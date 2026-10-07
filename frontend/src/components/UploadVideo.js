import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_PUBLIC_BASE_URL, validateTrafficVideoUpload } from '../services/api';
import './UploadVideo.css';

const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'];
const MAX_DURATION_SECONDS = 8 * 60 * 60;

function formatFileSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getExtension(fileName) {
  const parts = String(fileName || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function buildUploadErrorMessage(err) {
  if (!err.response) {
    return `Cannot reach the TrafficAtlas API at ${API_PUBLIC_BASE_URL}. Make sure the backend is running, then retry the upload.`;
  }
  const trafficScene = err.response?.data?.trafficScene;
  const baseMessage =
    trafficScene?.explanation ||
    err.response?.data?.error ||
    err.message ||
    'Video validation failed.';
  if (err.response?.status === 422 || trafficScene?.isTrafficCameraFootage === false) {
    if (/please upload/i.test(baseMessage)) {
      return baseMessage;
    }
    return `${baseMessage} Please upload a traffic video with a clear roadway, intersection, or traffic-camera view.`;
  }
  return baseMessage;
}

function UploadVideo() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [durationSeconds, setDurationSeconds] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  const validateVideo = (candidate) => {
    if (!candidate) return;

    setError('');
    setStatusMessage('');
    setUploadProgress(0);
    setDurationSeconds(null);
    const extension = getExtension(candidate.name);

    if (!SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
      setFile(null);
      setError('Unsupported video format. Upload MP4, MOV, AVI, MKV, WebM, or WMV.');
      return;
    }

    setFile(candidate);

    if (candidate.type?.startsWith('video/')) {
      setChecking(true);
      const objectUrl = URL.createObjectURL(candidate);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(objectUrl);
        setChecking(false);
        setDurationSeconds(Number.isFinite(video.duration) ? video.duration : null);
        if (video.duration > MAX_DURATION_SECONDS) {
          setError('Video duration must be less than 8 hours.');
        }
      };
      video.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setChecking(false);
      };
      video.src = objectUrl;
    }
  };

  const handleFileChange = (event) => {
    validateVideo(event.target.files?.[0]);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    validateVideo(event.dataTransfer.files?.[0]);
  };

  const handleContinue = async () => {
    if (!file) {
      setError('Please select a traffic video before continuing.');
      return;
    }
    if (error) return;
    if (checking) return;

    setUploading(true);
    setError('');
    setStatusMessage('Uploading video for server-side validation…');
    setUploadProgress(0);

    try {
      const result = await validateTrafficVideoUpload(file, (event) => {
        if (event.total) {
          setUploadProgress(Math.round((event.loaded / event.total) * 100));
        }
      });
      const acceptedVideo = result.video || {};
      sessionStorage.setItem(
        'trafficAtlasVideoUpload',
        JSON.stringify({
          videoId: acceptedVideo.videoId,
          name: acceptedVideo.fileName || file.name,
          size: acceptedVideo.fileSize || file.size,
          type: acceptedVideo.contentType || file.type || `video/${getExtension(file.name)}`,
          durationSeconds: acceptedVideo.durationSeconds ?? durationSeconds,
          width: acceptedVideo.width,
          height: acceptedVideo.height,
          sampledFrameCount: acceptedVideo.sampledFrameCount,
          trafficScene: acceptedVideo.trafficScene,
          status: acceptedVideo.status,
        }),
      );
      navigate('/upload/video/details');
    } catch (err) {
      setError(buildUploadErrorMessage(err));
    } finally {
      setUploading(false);
      setStatusMessage('');
    }
  };

  const selectedFormat = file ? getExtension(file.name).toUpperCase() : null;

  return (
    <main className="video-upload-page">
      <section className="video-stepper" aria-label="Video upload progress">
        <button
          type="button"
          className="stepper-back"
          onClick={() => navigate('/upload')}
          aria-label="Back to upload choices"
        >
          ‹
        </button>
        <div className="video-step active">
          <span>1</span>
          <p>Upload Video</p>
        </div>
        <div className="step-line" />
        <div className="video-step">
          <span>2</span>
          <p>More Details</p>
        </div>
      </section>

      {error && (
        <div className="video-warning" role="alert">
          <span aria-hidden="true">⏱</span>
          {error}
        </div>
      )}

      <section className="video-drop-card">
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.avi,.mkv,.webm,.wmv,video/*"
          className="video-file-input"
          onChange={handleFileChange}
        />

        <div
          className={`video-drop-zone${file ? ' has-file' : ''}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="video-upload-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 15.75V6" />
              <path d="m8.25 9.5 3.75-3.75 3.75 3.75" />
              <path d="M5.75 16.25v1.5A1.5 1.5 0 0 0 7.25 19.25h9.5a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
            </svg>
          </div>
          <p>{file ? file.name : 'Drag & drop your video here'}</p>
          {file ? (
            <span>
              {formatFileSize(file.size)} {selectedFormat ? `· ${selectedFormat}` : ''}
            </span>
          ) : (
            <span>or</span>
          )}
          <button type="button" onClick={() => inputRef.current?.click()}>
            Browse files
          </button>
          {checking && <small>Checking video metadata…</small>}
          {uploading && (
            <small>
              {statusMessage} {uploadProgress > 0 ? `${uploadProgress}%` : ''}
            </small>
          )}
        </div>

        <div className="video-rules-card">
          <div className="rule-row">
            <span>Max duration</span>
            <strong>8 hours</strong>
          </div>
          <div className="rule-row">
            <span>Supported formats</span>
            <div className="format-pills">
              {SUPPORTED_VIDEO_EXTENSIONS.map((extension) => (
                <b key={extension}>{extension.toUpperCase()}</b>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="video-upload-actions">
        <button
          type="button"
          className="video-continue-button"
          onClick={handleContinue}
          disabled={checking || uploading}
        >
          {uploading ? 'Validating…' : 'Continue'} <span aria-hidden="true">›</span>
        </button>
      </div>
    </main>
  );
}

export default UploadVideo;
export { buildUploadErrorMessage };
