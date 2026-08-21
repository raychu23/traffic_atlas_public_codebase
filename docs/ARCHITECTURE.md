# Architecture

## System Architecture

Traffic Atlas is a React application backed by an Express API and AWS services:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend API   │    │   AWS Services  │
│   (React)       │◄──►│   (Node.js)     │◄──►│   (S3, Cognito) │
│   Port: 3000    │    │   Port: 5001    │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Technology Stack

### Frontend

- React 18
- React Router
- Axios
- CSS stylesheets

### Backend

- Node.js and Express
- Cognito JWT verification
- Multer file handling
- AWS SDK clients
- `ffmpeg` and `ffprobe` subprocesses

### Infrastructure

- AWS S3 for shared object storage
- AWS Cognito for user authentication
- AWS SES for email notifications
- AWS Step Functions and batch jobs for dataset processing
- A local YOLO worker or remote DeepStream GPU worker for video analytics

## Data Flow

### Authentication Flow

1. The user submits credentials to `/api/users/login`.
2. The backend authenticates the user with Cognito.
3. The frontend stores the returned tokens in local storage.
4. Axios sends the access token in the `Authorization` header.
5. The backend verifies the token signature and issuer against Cognito JWKS.

### Dataset Upload Flow

1. User fills metadata form and uploads sample ZIP
2. Backend stores sample in S3 (or local `uploads/`) and metadata in `data/`
3. Admin reviews upload request via Admin Dashboard
4. Upon approval, user uploads full dataset
5. Dataset becomes available for search and download

### Dataset Download Flow

1. User requests dataset download
2. Backend checks access permissions (Open vs Request-based)
3. If approved, streams file from S3 or local storage to user
4. User downloads directly or via generated link

### Traffic Video Analytics Flow

1. React uploads a video to the authenticated Node API.
2. Node uses ffprobe/ffmpeg plus the configured OpenAI traffic-scene check to validate the video and
   extract a real preview frame.
3. A persistent job under `backend/data/video_jobs/{videoId}` starts the configured local or remote
   processor.
4. The processor writes `tracks.csv` and, when supported, `annotated.mp4`; Node derives a bounded
   trajectory preview for the browser.
5. React overlays the trajectories and editable normalized zones on the source frame.
6. Each confirmed zone edit is converted to pixel-coordinate `zones.geojson` and produces a
   refreshed `movement_counts.csv` without rerunning tracking.

Tracking is intentionally separated from recounting: the expensive model runs once, while zone edits
reuse the existing track table.

The processor mode is selected through `TRAFFIC_PROCESSOR_MODE`. `local-yolo` invokes local Python,
`deepstream-ssh` retains the fixed-host prototype, `ec2-on-demand-ssh` automatically starts and
stops the existing EC2 worker, and the durable production design uses `sqs-ec2`.

### EC2-only on-demand compatibility mode

`ec2-on-demand-ssh` is available where the backend can manage the existing EC2 instance but cannot
provision S3 or SQS. The backend serializes all tracking and recount operations, calls
`StartInstances`, waits for instance and system health checks, discovers the current public
hostname, uses the existing SSH/SCP processor, and calls `StopInstances` after the configured idle
window.

This mode removes idle GPU cost without requiring additional AWS services. Its limitation is that
the backend remains the queue and artifact store, so backend downtime can delay or interrupt jobs.
When the API is deployed to an always-running EC2 instance,
`TRAFFIC_VIDEO_DATA_ROOT=/var/lib/traffic-atlas/video` keeps accepted sources, job JSON, logs,
trajectories, zones, count CSVs, and annotated videos on its persistent EBS volume outside the Git
checkout. Outputs are copied back before the GPU stops, so completed jobs remain available while the
GPU volume is offline.

### On-demand GPU video orchestration

In `sqs-ec2` mode:

1. The API uploads the accepted source video to an encrypted S3 job prefix.
2. The API creates a durable DynamoDB job record and sends a FIFO SQS message.
3. An EventBridge schedule invokes the controller Lambda every minute.
4. The controller starts the configured EBS-backed GPU EC2 instance only when work is visible.
5. A systemd worker starts at boot, long-polls SQS, and processes one job at a time.
6. The worker runs the pinned YOLO11/ByteTrack container, derives trajectory and K-means zone
   artifacts, performs the initial movement count, uploads results to S3, and updates DynamoDB.
7. The API polling endpoint synchronizes ready artifacts for the existing frontend contract.
8. Zone edits enqueue a recount action that reuses `tracks.csv`; tracking does not rerun.
9. When no visible or in-flight work remains for the configured idle window, the worker calls
   `StopInstances` on itself. The scheduled controller protects against the enqueue/shutdown race by
   starting it again if work appears.

The infrastructure is defined in `infrastructure/video-on-demand/template.yaml`. The original SSH
mode remains available as an operational rollback while the queue path is introduced.

## Storage Architecture

### File System Structure

```
traffic-atlas/
├── backend/
│   ├── data/               # Metadata and activity logs (JSON)
│   │   └── video_jobs/     # Job state, zones, previews, and analytics outputs
│   ├── uploads/            # Temporary upload staging
│   ├── index.js            # Main API entry point
│   ├── videoJobs.js        # Persistent worker/recount orchestration
│   ├── storage.js          # Unified storage abstraction
│   ├── s3Storage.js        # AWS S3 implementation
│   ├── auth.js             # Auth middleware
│   ├── cognito.js          # Cognito integration
│   └── ...
├── frontend/
│   ├── src/                # React components and services
│   └── public/             # Static assets
└── docs/                   # Documentation files
```

### S3 / Data Root Structure

```
data_root/
├── datasets/
│   └── {dataset-id}/
│       ├── metadata.json
│       ├── LICENSE.txt
│       ├── sample/
│       └── full/
├── users/
│   └── {user-id}/
│       ├── profile.json
│       └── activity_log.json
├── requests/
│   ├── upload/
│   └── download/
└── audit/
```

## Security Architecture

### Authentication

- AWS Cognito for user management
- JWT tokens for session management
- Role-based access control (Admin group in Cognito)

### Data Protection

- S3 server-side encryption
- HTTPS for all API traffic
- Audit logging for all critical operations

## Deployment Architecture

### Development

- Local Node.js server with nodemon
- React dev server with HMR
- Environment-based configuration via `.env`

### Production Options

- **Amplify**: For frontend hosting
- **EC2/PM2**: For backend hosting
- **Docker**: For containerized environments

The EC2-only deployment assets are under `deploy/ec2/`. The always-running API EC2 instance requires
an instance profile that can describe, start, and stop only the configured GPU worker. Pushing the
repository does not deploy the backend unless a separate EC2 deployment workflow or host-side
release step is configured.

## Monitoring & Observability

### Logging

- Console logging for server events
- Audit log files for user/data actions

### Health Checks

- Basic server start verification
- AWS connectivity checks
