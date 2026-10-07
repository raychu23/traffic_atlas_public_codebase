#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-traffic-atlas-video-production}"
GPU_INSTANCE_ID="${GPU_INSTANCE_ID:-i-09d7366988c2ec368}"
IDLE_TIMEOUT_SECONDS="${TRAFFIC_IDLE_TIMEOUT_SECONDS:-900}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$SCRIPT_DIR/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    EnvironmentName=production \
    GpuInstanceId="$GPU_INSTANCE_ID"

output() {
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

VIDEO_BUCKET="$(output VideoBucket)"
VIDEO_QUEUE_URL="$(output VideoQueueUrl)"
VIDEO_JOBS_TABLE="$(output VideoJobsTable)"
GPU_INSTANCE_PROFILE="$(output GpuWorkerInstanceProfileName)"

cp "$SCRIPT_DIR"/worker/* "$BUILD_DIR/"
cp "$REPO_ROOT/backend/videoJobs.js" "$BUILD_DIR/videoJobs.js"
cp "$REPO_ROOT/backend/videoDataPaths.js" "$BUILD_DIR/videoDataPaths.js"
tar -C "$BUILD_DIR" -czf "$BUILD_DIR/traffic-video-worker.tar.gz" \
  traffic_video_worker.py \
  finalize-video-job.js \
  traffic-video-worker.service \
  install-worker.sh \
  requirements.txt \
  videoJobs.js \
  videoDataPaths.js
aws s3 cp \
  "$BUILD_DIR/traffic-video-worker.tar.gz" \
  "s3://$VIDEO_BUCKET/bootstrap/traffic-video-worker.tar.gz" \
  --region "$REGION"

CURRENT_PROFILE_ARN="$(
  aws ec2 describe-iam-instance-profile-associations \
    --region "$REGION" \
    --filters "Name=instance-id,Values=$GPU_INSTANCE_ID" \
    --query "IamInstanceProfileAssociations[?State!='disassociated'] | [0].IamInstanceProfile.Arn" \
    --output text
)"
if [[ "$CURRENT_PROFILE_ARN" == "None" ]]; then
  aws ec2 associate-iam-instance-profile \
    --region "$REGION" \
    --instance-id "$GPU_INSTANCE_ID" \
    --iam-instance-profile "Name=$GPU_INSTANCE_PROFILE" >/dev/null
elif [[ "$CURRENT_PROFILE_ARN" != */"$GPU_INSTANCE_PROFILE" ]]; then
  echo "EC2 already has an instance profile association; refusing to replace it automatically." >&2
  exit 1
fi

aws ec2 start-instances \
  --region "$REGION" \
  --instance-ids "$GPU_INSTANCE_ID" >/dev/null
aws ec2 wait instance-status-ok \
  --region "$REGION" \
  --instance-ids "$GPU_INSTANCE_ID"

COMMAND_ID="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$GPU_INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters commands="[
      \"set -euo pipefail\",
      \"rm -rf /tmp/traffic-video-worker && mkdir -p /tmp/traffic-video-worker\",
      \"aws s3 cp s3://$VIDEO_BUCKET/bootstrap/traffic-video-worker.tar.gz /tmp/traffic-video-worker.tar.gz --region $REGION\",
      \"tar -C /tmp/traffic-video-worker -xzf /tmp/traffic-video-worker.tar.gz\",
      \"sudo bash /tmp/traffic-video-worker/install-worker.sh '$VIDEO_QUEUE_URL' '$VIDEO_JOBS_TABLE' '$REGION' '$IDLE_TIMEOUT_SECONDS'\"
    ]" \
    --query "Command.CommandId" \
    --output text
)"
aws ssm wait command-executed \
  --region "$REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$GPU_INSTANCE_ID"
aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$GPU_INSTANCE_ID" \
  --query "{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}"

aws ec2 stop-instances \
  --region "$REGION" \
  --instance-ids "$GPU_INSTANCE_ID" >/dev/null

cat <<EOF
TRAFFIC_PROCESSOR_MODE=sqs-ec2
AWS_REGION=$REGION
TRAFFIC_VIDEO_BUCKET=$VIDEO_BUCKET
TRAFFIC_VIDEO_QUEUE_URL=$VIDEO_QUEUE_URL
TRAFFIC_VIDEO_JOBS_TABLE=$VIDEO_JOBS_TABLE
TRAFFIC_VIDEO_S3_PREFIX=traffic-video-jobs
EOF
