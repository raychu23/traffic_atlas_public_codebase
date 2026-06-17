# DynamoDB Schema Documentation

## Overview

The `dataset-uploads` table tracks the lifecycle of each dataset from upload through completion.

## Table Design

### Primary Key
- **Partition Key (HASH)**: `dataset_id` (String, Unique)
- **Sort Key (RANGE)**: None (single dataset per record)

### Global Secondary Indexes

#### 1. UserDatasetIndex
Query all datasets for a specific user:
```
- Partition Key: user_id
- Sort Key: dataset_id
- Projection: ALL
```

**Use case**: "Show me all my uploaded datasets"

#### 2. CreationDateIndex
Query datasets by user and creation time:
```
- Partition Key: user_id
- Sort Key: created_at
- Projection: ALL
```

**Use case**: "Show me my datasets in reverse chronological order"

---

## Item Structure

Complete example of a dataset record:

```json
{
  // === PRIMARY KEY (REQUIRED) ===
  "dataset_id": "dataset_abc123",
  
  // === USER IDENTIFICATION ===
  "user_id": "user_xyz789",
  
  // === UPLOAD & STATUS TRACKING ===
  "upload_status": "uploaded",
  "processing_status": "completed",
  "zip_s3_path": "s3://bucket/sample_data/dataset_abc123/uploaded_sample/sample.zip",
  
  // === TIMESTAMPS ===
  "created_at": "2024-01-15T10:15:30Z",
  "updated_at": "2024-01-15T10:45:00Z",
  "processing_started_at": "2024-01-15T10:15:45Z",
  "processing_completed_at": "2024-01-15T10:45:00Z",
  
  // === RESULTS & PATHS ===
  "summary_s3_path": "s3://bucket/sample_data/dataset_abc123/sample_analysis/metadata/dataset/",
  "frames_s3_path": "s3://bucket/sample_data/dataset_abc123/sample_analysis/frames/",
  "embeddings_s3_path": "s3://bucket/sample_data/dataset_abc123/sample_analysis/embeddings/",
  
  // === METRICS ===
  "processing_metrics": {
    "total_videos": 5,
    "total_frames_extracted": 750,
    "unique_tags_detected": 47,
    "processing_duration_seconds": 1785,
    "estimated_cost_usd": 12.50
  },
  
  // === ERROR HANDLING ===
  "error_message": null,
  "last_error_at": null,
  
  // === OPTIONAL: CLEANUP ===
  "expiration_timestamp": 1747562400,
  
  // === OPTIONAL: METADATA ===
  "dataset_name": "Traffic Scene Sample",
  "description": "Sample videos from urban traffic scenarios",
  "tags": ["traffic", "urban", "vehicles"],
  "visibility": "private",
  "shared_with": []
}
```

---

## Field Reference

### Identification

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `dataset_id` | String (PK) | Unique dataset identifier | `dataset_abc123` |
| `user_id` | String | Owner user ID | `user_xyz789` |
| `dataset_name` | String | Display name | `Traffic Scene Sample` |

### Status

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `upload_status` | String | `uploaded`, `verified` | Has file been validated? |
| `processing_status` | String | `pending`, `extracted`, `tagged`, `embeddings_generated`, `completed`, `failed` | Current pipeline stage |
| `error_message` | String | Error text or null | Why processing failed |

**Status Progression**:
```
uploaded → pending → extracted → tagged → embeddings_generated → completed
                                                                 ↓
                                                              failed
```

### Paths & References

| Field | Type | Description |
|-------|------|-------------|
| `zip_s3_path` | String | Location of uploaded ZIP on S3 |
| `summary_s3_path` | String | Location of dataset summaries |
| `frames_s3_path` | String | Location of extracted frames |
| `embeddings_s3_path` | String | Location of embeddings |

### Timestamps

All timestamps are ISO 8601 format (UTC):

| Field | Set By | Description |
|-------|--------|-------------|
| `created_at` | RegisterUpload Lambda | When record created |
| `updated_at` | UpdateStatus Lambda | When record last modified |
| `processing_started_at` | RegisterUpload Lambda | When extraction starts |
| `processing_completed_at` | UpdateStatus Lambda | When pipeline completes |
| `last_error_at` | UpdateStatus Lambda | When last error occurred |

### Metrics

| Field | Type | Description |
|-------|------|-------------|
| `processing_metrics.total_videos` | Number | Videos found and processed |
| `processing_metrics.total_frames_extracted` | Number | Individual frames extracted |
| `processing_metrics.unique_tags_detected` | Number | Unique tag labels |
| `processing_metrics.processing_duration_seconds` | Number | Total execution time |
| `processing_metrics.estimated_cost_usd` | Number | Approximate cost (for billing) |

### TTL (Time-To-Live)

| Field | Type | Description |
|-------|------|-------------|
| `expiration_timestamp` | Number | Unix timestamp (seconds) for auto-deletion |

Set to `Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60)` for 90-day retention

### Optional Metadata

| Field | Type | Description |
|-------|------|-------------|
| `description` | String | User-friendly description |
| `tags` | List | Custom tags for categorization |
| `visibility` | String | `private`, `shared`, `public` |
| `shared_with` | List | User IDs with access |

---

## Query Examples

### Example 1: Get a Dataset
```bash
aws dynamodb get-item \
  --table-name dataset-uploads-prod \
  --key '{"dataset_id": {"S": "dataset_abc123"}}'
```

### Example 2: Get All Datasets for a User
```bash
aws dynamodb query \
  --table-name dataset-uploads-prod \
  --index-name UserDatasetIndex \
  --key-condition-expression "user_id = :uid" \
  --expression-attribute-values '{":uid": {"S": "user_xyz789"}}'
```

