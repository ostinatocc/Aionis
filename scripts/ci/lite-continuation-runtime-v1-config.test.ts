import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  CONTINUATION_RUNTIME_V1_DAEMON_ENV_FIELDS,
  loadContinuationRuntimeV1DaemonConfig,
  publicContinuationRuntimeV1DaemonConfig,
} from "../../src/runtime-v1/config.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "aionis-v1-daemon-config-"));
let fixtureSequence = 0;
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function tokenFile(value: string | Buffer, mode = 0o600): string {
  const path = join(fixtureRoot, `token-${fixtureSequence++}`);
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
  return path;
}

function requiredEnv(
  hostToken = "a".repeat(32),
  operatorToken = "o".repeat(32),
): Record<string, string> {
  return {
    PATH: "/usr/bin",
    AIONIS_DATA_PATH: "/tmp/aionis-v1/runtime.sqlite",
    AIONIS_TENANT_ID: "tenant-a",
    AIONIS_HOST_PRINCIPAL_ID: "host-a",
    AIONIS_HOST_API_KEY_FILE: tokenFile(hostToken),
    AIONIS_OPERATOR_PRINCIPAL_ID: "operator-a",
    AIONIS_OPERATOR_API_KEY_FILE: tokenFile(operatorToken),
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-v1/trust-root.pem",
    AIONIS_TRUST_ROOT_SHA256: "0".repeat(64),
  };
}

test("daemon config has exactly thirteen governed environment fields and no worker state", () => {
  assert.equal(CONTINUATION_RUNTIME_V1_DAEMON_ENV_FIELDS.length, 13);
  assert.equal(new Set(CONTINUATION_RUNTIME_V1_DAEMON_ENV_FIELDS).size, 13);
  const config = loadContinuationRuntimeV1DaemonConfig(requiredEnv());
  assert.deepEqual({
    httpHost: config.httpHost,
    httpPort: config.httpPort,
    httpBodyLimitBytes: config.httpBodyLimitBytes,
    dataPath: config.dataPath,
    tenantId: config.tenantId,
    hostPrincipalId: config.hostPrincipalId,
    operatorPrincipalId: config.operatorPrincipalId,
    logLevel: config.logLevel,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  }, {
    httpHost: "127.0.0.1",
    httpPort: 3000,
    httpBodyLimitBytes: 1_048_576,
    dataPath: "/tmp/aionis-v1/runtime.sqlite",
    tenantId: "tenant-a",
    hostPrincipalId: "host-a",
    operatorPrincipalId: "operator-a",
    logLevel: "info",
    shutdownTimeoutMs: 30_000,
  });
  assert.equal(config.hostApiKeySha256.length, 64);
  assert.equal(config.operatorApiKeySha256.length, 64);
  assert.equal("jobs" in config, false);
  assert.equal("workerRole" in config, false);
  assert.equal("embedding" in config, false);
  assert.ok(Object.isFrozen(config));
});

test("daemon token authority is file-only, bounded, private, and single-link", () => {
  assert.doesNotThrow(() => loadContinuationRuntimeV1DaemonConfig(
    requiredEnv("h".repeat(32), "p".repeat(512)),
  ));
  const hostPath = tokenFile("h".repeat(32));
  const environment = {
    ...requiredEnv(),
    AIONIS_HOST_API_KEY_FILE: hostPath,
  };
  for (const mode of [0o000, 0o440, 0o644] as const) {
    chmodSync(hostPath, mode);
    assert.throws(() => loadContinuationRuntimeV1DaemonConfig(environment),
      /AIONIS_HOST_API_KEY_FILE_(?:file_posture_invalid|open_failed)/u);
  }
  chmodSync(hostPath, 0o400);
  assert.doesNotThrow(() => loadContinuationRuntimeV1DaemonConfig(environment));
  chmodSync(hostPath, 0o600);
  const hardlink = `${hostPath}-hardlink`;
  linkSync(hostPath, hardlink);
  assert.throws(() => loadContinuationRuntimeV1DaemonConfig(environment),
    /AIONIS_HOST_API_KEY_FILE_file_posture_invalid/u);
  rmSync(hardlink);
  const symlink = `${hostPath}-symlink`;
  symlinkSync(hostPath, symlink);
  assert.throws(() => loadContinuationRuntimeV1DaemonConfig({
    ...environment,
    AIONIS_HOST_API_KEY_FILE: symlink,
  }), /AIONIS_HOST_API_KEY_FILE_file_posture_invalid/u);
  assert.throws(() => loadContinuationRuntimeV1DaemonConfig({
    ...environment,
    AIONIS_HOST_API_KEY_FILE: undefined,
  }), /AIONIS_HOST_API_KEY_FILE_required/u);
});

test("daemon rejects non-canonical token bytes without retaining raw credentials", () => {
  const rejected = [
    Buffer.from("x".repeat(31)),
    Buffer.from("x".repeat(513)),
    Buffer.from(`${"x".repeat(32)}\n`),
    Buffer.from(`${"x".repeat(16)} ${"x".repeat(16)}`),
    Buffer.from(`${"x".repeat(16)}\t${"x".repeat(16)}`),
    Buffer.concat([Buffer.from("x".repeat(32)), Buffer.from([0])]),
    Buffer.concat([Buffer.from("x".repeat(32)), Buffer.from([0xc2, 0xa0])]),
    Buffer.concat([Buffer.from("x".repeat(32)), Buffer.from([0xff])]),
  ];
  for (const [index, bytes] of rejected.entries()) {
    const pathMarker = `path-marker-${index}`;
    const path = join(fixtureRoot, pathMarker);
    writeFileSync(path, bytes, { mode: 0o600 });
    const environment = { ...requiredEnv(), AIONIS_HOST_API_KEY_FILE: path };
    assert.throws(() => loadContinuationRuntimeV1DaemonConfig(environment), (error) => {
      const message = String(error);
      return message.includes("continuation_runtime_v1_daemon_config_invalid")
        && !message.includes(pathMarker) && !message.includes(bytes.toString("hex"));
    });
  }
});

