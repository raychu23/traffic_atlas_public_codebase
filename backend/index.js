require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const multer = require("multer");
const dataStorage = require("./storage");
const s3Storage = require("./s3Storage");
const { requireAuth, requireAdmin } = require("./auth");
const cognito = require("./cognito");
const emailService = require("./email");
const stepFunctions = require("./stepFunctions");
const embeddingsSphericalPca = require("./embeddingsSphericalPca");
const datasetFilterTags = require("./datasetFilterTags");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5001;
const MULTIPART_PART_SIZE_BYTES = 256 * 1024 * 1024; // 256 MB

// Middleware - CORS configuration
const ALLOWED_ORIGINS = new Set([
  "https://testing.example.com",
  "https://traffic-atlas.example.com",
  "https://www.example.com",
  "http://localhost:3000",
  "http://localhost:5173",
]);

if (process.env.CORS_ALLOWED_ORIGINS) {
  process.env.CORS_ALLOWED_ORIGINS.split(",").forEach((o) => {
    const trimmed = o.trim();
    if (trimmed) ALLOWED_ORIGINS.add(trimmed);
  });
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Any Amplify Hosting branch preview (testing.*.amplifyapp.com)
  if (/^https:\/\/[\w-]+\.[\w]+\.amplifyapp\.com$/i.test(origin)) return true;
  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    // Do not pass Error — that becomes HTTP 500 and omits CORS headers on preflight
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Disposition"],
};

app.use(cors(corsOptions));
// Ensure pre-flight OPTIONS requests always get CORS headers
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  "/legal",
  express.static(path.join(__dirname, "..", "frontend", "public", "legal")),
);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

async function clearTempUploadsOnStartup() {
  try {
    const entries = await fsPromises.readdir(uploadsDir, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          fsPromises.unlink(path.join(uploadsDir, entry.name)).catch(() => {}),
        ),
    );
  } catch (error) {
    console.warn("Unable to clear temp uploads directory:", error.message);
  }
}

const multerS3 = require("multer-s3");
const { S3Client } = require("@aws-sdk/client-s3");

let uploadStorage;
if (
  process.env.S3_BUCKET &&
  String(process.env.STORAGE_BACKEND || "").toLowerCase() === "s3"
) {
  const s3StreamingClient = new S3Client(s3Storage.getClientConfig());
  uploadStorage = multerS3({
    s3: s3StreamingClient,
    bucket: process.env.S3_BUCKET,
    key: function (req, file, cb) {
      if (!req.uploadRequestId) req.uploadRequestId = crypto.randomUUID();
      const prefix = (process.env.S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
      const relativePath = req.params.datasetId
        ? `datasets/${req.params.datasetId}/full_data.zip`
        : `requests/upload/${req.uploadRequestId}/sample_data.zip`;
      cb(null, prefix ? `${prefix}/${relativePath}` : relativePath);
    },
  });
} else {
  uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(
        null,
        file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname),
      );
    },
  });
}

const MAX_SAMPLE_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
const MAX_FULL_UPLOAD_BYTES = null; // no limit

function formatUploadLimit(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return "unlimited";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1024) {
    const tb = gb / 1024;
    return `${tb.toFixed(2)} TB`;
  }
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

const sampleUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_SAMPLE_UPLOAD_BYTES },
});

const fullUpload = multer({
  storage: uploadStorage,
});

const withUploadLimit = (bytes) => (req, res, next) => {
  req.uploadLimitBytes = bytes;
  next();
};

const generateRequestId = (req, res, next) => {
  if (!req.uploadRequestId) {
    req.uploadRequestId = crypto.randomUUID();
  }
  next();
};

async function cleanupTempUpload(filePath) {
  if (!filePath) return;
  try {
    await fsPromises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Failed to clean up temp upload:", filePath, error.message);
    }
  }
}

function resolveDatasetAccessMode(dataset = {}) {
  const accessLevel = dataset.access_level || dataset.accessLevel;
  if (accessLevel === "Public") return "open";
  if (accessLevel === "Private" || accessLevel === "Restricted")
    return "request";

  const accessPreference =
    dataset.access_preference || dataset.accessPreference;
  if (accessPreference === "open") return "open";
  if (accessPreference === "request") return "request";

  return "request";
}

function sanitizeUser(user) {
  if (!user) return user;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function slugifyFilenamePart(value, fallback = "dataset") {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback;
}

function buildDatasetDownloadName(dataset, { isSample = false } = {}) {
  const safeTitle = slugifyFilenamePart(dataset?.title);
  return `${safeTitle}${isSample ? "-sample" : ""}.zip`;
}

function hasValidBootstrapToken(req) {
  const configuredToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!configuredToken) return false;
  const provided = req.headers["x-bootstrap-token"];
  return typeof provided === "string" && provided === configuredToken;
}

function resolveAdminEmailSet() {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getDatasetOwnerId(dataset) {
  return (
    dataset?.uploaded_by ||
    dataset?.uploadedBy ||
    dataset?.system_metadata?.uploaded_by_user_id ||
    dataset?.systemMetadata?.uploadedByUserId ||
    null
  );
}

async function requireDatasetOwnerOrAdmin(req, res, datasetId) {
  const dataset = await dataStorage.getDataset(datasetId);
  if (!dataset) {
    res.status(404).json({ success: false, error: "Dataset not found" });
    return null;
  }
  const ownerId = getDatasetOwnerId(dataset);
  if (!req.auth.isAdmin && ownerId && ownerId !== req.auth.userId) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }
  if (!req.auth.isAdmin && !ownerId) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }
  return dataset;
}

/** Start Vaidio Step Function pipeline (server-side IAM only — no AWS keys from client). */
async function triggerDatasetProcessingPipeline(datasetId) {
  if (!stepFunctions.isEnabled()) {
    const err = new Error(
      "Processing pipeline is not configured. Set STEP_FUNCTIONS_STATE_MACHINE_ARN and S3_BUCKET.",
    );
    err.statusCode = 503;
    throw err;
  }
  let started;
  try {
    started = await stepFunctions.startDatasetPipeline(datasetId);
  } catch (error) {
    error.statusCode = error.statusCode || 500;
    throw error;
  }
  await dataStorage.saveDatasetPipelineExecution(datasetId, {
    executionArn: started.executionArn,
    startedAt: started.startDate,
    status: "RUNNING",
  });
  return started;
}

// Storage structure initialized automatically

// API Routes

