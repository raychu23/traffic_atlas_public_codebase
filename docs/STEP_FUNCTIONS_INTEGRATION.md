# Step Functions integration (frontend → backend → pipeline)

## Flow

```
User completes full ZIP upload (multipart/complete)
        ↓
Backend marks dataset active + starts Step Function (IAM role)
        ↓
Frontend polls GET /api/datasets/:datasetId/status every 5s
        ↓
Pipeline writes s3://…/datasets/{id}/analysis/status/processing_status.json
        ↓
UI shows complete / redirects to dataset page
```

## Backend changes

### 1. Environment (`.env`)

```env
STEP_FUNCTIONS_STATE_MACHINE_ARN=arn:aws:states:us-east-1:<AWS_ACCOUNT_ID>:stateMachine:YOUR_NAME
S3_BUCKET=your-s3-bucket
S3_PREFIX=traffic-atlas
AWS_REGION=us-east-1
```

### 2. New module: `backend/stepFunctions.js`

- `startDatasetPipeline(datasetId)` — starts execution with:

```json
{
  "dataset_id": "<uuid>",
  "bucket": "your-s3-bucket",
  "dataset_root_prefix": "traffic-atlas/datasets/<uuid>/"
}
```

- `getDatasetProcessingStatus(datasetId)` — merges Step Functions execution state + S3 `processing_status.json`

### 3. New API routes (`backend/index.js`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/datasets/:datasetId/approve` | Owner or admin | Manually start pipeline |
| GET | `/api/datasets/:datasetId/status` | Logged in | Poll processing status |

**Auto-trigger:**

- `POST /api/admin/upload-requests/:requestId/approve` — starts the pipeline on the **sample** as soon as an admin approves the upload request.
- `POST /api/datasets/:datasetId/upload-full/multipart/complete` — starts again after a successful **full** upload (if not already running or completed).

### 4. IAM (backend role — EC2 / ECS / Lambda)

```json
{
  "Effect": "Allow",
  "Action": ["states:StartExecution", "states:DescribeExecution"],
  "Resource": [
    "arn:aws:states:us-east-1:<AWS_ACCOUNT_ID>:stateMachine:YOUR_STATE_MACHINE_NAME",
    "arn:aws:states:us-east-1:<AWS_ACCOUNT_ID>:execution:YOUR_STATE_MACHINE_NAME:*"
  ]
}
```

Also needs existing S3 read for `analysis/status/processing_status.json`.

### 5. Install dependency

```bash
npm install @aws-sdk/client-sfn
```

## Frontend changes

### 1. `frontend/src/services/api.js`

```javascript
export const approveDatasetPipeline = async (datasetId) => {
  const response = await api.post(`/datasets/${datasetId}/approve`, {
    dataset_id: datasetId,
  });
  return response.data;
};

export const getDatasetProcessingStatus = async (datasetId) => {
  const response = await api.get(`/datasets/${datasetId}/status`);
  return response.data;
};
```

Uses existing `Authorization: Bearer` interceptor — **no AWS keys in the browser**.

### 2. `frontend/src/components/UploadFullDataset.js`

After `completeMultipartUpload` succeeds:

1. Pipeline may already be started by the backend (`completeRes.pipeline.executionArn`).
2. If not, calls `approveDatasetPipeline(datasetId)` as fallback.
3. Polls status via `useDatasetProcessingStatus` hook.

### 3. Optional manual trigger (admin / scripts)

```javascript
await approveDatasetPipeline(datasetId);
```

## Production vs demo mode

| Branch / env | Frontend | Backend |
|--------------|----------|---------|
| `production` (default) | `REACT_APP_USE_PIPELINE_DEMO=false` | `ALLOW_EMBEDDINGS_DEMO` unset |
| `testing` preview | `REACT_APP_USE_PIPELINE_DEMO=true` optional | `ALLOW_EMBEDDINGS_DEMO=true` optional |

Production reads embeddings, filter tags, and PCA from S3 after the Step Function runs. Use **Run processing pipeline** on the dataset page or `POST /api/datasets/:id/approve` to start analysis.

## Security

- Never send `client_aws_access_key_id` / `client_aws_secret_access_key` from the frontend.
- Only `dataset_id` (and JWT) go to your API; the server uses its IAM role to call Step Functions.

## S3 status file

The status endpoint reads:

`s3://{S3_BUCKET}/{S3_PREFIX}/datasets/{dataset_id}/analysis/status/processing_status.json`

Your Step Function should write this file as processing progresses.
