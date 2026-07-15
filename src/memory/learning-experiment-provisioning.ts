import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";
import {
  LEARNING_STORE_SCOPE_MAX_UTF8_BYTES,
  RequiredExternalInputsV1Schema,
} from "./learning-episode-ledger.js";
import { toTenantScopeKey } from "./tenant.js";

const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const BoundedIdSchema = z.string().trim().min(1).max(256);
const ExactBoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected exact bounded UTF-8 identifier",
    });
  }
});
const ExactBoundedKindSchema = z.string().superRefine((value, context) => {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > 120) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected exact bounded UTF-8 kind",
    });
  }
});
const TenantIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u);
const CanonicalUtcMillisSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "Expected canonical UTC millisecond timestamp");

function canonicalUtf8Order(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
}

const CanonicalDigestArraySchema = z.array(DigestSha256Schema).max(100).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "digest list must be unique" });
  }
  if (stableStringify(values) !== stableStringify(canonicalUtf8Order(values))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "digest list must use canonical UTF-8 order" });
  }
});

function canonicalEnumArray<T extends z.ZodTypeAny>(schema: T, max: number) {
  return z.array(schema).max(max).superRefine((values, context) => {
    const strings = values as string[];
    if (new Set(strings).size !== strings.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "enum list must be unique" });
    }
    if (stableStringify(strings) !== stableStringify(canonicalUtf8Order(strings))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "enum list must use canonical UTF-8 order" });
    }
  });
}

const ExactExternalInputV1Schema = z.object({
  immutable_input_manifest_sha256: DigestSha256Schema,
  retry_policy_sha256: DigestSha256Schema,
  planned_run_id: ExactBoundedIdSchema,
}).strict();

export const LearningExperimentRequiredExternalInputsV1Schema = z.intersection(
  RequiredExternalInputsV1Schema,
  z.object({
    offline_paired: ExactExternalInputV1Schema,
    production_shadow: ExactExternalInputV1Schema,
    tool_e2e: ExactExternalInputV1Schema,
  }).strict(),
).superRefine((inputs, context) => {
  const plannedRunIds = [
    inputs.offline_paired.planned_run_id,
    inputs.production_shadow.planned_run_id,
    inputs.tool_e2e.planned_run_id,
  ];
  if (new Set(plannedRunIds).size !== plannedRunIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tool_e2e", "planned_run_id"],
      message: "External input planned run IDs must be unique",
    });
  }
});

export const LearningExperimentExternalInputSetV1Schema = z.object({
  contract_version: z.literal("aionis_learning_experiment_external_input_set_v1"),
  tenant_id: TenantIdSchema,
  task_family: ExactBoundedIdSchema,
  experiment_id: ExactBoundedIdSchema,
  experiment_revision: z.number().int().positive(),
  roles: LearningExperimentRequiredExternalInputsV1Schema,
}).strict();

export type LearningExperimentExternalInputSetV1 = z.infer<
  typeof LearningExperimentExternalInputSetV1Schema
>;

export function learningExperimentExternalInputSetDigest(value: LearningExperimentExternalInputSetV1): string {
  return sha256Hex(stableStringify(LearningExperimentExternalInputSetV1Schema.parse(value)));
}

export const LearningMemoryNamespacePublicScopeV1Schema = z.string().superRefine(
  (value, context) => {
    if (value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > LEARNING_STORE_SCOPE_MAX_UTF8_BYTES
      || value.startsWith("tenant:")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected an exact public scope bounded to 256 UTF-8 bytes without the reserved tenant prefix",
      });
    }
  },
);

const LearningMemoryNamespaceManifestMemberV1Schema = z.object({
  tenant_id: TenantIdSchema,
  public_scope: LearningMemoryNamespacePublicScopeV1Schema,
}).strict();

const LearningMemoryNamespaceMatchingCovariatesV1Schema = z.object({
  contract_version: z.literal("aionis_learning_matching_covariates_v1"),
  host_adapter_sha256: DigestSha256Schema,
  provider_model_route_sha256: DigestSha256Schema,
  region: ExactBoundedKindSchema,
  workload_stratum: ExactBoundedIdSchema,
}).strict();

