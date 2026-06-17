#!/bin/bash

# invoke-pipeline.sh
# Example script to trigger the Dataset Processing Pipeline

set -e

# Configuration
STATE_MACHINE_ARN=$1
DATASET_ID=$2
USER_ID=$3
BUCKET=$4
ZIP_KEY=$5
AWS_REGION=${6:-us-east-1}

if [ -z "$STATE_MACHINE_ARN" ] || [ -z "$DATASET_ID" ]; then
  echo "Usage: $0 <STATE_MACHINE_ARN> <DATASET_ID> <USER_ID> <BUCKET> <ZIP_KEY> [AWS_REGION]"
  echo ""
  echo "Example:"
  echo "  $0 arn:aws:states:us-east-1:123456789:stateMachine:DatasetProcessingStateMachine \\"
  echo "       dataset_abc123 user_xyz789 my-bucket sample_data/dataset_abc123/uploaded_sample/sample.zip"
  echo ""
  exit 1
fi

echo "================================"
echo "Dataset Processing Pipeline"
echo "Execution Trigger"
echo "================================"
echo ""
echo "State Machine: $STATE_MACHINE_ARN"
echo "Dataset ID: $DATASET_ID"
echo "User ID: $USER_ID"
echo "Bucket: $BUCKET"
echo "Zip Key: $ZIP_KEY"
echo "Region: $AWS_REGION"
echo ""

# Create input JSON
INPUT_JSON=$(cat <<EOF
{
  "dataset_id": "$DATASET_ID",
  "user_id": "$USER_ID",
  "bucket": "$BUCKET",
  "zip_key": "$ZIP_KEY",
  "bedrockRoleArn": "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):role/BedrockServiceRole"
}
EOF
)

echo "Input:"
echo "$INPUT_JSON" | jq .
echo ""

# Start execution
echo "Starting execution..."
EXECUTION_ARN=$(aws stepfunctions start-execution \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --name "execution-${DATASET_ID}-$(date +%s)" \
  --input "$INPUT_JSON" \
  --region "$AWS_REGION" \
  --query 'executionArn' \
  --output text)

echo "✓ Execution started: $EXECUTION_ARN"
echo ""

# Poll for status
echo "Monitoring execution..."
echo ""

while true; do
  STATUS=$(aws stepfunctions describe-execution \
    --execution-arn "$EXECUTION_ARN" \
    --region "$AWS_REGION" \
    --query 'status' \
    --output text)
  
  case $STATUS in
    RUNNING)
      echo "Status: RUNNING 🔄"
      ;;
    SUCCEEDED)
      echo "Status: SUCCEEDED ✓"
      
      # Get output
      OUTPUT=$(aws stepfunctions describe-execution \
        --execution-arn "$EXECUTION_ARN" \
        --region "$AWS_REGION" \
        --query 'output' \
        --output text)
      
      echo ""
      echo "Final output:"
      echo "$OUTPUT" | jq .
      break
      ;;
    FAILED)
      echo "Status: FAILED ✗"
      
      # Get error details
      aws stepfunctions describe-execution \
        --execution-arn "$EXECUTION_ARN" \
        --region "$AWS_REGION" \
        --query '[status,cause,error]' \
        --output table
      exit 1
      ;;
    *)
      echo "Status: $STATUS"
      ;;
  esac
  
  sleep 10
done

echo ""
echo "================================"
echo "✓ Pipeline Execution Complete!"
echo "================================"
echo ""
echo "Artifacts available at:"
echo "  s3://$BUCKET/sample_data/$DATASET_ID/sample_analysis/"
echo ""
echo "Key outputs:"
echo "  Frames: sample_analysis/frames/"
echo "  Embeddings: sample_analysis/embeddings/"
echo "  Metadata: sample_analysis/metadata/"
echo "  Summaries: sample_analysis/metadata/dataset/"
echo ""
