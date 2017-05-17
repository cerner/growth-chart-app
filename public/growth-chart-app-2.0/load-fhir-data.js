window.GC = window.GC || {};

/**
 * Function to initialize Canadarm logging for the application.
 */
function initializeLogging() {
  Canadarm.init({
    onError: true,  // Set to false if you do not want window.onerror set.
    wrapEvents: false, // Set to false if you do not want all event handlers to be logged for errors
    logLevel: Canadarm.level.INFO, // Will only send logs for level of INFO and above.
    appenders: [
      Canadarm.Appender.standardLogAppender
    ],
    handlers: [
      Canadarm.Handler.beaconLogHandler(config.canadarm_beacon_url),
      Canadarm.Handler.consoleLogHandler
    ]
  });
}

GC.get_data = function() {

  initializeLogging();

  function postCandarmLog(smart, canadarmLog, logLevel){
    var logMessage = {};
    logMessage.app_name = 'Growth Chart';
    if (smart){
      logMessage.info = {
        tenant_key:  smart.tokenResponse ? smart.tokenResponse.tenant : '',
        user_id: smart.tokenResponse ? smart.tokenResponse.user : '',
        username: smart.tokenResponse ? smart.tokenResponse.username : ''
      };
    }
    logMessage.details = canadarmLog;
    switch (logLevel) {
      case 'INFO':
        Canadarm.info(JSON.stringify(logMessage));
        break;
      case 'ERROR':
        Canadarm.error(JSON.stringify(logMessage));
        break;
      case 'DEBUG':
        Canadarm.debug(JSON.stringify(logMessage));
        break;
      default:
        Canadarm.warn(JSON.stringify(logMessage));
    }
  }

  var dfd = $.Deferred();

  FHIR.oauth2.ready(onReady, onError);

  function onError(errMsg){
    console.error("Loading error", arguments);

    var canadarmLog = {msg: "Oauth2 failure : " + errMsg};
    postCandarmLog(undefined, canadarmLog, Canadarm.level.ERROR);

    dfd.reject({
      responseText: "Loading error. See console for details."
    });
  };

  function onErrorWithWarning(msg, smart, canadarmLog, logLevel){
    postCandarmLog(smart, canadarmLog, logLevel);
    console.error("Loading error", arguments);
    dfd.reject({
      responseText: msg,
      showMessage: true,
      messageType: 'warning',
    })
  };

  function onReady(smart){

    var hidePatientHeader = (smart.tokenResponse.need_patient_banner === false);
    GC.Preferences.prop("hidePatientHeader", hidePatientHeader);

    function defaultOnFail(promise, defaultValue) {
      var deferred = $.Deferred();
      $.when(promise).then(
          function (data) {
            deferred.resolve(data);
          },
          function () {
            deferred.resolve(defaultValue);
          }
      );
      return deferred.promise();
    };

    if (smart.hasOwnProperty('patient')) {
      var ptFetch = smart.patient.read();
      var vitalsFetch = smart.patient.api.fetchAll({type: "Observation", query: {code: {$or: [
        //Weight
        'http://loinc.org|3141-9',
        'http://loinc.org|29463-7',
        'http://loinc.org|8335-2',
        //Height
        'http://loinc.org|8302-2',
        'http://loinc.org|8301-4',
        'http://loinc.org|3137-7',
        //Head Circumference
        'http://loinc.org|8287-5',
        //BMI
        'http://loinc.org|39156-5',
        //Gestsational Age
        'http://loinc.org|18185-9',
        //Gestsational Age Cerner
        'http://loinc.org|11884-4',
        //Bone Age
        'http://loinc.org|85151-9',
        //Bone Age Old To Remove
        'http://loinc.org|37362-1',
        //Parental Height Father
        'http://loinc.org|83845-8',
        //Parental Height Mother
        'http://loinc.org|83846-6',
        //Parental Height Father/Mother To Remove
        'http://snomed.info/sct|8021000175101', 'http://snomed.info/sct|8031000175103']}}});

      $.when(ptFetch, vitalsFetch).fail(function(jqXHR) {
        const status = jqXHR ? "Status:"+ jqXHR.status + "StatusText:" + jqXHR.statusText : '';
        const canadarmLog = {};
        canadarmLog.msg = "Patient or Observations resource failed Error:" + status;
        onErrorWithWarning(GC.str('STR_Error_LoadingApplication'), smart, canadarmLog, Canadarm.level.ERROR);
      });

      var familyHistoryFetch = defaultOnFail(smart.patient.api.fetchAll({type: "FamilyMemberHistory"}), []);

      $.when(ptFetch, vitalsFetch, familyHistoryFetch).done(onData);
    } else {
      var canadarmLog = {msg: "Patient property unavailable on smart object."};
      onErrorWithWarning(GC.str('STR_Error_LoadingApplication'), smart, canadarmLog, Canadarm.level.ERROR);
    }

    function onData(patient, vitals, familyHistories){
      var canadarmInfo = {};

      // check patient gender
      if (!isKnownGender(patient.gender)){
        var canadarmLog = {msg:"Gender: "+ patient.gender +" - Unrecognized or Unavailable."};
        onErrorWithWarning(GC.str('STR_Error_UnknownGender'), smart, canadarmLog, Canadarm.level.ERROR);
      }

      var vitalsByCode = smart.byCodes(vitals, 'code');

      var t0 = new Date().getTime();

      // Initialize an empty patient structure
      var p = {
        demographics: { },
        vitals:{
          lengthData: [],
          weightData: [],
          BMIData: [],
          headCData: []
        },
        boneAge: [],
        familyHistory: {
          father : {
            height: null,
            isBio : false
          },
          mother : {
            height: null,
            isBio : false
          }
        }
      };

      // For debugging/exploration, a global handle on the output
      console.log("Check out the parsed FHIR data: window.patient, window.vitalsByCode, window.familyHistories");
      window.patient = patient;
      window.vitalsByCode = vitalsByCode;
      window.familyHistories = familyHistories;

      var fname = patient.name[0].given.join(" ");
      var lname = patient.name[0].family.join(" ");
      p.demographics.name = fname + " " + lname;
      p.demographics.birthday = patient.birthDate;
      p.demographics.gender = patient.gender;

      var gestAge = vitalsByCode('18185-9');
      updateCanadarmLogs(['18185-9'],'gestAge',vitalsByCode,gestAge.length);
      if (gestAge === undefined || gestAge.length == 0) {
        //handle an alternate mapping of Gest Age used by Cerner
        gestAge = vitalsByCode('11884-4');
        updateCanadarmLogs(['11884-4'],'gestAgeCerner',vitalsByCode,gestAge.length);
      }
      if (gestAge && gestAge.length > 0) {
        var weeks = 0, qty = gestAge[0].valueString ? 
          gestAge[0].valueString.value || '40W 0D' :
          gestAge[0].valueQuantity ? 
            gestAge[0].valueQuantity.value || 40 :
            40;

        if (typeof qty == 'string') {
          if (qty.indexOf("weeks") > 0 ) {
            qty = qty.replace(/ weeks/gi, "W");
          }
          qty.replace(/(\d+)([WD])\s*/gi, function(token, num, code) {
            num = parseFloat(num);
            if (code.toUpperCase() == 'D') {
              num /= 7;
            }
            weeks += num;
          });
        } else {
          weeks = qty;
        }

        p.demographics.gestationalAge = weeks;
        p.demographics.weeker = weeks;
      }

      function updateCanadarmLogs(loincs,loincKey,vitalsByCode, obsCount) {
        canadarmInfo[loincKey + 'Loinc'] = [];
        loincs.forEach(function(loinc){
          if (vitalsByCode(loinc).length > 0) {
            canadarmInfo[loincKey + 'Loinc'].push(loinc);
          }
        });
        canadarmInfo[loincKey + 'Count'] = obsCount
      }

      canadarmInfo.totalObservationsCount = Array.isArray(vitals) ? vitals.length : 0;
      canadarmInfo.invalidObservationsCount = 0;
      canadarmInfo.invalidObservations = [];

      var units = smart.units;
      var bodyWeightObservations = vitalsByCode('3141-9','29463-7','8335-2');
      updateCanadarmLogs(['3141-9','29463-7','8335-2'],'bodyWeightMeasured',vitalsByCode, bodyWeightObservations.length);
      process(bodyWeightObservations, units.kg, p.vitals.weightData);

      var bodyHeightObservations = vitalsByCode('8302-2','8301-4','3137-7');
      updateCanadarmLogs(['8302-2','8301-4','3137-7'],'bodyHeight',vitalsByCode,bodyHeightObservations.length);
      canadarmInfo.bodyHeightCount = bodyHeightObservations ? bodyHeightObservations.length : 0;
      process(bodyHeightObservations,  units.cm,  p.vitals.lengthData);

      var headCircumferenceObservations = vitalsByCode('8287-5');
      updateCanadarmLogs(['8287-5'],'headCircumference',vitalsByCode,headCircumferenceObservations.length);
      process(headCircumferenceObservations,  units.cm,  p.vitals.headCData);

      var bodyMassIndexObservations = vitalsByCode('39156-5');
      updateCanadarmLogs(['39156-5'],'bodyMassIndex',vitalsByCode,bodyMassIndexObservations.length);
      process(bodyMassIndexObservations, units.any, p.vitals.BMIData);

      var boneXRayBoneAgeObservations = vitalsByCode('85151-9').length > 0 ? vitalsByCode('85151-9') : vitalsByCode('37362-1');
      updateCanadarmLogs(['85151-9','37362-1'],'boneXRayBoneAge',vitalsByCode,boneXRayBoneAgeObservations.length);
      processBA(boneXRayBoneAgeObservations, p.boneAge);

      function isKnownGender(gender) {
        switch (gender) {
          case 'male':
          case 'female':
            return true;
            break;
        }
        return false;
      }

      function validObservationObj(obj){
        if (obj.status && (obj.status.toLowerCase() === 'final' || obj.status.toLowerCase() === 'amended') &&
          obj.hasOwnProperty('valueQuantity') && obj.valueQuantity.hasOwnProperty('value') && obj.valueQuantity.hasOwnProperty('code')) {
          return true;
        }
        var vQ = obj.hasOwnProperty('valueQuantity') ? "value=" + obj.valueQuantity.value + " code=" +
        obj.valueQuantity.code : "";
        canadarmInfo.invalidObservations.push("Status=" + obj.status + ",valueQuantity: " + vQ);
        canadarmInfo.invalidObservationsCount += 1;
        return false
      };

      function process(observationValues, toUnit, arr){
        observationValues && observationValues.forEach(function(v){
          if (validObservationObj(v)) {
            arr.push({
              agemos: months(v.effectiveDateTime, patient.birthDate),
              value: toUnit(v.valueQuantity),
              display: v.effectiveDateTime
            });
          }
        });
      };

      function processBA(boneAgeValues, arr){
        boneAgeValues && boneAgeValues.forEach(function(v){
          if (validObservationObj(v)) {
            arr.push({
              date: v.effectiveDateTime,
              boneAgeMos: units.any(v.valueQuantity)
            });
          }
        });
      };



      function months(d){
        return -1 * new XDate(d).diffMonths(new XDate(p.demographics.birthday));
      }

      $.each(familyHistories, function(index, fh){
        if (fh.resourceType === "FamilyMemberHistory") {
              var code = fh.relationship.coding[0].code;
              $.each(fh.extension || [], function(index, ext){
                if (ext.url === "http://fhir-registry.smarthealthit.org/StructureDefinition/family-history#height") {
                  var ht = units.cm(ext.valueQuantity);
                  var r = null;
                  if (code === 'FTH') {
                    r = p.familyHistory.father;
                  } else if (code === 'MTH') {
                    r = p.familyHistory.mother;
                  }
                  if (r) {
                    r.height = ht;
                    r.isBio = true;
                  }
                }
              });
        }
      });

      // Handle Father and Mother heights :

      // Check Height of Father using LOINC first over SNOMED if familyHistory is not available
      var observations = vitalsByCode('83845-8').length > 0 ? vitalsByCode('83845-8') : vitalsByCode('8021000175101');
      updateCanadarmLogs(['83845-8','8021000175101'],'parentalHeightFather',vitalsByCode,observations.length);
      if (observations && observations.length > 0 && p.familyHistory.father.height === null){
        if (validObservationObj(observations[0])) {
          p.familyHistory.father.height = units.cm(observations[0].valueQuantity);
          p.familyHistory.father.isBio = true;
        }
      }

      // Check Height of Mother using LOINC first over SNOMED if familyHistory is not available
      observations = vitalsByCode('83846-6').length > 0 ? vitalsByCode('83846-6') : vitalsByCode('8031000175103');
      updateCanadarmLogs(['83846-6','8031000175103'],'parentalHeightMother',vitalsByCode,observations.length);
      if (observations && observations.length > 0 && p.familyHistory.mother.height === null){
        if (validObservationObj(observations[0])) {
          p.familyHistory.mother.height = units.cm(observations[0].valueQuantity);
          p.familyHistory.mother.isBio = true;
        }
      }

      window.data = p;
      postCandarmLog(smart, canadarmInfo, Canadarm.level.INFO);
      console.log("Check out the patient's growth data: window.data");
      dfd.resolve(p);
    }
  }

  return dfd.promise();
};
