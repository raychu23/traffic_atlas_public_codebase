#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

async function main() {
  const [workRoot, videoId, widthText, heightText] = process.argv.slice(2);
  if (!workRoot || !videoId || !widthText || !heightText) {
    throw new Error('Usage: finalize-video-job.js WORK_ROOT VIDEO_ID WIDTH HEIGHT');
  }
  process.env.TRAFFIC_VIDEO_JOBS_ROOT = workRoot;
  const videoJobsModule =
    process.env.TRAFFIC_VIDEO_JOBS_MODULE || '/opt/traffic-atlas-worker/videoJobs.js';
  const { buildTrajectoryPreview, suggestTrafficZones, zonesToGeoJson } = require(videoJobsModule);
  const width = Number(widthText);
  const height = Number(heightText);
  const jobDir = path.join(workRoot, videoId);
  const outputDir = path.join(jobDir, 'output');
  const trajectories = await buildTrajectoryPreview(videoId, width, height);
  const zones = suggestTrafficZones(trajectories, width, height);
  await fs.writeFile(path.join(jobDir, 'zones.json'), JSON.stringify(zones, null, 2), 'utf8');
  await fs.writeFile(
    path.join(jobDir, 'zones.geojson'),
    JSON.stringify(zonesToGeoJson(zones, width, height), null, 2),
    'utf8',
  );
  await fs.copyFile(
    path.join(jobDir, 'trajectory_preview.json'),
    path.join(outputDir, 'trajectory_preview.json'),
  );
  await fs.copyFile(path.join(jobDir, 'zones.json'), path.join(outputDir, 'zones.json'));
  await fs.copyFile(path.join(jobDir, 'zones.geojson'), path.join(outputDir, 'zones.geojson'));
  process.stdout.write(
    `${JSON.stringify({ trajectories: trajectories.length, zones: zones.length })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
