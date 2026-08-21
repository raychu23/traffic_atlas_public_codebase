# Minimal S3 → Lambda → one GPU EC2

This is the smallest TrafficAtlas on-demand path. It has no CloudFormation, SQS, DynamoDB,
EventBridge, second EC2, or permanent queue host.

```
Node upload API → S3 input + state + control manifest → Lambda starts GPU
GPU systemd worker → S3 results/state → idle GPU stop
```

Enable it with:

```dotenv
TRAFFIC_PROCESSOR_MODE=s3-lambda-ec2
TRAFFIC_VIDEO_BUCKET=traffic-atlas-db
TRAFFIC_VIDEO_S3_PREFIX=traffic-video-jobs
AWS_REGION=us-east-1
```

The backend writes the input, then `state.json`, then `control/*.json` last. The final manifest
write is the GPU wake-up signal. The worker records the terminal state before deleting the manifest.

## One-time setup

Create two roles:

1. Lambda: CloudWatch Logs write plus `ec2:DescribeInstances` and `ec2:StartInstances` for
   `i-09d7366988c2ec368`.
2. GPU instance profile: `s3:ListBucket` for the job prefix; S3 get/put/delete for
   `traffic-video-jobs/*`; and `ec2:StopInstances` for itself.

Attach the second role to the GPU. Configure the bucket to invoke `lambda/wake_gpu.handler` for JSON
events beneath `traffic-video-jobs/`; the handler rejects anything outside `/control/`.

## GPU worker install

Install `worker/traffic_s3_worker.py`, `worker/traffic-s3-worker.service`, the existing
`worker/finalize-video-job.js`, and `backend/videoJobs.js` under `/opt/traffic-atlas-worker`. Create
`/etc/traffic-atlas/s3-worker.env`:

```dotenv
AWS_REGION=us-east-1
TRAFFIC_VIDEO_BUCKET=traffic-atlas-db
TRAFFIC_VIDEO_S3_PREFIX=traffic-video-jobs
TRAFFIC_WORK_ROOT=/srv/traffic-video/s3-work
TRAFFIC_APP_ROOT=/srv/traffic-video/app
TRAFFIC_YOLO_IMAGE=traffic-yolo:cam5-reference
TRAFFIC_COUNT_IMAGE=traffic-video:ds8-atlas-20260722
TRAFFIC_IDLE_TIMEOUT_SECONDS=900
TRAFFIC_FINALIZER=/opt/traffic-atlas-worker/finalize-video-job.js
TRAFFIC_VIDEO_JOBS_MODULE=/opt/traffic-atlas-worker/videoJobs.js
```

Enable `traffic-s3-worker.service`. It starts whenever the GPU boots, so Lambda only starts EC2 and
never needs SSH.

## Boundary

This removes the GPU dependency from the Node API. The current React app still submits through that
API, so a laptop-hosted API works as a temporary bridge. A direct-browser presign/status Lambda is a
separate authentication/API migration, not required for GPU wake-up.