const LearningMemoryNamespaceActivationV1Schema = z.object({
  activation_wave_index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  activation_starts_at: CanonicalUtcMillisSchema,
  index_window_ends_at: CanonicalUtcMillisSchema,
  wave_analysis_at: CanonicalUtcMillisSchema,
}).strict().superRefine((activation, context) => {
  if (!(activation.activation_starts_at < activation.index_window_ends_at
    && activation.index_window_ends_at < activation.wave_analysis_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Activation times must be strictly monotone",
    });
  }
});

const LearningMemoryNamespaceManifestPairV1Schema = z.object({
  members: z.tuple([
    LearningMemoryNamespaceManifestMemberV1Schema,
    LearningMemoryNamespaceManifestMemberV1Schema,
  ]),
  matching_covariates: LearningMemoryNamespaceMatchingCovariatesV1Schema,
  activation: LearningMemoryNamespaceActivationV1Schema,
}).strict().superRefine((pair, context) => {
  const memberKeys = pair.members.map((member) => stableStringify([
    member.tenant_id,
    member.public_scope,
  ]));
  if (memberKeys[0] === memberKeys[1]
    || stableStringify(memberKeys) !== stableStringify(canonicalUtf8Order(memberKeys))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["members"],
      message: "Pair members must be distinct and use canonical tenant/scope order",
    });
  }
});

function namespaceManifestPairKey(
  pair: z.infer<typeof LearningMemoryNamespaceManifestPairV1Schema>,
): string {
  return stableStringify([
    pair.activation.activation_wave_index,
    ...pair.members.map((member) => [member.tenant_id, member.public_scope]),
  ]);
}

export const LearningMemoryNamespaceManifestV1Schema = z.object({
  contract_version: z.literal("aionis_learning_memory_namespace_manifest_v1"),
  tenant_id: TenantIdSchema,
  task_family: ExactBoundedIdSchema,
  experiment_id: ExactBoundedIdSchema,
  experiment_revision: z.number().int().positive(),
  pairs: z.array(LearningMemoryNamespaceManifestPairV1Schema).length(384),
}).strict().superRefine((manifest, context) => {
  const memberKeys: string[] = [];
  const waveCounts = new Map<number, number>();
  const waveTimes = new Map<number, readonly [string, string, string]>();
  for (const [pairIndex, pair] of manifest.pairs.entries()) {
    for (const [memberIndex, member] of pair.members.entries()) {
      if (member.tenant_id !== manifest.tenant_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pairs", pairIndex, "members", memberIndex, "tenant_id"],
          message: "Namespace member tenant must match the manifest tenant",
        });
      }
      memberKeys.push(stableStringify([member.tenant_id, member.public_scope]));
    }
    const wave = pair.activation.activation_wave_index;
    waveCounts.set(wave, (waveCounts.get(wave) ?? 0) + 1);
    const times = [
      pair.activation.activation_starts_at,
      pair.activation.index_window_ends_at,
      pair.activation.wave_analysis_at,
    ] as const;
    const prior = waveTimes.get(wave);
    if (prior !== undefined && stableStringify(prior) !== stableStringify(times)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pairs", pairIndex, "activation"],
        message: "All pairs in one activation wave must share one frozen window",
      });
    } else {
      waveTimes.set(wave, times);
    }
  }
  if (new Set(memberKeys).size !== 768) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory namespace manifest requires 768 unique tenant/public scopes",
    });
  }
  if (waveCounts.get(1) !== 96 || waveCounts.get(2) !== 96 || waveCounts.get(3) !== 192) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory activation waves require exactly 96/96/192 pairs",
    });
  }
  const pairKeys = manifest.pairs.map(namespaceManifestPairKey);
  if (stableStringify(pairKeys) !== stableStringify(canonicalUtf8Order(pairKeys))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Namespace pairs must use canonical wave and tenant/scope order",
    });
  }
  const orderedTimes = [1, 2, 3].map((wave) => waveTimes.get(wave));
  if (orderedTimes.some((times) => times === undefined)
    || !(orderedTimes[0]![2] < orderedTimes[1]![0]
      && orderedTimes[1]![2] < orderedTimes[2]![0])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Activation wave windows must be strictly ordered and non-overlapping",
    });
  }
});

export type LearningMemoryNamespaceManifestV1 = z.infer<
  typeof LearningMemoryNamespaceManifestV1Schema
>;

export type LearningMemoryNamespaceScopeEncodingIssue = Readonly<{
  pair_index: number;
  member_index: number;
  scope_key_utf8_bytes: number;
}>;

