const { SFNClient, StartExecutionCommand, DescribeExecutionCommand } = require('@aws-sdk/client-sfn');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const s3Storage = require('./s3Storage');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const STATE_MACHINE_ARN = process.env.STEP_FUNCTIONS_STATE_MACHINE_ARN || '';
const ASSUME_ROLE_ARN = process.env.STEP_FUNCTIONS_ASSUME_ROLE_ARN || '';
const BUCKET = process.env.S3_BUCKET || 'your-s3-bucket';

let defaultClient = null;
let dedicatedSfnClient = null;
let assumedCredentials = null;
let assumedExpiryMs = 0;

function isEnabled() {
  return Boolean(STATE_MACHINE_ARN && BUCKET);
}

function useAssumeRole() {
  return process.env.STEP_FUNCTIONS_USE_ASSUME_ROLE === 'true' && Boolean(ASSUME_ROLE_ARN);
}

/** Optional keys in the pipeline account; S3 can keep separate AWS_ACCESS_KEY_ID. */
function sfnCredentialsFromEnv() {
  const accessKeyId = process.env.STEP_FUNCTIONS_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STEP_FUNCTIONS_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return { accessKeyId, secretAccessKey };
}

async function resolveSfnClientDirect() {
  const dedicated = sfnCredentialsFromEnv();
  if (dedicated) {
    if (!dedicatedSfnClient) {
      dedicatedSfnClient = new SFNClient({ region: REGION, credentials: dedicated });
    }
    return dedicatedSfnClient;
  }
  if (!defaultClient) {
    defaultClient = new SFNClient({ region: REGION });
  }
  return defaultClient;
}

async function resolveSfnClientWithAssume() {
  if (!ASSUME_ROLE_ARN) {
    throw new Error('STEP_FUNCTIONS_ASSUME_ROLE_ARN is not set');
  }

  const now = Date.now();
  if (assumedCredentials && assumedExpiryMs > now + 60_000) {
    return new SFNClient({ region: REGION, credentials: assumedCredentials });
  }

  const sts = new STSClient({ region: REGION });
  const resp = await sts.send(
    new AssumeRoleCommand({
      RoleArn: ASSUME_ROLE_ARN,
      RoleSessionName: `traffic-atlas-api-${Date.now()}`,
    })
  );

  if (!resp.Credentials?.AccessKeyId) {
    throw new Error(`Failed to assume role ${ASSUME_ROLE_ARN}`);
  }

  assumedCredentials = {
    accessKeyId: resp.Credentials.AccessKeyId,
    secretAccessKey: resp.Credentials.SecretAccessKey,
    sessionToken: resp.Credentials.SessionToken,
  };
  assumedExpiryMs = resp.Credentials.Expiration
    ? new Date(resp.Credentials.Expiration).getTime()
    : now + 3_600_000;

  return new SFNClient({ region: REGION, credentials: assumedCredentials });
}

async function resolveSfnClient() {
  return useAssumeRole() ? resolveSfnClientWithAssume() : resolveSfnClientDirect();
}

function formatPipelineStartError(error) {
  const msg = String(error?.message || error);
  if (/AssumeRole/i.test(msg) || error?.name === 'AccessDeniedException' && /sts:/i.test(msg)) {
    const err = new Error(
      'This API cannot assume VaidioTrafficAtlasApiTriggerRole. Ask the AWS owner to add your IAM user to that role\'s trust policy, '
      + 'attach the role to the EC2 instance profile (testing API), or set REACT_APP_API_URL to the deployed testing API. '
      + 'See docs/AWS_PIPELINE_HANDOFF.md.'
    );
    err.statusCode = 403;
    err.code = 'ASSUME_ROLE_DENIED';
    return err;
  }
  if (/StartExecution/i.test(msg) || (error?.name === 'AccessDeniedException' && /states:/i.test(msg))) {
    const err = new Error(
      'IAM denied states:StartExecution on the pipeline state machine. Use credentials in the pipeline account '
      + 'or the VaidioTrafficAtlasApiTriggerRole (with trust + STEP_FUNCTIONS_USE_ASSUME_ROLE=true).'
    );
    err.statusCode = 403;
    err.code = 'SFN_START_DENIED';
    return err;
  }
  return error;
}

/** S3 prefix for a dataset folder, e.g. traffic-atlas/datasets/{id}/ */
function getDatasetRootPrefix(datasetId) {
  const base = (process.env.S3_PREFIX || 'traffic-atlas').replace(/^\/+|\/+$/g, '');
  return `${base}/datasets/${datasetId}/`;
}

