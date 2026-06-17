#!/bin/bash

# setup-dynamodb.sh
# Create and configure DynamoDB table for dataset processing

set -e

ENVIRONMENT=${1:-dev}
AWS_REGION=${2:-us-east-1}
TABLE_NAME="dataset-uploads-${ENVIRONMENT}"

echo "================================"
echo "DynamoDB Setup"
echo "================================"
echo ""
echo "Environment: $ENVIRONMENT"
echo "Region: $AWS_REGION"
echo "Table: $TABLE_NAME"
echo ""

# ============================================================================
# Create DynamoDB Table
# ============================================================================
echo "Creating DynamoDB table..."

aws dynamodb create-table \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION" \
  --attribute-definitions \
    AttributeName=dataset_id,AttributeType=S \
    AttributeName=user_id,AttributeType=S \
    AttributeName=created_at,AttributeType=S \
  --key-schema \
    AttributeName=dataset_id,KeyType=HASH \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    "[
      {
        \"IndexName\": \"UserDatasetIndex\",
        \"KeySchema\": [
          {\"AttributeName\": \"user_id\", \"KeyType\": \"HASH\"},
          {\"AttributeName\": \"dataset_id\", \"KeyType\": \"RANGE\"}
        ],
        \"Projection\": {\"ProjectionType\": \"ALL\"},
        \"ProvisionedThroughput\": {
          \"ReadCapacityUnits\": 5,
          \"WriteCapacityUnits\": 5
        }
      },
      {
        \"IndexName\": \"CreationDateIndex\",
        \"KeySchema\": [
          {\"AttributeName\": \"user_id\", \"KeyType\": \"HASH\"},
          {\"AttributeName\": \"created_at\", \"KeyType\": \"RANGE\"}
        ],
        \"Projection\": {\"ProjectionType\": \"ALL\"},
        \"ProvisionedThroughput\": {
          \"ReadCapacityUnits\": 5,
          \"WriteCapacityUnits\": 5
        }
      }
    ]" \
  --tags \
    Key=Environment,Value=$ENVIRONMENT \
    Key=Application,Value=DatasetProcessing 2>/dev/null || echo "Table may already exist"

echo "Waiting for table to be active..."
aws dynamodb wait table-exists \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION"

echo "✓ DynamoDB table created: $TABLE_NAME"
echo ""

# ============================================================================
# Enable TTL (optional: auto-delete old datasets after 90 days)
# ============================================================================
echo "Enabling TTL for automatic cleanup..."

aws dynamodb update-time-to-live \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION" \
  --time-to-live-specification "AttributeName=expiration_timestamp,Enabled=true" 2>/dev/null || echo "TTL might already be enabled"

echo ""

# ============================================================================
# Display Table Info
# ============================================================================
echo "================================"
echo "Table Created Successfully!"
echo "================================"
echo ""

aws dynamodb describe-table \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION" \
  --query 'Table.[TableName, TableStatus, ItemCount, TableSizeBytes]' \
  --output table

echo ""
echo "Global Secondary Indexes:"
aws dynamodb describe-table \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION" \
  --query 'Table.GlobalSecondaryIndexes[*].[IndexName, IndexStatus]' \
  --output table

echo ""
echo "Streams Enabled:"
aws dynamodb describe-table \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION" \
  --query 'Table.StreamSpecification' \
  --output table

echo ""
echo "✓ Setup Complete!"
echo ""
