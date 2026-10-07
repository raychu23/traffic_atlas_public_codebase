const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

const ARTIFACT_FILES = {
  tracks: ["output/tracks.csv", "tracks.csv"],
  annotated: ["output/annotated.mp4", "annotated.mp4"],
  counts: ["output/movement_counts.csv", "movement_counts.csv"],
  trajectories: ["trajectory_preview.json", "trajectory_preview.json"],
  zones: ["zones.json", "zones.json"],
  zonesGeoJson: ["zones.geojson", "zones.geojson"],
};

const DIRECT_ARTIFACT_FILES = [
  ["tracks", "output/tracks.csv", "output/tracks.csv", "text/csv"],
  ["counts", "output/movement_counts.csv", "output/movement_counts.csv", "text/csv"],
  ["trajectories", "trajectory_preview.json", "output/trajectory_preview.json", "application/json"],
  ["zones", "zones.geojson", "zones/zones.geojson", "application/geo+json"],
];

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
let client;

function isCloudMode() {
  return process.env.TRAFFIC_PROCESSOR_MODE === "s3-lambda-ec2";
}

function getConfig() {
  const bucket = process.env.TRAFFIC_VIDEO_BUCKET || process.env.S3_BUCKET || "";
  const prefix = String(process.env.TRAFFIC_VIDEO_S3_PREFIX || "traffic-video-jobs").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!bucket) throw new Error("s3-lambda-ec2 mode requires TRAFFIC_VIDEO_BUCKET");
  return {
    bucket,
    prefix,
    region: REGION,
    binSeconds: Number(process.env.TRAFFIC_COUNT_BIN_SECONDS || 900),
  };
}

function getClient() {
  if (!client) client = new S3Client({ region: REGION });
  return client;
}

function setClientForTests(nextClient) {
  client = nextClient;
}

function jobPrefix(videoId, config = getConfig()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(videoId || ""))) throw new Error("Invalid video ID");
  return `${config.prefix}/${videoId}`;
}

async function putObject(key, body, contentType, contentLength) {
  const config = getConfig();
  const input = {
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: "AES256",
  };
  // The current AWS SDK transport cannot infer the decoded length of a Node
  // file stream. Supplying it avoids an invalid x-amz-decoded-content-length
  // header and lets failed HTTP requests be retried safely.
  if (Number.isFinite(contentLength)) input.ContentLength = contentLength;
  await getClient().send(new PutObjectCommand(input));
}

async function uploadFile(key, filePath, contentType) {
  const info = await fsPromises.stat(filePath);
  if (info.size > MULTIPART_UPLOAD_THRESHOLD_BYTES) {
    const config = getConfig();
    const upload = new Upload({
      client: getClient(),
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      },
      queueSize: 3,
      partSize: MULTIPART_UPLOAD_THRESHOLD_BYTES,
      leavePartsOnError: false,
    });
    await upload.done();
    return;
  }
  await putObject(key, fs.createReadStream(filePath), contentType, info.size);
}

async function persistJobState(job, config = getConfig()) {
  const prefix = jobPrefix(job.videoId, config);
  const { sourceVideoPath, ...portableJob } = job;
  await putObject(
    `${prefix}/state.json`,
    JSON.stringify({
      ...portableJob,
      inputKey: `${prefix}/input/video${path.extname(sourceVideoPath) || ".mp4"}`,
    }),
    "application/json",
  );
}

async function persistDirectJobArtifacts(job, jobDir, outputDir, { includeInput = true } = {}) {
  const config = getConfig();
  const prefix = jobPrefix(job.videoId, config);
  const uploaded = {};
  if (includeInput) {
    const extension = path.extname(job.sourceVideoPath).toLowerCase() || ".mp4";
    await uploadFile(
      `${prefix}/input/video${extension}`,
      job.sourceVideoPath,
      job.contentType || "video/mp4",
    );
    uploaded.input = true;
  }
  for (const [name, localRelative, destinationRelative, contentType] of DIRECT_ARTIFACT_FILES) {
    const localPath = localRelative.startsWith("output/")
      ? path.join(outputDir, path.basename(localRelative))
      : path.join(jobDir, localRelative);
    try {
      await fsPromises.access(localPath);
      await uploadFile(`${prefix}/${destinationRelative}`, localPath, contentType);
      uploaded[name] = true;
    } catch (error) {
      if (error.code === "ENOENT") uploaded[name] = false;
      else throw error;
    }
  }
  await persistJobState(job, config);
  return { prefix, uploaded };
}

