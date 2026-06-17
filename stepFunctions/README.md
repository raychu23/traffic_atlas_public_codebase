# Dataset Sample Processing Pipeline - Step Functions Architecture

Complete AWS Step Functions-based orchestration for video frame extraction, AI tagging, embedding generation, and dataset-level aggregation.

## Architecture Overview

```
User Upload (Zip)
    ↓
S3 Upload + RegisterUpload (Lambda)
    ↓
Database Record Created
    ↓
ExtractFrames (AWS Batch)
    ├─ Unzip file
    ├─ Scan for videos
    ├─ Extract frames (1 fps)
    └─ Upload to S3: sample_data/{dataset_id}/sample_analysis/frames/
    ↓
BuildTaggingInput (Lambda)
    ├─ List all frames
    ├─ Build JSONL for Bedrock
    └─ Upload to S3
    ↓
RunBedrockBatchInference (Bedrock)
    ├─ Process with Claude 3.5 Sonnet
    ├─ Generate tags per frame
    └─ Save output JSONL
    ↓
ParseTagOutputs (Lambda)
    ├─ Frame-level metadata: sample_data/{dataset_id}/sample_analysis/metadata/frames/
    ├─ Video-level summaries: sample_data/{dataset_id}/sample_analysis/metadata/videos/
    └─ Normalize tags
    ↓
GenerateEmbeddings (AWS Batch)
    ├─ Load CLIP model
    ├─ Generate embeddings per frame
    └─ Save to S3: sample_data/{dataset_id}/sample_analysis/embeddings/
    ↓
BuildSummaries (Lambda)
    ├─ Aggregate video-level → dataset-level
    ├─ Create filter tags (hierarchical)
    └─ Generate dataset summaries
    ↓
UpdateDatasetStatus (Lambda)
    └─ Mark dataset as ready
    └─ Database updated with summary path
    ↓
Website Filters Ready
```

## S3 Folder Structure

```
sample_data/
└── <dataset_id>/
    ├── uploaded_sample/
    │   └── sample_dataset.zip
    │
    └── sample_analysis/
        ├── manifest/
        │   ├── upload_manifest.json
        │   ├── video_inventory.json
        │   └── processing_status.json
        │
        ├── frames/
        │   ├── <video_name_1>/
        │   │   ├── frame_000001.jpg
        │   │   ├── frame_000002.jpg
        │   │   └── ...
        │   └── <video_name_2>/
        │       └── ...
        │
        ├── embeddings/
        │   ├── <video_name_1>/
        │   │   ├── frame_000001.npy
        │   │   ├── frame_000001.npy.metadata.json
        │   │   └── ...
        │   └── <video_name_2>/
        │       └── ...
        │
        ├── metadata/
        │   ├── frames/
        │   │   ├── <video_name_1>/
        │   │   │   ├── frame_000001.json
        │   │   │   ├── frame_000002.json
        │   │   │   └── ...
        │   │   └── <video_name_2>/
        │   │       └── ...
        │   │
        │   ├── videos/
        │   │   ├── <video_name_1>.json
        │   │   ├── <video_name_2>.json
        │   │   └── ...
        │   │
        │   └── dataset/
        │       ├── dataset_summary.json
        │       ├── dataset_filter_tags.json
        │       └── dataset_tag_distribution.json
        │
        └── logs/
            ├── extraction_log.json
            ├── tagging_log.json
            ├── embedding_log.json
            └── error_logs/
```

## Metadata Hierarchy

### 1. Frame-Level Metadata
**Path**: `metadata/frames/{video_name}/{frame_name}.json`

```json
{
  "tags": ["vehicle", "street", "urban"],
  "confidence_scores": [0.95, 0.92, 0.88],
  "description": "City street with parked cars",
  "bedrock_raw": {...},
  "processed_at": "2024-01-15T10:30:00Z"
}
```

### 2. Video-Level Summary
**Path**: `metadata/videos/{video_name}.json`

Aggregates all frames in a video:

```json
{
  "video_name": "traffic_scene_001",
  "frame_count": 150,
  "detected_tags": ["vehicle", "street", "person", "urban", ...],
  "tag_details": {
    "vehicle": {
      "count": 142,
      "avg_confidence": 0.94,
      "frequency_in_video": 142
    },
    ...
  },
  "coverage": 45,
  "processing_date": "2024-01-15T10:35:00Z"
}
```

