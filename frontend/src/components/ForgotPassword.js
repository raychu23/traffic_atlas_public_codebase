import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { forgotPassword, confirmPassword } from '../services/api';
import './UserRegistration.css';

/**
 * ForgotPassword — two-step password reset via AWS Cognito
 *   Step 1: enter email → Cognito sends a 6-digit code email
 *   Step 2: enter code + new password → Cognito confirms the reset
 */
function ForgotPassword() {
  const navigate = useNavigate();

  const [step, setStep] = useState(1); // 1 = request code, 2 = enter code
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // ── Step 1: Request reset code ────────────────────────────────────────────
  const handleRequestCode = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await forgotPassword(email);
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send reset code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: Confirm code + new password ───────────────────────────────────
  const handleConfirmReset = async (e) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmNewPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      await confirmPassword(email, code, newPassword);
      setSuccess(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Password reset failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Success state ─────────────────────────────────────────────────────────
  if (success) {
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
              <h1>Password Reset</h1>
              <p className="subtitle">
                Your password has been reset successfully.{' '}
                <span className="login-link" onClick={() => navigate('/login')}>
                  Sign in
                </span>{' '}
                with your new password.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
            <h1>{step === 1 ? 'Forgot Password' : 'Reset Password'}</h1>
            <p className="subtitle">
              {step === 1
                ? 'Enter your email and we\'ll send you a reset code.'
                : `Enter the 6-digit code sent to ${email} and choose a new password.`}
            </p>
          </div>

          {error && <div className="registration-error">{error}</div>}

          {/* ── Step 1 form ── */}
          {step === 1 && (
            <form onSubmit={handleRequestCode} className="registration-form">
              <div className="form-group">
                <label htmlFor="fp-email">Email Address</label>
                <input
                  id="fp-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="name@organization.edu"
                />
              </div>

              <button type="submit" className="register-button" disabled={loading}>
                {loading ? 'Sending Code…' : 'Send Reset Code'}
              </button>

              <p className="login-prompt">
                Remember your password?{' '}
                <span className="login-link" onClick={() => navigate('/login')}>Sign In</span>
              </p>
            </form>
          )}

          {/* ── Step 2 form ── */}
          {step === 2 && (
            <form onSubmit={handleConfirmReset} className="registration-form">
              <div className="form-group">
                <label htmlFor="fp-code">Verification Code</label>
                <input
                  id="fp-code"
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  maxLength={8}
                  placeholder="Enter 6-digit code"
                />
              </div>

              <div className="form-group">
                <label htmlFor="fp-new-password">New Password</label>
                <input
                  id="fp-new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                />
              </div>

              <div className="form-group">
                <label htmlFor="fp-confirm-password">Confirm New Password</label>
                <input
                  id="fp-confirm-password"
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="Repeat new password"
                />
              </div>

              <button type="submit" className="register-button" disabled={loading}>
                {loading ? 'Resetting Password…' : 'Reset Password'}
              </button>

              <p className="login-prompt">
                <span className="login-link" onClick={() => setStep(1)}>
                  ← Request a new code
                </span>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default ForgotPassword;
