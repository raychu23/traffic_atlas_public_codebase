import React from 'react';
import { useNavigate } from 'react-router-dom';
import './UploadLanding.css';
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

  const handleVideoUpload = () => {
    if (!userId) {
      navigate('/register');
      return;
    }
    navigate('/upload/video');
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

      <section className="upload-choice-wrap" aria-labelledby="upload-choice-title">
        <div className="upload-choice-heading">
          <span className="eyebrow">Choose upload type</span>
          <h2 id="upload-choice-title">What are you uploading?</h2>
          <p>
            Dataset upload lets you submit a representative ZIP, document ownership and collection
            details, and send it for review. Video upload accepts raw traffic footage for automated
            validation, vehicle tracking, trajectory mapping, and movement counts.
          </p>
        </div>

        <div className="upload-choice-grid">
          <article className="upload-choice-card">
            <div className="choice-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M4.75 6.75A2 2 0 0 1 6.75 4.75h10.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2V6.75Z" />
                <path d="M8 9h8" />
                <path d="M8 12h8" />
                <path d="M8 15h5" />
              </svg>
            </div>
            <h3>Dataset</h3>
            <p>
              Upload a sample ZIP, add metadata, accept terms, and continue through the existing
              dataset review flow.
            </p>
            <button type="button" className="choice-button" onClick={handleUpload}>
              Start Dataset Upload
            </button>
          </article>

          <article className="upload-choice-card featured">
            <div className="choice-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M5.25 7.25A2.25 2.25 0 0 1 7.5 5h6.25A2.25 2.25 0 0 1 16 7.25v9.5A2.25 2.25 0 0 1 13.75 19H7.5a2.25 2.25 0 0 1-2.25-2.25v-9.5Z" />
                <path d="m16 10 3.25-2v8L16 14" />
                <path d="M8.25 8.5h4.25" />
              </svg>
            </div>
            <h3>Video</h3>
            <p>
              Upload MP4, MOV, AVI, MKV, WebM, or WMV traffic footage, then review extracted
              metadata and frame previews.
            </p>
            <button type="button" className="choice-button primary" onClick={handleVideoUpload}>
              Start Video Upload
            </button>
          </article>
        </div>
      </section>
    </div>
  );
}

export default UploadLanding;
