const { execFile } = require("child_process");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");

function getFfmpegPath(explicitPath) {
  return explicitPath || process.env.FFMPEG_PATH || "ffmpeg";
}

function runFfmpeg(args, execFileImpl = execFile, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const command = getFfmpegPath(ffmpegPath);
    execFileImpl(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        const message =
          error.code === "ENOENT"
            ? `ffmpeg was not found at "${command}". Install ffmpeg or set FFMPEG_PATH to the ffmpeg binary.`
            : "Could not extract preview frames from this video. The file may be too short, corrupted, or encoded in an unsupported way. Please upload a standard MP4 or MOV traffic video with a clear roadway, intersection, or traffic-camera view.";
        reject(new Error(message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function extractVideoFrames(
  filePath,
  timestamps,
  { execFileImpl, tmpRoot, ffmpegPath } = {},
) {
  const frameDir = await fsPromises.mkdtemp(
    path.join(tmpRoot || os.tmpdir(), "traffic-video-frames-"),
  );
  const framePaths = [];

  try {
    for (let index = 0; index < timestamps.length; index += 1) {
      const framePath = path.join(frameDir, `frame-${String(index + 1).padStart(3, "0")}.jpg`);
      await runFfmpeg(
        [
          "-y",
          "-ss",
          String(timestamps[index]),
          "-i",
          filePath,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(768,iw)':-2",
          "-q:v",
          "4",
          framePath,
        ],
        execFileImpl,
        ffmpegPath,
      );
      framePaths.push(framePath);
    }
    return { frameDir, framePaths };
  } catch (error) {
    await fsPromises.rm(frameDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { extractVideoFrames, getFfmpegPath };
