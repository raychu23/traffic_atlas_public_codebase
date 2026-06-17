const AWS = require("aws-sdk");
const s3 = new AWS.S3();

exports.handler = async (event) => {
  console.log("ParseTagOutputs event:", JSON.stringify(event, null, 2));

  const { dataset_id, bucket, bedrock_output_prefix } = event;

  const basePrefix = `traffic-atlas/datasets/${dataset_id}/analysis`;
  const manifestKey = `${basePrefix}/bedrock/manifest/tagging_manifest.json`;

  try {
    // -----------------------------
    // 1. Load tagging manifest
    // -----------------------------
    const manifestObj = await s3.getObject({
      Bucket: bucket,
      Key: manifestKey
    }).promise();

    const manifest = JSON.parse(manifestObj.Body.toString("utf-8")).records;

    // -----------------------------
    // 2. List Bedrock outputs
    // -----------------------------
    let outputFiles = [];
    let token = null;

    do {
      const res = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: bedrock_output_prefix,
        ContinuationToken: token
      }).promise();

      outputFiles.push(...res.Contents.filter(f => f.Key.endsWith(".jsonl")));
      token = res.NextContinuationToken;
    } while (token);

    console.log("Output files:", outputFiles.length);

    const videoSummaries = {};

    // -----------------------------
    // 3. Parse outputs
    // -----------------------------
    for (const file of outputFiles) {
      const obj = await s3.getObject({
        Bucket: bucket,
        Key: file.Key
      }).promise();

      const lines = obj.Body.toString("utf-8").split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;

        const record = JSON.parse(line);
        const recordId = record.recordId;

        const frameInfo = manifest[recordId];
        if (!frameInfo) continue;

        const text = JSON.stringify(record.modelOutput || record.output);

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

        const video = frameInfo.video_name;
        const frameStem = frameInfo.frame_stem;

        // -----------------------------
        // Save frame-level tags
        // -----------------------------
        const frameKey = `${basePrefix}/tags/frame_level/${video}/${frameStem}.json`;

        await s3.putObject({
          Bucket: bucket,
          Key: frameKey,
          Body: JSON.stringify({
            dataset_id,
            recordId,
            ...frameInfo,
            tags: parsed,
            processed_at: new Date().toISOString()
          }, null, 2)
        }).promise();

        // -----------------------------
        // Aggregate video summary
        // -----------------------------
        if (!videoSummaries[video]) {
          videoSummaries[video] = {
            video_name: video,
            frame_count: 0,
            tag_counts: {}
          };
        }

        videoSummaries[video].frame_count++;

        for (const [k, v] of Object.entries(parsed)) {
          const tag = `${k}.${v}`;
          videoSummaries[video].tag_counts[tag] =
            (videoSummaries[video].tag_counts[tag] || 0) + 1;
        }
      }
    }

    // -----------------------------
    // 4. Save video summaries
    // -----------------------------
    for (const [video, summary] of Object.entries(videoSummaries)) {
      const key = `${basePrefix}/tags/video_level/${video}.json`;

      await s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(summary, null, 2)
      }).promise();
    }

    return { success: true };

  } catch (err) {
    console.error(err);
    throw err;
  }
};
