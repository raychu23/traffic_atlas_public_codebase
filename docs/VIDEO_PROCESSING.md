# Traffic video upload

The upload chooser offers Dataset and Video. Dataset continues through the sample ZIP,
metadata, terms, and review workflow. Video validates a traffic-camera clip, starts a
tracking job, displays paths and their endpoints, and lets the user edit zones and
download movement counts. Recounting uses stored tracks; it does not repeat detection.

## Setup

Use the existing authentication and API configuration. The frontend's existing
`REACT_APP_API_URL_TESTING` variable must point to the API (for example
`http://localhost:5001` in `frontend/.env.local`). This feature adds no login bypass.
Keep real credentials in untracked environment files or the deployment secret store.

The API needs `ffmpeg`, `ffprobe`, and a backend-only `OPENAI_API_KEY` for scene
validation. Optional executable paths and video settings are in the root `.env.example`.
The video upload limit defaults to 10 GiB; duration must be under 8 hours.
Use a current Node version supported by the AWS SDK packages (CI uses Node 22).

| Mode | Processing and lifecycle | Required worker |
| --- | --- | --- |
| `local-yolo` | API invokes local Python tracking/counting scripts | Provisioned `traffic-tool` checkout and Python environment |
| `deepstream-ssh` | API transfers video to an already-running GPU host | SSH access, runner scripts, Docker images |
| `ec2-on-demand-ssh` | API starts GPU, discovers its hostname, transfers the job, stops it after idle | Above plus EC2 describe/start/stop permissions |
| `s3-lambda-ec2` | API writes S3 job/manifest; Lambda wakes the S3 worker | S3 trigger, Lambda execution role, GPU instance profile and boot service |
| `sqs-ec2` | S3 artifacts, DynamoDB state, SQS jobs, scheduled wake-up | Provisioned infrastructure stack and GPU worker |

The actual detector/tracker scripts, model weights, GPU Docker images, and CUDA runtime
are separate worker prerequisites, not installed by `npm install`. The local default
is a sibling `../traffic-tool`; override `TRAFFIC_PROCESSOR_ROOT` and
`TRAFFIC_PROCESSOR_PYTHON` when using another location. Remote deployments must install
the runner bundle under `TRAFFIC_DEEPSTREAM_ROOT` and configure the matching image.

See [EC2 API deployment](../deploy/ec2/README.md),
[minimal S3 orchestration](../infrastructure/minimal-on-demand/README.md), and
[queue-based orchestration](../infrastructure/video-on-demand/README.md).
These are deployment resources; pushing this branch does not provision AWS or prove
that a configured worker is reachable.

## API

All video endpoints use the existing authentication middleware and check job ownership.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/videos/validate-upload` | Multipart `videoFile`; validate, persist, then dispatch tracking |
| `GET /api/videos/:videoId` | Status, trajectories, suggested/current zones, count rows |
| `POST /api/videos/:videoId/process` | Retry processing |
| `PUT /api/videos/:videoId/zones` | Save normalized polygons and recount |
| `GET /api/videos/:videoId/artifacts/:artifact` | Owner-authorized artifact retrieval |

The API returns 400 for missing/unsupported files, 413 for oversized uploads, 422
for footage rejected by scene validation, and 503 when the scene checker or video
configuration is unavailable. A video setup failure does not disable dataset routes.

## Persistence and boundaries

`TRAFFIC_VIDEO_DATA_ROOT` places staging, accepted sources, and
`jobs/<video-id>/` on a persistent API-host volume. Each job keeps state, a preview,
trajectories, zone geometry, and output CSVs. In cloud modes S3 holds job inputs,
state/control data, and outputs under the configured prefix. Direct EC2 mode can
also mirror files to S3 when a video bucket is configured.

Uploads still pass through the Node API. For laptop independence, host that API and
its persistent storage; the browser currently does not upload videos directly to S3.
An idle timeout is a shutdown delay after work, not an inference delay.
The direct reference tracker skips annotated-video generation. No automatic
source-retention policy or parallel one-hour chunking is implemented here.

The minimal S3 worker has retries and paginated job discovery, but the final
empty-queue/self-stop race still needs a coordinated shutdown handshake before
claiming production reliability. The queue-based deployment provides a scheduled
wake-up mechanism. Suggested zones currently use the bounded trajectory preview;
they are editable suggestions, not a full-length traffic-quality guarantee.

## Verification

```bash
npm ci
npm ci --prefix frontend
npm run verify
python3 -m unittest discover -s infrastructure/minimal-on-demand -p 'test_*.py'
npx playwright install chromium
npm run test:e2e
```

Backend tests cover validation, real local HTTP upload/error/ownership contracts,
job persistence/recovery, tracking/recount orchestration, and cloud synchronization.
Browser tests use HTTP fixtures; they verify UI and request contracts without
starting an AWS instance or calling OpenAI. GPU accuracy, live IAM access, cold-start
timing, and complete cloud deployment require a separate real-worker acceptance run.
