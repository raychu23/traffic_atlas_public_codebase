import React, { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  getDataset,
  downloadSample,
  listEmbeddingVideos,
} from "../services/api";
import {
  isHardcodedEmbeddingsDataset,
  applyHardcodedDatasetMetadata,
} from "../config/hardcodedEmbeddings";
import { useDatasetFilterTags } from "../hooks/useDatasetFilterTags";
import DatasetAnalysisTags from "./DatasetAnalysisTags";
import DatasetPipelineControls from "./DatasetPipelineControls";
import "./DatasetDetail.css";

function DatasetDetail() {
  const navigate = useNavigate();
  const { datasetId } = useParams();
  const [dataset, setDataset] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [hasEmbeddingsOnS3, setHasEmbeddingsOnS3] = useState(false);
  const [embeddingsCheckDone, setEmbeddingsCheckDone] = useState(false);
  const { filterTags, loading: filterTagsLoading } =
    useDatasetFilterTags(datasetId);
  const useDemoBundle = isHardcodedEmbeddingsDataset(datasetId);

  const recheckEmbeddings = () => {
    if (!datasetId || String(datasetId).startsWith("req_")) return;
    setEmbeddingsCheckDone(false);
    listEmbeddingVideos(datasetId)
      .then((res) => setHasEmbeddingsOnS3(Boolean(res?.videos?.length)))
      .catch(() => setHasEmbeddingsOnS3(false))
      .finally(() => setEmbeddingsCheckDone(true));
  };
  const isFullUnavailable =
    dataset?.status === "pending_full_upload" ||
    dataset?.status === "pending_approval";
  const accessMode =
    dataset?.access_level === "Public"
      ? "open"
      : dataset?.access_level === "Private" ||
          dataset?.access_level === "Restricted"
        ? "request"
        : dataset?.access_preference === "open"
          ? "open"
          : "request";

  useEffect(() => {
    let cancelled = false;
    const loadDataset = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await getDataset(datasetId);
        if (cancelled) return;
        if (response.success && response.dataset) {
          const ds = useDemoBundle
            ? applyHardcodedDatasetMetadata(response.dataset)
            : response.dataset;
          setDataset(ds);
        } else if (useDemoBundle) {
          setDataset(applyHardcodedDatasetMetadata(null));
        } else {
          setError("Dataset not found");
        }
      } catch {
        if (!cancelled) {
          if (useDemoBundle) {
            setDataset(applyHardcodedDatasetMetadata(null));
          } else {
            setError("Error loading dataset");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadDataset();
    return () => {
      cancelled = true;
    };
  }, [datasetId, useDemoBundle]);

  useEffect(() => {
    if (!datasetId) {
      setHasEmbeddingsOnS3(false);
      setEmbeddingsCheckDone(false);
      return undefined;
    }
    const isPendingUploadRequest = String(datasetId).startsWith("req_");

    if (useDemoBundle) {
      setHasEmbeddingsOnS3(true);
      setEmbeddingsCheckDone(true);
      return undefined;
    }

    if (isPendingUploadRequest) {
      setHasEmbeddingsOnS3(false);
      setEmbeddingsCheckDone(true);
      return undefined;
    }
    let cancelled = false;
    setEmbeddingsCheckDone(false);
    listEmbeddingVideos(datasetId)
      .then((res) => {
        if (!cancelled) {
          setHasEmbeddingsOnS3(Boolean(res?.videos?.length));
        }
      })
      .catch(() => {
        if (!cancelled) setHasEmbeddingsOnS3(false);
      })
      .finally(() => {
        if (!cancelled) setEmbeddingsCheckDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, useDemoBundle]);

  const handleDownloadSample = async () => {
    setDownloadError("");
    try {
      await downloadSample(datasetId);
    } catch (err) {
      setDownloadError(err.message || "You do not have access to the sample.");
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return "N/A";
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  };

  const formatDate = (d) => {
    if (!d) return "N/A";
    const text = String(d).trim();
    if (text.includes(" to ")) return text;
    if (/^[A-Za-z]+ \d{4}$/.test(text)) return text;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return text;
    return parsed.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  if (loading) {
    return (
      <div className="detail-loading">
        <div className="spinner" />
        <p>Loading dataset...</p>
      </div>
    );
  }

  if (error || !dataset) {
    return (
      <div className="detail-error">
        <p>{error || "Dataset not found"}</p>
        <button
          onClick={() => navigate("/discover")}
          className="detail-btn-primary"
        >
          Back to Datasets
        </button>
      </div>
    );
  }

  const tags = Array.isArray(dataset.keywords)
    ? dataset.keywords
    : dataset.keywords
      ? dataset.keywords.split(",").map((t) => t.trim())
      : [];
  const funding = Array.isArray(dataset.funded_by)
    ? dataset.funded_by.join(", ")
    : dataset.funded_by;

  return (
    <div className="detail-page">
      {/* Hero Banner */}
      <div className="detail-hero">
        <img
          src={dataset.image || "/images/albertoadan-detroit-3727417_1920.jpg"}
          alt={dataset.title}
          className="detail-hero-img"
        />
        <div className="detail-hero-overlay" />
        <button
          className="detail-back-btn"
          onClick={() => navigate("/discover")}
        >
          ← Back to Datasets
        </button>
      </div>

      {/* Content */}
      <div className="detail-body">
        {/* Left Column */}
        <div className="detail-left">
          <div className="detail-access-badge-row">
            <span
              className={`detail-access-badge ${accessMode === "open" ? "open" : "request"}`}
            >
              {accessMode === "open" ? "🔓 Open Access" : "🔒 Request Based"}
            </span>
          </div>

          <h1 className="detail-title">{dataset.title}</h1>

          <p className="detail-description">{dataset.description}</p>

          {tags.length > 0 && (
            <div className="detail-tags">
              {tags.map((tag, i) => (
                <span key={i} className="detail-tag">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          <div className="detail-actions">
            <button
              className="detail-btn-secondary"
              onClick={handleDownloadSample}
            >
              Download Sample
            </button>
            {downloadError && (
              <div className="detail-alert">{downloadError}</div>
            )}
            <button
              className="detail-btn-primary"
              onClick={() => navigate(`/download/${datasetId}/metadata`)}
              disabled={isFullUnavailable}
            >
              {accessMode === "open"
                ? "Download Full Dataset →"
                : "Request Full Dataset →"}
            </button>
          </div>
          {isFullUnavailable && (
            <div className="detail-alert">
              Full dataset is not available yet. Only the sample can be
              downloaded for now.
            </div>
          )}

          {/* Citation */}
          {dataset.preferred_citation && (
            <div className="detail-citation-box">
              <strong>Citation</strong>
              <p>{dataset.preferred_citation}</p>
            </div>
          )}

          <section
            className="detail-analysis-section"
            aria-labelledby="embedding-cluster-heading"
          >
            <h2
              id="embedding-cluster-heading"
              className="detail-section-heading"
            >
              Embedding Cluster Analysis
            </h2>
            <p className="detail-analysis-lead">
              Explore 3D embeddings in an interactive projection of traffic
              scene clips.
            </p>

            {filterTagsLoading && !filterTags && (
              <p className="detail-analysis-hint">Loading generated tags…</p>
            )}
            <DatasetAnalysisTags data={filterTags} />

            {!useDemoBundle && !embeddingsCheckDone && (
              <p className="detail-analysis-hint">
                Checking for CLIP embeddings on S3…
              </p>
            )}

            {embeddingsCheckDone && hasEmbeddingsOnS3 && (
              <button
                type="button"
                className="detail-btn-secondary"
                onClick={() => navigate(`/dataset/${datasetId}/analysis`)}
              >
                Explore 3D Embeddings →
              </button>
            )}

            {embeddingsCheckDone &&
              !hasEmbeddingsOnS3 &&
              dataset.status === "pending_approval" && (
                <p className="detail-analysis-hint detail-analysis-pending">
                  Analysis starts after an admin approves your sample upload.
                </p>
              )}

            {embeddingsCheckDone &&
              !hasEmbeddingsOnS3 &&
              (dataset.status === "active" ||
                dataset.status === "pending_full_upload") && (
                <DatasetPipelineControls
                  datasetId={datasetId}
                  hasEmbeddingsOnS3={hasEmbeddingsOnS3}
                  onProcessingComplete={recheckEmbeddings}
                />
              )}
          </section>
        </div>

        {/* Right Column — Metadata */}
        <div className="detail-right">
          <div className="detail-meta-card">
            <h3 className="detail-meta-heading">Dataset Information</h3>
            <table className="detail-meta-table">
              <tbody>
                {[
                  [
                    "Organization",
                    dataset.associated_organization ||
                      dataset.owner_name_or_org ||
                      dataset.associatedOrganization,
                  ],
                  ["Submitted By", dataset.uploader_name],
                  ["Location", dataset.location],
                  ["Collection Date", formatDate(dataset.collection_date)],
                  ["Funding", funding],
                  ["Grant / Project ID", dataset.grant_or_project_id],
                  ["Capture Method", dataset.capture_method],
                  ["Purpose", dataset.purpose_of_collection],
                  ["Allowed Uses", dataset.allowed_uses],
                  ["File Size", formatFileSize(dataset.file_size)],
                  ["Date Added", formatDate(dataset.created_at)],
                ].map(([key, val]) => (
                  <tr key={key}>
                    <td className="meta-key">{key}</td>
                    <td className="meta-val">{val || "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="detail-meta-card" style={{ marginTop: "16px" }}>
            <h3 className="detail-meta-heading">Access & License</h3>
            <table className="detail-meta-table">
              <tbody>
                <tr>
                  <td className="meta-key">License</td>
                  <td className="meta-val">{dataset.license || "N/A"}</td>
                </tr>
                <tr>
                  <td className="meta-key">Access Type</td>
                  <td className="meta-val">
                    {dataset.access_level ||
                      (accessMode === "open" ? "Open Access" : "Request-Based")}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DatasetDetail;
