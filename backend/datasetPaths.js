/**
 * S3 layout under datasets/{id}/.
 * v1 (default): matches deployed vaidio-trafficatlas-end-to-end-pipeline (sample/, full_data.zip).
 * v2: proposed layout (sample_dataset/, full_dataset/) — enable only after SFN Batch jobs are updated.
 */
const LAYOUT = String(process.env.DATASET_S3_LAYOUT || 'v1').toLowerCase();

function isV2Layout() {
  return LAYOUT === 'v2';
}

function sampleZipRelPaths() {
  if (isV2Layout()) {
    return ['sample_dataset/sample_data.zip', 'sample/sample_data.zip', 'sample_data.zip'];
  }
  return ['sample/sample_data.zip', 'sample_dataset/sample_data.zip', 'sample_data.zip'];
}

function fullZipRelPaths() {
  if (isV2Layout()) {
    return ['full_dataset/full_dataset.zip', 'full/full_data.zip', 'full_data.zip'];
  }
  return ['full/full_data.zip', 'full_dataset/full_dataset.zip', 'full_data.zip'];
}

function primarySampleZipRel() {
  return sampleZipRelPaths()[0];
}

function primaryFullZipRel() {
  return fullZipRelPaths()[0];
}

module.exports = {
  isV2Layout,
  sampleZipRelPaths,
  fullZipRelPaths,
  primarySampleZipRel,
  primaryFullZipRel,
};
