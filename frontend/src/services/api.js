import axios from "axios";
import { clearAuthTokens, notifyAuthChanged } from "./authState";

const rawApiUrl =
  process.env.REACT_APP_API_URL_TESTING ||
  "https://api.example.com";
const normalizedApiUrl = rawApiUrl.replace(/\/+$/, "");
const API_BASE_URL = normalizedApiUrl.endsWith("/api")
  ? normalizedApiUrl
  : `${normalizedApiUrl}/api`;
export const API_PUBLIC_BASE_URL = API_BASE_URL.replace(/\/api$/, "");

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("authToken");
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || "";
    if (status === 401 && !url.includes("/users/login")) {
      clearAuthTokens();
      localStorage.setItem("sessionExpired", "true");
      notifyAuthChanged();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  },
);

export const registerUser = async (userData) => {
  const response = await api.post("/users/register", userData);
  return response.data;
};

export const confirmRegistration = async (email, code) => {
  const response = await api.post("/users/confirm-registration", {
    email,
    code,
  });
  return response.data;
};

export const loginUser = async (credentials) => {
  const response = await api.post("/users/login", credentials);
  return response.data;
};

export const forgotPassword = async (email) => {
  const response = await api.post("/users/forgot-password", { email });
  return response.data;
};

export const confirmPassword = async (email, code, newPassword) => {
  const response = await api.post("/users/confirm-password", {
    email,
    code,
    newPassword,
  });
  return response.data;
};

export const getCurrentUser = async () => {
  const response = await api.get("/auth/me");
  return response.data;
};

export const getUploadTerms = async () => {
  const response = await api.get("/legal/upload-terms");
  return response.data;
};

export const getUser = async (userId) => {
  const response = await api.get(`/users/${userId}`);
  return response.data;
};

export const getUserDashboard = async () => {
  const response = await api.get("/users/me/dashboard");
  return response.data;
};

// Submit upload request with sample data
export const submitUploadRequest = async (
  metadata,
  sampleFile,
  onUploadProgress,
) => {
  const formData = new FormData();
  formData.append("metadata", JSON.stringify(metadata));
  if (sampleFile) {
    formData.append("sampleFile", sampleFile);
  }

  const response = await api.post("/datasets/upload-request", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
    onUploadProgress,
  });
  return response.data;
};

// Multipart sample upload (direct to S3)
export const initiateSampleMultipartUpload = async (payload) => {
  const response = await api.post(
    "/datasets/upload-request/multipart/initiate",
    payload,
  );
  return response.data;
};

export const getSampleMultipartParts = async (requestId) => {
  const response = await api.get(
    `/datasets/upload-request/${requestId}/multipart/parts`,
  );
  return response.data;
};

export const getSampleMultipartPartUrl = async (requestId, payload) => {
  const response = await api.post(
    `/datasets/upload-request/${requestId}/multipart/part-url`,
    payload,
  );
  return response.data;
};

export const completeSampleMultipartUpload = async (requestId, payload) => {
  const response = await api.post(
    `/datasets/upload-request/${requestId}/multipart/complete`,
    payload,
  );
  return response.data;
};

export const abortSampleMultipartUpload = async (requestId) => {
  const response = await api.post(
    `/datasets/upload-request/${requestId}/multipart/abort`,
  );
  return response.data;
};

// Upload full dataset after approval
export const uploadFullDataset = async (datasetId, fullFile) => {
  const formData = new FormData();
  formData.append("fullFile", fullFile);

  const response = await api.post(
    `/datasets/${datasetId}/upload-full`,
    formData,
    {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    },
  );
  return response.data;
};

// Multipart full dataset upload (direct to S3)
export const initiateMultipartUpload = async (datasetId, payload) => {
  const response = await api.post(
    `/datasets/${datasetId}/upload-full/multipart/initiate`,
    payload,
  );
  return response.data;
};

export const getMultipartSession = async (datasetId) => {
  const response = await api.get(
    `/datasets/${datasetId}/upload-full/multipart/session`,
  );
  return response.data;
};

export const getMultipartPartUrl = async (datasetId, payload) => {
  const response = await api.post(
    `/datasets/${datasetId}/upload-full/multipart/part-url`,
    payload,
  );
  return response.data;
};

export const listMultipartParts = async (datasetId, params) => {
  const response = await api.get(
    `/datasets/${datasetId}/upload-full/multipart/parts`,
    { params },
  );
  return response.data;
};

