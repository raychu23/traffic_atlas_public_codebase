const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

process.env.TRAFFIC_PROCESSOR_MODE = "s3-lambda-ec2";
process.env.TRAFFIC_VIDEO_BUCKET = "traffic-video-test";
process.env.TRAFFIC_VIDEO_S3_PREFIX = "traffic-video-jobs";

const {
  enqueueRecount,
  enqueueTracking,
  persistDirectJobArtifacts,
  setClientForTests,
} = require("./videoS3OnDemand");

test("S3-only tracking writes the input, state, then wake-up manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-s3-job-"));
  const source = path.join(root, "traffic.mp4");
  await fs.writeFile(source, "video");
  const calls = [];
  setClientForTests({
    async send(command) {
      calls.push(command);
      return {};
    },
  });
  const videoId = crypto.randomUUID();
  const result = await enqueueTracking({
    videoId,
    userId: "user-1",
    sourceVideoPath: source,
    contentType: "video/mp4",
    width: 1280,
    height: 960,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].input.Key, /input\/video\.mp4$/);
  assert.equal(calls[0].input.ContentLength, 5);
  assert.match(calls[1].input.Key, /state\.json$/);
  assert.match(calls[2].input.Key, /control\/track\.json$/);
  assert.equal(result.manifestKey, calls[2].input.Key);
  await fs.rm(root, { recursive: true, force: true });
});

test("S3-only recount uploads zones before the wake-up manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-s3-recount-"));
  const zonesPath = path.join(root, "zones.geojson");
  await fs.writeFile(zonesPath, '{"type":"FeatureCollection","features":[]}');
  const calls = [];
  setClientForTests({
    async send(command) {
      calls.push(command);
      return {};
    },
  });
  const result = await enqueueRecount(
    { videoId: crypto.randomUUID(), userId: "user-1" },
    zonesPath,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].input.Key, /input\/zones\.geojson$/);
  assert.equal(calls[0].input.ContentLength, 42);
  assert.match(calls[1].input.Key, /control\/recount-\d+\.json$/);
  assert.equal(result.manifestKey, calls[1].input.Key);
  await fs.rm(root, { recursive: true, force: true });
});

test("direct EC2 jobs persist one portable S3 job folder without a wake-up manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-s3-direct-job-"));
  const output = path.join(root, "output");
  const source = path.join(root, "traffic.mp4");
  await fs.mkdir(output);
  await fs.writeFile(source, "video");
  await fs.writeFile(path.join(output, "tracks.csv"), "tracks");
  await fs.writeFile(path.join(output, "movement_counts.csv"), "counts");
  await fs.writeFile(path.join(root, "trajectory_preview.json"), "[]");
  await fs.writeFile(
    path.join(root, "zones.geojson"),
    '{"type":"FeatureCollection","features":[]}',
  );
  const calls = [];
  setClientForTests({
    async send(command) {
      calls.push(command);
      return {};
    },
  });
  const videoId = crypto.randomUUID();
  const result = await persistDirectJobArtifacts(
    { videoId, sourceVideoPath: source, contentType: "video/mp4", status: "ready" },
    root,
    output,
  );
  assert.equal(result.uploaded.input, true);
  assert.deepEqual(
    calls.map((call) => call.input.Key),
    [
      `traffic-video-jobs/${videoId}/input/video.mp4`,
      `traffic-video-jobs/${videoId}/output/tracks.csv`,
      `traffic-video-jobs/${videoId}/output/movement_counts.csv`,
      `traffic-video-jobs/${videoId}/output/trajectory_preview.json`,
      `traffic-video-jobs/${videoId}/zones/zones.geojson`,
      `traffic-video-jobs/${videoId}/state.json`,
    ],
  );
  assert.equal(
    calls.some((call) => call.input.Key.includes("/control/")),
    false,
  );
  await fs.rm(root, { recursive: true, force: true });
});
