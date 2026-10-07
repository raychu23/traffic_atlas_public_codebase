const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const testRoot = path.join(os.tmpdir(), `traffic-atlas-video-jobs-${process.pid}`);
process.env.TRAFFIC_VIDEO_JOBS_ROOT = testRoot;

const {
  buildTrajectoryPreview,
  createVideoJob,
  getOutputDir,
  getPublicVideoJob,
  getVideoJob,
  recoverInterruptedVideoJobs,
  removeVideoJob,
  saveZones,
  startVideoProcessing,
  suggestTrafficZones,
  uploadRemoteVideo,
  updateVideoJob,
  zonesToGeoJson,
} = require("./videoJobs");
const { setClientsForTests } = require("./videoCloudOrchestrator");
const { cancelIdleStop, setClientForTests: setEc2ClientForTests } = require("./ec2WorkerLifecycle");

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

function baseJob(videoId, sourceVideoPath) {
  return {
    videoId,
    userId: "user-1",
    sourceVideoPath,
    fileName: "traffic.mp4",
    fileSize: 1234,
    contentType: "video/mp4",
    durationSeconds: 60,
    width: 100,
    height: 100,
    sampledFrameCount: 10,
    trafficScene: { isTrafficCameraFootage: true, confidence: "high" },
  };
}

test("development watcher excludes persistent JSON job state", async () => {
  const nodemonConfig = JSON.parse(
    await fs.readFile(path.join(__dirname, "..", "nodemon.json"), "utf8"),
  );
  const watchedExtensions = String(nodemonConfig.ext || "")
    .split(",")
    .map((extension) => extension.trim());

  assert.equal(watchedExtensions.includes("json"), false);
  assert.ok(nodemonConfig.ignore.includes("backend/data/**"));
  assert.ok(nodemonConfig.ignore.includes("backend/uploads/**"));
});

test("remote video upload retries a transient SSH transport failure before using SCP", async () => {
  const priorAttempts = process.env.TRAFFIC_TRANSFER_MAX_ATTEMPTS;
  const priorDelay = process.env.TRAFFIC_TRANSFER_RETRY_DELAY_MS;
  process.env.TRAFFIC_TRANSFER_MAX_ATTEMPTS = "3";
  process.env.TRAFFIC_TRANSFER_RETRY_DELAY_MS = "0";
  const calls = [];
  try {
    const uploadMethod = await uploadRemoteVideo(
      "/tmp/source.mp4",
      "/srv/traffic-video/data/inbox/test/input.mp4",
      { remoteHost: "ubuntu@example.test", remoteSshKey: "/tmp/test.pem" },
      "/tmp/traffic-upload.log",
      async (command) => {
        calls.push(command);
        if (command === "rsync" && calls.filter((value) => value === "rsync").length === 1) {
          throw new Error("Connection reset by peer");
        }
      },
    );
    assert.equal(uploadMethod, "rsync-retry-2");
    assert.deepEqual(calls, ["rsync", "rsync"]);
  } finally {
    if (priorAttempts === undefined) delete process.env.TRAFFIC_TRANSFER_MAX_ATTEMPTS;
    else process.env.TRAFFIC_TRANSFER_MAX_ATTEMPTS = priorAttempts;
    if (priorDelay === undefined) delete process.env.TRAFFIC_TRANSFER_RETRY_DELAY_MS;
    else process.env.TRAFFIC_TRANSFER_RETRY_DELAY_MS = priorDelay;
  }
});

test("zonesToGeoJson closes rings and converts normalized points to pixels", () => {
  const result = zonesToGeoJson(
    [
      {
        id: "west",
        label: "West",
        color: "#00847c",
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
          { x: 50, y: 100 },
          { x: 0, y: 100 },
        ],
      },
    ],
    200,
    100,
  );
  assert.deepEqual(result.features[0].geometry.coordinates[0], [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    [0, 0],
  ]);
});

test("trajectory preview preserves endpoints for slowly moving tracks", async () => {
  const videoId = crypto.randomUUID();
  const outputDir = getOutputDir(videoId);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "tracks.csv"),
    [
      "frame,time_s,track_id,class,conf,x1,y1,x2,y2,cx,cy",
      "1,0,7,car,0.9,155,90,166,100,160.531,94.481",
      "2,1,7,car,0.9,155,90,166,100,160.243,94.715",
    ].join("\n"),
  );

  const result = await buildTrajectoryPreview(videoId, 480, 270);

  assert.equal(result.length, 1);
  assert.equal(result[0].trackId, "7");
  assert.equal(result[0].points.length, 2);
  assert.equal(result[0].observations, undefined);
  assert.equal(result[0].lastObserved, undefined);
});

