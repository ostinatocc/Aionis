import { z } from "zod";
import {
  AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV,
  AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV,
  AUTHORITY_RECEIPT_HMAC_SECRET_ENV,
  resolveAuthorityReceiptKeyring,
} from "./util/authority-receipt-keys.js";
import { parseTrustedProxyCidrs } from "./util/ip-guard.js";
import { applyRuntimeProfileDefaults } from "./config/runtime-profiles.js";

const RuntimeModeSchema = z.enum(["local", "service", "cloud"]);
const EditionSchema = z.enum(["lite", "server"]);
const InspectBeforeUseModeSchema = z.enum(["shadow", "active"]);
const RecallAnnProviderSchema = z.enum(["off", "local", "zvec"]);

const EnvSchema = z.object({
  AIONIS_MODE: RuntimeModeSchema.default("local"),
  AIONIS_EDITION: EditionSchema.default("lite"),
  AIONIS_RUNTIME_PACKAGE_NAME: z.string().default(""),
  AIONIS_RUNTIME_PACKAGE_VERSION: z.string().default(""),
  AIONIS_RUNTIME_STARTED_AT: z.string().default(""),
  AIONIS_INSPECT_BEFORE_USE_MODE: InspectBeforeUseModeSchema.default("shadow"),
  AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: z.string().default(""),
  AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: z.string().default(""),
  AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET: z.string().default(""),
  APP_ENV: z.enum(["dev", "ci", "prod"]).default("dev"),
  AIONIS_LISTEN_HOST: z.string().default(""),
  AIONIS_ALLOW_UNAUTHENTICATED_REMOTE: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  LITE_WRITE_SQLITE_PATH: z.string().default(".tmp/aionis-lite-write.sqlite"),
  LITE_LOCAL_ACTOR_ID: z.string().min(1).default("local-user"),
  PORT: z.coerce.number().int().positive().default(3001),
  MEMORY_SCOPE: z.string().min(1).default("default"),
  MEMORY_TENANT_ID: z.string().min(1).default("default"),
  MEMORY_AUTH_MODE: z.enum(["off", "api_key", "jwt", "api_key_or_jwt"]).default("off"),
  MEMORY_API_KEYS_JSON: z.string().default("{}"),
  MEMORY_JWT_HS256_SECRET: z.string().default(""),
  MEMORY_JWT_CLOCK_SKEW_SEC: z.coerce.number().int().min(0).default(30),
  MEMORY_JWT_REQUIRE_EXP: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  // Optional hard guard: reject /v1/memory/write when no nodes are provided.
  // This prevents commit-only writes from being mistaken as recallable memory writes.
  MEMORY_WRITE_REQUIRE_NODES: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  EXECUTION_TREE_DEFAULT_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  RUNTIME_VERIFIER_EXECUTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
  LITE_INLINE_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(12_000),
  ADMIN_TOKEN: z.string().optional(),
  RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  // Dev ergonomics by default: allow unlimited loopback traffic unless explicitly disabled.
  RATE_LIMIT_BYPASS_LOOPBACK: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  RECALL_RATE_LIMIT_RPS: z.coerce.number().positive().default(10),
  RECALL_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(20),
  WRITE_RATE_LIMIT_RPS: z.coerce.number().positive().default(5),
  WRITE_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(10),
  // Optional write-side smoothing: when a write is just over the limit, wait briefly then retry once.
  WRITE_RATE_LIMIT_MAX_WAIT_MS: z.coerce.number().int().min(0).max(5000).default(200),
  TENANT_QUOTA_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  TENANT_RECALL_RATE_LIMIT_RPS: z.coerce.number().positive().default(30),
  TENANT_RECALL_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(60),
  TENANT_WRITE_RATE_LIMIT_RPS: z.coerce.number().positive().default(10),
  TENANT_WRITE_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(20),
  TENANT_WRITE_RATE_LIMIT_MAX_WAIT_MS: z.coerce.number().int().min(0).max(5000).default(300),
  // API inflight gates: coarse server-side backpressure for read/write paths.
  API_RECALL_MAX_INFLIGHT: z.coerce.number().int().positive().max(5000).default(256),
  API_RECALL_QUEUE_MAX: z.coerce.number().int().min(0).max(200000).default(6000),
  API_RECALL_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(2_000),
  API_WRITE_MAX_INFLIGHT: z.coerce.number().int().positive().max(5000).default(96),
  API_WRITE_QUEUE_MAX: z.coerce.number().int().min(0).max(200000).default(3000),
  API_WRITE_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(2_000),
  // Optional local ANN sidecar. ANN only generates candidates; SQLite remains authoritative.
  RECALL_ANN_PROVIDER: RecallAnnProviderSchema.default("off"),
  RECALL_ZVEC_PATH: z.string().default(""),
  RECALL_ANN_REBUILD_ON_START: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  RECALL_ANN_MAX_CANDIDATES: z.coerce.number().int().positive().max(10000).default(200),
  // Optional durable Substrate sidecar candidate source. It only proposes candidates;
  // Runtime SQLite remains the fact source and admission policy still decides.
  RECALL_SUBSTRATE_SIDECAR_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  RECALL_SUBSTRATE_PATH: z.string().default(""),
  RECALL_SUBSTRATE_MAX_CANDIDATES: z.coerce.number().int().positive().max(10000).default(200),
  RECALL_SUBSTRATE_FAIL_OPEN: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  PII_REDACTION: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  ALLOW_CROSS_SCOPE_EDGES: z
    .string()
    .optional()
    .transform((v) => (v ?? "false").toLowerCase())
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true"),
  MAX_TEXT_LEN: z.coerce.number().int().positive().default(8000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(20),
});

export type Env = z.infer<typeof EnvSchema>;
function isLoopbackListenHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (normalized === "localhost") return true;
  if (normalized === "::1" || normalized === "[::1]") return true;
  return normalized === "127.0.0.1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isRemoteListenHost(host: string): boolean {
  return !isLoopbackListenHost(host);
}

