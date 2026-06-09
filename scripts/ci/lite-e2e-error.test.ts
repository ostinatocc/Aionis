import test from "node:test";
import assert from "node:assert/strict";
import { AionisClientError } from "../../src/sdk.ts";
import { formatE2eError } from "../e2e/e2e-error.ts";

test("runtime e2e error formatter exposes response body while redacting secrets", () => {
  const error = new AionisClientError(400, "/v1/measure", {
    error: "bad_request",
    message: "schema failed for sk-api-secret-value",
    authorization: "Bearer secret-token",
    nested: {
      apiKey: "sk-secret",
      detail: "workflow_signature is not allowed",
    },
  });

  const formatted = formatE2eError(error);
  assert.match(formatted, /"status": 400/);
  assert.match(formatted, /"path": "\/v1\/measure"/);
  assert.match(formatted, /workflow_signature is not allowed/);
  assert.doesNotMatch(formatted, /sk-api-secret-value/);
  assert.doesNotMatch(formatted, /secret-token/);
  assert.doesNotMatch(formatted, /sk-secret/);
  assert.match(formatted, /\[REDACTED\]/);
});