test("K-means suggestions use moving road-user endpoints and convex hulls", () => {
  const clusterCenters = [
    [10, 20],
    [90, 20],
    [90, 80],
    [10, 80],
  ];
  const trajectories = Array.from({ length: 12 }, (_, index) => {
    const from = clusterCenters[index % clusterCenters.length];
    const to = clusterCenters[(index + 1) % clusterCenters.length];
    const jitter = (index % 3) - 1;
    return {
      trackId: String(index),
      class: "car",
      points: [
        { x: from[0] + jitter, y: from[1] - jitter },
        { x: 50, y: 50 },
        { x: to[0] - jitter, y: to[1] + jitter },
      ],
    };
  });
  trajectories.push({
    trackId: "sign",
    class: "road_sign",
    points: [
      { x: 50, y: 1 },
      { x: 50, y: 99 },
    ],
  });
  trajectories.push({
    trackId: "parked",
    class: "car",
    points: [
      { x: 50, y: 50 },
      { x: 50.5, y: 50.5 },
    ],
  });

  const zones = suggestTrafficZones(trajectories, 1000, 1000);

  assert.equal(zones.length, 4);
  assert.ok(zones.every((zone) => zone.points.length >= 3));
  assert.ok(zones.every((zone) => zone.points.every((point) => point.x >= 0 && point.x <= 100)));
  assert.ok(zones.every((zone) => zone.points.every((point) => point.y >= 0 && point.y <= 100)));
  assert.ok(zones[0].points.every((point) => point.x < 30));
  assert.ok(zones[3].points.every((point) => point.x > 70));
});

test("backend restart recovery makes interrupted processing jobs retryable", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  await fs.mkdir(testRoot, { recursive: true });
  await fs.writeFile(sourceVideoPath, "video");
  await createVideoJob(baseJob(videoId, sourceVideoPath));
  await updateVideoJob(videoId, {
    status: "processing",
    processingStartedAt: new Date().toISOString(),
  });

  const recovered = await recoverInterruptedVideoJobs();
  const job = await getVideoJob(videoId);

  assert.equal(recovered, 1);
  assert.equal(job.status, "failed");
  assert.match(job.error, /interrupted by a backend restart/i);
});

test("removeVideoJob clears a partially created job", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  await fs.mkdir(testRoot, { recursive: true });
  await fs.writeFile(sourceVideoPath, "video");
  await createVideoJob(baseJob(videoId, sourceVideoPath));

  await removeVideoJob(videoId);

  await assert.rejects(
    () => getVideoJob(videoId),
    (error) => error.statusCode === 404,
  );
});

test("tracking, trajectory preview, zone persistence, and recount share one job", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  await fs.mkdir(testRoot, { recursive: true });
  await fs.writeFile(sourceVideoPath, "video");
  await createVideoJob(baseJob(videoId, sourceVideoPath));

  const calls = [];
  const commandRunner = async (command, args) => {
    calls.push({ command, args });
    const outputIndex = args.indexOf("--out");
    if (outputIndex >= 0) {
      const outputDir = args[outputIndex + 1];
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, "tracks.csv"),
        [
          "frame,time_s,track_id,class,conf,x1,y1,x2,y2,cx,cy",
          "1,0,7,car,0.9,5,45,15,55,10,50",
          "2,1,7,car,0.9,45,45,55,55,50,50",
          "3,2,7,car,0.9,85,45,95,55,90,50",
        ].join("\n"),
      );
      return;
    }
    const countOutputIndex = args.indexOf("--output");
    assert.notEqual(countOutputIndex, -1);
    await fs.writeFile(
      args[countOutputIndex + 1],
      "bin_start_s,bin_end_s,class,from_zone,to_zone,count\n0,900,car,West,East,1\n",
    );
  };

  await startVideoProcessing(videoId, { commandRunner });
  let publicJob = await getPublicVideoJob(videoId, "user-1");
  assert.equal(publicJob.status, "ready");
  assert.equal(publicJob.trajectories.length, 1);
  assert.equal(publicJob.trajectories[0].trackId, "7");

  publicJob = await saveZones(
    videoId,
    "user-1",
    [
      {
        id: "west",
        label: "West",
        points: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 100 },
          { x: 0, y: 100 },
        ],
      },
      {
        id: "east",
        label: "East",
        points: [
          { x: 60, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 60, y: 100 },
        ],
      },
    ],
    { commandRunner },
  );
  assert.equal(publicJob.countsStatus, "ready");
  assert.deepEqual(publicJob.counts, [
    {
      bin_start_s: "0",
      bin_end_s: "900",
      class: "car",
      from_zone: "West",
      to_zone: "East",
      count: "1",
    },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(path.dirname(path.join(getOutputDir(videoId), "tracks.csv")), getOutputDir(videoId));
});