export function learningMemoryNamespaceManifestScopeEncodingIssue(args: {
  manifest: LearningMemoryNamespaceManifestV1;
  defaultTenantId: string;
}): LearningMemoryNamespaceScopeEncodingIssue | null {
  for (const [pairIndex, pair] of args.manifest.pairs.entries()) {
    for (const [memberIndex, member] of pair.members.entries()) {
      const scopeKey = toTenantScopeKey(
        member.public_scope,
        member.tenant_id,
        args.defaultTenantId,
      );
      const scopeKeyUtf8Bytes = Buffer.byteLength(scopeKey, "utf8");
      if (scopeKeyUtf8Bytes > LEARNING_STORE_SCOPE_MAX_UTF8_BYTES) {
        return {
          pair_index: pairIndex,
          member_index: memberIndex,
          scope_key_utf8_bytes: scopeKeyUtf8Bytes,
        };
      }
    }
  }
  return null;
}

export function learningMemoryNamespaceManifestDigest(value: LearningMemoryNamespaceManifestV1): string {
  return sha256Hex(stableStringify(LearningMemoryNamespaceManifestV1Schema.parse(value)));
}

export const LearningExperimentApplicabilityProfileProjectionV1Schema = z.object({
  contract_version: z.literal("aionis_learning_experiment_applicability_profile_v1"),
  profile_id: z.string().trim().min(1).max(120),
  mode: z.enum(["shadow", "active"]),
  task_family: BoundedIdSchema,
  scope_selector_sha256s: CanonicalDigestArraySchema,
  scope_prefix_selector_sha256s: CanonicalDigestArraySchema,
  task_signature_selector_sha256s: CanonicalDigestArraySchema,
  agent_roles: canonicalEnumArray(
    z.enum(["agent", "planner", "worker", "verifier", "reviewer"]),
    16,
  ),
  context_modes: canonicalEnumArray(z.enum(["standard", "full_power", "compact_agent"]), 16),
  guide_modes: canonicalEnumArray(z.enum(["standard", "full_power"]), 16),
}).strict();

export type LearningExperimentApplicabilityProfileProjectionV1 = z.infer<
  typeof LearningExperimentApplicabilityProfileProjectionV1Schema
>;

const LearningExperimentPolicyBindingsV1Schema = z.object({
  candidate_policy_config_sha256: DigestSha256Schema,
  candidate_policy_implementation_sha256: DigestSha256Schema,
  gate_policy_config_sha256: DigestSha256Schema,
  gate_prospective_calibration_sha256: DigestSha256Schema,
  collection_source_policy_sha256: DigestSha256Schema,
  required_evidence_series_sha256: DigestSha256Schema,
  required_external_inputs_sha256: DigestSha256Schema,
  external_execution_policy_sha256: DigestSha256Schema,
}).strict();

const LearningExperimentApplicabilityCollectionSourceV1Schema = z.object({
  collection_principal_sha256: DigestSha256Schema,
  collection_class: z.enum(["eligible_host", "fixture_pilot"]),
  collector_id: BoundedIdSchema,
  collector_version: z.string().trim().min(1).max(120),
  verifier_policy_sha256: DigestSha256Schema,
  binding_sha256: DigestSha256Schema,
}).strict();

const LearningExperimentConfirmatoryCohortMemberV1Schema = z.object({
  pair_member_ordinal: z.union([z.literal(0), z.literal(1)]),
  memory_namespace_sha256: DigestSha256Schema,
  namespace_lease_id_sha256: DigestSha256Schema,
  namespace_lease_generation: z.number().int().positive(),
}).strict();

const LearningExperimentConfirmatoryCohortPairV1Schema = z.object({
  pair_ordinal: z.number().int().min(0).max(383),
  randomization_pair_sha256: DigestSha256Schema,
  pair_record_sha256: DigestSha256Schema,
  matching_covariate_sha256: DigestSha256Schema,
  activation_wave_index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  activation_starts_at: CanonicalUtcMillisSchema,
  index_window_ends_at: CanonicalUtcMillisSchema,
  wave_analysis_at: CanonicalUtcMillisSchema,
  members: z.tuple([
    LearningExperimentConfirmatoryCohortMemberV1Schema,
    LearningExperimentConfirmatoryCohortMemberV1Schema,
  ]),
}).strict().superRefine((pair, context) => {
  if (!(pair.activation_starts_at < pair.index_window_ends_at
    && pair.index_window_ends_at < pair.wave_analysis_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activation_starts_at"],
      message: "Confirmatory cohort wave times must be strictly monotone",
    });
  }
  if (pair.members[0].pair_member_ordinal !== 0 || pair.members[1].pair_member_ordinal !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["members"],
      message: "Confirmatory cohort members must use canonical ordinal order 0,1",
    });
  }
});

