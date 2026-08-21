const path = require("path");

function resolveOptionalPath(value) {
  return value ? path.resolve(value) : null;
}

function getVideoDataPaths(environment = process.env, backendDirectory = __dirname) {
  const dataRoot = resolveOptionalPath(environment.TRAFFIC_VIDEO_DATA_ROOT);
  return {
    dataRoot,
    jobsRoot:
      resolveOptionalPath(environment.TRAFFIC_VIDEO_JOBS_ROOT) ||
      (dataRoot ? path.join(dataRoot, "jobs") : path.join(backendDirectory, "data", "video_jobs")),
    sourcesRoot:
      resolveOptionalPath(environment.TRAFFIC_VIDEO_SOURCES_ROOT) ||
      (dataRoot
        ? path.join(dataRoot, "sources")
        : path.join(backendDirectory, "uploads", "videos")),
    stagingRoot:
      resolveOptionalPath(environment.TRAFFIC_VIDEO_STAGING_ROOT) ||
      (dataRoot ? path.join(dataRoot, "staging") : path.join(backendDirectory, "uploads")),
  };
}

module.exports = {
  getVideoDataPaths,
};
