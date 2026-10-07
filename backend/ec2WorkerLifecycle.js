const {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} = require("@aws-sdk/client-ec2");

let client;
let operationTail = Promise.resolve();
let idleTimer = null;
let timerFunctions = {
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
};

function getConfig() {
  const config = {
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    instanceId: process.env.TRAFFIC_EC2_INSTANCE_ID || "",
    sshUser: process.env.TRAFFIC_EC2_SSH_USER || "ubuntu",
    idleSeconds: Number(process.env.TRAFFIC_EC2_IDLE_SECONDS || 300),
    pollMilliseconds: Number(process.env.TRAFFIC_EC2_POLL_MS || 5000),
    startTimeoutSeconds: Number(process.env.TRAFFIC_EC2_START_TIMEOUT_SECONDS || 600),
  };
  if (!/^i-[0-9a-f]+$/i.test(config.instanceId)) {
    throw new Error("TRAFFIC_EC2_INSTANCE_ID is missing or invalid");
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(config.sshUser)) {
    throw new Error("TRAFFIC_EC2_SSH_USER is invalid");
  }
  for (const [name, value] of [
    ["TRAFFIC_EC2_IDLE_SECONDS", config.idleSeconds],
    ["TRAFFIC_EC2_POLL_MS", config.pollMilliseconds],
    ["TRAFFIC_EC2_START_TIMEOUT_SECONDS", config.startTimeoutSeconds],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  return config;
}

function getClient(config = getConfig()) {
  if (!client) client = new EC2Client({ region: config.region });
  return client;
}

function setClientForTests(nextClient) {
  client = nextClient;
}

function setTimerFunctionsForTests(nextTimerFunctions) {
  timerFunctions = nextTimerFunctions;
}

function sleep(milliseconds) {
  return new Promise((resolve) => timerFunctions.setTimeout(resolve, milliseconds));
}

async function describeInstance(config, ec2) {
  const response = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [config.instanceId] }),
  );
  const instance = response.Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`EC2 worker ${config.instanceId} was not found`);
  return instance;
}

async function waitForState(config, ec2, acceptedStates) {
  const deadline = Date.now() + config.startTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const instance = await describeInstance(config, ec2);
    if (acceptedStates.includes(instance.State?.Name)) return instance;
    await sleep(config.pollMilliseconds);
  }
  throw new Error(
    `EC2 worker ${config.instanceId} did not reach ${acceptedStates.join(" or ")} within ${config.startTimeoutSeconds} seconds`,
  );
}

async function waitForStatusChecks(config, ec2) {
  const deadline = Date.now() + config.startTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await ec2.send(
      new DescribeInstanceStatusCommand({
        InstanceIds: [config.instanceId],
        IncludeAllInstances: true,
      }),
    );
    const status = response.InstanceStatuses?.[0];
    if (
      status?.InstanceState?.Name === "running" &&
      status?.InstanceStatus?.Status === "ok" &&
      status?.SystemStatus?.Status === "ok"
    ) {
      return;
    }
    await sleep(config.pollMilliseconds);
  }
  throw new Error(
    `EC2 worker ${config.instanceId} did not pass status checks within ${config.startTimeoutSeconds} seconds`,
  );
}

async function ensureWorkerRunning() {
  const config = getConfig();
  const ec2 = getClient(config);
  let instance = await describeInstance(config, ec2);
  let state = instance.State?.Name;
  if (state === "stopping") {
    instance = await waitForState(config, ec2, ["stopped"]);
    state = instance.State?.Name;
  }
  if (state === "stopped") {
    await ec2.send(new StartInstancesCommand({ InstanceIds: [config.instanceId] }));
    instance = await waitForState(config, ec2, ["running"]);
  } else if (state === "pending") {
    instance = await waitForState(config, ec2, ["running"]);
  } else if (state !== "running") {
    throw new Error(
      `EC2 worker ${config.instanceId} cannot start from state ${state || "unknown"}`,
    );
  }
  await waitForStatusChecks(config, ec2);
  instance = await describeInstance(config, ec2);
  const hostname = instance.PublicDnsName || instance.PublicIpAddress;
  if (!hostname) {
    throw new Error(`EC2 worker ${config.instanceId} has no reachable public hostname`);
  }
  return {
    instanceId: config.instanceId,
    hostname,
    remoteHost: `${config.sshUser}@${hostname}`,
  };
}

async function stopWorker() {
  const config = getConfig();
  const ec2 = getClient(config);
  const instance = await describeInstance(config, ec2);
  if (["stopped", "stopping"].includes(instance.State?.Name)) return instance.State.Name;
  await ec2.send(new StopInstancesCommand({ InstanceIds: [config.instanceId] }));
  return "stopping";
}

function cancelIdleStop() {
  if (!idleTimer) return;
  timerFunctions.clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleStop() {
  const config = getConfig();
  cancelIdleStop();
  idleTimer = timerFunctions.setTimeout(() => {
    idleTimer = null;
    stopWorker().catch((error) => {
      console.error(`Unable to stop idle EC2 worker ${config.instanceId}:`, error);
    });
  }, config.idleSeconds * 1000);
  idleTimer?.unref?.();
}

function runWithWorker(operation) {
  const run = operationTail
    .catch(() => {})
    .then(async () => {
      cancelIdleStop();
      try {
        const connection = await ensureWorkerRunning();
        return await operation(connection);
      } finally {
        scheduleIdleStop();
      }
    });
  operationTail = run;
  return run;
}

module.exports = {
  cancelIdleStop,
  describeInstance,
  ensureWorkerRunning,
  getConfig,
  runWithWorker,
  scheduleIdleStop,
  setClientForTests,
  setTimerFunctionsForTests,
  stopWorker,
  waitForState,
  waitForStatusChecks,
};
