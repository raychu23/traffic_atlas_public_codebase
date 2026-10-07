const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fsPromises = require("fs/promises");
const { getVideoDataPaths } = require("./videoDataPaths");
const { getVideoUploadErrorResponse } = require("./videoValidation/uploadErrors");

function registerVideoRoutes(
  app,
  {
    requireAuth,
    dataStorage,
    environment = process.env,
    paths = getVideoDataPaths(environment, __dirname),
    videoJobs = require("./videoJobs"),
    validateTrafficVideo = require("./videoValidation/validateTrafficVideo").validateTrafficVideo,
    extractVideoFrames = require("./videoValidation/frameExtractor").extractVideoFrames,
    verifyVideoTooling = require("./videoValidation/tooling").verifyVideoTooling,
  },
) {
  const router = express.Router();
  const { sourcesRoot: acceptedVideosDir, stagingRoot: videoStagingDir } = paths;
  const maxUploadBytes = Number(environment.MAX_VIDEO_UPLOAD_BYTES || 10 * 1024 ** 3);
  let initializationError;
  const ready = initialize().catch((error) => {
    initializationError = error;
    console.warn("Video upload initialization failed:", error.message);
  });

  async function initialize() {
    if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
      throw new Error("MAX_VIDEO_UPLOAD_BYTES must be a positive integer");
    }
    await fsPromises.mkdir(acceptedVideosDir, { recursive: true });
    await fsPromises.mkdir(videoStagingDir, { recursive: true });
    const entries = await fsPromises.readdir(videoStagingDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith("video-"))
        .map((entry) => cleanupTempUpload(path.join(videoStagingDir, entry.name))),
    );
    const recovered = await videoJobs.recoverInterruptedVideoJobs();
    if (recovered > 0) {
      console.warn(
        `Marked ${recovered} interrupted video job(s) as failed so they can be retried.`,
      );
    }
    verifyVideoTooling()
      .then((result) => {
        if (result.ok) {
          console.log("Video upload validation tooling available:", result.versions);
        } else {
          console.warn(result.message);
          result.missingTools.forEach((tool) => {
            console.warn(
              `Missing ${tool.name}: tried "${tool.command}". Set ${tool.envVar} if needed.`,
            );
          });
        }
      })
      .catch((error) => {
        console.warn("Unable to verify video upload validation tooling:", error.message);
      });
  }

  router.use(requireAuth);
  router.use(async (req, res, next) => {
    await ready;
    if (initializationError) {
      return res.status(503).json({
        success: false,
        error: "Video processing is temporarily unavailable.",
      });
    }
    next();
  });

  const videoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, videoStagingDir),
      filename: (req, file, cb) => {
        cb(null, `video-${crypto.randomUUID()}${path.extname(file.originalname)}`);
      },
    }),
    limits: { fileSize: Number.isSafeInteger(maxUploadBytes) ? maxUploadBytes : 0 },
    fileFilter: (req, file, callback) => {
      if (!/\.(mp4|mov|avi|mkv|webm|wmv)$/i.test(file.originalname)) {
        const error = new Error(
          "Unsupported video format. Upload MP4, MOV, AVI, MKV, WebM, or WMV.",
        );
        error.statusCode = 400;
        return callback(error);
      }
      callback(null, true);
    },
  }).single("videoFile");

  function receiveVideo(req, res, next) {
    videoUpload(req, res, (error) => {
      if (!error) return next();
      const status =
        error.code === "LIMIT_FILE_SIZE"
          ? 413
          : error.code === "LIMIT_UNEXPECTED_FILE"
            ? 400
            : error.statusCode || 500;
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? `Video exceeds the upload limit of ${maxUploadBytes} bytes.`
          : error.code === "LIMIT_UNEXPECTED_FILE"
            ? "Unexpected video upload field."
            : status === 500
              ? "Unable to receive the video upload."
              : error.message;
      res.status(status).json({ success: false, error: message });
    });
  }

  async function cleanupTempUpload(filePath) {
    if (!filePath) return;
    try {
      await fsPromises.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("Unable to clean up video upload:", error.message);
      }
    }
  }

  router.post("/validate-upload", receiveVideo, async (req, res) => {
    let tempFilePath = null;
    let storedFilePath = null;
    let videoId = null;
    let uploadCommitted = false;
    try {
      const userId = req.auth.userId;
      tempFilePath = req.file?.path || null;

      if (!req.file) {
        return res.status(400).json({ success: false, error: "Video file is required" });
      }

      const validation = await validateTrafficVideo(tempFilePath);
      videoId = crypto.randomUUID();
      const extension = path.extname(req.file.originalname).toLowerCase() || ".mp4";
      const storedFileName = `${videoId}${extension}`;
      const storedPath = path.join(acceptedVideosDir, storedFileName);
      await fsPromises.rename(tempFilePath, storedPath);
      storedFilePath = storedPath;
      tempFilePath = null;

      await videoJobs.createVideoJob({
        videoId,
        userId,
        sourceVideoPath: storedPath,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        contentType: req.file.mimetype,
        durationSeconds: validation.durationSeconds,
        width: validation.width,
        height: validation.height,
        sampledFrameCount: validation.sampledFrameCount,
        trafficScene: validation.trafficScene,
      });

      const previewTimestamp = Math.min(1, Math.max(0.1, validation.durationSeconds / 2));
      const preview = await extractVideoFrames(storedPath, [previewTimestamp]);
      try {
        await videoJobs.savePreview(videoId, preview.framePaths[0]);
      } finally {
        await fsPromises.rm(preview.frameDir, { recursive: true, force: true });
      }

      await dataStorage.logAuditEvent("upload", {
        videoId,
        userId,
        action: "traffic_video_upload_validated",
        fileName: req.file.originalname,
        fileSize: req.file.size,
        durationSeconds: validation.durationSeconds,
        sampledFrameCount: validation.sampledFrameCount,
        trafficSceneConfidence: validation.trafficScene.confidence,
      });

      res.json({
        success: true,
        video: {
          videoId,
          fileName: req.file.originalname,
          fileSize: req.file.size,
          contentType: req.file.mimetype,
          durationSeconds: validation.durationSeconds,
          width: validation.width,
          height: validation.height,
          sampledFrameCount: validation.sampledFrameCount,
          trafficScene: validation.trafficScene,
          status: "queued",
        },
      });
      uploadCommitted = true;

      videoJobs.startVideoProcessing(videoId).catch((error) => {
        console.error(`Unable to start video processing for ${videoId}:`, error);
      });
    } catch (error) {
      console.error("Traffic video upload validation error:", error);
      const response = getVideoUploadErrorResponse(error);
      res.status(response.status).json({
        success: false,
        error: response.message,
        trafficScene: response.trafficScene,
      });
    } finally {
      await cleanupTempUpload(tempFilePath);
      if (!uploadCommitted) {
        if (videoId) {
          try {
            await videoJobs.removeVideoJob(videoId);
          } catch (error) {
            console.warn(`Unable to remove incomplete video job ${videoId}:`, error.message);
          }
        }
        await cleanupTempUpload(storedFilePath);
      }
    }
  });

  router.get("/:videoId", async (req, res) => {
    try {
      const job = await videoJobs.getPublicVideoJob(req.params.videoId, req.auth.userId);
      res.json({ success: true, video: job });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  router.post("/:videoId/process", async (req, res) => {
    try {
      const job = await videoJobs.getVideoJob(req.params.videoId);
      videoJobs.assertJobOwner(job, req.auth.userId);
      videoJobs.startVideoProcessing(req.params.videoId).catch((error) => {
        console.error(`Unable to restart video processing for ${req.params.videoId}:`, error);
      });
      const publicJob = await videoJobs.getPublicVideoJob(req.params.videoId, req.auth.userId);
      res.status(202).json({ success: true, video: publicJob });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  router.put("/:videoId/zones", async (req, res) => {
    try {
      const job = await videoJobs.saveZones(req.params.videoId, req.auth.userId, req.body?.zones);
      res.json({ success: true, video: job });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  router.get("/:videoId/artifacts/:artifact", async (req, res) => {
    try {
      const artifactPath = await videoJobs.getArtifactPath(
        req.params.videoId,
        req.auth.userId,
        req.params.artifact,
      );
      if (["tracks", "counts"].includes(req.params.artifact)) {
        res.download(artifactPath);
        return;
      }
      res.sendFile(artifactPath);
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.use("/api/videos", router);
  return ready;
}

module.exports = { registerVideoRoutes };
