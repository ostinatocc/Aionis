import { createHash } from "node:crypto";

import { canonicalContinuationClone, type Sha256 } from "../continuation/contract.js";
import {
  continuationRuntimeV1AbsolutePath,
  continuationRuntimeV1Integer,
  continuationRuntimeV1LogLevel,
  continuationRuntimeV1OptionalText,
  continuationRuntimeV1RequiredSha256,
  continuationRuntimeV1RequiredText,
  continuationRuntimeV1Sha256,
  strictContinuationRuntimeV1Environment,
  type ContinuationRuntimeV1LogLevel,
} from "./config-support.js";
import { withContinuationRuntimeV1StableFileBytes } from "./stable-file.js";

export type { ContinuationRuntimeV1LogLevel } from "./config-support.js";

/**
 * The HTTP daemon's complete configuration authority surface. Worker-only
 * fields are intentionally absent, so a daemon process cannot parse or retain
 * provider credentials or queue-control settings.
 */
export const CONTINUATION_RUNTIME_V1_DAEMON_ENV_FIELDS = Object.freeze([
  "AIONIS_DATA_PATH",
  "AIONIS_HOST_API_KEY_FILE",
  "AIONIS_HOST_PRINCIPAL_ID",
  "AIONIS_HTTP_BODY_LIMIT_BYTES",
  "AIONIS_HTTP_HOST",
  "AIONIS_HTTP_PORT",
  "AIONIS_LOG_LEVEL",
  "AIONIS_OPERATOR_API_KEY_FILE",
  "AIONIS_OPERATOR_PRINCIPAL_ID",
  "AIONIS_SHUTDOWN_TIMEOUT_MS",
  "AIONIS_TENANT_ID",
  "AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH",
  "AIONIS_TRUST_ROOT_SHA256",
] as const);

export type ContinuationRuntimeV1DaemonConfig = Readonly<{
  httpHost: string;
  httpPort: number;
  httpBodyLimitBytes: number;
  dataPath: string;
  tenantId: string;
  hostPrincipalId: string;
  hostApiKeySha256: Sha256;
  operatorPrincipalId: string;
  operatorApiKeySha256: Sha256;
  trustRootPublicKeyPath: string;
  trustRootSha256: Sha256;
  logLevel: ContinuationRuntimeV1LogLevel;
  shutdownTimeoutMs: number;
}>;

function fail(message: string): never {
  throw new Error(`continuation_runtime_v1_daemon_config_invalid:${message}`);
}

function privateTokenSha256(
  env: Readonly<Record<string, string | undefined>>,
  fileField: string,
): Sha256 {
  const filePath = continuationRuntimeV1AbsolutePath(env, fileField, fail);
  return withContinuationRuntimeV1StableFileBytes(filePath, [32, 512], "runtime", "private",
    (code) => fail(`${fileField}_${code}`), (bytes) => {
      if (bytes.some((byte) => byte < 0x21 || byte > 0x7e)) {
        fail(`${fileField}_must_be_visible_ASCII_without_whitespace`);
      }
      return createHash("sha256").update(bytes).digest("hex");
    });
}

export function loadContinuationRuntimeV1DaemonConfig(
  value: unknown,
): ContinuationRuntimeV1DaemonConfig {
  const env = strictContinuationRuntimeV1Environment(value,
    CONTINUATION_RUNTIME_V1_DAEMON_ENV_FIELDS, fail);
  const config = canonicalContinuationClone({
    httpHost: continuationRuntimeV1OptionalText(env, "AIONIS_HTTP_HOST",
      "127.0.0.1", 253, fail),
    httpPort: continuationRuntimeV1Integer(env, "AIONIS_HTTP_PORT",
      3000, 1, 65_535, fail),
    httpBodyLimitBytes: continuationRuntimeV1Integer(env,
      "AIONIS_HTTP_BODY_LIMIT_BYTES", 1_048_576, 16_384, 5_242_880, fail),
    dataPath: continuationRuntimeV1AbsolutePath(env, "AIONIS_DATA_PATH", fail),
    tenantId: continuationRuntimeV1RequiredText(env, "AIONIS_TENANT_ID", 256, fail),
    hostPrincipalId: continuationRuntimeV1RequiredText(env,
      "AIONIS_HOST_PRINCIPAL_ID", 256, fail),
    hostApiKeySha256: privateTokenSha256(env, "AIONIS_HOST_API_KEY_FILE"),
    operatorPrincipalId: continuationRuntimeV1RequiredText(env,
      "AIONIS_OPERATOR_PRINCIPAL_ID", 256, fail),
    operatorApiKeySha256: privateTokenSha256(env, "AIONIS_OPERATOR_API_KEY_FILE"),
    trustRootPublicKeyPath: continuationRuntimeV1AbsolutePath(env,
      "AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH", fail),
    trustRootSha256: continuationRuntimeV1RequiredSha256(env,
      "AIONIS_TRUST_ROOT_SHA256", fail),
    logLevel: continuationRuntimeV1LogLevel(env, fail),
    shutdownTimeoutMs: continuationRuntimeV1Integer(env,
      "AIONIS_SHUTDOWN_TIMEOUT_MS", 30_000, 1_000, 300_000, fail),
  });
  if (config.hostApiKeySha256 === config.operatorApiKeySha256) {
    fail("host_and_operator_API_keys_must_be_distinct");
  }
  return config;
}

export function publicContinuationRuntimeV1DaemonConfig(
  config: ContinuationRuntimeV1DaemonConfig,
) {
  return canonicalContinuationClone({
    httpHost: config.httpHost,
    httpPort: config.httpPort,
    httpBodyLimitBytes: config.httpBodyLimitBytes,
    dataPathConfigured: true as const,
    tenantIdSha256: continuationRuntimeV1Sha256(config.tenantId),
    hostPrincipalIdSha256: continuationRuntimeV1Sha256(config.hostPrincipalId),
    operatorPrincipalIdSha256: continuationRuntimeV1Sha256(config.operatorPrincipalId),
    trustRootPublicKeyPathConfigured: true as const,
    trustRootSha256: config.trustRootSha256,
    logLevel: config.logLevel,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });
}
export type PublicContinuationRuntimeV1DaemonConfig =
  ReturnType<typeof publicContinuationRuntimeV1DaemonConfig>;
