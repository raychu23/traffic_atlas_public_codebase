const { execFile } = require("child_process");

const MAX_VIDEO_DURATION_SECONDS = 8 * 60 * 60;

function getFfprobePath(explicitPath) {
  return explicitPath || process.env.FFPROBE_PATH || "ffprobe";
}

function execFileJson(command, args, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message =
          error.code === "ENOENT"
            ? `ffprobe was not found at "${command}". Install ffmpeg or set FFPROBE_PATH to the ffprobe binary.`
            : stderr
              ? `${error.message}: ${stderr}`
              : error.message;
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`Unable to parse ${command} output: ${parseError.message}`));
      }
    });
  });
}

async function getVideoMetadata(filePath, { execFileImpl, ffprobePath } = {}) {
  const payload = await execFileJson(
    getFfprobePath(ffprobePath),
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    execFileImpl,
  );
  const durationSeconds = Number(payload?.format?.duration);
  const videoStream = (payload?.streams || []).find(
    (stream) => Number(stream?.width) > 0 && Number(stream?.height) > 0,
  );
  const width = Number(videoStream?.width);
  const height = Number(videoStream?.height);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Unable to determine video duration.");
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Unable to determine video dimensions.");
  }
  return { durationSeconds, width, height };
}

function assertAllowedDuration(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Unable to determine video duration.");
  }
  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error("Video duration must be 8 hours or shorter.");
  }
}

function chooseFrameTimestamps(durationSeconds) {
  const safeDuration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
  if (safeDuration <= 0) return [];
  if (safeDuration < 10) {
    const lastTimestamp = Math.max(1, safeDuration - 1);
    return Array.from({ length: lastTimestamp }, (_, index) => index + 1);
  }

  const frameCount = Math.min(50, Math.max(10, Math.floor(safeDuration / 60)));
  const lastTimestamp = Math.max(1, Math.floor(durationSeconds) - 1);
  const step = (lastTimestamp - 1) / Math.max(1, frameCount - 1);
  const timestamps = [1];

  for (let index = 1; index < frameCount; index += 1) {
    const timestamp = Math.max(1, Math.floor(1 + step * index));
    if (timestamp < durationSeconds && timestamps[timestamps.length - 1] !== timestamp) {
      timestamps.push(timestamp);
    }
  }

  return timestamps;
}

module.exports = {
  MAX_VIDEO_DURATION_SECONDS,
  assertAllowedDuration,
  chooseFrameTimestamps,
  getVideoMetadata,
  getFfprobePath,
};
