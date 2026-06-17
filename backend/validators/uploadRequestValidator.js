const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schema = require('../schemas/upload-request.schema.json');

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});
addFormats(ajv);

const validateUploadRequestSchema = ajv.compile(schema);

function formatAjvErrors(errors = []) {
  return errors.map((error) => {
    const path = error.instancePath ? error.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'root';
    return `${path}: ${error.message}`;
  });
}

module.exports = {
  validateUploadRequestSchema,
  formatAjvErrors
};
