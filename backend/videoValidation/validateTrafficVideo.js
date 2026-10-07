const fsPromises = require("fs/promises");
const {
  assertAllowedDuration,
  chooseFrameTimestamps,
  getVideoMetadata,
} = require("./videoMetadata");
const { extractVideoFrames } = require("./frameExtractor");
const { checkTrafficSceneWithOpenAI } = require("./trafficSceneChecker");

async function validateTrafficVideo(filePath, options = {}) {
  const metadata = await getVideoMetadata(filePath, options);
  assertAllowedDuration(metadata.durationSeconds);

  const timestamps = chooseFrameTimestamps(metadata.durationSeconds);
  const { frameDir, framePaths } = await extractVideoFrames(filePath, timestamps, options);

  try {
    const scene = await checkTrafficSceneWithOpenAI({
      framePaths,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      model: options.model,
    });

    if (!scene.isTrafficCameraFootage) {
      const error = new Error(
        scene.explanation || "This video does not appear to be traffic-camera footage.",
      );
      error.code = "NOT_TRAFFIC_CAMERA_FOOTAGE";
      error.scene = scene;
      throw error;
    }

    return {
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      sampledFrameCount: framePaths.length,
      trafficScene: scene,
    };
  } finally {
    await fsPromises.rm(frameDir, { recursive: true, force: true });
  }
}

module.exports = { validateTrafficVideo };