export type LearningExperimentConfirmatoryCohortPairV1 = z.infer<
  typeof LearningExperimentConfirmatoryCohortPairV1Schema
>;

export function learningConfirmatoryNamespaceSetDigest(
  pairs: readonly LearningExperimentConfirmatoryCohortPairV1[],
): string {
  return sha256Hex(stableStringify(canonicalUtf8Order(
    pairs.flatMap((pair) => pair.members.map((member) => member.memory_namespace_sha256)),
  )));
}

export function learningConfirmatoryPairManifestDigest(
  pairs: readonly LearningExperimentConfirmatoryCohortPairV1[],
): string {
  return sha256Hex(stableStringify([...pairs]
    .sort((left, right) => left.pair_ordinal - right.pair_ordinal)
    .map((pair) => ({
      pair_ordinal: pair.pair_ordinal,
      randomization_pair_sha256: pair.randomization_pair_sha256,
      pair_record_sha256: pair.pair_record_sha256,
    }))));
}

export function learningConfirmatoryActivationScheduleDigest(
  pairs: readonly LearningExperimentConfirmatoryCohortPairV1[],
): string {
  const waves = new Map<number, {
    activation_wave_index: number;
    activation_starts_at: string;
    index_window_ends_at: string;
    wave_analysis_at: string;
    pair_count: number;
  }>();
  for (const pair of pairs) {
    const existing = waves.get(pair.activation_wave_index);
    if (existing) {
      existing.pair_count += 1;
      continue;
    }
    waves.set(pair.activation_wave_index, {
      activation_wave_index: pair.activation_wave_index,
      activation_starts_at: pair.activation_starts_at,
      index_window_ends_at: pair.index_window_ends_at,
      wave_analysis_at: pair.wave_analysis_at,
      pair_count: 1,
    });
  }
  return sha256Hex(stableStringify([...waves.values()].sort(
    (left, right) => left.activation_wave_index - right.activation_wave_index,
  )));
}

export function learningConfirmatoryNamespaceLeaseMembershipDigest(
  pairs: readonly LearningExperimentConfirmatoryCohortPairV1[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_learning_namespace_lease_membership_v1",
    members: [...pairs]
      .sort((left, right) => left.pair_ordinal - right.pair_ordinal)
      .flatMap((pair) => pair.members.map((member) => ({
        pair_ordinal: pair.pair_ordinal,
        randomization_pair_sha256: pair.randomization_pair_sha256,
        pair_member_ordinal: member.pair_member_ordinal,
        memory_namespace_sha256: member.memory_namespace_sha256,
        namespace_lease_id_sha256: member.namespace_lease_id_sha256,
        namespace_lease_generation: member.namespace_lease_generation,
        activation_wave_index: pair.activation_wave_index,
      }))),
  }));
}

