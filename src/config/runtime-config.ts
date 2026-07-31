import type { Env } from "../config.js";
import { loadEnv } from "../config.js";
import {
  parseEmbeddingProviderConfig,
  type EmbeddingProviderConfig,
} from "../embeddings/index.js";
import {
  parseRuntimeEpisodeVerifierDefinitionsJson,
  type RuntimeEpisodeVerifierDefinitionInput,
} from "../execution/runtime-episode-verifier-registry.js";
import {
  resolveRuntimeProfile,
  type RuntimeProfileResolution,
} from "./runtime-profiles.js";

type StringKey<T> = Extract<keyof T, string>;
type KeysWithPrefix<T, Prefix extends string> = {
  [Key in StringKey<T>]: Key extends `${Prefix}${string}` ? Key : never;
}[StringKey<T>];

type RuntimeIdentityEnvKeys =
  | "AIONIS_MODE"
  | "AIONIS_EDITION"
  | "AIONIS_RUNTIME_PACKAGE_NAME"
  | "AIONIS_RUNTIME_PACKAGE_VERSION"
  | "AIONIS_RUNTIME_STARTED_AT"
  | "APP_ENV"
  | "AIONIS_LISTEN_HOST"
  | "AIONIS_ALLOW_UNAUTHENTICATED_REMOTE"
  | "AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV"
  | "TRUST_PROXY"
  | "TRUSTED_PROXY_CIDRS"
  | "PORT"
  | "MEMORY_SCOPE"
  | "MEMORY_TENANT_ID"
  | "LITE_LOCAL_ACTOR_ID";

type RuntimeStorageEnvKeys =
  | "LITE_WRITE_SQLITE_PATH"
  | "OUTBOX_POLL_INTERVAL_MS"
  | "OUTBOX_BATCH_SIZE";

type RuntimeGovernanceEnvKeys =
  | "AIONIS_INSPECT_BEFORE_USE_MODE"
  | "AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID"
  | "AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON"
  | "AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET"
  | "MEMORY_AUTH_MODE"
  | "MEMORY_API_KEYS_JSON"
  | "MEMORY_JWT_HS256_SECRET"
  | "MEMORY_JWT_CLOCK_SKEW_SEC"
  | "MEMORY_JWT_REQUIRE_EXP"
  | "TENANT_QUOTA_ENABLED"
  | "RUNTIME_VERIFIER_EXECUTION_ENABLED"
  | "ADMIN_TOKEN";

type RuntimeLimitEnvKeys =
  | KeysWithPrefix<Env, "RATE_LIMIT_">
  | KeysWithPrefix<Env, "RECALL_RATE_LIMIT_">
  | KeysWithPrefix<Env, "WRITE_RATE_LIMIT_">
  | KeysWithPrefix<Env, "TENANT_RECALL_">
  | KeysWithPrefix<Env, "TENANT_WRITE_">
  | KeysWithPrefix<Env, "API_RECALL_">
  | KeysWithPrefix<Env, "API_WRITE_">
  | "MAX_TEXT_LEN";

type RuntimeRecallLimitEnvKeys = KeysWithPrefix<Env, "RECALL_RATE_LIMIT_">;

type RuntimeRecallEnvKeys =
  Exclude<KeysWithPrefix<Env, "RECALL_">, RuntimeRecallLimitEnvKeys>;


export type RuntimeIdentityConfig = Readonly<Pick<Env, RuntimeIdentityEnvKeys>> & {
  readonly profile: RuntimeProfileResolution;
  readonly cors: Readonly<{
    memoryAllowOrigins: readonly string[];
    adminAllowOrigins: readonly string[];
  }>;
};
export type RuntimeStorageConfig = Readonly<Pick<Env, RuntimeStorageEnvKeys>>;
export type RuntimeRecallConfig = Readonly<Pick<Env, RuntimeRecallEnvKeys>>;
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
export type RuntimeGovernanceConfig = Readonly<Pick<Env, RuntimeGovernanceEnvKeys>>;
export type RuntimeLimitConfig = Readonly<Pick<Env, RuntimeLimitEnvKeys>>;
export type RuntimeExecutionConfig = Readonly<{
  episodeVerifierDefinitions:
    readonly DeepReadonly<RuntimeEpisodeVerifierDefinitionInput>[];
}>;
export type RuntimeProviderConfig = Readonly<{
  embedding: EmbeddingProviderConfig;
}>;

export type RuntimeConfig = {
  runtime: RuntimeIdentityConfig;
  storage: RuntimeStorageConfig;
  recall: RuntimeRecallConfig;
  governance: RuntimeGovernanceConfig;
  limits: RuntimeLimitConfig;
  execution: RuntimeExecutionConfig;
  providers: RuntimeProviderConfig;
};

