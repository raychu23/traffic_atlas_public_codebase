import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getTrafficVideoArtifact,
  getTrafficVideoJob,
  restartTrafficVideoProcessing,
  updateTrafficVideoZones,
} from '../services/api';
import './UploadVideoDetails.css';

function formatDuration(seconds) {
  if (!seconds) return 'Pending extraction';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return [hours, minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = Math.floor(value % 60);
  return [hours, minutes, remainingSeconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function polygonPoints(points) {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

function processingMessage(job) {
  if (!job) return 'Loading video job…';
  if (job.status === 'queued') return 'Queued for DeepStream GPU tracking';
  if (job.status === 'processing')
    return 'Mapping vehicle trajectories on the DeepStream EC2 worker…';
  if (job.status === 'failed') return 'Tracking failed';
  if (job.countsStatus === 'calculating') return 'Updating movement counts for the edited zones…';
  if (job.countsStatus === 'awaiting_tracks')
    return 'Zones saved · counts will update when tracking finishes';
  if (job.countsStatus === 'ready') return 'Trajectories and movement counts are ready';
  return 'Trajectories ready · adjust zones to calculate movements';
}

function UploadVideoDetails() {
  const navigate = useNavigate();
  const upload = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem('trafficAtlasVideoUpload') || '{}');
    } catch {
      return {};
    }
  }, []);
  const videoId = upload.videoId;
  const [job, setJob] = useState(null);
  const [zones, setZones] = useState([]);
  const [dragTarget, setDragTarget] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const [savingZones, setSavingZones] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const zonesRef = useRef([]);

  const loadJob = useCallback(async () => {
    if (!videoId) return;
    try {
      const result = await getTrafficVideoJob(videoId);
      setJob(result.video);
      setError('');
    } catch (requestError) {
      setError(
        requestError.response?.data?.error ||
          requestError.message ||
          'Unable to load video processing status.',
      );
    }
  }, [videoId]);

  const persistZones = useCallback(
    async (nextZones) => {
      if (!videoId) return;
      setSavingZones(true);
      setError('');
      try {
        const result = await updateTrafficVideoZones(videoId, nextZones);
        setJob(result.video);
      } catch (requestError) {
        setError(
          requestError.response?.data?.error ||
            requestError.message ||
            'Unable to update traffic zones.',
        );
      } finally {
        setSavingZones(false);
      }
    },
    [videoId],
  );

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  useEffect(() => {
    const shouldPoll =
      !job ||
      ['queued', 'processing'].includes(job.status) ||
      ['calculating', 'awaiting_tracks', 'awaiting_recount'].includes(job.countsStatus);
    if (!shouldPoll) return undefined;
    const interval = window.setInterval(loadJob, 2500);
    return () => window.clearInterval(interval);
  }, [job, loadJob]);

  useEffect(() => {
    if (!job || dragTarget || savingZones) return;
    const backendZones = job.zones?.length ? job.zones : job.suggestedZones || [];
    if (!backendZones.length) return;
    setZones(backendZones);
    zonesRef.current = backendZones;
  }, [dragTarget, job, savingZones]);

  useEffect(() => {
    let objectUrl = '';
    let cancelled = false;
    if (!videoId || !job?.artifacts?.preview) return undefined;
    getTrafficVideoArtifact(videoId, 'preview')
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((requestError) => {
        if (!cancelled)
          setError(
            requestError.response?.data?.error || 'Unable to load the extracted preview frame.',
          );
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [videoId, job?.artifacts?.preview]);

  const updateZonePoint = (event) => {
    if (!dragTarget) return;
    const svg = event.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    setZones((currentZones) => {
      const nextZones = currentZones.map((zone) => {
        if (zone.id !== dragTarget.zoneId) return zone;
        return {
          ...zone,
          points: zone.points.map((point, index) =>
            index === dragTarget.pointIndex ? { x, y } : point,
          ),
        };
      });
      zonesRef.current = nextZones;
      return nextZones;
    });
  };

  const finishZoneDrag = () => {
    if (!dragTarget) return;
    setDragTarget(null);
    persistZones(zonesRef.current);
  };

  const resetZones = () => {
    const suggestedZones = job?.suggestedZones || [];
    if (!suggestedZones.length) return;
    setZones(suggestedZones);
    zonesRef.current = suggestedZones;
    persistZones(suggestedZones);
  };

  const retryProcessing = async () => {
    setError('');
    try {
      const result = await restartTrafficVideoProcessing(videoId);
      setJob(result.video);
    } catch (requestError) {
      setError(
        requestError.response?.data?.error ||
          requestError.message ||
          'Unable to restart video processing.',
      );
    }
  };

  const downloadCounts = async () => {
    setDownloading(true);
    setError('');
    try {
      const blob = await getTrafficVideoArtifact(videoId, 'counts');
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${videoId}-movement-counts.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (requestError) {
      setError(
        requestError.response?.data?.error ||
          requestError.message ||
          'Unable to download movement counts.',
      );
    } finally {
      setDownloading(false);
    }
  };

  const countRows = job?.counts || [];
  const totalMovements = countRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);

  if (!videoId) {
    return (
      <main className="video-details-page">
        <section className="details-shell empty-video-job">
          <h1>No uploaded video selected</h1>
          <p>Return to the video upload page and select a traffic-camera video.</p>
          <button
            type="button"
            className="primary-action"
            onClick={() => navigate('/upload/video')}
          >
            Upload a video
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="video-details-page">
      <section className="details-stepper" aria-label="Video upload progress">
        <button
          type="button"
          className="details-back-icon"
          onClick={() => navigate('/upload/video')}
          aria-label="Back to video upload"
        >
          ‹
        </button>
        <div className="details-step complete">
          <span>1</span>
          <p>Upload Video</p>
        </div>
        <div className="details-line" />
        <div className="details-step active">
          <span>2</span>
          <p>Map &amp; Count</p>
        </div>
      </section>

      <section className="details-shell">
        <header className="details-header">
          <div>
            <span className="eyebrow">Video processing</span>
            <h1>Review trajectories and traffic zones</h1>
            <p>
              Vehicle paths are mapped once. Moving a zone reuses those tracks and updates the
              movement-count CSV.
            </p>
          </div>
          <div className="video-file-summary">
            <strong>{job?.fileName || upload.name || 'Selected traffic video'}</strong>
            <span>
              {job?.contentType || upload.type || 'video/*'} ·{' '}
              {formatDuration(job?.durationSeconds || upload.durationSeconds)}
            </span>
            <span className={`job-status ${job?.status || 'loading'}`}>
              {processingMessage(job)}
            </span>
          </div>
        </header>

        {error && (
          <div className="video-job-error" role="alert">
            {error}
          </div>
        )}
        {job?.status === 'failed' && (
          <div className="video-job-retry">
            <span>{job.error || 'The tracking process stopped unexpectedly.'}</span>
            <button type="button" onClick={retryProcessing}>
              Retry processing
            </button>
          </div>
        )}

        <div className="details-grid">
          <section className="data-table-card">
            <div className="card-heading table-heading">
              <div>
                <h2>Movement-count CSV</h2>
                <p>15-minute counts derived from first-zone to last-zone track movement.</p>
              </div>
              <button
                type="button"
                className="download-csv-button"
                onClick={downloadCounts}
                disabled={!job?.artifacts?.countsCsv || downloading}
              >
                {downloading ? 'Preparing…' : 'Download CSV'}
              </button>
            </div>
            <div className="responsive-table movement-count-table">
              <table>
                <thead>
                  <tr>
                    <th>Time block</th>
                    <th>Class</th>
                    <th>From zone</th>
                    <th>To zone</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {countRows.map((row, index) => (
                    <tr
                      key={`${row.bin_start_s}-${row.class}-${row.from_zone}-${row.to_zone}-${index}`}
                    >
                      <td>
                        {formatTime(row.bin_start_s)}–{formatTime(row.bin_end_s)}
                      </td>
                      <td>{row.class}</td>
                      <td>{row.from_zone}</td>
                      <td>{row.to_zone}</td>
                      <td>{row.count}</td>
                    </tr>
                  ))}
                  {countRows.length === 0 && (
                    <tr>
                      <td colSpan="5" className="empty-counts">
                        {processingMessage(job)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <footer className="table-footer">
              <span>{countRows.length} movement rows</span>
              <span>{totalMovements} total vehicles</span>
            </footer>
          </section>

          <section className="frame-preview-card">
            <div className="card-heading frame-heading">
              <div>
                <h2>Trajectory and zone map</h2>
                <p>Adjust the suggested zones, then save them to calculate movement counts.</p>
              </div>
              <div className="zone-actions">
                <button
                  type="button"
                  className="reset-zones-button"
                  onClick={resetZones}
                  disabled={savingZones || !job?.suggestedZones?.length}
                >
                  Reset zones
                </button>
                {!job?.zones?.length && (
                  <button
                    type="button"
                    className="reset-zones-button"
                    onClick={() => persistZones(zonesRef.current)}
                    disabled={savingZones}
                  >
                    Save zones
                  </button>
                )}
              </div>
            </div>

            <div
              className="intersection-preview"
              style={{
                aspectRatio: job?.width && job?.height ? `${job.width} / ${job.height}` : '16 / 9',
              }}
              aria-label="Extracted traffic-video frame with trajectories and editable zones"
            >
              {previewUrl ? (
                <img
                  className="video-preview-image"
                  src={previewUrl}
                  alt="Extracted frame from the uploaded traffic video"
                />
              ) : (
                <div className="preview-loading">Loading extracted frame…</div>
              )}
              <svg
                className="zone-editor"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                onPointerMove={updateZonePoint}
                onPointerUp={finishZoneDrag}
                onPointerCancel={finishZoneDrag}
              >
                {zones.map((zone) => (
                  <polygon
                    key={`zone-fill-${zone.id}`}
                    className="zone-fill"
                    points={polygonPoints(zone.points)}
                    fill={zone.color}
                    stroke={zone.color}
                    strokeWidth="0.8"
                  />
                ))}
                {(job?.trajectories || []).map((trajectory) => (
                  <polyline
                    key={`trajectory-path-${trajectory.trackId}`}
                    className="trajectory-path"
                    points={polygonPoints(trajectory.points)}
                  />
                ))}
                {(job?.trajectories || []).map((trajectory) => {
                  const start = trajectory.points[0];
                  const end = trajectory.points[trajectory.points.length - 1];
                  return (
                    <g
                      key={`trajectory-endpoints-${trajectory.trackId}`}
                      className="trajectory-endpoints"
                    >
                      {start && (
                        <circle
                          className="trajectory-endpoint trajectory-start"
                          cx={start.x}
                          cy={start.y}
                          r="0.8"
                        >
                          <title>{`Track ${trajectory.trackId} start`}</title>
                        </circle>
                      )}
                      {end && (
                        <circle
                          className="trajectory-endpoint trajectory-end"
                          cx={end.x}
                          cy={end.y}
                          r="0.8"
                        >
                          <title>{`Track ${trajectory.trackId} end`}</title>
                        </circle>
                      )}
                    </g>
                  );
                })}
                {zones.map((zone) => (
                  <g key={`zone-controls-${zone.id}`} className="zone-controls">
                    <text
                      x={zone.points.reduce((sum, point) => sum + point.x, 0) / zone.points.length}
                      y={zone.points.reduce((sum, point) => sum + point.y, 0) / zone.points.length}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {zone.label}
                    </text>
                    {zone.points.map((point, index) => (
                      <circle
                        key={`${zone.id}-${index}`}
                        cx={point.x}
                        cy={point.y}
                        r="1.8"
                        onPointerDown={(event) => {
                          if (savingZones) return;
                          event.preventDefault();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setDragTarget({ zoneId: zone.id, pointIndex: index });
                        }}
                      />
                    ))}
                  </g>
                ))}
              </svg>
            </div>

            <div className="preview-caption">
              <span>
                {job?.width && job?.height
                  ? `${job.width} × ${job.height} source frame`
                  : 'Extracted source frame'}{' '}
                · {job?.trajectories?.length || 0} trajectory paths
              </span>
              <span className="trajectory-legend">
                <i className="start-dot" /> Start <i className="end-dot" /> End
              </span>
              {savingZones ? ' · saving zones and recalculating…' : ''}
            </div>

            <dl className="preview-meta">
              <div>
                <dt>Tracking</dt>
                <dd>{job?.status === 'ready' ? 'Complete' : job?.status || 'Loading'}</dd>
              </div>
              <div>
                <dt>Zone coordinates</dt>
                <dd>
                  {job?.zoneSuggestionMethod === 'kmeans-convex-hull'
                    ? 'K-means hulls · pixel GeoJSON'
                    : 'Saved as pixel GeoJSON'}
                </dd>
              </div>
              <div>
                <dt>Movement counts</dt>
                <dd>{job?.countsStatus || 'Pending'}</dd>
              </div>
              {job?.trafficScene && (
                <div>
                  <dt>Traffic scene check</dt>
                  <dd>{job.trafficScene.confidence || 'accepted'} confidence</dd>
                </div>
              )}
            </dl>
          </section>
        </div>

        <div className="details-actions">
          <button
            type="button"
            className="secondary-action"
            onClick={() => navigate('/upload/video')}
          >
            ‹ Back
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={() => navigate('/upload')}
            disabled={savingZones}
          >
            Finish
          </button>
        </div>
      </section>
    </main>
  );
}

export default UploadVideoDetails;
