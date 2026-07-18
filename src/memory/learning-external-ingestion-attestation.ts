import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  LearningExternalCanonicalUtcMillisSchema,
  LearningExternalEd25519PublicKeyBase64Schema,
  LearningExternalEd25519SignatureBase64Schema,
  LearningExternalPreclaimHoldReasonSchema,
  learningExternalEd25519PublicKeyDigest,
  verifyLearningExternalReceiptWithExplicitSigner,
} from "./learning-external-authority.js";
import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "./learning-episode-ledger.js";

const MAX_CANONICAL_CONTRACT_BYTES = 1024 * 1024;
const MAX_CANONICAL_ATTESTATION_BYTES = 16 * 1024;

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const SourceCommitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const BoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256
    || containsUnpairedSurrogate(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * V1 evidence remains readable for schema v4, while newly projected evidence
 * binds the current v5 Runtime schema. The concrete version remains inside
 * every signed digest, so accepting the historical value does not alias it to
 * a v5 snapshot.
 */
export const LearningExternalRuntimeWriteSchemaVersionV1Schema = z.union([
  z.literal(4),
  z.literal(5),
]);
const CanonicalUnsigned64DecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u)
  .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn, {
    message: "Expected a canonical unsigned 64-bit decimal integer",
  });

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function canonicalJson<T>(schema: z.ZodType<T>, value: unknown): string {
  return stableStringify(schema.parse(value));
}

