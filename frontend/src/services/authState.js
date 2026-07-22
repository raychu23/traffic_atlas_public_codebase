/**
 * authState.js — Cognito token state helpers
 *
 * Tokens stored in localStorage:
 *   authToken   — Cognito Access Token  (sent as Bearer on API calls)
 *   idToken     — Cognito ID Token      (contains user claims incl. groups)
 *   refreshToken — Cognito Refresh Token (for session refresh)
 */

/**
 * Parse a JWT payload without verifying the signature.
 * (Verification happens server-side; we only read claims client-side)
 */
function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // Add base64 padding (JWT uses unpadded base64url)
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * Check whether a token is still valid (not expired).
 */
function isTokenValid(token) {
  if (!token) return false;
  const claims = parseJwt(token);
  if (!claims || !claims.exp) return false;
  // Add a 30-second buffer before expiry
  return claims.exp * 1000 > Date.now() + 30_000;
}

/**
 * Determine whether the user is in the Cognito "admins" group.
 * Priority: server-provided value → token claims
 */
function resolveIsAdmin() {
  // 1. Server explicitly set this at login time (most reliable)
  const stored = localStorage.getItem('userIsAdmin');
  if (stored === 'true') return true;
  if (stored === 'false') return false;

  // 2. Fall back to parsing the ID token / access token
  const idToken = localStorage.getItem('idToken');
  const accessToken = localStorage.getItem('authToken');
  const tokenToCheck = idToken || accessToken;
  if (tokenToCheck) {
    const claims = parseJwt(tokenToCheck);
    const groups = claims?.['cognito:groups'] || [];
    if (groups.includes('admins')) return true;
  }

  return false;
}

function isDevAuthEnabled() {
  return process.env.REACT_APP_DEV_AUTH_ENABLED === 'true';
}

function ensureDevProfile() {
  localStorage.setItem('authToken', 'dev-local-token');
  if (!localStorage.getItem('userId')) {
    localStorage.setItem('userId', 'dev-local-user');
  }
  if (!localStorage.getItem('userName')) {
    localStorage.setItem('userName', 'Local Dev User');
  }
  if (!localStorage.getItem('userEmail')) {
    localStorage.setItem('userEmail', 'dev@traffic-atlas.local');
  }
  if (!localStorage.getItem('userOrganization')) {
    localStorage.setItem('userOrganization', 'Traffic Atlas Local');
  }
  if (!localStorage.getItem('userRole')) {
    localStorage.setItem('userRole', 'developer');
  }
}

/**
 * getAuthState — returns the current auth state.
 * Used by ProtectedRoute, AdminRoute, and Navbar.
 */
export function getAuthState() {
  if (isDevAuthEnabled()) {
    ensureDevProfile();
    return {
      token: 'dev-local-token',
      isLoggedIn: true,
      isAdmin: false,
    };
  }

  const token = localStorage.getItem('authToken');
  const isAdmin = resolveIsAdmin();
  const isLoggedIn = isTokenValid(token);

  return {
    token,
    isLoggedIn,
    isAdmin,
  };
}

/**
 * saveAuthTokens — persist all Cognito tokens after login/register.
 */
export function saveAuthTokens({ token, idToken, refreshToken }) {
  if (token) localStorage.setItem('authToken', token);
  if (idToken) localStorage.setItem('idToken', idToken);
  if (refreshToken) localStorage.setItem('refreshToken', refreshToken);

  // Cache isAdmin from idToken claims for quick checks
  const claims = idToken ? parseJwt(idToken) : null;
  const groups = claims?.['cognito:groups'] || [];
  localStorage.setItem('userIsAdmin', String(groups.includes('admins')));
}

/**
 * clearAuthTokens — remove all tokens on logout.
 */
export function clearAuthTokens() {
  localStorage.removeItem('authToken');
  localStorage.removeItem('idToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('userId');
  localStorage.removeItem('userName');
  localStorage.removeItem('userEmail');
  localStorage.removeItem('userOrganization');
  localStorage.removeItem('userRole');
  localStorage.removeItem('userIsAdmin');
}

/**
 * notifyAuthChanged — fire a custom event so Navbar etc. can re-render.
 */
export function notifyAuthChanged() {
  window.dispatchEvent(new Event('auth-changed'));
}
