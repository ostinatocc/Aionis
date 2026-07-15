import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import { sha256Hex } from "../util/crypto.js";
import {
  LEARNING_EXPERIMENT_AUTHORITY_SCOPE,
  LEARNING_EXPERIMENT_CLOSE_MAX_TTL_MS,
  LEARNING_EXPERIMENT_CLOSE_OPERATION_KIND,
  LearningExperimentCloseApprovalV1Schema,
  learningExperimentCloseApprovalDigest,
  type LearningExperimentCloseApprovalV1,
} from "./learning-authority-approval.js";
import { CanonicalLearningUtcTimestampSchema } from "./learning-episode-ledger.js";

export {
  LEARNING_EXPERIMENT_AUTHORITY_SCOPE,
  LEARNING_EXPERIMENT_CLOSE_MAX_TTL_MS,
  LEARNING_EXPERIMENT_CLOSE_OPERATION_KIND,
};

export const LEARNING_EXPERIMENT_CLOSE_APPROVAL_HMAC_DOMAIN =
  "aionis.learning-experiment-close-approval.hmac.v1" as const;
export const LEARNING_EXPERIMENT_CLOSE_RECEIPT_ATTESTATION_HMAC_DOMAIN =
  "aionis.learning-experiment-close-receipt-attestation.hmac.v1" as const;

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const CloseIdSchema = z.string().regex(/^lxc_[0-9a-f]{64}$/u);
const AuthorizationKeyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u);
const AuthorizationNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/u).superRefine(
  (value, context) => {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length < 16
      || decoded.length > 96
      || decoded.toString("base64url") !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Authorization nonce must canonically encode 16 to 96 bytes",
      });
    }
  },
);

