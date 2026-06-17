# Traffic Atlas - API Documentation

## Base URL

```
http://localhost:5001/api
```

## Authentication

All API endpoints (except `/api/auth/login`) require a valid JWT token in the `Authorization` header:

```
Authorization: Bearer <your-jwt-token>
```

## Endpoints

### Authentication

#### POST /api/users/login
Login user and return JWT token.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password"
}
```

**Response:**
```json
{
  "success": true,
  "token": "jwt-token",
  "user": {
    "email": "user@example.com",
    "isAdmin": false
  }
}
```

#### GET /api/auth/me
Get current user profile.

**Headers:** `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "user": {
    "email": "user@example.com",
    "isAdmin": false
  }
}
```

### Datasets

#### GET /api/datasets
List all available datasets.

**Response:**
```json
{
  "success": true,
  "datasets": [
    {
      "id": "dataset-id",
      "title": "Dataset Title",
      "description": "Description",
      "category": "Dataset",
      "access_level": "Public"
    }
  ]
}
```

#### GET /api/datasets/:id
Get dataset details by ID.

**Response:**
```json
{
  "success": true,
  "dataset": {
    "id": "dataset-id",
    "title": "Dataset Title",
    "description": "Description",
    "metadata": {...}
  }
}
```

#### POST /api/datasets/upload-request
Submit new dataset upload request.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`

**Request:**
- Form fields for dataset metadata
- File: `sampleFile` (ZIP file, max 1GB)

**Response:**
```json
{
  "success": true,
  "requestId": "request-id"
}
```

#### POST /api/datasets/:id/download
Request dataset download.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "downloaderMetadata": {...},
  "consents": {...}
}
```

### User Dashboard

#### GET /api/users/me/dashboard
Get user's dashboard data (uploads, downloads).

**Headers:** `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "upload_requests": [...],
  "download_requests": [...]
}
```

### Admin Endpoints

All admin endpoints require admin privileges.

#### GET /api/admin/users
List all users.

#### GET /api/admin/upload-requests
List all upload requests.

#### GET /api/admin/upload-requests/:requestId
Get details of a specific upload request.

#### POST /api/admin/upload-requests/:requestId/approve
Approve upload request.

#### POST /api/admin/upload-requests/:requestId/reject
Reject upload request.

#### POST /api/admin/upload-requests/:requestId/comment
Send a comment/clarification to the uploader.

#### GET /api/admin/download-requests
List all download requests.

#### GET /api/admin/download-requests/:requestId
Get details of a specific download request.

#### POST /api/admin/download-requests/:requestId/approve
Approve download request.

#### POST /api/admin/download-requests/:requestId/reject
Reject download request.

#### POST /api/admin/download-requests/:requestId/comment
Send a comment/clarification to the requester.

### Messaging

#### GET /api/requests/:type/:requestId/messages
Get chat messages for a request (upload or download).

#### POST /api/requests/:type/:requestId/messages
Post a new message to the request chat.

## Error Responses

All endpoints return consistent error format:

```json
{
  "success": false,
  "error": "Error message"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Server Error

## Rate Limiting

API requests are limited to 100 requests per minute per IP address.

## Data Formats

- **Content-Type:** `application/json` (except file uploads)
- **Character Encoding:** UTF-8
- **Date Format:** ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ)