app.get("/api/legal/upload-terms", async (req, res) => {
  try {
    const legalConfig = dataStorage.getUploadLegalConfig();
    res.json({ success: true, ...legalConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// User Registration — Cognito only (no local S3 profile)
app.post("/api/users/register", async (req, res) => {
  try {
    const { name, email, organization, role, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "Email and password are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 8 characters",
      });
    }

    const normalizedEmail = String(email || "")
      .toLowerCase()
      .trim();

    // Register with Cognito — this is the single source of truth for users
    let cognitoResult;
    try {
      cognitoResult = await cognito.signUp(normalizedEmail, password, { name });
    } catch (cognitoErr) {
      console.log("--- COGNITO SIGNUP ERROR ---");
      console.log("Name:", cognitoErr.name);
      console.log("Message:", cognitoErr.message);
      console.log("----------------------------");
      const msg = cognitoErr.message || "";
      if (
        cognitoErr.name === "UsernameExistsException" ||
        cognitoErr.name === "AliasExistsException" ||
        msg.includes("already exists")
      ) {
        return res
          .status(409)
          .json({ success: false, error: "Email is already registered" });
      }
      if (
        cognitoErr.name === "InvalidPasswordException" ||
        msg.includes("Password did not conform")
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Password must be 8+ characters with upper, lower, number, and symbol.",
        });
      }
      throw cognitoErr;
    }

    const userProfile = {
      userId: cognitoResult.userSub,
      cognitoSub: cognitoResult.userSub,
      email: normalizedEmail,
      name: name || normalizedEmail,
      organization: organization || "",
      role: role || "user",
      isAdmin: false,
      createdAt: new Date().toISOString(),
    };

    // Persist a local profile record for org/role display and admin lists
    try {
      await dataStorage.upsertUserProfile(cognitoResult.userSub, {
        email: normalizedEmail,
        name: userProfile.name,
        organization: userProfile.organization,
        role: userProfile.role,
        isAdmin: false,
      });
    } catch (e) {
      console.warn("Failed to persist local user profile:", e.message);
    }

    if (!cognitoResult.userConfirmed) {
      return res.json({
        success: true,
        requiresConfirmation: true,
        message:
          "Account created. Please check your email to verify your address before logging in.",
        user: userProfile,
      });
    }

    // Email verification off — sign in immediately
    const tokens = await cognito.initiateAuth(normalizedEmail, password);
    res.json({
      success: true,
      requiresConfirmation: false,
      user: userProfile,
      token: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      isAdmin: false,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/users/confirm-registration", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res
        .status(400)
        .json({ success: false, error: "Email and code are required" });
    }
    await cognito.confirmSignUp(String(email).toLowerCase().trim(), code);

    res.json({
      success: true,
      message: "Account verified successfully. You can now log in.",
    });
  } catch (error) {
    const msg = error.message || "";
    if (
      msg.includes("CodeMismatchException") ||
      msg.includes("Invalid verification code")
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired verification code",
      });
    }
    console.error("Confirm registration error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/users/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "Email and password are required" });
    }

    if (!process.env.COGNITO_CLIENT_ID || !process.env.COGNITO_USER_POOL_ID) {
      return res.status(503).json({
        success: false,
        error:
          "Login is not configured on this API server. Set COGNITO_CLIENT_ID and COGNITO_USER_POOL_ID in .env, or point the frontend at the deployed testing API.",
        code: "AUTH_NOT_CONFIGURED",
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // 1. Authenticate via Cognito
    let tokens;
    try {
      tokens = await cognito.initiateAuth(normalizedEmail, password);
    } catch (cognitoErr) {
      const msg = cognitoErr.message || "";
      if (
        msg.includes("NotAuthorizedException") ||
        msg.includes("UserNotFoundException") ||
        msg.includes("Incorrect username")
      ) {
        return res
          .status(401)
          .json({ success: false, error: "Invalid email or password" });
      }
      if (msg.includes("UserNotConfirmedException")) {
        return res.status(403).json({
          success: false,
          error: "Please verify your email before logging in.",
          code: "USER_NOT_CONFIRMED",
        });
      }
      throw cognitoErr;
    }

    // 2. Get user profile from Cognito — no local storage
    let userProfile;
    try {
      userProfile = await cognito.adminGetUserAttributes(normalizedEmail);
    } catch {
      userProfile = {
        userId: normalizedEmail,
        email: normalizedEmail,
        name: normalizedEmail,
        organization: "",
        role: "user",
      };
    }

    // Merge local profile data if Cognito custom attributes are missing
    try {
      const localProfile = await dataStorage.getUserByEmail(normalizedEmail);
      if (localProfile) {
        if (!userProfile.organization)
          userProfile.organization = localProfile.organization || "";
        if (!userProfile.role) userProfile.role = localProfile.role || "";
        if (!userProfile.name)
          userProfile.name = localProfile.name || userProfile.name;
      }
    } catch {
      /* ignore local lookup failures */
    }

    // 3. Check Cognito groups for isAdmin
    let isAdmin = false;
    try {
      const groups = await cognito.adminGetUserGroups(normalizedEmail);
      isAdmin = groups.includes("admins");
    } catch (groupErr) {
      console.warn("[login] Could not check Cognito groups:", groupErr.message);
    }
    if (!isAdmin) isAdmin = resolveAdminEmailSet().has(normalizedEmail);

    try {
      await dataStorage.upsertUserProfile(
        userProfile.userId || userProfile.cognitoSub || normalizedEmail,
        {
          email: normalizedEmail,
          name: userProfile.name,
          organization: userProfile.organization,
          role: userProfile.role,
          isAdmin,
        },
      );
    } catch {
      /* ignore local profile persistence errors */
    }

    res.json({
      success: true,
      token: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      isAdmin,
      user: {
        userId: userProfile.userId || userProfile.cognitoSub,
        email: userProfile.email,
        name: userProfile.name,
        organization: userProfile.organization,
        role: userProfile.role,
        isAdmin,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Forgot Password — sends reset code via Cognito
app.post("/api/users/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: "Email is required" });
    }
    const result = await cognito.forgotPassword(
      String(email).toLowerCase().trim(),
    );
    res.json({ success: true, ...result });
  } catch (error) {
    // Return generic message to avoid leaking whether an email exists, unless we want to be explicit
    if (error.message?.includes("UserNotFound")) {
      return res.status(404).json({
        success: false,
        error: "No account found with that email address.",
      });
    }
    console.error("Forgot password error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Confirm Password Reset
app.post("/api/users/confirm-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        error: "email, code, and newPassword are required",
      });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 8 characters",
      });
    }
    await cognito.confirmForgotPassword(
      String(email).toLowerCase().trim(),
      code,
      newPassword,
    );
    res.json({
      success: true,
      message: "Password reset successfully. You can now sign in.",
    });
  } catch (error) {
    const msg = error.message || "";
    if (
      msg.includes("CodeMismatchException") ||
      msg.includes("Invalid verification code")
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid or expired reset code" });
    }
    if (msg.includes("ExpiredCodeException")) {
      return res.status(400).json({
        success: false,
        error: "Reset code has expired. Please request a new one.",
      });
    }
    if (msg.includes("UserNotFound")) {
      return res.status(404).json({
        success: false,
        error: "No account found with that email address.",
      });
    }
    if (msg.includes("LimitExceededException")) {
      return res.status(429).json({
        success: false,
        error: "Too many attempts. Please try again later.",
      });
    }
    console.error("Confirm password error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const userProfile = await cognito.adminGetUserAttributes(req.auth.email);
    const groups = await cognito.adminGetUserGroups(req.auth.email);
    const isAdmin =
      groups.includes("admins") || resolveAdminEmailSet().has(req.auth.email);

    try {
      const localProfile = await dataStorage.getUserByEmail(req.auth.email);
      if (localProfile) {
        if (!userProfile.organization)
          userProfile.organization = localProfile.organization || "";
        if (!userProfile.role) userProfile.role = localProfile.role || "";
        if (!userProfile.name)
          userProfile.name = localProfile.name || userProfile.name;
      }
    } catch {
      /* ignore local lookup failures */
    }

    try {
      await dataStorage.upsertUserProfile(
        userProfile.userId || userProfile.cognitoSub || req.auth.email,
        {
          email: req.auth.email,
          name: userProfile.name,
          organization: userProfile.organization,
          role: userProfile.role,
          isAdmin,
        },
      );
    } catch {
      /* ignore local profile persistence errors */
    }

    res.json({
      success: true,
      user: {
        userId: userProfile.userId || userProfile.cognitoSub,
        cognitoSub: userProfile.cognitoSub,
        email: userProfile.email,
        name: userProfile.name,
        organization: userProfile.organization,
        role: userProfile.role,
        isAdmin,
      },
    });
  } catch (error) {
    if (error.message?.includes("UserNotFound")) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current user profile (alias for auth/me, includes local profile fallback)
app.get("/api/users/me", requireAuth, async (req, res) => {
  try {
    let userProfile;
    let isAdmin = resolveAdminEmailSet().has(req.auth.email);

    // Try Cognito admin API; fall back to token claims if it fails (e.g., missing creds in testing)
    try {
      userProfile = await cognito.adminGetUserAttributes(req.auth.email);
      const groups = await cognito.adminGetUserGroups(req.auth.email);
      isAdmin = groups.includes("admins") || isAdmin;
    } catch (cognitoErr) {
      console.warn(
        "[/api/users/me] Cognito admin API unavailable, falling back to token claims:",
        cognitoErr.message,
      );
      userProfile = {
        userId: req.auth.userId || req.auth.email,
        cognitoSub: req.auth.userId,
        email: req.auth.email,
        name: req.auth.name || req.auth.email,
        organization: "",
        role: "",
      };
      isAdmin = isAdmin || req.auth.isAdmin || false;
    }

    try {
      const localProfile = await dataStorage.getUserByEmail(req.auth.email);
      if (localProfile) {
        if (!userProfile.organization)
          userProfile.organization = localProfile.organization || "";
        if (!userProfile.role) userProfile.role = localProfile.role || "";
        if (!userProfile.name)
          userProfile.name = localProfile.name || userProfile.name;
        if (typeof localProfile.isAdmin === "boolean")
          isAdmin = isAdmin || localProfile.isAdmin;
      }
    } catch {
      /* ignore local lookup failures */
    }

    res.json({
      success: true,
      user: {
        userId: userProfile.userId || userProfile.cognitoSub,
        cognitoSub: userProfile.cognitoSub,
        email: userProfile.email,
        name: userProfile.name,
        organization: userProfile.organization,
        role: userProfile.role,
        isAdmin,
      },
    });
  } catch (error) {
    if (error.message?.includes("UserNotFound")) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update current user profile (name/org/role)
app.put("/api/users/me", requireAuth, async (req, res) => {
  try {
    const { name, organization, role } = req.body || {};
    const email = req.auth.email;
    if (!email)
      return res
        .status(400)
        .json({ success: false, error: "Email missing from session" });

    try {
      await cognito.adminUpdateUserAttributes(email, {
        name: name ?? undefined,
        organization: organization ?? undefined,
        role: role ?? undefined,
      });
    } catch (err) {
      console.warn("Cognito profile update failed:", err.message);
    }

    const updated = await dataStorage.upsertUserProfile(
      req.auth.userId || email,
      {
        email,
        name: name ?? undefined,
        organization: organization ?? undefined,
        role: role ?? undefined,
      },
    );

    res.json({ success: true, user: sanitizeUser(updated) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete current user profile (local + Cognito)
app.delete("/api/users/me", requireAuth, async (req, res) => {
  try {
    const email = req.auth.email;
    if (!email)
      return res
        .status(400)
        .json({ success: false, error: "Email missing from session" });

    try {
      await cognito.adminDeleteUser(email);
    } catch (err) {
      console.warn("Cognito delete failed:", err.message);
    }

    try {
      await dataStorage.deleteUser(req.auth.userId || email);
    } catch (err) {
      console.warn("Local profile delete failed:", err.message);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user by ID (or email)
app.get("/api/users/:userId", requireAuth, async (req, res) => {
  try {
    const targetUserId = decodeURIComponent(req.params.userId);
    if (
      req.auth.email !== targetUserId &&
      req.auth.userId !== targetUserId &&
      !req.auth.isAdmin
    ) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const userProfile = await cognito.adminGetUserAttributes(targetUserId);
    const groups = await cognito.adminGetUserGroups(targetUserId);
    const isAdmin =
      groups.includes("admins") || resolveAdminEmailSet().has(targetUserId);

    res.json({
      success: true,
      user: {
        userId: userProfile.userId || userProfile.cognitoSub,
        cognitoSub: userProfile.cognitoSub,
        email: userProfile.email,
        name: userProfile.name,
        organization: userProfile.organization,
        role: userProfile.role,
        isAdmin,
      },
    });
  } catch (error) {
    if (error.message?.includes("UserNotFound")) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get(
  "/api/admin/s3/contents",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const prefix = req.query.prefix || "";
      const contents = await s3Storage.listS3Contents(prefix);
      res.json({ success: true, ...contents });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/admin/users/:userId/set-admin",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      // userId is the user's email (Cognito username)
      const targetEmail = decodeURIComponent(req.params.userId);
      const isAdmin = req.body?.isAdmin !== false;

      if (isAdmin) {
        await cognito.adminAddToGroup(targetEmail, "admins");
      } else {
        await cognito.adminRemoveFromGroup(targetEmail, "admins");
      }

      res.json({ success: true, email: targetEmail, isAdmin });
    } catch (error) {
      if (error.message?.includes("UserNotFoundException")) {
        return res
          .status(404)
          .json({ success: false, error: "User not found in Cognito" });
      }
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ── Admin: List all users ────────────────────────────────────────────────────
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await cognito.listAllUsers();
    const merged = [];
    for (const user of users) {
      if (user.organization && user.role) {
        merged.push(user);
        continue;
      }
      try {
        const local = await dataStorage.getUserByEmail(user.email);
        if (local) {
          merged.push({
            ...user,
            organization: user.organization || local.organization || "",
            role: user.role || local.role || "",
            name: user.name || local.name || user.name,
          });
        } else {
          merged.push(user);
        }
      } catch {
        merged.push(user);
      }
    }
    res.json({ success: true, users: merged });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Admin: Delete a user (Cognito only) ─────────────────────────────────────
app.delete(
  "/api/admin/users/:userId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      // userId param is the user's email (Cognito username)
      const targetEmail = decodeURIComponent(req.params.userId);

      // Prevent self-deletion
      const callerEmail = req.auth?.email;
      if (
        callerEmail &&
        callerEmail.toLowerCase() === targetEmail.toLowerCase()
      ) {
        return res.status(400).json({
          success: false,
          error: "You cannot delete your own account",
        });
      }

      // Delete from Cognito — single source of truth for users
      await cognito.adminDeleteUser(targetEmail);

      res.json({
        success: true,
        message: `User ${targetEmail} deleted from Cognito`,
      });
    } catch (error) {
      if (error.message?.includes("UserNotFoundException")) {
        return res
          .status(404)
          .json({ success: false, error: "User not found in Cognito" });
      }
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post("/api/admin/bootstrap/set-admin", async (req, res) => {
  try {
    if (!hasValidBootstrapToken(req)) {
      return res
        .status(403)
        .json({ success: false, error: "Invalid bootstrap token" });
    }

    const isAdmin = req.body?.isAdmin !== false;
    const { userId, email } = req.body || {};
    let updatedUser = null;

    if (userId) {
      updatedUser = await dataStorage.setUserAdminById(userId, isAdmin);
    } else if (email) {
      updatedUser = await dataStorage.setUserAdminByEmail(email, isAdmin);
    } else {
      return res
        .status(400)
        .json({ success: false, error: "userId or email is required" });
    }

    if (!updatedUser) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, user: sanitizeUser(updatedUser) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Submit upload request
app.post(
  "/api/datasets/upload-request",
  requireAuth,
  generateRequestId,
  withUploadLimit(MAX_SAMPLE_UPLOAD_BYTES),
  sampleUpload.single("sampleFile"),
  async (req, res) => {
    let tempFilePath = null;
    try {
      const userId = req.auth.userId;
      // req.file.path exists for local disk, req.file.location exists for S3 stream
      tempFilePath = req.file?.path || null;

      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "Sample file is required" });
      }

      let metadata;
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch (e) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid metadata JSON" });
      }

      // Auto-fill hidden metadata attributes
      metadata.system_metadata = {
        upload_timestamp: new Date().toISOString(),
        last_modified_timestamp: new Date().toISOString(),
        uploaded_by_user_id: userId,
      };

      // Validate upload request (skip physical file checks if streamed securely to S3)
      const validation = await dataStorage.validateUploadRequest(
        metadata,
        req.file.location || req.file.path,
      );

      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }

      // Create upload request (Pass the intercepted UUID mapping so it aligns physically generated paths)
      const request = await dataStorage.createUploadRequest(userId, {
        requestId: req.uploadRequestId,
        metadata,
        sampleFileSize: req.file.size,
        sampleFileName: req.file.originalname,
      });
      const requestId = req.uploadRequestId;

      // Save sample file strictly if local-mode. S3 streams are already complete at this point!
      if (tempFilePath) {
        await dataStorage.saveToStaging(requestId, tempFilePath, {
          ...metadata,
          uploaded_by: userId,
        });
      } else {
        // Just write the metadata structure since S3 took the zip native stream
        await dataStorage.saveToStaging(requestId, null, {
          ...metadata,
          uploaded_by: userId,
        });
      }

      // Save validation results
      const checksPath = path.join(
        dataStorage.DATA_ROOT,
        "requests",
        "upload",
        requestId,
        "sample_check.json",
      );
      const checksPayload = JSON.stringify(
        {
          validation,
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      if (s3Storage.isPrimaryMode()) {
        await s3Storage.putDataPathFromText(
          checksPath,
          checksPayload,
          "application/json",
        );
      } else {
        await fsPromises.mkdir(path.dirname(checksPath), { recursive: true });
        await fsPromises.writeFile(checksPath, checksPayload);
        await s3Storage.mirrorDataFile(checksPath, "application/json");
      }

      // Log audit event
      await dataStorage.logAuditEvent("upload", {
        requestId,
        userId,
        action: "upload_request_submitted",
        validationWarnings: validation.warnings,
      });

      res.json({
        success: true,
        requestId,
        message: "Upload request submitted. Waiting for admin review.",
        warnings: validation.warnings,
      });
    } catch (error) {
      console.error("Upload request error:", error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      await cleanupTempUpload(tempFilePath);
    }
  },
);

// Get upload request details (user-facing)
app.get("/api/upload-requests/:requestId", requireAuth, async (req, res) => {
  try {
    const { requestId } = req.params;
    const request = await dataStorage.getUploadRequest(requestId);
    if (!request) {
      return res
        .status(404)
        .json({ success: false, error: "Request not found" });
    }

    // Check ownership
    if (request.userId !== req.auth.userId && !req.auth.isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    res.json({ success: true, request });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload full dataset after approval
app.post(
  "/api/datasets/:datasetId/upload-full",
  requireAuth,
  fullUpload.single("fullFile"),
  async (req, res) => {
    let tempFilePath = null;
    try {
      const { datasetId } = req.params;
      tempFilePath = req.file?.path || null;

      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "Full dataset file is required" });
      }

      // Verify dataset exists and is approved
      const dataset = await dataStorage.getDataset(datasetId);
      if (!dataset) {
        return res
          .status(404)
          .json({ success: false, error: "Dataset not found" });
      }

      if (tempFilePath) {
        // Local caching fallback if S3 isn't mapped
        await dataStorage.saveDatasetFile(datasetId, tempFilePath, false);
      }
      // Stream mode bypassed saving since `multer-s3` already pipelined the data to datasets/<id>/full_data.zip

      await dataStorage.updateDatasetStatus(datasetId, "active");
      await dataStorage.updateUploadRequestStatus(datasetId, "active");

      res.json({ success: true, message: "Full dataset securely streamed" });
    } catch (error) {
      console.error("Full upload error:", error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      await cleanupTempUpload(tempFilePath);
    }
  },
);

// Multipart Upload (Sample Dataset)
app.post(
  "/api/datasets/upload-request/multipart/initiate",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const {
        fileName,
        fileSize,
        contentType,
        requestId: providedRequestId,
      } = req.body || {};
      if (!fileName || !fileSize) {
        return res.status(400).json({
          success: false,
          error: "fileName and fileSize are required.",
        });
      }

      const requestId = providedRequestId || crypto.randomUUID();
      const samplePath = path.join(
        dataStorage.DATA_ROOT,
        "requests",
        "upload",
        requestId,
        "sample_data.zip",
      );
      const key = s3Storage.toS3KeyFromDataPath(samplePath);

      const existing = await dataStorage.getMultipartSampleSession(requestId);
      if (existing && existing.status === "in_progress") {
        if (
          existing.fileName === fileName &&
          Number(existing.fileSize) === Number(fileSize)
        ) {
          return res.json({ success: true, session: existing, reused: true });
        }
        try {
          await s3Storage.abortMultipartUpload({
            key: existing.key,
            uploadId: existing.uploadId,
          });
        } catch (e) {}
        await dataStorage.clearMultipartSampleSession(requestId);
      }

      const { uploadId } = await s3Storage.createMultipartUpload({
        key,
        contentType: contentType || "application/zip",
        metadata: { uploader: req.auth.userId, requestId },
      });

      const session = {
        requestId,
        uploadId,
        key,
        fileName,
        fileSize,
        contentType: contentType || "application/zip",
        partSize: MULTIPART_PART_SIZE_BYTES,
        userId: req.auth.userId,
        createdAt: new Date().toISOString(),
        status: "in_progress",
      };

      await dataStorage.saveMultipartSampleSession(requestId, session);
      res.json({ success: true, session });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.get(
  "/api/datasets/upload-request/:requestId/multipart/parts",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { requestId } = req.params;
      const session = await dataStorage.getMultipartSampleSession(requestId);
      if (!session)
        return res
          .status(404)
          .json({ success: false, error: "No upload session found." });
      if (!req.auth.isAdmin && session.userId !== req.auth.userId) {
        return res.status(403).json({ success: false, error: "Forbidden" });
      }

      const parts = await s3Storage.listMultipartParts({
        key: session.key,
        uploadId: session.uploadId,
      });
      res.json({ success: true, parts });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/datasets/upload-request/:requestId/multipart/part-url",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { requestId } = req.params;
      const { partNumber } = req.body || {};
      if (!partNumber) {
        return res
          .status(400)
          .json({ success: false, error: "partNumber is required." });
      }
      const session = await dataStorage.getMultipartSampleSession(requestId);
      if (!session)
        return res
          .status(404)
          .json({ success: false, error: "No upload session found." });
      if (!req.auth.isAdmin && session.userId !== req.auth.userId) {
        return res.status(403).json({ success: false, error: "Forbidden" });
      }

      const url = await s3Storage.getMultipartPartUrl({
        key: session.key,
        uploadId: session.uploadId,
        partNumber: Number(partNumber),
      });
      res.json({ success: true, url });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/datasets/upload-request/:requestId/multipart/complete",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { requestId } = req.params;
      const { parts, metadata, sampleFileName, sampleFileSize } =
        req.body || {};
      if (!Array.isArray(parts) || parts.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: "parts are required." });
      }
      if (!metadata) {
        return res
          .status(400)
          .json({ success: false, error: "metadata is required." });
      }

      const session = await dataStorage.getMultipartSampleSession(requestId);
      if (!session)
        return res
          .status(404)
          .json({ success: false, error: "No upload session found." });
      if (!req.auth.isAdmin && session.userId !== req.auth.userId) {
        return res.status(403).json({ success: false, error: "Forbidden" });
      }

      const orderedParts = parts
        .map((p) => ({ PartNumber: Number(p.PartNumber), ETag: p.ETag }))
        .sort((a, b) => a.PartNumber - b.PartNumber);

      await s3Storage.completeMultipartUpload({
        key: session.key,
        uploadId: session.uploadId,
        parts: orderedParts,
      });

      const userId = req.auth.userId;
      const normalizedMeta =
        typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      normalizedMeta.system_metadata = {
        upload_timestamp: new Date().toISOString(),
        last_modified_timestamp: new Date().toISOString(),
        uploaded_by_user_id: userId,
      };

      const validation = await dataStorage.validateUploadRequest(
        normalizedMeta,
        `s3://${session.key}`,
      );
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }

      const request = await dataStorage.createUploadRequest(userId, {
        requestId,
        metadata: normalizedMeta,
        sampleFileSize: sampleFileSize || session.fileSize,
        sampleFileName: sampleFileName || session.fileName,
      });

      await dataStorage.saveToStaging(requestId, null, {
        ...normalizedMeta,
        uploaded_by: userId,
      });

      const checksPath = path.join(
        dataStorage.DATA_ROOT,
        "requests",
        "upload",
        requestId,
        "sample_check.json",
      );
      const checksPayload = JSON.stringify(
        {
          validation,
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      if (s3Storage.isPrimaryMode()) {
        await s3Storage.putDataPathFromText(
          checksPath,
          checksPayload,
          "application/json",
        );
      } else {
        await fsPromises.mkdir(path.dirname(checksPath), { recursive: true });
        await fsPromises.writeFile(checksPath, checksPayload);
        await s3Storage.mirrorDataFile(checksPath, "application/json");
      }

      await dataStorage.logAuditEvent("upload", {
        requestId,
        userId,
        action: "upload_request_submitted",
        validationWarnings: validation.warnings,
      });

      await dataStorage.clearMultipartSampleSession(requestId);
      res.json({
        success: true,
        requestId: request.requestId || requestId,
        message: "Upload request submitted. Waiting for admin review.",
        warnings: validation.warnings,
      });
    } catch (error) {
      console.error("Multipart sample upload error:", error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      // no temp file cleanup needed for multipart sample
    }
  },
);

app.post(
  "/api/datasets/upload-request/:requestId/multipart/abort",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { requestId } = req.params;
      const session = await dataStorage.getMultipartSampleSession(requestId);
      if (!session)
        return res
          .status(404)
          .json({ success: false, error: "No upload session found." });
      if (!req.auth.isAdmin && session.userId !== req.auth.userId) {
        return res.status(403).json({ success: false, error: "Forbidden" });
      }
      await s3Storage.abortMultipartUpload({
        key: session.key,
        uploadId: session.uploadId,
      });
      await dataStorage.clearMultipartSampleSession(requestId);
      res.json({ success: true, message: "Multipart upload aborted." });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Multipart Upload (Direct to S3)
app.post(
  "/api/datasets/:datasetId/upload-full/multipart/initiate",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { datasetId } = req.params;
      const { fileName, fileSize, contentType } = req.body || {};
      if (!fileName || !fileSize) {
        return res.status(400).json({
          success: false,
          error: "fileName and fileSize are required.",
        });
      }

      const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
      if (!dataset) return;

      const existing = await dataStorage.getMultipartUploadSession(datasetId);
      if (existing && existing.status === "in_progress") {
        if (
          existing.fileName === fileName &&
          Number(existing.fileSize) === Number(fileSize)
        ) {
          try {
            await s3Storage.listMultipartParts({
              key: existing.key,
              uploadId: existing.uploadId,
            });
            return res.json({ success: true, session: existing, reused: true });
          } catch (e) {
            if (!s3Storage.isMultipartUploadNotFoundError(e)) throw e;
            await dataStorage.clearMultipartUploadSession(datasetId);
          }
        } else {
          try {
            await s3Storage.abortMultipartUpload({
              key: existing.key,
              uploadId: existing.uploadId,
            });
          } catch (e) {}
          await dataStorage.clearMultipartUploadSession(datasetId);
        }
      }

      const { uploadId, key } = await s3Storage.createMultipartUpload({
        datasetId,
        contentType,
        metadata: { uploader: req.auth.userId },
      });

      const request = await dataStorage.findUploadRequestByDatasetId(datasetId);
      const session = {
        datasetId,
        requestId: request?.requestId || null,
        uploadId,
        key,
        fileName,
        fileSize,
        contentType: contentType || "application/octet-stream",
        partSize: MULTIPART_PART_SIZE_BYTES,
        userId: req.auth.userId,
        createdAt: new Date().toISOString(),
        status: "in_progress",
      };

      await dataStorage.saveMultipartUploadSession(datasetId, session);
      res.json({ success: true, session });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.get(
  "/api/datasets/:datasetId/upload-full/multipart/session",
  requireAuth,
  async (req, res) => {
    try {
      const { datasetId } = req.params;
      const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
      if (!dataset) return;
      let session = await dataStorage.getMultipartUploadSession(datasetId);
      let fullUploadExists = false;
      if (s3Storage.isEnabled()) {
        fullUploadExists = await s3Storage.objectExists(
          s3Storage.getDatasetFullKey(datasetId),
        );
      }
      if (
        session?.status === "in_progress" &&
        session.uploadId &&
        session.key
      ) {
        try {
          await s3Storage.listMultipartParts({
            key: session.key,
            uploadId: session.uploadId,
          });
        } catch (e) {
          if (s3Storage.isMultipartUploadNotFoundError(e)) {
            await dataStorage.clearMultipartUploadSession(datasetId);
            session = null;
          } else {
            throw e;
          }
        }
      }
      if (fullUploadExists && session?.status === "in_progress") {
        await dataStorage.clearMultipartUploadSession(datasetId);
        session = null;
      }
      res.json({ success: true, session, fullUploadExists });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.get(
  "/api/datasets/:datasetId/upload-full/multipart/parts",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { datasetId } = req.params;
      const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
      if (!dataset) return;

      const session = await dataStorage.getMultipartUploadSession(datasetId);
      const uploadId = req.query.uploadId || session?.uploadId;
      const key = req.query.key || session?.key;
      if (!uploadId || !key) {
        return res
          .status(400)
          .json({ success: false, error: "uploadId and key are required." });
      }

      const parts = await s3Storage.listMultipartParts({ key, uploadId });
      res.json({ success: true, parts });
    } catch (error) {
      if (s3Storage.isMultipartUploadNotFoundError(error)) {
        await dataStorage.clearMultipartUploadSession(datasetId);
        return res.status(404).json({
          success: false,
          code: "STALE_MULTIPART_UPLOAD",
          error:
            "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.",
        });
      }
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/datasets/:datasetId/upload-full/multipart/part-url",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { datasetId } = req.params;
      const { uploadId, key, partNumber } = req.body || {};
      if (!uploadId || !key || !partNumber) {
        return res.status(400).json({
          success: false,
          error: "uploadId, key, and partNumber are required.",
        });
      }
      const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
      if (!dataset) return;

      const url = await s3Storage.getMultipartPartUrl({
        key,
        uploadId,
        partNumber: Number(partNumber),
      });
      res.json({ success: true, url });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/datasets/:datasetId/upload-full/multipart/complete",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { datasetId } = req.params;
      const { uploadId, key, parts } = req.body || {};
      if (!uploadId || !key || !Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({
          success: false,
          error: "uploadId, key, and parts are required.",
        });
      }
      const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
      if (!dataset) return;

      const orderedParts = parts
        .map((p) => ({ PartNumber: Number(p.PartNumber), ETag: p.ETag }))
        .sort((a, b) => a.PartNumber - b.PartNumber);

      await s3Storage.completeMultipartUpload({
        key,
        uploadId,
        parts: orderedParts,
      });

      await dataStorage.updateDatasetStatus(datasetId, "active");
      const request = await dataStorage.findUploadRequestByDatasetId(datasetId);
      if (request?.requestId) {
        await dataStorage.updateUploadRequestStatus(
          request.requestId,
          "active",
        );
      }

      await dataStorage.clearMultipartUploadSession(datasetId);

      let pipeline = null;
      try {
        const started = await triggerDatasetProcessingPipeline(datasetId);
        pipeline = {
          executionArn: started.executionArn,
          message: "Processing pipeline started",
        };
      } catch (pipelineErr) {
        console.warn(
          "Pipeline start after full upload failed:",
          pipelineErr.message,
        );
        pipeline = {
          started: false,
          error: pipelineErr.message,
        };
      }

      res.json({
        success: true,
        message: "Multipart upload completed.",
        dataset_id: datasetId,
        pipeline,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

/**
 * Start processing pipeline (e.g. after final upload approval).
 * Body: optional { "dataset_id": "..." } — dataset_id in URL is authoritative.
 */
app.post("/api/datasets/:datasetId/approve", requireAuth, async (req, res) => {
  try {
    const { datasetId } = req.params;
    const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
    if (!dataset) return;

    const started = await triggerDatasetProcessingPipeline(datasetId);

    res.json({
      success: true,
      dataset_id: datasetId,
      executionArn: started.executionArn,
      message: "Processing pipeline started",
    });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error("Dataset approve/pipeline error:", error);
    res.status(status).json({
      success: false,
      error: error.message,
      code: error.code || undefined,
    });
  }
});

/**
 * Poll processing status (Step Functions + S3 analysis/status/processing_status.json).
 */
app.get("/api/datasets/:datasetId/status", requireAuth, async (req, res) => {
  try {
    const { datasetId } = req.params;
    const dataset = await dataStorage.getDataset(datasetId);
    const executionArn =
      dataset?.pipeline?.executionArn ||
      dataset?.pipeline?.execution_arn ||
      null;

    const status = await stepFunctions.getDatasetProcessingStatus(
      datasetId,
      executionArn,
    );

    if (!dataset && !status.processingStatus && !status.execution) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Allow analysis when dataset is active, sample-approved, or embeddings already exist on S3. */
async function assertEmbeddingAnalysisAllowed(datasetId, dataset) {
  if (embeddingsSphericalPca.isHardcodedDataset(datasetId)) {
    return dataset;
  }
  if (dataset.status === "active" || dataset.status === "pending_full_upload") {
    return dataset;
  }
  const videos = await embeddingsSphericalPca.listEmbeddingVideos(datasetId);
  if (videos.length > 0) {
    return dataset;
  }
  const err = new Error(
    `Embedding analysis is not available yet (dataset status: ${dataset.status || "unknown"}). ` +
      "Complete full upload and processing, or wait until CLIP embeddings appear under analysis/embeddings/clip/ on S3.",
  );
  err.statusCode = 403;
  throw err;
}

/**
 * Spherical PCA of CLIP embeddings — scoped to dataset S3 prefix, active datasets only.
 */
app.get("/api/datasets/:datasetId/embeddings/videos", async (req, res) => {
  try {
    const { datasetId } = req.params;
    const dataset = await dataStorage.getDataset(datasetId);
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }
    await assertEmbeddingAnalysisAllowed(datasetId, dataset);
    const videos = await embeddingsSphericalPca.listEmbeddingVideos(datasetId);
    res.json({
      success: true,
      datasetId,
      prefix: embeddingsSphericalPca.getEmbeddingsClipPrefix(datasetId),
      videos,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

app.get(
  "/api/datasets/:datasetId/embeddings/spherical-pca",
  async (req, res) => {
    try {
      const { datasetId } = req.params;
      const videoId = req.query.video_id || req.query.videoId || null;
      const dataset = await dataStorage.getDataset(datasetId);
      if (!dataset) {
        return res
          .status(404)
          .json({ success: false, error: "Dataset not found" });
      }
      await assertEmbeddingAnalysisAllowed(datasetId, dataset);
      const payload = await embeddingsSphericalPca.getSphericalPcaForDataset(
        datasetId,
        { videoId },
      );
      res.json(payload);
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  },
);

/** Dataset-level analysis tags (dataset_filter_tags.json on S3). */
app.get("/api/datasets/:datasetId/analysis/filter-tags", async (req, res) => {
  try {
    const { datasetId } = req.params;
    const dataset = await dataStorage.getDataset(datasetId);
    if (!dataset && !embeddingsSphericalPca.isHardcodedDataset(datasetId)) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }
    const payload = await datasetFilterTags.loadDatasetFilterTags(datasetId);
    if (!payload) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset filter tags not found" });
    }
    res.json({ success: true, ...payload });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post(
  "/api/datasets/:datasetId/upload-full/multipart/abort",
  requireAuth,
  async (req, res) => {
    try {
      if (!s3Storage.isEnabled()) {
        return res.status(400).json({
          success: false,
          error: "S3 is not configured for multipart uploads.",
        });
      }
      const { datasetId } = req.params;
      const { uploadId, key } = req.body || {};
      if (!uploadId || !key) {
        return res
          .status(400)
          .json({ success: false, error: "uploadId and key are required." });
      }
      const dataset = await requireDatasetOwnerOrAdmin(req, res, datasetId);
      if (!dataset) return;

      await s3Storage.abortMultipartUpload({ key, uploadId });
      await dataStorage.clearMultipartUploadSession(datasetId);
      res.json({ success: true, message: "Multipart upload aborted." });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Get all datasets
app.get("/api/datasets", async (req, res) => {
  try {
    const { search, organization, tags } = req.query;
    // We pass includePending: true here because the user wants to see "all datasets being uploaded"
    const datasets = await dataStorage.searchDatasets({
      search,
      organization,
      tags,
      includePending: true,
    });
    res.json({ success: true, datasets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get dataset by ID
app.get("/api/datasets/:datasetId", async (req, res) => {
  try {
    const dataset = await dataStorage.getDataset(req.params.datasetId);
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }
    res.json({ success: true, dataset });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Download dataset
app.post("/api/datasets/:datasetId/download", requireAuth, async (req, res) => {
  try {
    const { downloaderMetadata, consents } = req.body;
    const dataset = await dataStorage.getDataset(req.params.datasetId);

    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    // New check: if it's public but we don't have the data yet, block download
    if (
      dataset.status === "pending_full_upload" &&
      dataset.access_level === "Public"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "The uploader has not yet provided the full dataset file. Only the sample is available.",
      });
    }

    // Save consent
    if (consents) {
      await dataStorage.saveConsent(req.auth.userId, {
        type: "download",
        datasetId: req.params.datasetId,
        ...consents,
      });
    }

    // Check if open access or request required (supports access_level and legacy fields)
    const accessMode = resolveDatasetAccessMode(dataset);
    if (accessMode === "request") {
      // Create download request
      const request = await dataStorage.createDownloadRequest(
        req.auth.userId,
        req.params.datasetId,
        {
          ...downloaderMetadata,
          userId: req.auth.userId,
          consents,
        },
      );

      // Log audit event
      await dataStorage.logAuditEvent("download", {
        datasetId: req.params.datasetId,
        userId: req.auth.userId,
        action: "download_requested",
        requestId: request.requestId,
      });

      return res.json({
        success: true,
        requiresApproval: true,
        requestId: request.requestId,
        message: "Download request submitted. Please wait for approval.",
      });
    }

    // Log audit event for open access download
    await dataStorage.logAuditEvent("download", {
      datasetId: req.params.datasetId,
      userId: req.auth.userId,
      action: "dataset_downloaded",
    });

    let filePath = await dataStorage.getDatasetFile(req.params.datasetId, false);
    let isSample = false;
    if (!filePath) {
      filePath = await dataStorage.getDatasetFile(req.params.datasetId, true);
      isSample = true;
    }
    if (!filePath) {
      return res
        .status(404)
        .json({ success: false, error: "File not found" });
    }

    const downloadName = buildDatasetDownloadName(dataset, { isSample });
    const downloadPayload = await buildDownloadUrlPayload(
      req.params.datasetId,
      filePath,
      downloadName,
      isSample,
    );

    res.json({
      ...downloadPayload,
      message: "Download recorded. Your download will start automatically.",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Presigned S3 URL for sample download (preferred — browser fetches directly from S3)
app.get(
  "/api/datasets/:datasetId/sample-url",
  requireAuth,
  async (req, res) => {
    try {
      const { datasetId } = req.params;
      const dataset = await dataStorage.getDataset(datasetId);

      if (!dataset) {
        return res
          .status(404)
          .json({ success: false, error: "Dataset not found" });
      }

      const filePath = await dataStorage.getDatasetFile(datasetId, true);
      if (!filePath) {
        return res
          .status(404)
          .json({ success: false, error: "Sample file not found" });
      }

      try {
        await dataStorage.logAuditEvent("download", {
          datasetId,
          action: "sample_downloaded",
          unrestricted: true,
        });
      } catch (auditErr) {
        console.warn("sample-url audit log failed:", auditErr.message);
      }

      const downloadName = buildDatasetDownloadName(dataset, { isSample: true });
      const payload = await buildDownloadUrlPayload(
        datasetId,
        filePath,
        downloadName,
        true,
      );
      res.json(payload);
    } catch (error) {
      console.error("sample-url error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Download sample dataset (unrestricted access)
app.get("/api/datasets/:datasetId/sample", requireAuth, async (req, res) => {
  try {
    const dataset = await dataStorage.getDataset(req.params.datasetId);

    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    // Get sample file
    const filePath = await dataStorage.getDatasetFile(
      req.params.datasetId,
      true,
    );

    if (!filePath) {
      return res
        .status(404)
        .json({ success: false, error: "Sample file not found" });
    }

    // Log sample download (unrestricted)
    await dataStorage.logAuditEvent("download", {
      datasetId: req.params.datasetId,
      action: "sample_downloaded",
      unrestricted: true,
    });

    const downloadName = buildDatasetDownloadName(dataset, { isSample: true });
    if (String(filePath).startsWith("s3://")) {
      const downloadUrl = await s3Storage.getSignedDownloadUrl(
        filePath,
        downloadName,
      );
      return res.redirect(downloadUrl);
    }
    res.download(filePath, downloadName, (err) => {
      if (err) {
        console.error("Download error:", err);
        if (!res.headersSent) {
          res
            .status(500)
            .json({ success: false, error: "File download failed" });
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** JSON payload for client-side download (presigned S3 URL when on S3). */
async function buildDownloadUrlPayload(
  datasetId,
  filePath,
  downloadName,
  isSample = false,
) {
  if (String(filePath).startsWith("s3://")) {
    const signedUrl = await s3Storage.getSignedDownloadUrl(
      filePath,
      downloadName,
    );
    return {
      success: true,
      downloadUrl: signedUrl,
      fileName: downloadName,
      isSample,
      direct: true,
    };
  }

  const apiPath = isSample
    ? `/api/datasets/${datasetId}/sample`
    : `/api/datasets/${datasetId}/file`;

  return {
    success: true,
    downloadUrl: apiPath,
    fileName: downloadName,
    isSample,
    direct: false,
  };
}

async function resolveDatasetDownload(req, res) {
  const dataset = await dataStorage.getDataset(req.params.datasetId);

  if (!dataset) {
    res.status(404).json({ success: false, error: "Dataset not found" });
    return null;
  }

  const userId = req.auth.userId;
  const accessMode = resolveDatasetAccessMode(dataset);

  if (accessMode === "open") {
    let filePath = await dataStorage.getDatasetFile(
      req.params.datasetId,
      false,
    );
    let isSample = false;
    if (!filePath) {
      filePath = await dataStorage.getDatasetFile(req.params.datasetId, true);
      isSample = true;
    }

    if (!filePath) {
      res.status(404).json({ success: false, error: "File not found" });
      return null;
    }

    return {
      dataset,
      filePath,
      isSample,
      downloadName: buildDatasetDownloadName(dataset, { isSample }),
    };
  }

  if (userId) {
    const isApproved = await dataStorage.hasApprovedDownloadAccess(
      userId,
      req.params.datasetId,
    );
    if (isApproved) {
      let filePath = await dataStorage.getDatasetFile(
        req.params.datasetId,
        false,
      );
      let isSample = false;
      if (!filePath) {
        filePath = await dataStorage.getDatasetFile(req.params.datasetId, true);
        isSample = true;
      }

      if (!filePath) {
        res.status(404).json({ success: false, error: "File not found" });
        return null;
      }

      return {
        dataset,
        filePath,
        isSample,
        downloadName: buildDatasetDownloadName(dataset, { isSample }),
      };
    }
  }

  res.status(403).json({
    success: false,
    error:
      "Full dataset access requires approval. Please submit a download request.",
  });
  return null;
}

app.get("/api/datasets/:datasetId/file-url", requireAuth, async (req, res) => {
  try {
    const resolved = await resolveDatasetDownload(req, res);
    if (!resolved) return;

    const { filePath, downloadName, isSample } = resolved;
    const payload = await buildDownloadUrlPayload(
      req.params.datasetId,
      filePath,
      downloadName,
      isSample,
    );
    return res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get file download (full dataset - requires approval for request-based)
app.get("/api/datasets/:datasetId/file", requireAuth, async (req, res) => {
  try {
    const resolved = await resolveDatasetDownload(req, res);
    if (!resolved) return;

    const { filePath, downloadName } = resolved;
    if (String(filePath).startsWith("s3://")) {
      const downloadUrl = await s3Storage.getSignedDownloadUrl(
        filePath,
        downloadName,
      );
      return res.redirect(downloadUrl);
    }
    res.download(filePath, downloadName, (err) => {
      if (err) {
        console.error("Download error:", err);
        if (!res.headersSent) {
          res
            .status(500)
            .json({ success: false, error: "File download failed" });
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Endpoints

// Get upload requests (for admin)
app.get(
  "/api/admin/upload-requests",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const queue = await dataStorage.getAdminQueue("upload_requests");
      const requests = [];

      for (const requestId of queue) {
        const request = await dataStorage.getUploadRequest(requestId);
        if (request) {
          const stagingData = await dataStorage.getStagingData(requestId);
          const messages = await dataStorage.getMessages(requestId, "upload");
          const lastMessage = messages.length
            ? messages[messages.length - 1]
            : null;
          requests.push({
            ...request,
            stagingData: stagingData
              ? {
                  hasSample: stagingData.hasSample,
                  metadata: stagingData.metadata,
                }
              : null,
            lastMessage,
          });
        }
      }

      res.json({ success: true, requests });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Get upload request details (for admin)
app.get(
  "/api/admin/upload-requests/:requestId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const request = await dataStorage.getUploadRequest(requestId);

      if (!request) {
        return res
          .status(404)
          .json({ success: false, error: "Request not found" });
      }

      const stagingData = await dataStorage.getStagingData(requestId);
      const review = await dataStorage.getReview("upload", requestId);

      res.json({
        success: true,
        request,
        stagingData,
        review,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Presigned S3 URL for admin sample download (preferred)
app.get(
  "/api/admin/upload-requests/:requestId/sample-url",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      let filePath = null;
      let downloadName = "sample.zip";

      const stagingData = await dataStorage.getStagingData(requestId);
      if (stagingData?.samplePath) {
        filePath = stagingData.samplePath;
      } else {
        const request = await dataStorage.getUploadRequest(requestId);
        if (request?.datasetId) {
          filePath = await dataStorage.getDatasetFile(request.datasetId, true);
          const dataset = await dataStorage.getDataset(request.datasetId);
          if (dataset) {
            downloadName = buildDatasetDownloadName(dataset, { isSample: true });
          }
        }
      }

      if (!filePath) {
        return res
          .status(404)
          .json({ success: false, error: "Sample file not found" });
      }

      const payload = await buildDownloadUrlPayload(
        requestId,
        filePath,
        downloadName,
        true,
      );
      res.json(payload);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Download staging sample for a pending upload request (admin only)
app.get(
  "/api/admin/upload-requests/:requestId/sample",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const stagingData = await dataStorage.getStagingData(requestId);

      if (!stagingData || !stagingData.samplePath) {
        // Fallback: if already approved, try the dataset sample
        const request = await dataStorage.getUploadRequest(requestId);
        if (request?.datasetId) {
          const filePath = await dataStorage.getDatasetFile(
            request.datasetId,
            true,
          );
          if (filePath) {
            if (String(filePath).startsWith("s3://")) {
              const downloadUrl = await s3Storage.getSignedDownloadUrl(
                filePath,
                "sample.zip",
              );
              return res.redirect(downloadUrl);
            }
            return res.download(filePath, "sample.zip");
          }
        }
        return res
          .status(404)
          .json({ success: false, error: "Sample file not found" });
      }

      const filePath = stagingData.samplePath;
      if (String(filePath).startsWith("s3://")) {
        const downloadUrl = await s3Storage.getSignedDownloadUrl(
          filePath,
          "sample.zip",
        );
        return res.redirect(downloadUrl);
      }
      res.download(filePath, "sample.zip", (err) => {
        if (err && !res.headersSent) {
          res
            .status(500)
            .json({ success: false, error: "File download failed" });
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Approve upload request (admin)
app.post(
  "/api/admin/upload-requests/:requestId/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { adminNotes } = req.body;

      const result = await dataStorage.approveUploadRequest(
        requestId,
        adminNotes || "",
        req.auth?.email || "admin",
      );

      const datasetId = result.dataset?.datasetId || result.dataset?.dataset_id;
      let pipeline = null;
      if (datasetId) {
        try {
          const started = await triggerDatasetProcessingPipeline(datasetId);
          pipeline = {
            started: true,
            executionArn: started.executionArn,
            message: "Processing pipeline started on sample approval",
          };
        } catch (pipelineErr) {
          console.warn(
            "Pipeline start after sample approval failed:",
            pipelineErr.message,
          );
          pipeline = {
            started: false,
            error: pipelineErr.message,
          };
        }
      }

      // Get user profile to send email to
      const appBaseUrl = process.env.REACT_APP_URL || "http://localhost:3000";
      try {
        const uploaderProfile = await cognito.adminGetUserAttributes(
          result.request.userId,
        );
        const email = uploaderProfile.email || result.request.userId;
        // await emailService.sendUploadApprovedEmail(email, result.dataset.title, requestId, appBaseUrl);
      } catch (e) {
        console.warn("Failed to send upload approval email:", e.message);
      }

      res.json({
        success: true,
        message: pipeline?.started
          ? "Upload request approved; analysis pipeline started on sample data"
          : "Upload request approved",
        request: result.request,
        dataset: result.dataset,
        pipeline,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Reject upload request (admin)
app.post(
  "/api/admin/upload-requests/:requestId/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { reason, adminNotes } = req.body;

      if (!reason) {
        return res
          .status(400)
          .json({ success: false, error: "Rejection reason is required" });
      }

      const request = await dataStorage.rejectUploadRequest(
        requestId,
        reason,
        adminNotes || "",
        req.auth?.email || "admin",
      );

      try {
        const uploaderProfile = await cognito.adminGetUserAttributes(
          request.userId,
        );
        const email = uploaderProfile.email || request.userId;
        // await emailService.sendUploadRejectedEmail(email, request.metadata.title, reason, adminNotes);
      } catch (e) {}

      res.json({
        success: true,
        message: "Upload request rejected",
        request,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Clarify/Comment on upload request (admin)
app.post(
  "/api/admin/upload-requests/:requestId/comment",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { adminNotes } = req.body;
      if (!adminNotes)
        return res
          .status(400)
          .json({ success: false, error: "Notes required" });

      const request = await dataStorage.getUploadRequest(requestId);
      if (!request)
        return res.status(404).json({ success: false, error: "Not found" });

      await dataStorage.createReview("upload", requestId, {
        action: "comment",
        adminNotes,
      });
      request.status = "clarification_needed";
      request.adminNotes = adminNotes;
      // save a message in the thread
      await dataStorage.appendMessage(requestId, "upload", {
        sender: "admin",
        senderLabel: "Admin",
        text: adminNotes,
      });
      await dataStorage.saveUploadRequest(requestId, request);

      try {
        const uploaderProfile = await cognito.adminGetUserAttributes(
          request.userId,
        );
        const email = uploaderProfile.email || request.userId;
        const appBaseUrl = process.env.REACT_APP_URL || "http://localhost:3000";
        // await emailService.sendClarificationEmail(email, 'upload', request.metadata.title, adminNotes, requestId, appBaseUrl);
      } catch (e) {}

      res.json({ success: true, message: "Comment sent to user" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Request Chat / Messaging
// ─────────────────────────────────────────────────────────────────────────────
app.get(
  "/api/requests/:type/:requestId/messages",
  requireAuth,
  async (req, res) => {
    try {
      const { type, requestId } = req.params;
      if (!["upload", "download"].includes(type))
        return res
          .status(400)
          .json({ success: false, error: "Invalid config type" });

      // Enforce access control
      const request =
        type === "upload"
          ? await dataStorage.getUploadRequest(requestId)
          : await dataStorage.getDownloadRequest(requestId);

      if (!request)
        return res
          .status(404)
          .json({ success: false, error: "Request not found" });
      if (!req.auth.isAdmin && request.userId !== req.auth.userId) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }

      const messages = await dataStorage.getMessages(requestId, type);
      res.json({ success: true, messages });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/requests/:type/:requestId/messages",
  requireAuth,
  async (req, res) => {
    try {
      const { type, requestId } = req.params;
      const { text } = req.body;
      if (!["upload", "download"].includes(type))
        return res.status(400).json({ success: false, error: "Invalid type" });
      if (!text)
        return res
          .status(400)
          .json({ success: false, error: "Message text required" });

      const request =
        type === "upload"
          ? await dataStorage.getUploadRequest(requestId)
          : await dataStorage.getDownloadRequest(requestId);

      if (!request)
        return res
          .status(404)
          .json({ success: false, error: "Request not found" });
      if (!req.auth.isAdmin && request.userId !== req.auth.userId) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }

      // Determine if the user is acting as the Admin:
      // Either they explicitly request it (by passing actingAs='admin') from Admin context
      // Or they are an admin interacting with someone else's request.
      const isOwner = request.userId === req.auth.userId;
      const actingAsAdmin =
        req.auth.isAdmin && (req.body.actingAs === "admin" || !isOwner);

      // Sender details
      let senderName = actingAsAdmin ? "Admin" : "Requester";
      try {
        const p = await cognito.getUserProfile(req.auth.userId);
        if (p && p.name) senderName = actingAsAdmin ? "Admin" : p.name;
      } catch (e) {}

      const newMessage = await dataStorage.appendMessage(requestId, type, {
        sender: actingAsAdmin ? "admin" : req.auth.userId,
        senderLabel: senderName,
        text,
      });

      // Update status to indicate there is a new message based on role
      const queueType =
        type === "upload" ? "upload_requests" : "download_requests";

      const terminalStatuses = new Set(["approved", "rejected", "active"]);
      if (actingAsAdmin) {
        if (!terminalStatuses.has(request.status)) {
          request.status = "clarification_needed";
        }
        request.adminNotes = text; // track latest admin note
        await dataStorage.addToAdminQueue(queueType, requestId);
      } else {
        // If user replies, keep status for approved/rejected but notify admin
        if (
          !terminalStatuses.has(request.status) &&
          request.status === "clarification_needed"
        ) {
          request.status = "pending";
        }
        await dataStorage.addToAdminQueue(queueType, requestId);
      }

      if (type === "upload")
        await dataStorage.saveUploadRequest(requestId, request);
      else await dataStorage.saveDownloadRequest(requestId, request);

      res.json({ success: true, message: newMessage });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Get download requests (for admin)
app.get(
  "/api/admin/download-requests",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const queue = await dataStorage.getAdminQueue("download_requests");
      const requests = [];

      for (const requestId of queue) {
        const request = await dataStorage.getDownloadRequest(requestId);
        if (request) {
          const dataset = await dataStorage.getDataset(request.datasetId);
          const messages = await dataStorage.getMessages(requestId, "download");
          const lastMessage = messages.length
            ? messages[messages.length - 1]
            : null;
          requests.push({
            ...request,
            dataset: dataset
              ? {
                  title: dataset.title,
                  description: dataset.description,
                }
              : null,
            datasetTitle: dataset?.title || null,
            lastMessage,
          });
        }
      }

      res.json({ success: true, requests });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Admin: consolidated request history (approved/rejected/pending)
app.get(
  "/api/admin/requests/history",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const type = req.query.type || "all";
      const uploadRequests =
        type === "download" ? [] : await dataStorage.getAllRequests("upload");
      const downloadRequests =
        type === "upload" ? [] : await dataStorage.getAllRequests("download");
      res.json({ success: true, uploadRequests, downloadRequests });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Get download request details (for admin)
app.get(
  "/api/admin/download-requests/:requestId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const request = await dataStorage.getDownloadRequest(requestId);

      if (!request) {
        return res
          .status(404)
          .json({ success: false, error: "Request not found" });
      }

      const dataset = await dataStorage.getDataset(request.datasetId);
      const review = await dataStorage.getReview("download", requestId);

      res.json({
        success: true,
        request,
        dataset,
        review,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Approve download request (admin)
app.post(
  "/api/admin/download-requests/:requestId/approve",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { adminNotes } = req.body;

      const request = await dataStorage.approveDownloadRequest(
        requestId,
        adminNotes || "",
        req.auth?.email || "admin",
      );

      const appBaseUrl = process.env.REACT_APP_URL || "http://localhost:3000";
      try {
        const uploaderProfile = await cognito.adminGetUserAttributes(
          request.userId,
        );
        const email = uploaderProfile.email || request.userId;
        const dataset = await dataStorage.getDataset(request.datasetId);
        // await emailService.sendDownloadApprovedEmail(email, dataset?.title || 'Dataset', request.datasetId, appBaseUrl);
      } catch (e) {}

      res.json({
        success: true,
        message: "Download request approved",
        request,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// Reject download request (admin)
app.post(
  "/api/admin/download-requests/:requestId/reject",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { reason, adminNotes } = req.body;

      if (!reason) {
        return res
          .status(400)
          .json({ success: false, error: "Rejection reason is required" });
      }

      const request = await dataStorage.rejectDownloadRequest(
        requestId,
        reason,
        adminNotes || "",
        req.auth?.email || "admin",
      );

      try {
        const uploaderProfile = await cognito.adminGetUserAttributes(
          request.userId,
        );
        const email = uploaderProfile.email || request.userId;
        const dataset = await dataStorage.getDataset(request.datasetId);
        // await emailService.sendDownloadRejectedEmail(email, dataset?.title || 'Dataset', reason, adminNotes);
      } catch (e) {}

      res.json({
        success: true,
        message: "Download request rejected",
        request,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);
// Clarify/Comment on download request (admin)
app.post(
  "/api/admin/download-requests/:requestId/comment",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { adminNotes } = req.body;
      if (!adminNotes)
        return res
          .status(400)
          .json({ success: false, error: "Notes required" });

      const request = await dataStorage.getDownloadRequest(requestId);
      if (!request)
        return res.status(404).json({ success: false, error: "Not found" });

      await dataStorage.createReview("download", requestId, {
        action: "comment",
        adminNotes,
      });
      request.status = "clarification_needed";
      request.adminNotes = adminNotes;
      await dataStorage.appendMessage(requestId, "download", {
        sender: "admin",
        senderLabel: "Admin",
        text: adminNotes,
      });
      await dataStorage.saveDownloadRequest(requestId, request);

      try {
        const uploaderProfile = await cognito.adminGetUserAttributes(
          request.userId,
        );
        const email = uploaderProfile.email || request.userId;
        const dataset = await dataStorage.getDataset(request.datasetId);
        const appBaseUrl = process.env.REACT_APP_URL || "http://localhost:3000";
        // await emailService.sendClarificationEmail(email, 'download', dataset?.title || 'Dataset', adminNotes, requestId, appBaseUrl);
      } catch (e) {}

      res.json({ success: true, message: "Comment sent to user" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// User Dashboard
app.get("/api/users/me/dashboard", requireAuth, async (req, res) => {
  try {
    const data = await dataStorage.getUserDashboardData(req.auth.userId);
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Notifications summary (auto-refresh polling)
app.get("/api/notifications", requireAuth, async (req, res) => {
  try {
    if (req.auth.isAdmin) {
      const [uploadQueue, downloadQueue] = await Promise.all([
        dataStorage.getAdminQueue("upload_requests"),
        dataStorage.getAdminQueue("download_requests"),
      ]);

      const uploadRequests = [];
      for (const requestId of uploadQueue) {
        const request = await dataStorage.getUploadRequest(requestId);
        if (request) {
          const messages = await dataStorage.getMessages(requestId, "upload");
          uploadRequests.push({
            ...request,
            lastMessage: messages[messages.length - 1] || null,
          });
        }
      }

      const downloadRequests = [];
      for (const requestId of downloadQueue) {
        const request = await dataStorage.getDownloadRequest(requestId);
        if (request) {
          const messages = await dataStorage.getMessages(requestId, "download");
          downloadRequests.push({
            ...request,
            lastMessage: messages[messages.length - 1] || null,
          });
        }
      }

      const messageCount = [...uploadRequests, ...downloadRequests].filter(
        (req) => {
          const last = req.lastMessage;
          return last && last.sender !== "admin";
        },
      ).length;
      const requestCount =
        uploadRequests.filter((req) =>
          ["pending", "clarification_needed"].includes(req.status),
        ).length +
        downloadRequests.filter((req) =>
          ["pending", "clarification_needed"].includes(req.status),
        ).length;

      return res.json({
        success: true,
        messages: messageCount,
        requests: requestCount,
      });
    }

    const data = await dataStorage.getUserDashboardData(req.auth.userId);
    const uploadRequests = data.upload_requests || [];
    const downloadRequests = data.download_requests || [];
    const messageCount = [...uploadRequests, ...downloadRequests].filter(
      (req) => {
        const last = req.last_message || req.lastMessage;
        return last && last.sender === "admin";
      },
    ).length;
    const requestCount =
      uploadRequests.filter((req) => req.status === "approved").length +
      downloadRequests.filter((req) => req.status === "approved").length;

    return res.json({
      success: true,
      messages: messageCount,
      requests: requestCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
// Must be defined AFTER all routes (4-arg signature = error middleware in Express).
// CORS headers are already set by the cors() middleware before this runs,
// so the browser will NOT see a spurious CORS error even on 4xx/5xx responses.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // multer file-size limit exceeded
  if (err.code === "LIMIT_FILE_SIZE") {
    const limitLabel = formatUploadLimit(req.uploadLimitBytes);
    return res.status(413).json({
      success: false,
      error: `File too large. Maximum allowed size is ${limitLabel}.`,
    });
  }
  // multer unexpected field
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res
      .status(400)
      .json({ success: false, error: "Unexpected file field in upload." });
  }
  // Generic fallback
  console.error("Unhandled Express error:", err);
  return res
    .status(500)
    .json({ success: false, error: err.message || "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  clearTempUploadsOnStartup();
  console.log(`Server running on port ${PORT}`);
  console.log(`Storage structure initialized at: ${dataStorage.DATA_ROOT}`);
});