export const LearningExperimentConfirmatoryApplicabilityCohortV1Schema = z.object({
  contract_version: z.literal("aionis_learning_confirmatory_applicability_cohort_v1"),
  confirmatory_attempt_id: ExactBoundedIdSchema,
  confirmatory_attempt_sha256: DigestSha256Schema,
  eligible_memory_namespace_set_sha256: DigestSha256Schema,
  eligible_memory_namespace_count: z.literal(768),
  randomization_pair_manifest_sha256: DigestSha256Schema,
  randomization_pair_count: z.literal(384),
  activation_schedule_sha256: DigestSha256Schema,
  namespace_lease_membership_sha256: DigestSha256Schema,
  namespace_lease_count: z.literal(768),
  pairs: z.array(LearningExperimentConfirmatoryCohortPairV1Schema).length(384),
}).strict().superRefine((cohort, context) => {
  const pairHashes = cohort.pairs.map((pair) => pair.randomization_pair_sha256);
  if (new Set(pairHashes).size !== 384
    || stableStringify(pairHashes) !== stableStringify(canonicalUtf8Order(pairHashes))
    || cohort.pairs.some((pair, index) => pair.pair_ordinal !== index)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory cohort pairs must be unique and ordered by pair hash with complete ordinals",
    });
  }
  const namespaces = cohort.pairs.flatMap((pair) =>
    pair.members.map((member) => member.memory_namespace_sha256));
  const leases = cohort.pairs.flatMap((pair) =>
    pair.members.map((member) => member.namespace_lease_id_sha256));
  if (new Set(namespaces).size !== 768 || new Set(leases).size !== 768) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory cohort requires 768 unique namespace and lease hashes",
    });
  }
  const waveCounts = new Map<number, number>();
  const waveTimes = new Map<number, string>();
  for (const [index, pair] of cohort.pairs.entries()) {
    const wave = pair.activation_wave_index;
    waveCounts.set(wave, (waveCounts.get(wave) ?? 0) + 1);
    const signature = stableStringify([
      pair.activation_starts_at,
      pair.index_window_ends_at,
      pair.wave_analysis_at,
    ]);
    const prior = waveTimes.get(wave);
    if (prior !== undefined && prior !== signature) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pairs", index],
        message: "Confirmatory cohort pairs in one wave must share one frozen window",
      });
    } else {
      waveTimes.set(wave, signature);
    }
  }
  if (waveCounts.get(1) !== 96 || waveCounts.get(2) !== 96 || waveCounts.get(3) !== 192) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory cohort activation waves require exactly 96/96/192 pairs",
    });
  }
  const orderedTimes = [1, 2, 3].map((wave) => {
    const signature = waveTimes.get(wave);
    return signature === undefined ? null : JSON.parse(signature) as [string, string, string];
  });
  if (orderedTimes.some((times) => times === null)
    || !(orderedTimes[0]![2] < orderedTimes[1]![0]
      && orderedTimes[1]![2] < orderedTimes[2]![0])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory cohort wave windows must be strictly ordered and non-overlapping",
    });
  }
  const digestBindings = [
    [cohort.eligible_memory_namespace_set_sha256, learningConfirmatoryNamespaceSetDigest(cohort.pairs)],
    [cohort.randomization_pair_manifest_sha256, learningConfirmatoryPairManifestDigest(cohort.pairs)],
    [cohort.activation_schedule_sha256, learningConfirmatoryActivationScheduleDigest(cohort.pairs)],
    [cohort.namespace_lease_membership_sha256,
      learningConfirmatoryNamespaceLeaseMembershipDigest(cohort.pairs)],
  ] as const;
  if (digestBindings.some(([actual, expected]) => actual !== expected)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pairs"],
      message: "Confirmatory applicability cohort digest binding mismatch",
    });
  }
});

export type LearningExperimentConfirmatoryApplicabilityCohortV1 = z.infer<
  typeof LearningExperimentConfirmatoryApplicabilityCohortV1Schema
>;

const LearningExperimentApplicabilityManifestCommonV1Schema = z.object({
  contract_version: z.literal("aionis_learning_experiment_applicability_manifest_v1"),
  tenant_id: BoundedIdSchema,
  provision_operation_id_sha256: DigestSha256Schema,
  provision_request_sha256: DigestSha256Schema,
  provisioning_actor_sha256: DigestSha256Schema,
  runtime_authority_lineage_sha256: DigestSha256Schema,
  experiment_id: BoundedIdSchema,
  experiment_revision: z.number().int().positive(),
  profile_rule_sha256: DigestSha256Schema,
  experiment_declaration_sha256: DigestSha256Schema,
  experiment_config_sha256: DigestSha256Schema,
  task_family: BoundedIdSchema,
  profile: LearningExperimentApplicabilityProfileProjectionV1Schema,
  policy_bindings: LearningExperimentPolicyBindingsV1Schema,
  diagnostic_assignment_seed_sha256: DigestSha256Schema,
  collection_sources: z.array(LearningExperimentApplicabilityCollectionSourceV1Schema).max(100),
});

function validateApplicabilityManifestCommon(
  manifest: z.infer<typeof LearningExperimentApplicabilityManifestCommonV1Schema>,
  context: z.RefinementCtx,
): void {
  const principals = manifest.collection_sources.map((source) => source.collection_principal_sha256);
  if (new Set(principals).size !== principals.length
    || stableStringify(principals) !== stableStringify(canonicalUtf8Order(principals))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["collection_sources"],
      message: "Collection sources must be unique and sorted by principal fingerprint",
    });
  }
  if (manifest.profile.task_family !== manifest.task_family) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["profile", "task_family"],
      message: "Profile task family must match the manifest task family",
    });
  }
}

