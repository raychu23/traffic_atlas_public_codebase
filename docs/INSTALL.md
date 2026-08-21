# Installation

## Prerequisites

- Node.js 20 or later
- npm
- `ffmpeg` and `ffprobe`
- AWS credentials for the services enabled in the target environment
- An OpenAI project API key for traffic-scene validation

Video analytics also requires either the local YOLO processing tools or a provisioned DeepStream GPU
worker.

## Install dependencies

```bash
git clone https://github.com/reactor-lab-admin/traffic_atlas_public_codebase.git
cd traffic_atlas_public_codebase
npm run install-all
```

The root package contains the Express API and development tooling. `frontend/` has a separate
lockfile and dependency tree for the React application.

## Configure the backend

```bash
cp .env.example .env
```

Set the Cognito, storage, OpenAI, and processing values required by the environment. Keep `.env`
untracked.

Important settings:

| Variable                     | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `COGNITO_USER_POOL_ID`       | Cognito pool used to verify access tokens                   |
| `STORAGE_BACKEND`            | `s3` for shared storage or the supported local storage mode |
| `OPENAI_API_KEY`             | Backend-only traffic-scene validation credential            |
| `OPENAI_TRAFFIC_SCENE_MODEL` | Vision-capable model available to the OpenAI project        |
| `MAX_VIDEO_UPLOAD_BYTES`     | Maximum video upload size before the request is rejected    |
| `TRAFFIC_PROCESSOR_MODE`     | `local-yolo` or `deepstream-ssh`                            |

Each developer should use a separate credential associated with the Traffic Atlas OpenAI project.
Deployment credentials belong in the hosting platform's secret manager.

### Local authentication

Local authentication is disabled by default. To use the fixed local development identity, set:

```dotenv
DEV_AUTH_ENABLED=true
```

Do not enable this setting in a shared environment.

## Configure the frontend

```bash
cp frontend/.env.example frontend/.env.local
```

For a local API and local authentication:

```dotenv
REACT_APP_API_URL=http://localhost:5001/api
REACT_APP_DEV_AUTH_ENABLED=true
```

The frontend and backend development-auth flags must agree.

## Configure video tooling

Verify the binaries are available:

```bash
ffmpeg -version
ffprobe -version
```

Set `FFMPEG_PATH` and `FFPROBE_PATH` only when the binaries are not on `PATH`.

For `local-yolo`, configure `TRAFFIC_PROCESSOR_ROOT` and `TRAFFIC_PROCESSOR_PYTHON` if the sibling
`traffic-tool` checkout and its `.venv` are not available. For `deepstream-ssh`, configure the
remote host, SSH key, root directory, and container image shown in `.env.example`.

## Run locally

```bash
npm run dev
```

- Frontend: `http://localhost:3000`
- API: `http://localhost:5001/api`

## Verify the checkout

```bash
npm run format:check
npm run verify
npm run test:e2e
```

Playwright requires a Chromium browser. Install it once when it is not already available:

```bash
npx playwright install chromium
```

## S3 CORS

Browser-based S3 uploads and downloads require the frontend origin in the bucket's CORS policy.
Expose at least these response headers:

- `ETag`
- `Content-Length`
- `Content-Disposition`
- `Content-Type`

See `backend/scripts/s3-cors-example.json` for an example policy.

## Production frontend build

```bash
npm ci
npm ci --prefix frontend
npm run build:frontend
```

The generated frontend is written to `frontend/build/`. The backend runs directly on Node.js and
must receive its secrets through the deployment environment.

## Troubleshooting

- Authentication returns `503`: configure Cognito or enable both local development-auth flags.
- Video validation returns `400`: confirm `ffmpeg` and `ffprobe` can read the uploaded codec.
- Video validation returns `503`: check the backend OpenAI credential, model access, and server
  logs.
- Browser requests fail: verify `REACT_APP_API_URL`, API CORS origins, and the frontend deployment
  CSP.
- S3 uploads fail: verify IAM permissions, bucket CORS, bucket name, region, and optional prefix.
