const assert = require("node:assert/strict");
const test = require("node:test");

delete process.env.COGNITO_USER_POOL_ID;
delete process.env.COGNITO_CLIENT_ID;
const { hasValidCognitoClaims, requireAuth } = require("./auth");

function invokeRequireAuth(authorization) {
  const request = { headers: { authorization } };
  const response = {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  requireAuth(request, response, () => {
    nextCalled = true;
  });
  return { nextCalled, request, response };
}

test.afterEach(() => {
  delete process.env.DEV_AUTH_ENABLED;
});

test("rejects tokens when Cognito and explicit development auth are disabled", () => {
  const result = invokeRequireAuth("Bearer unsigned-token");

  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.response.body.error, "Authentication is not configured");
});

test("accepts the fixed local token only when development auth is enabled", () => {
  process.env.DEV_AUTH_ENABLED = "true";

  const result = invokeRequireAuth("Bearer dev-local-token");

  assert.equal(result.nextCalled, true);
  assert.equal(result.request.auth.userId, "dev-local-user");
  assert.equal(result.request.auth.isAdmin, false);
});

test("validates Cognito token use and application client", () => {
  assert.equal(
    hasValidCognitoClaims({ token_use: "access", client_id: "client-1" }, "client-1"),
    true,
  );
  assert.equal(hasValidCognitoClaims({ token_use: "id", aud: "client-1" }, "client-1"), true);
  assert.equal(
    hasValidCognitoClaims({ token_use: "access", client_id: "other-client" }, "client-1"),
    false,
  );
  assert.equal(hasValidCognitoClaims({ token_use: "refresh" }, "client-1"), false);
});
