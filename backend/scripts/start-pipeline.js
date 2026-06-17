#!/usr/bin/env node
/**
 * Start the Vaidio pipeline for a dataset (same input as the API).
 * Usage: node backend/scripts/start-pipeline.js <dataset-id>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const datasetId = process.argv[2];
if (!datasetId) {
  console.error('Usage: node backend/scripts/start-pipeline.js <dataset-id>');
  process.exit(1);
}

const stepFunctions = require('../stepFunctions');

stepFunctions
  .startDatasetPipeline(datasetId)
  .then((r) => {
    console.log('Started:', r.executionArn);
    console.log('Input:', JSON.stringify(r.input, null, 2));
  })
  .catch((e) => {
    console.error(e.message);
    if (e.code === 'ASSUME_ROLE_DENIED') {
      console.error('\nFix: ask AWS to trust your IAM user on VaidioTrafficAtlasApiTriggerRole,');
      console.error('or run this on the EC2 testing API server, or use the AWS Console to start the execution.');
    }
    process.exit(1);
  });