function parseCanonicalJson<T>(args: Readonly<{
  contractName: string;
  maxBytes: number;
  raw: string | Uint8Array;
  schema: z.ZodType<T>;
}>): T {
  const byteLength = typeof args.raw === "string"
    ? Buffer.byteLength(args.raw, "utf8")
    : args.raw.byteLength;
  if (byteLength > args.maxBytes) {
    throw new Error(`${args.contractName}_oversized`);
  }
  if (typeof args.raw !== "string"
    && args.raw.byteLength >= 3
    && args.raw[0] === 0xef
    && args.raw[1] === 0xbb
    && args.raw[2] === 0xbf) {
    throw new Error(`${args.contractName}_utf8_bom_forbidden`);
  }
  let raw: string;
  try {
    raw = typeof args.raw === "string"
      ? args.raw
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(args.raw);
  } catch {
    throw new Error(`${args.contractName}_invalid_utf8`);
  }
  if (raw.startsWith("\ufeff")) {
    throw new Error(`${args.contractName}_utf8_bom_forbidden`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${args.contractName}_invalid_json`);
  }
  const parsed = args.schema.parse(decoded);
  if (stableStringify(parsed) !== raw) {
    throw new Error(`${args.contractName}_noncanonical_json`);
  }
  return parsed;
}

function addBindingIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

export const LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS = Object.freeze([
  Object.freeze({
    role: "offline_paired",
    artifact_kind: "offline_paired_rerun",
  }),
  Object.freeze({
    role: "production_shadow",
    artifact_kind: "production_shadow_gate",
  }),
  Object.freeze({
    role: "tool_e2e",
    artifact_kind: "tool_e2e_gate",
  }),
] as const);

export const LEARNING_EXTERNAL_ATTESTATION_ROLE_ORDER = Object.freeze(
  LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.map(({ role }) => role),
);

export const LearningExternalAttestationRoleV1Schema = z.enum([
  "offline_paired",
  "production_shadow",
  "tool_e2e",
]);

export type LearningExternalAttestationRoleV1 = z.infer<
  typeof LearningExternalAttestationRoleV1Schema
>;

const LEARNING_EXTERNAL_INGESTION_LEDGER_REPLAY_TABLE_COUNT_SHAPE_V1 =
  Object.freeze({
    lite_learning_authorization_nonces: NonNegativeSafeIntegerSchema,
    lite_learning_collection_principal_bindings: NonNegativeSafeIntegerSchema,
    lite_learning_confirmatory_attempts: NonNegativeSafeIntegerSchema,
    lite_learning_control_jobs: NonNegativeSafeIntegerSchema,
    lite_learning_episode_events: NonNegativeSafeIntegerSchema,
    lite_learning_evidence_artifacts: NonNegativeSafeIntegerSchema,
    lite_learning_experiment_closures: NonNegativeSafeIntegerSchema,
    lite_learning_experiment_revisions: NonNegativeSafeIntegerSchema,
    lite_learning_exposure_items: NonNegativeSafeIntegerSchema,
    lite_learning_external_holdout_members: NonNegativeSafeIntegerSchema,
    lite_learning_external_preclaim_holds: NonNegativeSafeIntegerSchema,
    lite_learning_external_run_claims: NonNegativeSafeIntegerSchema,
    lite_learning_external_run_reservations: NonNegativeSafeIntegerSchema,
    lite_learning_external_session_terminations: NonNegativeSafeIntegerSchema,
    lite_learning_external_supervisor_bindings: NonNegativeSafeIntegerSchema,
    lite_learning_external_ticket_consumptions: NonNegativeSafeIntegerSchema,
    lite_learning_feedback_attributions: NonNegativeSafeIntegerSchema,
    lite_learning_gate_artifact_memberships: NonNegativeSafeIntegerSchema,
    lite_learning_gate_decisions: NonNegativeSafeIntegerSchema,
    lite_learning_gate_look_reservations: NonNegativeSafeIntegerSchema,
    lite_learning_host_use_receipts: NonNegativeSafeIntegerSchema,
    lite_learning_namespace_leases: NonNegativeSafeIntegerSchema,
    lite_learning_policy_versions: NonNegativeSafeIntegerSchema,
    lite_learning_randomization_pairs: NonNegativeSafeIntegerSchema,
    lite_runtime_authority_identity: NonNegativeSafeIntegerSchema,
  });

export const LEARNING_EXTERNAL_INGESTION_LEDGER_REPLAY_TABLE_NAMES_V1 =
  Object.freeze(Object.keys(
    LEARNING_EXTERNAL_INGESTION_LEDGER_REPLAY_TABLE_COUNT_SHAPE_V1,
  ));

export const LearningExternalIngestionLedgerReplayTableCountsV1Schema = z.object(
  LEARNING_EXTERNAL_INGESTION_LEDGER_REPLAY_TABLE_COUNT_SHAPE_V1,
).strict();

const LearningExternalIngestionLedgerReplayV1Schema = z.object({
  verifier_id: z.literal("aionis_lite_learning_ledger_replay"),
  verifier_version: z.literal(1),
  table_counts: LearningExternalIngestionLedgerReplayTableCountsV1Schema,
  protected_event_count: NonNegativeSafeIntegerSchema,
  legacy_event_count: NonNegativeSafeIntegerSchema,
  promotion_eligible_exposure_count: NonNegativeSafeIntegerSchema,
  control_job_count: NonNegativeSafeIntegerSchema,
  control_job_dead_letter_count: NonNegativeSafeIntegerSchema,
  control_job_expired_lease_count: NonNegativeSafeIntegerSchema,
}).strict().superRefine((value, context) => {
  const eventRowCount = value.table_counts.lite_learning_episode_events;
  if (BigInt(value.protected_event_count) + BigInt(value.legacy_event_count)
    !== BigInt(eventRowCount)) {
    addBindingIssue(
      context,
      ["table_counts", "lite_learning_episode_events"],
      "Episode table count must equal protected plus legacy replay event counts",
    );
  }
  if (value.promotion_eligible_exposure_count > value.protected_event_count) {
    addBindingIssue(
      context,
      ["promotion_eligible_exposure_count"],
      "Promotion-eligible exposure count cannot exceed protected replay events",
    );
  }
  const controlJobRowCount = value.table_counts.lite_learning_control_jobs;
  if (value.control_job_count !== controlJobRowCount) {
    addBindingIssue(
      context,
      ["table_counts", "lite_learning_control_jobs"],
      "Control-job table count must equal the replay control-job count",
    );
  }
  if (BigInt(value.control_job_dead_letter_count)
    + BigInt(value.control_job_expired_lease_count) > BigInt(value.control_job_count)) {
    addBindingIssue(
      context,
      ["control_job_dead_letter_count"],
      "Dead-letter and expired-lease job classes cannot exceed all control jobs",
    );
  }
});

export const LearningExternalIngestionLedgerVerificationV1Schema = z.object({
  contract_version: z.literal(
    "aionis_learning_external_ingestion_ledger_verification_v1",
  ),
  schema_component: z.literal("write_projection"),
  schema_version: LearningExternalRuntimeWriteSchemaVersionV1Schema,
  database_instance_id: DigestSha256Schema,
  checked_at: LearningExternalCanonicalUtcMillisSchema,
  ledger_verifier_id: z.literal("aionis_lite_learning_ledger_replay"),
  ledger_verifier_version: z.literal(1),
  replay: LearningExternalIngestionLedgerReplayV1Schema,
}).strict().superRefine((value, context) => {
  if (value.ledger_verifier_id !== value.replay.verifier_id) {
    addBindingIssue(
      context,
      ["ledger_verifier_id"],
      "Ledger verification and replay verifier identifiers must agree",
    );
  }
  if (value.ledger_verifier_version !== value.replay.verifier_version) {
    addBindingIssue(
      context,
      ["ledger_verifier_version"],
      "Ledger verification and replay verifier versions must agree",
    );
  }
});

export type LearningExternalIngestionLedgerVerificationV1 = z.infer<
  typeof LearningExternalIngestionLedgerVerificationV1Schema
>;

export function learningExternalIngestionLedgerVerificationJson(value: unknown): string {
  return canonicalJson(LearningExternalIngestionLedgerVerificationV1Schema, value);
}

export function learningExternalIngestionLedgerVerificationDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningExternalIngestionLedgerVerificationJson(value))
    .digest("hex");
}

export function parseCanonicalLearningExternalIngestionLedgerVerificationJson(
  raw: string | Uint8Array,
): LearningExternalIngestionLedgerVerificationV1 {
  return parseCanonicalJson({
    contractName: "learning_external_ingestion_ledger_verification",
    maxBytes: MAX_CANONICAL_CONTRACT_BYTES,
    raw,
    schema: LearningExternalIngestionLedgerVerificationV1Schema,
  });
}

const LearningExternalCoverageTerminalFactTimeV1Schema = z.discriminatedUnion(
  "branch_kind",
  [
    z.object({
      role: LearningExternalAttestationRoleV1Schema,
      branch_kind: z.literal("result"),
      ingest_operation_created_at: LearningExternalCanonicalUtcMillisSchema,
    }).strict(),
    z.object({
      role: LearningExternalAttestationRoleV1Schema,
      branch_kind: z.literal("termination_hold"),
      terminated_at: LearningExternalCanonicalUtcMillisSchema,
    }).strict(),
    z.object({
      role: LearningExternalAttestationRoleV1Schema,
      branch_kind: z.literal("preclaim_hold"),
      held_at: LearningExternalCanonicalUtcMillisSchema,
    }).strict(),
  ],
);

const LearningExternalCoverageFinalizedAtInputV1Schema = z.object({
  revision_created_at: LearningExternalCanonicalUtcMillisSchema,
  confirmatory_attempt_created_at: LearningExternalCanonicalUtcMillisSchema,
  terminal_facts: z.array(LearningExternalCoverageTerminalFactTimeV1Schema).max(3),
}).strict().superRefine((value, context) => {
  let previousRoleIndex = -1;
  for (const [index, fact] of value.terminal_facts.entries()) {
    const roleIndex = LEARNING_EXTERNAL_ATTESTATION_ROLE_ORDER.indexOf(fact.role);
    if (roleIndex <= previousRoleIndex) {
      addBindingIssue(
        context,
        ["terminal_facts", index, "role"],
        "Terminal facts must be unique and use the fixed external role order",
      );
    }
    previousRoleIndex = roleIndex;
  }
});

export function learningExternalTerminalCoverageFinalizedAtFromDatabaseFacts(
  value: unknown,
): string {
  const parsed = LearningExternalCoverageFinalizedAtInputV1Schema.parse(value);
  const times = [
    parsed.revision_created_at,
    parsed.confirmatory_attempt_created_at,
    ...parsed.terminal_facts.map((fact) => {
      if (fact.branch_kind === "result") return fact.ingest_operation_created_at;
      if (fact.branch_kind === "termination_hold") return fact.terminated_at;
      return fact.held_at;
    }),
  ];
  return times.reduce((latest, candidate) => candidate > latest ? candidate : latest);
}

export const LEARNING_EXTERNAL_INGESTION_SEMANTIC_RULES_V1 = Object.freeze({
  contract_version: "aionis_learning_external_ingestion_semantic_rules_v1",
  d2_output_authority: "unsigned_draft_not_signable",
  revision_row_sha256:
    "typed_full_lite_learning_experiment_revisions_authority_row_sha256_v1",
  ledger_verification_sha256:
    "canonical_aionis_learning_external_ingestion_ledger_verification_v1_sha256",
  coverage_finalized_at:
    "canonical_max_of_revision_attempt_and_db_terminal_fact_times_v1",
  coverage_finality: "d3_launcher_write_fence_capability_required",
  termination_hold_bundle_sha256:
    "d3_verified_tracked_bundle_capability_required",
  preclaim_hold_bundle_sha256:
    "d3_verified_tracked_bundle_capability_required",
  raw_caller_hold_bundle_digest: "forbidden",
  physical_database_lineage: "d3_launcher_database_binding_capability_required",
  database_binding_receipt_sha256:
    "d3_launcher_database_binding_capability_required",
  signature_authority: "d3_private_signer_only_after_all_claims_verified",
} as const);

const LearningExternalAttestationArtifactKindV1Schema = z.enum([
  "offline_paired_rerun",
  "production_shadow_gate",
  "tool_e2e_gate",
]);

const LearningExternalResultStatusV1Schema = z.enum([
  "passed",
  "failed",
  "inconclusive",
]);

const LearningExternalAbnormalTerminationReasonV1Schema = z.enum([
  "launch_failure",
  "binding_integrity_failure",
  "runner_crash",
  "lease_expired",
  "operator_revoke",
  "post_quiesce_revoke",
  "finalize_timeout",
]);

function assertFixedRoleOrder(
  values: ReadonlyArray<Readonly<{
    role: LearningExternalAttestationRoleV1;
    artifact_kind: string;
  }>>,
  context: z.RefinementCtx,
  path: string,
): void {
  if (values.length !== LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.length) {
    addBindingIssue(context, [path], "All three required external roles must be present");
    return;
  }
  for (const [index, expected] of LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.entries()) {
    const actual = values[index];
    if (actual?.role !== expected.role || actual.artifact_kind !== expected.artifact_kind) {
      addBindingIssue(
        context,
        [path, index],
        "Required external roles and artifact kinds must use the fixed canonical order",
      );
    }
  }
}

const RequiredSeriesIdentityShape = {
  role: LearningExternalAttestationRoleV1Schema,
  artifact_kind: LearningExternalAttestationArtifactKindV1Schema,
  evidence_series_id: BoundedIdSchema,
} as const;

const RequiredSeriesResultStatusV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("result"),
  artifact_status: LearningExternalResultStatusV1Schema,
}).strict();

const RequiredSeriesTerminationHoldStatusV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("termination_hold"),
  termination_reason: LearningExternalAbnormalTerminationReasonV1Schema,
}).strict();

const RequiredSeriesPreclaimHoldStatusV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("preclaim_hold"),
  preclaim_hold_reason: LearningExternalPreclaimHoldReasonSchema,
}).strict();

const RequiredSeriesUnstartedStatusV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("unstarted"),
}).strict();

export const LearningExternalRequiredSeriesStatusEntryV1Schema = z.discriminatedUnion(
  "branch_kind",
  [
    RequiredSeriesResultStatusV1Schema,
    RequiredSeriesTerminationHoldStatusV1Schema,
    RequiredSeriesPreclaimHoldStatusV1Schema,
    RequiredSeriesUnstartedStatusV1Schema,
  ],
);

export const LearningExternalRequiredSeriesStatusV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_required_series_status_v1"),
  tenant_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: PositiveSafeIntegerSchema,
  required_evidence_series_sha256: DigestSha256Schema,
  series: z.array(LearningExternalRequiredSeriesStatusEntryV1Schema).length(3),
}).strict().superRefine((value, context) => {
  assertFixedRoleOrder(value.series, context, "series");
});

export type LearningExternalRequiredSeriesStatusV1 = z.infer<
  typeof LearningExternalRequiredSeriesStatusV1Schema
>;

export function learningExternalRequiredSeriesStatusJson(value: unknown): string {
  return canonicalJson(LearningExternalRequiredSeriesStatusV1Schema, value);
}

export function learningExternalRequiredSeriesStatusDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningExternalRequiredSeriesStatusJson(value))
    .digest("hex");
}

export function parseCanonicalLearningExternalRequiredSeriesStatusJson(
  raw: string | Uint8Array,
): LearningExternalRequiredSeriesStatusV1 {
  return parseCanonicalJson({
    contractName: "learning_external_required_series_status",
    maxBytes: MAX_CANONICAL_CONTRACT_BYTES,
    raw,
    schema: LearningExternalRequiredSeriesStatusV1Schema,
  });
}

export const TerminalCoverageResultBranchV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("result"),
  artifact_status: LearningExternalResultStatusV1Schema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  session_termination_id: BoundedIdSchema,
  session_termination_sha256: DigestSha256Schema,
  report_sha256: DigestSha256Schema,
  public_run_authority_sha256: DigestSha256Schema,
  run_bundle_manifest_sha256: DigestSha256Schema,
  run_bundle_archive_sha256: DigestSha256Schema,
  bundle_commit_id: SourceCommitIdSchema,
  artifact_count: z.literal(1),
  ingest_operation_count: z.literal(1),
  current_series_head_count: z.literal(1),
}).strict();

export const TerminalCoverageTerminationHoldBranchV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("termination_hold"),
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema.nullable(),
  session_termination_id: BoundedIdSchema,
  session_termination_sha256: DigestSha256Schema,
  termination_reason: LearningExternalAbnormalTerminationReasonV1Schema,
  termination_hold_bundle_sha256: DigestSha256Schema,
  artifact_count: z.literal(0),
  ingest_operation_count: z.literal(0),
  current_series_head_count: z.literal(0),
}).strict();

export const TerminalCoveragePreclaimHoldBranchV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("preclaim_hold"),
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  preclaim_hold_id: BoundedIdSchema,
  preclaim_hold_sha256: DigestSha256Schema,
  zero_effects_proof_sha256: DigestSha256Schema,
  preclaim_hold_reason: LearningExternalPreclaimHoldReasonSchema,
  preclaim_hold_bundle_sha256: DigestSha256Schema,
  claim_count: z.literal(0),
  supervisor_binding_count: z.literal(0),
  session_termination_count: z.literal(0),
  artifact_count: z.literal(0),
  ingest_operation_count: z.literal(0),
  current_series_head_count: z.literal(0),
}).strict();

export const TerminalCoverageUnstartedBranchV1Schema = z.object({
  ...RequiredSeriesIdentityShape,
  branch_kind: z.literal("unstarted"),
  reservation_count: z.literal(0),
  ticket_consumption_count: z.literal(0),
  preclaim_hold_count: z.literal(0),
  claim_count: z.literal(0),
  supervisor_binding_count: z.literal(0),
  session_termination_count: z.literal(0),
  artifact_count: z.literal(0),
  ingest_operation_count: z.literal(0),
  current_series_head_count: z.literal(0),
}).strict();

export const LearningExternalTerminalCoverageBranchV1Schema = z.discriminatedUnion(
  "branch_kind",
  [
    TerminalCoverageResultBranchV1Schema,
    TerminalCoverageTerminationHoldBranchV1Schema,
    TerminalCoveragePreclaimHoldBranchV1Schema,
    TerminalCoverageUnstartedBranchV1Schema,
  ],
);

export const LearningExternalTerminalCoverageIndexV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_terminal_coverage_index_v1"),
  tenant_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: PositiveSafeIntegerSchema,
  required_evidence_series_sha256: DigestSha256Schema,
  branches: z.array(LearningExternalTerminalCoverageBranchV1Schema).length(3),
  finalized_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  assertFixedRoleOrder(value.branches, context, "branches");
  for (const [index, branch] of value.branches.entries()) {
    if (branch.branch_kind !== "termination_hold") continue;
    const requiresNoBinding = branch.termination_reason === "launch_failure"
      || branch.termination_reason === "binding_integrity_failure";
    const requiresBinding = branch.termination_reason === "runner_crash"
      || branch.termination_reason === "post_quiesce_revoke"
      || branch.termination_reason === "finalize_timeout";
    if ((requiresNoBinding && branch.supervisor_binding_id !== null)
      || (requiresBinding && branch.supervisor_binding_id === null)) {
      addBindingIssue(
        context,
        ["branches", index, "supervisor_binding_id"],
        "Termination-hold reason does not match the Runtime lifecycle binding shape",
      );
    }
  }
});

export type LearningExternalTerminalCoverageIndexV1 = z.infer<
  typeof LearningExternalTerminalCoverageIndexV1Schema
>;

export function learningExternalTerminalCoverageIndexJson(value: unknown): string {
  return canonicalJson(LearningExternalTerminalCoverageIndexV1Schema, value);
}

export function learningExternalTerminalCoverageIndexDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningExternalTerminalCoverageIndexJson(value))
    .digest("hex");
}

export function parseCanonicalLearningExternalTerminalCoverageIndexJson(
  raw: string | Uint8Array,
): LearningExternalTerminalCoverageIndexV1 {
  return parseCanonicalJson({
    contractName: "learning_external_terminal_coverage_index",
    maxBytes: MAX_CANONICAL_CONTRACT_BYTES,
    raw,
    schema: LearningExternalTerminalCoverageIndexV1Schema,
  });
}

const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_PRIMARY_KEY_SPECS = Object.freeze([
  Object.freeze({
    table: "lite_learning_policy_versions",
    primary_key: Object.freeze(["tenant_id", "policy_kind", "policy_id", "policy_version"]),
  }),
  Object.freeze({
    table: "lite_learning_collection_principal_bindings",
    primary_key: Object.freeze(["tenant_id", "collection_principal_sha256"]),
  }),
  Object.freeze({
    table: "lite_learning_experiment_revisions",
    primary_key: Object.freeze(["tenant_id", "experiment_id", "experiment_revision"]),
  }),
  Object.freeze({
    table: "lite_learning_confirmatory_attempts",
    primary_key: Object.freeze(["tenant_id", "confirmatory_attempt_id"]),
  }),
  Object.freeze({
    table: "lite_learning_randomization_pairs",
    primary_key: Object.freeze([
      "tenant_id", "confirmatory_attempt_id", "randomization_pair_sha256",
    ]),
  }),
  Object.freeze({
    table: "lite_learning_experiment_closures",
    primary_key: Object.freeze(["tenant_id", "experiment_close_id"]),
  }),
  Object.freeze({
    table: "lite_learning_authorization_nonces",
    primary_key: Object.freeze(["tenant_id", "authorization_key_id", "authorization_nonce"]),
  }),
  Object.freeze({ table: "lite_learning_episode_events", primary_key: Object.freeze(["row_id"]) }),
  Object.freeze({
    table: "lite_learning_exposure_items",
    primary_key: Object.freeze(["tenant_id", "scope", "event_id", "memory_id"]),
  }),
  Object.freeze({
    table: "lite_learning_feedback_attributions",
    primary_key: Object.freeze(["tenant_id", "scope", "event_id", "subject_kind", "subject_id"]),
  }),
  Object.freeze({
    table: "lite_learning_host_use_receipts",
    primary_key: Object.freeze(["tenant_id", "scope", "receipt_id"]),
  }),
  Object.freeze({
    table: "lite_learning_external_run_reservations",
    primary_key: Object.freeze(["row_id"]),
  }),
  Object.freeze({
    table: "lite_learning_external_holdout_members",
    primary_key: Object.freeze(["tenant_id", "reservation_id", "case_ordinal"]),
  }),
  Object.freeze({
    table: "lite_learning_external_ticket_consumptions",
    primary_key: Object.freeze(["tenant_id", "consumption_id"]),
  }),
  Object.freeze({
    table: "lite_learning_external_preclaim_holds",
    primary_key: Object.freeze(["tenant_id", "hold_id"]),
  }),
  Object.freeze({
    table: "lite_learning_external_run_claims",
    primary_key: Object.freeze(["tenant_id", "claim_id"]),
  }),
  Object.freeze({
    table: "lite_learning_external_supervisor_bindings",
    primary_key: Object.freeze(["tenant_id", "binding_id"]),
  }),
  Object.freeze({
    table: "lite_learning_external_session_terminations",
    primary_key: Object.freeze(["tenant_id", "termination_id"]),
  }),
  Object.freeze({ table: "lite_learning_evidence_artifacts", primary_key: Object.freeze(["row_id"]) }),
  Object.freeze({
    table: "lite_learning_gate_look_reservations",
    primary_key: Object.freeze(["row_id"]),
  }),
  Object.freeze({ table: "lite_learning_gate_decisions", primary_key: Object.freeze(["row_id"]) }),
  Object.freeze({
    table: "lite_learning_gate_artifact_memberships",
    primary_key: Object.freeze(["tenant_id", "decision_id", "artifact_id"]),
  }),
] as const);

/*
 * This is a versioned wire manifest, not a view over the store module. Keeping
 * the complete v4 column order here prevents a later store migration from
 * silently changing what an already-issued v1 authority-head digest means.
 */
const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_COLUMNS = Object.freeze({
  lite_learning_policy_versions: Object.freeze([
    "tenant_id", "policy_kind", "policy_id", "policy_version", "policy_config_sha256",
    "policy_config_json", "implementation_contract_sha256",
    "prospective_calibration_sha256", "prospective_calibration_json", "created_at",
  ]),
  lite_learning_collection_principal_bindings: Object.freeze([
    "tenant_id", "collection_principal_sha256", "collection_class", "collector_id",
    "collector_version", "verifier_policy_sha256", "verifier_policy_json", "binding_sha256",
    "created_at",
  ]),
  lite_learning_experiment_revisions: Object.freeze([
    "tenant_id", "experiment_id", "experiment_revision", "profile_id", "profile_rule_sha256",
    "serving_phase", "evidence_intent", "eligible_memory_namespace_set_sha256",
    "eligible_memory_namespace_count", "assignment_design", "randomization_pair_manifest_sha256",
    "randomization_pair_count", "activation_schedule_sha256", "candidate_policy_id",
    "candidate_policy_version", "candidate_policy_implementation_sha256",
    "candidate_policy_config_sha256", "assignment_unit_kind", "candidate_allocation_bps",
    "diagnostic_assignment_seed", "diagnostic_assignment_seed_sha256",
    "confirmatory_assignment_bits", "confirmatory_assignment_bit_count",
    "confirmatory_assignment_bits_sha256", "collection_source_policy_sha256",
    "collection_source_policy_json", "gate_policy_id", "gate_policy_version",
    "gate_policy_config_sha256", "gate_prospective_calibration_sha256",
    "required_evidence_series_sha256", "required_evidence_series_json",
    "required_external_inputs_sha256", "required_external_inputs_json",
    "external_execution_policy_sha256", "external_execution_policy_json", "safety_pause_mode",
    "config_sha256", "config_json", "created_at",
  ]),
  lite_learning_confirmatory_attempts: Object.freeze([
    "tenant_id", "confirmatory_attempt_id", "task_family", "candidate_policy_id",
    "candidate_policy_version", "candidate_policy_implementation_sha256", "experiment_id",
    "experiment_revision", "gate_policy_id", "gate_policy_version", "gate_policy_config_sha256",
    "eligible_memory_namespace_set_sha256", "eligible_memory_namespace_count",
    "planned_candidate_namespace_count", "planned_control_namespace_count",
    "randomization_pair_manifest_sha256", "randomization_pair_count", "activation_schedule_sha256",
    "attempt_sha256", "created_by", "created_at",
  ]),
  lite_learning_randomization_pairs: Object.freeze([
    "tenant_id", "confirmatory_attempt_id", "randomization_pair_sha256", "pair_ordinal",
    "member_0_memory_namespace_sha256", "member_1_memory_namespace_sha256",
    "matching_covariate_sha256", "matching_covariate_json", "activation_wave_index",
    "activation_starts_at", "index_window_ends_at", "wave_analysis_at", "pair_record_sha256",
    "created_at",
  ]),
  lite_learning_experiment_closures: Object.freeze([
    "tenant_id", "experiment_close_id", "confirmatory_attempt_id", "experiment_id",
    "experiment_revision", "namespace_set_sha256", "sealed_event_head_row_id", "close_reason",
    "authorization_sha256", "authorization_payload_json", "authorization_mac",
    "authorization_nonce", "authorization_expires_at", "authorization_key_id", "approved_by",
    "authority_operation_id", "authority_operation_scope", "authority_operation_kind",
    "close_sha256", "created_by", "created_at",
  ]),
  lite_learning_authorization_nonces: Object.freeze([
    "tenant_id", "authorization_key_id", "authorization_nonce", "authorization_kind",
    "authority_ref_id", "authorization_sha256", "created_at",
  ]),
  lite_learning_episode_events: Object.freeze([
    "row_id", "tenant_id", "scope", "event_id", "episode_id", "episode_sequence", "event_kind",
    "source_kind", "source_id", "source_sha256", "previous_event_sha256", "event_sha256",
    "payload_sha256", "payload_json", "item_set_sha256", "source_commit_id",
    "supersedes_event_id", "operation_id", "run_id", "collection_class",
    "collection_principal_sha256", "collector_id", "collector_version", "host_task_id",
    "host_source_task_sha256", "host_source_event_sha256", "host_task_envelope_created_at",
    "host_task_envelope_sha256", "task_family", "task_signature_sha256",
    "repo_signature_sha256", "memory_namespace_sha256", "namespace_set_sha256",
    "namespace_lease_id", "namespace_lease_generation", "profile_id", "experiment_id",
    "experiment_revision", "enrollment_state", "serving_phase", "evidence_intent",
    "assignment_mode", "assignment_unit_sha256", "assignment_namespace_sha256",
    "assignment_bucket", "randomization_pair_sha256", "matching_covariate_sha256",
    "pair_member_ordinal", "activation_wave_index", "activation_starts_at", "index_window_ends_at",
    "wave_analysis_at", "assignment_arm", "served_arm", "candidate_policy_id",
    "candidate_policy_version", "policy_affected", "predecision_track", "projection_complete",
    "promotion_eligible", "recorded_at",
  ]),
  lite_learning_exposure_items: Object.freeze([
    "tenant_id", "scope", "event_id", "episode_id", "memory_id", "decision_completeness",
    "memory_type", "source_backend", "recorded_action", "candidate_action", "served_action",
    "policy_changed", "hard_boundary_preserved", "prior_supported_use_count",
    "prior_contradicted_use_count", "prior_rehydrate_requested_count", "prior_effect_state",
    "repeated_negative_posture", "learning_track", "track_reason", "item_sha256",
  ]),
  lite_learning_feedback_attributions: Object.freeze([
    "tenant_id", "scope", "event_id", "episode_id", "subject_kind", "subject_id", "outcome",
    "action_outcome", "used_surface", "exposure_action", "boundary_outcome",
    "attribution_strength", "evidence_class", "host_use_receipt_id", "host_use_receipt_sha256",
    "receipt_item_sha256", "host_task_envelope_sha256", "collection_principal_sha256",
    "collector_id", "collector_version", "content_evidence_sha256", "verifier_kind",
    "verifier_version", "verifier_config_sha256", "verifier_status", "tool_status",
    "runtime_signal_refs_sha256", "item_sha256",
  ]),
  lite_learning_host_use_receipts: Object.freeze([
    "tenant_id", "scope", "receipt_id", "episode_id", "feedback_event_id", "operation_id",
    "run_id", "host_task_id", "host_task_envelope_sha256", "collection_principal_sha256",
    "collector_id", "collector_version", "host_trace_sha256", "observed_at", "received_at",
    "item_count", "item_set_sha256", "receipt_sha256", "receipt_payload_json", "verifier_status",
  ]),
  lite_learning_external_run_reservations: Object.freeze([
    "row_id", "tenant_id", "reservation_id", "artifact_kind", "evidence_series_id",
    "task_family", "candidate_policy_id", "candidate_policy_version",
    "candidate_policy_implementation_sha256", "candidate_policy_config_sha256",
    "applicable_experiment_id", "applicable_experiment_revision", "gate_policy_id",
    "gate_policy_version", "gate_policy_config_sha256", "applicability_manifest_sha256",
    "harness_bundle_sha256", "source_snapshot_sha256", "case_set_sha256",
    "holdout_membership_projection_sha256", "sealed_holdout_ref_sha256",
    "sealed_holdout_ciphertext_sha256", "execution_profile_sha256", "model_identity_sha256",
    "immutable_model_snapshot_sha256", "tool_manifest_sha256", "execution_order_sha256",
    "retry_policy_sha256", "retry_policy_json", "immutable_input_manifest_sha256",
    "immutable_input_manifest_json", "expected_runner_principal_sha256",
    "credential_broker_policy_sha256", "service_launcher_policy_sha256",
    "service_launcher_binary_sha256", "service_launcher_key_id", "supervisor_executable_sha256",
    "supervisor_argv_policy_sha256", "supervisor_sandbox_policy_sha256",
    "credential_session_class", "run_id", "reserve_operation_id", "runner_ticket_sha256",
    "reservation_sha256", "reserved_at",
  ]),
  lite_learning_external_holdout_members: Object.freeze([
    "tenant_id", "reservation_id", "task_family", "case_ordinal", "case_identity_sha256",
    "task_id_sha256", "content_workflow_sha256", "store_scope_sha256", "source_event_sha256",
    "source_evidence_sha256", "member_record_sha256", "created_at",
  ]),
  lite_learning_external_ticket_consumptions: Object.freeze([
    "tenant_id", "consumption_id", "reservation_id", "runner_ticket_sha256",
    "runner_principal_sha256", "broker_process_nonce_sha256", "consume_operation_id",
    "consumed_at", "consumption_sha256",
  ]),
  lite_learning_external_preclaim_holds: Object.freeze([
    "tenant_id", "hold_id", "reservation_id", "ticket_consumption_id", "hold_reason",
    "triggering_terminal_fact_sha256", "zero_effects_proof_sha256",
    "broker_preclaim_hold_receipt_sha256", "broker_preclaim_hold_receipt_json",
    "broker_preclaim_hold_receipt_signature", "hold_actor_id", "hold_operation_id", "held_at",
    "hold_sha256",
  ]),
  lite_learning_external_run_claims: Object.freeze([
    "tenant_id", "claim_id", "reservation_id", "ticket_consumption_id",
    "ticket_consumption_sha256", "runner_principal_sha256", "runner_execution_nonce_sha256",
    "credential_broker_receipt_sha256", "credential_broker_policy_sha256",
    "credential_broker_binary_sha256", "credential_broker_key_id",
    "credential_broker_receipt_json", "credential_broker_receipt_signature",
    "credential_session_id_sha256", "supervisor_bind_expires_at",
    "credential_session_expires_at", "credential_session_heartbeat_seconds",
    "credential_session_max_calls", "claim_operation_id", "claimed_at", "claim_sha256",
  ]),
  lite_learning_external_supervisor_bindings: Object.freeze([
    "tenant_id", "binding_id", "reservation_id", "ticket_consumption_id", "claim_id",
    "credential_session_id_sha256", "runner_principal_sha256",
    "supervisor_process_identity_sha256", "supervisor_executable_sha256",
    "supervisor_argv_sha256", "inherited_channel_sha256", "service_launcher_receipt_sha256",
    "service_launcher_policy_sha256", "service_launcher_binary_sha256", "service_launcher_key_id",
    "supervisor_sandbox_policy_sha256", "broker_binding_receipt_sha256",
    "broker_binding_receipt_json", "broker_binding_receipt_signature", "bind_operation_id",
    "bound_at", "binding_sha256",
  ]),
  lite_learning_external_session_terminations: Object.freeze([
    "tenant_id", "termination_id", "reservation_id", "ticket_consumption_id", "claim_id",
    "supervisor_binding_id", "credential_session_id_sha256", "termination_reason",
    "broker_quiesce_receipt_sha256", "runner_output_manifest_sha256",
    "terminal_run_manifest_sha256", "attempt_chain_sha256", "credential_broker_policy_sha256",
    "credential_broker_binary_sha256", "credential_broker_key_id",
    "broker_terminal_receipt_sha256", "broker_terminal_receipt_json",
    "broker_terminal_receipt_signature", "termination_actor_id", "terminate_operation_id",
    "terminated_at", "termination_sha256",
  ]),
  lite_learning_evidence_artifacts: Object.freeze([
    "row_id", "tenant_id", "artifact_id", "artifact_kind", "evidence_series_id",
    "external_run_reservation_id", "external_ticket_consumption_id", "external_run_claim_id",
    "external_supervisor_binding_id", "external_session_termination_id",
    "supersedes_artifact_id", "artifact_status", "task_family", "candidate_policy_id",
    "candidate_policy_version", "candidate_policy_implementation_sha256",
    "candidate_policy_config_sha256", "applicable_experiment_id",
    "applicable_experiment_revision", "source_experiment_id", "source_experiment_revision",
    "source_serving_phase", "look_index", "look_proposal_sha256", "gate_policy_id",
    "gate_policy_version", "gate_policy_config_sha256", "evidence_scope_set_sha256",
    "source_bundle_sha256", "harness_bundle_sha256", "report_sha256", "report_json",
    "source_ref", "source_commit_id", "collected_at", "ingested_at", "created_by",
  ]),
  lite_learning_gate_look_reservations: Object.freeze([
    "row_id", "tenant_id", "reservation_id", "operation_id", "task_family",
    "candidate_policy_id", "candidate_policy_version", "candidate_policy_implementation_sha256",
    "experiment_id", "experiment_revision", "gate_policy_id", "gate_policy_version",
    "gate_policy_config_sha256", "look_schedule_sha256", "randomization_pair_manifest_sha256",
    "activation_schedule_sha256", "look_index", "target_cumulative_pair_count", "analysis_at",
    "evidence_cutoff_event_row_id", "evidence_artifact_cutoff_row_id",
    "candidate_scheduled_namespace_count", "control_scheduled_namespace_count",
    "candidate_index_exposure_count", "control_index_exposure_count", "candidate_no_index_count",
    "control_no_index_count", "candidate_verified_receipt_count", "control_verified_receipt_count",
    "runtime_integrity_artifact_id", "runtime_integrity_report_sha256",
    "runtime_integrity_run_bundle_sha256", "required_artifact_heads_sha256",
    "trigger_basis_sha256", "trigger_basis_json", "reservation_sha256", "created_by", "created_at",
  ]),
  lite_learning_gate_decisions: Object.freeze([
    "row_id", "tenant_id", "decision_id", "task_family", "candidate_policy_id",
    "candidate_policy_version", "candidate_policy_implementation_sha256", "experiment_id",
    "experiment_revision", "gate_policy_id", "gate_policy_version", "look_index",
    "look_reservation_id", "look_reservation_sha256", "decision_kind", "evidence_verdict",
    "authority_action", "authority_scope", "analysis_at", "evidence_cutoff_event_row_id",
    "evidence_artifact_cutoff_row_id", "evidence_artifact_count", "experiment_config_sha256",
    "evidence_scope_set_sha256", "evidence_cohort_sha256", "evidence_artifact_set_sha256",
    "evidence_summary_sha256", "evidence_summary_json", "decision_sha256", "trigger_ref_kind",
    "trigger_ref_id", "trigger_episode_id", "supersedes_decision_id",
    "basis_evidence_decision_id", "authority_mutation_id", "source_commit_id",
    "adjudication_observed_event_head_row_id", "adjudication_observed_artifact_head_row_id",
    "post_cutoff_safety_sha256", "authorization_kind", "authorization_sha256",
    "authorization_payload_json", "authorization_mac", "authorization_nonce",
    "authorization_expires_at", "authorization_key_id", "approved_by", "authority_operation_id",
    "authority_operation_scope", "authority_operation_kind", "created_by", "created_at",
  ]),
  lite_learning_gate_artifact_memberships: Object.freeze([
    "tenant_id", "decision_id", "artifact_id", "artifact_role", "role_ordinal",
    "report_sha256", "membership_sha256",
  ]),
} as const);

const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_PRIMARY_KEY_KINDS = Object.freeze({
  lite_learning_experiment_revisions: Object.freeze(["text", "text", "integer"]),
  lite_learning_episode_events: Object.freeze(["integer"]),
  lite_learning_external_run_reservations: Object.freeze(["integer"]),
  lite_learning_external_holdout_members: Object.freeze(["text", "text", "integer"]),
  lite_learning_evidence_artifacts: Object.freeze(["integer"]),
  lite_learning_gate_look_reservations: Object.freeze(["integer"]),
  lite_learning_gate_decisions: Object.freeze(["integer"]),
} as const);

export const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS = Object.freeze(
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_PRIMARY_KEY_SPECS.map((spec) => Object.freeze({
    ...spec,
    primary_key_kinds: Object.freeze(spec.primary_key.map(() => "text" as const).map(
      (kind, index) => (LEARNING_RUNTIME_AUTHORITY_HEAD_V1_PRIMARY_KEY_KINDS[
        spec.table as keyof typeof LEARNING_RUNTIME_AUTHORITY_HEAD_V1_PRIMARY_KEY_KINDS
      ]?.[index] ?? kind),
    )) as readonly ("text" | "integer")[],
    column_order: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_COLUMNS[spec.table],
  })),
);

export const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC = Object.freeze({
  table: "lite_runtime_write_operations",
  primary_key: Object.freeze(["tenant_id", "scope", "operation_kind", "operation_id"]),
  primary_key_kinds: Object.freeze(["text", "text", "text", "text"] as const),
  column_order: Object.freeze([
    "tenant_id", "scope", "operation_kind", "operation_id", "request_sha256", "receipt_json",
    "commit_id", "created_at",
  ]),
  selector: Object.freeze({
    column: "scope",
    equals: "learning_external_authority_v1",
  }),
  closure: "all_rows_matching_selector",
} as const);

export const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_ENCODING_CONTRACT = Object.freeze({
  contract_version: "aionis_learning_runtime_authority_head_encoding_v1",
  framing: "u64be_length_prefixed_v1",
  frame_length: "unsigned_64_bit_big_endian",
  message_framing: "frame_domain_then_u64be_part_count_then_framed_parts",
  typed_value_framing: "tag_byte_then_framed_payload",
  sqlite_value_types: Object.freeze([
    Object.freeze({ identifier: "null", tag: 0 }),
    Object.freeze({ identifier: "text", tag: 1 }),
    Object.freeze({ identifier: "integer", tag: 2 }),
    Object.freeze({ identifier: "blob", tag: 3 }),
  ]),
  integer_payload: "canonical_signed_decimal_utf8",
  text_payload: "utf8",
  blob_payload: "lowercase_hex_utf8",
  primary_key_order: Object.freeze({
    null: "rejected",
    text: "unsigned_utf8_bytewise",
    integer: "signed_numeric",
    blob: "unsigned_raw_bytewise",
    real: "rejected",
    unsafe_integer: "rejected",
  }),
  row_order: "table_manifest_then_typed_primary_key_v1",
} as const);

export const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS = Object.freeze({
  field: "aionis.learning.runtime.authority-head.v1/field",
  primary_key: "aionis.learning.runtime.authority-head.v1/primary-key",
  row_content: "aionis.learning.runtime.authority-head.v1/row-content",
  row_entry: "aionis.learning.runtime.authority-head.v1/row-entry",
  table_rows: "aionis.learning.runtime.authority-head.v1/table-rows",
  table_head: "aionis.learning.runtime.authority-head.v1/table-head",
  operation_rows: "aionis.learning.runtime.authority-head.v1/operation-rows",
  operation_closure: "aionis.learning.runtime.authority-head.v1/operation-closure",
  operation_head: "aionis.learning.runtime.authority-head.v1/operation-head",
  database_lineage: "aionis.learning.runtime.authority-head.v1/database-lineage",
  root: "aionis.learning.runtime.authority-head.v1/root",
} as const);

export const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_DOMAINS =
  LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS;

export type LearningRuntimeAuthoritySqliteValueV1 =
  | Readonly<{ storage_class: "null"; value: null }>
  | Readonly<{ storage_class: "text"; value: Uint8Array }>
  | Readonly<{ storage_class: "integer"; value: number }>
  | Readonly<{ storage_class: "blob"; value: Uint8Array }>;

export type LearningRuntimeAuthoritySqlValue = LearningRuntimeAuthoritySqliteValueV1;

type NormalizedAuthoritySqlValue = Readonly<{
  tag: "null" | "text" | "integer" | "blob";
  tagByte: number;
  payload: Uint8Array;
  orderBytes: Uint8Array;
  integer?: number;
}>;

function authorityUtf8(value: string, label: string): Uint8Array {
  if (containsUnpairedSurrogate(value)) {
    throw new Error(`learning_runtime_authority_unpaired_surrogate:${label}`);
  }
  return Buffer.from(value, "utf8");
}

function normalizeAuthoritySqlValue(
  value: unknown,
  options: Readonly<{ primaryKey?: boolean }> = {},
): NormalizedAuthoritySqlValue {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value instanceof Uint8Array) {
    throw new Error("learning_runtime_authority_sql_value_requires_storage_class");
  }
  const tagged = value as Readonly<Record<string, unknown>>;
  if (stableStringify(Object.keys(tagged).sort()) !== stableStringify(["storage_class", "value"])) {
    throw new Error("learning_runtime_authority_sql_value_shape_invalid");
  }
  if (tagged.storage_class === "null") {
    if (tagged.value !== null) throw new Error("learning_runtime_authority_null_value_invalid");
    if (options.primaryKey) throw new Error("learning_runtime_authority_primary_key_null");
    return {
      tag: "null",
      tagByte: 0,
      payload: new Uint8Array(),
      orderBytes: new Uint8Array(),
    };
  }
  if (tagged.storage_class === "text") {
    if (!(tagged.value instanceof Uint8Array)) {
      throw new Error("learning_runtime_authority_text_value_invalid");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(tagged.value);
    } catch {
      throw new Error("learning_runtime_authority_text_invalid_utf8");
    }
    const payload = authorityUtf8(decoded, "text");
    if (Buffer.compare(Buffer.from(payload), Buffer.from(tagged.value)) !== 0) {
      throw new Error("learning_runtime_authority_text_noncanonical_utf8");
    }
    return { tag: "text", tagByte: 1, payload, orderBytes: payload };
  }
  if (tagged.storage_class === "integer") {
    if (typeof tagged.value !== "number"
      || !Number.isSafeInteger(tagged.value)
      || Object.is(tagged.value, -0)) {
      throw new Error("learning_runtime_authority_integer_unsafe_or_real");
    }
    const payload = authorityUtf8(tagged.value.toString(10), "integer");
    return {
      tag: "integer",
      tagByte: 2,
      payload,
      orderBytes: payload,
      integer: tagged.value,
    };
  }
  if (tagged.storage_class === "blob") {
    if (!(tagged.value instanceof Uint8Array)) {
      throw new Error("learning_runtime_authority_blob_value_invalid");
    }
    return {
      tag: "blob",
      tagByte: 3,
      payload: authorityUtf8(Buffer.from(tagged.value).toString("hex"), "blob"),
      orderBytes: Buffer.from(tagged.value),
    };
  }
  if (tagged.storage_class === "real") {
    throw new Error("learning_runtime_authority_real_rejected");
  }
  throw new Error("learning_runtime_authority_storage_class_unsupported");
}

export function encodeLearningRuntimeAuthorityU64BE(value: number | bigint): Uint8Array {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("learning_runtime_authority_u64_unsafe");
  }
  const integer = typeof value === "bigint" ? value : BigInt(value);
  if (integer < 0n || integer > 0xffff_ffff_ffff_ffffn) {
    throw new Error("learning_runtime_authority_u64_out_of_range");
  }
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(integer);
  return output;
}

export const learningRuntimeAuthorityU64be = encodeLearningRuntimeAuthorityU64BE;

export function learningRuntimeAuthorityFrame(value: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(encodeLearningRuntimeAuthorityU64BE(value.byteLength)),
    Buffer.from(value),
  ]);
}

export function encodeLearningRuntimeAuthorityMessage(
  domain: string,
  parts: Iterable<Uint8Array>,
): Uint8Array {
  if (!/^[\x20-\x7e]+$/u.test(domain)) {
    throw new Error("learning_runtime_authority_domain_must_be_ascii");
  }
  const materialized = [...parts];
  const framed: Uint8Array[] = [
    learningRuntimeAuthorityFrame(authorityUtf8(domain, "domain")),
    encodeLearningRuntimeAuthorityU64BE(materialized.length),
  ];
  for (const part of materialized) framed.push(learningRuntimeAuthorityFrame(part));
  return Buffer.concat(framed.map((part) => Buffer.from(part)));
}

export function encodeLearningRuntimeAuthorityTypedValue(value: unknown): Uint8Array {
  const normalized = normalizeAuthoritySqlValue(value);
  return Buffer.concat([
    Buffer.from([normalized.tagByte]),
    Buffer.from(learningRuntimeAuthorityFrame(normalized.payload)),
  ]);
}

export const encodeLearningRuntimeAuthoritySqliteValueV1 =
  encodeLearningRuntimeAuthorityTypedValue;

function authorityColumnMessage(column: string, value: unknown): Uint8Array {
  return encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.field,
    [authorityUtf8(column, "column"), encodeLearningRuntimeAuthorityTypedValue(value)],
  );
}

type AuthorityTableSpec = Readonly<{
  table: string;
  primary_key: readonly string[];
  primary_key_kinds: readonly ("text" | "integer")[];
  column_order: readonly string[];
}>;

function authorityTableSpec(table: string): AuthorityTableSpec {
  if (table === LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC.table) {
    return LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC;
  }
  const spec = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.find(
    (candidate) => candidate.table === table,
  );
  if (!spec) throw new Error(`learning_runtime_authority_table_unknown:${table}`);
  return spec;
}

function exactAuthorityRow(
  spec: AuthorityTableSpec,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value instanceof Uint8Array) {
    throw new Error(`learning_runtime_authority_row_invalid:${spec.table}`);
  }
  const row = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(row).sort();
  const expected = [...spec.column_order].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`learning_runtime_authority_row_columns_mismatch:${spec.table}`);
  }
  return row;
}

function rawDigestBytes(value: string): Uint8Array {
  return Buffer.from(DigestSha256Schema.parse(value), "hex");
}

export function learningRuntimeAuthorityRowContentDigest(args: Readonly<{
  table: string;
  row: unknown;
}>): string {
  const spec = authorityTableSpec(args.table);
  const row = exactAuthorityRow(spec, args.row);
  const parts: Uint8Array[] = [
    rawDigestBytes(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256),
    authorityUtf8(spec.table, "table"),
  ];
  for (const column of spec.column_order) {
    parts.push(authorityColumnMessage(column, row[column]));
  }
  return createHash("sha256").update(encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.row_content,
    parts,
  )).digest("hex");
}

function authorityPrimaryKeyMessage(
  spec: AuthorityTableSpec,
  row: Readonly<Record<string, unknown>>,
): Uint8Array {
  return encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.primary_key,
    spec.primary_key.map((column, index) => {
      const normalized = normalizeAuthoritySqlValue(row[column], { primaryKey: true });
      if (normalized.tag !== spec.primary_key_kinds[index]) {
        throw new Error(
          `learning_runtime_authority_primary_key_storage_class_mismatch:${spec.table}:${column}`,
        );
      }
      return authorityColumnMessage(column, row[column]);
    }),
  );
}

function authoritySqlStorageRank(value: NormalizedAuthoritySqlValue): number {
  if (value.tag === "integer") return 0;
  if (value.tag === "text") return 1;
  if (value.tag === "blob") return 2;
  throw new Error("learning_runtime_authority_primary_key_null");
}

function compareAuthoritySqlValues(left: unknown, right: unknown): number {
  const leftValue = normalizeAuthoritySqlValue(left, { primaryKey: true });
  const rightValue = normalizeAuthoritySqlValue(right, { primaryKey: true });
  const rank = authoritySqlStorageRank(leftValue) - authoritySqlStorageRank(rightValue);
  if (rank !== 0) return rank;
  if (leftValue.tag === "integer" && rightValue.tag === "integer") {
    return leftValue.integer! < rightValue.integer!
      ? -1
      : leftValue.integer! > rightValue.integer! ? 1 : 0;
  }
  return Buffer.compare(Buffer.from(leftValue.orderBytes), Buffer.from(rightValue.orderBytes));
}

function compareAuthorityPrimaryKeys(
  spec: AuthorityTableSpec,
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): number {
  for (const [index, column] of spec.primary_key.entries()) {
    const expectedKind = spec.primary_key_kinds[index];
    const leftKind = normalizeAuthoritySqlValue(left[column], { primaryKey: true }).tag;
    const rightKind = normalizeAuthoritySqlValue(right[column], { primaryKey: true }).tag;
    if (leftKind !== expectedKind || rightKind !== expectedKind) {
      throw new Error(
        `learning_runtime_authority_primary_key_storage_class_mismatch:${spec.table}:${column}`,
      );
    }
    const compared = compareAuthoritySqlValues(left[column], right[column]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export const compareLearningRuntimeAuthorityPrimaryKeyV1 = (
  table: string,
  left: unknown,
  right: unknown,
): number => {
  const spec = authorityTableSpec(table);
  return compareAuthorityPrimaryKeys(
    spec,
    exactAuthorityRow(spec, left),
    exactAuthorityRow(spec, right),
  );
};

export type LearningRuntimeAuthorityRowV1 = Readonly<{
  table: string;
  row_content_sha256: string;
  primary_key_message: Uint8Array;
  row_entry: Uint8Array;
  authority_row_sha256: string;
}>;

export function learningRuntimeAuthorityRowV1(args: Readonly<{
  table: string;
  row: unknown;
}>): LearningRuntimeAuthorityRowV1 {
  const spec = authorityTableSpec(args.table);
  const row = exactAuthorityRow(spec, args.row);
  const rowContentSha256 = learningRuntimeAuthorityRowContentDigest({ table: spec.table, row });
  const primaryKeyMessage = authorityPrimaryKeyMessage(spec, row);
  const rowEntry = encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.row_entry,
    [
      authorityUtf8(spec.table, "row_entry_table"),
      primaryKeyMessage,
      rawDigestBytes(rowContentSha256),
    ],
  );
  return {
    table: spec.table,
    row_content_sha256: rowContentSha256,
    primary_key_message: primaryKeyMessage,
    row_entry: rowEntry,
    authority_row_sha256: createHash("sha256").update(rowEntry).digest("hex"),
  };
}

/**
 * The D2 registered-revision binding is the typed full authority-row digest,
 * including the immutable three-column primary key. It is deliberately not a
 * generic JSON digest and cannot be redirected to another authority table.
 */
export function learningExternalIngestionRevisionRowDigestV1(row: unknown): string {
  return learningRuntimeAuthorityRowV1({
    table: "lite_learning_experiment_revisions",
    row,
  }).authority_row_sha256;
}

export type LearningRuntimeAuthorityTableRowsDigestV1 = Readonly<{
  row_count: number;
  rows_sha256: string;
}>;

export type LearningRuntimeAuthorityTableHasherV1 = Readonly<{
  append(row: unknown): LearningRuntimeAuthorityRowV1;
  finish(): LearningRuntimeAuthorityTableRowsDigestV1;
}>;

function snapshotAuthorityPrimaryKey(
  spec: AuthorityTableSpec,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(spec.primary_key.map((column) => {
    const value = normalizeAuthoritySqlValue(row[column], { primaryKey: true });
    if (value.tag === "integer") {
      return [column, Object.freeze({ storage_class: "integer", value: value.integer! })];
    }
    if (value.tag === "text") {
      return [column, Object.freeze({ storage_class: "text", value: Buffer.from(value.payload) })];
    }
    return [column, Object.freeze({ storage_class: "blob", value: Buffer.from(value.orderBytes) })];
  })));
}

export function createLearningRuntimeAuthorityTableHasherV1(args: Readonly<{
  table: string;
  expectedRowCount: number;
}>): LearningRuntimeAuthorityTableHasherV1 {
  const spec = authorityTableSpec(args.table);
  const expectedRowCount = NonNegativeSafeIntegerSchema.parse(args.expectedRowCount);
  const operationSpec = spec.table === LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC.table
    ? LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC
    : null;
  const hash = createHash("sha256");
  hash.update(learningRuntimeAuthorityFrame(authorityUtf8(
    operationSpec !== null
      ? LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.operation_rows
      : LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.table_rows,
    "domain",
  )));
  hash.update(encodeLearningRuntimeAuthorityU64BE(
    BigInt(expectedRowCount) + (operationSpec === null ? 3n : 6n),
  ));
  hash.update(learningRuntimeAuthorityFrame(rawDigestBytes(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256,
  )));
  hash.update(learningRuntimeAuthorityFrame(authorityUtf8(spec.table, "table")));
  if (operationSpec !== null) {
    hash.update(learningRuntimeAuthorityFrame(authorityUtf8(
      operationSpec.selector.column,
      "operation_selector_column",
    )));
    hash.update(learningRuntimeAuthorityFrame(authorityUtf8(
      operationSpec.selector.equals,
      "operation_selector_equals",
    )));
    hash.update(learningRuntimeAuthorityFrame(authorityUtf8(
      operationSpec.closure,
      "operation_closure",
    )));
  }
  hash.update(learningRuntimeAuthorityFrame(encodeLearningRuntimeAuthorityU64BE(
    expectedRowCount,
  )));
  let previous: Readonly<Record<string, unknown>> | null = null;
  let rowCount = 0;
  let finished: LearningRuntimeAuthorityTableRowsDigestV1 | null = null;
  return Object.freeze({
    append(input: unknown): LearningRuntimeAuthorityRowV1 {
      if (finished !== null) throw new Error("learning_runtime_authority_table_hasher_finished");
      if (rowCount >= expectedRowCount) {
        throw new Error(`learning_runtime_authority_table_row_count_exceeded:${spec.table}`);
      }
      const row = exactAuthorityRow(spec, input);
      if (operationSpec !== null) {
        const selector = normalizeAuthoritySqlValue(row[operationSpec.selector.column]);
        const expectedSelectorBytes = authorityUtf8(
          operationSpec.selector.equals,
          "operation_selector_equals",
        );
        if (selector.tag !== "text"
          || Buffer.compare(
            Buffer.from(selector.orderBytes),
            Buffer.from(expectedSelectorBytes),
          ) !== 0) {
          throw new Error(
            `learning_runtime_authority_operation_selector_mismatch:${operationSpec.selector.column}`,
          );
        }
      }
      if (previous !== null && compareAuthorityPrimaryKeys(spec, previous, row) >= 0) {
        throw new Error(`learning_runtime_authority_primary_key_order_invalid:${spec.table}`);
      }
      const encoded = learningRuntimeAuthorityRowV1({ table: spec.table, row });
      hash.update(learningRuntimeAuthorityFrame(encoded.row_entry));
      rowCount += 1;
      previous = snapshotAuthorityPrimaryKey(spec, row);
      return encoded;
    },
    finish(): LearningRuntimeAuthorityTableRowsDigestV1 {
      if (finished !== null) return finished;
      if (rowCount !== expectedRowCount) {
        throw new Error(`learning_runtime_authority_table_row_count_mismatch:${spec.table}`);
      }
      finished = Object.freeze({ row_count: rowCount, rows_sha256: hash.digest("hex") });
      return finished;
    },
  });
}

export function learningRuntimeAuthorityTableRowsDigest(args: Readonly<{
  table: string;
  expectedRowCount: number;
  rows: Iterable<unknown>;
}>): LearningRuntimeAuthorityTableRowsDigestV1 {
  const hasher = createLearningRuntimeAuthorityTableHasherV1({
    table: args.table,
    expectedRowCount: args.expectedRowCount,
  });
  for (const row of args.rows) hasher.append(row);
  return hasher.finish();
}

export function learningRuntimeAuthorityExternalOperationClosureDigest(args: Readonly<{
  rowCount: number;
  rowsSha256: string;
}>): string {
  const spec = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC;
  const rowCount = NonNegativeSafeIntegerSchema.parse(args.rowCount);
  return createHash("sha256").update(encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.operation_closure,
    [
      rawDigestBytes(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256),
      authorityUtf8(spec.table, "operation_table"),
      authorityUtf8(spec.selector.column, "operation_selector_column"),
      authorityUtf8(spec.selector.equals, "operation_selector_equals"),
      authorityUtf8(spec.closure, "operation_closure"),
      encodeLearningRuntimeAuthorityU64BE(rowCount),
      rawDigestBytes(args.rowsSha256),
    ],
  )).digest("hex");
}

export const learningRuntimeAuthorityOperationClosureDigestV1 =
  learningRuntimeAuthorityExternalOperationClosureDigest;

const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST = Object.freeze({
  contract_version: "aionis_learning_runtime_authority_head_table_manifest_v1",
  tables: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS,
  external_scope_operations: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC,
  encoding: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_ENCODING_CONTRACT,
  domains: LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS,
});

export function learningRuntimeAuthorityHeadTableManifestDigest(): string {
  return sha256Canonical(LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST);
}

export const LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256 =
  learningRuntimeAuthorityHeadTableManifestDigest();

const AuthorityTableHeadV1Schema = z.object({
  table: z.string(),
  primary_key: z.array(z.string()).min(1).max(8),
  primary_key_kinds: z.array(z.enum(["text", "integer"])).min(1).max(8),
  column_order: z.array(z.string()).min(1).max(128),
  row_count: NonNegativeSafeIntegerSchema,
  rows_sha256: DigestSha256Schema,
}).strict();

const ExternalScopeOperationHeadV1Schema = z.object({
  table: z.literal("lite_runtime_write_operations"),
  scope: z.literal("learning_external_authority_v1"),
  primary_key: z.tuple([
    z.literal("tenant_id"),
    z.literal("scope"),
    z.literal("operation_kind"),
    z.literal("operation_id"),
  ]),
  primary_key_kinds: z.tuple([
    z.literal("text"),
    z.literal("text"),
    z.literal("text"),
    z.literal("text"),
  ]),
  column_order: z.tuple([
    z.literal("tenant_id"),
    z.literal("scope"),
    z.literal("operation_kind"),
    z.literal("operation_id"),
    z.literal("request_sha256"),
    z.literal("receipt_json"),
    z.literal("commit_id"),
    z.literal("created_at"),
  ]),
  closure: z.literal("all_rows_matching_selector"),
  row_count: NonNegativeSafeIntegerSchema,
  rows_sha256: DigestSha256Schema,
  closure_sha256: DigestSha256Schema,
}).strict();

const DatabaseLineageV1Schema = z.object({
  database_instance_id: DigestSha256Schema,
  database_file_device: CanonicalUnsigned64DecimalSchema,
  database_file_inode: CanonicalUnsigned64DecimalSchema,
  checkpoint_generation: CanonicalUnsigned64DecimalSchema,
  database_main_file_byte_length: CanonicalUnsigned64DecimalSchema,
  database_main_file_sha256: DigestSha256Schema,
  wal_checkpointed_and_truncated: z.literal(true),
}).strict();

export const LearningRuntimeAuthorityHeadBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_runtime_authority_head_body_v1"),
  schema_component: z.literal("write_projection"),
  schema_version: LearningExternalRuntimeWriteSchemaVersionV1Schema,
  database_lineage: DatabaseLineageV1Schema,
  table_manifest_sha256: DigestSha256Schema,
  encoding_contract_version: z.literal("aionis_learning_runtime_authority_head_encoding_v1"),
  tables: z.array(AuthorityTableHeadV1Schema).length(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.length,
  ),
  external_scope_operations: ExternalScopeOperationHeadV1Schema,
}).strict().superRefine((value, context) => {
  if (value.table_manifest_sha256 !== LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_MANIFEST_SHA256) {
    addBindingIssue(context, ["table_manifest_sha256"], "Authority-head table manifest digest mismatch");
  }
  for (const [index, expected] of LEARNING_RUNTIME_AUTHORITY_HEAD_V1_TABLE_SPECS.entries()) {
    const actual = value.tables[index];
    if (actual?.table !== expected.table
      || stableStringify(actual.primary_key) !== stableStringify(expected.primary_key)
      || stableStringify(actual.primary_key_kinds)
        !== stableStringify(expected.primary_key_kinds)
      || stableStringify(actual.column_order) !== stableStringify(expected.column_order)) {
      addBindingIssue(
        context,
        ["tables", index],
        "Authority-head tables and primary keys must use the fixed canonical manifest order",
      );
    }
  }
  const operationSpec = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC;
  if (value.external_scope_operations.table !== operationSpec.table
    || value.external_scope_operations.scope !== operationSpec.selector.equals
    || value.external_scope_operations.closure !== operationSpec.closure
    || stableStringify(value.external_scope_operations.primary_key)
      !== stableStringify(operationSpec.primary_key)
    || stableStringify(value.external_scope_operations.primary_key_kinds)
      !== stableStringify(operationSpec.primary_key_kinds)
    || stableStringify(value.external_scope_operations.column_order)
      !== stableStringify(operationSpec.column_order)) {
    addBindingIssue(
      context,
      ["external_scope_operations"],
      "Authority head must close over every Runtime operation in the protected external scope",
    );
  }
  const expectedClosure = learningRuntimeAuthorityExternalOperationClosureDigest({
    rowCount: value.external_scope_operations.row_count,
    rowsSha256: value.external_scope_operations.rows_sha256,
  });
  if (value.external_scope_operations.closure_sha256 !== expectedClosure) {
    addBindingIssue(
      context,
      ["external_scope_operations", "closure_sha256"],
      "External operation closure digest does not bind its exact selected row set",
    );
  }
});

export type LearningRuntimeAuthorityHeadBodyV1 = z.infer<
  typeof LearningRuntimeAuthorityHeadBodyV1Schema
>;

export function learningRuntimeAuthorityHeadRootDigestV1(value: unknown): string {
  const body = LearningRuntimeAuthorityHeadBodyV1Schema.parse(value);
  const lineage = body.database_lineage;
  const lineageMessage = encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.database_lineage,
    [
      authorityUtf8(lineage.database_instance_id, "root_database_instance_id"),
      authorityUtf8(lineage.database_file_device, "root_database_file_device"),
      authorityUtf8(lineage.database_file_inode, "root_database_file_inode"),
      authorityUtf8(lineage.checkpoint_generation, "root_checkpoint_generation"),
      authorityUtf8(lineage.database_main_file_byte_length,
        "root_database_main_file_byte_length"),
      rawDigestBytes(lineage.database_main_file_sha256),
      Buffer.from([1]),
    ],
  );
  const tableHeadMessages = body.tables.map((table) => encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.table_head,
    [
      authorityUtf8(table.table, "root_table"),
      encodeLearningRuntimeAuthorityU64BE(table.row_count),
      rawDigestBytes(table.rows_sha256),
    ],
  ));
  const operation = body.external_scope_operations;
  const operationSpec = LEARNING_RUNTIME_AUTHORITY_HEAD_V1_OPERATION_SPEC;
  const operationHeadMessage = encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.operation_head,
    [
      authorityUtf8(operation.table, "root_operation_table"),
      authorityUtf8(operationSpec.selector.column, "root_operation_selector_column"),
      authorityUtf8(operationSpec.selector.equals, "root_operation_selector_equals"),
      authorityUtf8(operationSpec.closure, "root_operation_closure"),
      encodeLearningRuntimeAuthorityU64BE(operation.row_count),
      rawDigestBytes(operation.rows_sha256),
      rawDigestBytes(operation.closure_sha256),
    ],
  );
  const parts: Uint8Array[] = [
    authorityUtf8("aionis_learning_runtime_authority_head_v1", "root_contract_version"),
    authorityUtf8(body.schema_component, "root_schema_component"),
    authorityUtf8(String(body.schema_version), "root_schema_version"),
    authorityUtf8(body.encoding_contract_version, "root_encoding_contract_version"),
    rawDigestBytes(body.table_manifest_sha256),
    lineageMessage,
    ...tableHeadMessages,
    operationHeadMessage,
  ];
  return createHash("sha256").update(encodeLearningRuntimeAuthorityMessage(
    LEARNING_RUNTIME_AUTHORITY_HEAD_V1_HASH_DOMAINS.root,
    parts,
  )).digest("hex");
}

export const LearningRuntimeAuthorityHeadV1Schema = z.object({
  contract_version: z.literal("aionis_learning_runtime_authority_head_v1"),
  body: LearningRuntimeAuthorityHeadBodyV1Schema,
  authority_head_sha256: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  const expected = learningRuntimeAuthorityHeadRootDigestV1(value.body);
  if (value.authority_head_sha256 !== expected) {
    addBindingIssue(
      context,
      ["authority_head_sha256"],
      "Committed authority-head digest does not bind the canonical framed body",
    );
  }
});

export type LearningRuntimeAuthorityHeadV1 = z.infer<
  typeof LearningRuntimeAuthorityHeadV1Schema
>;

export function assertLearningRuntimeAuthorityHeadV1(
  value: unknown,
): LearningRuntimeAuthorityHeadV1 {
  return LearningRuntimeAuthorityHeadV1Schema.parse(value);
}

export function learningRuntimeAuthorityHeadDigest(value: unknown): string {
  return assertLearningRuntimeAuthorityHeadV1(value).authority_head_sha256;
}

export const RegisteredRevisionDigestsV1Schema = z.object({
  revision_row_sha256: DigestSha256Schema,
  profile_rule_sha256: DigestSha256Schema,
  experiment_config_sha256: DigestSha256Schema,
  confirmatory_attempt_sha256: DigestSha256Schema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  candidate_policy_config_sha256: DigestSha256Schema,
  collection_source_policy_sha256: DigestSha256Schema,
  gate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_config_sha256: DigestSha256Schema,
  gate_prospective_calibration_sha256: DigestSha256Schema,
  required_evidence_series_sha256: DigestSha256Schema,
  required_external_inputs_sha256: DigestSha256Schema,
  external_execution_policy_sha256: DigestSha256Schema,
}).strict();

export const RegisteredEvidenceSeriesV1Schema = z.object({
  offline_paired: BoundedIdSchema,
  production_shadow: BoundedIdSchema,
  tool_e2e: BoundedIdSchema,
  runtime_integrity: BoundedIdSchema,
}).strict().superRefine((value, context) => {
  if (new Set(Object.values(value)).size !== 4) {
    addBindingIssue(context, [], "The four registered evidence series identifiers must be distinct");
  }
});

export const ResultTupleV1Schema = z.object({
  role: LearningExternalAttestationRoleV1Schema,
  artifact_kind: LearningExternalAttestationArtifactKindV1Schema,
  evidence_series_id: BoundedIdSchema,
  artifact_status: LearningExternalResultStatusV1Schema,
  reservation_id: BoundedIdSchema,
  ticket_consumption_id: BoundedIdSchema,
  claim_id: BoundedIdSchema,
  supervisor_binding_id: BoundedIdSchema,
  session_termination_id: BoundedIdSchema,
  session_termination_sha256: DigestSha256Schema,
  report_sha256: DigestSha256Schema,
  public_run_authority_sha256: DigestSha256Schema,
  run_bundle_manifest_sha256: DigestSha256Schema,
  run_bundle_archive_sha256: DigestSha256Schema,
  bundle_commit_id: SourceCommitIdSchema,
  ingest_operation_scope: z.literal("learning_external_authority_v1"),
  ingest_operation_kind: z.literal("learning_evidence_ingest_v1"),
  ingest_operation_id: BoundedIdSchema,
  ingest_operation_request_sha256: DigestSha256Schema,
  ingest_operation_receipt_sha256: DigestSha256Schema,
  ingest_operation_commit_id: SourceCommitIdSchema,
  ingest_operation_created_at: LearningExternalCanonicalUtcMillisSchema,
  ingest_operation_row_sha256: DigestSha256Schema,
  post_transaction_projection_sha256: DigestSha256Schema,
  artifact_id: BoundedIdSchema,
  artifact_row_id: PositiveSafeIntegerSchema,
  artifact_row_sha256: DigestSha256Schema,
  artifact_authority_row_sha256: DigestSha256Schema,
  series_head_artifact_id: BoundedIdSchema,
  series_head_row_id: PositiveSafeIntegerSchema,
  series_head_artifact_row_sha256: DigestSha256Schema,
  series_head_row_sha256: DigestSha256Schema,
}).strict().superRefine((value, context) => {
  const expected = LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.find(
    (role) => role.role === value.role,
  );
  if (value.artifact_kind !== expected?.artifact_kind) {
    addBindingIssue(context, ["artifact_kind"], "Result tuple role and artifact kind disagree");
  }
  if (value.artifact_id !== value.series_head_artifact_id
    || value.artifact_row_id !== value.series_head_row_id
    || value.artifact_row_sha256 !== value.series_head_artifact_row_sha256
    || value.artifact_authority_row_sha256 !== value.series_head_row_sha256) {
    addBindingIssue(
      context,
      ["series_head_artifact_id"],
      "An external result must be the current registered series head",
    );
  }
  if (value.ingest_operation_commit_id !== value.bundle_commit_id) {
    addBindingIssue(
      context,
      ["ingest_operation_commit_id"],
      "The protected ingestion operation must bind the tracked bundle commit",
    );
  }
});

export const LearningExternalIngestionProjectionV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_ingestion_projection_v1"),
  schema_component: z.literal("write_projection"),
  schema_version: LearningExternalRuntimeWriteSchemaVersionV1Schema,
  ledger_verifier_id: z.literal("aionis_lite_learning_ledger_replay"),
  ledger_verifier_version: z.literal(1),
  ledger_verification_sha256: DigestSha256Schema,
  tenant_id: BoundedIdSchema,
  task_family: BoundedIdSchema,
  confirmatory_attempt_id: BoundedIdSchema,
  experiment_id: BoundedIdSchema,
  experiment_revision: PositiveSafeIntegerSchema,
  database_lineage: DatabaseLineageV1Schema,
  database_binding_receipt_sha256: DigestSha256Schema,
  registered_revision: RegisteredRevisionDigestsV1Schema,
  registered_evidence_series: RegisteredEvidenceSeriesV1Schema,
  required_series_status: LearningExternalRequiredSeriesStatusV1Schema,
  required_series_status_sha256: DigestSha256Schema,
  terminal_coverage_index: LearningExternalTerminalCoverageIndexV1Schema,
  terminal_coverage_index_sha256: DigestSha256Schema,
  result_tuples: z.array(ResultTupleV1Schema).max(3),
  result_tuples_sha256: DigestSha256Schema,
  authority_head: LearningRuntimeAuthorityHeadV1Schema,
}).strict().superRefine((value, context) => {
  const status = value.required_series_status;
  const coverage = value.terminal_coverage_index;
  const identityBindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [value.authority_head.body.schema_version, value.schema_version,
      "authority_head.body.schema_version"],
    [status.tenant_id, value.tenant_id, "required_series_status.tenant_id"],
    [coverage.tenant_id, value.tenant_id, "terminal_coverage_index.tenant_id"],
    [status.task_family, value.task_family, "required_series_status.task_family"],
    [coverage.task_family, value.task_family, "terminal_coverage_index.task_family"],
    [status.experiment_id, value.experiment_id, "required_series_status.experiment_id"],
    [coverage.experiment_id, value.experiment_id, "terminal_coverage_index.experiment_id"],
    [status.experiment_revision, value.experiment_revision,
      "required_series_status.experiment_revision"],
    [coverage.experiment_revision, value.experiment_revision,
      "terminal_coverage_index.experiment_revision"],
    [status.required_evidence_series_sha256,
      value.registered_revision.required_evidence_series_sha256,
      "required_series_status.required_evidence_series_sha256"],
    [coverage.required_evidence_series_sha256,
      value.registered_revision.required_evidence_series_sha256,
      "terminal_coverage_index.required_evidence_series_sha256"],
    [stableStringify(value.database_lineage),
      stableStringify(value.authority_head.body.database_lineage),
      "authority_head.database_lineage"],
  ];
  for (const [actual, expected, path] of identityBindings) {
    if (actual !== expected) {
      addBindingIssue(context, path.split("."), `${path} does not bind the aggregate projection`);
    }
  }
  const digestBindings: ReadonlyArray<readonly [string, string, string]> = [
    [value.registered_revision.required_evidence_series_sha256,
      sha256Canonical(value.registered_evidence_series),
      "registered_revision.required_evidence_series_sha256"],
    [value.required_series_status_sha256,
      learningExternalRequiredSeriesStatusDigest(status), "required_series_status_sha256"],
    [value.terminal_coverage_index_sha256,
      learningExternalTerminalCoverageIndexDigest(coverage), "terminal_coverage_index_sha256"],
    [value.result_tuples_sha256, sha256Canonical(value.result_tuples), "result_tuples_sha256"],
  ];
  for (const [actual, expected, path] of digestBindings) {
    if (actual !== expected) {
      addBindingIssue(context, [path], `${path} does not bind its canonical contract`);
    }
  }
  for (const [index, roleSpec] of LEARNING_EXTERNAL_ATTESTATION_ROLE_SPECS.entries()) {
    const expectedSeriesId = value.registered_evidence_series[roleSpec.role];
    const statusEntry = status.series[index];
    const coverageBranch = coverage.branches[index];
    if (statusEntry?.evidence_series_id !== expectedSeriesId
      || coverageBranch?.evidence_series_id !== expectedSeriesId) {
      addBindingIssue(
        context,
        ["registered_evidence_series", roleSpec.role],
        "Status and coverage must bind the preregistered evidence series",
      );
    }
    if (!statusEntry || !coverageBranch
      || statusEntry.branch_kind !== coverageBranch.branch_kind) {
      addBindingIssue(
        context,
        ["required_series_status", "series", index],
        "Required-series status and terminal coverage branch disagree",
      );
      continue;
    }
    if (statusEntry.branch_kind === "result"
      && (coverageBranch.branch_kind !== "result"
        || statusEntry.artifact_status !== coverageBranch.artifact_status)) {
      addBindingIssue(context, ["required_series_status", "series", index],
        "Result status does not match terminal coverage");
    } else if (statusEntry.branch_kind === "termination_hold"
      && (coverageBranch.branch_kind !== "termination_hold"
        || statusEntry.termination_reason !== coverageBranch.termination_reason)) {
      addBindingIssue(context, ["required_series_status", "series", index],
        "Termination-hold reason does not match terminal coverage");
    } else if (statusEntry.branch_kind === "preclaim_hold"
      && (coverageBranch.branch_kind !== "preclaim_hold"
        || statusEntry.preclaim_hold_reason !== coverageBranch.preclaim_hold_reason)) {
      addBindingIssue(context, ["required_series_status", "series", index],
        "Pre-claim-hold reason does not match terminal coverage");
    }
  }

  const resultBranches = coverage.branches.filter(
    (branch): branch is z.infer<typeof TerminalCoverageResultBranchV1Schema> =>
      branch.branch_kind === "result",
  );
  const expectedResultRoles = resultBranches.map(({ role }) => role);
  const actualResultRoles = value.result_tuples.map(({ role }) => role);
  if (stableStringify(actualResultRoles) !== stableStringify(expectedResultRoles)) {
    addBindingIssue(
      context,
      ["result_tuples"],
      "Result tuples must exist exactly once and in role order for every result branch",
    );
  }
  for (const [index, branch] of resultBranches.entries()) {
    const tuple = value.result_tuples[index];
    if (!tuple) continue;
    for (const field of [
      "role",
      "artifact_kind",
      "evidence_series_id",
      "artifact_status",
      "reservation_id",
      "ticket_consumption_id",
      "claim_id",
      "supervisor_binding_id",
      "session_termination_id",
      "session_termination_sha256",
      "report_sha256",
      "public_run_authority_sha256",
      "run_bundle_manifest_sha256",
      "run_bundle_archive_sha256",
      "bundle_commit_id",
    ] as const) {
      if (tuple[field] !== branch[field]) {
        addBindingIssue(
          context,
          ["result_tuples", index, field],
          `Result tuple ${field} does not match terminal coverage`,
        );
      }
    }
  }
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_CANONICAL_CONTRACT_BYTES) {
    addBindingIssue(context, [], "External ingestion projection exceeds the canonical byte limit");
  }
});

export type LearningExternalIngestionProjectionV1 = z.infer<
  typeof LearningExternalIngestionProjectionV1Schema
>;

export function learningExternalIngestionProjectionJson(value: unknown): string {
  return canonicalJson(LearningExternalIngestionProjectionV1Schema, value);
}

export function learningExternalIngestionProjectionDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningExternalIngestionProjectionJson(value))
    .digest("hex");
}

export function parseCanonicalLearningExternalIngestionProjectionJson(
  raw: string | Uint8Array,
): LearningExternalIngestionProjectionV1 {
  return parseCanonicalJson({
    contractName: "learning_external_ingestion_projection",
    maxBytes: MAX_CANONICAL_CONTRACT_BYTES,
    raw,
    schema: LearningExternalIngestionProjectionV1Schema,
  });
}

export const LearningExternalIngestionAttestationBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_external_ingestion_attestation_v1"),
  projection_sha256: DigestSha256Schema,
  database_binding_receipt_sha256: DigestSha256Schema,
  authority_head_sha256: DigestSha256Schema,
  attestor_service_identity: BoundedIdSchema,
  attestor_binary_sha256: DigestSha256Schema,
  attestor_policy_sha256: DigestSha256Schema,
  attestor_public_key_sha256: DigestSha256Schema,
  attestor_key_id: BoundedIdSchema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: BoundedIdSchema,
  attested_at: LearningExternalCanonicalUtcMillisSchema,
}).strict();

export type LearningExternalIngestionAttestationBodyV1 = z.infer<
  typeof LearningExternalIngestionAttestationBodyV1Schema
>;

export const LearningExternalIngestionAttestationEnvelopeV1Schema = z.object({
  body: LearningExternalIngestionAttestationBodyV1Schema,
  signature_algorithm: z.literal("ed25519-v1"),
  signature_base64: LearningExternalEd25519SignatureBase64Schema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(stableStringify(value), "utf8") > MAX_CANONICAL_ATTESTATION_BYTES) {
    addBindingIssue(context, [], "External ingestion attestation exceeds the canonical byte limit");
  }
});

export type LearningExternalIngestionAttestationEnvelopeV1 = z.infer<
  typeof LearningExternalIngestionAttestationEnvelopeV1Schema
>;

export function learningExternalIngestionAttestationJson(value: unknown): string {
  return canonicalJson(LearningExternalIngestionAttestationEnvelopeV1Schema, value);
}

export function learningExternalIngestionAttestationDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningExternalIngestionAttestationJson(value))
    .digest("hex");
}

export function parseCanonicalLearningExternalIngestionAttestationJson(
  raw: string | Uint8Array,
): LearningExternalIngestionAttestationEnvelopeV1 {
  return parseCanonicalJson({
    contractName: "learning_external_ingestion_attestation",
    maxBytes: MAX_CANONICAL_ATTESTATION_BYTES,
    raw,
    schema: LearningExternalIngestionAttestationEnvelopeV1Schema,
  });
}

export function verifyLearningExternalIngestionAttestation(args: Readonly<{
  envelope: unknown;
  projection: unknown;
  externalExecutionPolicy: ExternalExecutionPolicyV1;
  expectedAttestorServiceIdentity?: string;
}>): LearningExternalIngestionAttestationEnvelopeV1 {
  const envelope = LearningExternalIngestionAttestationEnvelopeV1Schema.parse(args.envelope);
  const projection = LearningExternalIngestionProjectionV1Schema.parse(args.projection);
  const policy = ExternalExecutionPolicyV1Schema.parse(args.externalExecutionPolicy);
  if (externalExecutionPolicyDigest(policy)
    !== projection.registered_revision.external_execution_policy_sha256) {
    throw new Error("learning_external_ingestion_external_execution_policy_digest_mismatch");
  }
  const expected = policy.runtime_authority_attestor;
  if (args.expectedAttestorServiceIdentity !== undefined
    && BoundedIdSchema.parse(args.expectedAttestorServiceIdentity) !== expected.service_identity) {
    throw new Error("learning_external_ingestion_attestor_service_identity_mismatch");
  }
  const expectedPublicKeyBase64 = LearningExternalEd25519PublicKeyBase64Schema.parse(
    expected.attestor_public_key_base64,
  );
  const expectedPublicKeySha256 = DigestSha256Schema.parse(
    expected.attestor_public_key_sha256,
  );
  if (learningExternalEd25519PublicKeyDigest(expectedPublicKeyBase64)
    !== expectedPublicKeySha256) {
    throw new Error("learning_external_ingestion_attestor_public_key_mismatch");
  }
  const body = envelope.body;
  const expectedBindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [body.projection_sha256,
      learningExternalIngestionProjectionDigest(projection), "projection_sha256"],
    [body.database_binding_receipt_sha256,
      projection.database_binding_receipt_sha256, "database_binding_receipt_sha256"],
    [body.authority_head_sha256,
      projection.authority_head.authority_head_sha256, "authority_head_sha256"],
    [body.attestor_service_identity, expected.service_identity, "attestor_service_identity"],
    [body.attestor_binary_sha256, expected.attestor_binary_sha256, "attestor_binary_sha256"],
    [body.attestor_policy_sha256, expected.attestor_policy_sha256, "attestor_policy_sha256"],
    [body.attestor_public_key_sha256,
      expectedPublicKeySha256, "attestor_public_key_sha256"],
    [body.attestor_key_id, expected.attestor_key_id, "attestor_key_id"],
    [body.service_launcher_policy_sha256,
      expected.service_launcher_policy_sha256, "service_launcher_policy_sha256"],
    [body.service_launcher_binary_sha256,
      expected.service_launcher_binary_sha256, "service_launcher_binary_sha256"],
    [body.service_launcher_public_key_sha256,
      expected.service_launcher_public_key_sha256,
      "service_launcher_public_key_sha256"],
    [body.service_launcher_key_id,
      expected.service_launcher_key_id, "service_launcher_key_id"],
    [projection.database_lineage.database_instance_id,
      expected.expected_database_instance_id, "database_instance_id"],
  ];
  for (const [actual, expected, field] of expectedBindings) {
    if (actual !== expected) {
      throw new Error(`learning_external_ingestion_attestation_binding_mismatch:${field}`);
    }
  }
  if (body.attested_at < projection.terminal_coverage_index.finalized_at) {
    throw new Error("learning_external_ingestion_attestation_precedes_terminal_coverage");
  }
  const verified = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningExternalIngestionAttestationBodyV1Schema,
    envelope,
    expectedPublicKeyBase64,
    expectedPublicKeySha256,
  });
  return LearningExternalIngestionAttestationEnvelopeV1Schema.parse(verified);
}
