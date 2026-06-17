const fs = require('fs');
const path = require('path');
const s3Storage = require('./s3Storage');
const stepFunctions = require('./stepFunctions');
const { isEmbeddingsDemoEnabled } = require('./demoMode');

const REPO_ROOT = path.join(__dirname, '..');
const LOCAL_FILTER_TAGS = path.join(REPO_ROOT, '.s3-samples/dataset_filter_tags.json');

function getFilterTagsS3Key(datasetId) {
  return `${stepFunctions.getDatasetRootPrefix(datasetId)}analysis/tags/dataset_level/dataset_filter_tags.json`;
}

async function loadDatasetFilterTags(datasetId) {
  if (s3Storage.isEnabled()) {
    try {
      const text = await s3Storage.getObjectTextByKey(getFilterTagsS3Key(datasetId));
      return JSON.parse(text);
    } catch (error) {
      console.warn('S3 dataset_filter_tags load failed:', error.message);
    }
  }
  if (isEmbeddingsDemoEnabled() && fs.existsSync(LOCAL_FILTER_TAGS)) {
    try {
      const doc = JSON.parse(fs.readFileSync(LOCAL_FILTER_TAGS, 'utf8'));
      if (!doc?.dataset_id || String(doc.dataset_id).toLowerCase() === String(datasetId).toLowerCase()) {
        return doc;
      }
    } catch (error) {
      console.warn('Local dataset_filter_tags parse failed:', error.message);
    }
  }
  return null;
}

module.exports = {
  getFilterTagsS3Key,
  loadDatasetFilterTags,
};