export const completeMultipartUpload = async (datasetId, payload) => {
  const response = await api.post(
    `/datasets/${datasetId}/upload-full/multipart/complete`,
    payload,
  );
  return response.data;
};

/** Start Vaidio processing pipeline (backend uses IAM; no AWS keys in browser). */
export const approveDatasetPipeline = async (datasetId) => {
  const response = await api.post(`/datasets/${datasetId}/approve`, {
    dataset_id: datasetId,
  });
  return response.data;
};

/** Poll Step Functions + S3 processing_status.json */
export const getDatasetProcessingStatus = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}/status`);
  return response.data;
};

/** Dataset-level analysis tags from S3 (dataset_filter_tags.json). */
export const getDatasetFilterTags = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}/analysis/filter-tags`);
  return response.data;
};

/** Spherical PCA of CLIP embeddings for dataset detail visualization */
export const getSphericalPcaEmbeddings = async (datasetId, videoId = null) => {
  const params = videoId ? { video_id: videoId } : {};
  const response = await api.get(
    `/datasets/${datasetId}/embeddings/spherical-pca`,
    { params },
  );
  return response.data;
};

/** List clip embedding videos under analysis/embeddings/clip/{videoId}/ */
export const listEmbeddingVideos = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}/embeddings/videos`);
  return response.data;
};

export const abortMultipartUpload = async (datasetId, payload) => {
  const response = await api.post(
    `/datasets/${datasetId}/upload-full/multipart/abort`,
    payload,
  );
  return response.data;
};

export const getNotificationSummary = async () => {
  const response = await api.get("/notifications");
  return response.data;
};

// Legacy - kept for backward compatibility
export const uploadDataset = async (metadata, zipFile) => {
  return submitUploadRequest(metadata, zipFile);
};

export const getDatasets = async (filters = {}) => {
  const response = await api.get("/datasets", { params: filters });
  return response.data;
};

export const getDataset = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}`);
  return response.data;
};

export const getDatasetDownloadUrl = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}/file-url`);
  return response.data;
};

export const getDatasetSampleDownloadUrl = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}/sample-url`);
  return response.data;
};

export const getAdminSampleDownloadUrl = async (requestId) => {
  const response = await api.get(
    `/admin/upload-requests/${requestId}/sample-url`,
  );
  return response.data;
};

/**
 * Start a dataset file download. Uses presigned S3 URL when direct=true (production).
 * Falls back to API streaming for local disk storage.
 */
export async function startDatasetFileDownload(meta) {
  if (!meta?.success || !meta?.downloadUrl) {
    throw new Error(meta?.error || "Failed to prepare download.");
  }

  if (meta.direct) {
    const link = document.createElement("a");
    link.href = meta.downloadUrl;
    link.rel = "noopener noreferrer";
    if (meta.fileName) {
      link.download = meta.fileName;
    }
    document.body.appendChild(link);
    link.click();
    link.remove();
    return meta;
  }

  const token = localStorage.getItem("authToken");
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const url = meta.downloadUrl.startsWith("http")
    ? meta.downloadUrl
    : `${API_PUBLIC_BASE_URL}${meta.downloadUrl}`;

  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    let message = "Unable to download file.";
    try {
      const data = await response.json();
      message = data?.error || message;
    } catch {
      // ignore parse failure
    }
    throw new Error(message);
  }

  const contentDisposition = response.headers.get("content-disposition") || "";
  let filename = meta.fileName || "download.zip";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(
    contentDisposition,
  );
  if (match && match[1]) {
    filename = decodeURIComponent(match[1]);
  }

  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
  return meta;
}

export const getAuthMe = async () => {
  const response = await api.get("/auth/me");
  return response.data;
};

export const getMyProfile = async () => {
  try {
    const response = await api.get("/users/me");
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 500) {
      const fallback = await api.get("/auth/me");
      return fallback.data;
    }
    throw err;
  }
};

export const updateMyProfile = async (payload) => {
  try {
    const response = await api.put("/users/me", payload);
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 500) {
      // Backend not yet deployed or Cognito admin creds missing — return a soft failure
      return {
        success: false,
        error:
          "Profile update is temporarily unavailable. Please try again later.",
      };
    }
    throw err;
  }
};

export const deleteMyProfile = async () => {
  const response = await api.delete("/users/me");
  return response.data;
};

export const downloadDataset = async (
  datasetId,
  downloaderMetadata,
  consents,
) => {
  const response = await api.post(`/datasets/${datasetId}/download`, {
    downloaderMetadata,
    consents,
  });
  return response.data;
};

