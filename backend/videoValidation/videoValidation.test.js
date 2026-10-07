const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_VIDEO_DURATION_SECONDS,
  assertAllowedDuration,
  chooseFrameTimestamps,
  getVideoMetadata,
} = require("./videoMetadata");
const { extractVideoFrames } = require("./frameExtractor");
const { verifyVideoTooling } = require("./tooling");
const {
  DEFAULT_TRAFFIC_SCENE_MODEL,
  checkTrafficSceneWithOpenAI,
} = require("./trafficSceneChecker");

test("assertAllowedDuration rejects videos longer than eight hours", () => {
  assert.throws(
    () => assertAllowedDuration(MAX_VIDEO_DURATION_SECONDS + 1),
    /Video duration must be 8 hours or shorter/,
  );
});

test("chooseFrameTimestamps selects between 10 and 50 timestamps across the video", () => {
  const timestamps = chooseFrameTimestamps(8 * 60 * 60);

  assert.equal(timestamps.length, 50);
  assert.equal(timestamps[0], 1);
  assert(timestamps[timestamps.length - 1] < 8 * 60 * 60);
  assert(timestamps.every((value, index) => index === 0 || value > timestamps[index - 1]));
});

test("chooseFrameTimestamps returns fewer unique timestamps for short videos", () => {
  const timestamps = chooseFrameTimestamps(5);

  assert.deepEqual(timestamps, [1, 2, 3, 4]);
});

test("checkTrafficSceneWithOpenAI sends image data and returns structured verdict", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    isTrafficCameraFootage: true,
                    confidence: "high",
                    explanation: "Fixed camera view of a road intersection.",
                  }),
                },
              ],
            },
          ],
        };
      },
    };
  };

  const result = await checkTrafficSceneWithOpenAI({
    framePaths: [__filename],
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });

  assert.equal(result.isTrafficCameraFootage, true);
  assert.equal(result.confidence, "high");
  assert.match(result.explanation, /intersection/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");

  const requestBody = JSON.parse(calls[0].options.body);
  assert.equal(requestBody.model, DEFAULT_TRAFFIC_SCENE_MODEL);
  const imageParts = requestBody.input[0].content.filter((part) => part.type === "input_image");
  assert.equal(imageParts.length, 1);
  assert.match(imageParts[0].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(imageParts[0].detail, "low");
});

test("checkTrafficSceneWithOpenAI reports unavailable model with override guidance", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    async json() {
      return {
        error: {
          message: "Project does not have access to model gpt-test",
        },
      };
    },
  });

  await assert.rejects(
    () =>
      checkTrafficSceneWithOpenAI({
        framePaths: [__filename],
        apiKey: "test-key",
        fetchImpl: fakeFetch,
        model: "gpt-test",
      }),
    (error) => {
      assert.equal(error.code, "OPENAI_TRAFFIC_SCENE_UNAVAILABLE");
      assert.match(error.message, /Set OPENAI_TRAFFIC_SCENE_MODEL/);
      return true;
    },
  );
});

test("checkTrafficSceneWithOpenAI rejects malformed structured output", async () => {
  const fakeFetch = async () => ({
    ok: true,
    async json() {
      return { output_text: JSON.stringify({ isTrafficCameraFootage: "yes" }) };
    },
  });

  await assert.rejects(
    () =>
      checkTrafficSceneWithOpenAI({
        framePaths: [__filename],
        apiKey: "test-key",
        fetchImpl: fakeFetch,
      }),
    (error) => error.code === "OPENAI_TRAFFIC_SCENE_UNAVAILABLE",
  );
});

test("checkTrafficSceneWithOpenAI rejects an invalid timeout configuration", async () => {
  await assert.rejects(
    () =>
      checkTrafficSceneWithOpenAI({
        framePaths: [__filename],
        apiKey: "test-key",
        fetchImpl: async () => assert.fail("fetch should not run"),
        timeoutMs: 0,
      }),
    (error) => {
      assert.equal(error.code, "OPENAI_TRAFFIC_SCENE_UNAVAILABLE");
      assert.match(error.message, /must be a positive number/);
      return true;
    },
  );
});

test("getVideoMetadata uses configured ffprobe path", async () => {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(
      null,
      JSON.stringify({
        format: { duration: "120.5" },
        streams: [{ width: 1920, height: 1080 }],
      }),
      "",
    );
  };

  const metadata = await getVideoMetadata("/tmp/video.mp4", {
    execFileImpl,
    ffprobePath: "/custom/bin/ffprobe",
  });

  assert.equal(metadata.durationSeconds, 120.5);
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(calls[0].command, "/custom/bin/ffprobe");
});

test("extractVideoFrames uses configured ffmpeg path", async () => {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, "", "");
  };

  const result = await extractVideoFrames("/tmp/video.mp4", [1], {
    execFileImpl,
    ffmpegPath: "/custom/bin/ffmpeg",
  });

  assert.equal(calls[0].command, "/custom/bin/ffmpeg");
  assert.equal(result.framePaths.length, 1);
});

test("extractVideoFrames hides raw ffmpeg stderr from user-facing errors", async () => {
  const execFileImpl = (command, args, options, callback) => {
    callback(
      new Error("Command failed: ffmpeg -y -ss 6 -i /private/path/video.mp4"),
      "",
      "ffmpeg version 8.1.2 lots of encoder output Conversion failed!",
    );
  };

  await assert.rejects(
    () => extractVideoFrames("/tmp/video.mp4", [1], { execFileImpl }),
    (error) => {
      assert.match(error.message, /Could not extract preview frames/);
      assert.match(error.message, /Please upload a standard MP4 or MOV traffic video/);
      assert.doesNotMatch(error.message, /ffmpeg version/);
      assert.doesNotMatch(error.message, /private\/path/);
      return true;
    },
  );
});

test("verifyVideoTooling reports missing ffprobe with actionable message", async () => {
  const execFileImpl = (command, args, options, callback) => {
    if (command === "missing-ffprobe") {
      const error = new Error(`spawn ${command} ENOENT`);
      error.code = "ENOENT";
      callback(error, "", "");
      return;
    }
    callback(null, "ffmpeg version test", "");
  };

  const result = await verifyVideoTooling({ execFileImpl, ffprobePath: "missing-ffprobe" });

  assert.equal(result.ok, false);
  assert.equal(result.missingTools.length, 1);
  assert.equal(result.missingTools[0].name, "ffprobe");
  assert.match(result.message, /Install ffmpeg/);
  assert.match(result.message, /FFPROBE_PATH/);
});
