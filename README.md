# Traffic Atlas

Traffic Atlas is a web application for publishing, discovering, and analyzing traffic datasets and
traffic-camera video. It provides dataset review workflows, Cognito-based authentication, S3-backed
storage, and asynchronous vehicle tracking and movement counting.

## Capabilities

- Submit a representative dataset sample and metadata for review.
- Review, approve, search, and download published datasets.
- Validate traffic-video uploads before processing.
- Run vehicle tracking through a local YOLO worker or a remote DeepStream worker.
- Edit traffic zones and recalculate movement counts without rerunning tracking.
- Download tracking, count, preview, and annotated-video artifacts.

## Requirements

- Node.js 20 or later
- npm
- `ffmpeg` and `ffprobe` for video validation
- AWS Cognito for shared or production authentication
- AWS credentials and an S3 bucket when `STORAGE_BACKEND=s3`
- An OpenAI project API key for traffic-scene validation
- A compatible local YOLO checkout or provisioned DeepStream worker for video analytics

## Local setup

```bash
git clone https://github.com/reactor-lab-admin/traffic_atlas_public_codebase.git
cd traffic_atlas_public_codebase
npm run install-all
cp .env.example .env
cp frontend/.env.example frontend/.env.local
npm run dev
```

Configure `.env` before starting the backend. The frontend runs on port `3000`; the API defaults to
port `5001`.

For local work without Cognito, set both of these flags:

```dotenv
# .env
DEV_AUTH_ENABLED=true

# frontend/.env.local
REACT_APP_DEV_AUTH_ENABLED=true
```

Development authentication is opt-in and must remain disabled in shared and deployed environments.

## OpenAI credentials

`OPENAI_API_KEY` is read only by the backend. Never use a `REACT_APP_*` variable for this secret or
commit a real key to the repository.

For team development, add developers to the Traffic Atlas OpenAI project and use separate
credentials for each developer or environment. Store deployment credentials in the platform's secret
manager.

## Development commands

| Command                  | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `npm run dev`            | Start the API and React development server        |
| `npm run server`         | Start the API with nodemon                        |
| `npm run client`         | Start the React development server                |
| `npm run lint`           | Lint changed JavaScript files                     |
| `npm run format`         | Format changed source and documentation files     |
| `npm run format:check`   | Check formatting without modifying files          |
| `npm run test:backend`   | Run backend tests                                 |
| `npm run test:frontend`  | Run frontend tests once                           |
| `npm run test:e2e`       | Run Playwright browser tests                      |
| `npm run build:frontend` | Build the production frontend                     |
| `npm run audit:backend`  | Audit backend production dependencies             |
| `npm run audit:frontend` | Audit frontend production dependencies            |
| `npm run verify`         | Run the pre-merge static checks, tests, and build |

Lint and formatting are applied incrementally to files changed by the branch. This avoids an
unrelated repository-wide rewrite while ensuring that new work meets the configured standards.

## Project structure

```text
backend/                 Express API, authentication, storage, and video jobs
backend/videoValidation/ Video metadata, frame extraction, and scene validation
frontend/src/            React application
e2e/                     Playwright browser workflows
stepFunctions/           AWS processing pipeline resources
docs/                    API, architecture, and installation documentation
.github/workflows/       Required continuous-integration checks
```

## Video-processing modes

`TRAFFIC_PROCESSOR_MODE=local-yolo` runs the configured Python tracking and counting scripts
locally. `TRAFFIC_PROCESSOR_MODE=deepstream-ssh` transfers accepted videos to a provisioned GPU
worker and retrieves the generated artifacts. See [Architecture](docs/ARCHITECTURE.md) for the
processing flow and [Installation](docs/INSTALL.md) for configuration.

For the EC2-only on-demand deployment, keep the Node API on an always-running CPU instance and set
`TRAFFIC_VIDEO_DATA_ROOT` to an EBS-backed directory outside the Git checkout. The API starts the
GPU worker for tracking/recounts, copies results back, and stops it after the idle window. See
[`deploy/ec2/README.md`](deploy/ec2/README.md) for the service, storage, IAM, and nginx setup.

## Quality and security

Pull requests run the following gates:

1. ESLint and Prettier checks for changed files.
2. Backend and frontend tests.
3. Production frontend build.
4. Production dependency audit.
5. Playwright browser workflow tests.

Do not commit `.env`, private keys, uploaded videos, job data, or generated artifacts.
Authentication is fail-closed unless Cognito or explicit local development authentication is
configured.

## Documentation

- [Installation](docs/INSTALL.md)
- [API reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [AWS pipeline handoff](docs/AWS_PIPELINE_HANDOFF.md)
- [Contributing](.github/CONTRIBUTING.md)

## License

Traffic Atlas is licensed under the [MIT License](LICENSE).
