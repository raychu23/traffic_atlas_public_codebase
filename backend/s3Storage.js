const fs = require("fs");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const DATA_ROOT = path.join(__dirname, "data");
const BUCKET = process.env.S3_BUCKET;
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const PREFIX = (process.env.S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
const STORAGE_BACKEND = String(process.env.STORAGE_BACKEND || "").toLowerCase();
const S3_ENDPOINT =
  process.env.S3_ENDPOINT ||
  process.env.AWS_ENDPOINT_URL_S3 ||
  process.env.AWS_ENDPOINT_URL;
const S3_FORCE_PATH_STYLE = ["1", "true", "yes"].includes(
  String(process.env.S3_FORCE_PATH_STYLE || "").toLowerCase(),
);

let client = null;

function isEnabled() {
  return Boolean(BUCKET);
}

function isPrimaryMode() {
  return isEnabled() && STORAGE_BACKEND === "s3";
}

function getClientConfig() {
  const config = { region: REGION };
  if (S3_ENDPOINT) {
    config.endpoint = S3_ENDPOINT;
  }
  if (S3_FORCE_PATH_STYLE) {
    config.forcePathStyle = true;
  }
  return config;
}

function getClient() {
  if (!client) {
    client = new S3Client(getClientConfig());
  }
  return client;
}

function toS3KeyFromDataPath(filePath) {
  // Normalize both to handle Windows case-insensitivity and slashes
  const normRoot = path.resolve(DATA_ROOT).toLowerCase();
  const normPath = path.resolve(filePath).toLowerCase();

  let relative = path.relative(normRoot, normPath);

  // If path.relative failed to produce a relative path (e.g. wrong root case),
  // fallback to a manual string replace
  if (path.isAbsolute(relative)) {
    // This happens if the drive letters don't match exactly in string comparison
    const rootSearch = normRoot.endsWith(path.sep)
      ? normRoot
      : normRoot + path.sep;
    if (normPath.startsWith(rootSearch)) {
      relative = normPath.slice(rootSearch.length);
    }
  }

  return (PREFIX ? `${PREFIX}/${relative}` : relative).replace(/\\/g, "/");
}

async function mirrorDataFile(
  filePath,
  contentType = "application/octet-stream",
) {
  if (!isEnabled() || isPrimaryMode()) return;
  const key = toS3KeyFromDataPath(filePath);
  const body = fs.createReadStream(filePath);
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

function toS3UriFromDataPath(filePath) {
  return `s3://${toS3KeyFromDataPath(filePath)}`;
}

function keyFromS3Uri(s3Uri) {
  let key = String(s3Uri).replace(/^s3:\/\//, "");
  // Support both s3://<key> and s3://<bucket>/<key> URI styles.
  if (BUCKET && key.startsWith(`${BUCKET}/`)) {
    key = key.slice(BUCKET.length + 1);
  }
  return key;
}

function dataPathFromKey(key) {
  const normalizedKey = String(key || "");
  let relative = normalizedKey;
  if (PREFIX && relative.startsWith(`${PREFIX}/`)) {
    relative = relative.slice(PREFIX.length + 1);
  }
  return path.join(DATA_ROOT, relative);
}

function getDatasetFullKey(datasetId) {
  const datasetPaths = require("./datasetPaths");
  const relativePath = `datasets/${datasetId}/${datasetPaths.primaryFullZipRel()}`;
  return PREFIX ? `${PREFIX}/${relativePath}` : relativePath;
}

async function createMultipartUpload({
  datasetId,
  key,
  contentType,
  metadata,
}) {
  if (!isEnabled()) throw new Error("S3 is not configured");
  const resolvedKey = key || getDatasetFullKey(datasetId);
  const resp = await getClient().send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: resolvedKey,
      ContentType: contentType || "application/octet-stream",
      Metadata: metadata || {},
    }),
  );
  return { uploadId: resp.UploadId, key: resolvedKey, bucket: BUCKET };
}

async function getMultipartPartUrl({
  key,
  uploadId,
  partNumber,
  expiresIn = 3600,
}) {
  if (!isEnabled()) throw new Error("S3 is not configured");
  const command = new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}

function isMultipartUploadNotFoundError(error) {
  const name = String(error?.name || error?.Code || "");
  const message = String(error?.message || "");
  return (
    name === "NoSuchUpload" || /specified upload does not exist/i.test(message)
  );
}

async function objectExists(key) {
  if (!isEnabled()) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (
      status === 404 ||
      error?.name === "NotFound" ||
      error?.name === "NoSuchKey"
    ) {
      return false;
    }
    throw error;
  }
}

async function listMultipartParts({ key, uploadId }) {
  if (!isEnabled()) throw new Error("S3 is not configured");
  const resp = await getClient().send(
    new ListPartsCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
    }),
  );
  return resp.Parts || [];
}

async function completeMultipartUpload({ key, uploadId, parts }) {
  if (!isEnabled()) throw new Error("S3 is not configured");
  return getClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
}

async function abortMultipartUpload({ key, uploadId }) {
  if (!isEnabled()) throw new Error("S3 is not configured");
  return getClient().send(
    new AbortMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
    }),
  );
}