### 3. Dataset-Level Summaries
**Path**: `metadata/dataset/{summary_type}.json`

#### dataset_summary.json
Overall statistics for the entire dataset:

```json
{
  "dataset_id": "dataset_abc123",
  "summary_generated_at": "2024-01-15T10:40:00Z",
  "processing_summary": {
    "total_videos": 5,
    "total_frames_sampled": 750,
    "unique_tags_detected": 47
  },
  "dominant_tags": [
    {
      "tag": "vehicle",
      "occurrences": 680,
      "confidence": 0.94,
      "prevalence": 90.7
    },
    {
      "tag": "street",
      "occurrences": 720,
      "confidence": 0.91,
      "prevalence": 96.0
    }
  ],
  "all_detected_tags": ["vehicle", "street", "person", ...],
  "tag_coverage": {
    "total_unique_tags": 47,
    "by_category": {
      "objects": 22,
      "activities": 14,
      "environment": 11
    }
  },
  "dataset_status": "processing_complete",
  "ready_for_web_display": true
}
```

#### dataset_filter_tags.json
Hierarchical tags for website filter UI:

```json
{
  "objects": {
    "vehicle": {
      "count": 680,
      "confidence": 0.94,
      "prevalence": 90.7,
      "clickable": true
    },
    "person": {
      "count": 230,
      "confidence": 0.87,
      "prevalence": 30.7,
      "clickable": true
    }
  },
  "activities": {
    "moving": {
      "count": 450,
      "confidence": 0.85,
      "prevalence": 60.0,
      "clickable": true
    }
  },
  "environment": {
    "urban": {
      "count": 720,
      "confidence": 0.91,
      "prevalence": 96.0,
      "clickable": true
    }
  },
  "other": {}
}
```

#### dataset_tag_distribution.json
Detailed statistics per tag:

```json
{
  "vehicle": {
    "total_occurrences": 680,
    "videos_with_tag": 5,
    "avg_confidence": 0.94,
    "prevalence_percentage": 90.7,
    "video_coverage": ["traffic_001", "traffic_002", ...]
  },
  ...
}
```

## Website Filter Implementation

The **dataset_filter_tags.json** feeds the website filter UI:

```javascript
// Frontend usage
const filterTags = await fetch(
  `s3://bucket/sample_data/{dataset_id}/sample_analysis/metadata/dataset/dataset_filter_tags.json`
);

// Render filter groups (Objects, Activities, Environment)
// Only show tags where "clickable": true (prevalence >= 5%)
// Use "prevalence" for sorting/weighting
// Use "count" for badge counts
```

## Deployment

### Prerequisites
- AWS Account with permissions for Lambda, Batch, DynamoDB, S3, ECR, Step Functions
- AWS CLI configured
- Docker (for building container images)

### Step 1: Build and Push Docker Images

```bash
cd backend/stepFunctions/batch

# Build frame extraction image
docker build -f Dockerfile.extraction -t dataset-processing:extraction .
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
docker tag dataset-processing:extraction <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/dataset-processing:extraction
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/dataset-processing:extraction

# Build embedding generation image
docker build -f Dockerfile.embedding -t dataset-processing:embedding .
docker tag dataset-processing:embedding <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/dataset-processing:embedding
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/dataset-processing:embedding
```

### Step 2: Create Batch Job Definitions

```bash
aws batch register-job-definition \
  --job-definition-name dataset-frame-extraction \
  --type container \
  --container-properties image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/dataset-processing:extraction,vcpus=4,memory=8192,jobRoleArn=<BATCH_ROLE_ARN>

aws batch register-job-definition \
  --job-definition-name dataset-embedding-generation \
  --type container \
  --container-properties image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/dataset-processing:embedding,vcpus=4,memory=16384,jobRoleArn=<BATCH_ROLE_ARN>,resourceRequirements='[{type=GPU,value=1}]'
```

### Step 3: Deploy CloudFormation Stack

```bash
aws cloudformation create-stack \
  --stack-name dataset-processing-pipeline \
  --template-body file://infrastructure/cloudformation.yaml \
  --parameters ParameterKey=EnvironmentName,ParameterValue=prod \
  --capabilities CAPABILITY_NAMED_IAM
