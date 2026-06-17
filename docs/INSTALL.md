# Traffic Atlas - Installation Guide

## Prerequisites

- Node.js 16+ and npm
- AWS Account with S3 access
- AWS CLI configured (for S3 operations)

## Quick Start

```bash
# Clone the repository
git clone <repository-url>
cd traffic-atlas

# Install all dependencies (backend + frontend)
npm run install-all

# Configure environment variables
cp .env.example .env
# Edit .env with your AWS credentials and configuration

# Start development servers
npm run dev
```

## Manual Installation

### Backend Dependencies

```bash
cd backend
npm install
```

### Frontend Dependencies

```bash
cd frontend
npm install
```

## Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Server
PORT=5001

# AWS Cognito (User Authentication)
COGNITO_USER_POOL_ID=your-pool-id
COGNITO_CLIENT_ID=your-client-id
COGNITO_REGION=us-east-1
COGNITO_ACCESS_KEY_ID=your-cognito-key
COGNITO_SECRET_ACCESS_KEY=your-cognito-secret

# Admin Configuration
ADMIN_EMAILS=admin@example.com

# AWS/S3 Storage Configuration
STORAGE_BACKEND=s3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-s3-key
AWS_SECRET_ACCESS_KEY=your-s3-secret
S3_BUCKET=your-bucket-name
S3_PREFIX=traffic-atlas/repo
S3_ENDPOINT=https://your-s3-endpoint
S3_FORCE_PATH_STYLE=true
```

### S3 CORS for browser uploads/downloads

If the frontend uploads to or downloads from S3 directly in the browser, your bucket must allow CORS for your frontend origin and expose download headers needed for progress UI.

A working example is provided at `backend/scripts/s3-cors-example.json`.
Make sure your bucket CORS exposes at least:

- `ETag`
- `Content-Length`
- `Content-Disposition`
- `Content-Type`

This is required so the browser can read file metadata and compute download progress for presigned S3 downloads.

## Development

```bash
# Start both backend and frontend
npm run dev

# Start backend only
npm run server

# Start frontend only
npm run client
```

## Production Build

```bash
# Build frontend for production
cd frontend
npm run build

# Backend is Node.js - no build required
# Just ensure production dependencies are installed
cd backend
npm install --production
```

## Troubleshooting

- **Port conflicts**: Kill processes on ports 3000 and 5001
- **AWS credentials**: Ensure IAM permissions include S3, Cognito, and SES access
- **CORS issues**: Verify frontend API URL matches backend CORS settings

For detailed deployment instructions, see [README.md](../README.md).