const LearningExperimentIntegrityApplicabilityManifestV1Schema =
  LearningExperimentApplicabilityManifestCommonV1Schema.extend({
  serving_phase: z.enum(["aa", "shadow"]),
  evidence_intent: z.literal("integrity_only"),
  assignment_design: z.literal("diagnostic_hash_v1"),
  cohort: z.null(),
  provisioned_at: CanonicalUtcMillisSchema,
}).strict().superRefine((manifest, context) => {
  validateApplicabilityManifestCommon(manifest, context);
});

const LearningExperimentConfirmatoryApplicabilityManifestV1Schema =
  LearningExperimentApplicabilityManifestCommonV1Schema.extend({
  serving_phase: z.literal("active_control"),
  evidence_intent: z.literal("confirmatory"),
  assignment_design: z.literal("matched_pair_complete_randomization_v1"),
  memory_namespace_manifest_sha256: DigestSha256Schema,
  external_input_set_sha256: DigestSha256Schema,
  tenant_scope_encoding_sha256: DigestSha256Schema,
  confirmatory_assignment_bits_sha256: DigestSha256Schema,
  cohort: LearningExperimentConfirmatoryApplicabilityCohortV1Schema,
  provisioned_at: CanonicalUtcMillisSchema,
}).strict().superRefine((manifest, context) => {
  validateApplicabilityManifestCommon(manifest, context);
});

export const LearningExperimentApplicabilityManifestV1Schema = z.union([
  LearningExperimentIntegrityApplicabilityManifestV1Schema,
  LearningExperimentConfirmatoryApplicabilityManifestV1Schema,
]);

export type LearningExperimentApplicabilityManifestV1 = z.infer<
  typeof LearningExperimentApplicabilityManifestV1Schema
>;

const LearningExperimentProvisionReceiptCommonV1Schema = z.object({
  contract_version: z.literal("aionis_learning_experiment_provision_receipt_v1"),
  operation_kind: z.literal("learning_experiment_provision_v1"),
  operation_id: BoundedIdSchema,
  request_sha256: DigestSha256Schema,
  tenant_id: BoundedIdSchema,
  authority_scope: z.literal("learning-experiment-authority-v1"),
  runtime_authority_lineage_sha256: DigestSha256Schema,
  actor: BoundedIdSchema,
  status: z.literal("provisioned"),
});

const LearningExperimentConfirmatoryAssignmentSummaryV1Schema = z.object({
  assignment_design: z.literal("matched_pair_complete_randomization_v1"),
  assignment_algorithm: z.literal("matched_pair_csprng_bit_v1"),
  confirmatory_assignment_bits_sha256: DigestSha256Schema,
  confirmatory_assignment_bit_count: z.literal(384),
  confirmatory_assignment_random_bytes: z.literal(48),
  confirmatory_assignment_bit_order: z.literal(
    "canonical_pair_hash_ascending_bit_zero_first_msb_first",
  ),
  randomness_rejection_or_redraw_allowed: z.literal(false),
}).strict();

export const LearningExperimentConfirmatoryProvisionSummaryV1Schema = z.object({
  contract_version: z.literal("aionis_learning_confirmatory_provision_summary_v1"),
  confirmatory_attempt_id: ExactBoundedIdSchema,
  confirmatory_attempt_sha256: DigestSha256Schema,
  eligible_memory_namespace_set_sha256: DigestSha256Schema,
  eligible_memory_namespace_count: z.literal(768),
  randomization_pair_manifest_sha256: DigestSha256Schema,
  randomization_pair_count: z.literal(384),
  activation_schedule_sha256: DigestSha256Schema,
  namespace_lease_membership_sha256: DigestSha256Schema,
  namespace_lease_count: z.literal(768),
  planned_candidate_namespace_count: z.literal(384),
  planned_control_namespace_count: z.literal(384),
  assignment: LearningExperimentConfirmatoryAssignmentSummaryV1Schema,
}).strict();