async function putDataPathFromBuffer(
  filePath,
  buffer,
  contentType = "application/octet-stream",
) {
  if (!isEnabled())
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials.");
  const key = toS3KeyFromDataPath(filePath);
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

async function putDataPathFromText(filePath, text, contentType = "text/plain") {
  const body = Buffer.from(String(text || ""), "utf8");
  await putDataPathFromBuffer(filePath, body, contentType);
}

async function putDataPathFromLocalFile(
  filePath,
  localPath,
  contentType = "application/octet-stream",
) {
  if (!isEnabled())
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials.");
  const key = toS3KeyFromDataPath(filePath);
  const body = fs.createReadStream(localPath);
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function getDataPathAsBuffer(filePath) {
  const key = toS3KeyFromDataPath(filePath);
  const response = await getClient().send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
  );
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function getDataPathAsText(filePath) {
  const buffer = await getDataPathAsBuffer(filePath);
  return buffer.toString("utf8");
}

/** Read object body as UTF-8 text by S3 key (not data/ relative path). */
async function getObjectTextByKey(key) {
  if (!isEnabled()) {
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials.");
  }
  const response = await getClient().send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key.replace(/^\/+/, ""),
    }),
  );
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read object body as raw bytes by S3 key. */
async function getObjectBufferByKey(key) {
  if (!isEnabled()) {
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials.");
  }
  const response = await getClient().send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key.replace(/^\/+/, ""),
    }),
  );
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function existsDataPath(filePath) {
  const key = toS3KeyFromDataPath(filePath);
  try {
    await getClient().send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch (error) {
    return false;
  }
}

/** List all object keys under a prefix (recursive, paginated). */
async function listObjectKeysByPrefix(prefix) {
  if (!isEnabled()) {
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials.");
  }
  const normalizedPrefix = String(prefix || "").replace(/^\/+/, "");
  const keys = [];
  let continuationToken;
  do {
    const response = await getClient().send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of response.Contents || []) {
      if (item.Key && !item.Key.endsWith("/")) {
        keys.push(item.Key);
      }
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return keys;
}

async function listDirNames(dataDirPath) {
  const prefixBase = toS3KeyFromDataPath(dataDirPath).replace(/\/+$/, "");
  const prefix = `${prefixBase}/`;
  const response = await getClient().send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      Delimiter: "/",
    }),
  );

  const names = new Set();

  for (const cp of response.CommonPrefixes || []) {
    const child = cp.Prefix.slice(prefix.length).replace(/\/$/, "");
    if (child) names.add(child);
  }

  for (const item of response.Contents || []) {
    const tail = item.Key.slice(prefix.length);
    if (!tail) continue;
    const first = tail.split("/")[0];
    if (first) names.add(first);
  }

  return [...names];
}

async function copyS3UriToDataPath(sourceS3Uri, targetDataPath) {
  const sourceKey = keyFromS3Uri(sourceS3Uri);
  const targetKey = toS3KeyFromDataPath(targetDataPath);
  await getClient().send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${sourceKey}`,
      Key: targetKey,
    }),
  );
}

function safeDownloadFilename(downloadName) {
  const base = String(downloadName || "download.bin")
    .replace(/["\r\n]/g, "")
    .replace(/[^\w.\-()+ ]/g, "_")
    .trim();
  return base || "download.zip";
}

async function getSignedDownloadUrl(
  s3Uri,
  downloadName = "download.bin",
  expiresIn = 3600,
) {
  if (!isEnabled()) throw new Error("S3 is not configured");
  const key = keyFromS3Uri(s3Uri);
  if (!key) {
    throw new Error("Invalid S3 URI for download");
  }
  const safeName = safeDownloadFilename(downloadName);
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}

async function listS3Contents(prefix = "") {
  if (!isEnabled()) {
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials.");
  }

  const normalizedPrefix = String(prefix || "").replace(/^\/+/, "");
  const basePrefix = PREFIX
    ? `${PREFIX}/${normalizedPrefix}`
    : normalizedPrefix;
  const prefixWithSlash =
    basePrefix && !basePrefix.endsWith("/") ? `${basePrefix}/` : basePrefix;

  const resp = await getClient().send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefixWithSlash,
      Delimiter: "/",
    }),
  );

  const folders = (resp.CommonPrefixes || []).map((item) => item.Prefix);
  const files = (resp.Contents || [])
    .map((item) => item.Key)
    .filter((key) => key !== prefixWithSlash);

  return {
    bucket: BUCKET,
    prefix: prefixWithSlash || "",
    folders,
    files,
  };
}

module.exports = {
  isEnabled,
  isPrimaryMode,
  getClient,
  getClientConfig,
  mirrorDataFile,
  listS3Contents,
  toS3KeyFromDataPath,
  toS3UriFromDataPath,
  dataPathFromKey,
  putDataPathFromBuffer,
  putDataPathFromText,
  putDataPathFromLocalFile,
  getDataPathAsBuffer,
  getDataPathAsText,
  getObjectTextByKey,
  getObjectBufferByKey,
  listObjectKeysByPrefix,
  existsDataPath,
  listDirNames,
  copyS3UriToDataPath,
  getSignedDownloadUrl,
  getDatasetFullKey,
  objectExists,
  isMultipartUploadNotFoundError,
  createMultipartUpload,
  getMultipartPartUrl,
  listMultipartParts,
  completeMultipartUpload,
  abortMultipartUpload,
};
