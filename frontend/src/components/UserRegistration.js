import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerUser, confirmRegistration } from '../services/api';
import { saveAuthTokens, notifyAuthChanged } from '../services/authState';
import './UserRegistration.css';

function UserRegistration() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    organization: '',
    role: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false); // email verification pending
  const [verificationCode, setVerificationCode] = useState('');

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const validateForm = () => {
    const errors = [];
    if (!formData.name.trim()) errors.push('Full name is required.');
    if (!formData.email.trim()) errors.push('Email is required.');
    if (!formData.organization.trim()) errors.push('Organization is required.');
    if (!formData.role.trim()) errors.push('Role is required.');
    if (!formData.password) {
      errors.push('Password is required.');
    } else {
      if (formData.password.length < 8) errors.push('Password must be at least 8 characters.');
      if (!/[A-Z]/.test(formData.password)) errors.push('Password must include at least one uppercase letter.');
      if (!/[a-z]/.test(formData.password)) errors.push('Password must include at least one lowercase letter.');
      if (!/[0-9]/.test(formData.password)) errors.push('Password must include at least one number.');
      if (!/[^A-Za-z0-9]/.test(formData.password)) errors.push('Password must include at least one symbol.');
    }
    return errors;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setErrorDetails([]);
    setLoading(true);

    try {
      const validationErrors = validateForm();
      if (validationErrors.length) {
        setError('Please fix the following before submitting:');
        setErrorDetails(validationErrors);
        setLoading(false);
        return;
      }
      const response = await registerUser(formData);
      if (response.success) {
        // Save profile info
        localStorage.setItem('userId',          response.user?.userId       || '');
        localStorage.setItem('userName',         response.user?.name         || '');
        localStorage.setItem('userEmail',        response.user?.email        || '');
        localStorage.setItem('userOrganization', response.user?.organization || '');
        localStorage.setItem('userRole',         response.user?.role         || '');

        if (response.requiresConfirmation) {
          // Cognito email verification is enabled — show confirmation message
          setConfirmed(true);
          return;
        }

        // Email verification is off — tokens are returned immediately
        saveAuthTokens({
          token:        response.token,
          idToken:      response.idToken,
          refreshToken: response.refreshToken,
        });
        notifyAuthChanged();
        navigate('/discover');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.');
      setErrorDetails([]);
    } finally {
      setLoading(false);
    }
  };

  const handleVerificationSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setErrorDetails([]);
    setLoading(true);

    try {
      const response = await confirmRegistration(formData.email, verificationCode);
      if (response.success) {
        // Go straight to login since they need to get their tokens
        navigate('/login', { state: { message: 'Account verified successfully. Please log in.' } });
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed. Please check your code and try again.');
      setErrorDetails([]);
    } finally {
      setLoading(false);
    }
  };

  // ── Email verification pending state ──────────────────────────────────────
  if (confirmed) {
    return (
      <div className="registration-page">
        <div className="registration-overlay"></div>
        <div className="registration-content">
          <div className="registration-card">
            <div className="registration-header">
              <div className="brand-logo">
                <span className="brand-name">Reactor </span>
                <span className="brand-wave">))</span>
              </div>
              <h1>Verify Your Email</h1>
              <p className="subtitle">
                We sent a 6-digit verification code to <strong>{formData.email}</strong>.
              </p>
            </div>
            
            {error && (
              <div className="registration-error">
                <div>{error}</div>
                {errorDetails.length > 0 && (
                  <ul className="registration-error-list">
                    {errorDetails.map((item, idx) => (
                      <li key={`${idx}-${String(item)}`}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <form onSubmit={handleVerificationSubmit} className="registration-form">
              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label htmlFor="verificationCode">Verification Code</label>
                <input
                  type="text"
                  id="verificationCode"
                  name="verificationCode"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  required
                  placeholder="Enter 6-digit code"
                  style={{ textAlign: 'center', letterSpacing: '2px', fontSize: '1.2rem' }}
                />
              </div>
              
              <button type="submit" className="register-button" disabled={loading}>
                {loading ? <span className="loader-text">Verifying...</span> : 'Verify Account'}
              </button>
              
              <p className="login-prompt">
                <span className="login-link" onClick={() => navigate('/login')}>Back to login</span>
              </p>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── Registration form ──────────────────────────────────────────────────────
  return (
    <div className="registration-page">
      <div className="registration-overlay"></div>
      <div className="registration-content">
        <div className="registration-card">
          <div className="registration-header">
            <div className="brand-logo">
              <span className="brand-name">Reactor </span>
              <span className="brand-wave">))</span>
            </div>
            <h1>Create Account</h1>
            <p className="subtitle">Join the community to share and access urban traffic data</p>
          </div>

          {error && (
            <div className="registration-error">
              <div>{error}</div>
              {errorDetails.length > 0 && (
                <ul className="registration-error-list">
                  {errorDetails.map((item, idx) => (
                    <li key={`${idx}-${String(item)}`}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="registration-form">
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="name">Full Name</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  placeholder="Enter your name"
                />
              </div>

              <div className="form-group">
                <label htmlFor="email">Email Address</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  placeholder="name@organization.edu"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="organization">Organization</label>
                <input
                  type="text"
                  id="organization"
                  name="organization"
                  value={formData.organization}
                  onChange={handleChange}
                  required
                  placeholder="University or Institution"
                />
              </div>

              <div className="form-group">
                <label htmlFor="role">Your Role</label>
                <select
                  id="role"
                  name="role"
                  value={formData.role}
                  onChange={handleChange}
                  required
                >
                  <option value="">Select your role</option>
                  <option value="student">Student</option>
                  <option value="DOT">DOT / Government</option>
                  <option value="researcher">Researcher</option>
                  <option value="educator">Educator</option>
                  <option value="developer">Developer</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="password">Password</label>
                <input
                  type="password"
                  id="password"
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                />
                <div className="password-hint">
                  Use 8+ characters with upper &amp; lower case letters, a number, and a symbol.
                </div>
              </div>
            </div>

            <button type="submit" className="register-button" disabled={loading}>
              {loading ? (
                <span className="loader-text">Creating Account...</span>
              ) : (
                'Create Account'
              )}
            </button>

            <p className="login-prompt">
              Already have an account?{' '}
              <span className="login-link" onClick={() => navigate('/login')}>Sign In</span>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

export default UserRegistration;
