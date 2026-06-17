import React, { useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import './SphericalPcaChart.css';

const PLOT_THEME = {
  paper: '#0f1419',
  plot: '#0a0e14',
  font: '#e2e8f0',
  title: '#f8fafc',
  grid: 'rgba(148, 163, 184, 0.12)',
  axis: '#94a3b8',
  accent: '#22c55e',
};

/** Distinct hues for cluster mode (readable on dark background). */
const CLUSTER_COLORS = [
  '#38bdf8', // sky
  '#fb923c', // orange
  '#e879f9', // fuchsia
  '#facc15', // yellow
  '#34d399', // emerald
  '#f472b6', // pink
  '#a78bfa', // violet
  '#2dd4bf', // teal
];

const DEFAULT_TAG_FIELDS = [
  'traffic_density',
  'weather',
  'lighting',
  'road_type',
  'vehicle_presence',
  'pedestrian_presence',
  'truck_presence',
];

/** Viridis stops (matplotlib/plotly) for discrete sampling & sphere tint. */
const VIRIDIS_STOPS = [
  '#440154',
  '#482878',
  '#3e4989',
  '#31688e',
  '#26828e',
  '#1f9e89',
  '#35b779',
  '#6ece58',
  '#b5de2b',
  '#fde725',
];

const VIRIDIS_SCALE = 'Viridis';

const PRESENCE_VIRIDIS = {
  absent: '#440154',
  no: '#440154',
  false: '#440154',
  present: '#fde725',
  yes: '#fde725',
  true: '#fde725',
  unknown: '#31688e',
};

const ORDINAL_RANK = [
  'absent', 'no', 'false', 'empty', 'low', 'medium', 'high', 'present', 'yes', 'true',
];

function viridisColor(t) {
  const clamped = Math.min(1, Math.max(0, t));
  const idx = Math.round(clamped * (VIRIDIS_STOPS.length - 1));
  return VIRIDIS_STOPS[idx];
}

function buildSphereMesh() {
  const n = 48;
  const xs = [];
  const ys = [];
  const zs = [];
  for (let i = 0; i < n; i += 1) {
    const rowX = [];
    const rowY = [];
    const rowZ = [];
    for (let j = 0; j < n; j += 1) {
      const u = (i / (n - 1)) * 2 * Math.PI;
      const v = (j / (n - 1)) * Math.PI;
      rowX.push(Math.cos(u) * Math.sin(v));
      rowY.push(Math.sin(u) * Math.sin(v));
      rowZ.push(Math.cos(v));
    }
    xs.push(rowX);
    ys.push(rowY);
    zs.push(rowZ);
  }
  return { xs, ys, zs };
}

function derivePhaseLabels(n) {
  const third = Math.max(1, Math.floor(n / 3));
  return Array.from({ length: n }, (_, i) => {
    if (i < third) return 'early';
    if (i < 2 * third) return 'mid';
    return 'late';
  });
}

function deriveClusterIds(points, k = 8) {
  const n = points.length;
  const K = Math.min(k, Math.max(2, Math.floor(n / 20)));
  let centroids = Array.from({ length: K }, (_, i) => {
    const p = points[Math.min(n - 1, Math.floor((i * n) / K))];
    return [...p];
  });
  const assign = () => {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < K; c += 1) {
        const d = (points[i][0] - centroids[c][0]) ** 2
          + (points[i][1] - centroids[c][1]) ** 2
          + (points[i][2] - centroids[c][2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      ids.push(best);
    }
    return ids;
  };
  let ids = assign();
  for (let iter = 0; iter < 12; iter += 1) {
    const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
    ids.forEach((c, i) => {
      sums[c][0] += points[i][0];
      sums[c][1] += points[i][1];
      sums[c][2] += points[i][2];
      sums[c][3] += 1;
    });
    const prevCentroids = centroids;
    centroids = sums.map((s, ci) => (
      s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : prevCentroids[ci]
    ));
    ids = assign();
  }
  return ids;
}

function formatTagField(field) {
  return String(field).replace(/_/g, ' ');
}

function formatLegendLabel(label) {
  return String(label).replace(/_/g, ' ');
}

function uniqueSorted(labels) {
  return [...new Set(labels)].sort((a, b) => String(a).localeCompare(String(b)));
}

function sortLabelsForViridis(unique) {
  return [...unique].sort((a, b) => {
    const ai = ORDINAL_RANK.indexOf(String(a).toLowerCase().trim());
    const bi = ORDINAL_RANK.indexOf(String(b).toLowerCase().trim());
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return String(a).localeCompare(String(b));
  });
}

/** Map categories to Viridis hues (no continuous colorbar). */
function buildViridisDiscreteColorMap(uniqueLabels) {
  const unique = sortLabelsForViridis(uniqueSorted(uniqueLabels));
  const map = {};
  const onlyPresence = unique.every((label) => {
    const k = String(label).toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(PRESENCE_VIRIDIS, k);
  });

  unique.forEach((label, i) => {
    const key = String(label).toLowerCase().trim();
    if (onlyPresence && PRESENCE_VIRIDIS[key]) {
      map[label] = PRESENCE_VIRIDIS[key];
    } else {
      map[label] = viridisColor(unique.length <= 1 ? 0.5 : i / (unique.length - 1));
    }
  });
  return { unique, map };
}

function buildClusterColorMap(clusterIds, clusterLabels = null) {
  const labels =
    clusterLabels?.length === clusterIds.length
      ? clusterLabels
      : clusterIds.map((c) => (c < 0 ? 'Noise' : `Cluster ${c}`));
  const unique = uniqueSorted(labels);
  const map = {};
  unique.forEach((label, i) => {
    map[label] =
      label === 'Noise' ? '#64748b' : CLUSTER_COLORS[i % CLUSTER_COLORS.length];
  });
  return {
    unique,
    map,
    markerColor: labels.map((l) => map[l] ?? '#94a3b8'),
  };
}

function normalizeClipIndices(clipIndices) {
  const minI = Math.min(...clipIndices);
  const maxI = Math.max(...clipIndices);
  const span = maxI - minI || 1;
  return clipIndices.map((i) => (i - minI) / span);
}

function buildMarkerEncoding({
  colorMode,
  clipIndices,
  temporalPhase,
  clusterIds,
  clusterLabels,
  videoIds,
  frameTags,
  uniqueVideos,
  multiVideo,
}) {
  const result = {
    markerColor: normalizeClipIndices(clipIndices),
    colorscale: VIRIDIS_SCALE,
    showscale: true,
    colorbarTitle: 'Clip index',
    cmin: 0,
    cmax: 1,
    legendItems: null,
  };

  if (colorMode.startsWith('tag:')) {
    const field = colorMode.slice(4);
    const labels = frameTags.map((ft) => ft?.tags?.[field] ?? 'unknown');
    const { unique, map } = buildViridisDiscreteColorMap(labels);

    result.markerColor = labels.map((l) => map[l] ?? viridisColor(0.5));
    result.showscale = false;
    result.colorscale = undefined;
    result.colorbarTitle = null;
    result.legendItems = unique.map((label) => ({
      label: formatLegendLabel(label),
      color: map[label],
    }));
    return result;
  }

  if (colorMode === 'cluster') {
    const { unique, map, markerColor } = buildClusterColorMap(clusterIds, clusterLabels);
    result.markerColor = markerColor;
    result.showscale = false;
    result.colorscale = undefined;
    result.legendItems = unique.map((label) => ({
      label,
      color: map[label],
    }));
    return result;
  }

  if (colorMode === 'phase') {
    const { unique, map } = buildViridisDiscreteColorMap(temporalPhase);
    result.markerColor = temporalPhase.map((l) => map[l]);
    result.showscale = false;
    result.colorscale = undefined;
    result.legendItems = unique.map((label) => ({
      label: formatLegendLabel(label),
      color: map[label],
    }));
    return result;
  }

  if (multiVideo) {
    const labels = videoIds.map((v) => v || 'unknown');
    const { unique, map } = buildViridisDiscreteColorMap(labels);
    result.markerColor = labels.map((l) => map[l]);
    result.showscale = false;
    result.colorscale = undefined;
    result.legendItems = unique.map((label) => ({
      label,
      color: map[label],
    }));
    return result;
  }

  return result;
}

function SphericalPcaChart({ data, title }) {
  const sphere = useMemo(() => buildSphereMesh(), []);
  const tagFields = data?.tagFields || data?.tag_fields || DEFAULT_TAG_FIELDS;
  const hasFrameTags = data?.hasFileTags === true && (data?.frameTags?.length > 0);
  const [colorMode, setColorMode] = useState('cluster');

  const enriched = useMemo(() => {
    if (!data?.points?.length) return null;
    const n = data.points.length;
    const clipIndices = data.clipIndices || data.points.map((_, i) => i);
    const temporalPhase = data.temporalPhase || data.temporal_phase || derivePhaseLabels(n);
    const clusterIds = data.clusterIds || data.cluster_ids || deriveClusterIds(data.points, data.nClusters || 8);
    const clusterLabels = data.clusterLabels || clusterIds.map((c) => `Cluster ${c}`);
    const videoIds = data.videoIds || data.video_ids || [];
    const frameTags = data.frameTags || data.frame_tags || [];
    return {
      clipIndices,
      temporalPhase,
      clusterIds,
      clusterLabels,
      videoIds,
      frameTags,
    };
  }, [data]);

  if (!data?.points?.length || !enriched) {
    return null;
  }

  const {
    clipIndices,
    temporalPhase,
    clusterIds,
    clusterLabels,
    videoIds,
    frameTags,
  } = enriched;
  const xs = data.points.map((p) => p[0]);
  const ys = data.points.map((p) => p[1]);
  const zs = data.points.map((p) => p[2]);
  const uniqueVideos = [...new Set(videoIds.filter(Boolean))];
  const multiVideo = uniqueVideos.length > 1;

  const encoding = buildMarkerEncoding({
    colorMode,
    clipIndices,
    temporalPhase,
    clusterIds,
    clusterLabels,
    videoIds,
    frameTags,
    uniqueVideos,
    multiVideo,
  });

  const clusterHint =
    data.clusteringMethod === 'dbscan' && data.pcaClusterDims
      ? `Clusters: DBSCAN on ${data.pcaClusterDims}D PCA · 3D view for display only`
      : null;

  const hoverText = clipIndices.map((idx, i) => {
    const ft = frameTags[i];
    const parts = [];
    if (videoIds[i]) parts.push(`<b>${videoIds[i]}</b>`);
    parts.push(`Clip <b>${idx}</b>`);
    if (ft?.tags && Object.keys(ft.tags).length) {
      Object.entries(ft.tags).forEach(([k, v]) => {
        parts.push(`${formatTagField(k)}: <b>${v}</b>`);
      });
    }
    if (ft?.shortDescription) parts.push(ft.shortDescription);
    if (!ft?.tags || !Object.keys(ft.tags).length) {
      parts.push(`Phase: ${temporalPhase[i]}`, clusterLabels[i]);
    }
    return parts.join('<br>');
  });

  const traces = [
    {
      type: 'surface',
      x: sphere.xs,
      y: sphere.ys,
      z: sphere.zs,
      opacity: 0.12,
      colorscale: [
        [0, 'rgba(30, 41, 59, 0.55)'],
        [1, 'rgba(51, 65, 85, 0.45)'],
      ],
      showscale: false,
      hoverinfo: 'skip',
    },
  ];

  const marker = {
    size: 4.5,
    color: encoding.markerColor,
    opacity: 0.95,
    line: { color: 'rgba(226, 232, 240, 0.25)', width: 0.35 },
    showscale: encoding.showscale,
  };

  if (encoding.showscale && encoding.colorscale) {
    marker.colorscale = encoding.colorscale;
    marker.cmin = encoding.cmin ?? 0;
    marker.cmax = encoding.cmax ?? 1;
    marker.colorbar = {
      title: { text: encoding.colorbarTitle, font: { size: 11, color: '#e2e8f0' } },
      thickness: 16,
      len: 0.6,
      tickfont: { color: '#cbd5e1', size: 10 },
      tickformat: '.1f',
      outlinecolor: PLOT_THEME.grid,
      bgcolor: 'rgba(15, 20, 25, 0.92)',
    };
  }

  traces.push({
    type: 'scatter3d',
    mode: 'markers',
    x: xs,
    y: ys,
    z: zs,
    text: hoverText,
    hovertemplate: '%{text}<extra></extra>',
    marker,
    name: 'CLIP clips',
  });

  const plot3d = {
    data: traces,
    layout: {
      title: {
        text: title || 'Explore 3D embeddings',
        font: { size: 17, color: PLOT_THEME.title, family: 'inherit' },
        x: 0.02,
        xanchor: 'left',
      },
      autosize: true,
      height: 620,
      margin: { l: 0, r: encoding.showscale ? 8 : 0, t: 52, b: 0 },
      paper_bgcolor: PLOT_THEME.paper,
      plot_bgcolor: PLOT_THEME.plot,
      scene: {
        bgcolor: PLOT_THEME.plot,
        xaxis: {
          range: [-1.08, 1.08],
          title: { text: 'Sphere X', font: { size: 12, color: PLOT_THEME.axis } },
          gridcolor: PLOT_THEME.grid,
          zerolinecolor: PLOT_THEME.grid,
          color: PLOT_THEME.axis,
          showbackground: true,
          backgroundcolor: 'rgba(15, 23, 42, 0.35)',
        },
        yaxis: {
          range: [-1.08, 1.08],
          title: { text: 'Sphere Y', font: { size: 12, color: PLOT_THEME.axis } },
          gridcolor: PLOT_THEME.grid,
          zerolinecolor: PLOT_THEME.grid,
          color: PLOT_THEME.axis,
          showbackground: true,
          backgroundcolor: 'rgba(15, 23, 42, 0.25)',
        },
        zaxis: {
          range: [-1.08, 1.08],
          title: { text: 'Sphere Z', font: { size: 12, color: PLOT_THEME.axis } },
          gridcolor: PLOT_THEME.grid,
          zerolinecolor: PLOT_THEME.grid,
          color: PLOT_THEME.axis,
          showbackground: true,
          backgroundcolor: 'rgba(15, 23, 42, 0.15)',
        },
        aspectmode: 'cube',
        camera: { eye: { x: 1.55, y: 1.45, z: 0.95 }, center: { x: 0, y: 0, z: 0 } },
      },
      font: { family: 'inherit', color: PLOT_THEME.font, size: 12 },
      hoverlabel: {
        bgcolor: '#0f172a',
        bordercolor: '#35b779',
        font: { color: '#f8fafc', size: 12 },
      },
    },
    config: {
      displayModeBar: true,
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud'],
    },
  };

  const baseModes = [
    ['time', 'Time'],
    ['cluster', 'Clusters'],
    ['phase', 'Phase'],
  ];
  const tagModes = hasFrameTags
    ? tagFields.map((f) => [`tag:${f}`, formatTagField(f)])
    : [];

  return (
    <div className="sparsity-viz">

      <div className="spherical-pca-section">
        <div className="spherical-pca-toolbar">
          <div className="spherical-pca-controls">
            <span className="control-label">Color by</span>
            {baseModes.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`pca-mode-btn ${colorMode === mode ? 'active' : ''}`}
                onClick={() => setColorMode(mode)}
              >
                {label}
              </button>
            ))}
            {hasFrameTags && <span className="control-divider">Tags</span>}
            {tagModes.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`pca-mode-btn pca-mode-btn-tag ${colorMode === mode ? 'active' : ''}`}
                onClick={() => setColorMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {clusterHint && (
            <p className="spherical-pca-cluster-hint">{clusterHint}</p>
          )}
        </div>

        {encoding.legendItems && encoding.legendItems.length > 0 && (
          <div className="sparsity-legend" role="list" aria-label="Color legend">
            {encoding.legendItems.map(({ label, color }) => (
              <span key={label} className="sparsity-legend-item" role="listitem">
                <span className="sparsity-legend-swatch" style={{ backgroundColor: color }} />
                {label}
              </span>
            ))}
          </div>
        )}

        <div className="spherical-pca-charts spherical-pca-charts-hero">
          <Plot {...plot3d} className="spherical-pca-plot spherical-pca-plot-main" useResizeHandler style={{ width: '100%' }} />
        </div>
      </div>
    </div>
  );
}

export default SphericalPcaChart;