test("video jobs reject reads from another user", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  await fs.writeFile(sourceVideoPath, "video");
  await createVideoJob(baseJob(videoId, sourceVideoPath));
  assert.equal((await getVideoJob(videoId)).userId, "user-1");
  await assert.rejects(
    () => getPublicVideoJob(videoId, "user-2"),
    (error) => error.statusCode === 403,
  );
});

test("remote EC2 mode uses the reference YOLO traffic tracker and recounts zones there", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  const fakeKeyPath = path.join(testRoot, `${videoId}.pem`);
  await fs.writeFile(sourceVideoPath, "video");
  await fs.writeFile(fakeKeyPath, "key");
  await createVideoJob(baseJob(videoId, sourceVideoPath));

  const previousEnv = {
    mode: process.env.TRAFFIC_PROCESSOR_MODE,
    host: process.env.TRAFFIC_DEEPSTREAM_HOST,
    key: process.env.TRAFFIC_DEEPSTREAM_SSH_KEY,
    root: process.env.TRAFFIC_DEEPSTREAM_ROOT,
    maxFrames: process.env.TRAFFIC_DEEPSTREAM_MAX_FRAMES,
    remoteTracker: process.env.TRAFFIC_REMOTE_TRACKER,
    yoloImage: process.env.TRAFFIC_YOLO_REMOTE_IMAGE,
  };
  process.env.TRAFFIC_PROCESSOR_MODE = "deepstream-ssh";
  process.env.TRAFFIC_DEEPSTREAM_HOST = "ubuntu@example.test";
  process.env.TRAFFIC_DEEPSTREAM_SSH_KEY = fakeKeyPath;
  process.env.TRAFFIC_DEEPSTREAM_ROOT = "/srv/traffic-video";
  process.env.TRAFFIC_DEEPSTREAM_MAX_FRAMES = "300";
  process.env.TRAFFIC_REMOTE_TRACKER = "yolo-traffic";
  process.env.TRAFFIC_YOLO_REMOTE_IMAGE = "traffic-yolo:cam5-reference";

  const calls = [];
  const commandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command !== "scp") return;
    const remoteSource = args[args.length - 2];
    const localDestination = args[args.length - 1];
    if (!String(remoteSource).includes(":")) return;
    if (remoteSource.endsWith("/tracks.csv")) {
      await fs.writeFile(
        localDestination,
        "frame,time_s,track_id,class,conf,x1,y1,x2,y2,cx,cy\n1,0,9,car,0.9,0,0,10,10,5,5\n2,1,9,car,0.9,80,80,90,90,85,85\n",
      );
    } else if (remoteSource.endsWith("/movement_counts.csv")) {
      await fs.writeFile(
        localDestination,
        "bin_start_s,bin_end_s,class,from_zone,to_zone,count\n0,900,car,Left,Right,1\n",
      );
    }
  };

  try {
    await startVideoProcessing(videoId, { commandRunner });
    assert.equal(
      calls.some(
        (call) => call.command === "scp" && String(call.args.at(-2)).endsWith("/annotated.mp4"),
      ),
      false,
    );
    const result = await saveZones(
      videoId,
      "user-1",
      [
        {
          id: "left",
          label: "Left",
          points: [
            { x: 0, y: 0 },
            { x: 45, y: 0 },
            { x: 45, y: 100 },
            { x: 0, y: 100 },
          ],
        },
        {
          id: "right",
          label: "Right",
          points: [
            { x: 55, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 55, y: 100 },
          ],
        },
      ],
      { commandRunner },
    );
    assert.equal(result.status, "ready");
    assert.equal(result.countsStatus, "ready");
    assert.equal(result.trajectories.length, 1);
    assert.ok(
      calls.some(
        (call) =>
          call.command === "ssh" &&
          call.args.at(-1).includes("TRAFFIC_YOLO_IMAGE=traffic-yolo:cam5-reference") &&
          call.args
            .at(-1)
            .endsWith(
              "run-yolo-traffic-job.sh /srv/traffic-video/data/inbox/traffic-atlas/" +
                videoId +
                "/input.mp4 /srv/traffic-video/out/traffic-atlas/" +
                videoId +
                " 300",
            ),
      ),
    );
    const upload = calls.find(
      (call) =>
        call.command === "rsync" &&
        call.args.includes("--partial") &&
        call.args.includes("--append") &&
        call.args.at(-1).endsWith(`/input.mp4`),
    );
    assert.ok(upload, "large remote video uploads use resumable rsync first");
    assert.ok(
      calls.some(
        (call) => call.command === "ssh" && call.args.at(-1).includes("run-zone-recount.sh"),
      ),
    );
  } finally {
    if (previousEnv.mode === undefined) delete process.env.TRAFFIC_PROCESSOR_MODE;
    else process.env.TRAFFIC_PROCESSOR_MODE = previousEnv.mode;
    if (previousEnv.host === undefined) delete process.env.TRAFFIC_DEEPSTREAM_HOST;
    else process.env.TRAFFIC_DEEPSTREAM_HOST = previousEnv.host;
    if (previousEnv.key === undefined) delete process.env.TRAFFIC_DEEPSTREAM_SSH_KEY;
    else process.env.TRAFFIC_DEEPSTREAM_SSH_KEY = previousEnv.key;
    if (previousEnv.root === undefined) delete process.env.TRAFFIC_DEEPSTREAM_ROOT;
    else process.env.TRAFFIC_DEEPSTREAM_ROOT = previousEnv.root;
    if (previousEnv.maxFrames === undefined) delete process.env.TRAFFIC_DEEPSTREAM_MAX_FRAMES;
    else process.env.TRAFFIC_DEEPSTREAM_MAX_FRAMES = previousEnv.maxFrames;
    if (previousEnv.remoteTracker === undefined) delete process.env.TRAFFIC_REMOTE_TRACKER;
    else process.env.TRAFFIC_REMOTE_TRACKER = previousEnv.remoteTracker;
    if (previousEnv.yoloImage === undefined) delete process.env.TRAFFIC_YOLO_REMOTE_IMAGE;
    else process.env.TRAFFIC_YOLO_REMOTE_IMAGE = previousEnv.yoloImage;
  }
});

