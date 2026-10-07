const { spawn } = require("child_process");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const readline = require("readline");
const { getVideoDataPaths } = require("./videoDataPaths");

const { jobsRoot: JOBS_ROOT } = getVideoDataPaths(process.env, __dirname);
const DEFAULT_PROCESSOR_ROOT = path.resolve(__dirname, "..", "..", "traffic-tool");
const activeProcessingJobs = new Map();
const recountQueues = new Map();
const ZONE_COLORS = ["#00847c", "#d97706", "#2563eb", "#7c3aed"];
const ROAD_USER_CLASSES = new Set([
  "bicycle",
  "bus",
  "car",
  "motorbike",
  "motorcycle",
  "truck",
  "vehicle",
]);

function getVideoCloud() {
  return require("./videoCloudOrchestrator");
}

function getVideoOrchestrator() {
  return process.env.TRAFFIC_PROCESSOR_MODE === "s3-lambda-ec2"
    ? require("./videoS3OnDemand")
    : getVideoCloud();
}

function shouldPersistDirectJobToS3(config) {
  return (
    config.mode === "ec2-on-demand-ssh" &&
    Boolean(process.env.TRAFFIC_VIDEO_BUCKET || process.env.S3_BUCKET)
  );
}

function getEc2WorkerLifecycle() {
  return require("./ec2WorkerLifecycle");
}

function nowIso() {
  return new Date().toISOString();
}

function assertVideoId(videoId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(videoId || ""))) {
    const error = new Error("Invalid video ID");
    error.statusCode = 400;
    throw error;
  }
  return String(videoId);
}

function getJobDir(videoId) {
  return path.join(JOBS_ROOT, assertVideoId(videoId));
}

function getJobPath(videoId) {
  return path.join(getJobDir(videoId), "job.json");
}

function getOutputDir(videoId) {
  return path.join(getJobDir(videoId), "output");
}

async function pathExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fsPromises.rename(tempPath, filePath);
}

async function createVideoJob({
  videoId,
  userId,
  sourceVideoPath,
  fileName,
  fileSize,
  contentType,
  durationSeconds,
  width,
  height,
  sampledFrameCount,
  trafficScene,
}) {
  assertVideoId(videoId);
  const createdAt = nowIso();
  const job = {
    version: 1,
    videoId,
    userId,
    sourceVideoPath: path.resolve(sourceVideoPath),
    fileName,
    fileSize,
    contentType,
    durationSeconds,
    width,
    height,
    sampledFrameCount,
    trafficScene,
    status: "queued",
    countsStatus: "not_configured",
    zones: [],
    suggestedZones: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    processingStartedAt: null,
    processingCompletedAt: null,
    countsUpdatedAt: null,
  };
  await fsPromises.mkdir(getOutputDir(videoId), { recursive: true });
  await writeJsonAtomic(getJobPath(videoId), job);
  return job;
}

async function removeVideoJob(videoId) {
  await fsPromises.rm(getJobDir(videoId), { recursive: true, force: true });
}

async function getVideoJob(videoId) {
  const jobPath = getJobPath(videoId);
  try {
    return JSON.parse(await fsPromises.readFile(jobPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      const notFound = new Error("Video job not found");
      notFound.statusCode = 404;
      throw notFound;
    }
    throw error;
  }
}

async function updateVideoJob(videoId, changes) {
  const current = await getVideoJob(videoId);
  const updated = { ...current, ...changes, updatedAt: nowIso() };
  await writeJsonAtomic(getJobPath(videoId), updated);
  return updated;
}

async function updateVideoTiming(videoId, changes) {
  const current = await getVideoJob(videoId);
  return updateVideoJob(videoId, {
    timing: { ...(current.timing || {}), ...changes },
  });
}

async function persistDirectJobToS3(videoId, config, { includeInput = true } = {}) {
  if (!shouldPersistDirectJobToS3(config)) return null;
  await updateVideoJob(videoId, { storageStatus: "syncing", storageError: null });
  try {
    const job = await getVideoJob(videoId);
    const result = await require("./videoS3OnDemand").persistDirectJobArtifacts(
      job,
      getJobDir(videoId),
      getOutputDir(videoId),
      { includeInput },
    );
    const synchronized = await updateVideoJob(videoId, {
      storageStatus: "synced",
      storageError: null,
      storage: {
        type: "s3",
        bucket: process.env.TRAFFIC_VIDEO_BUCKET || process.env.S3_BUCKET,
        prefix: result.prefix,
      },
    });
    await require("./videoS3OnDemand").persistJobState(synchronized);
    return result;
  } catch (error) {
    await updateVideoJob(videoId, { storageStatus: "failed", storageError: error.message });
    throw error;
  }
}

async function recoverInterruptedVideoJobs() {
  await fsPromises.mkdir(JOBS_ROOT, { recursive: true });
  if (getVideoOrchestrator().isCloudMode()) return 0;
  const entries = await fsPromises.readdir(JOBS_ROOT, { withFileTypes: true });
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    try {
      const job = await getVideoJob(entry.name);
      if (job.status !== "processing") continue;
      await updateVideoJob(entry.name, {
        status: "failed",
        error:
          "Processing was interrupted by a backend restart. Retry processing to run the video again.",
        processingInterruptedAt: nowIso(),
      });
      recovered += 1;
    } catch {
      // One malformed job must not prevent the API server from starting.
    }
  }
  return recovered;
}

