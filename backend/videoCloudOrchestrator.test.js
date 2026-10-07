const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

process.env.TRAFFIC_PROCESSOR_MODE = "sqs-ec2";
process.env.TRAFFIC_VIDEO_BUCKET = "traffic-video-test";
process.env.TRAFFIC_VIDEO_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/video.fifo";
process.env.TRAFFIC_VIDEO_JOBS_TABLE = "traffic-video-jobs-test";
process.env.TRAFFIC_VIDEO_S3_PREFIX = "traffic-video-jobs";

const {
  downloadArtifacts,
  enqueueRecount,
  enqueueTracking,
  getCloudJob,
  getConfig,
  jobPrefix,
  setClientsForTests,
} = require("./videoCloudOrchestrator");

function fakeClients(responses = {}) {
  const calls = [];
  const client = (name) => ({
    async send(command) {
      calls.push({ name, command: command.constructor.name, input: command.input });
      return responses[command.constructor.name] || {};
    },
  });
  return {
    calls,
    clients: {
      s3: client("s3"),
      sqs: client("sqs"),
      dynamodb: client("dynamodb"),
    },
  };
}

test("cloud configuration requires durable storage, queue, and job table", () => {
  const config = getConfig();
  assert.equal(config.bucket, "traffic-video-test");
  assert.equal(config.tableName, "traffic-video-jobs-test");
  assert.equal(
    jobPrefix("11111111-1111-4111-8111-111111111111", config),
    "traffic-video-jobs/11111111-1111-4111-8111-111111111111",
  );
});

test("tracking upload persists the job before sending a FIFO work message", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-cloud-job-"));
  const source = path.join(root, "traffic.mp4");
  await fs.writeFile(source, "video");
  const { calls, clients } = fakeClients();
  setClientsForTests(clients);
  const videoId = crypto.randomUUID();
  await enqueueTracking({
    videoId,
    userId: "user-1",
    sourceVideoPath: source,
    fileName: "traffic.mp4",
    contentType: "video/mp4",
    width: 1280,
    height: 960,
    durationSeconds: 60,
    createdAt: "2026-07-24T00:00:00.000Z",
  });
  assert.deepEqual(
    calls.map((call) => call.command),
    ["PutObjectCommand", "PutCommand", "SendMessageCommand"],
  );
  const message = calls.at(-1).input;
  assert.equal(message.MessageGroupId, videoId);
  assert.equal(JSON.parse(message.MessageBody).action, "track");
  assert.equal(JSON.parse(message.MessageBody).bucket, "traffic-video-test");
  await fs.rm(root, { recursive: true, force: true });
});

test("zone edits upload GeoJSON and enqueue recount without retracking", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-cloud-zone-"));
  const zonesPath = path.join(root, "zones.geojson");
  await fs.writeFile(zonesPath, '{"type":"FeatureCollection","features":[]}');
  const { calls, clients } = fakeClients();
  setClientsForTests(clients);
  const videoId = crypto.randomUUID();
  await enqueueRecount({ videoId, userId: "user-1" }, zonesPath);
  assert.deepEqual(
    calls.map((call) => call.command),
    ["PutObjectCommand", "UpdateCommand", "SendMessageCommand"],
  );
  assert.equal(JSON.parse(calls.at(-1).input.MessageBody).action, "recount");
  await fs.rm(root, { recursive: true, force: true });
});

test("cloud status and artifacts are read through AWS boundaries", async () => {
  const body = {
    async transformToByteArray() {
      return Buffer.from("artifact");
    },
  };
  const { clients } = fakeClients({
    GetCommand: { Item: { videoId: "11111111-1111-4111-8111-111111111111", status: "ready" } },
    GetObjectCommand: { Body: body },
  });
  setClientsForTests(clients);
  const job = await getCloudJob("11111111-1111-4111-8111-111111111111");
  assert.equal(job.status, "ready");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-cloud-artifacts-"));
  const result = await downloadArtifacts(
    "11111111-1111-4111-8111-111111111111",
    root,
    path.join(root, "output"),
  );
  assert.equal(result.tracks, true);
  assert.equal(await fs.readFile(path.join(root, "output", "tracks.csv"), "utf8"), "artifact");
  await fs.rm(root, { recursive: true, force: true });
});
