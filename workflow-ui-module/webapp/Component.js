sap.ui.define(
  [
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/ui/core/BusyIndicator",
    "com/hpe/gts/workflowuimodule/model/models",
    'sap/ui/model/Filter',
    'sap/ui/model/FilterOperator'
  ],
  function (UIComponent, JSONModel, MessageBox, BusyIndicator, models, Filter, FilterOperator) {
    "use strict";

    // Fields returned to the process as task outputs (must match "sap.bpa.task"/outputs in manifest.json)
    var OUTPUT_FIELDS = [
      "ucAuthorizedPersonTitle",
      "ucSignature",
      "ucSignedDate",
      "euTitle",
      "euSignature",
      "euSignedDate",
      "comment",
      "items",
      "customerReviewRequired"
    ];

    // Status written to LPP_HEADERSet.Status per approval level ("" = don't change the status)
    var LEVEL_STATUS = {
      "1": { approve: "5.OM_REV1",         reject: ""        },
      "2": { approve: "6.CUST_ACT",  reject: ""        },
      "3": { approve: "7.OM_REV2", reject: ""        },
      "4": { approve: "8.EPC_REV2",  reject: ""        },
      "5": { approve: "10.SNDBIS1", reject: "" },
      "6": { approve: "9.EPC_APPR", reject: "14.EPC_REJ" }
    };

    // GTS field holding the customer e-mail used for the customer review (Level 2 -> CUST_ACT)
    var CUSTOMER_EMAIL_FIELD = "CustEmail";

    return UIComponent.extend("com.hpe.gts.workflowuimodule.Component", {
      metadata: {
        manifest: "json"
      },

      init: function () {
        UIComponent.prototype.init.apply(this, arguments);
        this.getRouter().initialize();
        this.setModel(models.createDeviceModel(), "device");

        this.setTaskModels();

        this.getInboxAPI().addAction(
          { action: "APPROVE", label: "Approve", type: "accept" },
          function () {
            this.completeTask(true, "approve");
          },
          this
        );

        this.getInboxAPI().addAction(
          { action: "REJECT", label: "Reject", type: "reject" },
          function () {
            this.completeTask(false, "reject");
          },
          this
        );
      },

      setTaskModels: function () {
        // Task model (InstanceID, subject, etc.) provided by My Inbox
        var startupParameters = this.getComponentData().startupParameters;
        this.setModel(startupParameters.taskModel, "task");

        this._bProcessLevel = this.getModel("task").getProperty("/TaskTitle")?.split(":")[0];
        this.getModel("task").setProperty("/processLevel", this._bProcessLevel?.split(" ")?.[1]);
        let oEditableProps = {
          "salesOrder": false,
          "itemsTable": false,
          "ultimateConsignee": false,
          "nameOfAuthPerson": false,
          "titleOfAuthPerson": false,
          "sigOfAuthPerson": false,
          "dateDocIsSignedAuth": false,
          "addressAuthUser": false,
          "nameOfEndUser": false,
          "sigOfEndPerson": false,
          "dateDocIsSignedEnd": false,
          "addressEndUser": false
        }
        if (this._bProcessLevel === 'Level 1' || this._bProcessLevel === 'Level 5' || this._bProcessLevel === 'Level 6') {
            oEditableProps = {
            "salesOrder": false,
            "itemsTable": true,
            "ultimateConsignee": true,
            "nameOfAuthPerson": true,
            "titleOfAuthPerson": true,
            "sigOfAuthPerson": true,
            "addressAuthUser": true,
            "dateDocIsSignedAuth": true,
            "nameOfEndUser": true,
            "sigOfEndPerson": true,
            "dateDocIsSignedEnd": true,
            "addressEndUser": true
          }
        }
        else if (this._bProcessLevel === 'Level 2' || this._bProcessLevel === 'Level 4') {
          oEditableProps = {
            "salesOrder": false,
            "itemsTable": false,
            "ultimateConsignee": true,
            "nameOfAuthPerson": true,
            "titleOfAuthPerson": true,
            "sigOfAuthPerson": true,
            "addressAuthUser": true,
            "dateDocIsSignedAuth": true,
            "nameOfEndUser": true,
            "sigOfEndPerson": true,
            "dateDocIsSignedEnd": true,
            "addressEndUser": true
          }
        }
        else {
          oEditableProps = {
            "salesOrder": false,
            "itemsTable": false,
            "ultimateConsignee": true,
            "nameOfAuthPerson": true,
            "titleOfAuthPerson": true,
            "sigOfAuthPerson": true,
            "addressAuthUser": false,
            "dateDocIsSignedAuth": true,
            "nameOfEndUser": true,
            "sigOfEndPerson": true,
            "dateDocIsSignedEnd": true,
            "addressEndUser": false
          }
        }
        this.getModel("task").setProperty("/editableProps", oEditableProps);

        // Task context = inputs mapped in the process
        var taskContextModel = new JSONModel(this._getTaskInstancesBaseURL() + "/context");
        this.setModel(taskContextModel, "context");

        // Task instance itself - carries workflowInstanceId
        var taskInfoModel = new JSONModel(this._getTaskInstancesBaseURL());
        this.setModel(taskInfoModel, "taskInfo");

        // Process context - startEvent = process inputs (e.g. pro_inputs_cust)
        var wfContextModel = new JSONModel();
        this.setModel(wfContextModel, "wfContext");

        // GTS record (LPP_HEADERSet) - named model, bound in the view as {gts>/...}
        this.setModel(new JSONModel({ busy: true, loaded: false, LppItem: [] }), "gts");

        // UI state for Level 2 "Customer Review Required" + missing customer e-mail
        this.setModel(new JSONModel({
          custEmailMissing: false,
          custEmailInput: "",
          custEmailValid: false,
          custEmailState: "None",
          showUc: true,          // Ultimate Consignee section
          showEu: true,          // End User section
          certifyName: "",       // name in "I, <name>, hereby certify ..."
          userEmail: "",         // e-mail of the logged-on user
          isSuperUser: false     // userEmail === SuperEmail from LPP_HEADERSet
        }), "ui");

        this._pModelsLoaded = Promise.all([taskContextModel.dataLoaded(), taskInfoModel.dataLoaded()])
          .then(function () {
            return wfContextModel.loadData(
              this._getWorkflowRuntimeBaseURL() + "/workflow-instances/" + this.getWorkflowInstanceId() + "/context"
            ).catch(function () { /* no permission -> stays empty */ });
          }.bind(this));

        // read GTS after everything above is loaded (fixes issue 1)
        this._getLLPHeaderSetData().catch(function (e) {
          MessageBox.error("Could not read the GTS document: " + (e.message || e));
        });
      },

      /** resolves when task context + task instance info are loaded */
      whenReady: function () {
        return this._pModelsLoaded;
      },

      getWorkflowInstanceId: function () {
        return this.getModel("taskInfo").getProperty("/workflowInstanceId");
      },

      _getTaskInstancesBaseURL: function () {
        return this._getWorkflowRuntimeBaseURL() + "/task-instances/" + this.getTaskInstanceID();
      },

      _getWorkflowRuntimeBaseURL: function () {
        var appPath = this.getManifestEntry("/sap.app/id").replaceAll(".", "/");
        return sap.ui.require.toUrl(appPath) + "/bpmworkflowruntime/v1";
      },

      getTaskInstanceID: function () {
        return this.getModel("task").getData().InstanceID;
      },

      getInboxAPI: function () {
        return this.getComponentData().startupParameters.inboxAPI;
      },

      _getAppController: function () {
        var oRoot = this.getRootControl();
        return oRoot && oRoot.getController();
      },

      completeTask: async function (approvalStatus, outcomeId) {
        if (this._bSubmitting) {
          return; // double click guard
        }
        this._bSubmitting = true;
        BusyIndicator.show(0);
        try {
          await this._pModelsLoaded; // never PATCH an empty context
          var oContextModel = this.getModel("context");

          if (!approvalStatus && !(oContextModel.getProperty("/comment") || "").trim()) {
            MessageBox.error("Please enter a comment before rejecting.");
            return;
          }

          // Level 2: "Customer Review Required" must be chosen; "Yes" needs a customer e-mail
          if (approvalStatus && this.getProcessLevel() === "2") {
            var sReview = oContextModel.getProperty("/customerReviewRequired");
            var oUi = this.getModel("ui").getData();
            if (!sReview) {
              MessageBox.error("Please select 'Customer Review Required' (Yes / No) before approving.");
              return;
            }
            if (sReview === "Yes" && oUi.custEmailMissing && !oUi.custEmailValid) {
              MessageBox.error("Please enter a valid customer e-mail address for the customer review.");
              return;
            }
          }

          var oCert = null;
          if (approvalStatus) {
            try {
              oCert = await this._getAppController().generateAndStoreCertificate();
            } catch (e) {
              MessageBox.error("The certificate could not be stored in DMS, so the task was not approved.\n\n" +
                (e.message || e) + "\n\nPlease try again.");
              return;
            }
          }

           // GTS update for this level (approve AND reject) - skipped if nothing to change
          var oChanges = this._llpChangesForDecision(approvalStatus, oCert);
          if (Object.keys(oChanges).length) {
            try {
              await this._updateLLPHeaderSetData(oChanges);
            } catch (e) {
              MessageBox.error("The GTS document could not be updated, so the task was not completed.\n\n" + (e.message || e));
              return;
            }
          }

          await this._patchTaskInstance(outcomeId);
          this._refreshTaskList();
        } catch (e) {
          MessageBox.error("Could not complete the task: " + (e.message || e));
        } finally {
          this._bSubmitting = false;
          BusyIndicator.hide();
        }
      },



      /** process input from startEvent (process context) */
      _getGuidCuhd: function () {
        return String(this.getModel("wfContext").getProperty("/startEvent/pro_inputs_cust") || "").trim();
      },

      /** Gateway error -> readable message */
      _odataErrorText: function (oError) {
        try {
          var oErr = JSON.parse(oError.responseText).error;
          var aDetails = oErr.innererror && oErr.innererror.errordetails;
          return (aDetails && aDetails.length && aDetails[0].message) || oErr.message.value || oErr.message;
        } catch (e) {
          return (oError && (oError.message || oError.statusText)) || "Unknown error";
        }
      },

      /** GET LPP_HEADERSet('<GuidCuhd>')?$expand=LppItem -> named model "gts" */
      _getLLPHeaderSetData: async function () {
        var oGtsModel = this.getModel("gts");
        oGtsModel.setProperty("/busy", true);
        try {
          await this.whenReady();
          var sGuidCuhd = this._getGuidCuhd();
          if (!sGuidCuhd) {
            throw new Error("GuidCuhd (startEvent/pro_inputs_cust) not found in the process context.");
          }
          var oModel = this.getModel();                   // default OData model from manifest
          await oModel.metadataLoaded(true);
          var sPath = oModel.createKey("/LPP_HEADERSet", { GuidCuhd: sGuidCuhd });

          var oData = await new Promise(function (resolve, reject) {
            oModel.read(sPath, {
              urlParameters: { "$expand": "LppItem" },
              success: resolve,                            // oData = the header record
              error: function (oError) {
                reject(new Error(this._odataErrorText(oError)));
              }.bind(this)
            });
          }.bind(this));

          // ---- success: put the record into the named model ----
          this._sLLPPath = sPath;
          this._sGuidCuhd = oData.GuidCuhd;
          var oRecord = Object.assign({}, oData);
          delete oRecord.__metadata;
          oRecord.LppItem = ((oData.LppItem && oData.LppItem.results) || []).map(function (it) {
            var o = Object.assign({}, it);
            delete o.__metadata;
            return o;
          });
          oRecord.busy = false;
          oRecord.loaded = true;
          oGtsModel.setData(oRecord);

          // Level 2: is the customer e-mail missing in GTS?  (oRecord exists now)
          this.getModel("ui").setProperty("/custEmailMissing", !String(oRecord[CUSTOMER_EMAIL_FIELD] || "").trim());

          // which party sections to show (UC / EU)
          this._setPartyVisibility(oRecord);

          // logged-on user = SuperEmail from GTS?
          await this._checkSuperUser(oRecord);
          return oRecord;
        } catch (e) {
          oGtsModel.setProperty("/busy", false);
          throw e;
        }
      },

      /**
       * Ultimate Consignee (UC) / End User (EU) sections:
       *   UC + EU same       -> Ultimate Consignee only
       *   EU only (no UC)    -> End User only
       *   UC + EU different  -> Ultimate Consignee + End User
       *   UC only            -> Ultimate Consignee only
       * "Same" = same customer number; if a number is missing, same name + street + city + country.
       */
      /**
       * E-mail of the logged-on user.
       *   1. Fiori launchpad / Work Zone (My Inbox): ushell UserInfo service
       *   2. fallback: approuter user API (/user-api/currentUser) - only if that route exists in xs-app.json
       * Resolves "" if it can't be determined.
       */
      getCurrentUserEmail: async function () {
        if (this._sUserEmail !== undefined) {
          return this._sUserEmail;
        }
        var sEmail = "";
        try {
          var oContainer = sap.ui.require("sap/ushell/Container") || (sap.ushell && sap.ushell.Container);
          if (oContainer) {
            var oUserInfo = await oContainer.getServiceAsync("UserInfo");
            sEmail = (oUserInfo.getEmail && oUserInfo.getEmail()) ||
                     (oUserInfo.getUser && oUserInfo.getUser().getEmail && oUserInfo.getUser().getEmail()) || "";
          }
        } catch (e) {
          console.warn("ushell UserInfo not available:", e);
        }
        if (!sEmail) {
          try {
            var r = await fetch(sap.ui.require.toUrl("com/hpe/gts/workflowuimodule") + "/user-api/currentUser",
              { credentials: "include" });
            if (r.ok) {
              sEmail = (await r.json()).email || "";
            }
          } catch (e) { /* route not configured */ }
        }
        this._sUserEmail = String(sEmail || "").trim();
        return this._sUserEmail;
      },

      /** ui>/isSuperUser = logged-on user's e-mail equals LPP_HEADERSet.SuperEmail (case-insensitive) */
      _checkSuperUser: async function (g) {
        var oUi = this.getModel("ui");
        var sUser = (await this.getCurrentUserEmail()).toLowerCase();
        var sSuper = String(g.SuperEmail || "").trim().toLowerCase();
        oUi.setProperty("/userEmail", sUser);
        oUi.setProperty("/isSuperUser", !!sUser && !!sSuper && sUser === sSuper);

        // super user -> every field editable, whatever the level
        if (oUi.getProperty("/isSuperUser")) {
          var oTask = this.getModel("task");
          var oProps = Object.assign({}, oTask.getProperty("/editableProps"));
          Object.keys(oProps).forEach(function (k) { oProps[k] = true; });
          oTask.setProperty("/editableProps", oProps);
          oTask.setProperty("/readOnly", false);
        }
        return oUi.getProperty("/isSuperUser");
      },

      _setPartyVisibility: function (g) {
        var norm = function (v) {
          return String(v || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^0+(?=\d)/, "");
        };
        var bHasUc = !!(norm(g.UcCustomerno) || norm(g.UcCustomerName));
        var bHasEu = !!(norm(g.EuCustomerno) || norm(g.EuCustomerName));

        var bSame = false;
        if (bHasUc && bHasEu) {
          if (norm(g.UcCustomerno) && norm(g.EuCustomerno)) {
            bSame = norm(g.UcCustomerno) === norm(g.EuCustomerno);
          } else {
            bSame = ["CustomerName", "Street", "City", "Country"].every(function (f) {
              return norm(g["Uc" + f]) === norm(g["Eu" + f]);
            });
          }
        }

        var bShowUc = bHasUc || !bHasEu;            // nothing maintained -> show both
        var bShowEu = bHasEu ? !bSame : !bHasUc;

        var oUi = this.getModel("ui");
        // oUi.setProperty("/showUc", bShowUc);
        // oUi.setProperty("/showEu", bShowEu);
        oUi.setProperty("/certifyName", bShowUc ? (g.UcCustomerName || "") : (g.EuCustomerName || ""));
      },

     /** "1".."5" from the task title "Level n: ..." (set in setTaskModels) */
      getProcessLevel: function () {
        return String(this.getModel("task").getProperty("/processLevel") || "").trim();
      },

      /**
 * Update LPP_HEADERSet('<GuidCuhd>') from the named model "gts".
 * oChanges (optional) = values to change, e.g. { Status: "APPROVED", Reason: "..." }.
 * Only updatable properties are sent (MERGE = partial update). On success "gts" is refreshed.
 */
      _updateLLPHeaderSetData: async function (oChanges) {
        // LPP_HEADERSet properties the backend allows to update ($metadata: no sap:updatable="false")
        var LPP_UPDATABLE = [
          "SalesOrder",
          "UcCustomerName", "UcStreet", "UcHouseNum", "UcPostCode", "UcCity", "UcCountry", "UcWebsite", "UcCustEmail",
          "EuCustomerno", "EuCustomerName", "EuStreet", "EuHouseNum", "EuPostCode", "EuCity", "EuCountry", "EuWebsite", "EuCustEmail",
          "CertificateId", "CertificateUrl", "Status", "Reason", "BpaInstanceId",
          "TppValueOrd", "TotTppCust", "CustEmail"
          
        ];
        var LPP_DECIMALS = ["TppValueOrd", "TotTppCust"];   // Edm.Decimal -> sent as string in OData V2
        var oGtsModel = this.getModel("gts");
        if (!this._sLLPPath || !oGtsModel.getProperty("/loaded")) {
          await this._getLLPHeaderSetData();               // need path + current record first
        }

        // current record in "gts" + the changes -> payload with updatable fields only
        var oCurrent = Object.assign({}, oGtsModel.getData(), oChanges || {});
        var oPayload = {};
        LPP_UPDATABLE.forEach(function (sField) {
          if (oCurrent[sField] === undefined || oCurrent[sField] === null) {
            return;
          }
          oPayload[sField] = LPP_DECIMALS.indexOf(sField) >= 0
            ? String(oCurrent[sField])                     // Edm.Decimal must be a string in V2
            : oCurrent[sField];
        });

        var oModel = this.getModel();                      // default OData model from manifest
        oGtsModel.setProperty("/busy", true);
        try {
          const oUpdateRes = await new Promise(function (resolve, reject) {
            oModel.update(this._sLLPPath, oPayload, {
              method: "MERGE",                             // partial update
              success: (oRes) => {
                resolve(oRes);
              },
              error: function (oError) {
                reject(new Error(this._odataErrorText(oError)));
              }.bind(this)
            });
          }.bind(this));
         

          // ---- success: refresh the named model, UI updates via binding ----
          // Object.keys(oPayload).forEach(function (sField) {
          //   oGtsModel.setProperty("/" + sField, oPayload[sField]);
          // });
          return true;
        } finally {
          oGtsModel.setProperty("/busy", false);
        }
      },

            /** Fields written to LPP_HEADERSet for this level + decision (only updatable properties) */
      _llpChangesForDecision: function (bApproved, oCert) {
        var c = this.getModel("context").getData() || {};
        var sLevel = this.getProcessLevel();
        if ( sLevel !== "2" ){
        var oMap =   LEVEL_STATUS[sLevel] || { approve: "", reject: "" }         
        var sStatus = bApproved ? oMap.approve : oMap.reject;

        } else {
         var sStatus = c.customerReviewRequired == 'Yes' ?   '6.CUST_ACT' : '8.EPC_REV2';
        }

         
        var oChanges = {};

        if (sStatus) {
          oChanges.Status = sStatus;                                   // max 20 chars
        }
        if (!bApproved) {
          oChanges.Reason = String(c.comment || "").slice(0, 200);     // rejection reason
        }
        if (bApproved && oCert) {
          oChanges.CertificateId = String(oCert.objectId || "").slice(0, 80);
          oChanges.CertificateUrl = (oCert.folder + "/" + oCert.fileName).slice(0, 255);
        }
                // Level 2 + "Yes": store the e-mail entered on the screen (only if GTS had none)
        var oUi = this.getModel("ui").getData();
        if (bApproved && sLevel === "2" && c.customerReviewRequired === "Yes" && oUi.custEmailMissing) {
          oChanges[CUSTOMER_EMAIL_FIELD] = String(oUi.custEmailInput || "").trim().slice(0, 60);   // MaxLength 60
        }
        return oChanges;
      },

      _buildOutputs: function () {
        var oContext = this.getModel("context").getData() || {};
        var oOutputs = {};
        OUTPUT_FIELDS.forEach(function (sField) {
          if (sField === "items") {
            oOutputs.items = (oContext.items || []).map(function (oItem) {
              return {
                applicable: !!oItem.applicable,
                productDescription: oItem.productDescription || "",
                gpuQuantity: oItem.gpuQuantity || "",
                gpuModel: oItem.gpuModel || "",
                eccn: oItem.eccn || ""
              };
            });
          } else {
            oOutputs[sField] = oContext[sField] || "";
          }
        });
        return oOutputs;
      },

      _patchTaskInstance: async function (outcomeId) {
        var t = await fetch(this._getWorkflowRuntimeBaseURL() + "/xsrf-token", {
          method: "GET",
          headers: { "X-CSRF-Token": "Fetch" },
          credentials: "include"
        });
        var sToken = t.headers.get("X-CSRF-Token");
        if (!sToken) {
          throw new Error("Could not fetch CSRF token (HTTP " + t.status + ")");
        }
        var r = await fetch(this._getTaskInstancesBaseURL(), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": sToken },
          credentials: "include",
          body: JSON.stringify({ status: "COMPLETED", context: this._buildOutputs(), decision: outcomeId })
        });
        if (!r.ok) {
          var sText = await r.text();
          var sMsg = sText;
          try {
            sMsg = (JSON.parse(sText).error || {}).message || sText;
          } catch (e) { /* plain text */ }
          throw new Error(sMsg || "HTTP " + r.status);
        }
      },

      _refreshTaskList: function () {
        this.getInboxAPI().updateTask("NA", this.getTaskInstanceID());
      }
    });
  }
);