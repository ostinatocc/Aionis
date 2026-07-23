import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

import {
  CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_BATCH,
  CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_TEXT_BYTES,
  ContinuationRuntimeV1EmbeddingProviderError,
  createContinuationRuntimeV1EmbeddingProvider,
  loadContinuationRuntimeV1EmbeddingCredential,
  type ContinuationRuntimeV1EmbeddingBatchInput,
  type ContinuationRuntimeV1EmbeddingCredential,
} from "../../src/runtime-v1/embedding-provider.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1AuthorityClock,
} from "../../src/store/continuation-runtime-v1-database.js";

const MODEL = "embedding-model-v1";
const API_KEY = "provider-secret-key-00000001";
const DIMENSIONS = 3;
const liveAuthorityNow = () => new Date().toISOString();
let authoritySource = liveAuthorityNow;
const authorityRoot = mkdtempSync(join(tmpdir(), "aionis-embedding-provider-clock-"));
const apiKeyPath = join(authorityRoot, "embedding-api-key");
writeFileSync(apiKeyPath, API_KEY, { mode: 0o600 });
const credentials = new Set<ContinuationRuntimeV1EmbeddingCredential>();
const authorityDatabase = openContinuationRuntimeV1Database(
  join(authorityRoot, "authority", "runtime.sqlite"),
  {
    authorityNow: () => authoritySource(),
    databaseInstanceId: "e".repeat(64),
  },
);
const authorityClock = authorityDatabase.authorityNow;
after(async () => {
  await authorityDatabase.close();
  rmSync(authorityRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const credential of credentials) credential.destroy();
  credentials.clear();
});

type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

async function withHttpServer<T>(
  handler: HttpHandler,
  operation: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    return await operation(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    assert.ok(bytes <= 1_000_000);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

function providerConfig(baseUrl: string, keyPath = apiKeyPath) {
  return { baseUrl, model: MODEL, apiKeyFilePath: keyPath, dimensions: DIMENSIONS };
}

function credential(config = providerConfig("http://127.0.0.1:1/v1")) {
  const loaded = loadContinuationRuntimeV1EmbeddingCredential(config);
  credentials.add(loaded);
  return loaded;
}

function provider(baseUrl: string, authorityNow: () => string = liveAuthorityNow) {
  authoritySource = authorityNow;
  const config = providerConfig(baseUrl);
  return createContinuationRuntimeV1EmbeddingProvider(
    config,
    credential(config),
    authorityClock,
  );
}

function input(
  texts: readonly string[],
  signal: AbortSignal = new AbortController().signal,
  deadlineMs = 5_000,
): ContinuationRuntimeV1EmbeddingBatchInput {
  return {
    schema_version: "embedding_batch_input_v1",
    texts,
    lease_deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
    signal,
  };
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("operation unexpectedly succeeded");
}

function thrownError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("operation unexpectedly succeeded");
}

function assertProviderError(
  error: Error,
  code: ContinuationRuntimeV1EmbeddingProviderError["code"],
): void {
  assert.ok(error instanceof ContinuationRuntimeV1EmbeddingProviderError);
  assert.equal(error.code, code);
  assert.equal(error.message, `continuation_runtime_v1_embedding_provider_${code}`);
  assert.equal("cause" in error, false);
}

function successEnvelope(vectors: readonly (readonly number[])[]) {
  return {
    object: "list",
    model: MODEL,
    data: vectors.map((embedding, index) => ({
      object: "embedding",
      index,
      embedding,
    })),
    usage: { prompt_tokens: vectors.length, total_tokens: vectors.length },
  };
}

test("embedding provider performs one exact authenticated bounded batch and restores provider index order", async () => {
  const sourceA = "sensitive source input alpha";
  const sourceB = "sensitive source input beta";
  await withHttpServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/embeddings");
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    assert.match(request.headers["content-type"] ?? "", /^application\/json/u);
    const body = await requestJson(request);
    assert.deepEqual(body, {
      model: MODEL,
      input: [sourceA, sourceB],
      dimensions: DIMENSIONS,
      encoding_format: "float",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      model: MODEL,
      data: [
        { object: "embedding", index: 1, embedding: [4, 5, 6] },
        { object: "embedding", index: 0, embedding: [1, 2, 3] },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }));
  }, async (baseUrl) => {
    const result = await provider(baseUrl).embed(input([sourceA, sourceB]));
    assert.deepEqual(result, {
      schema_version: "embedding_batch_result_v1",
      model: MODEL,
      dimensions: DIMENSIONS,
      vectors: [[1, 2, 3], [4, 5, 6]],
    });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.vectors));
    assert.ok(result.vectors.every(Object.isFrozen));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(sourceA), false);
    assert.equal(serialized.includes(sourceB), false);
  });
});

