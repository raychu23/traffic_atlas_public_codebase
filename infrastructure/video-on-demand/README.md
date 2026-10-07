# TrafficAtlas on-demand GPU video processing

This stack converts the fixed, always-running SSH GPU prototype into a durable queue-driven worker.

## Runtime flow

1. The API validates the upload before accepting it.
2. The accepted file is encrypted and written under
   `s3://<bucket>/traffic-video-jobs/<videoId>/input/`.
3. DynamoDB stores the authoritative state and SQS FIFO stores tracking or recount work.
4. EventBridge invokes the controller every minute. If the queue is non-empty and the GPU instance
   is stopped, the controller calls `StartInstances`.
5. The EC2 systemd worker long-polls the queue, runs jobs serially, publishes artifacts, and updates
   state.
6. After the queue has no visible or in-flight messages for 15 minutes, the worker calls
   `StopInstances` on its own instance.

## Job states

Tracking uses:

`queued -> processing -> ready`

Failures use:

`queued -> processing -> failed -> retry or dead-letter queue`

Movement recounting uses:

`queued -> calculating -> ready`

The queue visibility timeout is six hours so a 30-minute or larger upload is not processed twice.
After three failed receives, SQS moves the message to the dead-letter queue.

## Deployment

Prerequisites:

- An AWS principal allowed to deploy CloudFormation, IAM, S3, SQS, DynamoDB, Lambda, EventBridge,
  CloudWatch, EC2 instance-profile associations, and SSM commands.
- The existing `g4dn.xlarge` worker and its EBS volume.
- The validated worker images and `/srv/traffic-video/app` already present on that volume.

Run:

```bash
AWS_REGION=us-east-1 \
GPU_INSTANCE_ID=i-09d7366988c2ec368 \
./infrastructure/video-on-demand/deploy.sh
```

The script:

1. Deploys the CloudFormation stack.
2. Packages and uploads the worker bundle.
3. Temporarily starts EC2.
4. Installs and enables the systemd worker through Systems Manager.
5. Stops EC2.
6. Prints the backend environment variables.

Attach the stack's `BackendPolicyArn` output to the production backend execution role. Do not attach
it to frontend identities.

## Backend configuration

```dotenv
TRAFFIC_PROCESSOR_MODE=sqs-ec2
AWS_REGION=us-east-1
TRAFFIC_VIDEO_BUCKET=<VideoBucket output>
TRAFFIC_VIDEO_QUEUE_URL=<VideoQueueUrl output>
TRAFFIC_VIDEO_JOBS_TABLE=<VideoJobsTable output>
TRAFFIC_VIDEO_S3_PREFIX=traffic-video-jobs
TRAFFIC_COUNT_BIN_SECONDS=900
```

## Rollback

Set `TRAFFIC_PROCESSOR_MODE=deepstream-ssh` to use the previous fixed-host execution path. The
CloudFormation stack retains its S3 bucket and DynamoDB table on deletion to protect job data.

## Operational checks

```bash
aws sqs get-queue-attributes \
  --queue-url "$TRAFFIC_VIDEO_QUEUE_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws ec2 describe-instances \
  --instance-ids "$GPU_INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name'

aws logs tail "/aws/lambda/traffic-atlas-video-controller-production" --follow
```