function pickSection<T extends object>(
  env: Env,
  include: (key: StringKey<Env>) => boolean,
): T {
  return Object.freeze(Object.fromEntries(
    Object.entries(env).filter(([key]) => include(key as StringKey<Env>)),
  )) as T;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function hasPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function parseCsv(raw: string): readonly string[] {
  return Object.freeze(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

const RUNTIME_KEYS = new Set<RuntimeIdentityEnvKeys>([
  "AIONIS_MODE",
  "AIONIS_EDITION",
  "AIONIS_RUNTIME_PACKAGE_NAME",
  "AIONIS_RUNTIME_PACKAGE_VERSION",
  "AIONIS_RUNTIME_STARTED_AT",
  "APP_ENV",
  "AIONIS_LISTEN_HOST",
  "AIONIS_ALLOW_UNAUTHENTICATED_REMOTE",
  "AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV",
  "TRUST_PROXY",
  "TRUSTED_PROXY_CIDRS",
  "PORT",
  "MEMORY_SCOPE",
  "MEMORY_TENANT_ID",
  "LITE_LOCAL_ACTOR_ID",
]);

const STORAGE_KEYS = new Set<RuntimeStorageEnvKeys>([
  "LITE_WRITE_SQLITE_PATH",
  "OUTBOX_POLL_INTERVAL_MS",
  "OUTBOX_BATCH_SIZE",
]);

const GOVERNANCE_KEYS = new Set<RuntimeGovernanceEnvKeys>([
  "AIONIS_INSPECT_BEFORE_USE_MODE",
  "AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID",
  "AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON",
  "AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET",
  "MEMORY_AUTH_MODE",
  "MEMORY_API_KEYS_JSON",
  "MEMORY_JWT_HS256_SECRET",
  "MEMORY_JWT_CLOCK_SKEW_SEC",
  "MEMORY_JWT_REQUIRE_EXP",
  "TENANT_QUOTA_ENABLED",
  "RUNTIME_VERIFIER_EXECUTION_ENABLED",
  "ADMIN_TOKEN",
]);

export function createRuntimeConfig(
  env: Env,
  providerSource: Record<string, string | undefined> = {},
): RuntimeConfig {
  const profile = resolveRuntimeProfile(env);
  const runtime = Object.freeze({
    ...pickSection<Pick<Env, RuntimeIdentityEnvKeys>>(env, (key) => RUNTIME_KEYS.has(key as RuntimeIdentityEnvKeys)),
    profile,
    cors: Object.freeze({
      memoryAllowOrigins: parseCsv(providerSource.CORS_ALLOW_ORIGINS ?? (env.APP_ENV === "prod" ? "" : "*")),
      adminAllowOrigins: parseCsv(providerSource.CORS_ADMIN_ALLOW_ORIGINS ?? ""),
    }),
  });
  const governance = deepFreeze({
    ...pickSection<Pick<Env, RuntimeGovernanceEnvKeys>>(env, (key) =>
      GOVERNANCE_KEYS.has(key as RuntimeGovernanceEnvKeys)),
  });
  return Object.freeze({
    runtime,
    storage: pickSection<RuntimeStorageConfig>(env, (key) => STORAGE_KEYS.has(key as RuntimeStorageEnvKeys)),
    recall: pickSection<RuntimeRecallConfig>(env, (key) =>
      key.startsWith("RECALL_")
      && !hasPrefix(key, ["RECALL_RATE_LIMIT_"])),
    governance,
    limits: pickSection<RuntimeLimitConfig>(env, (key) =>
      key === "MAX_TEXT_LEN"
      || hasPrefix(key, [
        "RATE_LIMIT_",
        "RECALL_RATE_LIMIT_",
        "WRITE_RATE_LIMIT_",
        "TENANT_RECALL_",
        "TENANT_WRITE_",
        "API_RECALL_",
        "API_WRITE_",
      ])),
    execution: deepFreeze({
      episodeVerifierDefinitions:
        parseRuntimeEpisodeVerifierDefinitionsJson(
          providerSource.AIONIS_EPISODE_VERIFIERS_JSON ?? "[]",
        ),
    }),
    providers: Object.freeze({
      embedding: parseEmbeddingProviderConfig(providerSource),
    }),
  });
}

export function loadRuntimeConfig(
  source: NodeJS.ProcessEnv = process.env,
): { env: Env; config: RuntimeConfig } {
  const env = loadEnv(source);
  return {
    env,
    config: createRuntimeConfig(env, source),
  };
}