test("embedding credential authority is file-only, private, stable, bounded, and zeroizable", () => {
  let sequence = 0;
  const writeSecret = (value: string | Buffer, mode = 0o600): string => {
    const path = join(authorityRoot, `credential-${sequence++}`);
    writeFileSync(path, value, { mode });
    chmodSync(path, mode);
    return path;
  };
  const load = (path: string): ContinuationRuntimeV1EmbeddingCredential => (
    loadContinuationRuntimeV1EmbeddingCredential(providerConfig(
      "http://127.0.0.1:1/v1",
      path,
    ))
  );

  for (const [value, mode] of ([
    ["x".repeat(16), 0o400], ["x".repeat(2_048), 0o600],
  ] as const)) {
    const loaded = load(writeSecret(value, mode));
    assert.equal(loaded.withAuthorizationHeader((header) => header),
      `Bearer ${value}`);
    loaded.destroy();
    loaded.destroy();
    assertProviderError(
      thrownError(() => loaded.withAuthorizationHeader(() => "unreachable")),
      "configuration_invalid",
    );
  }

  for (const invalid of [
    "x".repeat(15),
    "x".repeat(2_049),
    `${"x".repeat(16)}\n`,
    `${"x".repeat(8)} ${"x".repeat(8)}`,
    Buffer.concat([Buffer.from("x".repeat(16)), Buffer.from([0])]),
    Buffer.concat([Buffer.from("x".repeat(16)), Buffer.from([0xff])]),
  ]) {
    assertProviderError(thrownError(() => load(writeSecret(invalid))),
      "configuration_invalid");
  }
  for (const mode of [0o000, 0o440, 0o640, 0o644]) {
    assertProviderError(thrownError(() => load(writeSecret("x".repeat(32), mode))),
      "configuration_invalid");
  }

  const linked = writeSecret("x".repeat(32));
  const hardlink = `${linked}-hardlink`;
  linkSync(linked, hardlink);
  assertProviderError(thrownError(() => load(linked)), "configuration_invalid");
  rmSync(hardlink);
  const symlink = `${linked}-symlink`;
  symlinkSync(linked, symlink);
  assertProviderError(thrownError(() => load(symlink)), "configuration_invalid");
  const missing = join(authorityRoot, "credential-path-marker-missing");
  const missingError = thrownError(() => load(missing));
  assertProviderError(missingError, "configuration_invalid");
  assert.equal(`${missingError.stack ?? ""}`.includes(missing), false);
  assertProviderError(thrownError(() => load(authorityRoot)), "configuration_invalid");
});

test("embedding provider rejects non-exact and over-bound input before transport", async () => {
  const unused = provider("http://127.0.0.1:1/v1");
  for (const invalid of [
    input([]),
    input(Array.from(
      { length: CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_BATCH + 1 },
      () => "x",
    )),
    input(["x".repeat(CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_TEXT_BYTES + 1)]),
    { ...input(["x"]), unexpected: true },
  ]) {
    const error = await rejectedError(unused.embed(
      invalid as ContinuationRuntimeV1EmbeddingBatchInput,
    ));
    assertProviderError(error, "input_invalid");
  }
});

test("embedding provider converts adversarial reflection failures into stable redacted errors", async () => {
  const reflectionSecret = "proxy-trap-secret-must-not-escape";
  const hostileConfig = new Proxy(Object.create(null) as Record<string, unknown>, {
    ownKeys() { throw new Error(reflectionSecret); },
  });
  const configError = thrownError(() => createContinuationRuntimeV1EmbeddingProvider(
    hostileConfig as unknown as Parameters<
      typeof createContinuationRuntimeV1EmbeddingProvider
    >[0],
    credential(),
    authorityClock,
  ));
  assertProviderError(configError, "configuration_invalid");
  assert.equal(`${configError.stack ?? ""}`.includes(reflectionSecret), false);

  const hostileInput = new Proxy(Object.create(null) as Record<string, unknown>, {
    ownKeys() { throw new Error(reflectionSecret); },
  });
  const inputError = await rejectedError(provider("http://127.0.0.1:1/v1").embed(
    hostileInput as unknown as ContinuationRuntimeV1EmbeddingBatchInput,
  ));
  assertProviderError(inputError, "input_invalid");
  assert.equal(`${inputError.stack ?? ""}`.includes(reflectionSecret), false);
});

