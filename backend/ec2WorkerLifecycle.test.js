const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AWS_REGION = "us-east-1";
process.env.TRAFFIC_EC2_INSTANCE_ID = "i-0123456789abcdef0";
process.env.TRAFFIC_EC2_SSH_USER = "ubuntu";
process.env.TRAFFIC_EC2_IDLE_SECONDS = "300";
process.env.TRAFFIC_EC2_POLL_MS = "1";
process.env.TRAFFIC_EC2_START_TIMEOUT_SECONDS = "30";

const {
  ensureWorkerRunning,
  getConfig,
  runWithWorker,
  cancelIdleStop,
  setClientForTests,
  setTimerFunctionsForTests,
  stopWorker,
} = require("./ec2WorkerLifecycle");

function instance(state, overrides = {}) {
  return {
    InstanceId: "i-0123456789abcdef0",
    State: { Name: state },
    ...overrides,
  };
}

test("validates the on-demand EC2 worker configuration", () => {
  const config = getConfig();
  assert.equal(config.instanceId, "i-0123456789abcdef0");
  assert.equal(config.sshUser, "ubuntu");
  assert.equal(config.idleSeconds, 300);
});

test("starts a stopped worker, waits for health, and discovers its current hostname", async () => {
  const commands = [];
  let describeCount = 0;
  setClientForTests({
    async send(command) {
      const name = command.constructor.name;
      commands.push(name);
      if (name === "DescribeInstancesCommand") {
        describeCount += 1;
        const value =
          describeCount === 1
            ? instance("stopped")
            : instance("running", {
                PublicDnsName: "ec2-203-0-113-10.compute-1.amazonaws.com",
              });
        return { Reservations: [{ Instances: [value] }] };
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

  const connection = await ensureWorkerRunning();
  assert.equal(
    connection.remoteHost,
    "ubuntu@ec2-203-0-113-10.compute-1.amazonaws.com",
  );
  assert.deepEqual(commands, [
    "DescribeInstancesCommand",
    "StartInstancesCommand",
    "DescribeInstancesCommand",
    "DescribeInstanceStatusCommand",
    "DescribeInstancesCommand",
  ]);
});

test("stops a running worker and leaves a stopped worker unchanged", async () => {
  const commands = [];
  let state = "running";
  setClientForTests({
    async send(command) {
      const name = command.constructor.name;
      commands.push(name);
      if (name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [instance(state)] }] };
      }
      if (name === "StopInstancesCommand") state = "stopping";
      return {};
    },
  });

  assert.equal(await stopWorker(), "stopping");
  state = "stopped";
  assert.equal(await stopWorker(), "stopped");
  assert.deepEqual(commands, [
    "DescribeInstancesCommand",
    "StopInstancesCommand",
    "DescribeInstancesCommand",
  ]);
});

test("failed health check after starting still schedules idle shutdown", async () => {
  let state = "stopped";
  const timers = [];
  setTimerFunctionsForTests({
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return { unref() {} };
    },
    clearTimeout() {},
  });
  setClientForTests({
    async send(command) {
      const name = command.constructor.name;
      if (name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [instance(state)] }] };
      }
      if (name === "StartInstancesCommand") state = "running";
      if (name === "DescribeInstanceStatusCommand")
        throw new Error("health check unavailable");
      return {};
    },
  });
  try {
    await assert.rejects(
      runWithWorker(async () =>
        assert.fail("processing must not start before health checks"),
      ),
      /health check unavailable/,
    );
    assert.equal(state, "running");
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 300000);
  } finally {
    cancelIdleStop();
    setTimerFunctionsForTests({
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
    });
  }
});
