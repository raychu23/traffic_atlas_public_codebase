/**
 * dataset-build-tagging-input
 * Lists extracted frames from S3 and builds JSONL for Bedrock batch inference.
 *
 * Output:
 * - analysis/bedrock/input/tagging_input.jsonl
 * - analysis/bedrock/manifest/tagging_manifest.json
 * - analysis/bedrock/manifest/video_inventory.json
 */

const AWS = require("aws-sdk");
const s3 = new AWS.S3();

exports.handler = async (event) => {
  console.log("BuildTaggingInput event:", JSON.stringify(event, null, 2));

  const { dataset_id, bucket, frames_prefix } = event;

  if (!dataset_id || !bucket || !frames_prefix) {
    throw new Error("Missing required input: dataset_id, bucket, or frames_prefix");
  }

  try {
    const videoFrames = {};
    let continuationToken = null;
    let totalFrames = 0;

    // --------------------------------------------------
    // 1. List extracted frames from S3
    // --------------------------------------------------
    do {
      const response = await s3
        .listObjectsV2({
          Bucket: bucket,
          Prefix: frames_prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        })
        .promise();

      for (const obj of response.Contents || []) {
        const keyLower = obj.Key.toLowerCase();

        // For now, prefer PNG because Bedrock Playground worked with PNG.
        // JPG is kept here too, but you can remove it later if needed.
        if (!keyLower.endsWith(".png") && !keyLower.endsWith(".jpg") && !keyLower.endsWith(".jpeg")) {
          continue;
        }

        const relativePath = obj.Key.replace(frames_prefix, "");
        const parts = relativePath.split("/").filter(Boolean);

        if (parts.length < 2) {
          console.warn("Skipping frame with unexpected path:", obj.Key);
          continue;
        }

        const videoName = parts[0];
        const frameName = parts[1];
        const frameStem = frameName.replace(/\.[^/.]+$/, "");

        if (!videoFrames[videoName]) {
          videoFrames[videoName] = [];
        }

        videoFrames[videoName].push({
          frame_key: obj.Key,
          frame_name: frameName,
          frame_stem: frameStem,
          s3_uri: `s3://${bucket}/${obj.Key}`,
        });

        totalFrames++;
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    console.log(
      `Found ${totalFrames} frames across ${Object.keys(videoFrames).length} videos`
    );

    if (totalFrames === 0) {
      throw new Error(`No frames found under prefix: ${frames_prefix}`);
    }

    // Keep stable order
    for (const videoName of Object.keys(videoFrames)) {
      videoFrames[videoName].sort((a, b) =>
        a.frame_name.localeCompare(b.frame_name)
      );
    }

    // --------------------------------------------------
    // 2. Prompt for traffic-frame tagging
    // --------------------------------------------------
    const taggingPrompt = `
You are analyzing a traffic video frame for a transportation dataset platform.

Return ONLY valid JSON. Do not include markdown, explanation, or extra text.

Use only the allowed values listed below.

Allowed values:
lighting: daytime, nighttime, dawn_dusk, indoor, unknown
weather: clear, cloudy, rainy, snowy, foggy, wet_road, unknown
road_type: freeway, arterial, local_street, intersection, ramp, parking_area, work_zone, unknown
traffic_density: none, low, medium, high, congested, unknown
vehicle_presence: yes, no, unknown
pedestrian_presence: yes, no, unknown
cyclist_presence: yes, no, unknown
truck_presence: yes, no, unknown
bus_presence: yes, no, unknown
motorcycle_presence: yes, no, unknown
emergency_vehicle_presence: yes, no, unknown

Return this exact JSON structure:
{
  "lighting": "unknown",
  "weather": "unknown",
  "road_type": "unknown",
  "traffic_density": "unknown",
  "vehicle_presence": "unknown",
  "pedestrian_presence": "unknown",
  "cyclist_presence": "unknown",
  "truck_presence": "unknown",
  "bus_presence": "unknown",
  "motorcycle_presence": "unknown",
  "emergency_vehicle_presence": "unknown",
  "short_description": "brief traffic scene description"
}
`.trim();

    // --------------------------------------------------
    // 3. Build Bedrock batch JSONL + manifest
    // --------------------------------------------------
    const jsonlLines = [];
    const taggingManifest = {
      dataset_id,
      bucket,
      frames_prefix,
      created_at: new Date().toISOString(),
      total_frames: totalFrames,
      records: {},
    };

    for (const [videoName, frames] of Object.entries(videoFrames)) {
      for (const frame of frames) {
        const recordId = `${videoName}__${frame.frame_stem}`;

        const jsonlItem = {
          recordId,
          modelInput: {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 700,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "s3",
                      s3_uri: frame.s3_uri,
                    },
                  },
                  {
                    type: "text",
                    text: taggingPrompt,
                  },
                ],
              },
            ],
          },
        };

        jsonlLines.push(JSON.stringify(jsonlItem));

        taggingManifest.records[recordId] = {
          dataset_id,
          video_name: videoName,
          frame_name: frame.frame_name,
          frame_stem: frame.frame_stem,
          frame_s3_key: frame.frame_key,
          frame_s3_uri: frame.s3_uri,
        };
      }
    }

    // --------------------------------------------------
    // 4. Write Bedrock input + manifests
    // --------------------------------------------------
    const basePrefix = `traffic-atlas/datasets/${dataset_id}/analysis`;

    const taggingInputKey = `${basePrefix}/bedrock/input/tagging_input.jsonl`;
    const taggingManifestKey = `${basePrefix}/bedrock/manifest/tagging_manifest.json`;
    const inventoryKey = `${basePrefix}/bedrock/manifest/video_inventory.json`;

    await s3
      .putObject({
        Bucket: bucket,
        Key: taggingInputKey,
        Body: jsonlLines.join("\n"),
        ContentType: "application/x-ndjson",
      })
      .promise();

    await s3
      .putObject({
        Bucket: bucket,
        Key: taggingManifestKey,
        Body: JSON.stringify(taggingManifest, null, 2),
        ContentType: "application/json",
      })
      .promise();

    const inventory = {
      dataset_id,
      total_videos: Object.keys(videoFrames).length,
      total_frames: totalFrames,
      videos: Object.entries(videoFrames).map(([videoName, frames]) => ({
        video_name: videoName,
        frame_count: frames.length,
        frames: frames.map((f) => f.frame_name),
      })),
      created_at: new Date().toISOString(),
    };

    await s3
      .putObject({
        Bucket: bucket,
        Key: inventoryKey,
        Body: JSON.stringify(inventory, null, 2),
        ContentType: "application/json",
      })
      .promise();

    console.log("Bedrock tagging input created successfully");

    return {
      success: true,
      dataset_id,
      videos_count: Object.keys(videoFrames).length,
      frames_count: totalFrames,

      tagging_input_key: taggingInputKey,
      tagging_input_s3_uri: `s3://${bucket}/${taggingInputKey}`,

      tagging_manifest_key: taggingManifestKey,
      tagging_manifest_s3_uri: `s3://${bucket}/${taggingManifestKey}`,

      inventory_key: inventoryKey,
      inventory_s3_uri: `s3://${bucket}/${inventoryKey}`,

      bedrock_input_prefix: `${basePrefix}/bedrock/input/`,
      bedrock_output_prefix: `${basePrefix}/bedrock/output/`,
      bedrock_manifest_prefix: `${basePrefix}/bedrock/manifest/`,
    };
  } catch (error) {
    console.error("BuildTaggingInput error:", error);
    throw error;
  }
};
