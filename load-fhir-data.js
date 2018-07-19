/* global GC, $, FHIR, XDate */
window.GC = window.GC || {};

GC.get_data = function() {
    var dfd = $.Deferred();

    function isKnownGender(gender) {
        switch (gender) {
        case 'male':
        case 'female':
            return true;
        }
        return false;
    }

    function isValidObservationObj(obj){
        if (obj.hasOwnProperty('status') && obj.status &&
            (obj.status.toLowerCase() === 'final' || obj.status.toLowerCase() === 'amended') &&
            obj.hasOwnProperty('valueQuantity') && obj.valueQuantity.hasOwnProperty('value') &&
            obj.valueQuantity.hasOwnProperty('code')) {
            return true;
        }
        return false;
    }

    function processBoneAge(boneAgeValues, arr, units) {
        boneAgeValues && boneAgeValues.forEach(function(v){
            if (isValidObservationObj(v)) {
                arr.push({
                    date: v.effectiveDateTime,
                    dateString: v.effectiveDateTime,
                    boneAgeMos: units.any(v.valueQuantity)
                })
            }
        });
    }

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
    }

    function onError() {
        console.log("Loading error", arguments);
        dfd.reject({
            responseText: "Loading error. See console for details."
        });
    }

    function onErrorWithWarning(msg){
        console.log("Loading error", arguments);
        dfd.reject({
            responseText: msg,
            showMessage : true,
            messageType : 'warning'
        });
    }

    function onReady(smart){
        var hidePatientHeader = (smart.tokenResponse.need_patient_banner === false);

        GC.Preferences.prop("hidePatientHeader", hidePatientHeader);

        function onData(patient, vitals, familyHistories) {
            // check patient gender
            if (!isKnownGender(patient.gender)) {
                onErrorWithWarning(GC.str('STR_Error_UnknownGender'));
            }

            var vitalsByCode = smart.byCodes(vitals, 'code');

            // Initialize an empty patient structure
            var p = {
                demographics: {},
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

            function months(d){
                return -1 * new XDate(d).diffMonths(new XDate(p.demographics.birthday));
            }

            function process(observationValues, toUnit, arr){
                observationValues && observationValues.forEach(function(v){
                    if (isValidObservationObj(v)) {
                        arr.push({
                            agemos: months(v.effectiveDateTime, patient.birthDate),
                            value: toUnit(v.valueQuantity),
                            display: v.effectiveDateTime,
                            dateString: v.effectiveDateTime
                        })
                    }
                });
            }

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

            var gestAge = vitalsByCode('76516-4');
            if (gestAge === undefined || gestAge.length == 0) {
              gestAge = vitalsByCode('18185-9');
              if (gestAge === undefined || gestAge.length == 0) {
                //handle an alternate mapping of Gest Age used by Cerner
                gestAge = vitalsByCode('11884-4');
              }
            }

            if (gestAge && gestAge.length > 0) {
                var weeks = 0,
                    qty = gestAge[0].valueString ?
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
                }
                else {
                    weeks = qty;
                }

                p.demographics.gestationalAge = weeks;
                p.demographics.weeker = weeks;
            }

            var units = smart.units;

            process(vitalsByCode('3141-9','29463-7','8335-2'), units.kg, p.vitals.weightData);
            process(vitalsByCode('8302-2','8301-4','3137-7'),  units.cm,  p.vitals.lengthData);
            process(vitalsByCode('8287-5'),  units.cm,  p.vitals.headCData);
            process(vitalsByCode('39156-5'), units.any, p.vitals.BMIData);
            //Bone Age: The reason to prefer the LOINC 85151-9 over 37362-1 is because 37362-1 is a LOINC for radiology report (document)
            // and may not represent a quantitative value which the app needs.
            var boneAgeObservations = vitalsByCode('85151-9') ? vitalsByCode('85151-9') : vitalsByCode('37362-1');
            processBoneAge(boneAgeObservations, p.boneAge, units);

            $.each(familyHistories, function(index, fh) {
                if (fh.resourceType === "FamilyMemberHistory") {
                    var code = fh.relationship.coding[0].code;
                    $.each(fh.extension || [], function(index2, ext){
                        if (ext.url === "http://fhir-registry.smarthealthit.org/StructureDefinition/family-history#height") {
                            var ht = units.cm(ext.valueQuantity);
                            var r = null;
                            if (code === 'FTH') {
                                r = p.familyHistory.father;
                            }
                            else if (code === 'MTH') {
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

            // Handle father's and mother's heights using LOINC when Family History FHIR resource is not available.
            var observations = vitalsByCode['83845-8'];
            if (observations && observations.length > 0 && p.familyHistory.father.height === null){
                if (isValidObservationObj(observations[0])) {
                    p.familyHistory.father.height = units.cm(observations[0].valueQuantity);
                    p.familyHistory.father.isBio = true;
                }
            }
            observations = vitalsByCode['83846-6'];
            if (observations && observations.length > 0 && p.familyHistory.mother.height === null){
                if (isValidObservationObj(observations[0])) {
                    p.familyHistory.mother.height = units.cm(observations[0].valueQuantity);
                    p.familyHistory.mother.isBio = true;
                }
            }

            window.data = p;
            console.log("Check out the patient's growth data: window.data");
            dfd.resolve(p);
        }

        if (!smart.hasOwnProperty('patient')) {
            return onErrorWithWarning(
                GC.str('STR_Error_LoadingApplication') + ": " +
                GC.str('STR_Error_NoPatient')
            );
        }

        smart.patient.read().then(
            function(ptFetch) {
                var vitalsFetch = smart.patient.api.fetchAll({
                    type: "Observation",
                    query: {
                        code: {
                            $or: [
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

                                //Bone Age
                                'http://loinc.org|85151-9',
                                'http://loinc.org|37362-1',

                                //Gestsational Age at Birth
                                'http://loinc.org|76516-4',

                                //Gestsational Age
                                'http://loinc.org|18185-9',
                                'http://loinc.org|11884-4',

                                //Parental Height Father
                                'http://loinc.org|83845-8',
                                //Parental Height Mother
                                'http://loinc.org|83846-6'
                            ]
                        }
                    }
                });

                var familyHistoryFetch = defaultOnFail(
                    smart.patient.api.fetchAll({
                        type: "FamilyMemberHistory"
                    }),
                    []
                );

                $.when(ptFetch, vitalsFetch, familyHistoryFetch).done(onData);
            },
            function(error) {
                onErrorWithWarning(
                    GC.str('STR_Error_LoadingApplication') + " (" + error + ")"
                );
            }
        )
    }

    FHIR.oauth2.ready(onReady, onError);
    return dfd.promise();
};