const LearningExperimentIntegrityProvisionReceiptV1Schema =
  LearningExperimentProvisionReceiptCommonV1Schema.extend({
  experiment: z.object({
    experiment_id: BoundedIdSchema,
    experiment_revision: z.number().int().positive(),
    profile_id: z.string().trim().min(1).max(120),
    profile_rule_sha256: DigestSha256Schema,
    experiment_config_sha256: DigestSha256Schema,
    serving_phase: z.enum(["aa", "shadow"]),
    evidence_intent: z.literal("integrity_only"),
  }).strict(),
  policy_bindings: LearningExperimentPolicyBindingsV1Schema,
  cohort: z.null(),
  applicability_manifest_sha256: DigestSha256Schema,
  applicability_manifest: LearningExperimentIntegrityApplicabilityManifestV1Schema,
}).strict().superRefine((receipt, context) => {
  if (receipt.tenant_id !== receipt.applicability_manifest.tenant_id
    || sha256Hex(receipt.operation_id)
      !== receipt.applicability_manifest.provision_operation_id_sha256
    || receipt.request_sha256 !== receipt.applicability_manifest.provision_request_sha256
    || sha256Hex(receipt.actor) !== receipt.applicability_manifest.provisioning_actor_sha256
    || receipt.runtime_authority_lineage_sha256
      !== receipt.applicability_manifest.runtime_authority_lineage_sha256
    || receipt.experiment.experiment_id !== receipt.applicability_manifest.experiment_id
    || receipt.experiment.experiment_revision !== receipt.applicability_manifest.experiment_revision
    || receipt.experiment.profile_id !== receipt.applicability_manifest.profile.profile_id
    || receipt.experiment.profile_rule_sha256 !== receipt.applicability_manifest.profile_rule_sha256
    || receipt.experiment.experiment_config_sha256
      !== receipt.applicability_manifest.experiment_config_sha256
    || receipt.experiment.serving_phase !== receipt.applicability_manifest.serving_phase
    || receipt.experiment.evidence_intent !== receipt.applicability_manifest.evidence_intent
    || stableStringify(receipt.policy_bindings)
      !== stableStringify(receipt.applicability_manifest.policy_bindings)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["applicability_manifest"],
      message: "receipt and applicability manifest bindings disagree",
    });
  }
  const manifestSha256 = sha256Hex(stableStringify(receipt.applicability_manifest));
  if (receipt.applicability_manifest_sha256 !== manifestSha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["applicability_manifest_sha256"],
      message: "applicability manifest digest mismatch",
    });
  }
});

