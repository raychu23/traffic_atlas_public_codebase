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

1. Lambda: CloudWatch Logs write, `ec2:DescribeInstances` on `*`, and `ec2:StartInstances`
   limited to `i-09d7366988c2ec368`. Also grant `s3:GetObject` on the single lifecycle object
   `arn:aws:s3:::traffic-atlas-db/traffic-video-jobs/_workers/i-09d7366988c2ec368/lifecycle.json`.
2. GPU instance profile: `s3:ListBucket` for the job prefix; S3 get/put/delete for
   `traffic-video-jobs/*`; and `ec2:StopInstances` for itself.

Attach the second role to the GPU. Configure the bucket to invoke `lambda/wake_gpu.handler` for JSON
events beneath `traffic-video-jobs/`; the handler rejects anything outside `/control/`.
Set Lambda environment variables `GPU_INSTANCE_ID`, `TRAFFIC_VIDEO_BUCKET`, and
`TRAFFIC_VIDEO_S3_PREFIX` to the same instance, bucket, and prefix used by the worker.

## GPU worker install

Install `worker/traffic_s3_worker.py`, `worker/traffic-s3-worker.service`, the existing
`../video-on-demand/worker/finalize-video-job.js`, `backend/videoJobs.js`, and
`backend/videoDataPaths.js` under `/opt/traffic-atlas-worker`. Create
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

The worker writes an `active` lifecycle object on startup. Before idle shutdown it writes
`stopping`, then scans for jobs once more. A job found in that scan cancels shutdown and restores
`active`. An upload after the final scan sees the `stopping` intent in Lambda, so its invocation
fails for retry even if EC2 still reports `running`. A stopped instance can be started regardless
of its previous marker, and worker startup clears stale shutdown intent. Marker write/read errors
fail closed: the worker does not stop if its intent or cancellation write fails, and Lambda does
not acknowledge a running worker with a missing or unreadable marker. The object is retained with
`active` state rather than deleted, so Lambda needs only exact-object read permission.

Keep Lambda asynchronous retries enabled. This handshake covers the normal upload/shutdown race;
it does not guarantee delivery after retries or the event age limit are exhausted. If the worker
cannot boot, IAM denies access, or a stale marker persists after a crash, inspect the retained
control manifest and retry its wake-up after recovery. Worker `zones.json` stores initial zone
suggestions; `zones.geojson` stores the latest polygons used for counting.

## Boundary

This removes the GPU dependency from the Node API. The current React app still submits through that
API, so a laptop-hosted API works as a temporary bridge. A direct-browser presign/status Lambda is a
separate authentication/API migration, not required for GPU wake-up.
