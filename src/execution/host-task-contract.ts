import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";

const BoundedIdSchema = z.string().trim().min(1).max(256);
const BoundedKindSchema = z.string().trim().min(1).max(120);
const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const EpisodeIdSchema = z.string().regex(/^lep_[0-9a-f]{64}$/);
const CanonicalUtcTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .datetime({ offset: false, precision: 3 });
const HostVerifierVersionSchema = z.string().trim().min(1).superRefine(
  (value, context) => {
    if (Buffer.byteLength(value, "utf8") > 120) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Host verifier version must be bounded to 120 UTF-8 bytes",
      });
    }
  },
);

export const HostTaskEnvelopeV1Schema = z.object({
  contract_version: z.literal("host_task_envelope_v1"),
  host_task_id: BoundedIdSchema,
  collector_id: BoundedIdSchema,
  collector_version: BoundedKindSchema,
  task_family: BoundedKindSchema,
  task_signature: BoundedIdSchema,
  repository_signature: BoundedIdSchema,
  source_task_sha256: DigestSha256Schema,
  source_event_sha256: DigestSha256Schema,
  created_at: CanonicalUtcTimestampSchema,
}).strict();

export type HostTaskEnvelopeV1 = z.infer<typeof HostTaskEnvelopeV1Schema>;

export function hostTaskEnvelopeDigest(value: HostTaskEnvelopeV1): string {
  return sha256Hex(stableStringify(HostTaskEnvelopeV1Schema.parse(value)));
}

const HostUseReceiptItemV1Schema = z.object({
  memory_id: BoundedIdSchema,
  used_surface: z.enum(["use_now", "inspect_before_use", "do_not_use"]),
  outcome: z.enum(["positive", "negative", "neutral"]),
  action_outcome: z.enum([
    "accepted_completed",
    "accepted_incomplete",
    "rejected",
    "not_applicable",
  ]),
  verifier_kind: z.enum([
    "instrumented_agent_trace",
    "deterministic_scorer",
  ]),
  verifier_version: HostVerifierVersionSchema,
  verifier_config_sha256: DigestSha256Schema,
  verifier_status: z.literal("passed"),
  content_evidence_sha256: DigestSha256Schema,
  evidence_ref_sha256: DigestSha256Schema,
}).strict();

const HostUseReceiptV1BodyObjectSchema = z.object({
  contract_version: z.literal("host_use_receipt_v1"),
  receipt_id: BoundedIdSchema,
  guide_trace_id: BoundedIdSchema,
  episode_id: EpisodeIdSchema,
  operation_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  host_task_id: BoundedIdSchema,
  host_task_envelope_sha256: DigestSha256Schema,
  collector_id: BoundedIdSchema,
  collector_version: BoundedKindSchema,
  host_trace_sha256: DigestSha256Schema,
  observed_at: CanonicalUtcTimestampSchema,
  items: z.array(HostUseReceiptItemV1Schema).min(1).max(96),
}).strict();

function validateUniqueReceiptItems(
  value: { items: Array<{ memory_id: string }> },
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  let previousMemoryId: string | null = null;
  for (const item of value.items) {
    if (seen.has(item.memory_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: `Duplicate host-use receipt memory_id: ${item.memory_id}`,
      });
    }
    if (
      previousMemoryId !== null
      && Buffer.compare(
        Buffer.from(previousMemoryId, "utf8"),
        Buffer.from(item.memory_id, "utf8"),
      ) >= 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message:
          "Host-use receipt items must be unique and sorted by UTF-8 memory_id bytes",
      });
    }
    seen.add(item.memory_id);
    previousMemoryId = item.memory_id;
  }
}

export const HostUseReceiptV1BodySchema =
  HostUseReceiptV1BodyObjectSchema.superRefine(validateUniqueReceiptItems);

export type HostUseReceiptV1Body =
  z.infer<typeof HostUseReceiptV1BodySchema>;

export function hostUseReceiptDigest(value: HostUseReceiptV1Body): string {
  return sha256Hex(stableStringify(HostUseReceiptV1BodySchema.parse(value)));
}

export const HostUseReceiptV1Schema = HostUseReceiptV1BodyObjectSchema.extend({
  receipt_sha256: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  validateUniqueReceiptItems(value, context);
  const { receipt_sha256: suppliedDigest, ...body } = value;
  if (suppliedDigest !== hostUseReceiptDigest(body)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt_sha256"],
      message: "Host-use receipt digest does not match its canonical body",
    });
  }
});

export type HostUseReceiptV1 = z.infer<typeof HostUseReceiptV1Schema>;