const LearningExperimentConfirmatoryProvisionReceiptV1Schema =
  LearningExperimentProvisionReceiptCommonV1Schema.extend({
  experiment: z.object({
    experiment_id: BoundedIdSchema,
    experiment_revision: z.number().int().positive(),
    profile_id: z.string().trim().min(1).max(120),
    profile_rule_sha256: DigestSha256Schema,
    experiment_config_sha256: DigestSha256Schema,
    serving_phase: z.literal("active_control"),
    evidence_intent: z.literal("confirmatory"),
  }).strict(),
  policy_bindings: LearningExperimentPolicyBindingsV1Schema,
  input_bindings: z.object({
    memory_namespace_manifest_sha256: DigestSha256Schema,
    external_input_set_sha256: DigestSha256Schema,
    tenant_scope_encoding_sha256: DigestSha256Schema,
  }).strict(),
  cohort: LearningExperimentConfirmatoryProvisionSummaryV1Schema,
  applicability_manifest_sha256: DigestSha256Schema,
  applicability_manifest: LearningExperimentConfirmatoryApplicabilityManifestV1Schema,
}).strict().superRefine((receipt, context) => {
  const manifest = receipt.applicability_manifest;
  const commonBindingsDisagree = receipt.tenant_id !== manifest.tenant_id
    || sha256Hex(receipt.operation_id) !== manifest.provision_operation_id_sha256
    || receipt.request_sha256 !== manifest.provision_request_sha256
    || sha256Hex(receipt.actor) !== manifest.provisioning_actor_sha256
    || receipt.runtime_authority_lineage_sha256 !== manifest.runtime_authority_lineage_sha256
    || receipt.experiment.experiment_id !== manifest.experiment_id
    || receipt.experiment.experiment_revision !== manifest.experiment_revision
    || receipt.experiment.profile_id !== manifest.profile.profile_id
    || receipt.experiment.profile_rule_sha256 !== manifest.profile_rule_sha256
    || receipt.experiment.experiment_config_sha256 !== manifest.experiment_config_sha256
    || receipt.experiment.serving_phase !== manifest.serving_phase
    || receipt.experiment.evidence_intent !== manifest.evidence_intent
    || stableStringify(receipt.policy_bindings) !== stableStringify(manifest.policy_bindings);
  const inputBindingsDisagree = receipt.input_bindings.memory_namespace_manifest_sha256
      !== manifest.memory_namespace_manifest_sha256
    || receipt.input_bindings.external_input_set_sha256 !== manifest.external_input_set_sha256
    || receipt.input_bindings.tenant_scope_encoding_sha256
      !== manifest.tenant_scope_encoding_sha256;
  const cohortBindingsDisagree = receipt.cohort.confirmatory_attempt_id
      !== manifest.cohort.confirmatory_attempt_id
    || receipt.cohort.confirmatory_attempt_sha256
      !== manifest.cohort.confirmatory_attempt_sha256
    || receipt.cohort.eligible_memory_namespace_set_sha256
      !== manifest.cohort.eligible_memory_namespace_set_sha256
    || receipt.cohort.eligible_memory_namespace_count
      !== manifest.cohort.eligible_memory_namespace_count
    || receipt.cohort.randomization_pair_manifest_sha256
      !== manifest.cohort.randomization_pair_manifest_sha256
    || receipt.cohort.randomization_pair_count !== manifest.cohort.randomization_pair_count
    || receipt.cohort.activation_schedule_sha256 !== manifest.cohort.activation_schedule_sha256
    || receipt.cohort.namespace_lease_membership_sha256
      !== manifest.cohort.namespace_lease_membership_sha256
    || receipt.cohort.namespace_lease_count !== manifest.cohort.namespace_lease_count
    || receipt.cohort.assignment.confirmatory_assignment_bits_sha256
      !== manifest.confirmatory_assignment_bits_sha256;
  if (commonBindingsDisagree || inputBindingsDisagree || cohortBindingsDisagree) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["applicability_manifest"],
      message: "Confirmatory receipt and applicability manifest bindings disagree",
    });
  }
  const manifestSha256 = sha256Hex(stableStringify(manifest));
  if (receipt.applicability_manifest_sha256 !== manifestSha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["applicability_manifest_sha256"],
      message: "Applicability manifest digest mismatch",
    });
  }
});

export const LearningExperimentProvisionReceiptV1Schema = z.union([
  LearningExperimentIntegrityProvisionReceiptV1Schema,
  LearningExperimentConfirmatoryProvisionReceiptV1Schema,
]);

export type LearningExperimentProvisionReceiptV1 = z.infer<
  typeof LearningExperimentProvisionReceiptV1Schema
>;

const SECRET_KEY_PATTERN = /(?:^|_)(?:api_?key|authorization|credential|password|private_?key|secret)(?:_|$)/iu;
const ASSIGNMENT_AUTHORITY_KEY_PATTERN = /(?:assignment.*(?:seed|bits|randomness)|assigned_arm|store_scope)/iu;
const SECRET_VALUE_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|\bAKIA[0-9A-Z]{16}\b|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{20,})/u;

export function assertLearningExperimentApplicabilityManifestSafe(
  value: LearningExperimentApplicabilityManifestV1,
): void {
  const parsed = LearningExperimentApplicabilityManifestV1Schema.parse(value);
  const visit = (candidate: unknown, path: string): void => {
    if (candidate instanceof Uint8Array || Buffer.isBuffer(candidate)) {
      throw new Error(`learning_experiment_applicability_secret_scan_binary:${path}`);
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof candidate === "string" && SECRET_VALUE_PATTERN.test(candidate)) {
      throw new Error(`learning_experiment_applicability_secret_scan_value:${path}`);
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)
        || (ASSIGNMENT_AUTHORITY_KEY_PATTERN.test(key) && !key.endsWith("_sha256"))) {
        throw new Error(`learning_experiment_applicability_secret_scan_key:${path}.${key}`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(parsed, "$manifest");
  if (Buffer.byteLength(stableStringify(parsed), "utf8") > 512 * 1024) {
    throw new Error("learning_experiment_applicability_manifest_too_large");
  }
}

export function learningExperimentApplicabilityManifestDigest(
  value: LearningExperimentApplicabilityManifestV1,
): string {
  const parsed = LearningExperimentApplicabilityManifestV1Schema.parse(value);
  assertLearningExperimentApplicabilityManifestSafe(parsed);
  return sha256Hex(stableStringify(parsed));
}
