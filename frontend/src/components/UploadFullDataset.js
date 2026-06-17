import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api, {
  initiateMultipartUpload,
  getMultipartSession,
  getMultipartPartUrl,
  listMultipartParts,
  completeMultipartUpload,
  abortMultipartUpload,
  approveDatasetPipeline,
} from '../services/api';
import { useDatasetProcessingStatus } from '../hooks/useDatasetProcessingStatus';
import './UploadFullDataset.css';
import UploadErrorModal from './UploadErrorModal';

function UploadFullDataset() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [datasetId, setDatasetId] = useState(null);
  const [datasetTitle, setDatasetTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [session, setSession] = useState(null);
  const [fullUploadExists, setFullUploadExists] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [resumeRequested, setResumeRequested] = useState(false);
  const [pipelineStarted, setPipelineStarted] = useState(false);
  const [pollPipeline, setPollPipeline] = useState(false);

  const { status: pipelineStatus, loading: pipelineLoading, error: pipelineError } =
    useDatasetProcessingStatus(datasetId, { enabled: pollPipeline, intervalMs: 5000 });

  const raiseError = (message) => {
    setError(message);
    setShowErrorModal(true);
  };

  const isStaleMultipartError = (err) => {
    const code = err?.response?.data?.code;
    const msg = err?.response?.data?.error || err?.message || '';
    return code === 'STALE_MULTIPART_UPLOAD' || /upload does not exist/i.test(msg);
  };

  const startFreshMultipartSession = async (datasetIdValue, fileMeta) => {
    const initRes = await initiateMultipartUpload(datasetIdValue, {
      fileName: fileMeta.name,
      fileSize: fileMeta.size,
      contentType: fileMeta.type || 'application/zip',
    });
    if (!initRes.success || !initRes.session) {
      throw new Error(initRes.error || 'Failed to initiate multipart upload.');
    }
    setSession(initRes.session);
    return initRes.session;
  };

  useEffect(() => {
    const fetchRequestInfo = async () => {
      try {
        const res = await api.get(`/upload-requests/${requestId}`);
        if (res.data.success) {
          setDatasetId(res.data.request.datasetId);
          setDatasetTitle(res.data.request.metadata?.title || 'Dataset');
        }
      } catch (err) {
        console.error('Failed to fetch request info:', err);
        raiseError('Could not verify your upload request. Please ensure you are logged in and using a valid link.');
      } finally {
        setFetching(false);
      }
    };

    if (requestId) {
      fetchRequestInfo();
    }
  }, [requestId]);

  useEffect(() => {
    const loadSession = async () => {
      if (!datasetId) return;
      setSessionLoading(true);
      try {
        const res = await getMultipartSession(datasetId);
        if (res.success) {
          setFullUploadExists(Boolean(res.fullUploadExists));
          if (res.session) {
            setSession(res.session);
          } else {
            setSession(null);
          }
        }
      } catch (err) {
        console.error('Failed to load upload session:', err);
      } finally {
        setSessionLoading(false);
      }
    };
    loadSession();
  }, [datasetId]);
  
  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setError('');
      setShowErrorModal(false);
      setFile(e.target.files[0]);
    }
  };

  const handleResume = () => {
    setResumeRequested(true);
  };

  const uploadPart = async (datasetIdValue, uploadId, key, partNumber, blob) => {
    const urlRes = await getMultipartPartUrl(datasetIdValue, { uploadId, key, partNumber });
    if (!urlRes.success || !urlRes.url) {
      throw new Error(urlRes.error || 'Failed to get upload URL.');
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', urlRes.url);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag');
          if (!etag) {
            reject(new Error('Missing ETag header from S3. Ensure ETag is exposed in S3 CORS.'));
            return;
          }
          const normalizedEtag = etag.startsWith('"') ? etag : `"${etag}"`;
          resolve({ PartNumber: partNumber, ETag: normalizedEtag });
        } else {
          reject(new Error(`Part ${partNumber} upload failed with status ${xhr.status}.`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error uploading part ${partNumber}.`));
      xhr.send(blob);
    });
  };

  const uploadPartWithRetry = async (datasetIdValue, uploadId, key, partNumber, blob, maxRetries = 3) => {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        return await uploadPart(datasetIdValue, uploadId, key, partNumber, blob);
      } catch (err) {
        lastErr = err;
        if (attempt >= maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
    throw lastErr;
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file) {
      raiseError('Please select a full dataset file to upload.');
      return;
    }
    if (session && (session.fileName !== file.name || Number(session.fileSize) !== Number(file.size))) {
      raiseError('Selected file does not match the existing upload session. Please choose the same file to resume.');
      return;
    }
    if (!datasetId) {
      raiseError('Dataset identification missing. Cannot proceed.');
      return;
    }

    setLoading(true);
    setError('');
    setShowErrorModal(false);
    setIsUploading(true);
    setUploadProgress(0);

    try {
      let activeSession = session;
      if (resumeRequested && !activeSession) {
        const refreshed = await getMultipartSession(datasetId);
        if (refreshed.success && refreshed.session) {
          activeSession = refreshed.session;
          setSession(activeSession);
        }
      }
      if (activeSession && (activeSession.fileName !== file.name || Number(activeSession.fileSize) !== Number(file.size))) {
        await abortMultipartUpload(datasetId, { uploadId: activeSession.uploadId, key: activeSession.key });
        activeSession = null;
        setSession(null);
      }

      if (!activeSession) {
        activeSession = await startFreshMultipartSession(datasetId, file);
      }

      const partSize = activeSession.partSize || (256 * 1024 * 1024);
      const totalParts = Math.ceil(file.size / partSize);

      let existingParts = [];
      try {
        const partsRes = await listMultipartParts(datasetId, {
          uploadId: activeSession.uploadId,
          key: activeSession.key,
        });
        existingParts = partsRes.success && Array.isArray(partsRes.parts) ? partsRes.parts : [];
      } catch (partsErr) {
        if (!isStaleMultipartError(partsErr)) throw partsErr;
        try {
          await abortMultipartUpload(datasetId, {
            uploadId: activeSession.uploadId,
            key: activeSession.key,
          });
        } catch (abortErr) {
          console.warn('Could not abort stale multipart upload:', abortErr);
        }
        activeSession = await startFreshMultipartSession(datasetId, file);
        const partsRes = await listMultipartParts(datasetId, {
          uploadId: activeSession.uploadId,
          key: activeSession.key,
        });
        existingParts = partsRes.success && Array.isArray(partsRes.parts) ? partsRes.parts : [];
      }
      const existingMap = new Map(existingParts.map((p) => [Number(p.PartNumber), p.ETag]));

      let uploadedBytes = existingParts.reduce((sum, p) => sum + (p.Size || 0), 0);
      setUploadProgress(Math.round((uploadedBytes / file.size) * 100));

      const pendingParts = [];
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (!existingMap.has(partNumber)) pendingParts.push(partNumber);
      }

      const normalizeEtag = (etag) => {
        const t = String(etag || '').trim();
        if (!t) return t;
        return t.startsWith('"') ? t : `"${t}"`;
      };

      const uploadedParts = existingParts.map((p) => ({
        PartNumber: Number(p.PartNumber),
        ETag: normalizeEtag(p.ETag),
      }));

      const concurrency = 4;
      const queue = [...pendingParts];
      const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }).map(async () => {
        while (queue.length) {
          const partNumber = queue.shift();
          if (!partNumber) return;
          const start = (partNumber - 1) * partSize;
          const end = Math.min(start + partSize, file.size);
          const blob = file.slice(start, end);

          const result = await uploadPartWithRetry(
            datasetId,
            activeSession.uploadId,
            activeSession.key,
            partNumber,
            blob
          );
          uploadedParts.push(result);
          uploadedBytes += (end - start);
          setUploadProgress(Math.min(99, Math.round((uploadedBytes / file.size) * 100)));
        }
      });

      await Promise.all(workers);

      const completeRes = await completeMultipartUpload(datasetId, {
        uploadId: activeSession.uploadId,
        key: activeSession.key,
        parts: uploadedParts
      });
      if (!completeRes.success) {
        const apiErrors = completeRes.errors || [];
        throw new Error(
          apiErrors.length
            ? `${completeRes.error || 'Upload failed'}: ${apiErrors.join(' · ')}`
            : (completeRes.error || 'Failed to complete multipart upload.')
        );
      }

      setUploadProgress(100);

      let pipelineOk = Boolean(completeRes.pipeline?.executionArn);
      const pipelineStartError = completeRes.pipeline?.error || null;
      if (!pipelineOk) {
        try {
          const approveRes = await approveDatasetPipeline(datasetId);
          pipelineOk = Boolean(approveRes?.executionArn);
        } catch (pipelineErr) {
          console.warn('Pipeline start via approve failed:', pipelineErr);
        }
      }

      setPipelineStarted(pipelineOk);
      setPollPipeline(pipelineOk);
      if (pipelineOk) {
        setSuccess(
          'Full dataset uploaded. Processing pipeline started — this page will update when analysis completes.'
        );
      } else {
        setSuccess(
          'Full dataset uploaded successfully. '
          + (pipelineStartError
            ? `Automatic processing did not start (${pipelineStartError}). An admin can start the pipeline in AWS.`
            : 'If embeddings/tags do not appear, the API server may need a restart to pick up your dataset on S3.')
        );
      }
      
    } catch (err) {
      console.error(err);
      raiseError(err.response?.data?.error || err.message || 'Failed to upload full dataset.');
      setUploadProgress(0);
    } finally {
      setLoading(false);
      setIsUploading(false);
    }
  };

  const pipelineOverall = (pipelineStatus?.overallStatus || '').toLowerCase();
  const pipelineDone = ['completed', 'succeeded'].includes(pipelineOverall);
  const pipelineFailed = ['failed', 'aborted', 'timed_out'].includes(pipelineOverall);

  useEffect(() => {
    if (pipelineDone && datasetId) {
      const t = setTimeout(() => navigate(`/dataset/${datasetId}`), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [pipelineDone, datasetId, navigate]);

  if (fetching) {
    return (
      <div className="upload-full-container">
        <p>Loading request details...</p>
      </div>
    );
  }

  return (
    <div className="upload-full-container">
      <h1 className="upload-title">Upload Full Dataset</h1>
      <p className="upload-subtitle">
        Your sample submission for <strong>{datasetTitle}</strong> has been approved. 
        Please upload the full dataset (no size limit) to finalize publication.
      </p>

      {fullUploadExists && !isUploading && (
        <div className="alert-uf success">
          A full dataset file is already stored for this dataset. You can view it on the dataset page or upload a new
          file below to replace it.
          {datasetId && (
            <button
              type="button"
              className="resume-btn"
              onClick={() => navigate(`/dataset/${datasetId}`)}
            >
              View dataset
            </button>
          )}
        </div>
      )}
      {session && !isUploading && (
        <div className="alert-uf success">
          Resumable upload detected for <strong>{session.fileName}</strong>. Select the same file to resume or click
          <button type="button" className="resume-btn" onClick={handleResume}>Resume Upload</button>.
        </div>
      )}
      {sessionLoading && (
        <div className="alert-uf">Checking for existing upload session...</div>
      )}
      
      {error && <div className="alert-uf error">{error}</div>}
      {success && <div className="alert-uf success">{success}</div>}
      {showErrorModal && <UploadErrorModal message={error} onClose={() => setShowErrorModal(false)} />}
      
      {pipelineStarted && (
        <div className="pipeline-status-panel">
          <h2>Processing pipeline</h2>
          {pipelineLoading && <p>Checking status…</p>}
          {pipelineError && <p className="alert-uf error">{pipelineError}</p>}
          {pipelineStatus && (
            <>
              <p>
                <strong>Status:</strong>{' '}
                {pipelineStatus.overallStatus || pipelineStatus.execution?.status || 'pending'}
              </p>
              {pipelineStatus.executionArn && (
                <p className="pipeline-meta">
                  <small>Execution: {pipelineStatus.executionArn}</small>
                </p>
              )}
              {pipelineStatus.processingStatus && (
                <pre className="pipeline-json">
                  {JSON.stringify(pipelineStatus.processingStatus, null, 2)}
                </pre>
              )}
            </>
          )}
          {pipelineDone && <p className="alert-uf success">Processing complete. Redirecting to dataset…</p>}
          {pipelineFailed && (
            <p className="alert-uf error">
              Processing failed. Contact support or retry from the dataset page.
            </p>
          )}
        </div>
      )}

      {!success && !pipelineStarted && (
        <form onSubmit={handleUpload} className="upload-form">
          <div className="form-group">
            <label>Full Dataset (.zip)</label>
            <input 
              type="file" 
              accept=".zip"
              onChange={handleFileChange} 
              disabled={loading || isUploading} 
            />
          </div>
          
          {isUploading && (
            <div className="upload-progress-container">
              <div className="upload-progress-info">
                <span>Uploading full dataset...</span>
                <span className="upload-progress-percent">{Math.round(uploadProgress)}%</span>
              </div>
              <div className="upload-progress-bar">
                <div 
                  className="upload-progress-fill" 
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
          
          <button type="submit" className="btn-primary-uf" disabled={loading || isUploading || !file || !datasetId}>
            {isUploading ? `Uploading... ${Math.round(uploadProgress)}%` : (loading ? 'Processing...' : 'Upload Now')}
          </button>
        </form>
      )}
    </div>
  );
}

export default UploadFullDataset;