test("embedding provider requires one explicit canonical authority clock", () => {
  const config = providerConfig("http://127.0.0.1:1/v1");
  const providerCredential = credential(config);
  const withoutClock = createContinuationRuntimeV1EmbeddingProvider as unknown as
    (value: typeof config, valueCredential: typeof providerCredential) => unknown;
  assertProviderError(
    thrownError(() => withoutClock(config, providerCredential)),
    "configuration_invalid",
  );
  assertProviderError(
    thrownError(() => createContinuationRuntimeV1EmbeddingProvider(
      config,
      providerCredential,
      null as unknown as ContinuationRuntimeV1AuthorityClock,
    )),
    "configuration_invalid",
  );
  assertProviderError(
    thrownError(() => createContinuationRuntimeV1EmbeddingProvider(
      config,
      providerCredential,
      liveAuthorityNow as unknown as ContinuationRuntimeV1AuthorityClock,
    )),
    "configuration_invalid",
  );
});

test("embedding provider binds both caller abort and lease deadline to the live request", async () => {
  let sawRequest!: () => void;
  const requested = new Promise<void>((resolve) => { sawRequest = resolve; });
  await withHttpServer((request) => {
    request.resume();
    sawRequest();
  }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = provider(baseUrl).embed(input(["abort-me"], controller.signal));
    await requested;
    controller.abort();
    assertProviderError(await rejectedError(pending), "request_aborted");
  });

  await withHttpServer((request) => {
    request.resume();
  }, async (baseUrl) => {
    const error = await rejectedError(provider(baseUrl).embed(input(["deadline"], undefined, 100)));
    assertProviderError(error, "lease_deadline_exceeded");
  });

  const expired = input(["already-expired"]);
  const error = await rejectedError(provider("http://127.0.0.1:1/v1").embed({
    ...expired,
    lease_deadline_at: new Date(Date.now() - 1_000).toISOString(),
  }));
  assertProviderError(error, "lease_deadline_exceeded");

  const clock = { value: "2000-01-01T00:00:00.000Z" };
  const deadline = "2000-01-01T00:00:05.000Z";
  await withHttpServer((request, response) => {
    request.resume();
    clock.value = deadline;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(successEnvelope([[1, 2, 3]])));
  }, async (baseUrl) => {
    const shifted = provider(baseUrl, () => clock.value).embed({
      schema_version: "embedding_batch_input_v1",
      texts: ["deadline-after-response"],
      lease_deadline_at: deadline,
      signal: new AbortController().signal,
    });
    assertProviderError(
      await rejectedError(shifted),
      "lease_deadline_exceeded",
    );
  });
});

test("embedding provider redacts provider body, source input, and key from non-2xx errors", async () => {
  const providerBodySecret = "raw-provider-failure-do-not-disclose";
  const sourceSecret = "source-input-do-not-disclose";
  await withHttpServer((request, response) => {
    request.resume();
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: providerBodySecret }));
  }, async (baseUrl) => {
    const error = await rejectedError(provider(baseUrl).embed(input([sourceSecret])));
    assertProviderError(error, "provider_http_failure");
    const publicError = `${String(error)}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
    for (const secret of [providerBodySecret, sourceSecret, API_KEY]) {
      assert.equal(publicError.includes(secret), false);
    }
  });
});

test("embedding provider caps a chunked 2xx response before JSON parsing", async () => {
  await withHttpServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    for (let index = 0; index < 80; index += 1) response.write("x".repeat(1_024));
    response.end();
  }, async (baseUrl) => {
    const error = await rejectedError(provider(baseUrl).embed(input(["bounded-response"])));
    assertProviderError(error, "provider_response_too_large");
  });
});

test("embedding provider strictly rejects malformed, wrong-model, wrong-dimension, and non-finite-compatible vectors", async () => {
  let responseBody = "";
  await withHttpServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(responseBody);
  }, async (baseUrl) => {
    const service = provider(baseUrl);
    const cases: ReadonlyArray<readonly [string, ContinuationRuntimeV1EmbeddingProviderError["code"]]> = [
      ["{", "provider_response_malformed"],
      [JSON.stringify({ ...successEnvelope([[1, 2, 3]]), extra: true }), "provider_response_malformed"],
      [JSON.stringify({ ...successEnvelope([[1, 2, 3]]), model: "wrong-model" }), "provider_response_model_mismatch"],
      [JSON.stringify(successEnvelope([[1, 2]])), "provider_response_dimensions_mismatch"],
      [JSON.stringify(successEnvelope([[1, null as unknown as number, 3]])), "provider_response_vector_invalid"],
    ];
    for (const [body, code] of cases) {
      responseBody = body;
      const error = await rejectedError(service.embed(input(["strict-response"])));
      assertProviderError(error, code);
    }
  });
});