function assertJobOwner(job, userId) {
  if (!userId || job.userId !== userId) {
    const error = new Error("You do not have access to this video job");
    error.statusCode = 403;
    throw error;
  }
}

function getProcessorConfig() {
  const processorRoot = path.resolve(process.env.TRAFFIC_PROCESSOR_ROOT || DEFAULT_PROCESSOR_ROOT);
  const bundledPython = path.join(processorRoot, ".venv", "bin", "python");
  const python =
    process.env.TRAFFIC_PROCESSOR_PYTHON ||
    (fs.existsSync(bundledPython) ? bundledPython : "python3");
  return {
    mode: process.env.TRAFFIC_PROCESSOR_MODE || "local-yolo",
    processorRoot,
    python,
    trackerScript: path.resolve(
      process.env.TRAFFIC_TRACKER_SCRIPT || path.join(processorRoot, "track_yolo.py"),
    ),
    countScript: path.resolve(
      process.env.TRAFFIC_COUNT_SCRIPT || path.join(processorRoot, "count_movements.py"),
    ),
    model: process.env.TRAFFIC_YOLO_MODEL || "yolo11n.pt",
    tracker: process.env.TRAFFIC_YOLO_TRACKER || "bytetrack.yaml",
    device: process.env.TRAFFIC_YOLO_DEVICE || "auto",
    binSeconds: Number(process.env.TRAFFIC_COUNT_BIN_SECONDS || 900),
    remoteHost: process.env.TRAFFIC_DEEPSTREAM_HOST || "",
    remoteSshKey: process.env.TRAFFIC_DEEPSTREAM_SSH_KEY || "",
    remoteRoot: process.env.TRAFFIC_DEEPSTREAM_ROOT || "/srv/traffic-video",
    remoteImage: process.env.TRAFFIC_DEEPSTREAM_IMAGE || "traffic-video:ds8",
    remoteTracker: process.env.TRAFFIC_REMOTE_TRACKER || "deepstream",
    remoteYoloImage: process.env.TRAFFIC_YOLO_REMOTE_IMAGE || "traffic-yolo:cam5-reference",
    remoteMountApp: process.env.TRAFFIC_DEEPSTREAM_MOUNT_APP !== "false",
    remoteMaxFrames: process.env.TRAFFIC_DEEPSTREAM_MAX_FRAMES || "",
  };
}

function assertSafeRemoteConfig(config) {
  if (!/^[a-zA-Z0-9._@-]+$/.test(config.remoteHost)) {
    throw new Error("TRAFFIC_DEEPSTREAM_HOST is missing or invalid");
  }
  if (!config.remoteSshKey) {
    throw new Error("TRAFFIC_DEEPSTREAM_SSH_KEY is required for the DeepStream EC2 worker");
  }
  if (!path.isAbsolute(config.remoteSshKey) || !fs.existsSync(config.remoteSshKey)) {
    throw new Error("TRAFFIC_DEEPSTREAM_SSH_KEY must point to an existing absolute key path");
  }
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(config.remoteRoot)) {
    throw new Error("TRAFFIC_DEEPSTREAM_ROOT must be a safe absolute path");
  }
  if (!/^[a-zA-Z0-9._:/-]+$/.test(config.remoteImage)) {
    throw new Error("TRAFFIC_DEEPSTREAM_IMAGE is invalid");
  }
  if (!new Set(["deepstream", "yolo-traffic"]).has(config.remoteTracker)) {
    throw new Error("TRAFFIC_REMOTE_TRACKER must be deepstream or yolo-traffic");
  }
  if (!/^[a-zA-Z0-9._:/-]+$/.test(config.remoteYoloImage)) {
    throw new Error("TRAFFIC_YOLO_REMOTE_IMAGE is invalid");
  }
  if (config.remoteMaxFrames && !/^[1-9][0-9]*$/.test(config.remoteMaxFrames)) {
    throw new Error("TRAFFIC_DEEPSTREAM_MAX_FRAMES must be a positive integer");
  }
}

function remoteJobPaths(videoId, config, sourceVideoPath) {
  const extension = path.extname(sourceVideoPath).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw new Error("Uploaded video has an unsupported filename extension");
  }
  const inputDir = `${config.remoteRoot}/data/inbox/traffic-atlas/${videoId}`;
  const outputDir = `${config.remoteRoot}/out/traffic-atlas/${videoId}`;
  const zonesDir = `${config.remoteRoot}/data/zones/traffic-atlas/${videoId}`;
  return {
    inputDir,
    inputPath: `${inputDir}/input${extension}`,
    outputDir,
    tracksPath: `${outputDir}/tracks.csv`,
    annotatedPath: `${outputDir}/annotated.mp4`,
    countsPath: `${outputDir}/movement_counts.csv`,
    zonesDir,
    zonesPath: `${zonesDir}/zones.geojson`,
  };
}

