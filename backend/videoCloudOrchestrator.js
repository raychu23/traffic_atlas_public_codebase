const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const ARTIFACT_FILES = {
  tracks: ["output/tracks.csv", "tracks.csv"],
  annotated: ["output/annotated.mp4", "annotated.mp4"],
  counts: ["output/movement_counts.csv", "movement_counts.csv"],
  trajectories: ["trajectory_preview.json", "trajectory_preview.json"],
  zones: ["zones.json", "zones.json"],
  zonesGeoJson: ["zones.geojson", "zones.geojson"],
};

let clients;

function isCloudMode() {
  return process.env.TRAFFIC_PROCESSOR_MODE === "sqs-ec2";
}

function getConfig() {
  const config = {
    region: REGION,
    bucket: process.env.TRAFFIC_VIDEO_BUCKET || "",
    queueUrl: process.env.TRAFFIC_VIDEO_QUEUE_URL || "",
    tableName: process.env.TRAFFIC_VIDEO_JOBS_TABLE || "",
    prefix: String(process.env.TRAFFIC_VIDEO_S3_PREFIX || "traffic-video-jobs").replace(
      /^\/+|\/+$/g,
      "",
    ),
    binSeconds: Number(process.env.TRAFFIC_COUNT_BIN_SECONDS || 900),
    ttlDays: Number(process.env.TRAFFIC_VIDEO_JOB_TTL_DAYS || 30),
  };
  if (!config.bucket || !config.queueUrl || !config.tableName) {
    throw new Error(
      "sqs-ec2 mode requires TRAFFIC_VIDEO_BUCKET, TRAFFIC_VIDEO_QUEUE_URL, and TRAFFIC_VIDEO_JOBS_TABLE",
    );
  }
  if (!Number.isFinite(config.binSeconds) || config.binSeconds <= 0) {
    throw new Error("TRAFFIC_COUNT_BIN_SECONDS must be a positive number");
  }
  if (!Number.isFinite(config.ttlDays) || config.ttlDays <= 0) {
    throw new Error("TRAFFIC_VIDEO_JOB_TTL_DAYS must be a positive number");
  }
  return config;
}

function getClients() {
  if (!clients) {
    const s3 = new S3Client({ region: REGION });
    const sqs = new SQSClient({ region: REGION });
    const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    clients = { s3, sqs, dynamodb };
  }
  return clients;
}

function setClientsForTests(nextClients) {
  clients = nextClients;
}

function jobPrefix(videoId, config = getConfig()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(videoId || ""))) {
    throw new Error("Invalid video ID");
  }
  return `${config.prefix}/${videoId}`;
}

async function uploadFile(bucket, key, filePath, contentType) {
  const { s3 } = getClients();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || "application/octet-stream",
      ServerSideEncryption: "AES256",
    }),
  );
}

async function enqueueTracking(job) {
  const config = getConfig();
  const { sqs, dynamodb } = getClients();
  const prefix = jobPrefix(job.videoId, config);
  const extension = path.extname(job.sourceVideoPath).toLowerCase() || ".mp4";
  const inputKey = `${prefix}/input/video${extension}`;
  const createdAt = new Date().toISOString();

  await uploadFile(config.bucket, inputKey, job.sourceVideoPath, job.contentType);
  await dynamodb.send(
    new PutCommand({
      TableName: config.tableName,
      Item: {
        videoId: job.videoId,
        userId: job.userId,
        status: "queued",
        countsStatus: "awaiting_tracks",
        inputKey,
        outputPrefix: `${prefix}/output`,
        fileName: job.fileName,
        width: Number(job.width),
        height: Number(job.height),
        durationSeconds: Number(job.durationSeconds),
        createdAt: job.createdAt || createdAt,
        updatedAt: createdAt,
        expiresAt: Math.floor(Date.now() / 1000) + config.ttlDays * 86400,
      },
    }),
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queueUrl,
      MessageGroupId: job.videoId,
      MessageDeduplicationId: `track-${job.videoId}-${Date.now()}`,
      MessageBody: JSON.stringify({
        schemaVersion: 1,
        action: "track",
        videoId: job.videoId,
        userId: job.userId,
        bucket: config.bucket,
        inputKey,
        outputPrefix: `${prefix}/output`,
        width: Number(job.width),
        height: Number(job.height),
        binSeconds: config.binSeconds,
      }),
    }),
  );
  return { inputKey, outputPrefix: `${prefix}/output` };
}

async function enqueueRecount(job, zonesPath) {
  const config = getConfig();
  const { sqs, dynamodb } = getClients();
  const prefix = jobPrefix(job.videoId, config);
  const zonesKey = `${prefix}/input/zones.geojson`;
  const requestedAt = new Date().toISOString();
  await uploadFile(config.bucket, zonesKey, zonesPath, "application/geo+json");
  await dynamodb.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { videoId: job.videoId },
      UpdateExpression:
        "SET countsStatus = :countsStatus, zonesKey = :zonesKey, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":countsStatus": "queued",
        ":zonesKey": zonesKey,
        ":updatedAt": requestedAt,
      },
    }),
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queueUrl,
      MessageGroupId: job.videoId,
      MessageDeduplicationId: `recount-${job.videoId}-${Date.now()}`,
      MessageBody: JSON.stringify({
        schemaVersion: 1,
        action: "recount",
        videoId: job.videoId,
        userId: job.userId,
        bucket: config.bucket,
        zonesKey,
        outputPrefix: `${prefix}/output`,
        binSeconds: config.binSeconds,
      }),
    }),
  );
}

async function getCloudJob(videoId) {
  const config = getConfig();
  const { dynamodb } = getClients();
  const response = await dynamodb.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { videoId },
      ConsistentRead: true,
    }),
  );
  return response.Item || null;
}

async function streamToFile(body, destination) {
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const bytes = await body.transformToByteArray();
  await fsPromises.writeFile(temporary, bytes);
  await fsPromises.rename(temporary, destination);
}

async function downloadObjectIfPresent(bucket, key, destination) {
  const { s3 } = getClients();
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await streamToFile(response.Body, destination);
    return true;
  } catch (error) {
    if (
      error?.name === "NoSuchKey" ||
      error?.name === "NotFound" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw error;
  }
}

async function downloadArtifacts(videoId, jobDir, outputDir) {
  const config = getConfig();
  const prefix = jobPrefix(videoId, config);
  const downloaded = {};
  for (const [name, [destinationRelative, sourceName]] of Object.entries(ARTIFACT_FILES)) {
    const destination = destinationRelative.startsWith("output/")
      ? path.join(outputDir, path.basename(destinationRelative))
      : path.join(jobDir, destinationRelative);
    if (name !== "counts") {
      try {
        await fsPromises.access(destination);
        downloaded[name] = true;
        continue;
      } catch {
        // Download immutable tracking artifacts only when they are not cached locally.
      }
    }
    downloaded[name] = await downloadObjectIfPresent(
      config.bucket,
      `${prefix}/output/${sourceName}`,
      destination,
    );
  }
  return downloaded;
}

async function markBackendSynchronized(videoId) {
  const config = getConfig();
  const { dynamodb } = getClients();
  await dynamodb.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { videoId },
      UpdateExpression: "SET backendSynchronizedAt = :now",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    }),
  );
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
  setClientsForTests,
};
