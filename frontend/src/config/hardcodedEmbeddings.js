/** Must match backend/embeddingsSphericalPca.js — only used when REACT_APP_USE_PIPELINE_DEMO=true */
import { isPipelineDemoMode } from './demoMode';
import bundledPcaJson from '../data/hardcoded-spherical-pca.json';
import bundledFilterTagsJson from '../data/hardcoded-dataset-filter-tags.json';
import bundledDatasetMetadata from '../data/hardcoded-dataset-metadata.json';

export const HARDCODED_EMBEDDINGS_DATASET_ID = '4ee8dc70-c221-486f-9ec0-53cde7c8c41d';
export const HARDCODED_VIDEO_ID = '400661_0062_20240612_184739';
/** Shown when dataset metadata API is unavailable (demo bundle). */
export const HARDCODED_DATASET_FALLBACK_TITLE = bundledDatasetMetadata.title;

let cachedPca = null;

export function isHardcodedEmbeddingsDataset(datasetId) {
  if (!isPipelineDemoMode()) {
    return false;
  }
  return String(datasetId || '').toLowerCase() === HARDCODED_EMBEDDINGS_DATASET_ID.toLowerCase();
}

export function getHardcodedVideosList() {
  return [{ videoId: HARDCODED_VIDEO_ID, hardcoded: true }];
}

function normalizeBundledPca(data) {
  return {
    ...data,
    success: true,
    hardcoded: true,
    hasFileTags: Boolean(data.hasFileTags && data.frameTags?.length),
    datasetId: HARDCODED_EMBEDDINGS_DATASET_ID,
    videoIds: data.videoIds || Array.from({ length: data.nClips || 0 }, () => HARDCODED_VIDEO_ID),
  };
}

/** Load bundled spherical PCA (compiled into the JS bundle — no separate fetch). */
export async function loadHardcodedSphericalPca() {
  if (cachedPca) {
    return cachedPca;
  }
  cachedPca = normalizeBundledPca(bundledPcaJson);
  return cachedPca;
}

/** Bundled dataset_filter_tags.json (compiled into JS bundle — no API). */
export function loadHardcodedDatasetFilterTags() {
  return {
    ...bundledFilterTagsJson,
    hardcoded: true,
  };
}

/** Merge display metadata for demo dataset (overrides placeholder API fields). */
export function applyHardcodedDatasetMetadata(dataset) {
  const base = dataset && typeof dataset === 'object' ? dataset : {};
  return {
    ...base,
    ...bundledDatasetMetadata,
    dataset_id: HARDCODED_EMBEDDINGS_DATASET_ID,
    created_at: base.created_at || base.createdAt || bundledDatasetMetadata.created_at,
  };
}