### Example 3: Get User's Datasets (Newest First)
```bash
aws dynamodb query \
  --table-name dataset-uploads-prod \
  --index-name CreationDateIndex \
  --key-condition-expression "user_id = :uid" \
  --expression-attribute-values '{":uid": {"S": "user_xyz789"}}' \
  --scan-index-forward false \
  --limit 10
```

### Example 4: Get Recently Completed Datasets
```bash
aws dynamodb scan \
  --table-name dataset-uploads-prod \
  --filter-expression "processing_status = :status AND created_at > :date" \
  --expression-attribute-values '{
    ":status": {"S": "completed"},
    ":date": {"S": "2024-01-15T00:00:00Z"}
  }'
```

### Example 5: Find Failed Datasets
```bash
aws dynamodb scan \
  --table-name dataset-uploads-prod \
  --filter-expression "processing_status = :status" \
  --expression-attribute-values '{":status": {"S": "failed"}}'
```

---

## Update Operations

### Update Status After Processing Step
```javascript
const params = {
  TableName: 'dataset-uploads-prod',
  Key: { dataset_id: 'dataset_abc123' },
  UpdateExpression: 'SET processing_status = :status, updated_at = :time',
  ExpressionAttributeValues: {
    ':status': 'extracted',
    ':time': new Date().toISOString()
  }
};

await dynamodb.update(params).promise();
```

### Add Processing Metrics on Completion
```javascript
const params = {
  TableName: 'dataset-uploads-prod',
  Key: { dataset_id: 'dataset_abc123' },
  UpdateExpression: `
    SET processing_status = :status,
        processing_completed_at = :completed,
        processing_metrics = :metrics,
        summary_s3_path = :summary,
        updated_at = :time
  `,
  ExpressionAttributeValues: {
    ':status': 'completed',
    ':completed': new Date().toISOString(),
    ':metrics': {
      total_videos: 5,
      total_frames_extracted: 750,
      unique_tags_detected: 47,
      processing_duration_seconds: 1785,
      estimated_cost_usd: 12.50
    },
    ':summary': 's3://bucket/sample_data/dataset_abc123/sample_analysis/metadata/dataset/',
    ':time': new Date().toISOString()
  }
};

await dynamodb.update(params).promise();
```

### Record Error
```javascript
const params = {
  TableName: 'dataset-uploads-prod',
  Key: { dataset_id: 'dataset_abc123' },
  UpdateExpression: `
    SET processing_status = :status,
        error_message = :error,
        last_error_at = :time,
        updated_at = :time
  `,
  ExpressionAttributeValues: {
    ':status': 'failed',
    ':error': 'FFmpeg extraction failed: unrecognized file format',
    ':time': new Date().toISOString()
  }
};

await dynamodb.update(params).promise();
```

---

## Billing & Performance

### Capacity Mode
- **Recommended**: PAY_PER_REQUEST (on-demand)
- **Alternative**: Provisioned with auto-scaling
  - Base: 5 RCU, 5 WCU
  - Auto-scale target: 70% utilization

### Expected Size

| Scenario | Records | Avg Size | Total Size |
|----------|---------|----------|-----------|
| New user | 10 | ~1.5 KB | ~15 KB |
| Active user | 100 | ~1.5 KB | ~150 KB |
| High volume | 10,000 | ~1.5 KB | ~15 MB |
| Very large | 1,000,000 | ~1.5 KB | ~1.5 GB |

### Cost Estimate (PAY_PER_REQUEST, monthly)
- First 5 KB write: $0.00
- Each additional: $1.25 per 1 million writes
- Read: $0.25 per 1 million reads

**Typical cost**: < $1/month for small teams

---

## Monitoring

### CloudWatch Metrics to Watch

```bash
# View table metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=dataset-uploads-prod \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Sum
```

```bash
# View query metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name UserErrors \
  --dimensions Name=TableName,Value=dataset-uploads-prod \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Sum
```

### Alarms (Recommended)

```bash
# Alert if write throttling
aws cloudwatch put-metric-alarm \
  --alarm-name dataset-dynamodb-writes \
  --alarm-description "DynamoDB write throttling" \
  --metric-name WriteThrottleEvents \
  --namespace AWS/DynamoDB \
  --statistic Sum \
  --period 300 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions arn:aws:sns:us-east-1:ACCOUNT:alerts
```

---

## Backup & Recovery

### Enable Point-in-Time Recovery (PITR)

```bash
aws dynamodb update-continuous-backups \
  --table-name dataset-uploads-prod \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
```

### Create On-Demand Backup

```bash
aws dynamodb create-backup \
  --table-name dataset-uploads-prod \
  --backup-name dataset-uploads-prod-2024-01-15
```

### View Backups

```bash
aws dynamodb list-backups \
  --table-name dataset-uploads-prod
```

---

## Access Control (IAM Policy)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:ACCOUNT:table/dataset-uploads-prod",
        "arn:aws:dynamodb:us-east-1:ACCOUNT:table/dataset-uploads-prod/index/*"
      ],
      "Condition": {
        "StringEquals": {
          "dynamodb:LeadingKeys": ["${aws:username}"]
        }
      }
    }
  ]
}
```

This allows users to access only their own datasets (where `user_id` matches their username).

---

## Schema Evolution

If you need to add new fields:

1. **Backward Compatible**: Just add new fields (DynamoDB is schema-less)
2. **No Migration Needed**: Existing items work as-is
3. **Update Code**: Handle missing fields in application logic

Example: Add `dataset_version` field
```javascript
// Old items won't have this field - check before using
const version = item.dataset_version || '1.0';
```

---

## Related Documentation

- [AWS DynamoDB Developer Guide](https://docs.aws.amazon.com/dynamodb/)
- [Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- [Query & Scan Optimization](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.html)
