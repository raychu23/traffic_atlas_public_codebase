import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loginUser } from '../services/api';
import { saveAuthTokens, notifyAuthChanged } from '../services/authState';
import './UserRegistration.css';

function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    const expired = localStorage.getItem('sessionExpired');
    if (expired === 'true') {
      setError('Your session expired. Please sign in again.');
      localStorage.removeItem('sessionExpired');
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await loginUser({ email, password });
      if (response.success) {
        // Save Cognito tokens (also sets userIsAdmin from idToken claims)
        saveAuthTokens({
          token: response.token,
          idToken: response.idToken,
          refreshToken: response.refreshToken,
        });

        // Server-side group check overrides client-side token parsing
        if (typeof response.isAdmin === 'boolean') {
          localStorage.setItem('userIsAdmin', String(response.isAdmin));
        }

        // Save profile info
        localStorage.setItem('userId', response.user.userId || '');
        localStorage.setItem('userName', response.user.name || '');
        localStorage.setItem('userEmail', response.user.email || '');
        localStorage.setItem('userOrganization', response.user.organization || '');
        localStorage.setItem('userRole', response.user.role || '');

        notifyAuthChanged();
        const redirectPath = location.state?.from?.pathname || '/discover';
        navigate(redirectPath, { replace: true });
      }
    } catch (err) {
      const errData = err.response?.data;
      if (errData?.code === 'USER_NOT_CONFIRMED') {
        setError('Your email address has not been verified. Please check your inbox for a confirmation link.');
      } else {
        setError(errData?.error || 'Sign in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

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
            <h1>Sign In</h1>
            <p className="subtitle">Access protected upload and download features</p>

          </div>

          {error && <div className="registration-error">{error}</div>}

          <form onSubmit={handleSubmit} className="registration-form">
            <div className="form-group">
              <label htmlFor="email">Email Address</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="name@organization.edu"
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Enter your password"
              />
            </div>

            <button type="submit" className="register-button" disabled={loading}>
              {loading ? 'Signing In...' : 'Sign In'}
            </button>

            <p className="login-prompt">
              <span className="login-link" onClick={() => navigate('/forgot-password')}>
                Forgot password?
              </span>
            </p>

            <p className="login-prompt">
              Need an account?{' '}
              <span className="login-link" onClick={() => navigate('/register')}>Register</span>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

export default Login;
