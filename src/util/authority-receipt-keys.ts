import { createHash, randomBytes } from "node:crypto";

export const AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV = "AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID";
export const AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV = "AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON";
export const AUTHORITY_RECEIPT_HMAC_SECRET_ENV = "AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET";

export type AuthorityReceiptResolvedKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
  configured: boolean;
  ephemeral: boolean;
  source: "ephemeral" | "legacy_secret" | "keyring";
};

let ephemeralKey: Buffer | null = null;

function getEphemeralKey(): Buffer {
  if (!ephemeralKey) ephemeralKey = randomBytes(32);
  return ephemeralKey;
}

function sha256Prefix(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function firstString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeKeyId(value: unknown, path: string): string {
  const keyId = firstString(value);
  if (!keyId) throw new Error(`${path} must be a non-empty string`);
  if (keyId.length > 120) throw new Error(`${path} must be at most 120 characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(keyId)) {
    throw new Error(`${path} must use only letters, numbers, dot, underscore, colon, or dash`);
  }
  return keyId;
}

function secretString(value: unknown, path: string): string {
  const secret = firstString(value);
  if (!secret) throw new Error(`${path} must be a non-empty string`);
  return secret;
}

function keyringEntrySecret(value: unknown, path: string): string {
  if (typeof value === "string") return secretString(value, path);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return secretString((value as Record<string, unknown>).secret, `${path}.secret`);
  }
  throw new Error(`${path} must be a string secret or an object with a secret field`);
}

export function parseAuthorityReceiptHmacKeysJson(raw: string): Map<string, Buffer> {
  const input = raw.trim();
  if (input.length === 0) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} must be valid JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} must be a JSON object`);
  }

  const keys = new Map<string, Buffer>();
  for (const [rawKeyId, rawSecret] of Object.entries(parsed as Record<string, unknown>)) {
    const keyId = normalizeKeyId(rawKeyId, `${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} key`);
    if (keys.has(keyId)) {
      throw new Error(`${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} contains duplicate key id after normalization`);
    }
    const secret = keyringEntrySecret(rawSecret, `${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV}.${keyId}`);
    keys.set(keyId, Buffer.from(secret, "utf8"));
  }
  return keys;
}

export function resolveAuthorityReceiptKeyring(
  env: Record<string, unknown> = process.env,
): AuthorityReceiptResolvedKeyring {
  const activeKeyIdInput = firstString(env[AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV]);
  const keyringKeys = parseAuthorityReceiptHmacKeysJson(String(env[AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV] ?? ""));
  const legacySecret = firstString(env[AUTHORITY_RECEIPT_HMAC_SECRET_ENV]);

  if (keyringKeys.size > 0) {
    const activeKeyId =
      activeKeyIdInput
      ?? (keyringKeys.size === 1 ? [...keyringKeys.keys()][0] : null);
    if (!activeKeyId) {
      throw new Error(`${AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV} is required when ${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} contains more than one key`);
    }
    const normalizedActiveKeyId = normalizeKeyId(activeKeyId, AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV);
    if (!keyringKeys.has(normalizedActiveKeyId)) {
      throw new Error(`${AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV} must reference a key in ${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV}`);
    }
    return {
      activeKeyId: normalizedActiveKeyId,
      keys: keyringKeys,
      configured: true,
      ephemeral: false,
      source: "keyring",
    };
  }

  if (legacySecret) {
    const activeKeyId = activeKeyIdInput
      ? normalizeKeyId(activeKeyIdInput, AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV)
      : `legacy:${sha256Prefix(legacySecret)}`;
    return {
      activeKeyId,
      keys: new Map([[activeKeyId, Buffer.from(legacySecret, "utf8")]]),
      configured: true,
      ephemeral: false,
      source: "legacy_secret",
    };
  }

  if (activeKeyIdInput) {
    throw new Error(`${AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID_ENV} requires ${AUTHORITY_RECEIPT_HMAC_KEYS_JSON_ENV} or ${AUTHORITY_RECEIPT_HMAC_SECRET_ENV}`);
  }

  const key = getEphemeralKey();
  const activeKeyId = `ephemeral:${sha256Prefix(key)}`;
  return {
    activeKeyId,
    keys: new Map([[activeKeyId, key]]),
    configured: false,
    ephemeral: true,
    source: "ephemeral",
  };
}

export function authorityReceiptKeyringPublicInfo(
  env: Record<string, unknown> = process.env,
): {
  active_key_id: string;
  key_count: number;
  configured: boolean;
  ephemeral: boolean;
  source: AuthorityReceiptResolvedKeyring["source"];
} {
  const keyring = resolveAuthorityReceiptKeyring(env);
  return {
    active_key_id: keyring.activeKeyId,
    key_count: keyring.keys.size,
    configured: keyring.configured,
    ephemeral: keyring.ephemeral,
    source: keyring.source,
  };
}
