const jwt = require("jsonwebtoken");
const jwksRsa = require("jwks-rsa");

const REGION = process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

const jwksUri =
  USER_POOL_ID && CLIENT_ID
    ? `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`
    : null;

const jwksClient = jwksUri
  ? jwksRsa({
      jwksUri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
    })
  : null;

function getSigningKey(header, callback) {
  if (!jwksClient) {
    return callback(new Error("Cognito is not configured (missing COGNITO_USER_POOL_ID)"));
  }
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

function hasValidCognitoClaims(decoded, clientId = CLIENT_ID) {
  if (!decoded || !clientId || !["access", "id"].includes(decoded.token_use)) {
    return false;
  }
  const tokenClientId = decoded.token_use === "access" ? decoded.client_id : decoded.aud;
  return tokenClientId === clientId;
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  if (process.env.DEV_AUTH_ENABLED === "true" && token === "dev-local-token") {
    req.auth = {
      userId: "dev-local-user",
      email: "dev@traffic-atlas.local",
      role: "user",
      isAdmin: false,
      cognitoSub: "dev-local-user",
      groups: [],
    };
    return next();
  }

  if (!jwksClient) {
    return res.status(503).json({ success: false, error: "Authentication is not configured" });
  }

  jwt.verify(
    token,
    getSigningKey,
    {
      algorithms: ["RS256"],
      issuer: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
    },
    (err, decoded) => {
      if (err) {
        return res.status(401).json({ success: false, error: "Invalid or expired token" });
      }

      if (!hasValidCognitoClaims(decoded)) {
        return res.status(401).json({ success: false, error: "Invalid token claims" });
      }

      const groups = decoded["cognito:groups"] || [];
      const isAdmin = groups.includes("admins");
      const email = decoded.email || decoded.username || decoded["cognito:username"] || "";

      req.auth = {
        userId: decoded.sub,
        email,
        role: isAdmin ? "admin" : "user",
        isAdmin,
        cognitoSub: decoded.sub,
        groups,
      };

      return next();
    },
  );
}

function requireAdmin(req, res, next) {
  if (!req.auth || !req.auth.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required" });
  }
  return next();
}

module.exports = { hasValidCognitoClaims, requireAuth, requireAdmin };
