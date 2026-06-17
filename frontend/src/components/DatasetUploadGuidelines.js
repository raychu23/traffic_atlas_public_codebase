import React from 'react';
import { useNavigate } from 'react-router-dom';
import './UploadMetadata.css';
import { SAMPLE_UPLOAD_LIMIT_BYTES, formatUploadLimit } from '../config/uploadLimits';

function DatasetUploadGuidelines() {
  const navigate = useNavigate();

  return (
    <div className="container upload-atlas">
      <div className="card upload-card">
        <div className="metadata-section" style={{ textAlign: 'center', marginBottom: '40px' }}>
          <h1 style={{ fontSize: '28px', color: '#0b1834', marginBottom: '8px' }}>Dataset Upload Guidelines</h1>
          <p style={{ color: '#737373', fontSize: '16px' }}>Traffic & Transportation Data Repository</p>
        </div>

        <div className="metadata-section">
          <h2>1. Scope of Supported Datasets</h2>
          <p>Accepted topics include traffic videos, images, sensor/telemetry data, annotations, and supporting metadata/documentation for transportation operations, safety, research, or education.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>2. Accepted Data Formats</h2>
          <p><strong>Video:</strong> .mp4, .avi, .mkv | <strong>Images:</strong> .jpg, .png | <strong>Tabular:</strong> .csv, .txt | <strong>Metadata:</strong> .json, .yaml | <strong>Docs:</strong> .txt, .md, .pdf</p>
          <p style={{ marginTop: '8px', fontStyle: 'italic', color: '#e31b0c' }}>Executable files or scripts are not permitted.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>3. Folder Structure Requirements</h2>
          <p>Use clear folder hierarchies; sample and full dataset structure must match.</p>
          <pre style={{ 
            background: '#f8fafc', 
            padding: '16px', 
            borderRadius: '8px', 
            border: '1px solid #e2e8f0',
            marginTop: '12px',
            fontFamily: 'monospace',
            fontSize: '14px',
            color: '#334155'
          }}>
{`dataset_name/
├── videos/
│   ├── intersection_day/
│   └── intersection_night/
├── images/
├── annotations/
├── metadata/
│   ├── dataset_metadata.json
│   └── README.txt
└── documentation/`}
          </pre>
        </div>

        <div className="metadata-section section-divider">
          <h2>4. Metadata Requirements (Mandatory)</h2>
          <p>Include title, description, collection method, location/date range, file formats/naming conventions, and known limitations in metadata/.</p>
          <p style={{ marginTop: '8px' }}><strong>Accepted metadata formats:</strong> .json, .csv, .yaml, .txt.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>5. File Naming & Data Quality</h2>
          <p>Use descriptive filenames, avoid special characters where possible, ensure files are readable, and remove duplicates/unnecessary files.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>6. Content, Privacy & Compliance</h2>
          <p>Contributors must confirm legal sharing rights, transportation relevance, no explicit/18+ content, and appropriate consent/privacy protections where required.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>7. Dataset Packaging</h2>
          <p>Upload compressed <strong>.zip archives only</strong>. ZIPs must include folder structure, data files, metadata, and documentation. Password-protected ZIPs are not accepted.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>8. Sample Dataset Submission</h2>
          <p>Initial review requires a representative sample dataset (max {formatUploadLimit(SAMPLE_UPLOAD_LIMIT_BYTES)}, recommended 500 MB or less), using the same folder structure and metadata as the full dataset.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>9. Full Dataset Upload (Post-Approval)</h2>
          <p>After sample approval, the full dataset must follow the same structure and metadata format and may undergo additional validation.</p>
        </div>

        <div className="metadata-section section-divider">
          <h2>10. Review & Approval Process</h2>
          <p>All submissions are reviewed for relevance, structural consistency, and compliance. Sample approval does not guarantee full-dataset acceptance if major differences are found.</p>
        </div>

        <div className="upload-fixed-cta">
          <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)}>
            Back
          </button>
          <button type="button" className="btn figma-cta" onClick={() => navigate('/upload/metadata')}>
            Go To Upload Wizard
          </button>
        </div>
      </div>
    </div>
  );
}

export default DatasetUploadGuidelines;
