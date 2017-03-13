import React from 'react';
import ReactDOM from 'react-dom';
import App from './components/App/app';
import ASCVDRisk from './app/load_fhir_data';

ASCVDRisk.fetchPatientData().then(
  () => {
    ReactDOM.render(<App />, document.getElementById('container'));
  },
);
