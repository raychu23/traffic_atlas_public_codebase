const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const {
  validateUploadRequestSchema,
  formatAjvErrors
} = require('./validators/uploadRequestValidator');
const s3Storage = require('./s3Storage');
const stepFunctions = require('./stepFunctions');
const datasetPaths = require('./datasetPaths');

const DATA_ROOT = path.join(__dirname, 'data');
const MAX_SAMPLE_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

function formatBytes(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}
const LEGAL_TERMS_VERSION = 'ironyun-terms-v2026-03';
const S3_PRIMARY = s3Storage.isPrimaryMode();

// Ensure directory exists
async function ensureDir(dirPath) {
  if (S3_PRIMARY) return;
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function uploadRequestFileNames(requestId) {
  return [`upload_request_${requestId}.json`, `ulreq_${requestId}.json`];
}

function downloadRequestFileNames(requestId) {
  return [`download_request_${requestId}.json`, `dlreq_${requestId}.json`];
}

function reviewFileNames(requestType, requestId) {
  const legacyPrefix = requestType === 'upload' ? 'ulreq' : 'dlreq';
  return [`review_${requestId}.json`, `${legacyPrefix}_${requestId}_review.json`];
}

async function writeJson(filePath, data) {
  const text = JSON.stringify(data, null, 2);
  if (S3_PRIMARY) {
    await s3Storage.putDataPathFromText(filePath, text, 'application/json');
    return;
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text);
  await s3Storage.mirrorDataFile(filePath, 'application/json');
}

async function writeText(filePath, content) {
  if (S3_PRIMARY) {
    await s3Storage.putDataPathFromText(filePath, content, 'text/plain');
    return;
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content);
  await s3Storage.mirrorDataFile(filePath, 'text/plain');
}

async function readText(filePath) {
  if (S3_PRIMARY) {
    return s3Storage.getDataPathAsText(filePath);
  }
  return fs.readFile(filePath, 'utf8');
}

async function readJson(filePath) {
  const text = await readText(filePath);
  return JSON.parse(text);
}

async function pathExists(filePath) {
  if (S3_PRIMARY) {
    return s3Storage.existsDataPath(filePath);
  }
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function readDir(dirPath) {
  if (S3_PRIMARY) {
    return s3Storage.listDirNames(dirPath);
  }
  return fs.readdir(dirPath);
}

async function findRequestInUsers(requestType, requestId) {
  const usersDir = path.join(DATA_ROOT, 'users');
  const userDirs = await readDir(usersDir);
  const requestDir = requestType === 'upload' ? 'upload' : 'download';
  const fileNames = requestType === 'upload'
    ? uploadRequestFileNames(requestId)
    : downloadRequestFileNames(requestId);

  for (const userDir of userDirs) {
    if (!userDir.startsWith('user_')) continue;
    for (const fileName of fileNames) {
      const reqPath = path.join(usersDir, userDir, 'requests', requestDir, fileName);
      try {
        return {
          request: await readJson(reqPath),
          userId: userDir.replace('user_', ''),
          path: reqPath
        };
      } catch (error) {
        // Continue searching other possible paths
      }
    }
  }

  return null;
}

async function upsertUserUploadRecord(userId, datasetId, record) {
  const logPath = path.join(DATA_ROOT, 'users', userId, 'activity_log.json');
  await ensureDir(path.dirname(logPath));
  let log = [];
  try { log = await readJson(logPath); } catch (e) {}
  log.push({ type: 'upload_approved', datasetId, record, timestamp: new Date().toISOString() });
  await writeJson(logPath, log);
}

async function upsertUserDownloadRecord(userId, requestId, record) {
  const logPath = path.join(DATA_ROOT, 'users', userId, 'activity_log.json');
  await ensureDir(path.dirname(logPath));
  let log = [];
  try { log = await readJson(logPath); } catch (e) {}
  log.push({ type: 'download_request', requestId, record, timestamp: new Date().toISOString() });
  await writeJson(logPath, log);
}

function datasetDirCandidates(datasetId) {
  return [
    path.join(DATA_ROOT, 'datasets', datasetId),
    path.join(DATA_ROOT, 'datasets', `data_${datasetId}`)
  ];
}

/** S3 keys where dataset metadata may live (data/ mirror vs pipeline prefix). */
function getDatasetMetadataCandidateKeys(datasetId) {
  const keys = [];
  if (s3Storage.isEnabled()) {
    const fromDataRoot = path.join(DATA_ROOT, 'datasets', datasetId, 'metadata.json');
    keys.push(s3Storage.toS3KeyFromDataPath(fromDataRoot));
  }
  keys.push(`${stepFunctions.getDatasetRootPrefix(datasetId)}metadata.json`);
  return [...new Set(keys)];
}

async function readDatasetMetadataFromCandidateKeys(datasetId) {
  if (!s3Storage.isEnabled()) return null;
  for (const key of getDatasetMetadataCandidateKeys(datasetId)) {
    try {
      const text = await s3Storage.getObjectTextByKey(key);
      return JSON.parse(text);
    } catch {
      // try next key
    }
  }
  return null;
}

async function resolveDatasetDir(datasetId, createIfMissing = false) {
  const [preferredDir, legacyDir] = datasetDirCandidates(datasetId);
  if (S3_PRIMARY) {
    if (await pathExists(path.join(preferredDir, 'metadata.json'))) return preferredDir;
    if (await pathExists(path.join(legacyDir, 'metadata.json'))) return legacyDir;
    if (await pathExists(path.join(preferredDir, 'dataset.json'))) return preferredDir;
    if (await pathExists(path.join(legacyDir, 'dataset.json'))) return legacyDir;
    if (await pathExists(path.join(preferredDir, 'sample_data.zip')) || await pathExists(path.join(preferredDir, 'full_data.zip'))) return preferredDir;
    if (await pathExists(path.join(legacyDir, 'sample_data.zip')) || await pathExists(path.join(legacyDir, 'full_data.zip'))) return legacyDir;
    if (await readDatasetMetadataFromCandidateKeys(datasetId)) return preferredDir;
    if (!createIfMissing) return preferredDir;
    return preferredDir;
  }
  if (await pathExists(preferredDir)) {
    return preferredDir;
  }
  if (await pathExists(legacyDir)) {
    return legacyDir;
  }
  if (!createIfMissing) return preferredDir;
  await ensureDir(preferredDir);
  return preferredDir;
}

// User Operations
async function createUser(userData) {
  const userId = crypto.randomUUID();
  const userDir = path.join(DATA_ROOT, 'users', `user_${userId}`);
  await ensureDir(userDir);
  
  const profilePath = path.join(userDir, 'profile.json');
  const email = String(userData.email || '').toLowerCase().trim();
  const profile = {
    userId,
    ...userData,
    email,
    createdAt: new Date().toISOString()
  };
  
  await writeJson(profilePath, profile);
  
  // Initialize subdirectories
  await ensureDir(path.join(userDir, 'consents'));
  await ensureDir(path.join(userDir, 'requests', 'upload'));
  await ensureDir(path.join(userDir, 'requests', 'download'));
  await ensureDir(path.join(userDir, 'uploads'));
  await ensureDir(path.join(userDir, 'downloads'));
  
  return profile;
}

async function getUser(userId) {
  const profilePath = path.join(DATA_ROOT, 'users', `user_${userId}`, 'profile.json');
  try {
    return await readJson(profilePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function getUserByEmail(email) {
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized) return null;

  const usersDir = path.join(DATA_ROOT, 'users');
  let userDirs = [];
  try {
    userDirs = await readDir(usersDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }

  for (const userDir of userDirs) {
    if (!userDir.startsWith('user_')) continue;
    const profilePath = path.join(usersDir, userDir, 'profile.json');
    try {
      const profile = await readJson(profilePath);
      if (String(profile.email || '').toLowerCase() === normalized) {
        return profile;
      }
    } catch (error) {
      // Ignore malformed/missing profile and continue search
    }
  }

  return null;
}

async function updateUserProfile(userId, updater) {
  const profilePath = path.join(DATA_ROOT, 'users', `user_${userId}`, 'profile.json');
  let profile;
  try {
    profile = await readJson(profilePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }

  const updatedProfile = {
    ...profile,
    ...updater,
    updatedAt: new Date().toISOString()
  };

  await writeJson(profilePath, updatedProfile);
  return updatedProfile;
}

async function upsertUserProfile(userId, updater = {}) {
  const userDir = path.join(DATA_ROOT, 'users', `user_${userId}`);
  await ensureDir(userDir);
  const profilePath = path.join(userDir, 'profile.json');
  let profile = {};
  try {
    profile = await readJson(profilePath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') throw error;
  }

  const updatedProfile = {
    userId,
    ...profile,
    ...updater,
    updatedAt: new Date().toISOString(),
  };

  await writeJson(profilePath, updatedProfile);
  return updatedProfile;
}

async function setUserAdminById(userId, isAdmin) {
  return updateUserProfile(userId, { isAdmin: Boolean(isAdmin) });
}

async function setUserAdminByEmail(email, isAdmin) {
  const user = await getUserByEmail(email);
  if (!user) return null;
  return setUserAdminById(user.userId, isAdmin);
}

async function setUserPasswordHashById(userId, passwordHash) {
  return updateUserProfile(userId, { passwordHash });
}

async function setUserPasswordHashByEmail(email, passwordHash) {
  const user = await getUserByEmail(email);
  if (!user) return null;
  return setUserPasswordHashById(user.userId, passwordHash);
}

// Dataset Operations
// Helper function to convert camelCase to snake_case for API compatibility
function toSnakeCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toSnakeCase);
  
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip null/undefined values
    if (value === null || value === undefined) continue;
    
    // Convert camelCase to snake_case
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    
    // Recursively convert nested objects
    if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[snakeKey] = toSnakeCase(value);
    } else {
      result[snakeKey] = value;
    }
  }
  return result;
}

async function createDataset(datasetData) {
  const datasetId = crypto.randomUUID();
  const datasetDir = await resolveDatasetDir(datasetId, true);
  await ensureDir(datasetDir);
  
  const datasetPath = path.join(datasetDir, 'metadata.json');
  const dataset = {
    datasetId,
    ...datasetData,
    createdAt: new Date().toISOString()
  };
  
  await writeJson(datasetPath, dataset);
  
  const licensePath = path.join(datasetDir, 'LICENSE.txt');
  await writeText(licensePath, datasetData.preferredCitation || 'See dataset metadata for license information.');
  
  return toSnakeCase(dataset);
}

async function getDataset(datasetId) {
  if (datasetId.startsWith('req_')) {
    const requestId = datasetId.replace('req_', '');
    const request = await getUploadRequest(requestId);
    if (!request) return null;
    return toSnakeCase({
      ...request.metadata,
      dataset_id: datasetId,
      status: 'pending_approval',
      is_request: true
    });
  }

  const datasetDir = await resolveDatasetDir(datasetId);
  const datasetPath = path.join(datasetDir, 'metadata.json');
  try {
    const dataset = await readJson(datasetPath);
    return toSnakeCase(dataset);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') {
      try {
        const legacyPath = path.join(datasetDir, 'dataset.json');
        const legacy = await readJson(legacyPath);
        return toSnakeCase(legacy);
      } catch (e) {
        const fromS3 = await readDatasetMetadataFromCandidateKeys(datasetId);
        if (fromS3) return toSnakeCase(fromS3);
        return null;
      }
    }
    throw error;
  }
}

async function getAllDatasets(includePending = false) {
  const datasetsDir = path.join(DATA_ROOT, 'datasets');
  const datasets = [];
  
  try {
    const dirs = await readDir(datasetsDir);
    for (const dir of dirs) {
      try {
        let datasetPath = path.join(datasetsDir, dir, 'metadata.json');
        if (!(await pathExists(datasetPath))) {
           datasetPath = path.join(datasetsDir, dir, 'dataset.json');
        }
        const dataset = await readJson(datasetPath);
        
        // Show if: 
        // 1. Explicitly active
        // 2. Or NO status (legacy data)
        // 3. Or pending_full_upload (approved sample, but awaiting big file)
        const isVisible = includePending || 
                          !dataset.status || 
                          dataset.status === 'active' || 
                          dataset.status === 'pending_full_upload';
                          
        if (isVisible) {
          datasets.push(toSnakeCase({
            ...dataset,
            dataset_id: dataset.datasetId || dataset.dataset_id || dir
          }));
        }
      } catch (error) {
        // Ignore missing/invalid
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') console.error('Error reading datasets:', error);
  }

  // Also include "Being Uploaded" requests if requested
  if (includePending) {
    try {
      const requestsDir = path.join(DATA_ROOT, 'requests', 'upload');
      const requestDirs = await readDir(requestsDir);
      for (const reqId of requestDirs) {
        try {
          const reqPath = path.join(requestsDir, reqId, 'request.json');
          const request = await readJson(reqPath);
          if (request.status === 'pending') {
            datasets.push(toSnakeCase({
              ...request.metadata,
              dataset_id: `req_${request.requestId}`,
              status: 'pending_approval',
              is_request: true
            }));
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  return datasets;
}

async function searchDatasets(filters = {}) {
  const allDatasets = await getAllDatasets(filters.includePending || false);
  
  return allDatasets.filter(dataset => {
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      const searchable = [
        dataset.title,
        dataset.description,
        dataset.keywords,
        dataset.tags
      ].join(' ').toLowerCase();
      if (!searchable.includes(searchLower)) return false;
    }
    
    if (filters.organization) {
      const orgLower = filters.organization.toLowerCase();
      const orgValue = dataset.associatedOrganization || dataset.associated_organization || dataset.owner_name_or_org || '';
      if (!orgValue.toLowerCase().includes(orgLower)) {
        return false;
      }
    }
    
    if (filters.tags) {
      const tagsLower = filters.tags.toLowerCase();
      const tagsText = Array.isArray(dataset.tags)
        ? dataset.tags.join(' ')
        : String(dataset.tags || '');
      if (!tagsText.toLowerCase().includes(tagsLower)) {
        return false;
      }
    }
    
    return true;
  });
}

// Upload Request Operations
async function createUploadRequest(userId, requestData) {
  const requestId = requestData.requestId || crypto.randomUUID();
  const requestPath = path.join(
    DATA_ROOT,
    'requests',
    'upload',
    requestId,
    'request.json'
  );
  
  const request = {
    requestId,
    userId,
    ...requestData,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  await writeJson(requestPath, request);
  
  // Add to admin queue
  await addToAdminQueue('upload_requests', requestId);
  
  return request;
}

async function saveUploadRequest(requestId, requestData) {
  const requestPath = path.join(
    DATA_ROOT,
    'requests',
    'upload',
    requestId,
    'request.json'
  );
  await writeJson(requestPath, requestData);
  return requestData;
}

// Download Request Operations
async function createDownloadRequest(userId, datasetId, requestData) {
  const requestId = crypto.randomUUID();
  const requestPath = path.join(
    DATA_ROOT,
    'requests',
    'download',
    requestId,
    'request.json'
  );
  
  const request = {
    requestId,
    userId,
    datasetId,
    ...requestData,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  await writeJson(requestPath, request);

  // Add to admin queue
  await addToAdminQueue('download_requests', requestId);
  
  return request;
}

async function saveDownloadRequest(requestId, requestData) {
  const requestPath = path.join(
    DATA_ROOT,
    'requests',
    'download',
    requestId,
    'request.json'
  );
  await writeJson(requestPath, requestData);
  return requestData;
}

// Admin Queue Operations
async function addToAdminQueue(queueType, requestId) {
  const queuePath = path.join(DATA_ROOT, 'admin', 'queues', `${queueType}_index.json`);
  
  let queue = [];
  try {
    queue = await readJson(queuePath);
  } catch (error) {
    // File doesn't exist, create new queue
  }
  
  if (!queue.includes(requestId)) {
    queue.push(requestId);
    await writeJson(queuePath, queue);
  }
}

async function getAdminQueue(queueType) {
  const queuePath = path.join(DATA_ROOT, 'admin', 'queues', `${queueType}_index.json`);
  try {
    return await readJson(queuePath);
  } catch (error) {
    return [];
  }
}

// Audit Operations
async function logAuditEvent(eventType, eventData) {
  const eventId = crypto.randomUUID();
  const eventPath = path.join(
    DATA_ROOT,
    'audit',
    eventType === 'upload' ? 'uploads' : 'downloads',
    `event_${eventId}.json`
  );
  
  const event = {
    eventId,
    eventType,
    ...eventData,
    timestamp: new Date().toISOString()
  };
  
  await writeJson(eventPath, event);
  return event;
}

// Consent Operations
async function saveConsent(userId, consentData) {
  const consentId = crypto.randomUUID();
  const consentPath = path.join(
    DATA_ROOT,
    'users',
    `user_${userId}`,
    'consents',
    `consent_${consentId}.json`
  );
  
  const consent = {
    consentId,
    userId,
    ...consentData,
    createdAt: new Date().toISOString()
  };
  
  await writeJson(consentPath, consent);
  return consent;
}

// File Operations
async function saveDatasetFile(datasetId, fileData, isSample = false) {
  const datasetDir = await resolveDatasetDir(datasetId, true);
  await ensureDir(datasetDir);
  const fileName = isSample ? datasetPaths.primarySampleZipRel() : datasetPaths.primaryFullZipRel();
  const filePath = path.join(datasetDir, fileName);
  
  // If fileData is a buffer or file path, copy it
  if (S3_PRIMARY) {
    if (typeof fileData === 'string' && fileData.startsWith('s3://')) {
      await s3Storage.copyS3UriToDataPath(fileData, filePath);
    } else if (typeof fileData === 'string') {
      await s3Storage.putDataPathFromLocalFile(filePath, fileData, 'application/zip');
    } else {
      await s3Storage.putDataPathFromBuffer(filePath, fileData, 'application/zip');
    }
  } else {
    if (typeof fileData === 'string') {
      await fs.copyFile(fileData, filePath);
    } else {
      await fs.writeFile(filePath, fileData);
    }
    await s3Storage.mirrorDataFile(filePath, 'application/zip');
  }
  
  return filePath;
}

async function getDatasetFile(datasetId, isSample = false) {
  const datasetDir = await resolveDatasetDir(datasetId);
  const candidates = isSample ? datasetPaths.sampleZipRelPaths() : datasetPaths.fullZipRelPaths();
  for (const rel of candidates) {
    const candidatePath = path.join(datasetDir, rel);
    if (await pathExists(candidatePath)) {
      return S3_PRIMARY ? s3Storage.toS3UriFromDataPath(candidatePath) : candidatePath;
    }
  }
  return null;
}

// Staging Operations
async function saveToStaging(requestId, fileData, metadata) {
  const stagingDir = path.join(DATA_ROOT, 'requests', 'upload', requestId);
  await ensureDir(stagingDir);
  
  // Save sample_data.zip only if local buffering was utilized
  if (fileData) {
    const samplePath = path.join(stagingDir, 'sample_data.zip');
    if (S3_PRIMARY) {
      if (typeof fileData === 'string') {
        await s3Storage.putDataPathFromLocalFile(samplePath, fileData, 'application/zip');
      } else {
        await s3Storage.putDataPathFromBuffer(samplePath, fileData, 'application/zip');
      }
    } else {
      if (typeof fileData === 'string') {
        await fs.copyFile(fileData, samplePath);
      } else {
        await fs.writeFile(samplePath, fileData);
      }
      await s3Storage.mirrorDataFile(samplePath, 'application/zip');
    }
  }
  
  // Save metadata
  const metadataPath = path.join(stagingDir, 'metadata.json');
  await writeJson(metadataPath, metadata);
  
  return stagingDir;
}

async function getStagingData(requestId) {
  const stagingDir = path.join(DATA_ROOT, 'requests', 'upload', requestId);
  try {
    const metadataPath = path.join(stagingDir, 'metadata.json');
    const samplePath = path.join(stagingDir, 'sample_data.zip');
    
    const metadata = await readJson(metadataPath);
    const hasSample = await pathExists(samplePath);
    const uploadedBy = metadata?.uploaded_by || metadata?.userId || '';
    
    return {
      metadata,
      uploadedBy: { userId: uploadedBy },
      hasSample,
      samplePath: hasSample ? (S3_PRIMARY ? s3Storage.toS3UriFromDataPath(samplePath) : samplePath) : null
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }
}

function getUploadLegalConfig() {
  return {
    termsVersion: LEGAL_TERMS_VERSION,
    documents: [
      {
        id: 'customer-data-consent',
        title: 'Customer Data Use and Model Training Permission Consent Form',
        url: '/legal/Customer%20Data%20Use%20and%20Model%20Training%20Permission%20Consent%20Form.pdf'
      },
      {
        id: 'ironyun-policy',
        title: 'IronYun policy on AI dataset usage for AI models training',
        url: '/legal/IronYun%20policy%20on%20AI%20dataset%20usage%20for%20AI%20models%20training.pdf'
      },
      {
        id: 'vaidio-fairness-bias',
        title: 'Vaidio AI Fairness Bias Compliance Statement',
        url: '/legal/Vaidio_AI_Fairness_Bias_Compliance%20Statement.pdf'
      }
    ]
  };
}

function splitToList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function asOptionalString(value) {
  const normalized = asString(value);
  return normalized ? normalized : undefined;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return fallback;
}

function normalizeUploadMetadata(metadata = {}, fallbackUserId = '') {
  const uploadedBy = asString(
    metadata.uploaded_by || metadata.uploadedBy || metadata.user_id || metadata.userId || fallbackUserId
  );
  const uploaderName = asString(metadata.uploader_name || metadata.uploaderName || metadata.fullName);
  const uploaderOrg = asString(metadata.uploader_org || metadata.uploaderOrg || metadata.associatedOrganization || metadata.organization);
  const contactEmail = asString(metadata.contact_email || metadata.contactEmail || metadata.uploaderEmail || metadata.email);
  const purposes = splitToList(metadata.purpose_of_collection || metadata.purposeOfCollection);
  const keywords = Array.isArray(metadata.keywords)
    ? metadata.keywords
    : splitToList(metadata.keywords || purposes.join(','));
  const accessLevel = asString(metadata.access_level || metadata.accessLevel);
  const accessPreference = asString(metadata.access_preference || metadata.accessPreference);
  const mappedAccessLevel = accessLevel || (accessPreference === 'open' ? 'Public' : accessPreference === 'request' ? 'Restricted' : '');
  const resolvedAccessLevel = mappedAccessLevel || 'Private';
  const resolvedAccessPreference = resolvedAccessLevel === 'Public' ? 'open' : 'request';
  const legacyTermsAck = normalizeBoolean(metadata.termsChecklistAck, false);
  const legacyDeclarationAck = normalizeBoolean(metadata.finalDeclarationAck, false);
  const sensitiveTypes = splitToList(metadata.sensitive_data_type || metadata.sensitiveDataType);

  return {
    ...metadata,
    uploaded_by: uploadedBy,
    title: asString(metadata.title),
    description: asString(metadata.description),
    category: asString(metadata.category) || 'Other',
    version: asString(metadata.version) || 'v1',
    keywords,
    owner_name_or_org: asString(metadata.owner_name_or_org || metadata.ownerNameOrOrg || uploaderOrg || uploaderName),
    source: asString(metadata.source) || 'User submission',
    uploader_name: asOptionalString(uploaderName),
    uploader_org: asOptionalString(uploaderOrg),
    date_created: asOptionalString(metadata.date_created || metadata.dateCreated),
    collection_period_start: asOptionalString(metadata.collection_period_start || metadata.collectionPeriodStart),
    collection_period_end: asOptionalString(metadata.collection_period_end || metadata.collectionPeriodEnd),
    funded_by: splitToList(metadata.funded_by || metadata.fundedBy || metadata.funding || metadata.funded_by_text),
    grant_or_project_id: asOptionalString(metadata.grant_or_project_id || metadata.grantOrProjectId),
    partner_institutions: splitToList(metadata.partner_institutions || metadata.partnerInstitutions),
    related_project_url: asOptionalString(metadata.related_project_url || metadata.relatedProjectUrl),
    license: asString(metadata.license) || 'Internal',
    access_level: resolvedAccessLevel,
    accessPreference: resolvedAccessPreference,
    access_preference: resolvedAccessPreference,
    allowed_users_or_teams: splitToList(metadata.allowed_users_or_teams || metadata.allowedUsersOrTeams),
    embargo_until: asOptionalString(metadata.embargo_until || metadata.embargoUntil),
    contains_sensitive_data: normalizeBoolean(metadata.contains_sensitive_data ?? metadata.containsSensitiveData, false),
    sensitive_data_type: sensitiveTypes,
    ethics_irb_reference: asOptionalString(metadata.ethics_irb_reference || metadata.ethicsIrbReference),
    contact_email: contactEmail,
    change_notes: asOptionalString(metadata.change_notes || metadata.changeNotes),
    terms_and_conditions_accept: normalizeBoolean(
      metadata.terms_and_conditions_accept ?? metadata.termsAndConditionsAccept ?? legacyTermsAck,
      legacyTermsAck
    ),
    rights_confirmation_accept: normalizeBoolean(
      metadata.rights_confirmation_accept ?? metadata.rightsConfirmationAccept ?? legacyDeclarationAck,
      legacyDeclarationAck
    ),
    privacy_compliance_accept: normalizeBoolean(
      metadata.privacy_compliance_accept ?? metadata.privacyComplianceAccept ?? legacyTermsAck,
      legacyTermsAck
    ),
    terms_version_accepted: asString(metadata.terms_version_accepted || metadata.termsVersionAccepted || LEGAL_TERMS_VERSION),
  };
}

function isValidDateString(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

// Validation Functions
async function validateUploadRequest(metadata, filePath) {
  const normalized = normalizeUploadMetadata(metadata, metadata.uploaded_by || metadata.uploadedBy || '');
  const errors = [];
  const warnings = [];
  const schemaValid = validateUploadRequestSchema(normalized);
  if (!schemaValid) {
    errors.push(...formatAjvErrors(validateUploadRequestSchema.errors));
  }

  if (normalized.terms_version_accepted !== LEGAL_TERMS_VERSION) {
    errors.push(`terms_version_accepted must be "${LEGAL_TERMS_VERSION}".`);
  }

  if (normalized.description && normalized.description.split(/\s+/).filter(Boolean).length < 5) {
    errors.push('description: must contain at least 5 words.');
  }

  const dateFields = [
    ['date_created', normalized.date_created],
    ['collection_period_start', normalized.collection_period_start],
    ['collection_period_end', normalized.collection_period_end],
    ['embargo_until', normalized.embargo_until],
  ];

  for (const [field, value] of dateFields) {
    if (!isValidDateString(value)) {
      errors.push(`Invalid date format for ${field}. Expected YYYY-MM-DD.`);
    }
  }

  if (normalized.collection_period_start && normalized.collection_period_end) {
    if (normalized.collection_period_start > normalized.collection_period_end) {
      errors.push('collection_period_start cannot be after collection_period_end.');
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  if (normalized.date_created && normalized.date_created > todayIso) {
    errors.push('date_created cannot be in the future.');
  }

  if (normalized.embargo_until && normalized.embargo_until <= todayIso) {
    warnings.push('Embargo date is in the past or today; embargo may have no effect.');
  }

  if (!normalized.keywords || normalized.keywords.length < 1) {
    warnings.push('Consider adding at least one keyword for better discoverability.');
  }

  // File validation
  if (filePath) {
    if (typeof filePath === 'string' && (filePath.startsWith('http') || filePath.startsWith('s3://'))) {
      // S3 Streamed File - assume multer already validated constraints implicitly
    } else {
      try {
        const stats = await fs.stat(filePath);
        if (stats.size > MAX_SAMPLE_SIZE_BYTES) {
          errors.push(`Sample file exceeds maximum size of ${formatBytes(MAX_SAMPLE_SIZE_BYTES)}.`);
        }
        if (stats.size === 0) {
          errors.push('Sample file is empty');
        }
      } catch (error) {
        errors.push('Cannot access sample file');
      }
    }
  } else {
    errors.push('Sample file is required');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    normalizedMetadata: normalized
  };
}

// Review Operations
async function createReview(requestType, requestId, reviewData) {
  const reviewId = crypto.randomUUID();
  const reviewPath = path.join(
    DATA_ROOT,
    'requests',
    requestType,
    requestId,
    'review.json'
  );
  
  const review = {
    reviewId,
    requestId,
    requestType,
    ...reviewData,
    reviewedAt: new Date().toISOString()
  };
  
  await writeJson(reviewPath, review);
  return review;
}

async function getReview(requestType, requestId) {
  const reviewPath = path.join(DATA_ROOT, 'requests', requestType, requestId, 'review.json');
  try {
    return await readJson(reviewPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') throw error;
  }
  return null;
}

// Request Approval/Rejection
async function approveUploadRequest(requestId, adminNotes = '', reviewerId = 'admin') {
  const request = await getUploadRequest(requestId);
  if (!request) {
    throw new Error('Upload request not found');
  }
  if (request.status === 'approved' && request.datasetId) {
    const existingDataset = await getDataset(request.datasetId);
    return { request, dataset: existingDataset };
  }
  const userId = request.userId;
  
  // Get staging data (may be missing for older requests created before ID alignment fix)
  const stagingData = await getStagingData(requestId);
  const datasetMetadata = stagingData?.metadata || request.metadata;
  if (!datasetMetadata) {
    throw new Error('No dataset metadata found for this upload request');
  }
  
  // Create dataset from available metadata source
  const dataset = await createDataset({
    ...datasetMetadata,
    status: 'pending_full_upload'
  });
  const datasetId = dataset.datasetId || dataset.dataset_id;
  if (!datasetId) {
    throw new Error('Created dataset is missing an ID');
  }
  
  // Move sample file to dataset
  if (stagingData.samplePath) {
    await saveDatasetFile(datasetId, stagingData.samplePath, true);
  }
  
  // Update request status
  request.status = 'approved';
  request.approvedAt = new Date().toISOString();
  request.datasetId = datasetId;
  request.adminNotes = adminNotes;
  request.reviewerId = reviewerId || request.reviewerId || 'admin';
  
  const finalRequestPath = path.join(DATA_ROOT, 'requests', 'upload', requestId, 'request.json');
  await writeJson(finalRequestPath, request);

  await upsertUserUploadRecord(userId, datasetId, {
    datasetId,
    requestId,
    status: request.status,
    approvedAt: request.approvedAt,
    title: datasetMetadata.title || '',
    description: datasetMetadata.description || '',
    sampleAvailable: Boolean(stagingData?.samplePath)
  });
  
  // Remove from admin queue
  await removeFromAdminQueue('upload_requests', requestId);
  
  // Create review record
  await createReview('upload', requestId, {
    status: 'approved',
    adminNotes,
    reviewerId: reviewerId || 'admin'
  });
  
  return { request, dataset };
}

async function rejectUploadRequest(requestId, reason, adminNotes = '', reviewerId = 'admin') {
  const request = await getUploadRequest(requestId);
  if (!request) {
    throw new Error('Upload request not found');
  }
  const userId = request.userId;
  
  request.status = 'rejected';
  request.rejectedAt = new Date().toISOString();
  request.rejectionReason = reason;
  request.adminNotes = adminNotes;
  request.reviewerId = reviewerId || request.reviewerId || 'admin';
  
  const finalRequestPath = path.join(DATA_ROOT, 'requests', 'upload', requestId, 'request.json');
  await writeJson(finalRequestPath, request);
  
  // Remove from admin queue
  await removeFromAdminQueue('upload_requests', requestId);
  
  // Create review record
  await createReview('upload', requestId, {
    status: 'rejected',
    reason,
    adminNotes,
    reviewerId: reviewerId || 'admin'
  });
  
  return request;
}

async function approveDownloadRequest(requestId, adminNotes = '', reviewerId = 'admin') {
  const request = await getDownloadRequest(requestId);
  if (!request) {
    throw new Error('Download request not found');
  }
  const userId = request.userId;
  
  request.status = 'approved';
  request.approvedAt = new Date().toISOString();
  request.adminNotes = adminNotes;
  request.reviewerId = reviewerId || request.reviewerId || 'admin';
  
  const finalRequestPath = path.join(DATA_ROOT, 'requests', 'download', requestId, 'request.json');
  await writeJson(finalRequestPath, request);
  await upsertUserDownloadRecord(userId, requestId, request);
  
  // Remove from admin queue
  await removeFromAdminQueue('download_requests', requestId);
  
  // Create review record
  await createReview('download', requestId, {
    status: 'approved',
    adminNotes,
    reviewerId: reviewerId || 'admin'
  });
  
  return request;
}

async function rejectDownloadRequest(requestId, reason, adminNotes = '', reviewerId = 'admin') {
  const request = await getDownloadRequest(requestId);
  if (!request) {
    throw new Error('Download request not found');
  }
  const userId = request.userId;
  
  request.status = 'rejected';
  request.rejectedAt = new Date().toISOString();
  request.rejectionReason = reason;
  request.adminNotes = adminNotes;
  request.reviewerId = reviewerId || request.reviewerId || 'admin';
  
  const finalRequestPath = path.join(DATA_ROOT, 'requests', 'download', requestId, 'request.json');
  await writeJson(finalRequestPath, request);
  await upsertUserDownloadRecord(userId, requestId, request);
  
  // Remove from admin queue
  await removeFromAdminQueue('download_requests', requestId);
  
  // Create review record
  await createReview('download', requestId, {
    status: 'rejected',
    reason,
    adminNotes,
    reviewerId: reviewerId || 'admin'
  });
  
  return request;
}

async function removeFromAdminQueue(queueType, requestId) {
  const queuePath = path.join(DATA_ROOT, 'admin', 'queues', `${queueType}_index.json`);
  
  try {
    let queue = await readJson(queuePath);
    queue = queue.filter(id => id !== requestId);
    await writeJson(queuePath, queue);
  } catch (error) {
    // Queue might not exist, that's okay
  }
}

async function getUploadRequest(requestId) {
  const requestPath = path.join(DATA_ROOT, 'requests', 'upload', requestId, 'request.json');
  try {
    return await readJson(requestPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function getDownloadRequest(requestId) {
  const requestPath = path.join(DATA_ROOT, 'requests', 'download', requestId, 'request.json');
  try {
    return await readJson(requestPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function getAllRequests(requestType = 'upload') {
  const type = requestType === 'download' ? 'download' : 'upload';
  const requestsDir = path.join(DATA_ROOT, 'requests', type);
  let requestDirs = [];
  try {
    requestDirs = await readDir(requestsDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return [];
    throw error;
  }

  const results = [];
  for (const reqId of requestDirs) {
    try {
      const reqPath = path.join(requestsDir, reqId, 'request.json');
      const request = await readJson(reqPath);
      if (request) results.push(request);
    } catch { /* ignore */ }
  }
  return results;
}

async function findUploadRequestByDatasetId(datasetId) {
  const uploadRequestsDir = path.join(DATA_ROOT, 'requests', 'upload');
  let requestDirs = [];
  try {
    requestDirs = await readDir(uploadRequestsDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }

  for (const requestId of requestDirs) {
    try {
      const reqPath = path.join(uploadRequestsDir, requestId, 'request.json');
      const request = await readJson(reqPath);
      if (String(request.datasetId || '').toLowerCase() === String(datasetId).toLowerCase()) {
        return request;
      }
    } catch (e) {}
  }
  return null;
}

async function saveMultipartUploadSession(datasetId, session) {
  const datasetDir = await resolveDatasetDir(datasetId, true);
  const sessionPath = path.join(datasetDir, 'multipart_upload.json');
  await writeJson(sessionPath, session);
  return session;
}

async function getMultipartUploadSession(datasetId) {
  const datasetDir = await resolveDatasetDir(datasetId, false);
  const sessionPath = path.join(datasetDir, 'multipart_upload.json');
  try {
    return await readJson(sessionPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function clearMultipartUploadSession(datasetId) {
  const datasetDir = await resolveDatasetDir(datasetId, false);
  const sessionPath = path.join(datasetDir, 'multipart_upload.json');
  try {
    await fs.unlink(sessionPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') throw error;
  }
}

async function saveMultipartSampleSession(requestId, session) {
  const stagingDir = path.join(DATA_ROOT, 'requests', 'upload', requestId);
  await ensureDir(stagingDir);
  const sessionPath = path.join(stagingDir, 'multipart_upload.json');
  await writeJson(sessionPath, session);
  return session;
}

async function getMultipartSampleSession(requestId) {
  const stagingDir = path.join(DATA_ROOT, 'requests', 'upload', requestId);
  const sessionPath = path.join(stagingDir, 'multipart_upload.json');
  try {
    return await readJson(sessionPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function clearMultipartSampleSession(requestId) {
  const stagingDir = path.join(DATA_ROOT, 'requests', 'upload', requestId);
  const sessionPath = path.join(stagingDir, 'multipart_upload.json');
  try {
    await fs.unlink(sessionPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') throw error;
  }
}

async function uploadFullDataset(datasetId, fileData) {
  await saveDatasetFile(datasetId, fileData, false);
  
  // Update dataset status
  const dataset = await getDataset(datasetId);
  if (dataset) {
    dataset.fullDatasetUploaded = true;
    dataset.fullDatasetUploadedAt = new Date().toISOString();
    const datasetDir = await resolveDatasetDir(datasetId, true);
    const datasetPath = path.join(datasetDir, 'dataset.json');
    await writeJson(datasetPath, dataset);
  }
  
  return dataset;
}



// Get all user profiles (for admin user management)
async function getAllUsers() {
  const usersDir = path.join(DATA_ROOT, 'users');
  let userDirs = [];
  try {
    userDirs = await readDir(usersDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') return [];
    throw error;
  }

  const users = [];
  for (const dir of userDirs) {
    if (!dir.startsWith('user_')) continue;
    const profilePath = path.join(usersDir, dir, 'profile.json');
    try {
      const profile = await readJson(profilePath);
      // Never expose passwordHash
      const { passwordHash, ...safeProfile } = profile;
      users.push(safeProfile);
    } catch {
      // Ignore unreadable profiles
    }
  }
  return users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Delete a user's local profile directory
async function deleteUser(userId) {
  const userDir = path.join(DATA_ROOT, 'users', `user_${userId}`);
  if (S3_PRIMARY) {
    // In S3 primary mode we can only delete the profile.json; full directory cleanup is out of scope
    const profilePath = path.join(userDir, 'profile.json');
    try {
      await s3Storage.deleteDataPath(profilePath);
    } catch { /* ignore if already gone */ }
    return true;
  }
  try {
    await fs.rm(userDir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'NoSuchKey') throw error;
  }
  return true;
}

async function getUserDashboardData(userId) {
  const uploadRequests = [];
  const downloadRequests = [];
  const datasets = [];

  // 1. Get All Upload Requests for this user
  try {
    const uploadRequestsDir = path.join(DATA_ROOT, 'requests', 'upload');
    const requestDirs = await readDir(uploadRequestsDir);
    for (const reqId of requestDirs) {
      try {
        const reqPath = path.join(uploadRequestsDir, reqId, 'request.json');
        const request = await readJson(reqPath);
        if (request.userId === userId) {
          const messages = await getMessages(request.requestId || reqId, 'upload');
          const lastMessage = messages.length ? messages[messages.length - 1] : null;
          uploadRequests.push(toSnakeCase({ ...request, lastMessage }));
        }
      } catch (e) {}
    }
  } catch (e) {}

  // 2. Get All Download Requests for this user
  try {
    const downloadRequestsDir = path.join(DATA_ROOT, 'requests', 'download');
    const requestDirs = await readDir(downloadRequestsDir);
    for (const reqId of requestDirs) {
      try {
        const reqPath = path.join(downloadRequestsDir, reqId, 'request.json');
        const request = await readJson(reqPath);
        if (request.userId === userId) {
          const snaked = toSnakeCase(request);
          // Enrich with dataset title
          try {
            const ds = await getDataset(request.datasetId);
            snaked.dataset_title = ds?.title || null;
          } catch (_) {}
          try {
            const messages = await getMessages(request.requestId || reqId, 'download');
            snaked.last_message = messages.length ? messages[messages.length - 1] : null;
          } catch (_) {}
          downloadRequests.push(snaked);
        }
      } catch (e) {}
    }
  } catch (e) {}

  // 3. Get Datasets uploaded by this user
  try {
    const allDatasets = await getAllDatasets(true); // include pending full upload
    for (const ds of allDatasets) {
      // Check for ownership (stored in system_metadata or metadata)
      if (ds.system_metadata?.uploaded_by_user_id === userId || ds.uploader_id === userId) {
        datasets.push(ds);
      }
    }
  } catch (e) {}

  return { 
    upload_requests: uploadRequests, 
    download_requests: downloadRequests, 
    datasets 
  };
}

async function hasApprovedDownloadAccess(userId, datasetId) {
  try {
    const logPath = path.join(DATA_ROOT, 'users', userId, 'activity_log.json');
    if (!(await pathExists(logPath))) {
      console.log(`[debug] No activity log for user ${userId}`);
      return false;
    }
    
    const log = await readJson(logPath);
    for (const entry of log) {
      if (entry.type === 'download_request' && entry.record) {
        const rDatasetId = entry.record.datasetId || entry.record.dataset_id;
        const rStatus = entry.record.status;
        
        if (String(rDatasetId).toLowerCase() === String(datasetId).toLowerCase() && rStatus === 'approved') {
          console.log(`[debug] Found approved request in activity log for user=${userId}, dataset=${datasetId}`);
          return true;
        }
      }
    }
    console.log(`[debug] No approved request found for user=${userId}, dataset=${datasetId} in log of size ${log.length}`);
  } catch (e) {
    console.error('Error in hasApprovedDownloadAccess:', e);
  }
  return false;
}

async function updateUploadRequestStatus(requestId, status) {
  const requestsDir = path.join(DATA_ROOT, 'requests', 'upload');
  const reqPath = path.join(requestsDir, requestId, 'request.json');
  if (!(await pathExists(reqPath))) return;
  const request = await readJson(reqPath);
  request.status = status;
  await writeJson(reqPath, request);
  return toSnakeCase(request);
}

async function updateDatasetStatus(datasetId, status) {
  const datasetDir = await resolveDatasetDir(datasetId, false);
  const metadataPath = path.join(datasetDir, 'metadata.json');
  const dataset = await readJson(metadataPath);
  dataset.status = status;
  await writeJson(metadataPath, dataset);
  return toSnakeCase(dataset);
}

async function saveDatasetPipelineExecution(datasetId, pipelineInfo) {
  const datasetDir = await resolveDatasetDir(datasetId, false);
  const metadataPath = path.join(datasetDir, 'metadata.json');
  const dataset = await readJson(metadataPath);
  dataset.pipeline = {
    ...(dataset.pipeline || {}),
    ...pipelineInfo,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(metadataPath, dataset);
  return toSnakeCase(dataset);
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Messages (Clarification Threads)
// ─────────────────────────────────────────────────────────────────────────────
async function getMessages(requestId, type = 'upload') {
  const messagesPath = path.join(DATA_ROOT, 'requests', type, requestId, 'messages.json');
  try {
    const data = await readJson(messagesPath);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return []; // No messages yet
  }
}

async function appendMessage(requestId, type = 'upload', messageData) {
  const messages = await getMessages(requestId, type);
  const newMessage = {
    id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
    timestamp: new Date().toISOString(),
    sender: messageData.sender,           // 'admin' or userId
    senderLabel: messageData.senderLabel, // 'Admin' or user's name
    text: messageData.text
  };
  messages.push(newMessage);
  
  const messagesPath = path.join(DATA_ROOT, 'requests', type, requestId, 'messages.json');
  await writeJson(messagesPath, messages);
  return newMessage;
}

module.exports = {
  updateDatasetStatus,
  saveDatasetPipelineExecution,
  updateUploadRequestStatus,
  hasApprovedDownloadAccess,
  createUser,
  getUser,
  getUserByEmail,
  updateUserProfile,
  upsertUserProfile,
  setUserAdminById,
  setUserAdminByEmail,
  getAllUsers,
  deleteUser,
  setUserPasswordHashById,
  setUserPasswordHashByEmail,
  createDataset,
  getDataset,
  getAllDatasets,
  searchDatasets,
  getUserDashboardData,
  createUploadRequest,
  createDownloadRequest,
  getUploadRequest,
  saveUploadRequest,
  getDownloadRequest,
  getAllRequests,
  saveDownloadRequest,
  findUploadRequestByDatasetId,
  saveMultipartUploadSession,
  getMultipartUploadSession,
  clearMultipartUploadSession,
  saveMultipartSampleSession,
  getMultipartSampleSession,
  clearMultipartSampleSession,
  getAdminQueue,
  addToAdminQueue,
  logAuditEvent,
  saveConsent,
  saveDatasetFile,
  getDatasetFile,
  saveToStaging,
  getStagingData,
  getUploadLegalConfig,
  normalizeUploadMetadata,
  validateUploadRequest,
  createReview,
  getReview,
  approveUploadRequest,
  rejectUploadRequest,
  approveDownloadRequest,
  rejectDownloadRequest,
  uploadFullDataset,
  ensureDir,
  DATA_ROOT,
  getMessages,
  appendMessage
};