async function enqueueTracking(job) {
  const config = getConfig();
  const prefix = jobPrefix(job.videoId, config);
  const extension = path.extname(job.sourceVideoPath).toLowerCase() || ".mp4";
  const inputKey = `${prefix}/input/video${extension}`;
  const outputPrefix = `${prefix}/output`;
  const stateKey = `${prefix}/state.json`;
  const manifestKey = `${prefix}/control/track.json`;
  const createdAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    action: "track",
    videoId: job.videoId,
    userId: job.userId,
    bucket: config.bucket,
    inputKey,
    outputPrefix,
    width: Number(job.width),
    height: Number(job.height),
    binSeconds: config.binSeconds,
  };
  await uploadFile(inputKey, job.sourceVideoPath, job.contentType || "video/mp4");
  await putObject(
    stateKey,
    JSON.stringify({
      ...manifest,
      status: "queued",
      countsStatus: "awaiting_tracks",
      createdAt,
      updatedAt: createdAt,
    }),
    "application/json",
  );
  // This is written last: its S3 event is the GPU wake-up signal.
  await putObject(manifestKey, JSON.stringify(manifest), "application/json");
  return { inputKey, outputPrefix, stateKey, manifestKey };
}

async function enqueueRecount(job, zonesPath) {
  const config = getConfig();
  const prefix = jobPrefix(job.videoId, config);
  const zonesKey = `${prefix}/input/zones.geojson`;
  const manifestKey = `${prefix}/control/recount-${Date.now()}.json`;
  const manifest = {
    schemaVersion: 1,
    action: "recount",
    videoId: job.videoId,
    userId: job.userId,
    bucket: config.bucket,
    zonesKey,
    outputPrefix: `${prefix}/output`,
    binSeconds: config.binSeconds,
  };
  await uploadFile(zonesKey, zonesPath, "application/geo+json");
  await putObject(manifestKey, JSON.stringify(manifest), "application/json");
  return { zonesKey, manifestKey };
}

async function getObjectJson(key) {
  const config = getConfig();
  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    return JSON.parse(Buffer.from(await response.Body.transformToByteArray()).toString("utf8"));
  } catch (error) {
    if (["NoSuchKey", "NotFound"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404)
      return null;
    throw error;
  }
}

async function getCloudJob(videoId) {
  return getObjectJson(`${jobPrefix(videoId)}/state.json`);
}

async function streamToFile(body, destination) {
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  await fsPromises.writeFile(destination, Buffer.from(await body.transformToByteArray()));
}

async function downloadArtifacts(videoId, jobDir, outputDir) {
  const config = getConfig();
  const prefix = jobPrefix(videoId, config);
  const downloaded = {};
  for (const [name, [relative, sourceName]] of Object.entries(ARTIFACT_FILES)) {
    const destination = relative.startsWith("output/")
      ? path.join(outputDir, path.basename(relative))
      : path.join(jobDir, relative);
    try {
      const response = await getClient().send(
        new GetObjectCommand({ Bucket: config.bucket, Key: `${prefix}/output/${sourceName}` }),
      );
      await streamToFile(response.Body, destination);
      downloaded[name] = true;
    } catch (error) {
      if (
        ["NoSuchKey", "NotFound"].includes(error?.name) ||
        error?.$metadata?.httpStatusCode === 404
      )
        downloaded[name] = false;
      else throw error;
    }
  }
  return downloaded;
}

async function markBackendSynchronized() {
  // S3 state is authoritative. The API keeps its synchronization timestamp locally.
}

module.exports = {
  ARTIFACT_FILES,
  downloadArtifacts,
  enqueueRecount,
  enqueueTracking,
  getCloudJob,
  getConfig,
  isCloudMode,
  jobPrefix,
  markBackendSynchronized,
  persistDirectJobArtifacts,
  persistJobState,
  setClientForTests,
};