function getProcessingStatusKey(datasetId) {
  return `${getDatasetRootPrefix(datasetId)}analysis/status/processing_status.json`;
}

function s3CredentialsForPipeline() {
  const accessKeyId =
    process.env.PROCESSING_S3_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey =
    process.env.PROCESSING_S3_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  return { accessKeyId, secretAccessKey };
}

function buildStepInput(datasetId) {
  const { accessKeyId, secretAccessKey } = s3CredentialsForPipeline();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 credentials for pipeline Batch jobs are missing. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY '
      + '(source bucket) or PROCESSING_S3_AWS_ACCESS_KEY_ID/PROCESSING_S3_AWS_SECRET_ACCESS_KEY.'
    );
  }
  return {
    dataset_id: datasetId,
    bucket: BUCKET,
    dataset_root_prefix: getDatasetRootPrefix(datasetId),
    // Required by vaidio-trafficatlas-end-to-end-pipeline (Batch reads client bucket)
    client_aws_access_key_id: accessKeyId,
    client_aws_secret_access_key: secretAccessKey,
  };
}

function safeExecutionName(datasetId) {
  const sanitized = String(datasetId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return `vaidio-${sanitized}-${Date.now()}`;
}

/**
 * Start the Vaidio processing Step Function for a dataset.
 * Uses IAM role credentials on the server — never pass AWS keys from the client.
 */
async function startDatasetPipeline(datasetId) {
  if (!datasetId) {
    throw new Error('dataset_id is required');
  }
  if (!isEnabled()) {
    throw new Error(
      'Step Functions is not configured. Set STEP_FUNCTIONS_STATE_MACHINE_ARN and S3_BUCKET.'
    );
  }

  const input = buildStepInput(datasetId);
  try {
    const sfn = await resolveSfnClient();
    const response = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: safeExecutionName(datasetId),
        input: JSON.stringify(input),
      })
    );

    return {
      datasetId,
      executionArn: response.executionArn,
      startDate: response.startDate?.toISOString?.() || new Date().toISOString(),
      input,
    };
  } catch (error) {
    throw formatPipelineStartError(error);
  }
}

async function describeExecution(executionArn) {
  if (!executionArn) return null;
  const sfn = await resolveSfnClient();
  const response = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  return {
    executionArn: response.executionArn,
    status: response.status,
    startDate: response.startDate,
    stopDate: response.stopDate,
    error: response.error,
    cause: response.cause,
  };
}

/**
 * Read pipeline status written by the Step Function / analysis jobs in S3.
 */
async function readProcessingStatusFromS3(datasetId) {
  if (!s3Storage.isEnabled()) {
    return null;
  }
  const key = getProcessingStatusKey(datasetId);
  try {
    const text = await s3Storage.getObjectTextByKey(key);
    return JSON.parse(text);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Combined status for the frontend: Step Functions execution + S3 processing_status.json
 */
async function getDatasetProcessingStatus(datasetId, storedExecutionArn = null) {
  const result = {
    datasetId,
    pipelineConfigured: isEnabled(),
    executionArn: storedExecutionArn || null,
    execution: null,
    processingStatus: null,
    overallStatus: 'unknown',
  };

  if (storedExecutionArn) {
    try {
      result.execution = await describeExecution(storedExecutionArn);
      result.overallStatus = mapExecutionStatus(result.execution?.status);
    } catch (error) {
      result.executionError = error.message;
    }
  }

  try {
    result.processingStatus = await readProcessingStatusFromS3(datasetId);
    if (result.processingStatus?.status) {
      result.overallStatus = String(result.processingStatus.status).toLowerCase();
    }
  } catch (error) {
    result.processingStatusError = error.message;
  }

  return result;
}

function mapExecutionStatus(sfnStatus) {
  switch (sfnStatus) {
    case 'RUNNING':
      return 'processing';
    case 'SUCCEEDED':
      return 'completed';
    case 'FAILED':
    case 'TIMED_OUT':
    case 'ABORTED':
      return 'failed';
    default:
      return 'pending';
  }
}

module.exports = {
  isEnabled,
  getDatasetRootPrefix,
  getProcessingStatusKey,
  buildStepInput,
  startDatasetPipeline,
  describeExecution,
  readProcessingStatusFromS3,
  getDatasetProcessingStatus,
};
