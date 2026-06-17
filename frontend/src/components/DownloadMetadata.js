import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  downloadDataset,
  getDataset,
  getDatasetDownloadUrl,
  startDatasetFileDownload,
  API_PUBLIC_BASE_URL,
} from "../services/api";
import "./DownloadMetadata.css";

const ROLE_OPTIONS = [
  "Student",
  "Researcher",
  "Faculty",
  "Industry Professional",
  "Government / Public Agency",
  "Other",
];

const INTENDED_USE_OPTIONS = [
  "Academic research",
  "Education / classroom use",
  "Class project",
  "Method evaluation / benchmarking",
];

const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 TrafficAtlas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function getAccessMode(dataset) {
  if (dataset?.access_level === "Public") return "open";
  if (
    dataset?.access_level === "Private" ||
    dataset?.access_level === "Restricted"
  )
    return "request";
  return dataset?.access_preference === "open" ? "open" : "request";
}

function DownloadMetadata() {
  const navigate = useNavigate();
  const { datasetId } = useParams();

  const [dataset, setDataset] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState([]);
  const [successMessage, setSuccessMessage] = useState("");
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [downloadStatus, setDownloadStatus] = useState("");

  const [formData, setFormData] = useState({
    fullName: localStorage.getItem("userName") || "",
    email: localStorage.getItem("userEmail") || "",
    role: localStorage.getItem("userRole") || "",
    organization: localStorage.getItem("userOrganization") || "",
    intendedUse: "",
    useDescription: "",
    usageDeclaration: false,
    licenseAgreement: false,
    citationAgreement: false,
    finalConfirmation: false,
  });

  const loadDataset = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await getDataset(datasetId);
      if (response.success && response.dataset) {
        setDataset(response.dataset);
      } else {
        setError("Dataset not found");
      }
    } catch {
      setError("Error loading dataset");
    } finally {
      setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => {
    loadDataset();
  }, [loadDataset]);

  const isFullUnavailable =
    dataset?.status === "pending_full_upload" ||
    dataset?.status === "pending_approval";

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  };

  const raiseError = (message, details = []) => {
    setError(message);
    setErrorDetails(Array.isArray(details) ? details : []);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const validate = () => {
    const errors = [];
    if (!formData.fullName.trim()) errors.push("Full name is required.");
    if (!formData.email.trim()) errors.push("Email is required.");
    if (!formData.role.trim()) errors.push("Role is required.");
    if (!formData.organization.trim()) errors.push("Organization is required.");
    if (!formData.intendedUse.trim())
      errors.push("Please choose your intended use.");
    if (!formData.usageDeclaration)
      errors.push("You must accept usage restrictions.");
    if (!formData.licenseAgreement)
      errors.push("You must agree to the MIT License.");
    if (!formData.citationAgreement)
      errors.push("You must agree to dataset citation requirements.");
    if (!formData.finalConfirmation)
      errors.push("Please confirm your request information is accurate.");
    return errors;
  };

  const downloadFileWithProgress = async (
    _datasetDownloadUrl,
    fallbackFileName,
  ) => {
    setDownloadStatus("Preparing download...");
    setDownloadProgress(0);

    await new Promise((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    const downloadMeta = await getDatasetDownloadUrl(datasetId);
    if (!downloadMeta.success || !downloadMeta.downloadUrl) {
      throw new Error(downloadMeta.error || "Failed to prepare download.");
    }

    if (downloadMeta.direct) {
      setDownloadStatus("Starting download from storage...");
      setDownloadProgress(100);
      await startDatasetFileDownload({
        ...downloadMeta,
        fileName: downloadMeta.fileName || fallbackFileName,
      });
      setDownloadStatus("Download started.");
      return;
    }

    const response = await fetch(
      downloadMeta.downloadUrl.startsWith("http")
        ? downloadMeta.downloadUrl
        : `${API_PUBLIC_BASE_URL}${downloadMeta.downloadUrl}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken") || ""}`,
        },
      },
    );
    if (!response.ok || !response.body) {
      throw new Error("Failed to download file from storage.");
    }

    const totalBytes = Number(response.headers.get("content-length") || 0);
    if (totalBytes > 0) {
      setDownloadStatus(
        `Download started... 0 MB of ${Math.round(totalBytes / 1024 / 1024)} MB`,
      );
    } else {
      setDownloadStatus("Download started...");
    }
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        receivedBytes += value.length;
        if (totalBytes > 0) {
          setDownloadProgress(
            Math.min(100, Math.round((receivedBytes / totalBytes) * 100)),
          );
          setDownloadStatus(
            `Downloading... ${Math.round(receivedBytes / 1024 / 1024)} MB of ${Math.round(totalBytes / 1024 / 1024)} MB`,
          );
        } else {
          setDownloadStatus(
            `Downloading... ${Math.round(receivedBytes / 1024 / 1024)} MB received`,
          );
        }
      }
    }

    const blob = new Blob(chunks);
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = downloadMeta.fileName || fallbackFileName || "download.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(objectUrl);
    setDownloadProgress(100);
    setDownloadStatus("Download complete.");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isFullUnavailable) {
      raiseError(
        "Full dataset is not available yet. Only the sample is available.",
      );
      return;
    }
    const validationErrors = validate();
    if (validationErrors.length) {
      raiseError(
        "Please fix the following before submitting:",
        validationErrors,
      );
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const downloaderMetadata = {
        userId: localStorage.getItem("userId") || "anonymous",
        downloaderName: formData.fullName,
        downloaderEmail: formData.email,
        downloaderRole: formData.role,
        downloaderOrganization: formData.organization,
        purposeOfUse: formData.intendedUse,
        projectAssociation: formData.useDescription,
      };
      const consents = {
        usageDeclaration: formData.usageDeclaration,
        licenseAgreement: formData.licenseAgreement,
        citationAgreement: formData.citationAgreement,
        finalConfirmation: formData.finalConfirmation,
      };

      const response = await downloadDataset(
        datasetId,
        downloaderMetadata,
        consents,
      );
      if (!response.success) {
        raiseError("Request failed. Please try again.");
        return;
      }

      if (response.requiresApproval) {
        setSuccessMessage(
          "Request submitted. Full dataset access is pending approval.",
        );
        setTimeout(() => navigate("/discover"), 2500);
      } else {
        setSuccessMessage("Request recorded. Your download will start now.");
        if (response.downloadUrl) {
          if (response.direct) {
            setDownloadStatus("Starting download from storage...");
            setDownloadProgress(100);
            await startDatasetFileDownload(response);
            setDownloadStatus("Download started.");
          } else {
            await downloadFileWithProgress(
              response.downloadUrl,
              `${dataset?.title || "dataset"}.zip`,
            );
          }
        }
      }
    } catch (err) {
      raiseError(
        err.response?.data?.error ||
          "Failed to submit request. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="download-page">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "80px 0",
            gap: "16px",
            color: "#6b7280",
          }}
        >
          <div
            className="spinner"
            style={{
              width: 36,
              height: 36,
              border: "3px solid #e5e7eb",
              borderTopColor: "#2a7c6f",
              borderRadius: "50%",
              animation: "spin 0.7s linear infinite",
            }}
          />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="download-page">
      <h1 className="download-page-title">Download Request</h1>
      <p className="download-page-subtitle">
        Complete the form below to request access to this dataset.
      </p>

      {/* Dataset Banner */}
      {dataset && (
        <div className="dataset-summary-banner">
          <h3>{dataset.title}</h3>
          <p>
            {dataset.description?.substring(0, 120)}
            {dataset.description?.length > 120 ? "…" : ""}
          </p>
          <span className="access-type">
            {getAccessMode(dataset) === "open"
              ? "🔓 Open Access"
              : "🔒 Request-Based Access"}
          </span>
        </div>
      )}

      {error && (
        <div className="dl-alert error">
          <div>{error}</div>
          {errorDetails.length > 0 && (
            <ul className="dl-error-list">
              {errorDetails.map((item, idx) => (
                <li key={`${idx}-${String(item)}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {successMessage && (
        <div className="dl-alert success">{successMessage}</div>
      )}
      {downloadProgress !== null && (
        <div className="dl-download-progress">
          <div className="dl-download-progress-header">
            <span>Download progress</span>
            <span>{downloadProgress}%</span>
          </div>
          <div className="dl-download-progress-bar">
            <div
              className="dl-download-progress-fill"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
          {downloadStatus && (
            <div className="dl-download-progress-text">{downloadStatus}</div>
          )}
        </div>
      )}

      {isFullUnavailable && (
        <div className="dl-alert error">
          Full dataset is not available yet. You can download the sample, but
          full access requests are disabled until upload completes.
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Section 1 — Requestor Info */}
        <div className="dl-section">
          <div className="dl-section-title">
            Section 1 — Requestor Information
          </div>
          <div className="dl-two-col">
            <div className="dl-form-group">
              <label htmlFor="fullName">Full Name *</label>
              <input
                id="fullName"
                name="fullName"
                value={formData.fullName}
                onChange={handleChange}
                placeholder="Dr. Jane Smith"
                required
              />
            </div>
            <div className="dl-form-group">
              <label htmlFor="email">Email Address *</label>
              <input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="you@university.edu"
                required
              />
            </div>
            <div className="dl-form-group">
              <label htmlFor="role">Role *</label>
              <select
                id="role"
                name="role"
                value={formData.role}
                onChange={handleChange}
                required
              >
                <option value="">Select your role</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="dl-form-group">
              <label htmlFor="organization">
                Affiliated Institution / Organization *
              </label>
              <input
                id="organization"
                name="organization"
                value={formData.organization}
                onChange={handleChange}
                placeholder="Example University"
                required
              />
            </div>
          </div>
        </div>

        {/* Section 2 — Purpose */}
        <div className="dl-section">
          <div className="dl-section-title">
            Section 2 — Purpose of Download
          </div>
          <div className="dl-form-group">
            <label htmlFor="intendedUse">Intended Use of the Dataset *</label>
            <select
              id="intendedUse"
              name="intendedUse"
              value={formData.intendedUse}
              onChange={handleChange}
              required
            >
              <option value="">Select intended use</option>
              {INTENDED_USE_OPTIONS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="dl-form-group">
            <label htmlFor="useDescription">
              Brief Description of Use (Optional)
            </label>
            <textarea
              id="useDescription"
              name="useDescription"
              value={formData.useDescription}
              onChange={handleChange}
              placeholder="Example: Traffic safety analysis for a graduate research project."
            />
          </div>
        </div>

        {/* Section 3 — Usage Restrictions */}
        <div className="dl-section">
          <div className="dl-section-title">
            Section 3 — Usage Restrictions & Consent
          </div>
          <div className="dl-checkbox-group">
            <input
              id="usageDeclaration"
              name="usageDeclaration"
              type="checkbox"
              checked={formData.usageDeclaration}
              onChange={handleChange}
            />
            <label htmlFor="usageDeclaration">
              I will use this dataset only for research/education, not for
              commercial use, not redistribute it without permission, and comply
              with license/usage terms.
            </label>
          </div>
        </div>

        {/* Section 4 — License & Citation */}
        <div className="dl-section">
          <div className="dl-section-title">
            Section 4 — License & Citation Acknowledgement
          </div>
          <div className="dl-checkbox-group">
            <input
              id="licenseAgreement"
              name="licenseAgreement"
              type="checkbox"
              checked={formData.licenseAgreement}
              onChange={handleChange}
            />
            <label htmlFor="licenseAgreement">
              I have reviewed and agree to the dataset license (MIT License).
            </label>
          </div>
          <details className="dl-license">
            <summary>Read the MIT License</summary>
            <pre>{MIT_LICENSE_TEXT}</pre>
          </details>
          <div className="dl-checkbox-group">
            <input
              id="citationAgreement"
              name="citationAgreement"
              type="checkbox"
              checked={formData.citationAgreement}
              onChange={handleChange}
            />
            <label htmlFor="citationAgreement">
              I agree to cite this dataset in any publication/presentation using
              the preferred citation below.
            </label>
          </div>
          <div className="citation-box">
            <strong>Preferred Citation</strong>
            <p>
              {dataset?.preferred_citation ||
                dataset?.citation ||
                "Citation not provided by contributor."}
            </p>
          </div>
        </div>

        {/* Section 5 — Final Confirmation */}
        <div className="dl-section">
          <div className="dl-section-title">Section 5 — Final Confirmation</div>
          <p className="access-notice">
            Full dataset access requires a registered user account. If approved,
            you will receive an email with instructions to complete registration
            and download the dataset.
          </p>
          <div className="dl-checkbox-group">
            <input
              id="finalConfirmation"
              name="finalConfirmation"
              type="checkbox"
              checked={formData.finalConfirmation}
              onChange={handleChange}
            />
            <label htmlFor="finalConfirmation">
              I certify that the information provided above is accurate and
              submitted in good faith.
            </label>
          </div>
        </div>

        <div className="dl-button-group">
          <button
            type="button"
            className="dl-btn-secondary"
            onClick={() => navigate(`/dataset/${datasetId}`)}
            disabled={submitting}
          >
            ← Back
          </button>
          <button
            type="submit"
            className="dl-btn-primary"
            disabled={submitting || isFullUnavailable}
          >
            {submitting ? "Submitting…" : "Submit Request →"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default DownloadMetadata;
