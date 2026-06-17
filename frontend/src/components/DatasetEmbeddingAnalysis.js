import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDataset } from '../services/api';
import { isHardcodedEmbeddingsDataset, HARDCODED_DATASET_FALLBACK_TITLE } from '../config/hardcodedEmbeddings';
import DatasetPipelineControls from './DatasetPipelineControls';
import { useDatasetEmbeddings } from '../hooks/useDatasetEmbeddings';
import SphericalPcaChart from './SphericalPcaChart';
import './DatasetEmbeddingAnalysis.css';

function DatasetEmbeddingAnalysis() {
  const { datasetId } = useParams();
  const navigate = useNavigate();
  const [dataset, setDataset] = useState(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [selectedVideoId, setSelectedVideoId] = useState('');

  const { videos, viz, loading, videosLoading, error, hasEmbeddings } =
    useDatasetEmbeddings(datasetId, {
      enabled: Boolean(datasetId),
      videoId: selectedVideoId,
    });

  useEffect(() => {
    let cancelled = false;
    setPageError('');

    getDataset(datasetId)
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.dataset) {
          setDataset(res.dataset);
        } else if (!isHardcodedEmbeddingsDataset(datasetId)) {
          setPageError('Dataset not found.');
        }
      })
      .catch(() => {
        if (!cancelled && !isHardcodedEmbeddingsDataset(datasetId)) {
          setPageError('Could not load dataset.');
        }
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  const datasetName = dataset?.title
    || (isHardcodedEmbeddingsDataset(datasetId) ? HARDCODED_DATASET_FALLBACK_TITLE : null);

  if (pageLoading) {
    return (
      <div className="analysis-page analysis-loading">
        <div className="spinner" />
        <p>Loading embedding cluster analysis…</p>
      </div>
    );
  }

  if (pageError && !dataset && !isHardcodedEmbeddingsDataset(datasetId)) {
    return (
      <div className="analysis-page">
        <button type="button" className="analysis-back" onClick={() => navigate(`/dataset/${datasetId}`)}>
          ← Back to dataset
        </button>
        <div className="analysis-alert">{pageError}</div>
      </div>
    );
  }

  return (
    <div className="analysis-page">
      <header className="analysis-header">
        <button type="button" className="analysis-back" onClick={() => navigate(`/dataset/${datasetId}`)}>
          ← Back to dataset
        </button>
        <p className="analysis-eyebrow">Embedding Cluster Analysis</p>
        <h1 className="analysis-title">Explore 3D Embeddings</h1>
        <p className="analysis-lead">
          Navigate high-dimensional traffic scene embeddings through an interactive 3D projection.
        </p>
        {datasetName && (
          <p className="analysis-dataset-name">{datasetName}</p>
        )}
        <p className="analysis-meta">
          <span className="analysis-meta-id">ID <code>{datasetId}</code></span>
          {hasEmbeddings && (
            <span className="analysis-meta-videos">
              {videos.length} video{videos.length !== 1 ? 's' : ''}
            </span>
          )}
        </p>
      </header>

      {videos.length > 1 && (
        <div className="embedding-video-filter analysis-filter">
          <label htmlFor="analysis-video-select">Clip source</label>
          <select
            id="analysis-video-select"
            value={selectedVideoId}
            onChange={(e) => setSelectedVideoId(e.target.value)}
          >
            <option value="">All videos ({videos.length})</option>
            {videos.map((v) => (
              <option key={v.videoId} value={v.videoId}>
                {v.videoId}
              </option>
            ))}
          </select>
        </div>
      )}

      {(loading || videosLoading) && (
        <p className="analysis-status">Loading 3D embeddings…</p>
      )}

      {error && !loading && (
        <div className="analysis-alert">
          <p>{error}</p>
          {!hasEmbeddings && (
            <DatasetPipelineControls
              datasetId={datasetId}
              hasEmbeddingsOnS3={false}
              onProcessingComplete={() => window.location.reload()}
            />
          )}
        </div>
      )}

      {viz && !loading && (
        <SphericalPcaChart
          data={viz}
          title={datasetName ? `${datasetName} — 3D embeddings` : 'Explore 3D embeddings'}
        />
      )}

      {!loading && !videosLoading && !error && !viz && (
        <div className="analysis-alert">
          <p>Visualization data did not load. Refresh the page or try again later.</p>
        </div>
      )}
    </div>
  );
}

export default DatasetEmbeddingAnalysis;