function exactUtf8TextSchema(maxBytes: number, label: string) {
  return z.string().superRefine((value, context) => {
    if (value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maxBytes
      || Buffer.from(value, "utf8").toString("utf8") !== value
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be exact control-free UTF-8 text bounded to ${String(maxBytes)} bytes`,
      });
    }
  });
}

const ExactIdSchema = exactUtf8TextSchema(256, "Identifier");
const ExactKindSchema = exactUtf8TextSchema(120, "Kind");
const TenantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

const AuthorizationMacSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).superRefine(
  (value, context) => {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Close authorization MAC must be canonical base64url for exactly 32 bytes",
      });
    }
  },
);

export const LearningExperimentCloseAuthorizationEnvelopeV1Schema = z.object({
  contract_version: z.literal("learning_experiment_close_authorization_envelope_v1"),
  approval: LearningExperimentCloseApprovalV1Schema,
  authorization_mac: AuthorizationMacSchema,
}).strict();

export type LearningExperimentCloseAuthorizationEnvelopeV1 = z.infer<
  typeof LearningExperimentCloseAuthorizationEnvelopeV1Schema
>;

export type LearningExperimentCloseAuthorizationSplitV1 = Readonly<{
  approval: LearningExperimentCloseApprovalV1;
  authorization_payload_json: string;
  authorization_sha256: string;
  authorization_mac: string;
  authorization_mac_sha256: string;
}>;

function authorizationMacDigest(authorizationMac: string): string {
  return createHash("sha256")
    .update(Buffer.from(authorizationMac, "base64url"))
    .digest("hex");
}

function closeApprovalSigningInput(approval: LearningExperimentCloseApprovalV1): Buffer {
  return Buffer.concat([
    Buffer.from(LEARNING_EXPERIMENT_CLOSE_APPROVAL_HMAC_DOMAIN, "utf8"),
    Buffer.from([0]),
    Buffer.from(stableStringify(approval), "utf8"),
  ]);
}

export function splitLearningExperimentCloseAuthorization(
  value: unknown,
): LearningExperimentCloseAuthorizationSplitV1 {
  const envelope = LearningExperimentCloseAuthorizationEnvelopeV1Schema.parse(value);
  const authorizationPayloadJson = stableStringify(envelope.approval);
  return Object.freeze({
    approval: envelope.approval,
    authorization_payload_json: authorizationPayloadJson,
    authorization_sha256: sha256Hex(authorizationPayloadJson),
    authorization_mac: envelope.authorization_mac,
    authorization_mac_sha256: authorizationMacDigest(envelope.authorization_mac),
  });
}

export function learningExperimentCloseApprovalMac(
  approval: LearningExperimentCloseApprovalV1,
  key: string | Uint8Array,
): string {
  const parsed = LearningExperimentCloseApprovalV1Schema.parse(approval);
  return createHmac("sha256", key)
    .update(closeApprovalSigningInput(parsed))
    .digest("base64url");
}

export type LearningExperimentCloseApprovalMacVerification =
  | Readonly<{
      ok: true;
      authorization: LearningExperimentCloseAuthorizationSplitV1;
    }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_authorization"
        | "authorization_key_id_mismatch"
        | "authorization_key_empty"
        | "authorization_mac_mismatch"
        | "verification_time_invalid"
        | "authorization_not_yet_valid"
        | "authorization_expired";
    }>;

export type LearningExperimentCloseApprovalMacSignatureVerification =
  | Readonly<{
      ok: true;
      authorization: LearningExperimentCloseAuthorizationSplitV1;
    }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_authorization"
        | "authorization_key_id_mismatch"
        | "authorization_key_empty"
        | "authorization_mac_mismatch";
    }>;

/**
 * Verifies the durable signature independently of its admission-time window.
 * This is used when checking already-committed closure bundles: expiry must
 * prevent a new close, but must not make a historical fact unverifiable.
 */
export function verifyLearningExperimentCloseApprovalMacSignature(args: Readonly<{
  authorization: unknown;
  key: string | Uint8Array;
  expected_authorization_key_id: string;
}>): LearningExperimentCloseApprovalMacSignatureVerification {
  const envelopeResult = LearningExperimentCloseAuthorizationEnvelopeV1Schema.safeParse(
    args.authorization,
  );
  if (!envelopeResult.success) return { ok: false, reason: "invalid_authorization" };
  if (!AuthorizationKeyIdSchema.safeParse(args.expected_authorization_key_id).success
    || envelopeResult.data.approval.authorization_key_id
      !== args.expected_authorization_key_id) {
    return { ok: false, reason: "authorization_key_id_mismatch" };
  }
  const keyBytes = typeof args.key === "string" ? Buffer.from(args.key, "utf8") : args.key;
  if (keyBytes.byteLength === 0) return { ok: false, reason: "authorization_key_empty" };
  const expected = Buffer.from(
    learningExperimentCloseApprovalMac(envelopeResult.data.approval, args.key),
    "base64url",
  );
  const supplied = Buffer.from(envelopeResult.data.authorization_mac, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: "authorization_mac_mismatch" };
  }
  return {
    ok: true,
    authorization: splitLearningExperimentCloseAuthorization(envelopeResult.data),
  };
}

export function verifyLearningExperimentCloseApprovalMac(args: Readonly<{
  authorization: unknown;
  key: string | Uint8Array;
  expected_authorization_key_id: string;
  verified_at: string;
}>): LearningExperimentCloseApprovalMacVerification {
  if (!CanonicalLearningUtcTimestampSchema.safeParse(args.verified_at).success) {
    return { ok: false, reason: "verification_time_invalid" };
  }
  const signature = verifyLearningExperimentCloseApprovalMacSignature(args);
  if (!signature.ok) return signature;
  if (args.verified_at < signature.authorization.approval.authorization_issued_at) {
    return { ok: false, reason: "authorization_not_yet_valid" };
  }
  if (args.verified_at >= signature.authorization.approval.authorization_expires_at) {
    return { ok: false, reason: "authorization_expired" };
  }
  return signature;
}

function closeApprovalFrom(
  value: LearningExperimentCloseApprovalV1 | LearningExperimentCloseAuthorizationEnvelopeV1,
): LearningExperimentCloseApprovalV1 {
  const envelope = LearningExperimentCloseAuthorizationEnvelopeV1Schema.safeParse(value);
  if (envelope.success) return envelope.data.approval;
  return LearningExperimentCloseApprovalV1Schema.parse(value);
}

function requestProjection(args: Readonly<{
  actor: string;
  approval: LearningExperimentCloseApprovalV1;
  authorization_sha256: string;
  authorization_mac_sha256: string;
}>): Record<string, unknown> {
  return {
    contract_version: "aionis_learning_experiment_close_request_v1",
    operation_kind: args.approval.authority_operation_kind,
    operation_id: args.approval.authority_operation_id,
    tenant_id: args.approval.tenant_id,
    authority_scope: args.approval.authority_scope,
    runtime_authority_lineage_sha256: args.approval.runtime_authority_lineage_sha256,
    actor: ExactIdSchema.parse(args.actor),
    task_family: args.approval.task_family,
    confirmatory_attempt_id: args.approval.confirmatory_attempt_id,
    confirmatory_attempt_sha256: args.approval.confirmatory_attempt_sha256,
    experiment_id: args.approval.experiment_id,
    experiment_revision: args.approval.experiment_revision,
    experiment_config_sha256: args.approval.experiment_config_sha256,
    namespace_set_sha256: args.approval.namespace_set_sha256,
    authorization_sha256: DigestSha256Schema.parse(args.authorization_sha256),
    authorization_mac_sha256: DigestSha256Schema.parse(args.authorization_mac_sha256),
  };
}

export function learningExperimentCloseRequestDigest(args: Readonly<{
  actor: string;
  authorization: LearningExperimentCloseAuthorizationEnvelopeV1;
}>): string {
  const split = splitLearningExperimentCloseAuthorization(args.authorization);
  return sha256Hex(stableStringify(requestProjection({
    actor: args.actor,
    approval: split.approval,
    authorization_sha256: split.authorization_sha256,
    authorization_mac_sha256: split.authorization_mac_sha256,
  })));
}

export function learningExperimentCloseId(
  value: LearningExperimentCloseApprovalV1 | LearningExperimentCloseAuthorizationEnvelopeV1,
): string {
  const approval = closeApprovalFrom(value);
  return `lxc_${sha256Hex(stableStringify({
    contract_version: "aionis_learning_experiment_close_identity_v1",
    tenant_id: approval.tenant_id,
    confirmatory_attempt_id: approval.confirmatory_attempt_id,
    experiment_id: approval.experiment_id,
    experiment_revision: approval.experiment_revision,
    authority_operation_id: approval.authority_operation_id,
    authorization_sha256: learningExperimentCloseApprovalDigest(approval),
  }))}`;
}

export const LearningExperimentLeaseMembershipEntryV1Schema = z.object({
  pair_ordinal: z.number().int().min(0).max(383),
  randomization_pair_sha256: DigestSha256Schema,
  pair_member_ordinal: z.union([z.literal(0), z.literal(1)]),
  memory_namespace_sha256: DigestSha256Schema,
  namespace_lease_id: ExactIdSchema,
  namespace_lease_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  activation_wave_index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
}).strict();

export type LearningExperimentLeaseMembershipEntryV1 = z.infer<
  typeof LearningExperimentLeaseMembershipEntryV1Schema
>;

export const LearningExperimentLeaseMembershipV1Schema = z.array(
  LearningExperimentLeaseMembershipEntryV1Schema,
).length(768).superRefine((members, context) => {
  const pairHashes: string[] = [];
  const namespaces = new Set<string>();
  const leaseIds = new Set<string>();
  const waveMemberCounts = new Map<number, number>();
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!;
    const expectedPairOrdinal = Math.floor(index / 2);
    const expectedMemberOrdinal = index % 2;
    if (member.pair_ordinal !== expectedPairOrdinal
      || member.pair_member_ordinal !== expectedMemberOrdinal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "Lease membership must use complete canonical pair/member ordinal order",
      });
      break;
    }
    const pairStart = index - expectedMemberOrdinal;
    const first = members[pairStart]!;
    if (member.randomization_pair_sha256 !== first.randomization_pair_sha256
      || member.activation_wave_index !== first.activation_wave_index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "Both lease members must bind the same pair and activation wave",
      });
    }
    if (expectedMemberOrdinal === 0) pairHashes.push(member.randomization_pair_sha256);
    namespaces.add(member.memory_namespace_sha256);
    leaseIds.add(member.namespace_lease_id);
    waveMemberCounts.set(
      member.activation_wave_index,
      (waveMemberCounts.get(member.activation_wave_index) ?? 0) + 1,
    );
  }
  const canonicalPairHashes = [...pairHashes].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (pairHashes.length !== 384
    || new Set(pairHashes).size !== 384
    || stableStringify(pairHashes) !== stableStringify(canonicalPairHashes)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Lease membership requires 384 unique pair hashes in canonical UTF-8 order",
    });
  }
  if (namespaces.size !== 768 || leaseIds.size !== 768) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Lease membership requires 768 unique namespaces and raw lease IDs",
    });
  }
  if (waveMemberCounts.get(1) !== 192
    || waveMemberCounts.get(2) !== 192
    || waveMemberCounts.get(3) !== 384) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Lease membership activation waves require exactly 192/192/384 members",
    });
  }
});

export type LearningExperimentLeaseMembershipV1 = z.infer<
  typeof LearningExperimentLeaseMembershipV1Schema
>;

export function learningExperimentLeaseMembershipDigest(
  value: readonly LearningExperimentLeaseMembershipEntryV1[],
): string {
  const members = LearningExperimentLeaseMembershipV1Schema.parse(value);
  return sha256Hex(stableStringify({
    contract_version: "aionis_learning_namespace_lease_membership_v1",
    members: members.map((member) => ({
      pair_ordinal: member.pair_ordinal,
      randomization_pair_sha256: member.randomization_pair_sha256,
      pair_member_ordinal: member.pair_member_ordinal,
      memory_namespace_sha256: member.memory_namespace_sha256,
      namespace_lease_id_sha256: sha256Hex(member.namespace_lease_id),
      namespace_lease_generation: member.namespace_lease_generation,
      activation_wave_index: member.activation_wave_index,
    })),
  }));
}

const LearningExperimentCloseReceiptBodyV1Shape = {
  contract_version: z.literal("aionis_learning_experiment_close_receipt_v1"),
  operation_kind: z.literal(LEARNING_EXPERIMENT_CLOSE_OPERATION_KIND),
  operation_id: ExactIdSchema,
  request_sha256: DigestSha256Schema,
  tenant_id: TenantIdSchema,
  authority_scope: z.literal(LEARNING_EXPERIMENT_AUTHORITY_SCOPE),
  runtime_authority_lineage_sha256: DigestSha256Schema,
  actor: ExactIdSchema,
  status: z.literal("closed"),
  authorization_sha256: DigestSha256Schema,
  authorization_mac_sha256: DigestSha256Schema,
  authorization_key_id: AuthorizationKeyIdSchema,
  authorization_nonce: AuthorizationNonceSchema,
  approved_by: ExactIdSchema,
  authorization_issued_at: CanonicalLearningUtcTimestampSchema,
  authorization_expires_at: CanonicalLearningUtcTimestampSchema,
  task_family: ExactKindSchema,
  confirmatory_attempt_id: ExactIdSchema,
  confirmatory_attempt_sha256: DigestSha256Schema,
  experiment_id: ExactIdSchema,
  experiment_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  experiment_config_sha256: DigestSha256Schema,
  namespace_set_sha256: DigestSha256Schema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_implementation_sha256: DigestSha256Schema,
  experiment_close_id: CloseIdSchema,
  close_reason: z.enum(["operator_stop", "safety_abort", "rollout_expired", "evidence_complete"]),
  sealed_event_head_row_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  close_sha256: DigestSha256Schema,
  closed_at: CanonicalLearningUtcTimestampSchema,
  namespace_lease_membership_sha256: DigestSha256Schema,
  namespace_lease_count: z.literal(768),
  release_operation_id: ExactIdSchema,
  release_ref_kind: z.literal("experiment_close"),
  release_ref_id: CloseIdSchema,
  released_at: CanonicalLearningUtcTimestampSchema,
} as const;

const LearningExperimentCloseReceiptBodyV1ObjectSchema = z.object(
  LearningExperimentCloseReceiptBodyV1Shape,
).strict();

type LearningExperimentCloseReceiptBodyV1Internal = z.infer<
  typeof LearningExperimentCloseReceiptBodyV1ObjectSchema
>;

function validateLearningExperimentCloseReceiptBody(
  receipt: LearningExperimentCloseReceiptBodyV1Internal,
  context: z.RefinementCtx,
): void {
  const approval = LearningExperimentCloseApprovalV1Schema.parse({
    contract_version: "learning_experiment_close_approval_v1",
    authorization_kind: "experiment_close",
    action: "close_experiment",
    runtime_authority_lineage_sha256: receipt.runtime_authority_lineage_sha256,
    tenant_id: receipt.tenant_id,
    task_family: receipt.task_family,
    confirmatory_attempt_id: receipt.confirmatory_attempt_id,
    confirmatory_attempt_sha256: receipt.confirmatory_attempt_sha256,
    experiment_id: receipt.experiment_id,
    experiment_revision: receipt.experiment_revision,
    experiment_config_sha256: receipt.experiment_config_sha256,
    namespace_set_sha256: receipt.namespace_set_sha256,
    close_reason: receipt.close_reason,
    candidate_policy_implementation_sha256: receipt.candidate_policy_implementation_sha256,
    gate_policy_implementation_sha256: receipt.gate_policy_implementation_sha256,
    authority_scope: receipt.authority_scope,
    authority_operation_kind: receipt.operation_kind,
    authority_operation_id: receipt.operation_id,
    approved_by: receipt.approved_by,
    authorization_key_id: receipt.authorization_key_id,
    authorization_nonce: receipt.authorization_nonce,
    authorization_issued_at: receipt.authorization_issued_at,
    authorization_expires_at: receipt.authorization_expires_at,
  });
  const expectedAuthorizationSha256 = learningExperimentCloseApprovalDigest(approval);
  if (receipt.authorization_sha256 !== expectedAuthorizationSha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization_sha256"],
      message: "Close receipt approval digest binding mismatch",
    });
  }
  const expectedRequestSha256 = sha256Hex(stableStringify(requestProjection({
    actor: receipt.actor,
    approval,
    authorization_sha256: receipt.authorization_sha256,
    authorization_mac_sha256: receipt.authorization_mac_sha256,
  })));
  if (receipt.request_sha256 !== expectedRequestSha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request_sha256"],
      message: "Close receipt request digest binding mismatch",
    });
  }
  if (receipt.experiment_close_id !== learningExperimentCloseId(approval)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["experiment_close_id"],
      message: "Close receipt deterministic close ID mismatch",
    });
  }
  if (receipt.release_operation_id !== receipt.operation_id
    || receipt.release_ref_id !== receipt.experiment_close_id
    || receipt.released_at !== receipt.closed_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["release_operation_id"],
      message: "Close receipt release must bind the exact close operation, reference, and time",
    });
  }
}

export const LearningExperimentCloseReceiptBodyV1Schema =
  LearningExperimentCloseReceiptBodyV1ObjectSchema.superRefine(
    validateLearningExperimentCloseReceiptBody,
  );

export type LearningExperimentCloseReceiptBodyV1 = z.infer<
  typeof LearningExperimentCloseReceiptBodyV1Schema
>;

export const LearningExperimentCloseReceiptV1Schema = z.object({
  ...LearningExperimentCloseReceiptBodyV1Shape,
  receipt_attestation_key_id: AuthorizationKeyIdSchema,
  receipt_attestation_mac: AuthorizationMacSchema,
}).strict().superRefine(validateLearningExperimentCloseReceiptBody);

export type LearningExperimentCloseReceiptV1 = z.infer<
  typeof LearningExperimentCloseReceiptV1Schema
>;

function closeReceiptAttestationSigningInput(
  body: LearningExperimentCloseReceiptBodyV1,
  keyId: string,
): Buffer {
  return Buffer.concat([
    Buffer.from(LEARNING_EXPERIMENT_CLOSE_RECEIPT_ATTESTATION_HMAC_DOMAIN, "utf8"),
    Buffer.from([0]),
    Buffer.from(stableStringify({
      receipt_attestation_key_id: AuthorizationKeyIdSchema.parse(keyId),
      receipt: body,
    }), "utf8"),
  ]);
}

export function learningExperimentCloseReceiptAttestationMac(
  value: LearningExperimentCloseReceiptBodyV1,
  keyId: string,
  key: string | Uint8Array,
): string {
  const body = LearningExperimentCloseReceiptBodyV1Schema.parse(value);
  return createHmac("sha256", key)
    .update(closeReceiptAttestationSigningInput(body, keyId))
    .digest("base64url");
}

export function learningExperimentCloseReceiptBody(
  value: LearningExperimentCloseReceiptV1,
): LearningExperimentCloseReceiptBodyV1 {
  const receipt = LearningExperimentCloseReceiptV1Schema.parse(value);
  const {
    receipt_attestation_key_id: _keyId,
    receipt_attestation_mac: _mac,
    ...body
  } = receipt;
  return LearningExperimentCloseReceiptBodyV1Schema.parse(body);
}

export type LearningExperimentCloseReceiptAttestationVerification =
  | Readonly<{ ok: true; body: LearningExperimentCloseReceiptBodyV1 }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid_receipt"
        | "receipt_attestation_key_id_mismatch"
        | "receipt_attestation_key_empty"
        | "receipt_attestation_mac_mismatch";
    }>;

export function verifyLearningExperimentCloseReceiptAttestation(args: Readonly<{
  receipt: unknown;
  key: string | Uint8Array;
  expected_receipt_attestation_key_id: string;
}>): LearningExperimentCloseReceiptAttestationVerification {
  const receiptResult = LearningExperimentCloseReceiptV1Schema.safeParse(args.receipt);
  if (!receiptResult.success) return { ok: false, reason: "invalid_receipt" };
  if (!AuthorizationKeyIdSchema.safeParse(args.expected_receipt_attestation_key_id).success
    || receiptResult.data.receipt_attestation_key_id
      !== args.expected_receipt_attestation_key_id) {
    return { ok: false, reason: "receipt_attestation_key_id_mismatch" };
  }
  const keyBytes = typeof args.key === "string" ? Buffer.from(args.key, "utf8") : args.key;
  if (keyBytes.byteLength === 0) {
    return { ok: false, reason: "receipt_attestation_key_empty" };
  }
  const body = learningExperimentCloseReceiptBody(receiptResult.data);
  const expected = Buffer.from(
    learningExperimentCloseReceiptAttestationMac(
      body,
      receiptResult.data.receipt_attestation_key_id,
      args.key,
    ),
    "base64url",
  );
  const supplied = Buffer.from(receiptResult.data.receipt_attestation_mac, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { ok: false, reason: "receipt_attestation_mac_mismatch" };
  }
  return { ok: true, body };
}