```

### Step 4: Package and Deploy Lambda Functions

```bash
# Package each Lambda directory
cd lambdas
zip -r register-upload.zip register-upload.js node_modules/
zip -r build-tagging-input.zip build-tagging-input.js node_modules/
zip -r parse-tag-outputs.zip parse-tag-outputs.js node_modules/
zip -r build-summaries.zip build-summaries.js node_modules/
zip -r update-status.zip update-status.js node_modules/

# Upload to Lambda
aws lambda update-function-code \
  --function-name dataset-register-upload \
  --zip-file fileb://register-upload.zip
```

## Triggering the Pipeline

### From S3 Upload
When a zip is uploaded to `s3://bucket/sample_data/<dataset_id>/uploaded_sample/`:

```javascript
// Event from S3 trigger
const event = {
  dataset_id: 'dataset_abc123',
  user_id: 'user_xyz789',
  bucket: 'dataset-processing-bucket',
  zip_key: 'sample_data/dataset_abc123/uploaded_sample/sample.zip'
};

// Start Step Functions execution
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:ACCOUNT_ID:stateMachine:DatasetProcessingStateMachine \
  --input "$(echo $event | jq -c .)"
```

## Performance & Costs

### Processing Time (approx. for 5 videos, 150 frames)
- Frame extraction: 2-5 minutes
- Bedrock tagging: 5-15 minutes
- Embedding generation: 10-20 minutes
- Aggregation: 1-2 minutes
- **Total: ~20-40 minutes**

### Cost Breakdown (monthly, 100 datasets)
- Lambda: ~$20
- DynamoDB: ~$5 (minimal usage)
- Batch (EC2): ~$300-500
- S3: ~$50
- Bedrock batch inference: ~$200-400 (depends on model usage)
- **Total: ~$575-975/month**

## Monitoring & Debugging

### CloudWatch Logs
- Lambda: `/aws/lambda/dataset-*`
- Batch: `/aws/batch/job`
- Step Functions: `Step Functions Execution History`

### Check Pipeline Status

```bash
# Get Step Functions execution status
aws stepfunctions describe-execution \
  --execution-arn arn:aws:states:us-east-1:ACCOUNT_ID:execution:DatasetProcessingStateMachine:dataset_abc123

# View S3 artifacts
aws s3 ls s3://bucket/sample_data/dataset_abc123/sample_analysis/

# Check DynamoDB status
aws dynamodb get-item \
  --table-name dataset-uploads-prod \
  --key '{"dataset_id":{"S":"dataset_abc123"}}'
```

### Debugging Common Issues

**Frames not extracted:**
- Check Batch job logs in CloudWatch
- Verify video codec compatibility (FFmpeg)
- Check S3 permissions

**Bedrock tagging failed:**
- Verify Bedrock model access in your region
- Check IAM permissions for BedrockFullAccess
- Review Bedrock pricing and quotas

**Embeddings empty:**
- Verify CLIP model can be downloaded (requires internet/proxy)
- Check GPU availability in compute environment
- Review Batch job error logs

## Next Steps

1. **Parallel Frame Processing**: Use Step Functions Distributed Map for large datasets
2. **Custom Models**: Replace Bedrock with custom SageMaker endpoint
3. **Real-time Updates**: Add WebSocket notifications to frontend during processing
4. **Tag Refinement**: Implement feedback loop to improve tag quality
5. **Multi-format Support**: Extend to image uploads, PDFs, etc.

## Files Overview

```
backend/stepFunctions/
├── stateMachine.json                    # Step Functions definition
├── lambdas/
│   ├── register-upload.js               # Initialize processing
│   ├── build-tagging-input.js           # Prepare Bedrock input
│   ├── parse-tag-outputs.js             # Process Bedrock output
│   ├── build-summaries.js               # Aggregate to dataset level
│   └── update-status.js                 # Update DB status
├── batch/
│   ├── frame-extraction.py              # FFmpeg frame extraction
│   ├── embedding-generation.py          # CLIP embeddings
│   ├── Dockerfile.extraction            # Container for extraction
│   ├── Dockerfile.embedding             # Container for embeddings
│   ├── requirements-extraction.txt
│   └── requirements-embedding.txt
├── infrastructure/
│   └── cloudformation.yaml              # Full AWS stack definition
└── README.md
```