test("production queue mode persists and enqueues tracking without requiring a running EC2 host", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  await fs.writeFile(sourceVideoPath, "video");
  await createVideoJob(baseJob(videoId, sourceVideoPath));
  const previousEnv = {
    mode: process.env.TRAFFIC_PROCESSOR_MODE,
    bucket: process.env.TRAFFIC_VIDEO_BUCKET,
    queue: process.env.TRAFFIC_VIDEO_QUEUE_URL,
    table: process.env.TRAFFIC_VIDEO_JOBS_TABLE,
  };
  process.env.TRAFFIC_PROCESSOR_MODE = "sqs-ec2";
  process.env.TRAFFIC_VIDEO_BUCKET = "traffic-video-test";
  process.env.TRAFFIC_VIDEO_QUEUE_URL =
    "https://sqs.us-east-1.amazonaws.com/123456789012/video.fifo";
  process.env.TRAFFIC_VIDEO_JOBS_TABLE = "traffic-video-jobs-test";
  const calls = [];
  const fakeClient = {
    async send(command) {
      calls.push(command.constructor.name);
      return {};
    },
  };
  setClientsForTests({ s3: fakeClient, sqs: fakeClient, dynamodb: fakeClient });

  try {
    const result = await startVideoProcessing(videoId);
    assert.equal(result.status, "queued");
    assert.equal(result.countsStatus, "awaiting_tracks");
    assert.deepEqual(calls, ["PutObjectCommand", "PutCommand", "SendMessageCommand"]);
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      const environmentName = {
        mode: "TRAFFIC_PROCESSOR_MODE",
        bucket: "TRAFFIC_VIDEO_BUCKET",
        queue: "TRAFFIC_VIDEO_QUEUE_URL",
        table: "TRAFFIC_VIDEO_JOBS_TABLE",
      }[name];
      if (value === undefined) delete process.env[environmentName];
      else process.env[environmentName] = value;
    }
  }
});

