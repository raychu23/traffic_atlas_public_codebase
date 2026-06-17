const fs = require('fs');
const path = require('path');
const s3Storage = require('./s3Storage');
const stepFunctions = require('./stepFunctions');

const REPO_ROOT = path.join(__dirname, '..');
const LOCAL_FRAME_TAGS = path.join(REPO_ROOT, '.s3-samples/frame_tags.json');

/** Bedrock tag dimensions in frame_tags.json */
const TAG_FIELDS = [
  'traffic_density',
  'weather',
  'lighting',
  'road_type',
  'vehicle_presence',
  'pedestrian_presence',
  'cyclist_presence',
  'truck_presence',
  'bus_presence',
  'motorcycle_presence',
  'emergency_vehicle_presence',
];

function getFrameTagsS3Key(datasetId) {
  return `${stepFunctions.getDatasetRootPrefix(datasetId)}analysis/tags/frame_level/frame_tags.json`;
}

function parseFrameIndex(frameStem) {
  const match = String(frameStem || '').match(/frame_(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

async function loadFrameTagsDocument(datasetId) {
  if (s3Storage.isEnabled()) {
    try {
      const text = await s3Storage.getObjectTextByKey(getFrameTagsS3Key(datasetId));
      return JSON.parse(text);
    } catch (error) {
      console.warn('S3 frame_tags load failed:', error.message);
    }
  }
  if (fs.existsSync(LOCAL_FRAME_TAGS)) {
    return JSON.parse(fs.readFileSync(LOCAL_FRAME_TAGS, 'utf8'));
  }
  return null;
}

/** videoId -> { rowIndex -> tag record } */
function indexFrameTagsByVideo(doc) {
  const byVideo = {};
  const records = Array.isArray(doc?.records) ? doc.records : [];
  for (const rec of records) {
    const video = rec.video_name;
    if (!video) continue;
    const idx = parseFrameIndex(rec.frame_stem);
    if (idx === null) continue;
    if (!byVideo[video]) byVideo[video] = {};
    byVideo[video][idx] = rec;
  }
  return byVideo;
}

/**
 * Align Bedrock tags to embedding rows (same order as .npy / PCA points).
 */
function alignFrameTagsForSources(sources, byVideo) {
  const frameTags = [];
  for (const src of sources) {
    const map = byVideo[src.videoId] || {};
    for (let i = 0; i < src.rows; i += 1) {
      const rec = map[i];
      frameTags.push({
        clipIndex: i,
        videoId: src.videoId,
        recordId: rec?.recordId || null,
        frameStem: rec?.frame_stem || `frame_${String(i).padStart(6, '0')}`,
        tags: rec?.tags || {},
        shortDescription: rec?.short_description || null,
      });
    }
  }
  return frameTags;
}

async function attachBedrockTags(payload, datasetId, sources) {
  const doc = await loadFrameTagsDocument(datasetId);
  if (!doc) {
    return {
      ...payload,
      hasFileTags: false,
      tagFields: TAG_FIELDS,
      frameTags: [],
    };
  }

  const byVideo = indexFrameTagsByVideo(doc);
  const frameTags = alignFrameTagsForSources(sources, byVideo);
  const hasAny = frameTags.some((ft) => Object.keys(ft.tags || {}).length > 0);

  return {
    ...payload,
    hasFileTags: hasAny,
    tagFields: TAG_FIELDS,
    frameTags,
  };
}

module.exports = {
  TAG_FIELDS,
  getFrameTagsS3Key,
  loadFrameTagsDocument,
  attachBedrockTags,
};
