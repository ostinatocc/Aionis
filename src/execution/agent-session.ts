import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";
import { stableJson } from "../util/stable-json.js";

const SessionIdSchema = z.string().trim().min(1).max(256);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const IsoTimestampSchema = z.string().datetime();

export const ExecutionSessionBindingV1Schema = z.object({
  contract_version: z.literal("execution_session_binding_v1"),
  tenant_id: SessionIdSchema,
  store_scope: SessionIdSchema,
  public_scope: SessionIdSchema,
  session_key: SessionIdSchema,
  continuation_id: SessionIdSchema,
  episode_id: SessionIdSchema,
  goal_sha256: Sha256Schema,
  task_envelope_sha256: Sha256Schema,
  subject_identity_sha256: Sha256Schema,
  created_at: IsoTimestampSchema,
}).strict();
export type ExecutionSessionBindingV1 = z.infer<
  typeof ExecutionSessionBindingV1Schema
>;

export const ExecutionSessionLeaseStatusV1Schema = z.enum([
  "active",
  "released",
  "expired",
]);
export type ExecutionSessionLeaseStatusV1 = z.infer<
  typeof ExecutionSessionLeaseStatusV1Schema
>;

const ExecutionSessionLeaseV1MaterialObjectSchema = z.object({
  contract_version: z.literal("execution_session_lease_v1"),
  binding: ExecutionSessionBindingV1Schema,
  lease_id: SessionIdSchema,
  holder_id: SessionIdSchema,
  lease_revision: z.number().int().positive(),
  status: ExecutionSessionLeaseStatusV1Schema,
  expires_at: IsoTimestampSchema.nullable(),
  current_state_sha256: Sha256Schema,
  last_event_id: SessionIdSchema,
  last_event_sha256: Sha256Schema,
  updated_at: IsoTimestampSchema,
}).strict();

function refineExecutionSessionLeaseMaterial(
  value: z.infer<typeof ExecutionSessionLeaseV1MaterialObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (
    value.status === "active"
    && value.expires_at === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "An active execution-session lease must expire",
    });
  }
  if (
    value.status === "released"
    && value.expires_at !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "A released execution-session lease cannot retain an expiry",
    });
  }
}

export const ExecutionSessionLeaseV1MaterialSchema =
  ExecutionSessionLeaseV1MaterialObjectSchema.superRefine(
    refineExecutionSessionLeaseMaterial,
  );

export const ExecutionSessionLeaseV1Schema =
  ExecutionSessionLeaseV1MaterialObjectSchema.extend({
    lease_sha256: Sha256Schema,
  }).strict().superRefine((value, context) => {
    refineExecutionSessionLeaseMaterial(value, context);
    const { lease_sha256: _digest, ...material } = value;
    if (executionSessionLeaseDigest(material) !== value.lease_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lease_sha256"],
        message: "Execution-session lease digest does not match its material",
      });
    }
  });
export type ExecutionSessionLeaseV1 = z.infer<
  typeof ExecutionSessionLeaseV1Schema
>;

export const ExecutionSessionLeaseEventKindV1Schema = z.enum([
  "acquired",
  "renewed",
  "taken_over",
  "handed_off",
  "released",
  "expired",
]);
export type ExecutionSessionLeaseEventKindV1 = z.infer<
  typeof ExecutionSessionLeaseEventKindV1Schema
>;

const ExecutionSessionLeaseEventV1MaterialObjectSchema = z.object({
  contract_version: z.literal("execution_session_lease_event_v1"),
  event_id: SessionIdSchema,
  tenant_id: SessionIdSchema,
  store_scope: SessionIdSchema,
  session_key: SessionIdSchema,
  continuation_id: SessionIdSchema,
  episode_id: SessionIdSchema,
  event_kind: ExecutionSessionLeaseEventKindV1Schema,
  operation_id: SessionIdSchema,
  request_sha256: Sha256Schema,
  previous_event_sha256: Sha256Schema.nullable(),
  lease_id: SessionIdSchema,
  lease_revision: z.number().int().positive(),
  holder_id: SessionIdSchema,
  previous_holder_id: SessionIdSchema.nullable(),
  expires_at: IsoTimestampSchema.nullable(),
  current_state_sha256: Sha256Schema,
  handoff_receipt_id: SessionIdSchema.nullable(),
  recorded_at: IsoTimestampSchema,
}).strict();

