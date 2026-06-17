const fs = require('fs');
const path = require('path');
const { PCA } = require('ml-pca');
const { loadNpyFile, parseNpy } = require('./npyLoader');
const s3Storage = require('./s3Storage');
const stepFunctions = require('./stepFunctions');
const embeddingsTags = require('./embeddingsTags');
const { clusterEmbeddings } = require('./embeddingCluster');
const { isEmbeddingsDemoEnabled } = require('./demoMode');

const REPO_ROOT = path.join(__dirname, '..');
const CLIP_EMBEDDINGS_SUFFIX = '_clip_embeddings.npy';
const CLIP_PATH_RE = /\/embeddings\/clip\/([^/]+)\//;

/** Hardcoded demo dataset + embeddings (Traffic Atlas / Vaidio pipeline). */
const HARDCODED_DATASET_ID = '4ee8dc70-c221-486f-9ec0-53cde7c8c41d';
const HARDCODED_VIDEO_ID = '400661_0062_20240612_184739';
const HARDCODED_NPY_PATH = path.join(REPO_ROOT, `${HARDCODED_VIDEO_ID}${CLIP_EMBEDDINGS_SUFFIX}`);
const HARDCODED_PCA_JSON_PATH = path.join(
  REPO_ROOT,
  'plots',
  `${HARDCODED_VIDEO_ID}_spherical_pca.json`
);
const HARDCODED_S3_KEY =
  `traffic-atlas/datasets/${HARDCODED_DATASET_ID}/analysis/embeddings/clip/${HARDCODED_VIDEO_ID}/${HARDCODED_VIDEO_ID}${CLIP_EMBEDDINGS_SUFFIX}`;

function isHardcodedDataset(datasetId) {
  if (!isEmbeddingsDemoEnabled()) {
    return false;
  }
  return String(datasetId || '').toLowerCase() === HARDCODED_DATASET_ID.toLowerCase();
}

function loadHardcodedSources(videoId = null) {
  if (!isHardcodedDataset(HARDCODED_DATASET_ID)) {
    return null;
  }
  if (videoId && videoId !== HARDCODED_VIDEO_ID) {
    return null;
  }
  if (!fs.existsSync(HARDCODED_NPY_PATH)) {
    return null;
  }
  const { data, rows, cols } = loadNpyFile(HARDCODED_NPY_PATH);
  return [{
    videoId: HARDCODED_VIDEO_ID,
    data: normalizeRows(data),
    rows,
    cols,
    source: `s3://your-s3-bucket/${HARDCODED_S3_KEY}`,
  }];
}

