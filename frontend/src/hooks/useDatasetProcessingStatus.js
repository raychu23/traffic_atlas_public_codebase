import { useState, useEffect, useRef, useCallback } from 'react';
import { getDatasetProcessingStatus } from '../services/api';

const TERMINAL = new Set(['completed', 'failed', 'succeeded', 'aborted', 'timed_out']);

/**
 * Poll GET /api/datasets/:datasetId/status until processing finishes or times out.
 */
export function useDatasetProcessingStatus(datasetId, { enabled = false, intervalMs = 5000, maxAttempts = 120 } = {}) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const attemptsRef = useRef(0);
  const timerRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!datasetId) return null;
    setLoading(true);
    setError('');
    try {
      const data = await getDatasetProcessingStatus(datasetId);
      setStatus(data);
      return data;
    } catch (err) {
      const statusCode = err.response?.status;
      if (statusCode === 404) {
        setError('Dataset record not found on the server. It may not be published yet.');
        stopPolling();
        return null;
      }
      setError(err.response?.data?.error || err.message || 'Failed to load status');
      return null;
    } finally {
      setLoading(false);
    }
  }, [datasetId, stopPolling]);

  useEffect(() => {
    if (!enabled || !datasetId) {
      stopPolling();
      return undefined;
    }

    attemptsRef.current = 0;

    const tick = async () => {
      attemptsRef.current += 1;
      const data = await fetchStatus();
      const overall = (data?.overallStatus || data?.processingStatus?.status || '').toLowerCase();
      if (TERMINAL.has(overall) || attemptsRef.current >= maxAttempts) {
        stopPolling();
      }
    };

    tick();
    timerRef.current = setInterval(tick, intervalMs);

    return () => stopPolling();
  }, [enabled, datasetId, intervalMs, maxAttempts, fetchStatus, stopPolling]);

  return { status, loading, error, refresh: fetchStatus, stopPolling };
}
