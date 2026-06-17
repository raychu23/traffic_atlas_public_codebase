#!/usr/bin/env node
/**
 * End-to-end API flow test for Traffic Atlas.
 * Usage:
 *   node scripts/e2e-flow-test.mjs
 *   API_BASE=https://api.example.com/api \
 *   FLOW_TEST_EMAIL=user@example.com FLOW_TEST_PASSWORD=secret \
 *   FLOW_TEST_ADMIN_EMAIL=admin@example.com FLOW_TEST_ADMIN_PASSWORD=secret \
 *   node scripts/e2e-flow-test.mjs
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const API_BASE = (
  process.env.API_BASE ||
  process.env.REACT_APP_API_URL_TESTING ||
  "https://api.example.com"
)
  .replace(/\/+$/, "")
  .replace(/\/api$/, "") + "/api";

const USER_EMAIL = process.env.FLOW_TEST_EMAIL || process.env.FLOW_TEST_USER_EMAIL;
const USER_PASSWORD = process.env.FLOW_TEST_PASSWORD || process.env.FLOW_TEST_USER_PASSWORD;
const ADMIN_EMAIL = process.env.FLOW_TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.FLOW_TEST_ADMIN_PASSWORD;

const results = [];
let passed = 0;
let failed = 0;
let skipped = 0;

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  if (status === "PASS") passed++;
  else if (status === "FAIL") failed++;
  else skipped++;
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "○";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(method, path, { token, body, formData, expectStatus } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 300) };
  }
  if (expectStatus !== undefined && res.status !== expectStatus) {
    throw new Error(`expected HTTP ${expectStatus}, got ${res.status}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json, headers: res.headers };
}

async function login(email, password) {
  const { status, json } = await request("POST", "/users/login", {
    body: { email, password },
  });
  if (status !== 200 || !json?.success) {
    throw new Error(json?.error || `login failed HTTP ${status}`);
  }
  return json.accessToken || json.token || json.idToken;
}

async function testPublic() {
  const { status, json } = await request("GET", "/datasets");
  if (status === 200 && json?.success && Array.isArray(json.datasets)) {
    record("GET /datasets", "PASS", `${json.datasets.length} datasets`);
    return json.datasets;
  }
  record("GET /datasets", "FAIL", `HTTP ${status}`);
  return [];
}

async function testLegal() {
  const { status, json } = await request("GET", "/legal/upload-terms");
  if (status === 200 && json?.success) {
    record("GET /legal/upload-terms", "PASS");
  } else {
    record("GET /legal/upload-terms", "FAIL", `HTTP ${status}`);
  }
}

async function testDatasetDetail(datasets) {
  if (!datasets.length) {
    record("GET /datasets/:id", "SKIP", "no datasets");
    return null;
  }
  const id = datasets[0].dataset_id || datasets[0].id;
  const { status, json } = await request("GET", `/datasets/${id}`);
  if (status === 200 && json?.success && json.dataset) {
    record("GET /datasets/:id", "PASS", id);
    return { id, dataset: json.dataset };
  }
  record("GET /datasets/:id", "FAIL", `HTTP ${status}`);
  return null;
}

async function testEmbeddings(datasetId) {
  if (!datasetId) return;
  const videos = await request("GET", `/datasets/${datasetId}/embeddings/videos`);
  if (videos.status === 200 && videos.json?.success) {
    record("GET /embeddings/videos", "PASS", `${(videos.json.videos || []).length} videos`);
    const vid = videos.json.videos?.[0]?.video_id || videos.json.videos?.[0]?.videoId;
    if (vid) {
      const pca = await request(
        "GET",
        `/datasets/${datasetId}/embeddings/spherical-pca?video_id=${encodeURIComponent(vid)}`,
      );
      if (pca.status === 200 && pca.json?.success) {
        const pts = pca.json.points?.length ?? 0;
        const clusters = pca.json.nClusters ?? "?";
        record("GET /embeddings/spherical-pca", "PASS", `${pts} points, ${clusters} clusters`);
      } else {
        record("GET /embeddings/spherical-pca", "FAIL", pca.json?.error || `HTTP ${pca.status}`);
      }
    }
  } else {
    record("GET /embeddings/videos", "FAIL", videos.json?.error || `HTTP ${videos.status}`);
  }

  const tags = await request("GET", `/datasets/${datasetId}/analysis/filter-tags`);
  if (tags.status === 200 && tags.json?.success) {
    record("GET /analysis/filter-tags", "PASS");
  } else {
    record("GET /analysis/filter-tags", "FAIL", tags.json?.error || `HTTP ${tags.status}`);
  }
}

async function testAuthFlow(label, email, password) {
  if (!email || !password) {
    record(`${label} login`, "SKIP", "no credentials");
    return null;
  }
  try {
    const token = await login(email, password);
    record(`${label} login`, "PASS");

    const me = await request("GET", "/auth/me", { token });
    if (me.status === 200 && me.json?.success) {
      record(`${label} GET /auth/me`, "PASS", me.json.user?.email || "");
    } else {
      record(`${label} GET /auth/me`, "FAIL", `HTTP ${me.status}`);
    }

    const profile = await request("GET", "/users/me", { token });
    if (profile.status === 200 && profile.json?.success) {
      record(`${label} GET /users/me`, "PASS");
    } else {
      record(`${label} GET /users/me`, "FAIL", `HTTP ${profile.status}`);
    }

    const dash = await request("GET", "/users/me/dashboard", { token });
    if (dash.status === 200 && dash.json?.success) {
      const up = dash.json.upload_requests?.length ?? 0;
      const down = dash.json.download_requests?.length ?? 0;
      record(`${label} GET /users/me/dashboard`, "PASS", `${up} uploads, ${down} downloads`);
    } else {
      record(`${label} GET /users/me/dashboard`, "FAIL", `HTTP ${dash.status}`);
    }

    const notif = await request("GET", "/notifications", { token });
    if (notif.status === 200 && notif.json?.success) {
      record(`${label} GET /notifications`, "PASS");
    } else {
      record(`${label} GET /notifications`, "FAIL", `HTTP ${notif.status}`);
    }

    return token;
  } catch (e) {
    record(`${label} login`, "FAIL", e.message);
    return null;
  }
}

async function testSampleDownload(token, datasetId) {
  if (!token || !datasetId) {
    record("GET /sample-url", "SKIP", "no token or dataset");
    return;
  }
  const { status, json } = await request("GET", `/datasets/${datasetId}/sample-url`, { token });
  if (status === 200 && json?.success && json.downloadUrl) {
    const url = json.downloadUrl;
    const head = await fetch(url, { method: "HEAD" });
    const ct = head.headers.get("content-type") || "";
    const isHtml = ct.includes("text/html");
    const ok = head.ok && !isHtml;
    record(
      "GET /sample-url + S3 HEAD",
      ok ? "PASS" : "FAIL",
      ok ? `${head.status} ${ct}` : `bad response: ${head.status} ${ct}`,
    );
  } else if (status === 404) {
    record("GET /sample-url", "SKIP", json?.error || "no sample file");
  } else {
    record("GET /sample-url", "FAIL", json?.error || `HTTP ${status}`);
  }
}

async function testDownloadRequest(token, dataset) {
  if (!token || !dataset) {
    record("POST /download (restricted)", "SKIP", "no token or dataset");
    return null;
  }
  const access = dataset.access_preference || dataset.accessPreference;
  const restricted = access === "request" || access === "restricted";
  if (!restricted) {
    record("POST /download (restricted)", "SKIP", "dataset is open access");
    return null;
  }

  const body = {
    name: "E2E Test User",
    email: USER_EMAIL || "e2e@test.local",
    organization: "E2E Test Org",
    role: "researcher",
    purpose: "Automated flow test",
    consents: {
      termsAccepted: true,
      privacyAccepted: true,
      citationAccepted: true,
    },
  };

  const { status, json } = await request("POST", `/datasets/${dataset.dataset_id || dataset.id}/download`, {
    token,
    body,
  });

  if (status === 200 && json?.success) {
    if (json.requiresApproval) {
      record("POST /download (restricted)", "PASS", `requestId=${json.requestId || json.download_request_id || "ok"}`);
      return json.requestId || json.download_request_id;
    }
    record("POST /download (restricted)", "PASS", "immediate access granted");
    return null;
  }
  if (status === 409 || json?.error?.includes("already")) {
    record("POST /download (restricted)", "PASS", "existing request");
    return json.requestId || null;
  }
  record("POST /download (restricted)", "FAIL", json?.error || `HTTP ${status}`);
  return null;
}

async function testOpenDownload(token, dataset) {
  if (!token || !dataset) return;
  const access = dataset.access_preference || dataset.accessPreference;
  if (access !== "open") {
    record("POST /download (open)", "SKIP", "not open dataset");
    return;
  }
  const id = dataset.dataset_id || dataset.id;
  const body = {
    name: "E2E Test",
    email: USER_EMAIL || "e2e@test.local",
    organization: "Test",
    role: "researcher",
    purpose: "Test",
    consents: { termsAccepted: true, privacyAccepted: true, citationAccepted: true },
  };
  const { status, json } = await request("POST", `/datasets/${id}/download`, { token, body });
  if (status === 200 && json?.success) {
    record("POST /download (open)", "PASS", json.downloadUrl ? "presigned URL" : "ok");
    if (json.downloadUrl) {
      const head = await fetch(json.downloadUrl, { method: "HEAD" });
      const ct = head.headers.get("content-type") || "";
      record(
        "Open download S3 HEAD",
        head.ok && !ct.includes("text/html") ? "PASS" : "FAIL",
        `${head.status} ${ct}`,
      );
    }
  } else {
    record("POST /download (open)", "FAIL", json?.error || `HTTP ${status}`);
  }
}

async function testChat(token, requestId, type = "download") {
  if (!token || !requestId) {
    record(`Chat ${type}`, "SKIP", "no request");
    return;
  }
  const msg = `E2E test message ${Date.now()}`;
  const post = await request("POST", `/requests/${type}/${requestId}/messages`, {
    token,
    body: { message: msg },
  });
  if (post.status === 200 && post.json?.success) {
    record(`POST /requests/${type}/:id/messages`, "PASS");
  } else {
    record(`POST /requests/${type}/:id/messages`, "FAIL", post.json?.error || `HTTP ${post.status}`);
    return;
  }
  const get = await request("GET", `/requests/${type}/${requestId}/messages`, { token });
  if (get.status === 200 && get.json?.success && Array.isArray(get.json.messages)) {
    const found = get.json.messages.some((m) => m.message?.includes("E2E test message"));
    record(`GET /requests/${type}/:id/messages`, found ? "PASS" : "FAIL", `${get.json.messages.length} msgs`);
  } else {
    record(`GET /requests/${type}/:id/messages`, "FAIL", `HTTP ${get.status}`);
  }
}

async function testAdmin(adminToken) {
  if (!adminToken) {
    record("Admin endpoints", "SKIP", "no admin token");
    return;
  }
  const endpoints = [
    ["GET /admin/upload-requests", "/admin/upload-requests"],
    ["GET /admin/download-requests", "/admin/download-requests"],
    ["GET /admin/requests/history", "/admin/requests/history?type=all"],
    ["GET /admin/users", "/admin/users"],
  ];
  for (const [name, path] of endpoints) {
    const { status, json } = await request("GET", path, { token: adminToken });
    if (status === 200 && json?.success) {
      record(name, "PASS");
    } else if (status === 403) {
      record(name, "FAIL", "not admin");
    } else {
      record(name, "FAIL", json?.error || `HTTP ${status}`);
    }
  }
}

async function testUploadMultipartInit(token) {
  if (!token) {
    record("Sample multipart initiate", "SKIP", "no token");
    return;
  }
  const metadata = {
    title: `E2E Upload Test ${Date.now()}`,
    description: "Automated multipart init test — abort immediately",
    associatedOrganization: "E2E Org",
    project: "Flow Test",
    purposeOfCollection: "Testing",
    location: "Test City",
    collectionDate: "2026-05-18",
    captureMethod: "CCTV",
    keywords: "test",
    tags: "test",
    source: "e2e",
    citation: "N/A",
    privacyDeclaration: "Test only",
    accessPreference: "open",
    allowedUses: "research",
    preferredCitation: "N/A",
    consents: { termsAccepted: true, uploadTermsAccepted: true },
  };
  const { status, json } = await request("POST", "/datasets/upload-request/multipart/initiate", {
    token,
    body: { metadata, fileName: "sample_data.zip", fileSize: 1024, contentType: "application/zip" },
  });
  if (status === 200 && json?.success && json.uploadId) {
    record("POST upload multipart/initiate", "PASS", `uploadId=${json.uploadId?.slice(0, 12)}...`);
    if (json.requestId) {
      await request("POST", `/datasets/upload-request/${json.requestId}/multipart/abort`, {
        token,
        body: { uploadId: json.uploadId },
      });
      record("POST upload multipart/abort", "PASS");
    }
  } else {
    record("POST upload multipart/initiate", "FAIL", json?.error || `HTTP ${status}`);
  }
}

async function testUnauthenticated() {
  const { status } = await request("GET", "/auth/me", { expectStatus: 401 });
  record("GET /auth/me without token → 401", status === 401 ? "PASS" : "FAIL", `HTTP ${status}`);
}

async function main() {
  console.log(`\n=== Traffic Atlas E2E Flow Test ===`);
  console.log(`API: ${API_BASE}\n`);

  await testUnauthenticated();
  await testLegal();
  const datasets = await testPublic();
  const detail = await testDatasetDetail(datasets);
  const datasetId = detail?.id;
  const dataset = detail?.dataset;

  if (datasetId) await testEmbeddings(datasetId);

  const userToken = await testAuthFlow("User", USER_EMAIL, USER_PASSWORD);
  const adminToken = await testAuthFlow("Admin", ADMIN_EMAIL || USER_EMAIL, ADMIN_PASSWORD || USER_PASSWORD);

  if (userToken && datasetId) {
    await testSampleDownload(userToken, datasetId);
    await testOpenDownload(userToken, dataset);
    const restricted = datasets.find(
      (d) => (d.access_preference || d.accessPreference) === "request",
    );
    const dlReqId = await testDownloadRequest(
      userToken,
      restricted ? { ...restricted, dataset_id: restricted.dataset_id || restricted.id } : dataset,
    );
    await testChat(userToken, dlReqId, "download");
    await testUploadMultipartInit(userToken);
  }

  const effectiveAdmin = adminToken && adminToken !== userToken ? adminToken : null;
  await testAdmin(effectiveAdmin || (await (async () => {
    if (ADMIN_EMAIL && ADMIN_PASSWORD) return adminToken;
    if (userToken) {
      const me = await request("GET", "/auth/me", { token: userToken });
      if (me.json?.user?.isAdmin) return userToken;
    }
    return null;
  })()));

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed, ${skipped} skipped ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
