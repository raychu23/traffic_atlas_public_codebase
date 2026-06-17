/**
 * Reduce embeddings in tangent space, then cluster (DBSCAN by default).
 * 3D spherical PCA for visualization uses separate logic in embeddingsSphericalPca.js.
 */

const { PCA } = require('ml-pca');

const DEFAULT_CLUSTER_DIMS = 50;
const DEFAULT_MIN_PTS = 5;

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
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

function projectToTangentSpace(X) {
  const mu = sphericalMeanDirection(X);
  return X.map((row) => {
    const dot = row.reduce((s, v, j) => s + v * mu[j], 0);
    return row.map((v, j) => v - dot * mu[j]);
  });
}

/**
 * Tangent-space PCA without spherical re-normalization (for clustering space).
 */
function pcaReduceInTangentSpace(X, nComponents) {
  const n = X.length;
  const dims = Math.min(nComponents, n, X[0].length);
  if (dims < 1) {
    return { coords: X.map(() => []), dims: 0 };
  }

  const T = projectToTangentSpace(X);
  const pca = new PCA(T);
  const predicted = pca.predict(T, { nComponents: dims });
  const coords =
    typeof predicted.to2DArray === 'function' ? predicted.to2DArray() : predicted;
  return { coords, dims };
}

function regionQuery(points, idx, eps) {
  const neighbors = [];
  for (let i = 0; i < points.length; i += 1) {
    if (euclidean(points[idx], points[i]) <= eps) {
      neighbors.push(i);
    }
  }
  return neighbors;
}

/**
 * Classic DBSCAN. Unassigned noise points are labeled -1.
 */
function dbscan(points, eps, minPts) {
  const n = points.length;
  if (n === 0) return [];

  const labels = new Array(n).fill(undefined);
  let clusterId = 0;

  for (let i = 0; i < n; i += 1) {
    if (labels[i] !== undefined) continue;

    const neighbors = regionQuery(points, i, eps);
    if (neighbors.length < minPts) {
      labels[i] = -1;
      continue;
    }

    labels[i] = clusterId;
    const seeds = neighbors.filter((j) => j !== i);

    for (let s = 0; s < seeds.length; s += 1) {
      const q = seeds[s];
      if (labels[q] === -1) {
        labels[q] = clusterId;
      }
      if (labels[q] !== undefined) continue;

      labels[q] = clusterId;
      const qNeighbors = regionQuery(points, q, eps);
      if (qNeighbors.length >= minPts) {
        for (const nn of qNeighbors) {
          if (!seeds.includes(nn)) {
            seeds.push(nn);
          }
        }
      }
    }

    clusterId += 1;
  }

  return labels.map((l) => (l === undefined ? -1 : l));
}

/** Heuristic eps from k-NN distances (70th percentile). */
function estimateDbscanEps(points, minPts) {
  const n = points.length;
  if (n < 2) return 0.5;

  const k = Math.min(minPts, n - 1);
  const knnDistances = points.map((_, i) => {
    const dists = [];
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      dists.push(euclidean(points[i], points[j]));
    }
    dists.sort((a, b) => a - b);
    return dists[Math.min(k - 1, dists.length - 1)] ?? 0;
  });

  knnDistances.sort((a, b) => a - b);
  const idx = Math.floor(knnDistances.length * 0.7);
  const eps = knnDistances[Math.min(idx, knnDistances.length - 1)];
  return Math.max(eps, 1e-6);
}

function buildClusterLabels(clusterIds) {
  return clusterIds.map((id) => (id < 0 ? 'Noise' : `Cluster ${id}`));
}

/**
 * @param {number[][]} normalizedEmbeddings - L2-normalized rows (512-d)
 * @param {{ method?: string, pcaDims?: number, eps?: number, minPts?: number }} options
 */
function clusterEmbeddings(normalizedEmbeddings, options = {}) {
  const n = normalizedEmbeddings.length;
  if (n === 0) {
    return {
      clusterIds: [],
      clusterLabels: [],
      nClusters: 0,
      noiseCount: 0,
      method: 'none',
      pcaDims: 0,
      eps: null,
      minPts: null,
    };
  }

  if (n === 1) {
    return {
      clusterIds: [0],
      clusterLabels: ['Cluster 0'],
      nClusters: 1,
      noiseCount: 0,
      method: 'singleton',
      pcaDims: 1,
      eps: null,
      minPts: null,
    };
  }

  const method = String(options.method || 'dbscan').toLowerCase();
  const pcaDims = options.pcaDims ?? DEFAULT_CLUSTER_DIMS;
  const minPts = options.minPts ?? Math.min(DEFAULT_MIN_PTS, Math.max(2, Math.floor(n / 20)));

  const { coords, dims } = pcaReduceInTangentSpace(normalizedEmbeddings, pcaDims);

  let clusterIds;
  let eps = options.eps ?? null;

  if (method === 'dbscan') {
    eps = eps ?? estimateDbscanEps(coords, minPts);
    clusterIds = dbscan(coords, eps, minPts);
  } else {
    throw new Error(`Unsupported clustering method: ${method}`);
  }

  const noiseCount = clusterIds.filter((id) => id < 0).length;
  const nClusters = new Set(clusterIds.filter((id) => id >= 0)).size;

  return {
    clusterIds,
    clusterLabels: buildClusterLabels(clusterIds),
    nClusters,
    noiseCount,
    method,
    pcaDims: dims,
    eps,
    minPts,
  };
}

module.exports = {
  DEFAULT_CLUSTER_DIMS,
  clusterEmbeddings,
  pcaReduceInTangentSpace,
  dbscan,
  estimateDbscanEps,
};