test("daemon rejects every worker-only or legacy AIONIS control", () => {
  for (const field of [
    "AIONIS_WORKER_ROLE",
    "AIONIS_JOB_BATCH_SIZE",
    "AIONIS_JOB_LEASE_MS",
    "AIONIS_JOB_POLL_MS",
    "AIONIS_EMBEDDING_API_KEY",
    "AIONIS_EMBEDDING_API_KEY_FILE",
    "AIONIS_EMBEDDING_BASE_URL",
    "AIONIS_EMBEDDING_DIMENSIONS",
    "AIONIS_EMBEDDING_MODEL",
    "AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH",
    "AIONIS_EFFECT_SIGNER_SHA256",
    "AIONIS_HOST_API_KEY",
    "AIONIS_OPERATOR_API_KEY",
    "AIONIS_API_KEY",
    "AIONIS_PRINCIPAL_ID",
    "AIONIS_HOST",
    "AIONIS_PORT",
    "AIONIS_BODY_LIMIT_BYTES",
    "AIONIS_MODE",
    "AIONIS_EDITION",
    "AIONIS_POTR",
  ] as const) {
    assert.throws(
      () => loadContinuationRuntimeV1DaemonConfig({
        ...requiredEnv(),
        [field]: "forbidden",
      }),
      /unknown_AIONIS_fields/u,
      field,
    );
  }
  assert.doesNotThrow(() => loadContinuationRuntimeV1DaemonConfig({
    ...requiredEnv(),
    HOME: "/tmp",
    CI: "true",
  }));
});

test("daemon requires canonical secure identities, paths, integers, and text", () => {
  const cases: Array<readonly [string, string]> = [
    ["AIONIS_DATA_PATH", "relative.sqlite"],
    ["AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH", "/tmp/../root.pem"],
    ["AIONIS_TENANT_ID", " tenant-a"],
    ["AIONIS_TENANT_ID", "tenant\u0000a"],
    ["AIONIS_HOST_PRINCIPAL_ID", " host-a"],
    ["AIONIS_OPERATOR_PRINCIPAL_ID", " operator-a"],
    ["AIONIS_HTTP_PORT", "03000"],
    ["AIONIS_HTTP_PORT", "65536"],
    ["AIONIS_HTTP_BODY_LIMIT_BYTES", "8192"],
    ["AIONIS_LOG_LEVEL", "verbose"],
    ["AIONIS_TRUST_ROOT_SHA256", "A".repeat(64)],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => loadContinuationRuntimeV1DaemonConfig({
      ...requiredEnv(),
      [field]: value,
    }), /continuation_runtime_v1_daemon_config_invalid/u, field);
  }
  assert.throws(
    () => loadContinuationRuntimeV1DaemonConfig({
      ...requiredEnv(),
      AIONIS_HTTP_PORT: 3000,
    }),
    /AIONIS_HTTP_PORT_must_be_text/u,
  );
  const accessor = { ...requiredEnv() };
  Object.defineProperty(accessor, "AIONIS_HTTP_PORT", {
    enumerable: true,
    get: () => "3000",
  });
  assert.throws(
    () => loadContinuationRuntimeV1DaemonConfig(accessor),
    /enumerable_data_properties/u,
  );
  assert.throws(
    () => loadContinuationRuntimeV1DaemonConfig({
      ...requiredEnv("s".repeat(32), "s".repeat(32)),
    }),
    /host_and_operator_API_keys_must_be_distinct/u,
  );
});

test("daemon public config does not disclose credentials, paths, or raw identities", () => {
  const secret = "secret-value-that-must-never-leak";
  const config = loadContinuationRuntimeV1DaemonConfig({
    ...requiredEnv(
      `${secret}-host-key-0000000000000000`,
      `${secret}-operator-key-000000000000`,
    ),
    AIONIS_DATA_PATH: `/tmp/${secret}/runtime.sqlite`,
    AIONIS_TENANT_ID: `${secret}-tenant`,
    AIONIS_HOST_PRINCIPAL_ID: `${secret}-host`,
    AIONIS_OPERATOR_PRINCIPAL_ID: `${secret}-operator`,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: `/tmp/${secret}/root.pem`,
  });
  const publicConfig = publicContinuationRuntimeV1DaemonConfig(config);
  const serialized = JSON.stringify(publicConfig);
  assert.equal(serialized.includes(secret), false);
  assert.equal("hostApiKeySha256" in publicConfig, false);
  assert.equal("operatorApiKeySha256" in publicConfig, false);
  assert.deepEqual({
    httpHost: publicConfig.httpHost,
    httpPort: publicConfig.httpPort,
    httpBodyLimitBytes: publicConfig.httpBodyLimitBytes,
    dataPathConfigured: publicConfig.dataPathConfigured,
    trustRootPublicKeyPathConfigured: publicConfig.trustRootPublicKeyPathConfigured,
  }, {
    httpHost: "127.0.0.1",
    httpPort: 3000,
    httpBodyLimitBytes: 1_048_576,
    dataPathConfigured: true,
    trustRootPublicKeyPathConfigured: true,
  });
  assert.ok(Object.isFrozen(publicConfig));
});