// Download sample (presigned S3 URL when configured)
export const downloadSample = async (datasetId) => {
  const meta = await getDatasetSampleDownloadUrl(datasetId);
  await startDatasetFileDownload(meta);
};

// Download sample for admin (works on pending staging requests too)
export const downloadAdminSample = async (requestId) => {
  const meta = await getAdminSampleDownloadUrl(requestId);
  await startDatasetFileDownload(meta);
};

// Download full dataset (requires approval) — presigned S3 when configured
export const downloadFullDataset = async (datasetId) => {
  const meta = await getDatasetDownloadUrl(datasetId);
  await startDatasetFileDownload(meta);
};

// Admin APIs
export const getUploadRequests = async () => {
  const response = await api.get("/admin/upload-requests");
  return response.data;
};

export const getUploadRequest = async (requestId) => {
  const response = await api.get(`/admin/upload-requests/${requestId}`);
  return response.data;
};

export const approveUploadRequest = async (requestId, adminNotes) => {
  const response = await api.post(
    `/admin/upload-requests/${requestId}/approve`,
    {
      adminNotes,
    },
  );
  return response.data;
};

export const clarifyUploadRequest = async (requestId, adminNotes) => {
  const response = await api.post(
    `/admin/upload-requests/${requestId}/comment`,
    { adminNotes },
  );
  return response.data;
};

export const rejectUploadRequest = async (requestId, reason, adminNotes) => {
  const response = await api.post(
    `/admin/upload-requests/${requestId}/reject`,
    {
      reason,
      adminNotes,
    },
  );
  return response.data;
};

export const getDownloadRequests = async () => {
  const response = await api.get("/admin/download-requests");
  return response.data;
};

export const getDownloadRequest = async (requestId) => {
  const response = await api.get(`/admin/download-requests/${requestId}`);
  return response.data;
};

// Admin User Management
export const getAdminUsers = async () => {
  const response = await api.get("/admin/users");
  return response.data;
};

export const getRequestHistory = async () => {
  const response = await api.get("/admin/requests/history");
  return response.data;
};

export const deleteAdminUser = async (userId) => {
  const response = await api.delete(`/admin/users/${userId}`);
  return response.data;
};

export const setAdminUser = async (userId, isAdmin) => {
  const response = await api.post(`/admin/users/${userId}/set-admin`, {
    isAdmin,
  });
  return response.data;
};

export const approveDownloadRequest = async (requestId, adminNotes) => {
  const response = await api.post(
    `/admin/download-requests/${requestId}/approve`,
    {
      adminNotes,
    },
  );
  return response.data;
};

export const clarifyDownloadRequest = async (requestId, adminNotes) => {
  const response = await api.post(
    `/admin/download-requests/${requestId}/comment`,
    { adminNotes },
  );
  return response.data;
};

export const rejectDownloadRequest = async (requestId, reason, adminNotes) => {
  const response = await api.post(
    `/admin/download-requests/${requestId}/reject`,
    {
      reason,
      adminNotes,
    },
  );
  return response.data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Request Chat / Threaded messaging
// ─────────────────────────────────────────────────────────────────────────────
export const getMessages = async (type, requestId) => {
  const response = await api.get(`/requests/${type}/${requestId}/messages`);
  return response.data;
};

export const sendMessage = async (type, requestId, text, actingAs = "user") => {
  const response = await api.post(`/requests/${type}/${requestId}/messages`, {
    text,
    actingAs,
  });
  return response.data;
};

export const validateTrafficVideoUpload = async (videoFile, onUploadProgress) => {
  const formData = new FormData();
  formData.append('videoFile', videoFile);

  const response = await api.post('/videos/validate-upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
    onUploadProgress,
  });
  return response.data;
};

export const getTrafficVideoJob = async (videoId) => {
  const response = await api.get(`/videos/${videoId}`);
  return response.data;
};

export const restartTrafficVideoProcessing = async (videoId) => {
  const response = await api.post(`/videos/${videoId}/process`);
  return response.data;
};

export const updateTrafficVideoZones = async (videoId, zones) => {
  const response = await api.put(`/videos/${videoId}/zones`, { zones });
  return response.data;
};

export const getTrafficVideoArtifact = async (videoId, artifact) => {
  const response = await api.get(`/videos/${videoId}/artifacts/${artifact}`, {
    responseType: 'blob',
  });
  return response.data;
};

export default api;
