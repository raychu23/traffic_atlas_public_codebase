# Quick Reference Guide

## File Structure

```
backend/stepFunctions/
│
├── 📄 README.md                          ← Start here! Architecture overview
├── 📄 METADATA_GUIDE.md                  ← Metadata hierarchy & website integration
├── 📄 QUICK_REFERENCE.md                 ← This file
│
├── 🔷 stateMachine.json                  ← Step Functions state machine definition
│
├── lambdas/                              ← Lightweight orchestration tasks
│   ├── register-upload.js                ← Initialize processing
│   ├── build-tagging-input.js            ← Prepare Bedrock input JSONL
│   ├── parse-tag-outputs.js              ← Process Bedrock output
│   ├── build-summaries.js                ← Aggregate frame→video→dataset
│   └── update-status.js                  ← Update DB status
│
├── batch/                                ← Heavy computation jobs
│   ├── frame-extraction.py               ← FFmpeg frame extraction
│   ├── embedding-generation.py           ← CLIP embedding generation
│   ├── Dockerfile.extraction             ← Container for extraction
│   ├── Dockerfile.embedding              ← Container for embeddings (GPU)
│   ├── requirements-extraction.txt
│   └── requirements-embedding.txt
│
├── infrastructure/
│   └── cloudformation.yaml               ← Complete AWS infrastructure as code
│
├── 🚀 deployment-guide.sh                ← Automated deployment script
└── 🎯 invoke-pipeline.sh                 ← Trigger execution script
```

---

## Quick Start (5 minutes)

### 1. Deploy Infrastructure
```bash
cd backend/stepFunctions
chmod +x deployment-guide.sh
./deployment-guide.sh prod us-east-1
```

### 2. Upload Test Zip
```bash
aws s3 cp sample.zip s3://bucket/sample_data/test_001/uploaded_sample/
```

### 3. Trigger Pipeline
```bash
chmod +x invoke-pipeline.sh
./invoke-pipeline.sh \
  "arn:aws:states:us-east-1:ACCOUNT:stateMachine:DatasetProcessingStateMachine" \
  "test_001" \
  "user_123" \
  "dataset-bucket" \
  "sample_data/test_001/uploaded_sample/sample.zip"
```

### 4. Monitor
```bash
aws stepfunctions describe-execution \
  --execution-arn <EXECUTION_ARN> \
  --query '[status,startDate,stopDate]'
```

---

## Architecture At A Glance

### Step Functions Flow
```
RegisterUpload (Lambda)
    ↓ Create DB record
ExtractFrames (Batch) 
    ↓ FFmpeg → S3: frames/
BuildTaggingInput (Lambda)
    ↓ Create JSONL
RunBedrockBatchInference (Bedrock)
    ↓ Claude tags
ParseTagOutputs (Lambda)
    ↓ Frame & Video summaries
GenerateEmbeddings (Batch)
    ↓ CLIP embeddings
BuildSummaries (Lambda)
    ↓ Aggregate to dataset level
UpdateDatasetStatus (Lambda)
    ↓ Mark complete
```

### Metadata Hierarchy
```
Frame Level (50 tags/frame)
    ↓ Remove noise via frequency
Video Level (top 20% tags)
    ↓ Aggregate across videos
Dataset Level (top 5% tags, >= 5% prevalence)
    ↓ Use for website filters
```

---

## Core Concepts

| Component | Role | Language | Timeout |
|-----------|------|----------|---------|
| **Lambda** | Glue logic, DB ops, list S3 | JavaScript | 5-15 min |
| **Batch** | Heavy compute, long jobs | Python | Hour+ |
| **Bedrock** | LLM tagging | Managed | Async |
| **Step Functions** | Orchestration | JSON | N/A |
| **DynamoDB** | Status tracking | N/A | N/A |
| **S3** | Artifact storage | N/A | N/A |

---

## Configuration

### Environment Variables (Batch)
```bash
DATASET_ID          # Unique dataset identifier
BUCKET              # S3 bucket name
ZIP_KEY             # Key to uploaded zip
OUTPUT_PREFIX       # Where to write outputs
FRAMES_PREFIX       # Where frames are located
```

### Lambda Environment
```bash
DATASET_TABLE       # DynamoDB table name
AWS_REGION          # AWS region
```

### Bedrock Configuration
```bash
Model: anthropic.claude-3-5-sonnet-20241022-v2:0
Input: JSONL format from S3
Output: JSONL format to S3
Batch: Asynchronous processing
```

---

## Key S3 Paths

### Input
```
sample_data/{dataset_id}/uploaded_sample/sample.zip
```

### Intermediate
```
s3://bucket/sample_data/{dataset_id}/sample_analysis/
├── frames/{video}/{frame}/*.jpg
├── embeddings/{video}/{frame}/*.npy
└── ...
```

