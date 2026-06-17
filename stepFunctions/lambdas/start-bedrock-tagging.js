const AWS = require("aws-sdk");

const s3 = new AWS.S3({
  accessKeyId: process.env.CLIENT_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.CLIENT_AWS_SECRET_ACCESS_KEY
});
const bedrock = new AWS.Bedrock();

async function readExistingStatus(bucket, statusKey) {
  try {
    const obj = await s3.getObject({
      Bucket: bucket,
      Key: statusKey
    }).promise();

    return JSON.parse(obj.Body.toString("utf-8"));
  } catch (err) {
    if (err.code === "NoSuchKey" || err.code === "NotFound") {
      return {};
    }
    throw err;
  }
}


exports.handler = async (event) => {
  console.log("StartBedrockTagging event:", JSON.stringify(event, null, 2));

  const {
    dataset_id,
    bucket,
    frames_prefix,
    model_id,
    bedrock_role_arn
  } = event;

  if (!dataset_id || !bucket || !frames_prefix || !model_id || !bedrock_role_arn) {
    throw new Error(
      "Missing required input: dataset_id, bucket, frames_prefix, model_id, or bedrock_role_arn"
    );
  }

  const datasetRootPrefix = event.dataset_root_prefix || `traffic-atlas/datasets/${dataset_id}/`;
  const basePrefix = `${datasetRootPrefix.replace(/\/$/, "")}/analysis`;
  
  const taggingInputKey = `${basePrefix}/bedrock/input/tagging_input.jsonl`;
  const taggingManifestKey = `${basePrefix}/bedrock/manifest/tagging_manifest.json`;
  const inventoryKey = `${basePrefix}/bedrock/manifest/video_inventory.json`;
  const statusKey = `${basePrefix}/status/processing_status.json`;

  const taggingInputS3Uri = `s3://${bucket}/${taggingInputKey}`;
  const bedrockOutputS3Uri = `s3://${bucket}/${basePrefix}/bedrock/output/`;

  try {
    // -----------------------------
    // 1. List frames
    // -----------------------------
    const videoFrames = {};
    let continuationToken = null;
    let totalFrames = 0;

    do {
      const response = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: frames_prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken
      }).promise();

      for (const obj of response.Contents || []) {
        const keyLower = obj.Key.toLowerCase();

        // Keep PNG for now because Bedrock Playground worked reliably with PNG
        if (!keyLower.endsWith(".png")) continue;

        const relativePath = obj.Key.replace(frames_prefix, "");
        const parts = relativePath.split("/").filter(Boolean);

        if (parts.length < 2) {
          console.warn("Skipping unexpected frame path:", obj.Key);
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
          s3_uri: `s3://${bucket}/${obj.Key}`
        });

        totalFrames++;
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (totalFrames === 0) {
      throw new Error(`No PNG frames found under prefix: ${frames_prefix}`);
    }

    for (const videoName of Object.keys(videoFrames)) {
      videoFrames[videoName].sort((a, b) => a.frame_name.localeCompare(b.frame_name));
    }

    // -----------------------------
    // 2. Build prompt
    // -----------------------------
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

    // -----------------------------
    // 3. Build JSONL and manifest
    // -----------------------------
    const jsonlLines = [];
    const taggingManifest = {
      dataset_id,
      bucket,
      frames_prefix,
      created_at: new Date().toISOString(),
      total_frames: totalFrames,
      records: {}
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
		    type: "s3Location",
		    s3Location: {
		      uri: frame.s3_uri
		    }
		  }
		},
                  {
                    type: "text",
                    text: taggingPrompt
                  }
                ]
              }
            ]
          }
        };

        jsonlLines.push(JSON.stringify(jsonlItem));

        taggingManifest.records[recordId] = {
          dataset_id,
          video_name: videoName,
          frame_name: frame.frame_name,
          frame_stem: frame.frame_stem,
          frame_s3_key: frame.frame_key,
          frame_s3_uri: frame.s3_uri
        };
      }
    }

    // -----------------------------
    // 4. Save JSONL, manifest, inventory
    // -----------------------------
    await s3.putObject({
      Bucket: bucket,
      Key: taggingInputKey,
      Body: jsonlLines.join("\n"),
      ContentType: "application/x-ndjson"
    }).promise();

    await s3.putObject({
      Bucket: bucket,
      Key: taggingManifestKey,
      Body: JSON.stringify(taggingManifest, null, 2),
      ContentType: "application/json"
    }).promise();

    const inventory = {
      dataset_id,
      total_videos: Object.keys(videoFrames).length,
      total_frames: totalFrames,
      frame_format: "png",
      videos: Object.entries(videoFrames).map(([videoName, frames]) => ({
        video_name: videoName,
        frame_count: frames.length,
        frames: frames.map((f) => f.frame_name)
      })),
      created_at: new Date().toISOString()
    };

    await s3.putObject({
      Bucket: bucket,
      Key: inventoryKey,
      Body: JSON.stringify(inventory, null, 2),
      ContentType: "application/json"
    }).promise();

    // -----------------------------
    // 5. Submit Bedrock batch job
    // -----------------------------
    const jobName = `vaidio-traffic-tagging-${dataset_id}-${Date.now()}`;

    const bedrockResponse = await bedrock.createModelInvocationJob({
      jobName,
      roleArn: bedrock_role_arn,
      modelId: model_id,
      inputDataConfig: {
        s3InputDataConfig: {
          s3Uri: taggingInputS3Uri
        }
      },
      outputDataConfig: {
        s3OutputDataConfig: {
          s3Uri: bedrockOutputS3Uri
        }
      }
    }).promise();

    // -----------------------------
    // 6. Update S3 status file
    // -----------------------------
	const existingStatus = await readExistingStatus(bucket, statusKey);

	const status = {
	  ...existingStatus,
	  dataset_id,
	  bucket,
	  current_stage: "bedrock_batch_running",
	  overall_status: "processing",
	  updated_at: new Date().toISOString(),
	  steps: {
	    ...(existingStatus.steps || {}),

	    tagging_input: {
	      status: "completed",
	      frames_count: totalFrames,
	      tagging_input_key: taggingInputKey,
	      tagging_input_s3_uri: taggingInputS3Uri,
	      tagging_manifest_key: taggingManifestKey,
	      inventory_key: inventoryKey,
	      completed_at: new Date().toISOString()
	    },

	    bedrock_batch: {
	      status: "running",
	      jobArn: bedrockResponse.jobArn,
	      jobName,
	      model_id,
	      input_s3_uri: taggingInputS3Uri,
	      output_s3_uri: bedrockOutputS3Uri,
	      started_at: new Date().toISOString()
	    },

	    tag_parsing: {
	      status: "pending"
	    },

	    dataset_summary: {
	      status: "pending"
	    }
	  }
	};

    await s3.putObject({
      Bucket: bucket,
      Key: statusKey,
      Body: JSON.stringify(status, null, 2),
      ContentType: "application/json"
    }).promise();

    return {
      success: true,
      dataset_id,
      jobArn: bedrockResponse.jobArn,
      jobName,
      frames_count: totalFrames,
      tagging_input_key: taggingInputKey,
      tagging_input_s3_uri: taggingInputS3Uri,
      tagging_manifest_key: taggingManifestKey,
      bedrock_output_prefix: `${basePrefix}/bedrock/output/`,
      bedrock_output_s3_uri: bedrockOutputS3Uri,
      status_key: statusKey
    };

  } catch (error) {
    console.error("StartBedrockTagging error:", error);
    throw error;
  }
};
