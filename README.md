# Traffic Atlas

> Open-access cloud-based traffic video repository

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![React Version](https://img.shields.io/badge/react-18.2.0-blue)](https://reactjs.org/)

## 🚀 Quick Start

```bash
git clone <repository-url>
cd traffic-atlas
npm run install-all
cp .env.example .env
# Configure .env with your AWS credentials
npm run dev
```

## 📖 Documentation

- [**README.md**](README.md) - Project overview and main entry point
- [**INSTALL.md**](docs/INSTALL.md) - Installation instructions
- [**API.md**](docs/API.md) - API documentation
- [**ARCHITECTURE.md**](docs/ARCHITECTURE.md) - System architecture
- [**CHANGELOG.md**](docs/CHANGELOG.md) - Version history

## 🌟 Features

- **S3-based Storage** - Scalable cloud storage with AWS S3
- **User Authentication** - Secure login with AWS Cognito
- **Dataset Management** - Upload, download, and manage traffic datasets
- **Admin Dashboard** - Review and approve user submissions
- **Modern UI** - Responsive React frontend with Tailwind CSS

## 🛠️ Technology Stack

### Video upload

The upload page also accepts traffic video for trajectory tracking, editable zones,
and movement-count CSVs. See [Video processing](docs/VIDEO_PROCESSING.md) for setup,
worker requirements, supported processing modes, and verification limits.

- **Frontend**: React 18, React Router, Axios, Tailwind CSS
- **Backend**: Node.js, Express.js, JWT, Multer
- **Infrastructure**: AWS S3, Cognito, SES, IAM
- **Development**: TypeScript, Nodemon, ESLint

## 📁 Project Structure

```
traffic-atlas/
├── backend/                 # Node.js/Express API
│   ├── index.js            # Main server entry
│   ├── auth.js             # Authentication middleware
│   ├── storage.js          # Data management
│   ├── s3Storage.js        # AWS S3 operations
│   ├── scripts/            # Utility scripts
│   └── data/               # Local data structure
├── frontend/               # React application
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── services/       # API services
│   │   └── App.js          # Main app
│   └── public/
├── docs/                   # Project documentation
├── .github/                # GitHub community files
├── .env.example            # Environment template
└── package.json            # Dependencies and scripts
```

## 🚀 Deployment

### AWS Amplify (Frontend)
```bash
cd frontend
npm run build
amplify init
amplify add hosting
amplify publish --prod
```

### AWS EC2 (Full Application)
```bash
# Clone and install
git clone <repository-url>
cd traffic-atlas
npm run install-all

# Build frontend
cd frontend && npm run build

# Configure PM2 and Nginx (see docs/INSTALL.md)
```

### Docker
```bash
docker build -t traffic-atlas .
docker run -p 5001:5001 traffic-atlas
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](.github/CONTRIBUTING.md) for details.

- Fork the repository
- Create a feature branch
- Submit a pull request
- Follow our code of conduct

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔗 Links

- [Documentation](docs/)
- [API Reference](docs/API.md)
- [Installation Guide](docs/INSTALL.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [Issue Tracker](https://github.com/your-org/traffic-atlas/issues)
- [Discussions](https://github.com/your-org/traffic-atlas/discussions)

## � Support

For support and questions:
- Create an [issue](https://github.com/your-org/traffic-atlas/issues)
- Start a [discussion](https://github.com/your-org/traffic-atlas/discussions)
- Check our [documentation](docs/)

---

**Traffic Atlas** - Building the future of traffic data sharing 🚗📊
