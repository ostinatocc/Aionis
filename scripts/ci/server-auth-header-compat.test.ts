import test from "node:test";
import assert from "node:assert/strict";
import { createAuthResolver } from "../../src/util/auth.ts";

const apiKeysJson = JSON.stringify({
  "dev-key": {
    tenant_id: "tenant-a",
    agent_id: "agent-a",
    team_id: "team-a",
    role: "developer",
  },
});

test("api key auth accepts x-api-key", () => {
  const resolver = createAuthResolver({
    mode: "api_key",
    apiKeysJson,
  });

  const principal = resolver.resolve({ "x-api-key": "dev-key" });
  assert.equal(principal?.tenant_id, "tenant-a");
  assert.equal(principal?.agent_id, "agent-a");
  assert.equal(principal?.team_id, "team-a");
  assert.equal(principal?.role, "developer");
  assert.equal(principal?.source, "api_key");
});

test("api key auth accepts bearer token for SDK compatibility", () => {
  const resolver = createAuthResolver({
    mode: "api_key",
    apiKeysJson,
  });

  const principal = resolver.resolve({ authorization: "Bearer dev-key" });
  assert.equal(principal?.tenant_id, "tenant-a");
  assert.equal(principal?.source, "api_key");
});

test("api_key_or_jwt auth falls back to bearer api key when token is not a valid jwt", () => {
  const resolver = createAuthResolver({
    mode: "api_key_or_jwt",
    apiKeysJson,
    jwtHs256Secret: "jwt-secret",
  });

  const principal = resolver.resolve({ authorization: "Bearer dev-key" });
  assert.equal(principal?.tenant_id, "tenant-a");
  assert.equal(principal?.source, "api_key");
});

test("api key auth rejects unknown bearer token", () => {
  const resolver = createAuthResolver({
    mode: "api_key",
    apiKeysJson,
  });

  const principal = resolver.resolve({ authorization: "Bearer unknown-key" });
  assert.equal(principal, null);
});
