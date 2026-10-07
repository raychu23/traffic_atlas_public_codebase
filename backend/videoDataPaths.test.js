const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { getVideoDataPaths } = require("./videoDataPaths");

test("video data root keeps durable jobs and sources outside the application checkout", () => {
  const paths = getVideoDataPaths(
    { TRAFFIC_VIDEO_DATA_ROOT: "/var/lib/traffic-atlas/video" },
    "/opt/traffic-atlas/current/backend",
  );

  assert.deepEqual(paths, {
    dataRoot: "/var/lib/traffic-atlas/video",
    jobsRoot: "/var/lib/traffic-atlas/video/jobs",
    sourcesRoot: "/var/lib/traffic-atlas/video/sources",
    stagingRoot: "/var/lib/traffic-atlas/video/staging",
  });
});

test("explicit path overrides remain supported", () => {
  const paths = getVideoDataPaths(
    {
      TRAFFIC_VIDEO_DATA_ROOT: "/var/lib/traffic-atlas/video",
      TRAFFIC_VIDEO_JOBS_ROOT: "/mnt/jobs",
      TRAFFIC_VIDEO_SOURCES_ROOT: "/mnt/sources",
      TRAFFIC_VIDEO_STAGING_ROOT: "/mnt/staging",
    },
    "/opt/traffic-atlas/current/backend",
  );

  assert.equal(paths.jobsRoot, "/mnt/jobs");
  assert.equal(paths.sourcesRoot, "/mnt/sources");
  assert.equal(paths.stagingRoot, "/mnt/staging");
});

test("local defaults preserve the existing repository layout", () => {
  const backendDirectory = path.resolve("/workspace/traffic-atlas/backend");
  const paths = getVideoDataPaths({}, backendDirectory);

  assert.equal(paths.jobsRoot, path.join(backendDirectory, "data", "video_jobs"));
  assert.equal(paths.sourcesRoot, path.join(backendDirectory, "uploads", "videos"));
  assert.equal(paths.stagingRoot, path.join(backendDirectory, "uploads"));
});