test("EC2-only mode starts the stopped instance and uses its discovered hostname", async () => {
  const videoId = crypto.randomUUID();
  const sourceVideoPath = path.join(testRoot, `${videoId}.mp4`);
  const fakeKeyPath = path.join(testRoot, `${videoId}.pem`);
  await fs.writeFile(sourceVideoPath, "video");
  await fs.writeFile(fakeKeyPath, "key");
  await createVideoJob(baseJob(videoId, sourceVideoPath));
  const previousEnv = {
    mode: process.env.TRAFFIC_PROCESSOR_MODE,
    instanceId: process.env.TRAFFIC_EC2_INSTANCE_ID,
    sshUser: process.env.TRAFFIC_EC2_SSH_USER,
    key: process.env.TRAFFIC_DEEPSTREAM_SSH_KEY,
    root: process.env.TRAFFIC_DEEPSTREAM_ROOT,
  };
  process.env.TRAFFIC_PROCESSOR_MODE = "ec2-on-demand-ssh";
  process.env.TRAFFIC_EC2_INSTANCE_ID = "i-0123456789abcdef0";
  process.env.TRAFFIC_EC2_SSH_USER = "ubuntu";
  process.env.TRAFFIC_EC2_POLL_MS = "1";
  process.env.TRAFFIC_EC2_START_TIMEOUT_SECONDS = "30";
  process.env.TRAFFIC_EC2_IDLE_SECONDS = "300";
  process.env.TRAFFIC_DEEPSTREAM_SSH_KEY = fakeKeyPath;
  process.env.TRAFFIC_DEEPSTREAM_ROOT = "/srv/traffic-video";

  const ec2Calls = [];
  let state = "stopped";
  setEc2ClientForTests({
    async send(command) {
      const name = command.constructor.name;
      ec2Calls.push(name);
      if (name === "StartInstancesCommand") state = "running";
      if (name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  State: { Name: state },
                  PublicDnsName: "ec2-current.example.test",
                },
              ],
            },
          ],
        };
      }
      if (name === "DescribeInstanceStatusCommand") {
        return {
          InstanceStatuses: [
            {
              InstanceState: { Name: "running" },
              InstanceStatus: { Status: "ok" },
              SystemStatus: { Status: "ok" },
            },
          ],
        };
      }
      return {};
    },
  });
  const processCalls = [];
  const commandRunner = async (command, args) => {
    processCalls.push({ command, args });
    if (command !== "scp") return;
    const remoteSource = args.at(-2);
    const localDestination = args.at(-1);
    if (!String(remoteSource).includes(":")) return;
    if (remoteSource.endsWith("/tracks.csv")) {
      await fs.writeFile(
        localDestination,
        "frame,time_s,track_id,class,conf,x1,y1,x2,y2,cx,cy\n1,0,9,car,0.9,0,0,10,10,5,5\n2,1,9,car,0.9,80,80,90,90,85,85\n",
      );
    }
  };

  try {
    const result = await startVideoProcessing(videoId, { commandRunner });
    assert.equal(result.status, "ready");
    assert.ok(ec2Calls.includes("StartInstancesCommand"));
    assert.ok(
      processCalls.some(
        (call) => call.command === "ssh" && call.args.includes("ubuntu@ec2-current.example.test"),
      ),
    );
    const timedJob = await getVideoJob(videoId);
    assert.equal(timedJob.timing.remoteUploadMethod, "rsync");
    assert.ok(timedJob.timing.ec2ReadyMilliseconds >= 0);
    assert.ok(timedJob.timing.trackerMilliseconds >= 0);
    assert.equal(
      processCalls.some(
        (call) => call.command === "scp" && String(call.args.at(-2)).endsWith("/annotated.mp4"),
      ),
      false,
    );
  } finally {
    cancelIdleStop();
    const environmentNames = {
      mode: "TRAFFIC_PROCESSOR_MODE",
      instanceId: "TRAFFIC_EC2_INSTANCE_ID",
      sshUser: "TRAFFIC_EC2_SSH_USER",
      key: "TRAFFIC_DEEPSTREAM_SSH_KEY",
      root: "TRAFFIC_DEEPSTREAM_ROOT",
    };
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[environmentNames[name]];
      else process.env[environmentNames[name]] = value;
    }
  }
});
