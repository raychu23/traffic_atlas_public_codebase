const { execFile } = require("child_process");
const { getFfmpegPath } = require("./frameExtractor");
const { getFfprobePath } = require("./videoMetadata");

function runVersion(command, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl(command, ["-version"], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error });
        return;
      }
      resolve({ ok: true, version: String(stdout || "").split("\n")[0] });
    });
  });
}

async function verifyVideoTooling({ execFileImpl, ffmpegPath, ffprobePath } = {}) {
  const checks = [
    { name: "ffmpeg", command: getFfmpegPath(ffmpegPath), envVar: "FFMPEG_PATH" },
    { name: "ffprobe", command: getFfprobePath(ffprobePath), envVar: "FFPROBE_PATH" },
  ];
  const missingTools = [];
  const versions = {};

  for (const check of checks) {
    const result = await runVersion(check.command, execFileImpl);
    if (result.ok) {
      versions[check.name] = result.version;
    } else {
      missingTools.push({
        name: check.name,
        command: check.command,
        envVar: check.envVar,
        error: result.error.message,
      });
    }
  }

  if (missingTools.length > 0) {
    return {
      ok: false,
      versions,
      missingTools,
      message:
        "Video upload validation requires ffmpeg and ffprobe. Install ffmpeg, or set " +
        missingTools.map((tool) => tool.envVar).join(" and ") +
        " to absolute binary paths.",
    };
  }

  return {
    ok: true,
    versions,
    missingTools: [],
    message: "Video upload validation tooling is available.",
  };
}

module.exports = { verifyVideoTooling };
