import { createHash, createHmac } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import { sha256Hex } from "../util/crypto.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
  learningGatePolicyEvidenceIntentCompatible,
  resolveLearningGatePolicy,
} from "./learning-gate-policy.js";

const LEARNING_GATE_POLICY = resolveLearningGatePolicy(
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_VERSION,
);
const LEARNING_GATE_CONFIG = LEARNING_GATE_POLICY.config;

const BoundedIdSchema = z.string().trim().min(1).max(256);
const BoundedKindSchema = z.string().trim().min(1).max(120);
const HostVerifierVersionSchema = z.string().trim().min(1).superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > 120) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Host verifier version must be bounded to 120 UTF-8 bytes",
    });
  }
});
const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const EpisodeIdSchema = z.string().regex(/^lep_[0-9a-f]{64}$/);
export const CanonicalLearningUtcTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .datetime({ offset: false, precision: 3 });
const NullableDigestSchema = DigestSha256Schema.nullable();
const NullableCanonicalUtcMillisSchema = CanonicalLearningUtcTimestampSchema.nullable();
const LearningActionSchema = z.enum(["use_now", "inspect_before_use", "do_not_use", "rehydrate"]);
export type LearningAction = z.infer<typeof LearningActionSchema>;
const PriorEffectStateSchema = z.enum([
  "no_prior",
  "supported",
  "contradicted",
  "mixed",
  "rehydrate_requested",
]);

export type PublicScope = string & { readonly __kind: "public_scope" };
export type StoreScope = string & { readonly __kind: "store_scope" };

export const LEARNING_STORE_SCOPE_MAX_UTF8_BYTES = 256;

const ExactLearningStoreScopeSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > LEARNING_STORE_SCOPE_MAX_UTF8_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact store scope bounded to 256 UTF-8 bytes",
    });
  }
});

export function asPublicScope(value: string): PublicScope {
  return BoundedIdSchema.parse(value) as PublicScope;
}

export function asStoreScope(value: string): StoreScope {
  return ExactLearningStoreScopeSchema.parse(value) as StoreScope;
}

export function learningMemoryNamespaceSha256(storeScope: StoreScope): string {
  return sha256Hex(asStoreScope(storeScope));
}

export function learningAssignmentUnitSha256(args: {
  tenantId: string;
  storeScope: StoreScope;
}): string {
  return sha256Hex(stableStringify({
    tenant_id: BoundedIdSchema.parse(args.tenantId),
    memory_namespace_sha256: learningMemoryNamespaceSha256(args.storeScope),
  }));
}

export const CollectionPrincipalIdentityV1Schema = z.object({
  contract_version: z.literal("aionis_collection_principal_v1"),
  tenant_id: BoundedIdSchema,
  agent_id: BoundedIdSchema.nullable(),
  team_id: BoundedIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.agent_id === null && value.team_id === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agent_id"],
      message: "Collection principal identity requires an agent_id or team_id subject",
    });
  }
});

export type CollectionPrincipalIdentityV1 = z.infer<typeof CollectionPrincipalIdentityV1Schema>;

export function learningCollectionPrincipalSha256(args: {
  tenant_id: string;
  agent_id: string | null;
  team_id: string | null;
}): string {
  return sha256Hex(stableStringify(CollectionPrincipalIdentityV1Schema.parse({
    contract_version: "aionis_collection_principal_v1",
    tenant_id: args.tenant_id,
    agent_id: args.agent_id,
    team_id: args.team_id,
  })));
}

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
  created_at: CanonicalLearningUtcTimestampSchema,
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
  verifier_kind: z.enum(["instrumented_agent_trace", "deterministic_scorer"]),
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
  observed_at: CanonicalLearningUtcTimestampSchema,
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
      && Buffer.compare(Buffer.from(previousMemoryId, "utf8"), Buffer.from(item.memory_id, "utf8")) >= 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Host-use receipt items must be unique and sorted by UTF-8 memory_id bytes",
      });
    }
    seen.add(item.memory_id);
    previousMemoryId = item.memory_id;
  }
}

export const HostUseReceiptV1BodySchema = HostUseReceiptV1BodyObjectSchema.superRefine(
  validateUniqueReceiptItems,
);

export type HostUseReceiptV1Body = z.infer<typeof HostUseReceiptV1BodySchema>;

export function hostUseReceiptDigest(value: HostUseReceiptV1Body): string {
  return sha256Hex(stableStringify(HostUseReceiptV1BodySchema.parse(value)));
}

export const HostUseReceiptV1Schema = HostUseReceiptV1BodyObjectSchema.extend({
  receipt_sha256: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  validateUniqueReceiptItems(value, context);
  const { receipt_sha256: suppliedDigest, ...body } = value;
  const expectedDigest = hostUseReceiptDigest(body);
  if (suppliedDigest !== expectedDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt_sha256"],
      message: "Host-use receipt digest does not match its canonical body",
    });
  }
});

export type HostUseReceiptV1 = z.infer<typeof HostUseReceiptV1Schema>;

