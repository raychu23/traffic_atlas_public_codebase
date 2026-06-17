#!/bin/bash

# deployment-guide.sh
# Complete Step-by-Step Deployment Guide for Dataset Processing Pipeline

set -e

echo "================================"
echo "Dataset Processing Pipeline"
echo "Deployment Guide"
echo "================================"
echo ""

# Configuration
ENVIRONMENT=${1:-dev}
AWS_REGION=${2:-us-east-1}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO_NAME="dataset-processing"

echo "Environment: $ENVIRONMENT"
echo "Region: $AWS_REGION"
echo "Account: $AWS_ACCOUNT_ID"
echo ""

# ============================================================================
# Step 1: Create ECR Repositories
# ============================================================================
echo "Step 1: Creating ECR repositories..."

aws ecr create-repository \
  --repository-name $ECR_REPO_NAME \
  --region $AWS_REGION 2>/dev/null || echo "Repository already exists"

echo "✓ ECR repositories ready"
echo ""

# ============================================================================
# Step 2: Build and Push Docker Images
# ============================================================================
echo "Step 2: Building and pushing Docker images..."

cd batch/

# Frame extraction image
echo "Building frame extraction image..."
docker build -f Dockerfile.extraction -t $ECR_REPO_NAME:extraction .

echo "Pushing frame extraction image..."
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker tag $ECR_REPO_NAME:extraction \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:extraction
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:extraction

# Embedding generation image
echo "Building embedding generation image..."
docker build -f Dockerfile.embedding -t $ECR_REPO_NAME:embedding .

echo "Pushing embedding generation image..."
docker tag $ECR_REPO_NAME:embedding \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:embedding
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:embedding

echo "✓ Docker images pushed to ECR"
cd ..
echo ""

# ============================================================================
# Step 3: Deploy CloudFormation Stack
# ============================================================================
echo "Step 3: Deploying CloudFormation stack..."

STACK_NAME="dataset-processing-$ENVIRONMENT"

aws cloudformation create-stack \
  --stack-name $STACK_NAME \
  --template-body file://infrastructure/cloudformation.yaml \
  --parameters ParameterKey=EnvironmentName,ParameterValue=$ENVIRONMENT \
             ParameterKey=ECRRepositoryName,ParameterValue=$ECR_REPO_NAME \
  --capabilities CAPABILITY_NAMED_IAM \
  --region $AWS_REGION 2>/dev/null || \
aws cloudformation update-stack \
  --stack-name $STACK_NAME \
  --template-body file://infrastructure/cloudformation.yaml \
  --parameters ParameterKey=EnvironmentName,ParameterValue=$ENVIRONMENT \
             ParameterKey=ECRRepositoryName,ParameterValue=$ECR_REPO_NAME \
  --capabilities CAPABILITY_NAMED_IAM \
  --region $AWS_REGION

echo "Waiting for stack to complete..."
aws cloudformation wait stack-create-complete \
  --stack-name $STACK_NAME \
  --region $AWS_REGION 2>/dev/null || echo "Stack already exists or update in progress"

echo "✓ CloudFormation stack deployed"
echo ""

# ============================================================================
# Step 4: Register Batch Job Definitions
# ============================================================================
echo "Step 4: Registering AWS Batch job definitions..."

EXTRACTION_IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:extraction"
EMBEDDING_IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:embedding"

# Get Batch execution role ARN from CloudFormation
BATCH_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`BatchExecutionRoleArn`].OutputValue' \
  --output text \
  --region $AWS_REGION)

echo "Batch Role ARN: $BATCH_ROLE_ARN"

# Register frame extraction job definition
aws batch register-job-definition \
  --job-definition-name dataset-frame-extraction \
  --type container \
  --region $AWS_REGION \
  --container-properties \
    image=$EXTRACTION_IMAGE,\
vcpus=4,\
memory=8192,\
jobRoleArn=$BATCH_ROLE_ARN,\
mountPoints='[],',\
environment='[{name=AWS_REGION,value='"$AWS_REGION"'}]'

# Register embedding generation job definition
aws batch register-job-definition \
  --job-definition-name dataset-embedding-generation \
  --type container \
  --region $AWS_REGION \
  --container-properties \
    image=$EMBEDDING_IMAGE,\
vcpus=4,\
memory=16384,\
jobRoleArn=$BATCH_ROLE_ARN,\
resourceRequirements='[{type=GPU,value=1}]',\
environment='[{name=AWS_REGION,value='"$AWS_REGION"'}]'

echo "✓ Batch job definitions registered"
echo ""

# ============================================================================
# Step 5: Deploy Lambda Functions
# ============================================================================
echo "Step 5: Deploying Lambda functions..."

cd lambdas/

for func in register-upload build-tagging-input parse-tag-outputs build-summaries update-status; do
  echo "Packaging $func..."
  
  rm -rf $func-package/
  mkdir -p $func-package/
  
  cp $func.js $func-package/index.js
  
  # Copy node_modules if they exist
  if [ -d "node_modules" ]; then
    cp -r node_modules $func-package/
  fi
  
  cd $func-package/
  zip -r ../$func.zip . > /dev/null 2>&1
  cd ..
  
  echo "Deploying $func Lambda..."
  aws lambda update-function-code \
    --function-name dataset-$func \
    --zip-file fileb://$func.zip \
    --region $AWS_REGION 2>/dev/null || echo "Function not yet created by CloudFormation"
done

cd ..
echo "✓ Lambda functions deployed"
echo ""

# ============================================================================
# Step 6: Verify Deployment
# ============================================================================
echo "Step 6: Verifying deployment..."

echo "Checking CloudFormation stack outputs..."
aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $AWS_REGION \
  --query 'Stacks[0].Outputs' \
  --output table

echo ""
echo "Checking Lambda functions..."
aws lambda list-functions \
  --region $AWS_REGION \
  --query 'Functions[?starts_with(FunctionName, `dataset-`)].[FunctionName,Runtime]' \
  --output table

echo ""
echo "Checking Batch job queues..."
aws batch describe-job-queues \
  --region $AWS_REGION \
  --query 'jobQueues[*].[jobQueueName,state]' \
  --output table

echo ""
echo "================================"
echo "✓ Deployment Complete!"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Upload a test zip to S3"
echo "2. Trigger Step Functions execution"
echo "3. Monitor progress in CloudWatch"
echo ""
echo "Example execution:"
echo "aws stepfunctions start-execution \\"
echo "  --state-machine-arn <STATE_MACHINE_ARN> \\"
echo "  --input '{\"dataset_id\": \"test_001\", \"user_id\": \"user_123\", \"bucket\": \"<BUCKET>\", \"zip_key\": \"<ZIP_KEY>\"}' \\"
echo "  --region $AWS_REGION"
echo ""
