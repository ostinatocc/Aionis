import { createHmac, timingSafeEqual } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import {
  authorityReceiptKeyringPublicInfo,
  resolveAuthorityReceiptKeyring,
} from "../util/authority-receipt-keys.js";
import type { RuntimeAuthorityGateV1 } from "./authority-gate.js";
import {
  authorityClaimPaths,
  collectAuthorityClaims,
  type AuthorityWriteNode,
} from "./authority-claims.js";

const RECEIPT_VERSION = "runtime_authority_receipt_v1" as const;
const RECEIPT_ISSUER = "aionis_runtime_authority" as const;
const RECEIPT_ALG = "HS256" as const;

export type RuntimeAuthorityReceiptV1 = {
  receipt_version: typeof RECEIPT_VERSION;
  issuer: typeof RECEIPT_ISSUER;
  alg: typeof RECEIPT_ALG;
  key_id: string;
  subject: {
    scope: string;
    node_id: string;
    client_id: string | null;
    node_type: string;
  };
  claim_paths: string[];
  gate_sha256: string;
  issued_at: string;
  signature: string;
};

type RuntimeAuthorityReceiptPayload = Omit<RuntimeAuthorityReceiptV1, "signature">;

export type RuntimeAuthorityReceiptVerification =
  | { ok: true; receipt: RuntimeAuthorityReceiptV1 }
  | {
      ok: false;
      reason:
        | "missing_authority_receipt"
        | "invalid_authority_receipt"
        | "unknown_authority_receipt_key"
        | "authority_receipt_mismatch";
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function gateHash(authorityGate: RuntimeAuthorityGateV1): string {
  return sha256Hex(stableStringify(authorityGate));
}

function subjectForNode(node: AuthorityWriteNode): RuntimeAuthorityReceiptV1["subject"] | null {
  const scope = firstString(node.scope);
  const nodeId = firstString(node.id);
  const nodeType = firstString(node.type);
  if (!scope || !nodeId || !nodeType) return null;
  return {
    scope,
    node_id: nodeId,
    client_id: firstString(node.client_id),
    node_type: nodeType,
  };
}

function expectedPayload(args: {
  node: AuthorityWriteNode;
  slots: Record<string, unknown>;
  authorityGate: RuntimeAuthorityGateV1;
  keyId: string;
  issuedAt: string;
}): RuntimeAuthorityReceiptPayload | null {
  const subject = subjectForNode(args.node);
  if (!subject) return null;
  const claimPaths = authorityClaimPaths(collectAuthorityClaims(args.node, args.slots));
  if (claimPaths.length === 0) return null;
  return {
    receipt_version: RECEIPT_VERSION,
    issuer: RECEIPT_ISSUER,
    alg: RECEIPT_ALG,
    key_id: args.keyId,
    subject,
    claim_paths: claimPaths,
    gate_sha256: gateHash(args.authorityGate),
    issued_at: args.issuedAt,
  };
}

function signPayload(payload: RuntimeAuthorityReceiptPayload, key: Buffer): string {
  return createHmac("sha256", key)
    .update(stableStringify(payload))
    .digest("base64url");
}

function stringsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseRuntimeAuthorityReceipt(value: unknown): RuntimeAuthorityReceiptV1 | null {
  const record = asRecord(value);
  const subject = asRecord(record?.subject);
  if (!record || !subject) return null;
  if (record.receipt_version !== RECEIPT_VERSION) return null;
  if (record.issuer !== RECEIPT_ISSUER) return null;
  if (record.alg !== RECEIPT_ALG) return null;
  const keyId = firstString(record.key_id);
  const gateSha = firstString(record.gate_sha256);
  const issuedAt = firstString(record.issued_at);
  const signature = firstString(record.signature);
  const scope = firstString(subject.scope);
  const nodeId = firstString(subject.node_id);
  const nodeType = firstString(subject.node_type);
  if (!keyId || !gateSha || !issuedAt || !signature || !scope || !nodeId || !nodeType) return null;
  if (!Array.isArray(record.claim_paths)) return null;
  const rawClaimPaths = record.claim_paths;
  const claimPaths = rawClaimPaths.map((entry) => firstString(entry)).filter((entry): entry is string => !!entry);
  if (claimPaths.length !== rawClaimPaths.length) return null;
  return {
    receipt_version: RECEIPT_VERSION,
    issuer: RECEIPT_ISSUER,
    alg: RECEIPT_ALG,
    key_id: keyId,
    subject: {
      scope,
      node_id: nodeId,
      client_id: firstString(subject.client_id),
      node_type: nodeType,
    },
    claim_paths: claimPaths,
    gate_sha256: gateSha,
    issued_at: issuedAt,
    signature,
  };
}

export function issueRuntimeAuthorityReceiptForNode(args: {
  node: AuthorityWriteNode;
  slots: Record<string, unknown>;
  authorityGate: RuntimeAuthorityGateV1;
  issuedAt?: string;
}): RuntimeAuthorityReceiptV1 | null {
  const keyring = resolveAuthorityReceiptKeyring();
  const activeKey = keyring.keys.get(keyring.activeKeyId);
  if (!activeKey) return null;
  const payload = expectedPayload({
    node: args.node,
    slots: args.slots,
    authorityGate: args.authorityGate,
    keyId: keyring.activeKeyId,
    issuedAt: args.issuedAt ?? new Date().toISOString(),
  });
  if (!payload) return null;
  return {
    ...payload,
    signature: signPayload(payload, activeKey),
  };
}

export function verifyRuntimeAuthorityReceiptForNode(args: {
  node: AuthorityWriteNode;
  slots: Record<string, unknown>;
  authorityGate: RuntimeAuthorityGateV1;
}): RuntimeAuthorityReceiptVerification {
  const rawReceipt = args.slots.authority_receipt_v1;
  if (!rawReceipt) return { ok: false, reason: "missing_authority_receipt" };
  const receipt = parseRuntimeAuthorityReceipt(rawReceipt);
  if (!receipt) return { ok: false, reason: "invalid_authority_receipt" };
  const keyring = resolveAuthorityReceiptKeyring();
  const verificationKey = keyring.keys.get(receipt.key_id);
  if (!verificationKey) return { ok: false, reason: "unknown_authority_receipt_key" };
  const expected = expectedPayload({
    node: args.node,
    slots: args.slots,
    authorityGate: args.authorityGate,
    keyId: receipt.key_id,
    issuedAt: receipt.issued_at,
  });
  if (!expected) return { ok: false, reason: "authority_receipt_mismatch" };
  const suppliedPayload: RuntimeAuthorityReceiptPayload = {
    receipt_version: receipt.receipt_version,
    issuer: receipt.issuer,
    alg: receipt.alg,
    key_id: receipt.key_id,
    subject: receipt.subject,
    claim_paths: receipt.claim_paths,
    gate_sha256: receipt.gate_sha256,
    issued_at: receipt.issued_at,
  };
  if (stableStringify(suppliedPayload) !== stableStringify(expected)) {
    return { ok: false, reason: "authority_receipt_mismatch" };
  }
  const expectedSignature = signPayload(suppliedPayload, verificationKey);
  if (!stringsEqual(receipt.signature, expectedSignature)) {
    return { ok: false, reason: "authority_receipt_mismatch" };
  }
  return { ok: true, receipt };
}

export function runtimeAuthorityReceiptKeyringInfo(): ReturnType<typeof authorityReceiptKeyringPublicInfo> {
  return authorityReceiptKeyringPublicInfo();
}