function loadHardcodedPcaJson(videoId = null) {
  if (!fs.existsSync(HARDCODED_PCA_JSON_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(HARDCODED_PCA_JSON_PATH, 'utf8'));
    if (!parsed?.points?.length) {
      return null;
    }
    if (videoId && parsed.videoIds?.length && !parsed.videoIds.every((v) => v === videoId)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getEmbeddingsClipPrefix(datasetId) {
  return `${stepFunctions.getDatasetRootPrefix(datasetId)}analysis/embeddings/clip/`;
}

function getSphericalPcaJsonKey(datasetId) {
  return `${stepFunctions.getDatasetRootPrefix(datasetId)}analysis/embeddings/spherical_pca.json`;
}

function parseVideoIdFromKey(key) {
  const match = String(key).match(CLIP_PATH_RE);
  return match ? match[1] : null;
}

function normalizeRows(matrix) {
  return matrix.map((row) => {
    const norm = Math.sqrt(row.reduce((s, v) => s + v * v, 0)) || 1;
    return row.map((v) => v / norm);
  });
}

function sphericalMeanDirection(X) {
  const d = X[0].length;
  const mu = new Array(d).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    for (let j = 0; j < d; j += 1) {
      mu[j] += X[i][j];
    }
  }
  const n = Math.sqrt(mu.reduce((s, v) => s + v * v, 0)) || 1;
  return mu.map((v) => v / n);
}

function tangentSpacePca(X, nComponents = 3) {
  const mu = sphericalMeanDirection(X);
  const T = X.map((row) => {
    const dot = row.reduce((s, v, j) => s + v * mu[j], 0);
    return row.map((v, j) => v - dot * mu[j]);
  });
  const pca = new PCA(T);
  const predicted = pca.predict(T, { nComponents });
  const coords = typeof predicted.to2DArray === 'function' ? predicted.to2DArray() : predicted;
  return normalizeRows(coords);
}

function stereographicProject(points3d) {
  return points3d.map(([x, y, z]) => {
    const denom = Math.abs(1 - z) < 1e-8 ? 1e-8 : 1 - z;
    return [x / denom, y / denom];
  });
}

function listLocalClipEmbeddingFiles(datasetId) {
  const clipRoot = path.join(
    __dirname,
    'data',
    'datasets',
    datasetId,
    'analysis',
    'embeddings',
    'clip'
  );
  if (!fs.existsSync(clipRoot)) {
    return [];
  }

  const entries = [];
  for (const videoId of fs.readdirSync(clipRoot)) {
    const dir = path.join(clipRoot, videoId);
    if (!fs.statSync(dir).isDirectory()) continue;
    const npyPath = path.join(dir, `${videoId}${CLIP_EMBEDDINGS_SUFFIX}`);
    if (fs.existsSync(npyPath)) {
      entries.push({ videoId, key: null, localPath: npyPath });
    }
  }
  return entries.sort((a, b) => a.videoId.localeCompare(b.videoId));
}

async function listS3ClipEmbeddingKeys(datasetId) {
  if (!s3Storage.isEnabled()) {
    return [];
  }
  const prefix = getEmbeddingsClipPrefix(datasetId);
  const keys = await s3Storage.listObjectKeysByPrefix(prefix);
  return keys
    .filter((key) => key.endsWith(CLIP_EMBEDDINGS_SUFFIX))
    .map((key) => ({
      videoId: parseVideoIdFromKey(key),
      key,
      localPath: null,
    }))
    .filter((entry) => entry.videoId)
    .sort((a, b) => a.videoId.localeCompare(b.videoId));
}

async function discoverClipEmbeddingSources(datasetId) {
  const s3Entries = await listS3ClipEmbeddingKeys(datasetId);
  if (s3Entries.length) {
    return s3Entries;
  }
  return listLocalClipEmbeddingFiles(datasetId);
}

async function loadNpyEntry(entry) {
  if (entry.localPath) {
    const { data, rows, cols } = loadNpyFile(entry.localPath);
    return {
      videoId: entry.videoId,
      data: normalizeRows(data),
      rows,
      cols,
      source: entry.localPath,
    };
  }
  const buffer = await s3Storage.getObjectBufferByKey(entry.key);
  const { data, rows, cols } = parseNpy(buffer);
  const bucket = process.env.S3_BUCKET || 'your-s3-bucket';
  return {
    videoId: entry.videoId,
    data: normalizeRows(data),
    rows,
    cols,
    source: `s3://${bucket}/${entry.key}`,
  };
}

async function loadEmbeddingsFromClipSources(datasetId, { videoId = null } = {}) {
  let entries = await discoverClipEmbeddingSources(datasetId);

  if (videoId) {
    entries = entries.filter((e) => e.videoId === videoId);
  }

  if (!entries.length) {
    return null;
  }

  const loaded = [];
  for (const entry of entries) {
    try {
      loaded.push(await loadNpyEntry(entry));
    } catch (error) {
      console.warn(`Failed to load embeddings ${entry.key || entry.localPath}:`, error.message);
    }
  }

  if (!loaded.length) {
    return null;
  }

  return loaded;
}

async function loadCachedJson(datasetId, { videoId = null } = {}) {
  if (isHardcodedDataset(datasetId)) {
    const hardcoded = loadHardcodedPcaJson(videoId);
    if (hardcoded) {
      return hardcoded;
    }
  }
  if (s3Storage.isEnabled()) {
    try {
      const text = await s3Storage.getObjectTextByKey(getSphericalPcaJsonKey(datasetId));
      const parsed = JSON.parse(text);
      if (parsed?.points?.length) {
        if (!videoId || !parsed.videoIds || parsed.videoIds.every((v) => v === videoId)) {
          return parsed;
        }
      }
    } catch {
      // continue
    }
  }
  return null;
}

function buildPayloadFromSources(sources, meta = {}) {
  const allData = [];
  const clipIndices = [];
  const videoIds = [];
  const sourceMeta = [];

  for (const src of sources) {
    sourceMeta.push({
      videoId: src.videoId,
      nClips: src.rows,
      dim: src.cols,
      source: src.source,
    });
    for (let i = 0; i < src.data.length; i += 1) {
      allData.push(src.data[i]);
      clipIndices.push(i);
      videoIds.push(src.videoId);
    }
  }

  const dim = sources[0].cols;
  const clusterMeta = clusterEmbeddings(allData, {
    method: 'dbscan',
    pcaDims: Number(process.env.EMBEDDING_CLUSTER_PCA_DIMS) || 50,
    eps: process.env.EMBEDDING_DBSCAN_EPS
      ? Number(process.env.EMBEDDING_DBSCAN_EPS)
      : undefined,
    minPts: process.env.EMBEDDING_DBSCAN_MIN_PTS
      ? Number(process.env.EMBEDDING_DBSCAN_MIN_PTS)
      : undefined,
  });
  const points = tangentSpacePca(allData, 3);
  const stereo = stereographicProject(points);

  return {
    success: true,
    datasetId: meta.datasetId || null,
    videoId: meta.videoId || null,
    nClips: allData.length,
    dim,
    nVideos: sources.length,
    sources: sourceMeta,
    source: sourceMeta.map((s) => s.source).join(' | '),
    points,
    stereographic: stereo,
    clipIndices,
    videoIds,
    clusterIds: clusterMeta.clusterIds,
    clusterLabels: clusterMeta.clusterLabels,
    nClusters: clusterMeta.nClusters,
    noiseCount: clusterMeta.noiseCount,
    clusteringMethod: clusterMeta.method,
    pcaClusterDims: clusterMeta.pcaDims,
    dbscanEps: clusterMeta.eps,
    dbscanMinPts: clusterMeta.minPts,
  };
}

async function buildPayloadFromSourcesAsync(sources, meta = {}) {
  const payload = buildPayloadFromSources(sources, meta);
  return embeddingsTags.attachBedrockTags(payload, meta.datasetId, sources);
}

async function getSphericalPcaForDataset(datasetId, { videoId = null } = {}) {
  if (isHardcodedDataset(datasetId)) {
    const cached = loadHardcodedPcaJson(videoId);
    if (cached?.points?.length) {
      return {
        ...cached,
        success: true,
        datasetId,
        cached: true,
        hardcoded: true,
        hasFileTags: Boolean(cached.hasFileTags && cached.frameTags?.length),
        videoId: videoId || null,
      };
    }
    const hardcodedSources = loadHardcodedSources(videoId);
    if (hardcodedSources?.length) {
      return buildPayloadFromSourcesAsync(hardcodedSources, { datasetId, videoId, hardcoded: true });
    }
  }

  let sources = await loadEmbeddingsFromClipSources(datasetId, { videoId });

  if (sources?.length) {
    return buildPayloadFromSourcesAsync(sources, { datasetId, videoId });
  }

  const cached = await loadCachedJson(datasetId, { videoId });
  if (cached?.points?.length) {
    const base = { ...cached, success: true, datasetId, cached: true, videoId: videoId || cached.videoId || null };
    if (!base.frameTags?.length && sources?.length) {
      return embeddingsTags.attachBedrockTags(base, datasetId, sources);
    }
    return base;
  }

  const prefix = getEmbeddingsClipPrefix(datasetId);
  const err = new Error(
    `CLIP embeddings not found. Expected S3 objects under ${prefix}<video_id>/*_clip_embeddings.npy`
  );
  err.statusCode = 404;
  throw err;
}

/** List available clip embedding videos for a dataset (for UI selector). */
async function listEmbeddingVideos(datasetId) {
  let entries = await discoverClipEmbeddingSources(datasetId);
  if (!entries.length && isHardcodedDataset(datasetId) && fs.existsSync(HARDCODED_NPY_PATH)) {
    entries = [{
      videoId: HARDCODED_VIDEO_ID,
      key: HARDCODED_S3_KEY,
      localPath: HARDCODED_NPY_PATH,
    }];
  }
  return entries.map((e) => ({
    videoId: e.videoId,
    s3Key: e.key || null,
    localPath: e.localPath || null,
  }));
}

module.exports = {
  HARDCODED_DATASET_ID,
  HARDCODED_VIDEO_ID,
  isHardcodedDataset,
  getEmbeddingsClipPrefix,
  getSphericalPcaForDataset,
  listEmbeddingVideos,
  tangentSpacePca,
  stereographicProject,
};
