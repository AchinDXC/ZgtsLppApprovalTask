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
    "sap/m/MessageBox",
    "sap/ui/core/BusyIndicator"
],
  function (Controller, Filter, FilterOperator, Dialog, Button, HTML, MessageBox, DmsToast, DmsMsgBox, DmsBusy) {
    "use strict";

    // Adobe Forms (ADS) template used by the process step "Render PDF 5"
    function esc(v) {
      if (v === null || v === undefined) {
        return "";
      }
      return String(v)
        .split("&").join("&amp;")
        .split("<").join("&lt;")
        .split(">").join("&gt;")
        .split("\"").join("&quot;")
        .split("'").join("&apos;");
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

    return Controller.extend("com.hpe.gts.workflowuimodule.dev.controller.App", {
      // ================= DMS file upload =================
      _DMS_REPO_ID: "e7dd4f2c-d6f2-443c-b199-d50055d08f16",

      _getDmsBaseUrl: function () {
        var sModulePath = sap.ui.require.toUrl("com/hpe/gts/workflowuimodule");
        return sModulePath + "/dms/"; // DMS_API destination already points to /browser/<repo>/root
      },

      _getDmsFolderName: function () {
        var oCtx = this._getContextModel();
        return (oCtx && oCtx.getProperty("/workflowInstanceId")) || "LPP";
      },

      onFileSizeExceed: function () {
        DmsMsgBox.error("File is too large (max 25 MB).");
      },

      onTypeMismatch: function (oEvent) {
        DmsMsgBox.error("File type ." + oEvent.getParameter("fileType") + " is not allowed.");
      },

      onUploadToDms: async function () {
        var oFU = this.byId("fileUploader");
        var oDomRef = oFU.getFocusDomRef();
        var oFile = oDomRef && oDomRef.files && oDomRef.files[0];
        if (!oFile) {
          DmsToast.show("Please choose a file first.");
          return;
        }
        DmsBusy.show(0);
        try {
          var sFolder = this._getDmsFolderName();
          //await this._ensureDmsFolder(sFolder);
         const sFolderObjectID =  await this.ensureFolderPath(sFolder);
         if(!sFolderObjectID){
          let oFolderResponse = await this.createFolder(sFolder);
          let oDocRes = await this.uploadDocument(oFile, sFolder, 'Test');
         }
          // var oResult = await this._createDocument(sFolder, oFile);
          var oCtx = this._getContextModel();
          var aAtt = (oCtx.getProperty("/attachments") || []).slice();
          aAtt.push({
            objectId: oResult.succinctProperties["cmis:objectId"],
            fileName: oFile.name,
            folder: sFolder,
            mimeType: oFile.type,
            size: oFile.size,
            uploadedOn: new Date().toISOString()
          });
          oCtx.setProperty("/attachments", aAtt);
          oFU.clear();
          DmsToast.show("'" + oFile.name + "' uploaded to DMS.");
        } catch (e) {
          DmsMsgBox.error("Upload failed: " + (e.message || e));
        } finally {
          DmsBusy.hide();
        }
      },

      

      _ensureDmsFolder: async function (sFolder) {
        var fd = new FormData();
        fd.append("cmisaction", "createFolder");
        fd.append("propertyId[0]", "cmis:name");
        fd.append("propertyValue[0]", sFolder);
        fd.append("propertyId[1]", "cmis:objectTypeId");
        fd.append("propertyValue[1]", "cmis:folder");
        fd.append("succinct", "true");
        var r = await fetch(this._getDmsBaseUrl(), { method: "POST", body: fd });
        if (!r.ok && r.status !== 409) {
          throw new Error("Folder creation failed (HTTP " + r.status + ")");
        }
      },

      _createDocument: async function (sFolder, oFile) {
        var fd = new FormData();
        fd.append("cmisaction", "createDocument");
        fd.append("propertyId[0]", "cmis:name");
        fd.append("propertyValue[0]", oFile.name);
        fd.append("propertyId[1]", "cmis:objectTypeId");
        fd.append("propertyValue[1]", "cmis:document");
        fd.append("_charset_", "UTF-8");
        fd.append("succinct", "true");
        fd.append("includeAllowableActions", "true");
        fd.append("filename", oFile.name);
        fd.append("media", oFile, oFile.name);
        var sUrl = this._getDmsBaseUrl() + encodeURIComponent(sFolder);
        var r = await fetch(sUrl, { method: "POST", body: fd });
        if (r.status === 409) {
          throw new Error("A file named '" + oFile.name + "' already exists for this request.");
        }
        if (!r.ok) {
          throw new Error("HTTP " + r.status + " - " + (await r.text()));
        }
        return r.json();
      },

      onOpenAttachment: function (oEvent) {
        var o = oEvent.getSource().getBindingContext("context").getObject();
        var sUrl = this._getDmsBaseUrl() + "?cmisselector=content&objectId=" +
          encodeURIComponent(o.objectId) + "&download=attachment";
        window.open(sUrl, "_blank");
      },
      // ================= end DMS file upload =================

      onInit: function () {},

      _getContextModel: function () {
        return this.getOwnerComponent().getModel("context");
      },

      /* ---------------- Product table ---------------- */

      onAddRow: function () {
        var oModel = this._getContextModel();
        var aItems = (oModel.getProperty("/items") || []).slice();
        aItems.push({ applicable: false, productDescription: "", gpuQuantity: "", gpuModel: "", eccn: "" });
        oModel.setProperty("/items", aItems);
      },

      onDeleteRow: function (oEvent) {
        var oModel = this._getContextModel();
        var sPath = oEvent.getSource().getBindingContext("context").getPath();
        var iIndex = parseInt(sPath.split("/").pop(), 10);
        var aItems = (oModel.getProperty("/items") || []).slice();
        aItems.splice(iIndex, 1);
        oModel.setProperty("/items", aItems);
      },

      onSearch: function (oEvent) {
        var sQuery = oEvent.getParameter("newValue");
        if (sQuery === undefined) {
          sQuery = oEvent.getParameter("query");
        }
        var aFilters = [];
        if (sQuery) {
          aFilters.push(
            new Filter({
              filters: ["productDescription", "gpuQuantity", "gpuModel", "eccn"].map(function (sField) {
                return new Filter(sField, FilterOperator.Contains, sQuery);
              }),
              and: false
            })
          );
        }
        this.byId("itemsTable").getBinding("items").filter(aFilters);
      },

      /* ---------------- Preview as PDF (SAP Forms Service by Adobe) ---------------- */

      // Same XML structure as the process script "Build Certificate XML"
      _buildCertificateXml: function () {
        var c = this._getContextModel().getData() || {};
        var so = c.salesOrderNumber || "";
        var items = c.items || [];

        var hf = [
          ["REQUEST_ID", ""],
          ["GTS_DOCUMENT", ""],
          ["SALES_ORDER", so],
          ["UC_CUSTOMER_NAME", c.ucOwnerName || c.ultimateConsignee || "Not Provided"],
          ["UC_STREET", c.ucAddress],
          ["UC_CITY", c.ucCity],
          ["UC_COUNTRY", c.ucCountry],
          ["UC_WEBSITE", c.ucWebsite],
          ["UC_CUST_EMAIL", c.ucEmail],
          ["EU_CUSTOMER_NAME", c.endUserName || "Not Provided"],
          ["EU_STREET", c.euAddress],
          ["EU_CITY", c.euCity],
          ["EU_COUNTRY", c.euCountry],
          ["EU_WEBSITE", c.euWebsite],
          ["EU_CUST_EMAIL", c.euEmail],
          ["LEGAL_REGULATION", "LPP"],
          ["STATUS", "PREVIEW"],
          ["CERTIFICATE_ID", "LPP-CERT-" + (so || "PREVIEW") + "-PREVIEW"],
          ["CHANGED_AT", new Date().toISOString().split(".")[0] + "Z"]
        ];

        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><data><IM_LPP_ORDER_HEADER>";
        hf.forEach(function (f) {
          xml += tag(f[0], f[1]);
        });
        xml += "</IM_LPP_ORDER_HEADER><IM_LPP_ORDER_ITEM>";

        var gpus = [];
        items.forEach(function (it, j) {
          if (it.gpuModel) {
            gpus.push(String(it.gpuModel));
          }
          xml += "<DATA>" +
            tag("SALES_ORDER_ITEM", String((j + 1) * 10)) +
            tag("PROD_DESC", it.productDescription) +
            tag("QUNT", it.gpuQuantity) +
            tag("GPU_MODEL", it.gpuModel) +
            tag("ECCN", it.eccn) +
            "</DATA>";
        });
        xml += "</IM_LPP_ORDER_ITEM><IM_LPP_ORDER>" + tag("SALES_ORDER", so) +
          tag("GPU_MODEL", gpus.join(", ")) + "</IM_LPP_ORDER></data>";
        return xml;
      },

      onPreviewPdf: function () {
        var oView = this.getView();
        var sUrl = sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") +
          "/ads/v1/adsRender/pdf?templateSource=storageName";
        var oBody = {
          xdpTemplate: XDP_TEMPLATE,
          xmlData: utf8ToBase64(this._buildCertificateXml()),
          formType: "print",
          formLocale: "en_US",
          taggedPdf: 1,
          embedFont: 0
        };

        oView.setBusy(true);
        jQuery
          .ajax({
            url: sUrl,
            method: "POST",
            contentType: "application/json",
            dataType: "json",
            data: JSON.stringify(oBody)
          })
          .done(
            function (oResult) {
              if (!oResult || !oResult.fileContent) {
                MessageBox.error("The Adobe Forms service returned no PDF content.");
                return;
              }
              this._showPdf(oResult.fileContent, oResult.fileName);
            }.bind(this)
          )
          .fail(function (oXhr) {
            MessageBox.error(
              "Could not render the PDF preview (" + oXhr.status + ").\n" + (oXhr.responseText || oXhr.statusText)
            );
          })
          .always(function () {
            oView.setBusy(false);
          });
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
            beginButton: new Button({
              text: "Download",
              type: "Emphasized",
              press: this._downloadPdf.bind(this)
            }),
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
      },

        uploadDocument: async function (oFile, sFolderPath, sFileName) {
            const sName = sFileName || oFile.name;
            const oFormData = new FormData();
            oFormData.append("cmisaction", "createDocument");
            oFormData.append("propertyId[0]", "cmis:name");
            oFormData.append("propertyValue[0]", sName);
            oFormData.append("propertyId[1]", "cmis:objectTypeId");
            oFormData.append("propertyValue[1]", "cmis:document");
            oFormData.append("_charset_", "UTF-8");
            oFormData.append("succinct", "true");
            oFormData.append("includeAllowableActions", "true");
            oFormData.append("filename", sName);
            // the binary content must be the last part
            oFormData.append("media", oFile, sName);
 
            return this._post(this._buildFolderUrl(sFolderPath), oFormData);
        },

        /**
 * Ensures every folder in the path exists, e.g. "Invoices/2026/Q4".
 * @returns {Promise<string>} objectId of the last folder
 */
ensureFolderPath: async function (sPath) {
    const aParts = sPath.split("/").filter(Boolean);
    let sCurrent = "";
    let sObjectId;

    for (const sPart of aParts) {
        const sNext = sCurrent ? sCurrent + "/" + sPart : sPart;
        const oCheck = await fetch(this._buildFolderUrl(sNext) + "?cmisselector=object&succinct=true", {
            headers: { "Accept": "application/json" }
        });

        if (oCheck.ok) {
            sObjectId = (await oCheck.json()).succinctProperties["cmis:objectId"];
        } else if (oCheck.status === 404) {
            const oNew = await this.createFolder(sPart, sCurrent);
            sObjectId = oNew.succinctProperties["cmis:objectId"];
        } else {
            await this._handleResponse(oCheck); // throws with the CMIS error
        }
        sCurrent = sNext;
    }
    return sObjectId;
},
 
        /**
         * POST - create a folder.
         * @param {string} sFolderName   new folder name
         * @param {string} [sParentPath] parent path under root ("" = root)
         * @returns {Promise<object>}
         */
        createFolder: async function (sFolderName, sParentPath) {
            const oFormData = new FormData();
            oFormData.append("cmisaction", "createFolder");
            oFormData.append("propertyId[0]", "cmis:name");
            oFormData.append("propertyValue[0]", sFolderName);
            oFormData.append("propertyId[1]", "cmis:objectTypeId");
            oFormData.append("propertyValue[1]", "cmis:folder");
            oFormData.append("succinct", "true");
 
            return this._post(this._buildFolderUrl(sParentPath), oFormData);
        },
 
        /**
         * POST - delete a document/folder by objectId.
         * @param {string} sObjectId
         */
        deleteObject: async function (sObjectId) {
            const oFormData = new FormData();
            oFormData.append("cmisaction", "delete");
            oFormData.append("objectId", sObjectId);
            return this._post(sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") + "/dms/browser/e7dd4f2c-d6f2-443c-b199-d50055d08f16/root", oFormData);
        },
 
        /* =========================================================== */
        /* Internals                                                    */
        /* =========================================================== */
 
        _buildFolderUrl: function (sPath) {
            let sUrl = sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") + "/dms/browser/e7dd4f2c-d6f2-443c-b199-d50055d08f16/root";
            if (sPath) {
                sUrl += "/" + sPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
            }
            return sUrl;
        },
 
        /** Fetches a CSRF token from the approuter (needed only if csrfProtection is on for the route). */
        _fetchCsrfToken: async function () {
            if (this._sCsrfToken) {
                return this._sCsrfToken;
            }
            try {
                const oResponse = await fetch(sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") + "/dms/browser", {
                    method: "HEAD",
                    headers: { "X-CSRF-Token": "Fetch" }
                });
                this._sCsrfToken = oResponse.headers.get("X-CSRF-Token");
            } catch (e) {
                this._sCsrfToken = null; // route has csrfProtection:false – fine
            }
            return this._sCsrfToken;
        },
 
        _post: async function (sUrl, oFormData, bRetried) {
            const sToken = await this._fetchCsrfToken();
            const oHeaders = { "Accept": "application/json" };
            if (sToken) {
                oHeaders["X-CSRF-Token"] = sToken;
            }
            // NOTE: do NOT set Content-Type – the browser adds multipart/form-data with the boundary
            const oResponse = await fetch(sUrl, {
                method: "POST",
                headers: oHeaders,
                body: oFormData
            });
 
            // token expired → refetch once and retry
            if (oResponse.status === 403 && !bRetried &&
                (oResponse.headers.get("X-CSRF-Token") || "").toLowerCase() === "required") {
                this._sCsrfToken = null;
                return this._post(sUrl, oFormData, true);
            }
            return this._handleResponse(oResponse);
        },
 
        _handleResponse: async function (oResponse) {
            // const sText = await oResponse.json();
            let oBody;
            // try { oBody = sText ? JSON.parse(sText) : {}; } catch (e) { oBody = { raw: sText }; }
 
            if (!oResponse.ok) {
                // CMIS errors come back as { exception: "nameConstraintViolation", message: "..." }
                const oError = new Error(oBody?.message || oResponse.statusText);
                oError.status = oResponse.status;
                oError.exception = oBody?.exception;
                throw oError;
            }
            return oResponse;
        }
    });
  }
);
