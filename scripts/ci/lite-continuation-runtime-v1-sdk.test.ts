import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

import {
  AionisRuntimeV1ClientError,
  createAionisRuntimeV1Client,
} from "../../src/runtime-v1/sdk.js";

const KEY = "sdk-test-key-abcdefghijklmnopqrstuvwxyz";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ROOT = resolve(import.meta.dirname, "../..");

type Captured = Readonly<{
  method: string;
  url: string;
  authorization: string | undefined;
  requestId: string | undefined;
  contentType: string | undefined;
  body: string;
}>;

test("SDK is a distinct private package and the repository root is not publishable", () => {
  const root = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const sdk = JSON.parse(readFileSync(resolve(ROOT, "packages/sdk/package.json"), "utf8"));
  assert.equal(root.private, true);
  for (const field of ["exports", "files", "main", "types"] as const) {
    assert.equal(Object.hasOwn(root, field), false, field);
  }
  assert.equal(Object.hasOwn(root.scripts, "prepack"), false);
  assert.equal(Object.hasOwn(root, "workspaces"), false);

  assert.equal(sdk.name, "@aionis/continuation-sdk");
  assert.equal(sdk.version, "1.0.0-alpha.1");
  assert.equal(sdk.private, true);
  assert.deepEqual(Object.keys(sdk.exports), ["."]);
  assert.equal(Object.hasOwn(sdk, "os"), false);
  for (const field of [
    "dependencies", "optionalDependencies", "peerDependencies", "bin",
  ] as const) {
    assert.equal(Object.hasOwn(sdk, field), false, field);
  }
  assert.deepEqual(sdk.files, ["dist", "LICENSE", "NOTICE", "README.md"]);
});

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fixture(
  handler?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const captured: Captured[] = [];
  const server = createServer(async (request, response) => {
    captured.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      requestId: request.headers["x-request-id"] as string | undefined,
      contentType: request.headers["content-type"],
      body: await body(request),
    });
    if (handler) return handler(request, response);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("address missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = createAionisRuntimeV1Client({
    baseUrl,
    apiKey: KEY,
    timeoutMs: 1_000,
    requestBodyLimitBytes: 16_384,
    responseBodyLimitBytes: 1_024,
  });
  return {
    client,
    baseUrl,
    captured,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("SDK exposes exactly five methods and sends the exact governed surface", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(Object.keys(value.client).sort(), [
      "createContinuation",
      "decideAuthority",
      "readDecision",
      "recordObservations",
      "recordOutcome",
    ]);
    const options = { requestId: "sdk.request-1" };
    assert.deepEqual(await value.client.recordObservations({
      operationId: "obs-1",
      scope: "scope-a",
      body: { schema_version: "record_observations_body_v1" } as never,
      options,
    }), { ok: true });
    await value.client.createContinuation({
      operationId: "decision-1",
      scope: "scope-a",
      body: { schema_version: "create_continuation_body_v1" } as never,
    });
    await value.client.recordOutcome({
      operationId: "outcome-1",
      scope: "scope-a",
      body: { schema_version: "record_outcome_body_v1" } as never,
    });
    await value.client.decideAuthority({
      operationId: "authority-1",
      scope: "scope-a",
      taskFamily: "repair",
      body: { schema_version: "authority_decision_body_v1" } as never,
    });
    await value.client.readDecision({
      decisionId: "decision/1",
      scope: "scope-a",
      view: "counterfactual",
      excludeCapsule: {
        capsule_id: "cap-a",
        capsule_revision: 1,
        capsule_sha256: SHA_A,
      },
      substituteBranch: {
        branch_id: "branch-a",
        branch_revision: 2,
        manifest_sha256: SHA_B,
      },
    });

    assert.deepEqual(value.captured.map((request) => `${request.method} ${request.url}`), [
      "POST /v1/observations",
      "POST /v1/continuations",
      "POST /v1/outcomes",
      "POST /v1/authority-decisions",
      `GET /v1/decisions/decision%2F1?scope=scope-a&view=counterfactual&exclude_capsule_id=cap-a&exclude_capsule_revision=1&exclude_capsule_sha256=${SHA_A}&substitute_branch_id=branch-a&substitute_branch_revision=2&substitute_manifest_sha256=${SHA_B}`,
    ]);
    for (const request of value.captured) {
      assert.equal(request.authorization, `Bearer ${KEY}`);
    }
    assert.equal(value.captured[0]!.requestId, "sdk.request-1");
    assert.equal(value.captured[0]!.contentType, "application/json");
    assert.equal(value.captured[4]!.contentType, undefined);
    assert.equal(value.captured[0]!.body,
      '{"body":{"schema_version":"record_observations_body_v1"},"operation_id":"obs-1","scope":"scope-a"}');
    assert.equal(value.captured[3]!.body,
      '{"body":{"schema_version":"authority_decision_body_v1"},"operation_id":"authority-1","scope":"scope-a","task_family":"repair"}');
    assert.ok(Object.isFrozen(value.client));
  } finally {
    await value.close();
  }
});

