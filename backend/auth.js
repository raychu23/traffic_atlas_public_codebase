/**
 * auth.js — Cognito JWT validation middleware
 *
 * Validates the Cognito Access Token sent as `Authorization: Bearer <token>`
 * using the public JWKS endpoint of your User Pool.
 *
 * Required env vars:
 *   COGNITO_USER_POOL_ID  e.g. us-east-1_xxxxxxxxx
 *   COGNITO_REGION        e.g. us-east-1  (falls back to AWS_REGION)
 */

const jwt     = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');

const REGION       = process.env.COGNITO_REGION      || process.env.AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

// Cognito JWKS URI — publishes the RSA public keys used to sign tokens
const jwksUri = USER_POOL_ID
  ? `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`
  : null;

// Build JWKS client with in-memory caching so we don't hit the endpoint every request
const jwksClient = jwksUri
  ? jwksRsa({
      jwksUri,
      cache:            true,
      cacheMaxEntries:  5,
      cacheMaxAge:      10 * 60 * 1000, // 10 minutes
      rateLimit:        true,
    })
  : null;

/**
 * Retrieve the signing key for a given `kid` from the Cognito JWKS endpoint.
 */
function getSigningKey(header, callback) {
  if (!jwksClient) {
    return callback(new Error('Cognito is not configured (missing COGNITO_USER_POOL_ID)'));
  }
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * requireAuth — Express middleware.
 *
 * Validates the Cognito Access Token and populates req.auth with:
 *   { userId, email, role, isAdmin, cognitoSub, groups }
 *
 * Falls back gracefully when Cognito is not yet configured so the server
 * can still start up during local development without credentials.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  // If Cognito is not configured (dev with no .env) — degrade gracefully
  if (!jwksClient) {
    console.warn('[auth] WARNING: COGNITO_USER_POOL_ID not set — accepting any token in dev mode');
    try {
      const decoded = jwt.decode(token);
      if (!decoded) throw new Error('Cannot decode token');
      req.auth = {
        userId:     decoded.sub   || decoded['cognito:username'] || 'unknown',
        email:      decoded.email || decoded.username || '',
        role:       'user',
        isAdmin:    false,
        cognitoSub: decoded.sub || '',
        groups:     [],
      };
      return next();
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid token (dev mode)' });
    }
  }

  // Verify with Cognito public keys
  jwt.verify(
    token,
    getSigningKey,
    {
      algorithms: ['RS256'],
      issuer:     `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
    },
    (err, decoded) => {
      if (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
      }

      // Cognito Access Tokens: 'username' holds the email (Cognito login name).
      // ID Tokens also have an 'email' claim. Accept both token types gracefully.
      const groups = decoded['cognito:groups'] || [];
      const isAdmin = groups.includes('admins');
      // 'username' in Cognito Access Tokens is always the email address used at signup
      const email = decoded.email || decoded.username || decoded['cognito:username'] || '';

      req.auth = {
        userId:     decoded.sub,
        email,
        role:       isAdmin ? 'admin' : 'user',
        isAdmin,
        cognitoSub: decoded.sub,
        groups,
      };

      return next();
    }
  );
}

/**
 * requireAdmin — must be chained after requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.auth || !req.auth.isAdmin) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
