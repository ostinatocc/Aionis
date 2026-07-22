import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateContinuationRuntimeV1,
  ContinuationRuntimeV1AuthenticationError,
} from "../../src/runtime-v1/auth.js";
import { loadContinuationRuntimeV1DaemonConfig } from
  "../../src/runtime-v1/config.js";

const TOKEN = "runtime-secret-token-abcdefghijklmnopqrstuvwxyz";
const OPERATOR_TOKEN = "operator-secret-token-abcdefghijklmnopqrstuvwxyz";

function config() {
  return loadContinuationRuntimeV1DaemonConfig({
    AIONIS_DATA_PATH: "/tmp/aionis-v1/runtime.sqlite",
    AIONIS_TENANT_ID: "tenant-a",
    AIONIS_HOST_PRINCIPAL_ID: "host-a",
    AIONIS_HOST_API_KEY: TOKEN,
    AIONIS_OPERATOR_PRINCIPAL_ID: "operator-a",
    AIONIS_OPERATOR_API_KEY: OPERATOR_TOKEN,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-v1/trust-root.pem",
    AIONIS_TRUST_ROOT_SHA256: "0".repeat(64),
  });
}

test("bearer authentication returns only a detached immutable principal", () => {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const principal = authenticateContinuationRuntimeV1(headers, config(), "trusted_host");
  headers.authorization = `Bearer ${"x".repeat(40)}`;
  assert.deepEqual(principal, {
    tenant_id: "tenant-a",
    principal_sha256: principal.principal_sha256,
    principal_kind: "trusted_host",
    authentication: "bearer_sha256_v1",
  });
  assert.match(principal.principal_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(principal).includes(TOKEN), false);
  assert.ok(Object.isFrozen(principal));
});

test("absent, malformed, duplicate, array, and incorrect credentials fail identically", () => {
  const attempts: unknown[] = [
    {},
    { authorization: `Basic ${TOKEN}` },
    { authorization: "Bearer short" },
    { authorization: [`Bearer ${TOKEN}`] },
    { authorization: `Bearer ${"x".repeat(TOKEN.length)}` },
    { authorization: `Bearer ${TOKEN}`, Authorization: `Bearer ${TOKEN}` },
    { authorization: `Bearer ${TOKEN}\n` },
  ];
  for (const headers of attempts) {
    assert.throws(
      () => authenticateContinuationRuntimeV1(headers, config(), "trusted_host"),
      (error) => error instanceof ContinuationRuntimeV1AuthenticationError
        && error.message === "unauthorized"
        && error.statusCode === 401,
    );
  }
});

test("credential-bearing config fields reject whitespace before authentication", () => {
  for (const value of [
    "runtime secret token with spaces 0000000000",
    `runtime-secret-token\t${"x".repeat(20)}`,
  ]) {
    assert.throws(() => loadContinuationRuntimeV1DaemonConfig({
      AIONIS_DATA_PATH: "/tmp/aionis-v1/runtime.sqlite",
      AIONIS_TENANT_ID: "tenant-a",
      AIONIS_HOST_PRINCIPAL_ID: "host-a",
      AIONIS_HOST_API_KEY: value,
      AIONIS_OPERATOR_PRINCIPAL_ID: "operator-a",
      AIONIS_OPERATOR_API_KEY: OPERATOR_TOKEN,
      AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-v1/trust-root.pem",
      AIONIS_TRUST_ROOT_SHA256: "0".repeat(64),
    }), /must_not_contain_whitespace|bounded_canonical_text/u);
  }
});

test("credential rotation preserves the stable authenticated principal", () => {
  const first = config();
  const rotatedToken = "rotated-runtime-token-abcdefghijklmnopqrstuvwxyz";
  const rotated = loadContinuationRuntimeV1DaemonConfig({
    AIONIS_DATA_PATH: "/tmp/aionis-v1/runtime.sqlite",
    AIONIS_TENANT_ID: "tenant-a",
    AIONIS_HOST_PRINCIPAL_ID: "host-a",
    AIONIS_HOST_API_KEY: rotatedToken,
    AIONIS_OPERATOR_PRINCIPAL_ID: "operator-a",
    AIONIS_OPERATOR_API_KEY: OPERATOR_TOKEN,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-v1/trust-root.pem",
    AIONIS_TRUST_ROOT_SHA256: "0".repeat(64),
  });
  const before = authenticateContinuationRuntimeV1(
    { authorization: `Bearer ${TOKEN}` },
    first,
    "trusted_host",
  );
  const after = authenticateContinuationRuntimeV1(
    { authorization: `Bearer ${rotatedToken}` },
    rotated,
    "trusted_host",
  );
  assert.equal(before.principal_sha256, after.principal_sha256);
  assert.notEqual(first.hostApiKeySha256, rotated.hostApiKeySha256);
});

test("trusted-host and operator credentials are role-separated stable principals", () => {
  const value = config();
  const trustedHost = authenticateContinuationRuntimeV1(
    { authorization: `Bearer ${TOKEN}` },
    value,
    "trusted_host",
  );
  const operator = authenticateContinuationRuntimeV1(
    { authorization: `Bearer ${OPERATOR_TOKEN}` },
    value,
    "operator",
  );
  assert.equal(trustedHost.principal_kind, "trusted_host");
  assert.equal(operator.principal_kind, "operator");
  assert.equal(authenticateContinuationRuntimeV1(
    { authorization: `Bearer ${TOKEN}` },
    value,
    "trusted_host_or_operator",
  ).principal_kind, "trusted_host");
  assert.equal(authenticateContinuationRuntimeV1(
    { authorization: `Bearer ${OPERATOR_TOKEN}` },
    value,
    "trusted_host_or_operator",
  ).principal_kind, "operator");
  assert.notEqual(trustedHost.principal_sha256, operator.principal_sha256);
  assert.throws(
    () => authenticateContinuationRuntimeV1(
      { authorization: `Bearer ${TOKEN}` },
      value,
      "operator",
    ),
    ContinuationRuntimeV1AuthenticationError,
  );
  assert.throws(
    () => authenticateContinuationRuntimeV1(
      { authorization: `Bearer ${OPERATOR_TOKEN}` },
      value,
      "trusted_host",
    ),
    ContinuationRuntimeV1AuthenticationError,
  );
});
