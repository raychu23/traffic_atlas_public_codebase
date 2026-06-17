const AWS = require("aws-sdk");
const s3 = new AWS.S3();

exports.handler = async (event) => {
  console.log("BuildSummaries event:", JSON.stringify(event, null, 2));

  const { dataset_id, bucket } = event;

  const basePrefix = `traffic-atlas/datasets/${dataset_id}/analysis`;
  const videoPrefix = `${basePrefix}/tags/video_level/`;

  try {
    // -----------------------------
    // 1. Read video summaries
    // -----------------------------
    let videos = [];
    let token = null;

    do {
      const res = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: videoPrefix,
        ContinuationToken: token
      }).promise();

      for (const file of res.Contents) {
        if (!file.Key.endsWith(".json")) continue;

        const obj = await s3.getObject({
          Bucket: bucket,
          Key: file.Key
        }).promise();

        videos.push(JSON.parse(obj.Body.toString("utf-8")));
      }

      token = res.NextContinuationToken;
    } while (token);

    // -----------------------------
    // 2. Aggregate dataset stats
    // -----------------------------
    let totalFrames = 0;
    const tagCounts = {};

    for (const v of videos) {
      totalFrames += v.frame_count;

      for (const [tag, count] of Object.entries(v.tag_counts || {})) {
        tagCounts[tag] = (tagCounts[tag] || 0) + count;
      }
    }

    // -----------------------------
    // 3. Compute dominant tags
    // -----------------------------
    const dominant = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tag, count]) => ({ tag, count }));

    // -----------------------------
    // 4. Build dataset summary
    // -----------------------------
    const summary = {
      dataset_id,
      total_videos: videos.length,
      total_frames: totalFrames,
      dominant_tags: dominant,
      generated_at: new Date().toISOString()
    };

    // -----------------------------
    // 5. Save
    // -----------------------------
    await s3.putObject({
      Bucket: bucket,
      Key: `${basePrefix}/tags/dataset_level/dataset_summary.json`,
      Body: JSON.stringify(summary, null, 2)
    }).promise();

    return { success: true };

  } catch (err) {
    console.error(err);
    throw err;
  }
};
