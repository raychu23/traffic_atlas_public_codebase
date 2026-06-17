#!/usr/bin/env node
/**
 * Try to discover / validate the Step Functions ARN for local .env setup.
 * Usage: node backend/scripts/discover-pipeline-arn.js [datasetId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { SFNClient, ListStateMachinesCommand, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET || 'your-s3-bucket';
const PREFIX = (process.env.S3_PREFIX || 'traffic-atlas').replace(/^\/+|\/+$/g, '');
const datasetId = process.argv[2] || '4ee8dc70-c221-486f-9ec0-53cde7c8c41d';

const CANDIDATE_ACCOUNTS = [process.env.AWS_ACCOUNT_ID].filter(Boolean);
const CANDIDATE_NAMES = [
  'vaidio-trafficatlas-dataset-processing',
  'vaidio-traffic-atlas-pipeline',
  'VaidioTrafficAtlasPipeline',
  'vaidio-trafficatlas-pipeline',
  'DatasetProcessingStateMachine',
  'vaidio-traffic-atlas-end-to-end',
];

async function main() {
  const client = new SFNClient({ region: REGION });
  console.log('Region:', REGION);
  console.log('Dataset ID for test start:', datasetId);
  console.log('');

  let listed = [];
  try {
    const resp = await client.send(new ListStateMachinesCommand({ maxResults: 1000 }));
    listed = resp.stateMachines || [];
    console.log(`Found ${listed.length} state machine(s) in this account:\n`);
    for (const sm of listed) {
      const hit = /vaidio|traffic|dataset|atlas/i.test(sm.name);
      console.log(`  ${hit ? '→' : ' '} ${sm.name}\n    ${sm.stateMachineArn}`);
    }
  } catch (e) {
    console.warn('ListStateMachines failed (need states:ListStateMachines in this account):', e.message);
    console.warn('Trying fixed ARN patterns from AWS_ACCOUNT_ID...\n');
  }

  const arns = [
    ...listed.map((s) => s.stateMachineArn),
    ...CANDIDATE_ACCOUNTS.flatMap((acct) =>
      CANDIDATE_NAMES.map((name) => `arn:aws:states:${REGION}:${acct}:stateMachine:${name}`)
    ),
    process.env.STEP_FUNCTIONS_STATE_MACHINE_ARN,
  ].filter(Boolean);

  const unique = [...new Set(arns)];
  const input = JSON.stringify({
    dataset_id: datasetId,
    bucket: BUCKET,
    dataset_root_prefix: `${PREFIX}/datasets/${datasetId}/`,
  });

  for (const arn of unique) {
    try {
      const resp = await client.send(
        new StartExecutionCommand({
          stateMachineArn: arn,
          name: `discover-${Date.now()}`,
          input,
        })
      );
      console.log('\n✓ StartExecution succeeded!');
      console.log('  Add to .env:');
      console.log(`  STEP_FUNCTIONS_STATE_MACHINE_ARN=${arn}`);
      console.log('  executionArn:', resp.executionArn);
      return;
    } catch (e) {
      const short = e.name || e.Code || e.message;
      if (!/AccessDenied|StateMachineDoesNotExist|InvalidArn/i.test(String(short + e.message))) {
        console.log(`  ? ${arn}: ${e.message}`);
      }
    }
  }

  console.log('\nCould not start pipeline with current AWS credentials.');
  console.log('Set AWS_ACCOUNT_ID or STEP_FUNCTIONS_STATE_MACHINE_ARN for your deployment account.');
  console.log('Ask your admin for STEP_FUNCTIONS_STATE_MACHINE_ARN, or in that account:');
  console.log('  AWS Console → Step Functions → State machines → copy ARN');
  console.log('Then set it in .env and restart: npm run dev');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
