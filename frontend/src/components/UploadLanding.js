import React from 'react';
import { useNavigate } from 'react-router-dom';
import './UploadLanding.css';
import { SAMPLE_UPLOAD_LIMIT_BYTES, formatUploadLimit } from '../config/uploadLimits';

const PROCESS_STEPS = [
  {
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 3.75h5.5L18.25 8.5V19A1.25 1.25 0 0 1 17 20.25H8A1.25 1.25 0 0 1 6.75 19V5A1.25 1.25 0 0 1 8 3.75Z" />
        <path d="M13.5 3.75V8.5h4.75" />
        <path d="M9.25 12h5.5" />
        <path d="M9.25 15.5h5.5" />
      </svg>
    ),
    title: 'Submission Request Form',
    description: 'Fill out the form and upload a sample of your dataset, which we will review.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 7.75v4.25l2.5 1.5" />
      </svg>
    ),
    title: 'Wait',
    description: 'This review process usually takes ...',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 15.75V6" />
        <path d="m8.25 9.5 3.75-3.75 3.75 3.75" />
        <path d="M5.75 16.25v1.5A1.5 1.5 0 0 0 7.25 19.25h9.5a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
      </svg>
    ),
    title: 'Data Upload',
    description: 'Input further information about your dataset, upload your full dataset as a zip, and make your preferred citation.',
  },
];

function UploadLanding() {
  const navigate = useNavigate();
  const userId = localStorage.getItem('userId');

  const handleUpload = () => {
    if (!userId) {
      navigate('/register');
      return;
    }
    navigate('/upload/metadata');
  };

  return (
    <div className="upload-page">
      <div className="blob blob-left-top" />
      <div className="blob blob-right-top" />
      <div className="blob blob-left-mid" />
      <div className="blob blob-right-mid" />

      <section className="upload-hero-wrap">
        <div className="upload-hero-copy">
          <h1>Input the who, what, when, where, and your data will be live after approval!</h1>
          <button className="upload-pill-btn" onClick={handleUpload}>
            Upload Data
          </button>
        </div>

        <div className="upload-hero-media">
          <img
            src="/images/AdobeStock_556078681-1024x611.jpg"
            alt="Highway traffic"
            className="media-main"
          />
          <img
            src="/images/methodshop-four-color-traffic-lights-8750618_1920.png"
            alt="City night traffic"
            className="media-secondary"
          />
        </div>
      </section>

      <section className="upload-process-wrap">
        <div className="process-left-col">
          <div className="process-header">
            <h2>Uploading Data: The 3-Step Process</h2>
            <button className="upload-pill-btn upload-process-cta" onClick={handleUpload}>
              Upload Data
            </button>
          </div>

          <div className="process-grid">
            {PROCESS_STEPS.map((step, index) => (
              <article
                className={`step-item${index === 1 ? ' step-item-divider' : ''}${index === 2 ? ' step-item-wide' : ''}`}
                key={step.title}
              >
                <div className="step-icon">{step.icon}</div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </article>
            ))}
          </div>
        </div>

        <aside className="sample-panel">
          <div className="sample-shell">
            <div className="sample-panel-header">
              <div>
                <div className="sample-head">Upload Sample Dataset</div>
                <div className="sample-sub">
                  Upload a compressed (.zip) file • Recommended size &lt;{formatUploadLimit(SAMPLE_UPLOAD_LIMIT_BYTES)}
                </div>
              </div>
            </div>

            <div className="sample-zone">
              <div className="sample-zone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 15.75V6" />
                  <path d="m8.25 9.5 3.75-3.75 3.75 3.75" />
                  <path d="M5.75 16.25v1.5A1.5 1.5 0 0 0 7.25 19.25h9.5a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
                </svg>
              </div>
              <p>Drag and drop your file here</p>
              <span>or</span>
              <button type="button" onClick={handleUpload}>Browse Files</button>
            </div>

            <div className="sample-meta-row">
              <div className="sample-note">This should be a representative sample, not your full dataset.</div>
              <button
                type="button"
                className="sample-footnote-link"
                onClick={() => navigate('/upload/guidelines')}
              >
                Review upload guidelines
              </button>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

export default UploadLanding;