function validateEditionPosture(env: Env): void {
  if (env.AIONIS_EDITION === "lite") {
    if (env.AIONIS_MODE !== "local") {
      throw new Error("Aionis Lite requires AIONIS_MODE=local");
    }
    if (env.MEMORY_AUTH_MODE !== "off") {
      throw new Error("Aionis Lite requires MEMORY_AUTH_MODE=off");
    }
    if (env.TENANT_QUOTA_ENABLED) {
      throw new Error("Aionis Lite requires TENANT_QUOTA_ENABLED=false");
    }
    return;
  }

  if (env.AIONIS_MODE !== "service") {
    throw new Error("Aionis Server requires AIONIS_MODE=service");
  }
  if (env.MEMORY_AUTH_MODE === "off" && !env.AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV) {
    throw new Error("Aionis Server requires MEMORY_AUTH_MODE=api_key, jwt, or api_key_or_jwt");
  }
}

function validateAuthorityReceiptKeyringPosture(env: Env): void {
  const keyring = resolveAuthorityReceiptKeyring(env);
  if (env.APP_ENV !== "prod") return;

  if (!keyring.configured || keyring.ephemeral) {
    throw new Error(
      `${AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV} and ${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} or ${AUTHORITY_RECEIPT_HMAC_SECRET_ENV} are required when APP_ENV=prod`,
    );
  }
  if (env.AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID.trim().length === 0) {
    throw new Error(`${AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV} is required when APP_ENV=prod`);
  }
  const activeKey = keyring.keys.get(keyring.activeKeyId);
  if (!activeKey || activeKey.length < 32) {
    throw new Error(`${AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV} must reference a secret of at least 32 bytes when APP_ENV=prod`);
  }
  for (const [keyId, secret] of keyring.keys.entries()) {
    if (secret.length < 32) {
      throw new Error(`${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV}.${keyId} must be at least 32 bytes when APP_ENV=prod`);
    }
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(applyRuntimeProfileDefaults(source));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const trustedProxyCidrs = parseTrustedProxyCidrs(parsed.data.TRUSTED_PROXY_CIDRS);
  parsed.data.TRUSTED_PROXY_CIDRS = trustedProxyCidrs.join(",");
  validateEditionPosture(parsed.data);
  if (parsed.data.AIONIS_EDITION === "lite" && parsed.data.APP_ENV === "prod") {
    throw new Error("Lite runtime does not currently support APP_ENV=prod; use APP_ENV=dev/ci.");
  }
  resolveAuthorityReceiptKeyring(parsed.data);
  if (
    parsed.data.AIONIS_EDITION === "lite"
    && parsed.data.MEMORY_AUTH_MODE === "off"
    && isRemoteListenHost(parsed.data.AIONIS_LISTEN_HOST)
    && !parsed.data.AIONIS_ALLOW_UNAUTHENTICATED_REMOTE
  ) {
    throw new Error(
      "AIONIS_LISTEN_HOST exposes an unauthenticated Lite Runtime; keep AIONIS_LISTEN_HOST on loopback or set AIONIS_ALLOW_UNAUTHENTICATED_REMOTE=true intentionally.",
    );
  }
  if (parsed.data.EMBEDDING_DIM !== 1536) {
    throw new Error(`EMBEDDING_DIM must be 1536 for text-embedding-3-small; got ${parsed.data.EMBEDDING_DIM}`);
  }
  if ((parsed.data.MEMORY_AUTH_MODE === "jwt" || parsed.data.MEMORY_AUTH_MODE === "api_key_or_jwt") && !parsed.data.MEMORY_JWT_HS256_SECRET) {
    throw new Error("MEMORY_JWT_HS256_SECRET is required when MEMORY_AUTH_MODE includes jwt");
  }
  if (parsed.data.APP_ENV === "prod") {
    if (parsed.data.TRUST_PROXY && trustedProxyCidrs.length === 0) {
      throw new Error("TRUST_PROXY=true requires TRUSTED_PROXY_CIDRS in APP_ENV=prod");
    }
    if (parsed.data.MEMORY_AUTH_MODE === "off") {
      throw new Error("MEMORY_AUTH_MODE=off is not allowed when APP_ENV=prod");
    }
    if (parsed.data.RATE_LIMIT_BYPASS_LOOPBACK) {
      throw new Error("RATE_LIMIT_BYPASS_LOOPBACK=true is not allowed when APP_ENV=prod");
    }
    if (!parsed.data.RATE_LIMIT_ENABLED) {
      throw new Error("RATE_LIMIT_ENABLED=false is not allowed when APP_ENV=prod");
    }
    if (!parsed.data.TENANT_QUOTA_ENABLED) {
      throw new Error("TENANT_QUOTA_ENABLED=false is not allowed when APP_ENV=prod");
    }
    if (parsed.data.RUNTIME_VERIFIER_EXECUTION_ENABLED) {
      throw new Error("RUNTIME_VERIFIER_EXECUTION_ENABLED=true is not allowed when APP_ENV=prod");
    }
    if (parsed.data.MEMORY_AUTH_MODE === "api_key" || parsed.data.MEMORY_AUTH_MODE === "api_key_or_jwt") {
      let parsedKeys: unknown;
      try {
        parsedKeys = JSON.parse(parsed.data.MEMORY_API_KEYS_JSON);
      } catch {
        throw new Error("MEMORY_API_KEYS_JSON must be valid JSON when APP_ENV=prod and auth uses api keys");
      }
      const keys = parsedKeys && typeof parsedKeys === "object" && !Array.isArray(parsedKeys) ? Object.keys(parsedKeys as Record<string, unknown>) : [];
      if (keys.length === 0) {
        throw new Error("MEMORY_API_KEYS_JSON must contain at least one key when APP_ENV=prod and auth uses api keys");
      }
    }
    if (parsed.data.MEMORY_AUTH_MODE === "jwt" || parsed.data.MEMORY_AUTH_MODE === "api_key_or_jwt") {
      if (!parsed.data.MEMORY_JWT_REQUIRE_EXP) {
        throw new Error("MEMORY_JWT_REQUIRE_EXP=false is not allowed when APP_ENV=prod and auth uses jwt");
      }
      if (Buffer.byteLength(parsed.data.MEMORY_JWT_HS256_SECRET, "utf8") < 32) {
        throw new Error("MEMORY_JWT_HS256_SECRET must be at least 32 bytes when APP_ENV=prod and auth uses jwt");
      }
    }
    validateAuthorityReceiptKeyringPosture(parsed.data);
  }
  return parsed.data;
}
