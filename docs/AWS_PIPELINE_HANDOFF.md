# Traffic Atlas ↔ Vaidio pipeline (configured)

## Step Functions

| Setting | Value |
|---------|--------|
| State machine ARN | `arn:aws:states:us-east-1:<AWS_ACCOUNT_ID>:stateMachine:vaidio-trafficatlas-end-to-end-pipeline` |
| API trigger role | `arn:aws:iam::<AWS_ACCOUNT_ID>:role/VaidioTrafficAtlasApiTriggerRole` |
| Execution input | `{ dataset_id, bucket, dataset_root_prefix, client_aws_access_key_id, client_aws_secret_access_key }` (S3 keys for Batch — server-side only) |

### `.env` (API server)

```env
STEP_FUNCTIONS_STATE_MACHINE_ARN=arn:aws:states:us-east-1:<AWS_ACCOUNT_ID>:stateMachine:vaidio-trafficatlas-end-to-end-pipeline
STEP_FUNCTIONS_ASSUME_ROLE_ARN=arn:aws:iam::<AWS_ACCOUNT_ID>:role/VaidioTrafficAtlasApiTriggerRole
S3_BUCKET=your-s3-bucket
S3_PREFIX=traffic-atlas
```

### Local dev vs EC2

| Setup | `.env` |
|--------|--------|
| **EC2 testing API** (recommended) | Attach `VaidioTrafficAtlasApiTriggerRole` to instance profile; do not need assume |
| **Local API, two accounts** | Keep `AWS_ACCESS_KEY_ID` for your S3 bucket; set `STEP_FUNCTIONS_AWS_ACCESS_KEY_ID` + secret for account **<AWS_ACCOUNT_ID>** (`StartExecution` only) |
| **Local API, AssumeRole** | Set `STEP_FUNCTIONS_USE_ASSUME_ROLE=true` **only after** trust policy below |

Trust policy to add on **`VaidioTrafficAtlasApiTriggerRole`** (replace principal if needed):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<AWS_ACCOUNT_ID>:user/example-user" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**Workaround without local assume:** point the frontend at the deployed API:

```env
# frontend/.env.local
REACT_APP_API_URL=https://api.example.com
```

(Testing EC2 must have `STEP_FUNCTIONS_STATE_MACHINE_ARN` set and the trigger role attached.)

### Manual start (AWS Console)

Step Functions → `vaidio-trafficatlas-end-to-end-pipeline` → Start execution → input:

```json
{
  "dataset_id": "83ca1b9b-eb2f-43b9-8177-c0d8cd84ed6e",
  "bucket": "your-s3-bucket",
  "dataset_root_prefix": "traffic-atlas/datasets/83ca1b9b-eb2f-43b9-8177-c0d8cd84ed6e/",
  "client_aws_access_key_id": "<s3 access key>",
  "client_aws_secret_access_key": "<s3 secret key>"
}
```

## S3 layout

### v1 (default — matches live `vaidio-trafficatlas-end-to-end-pipeline`)

```
datasets/{id}/
├── sample/sample_data.zip          ← SFN reads ZIP_PREFIX = {root}sample/
├── full/full_data.zip or full_data.zip at root (multipart upload)
└── analysis/                       ← all pipeline outputs
```

`DATASET_S3_LAYOUT=v1` (default)

### v2 (proposed — enable after SFN owner updates Batch `ZIP_PREFIX`)

```
datasets/{id}/
├── sample_dataset/sample_data.zip
├── full_dataset/full_dataset.zip
└── analysis/
```

`DATASET_S3_LAYOUT=v2`

**Do not enable v2 until** the Step Function’s frame-extraction job uses  
`{dataset_root_prefix}sample_dataset/` (today it uses `{dataset_root_prefix}sample/`).

## App triggers

- Admin approves sample → `POST /api/admin/upload-requests/:id/approve`
- Full upload complete → multipart complete
- Manual → `POST /api/datasets/:id/approve` or UI **Run processing pipeline**
