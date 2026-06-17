import { useState, useEffect } from 'react';
import { getDatasetFilterTags } from '../services/api';
import {
  isHardcodedEmbeddingsDataset,
  loadHardcodedDatasetFilterTags,
} from '../config/hardcodedEmbeddings';

/** Dataset-level filter tags from S3 (pipeline output), with optional bundled demo fallback. */
export function useDatasetFilterTags(datasetId, { enabled = true } = {}) {
  const [filterTags, setFilterTags] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || !datasetId) {
      setFilterTags(null);
      setError('');
      return undefined;
    }

    if (isHardcodedEmbeddingsDataset(datasetId)) {
      const doc = loadHardcodedDatasetFilterTags();
      setFilterTags(doc?.dominant_tags || doc?.filter_tags ? doc : null);
      setLoading(false);
      setError('');
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    getDatasetFilterTags(datasetId)
      .then((res) => {
        if (cancelled) return;
        if (res?.success && (res.dominant_tags || res.filter_tags)) {
          setFilterTags(res);
        } else {
          setFilterTags(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFilterTags(null);
          if (err.response?.status !== 404) {
            setError(err.response?.data?.error || err.message || 'Failed to load tags');
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [datasetId, enabled]);

  return { filterTags, loading, error };
}