function sshBaseArgs(config) {
  return [
    "-i",
    path.resolve(config.remoteSshKey),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function rsyncRemoteShell(config) {
  return ["ssh", ...sshBaseArgs(config)].map(shellQuote).join(" ");
}

async function uploadRemoteVideo(sourceVideoPath, remoteInputPath, config, logPath, commandRunner) {
  const sshArgs = sshBaseArgs(config);
  const destination = `${config.remoteHost}:${remoteInputPath}`;
  const retryDelayMs = Math.max(0, Number(process.env.TRAFFIC_TRANSFER_RETRY_DELAY_MS || 2000));
  const maxAttempts = Math.max(1, Number(process.env.TRAFFIC_TRANSFER_MAX_ATTEMPTS || 3));

  let rsyncError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await commandRunner(
        "rsync",
        [
          "--archive",
          "--partial",
          // macOS ships rsync 2.6.x, which supports resumable --append but not
          // the newer --append-verify option. The source is immutable per job,
          // so resuming that same input file is safe here.
          "--append",
          "--timeout=120",
          "-e",
          rsyncRemoteShell(config),
          sourceVideoPath,
          destination,
        ],
        { logPath },
      );
      return attempt === 1 ? "rsync" : `rsync-retry-${attempt}`;
    } catch (error) {
      rsyncError = error;
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  // Preserve SCP for minimal API hosts without rsync, while preferring the
  // resumable rsync path for large videos and retrying transient SSH failures.
  try {
    await commandRunner("scp", [...sshArgs, sourceVideoPath, destination], { logPath });
    return "scp-fallback";
  } catch (scpError) {
    scpError.message = `Resumable upload failed after ${maxAttempts} rsync attempt(s): ${scpError.message || rsyncError?.message}`;
    throw scpError;
  }
}

async function runRemoteDeepStreamTracking(
  videoId,
  job,
  config,
  outputDir,
  logPath,
  commandRunner,
) {
  assertSafeRemoteConfig(config);
  const remote = remoteJobPaths(videoId, config, job.sourceVideoPath);
  const sshArgs = sshBaseArgs(config);
  await commandRunner(
    "ssh",
    [
      ...sshArgs,
      config.remoteHost,
      `mkdir -p ${remote.inputDir} ${remote.outputDir} ${remote.zonesDir}`,
    ],
    { logPath },
  );
  const uploadStartedAt = Date.now();
  await updateVideoTiming(videoId, { remoteUploadStartedAt: nowIso() });
  const uploadMethod = await uploadRemoteVideo(
    job.sourceVideoPath,
    remote.inputPath,
    config,
    logPath,
    commandRunner,
  );
  await updateVideoTiming(videoId, {
    remoteUploadCompletedAt: nowIso(),
    remoteUploadMilliseconds: Date.now() - uploadStartedAt,
    remoteUploadMethod: uploadMethod,
  });
  const useYoloTraffic = config.remoteTracker === "yolo-traffic";
  const environment = useYoloTraffic
    ? `TRAFFIC_YOLO_IMAGE=${config.remoteYoloImage} TRAFFIC_APP_DIR=${config.remoteRoot}/app`
    : [
        `TRAFFIC_IMAGE=${config.remoteImage}`,
        config.remoteMountApp ? `TRAFFIC_APP_DIR=${config.remoteRoot}/app` : "",
      ]
        .filter(Boolean)
        .join(" ");
  const runner = useYoloTraffic ? "run-yolo-traffic-job.sh" : "run-deepstream-job.sh";
  const frameLimitArguments = config.remoteMaxFrames
    ? useYoloTraffic
      ? ` ${config.remoteMaxFrames}`
      : ` '' ${config.remoteMaxFrames}`
    : "";
  const trackerStartedAt = Date.now();
  await updateVideoTiming(videoId, { trackerStartedAt: nowIso() });
  await commandRunner(
    "ssh",
    [
      ...sshArgs,
      config.remoteHost,
      `${environment} ${config.remoteRoot}/app/scripts/${runner} ${remote.inputPath} ${remote.outputDir}${frameLimitArguments}`,
    ],
    { logPath },
  );
  await updateVideoTiming(videoId, {
    trackerCompletedAt: nowIso(),
    trackerMilliseconds: Date.now() - trackerStartedAt,
  });
  const artifactDownloadStartedAt = Date.now();
  await updateVideoTiming(videoId, { artifactDownloadStartedAt: nowIso() });
  await commandRunner(
    "scp",
    [...sshArgs, `${config.remoteHost}:${remote.tracksPath}`, path.join(outputDir, "tracks.csv")],
    { logPath },
  );
  await updateVideoTiming(videoId, {
    artifactDownloadCompletedAt: nowIso(),
    artifactDownloadMilliseconds: Date.now() - artifactDownloadStartedAt,
  });
  await updateVideoJob(videoId, { remote });
  return remote;
}

async function runRemoteMovementRecount(videoId, job, config, countsPath, logPath, commandRunner) {
  assertSafeRemoteConfig(config);
  const remote = job.remote || remoteJobPaths(videoId, config, job.sourceVideoPath);
  const sshArgs = sshBaseArgs(config);
  const localZonesPath = path.join(getJobDir(videoId), "zones.geojson");
  await commandRunner(
    "ssh",
    [...sshArgs, config.remoteHost, `mkdir -p ${remote.zonesDir} ${remote.outputDir}`],
    { logPath },
  );
  await commandRunner(
    "scp",
    [...sshArgs, localZonesPath, `${config.remoteHost}:${remote.zonesPath}`],
    { logPath },
  );
  const environment = [
    `TRAFFIC_IMAGE=${config.remoteImage}`,
    `TRAFFIC_COUNT_BIN_SECONDS=${config.binSeconds}`,
    config.remoteMountApp ? `TRAFFIC_APP_DIR=${config.remoteRoot}/app` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const recountStartedAt = Date.now();
  await updateVideoTiming(videoId, { recountStartedAt: nowIso() });
  await commandRunner(
    "ssh",
    [
      ...sshArgs,
      config.remoteHost,
      `${environment} ${config.remoteRoot}/app/scripts/run-zone-recount.sh ${remote.tracksPath} ${remote.zonesPath} ${remote.countsPath}`,
    ],
    { logPath },
  );
  await updateVideoTiming(videoId, {
    recountCompletedAt: nowIso(),
    recountMilliseconds: Date.now() - recountStartedAt,
  });
  await commandRunner(
    "scp",
    [...sshArgs, `${config.remoteHost}:${remote.countsPath}`, countsPath],
    { logPath },
  );
}

function runCommand(command, args, { cwd, logPath } = {}) {
  return new Promise((resolve, reject) => {
    const log = logPath ? fs.createWriteStream(logPath, { flags: "a" }) : null;
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    child.stdout.on("data", (chunk) => log?.write(chunk));
    child.stderr.on("data", (chunk) => {
      log?.write(chunk);
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      log?.end();
      reject(error);
    });
    child.on("close", (code) => {
      log?.end();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderrTail.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function savePreview(videoId, extractedFramePath) {
  const previewPath = path.join(getJobDir(videoId), "preview.jpg");
  await fsPromises.copyFile(extractedFramePath, previewPath);
  return previewPath;
}

async function startVideoProcessing(videoId, { commandRunner = runCommand } = {}) {
  assertVideoId(videoId);
  if (activeProcessingJobs.has(videoId)) return activeProcessingJobs.get(videoId);

  const operation = (async () => {
    const job = await getVideoJob(videoId);
    const config = getProcessorConfig();
    const outputDir = getOutputDir(videoId);
    const logPath = path.join(getJobDir(videoId), "processing.log");
    const processingStartedAt = Date.now();
    await updateVideoJob(videoId, {
      status: "processing",
      error: null,
      processingStartedAt: nowIso(),
      timing: { processingRequestedAt: nowIso() },
    });
    try {
      if (["sqs-ec2", "s3-lambda-ec2"].includes(config.mode)) {
        const cloud = await getVideoOrchestrator().enqueueTracking(job);
        return updateVideoJob(videoId, {
          status: "queued",
          countsStatus: "awaiting_tracks",
          cloud,
          processingStartedAt: null,
        });
      } else if (config.mode === "ec2-on-demand-ssh") {
        await updateVideoTiming(videoId, { ec2StartRequestedAt: nowIso() });
        await getEc2WorkerLifecycle().runWithWorker(async (connection) => {
          await updateVideoTiming(videoId, {
            ec2ReadyAt: nowIso(),
            ec2ReadyMilliseconds: Date.now() - processingStartedAt,
          });
          return runRemoteDeepStreamTracking(
            videoId,
            job,
            { ...config, remoteHost: connection.remoteHost },
            outputDir,
            logPath,
            commandRunner,
          );
        });
      } else if (config.mode === "deepstream-ssh") {
        await runRemoteDeepStreamTracking(videoId, job, config, outputDir, logPath, commandRunner);
      } else if (config.mode === "local-yolo") {
        const args = [
          config.trackerScript,
          "--video",
          job.sourceVideoPath,
          "--out",
          outputDir,
          "--model",
          config.model,
          "--tracker",
          config.tracker,
          "--device",
          config.device,
        ];
        if (process.env.TRAFFIC_YOLO_MAX_FRAMES) {
          args.push("--max-frames", String(process.env.TRAFFIC_YOLO_MAX_FRAMES));
        }
        await commandRunner(config.python, args, { cwd: config.processorRoot, logPath });
      } else {
        throw new Error(`Unsupported TRAFFIC_PROCESSOR_MODE: ${config.mode}`);
      }
      const tracksPath = path.join(outputDir, "tracks.csv");
      if (!(await pathExists(tracksPath))) {
        throw new Error("Tracking completed without producing tracks.csv");
      }
      const finalizationStartedAt = Date.now();
      await updateVideoTiming(videoId, { localFinalizationStartedAt: nowIso() });
      const trajectories = await buildTrajectoryPreview(
        videoId,
        Number(job.width),
        Number(job.height),
      );
      const suggestedZones = suggestTrafficZones(
        trajectories,
        Number(job.width),
        Number(job.height),
      );
      const latestJob = await getVideoJob(videoId);
      const zones = latestJob.zones?.length ? latestJob.zones : suggestedZones;
      if (!latestJob.zones?.length && zones.length) {
        await writeJsonAtomic(
          path.join(getJobDir(videoId), "zones.geojson"),
          zonesToGeoJson(zones, Number(job.width), Number(job.height)),
        );
      }
      const current = await updateVideoJob(videoId, {
        status: "ready",
        processingCompletedAt: nowIso(),
        suggestedZones,
        zones,
        zoneSuggestionMethod: suggestedZones.length ? "kmeans-convex-hull" : null,
        countsStatus: zones.length ? "awaiting_recount" : "not_configured",
      });
      await updateVideoTiming(videoId, {
        localFinalizationCompletedAt: nowIso(),
        localFinalizationMilliseconds: Date.now() - finalizationStartedAt,
      });
      if (current.zones?.length) {
        await recountMovements(videoId, { commandRunner });
      }
      if (shouldPersistDirectJobToS3(config)) {
        await updateVideoJob(videoId, { storageStatus: "pending", storageError: null });
        // The UI is usable as soon as counts are ready. Archive the source and
        // small data artifacts after returning rather than holding the request
        // open behind the user's broadband upload.
        void persistDirectJobToS3(videoId, config).catch((error) => {
          console.error(`Could not archive traffic video job ${videoId} to S3: ${error.message}`);
        });
      }
      return getVideoJob(videoId);
    } catch (error) {
      await updateVideoJob(videoId, {
        status: "failed",
        error: error.message,
      });
      return getVideoJob(videoId);
    }
  })();

  activeProcessingJobs.set(videoId, operation);
  operation.then(
    () => activeProcessingJobs.delete(videoId),
    () => activeProcessingJobs.delete(videoId),
  );
  return operation;
}

function normalizeZone(zone, index) {
  const id = String(zone?.id || `zone-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-");
  const label = String(zone?.label || `Zone ${index + 1}`)
    .trim()
    .slice(0, 80);
  const points = Array.isArray(zone?.points) ? zone.points : [];
  if (points.length < 3) {
    const error = new Error(`${label} must contain at least three points`);
    error.statusCode = 400;
    throw error;
  }
  return {
    id,
    label,
    color: String(zone?.color || "#00847c").slice(0, 20),
    points: points.map((point) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
        const error = new Error(`${label} contains a point outside the video frame`);
        error.statusCode = 400;
        throw error;
      }
      return { x, y };
    }),
  };
}

function zonesToGeoJson(zones, width, height) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Video dimensions are unavailable; zones cannot be converted to pixels");
  }
  return {
    type: "FeatureCollection",
    features: zones.map((zone) => {
      const ring = zone.points.map((point) => [
        Number(((point.x / 100) * width).toFixed(3)),
        Number(((point.y / 100) * height).toFixed(3)),
      ]);
      ring.push([...ring[0]]);
      return {
        type: "Feature",
        properties: { id: zone.id, name: zone.label, color: zone.color },
        geometry: { type: "Polygon", coordinates: [ring] },
      };
    }),
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function squaredDistance(left, right) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function initializeKMeansPlusPlus(points, clusterCount, random) {
  const centers = [points[Math.floor(random() * points.length)]];
  while (centers.length < clusterCount) {
    const weights = points.map((point) =>
      Math.min(...centers.map((center) => squaredDistance(point, center))),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) {
      centers.push(points[centers.length % points.length]);
      continue;
    }
    let threshold = random() * total;
    let selected = points[points.length - 1];
    for (let index = 0; index < points.length; index += 1) {
      threshold -= weights[index];
      if (threshold <= 0) {
        selected = points[index];
        break;
      }
    }
    centers.push(selected);
  }
  return centers.map((center) => ({ ...center }));
}

function fitKMeans(points, clusterCount, { seed = 42, restarts = 10, maxIterations = 100 } = {}) {
  let best = null;
  for (let restart = 0; restart < restarts; restart += 1) {
    const random = seededRandom(seed + restart * 1009);
    let centers = initializeKMeansPlusPlus(points, clusterCount, random);
    let assignments = new Array(points.length).fill(-1);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const nextAssignments = points.map((point) => {
        let nearest = 0;
        let nearestDistance = squaredDistance(point, centers[0]);
        for (let index = 1; index < centers.length; index += 1) {
          const distance = squaredDistance(point, centers[index]);
          if (distance < nearestDistance) {
            nearest = index;
            nearestDistance = distance;
          }
        }
        return nearest;
      });
      const changed = nextAssignments.some((value, index) => value !== assignments[index]);
      assignments = nextAssignments;
      centers = centers.map((center, cluster) => {
        const members = points.filter((_, index) => assignments[index] === cluster);
        if (!members.length) {
          const replacement = points.reduce(
            (farthest, point) => {
              const pointDistance = Math.min(
                ...centers.map((candidate) => squaredDistance(point, candidate)),
              );
              return pointDistance > farthest.distance
                ? { point, distance: pointDistance }
                : farthest;
            },
            { point: center, distance: -1 },
          ).point;
          return { ...replacement };
        }
        return {
          x: members.reduce((sum, point) => sum + point.x, 0) / members.length,
          y: members.reduce((sum, point) => sum + point.y, 0) / members.length,
        };
      });
      if (!changed) break;
    }
    const inertia = points.reduce(
      (sum, point, index) => sum + squaredDistance(point, centers[assignments[index]]),
      0,
    );
    if (!best || inertia < best.inertia) best = { assignments, centers, inertia };
  }
  return best;
}

function convexHull(points) {
  const unique = [
    ...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values(),
  ].sort((left, right) => left.x - right.x || left.y - right.y);
  if (unique.length <= 2) return unique;
  const cross = (origin, left, right) =>
    (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function paddedHull(points) {
  const hull = convexHull(points);
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  if (hull.length < 3) {
    const halfWidth = Math.max(
      2.5,
      (Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))) /
        2 +
        1.5,
    );
    const halfHeight = Math.max(
      2.5,
      (Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))) /
        2 +
        1.5,
    );
    return [
      { x: center.x - halfWidth, y: center.y - halfHeight },
      { x: center.x + halfWidth, y: center.y - halfHeight },
      { x: center.x + halfWidth, y: center.y + halfHeight },
      { x: center.x - halfWidth, y: center.y + halfHeight },
    ].map((point) => ({
      x: Number(Math.max(0, Math.min(100, point.x)).toFixed(3)),
      y: Number(Math.max(0, Math.min(100, point.y)).toFixed(3)),
    }));
  }
  return hull.map((point) => {
    const distance = Math.hypot(point.x - center.x, point.y - center.y) || 1;
    const padding = 1.25;
    return {
      x: Number(
        Math.max(0, Math.min(100, point.x + ((point.x - center.x) / distance) * padding)).toFixed(
          3,
        ),
      ),
      y: Number(
        Math.max(0, Math.min(100, point.y + ((point.y - center.y) / distance) * padding)).toFixed(
          3,
        ),
      ),
    };
  });
}

function suggestTrafficZones(
  trajectories,
  width,
  height,
  { clusterCount = 4, minDisplacementPixels = 100 } = {},
) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];
  const candidates = (trajectories || []).filter((trajectory) => {
    const className = String(trajectory.class || "vehicle")
      .toLowerCase()
      .replace(/[- ]/g, "_");
    const start = trajectory.points?.[0];
    const end = trajectory.points?.at(-1);
    if (!ROAD_USER_CLASSES.has(className) || !start || !end) return false;
    return (
      Math.hypot(((end.x - start.x) / 100) * width, ((end.y - start.y) / 100) * height) >
      minDisplacementPixels
    );
  });
  if (candidates.length < clusterCount) return [];

  const samples = candidates.flatMap((trajectory, trajectoryIndex) => [
    { ...trajectory.points[0], trajectoryIndex, endpoint: "start" },
    { ...trajectory.points.at(-1), trajectoryIndex, endpoint: "end" },
  ]);
  const meanX = samples.reduce((sum, point) => sum + point.x, 0) / samples.length;
  const meanY = samples.reduce((sum, point) => sum + point.y, 0) / samples.length;
  const std = (axis, mean) =>
    Math.sqrt(
      samples.reduce((sum, point) => sum + (point[axis] - mean) ** 2, 0) /
        Math.max(1, samples.length - 1),
    ) || 1;
  const stdX = std("x", meanX);
  const stdY = std("y", meanY);
  const standardized = samples.map((point) => ({
    x: (point.x - meanX) / stdX,
    y: (point.y - meanY) / stdY,
  }));
  const result = fitKMeans(standardized, clusterCount, { seed: 42, restarts: 10 });
  if (!result) return [];

  const crossGateTrajectories = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    if (result.assignments[index * 2] !== result.assignments[index * 2 + 1]) {
      crossGateTrajectories.add(index);
    }
  }
  const clusters = Array.from({ length: clusterCount }, (_, cluster) => ({
    cluster,
    points: samples.filter(
      (sample, index) =>
        result.assignments[index] === cluster && crossGateTrajectories.has(sample.trajectoryIndex),
    ),
  })).filter((cluster) => cluster.points.length > 0);
  clusters.sort((left, right) => {
    const centroid = (cluster, axis) =>
      cluster.points.reduce((sum, point) => sum + point[axis], 0) / cluster.points.length;
    return centroid(left, "x") - centroid(right, "x") || centroid(left, "y") - centroid(right, "y");
  });
  return clusters.map((cluster, index) => ({
    id: `zone-${index + 1}`,
    label: `Zone ${index + 1}`,
    color: ZONE_COLORS[index % ZONE_COLORS.length],
    points: paddedHull(cluster.points),
  }));
}

async function replaceZonesWithSuggestions(
  videoId,
  { commandRunner = runCommand, recount = true } = {},
) {
  const job = await getVideoJob(videoId);
  const trajectories = await readTrajectoryPreview(videoId);
  const suggestedZones = suggestTrafficZones(trajectories, Number(job.width), Number(job.height));
  if (!suggestedZones.length)
    throw new Error("Not enough qualifying trajectories for K-means zones");
  await writeJsonAtomic(
    path.join(getJobDir(videoId), "zones.geojson"),
    zonesToGeoJson(suggestedZones, Number(job.width), Number(job.height)),
  );
  await updateVideoJob(videoId, {
    zones: suggestedZones,
    suggestedZones,
    zoneSuggestionMethod: "kmeans-convex-hull",
    countsStatus: recount && job.status === "ready" ? "calculating" : job.countsStatus,
  });
  if (recount && job.status === "ready") await recountMovements(videoId, { commandRunner });
  return getVideoJob(videoId);
}

async function saveZones(videoId, userId, zones, { commandRunner = runCommand } = {}) {
  const job = await getVideoJob(videoId);
  assertJobOwner(job, userId);
  if (!Array.isArray(zones) || zones.length === 0 || zones.length > 20) {
    const error = new Error("Provide between 1 and 20 traffic zones");
    error.statusCode = 400;
    throw error;
  }
  const normalized = zones.map(normalizeZone);
  const geoJson = zonesToGeoJson(normalized, Number(job.width), Number(job.height));
  await writeJsonAtomic(path.join(getJobDir(videoId), "zones.geojson"), geoJson);
  await updateVideoJob(videoId, {
    zones: normalized,
    zonesEditedAt: nowIso(),
    countsStatus: job.status === "ready" ? "calculating" : "awaiting_tracks",
  });
  if (job.status === "ready") {
    await recountMovements(videoId, { commandRunner });
    await persistDirectJobToS3(videoId, getProcessorConfig(), { includeInput: false });
  }
  return getPublicVideoJob(videoId, userId);
}

async function recountMovements(videoId, { commandRunner = runCommand } = {}) {
  const previous = recountQueues.get(videoId) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => runMovementRecount(videoId, { commandRunner }));
  recountQueues.set(videoId, operation);
  operation.then(
    () => {
      if (recountQueues.get(videoId) === operation) recountQueues.delete(videoId);
    },
    () => {
      if (recountQueues.get(videoId) === operation) recountQueues.delete(videoId);
    },
  );
  return operation;
}

async function runMovementRecount(videoId, { commandRunner = runCommand } = {}) {
  const job = await getVideoJob(videoId);
  const config = getProcessorConfig();
  const outputDir = getOutputDir(videoId);
  const tracksPath = path.join(outputDir, "tracks.csv");
  const zonesPath = path.join(getJobDir(videoId), "zones.geojson");
  const countsPath = path.join(outputDir, "movement_counts.csv");
  if (!(await pathExists(tracksPath))) {
    await updateVideoJob(videoId, { countsStatus: "awaiting_tracks" });
    return;
  }
  await updateVideoJob(videoId, { countsStatus: "calculating", error: null });
  try {
    if (["sqs-ec2", "s3-lambda-ec2"].includes(config.mode)) {
      await getVideoOrchestrator().enqueueRecount(job, zonesPath);
      await updateVideoJob(videoId, { countsStatus: "queued" });
      return;
    } else if (config.mode === "ec2-on-demand-ssh") {
      const workerWaitStartedAt = Date.now();
      await updateVideoTiming(videoId, { recountEc2RequestedAt: nowIso() });
      await getEc2WorkerLifecycle().runWithWorker(async (connection) => {
        await updateVideoTiming(videoId, {
          recountEc2ReadyAt: nowIso(),
          recountEc2ReadyMilliseconds: Date.now() - workerWaitStartedAt,
        });
        return runRemoteMovementRecount(
          videoId,
          job,
          { ...config, remoteHost: connection.remoteHost },
          countsPath,
          path.join(getJobDir(videoId), "processing.log"),
          commandRunner,
        );
      });
    } else if (config.mode === "deepstream-ssh") {
      await runRemoteMovementRecount(
        videoId,
        job,
        config,
        countsPath,
        path.join(getJobDir(videoId), "processing.log"),
        commandRunner,
      );
    } else {
      await commandRunner(
        config.python,
        [
          config.countScript,
          "--tracks",
          tracksPath,
          "--zones",
          zonesPath,
          "--output",
          countsPath,
          "--bin-seconds",
          String(config.binSeconds),
        ],
        { cwd: config.processorRoot, logPath: path.join(getJobDir(videoId), "processing.log") },
      );
    }
    await updateVideoJob(videoId, {
      countsStatus: "ready",
      countsUpdatedAt: nowIso(),
    });
  } catch (error) {
    await updateVideoJob(videoId, {
      countsStatus: "failed",
      error: `Movement recount failed: ${error.message}`,
    });
    throw error;
  }
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
}

async function readCounts(videoId) {
  const countsPath = path.join(getOutputDir(videoId), "movement_counts.csv");
  if (!(await pathExists(countsPath))) return [];
  const lines = (await fsPromises.readFile(countsPath, "utf8")).split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

async function buildTrajectoryPreview(
  videoId,
  width,
  height,
  { maxTracks = 200, maxPointsPerTrack = 80 } = {},
) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Video dimensions are required to build trajectory previews");
  }
  const tracksPath = path.join(getOutputDir(videoId), "tracks.csv");
  const input = fs.createReadStream(tracksPath, "utf8");
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const trajectories = new Map();
  let headers = null;
  for await (const line of lines) {
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (!line) continue;
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const trackId = String(row.track_id || "");
    if (!trackId) continue;
    if (!trajectories.has(trackId)) {
      if (trajectories.size >= maxTracks) continue;
      trajectories.set(trackId, {
        trackId,
        class: row.class || "vehicle",
        points: [],
        observations: 0,
        lastObserved: null,
      });
    }
    const trajectory = trajectories.get(trackId);
    const x = (Number(row.cx) / width) * 100;
    const y = (Number(row.cy) / height) * 100;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = {
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
    };
    trajectory.observations += 1;
    trajectory.lastObserved = point;
    const previous = trajectory.points[trajectory.points.length - 1];
    if (previous && Math.hypot(x - previous.x, y - previous.y) < 0.35) continue;
    trajectory.points.push(point);
    if (trajectory.points.length > maxPointsPerTrack) {
      trajectory.points = trajectory.points.filter((_, index) => index % 2 === 0);
    }
  }
  const payload = [...trajectories.values()]
    .map((trajectory) => {
      const lastPoint = trajectory.points[trajectory.points.length - 1];
      if (
        trajectory.observations >= 2 &&
        trajectory.lastObserved &&
        lastPoint &&
        Math.hypot(
          trajectory.lastObserved.x - lastPoint.x,
          trajectory.lastObserved.y - lastPoint.y,
        ) >= 0.001
      ) {
        trajectory.points.push(trajectory.lastObserved);
      }
      return {
        trackId: trajectory.trackId,
        class: trajectory.class,
        points: trajectory.points,
      };
    })
    .filter((trajectory) => trajectory.points.length >= 2);
  await writeJsonAtomic(path.join(getJobDir(videoId), "trajectory_preview.json"), payload);
  return payload;
}

async function readTrajectoryPreview(videoId) {
  const previewPath = path.join(getJobDir(videoId), "trajectory_preview.json");
  if (!(await pathExists(previewPath))) return [];
  return JSON.parse(await fsPromises.readFile(previewPath, "utf8"));
}

async function synchronizeCloudJob(videoId) {
  const videoCloud = getVideoOrchestrator();
  if (!videoCloud.isCloudMode()) return getVideoJob(videoId);
  const localJob = await getVideoJob(videoId);
  const cloudJob = await videoCloud.getCloudJob(videoId);
  if (!cloudJob) return localJob;
  if (cloudJob.updatedAt === localJob.cloudUpdatedAt) return localJob;

  if (["ready", "failed"].includes(cloudJob.status) || cloudJob.countsStatus === "ready") {
    await videoCloud.downloadArtifacts(videoId, getJobDir(videoId), getOutputDir(videoId));
  }
  let zones = localJob.zones || [];
  let suggestedZones = localJob.suggestedZones || [];
  const zonesPath = path.join(getJobDir(videoId), "zones.json");
  if (await pathExists(zonesPath)) {
    suggestedZones = JSON.parse(await fsPromises.readFile(zonesPath, "utf8"));
    // The worker's zones.json contains tracking suggestions, not subsequent edits.
    if (!localJob.zonesEditedAt) zones = suggestedZones;
  }
  const synchronized = await updateVideoJob(videoId, {
    status: cloudJob.status || localJob.status,
    countsStatus: cloudJob.countsStatus || localJob.countsStatus,
    error: cloudJob.error || null,
    processingStartedAt: cloudJob.processingStartedAt || localJob.processingStartedAt,
    processingCompletedAt: cloudJob.processingCompletedAt || localJob.processingCompletedAt,
    countsUpdatedAt: cloudJob.countsUpdatedAt || localJob.countsUpdatedAt,
    zones,
    suggestedZones,
    zoneSuggestionMethod: zones.length ? "kmeans-convex-hull" : localJob.zoneSuggestionMethod,
    cloudUpdatedAt: cloudJob.updatedAt,
  });
  await videoCloud.markBackendSynchronized(videoId);
  return synchronized;
}

async function getPublicVideoJob(videoId, userId) {
  const job = await synchronizeCloudJob(videoId);
  assertJobOwner(job, userId);
  return {
    videoId: job.videoId,
    fileName: job.fileName,
    fileSize: job.fileSize,
    contentType: job.contentType,
    durationSeconds: job.durationSeconds,
    width: job.width,
    height: job.height,
    sampledFrameCount: job.sampledFrameCount,
    trafficScene: job.trafficScene,
    processingMode: getProcessorConfig().mode,
    status: job.status,
    countsStatus: job.countsStatus,
    zones: job.zones || [],
    suggestedZones: job.suggestedZones || [],
    zoneSuggestionMethod: job.zoneSuggestionMethod || null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    processingStartedAt: job.processingStartedAt,
    processingCompletedAt: job.processingCompletedAt,
    countsUpdatedAt: job.countsUpdatedAt,
    timing: job.timing || {},
    storageStatus: job.storageStatus || "local",
    storage: job.storage || null,
    counts: await readCounts(videoId),
    trajectories: await readTrajectoryPreview(videoId),
    artifacts: {
      preview: await pathExists(path.join(getJobDir(videoId), "preview.jpg")),
      tracks: await pathExists(path.join(getOutputDir(videoId), "tracks.csv")),
      annotatedVideo: await pathExists(path.join(getOutputDir(videoId), "annotated.mp4")),
      countsCsv: await pathExists(path.join(getOutputDir(videoId), "movement_counts.csv")),
      trajectoryPreview: await pathExists(path.join(getJobDir(videoId), "trajectory_preview.json")),
    },
  };
}

async function getArtifactPath(videoId, userId, artifact) {
  const job = await synchronizeCloudJob(videoId);
  assertJobOwner(job, userId);
  const artifactPaths = {
    preview: path.join(getJobDir(videoId), "preview.jpg"),
    tracks: path.join(getOutputDir(videoId), "tracks.csv"),
    counts: path.join(getOutputDir(videoId), "movement_counts.csv"),
    annotated: path.join(getOutputDir(videoId), "annotated.mp4"),
  };
  const artifactPath = artifactPaths[artifact];
  if (!artifactPath || !(await pathExists(artifactPath))) {
    const error = new Error("Video artifact not found");
    error.statusCode = 404;
    throw error;
  }
  return artifactPath;
}

module.exports = {
  JOBS_ROOT,
  assertJobOwner,
  buildTrajectoryPreview,
  createVideoJob,
  getArtifactPath,
  getJobDir,
  getOutputDir,
  getProcessorConfig,
  getPublicVideoJob,
  getVideoJob,
  normalizeZone,
  parseCsvLine,
  readCounts,
  readTrajectoryPreview,
  replaceZonesWithSuggestions,
  recoverInterruptedVideoJobs,
  removeVideoJob,
  remoteJobPaths,
  recountMovements,
  runCommand,
  runRemoteDeepStreamTracking,
  runRemoteMovementRecount,
  uploadRemoteVideo,
  savePreview,
  saveZones,
  startVideoProcessing,
  suggestTrafficZones,
  synchronizeCloudJob,
  updateVideoJob,
  zonesToGeoJson,
};
