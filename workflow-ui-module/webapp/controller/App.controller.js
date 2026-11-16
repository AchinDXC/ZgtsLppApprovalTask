sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/ui/core/HTML",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/BusyIndicator"
  ],
  function (Controller, Filter, FilterOperator, Dialog, Button, HTML, MessageBox, MessageToast, BusyIndicator) {
    "use strict";

    // Adobe Forms (ADS) template used by the process step "Render PDF 5"
    var XDP_TEMPLATE = "LPPCertificateForm/LPPCertificateTemplate";
    // DMS folder layout: <root>/LPP/<SalesOrder>/  (one folder per sales order)
    var DMS_BASE_FOLDER = "LPP";
    // Levels where manual uploads keep their original name and are never overwritten
    var KEEP_NAME_LEVELS = [4, 6];

    function esc(v) {
      if (v === null || v === undefined) {
        return "";
      }
      return String(v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[c];
      });
    }

    function tag(n, v) {
      return "<" + n + ">" + esc(v) + "</" + n + ">";
    }

    function utf8ToBase64(str) {
      var bytes = new TextEncoder().encode(str);
      var bin = "";
      for (var i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      return btoa(bin);
    }

    function base64ToBlob(b64, type) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return new Blob([bytes], { type: type });
    }

    /** Error carrying the HTTP status and DMS's own message */
    function httpError(iStatus, oBody, sFallback) {
      var e = new Error((oBody && oBody.message) || sFallback || "HTTP " + iStatus);
      e.status = iStatus;
      e.cmis = oBody && oBody.exception;
      return e;
    }

    async function readBody(r) {
      var t = await r.text();
      try {
        return JSON.parse(t);
      } catch (e) {
        return { message: t };
      }
    }

    return Controller.extend("com.hpe.gts.workflowuimodule.controller.App", {
      onInit: function () {
        this._oSelectedFile = null;
        this._oSignedCopyFile = null;
      },

      _getContextModel: function () {
        return this.getOwnerComponent().getModel("context");
      },

      _getGtsModel: function () {
        return this.getOwnerComponent().getModel("gts");
      },

      /** LPP_HEADERSet record from the named model "gts" - waits until the read has finished */
      _getGtsData: async function () {
        var oComp = this.getOwnerComponent();
        var oGts = oComp.getModel("gts");
        if (!oGts.getProperty("/loaded")) {
          await oComp._getLLPHeaderSetData();          // not loaded yet (or failed) -> read now
        }
        return oGts.getData() || {};
      },

      // ======================================================================
      // DMS (CMIS browser binding)
      // Route /dms -> destination (= <ecmservice>/browser/<repoId>) with target /root$1,
      // so requests land on .../root exactly (DMS answers ".../root/" with 405).
      // ======================================================================

      _dmsUrl: function (sQuery) {
        return sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") + "/dms" + (sQuery ? "?" + sQuery : "");
      },

      /** CSRF token for the approuter route (cached; "" if the route has CSRF protection off) */
      _getDmsCsrfToken: async function (bRefresh) {
        if (this._sDmsCsrf !== undefined && !bRefresh) {
          return this._sDmsCsrf;
        }
        var r = await fetch(this._dmsUrl("cmisselector=object&succinct=true"), {
          method: "GET",
          headers: { "X-CSRF-Token": "Fetch" },
          credentials: "include"
        });
        this._sDmsCsrf = r.headers.get("X-CSRF-Token") || "";
        return this._sDmsCsrf;
      },

      /**
       * POST a CMIS action, e.g. createFolder / createDocument / delete / update.
       * mFields are form fields; sObjectId (parent folder or target object) goes into the form, never into the URL.
       */
      _cmisPost: async function (mFields, sObjectId, oFile, bRetried) {
        var fd = new FormData();
        Object.keys(mFields).forEach(function (k) {
          fd.append(k, mFields[k]);
        });
        if (sObjectId) {
          fd.append("objectId", sObjectId);
        }
        fd.append("succinct", "true");
        fd.append("_charset_", "UTF-8");
        if (oFile) {
          fd.append("media", oFile.blob, oFile.name);
        }
        var sToken = await this._getDmsCsrfToken();
        var r = await fetch(this._dmsUrl(), {
          method: "POST",
          body: fd,
          headers: sToken ? { "X-CSRF-Token": sToken } : {},
          credentials: "include"
        });
        if (r.status === 403 && !bRetried && (r.headers.get("X-CSRF-Token") || "").toLowerCase() === "required") {
          await this._getDmsCsrfToken(true); // token expired -> fetch a new one, retry once
          return this._cmisPost(mFields, sObjectId, oFile, true);
        }
        var oBody = await readBody(r);
        if (!r.ok) {
          throw httpError(r.status, oBody);
        }
        return (oBody && oBody.succinctProperties) || {};
      },

      _cmisChildren: async function (sParentId) {
        var r = await fetch(this._dmsUrl(
          (sParentId ? "objectId=" + encodeURIComponent(sParentId) + "&" : "") +
          "cmisselector=children&succinct=true&maxItems=1000"), { credentials: "include" });
        var oBody = await readBody(r);
        if (!r.ok) {
          throw httpError(r.status, oBody);
        }
        return (oBody.objects || []).map(function (o) {
          return (o.object && o.object.succinctProperties) || {};
        });
      },

      /** createFolder; if it already exists (409) return the existing one */
      _ensureFolder: async function (sParentId, sName) {
        try {
          var p = await this._cmisPost({
            "cmisaction": "createFolder",
            "propertyId[0]": "cmis:name", "propertyValue[0]": sName,
            "propertyId[1]": "cmis:objectTypeId", "propertyValue[1]": "cmis:folder"
          }, sParentId);
          return p["cmis:objectId"];
        } catch (e) {
          if (e.status !== 409) {
            throw e;
          }
          var oHit = (await this._cmisChildren(sParentId)).find(function (c) {
            return c["cmis:name"] === sName;
          });
          if (!oHit) {
            throw e;
          }
          return oHit["cmis:objectId"];
        }
      },

      /**
       * objectId of <root>/LPP/<SalesOrder>, created on first use.
       * One folder per sales order: every workflow run and every level of the same order uses it.
       */
      _getRequestFolder: async function () {
        if (this._oFolder) {
          return this._oFolder;
        }
        var g = await this._getGtsData();
        var sSalesOrder = String(g.SalesOrder || "").trim();
        if (!sSalesOrder) {
          throw new Error("Sales order number is not available - cannot determine the DMS folder.");
        }
        var sFolderName = sSalesOrder.replace(/[\\/:*?"<>|]/g, "_"); // characters not allowed in a folder name
        var sBaseId = await this._ensureFolder("", DMS_BASE_FOLDER);
        var sId = await this._ensureFolder(sBaseId, sFolderName);
        this._oFolder = { id: sId, path: DMS_BASE_FOLDER + "/" + sFolderName };
        return this._oFolder;
      },

      /**
       * Upload a Blob/File into the request folder under exactly sFileName.
       * Never overwrites: if the name exists, an error with status 409 is raised.
       * sDescription (optional) -> cmis:description, e.g. "Level 4 - Customer Signed Copy".
       */
      _uploadToDms: async function (oBlob, sFileName, sMimeType, sDescription) {
        var oFolder = await this._getRequestFolder();
        var sMime = sMimeType || oBlob.type || "application/octet-stream";
        var mFields = {
          "cmisaction": "createDocument",
          "propertyId[0]": "cmis:name", "propertyValue[0]": sFileName,
          "propertyId[1]": "cmis:objectTypeId", "propertyValue[1]": "cmis:document"
        };
        if (sDescription) {
          mFields["propertyId[2]"] = "cmis:description";
          mFields["propertyValue[2]"] = sDescription;
        }
        var p;
        try {
          p = await this._cmisPost(mFields, oFolder.id, { blob: new Blob([oBlob], { type: sMime }), name: sFileName });
        } catch (e) {
          if (e.status === 409) {
            var oDup = new Error("A file named '" + sFileName + "' already exists for this sales order.");
            oDup.status = 409;
            throw oDup;
          }
          throw e;
        }
        return {
          objectId: p["cmis:objectId"],
          fileName: p["cmis:name"] || sFileName,
          folder: oFolder.path,
          folderId: oFolder.id,
          mimeType: sMime,
          size: oBlob.size,
          uploadedOn: new Date().toISOString()
        };
      },

      /**
       * Upload WITHOUT deleting anything: stored under sFileName if that name is free,
       * otherwise as "<name> (2).<ext>", "<name> (3).<ext>", ... - every earlier document stays in DMS.
       */
      _uploadKeepingAll: async function (oBlob, sFileName, sMimeType, sDescription) {
        var iDot = sFileName.lastIndexOf(".");
        var sBase = iDot > 0 ? sFileName.slice(0, iDot) : sFileName;
        var sExt = iDot > 0 ? sFileName.slice(iDot) : "";
        for (var i = 1; i <= 50; i++) {
          var sName = i === 1 ? sFileName : sBase + " (" + i + ")" + sExt;
          try {
            var oAtt = await this._uploadToDms(oBlob, sName, sMimeType, sDescription);
            oAtt.renamed = i > 1;
            return oAtt;
          } catch (e) {
            if (e.status !== 409) {
              throw e;
            }
          }
        }
        throw new Error("Could not store '" + sFileName + "': too many files with the same name.");
      },

      _addAttachment: function (oAtt) {
        var oCtx = this._getContextModel();
        var aAtt = (oCtx.getProperty("/attachments") || []).filter(function (a) {
          return a.objectId !== oAtt.objectId;
        });
        aAtt.push(oAtt);
        oCtx.setProperty("/attachments", aAtt);
      },

      // ======================================================================
      // Approval level - same UI for every level
      // ======================================================================

      /**
       * Approval level of this task (1, 2, ...), derived from:
       *   1. task subject      e.g. "Level 2: OM LPP Certificate Review"   (set per task in BPA)
       *   2. task definition   e.g. activityId "level2Approval"
       *   3. fallback          next level after the certificates already stored for this request
       * Cached, so a retry in the same session keeps the same level.
       */
      _getApprovalLevel: async function () {
        if (this._iLevel) {
          return this._iLevel;
        }
        var oComp = this.getOwnerComponent();
        await oComp.whenReady();
        var oInfo = oComp.getModel("taskInfo").getData() || {};
        var oTask = oComp.getModel("task").getData() || {};
        var aSources = [oInfo.subject, oTask.TaskTitle, oInfo.activityId, oInfo.definitionId, oTask.TaskDefinitionName];
        var aPatterns = [/level\s*[-_:]?\s*(\d+)/i, /(\d+)\s*(?:st|nd|rd|th)?\s*[-_ ]?\s*level/i, /\bL(\d)\b/];

        for (var i = 0; i < aSources.length && !this._iLevel; i++) {
          for (var j = 0; j < aPatterns.length && aSources[i]; j++) {
            var m = aPatterns[j].exec(String(aSources[i]));
            if (m) {
              this._iLevel = parseInt(m[1], 10);
              break;
            }
          }
        }

        if (!this._iLevel) {
          // fallback: count certificates already in the request folder
          var so = this._getGtsModel().getProperty("/SalesOrder") || "UNKNOWN";
          var rx = new RegExp("^LPP_Certificate_" + so.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "_Level(\\d+)\\.pdf$");
          var oFolder = await this._getRequestFolder();
          var iMax = 0;
          (await this._cmisChildren(oFolder.id)).forEach(function (c) {
            var mm = rx.exec(c["cmis:name"] || "");
            if (mm) {
              iMax = Math.max(iMax, parseInt(mm[1], 10));
            }
          });
          this._iLevel = iMax + 1;
        }
        return this._iLevel;
      },

            // ---------------- Level 2: Customer Review Required + customer e-mail ----------------

      onCustEmailChange: function (oEvent) {
        var sValue = String(oEvent.getParameter("value") || "").trim();
        var bValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(sValue);
        var oUi = this.getOwnerComponent().getModel("ui");
        oUi.setProperty("/custEmailValid", bValid);
        oUi.setProperty("/custEmailState", !sValue ? "None" : (bValid ? "Success" : "Error"));

        // e-mail removed / invalid again -> "Yes" is no longer allowed
        var oCtx = this._getContextModel();
        if (!bValid && oCtx.getProperty("/customerReviewRequired") === "Yes") {
          oCtx.setProperty("/customerReviewRequired", "");
        }
      },

      onCustReviewChange: function (oEvent) {
        var oUi = this.getOwnerComponent().getModel("ui").getData();
        var sKey = oEvent.getParameter("selectedItem") && oEvent.getParameter("selectedItem").getKey();
        if (sKey === "Yes" && oUi.custEmailMissing && !oUi.custEmailValid) {
          this._getContextModel().setProperty("/customerReviewRequired", "");
          MessageToast.show("Enter the customer e-mail address first.");
        }
      },

      /** "invoice.pdf" -> "invoice_Level1.pdf" (an existing _Level<n> suffix is replaced) */
      _levelFileName: function (sFileName, iLevel) {
        var iDot = sFileName.lastIndexOf(".");
        var sBase = iDot > 0 ? sFileName.slice(0, iDot) : sFileName;
        var sExt = iDot > 0 ? sFileName.slice(iDot) : "";
        return sBase.replace(/_Level\d+$/i, "") + "_Level" + iLevel + sExt;
      },

      /** "LPP_Certificate_<SO>_Level<n>.pdf" */
      _certificateFileName: function (iLevel) {
        var so = this._getGtsModel().getProperty("/SalesOrder") || "UNKNOWN";
        return "LPP_Certificate_" + so + "_Level" + iLevel + ".pdf";
      },

      // ---------------- file upload (FileUploader) ----------------

      onFileChange: function (oEvent) {
        var aFiles = oEvent.getParameter("files");
        this._oSelectedFile = aFiles && aFiles[0] ? aFiles[0] : null;
      },

      onFileSizeExceed: function () {
        MessageBox.error("File is too large (max 25 MB).");
      },

      onTypeMismatch: function (oEvent) {
        MessageBox.error("File type ." + oEvent.getParameter("fileType") + " is not allowed.");
      },

      onUploadToDms: async function () {
        var oFile = this._oSelectedFile;
        if (!oFile) {
          MessageToast.show("Please choose a file first.");
          return;
        }
        BusyIndicator.show(0);
        try {
          var iLevel = await this._getApprovalLevel();
          // Level 4 / 6: original file name; other levels: <name>_Level<n>.<ext>
          // Nothing is ever deleted: a duplicate name is stored as "<name> (2).<ext>"
          var sName = KEEP_NAME_LEVELS.indexOf(iLevel) >= 0 ? oFile.name : this._levelFileName(oFile.name, iLevel);
          var oAtt = await this._uploadKeepingAll(oFile, sName, oFile.type, "Level " + iLevel + " - Attachment");

          oAtt.level = iLevel;
          oAtt.type = "Attachment";
          this._addAttachment(oAtt);
          this.byId("fileUploader").clear();
          this._oSelectedFile = null;
          MessageToast.show("'" + oAtt.fileName + "' uploaded to DMS" +
            (oAtt.renamed ? " (a file with the same name already existed, so a number was added)." : "."));
        } catch (e) {
          MessageBox.error("Upload failed: " + (e.message || e));
        } finally {
          BusyIndicator.hide();
        }
      },

      // ---------------- Customer signed copy (levels 4 and 6) ----------------

      onSignedCopyChange: function (oEvent) {
        var aFiles = oEvent.getParameter("files");
        this._oSignedCopyFile = aFiles && aFiles[0] ? aFiles[0] : null;
      },

      onUploadSignedCopy: async function () {
        var oFile = this._oSignedCopyFile;
        if (!oFile) {
          MessageToast.show("Please choose the customer signed copy first.");
          return;
        }
        BusyIndicator.show(0);
        try {
          var iLevel = await this._getApprovalLevel();
          // original file name; a duplicate name is stored as "<name> (2).<ext>" - nothing is deleted
          var oAtt = await this._uploadKeepingAll(oFile, oFile.name, oFile.type, "Level " + iLevel + " - Customer Signed Copy");
          oAtt.level = iLevel;
          oAtt.type = "Customer Signed Copy";
          this._addAttachment(oAtt);
          this.byId("signedCopyUploader").clear();
          this._oSignedCopyFile = null;
          MessageToast.show("Customer signed copy '" + oAtt.fileName + "' uploaded to DMS" +
            (oAtt.renamed ? " (a file with the same name already existed, so a number was added)." : "."));
        } catch (e) {
          MessageBox.error("Upload of the customer signed copy failed: " + (e.message || e));
        } finally {
          BusyIndicator.hide();
        }
      },

      onOpenAttachment: function (oEvent) {
        var o = oEvent.getSource().getBindingContext("context").getObject();
        window.open(this._dmsUrl("cmisselector=content&download=attachment&objectId=" + encodeURIComponent(o.objectId)), "_blank");
      },

      // ---------------- Product table (named model "gts", /LppItem) ----------------

      onAddRow: function () {
        var oModel = this._getGtsModel();
        var aItems = (oModel.getProperty("/LppItem") || []).slice();
        aItems.push({ SalesOrderItem: "", ProdDesc: "", Qunt: "", GpuModel: "", Eccn: "" });
        oModel.setProperty("/LppItem", aItems);
      },

      onDeleteRow: function (oEvent) {
        var oModel = this._getGtsModel();
        var sPath = oEvent.getSource().getBindingContext("gts").getPath();
        var iIndex = parseInt(sPath.split("/").pop(), 10);
        var aItems = (oModel.getProperty("/LppItem") || []).slice();
        aItems.splice(iIndex, 1);
        oModel.setProperty("/LppItem", aItems);
      },

      onSearch: function (oEvent) {
        var sQuery = oEvent.getParameter("newValue");
        if (sQuery === undefined) {
          sQuery = oEvent.getParameter("query");
        }
        var aFilters = [];
        if (sQuery) {
          aFilters.push(new Filter({
            filters: ["ProdDesc", "GpuModel", "Eccn", "SalesOrderItem"].map(function (sField) {
              return new Filter(sField, FilterOperator.Contains, sQuery);
            }),
            and: false
          }));
        }
        this.byId("itemsTable").getBinding("items").filter(aFilters);
      },

      // ======================================================================
      // Certificate PDF (SAP Forms Service by Adobe)
      // ======================================================================

      /** Certificate XML for ADS, built from the GTS record (LPP_HEADERSet + LppItem) */
      _buildCertificateXml: async function (sStatus) {
        var g = await this._getGtsData();
        var so = g.SalesOrder || "";
        var items = g.LppItem || [];
        var bFinal = sStatus !== "PREVIEW";
        var join = function () {                           // "Main St" + "12" -> "Main St 12"
          return Array.prototype.slice.call(arguments).filter(Boolean).join(" ");
        };
        var qty = function (v) {                           // Edm.Decimal "4.000" -> "4"
          var n = parseFloat(v);
          return isNaN(n) ? "" : String(n);
        };

        var hf = [
          ["REQUEST_ID", g.RequestId || this.getOwnerComponent().getWorkflowInstanceId() || ""],
          ["GTS_DOCUMENT", g.GtsDocument],
          ["SALES_ORDER", so],
          ["UC_CUSTOMER_NAME", g.UcCustomerName || "Not Provided"],
          ["UC_STREET", join(g.UcStreet, g.UcHouseNum)],
          ["UC_CITY", join(g.UcPostCode, g.UcCity)],
          ["UC_COUNTRY", g.UcCountry],
          ["UC_WEBSITE", g.UcWebsite],
          ["UC_CUST_EMAIL", g.UcCustEmail],
          ["EU_CUSTOMER_NAME", g.EuCustomerName || "Not Provided"],
          ["EU_STREET", join(g.EuStreet, g.EuHouseNum)],
          ["EU_CITY", join(g.EuPostCode, g.EuCity)],
          ["EU_COUNTRY", g.EuCountry],
          ["EU_WEBSITE", g.EuWebsite],
          ["EU_CUST_EMAIL", g.EuCustEmail],
          ["LEGAL_REGULATION", "LPP"],
          ["STATUS", sStatus],
          ["CERTIFICATE_ID", "LPP-CERT-" + (so || "PREVIEW") + (bFinal ? "" : "-PREVIEW")],
          ["CHANGED_AT", new Date().toISOString().split(".")[0] + "Z"]
        ];

        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><data><IM_LPP_ORDER_HEADER>";
        hf.forEach(function (f) {
          xml += tag(f[0], f[1]);
        });
        xml += "</IM_LPP_ORDER_HEADER><IM_LPP_ORDER_ITEM>";

        var gpus = [];
        items.forEach(function (it, j) {
          if (it.GpuModel && gpus.indexOf(String(it.GpuModel)) < 0) {
            gpus.push(String(it.GpuModel));
          }
          xml += "<DATA>" +
            tag("SALES_ORDER_ITEM", it.SalesOrderItem || String((j + 1) * 10)) +
            tag("PROD_DESC", it.ProdDesc) +
            tag("QUNT", qty(it.Qunt)) +
            tag("GPU_MODEL", it.GpuModel) +
            tag("ECCN", it.Eccn) +
            "</DATA>";
        });
        xml += "</IM_LPP_ORDER_ITEM><IM_LPP_ORDER>" + tag("SALES_ORDER", so) +
          tag("GPU_MODEL", gpus.join(", ")) + "</IM_LPP_ORDER></data>";
        return xml;
      },

      /** Renders the certificate via ADS; resolves { base64, fileName } */
      _renderCertificatePdf: async function (sStatus) {
        var sXml = await this._buildCertificateXml(sStatus);
        var r = await fetch(sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") +
          "/ads/v1/adsRender/pdf?templateSource=storageName", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            xdpTemplate: XDP_TEMPLATE,
            xmlData: utf8ToBase64(sXml),
            formType: "print",
            formLocale: "en_US",
            taggedPdf: 1,
            embedFont: 0
          })
        });
        var oBody = await readBody(r);
        if (!r.ok) {
          throw httpError(r.status, oBody, "Adobe Forms service failed (HTTP " + r.status + ")");
        }
        if (!oBody || !oBody.fileContent) {
          throw new Error("The Adobe Forms service returned no PDF content.");
        }
        return { base64: oBody.fileContent, fileName: oBody.fileName };
      },

      onPreviewPdf: async function () {
        var oView = this.getView();
        oView.setBusy(true);
        try {
          var oPdf = await this._renderCertificatePdf("PREVIEW");
          this._showPdf(oPdf.base64, oPdf.fileName);
        } catch (e) {
          MessageBox.error("Could not render the PDF preview.\n" + (e.message || e));
        } finally {
          oView.setBusy(false);
        }
      },

      /**
       * Renders the APPROVED certificate and stores it in DMS (request folder) as
       * LPP_Certificate_<SO>_Level<n>.pdf. Nothing is deleted: if that file is already there
       * (e.g. retry after a failed task completion) the new one is stored as "... (2).pdf".
       * Called by Component on Approve, and by the button. Resolves the attachment entry.
       */
      generateAndStoreCertificate: async function () {
        var iLevel = await this._getApprovalLevel();
        var sFileName = this._certificateFileName(iLevel);
        var oPdf = await this._renderCertificatePdf("APPROVED");
        // every approve keeps its certificate: a repeat is stored as "LPP_Certificate_<SO>_Level<n> (2).pdf"
        var oAtt = await this._uploadKeepingAll(base64ToBlob(oPdf.base64, "application/pdf"), sFileName, "application/pdf",
          "Level " + iLevel + " - Certificate");
        oAtt.isCertificate = true;
        oAtt.level = iLevel;
        oAtt.type = "Certificate";
        this._addAttachment(oAtt);
        return oAtt;
      },

      onGenerateCertificate: async function () {
        BusyIndicator.show(0);
        try {
          var oAtt = await this.generateAndStoreCertificate();
          MessageToast.show("Certificate '" + oAtt.fileName + "' stored in DMS.");
        } catch (e) {
          MessageBox.error("Could not store the certificate in DMS.\n" + (e.message || e));
        } finally {
          BusyIndicator.hide();
        }
      },

      _showPdf: function (sBase64, sFileName) {
        if (this._sPdfUrl) {
          URL.revokeObjectURL(this._sPdfUrl);
        }
        this._sPdfUrl = URL.createObjectURL(base64ToBlob(sBase64, "application/pdf"));
        this._sPdfFileName = sFileName || "LPP_Certificate_Preview.pdf";

        if (!this._oPdfDialog) {
          this._oPdfHtml = new HTML({ preferDOM: false });
          this._oPdfDialog = new Dialog({
            title: "LPP Certificate - Preview",
            contentWidth: "90%",
            contentHeight: "85%",
            resizable: true,
            draggable: true,
            horizontalScrolling: false,
            verticalScrolling: false,
            content: [this._oPdfHtml],
            beginButton: new Button({ text: "Download", type: "Emphasized", press: this._downloadPdf.bind(this) }),
            endButton: new Button({
              text: "Close",
              press: function () {
                this._oPdfDialog.close();
              }.bind(this)
            })
          });
          this.getView().addDependent(this._oPdfDialog);
        }
        this._oPdfHtml.setContent(
          "<iframe title=\"LPP Certificate preview\" src=\"" + this._sPdfUrl +
          "\" style=\"width:100%;height:100%;border:0;display:block\"></iframe>"
        );
        this._oPdfDialog.open();
      },

      _downloadPdf: function () {
        var oLink = document.createElement("a");
        oLink.href = this._sPdfUrl;
        oLink.download = this._sPdfFileName;
        document.body.appendChild(oLink);
        oLink.click();
        document.body.removeChild(oLink);
      },

      onExit: function () {
        if (this._sPdfUrl) {
          URL.revokeObjectURL(this._sPdfUrl);
        }
      }
    });
  }
);