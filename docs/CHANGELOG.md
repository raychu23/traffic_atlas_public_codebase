# Traffic Atlas - Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Complete project restructure from TransVision Hub to Traffic Atlas
- Comprehensive documentation (README, API, Architecture, Installation)
- GitHub community standards (Contributing, Issue Templates, License)
- Professional project structure (frontend/backend separation)
- **New documentation structure in `docs/` directory**

### Changed
- Renamed all references from "TransVision Hub" to "Traffic Atlas"
- Updated project structure from server/client to backend/frontend
- Improved environment configuration with .env.example
- Enhanced build and deployment scripts
- **Cleaned up root directory by removing `requirements.txt` and `.venv`**
- **Removed unused `sqlite3` dependency from backend**

### Removed
- Legacy configuration files (amplify.yml, requirements.txt)
- Unnecessary build artifacts and local data
- Redundant documentation and migration notes

### Security
- Updated AWS SDK dependencies to latest versions
- Enhanced authentication middleware documentation
- Improved security considerations in documentation

## [1.0.0] - 2026-03-27

### Added
- Initial release of Traffic Atlas
- S3-based storage architecture
- AWS Cognito authentication
- React frontend with modern UI
- Node.js/Express backend API
- Dataset upload/download workflows
- Admin dashboard and approval system
- User management and access controls
- Comprehensive API documentation
- Multi-deployment options (Amplify, EC2, Docker)

### Features
- **Core Functionality**
  - User registration and authentication
  - Dataset metadata management
  - File upload with validation
  - Access control and permissions
  - Admin approval workflows

- **Technical Features**
  - JWT-based authentication
  - S3 integration for storage
  - Email notifications via SES
  - Responsive web design
  - RESTful API design
  - Database audit logging

- **Deployment**
  - AWS Amplify hosting
  - EC2 deployment guide
  - Docker containerization
  - Environment configuration
  - Production optimization

### Documentation
- Complete README with setup instructions
- API documentation with examples
- Architecture overview
- Installation guide
- Contributing guidelines
- MIT License

### Dependencies
- Node.js 16+ runtime
- React 18 frontend
- Express.js backend
- AWS SDK v3
- Modern JavaScript/TypeScript
