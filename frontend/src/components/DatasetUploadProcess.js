import React from 'react';
import PropTypes from 'prop-types';
import './DatasetUploadProcess.css';
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
    title: 'Choose a sample',
    description: 'Select a representative ZIP that uses the same structure as the full dataset.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 7.75v4.25l2.5 1.5" />
      </svg>
    ),
    title: 'Describe the dataset',
    description: 'Add ownership, collection, access, licensing, and contact metadata.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 15.75V6" />
        <path d="m8.25 9.5 3.75-3.75 3.75 3.75" />
        <path d="M5.75 16.25v1.5A1.5 1.5 0 0 0 7.25 19.25h9.5a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
      </svg>
    ),
    title: 'Submit for review',
    description: 'Confirm the terms and send the request to the Traffic Atlas review team.',
  },
];

function DatasetUploadProcess({
  zipFile,
  fileSizeLabel,
  onFileSelect,
  onRemoveFile,
  onContinue,
  onOpenGuidelines,
}) {
  return (
    <section className="dataset-process-wrap">
      <div className="dataset-process-left">
        <div className="dataset-process-header">
          <h1>Submit a dataset</h1>
          <button type="button" className="upload-pill-btn" onClick={onContinue}>
            Continue
          </button>
        </div>

        <div className="dataset-process-grid">
          {PROCESS_STEPS.map((step, index) => (
            <article
              className={`dataset-step-item${index === 1 ? ' dataset-step-item-divider' : ''}${index === 2 ? ' dataset-step-item-wide' : ''}`}
              key={step.title}
            >
              <div className="dataset-step-icon">{step.icon}</div>
              <h2>{step.title}</h2>
              <p>{step.description}</p>
            </article>
          ))}
        </div>
      </div>

      <aside className="dataset-sample-panel">
        <div className="dataset-sample-shell">
          <div className="dataset-sample-header">
            <h2>Upload Sample Dataset</h2>
            <p>ZIP format · Maximum {formatUploadLimit(SAMPLE_UPLOAD_LIMIT_BYTES)}</p>
          </div>

          {zipFile ? (
            <div className="dataset-file-picked">
              <div className="dataset-file-info">
                <span className="file-icon" aria-hidden="true">
                  ZIP
                </span>
                <span>
                  {zipFile.name} ({fileSizeLabel})
                </span>
              </div>
              <button
                type="button"
                className="remove-file-btn"
                onClick={onRemoveFile}
                aria-label={`Remove ${zipFile.name}`}
              >
                Remove
              </button>
            </div>
          ) : (
            <label
              className="dataset-sample-zone"
              htmlFor="datasetSampleZipFile"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                onFileSelect(event.dataTransfer.files?.[0]);
              }}
            >
              <div className="dataset-sample-zone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 15.75V6" />
                  <path d="m8.25 9.5 3.75-3.75 3.75 3.75" />
                  <path d="M5.75 16.25v1.5A1.5 1.5 0 0 0 7.25 19.25h9.5a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
                </svg>
              </div>
              <p>Drag and drop your file here</p>
              <span>or</span>
              <strong>Browse Files</strong>
              <input
                id="datasetSampleZipFile"
                type="file"
                accept=".zip"
                onChange={(event) => onFileSelect(event.target.files?.[0])}
              />
            </label>
          )}

          <div className="dataset-sample-meta-row">
            <div className="dataset-sample-note">
              This should be a representative sample, not your full dataset.
            </div>
            <button type="button" className="sample-footnote-link" onClick={onOpenGuidelines}>
              Review upload guidelines
            </button>
          </div>
        </div>
      </aside>
    </section>
  );
}

DatasetUploadProcess.propTypes = {
  zipFile: PropTypes.shape({
    name: PropTypes.string.isRequired,
  }),
  fileSizeLabel: PropTypes.string.isRequired,
  onFileSelect: PropTypes.func.isRequired,
  onRemoveFile: PropTypes.func.isRequired,
  onContinue: PropTypes.func.isRequired,
  onOpenGuidelines: PropTypes.func.isRequired,
};

export default DatasetUploadProcess;