### Output (For Website)
```
s3://bucket/sample_data/{dataset_id}/sample_analysis/metadata/dataset/
├── dataset_summary.json              # Stats
├── dataset_filter_tags.json          ⭐ USE THIS FOR FILTERS
└── dataset_tag_distribution.json     # Details
```

---

## Debugging Checklist

| Issue | Check |
|-------|-------|
| **Batch job fails** | CloudWatch logs `/aws/batch/job` |
| **Lambda timeout** | Increase memory/timeout in function config |
| **Bedrock errors** | IAM permissions, model access, region |
| **Missing metadata** | Verify Batch jobs completed in CloudWatch |
| **Website filters empty** | Verify `dataset_filter_tags.json` exists |
| **High costs** | Check GPU instance uptime, Batch queue idle |

---

## Frontend Integration

### Load Filters
```javascript
const filterTags = await fetch(
  `s3://bucket/sample_data/{datasetId}/sample_analysis/metadata/dataset/dataset_filter_tags.json`
).then(r => r.json());
```

### Filter Structure
```json
{
  "objects": { "vehicle": {...}, "person": {...} },
  "activities": { "moving": {...} },
  "environment": { "urban": {...} },
  "other": {}
}
```

### Display Rules
- Show only tags where `clickable: true`
- Sort by `prevalence` (descending)
- Use `confidence` for opacity
- Show `count` and `prevalence` in badge

---

## Performance Metrics

| Stage | Typical Time | Cost (100 datasets/mo) |
|-------|-------------|------------------------|
| Frame Extraction | 5 min | $50/mo |
| Bedrock Tagging | 10 min | $200-400/mo |
| Embedding Gen | 15 min | $150-200/mo |
| Aggregation | 2 min | $5/mo |
| **Total** | **~30 min** | **~$575/mo** |

---

## Common Commands

### Check Execution Status
```bash
aws stepfunctions describe-execution \
  --execution-arn <ARN> \
  --query '[status, startDate, stopDate]'
```

### View Batch Jobs
```bash
aws batch list-jobs \
  --job-queue video-processing-queue \
  --job-status RUNNING
```

### Download Metadata
```bash
aws s3 cp \
  s3://bucket/sample_data/{id}/sample_analysis/metadata/dataset/ \
  ./metadata/ \
  --recursive
```

### Query DynamoDB
```bash
aws dynamodb get-item \
  --table-name dataset-uploads-prod \
  --key '{"dataset_id":{"S":"dataset_abc123"}}'
```

### Monitor Costs
```bash
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost
```

---

## Environment Setup

### Local Prerequisites
```bash
# Install AWS CLI
brew install awscli

# Install Docker
brew install docker

# Configure AWS credentials
aws configure

# Set Python 3.11+
python3 --version
```

### Deploy Docker Images
```bash
# Build and push extraction container
docker build -f Dockerfile.extraction -t extraction:latest .
docker tag extraction:latest {ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/extraction:latest
docker push {ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/extraction:latest

# Build and push embedding container
docker build -f Dockerfile.embedding -t embedding:latest .
docker tag embedding:latest {ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/embedding:latest
docker push {ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/embedding:latest
```

---

## Troubleshooting

### Lambda Out of Memory
```bash
# Increase memory from 1024 MB to 2048 MB
aws lambda update-function-configuration \
  --function-name dataset-build-summaries \
  --memory-size 2048 \
  --ephemeral-storage Size=2048
```

### Batch GPU Not Working
```bash
# Verify instance type supports GPU
aws batch describe-compute-environments \
  --compute-environments dataset-compute-prod \
  --query 'computeEnvironments[0].computeResources.instanceTypes'
```

### Bedrock Region Error
```bash
# Bedrock available in: us-east-1, ap-northwest-2, eu-central-1
# Update state machine and Batch jobs to use correct region
```

---

## Next Steps

1. **Custom Categorization**: Update `categorize_tag()` in `build-summaries.js`
2. **Parallel Processing**: Enable Step Functions Distributed Map for 1000+ frames
3. **Real-time Notifications**: Add SNS topics when stages complete
4. **Tag Feedback Loop**: Capture user corrections to improve model
5. **Multi-language**: Extend Bedrock prompt for localization

---

## Support Reference

- **AWS Batch**: https://docs.aws.amazon.com/batch/
- **Step Functions**: https://docs.aws.amazon.com/step-functions/
- **Bedrock**: https://docs.aws.amazon.com/bedrock/
- **FFmpeg**: https://ffmpeg.org/documentation.html
- **CLIP**: https://github.com/openai/CLIP

---

**Last Updated**: 2024-01-15
**Version**: 1.0.0
**Status**: Production Ready ✓
