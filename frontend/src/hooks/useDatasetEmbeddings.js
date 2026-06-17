import { useState, useEffect } from 'react';
import { getSphericalPcaEmbeddings, listEmbeddingVideos } from '../services/api';
import {
  isHardcodedEmbeddingsDataset,
  loadHardcodedSphericalPca,
  getHardcodedVideosList,
} from '../config/hardcodedEmbeddings';

/**
 * Load CLIP embeddings + spherical PCA for a dataset.
 * Demo dataset (4ee8dc70-…) loads bundled visualization data without API calls.
 */
export function useDatasetEmbeddings(datasetId, { enabled = true, videoId = '' } = {}) {
  const [videos, setVideos] = useState([]);
  const [viz, setViz] = useState(null);
  const [loading, setLoading] = useState(false);
  const [videosLoading, setVideosLoading] = useState(false);
  const [error, setError] = useState('');
  const isHardcoded = isHardcodedEmbeddingsDataset(datasetId);

  useEffect(() => {
    if (!enabled || !datasetId) {
      setVideos([]);
      return undefined;
    }

    if (isHardcoded) {
      setVideos(getHardcodedVideosList());
      setVideosLoading(false);
      return undefined;
    }

    let cancelled = false;
    setVideosLoading(true);

    const loadVideos = async () => {
      try {
        const res = await listEmbeddingVideos(datasetId);
        if (!cancelled && res?.videos?.length) {
          setVideos(res.videos);
        }
      } catch {
        if (!cancelled) setVideos([]);
      }
    };

    loadVideos().finally(() => {
      if (!cancelled) setVideosLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [datasetId, enabled, isHardcoded]);

  useEffect(() => {
    if (!enabled || !datasetId) {
      setViz(null);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    const load = async () => {
      try {
        let data = null;

        if (isHardcoded) {
          data = await loadHardcodedSphericalPca();
          if (videoId && data?.videoIds?.length) {
            const indices = data.videoIds
              .map((id, i) => (id === videoId ? i : -1))
              .filter((i) => i >= 0);
            if (indices.length && indices.length < data.points.length) {
              const pick = (arr) => (Array.isArray(arr) ? indices.map((i) => arr[i]) : arr);
              data = {
                ...data,
                points: pick(data.points),
                stereographic: pick(data.stereographic),
                videoIds: pick(data.videoIds),
                frameTags: pick(data.frameTags),
                nClips: indices.length,
              };
            }
          }
        } else {
          data = await getSphericalPcaEmbeddings(datasetId, videoId || null);
        }

        if (!cancelled) {
          if (data?.points?.length) {
            setViz(data);
          } else {
            setViz(null);
            if (isHardcoded) {
              setError('Bundled embedding visualization data is missing.');
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setViz(null);
          setError(
            err.response?.data?.error
              || err.message
              || 'No embeddings found for this dataset yet.'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [datasetId, enabled, videoId, isHardcoded]);

  return {
    videos,
    viz,
    loading,
    videosLoading,
    error,
    hasEmbeddings: isHardcoded || videos.length > 0,
    isHardcoded,
  };
}
