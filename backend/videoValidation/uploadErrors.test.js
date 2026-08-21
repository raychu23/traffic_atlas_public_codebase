const assert = require("node:assert/strict");
const test = require("node:test");

const { getVideoUploadErrorResponse } = require("./uploadErrors");

test("does not expose OpenAI service details to upload clients", () => {
  const error = new Error('OpenAI traffic-scene check failed: project "internal" is unavailable');
  error.code = "OPENAI_TRAFFIC_SCENE_UNAVAILABLE";

  const response = getVideoUploadErrorResponse(error);

  assert.equal(response.status, 503);
  assert.equal(
    response.message,
    "Traffic-scene validation is temporarily unavailable. Try again later.",
  );
  assert.doesNotMatch(response.message, /internal/);
});

test("preserves a rejected scene explanation for the uploader", () => {
  const error = new Error("The sampled frames do not contain a roadway.");
  error.code = "NOT_TRAFFIC_CAMERA_FOOTAGE";
  error.scene = { isTrafficCameraFootage: false, confidence: "high" };

  const response = getVideoUploadErrorResponse(error);

  assert.equal(response.status, 422);
  assert.equal(response.message, error.message);
  assert.equal(response.trafficScene, error.scene);
});

test("replaces unexpected internal errors with a generic response", () => {
  const response = getVideoUploadErrorResponse(
    new Error("ENOENT: missing /private/internal/path/job.json"),
  );

  assert.equal(response.status, 500);
  assert.equal(response.message, "Unable to process the video upload.");
});
