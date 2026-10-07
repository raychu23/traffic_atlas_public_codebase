const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(os.tmpdir(), `traffic-cloud-sync-${process.pid}`);
process.env.TRAFFIC_VIDEO_JOBS_ROOT = root;
process.env.TRAFFIC_PROCESSOR_MODE = "s3-lambda-ec2";
process.env.TRAFFIC_VIDEO_BUCKET = "test-bucket";
const jobs = require("./videoJobs");
const cloud = require("./videoS3OnDemand");

test.after(() => fs.rm(root, { recursive: true, force: true }));

test("cloud recount status preserves edited polygons and original reset suggestions", async () => {
  const videoId = crypto.randomUUID();
  const original = [
    {
      id: "west",
      label: "West",
      color: "#00847c",
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 30 },
      ],
    },
  ];
  const edited = [
    {
      ...original[0],
      points: [
        { x: 5, y: 5 },
        { x: 35, y: 5 },
        { x: 35, y: 45 },
      ],
    },
  ];
  let state = { status: "ready", countsStatus: "ready", updatedAt: "initial" };
  cloud.setClientForTests({
    async send(command) {
      if (command.constructor.name !== "GetObjectCommand") {
        command.input.Body?.destroy?.();
        return {};
      }
      const key = command.input.Key;
      let value;
      if (key.endsWith("/state.json")) value = JSON.stringify(state);
      else if (key.endsWith("/zones.json")) value = JSON.stringify(original);
      else if (key.endsWith("/tracks.csv")) value = "track_id,cx,cy\n1,5,5\n1,90,90\n";
      else if (key.endsWith("/movement_counts.csv")) value = "class,count\ncar,1\n";
      else {
        const error = new Error("missing");
        error.name = "NoSuchKey";
        throw error;
      }
      return { Body: { transformToByteArray: async () => Buffer.from(value) } };
    },
  });
  await jobs.createVideoJob({
    videoId,
    userId: "owner",
    sourceVideoPath: "/tmp/input.mp4",
    width: 100,
    height: 100,
  });
  const initial = await jobs.getPublicVideoJob(videoId, "owner");
  assert.deepEqual(initial.zones, original);
  const saved = await jobs.saveZones(videoId, "owner", edited);
  assert.deepEqual(saved.zones, edited);
  state = { ...state, countsStatus: "calculating", updatedAt: "recount-start" };
  const calculating = await jobs.getPublicVideoJob(videoId, "owner");
  assert.deepEqual(calculating.zones, edited);
  state = { ...state, countsStatus: "ready", updatedAt: "recount-complete" };
  const ready = await jobs.getPublicVideoJob(videoId, "owner");
  assert.deepEqual(ready.zones, edited);
  assert.deepEqual(ready.suggestedZones, original);
  assert.equal(ready.countsStatus, "ready");
});
