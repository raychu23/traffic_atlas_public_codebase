const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { registerVideoRoutes } = require("./videoRoutes");
const configuredPool = process.env.COGNITO_USER_POOL_ID;
delete process.env.COGNITO_USER_POOL_ID;
const { requireAuth } = require("./auth");
if (configuredPool !== undefined) process.env.COGNITO_USER_POOL_ID = configuredPool;

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-routes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    sourcesRoot: path.join(root, "sources"),
    stagingRoot: path.join(root, "staging"),
  };
  const jobs = new Map();
  const started = [];
  const audits = [];
  const app = express();
  app.use(express.json());
  const owner = "video-owner";
  const token = jwt.sign({ sub: owner }, "test-fixture");
  const assertOwner = (job, userId) => {
    if (job.userId !== userId) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
  };
  const videoJobs = {
    recoverInterruptedVideoJobs: async () => 0,
    createVideoJob: async (job) => jobs.set(job.videoId, job),
    removeVideoJob: async (id) => jobs.delete(id),
    savePreview: async () => {},
    startVideoProcessing: async (id) => started.push(id),
    getVideoJob: async (id) => jobs.get(id),
    assertJobOwner: assertOwner,
    getPublicVideoJob: async (id, userId) => {
      const job = jobs.get(id);
      assertOwner(job, userId);
      return job;
    },
    ...overrides.videoJobs,
  };
  const ready = registerVideoRoutes(app, {
    // The existing auth middleware is used unchanged. The repository's
    // unconfigured-Cognito fallback accepts this local test fixture token.
    requireAuth,
    paths,
    environment: {},
    dataStorage: { logAuditEvent: async (...event) => audits.push(event) },
    validateTrafficVideo: async () => ({
      durationSeconds: 60,
      width: 1280,
      height: 960,
      sampledFrameCount: 3,
      trafficScene: { confidence: "high", isTrafficCameraFootage: true },
    }),
    extractVideoFrames: async () => {
      const frameDir = await fs.mkdtemp(path.join(root, "preview-"));
      const framePath = path.join(frameDir, "frame.jpg");
      await fs.writeFile(framePath, "preview");
      return { frameDir, framePaths: [framePath] };
    },
    verifyVideoTooling: async () => ({ ok: true, versions: {} }),
    ...overrides,
    videoJobs,
  });
  app.get("/api/datasets", (req, res) => res.json({ datasets: ["unchanged"] }));
  await ready;
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.on("error", reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (endpoint, options = {}) =>
    fetch(baseUrl + endpoint, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
  const upload = (name = "intersection.mp4", bytes = "video", options = {}) => {
    const form = new FormData();
    form.append("videoFile", new Blob([bytes], { type: "video/mp4" }), name);
    return request("/api/videos/validate-upload", { method: "POST", body: form, ...options });
  };
  return { root, paths, jobs, started, audits, request, upload, videoJobs };
}

async function assertClean(f) {
  // Failure cleanup follows the HTTP response in the route's finally block.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const staging = await fs.readdir(f.paths.stagingRoot);
    const sources = await fs.readdir(f.paths.sourcesRoot);
    if (!staging.length && !sources.length && !f.jobs.size) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Rejected video left staged input, accepted input, or partial job state");
}

test("video upload retains metadata, source, audit and starts one processing job", async (t) => {
  const f = await fixture(t);
  const response = await f.upload();
  assert.equal(response.status, 200);
  const { video } = await response.json();
  assert.equal(video.status, "queued");
  assert.equal(video.durationSeconds, 60);
  assert.deepEqual(f.started, [video.videoId]);
  const job = f.jobs.get(video.videoId);
  assert.equal(await fs.readFile(job.sourceVideoPath, "utf8"), "video");
  assert.equal(f.audits[0][1].videoId, video.videoId);
  assert.deepEqual(await fs.readdir(f.paths.stagingRoot), []);
  assert.equal(
    (await fs.readdir(f.root)).some((name) => name.startsWith("preview-")),
    false,
  );
  assert.equal((await f.request(`/api/videos/${video.videoId}`)).status, 200);
  const otherToken = jwt.sign({ sub: "another-user" }, "test-fixture");
  assert.equal(
    (
      await f.request(`/api/videos/${video.videoId}`, {
        headers: { Authorization: `Bearer ${otherToken}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(`/api/videos/${video.videoId}/process`, {
        method: "POST",
        headers: { Authorization: `Bearer ${otherToken}` },
      })
    ).status,
    403,
  );
  assert.equal(f.started.length, 1);
});

test("unauthenticated uploads are rejected before receiving files", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.upload("clip.mp4", "video", {
        headers: { Authorization: "" },
      })
    ).status,
    401,
  );
  await assertClean(f);
});

test("video multipart failures are scoped to video routes", async (t) => {
  const f = await fixture(t, { environment: { MAX_VIDEO_UPLOAD_BYTES: "8" } });
  assert.equal((await f.upload("wrong.txt")).status, 400);
  assert.equal((await f.upload("clip.mp4", "too many bytes")).status, 413);
  const missing = await f.request("/api/videos/validate-upload", { method: "POST" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "Video file is required");
  await assertClean(f);
  assert.deepEqual(await (await f.request("/api/datasets")).json(), { datasets: ["unchanged"] });
});

test("traffic validation failure cleans up staged input", async (t) => {
  const f = await fixture(t, {
    validateTrafficVideo: async () => {
      throw Object.assign(new Error("Not roadway footage"), { code: "NOT_TRAFFIC_CAMERA_FOOTAGE" });
    },
  });
  assert.equal((await f.upload()).status, 422);
  await assertClean(f);
  assert.deepEqual(f.started, []);
});

test("preview failure cleans up the accepted source and partially created job", async (t) => {
  const f = await fixture(t, {
    videoJobs: {
      savePreview: async () => {
        throw new Error("preview storage failed");
      },
    },
  });
  assert.equal((await f.upload()).status, 500);
  await assertClean(f);
  assert.deepEqual(f.started, []);
});

test("invalid video configuration leaves dataset routes available", async (t) => {
  const f = await fixture(t, { environment: { MAX_VIDEO_UPLOAD_BYTES: "invalid" } });
  assert.equal((await f.upload()).status, 503);
  assert.equal((await f.request("/api/datasets")).status, 200);
});

test("unwritable video storage leaves dataset routes available", async (t) => {
  const f = await fixture(t, {
    paths: { sourcesRoot: "/dev/null/video", stagingRoot: "/dev/null/staging" },
  });
  assert.equal((await f.upload()).status, 503);
  assert.equal((await f.request("/api/datasets")).status, 200);
});
