# Traffic Atlas - Architecture Overview

## System Architecture

Traffic Atlas is a full-stack web application built with a modern microservices architecture:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend API   │    │   AWS Services  │
│   (React)       │◄──►│   (Node.js)     │◄──►│   (S3, Cognito) │
│   Port: 3000    │    │   Port: 5001    │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Technology Stack

### Frontend
- **React 18** - UI framework
- **React Router** - Client-side routing
- **Axios** - HTTP client
- **Tailwind CSS** - Styling
- **TypeScript** - Type safety

### Backend
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **JWT** - Authentication tokens
- **Multer** - File upload handling
- **AWS SDK** - AWS service integration

### Infrastructure
- **AWS S3** - File storage
- **AWS Cognito** - User authentication
- **AWS SES** - Email notifications
- **AWS IAM** - Access management

## Data Flow

### Authentication Flow
1. User submits credentials to `/api/users/login`
2. Backend validates with AWS Cognito
3. JWT token returned and stored in localStorage
4. Token included in Authorization header for API calls

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

## Storage Architecture

### File System Structure
```
traffic-atlas/
├── backend/
│   ├── data/               # Metadata and activity logs (JSON)
│   ├── uploads/            # Temporary upload staging
│   ├── index.js            # Main API entry point
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

## Monitoring & Observability

### Logging
- Console logging for server events
- Audit log files for user/data actions

### Health Checks
- Basic server start verification
- AWS connectivity checks