const ExposureCommittedV1ObjectSchema = z.object({
  contract_version: z.literal("aionis_learning_exposure_v1"),
  guide_trace_id: BoundedIdSchema,
  guide_receipt_sha256: DigestSha256Schema,
  guide_commit_id: BoundedIdSchema,
  request_sha256: DigestSha256Schema,
  operation_protection: z.enum(["protected", "legacy_unprotected"]),
  collection_class: z.enum(["eligible_host", "fixture_pilot", "unverified", "legacy_unclassified"]),
  collection_principal_sha256: NullableDigestSchema,
  collection_source_policy_sha256: NullableDigestSchema,
  collector_id: BoundedIdSchema.nullable(),
  collector_version: BoundedKindSchema.nullable(),
  host_task_id: BoundedIdSchema.nullable(),
  host_task_envelope: HostTaskEnvelopeV1Schema.nullable(),
  host_task_envelope_sha256: NullableDigestSchema,
  profile_rule_sha256: NullableDigestSchema,
  experiment_config_sha256: NullableDigestSchema,
  evidence_intent: z.enum(["integrity_only", "confirmatory"]).nullable(),
  memory_namespace_sha256: NullableDigestSchema,
  namespace_set_sha256: NullableDigestSchema,
  namespace_lease_id: BoundedIdSchema.nullable(),
  namespace_lease_generation: z.number().int().positive().nullable(),
  assignment_reason_codes: z.array(BoundedKindSchema).max(32),
  assignment_algorithm: z.enum([
    "matched_pair_csprng_bit_v1",
    "diagnostic_sha256_48_mod_10000_v1",
    "none",
  ]),
  assignment_namespace_sha256: NullableDigestSchema,
  candidate_allocation_bps: z.number().int().min(1_000).max(9_000).nullable(),
  assignment_bucket: z.number().int().min(0)
    .max(LEARNING_GATE_CONFIG.diagnostic_assignment_bucket_count - 1).nullable(),
  randomization_pair_sha256: NullableDigestSchema,
  matching_covariate_sha256: NullableDigestSchema,
  pair_member_ordinal: z.number().int().min(0)
    .max(LEARNING_GATE_CONFIG.matched_pair_member_count - 1).nullable(),
  activation_wave_index: z.number().int().min(1)
    .max(LEARNING_GATE_CONFIG.activation_wave_pair_counts.length).nullable(),
  activation_starts_at: NullableCanonicalUtcMillisSchema,
  index_window_ends_at: NullableCanonicalUtcMillisSchema,
  wave_analysis_at: NullableCanonicalUtcMillisSchema,
  assignment_arm: z.enum(["control", "candidate", "not_enrolled"]),
  served_arm: z.enum(["control", "candidate"]),
  relevant_memory_ids: z.array(BoundedIdSchema).max(256),
  recorded_surface_sha256: DigestSha256Schema,
  candidate_surface_sha256: DigestSha256Schema,
  served_surface_sha256: DigestSha256Schema,
  projection_complete: z.boolean(),
  projection_incomplete_reason_codes: z.array(BoundedKindSchema).max(32),
  hard_boundary_upgrade_count: z.number().int().nonnegative(),
}).strict();

function validateExposureCommittedV1(
  value: z.infer<typeof ExposureCommittedV1ObjectSchema>,
  context: z.RefinementCtx,
): void {
  const issue = (path: string, message: string) => context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
  });
  if (value.host_task_envelope) {
    if (value.host_task_envelope_sha256 !== hostTaskEnvelopeDigest(value.host_task_envelope)) {
      issue("host_task_envelope_sha256", "Host-task envelope digest mismatch");
    }
    if (
      value.host_task_id !== value.host_task_envelope.host_task_id
      || value.collector_id !== value.host_task_envelope.collector_id
      || value.collector_version !== value.host_task_envelope.collector_version
    ) {
      issue("host_task_envelope", "Host-task envelope identity does not match exposure identity");
    }
  } else if (value.host_task_envelope_sha256 !== null) {
    issue("host_task_envelope_sha256", "Envelope digest requires a persisted envelope");
  }

  for (const [field, values] of [
    ["assignment_reason_codes", value.assignment_reason_codes],
    ["relevant_memory_ids", value.relevant_memory_ids],
    ["projection_incomplete_reason_codes", value.projection_incomplete_reason_codes],
  ] as const) {
    if (new Set(values).size !== values.length) {
      issue(field, `${field} must contain unique values`);
    }
    const sorted = [...values].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
    if (values.some((entry, index) => entry !== sorted[index])) {
      issue(field, `${field} must use canonical UTF-8 byte ordering`);
    }
  }
  if (value.projection_complete && value.projection_incomplete_reason_codes.length > 0) {
    issue(
      "projection_incomplete_reason_codes",
      "A complete projection cannot retain incomplete reason codes",
    );
  }
  if (!value.projection_complete && value.projection_incomplete_reason_codes.length === 0) {
    issue(
      "projection_incomplete_reason_codes",
      "An incomplete projection requires at least one stable reason code",
    );
  }
  if (!value.projection_complete && value.served_arm === "candidate") {
    issue("served_arm", "An incomplete projection cannot serve the candidate arm");
  }

  if (value.assignment_algorithm === "matched_pair_csprng_bit_v1") {
    if (
      value.collection_class !== "eligible_host"
      || value.evidence_intent !== "confirmatory"
      || value.operation_protection !== "protected"
      || value.collection_principal_sha256 === null
      || value.collection_source_policy_sha256 === null
      || value.host_task_envelope === null
      || value.host_task_envelope_sha256 === null
      || value.profile_rule_sha256 === null
      || value.experiment_config_sha256 === null
      || value.memory_namespace_sha256 === null
      || value.namespace_set_sha256 === null
      || value.namespace_lease_id === null
      || value.namespace_lease_generation === null
      || value.candidate_allocation_bps !== LEARNING_GATE_CONFIG.confirmatory_candidate_allocation_bps
      || value.assignment_namespace_sha256 === null
      || value.assignment_bucket !== null
      || value.randomization_pair_sha256 === null
      || value.matching_covariate_sha256 === null
      || value.pair_member_ordinal === null
      || value.activation_wave_index === null
      || value.activation_starts_at === null
      || value.index_window_ends_at === null
      || value.wave_analysis_at === null
      || value.assignment_arm === "not_enrolled"
    ) {
      issue("assignment_algorithm", "Matched-pair assignment requires the exact frozen 50/50 pair/wave binding");
    }
    if (
      value.activation_starts_at !== null
      && value.index_window_ends_at !== null
      && value.wave_analysis_at !== null
      && !(
        value.activation_starts_at < value.index_window_ends_at
        && value.index_window_ends_at < value.wave_analysis_at
      )
    ) {
      issue("activation_starts_at", "Matched-pair wave times must satisfy start < window_end < analysis_at");
    }
  }
  if (value.assignment_algorithm === "diagnostic_sha256_48_mod_10000_v1") {
    if (
      value.assignment_namespace_sha256 === null
      || value.candidate_allocation_bps === null
      || value.assignment_bucket === null
      || value.randomization_pair_sha256 !== null
      || value.matching_covariate_sha256 !== null
      || value.pair_member_ordinal !== null
      || value.activation_wave_index !== null
      || value.activation_starts_at !== null
      || value.index_window_ends_at !== null
      || value.wave_analysis_at !== null
      || value.assignment_arm === "not_enrolled"
      || (value.collection_class === "eligible_host" && value.evidence_intent === "confirmatory")
    ) {
      issue("assignment_algorithm", "Diagnostic assignment cannot claim confirmatory pair facts");
    }
  }
  if (value.assignment_algorithm === "none") {
    if (
      value.assignment_arm !== "not_enrolled"
      || value.assignment_namespace_sha256 !== null
      || value.candidate_allocation_bps !== null
      || value.assignment_bucket !== null
      || value.randomization_pair_sha256 !== null
      || value.matching_covariate_sha256 !== null
      || value.pair_member_ordinal !== null
      || value.activation_wave_index !== null
      || value.activation_starts_at !== null
      || value.index_window_ends_at !== null
      || value.wave_analysis_at !== null
    ) {
      issue("assignment_arm", "Unassigned exposure cannot claim assignment, pair, or wave facts");
    }
  }
  if (
    value.collection_class === "fixture_pilot"
    && (
      value.assignment_algorithm === "matched_pair_csprng_bit_v1"
      || value.host_task_id !== null
      || value.host_task_envelope !== null
      || value.host_task_envelope_sha256 !== null
    )
  ) {
    issue("collection_class", "Fixture-pilot exposure cannot claim confirmatory assignment or production host-task identity");
  }
}