test("runtime errors are typed and mutation failures are never retried", async () => {
  let calls = 0;
  const value = await fixture((_request, response) => {
    calls += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema_version: "continuation_runtime_http_error_v1",
      error: {
        code: "not_ready",
        operation_id: "obs-1",
        request_id: "request-1",
      },
    }));
  });
  try {
    await assert.rejects(value.client.recordObservations({
      operationId: "obs-1",
      scope: "scope-a",
      body: {} as never,
    }), (error: unknown) => {
      assert.ok(error instanceof AionisRuntimeV1ClientError);
      assert.equal(error.kind, "runtime");
      assert.equal(error.code, "not_ready");
      assert.equal(error.statusCode, 503);
      assert.equal(error.operationId, "obs-1");
      assert.equal(error.requestId, "request-1");
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    await value.close();
  }
});

test("timeout and caller abort stay typed while a response body is streaming", async () => {
  const value = await fixture(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
    await new Promise((resolve) => setTimeout(resolve, 250));
    response.end("true}");
  });
  try {
    const timeoutClient = createAionisRuntimeV1Client({
      baseUrl: value.baseUrl,
      apiKey: KEY,
      timeoutMs: 100,
      requestBodyLimitBytes: 16_384,
      responseBodyLimitBytes: 1_024,
    });
    await assert.rejects(timeoutClient.createContinuation({
      operationId: "decision-timeout",
      scope: "scope-a",
      body: {} as never,
    }), (error: unknown) => {
      assert.ok(error instanceof AionisRuntimeV1ClientError);
      assert.equal(error.kind, "timeout");
      return true;
    });

    const controller = new AbortController();
    const aborted = value.client.createContinuation({
      operationId: "decision-aborted",
      scope: "scope-a",
      body: {} as never,
      options: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(aborted, (error: unknown) => {
      assert.ok(error instanceof AionisRuntimeV1ClientError);
      assert.equal(error.kind, "aborted");
      return true;
    });
  } finally {
    await value.close();
  }
});

test("response stream failures are typed transport errors", async () => {
  const value = await fixture(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
    await new Promise((resolve) => setTimeout(resolve, 25));
    response.destroy(new Error("fixture_stream_failure"));
  });
  try {
    await assert.rejects(value.client.createContinuation({
      operationId: "decision-stream-failure",
      scope: "scope-a",
      body: {} as never,
    }), (error: unknown) => {
      assert.ok(error instanceof AionisRuntimeV1ClientError);
      assert.equal(error.kind, "transport");
      assert.equal(error.code, "request_failed");
      return true;
    });
  } finally {
    await value.close();
  }
});

test("protocol rejects malformed media, error envelopes, and oversized responses", async () => {
  for (const mode of ["media", "envelope", "large"] as const) {
    const value = await fixture((_request, response) => {
      if (mode === "media") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("{}");
      } else if (mode === "envelope") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end('{"error":{"code":"conflict"}}');
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ value: "x".repeat(2_000) }));
      }
    });
    try {
      await assert.rejects(value.client.recordOutcome({
        operationId: "outcome-1",
        scope: "scope-a",
        body: {} as never,
      }), (error: unknown) => {
        assert.ok(error instanceof AionisRuntimeV1ClientError);
        assert.equal(error.kind, "protocol");
        return true;
      });
    } finally {
      await value.close();
    }
  }
});

test("configuration, call shapes, body bounds, and counterfactual selectors are closed", async () => {
  assert.throws(() => createAionisRuntimeV1Client({
    baseUrl: "https://user@example.com/base",
    apiKey: KEY,
    timeoutMs: 1_000,
    requestBodyLimitBytes: 16_384,
    responseBodyLimitBytes: 1_024,
  }), /base_url_invalid/u);
  assert.throws(() => createAionisRuntimeV1Client({
    baseUrl: "http://runtime.example.test",
    apiKey: KEY,
    timeoutMs: 1_000,
    requestBodyLimitBytes: 16_384,
    responseBodyLimitBytes: 1_024,
  }), /base_url_invalid/u);
  assert.doesNotThrow(() => createAionisRuntimeV1Client({
    baseUrl: "https://runtime.example.test",
    apiKey: KEY,
    timeoutMs: 1_000,
    requestBodyLimitBytes: 16_384,
    responseBodyLimitBytes: 1_024,
  }));
  assert.doesNotThrow(() => createAionisRuntimeV1Client({
    baseUrl: "http://[::1]:3000",
    apiKey: KEY,
    timeoutMs: 1_000,
    requestBodyLimitBytes: 16_384,
    responseBodyLimitBytes: 1_024,
  }));
  const value = await fixture();
  try {
    await assert.rejects(value.client.recordObservations({
      operationId: "obs-1",
      scope: "scope-a",
      body: { value: "x".repeat(17_000) } as never,
    }), /request_body_too_large/u);
    await assert.rejects(value.client.readDecision({
      decisionId: "decision-1",
      scope: "scope-a",
      view: "full",
      excludeCapsule: {
        capsule_id: "cap-a",
        capsule_revision: 1,
        capsule_sha256: SHA_A,
      },
      substituteBranch: null,
    }), /counterfactual_selector_invalid/u);
    await assert.rejects(value.client.createContinuation({
      operationId: "decision-1",
      scope: "scope-a",
      body: {} as never,
      extra: true,
    } as never), /mutation_input_shape_invalid/u);
    assert.equal(value.captured.length, 0);
  } finally {
    await value.close();
  }
});
