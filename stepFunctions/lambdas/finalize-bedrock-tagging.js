const AWS = require("aws-sdk");

const s3 = new AWS.S3({
  accessKeyId: process.env.CLIENT_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.CLIENT_AWS_SECRET_ACCESS_KEY
});


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


const TAG_FIELDS = [
  "lighting",
  "weather",
  "road_type",
  "traffic_density",
  "vehicle_presence",
  "pedestrian_presence",
  "cyclist_presence",
  "truck_presence",
  "bus_presence",
  "motorcycle_presence",
  "emergency_vehicle_presence"
];

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function extractClaudeText(record) {
  const output = record.modelOutput || record.output || record.outputBody || null;

  if (!output) return "";

  let body = output;

  if (typeof body === "string") {
    body = safeJsonParse(body) || body;
  }

  if (body && typeof body.body === "string") {
    body = safeJsonParse(body.body) || body.body;
  }

  if (body && Array.isArray(body.content)) {
    return body.content.map((x) => x.text || "").filter(Boolean).join("\n");
  }

  if (body && body.message && Array.isArray(body.message.content)) {
    return body.message.content.map((x) => x.text || "").filter(Boolean).join("\n");
  }

  if (typeof body === "string") {
    return body;
  }

  return JSON.stringify(body);
}

function normalizeTags(parsed) {
  const tags = {};

  for (const field of TAG_FIELDS) {
    tags[field] = parsed && parsed[field] ? String(parsed[field]).trim() : "unknown";
  }

  return {
    tags,
    short_description:
      parsed && parsed.short_description
        ? String(parsed.short_description).trim()
        : ""
  };
}

function increment(obj, key, amount = 1) {
  obj[key] = (obj[key] || 0) + amount;
}