function refineExecutionSessionLeaseEventMaterial(
  value: z.infer<typeof ExecutionSessionLeaseEventV1MaterialObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (
    (value.event_kind === "acquired") !== (
      value.lease_revision === 1
      && value.previous_event_sha256 === null
      && value.previous_holder_id === null
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["event_kind"],
      message: "Only the first lease revision may be acquired",
    });
  }
  if (
    (value.event_kind === "handed_off")
      !== (value.handoff_receipt_id !== null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["handoff_receipt_id"],
      message: "Only a handoff event may bind a handoff receipt",
    });
  }
  if (
    (value.event_kind === "released")
      !== (value.expires_at === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "Only a release event omits lease expiry",
    });
  }
}

export const ExecutionSessionLeaseEventV1MaterialSchema =
  ExecutionSessionLeaseEventV1MaterialObjectSchema.superRefine(
    refineExecutionSessionLeaseEventMaterial,
  );

export const ExecutionSessionLeaseEventV1Schema =
  ExecutionSessionLeaseEventV1MaterialObjectSchema.extend({
    event_sha256: Sha256Schema,
  }).strict().superRefine((value, context) => {
    refineExecutionSessionLeaseEventMaterial(value, context);
    const { event_sha256: _digest, ...material } = value;
    if (executionSessionLeaseEventDigest(material) !== value.event_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_sha256"],
        message:
          "Execution-session lease-event digest does not match its material",
      });
    }
  });
export type ExecutionSessionLeaseEventV1 = z.infer<
  typeof ExecutionSessionLeaseEventV1Schema
>;

const ExecutionSessionHandoffReceiptV1MaterialObjectSchema = z.object({
  contract_version: z.literal("execution_session_handoff_receipt_v1"),
  receipt_id: SessionIdSchema,
  tenant_id: SessionIdSchema,
  store_scope: SessionIdSchema,
  session_key: SessionIdSchema,
  continuation_id: SessionIdSchema,
  episode_id: SessionIdSchema,
  from_holder_id: SessionIdSchema,
  to_holder_id: SessionIdSchema,
  from_lease_revision: z.number().int().positive(),
  state_sha256: Sha256Schema,
  evidence_refs: z.array(SessionIdSchema).max(256),
  created_at: IsoTimestampSchema,
}).strict();

function refineExecutionSessionHandoffReceiptMaterial(
  value: z.infer<
    typeof ExecutionSessionHandoffReceiptV1MaterialObjectSchema
  >,
  context: z.RefinementCtx,
): void {
  const unique = new Set(value.evidence_refs);
  if (unique.size !== value.evidence_refs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_refs"],
      message: "Handoff evidence references must be unique",
    });
  }
  if (value.from_holder_id === value.to_holder_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_holder_id"],
      message: "A handoff must change the lease holder",
    });
  }
}

export const ExecutionSessionHandoffReceiptV1MaterialSchema =
  ExecutionSessionHandoffReceiptV1MaterialObjectSchema.superRefine(
    refineExecutionSessionHandoffReceiptMaterial,
  );

export const ExecutionSessionHandoffReceiptV1Schema =
  ExecutionSessionHandoffReceiptV1MaterialObjectSchema.extend({
    receipt_sha256: Sha256Schema,
  }).strict().superRefine((value, context) => {
    refineExecutionSessionHandoffReceiptMaterial(value, context);
    const { receipt_sha256: _digest, ...material } = value;
    if (
      executionSessionHandoffReceiptDigest(material)
      !== value.receipt_sha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt_sha256"],
        message: "Handoff receipt digest does not match its material",
      });
    }
  });
export type ExecutionSessionHandoffReceiptV1 = z.infer<
  typeof ExecutionSessionHandoffReceiptV1Schema
>;

export function executionSessionLeaseDigest(
  material: z.input<typeof ExecutionSessionLeaseV1MaterialSchema>,
): string {
  return sha256Hex(stableJson(
    ExecutionSessionLeaseV1MaterialSchema.parse(material),
  ));
}

export function executionSessionLeaseEventDigest(
  material: z.input<typeof ExecutionSessionLeaseEventV1MaterialSchema>,
): string {
  return sha256Hex(stableJson(
    ExecutionSessionLeaseEventV1MaterialSchema.parse(material),
  ));
}

export function executionSessionHandoffReceiptDigest(
  material: z.input<typeof ExecutionSessionHandoffReceiptV1MaterialSchema>,
): string {
  return sha256Hex(stableJson(
    ExecutionSessionHandoffReceiptV1MaterialSchema.parse(material),
  ));
}
