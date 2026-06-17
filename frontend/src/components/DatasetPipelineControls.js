import React, { useState, useEffect } from 'react';
import { approveDatasetPipeline } from '../services/api';
import { useDatasetProcessingStatus } from '../hooks/useDatasetProcessingStatus';
import './DatasetPipelineControls.css';

const TERMINAL_OK = new Set(['completed', 'succeeded']);
const TERMINAL_FAIL = new Set(['failed', 'aborted', 'timed_out']);

/**
 * Start or monitor the Vaidio Step Functions pipeline for a dataset.
 */
function DatasetPipelineControls({
  datasetId,
  hasEmbeddingsOnS3,
  onProcessingComplete,
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [poll, setPoll] = useState(false);

  const { status, loading, error, refresh } = useDatasetProcessingStatus(datasetId, {
    enabled: poll,
    intervalMs: 5000,
  });

  useEffect(() => {
    if (datasetId) refresh();
  }, [datasetId, refresh]);

  const overall = (status?.overallStatus || status?.processingStatus?.status || '').toLowerCase();
  const pipelineConfigured = status?.pipelineConfigured !== false;
  const isRunning = poll && !TERMINAL_OK.has(overall) && !TERMINAL_FAIL.has(overall);
  const showStart =
    !hasEmbeddingsOnS3 && !isRunning && pipelineConfigured;

  useEffect(() => {
    if (TERMINAL_OK.has(overall) && onProcessingComplete) {
      onProcessingComplete();
    }
  }, [overall, onProcessingComplete]);

  const handleStartPipeline = async () => {
    setStartError('');
    setStarting(true);
    try {
      const res = await approveDatasetPipeline(datasetId);
      if (!res?.success && !res?.executionArn) {
        throw new Error(res?.error || 'Pipeline did not start');
      }
      setPoll(true);
      await refresh();
    } catch (err) {
      const data = err.response?.data;
      let msg = data?.error || err.message || 'Failed to start processing pipeline';
      if (data?.code === 'ASSUME_ROLE_DENIED') {
        msg +=
          ' Use the deployed testing API (set REACT_APP_API_URL in frontend/.env.local) or ask AWS to add your IAM user to VaidioTrafficAtlasApiTriggerRole trust (docs/AWS_PIPELINE_HANDOFF.md).';
      }
      setStartError(msg);
    } finally {
      setStarting(false);
    }
  };

  if (!datasetId) {
    return null;
  }

  if (status?.pipelineConfigured === false) {
    return (
      <div className="pipeline-controls">
        <p className="pipeline-controls-error">
          Processing pipeline is not configured on this API server. Set{' '}
          <code>STEP_FUNCTIONS_STATE_MACHINE_ARN</code> and <code>S3_BUCKET</code> in the backend{' '}
          <code>.env</code>, then restart the server (see docs/AWS_PIPELINE_HANDOFF.md).
        </p>
      </div>
    );
  }

  return (
    <div className="pipeline-controls">
      {showStart && (
        <>
          <p className="pipeline-controls-hint">
            No analysis outputs on S3 yet. Start the Vaidio processing pipeline to generate CLIP
            embeddings, tags, and the 3D visualization.
          </p>
          <button
            type="button"
            className="pipeline-controls-start"
            onClick={handleStartPipeline}
            disabled={starting}
          >
            {starting ? 'Starting pipeline…' : 'Run processing pipeline'}
          </button>
        </>
      )}

      {startError && <p className="pipeline-controls-error">{startError}</p>}
      {error && <p className="pipeline-controls-error">{error}</p>}

      {(isRunning || poll) && (
        <div className="pipeline-controls-status" aria-live="polite">
          <p>
            <strong>Pipeline status:</strong>{' '}
            {loading && !overall ? 'Checking…' : (overall || 'pending')}
          </p>
          {status?.executionArn && (
            <p className="pipeline-controls-meta">
              <small>{status.executionArn}</small>
            </p>
          )}
          {TERMINAL_OK.has(overall) && (
            <p className="pipeline-controls-success">Processing finished. Refreshing embeddings…</p>
          )}
          {TERMINAL_FAIL.has(overall) && (
            <p className="pipeline-controls-error">
              Processing failed. Check AWS Step Functions or try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default DatasetPipelineControls;