exports.handler = async (event) => {
  console.log("FinalizeBedrockTagging event:", JSON.stringify(event, null, 2));

  const {
    dataset_id,
    bucket,
    bedrock_output_prefix
  } = event;

  if (!dataset_id || !bucket || !bedrock_output_prefix) {
    throw new Error("Missing required input: dataset_id, bucket, or bedrock_output_prefix");
  }
  
  const datasetRootPrefix = event.dataset_root_prefix || `traffic-atlas/datasets/${dataset_id}/`;
  const basePrefix = `${datasetRootPrefix.replace(/\/$/, "")}/analysis`;
  const manifestKey = `${basePrefix}/bedrock/manifest/tagging_manifest.json`;
  const statusKey = `${basePrefix}/status/processing_status.json`;

  try {
    // -----------------------------
    // 1. Read manifest
    // -----------------------------
    const manifestObj = await s3.getObject({
      Bucket: bucket,
      Key: manifestKey
    }).promise();

    const manifest = JSON.parse(manifestObj.Body.toString("utf-8"));
    const manifestRecords = manifest.records || {};

    // -----------------------------
    // 2. List Bedrock output files
    // -----------------------------
    const outputFiles = [];
    let token = null;

    do {
      const res = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: bedrock_output_prefix,
        MaxKeys: 1000,
        ContinuationToken: token
      }).promise();

      for (const file of res.Contents || []) {
        if (file.Key.toLowerCase().endsWith(".jsonl")) {
          outputFiles.push(file.Key);
        }
      }

      token = res.NextContinuationToken;
    } while (token);

    if (outputFiles.length === 0) {
      throw new Error(`No Bedrock output JSONL found under ${bedrock_output_prefix}`);
    }

    // -----------------------------
    // 3. Parse outputs
    // -----------------------------
    const videoSummaries = {};
    const datasetDistribution = {};
    let totalFramesTagged = 0;
    let parseFailures = 0;
    let missingManifestRecords = 0;

    for (const field of TAG_FIELDS) {
      datasetDistribution[field] = {};
    }

    for (const outputFile of outputFiles) {
      const obj = await s3.getObject({
        Bucket: bucket,
        Key: outputFile
      }).promise();

      const lines = obj.Body.toString("utf-8").split("\n").filter(Boolean);

      for (const line of lines) {
        let record;

        try {
          record = JSON.parse(line);
        } catch (err) {
          parseFailures++;
          continue;
        }

        const recordId = record.recordId || record.record_id || record.id;
        const frameInfo = manifestRecords[recordId];

        if (!recordId || !frameInfo) {
          missingManifestRecords++;
          continue;
        }

        const responseText = extractClaudeText(record);
        const parsed = safeJsonParse(responseText);

        if (!parsed) {
          parseFailures++;
        }

        const normalized = normalizeTags(parsed);

        const videoName = frameInfo.video_name;
        const frameStem = frameInfo.frame_stem;

        const frameTagKey = `${basePrefix}/tags/frame_level/${videoName}/${frameStem}.json`;

        const frameTagMetadata = {
          dataset_id,
          recordId,
          video_name: videoName,
          frame_name: frameInfo.frame_name,
          frame_stem: frameInfo.frame_stem,
          frame_s3_key: frameInfo.frame_s3_key,
          frame_s3_uri: frameInfo.frame_s3_uri,
          tags: normalized.tags,
          short_description: normalized.short_description,
          parsed_successfully: Boolean(parsed),
          raw_response_text: responseText,
          bedrock_output_file: outputFile,
          processed_at: new Date().toISOString()
        };

        await s3.putObject({
          Bucket: bucket,
          Key: frameTagKey,
          Body: JSON.stringify(frameTagMetadata, null, 2),
          ContentType: "application/json"
        }).promise();

        if (!videoSummaries[videoName]) {
          videoSummaries[videoName] = {
            dataset_id,
            video_name: videoName,
            frame_count: 0,
            source_frames_prefix: `${basePrefix}/frames/${videoName}/`,
            frame_tag_files: [],
            tag_counts: {},
            category_counts: {},
            sample_descriptions: []
          };

          for (const field of TAG_FIELDS) {
            videoSummaries[videoName].category_counts[field] = {};
          }
        }

        const videoSummary = videoSummaries[videoName];

        videoSummary.frame_count++;
        videoSummary.frame_tag_files.push(frameTagKey);

        if (normalized.short_description) {
          videoSummary.sample_descriptions.push({
            frame_name: frameInfo.frame_name,
            description: normalized.short_description
          });
        }

        for (const field of TAG_FIELDS) {
          const value = normalized.tags[field] || "unknown";
          const flatTag = `${field}.${value}`;

          increment(videoSummary.tag_counts, flatTag);
          increment(videoSummary.category_counts[field], value);
          increment(datasetDistribution[field], value);
        }

        totalFramesTagged++;
      }
    }

    // -----------------------------
    // 4. Save video summaries
    // -----------------------------
    const videoSummaryKeys = [];

    for (const [videoName, summary] of Object.entries(videoSummaries)) {
      const dominant_tags = {};

      for (const field of TAG_FIELDS) {
        const sorted = Object.entries(summary.category_counts[field] || {})
          .sort((a, b) => b[1] - a[1]);

        dominant_tags[field] = sorted.length > 0 ? sorted[0][0] : "unknown";
      }

      const finalVideoSummary = {
        ...summary,
        dominant_tags,
        sample_descriptions: summary.sample_descriptions.slice(0, 10),
        processing_date: new Date().toISOString()
      };

      const videoSummaryKey = `${basePrefix}/tags/video_level/${videoName}.json`;

      await s3.putObject({
        Bucket: bucket,
        Key: videoSummaryKey,
        Body: JSON.stringify(finalVideoSummary, null, 2),
        ContentType: "application/json"
      }).promise();

      videoSummaryKeys.push(videoSummaryKey);
    }

    // -----------------------------
    // 5. Build dataset summary
    // -----------------------------
    const allFlatTagCounts = {};

    for (const [field, values] of Object.entries(datasetDistribution)) {
      for (const [value, count] of Object.entries(values)) {
        allFlatTagCounts[`${field}.${value}`] = count;
      }
    }

    const topTags = Object.entries(allFlatTagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => ({
        tag,
        count,
        percentage:
          totalFramesTagged > 0
            ? Number(((count / totalFramesTagged) * 100).toFixed(2))
            : 0
      }));

    const dominantTags = {};

    for (const field of TAG_FIELDS) {
      const sorted = Object.entries(datasetDistribution[field] || {})
        .sort((a, b) => b[1] - a[1]);

      dominantTags[field] = sorted.length > 0 ? sorted[0][0] : "unknown";
    }

    const filterTags = [];

    for (const [field, value] of Object.entries(dominantTags)) {
      if (value !== "unknown") {
        filterTags.push(`${field}.${value}`);
      }
    }

    const datasetSummary = {
      dataset_id,
      generated_at: new Date().toISOString(),
      total_videos: Object.keys(videoSummaries).length,
      total_frames_tagged: totalFramesTagged,
      source_references: {
        tagging_manifest_key: manifestKey,
        bedrock_output_prefix,
        video_summary_files: videoSummaryKeys
      },
      dominant_tags: dominantTags,
      top_tags: topTags,
      filter_tags: filterTags,
      ready_for_web_display: true
    };

    const datasetLevelPrefix = `${basePrefix}/tags/dataset_level`;

    const summaryKey = `${datasetLevelPrefix}/dataset_summary.json`;
    const filterTagsKey = `${datasetLevelPrefix}/dataset_filter_tags.json`;
    const distributionKey = `${datasetLevelPrefix}/dataset_tag_distribution.json`;

    await s3.putObject({
      Bucket: bucket,
      Key: summaryKey,
      Body: JSON.stringify(datasetSummary, null, 2),
      ContentType: "application/json"
    }).promise();

    await s3.putObject({
      Bucket: bucket,
      Key: filterTagsKey,
      Body: JSON.stringify({
        dataset_id,
        generated_at: new Date().toISOString(),
        filter_tags: filterTags,
        dominant_tags: dominantTags
      }, null, 2),
      ContentType: "application/json"
    }).promise();

    await s3.putObject({
      Bucket: bucket,
      Key: distributionKey,
      Body: JSON.stringify({
        dataset_id,
        generated_at: new Date().toISOString(),
        total_frames_tagged: totalFramesTagged,
        tag_distribution: datasetDistribution,
        top_tags: topTags
      }, null, 2),
      ContentType: "application/json"
    }).promise();

    // -----------------------------
    // 6. Update status
    // -----------------------------
    const existingStatus = await readExistingStatus(bucket, statusKey);

	const status = {
	  ...existingStatus,
	  dataset_id,
	  current_stage: "tagging_completed",
	  overall_status: "completed",
	  updated_at: new Date().toISOString(),
	  steps: {
	    ...(existingStatus.steps || {}),

	    tag_parsing: {
	      status: "completed",
	      frames_tagged: totalFramesTagged,
	      videos_processed: Object.keys(videoSummaries).length,
	      parse_failures: parseFailures,
	      missing_manifest_records: missingManifestRecords,
	      completed_at: new Date().toISOString()
	    },

	    dataset_summary: {
	      status: "completed",
	      summary_key: summaryKey,
	      filter_tags_key: filterTagsKey,
	      distribution_key: distributionKey,
	      completed_at: new Date().toISOString()
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
      total_frames_tagged: totalFramesTagged,
      videos_processed: Object.keys(videoSummaries).length,
      parse_failures: parseFailures,
      missing_manifest_records: missingManifestRecords,
      summary_key: summaryKey,
      filter_tags_key: filterTagsKey,
      distribution_key: distributionKey,
      status_key: statusKey
    };

  } catch (error) {
    console.error("FinalizeBedrockTagging error:", error);
    throw error;
  }
};
