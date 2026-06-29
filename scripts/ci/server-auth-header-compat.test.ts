import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createAuthResolver } from "../../src/util/auth.ts";

const apiKeysJson = JSON.stringify({
  "dev-key": {
    tenant_id: "tenant-a",
    agent_id: "agent-a",
    team_id: "team-a",
    role: "developer",
  },
});

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64urlJson({ alg: "HS256", typ: "JWT" });
  const body = base64urlJson(payload);
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

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

test("jwt auth requires exp by default", () => {
  const secret = "jwt-secret-with-at-least-32-bytes";
  const resolver = createAuthResolver({
    mode: "jwt",
    apiKeysJson,
    jwtHs256Secret: secret,
  });

  const withoutExp = signJwt({ tenant_id: "tenant-a", sub: "agent-a" }, secret);
  assert.equal(resolver.resolve({ authorization: `Bearer ${withoutExp}` }), null);

  const withExp = signJwt({
    tenant_id: "tenant-a",
    sub: "agent-a",
    exp: Math.floor(Date.now() / 1000) + 300,
  }, secret);
  const principal = resolver.resolve({ authorization: `Bearer ${withExp}` });
  assert.equal(principal?.tenant_id, "tenant-a");
  assert.equal(principal?.source, "jwt");
});
