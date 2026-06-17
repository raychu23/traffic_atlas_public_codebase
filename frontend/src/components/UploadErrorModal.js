import React from 'react';
import './UploadErrorModal.css';

function UploadErrorModal({ message, details = [], onClose }) {
  if (!message) return null;

  return (
    <div className="upload-error-overlay" onClick={onClose}>
      <div className="upload-error-modal" onClick={(e) => e.stopPropagation()}>
        <div className="upload-error-header">
          <div className="upload-error-title">Upload Error</div>
          <button type="button" className="upload-error-close" onClick={onClose}>✕</button>
        </div>
        <div className="upload-error-body">
          <div>{message}</div>
          {Array.isArray(details) && details.length > 0 && (
            <ul className="upload-error-details">
              {details.map((item, idx) => (
                <li key={`${idx}-${String(item)}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="upload-error-actions">
          <button type="button" className="upload-error-dismiss" onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

export default UploadErrorModal;