export const ExposureCommittedV1Schema = ExposureCommittedV1ObjectSchema.superRefine(
  validateExposureCommittedV1,
);

export type ExposureCommittedV1 = z.infer<typeof ExposureCommittedV1Schema>;

const FeedbackAttributedV1ObjectSchema = z.object({
  contract_version: z.literal("aionis_learning_feedback_v1"),
  feedback_kind: z.enum(["memory", "tool_selection"]),
  guide_trace_id: BoundedIdSchema,
  request_sha256: DigestSha256Schema,
  operation_protection: z.enum(["protected", "legacy_unprotected"]),
  operation_receipt_sha256: NullableDigestSchema.optional(),
  run_id: BoundedIdSchema,
  source_commit_id: BoundedIdSchema,
  run_lifecycle_decision_rowid_cutoff: z.number().int().nonnegative().optional(),
  run_lifecycle_feedback_rowid_cutoff: z.number().int().nonnegative().optional(),
  host_use_receipt_sha256: NullableDigestSchema,
  runtime_signal_refs: z.array(BoundedIdSchema).max(96),
  unused_exposure_ids: z.array(BoundedIdSchema).max(96),
  learning_control_queue_contract: z.literal("unused_exposure_learning_control_v1").optional(),
}).strict();

function validateFeedbackAttributedV1(
  value: z.infer<typeof FeedbackAttributedV1ObjectSchema>,
  context: z.RefinementCtx,
): void {
  for (const field of ["runtime_signal_refs", "unused_exposure_ids"] as const) {
    if (new Set(value[field]).size !== value[field].length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be unique` });
    }
  }
  if ((value.operation_protection === "protected")
    ? typeof value.operation_receipt_sha256 !== "string"
    : value.operation_receipt_sha256 !== null && value.operation_receipt_sha256 !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation_receipt_sha256"],
      message: "protected feedback requires one exact route operation receipt digest",
    });
  }
  if (value.learning_control_queue_contract
    && (value.feedback_kind !== "memory" || value.unused_exposure_ids.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["learning_control_queue_contract"],
      message: "learning-control queue provenance requires memory feedback with an unused exposure",
    });
  }
  const hasRunLifecycleCutoffs = value.run_lifecycle_decision_rowid_cutoff !== undefined
    && value.run_lifecycle_feedback_rowid_cutoff !== undefined;
  if (value.feedback_kind === "tool_selection" && value.operation_protection === "protected") {
    if (!hasRunLifecycleCutoffs || value.run_lifecycle_decision_rowid_cutoff === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_lifecycle_decision_rowid_cutoff"],
        message: "protected tool feedback requires exact run lifecycle row cutoffs",
      });
    }
  } else if (value.run_lifecycle_decision_rowid_cutoff !== undefined
    || value.run_lifecycle_feedback_rowid_cutoff !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_lifecycle_decision_rowid_cutoff"],
      message: "run lifecycle row cutoffs are reserved for protected tool feedback",
    });
  }
}

export const FeedbackAttributedV1Schema = FeedbackAttributedV1ObjectSchema.superRefine(
  validateFeedbackAttributedV1,
);

export type FeedbackAttributedV1 = z.infer<typeof FeedbackAttributedV1Schema>;

export function assertFeedbackOperationBinding(
  event: EventWithoutDigest,
  payload: FeedbackAttributedV1,
): void {
  if (payload.feedback_kind === "memory") {
    if (event.source_kind !== "memory_feedback_operation"
      || event.run_id !== payload.run_id
      || event.source_commit_id !== payload.source_commit_id) {
      throw new Error("memory feedback event identity does not match its canonical payload");
    }
    if (payload.operation_protection === "protected" && (
      event.operation_id === null
      || event.source_id !== event.operation_id
      || event.source_sha256 !== payload.request_sha256
    )) {
      throw new Error("protected memory feedback is not bound to its operation request digest");
    }
    return;
  }
  if (event.source_kind !== "tool_feedback_operation"
    || event.event_kind !== "feedback_attributed"
    || event.run_id !== payload.run_id
    || event.source_commit_id !== payload.source_commit_id
    || payload.host_use_receipt_sha256 !== null
    || payload.runtime_signal_refs.length !== 0
    || payload.unused_exposure_ids.length !== 0
    || payload.learning_control_queue_contract !== undefined) {
    throw new Error("tool feedback event identity does not match its canonical payload");
  }
  if (payload.operation_protection === "protected") {
    if (event.operation_id === null
      || event.source_id !== event.operation_id
      || event.source_sha256 !== payload.request_sha256) {
      throw new Error("protected tool feedback is not bound to its operation request digest");
    }
    return;
  }
  if (event.operation_id !== null
    || event.source_id !== payload.source_commit_id
    || event.source_sha256 !== payload.request_sha256) {
    throw new Error("legacy tool feedback has invalid source identity");
  }
}

const EffectMeasuredV1ObjectSchema = z.object({
  contract_version: z.literal("aionis_learning_effect_v1"),
  measurement_id: BoundedIdSchema,
  measurement_record_sha256: DigestSha256Schema,
  // Omission is accepted only to replay historical v1 effects; new builders require it.
  operation_receipt_sha256: NullableDigestSchema.optional(),
  baseline_episode_id: EpisodeIdSchema,
  after_episode_id: EpisodeIdSchema,
  evidence_status: z.enum(["sufficient", "insufficient"]),
  eligible_for_skill_export: z.boolean(),
}).strict();

function validateEffectMeasuredV1(
  value: z.infer<typeof EffectMeasuredV1ObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (value.baseline_episode_id === value.after_episode_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["after_episode_id"],
      message: "Effect measurement requires distinct baseline and after episodes",
    });
  }
  if (value.eligible_for_skill_export && value.evidence_status !== "sufficient") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eligible_for_skill_export"],
      message: "Insufficient effect evidence cannot be eligible for skill export",
    });
  }
}

export const EffectMeasuredV1Schema = EffectMeasuredV1ObjectSchema.superRefine(
  validateEffectMeasuredV1,
);

export type EffectMeasuredV1 = z.infer<typeof EffectMeasuredV1Schema>;
export type FreshEffectMeasuredV1 = EffectMeasuredV1 & Readonly<{
  operation_receipt_sha256: string | null;
}>;

export const LearningEpisodePayloadV1Schema = z.discriminatedUnion("contract_version", [
  ExposureCommittedV1ObjectSchema,
  FeedbackAttributedV1ObjectSchema,
  EffectMeasuredV1ObjectSchema,
]).superRefine((value, context) => {
  if (value.contract_version === "aionis_learning_exposure_v1") {
    validateExposureCommittedV1(value, context);
  } else if (value.contract_version === "aionis_learning_feedback_v1") {
    validateFeedbackAttributedV1(value, context);
  } else {
    validateEffectMeasuredV1(value, context);
  }
});

export const FrozenPriorStateSchema = z.object({
  prior_supported_use_count: z.number().int().nonnegative(),
  prior_contradicted_use_count: z.number().int().nonnegative(),
  prior_rehydrate_requested_count: z.number().int().nonnegative(),
  prior_effect_state: PriorEffectStateSchema,
  repeated_negative_posture: z.boolean(),
}).strict();

export type FrozenPriorState = z.infer<typeof FrozenPriorStateSchema>;
export type LearningTrackReason =
  | "no_prior"
  | "prior_supported"
  | "prior_contradicted"
  | "prior_mixed"
  | "prior_rehydrate_requested"
  | "prior_nonuse_control"
  | "legacy_unclassified";

export function classifyLearningTrack(priorInput: FrozenPriorState): {
  track: "explore" | "exploit";
  reason: Exclude<LearningTrackReason, "legacy_unclassified">;
} {
  const prior = FrozenPriorStateSchema.parse(priorInput);
  if (prior.repeated_negative_posture) return { track: "exploit", reason: "prior_nonuse_control" };
  if (
    prior.prior_effect_state === "mixed"
    || (prior.prior_supported_use_count > 0 && prior.prior_contradicted_use_count > 0)
  ) return { track: "exploit", reason: "prior_mixed" };
  if (prior.prior_effect_state === "contradicted" || prior.prior_contradicted_use_count > 0) {
    return { track: "exploit", reason: "prior_contradicted" };
  }
  if (prior.prior_effect_state === "rehydrate_requested" || prior.prior_rehydrate_requested_count > 0) {
    return { track: "exploit", reason: "prior_rehydrate_requested" };
  }
  if (prior.prior_effect_state === "supported" || prior.prior_supported_use_count > 0) {
    return { track: "exploit", reason: "prior_supported" };
  }
  return { track: "explore", reason: "no_prior" };
}

function nonNegativeRuntimeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export function frozenPriorStateFromRuntimeSlots(slots: Record<string, unknown>): FrozenPriorState {
  const supported = nonNegativeRuntimeInt(slots.positive_attributed_use_count);
  const contradicted = nonNegativeRuntimeInt(slots.weak_counter_signal_count)
    + nonNegativeRuntimeInt(slots.strong_counter_signal_count);
  const rehydrateRequested = nonNegativeRuntimeInt(slots.prior_rehydrate_requested_count)
    + nonNegativeRuntimeInt(slots.rehydrate_requested_count);
  const repeatedNegativePosture = contradicted >= 2
    || slots.feedback_learning_control_posture === "inspect_before_use"
    || nonNegativeRuntimeInt(slots.repeated_unused_without_positive_observation_count) >= 2;
  const priorEffectState: FrozenPriorState["prior_effect_state"] = supported > 0 && contradicted > 0
    ? "mixed"
    : contradicted > 0
      ? "contradicted"
      : supported > 0
        ? "supported"
        : rehydrateRequested > 0
          ? "rehydrate_requested"
          : "no_prior";
  return {
    prior_supported_use_count: supported,
    prior_contradicted_use_count: contradicted,
    prior_rehydrate_requested_count: rehydrateRequested,
    prior_effect_state: priorEffectState,
    repeated_negative_posture: repeatedNegativePosture,
  };
}

const CompleteLearningLedgerItemSchema = z.object({
  decision_completeness: z.literal("complete"),
  memory_id: BoundedIdSchema,
  memory_type: BoundedKindSchema,
  source_backend: BoundedKindSchema,
  recorded_action: LearningActionSchema,
  candidate_action: LearningActionSchema,
  served_action: LearningActionSchema,
  policy_changed: z.boolean(),
  hard_boundary_preserved: z.boolean(),
  prior_supported_use_count: z.number().int().nonnegative(),
  prior_contradicted_use_count: z.number().int().nonnegative(),
  prior_rehydrate_requested_count: z.number().int().nonnegative(),
  prior_effect_state: PriorEffectStateSchema,
  repeated_negative_posture: z.boolean(),
  learning_track: z.enum(["explore", "exploit"]),
  track_reason: z.enum([
    "no_prior",
    "prior_supported",
    "prior_contradicted",
    "prior_mixed",
    "prior_rehydrate_requested",
    "prior_nonuse_control",
  ]),
}).strict().superRefine((item, context) => {
  const classified = classifyLearningTrack({
    prior_supported_use_count: item.prior_supported_use_count,
    prior_contradicted_use_count: item.prior_contradicted_use_count,
    prior_rehydrate_requested_count: item.prior_rehydrate_requested_count,
    prior_effect_state: item.prior_effect_state,
    repeated_negative_posture: item.repeated_negative_posture,
  });
  if (classified.track !== item.learning_track || classified.reason !== item.track_reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Learning item track does not match frozen prior state" });
  }
  if (item.recorded_action !== "use_now" && item.candidate_action !== item.recorded_action) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidate_action"], message: "Candidate cannot change a recorded non-use boundary" });
  }
  if (item.recorded_action !== "use_now" && item.served_action === "use_now") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["served_action"], message: "Served action cannot upgrade a recorded non-use boundary" });
  }
  const hardBoundaryPreserved = item.recorded_action === "use_now"
    || (item.candidate_action === item.recorded_action && item.served_action !== "use_now");
  if (item.hard_boundary_preserved !== hardBoundaryPreserved) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hard_boundary_preserved"], message: "Hard-boundary preservation flag is inconsistent" });
  }
  if (item.policy_changed !== (item.candidate_action !== item.recorded_action)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["policy_changed"], message: "Policy-changed flag is inconsistent" });
  }
});

const LegacyLearningLedgerItemSchema = z.object({
  decision_completeness: z.literal("legacy_served_only"),
  memory_id: BoundedIdSchema,
  memory_type: z.null(),
  source_backend: z.null(),
  recorded_action: z.null(),
  candidate_action: z.null(),
  served_action: LearningActionSchema,
  policy_changed: z.null(),
  hard_boundary_preserved: z.null(),
  prior_supported_use_count: z.null(),
  prior_contradicted_use_count: z.null(),
  prior_rehydrate_requested_count: z.null(),
  prior_effect_state: z.null(),
  repeated_negative_posture: z.null(),
  learning_track: z.literal("unclassified"),
  track_reason: z.literal("legacy_unclassified"),
}).strict();

export const LearningLedgerItemSchema = z.union([
  CompleteLearningLedgerItemSchema,
  LegacyLearningLedgerItemSchema,
]);
export type LearningLedgerItem = z.infer<typeof LearningLedgerItemSchema>;

export function learningDecisionSurfaceDigest(
  surface: readonly Readonly<{ memory_id: string; action: LearningAction }>[],
): string {
  const parsed = surface.map((entry) => ({
    memory_id: BoundedIdSchema.parse(entry.memory_id),
    action: LearningActionSchema.parse(entry.action),
  }));
  const ids = parsed.map((entry) => entry.memory_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Learning decision surface contains duplicate memory_id values");
  }
  const sorted = [...parsed].sort((left, right) =>
    Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
  );
  return sha256Hex(stableStringify(sorted));
}

export function learningItemSetDigest(items: readonly LearningLedgerItem[]): string {
  const parsed = items.map((item) => LearningLedgerItemSchema.parse(item));
  const ids = parsed.map((item) => item.memory_id);
  if (new Set(ids).size !== ids.length) throw new Error("Learning item set contains duplicate memory_id values");
  const sorted = [...parsed].sort((left, right) =>
    Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
  );
  return sha256Hex(stableStringify(sorted));
}

export function assertLearningExposureDecisionBindings(
  payload: ExposureCommittedV1,
  items: readonly LearningLedgerItem[],
): void {
  const itemMemoryIds = items.map((item) => item.memory_id).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  const relevantMemoryIdSet = new Set(payload.relevant_memory_ids);
  if (itemMemoryIds.some((memoryId) => !relevantMemoryIdSet.has(memoryId))) {
    throw new Error("learning exposure item is outside the declared relevant-memory set");
  }
  const hasLegacyItems = items.some((item) => item.decision_completeness === "legacy_served_only");
  if (payload.projection_complete && (
    hasLegacyItems
    || itemMemoryIds.length !== payload.relevant_memory_ids.length
    || itemMemoryIds.some((memoryId, index) => memoryId !== payload.relevant_memory_ids[index])
  )) {
    throw new Error("complete learning exposure must exactly cover the relevant-memory set");
  }
  if (hasLegacyItems) {
    if (!payload.projection_incomplete_reason_codes.includes("legacy_served_only")) {
      throw new Error("legacy learning exposure requires its stable incomplete reason");
    }
    return;
  }
  const completeItems = items.filter((item) => item.decision_completeness === "complete");
  const surfaceDigest = (action: "recorded_action" | "candidate_action" | "served_action") =>
    learningDecisionSurfaceDigest(completeItems.map((item) => ({
      memory_id: item.memory_id,
      action: item[action],
    })));
  if (payload.recorded_surface_sha256 !== surfaceDigest("recorded_action")
    || payload.candidate_surface_sha256 !== surfaceDigest("candidate_action")
    || payload.served_surface_sha256 !== surfaceDigest("served_action")) {
    throw new Error("learning exposure surface digest mismatch");
  }
  const hardBoundaryUpgradeCount = completeItems.filter((item) =>
    item.recorded_action !== "use_now" && item.candidate_action === "use_now"
  ).length;
  if (payload.hard_boundary_upgrade_count !== hardBoundaryUpgradeCount) {
    throw new Error("learning exposure hard-boundary count mismatch");
  }
  for (const item of completeItems) {
    const expectedServedAction = payload.served_arm === "candidate"
      ? item.candidate_action
      : item.recorded_action;
    if (item.served_action !== expectedServedAction) {
      throw new Error("learning exposure served action does not match the explicit served arm");
    }
  }
}

export function learningEpisodeTrackSummary(
  items: readonly { policy_affected: boolean; learning_track: "explore" | "exploit" | "unclassified" }[],
): "unaffected" | "explore" | "exploit" | "mixed" | "unclassified" {
  const affected = items.filter((item) => item.policy_affected);
  if (affected.length === 0) return "unaffected";
  if (affected.some((item) => item.learning_track === "unclassified")) return "unclassified";
  const tracks = new Set(affected.map((item) => item.learning_track));
  if (tracks.size > 1) return "mixed";
  return affected[0]?.learning_track === "exploit" ? "exploit" : "explore";
}

export function learningEpisodeId(args: { tenantId: string; scope: string; guideTraceId: string }): string {
  const canonical = {
    tenant_id: BoundedIdSchema.parse(args.tenantId),
    scope: BoundedIdSchema.parse(args.scope),
    guide_trace_id: BoundedIdSchema.parse(args.guideTraceId),
  };
  return `lep_${sha256Hex(stableStringify(canonical))}`;
}

export const LearningEpisodeEventWithoutDigestSchema = z.object({
  contract_version: z.literal("aionis_learning_episode_event_v1"),
  tenant_id: BoundedIdSchema,
  scope: BoundedIdSchema,
  event_id: BoundedIdSchema,
  episode_id: EpisodeIdSchema,
  episode_sequence: z.number().int().positive(),
  event_kind: z.enum(["exposure_committed", "feedback_attributed", "effect_measured"]),
  source_kind: z.enum([
    "guide_receipt",
    "memory_feedback_operation",
    "tool_feedback_operation",
    "product_measurement",
    "legacy_backfill",
  ]),
  source_id: BoundedIdSchema,
  source_sha256: DigestSha256Schema,
  previous_event_sha256: NullableDigestSchema,
  payload_sha256: DigestSha256Schema,
  item_set_sha256: DigestSha256Schema,
  source_commit_id: BoundedIdSchema.nullable(),
  supersedes_event_id: BoundedIdSchema.nullable(),
  operation_id: BoundedIdSchema.nullable(),
  run_id: BoundedIdSchema.nullable(),
  collection_class: z.enum(["eligible_host", "fixture_pilot", "unverified", "legacy_unclassified"]),
  recorded_at: CanonicalLearningUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.episode_sequence === 1 && value.previous_event_sha256 !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["previous_event_sha256"], message: "First episode event has no predecessor" });
  }
  if (value.episode_sequence > 1 && value.previous_event_sha256 === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["previous_event_sha256"], message: "Later episode event requires predecessor digest" });
  }
  if (value.supersedes_event_id === value.event_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["supersedes_event_id"], message: "Event cannot supersede itself" });
  }
});

export type EventWithoutDigest = z.infer<typeof LearningEpisodeEventWithoutDigestSchema>;

export function learningEpisodeEventDigest(event: EventWithoutDigest): string {
  return sha256Hex(stableStringify(LearningEpisodeEventWithoutDigestSchema.parse(event)));
}

export type LearningExperimentCompatibility = {
  compatible: boolean;
  promotion_eligible: boolean;
  reason: string;
};

export function resolveLearningExperimentCompatibility(args: {
  profileMode: "off" | "shadow" | "active";
  servingPhase: "aa" | "shadow" | "active_control";
  evidenceIntent: "integrity_only" | "confirmatory";
  candidateAllocationBps: number;
}): LearningExperimentCompatibility {
  if (!Number.isInteger(args.candidateAllocationBps) || args.candidateAllocationBps < 1_000 || args.candidateAllocationBps > 9_000) {
    return { compatible: false, promotion_eligible: false, reason: "invalid_candidate_allocation" };
  }
  if (args.profileMode === "off") {
    return { compatible: false, promotion_eligible: false, reason: "profile_off" };
  }
  if (args.profileMode === "shadow" && args.servingPhase === "active_control") {
    return { compatible: false, promotion_eligible: false, reason: "profile_shadow_authority_ceiling" };
  }
  if (args.servingPhase === "active_control") {
    if (!learningGatePolicyEvidenceIntentCompatible(args.servingPhase, args.evidenceIntent)) {
      return { compatible: false, promotion_eligible: false, reason: "active_control_requires_confirmatory" };
    }
    if (args.candidateAllocationBps !== LEARNING_GATE_CONFIG.confirmatory_candidate_allocation_bps) {
      return { compatible: false, promotion_eligible: false, reason: "confirmatory_requires_exact_50_50_allocation" };
    }
    return { compatible: true, promotion_eligible: true, reason: "confirmatory_active_control" };
  }
  if (!learningGatePolicyEvidenceIntentCompatible(args.servingPhase, args.evidenceIntent)) {
    return { compatible: false, promotion_eligible: false, reason: "non_active_phase_requires_integrity_only" };
  }
  return { compatible: true, promotion_eligible: false, reason: "integrity_only_phase" };
}

function rawBytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function confirmatoryMatchedPairAssignment(args: {
  assignmentRandomBits: Uint8Array;
  canonicalPairOrdinal: number;
  pairMemberOrdinal: 0 | 1;
}) {
  if (args.assignmentRandomBits.byteLength !== LEARNING_GATE_CONFIG.confirmatory_assignment_random_bytes) {
    throw new Error(
      `Gate-policy v1 confirmatory assignment requires exactly ${LEARNING_GATE_CONFIG.confirmatory_assignment_random_bytes} random bytes`,
    );
  }
  if (
    !Number.isInteger(args.canonicalPairOrdinal)
    || args.canonicalPairOrdinal < 0
    || args.canonicalPairOrdinal >= LEARNING_GATE_CONFIG.confirmatory_pair_count
  ) {
    throw new Error(
      `Canonical pair ordinal must be in [0, ${LEARNING_GATE_CONFIG.confirmatory_pair_count - 1}]`,
    );
  }
  if (
    !Number.isInteger(args.pairMemberOrdinal)
    || args.pairMemberOrdinal < 0
    || args.pairMemberOrdinal >= LEARNING_GATE_CONFIG.matched_pair_member_count
  ) {
    throw new Error(
      `Pair member ordinal must be in [0, ${LEARNING_GATE_CONFIG.matched_pair_member_count - 1}]`,
    );
  }
  const byte = args.assignmentRandomBits[Math.floor(args.canonicalPairOrdinal / 8)] ?? 0;
  const shift = 7 - (args.canonicalPairOrdinal % 8);
  const candidateMemberOrdinal = ((byte >> shift) & 1) as 0 | 1;
  return {
    algorithm: "matched_pair_csprng_bit_v1" as const,
    arm: args.pairMemberOrdinal === candidateMemberOrdinal ? "candidate" as const : "control" as const,
    assignment_randomness_sha256: rawBytesSha256(args.assignmentRandomBits),
  };
}

export function diagnosticLearningAssignment(args: {
  diagnosticAssignmentSeed: Uint8Array;
  assignmentNamespace: string;
  assignmentUnit: string;
  candidateAllocationBps: number;
}) {
  if (args.diagnosticAssignmentSeed.byteLength !== LEARNING_GATE_CONFIG.diagnostic_assignment_random_bytes) {
    throw new Error(
      `Diagnostic assignment requires exactly ${LEARNING_GATE_CONFIG.diagnostic_assignment_random_bytes} random seed bytes`,
    );
  }
  if (!Number.isInteger(args.candidateAllocationBps) || args.candidateAllocationBps < 1_000 || args.candidateAllocationBps > 9_000) {
    throw new Error("Candidate allocation must be integer basis points in [1000, 9000]");
  }
  const input = stableStringify({
    contract_version: "aionis_diagnostic_assignment_v1",
    assignment_namespace: BoundedIdSchema.parse(args.assignmentNamespace),
    assignment_unit: DigestSha256Schema.parse(args.assignmentUnit),
  });
  const digest = createHmac("sha256", args.diagnosticAssignmentSeed).update(input).digest();
  const bucket = digest.readUIntBE(0, LEARNING_GATE_CONFIG.diagnostic_assignment_hash_prefix_bytes)
    % LEARNING_GATE_CONFIG.diagnostic_assignment_bucket_count;
  return {
    algorithm: "diagnostic_sha256_48_mod_10000_v1" as const,
    arm: bucket < args.candidateAllocationBps ? "candidate" as const : "control" as const,
    assignment_bucket: bucket,
    diagnostic_assignment_seed_sha256: rawBytesSha256(args.diagnosticAssignmentSeed),
  };
}

export function resolveLearningAssignment(args: {
  collectionClass: "eligible_host" | "fixture_pilot" | "unverified" | "legacy_unclassified";
  evidenceIntent: "integrity_only" | "confirmatory";
  diagnosticAssignmentSeed: Uint8Array;
  diagnosticAssignmentNamespace: string;
  assignmentUnit: string;
  candidateAllocationBps: number;
  assignmentRandomBits?: Uint8Array | null;
  canonicalPairOrdinal?: number | null;
  pairMemberOrdinal?: 0 | 1 | null;
}) {
  if (args.collectionClass === "eligible_host" && args.evidenceIntent === "confirmatory") {
    if (args.candidateAllocationBps !== LEARNING_GATE_CONFIG.confirmatory_candidate_allocation_bps) {
      throw new Error(
        `Eligible-host confirmatory assignment requires candidateAllocationBps=${LEARNING_GATE_CONFIG.confirmatory_candidate_allocation_bps}`,
      );
    }
    if (
      args.assignmentRandomBits == null
      || args.canonicalPairOrdinal == null
      || args.pairMemberOrdinal == null
    ) {
      throw new Error("Eligible-host confirmatory assignment requires its persisted matched-pair bit binding");
    }
    return {
      ...confirmatoryMatchedPairAssignment({
        assignmentRandomBits: args.assignmentRandomBits,
        canonicalPairOrdinal: args.canonicalPairOrdinal,
        pairMemberOrdinal: args.pairMemberOrdinal,
      }),
      assignment_authority: "confirmatory_matched_pair" as const,
    };
  }
  return {
    ...diagnosticLearningAssignment({
      diagnosticAssignmentSeed: args.diagnosticAssignmentSeed,
      assignmentNamespace: args.diagnosticAssignmentNamespace,
      assignmentUnit: args.assignmentUnit,
      candidateAllocationBps: args.candidateAllocationBps,
    }),
    assignment_authority: "diagnostic_only" as const,
  };
}

export function isLearningExposurePromotionEligible(rawExposure: ExposureCommittedV1): boolean {
  const parsed = ExposureCommittedV1Schema.safeParse(rawExposure);
  if (!parsed.success) return false;
  const exposure = parsed.data;
  const servingReason = exposure.served_arm === "candidate"
    ? "candidate_arm_served"
    : "control_arm_served";
  return exposure.operation_protection === "protected"
    && exposure.collection_class === "eligible_host"
    && exposure.collection_principal_sha256 !== null
    && exposure.collection_source_policy_sha256 !== null
    && exposure.host_task_envelope !== null
    && exposure.host_task_envelope_sha256 !== null
    && exposure.profile_rule_sha256 !== null
    && exposure.experiment_config_sha256 !== null
    && exposure.evidence_intent === "confirmatory"
    && exposure.memory_namespace_sha256 !== null
    && exposure.namespace_set_sha256 !== null
    && exposure.namespace_lease_id !== null
    && exposure.namespace_lease_generation !== null
    && exposure.assignment_algorithm === "matched_pair_csprng_bit_v1"
    && exposure.assignment_namespace_sha256 !== null
    && exposure.assignment_arm !== "not_enrolled"
    && exposure.served_arm === exposure.assignment_arm
    && exposure.assignment_reason_codes.length === 2
    && exposure.assignment_reason_codes.includes("confirmatory_active_lease")
    && exposure.assignment_reason_codes.includes(servingReason)
    && exposure.projection_complete
    && exposure.hard_boundary_upgrade_count === 0;
}

const CanonicalTaskSourceSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.enum(["context", "execution_packet_v1", "execution_state_v1"]),
    task_family: BoundedKindSchema,
    task_signature: BoundedIdSchema,
    repository_signature: BoundedIdSchema,
  }).strict(),
  z.object({
    source: z.literal("host_task_envelope_v1"),
    envelope: HostTaskEnvelopeV1Schema,
  }).strict(),
]);

export const CanonicalLearningTaskIdentityV1Schema = z.object({
  tenant_id: BoundedIdSchema,
  public_scope: BoundedIdSchema,
  store_scope: BoundedIdSchema,
  task_family: BoundedKindSchema,
  task_signature: BoundedIdSchema,
  repository_signature: BoundedIdSchema,
  host_task_id: BoundedIdSchema.nullable(),
  source_task_sha256: NullableDigestSchema,
  source_event_sha256: NullableDigestSchema,
}).strict();

export type CanonicalLearningTaskIdentityV1 = Omit<
  z.infer<typeof CanonicalLearningTaskIdentityV1Schema>,
  "public_scope" | "store_scope"
> & { public_scope: PublicScope; store_scope: StoreScope };

export function reconcileCanonicalLearningTaskIdentity(args: {
  tenantId: string;
  publicScope: PublicScope;
  storeScope: StoreScope;
  sources: z.input<typeof CanonicalTaskSourceSchema>[];
}): CanonicalLearningTaskIdentityV1 {
  if (args.sources.length === 0 || args.sources.length > 4) {
    throw new Error("Canonical learning task identity requires 1 to 4 bounded sources");
  }
  const sources = args.sources.map((source) => CanonicalTaskSourceSchema.parse(source));
  if (new Set(sources.map((source) => source.source)).size !== sources.length) {
    throw new Error("Canonical learning task identity accepts each source at most once");
  }
  const normalized = sources.map((source) => source.source === "host_task_envelope_v1"
    ? {
        task_family: source.envelope.task_family,
        task_signature: source.envelope.task_signature,
        repository_signature: source.envelope.repository_signature,
        host_task_id: source.envelope.host_task_id,
        source_task_sha256: source.envelope.source_task_sha256,
        source_event_sha256: source.envelope.source_event_sha256,
      }
    : {
        task_family: source.task_family,
        task_signature: source.task_signature,
        repository_signature: source.repository_signature,
        host_task_id: null,
        source_task_sha256: null,
        source_event_sha256: null,
      });
  const first = normalized[0];
  if (!first) throw new Error("Missing canonical learning task identity source");
  for (const entry of normalized.slice(1)) {
    if (
      entry.task_family !== first.task_family
      || entry.task_signature !== first.task_signature
      || entry.repository_signature !== first.repository_signature
    ) {
      throw new Error("Canonical learning task identity sources disagree");
    }
  }
  const hostEntries = normalized.filter((entry) => entry.host_task_id !== null);
  if (hostEntries.length > 1) {
    const host = hostEntries[0];
    if (hostEntries.some((entry) => stableStringify(entry) !== stableStringify(host))) {
      throw new Error("Host task identity sources disagree");
    }
  }
  const host = hostEntries[0] ?? null;
  const parsed = CanonicalLearningTaskIdentityV1Schema.parse({
    tenant_id: args.tenantId,
    public_scope: args.publicScope,
    store_scope: args.storeScope,
    task_family: first.task_family,
    task_signature: first.task_signature,
    repository_signature: first.repository_signature,
    host_task_id: host?.host_task_id ?? null,
    source_task_sha256: host?.source_task_sha256 ?? null,
    source_event_sha256: host?.source_event_sha256 ?? null,
  });
  return {
    ...parsed,
    public_scope: parsed.public_scope as PublicScope,
    store_scope: parsed.store_scope as StoreScope,
  };
}

function base64Ed25519PublicKey(value: string): boolean {
  try {
    return Buffer.from(value, "base64").byteLength === 32
      && Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

const RuntimeAuthorityAttestorV1Schema = z.object({
  service_identity: BoundedIdSchema,
  attestor_binary_sha256: DigestSha256Schema,
  attestor_policy_sha256: DigestSha256Schema,
  attestor_public_key_base64: z.string().refine(base64Ed25519PublicKey, "Expected canonical 32-byte Ed25519 public key"),
  attestor_public_key_sha256: DigestSha256Schema,
  attestor_key_id: BoundedIdSchema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_base64: z.string().refine(base64Ed25519PublicKey, "Expected canonical 32-byte Ed25519 public key"),
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: BoundedIdSchema,
  receipt_signature_algorithm: z.literal("ed25519-v1"),
  expected_database_instance_id: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  const keys = [
    ["attestor_public_key_base64", "attestor_public_key_sha256"],
    ["service_launcher_public_key_base64", "service_launcher_public_key_sha256"],
  ] as const;
  for (const [keyField, digestField] of keys) {
    const expected = createHash("sha256").update(Buffer.from(value[keyField], "base64")).digest("hex");
    if (value[digestField] !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [digestField],
        message: `${digestField} does not bind the supplied raw Ed25519 public key`,
      });
    }
  }
});

const ExternalExecutionRoleV1Schema = z.object({
  runner_principal_sha256: DigestSha256Schema,
  credential_session_class: z.enum(["eligible_host_adapter", "formal_tool_eval", "immutable_paired_eval"]),
  broker_policy_sha256: DigestSha256Schema,
  broker_binary_sha256: DigestSha256Schema,
  broker_public_key_sha256: DigestSha256Schema,
  broker_key_id: BoundedIdSchema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: BoundedIdSchema,
  supervisor_executable_sha256: DigestSha256Schema,
  supervisor_argv_policy_sha256: DigestSha256Schema,
  supervisor_sandbox_policy_sha256: DigestSha256Schema,
  receipt_signature_algorithm: z.literal("ed25519-v1"),
  credential_scope_sha256: DigestSha256Schema,
  supervisor_bind_ttl_seconds: z.number().int().positive().max(86_400),
  credential_session_hard_ttl_seconds: z.number().int().positive().max(86_400),
  credential_session_heartbeat_seconds: z.number().int().positive().max(3_600),
  credential_session_max_calls: z.number().int().positive().max(100_000),
  per_call_capability_ttl_seconds: z.number().int().positive().max(3_600),
  post_quiesce_finalize_ttl_seconds: z.number().int().positive().max(86_400),
}).strict();

export const ExternalExecutionPolicyV1Schema = z.object({
  policy_version: z.literal("external-execution-v1"),
  runtime_authority_attestor: RuntimeAuthorityAttestorV1Schema,
  roles: z.object({
    offline_paired: ExternalExecutionRoleV1Schema,
    production_shadow: ExternalExecutionRoleV1Schema,
    tool_e2e: ExternalExecutionRoleV1Schema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const expected = {
    offline_paired: "immutable_paired_eval",
    production_shadow: "eligible_host_adapter",
    tool_e2e: "formal_tool_eval",
  } as const;
  for (const roleName of Object.keys(expected) as Array<keyof typeof expected>) {
    if (value.roles[roleName].credential_session_class !== expected[roleName]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles", roleName, "credential_session_class"],
        message: `${roleName} has a fixed credential session class`,
      });
    }
    const role = value.roles[roleName];
    const attestor = value.runtime_authority_attestor;
    const launcherBindings = [
      ["service_launcher_policy_sha256", attestor.service_launcher_policy_sha256],
      ["service_launcher_binary_sha256", attestor.service_launcher_binary_sha256],
      ["service_launcher_public_key_sha256", attestor.service_launcher_public_key_sha256],
      ["service_launcher_key_id", attestor.service_launcher_key_id],
    ] as const;
    for (const [field, canonicalValue] of launcherBindings) {
      if (role[field] !== canonicalValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", roleName, field],
          message: `${roleName} cannot override the global Runtime authority launcher ${field}`,
        });
      }
    }
  }
});

export type ExternalExecutionPolicyV1 = z.infer<typeof ExternalExecutionPolicyV1Schema>;

const ExternalInputV1Schema = z.object({
  immutable_input_manifest_sha256: DigestSha256Schema,
  retry_policy_sha256: DigestSha256Schema,
  planned_run_id: BoundedIdSchema,
}).strict();

export const RequiredExternalInputsV1Schema = z.object({
  offline_paired: ExternalInputV1Schema,
  production_shadow: ExternalInputV1Schema,
  tool_e2e: ExternalInputV1Schema,
}).strict();

export const IntegrityOnlyExternalInputsV1Schema = z.object({}).strict();

export function parseLearningRequiredExternalInputs(
  evidenceIntent: "integrity_only" | "confirmatory",
  value: unknown,
): Record<string, unknown> {
  return evidenceIntent === "confirmatory"
    ? RequiredExternalInputsV1Schema.parse(value)
    : IntegrityOnlyExternalInputsV1Schema.parse(value);
}

export function externalExecutionPolicyDigest(value: ExternalExecutionPolicyV1): string {
  return sha256Hex(stableStringify(ExternalExecutionPolicyV1Schema.parse(value)));
}
