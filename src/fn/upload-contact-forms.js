const environment = require('../lib/environment');
const uploadForms = require('../lib/upload-forms');

module.exports = () => uploadForms(environment.pathToProject, environment.apiUrl, 'contact', {
  id_prefix: 'contact:',
  forms: environment.extraArgs,
  default_context: { person:false, place:false },
});
