import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  API_PUBLIC_BASE_URL,
  getUploadTerms,
  initiateSampleMultipartUpload,
  getSampleMultipartParts,
  getSampleMultipartPartUrl,
  completeSampleMultipartUpload
} from '../services/api';
import './UploadMetadata.css';
import UploadErrorModal from './UploadErrorModal';
import DatasetUploadProcess from './DatasetUploadProcess';
import { SAMPLE_UPLOAD_LIMIT_BYTES, formatBytes, formatUploadLimit } from '../config/uploadLimits';

const STEPS = ['Core Metadata', 'Files & Advanced', 'Terms & Conditions'];
const CATEGORY_OPTIONS = ['Dataset', 'Report', 'Image', 'Model', 'Other'];
const LICENSE_OPTIONS = ['CC BY 4.0', 'CC BY-NC 4.0', 'MIT', 'Internal', 'Restricted', 'Other'];
const ACCESS_OPTIONS = ['Public', 'Private', 'Restricted'];
const SENSITIVE_DATA_OPTIONS = ['PII', 'Health', 'Financial', 'Other'];
const DEFAULT_TERMS_VERSION = 'ironyun-terms-v2026-03';

function toList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function UploadMetadata() {
  const navigate = useNavigate();
  const userId = localStorage.getItem('userId');

  const [step, setStep] = useState(1);
  const [zipFile, setZipFile] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [legalDocs, setLegalDocs] = useState([]);
  const [termsVersion, setTermsVersion] = useState(DEFAULT_TERMS_VERSION);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorDetails, setErrorDetails] = useState([]);
  const [stepErrors, setStepErrors] = useState({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [showMetadataForm, setShowMetadataForm] = useState(false);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    category: '',
    version: 'v1',
    keywordsText: '',
    owner_name_or_org: '',
    source: '',
    uploader_name: localStorage.getItem('userName') || '',
    uploader_org: localStorage.getItem('userOrganization') || '',
    date_created: '',
    collection_period_start: '',
    collection_period_end: '',
    funded_by_text: '',
    grant_or_project_id: '',
    partner_institutions_text: '',
    related_project_url: '',
    license: '',
    access_level: '',
    allowed_users_or_teams_text: '',
    embargo_until: '',
    contains_sensitive_data: false,
    sensitive_data_type: [],
    ethics_irb_reference: '',
    contact_email: localStorage.getItem('userEmail') || '',
    change_notes: '',
    sample_guidelines_ack: false,
    terms_and_conditions_accept: false,
    rights_confirmation_accept: false,
    privacy_compliance_accept: false,
  });

  useEffect(() => {
    if (!userId) {
      navigate('/register');
    }
  }, [userId, navigate]);

  useEffect(() => {
    const loadTerms = async () => {
      try {
        const response = await getUploadTerms();
        if (response.success) {
          setLegalDocs(response.documents || []);
          setTermsVersion(response.termsVersion || DEFAULT_TERMS_VERSION);
        }
      } catch (err) {
        setLegalDocs([]);
        setTermsVersion(DEFAULT_TERMS_VERSION);
      }
    };
    loadTerms();
  }, []);

  useEffect(() => {
    if (step === 3) {
      setError('');
      setShowErrorModal(false);
      setHasAttemptedSubmit(false);
    }
  }, [step]);

  const titleChars = formData.title.length;
  const descChars = formData.description.trim().length;
  const descWords = useMemo(() => {
    const cleaned = formData.description.trim();
    return cleaned ? cleaned.split(/\s+/).length : 0;
  }, [formData.description]);

  const fileSizeLabel = useMemo(() => {
    if (!zipFile || typeof zipFile.size !== 'number') return '';
    return formatBytes(zipFile.size);
  }, [zipFile]);

  const raiseError = (message, details = []) => {
    setError(message);
    setErrorDetails(Array.isArray(details) ? details : []);
    setShowErrorModal(true);
  };

  const scrollToTop = (behavior = 'smooth') => {
    window.scrollTo({ top: 0, behavior });
  };

  const setStepError = (stepIndex, hasError) => {
    setStepErrors((prev) => ({ ...prev, [stepIndex]: hasError }));
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSensitiveTypeToggle = (value) => {
    setFormData((prev) => {
      const exists = prev.sensitive_data_type.includes(value);
      const next = exists
        ? prev.sensitive_data_type.filter((item) => item !== value)
        : [...prev.sensitive_data_type, value];
      return { ...prev, sensitive_data_type: next };
    });
  };

  const handleFileSelect = (file) => {
    if (!file) {
      setZipFile(null);
      setShowErrorModal(false);
      return;
    }

    if (!file.name.toLowerCase().endsWith('.zip')) {
      raiseError('Please upload a .zip file.');
      setZipFile(null);
      return;
    }

    if (file.size > SAMPLE_UPLOAD_LIMIT_BYTES) {
      raiseError(`File too large. Maximum allowed size is ${formatUploadLimit(SAMPLE_UPLOAD_LIMIT_BYTES)}.`);
      setZipFile(null);
      return;
    }

    setError('');
    setShowErrorModal(false);
    setZipFile(file);
  };

  const handleSampleContinue = () => {
    if (!zipFile) {
      raiseError('Please upload a sample dataset ZIP file before continuing.');
      return;
    }
    setError('');
    setShowErrorModal(false);
    setShowMetadataForm(true);
    scrollToTop();
  };

  const handleRemoveSampleFile = () => {
    setZipFile(null);
    setShowMetadataForm(false);
  };

  const validateStep = (stepToValidate) => {
    const errors = [];
    const fundedBy = toList(formData.funded_by_text);
    const allowedUsers = toList(formData.allowed_users_or_teams_text);

    if (stepToValidate === 1) {
      if (!formData.title.trim()) errors.push('Title is required.');
      if (titleChars < 5 || titleChars > 150) errors.push('Title must be between 5 and 150 characters.');
      if (!formData.description.trim()) errors.push('Description is required.');
      if (descChars < 20) errors.push('Description must be at least 20 characters.');
      if (descWords < 5) errors.push('Description must contain at least 5 words.');
      if (formData.source.trim().length < 3) errors.push('Source must be at least 3 characters.');
      if (fundedBy.some((f) => f.length < 2)) {
        errors.push('Each funding organization must be at least 2 characters.');
      }
      if (!formData.category) errors.push('Category is required.');
      if (!formData.owner_name_or_org.trim()) errors.push('Owner name/organization is required.');
      if (!formData.source.trim()) errors.push('Source is required.');
      if (!fundedBy.length) errors.push('At least one funding organization is required.');
      if (!formData.license) errors.push('License is required.');
      if (!formData.access_level) errors.push('Access level is required.');
      if (!formData.contact_email.trim()) errors.push('Contact email is required.');

      if (formData.access_level === 'Restricted' && !allowedUsers.length) {
        errors.push('Allowed users/teams are required for restricted access.');
      }

      if (formData.collection_period_start && formData.collection_period_end) {
        if (formData.collection_period_start > formData.collection_period_end) {
          errors.push('Collection period start date must be before end date.');
        }
      }

      if (formData.contains_sensitive_data && !formData.sensitive_data_type.length) {
        errors.push('Select at least one sensitive data type.');
      }

      if (formData.sensitive_data_type.includes('Health') && !formData.ethics_irb_reference.trim()) {
        errors.push('Ethics/IRB reference is required when health data is present.');
      }
    }

    if (stepToValidate === 2) {
      if (!zipFile) errors.push('Sample dataset ZIP file is required.');
      if (!formData.sample_guidelines_ack) errors.push('Please acknowledge sample dataset guidelines.');
    }

    if (stepToValidate === 3) {
      if (!formData.terms_and_conditions_accept) errors.push('Please accept Terms & Conditions.');
      if (!formData.rights_confirmation_accept) errors.push('Please confirm upload rights.');
      if (!formData.privacy_compliance_accept) errors.push('Please confirm privacy compliance.');
    }

    return errors;
  };

  const goNext = () => {
    const validationErrors = validateStep(step);
    if (validationErrors.length) {
      raiseError('Please fix the following before continuing:', validationErrors);
      setStepError(step, true);
      scrollToTop();
      return;
    }
    setError('');
    setShowErrorModal(false);
    setStepError(step, false);
    setStep((prev) => Math.min(prev + 1, 3));
    scrollToTop();
  };

  const goBack = () => {
    setError('');
    setShowErrorModal(false);
    setStep((prev) => Math.max(prev - 1, 1));
    scrollToTop();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (step < 3) {
      goNext();
      return;
    }
    if (!hasAttemptedSubmit) {
      return;
    }

    const step1Errors = validateStep(1);
    const step2Errors = validateStep(2);
    const step3Errors = validateStep(3);
    setStepError(1, step1Errors.length > 0);
    setStepError(2, step2Errors.length > 0);
    setStepError(3, step3Errors.length > 0);
    const allErrors = [
      ...step1Errors.map((err) => `Step 1: ${err}`),
      ...step2Errors.map((err) => `Step 2: ${err}`),
      ...step3Errors.map((err) => `Step 3: ${err}`),
    ];
    if (allErrors.length) {
      const firstStep = step1Errors.length ? 1 : step2Errors.length ? 2 : 3;
      setStep(firstStep);
      raiseError('Please fix the following before submitting:', allErrors);
      scrollToTop();
      return;
    }

    if (!zipFile) {
      raiseError('Sample ZIP file is missing.');
      return;
    }

    setLoading(true);
    setError('');
    setShowErrorModal(false);
    setIsUploading(true);
    setUploadProgress(0);

    try {
      const payload = {
        uploaded_by: userId,
        title: formData.title.trim(),
        description: formData.description.trim(),
        category: formData.category,
        version: formData.version.trim() || 'v1',
        keywords: toList(formData.keywordsText),
        owner_name_or_org: formData.owner_name_or_org.trim(),
        source: formData.source.trim(),
        uploader_name: formData.uploader_name.trim(),
        ...(formData.uploader_org.trim() ? { uploader_org: formData.uploader_org.trim() } : {}),
        date_created: formData.date_created || undefined,
        collection_period_start: formData.collection_period_start || undefined,
        collection_period_end: formData.collection_period_end || undefined,
        funded_by: toList(formData.funded_by_text),
        grant_or_project_id: formData.grant_or_project_id.trim() || undefined,
        partner_institutions: toList(formData.partner_institutions_text),
        related_project_url: formData.related_project_url.trim() || undefined,
        license: formData.license,
        access_level: formData.access_level,
        allowed_users_or_teams: toList(formData.allowed_users_or_teams_text),
        embargo_until: formData.embargo_until || undefined,
        contains_sensitive_data: Boolean(formData.contains_sensitive_data),
        sensitive_data_type: formData.sensitive_data_type,
        ethics_irb_reference: formData.ethics_irb_reference.trim() || undefined,
        contact_email: formData.contact_email.trim(),
        change_notes: formData.change_notes.trim() || undefined,
        terms_and_conditions_accept: Boolean(formData.terms_and_conditions_accept),
        rights_confirmation_accept: Boolean(formData.rights_confirmation_accept),
        privacy_compliance_accept: Boolean(formData.privacy_compliance_accept),
        terms_version_accepted: termsVersion,
      };

      const initRes = await initiateSampleMultipartUpload({
        fileName: zipFile.name,
        fileSize: zipFile.size,
        contentType: zipFile.type || 'application/zip'
      });
      if (!initRes.success || !initRes.session) {
        throw new Error(initRes.error || 'Failed to initiate multipart upload.');
      }

      const { requestId, partSize } = initRes.session;
      const totalParts = Math.ceil(zipFile.size / partSize);
      const partsRes = await getSampleMultipartParts(requestId);
      const existingParts = partsRes.success && Array.isArray(partsRes.parts) ? partsRes.parts : [];
      const existingMap = new Map(existingParts.map((p) => [Number(p.PartNumber), p.ETag]));
      let uploadedBytes = existingParts.reduce((sum, p) => sum + (p.Size || 0), 0);
      setUploadProgress(Math.round((uploadedBytes / zipFile.size) * 100));

      const pendingParts = [];
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (!existingMap.has(partNumber)) pendingParts.push(partNumber);
      }

      const uploadedParts = existingParts.map((p) => ({
        PartNumber: Number(p.PartNumber),
        ETag: p.ETag
      }));

      const uploadPart = async (partNumber) => {
        const urlRes = await getSampleMultipartPartUrl(requestId, { partNumber });
        if (!urlRes.success || !urlRes.url) {
          throw new Error(urlRes.error || 'Failed to get upload URL.');
        }
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, zipFile.size);
        const blob = zipFile.slice(start, end);

        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', urlRes.url);
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const etag = xhr.getResponseHeader('ETag');
              if (!etag) {
                reject(new Error('Missing ETag header from S3. Ensure ETag is exposed in S3 CORS.'));
                return;
              }
              const normalizedEtag = etag.startsWith('"') ? etag : `"${etag}"`;
              resolve({ PartNumber: partNumber, ETag: normalizedEtag, size: end - start });
            } else {
              reject(new Error(`Part ${partNumber} upload failed with status ${xhr.status}.`));
            }
          };
          xhr.onerror = () => reject(new Error(`Network error uploading part ${partNumber}.`));
          xhr.send(blob);
        });
      };

      const uploadPartWithRetry = async (partNumber, maxRetries = 3) => {
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
          try {
            return await uploadPart(partNumber);
          } catch (err) {
            if (attempt >= maxRetries) throw err;
            await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
          }
        }
        return null;
      };

      const concurrency = 4;
      const queue = [...pendingParts];
      const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }).map(async () => {
        while (queue.length) {
          const partNumber = queue.shift();
          if (!partNumber) return;
          const result = await uploadPartWithRetry(partNumber);
          uploadedParts.push({ PartNumber: result.PartNumber, ETag: result.ETag });
          uploadedBytes += result.size;
          setUploadProgress(Math.min(99, Math.round((uploadedBytes / zipFile.size) * 100)));
        }
      });

      await Promise.all(workers);

      const response = await completeSampleMultipartUpload(requestId, {
        parts: uploadedParts,
        metadata: payload,
        sampleFileName: zipFile.name,
        sampleFileSize: zipFile.size
      });

      if (!response.success) {
        const apiErrors = response.errors || [];
        const detailText = apiErrors.length ? apiErrors.join(' ') : '';
        throw Object.assign(
          new Error(detailText || response.error || 'Failed to complete upload request.'),
          { validationErrors: apiErrors }
        );
      }

      setUploadProgress(100);

      if (response.success) {
        setSuccessMessage(`Submission request sent${response.requestId ? ` (ID: ${response.requestId})` : ''}.`);
        setTimeout(() => navigate('/discover'), 1800);
      }
    } catch (err) {
      const details = err.validationErrors
        || err.response?.data?.errors
        || [];
      const summary = err.response?.data?.error || err.message || 'Submission failed. Please try again.';
      const message = details.length
        ? `${summary} ${Array.isArray(details) ? details.join(' · ') : details}`
        : summary;
      raiseError(message, details);
      setUploadProgress(0);
    } finally {
      setLoading(false);
      setIsUploading(false);
    }
  };

  return (
    <div className="container upload-atlas">
      <div className="card upload-card">
        {!showMetadataForm ? (
          <>
            {error && <div className="alert alert-error">{error}</div>}
            {showErrorModal && (
              <UploadErrorModal
                message={error}
                details={errorDetails}
                onClose={() => setShowErrorModal(false)}
              />
            )}
            <DatasetUploadProcess
              zipFile={zipFile}
              fileSizeLabel={fileSizeLabel}
              onFileSelect={handleFileSelect}
              onRemoveFile={handleRemoveSampleFile}
              onContinue={handleSampleContinue}
              onOpenGuidelines={() => window.open('/upload/guidelines', '_blank', 'noopener,noreferrer')}
            />
          </>
        ) : (
          <>

        <div className="upload-stepper">
          {STEPS.map((label, idx) => {
            const number = idx + 1;
            const state = number === step ? 'active' : number < step ? 'done' : 'idle';
            return (
              <div
                key={label}
                className={`upload-step ${state} ${stepErrors[number] ? 'error' : ''}`}
              >
                <div className="upload-step-dot">{number}</div>
                <div className="upload-step-label">
                  {label}
                  <span className="required-asterisk">*</span>
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {successMessage && <div className="alert alert-success">{successMessage}</div>}
        {showErrorModal && (
          <UploadErrorModal
            message={error}
            details={errorDetails}
            onClose={() => setShowErrorModal(false)}
          />
        )}

        <form onSubmit={handleSubmit}>
          {step === 1 && (
            <>
              <div className="metadata-section">
                <h2>File Details</h2>
                <div className="two-col-grid">
                  <div className="form-group with-counter">
                    <label htmlFor="title">Title*</label>
                    <input id="title" name="title" value={formData.title} onChange={handleChange} maxLength={150} />
                    <p className="counter">{titleChars}/150 characters</p>
                  </div>

                  <div className="form-group">
                    <label htmlFor="category">Category*</label>
                    <select id="category" name="category" value={formData.category} onChange={handleChange}>
                      <option value="">Select one</option>
                      {CATEGORY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </div>

                  <div className="form-group with-counter" style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="description">Description*</label>
                    <textarea id="description" name="description" value={formData.description} onChange={handleChange} />
                    <p className={`counter ${descWords < 5 ? 'danger' : ''}`}>{descWords} words (minimum 5)</p>
                  </div>

                  <div className="form-group">
                    <label htmlFor="version">Version</label>
                    <input id="version" name="version" value={formData.version} onChange={handleChange} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="keywordsText">Keywords (comma-separated)</label>
                    <input id="keywordsText" name="keywordsText" value={formData.keywordsText} onChange={handleChange} placeholder="traffic, cv, urban" />
                  </div>
                </div>
              </div>

              <div className="metadata-section section-divider">
                <h2>Ownership, Source, Funding</h2>
                <div className="two-col-grid">
                  <div className="form-group">
                    <label htmlFor="owner_name_or_org">Owner Name / Organization*</label>
                    <input id="owner_name_or_org" name="owner_name_or_org" value={formData.owner_name_or_org} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="source">Source*</label>
                    <input id="source" name="source" value={formData.source} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="uploader_name">Uploader Name*</label>
                    <input id="uploader_name" name="uploader_name" value={formData.uploader_name} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="uploader_org">Uploader Organization</label>
                    <input id="uploader_org" name="uploader_org" value={formData.uploader_org} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="funded_by_text">Funded By* (comma-separated)</label>
                    <input id="funded_by_text" name="funded_by_text" value={formData.funded_by_text} onChange={handleChange} placeholder="NSF, Iowa DOT" />
                  </div>
                  <div className="form-group">
                    <label htmlFor="grant_or_project_id">Grant / Project ID</label>
                    <input id="grant_or_project_id" name="grant_or_project_id" value={formData.grant_or_project_id} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="partner_institutions_text">Partner Institutions (comma-separated)</label>
                    <input id="partner_institutions_text" name="partner_institutions_text" value={formData.partner_institutions_text} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="related_project_url">Related Project URL</label>
                    <input id="related_project_url" name="related_project_url" value={formData.related_project_url} onChange={handleChange} placeholder="https://..." />
                  </div>
                </div>
              </div>

              <div className="metadata-section section-divider">
                <h2>Compliance, Access, Contact</h2>
                <div className="two-col-grid">
                  <div className="form-group">
                    <label htmlFor="license">License*</label>
                    <select id="license" name="license" value={formData.license} onChange={handleChange}>
                      <option value="">Select one</option>
                      {LICENSE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="access_level">Access Level*</label>
                    <select id="access_level" name="access_level" value={formData.access_level} onChange={handleChange}>
                      <option value="">Select one</option>
                      {ACCESS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </div>
                  {formData.access_level === 'Restricted' && (
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor="allowed_users_or_teams_text">Allowed Users or Teams* (comma-separated)</label>
                      <input
                        id="allowed_users_or_teams_text"
                        name="allowed_users_or_teams_text"
                        value={formData.allowed_users_or_teams_text}
                        onChange={handleChange}
                        placeholder="team-data-science, user_123"
                      />
                    </div>
                  )}

                  <div className="form-group">
                    <label htmlFor="contact_email">Contact Email*</label>
                    <input id="contact_email" name="contact_email" type="email" value={formData.contact_email} onChange={handleChange} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="embargo_until">Embargo Until</label>
                    <input id="embargo_until" name="embargo_until" type="date" value={formData.embargo_until} onChange={handleChange} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="date_created">Date Created</label>
                    <input id="date_created" name="date_created" type="date" value={formData.date_created} onChange={handleChange} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="collection_period_start">Collection Start</label>
                    <input id="collection_period_start" name="collection_period_start" type="date" value={formData.collection_period_start} onChange={handleChange} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="collection_period_end">Collection End</label>
                    <input id="collection_period_end" name="collection_period_end" type="date" value={formData.collection_period_end} onChange={handleChange} />
                  </div>

                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <label className="plain-text">Contains Sensitive Data?*</label>
                    <div className="sensitive-choice-row">
                      <label className="sensitive-choice">
                        <input
                          type="radio"
                          name="contains_sensitive_data"
                          checked={!formData.contains_sensitive_data}
                          onChange={() => setFormData((prev) => ({ ...prev, contains_sensitive_data: false, sensitive_data_type: [], ethics_irb_reference: '' }))}
                        />
                        <span>No</span>
                      </label>
                      <label className="sensitive-choice">
                        <input
                          type="radio"
                          name="contains_sensitive_data"
                          checked={formData.contains_sensitive_data}
                          onChange={() => setFormData((prev) => ({ ...prev, contains_sensitive_data: true }))}
                        />
                        <span>Yes</span>
                      </label>
                    </div>
                  </div>

                  {formData.contains_sensitive_data && (
                    <>
                      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label>Sensitive Data Type*</label>
                        <div className="sensitive-types-grid">
                        {SENSITIVE_DATA_OPTIONS.map((option) => {
                          const optionId = `sensitive-${option.toLowerCase()}`;
                          return (
                            <label key={option} className="checkbox-group compact-check">
                              <input
                                id={optionId}
                                type="checkbox"
                                checked={formData.sensitive_data_type.includes(option)}
                                onChange={() => handleSensitiveTypeToggle(option)}
                              />
                              <span>{option}</span>
                            </label>
                          );
                        })}
                        </div>
                      </div>
                      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label htmlFor="ethics_irb_reference">Ethics / IRB Reference</label>
                        <input id="ethics_irb_reference" name="ethics_irb_reference" value={formData.ethics_irb_reference} onChange={handleChange} />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="metadata-section">
                <div className="sample-upload-card">
                  <h2>Upload Sample Dataset</h2>
                  <p>Upload a compressed (.zip) file. Max size {formatUploadLimit(SAMPLE_UPLOAD_LIMIT_BYTES)}.</p>

                  {zipFile ? (
                    <div className="file-picked-container">
                      <div className="file-info">
                        <span className="file-icon">📄</span>
                        <span>{zipFile.name} ({fileSizeLabel})</span>
                      </div>
                      <button type="button" className="remove-file-btn" onClick={() => setZipFile(null)}>✕</button>
                    </div>
                  ) : (
                    <label className="drop-zone" htmlFor="zipFile">
                      <div className="drop-zone-icon">Upload</div>
                      <div className="drop-zone-title">Drag and drop your file here</div>
                      <div className="drop-zone-sub">or</div>
                      <span className="browse-btn">Browse Files</span>
                      <input
                        id="zipFile"
                        type="file"
                        accept=".zip"
                        onChange={(event) => handleFileSelect(event.target.files?.[0])}
                      />
                    </label>
                  )}
                </div>

                <div className="guidelines-acknowledgement">
                  <h3>Sample Dataset Guidelines Acknowledgement</h3>
                  <ul className="guidelines-list">
                    <li>Follows the same folder structure as the full dataset</li>
                    <li>Contains a small representative subset of files</li>
                    <li>Includes metadata files used in the full dataset</li>
                  </ul>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => window.open('/upload/guidelines', '_blank', 'noopener,noreferrer')}
                  >
                    View full sample upload guidelines
                  </button>
                  <label className="checkbox-group">
                    <input
                      id="sample_guidelines_ack"
                      name="sample_guidelines_ack"
                      type="checkbox"
                      checked={formData.sample_guidelines_ack}
                      onChange={handleChange}
                    />
                    <span>I confirm my sample follows these rules.</span>
                  </label>
                </div>
              </div>

              <div className="metadata-section section-divider">
                <h2>Optional Metadata</h2>
                <div className="form-group">
                  <label htmlFor="change_notes">Change Notes (required when uploading a new version)</label>
                  <textarea
                    id="change_notes"
                    name="change_notes"
                    value={formData.change_notes}
                    onChange={handleChange}
                    placeholder="Describe what changed in this version..."
                  />
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <div className="metadata-section">
              <div className="terms-card">
                <h2>Terms, Rights, and Privacy Confirmation</h2>
                <ul className="terms-list">
                  <li>I have legal rights to upload this content.</li>
                  <li>The provided metadata is accurate to the best of my knowledge.</li>
                  <li>I understand access controls and licensing selected in this form.</li>
                  <li>I confirm data privacy and compliance requirements are met.</li>
                </ul>

                <label className="checkbox-group">
                  <input
                    id="terms_and_conditions_accept"
                    name="terms_and_conditions_accept"
                    type="checkbox"
                    checked={formData.terms_and_conditions_accept}
                    onChange={handleChange}
                  />
                  <span>I accept the Terms & Conditions.</span>
                </label>

                <label className="checkbox-group">
                  <input
                    id="rights_confirmation_accept"
                    name="rights_confirmation_accept"
                    type="checkbox"
                    checked={formData.rights_confirmation_accept}
                    onChange={handleChange}
                  />
                  <span>I confirm I have rights/permission to upload this content.</span>
                </label>

                <label className="checkbox-group">
                  <input
                    id="privacy_compliance_accept"
                    name="privacy_compliance_accept"
                    type="checkbox"
                    checked={formData.privacy_compliance_accept}
                    onChange={handleChange}
                  />
                  <span>I confirm privacy and regulatory compliance.</span>
                </label>

                <button type="button" className="link-btn" onClick={() => window.open('https://opensource.org/license/mit/', '_blank', 'noopener,noreferrer')}>
                  View Terms & Conditions and License
                </button>
                <div className="legal-doc-links">
                  {(legalDocs || []).map((doc) => (
                    <a key={doc.id} href={`${API_PUBLIC_BASE_URL}${doc.url}`} target="_blank" rel="noreferrer" className="link-btn">
                      {doc.title}
                    </a>
                  ))}
                </div>
                <p className="note-text">Terms version: {termsVersion}</p>
              </div>
            </div>
          )}

          <div className="upload-fixed-cta">
            {isUploading && (
              <div className="upload-progress-container">
                <div className="upload-progress-info">
                  <span>Uploading sample data...</span>
                  <span className="upload-progress-percent">{Math.round(uploadProgress)}%</span>
                </div>
                <div className="upload-progress-bar">
                  <div 
                    className="upload-progress-fill" 
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
            {step > 1 && (
              <button type="button" className="btn btn-secondary" onClick={goBack} disabled={loading || isUploading}>
                Back
              </button>
            )}
            {step < 3 ? (
              <button type="button" className="btn figma-cta" onClick={goNext} disabled={loading || isUploading}>
                Continue
              </button>
            ) : (
              <button
                type="submit"
                className="btn figma-cta"
                disabled={loading || isUploading}
                onClick={() => setHasAttemptedSubmit(true)}
              >
                {isUploading ? `Uploading... ${Math.round(uploadProgress)}%` : (loading ? 'Submitting...' : 'Submit Request')}
              </button>
            )}
          </div>
        </form>
          </>
        )}
      </div>
    </div>
  );
}

export default UploadMetadata;
