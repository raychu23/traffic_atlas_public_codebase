const fsPromises = require("fs/promises");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TRAFFIC_SCENE_MODEL = "gpt-4o";

const trafficSceneSchema = {
  type: "object",
  properties: {
    isTrafficCameraFootage: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    explanation: { type: "string" },
  },
  required: ["isTrafficCameraFootage", "confidence", "explanation"],
  additionalProperties: false,
};

function extractOutputText(responseBody) {
  if (typeof responseBody?.output_text === "string") {
    return responseBody.output_text;
  }
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
    }
  }
  return "";
}

async function framePathToImagePart(framePath) {
  const base64Image = await fsPromises.readFile(framePath, "base64");
  return {
    type: "input_image",
    image_url: `data:image/jpeg;base64,${base64Image}`,
  };
}

async function checkTrafficSceneWithOpenAI({
  framePaths,
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = global.fetch,
  model = process.env.OPENAI_TRAFFIC_SCENE_MODEL || DEFAULT_TRAFFIC_SCENE_MODEL,
  timeoutMs = Number(process.env.OPENAI_TRAFFIC_SCENE_TIMEOUT_MS || 30_000),
} = {}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the backend server.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to call OpenAI.");
  }
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    throw new Error("At least one sampled frame is required.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const error = new Error("OPENAI_TRAFFIC_SCENE_TIMEOUT_MS must be a positive number.");
    error.code = "OPENAI_TRAFFIC_SCENE_UNAVAILABLE";
    throw error;
  }

  const imageParts = await Promise.all(framePaths.map(framePathToImagePart));
  imageParts.forEach((part) => {
    part.detail = "low";
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseBody;
  try {
    response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Classify whether these sampled frames show traffic-camera footage suitable for vehicle tracking. " +
                  "Accept roadways, intersections, highways, and parking areas with visible vehicle movement. " +
                  "Reject unrelated, synthetic, or screen-recorded content.",
              },
              ...imageParts,
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "traffic_scene_validation",
            strict: true,
            schema: trafficSceneSchema,
          },
        },
      }),
    });
    responseBody = await response.json().catch(() => ({}));
  } catch (error) {
    const unavailable = new Error(
      error.name === "AbortError"
        ? "OpenAI traffic-scene check timed out"
        : `OpenAI traffic-scene check failed: ${error.message}`,
    );
    unavailable.code = "OPENAI_TRAFFIC_SCENE_UNAVAILABLE";
    throw unavailable;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const apiMessage = responseBody?.error?.message || `HTTP ${response.status}`;
    const error = new Error(
      `OpenAI traffic-scene check failed for model "${model}": ${apiMessage}. ` +
        "Set OPENAI_TRAFFIC_SCENE_MODEL to a vision-capable model available to this OpenAI project.",
    );
    error.code = "OPENAI_TRAFFIC_SCENE_UNAVAILABLE";
    throw error;
  }

  const outputText = extractOutputText(responseBody);
  if (!outputText) {
    throw new Error("OpenAI traffic-scene check returned no structured text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new Error(`OpenAI traffic-scene check returned invalid JSON: ${error.message}`);
  }

  if (
    typeof parsed.isTrafficCameraFootage !== "boolean" ||
    !["low", "medium", "high"].includes(parsed.confidence) ||
    typeof parsed.explanation !== "string"
  ) {
    const error = new Error("OpenAI traffic-scene check returned an invalid result.");
    error.code = "OPENAI_TRAFFIC_SCENE_UNAVAILABLE";
    throw error;
  }

  return {
    isTrafficCameraFootage: parsed.isTrafficCameraFootage,
    confidence: parsed.confidence,
    explanation: parsed.explanation.slice(0, 500),
  };
}

module.exports = {
  DEFAULT_TRAFFIC_SCENE_MODEL,
  checkTrafficSceneWithOpenAI,
  extractOutputText,
  trafficSceneSchema,
};
