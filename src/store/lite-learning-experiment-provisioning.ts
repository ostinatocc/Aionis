import { createHash, randomBytes as operatingSystemRandomBytes } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import {
  admissionCandidatePolicyExperimentDeclarationDigest,
  admissionCandidatePolicyProfileRuleDigest,
  loadEnv,
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../config.js";
import {
  resolveAdmissionCandidatePolicy,
  type AdmissionCandidatePolicyRegistryEntry,
} from "../memory/admission-candidate-policy.js";
import {
  PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY,
  type LearningExternalExecutionPolicyRegistryEntry,
} from "../memory/learning-external-execution-policy.js";
import {
  LEARNING_COLLECTION_SOURCE_POLICY_STRICT_VALIDATION_CONTRACT,
  LearningExperimentExternalInputSetV1Schema,
  LearningExperimentApplicabilityProfileProjectionV1Schema,
  LearningMemoryNamespaceManifestV1Schema,
  LearningExperimentProvisionReceiptV1Schema,
  learningExperimentExternalInputSetDigest,
  learningExperimentApplicabilityManifestDigest,
  learningMemoryNamespaceManifestScopeEncodingIssue,
  learningMemoryNamespaceManifestDigest,
  type LearningExperimentConfirmatoryApplicabilityCohortV1,
  type LearningExperimentExternalInputSetV1,
  type LearningExperimentApplicabilityManifestV1,
  type LearningExperimentApplicabilityProfileProjectionV1,
  type LearningMemoryNamespaceManifestV1,
  type LearningExperimentProvisionReceiptV1,
} from "../memory/learning-experiment-provisioning.js";
import {
  ExternalExecutionPolicyV1Schema,
  asStoreScope,
  confirmatoryMatchedPairAssignment,
  externalExecutionPolicyDigest,
  learningAssignmentUnitSha256,
  learningMemoryNamespaceSha256,
} from "../memory/learning-episode-ledger.js";
import { learningCollectionSourcePolicyProjection } from "../memory/learning-experiment-resolver.js";
import {
  resolveLearningGatePolicy,
  type LearningGatePolicyRegistryEntry,
} from "../memory/learning-gate-policy.js";
import { sha256Hex } from "../util/crypto.js";
import { resolveTenantScope } from "../memory/tenant.js";
import {
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  createLiteLearningEpisodeLedgerAccess,
  learningActivationScheduleDigest,
  learningCollectionPrincipalBindingDigest,
  learningConfirmatoryAttemptDigest,
  learningRandomizationPairIdentityDigest,
  learningRandomizationPairManifestDigest,
  learningRandomizationPairRecordDigest,
  type LiteLearningConfirmatoryPreTreatmentLineageSnapshot,
  type LiteLearningAuthorityRow,
  type LiteLearningEpisodeLedgerAccess,
} from "./lite-learning-episode-ledger.js";
import {
  buildApplicabilityManifestFromDatabase,
  buildConfirmatoryApplicabilityCohort,
} from "./lite-learning-experiment-applicability.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "./lite-runtime-database.js";
import {
  LiteTenantScopeAuthorityError,
  assertLiteTenantScopeEncodingAnchor,
  assertLiteTenantScopeEncodingAnchorSetIntegrity,
  ensureLiteTenantScopeEncodingAnchor,
  tenantScopeEncodingDigest,
} from "./lite-tenant-scope-authority.js";
import type { SqliteDatabase } from "./sqlite.js";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteOperationRow,
  type LiteWriteStore,
} from "./lite-write-store.js";

export const LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND =
  "learning_experiment_provision_v1" as const;
export const LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE =
  "learning-experiment-authority-v1" as const;

const CONFIRMATORY_PROVISION_BEGIN_BUSY_RETRY = {
  // Runtime connections already wait five seconds inside each SQLite BEGIN.
  // Six attempts keep confirmatory provisioning bounded to roughly 30 seconds
  // without changing the connection-wide busy_timeout for unrelated writes.
  maxAttempts: 6,
  delayMs: 25,
} as const;

type ProvisioningGatePolicyRegistryEntry = Readonly<{
  policy_id: string;
  policy_version: string;
  registry_status: "calibration_pending" | "registered";
  config: unknown;
  policy_config_sha256: string;
  implementation_contract_sha256: string;
  prospective_calibration_artifact_sha256: string | null;
  prospective_calibration_artifact: unknown | null;
}>;

export type LearningExperimentProvisioningRegistry = Readonly<{
  resolveCandidatePolicy(
    policyId: string,
    policyVersion: string,
  ): AdmissionCandidatePolicyRegistryEntry;
  resolveGatePolicy(
    policyId: string,
    policyVersion: string,
  ): ProvisioningGatePolicyRegistryEntry;
  resolveExternalExecutionPolicy(
    registryKey: string,
    databaseInstanceId: string,
  ): LearningExternalExecutionPolicyRegistryEntry | null;
}>;

function productionGatePolicy(
  policyId: string,
  policyVersion: string,
): ProvisioningGatePolicyRegistryEntry {
  const policy: LearningGatePolicyRegistryEntry = resolveLearningGatePolicy(policyId, policyVersion);
  return {
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    registry_status: policy.registry_status,
    config: policy.config,
    policy_config_sha256: policy.policy_config_sha256,
    implementation_contract_sha256: policy.implementation_contract_sha256,
    prospective_calibration_artifact_sha256: policy.prospective_calibration_artifact_sha256,
    prospective_calibration_artifact: null,
  };
}

export const PRODUCTION_LEARNING_EXPERIMENT_PROVISIONING_REGISTRY:
LearningExperimentProvisioningRegistry = Object.freeze({
  resolveCandidatePolicy: (policyId: string, policyVersion: string) =>
    resolveAdmissionCandidatePolicy(policyId, policyVersion),
  resolveGatePolicy: productionGatePolicy,
  resolveExternalExecutionPolicy: (registryKey: string, databaseInstanceId: string) =>
    PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY.resolve({
      registryKey,
      databaseInstanceId,
    }),
});

export type LearningExperimentProvisionInput = Readonly<{
  tenantId: string;
  actor: string;
  operationId: string;
  profileRule: AionisAdmissionCandidatePolicyProfileRule;
  taskFamily: string;
  experimentId: string;
  experimentRevision: number;
  memoryNamespaceManifest?: LearningMemoryNamespaceManifestV1;
  externalInputSet?: LearningExperimentExternalInputSetV1;
}>;

/**
 * Internal composition/test seam. The production top-level provision function
 * and CLI deliberately do not accept this object, so registry status and
 * assignment entropy cannot be overridden by operator input.
 * @internal
 */
export type LearningExperimentProvisioningDependencies = Readonly<{
  registry?: LearningExperimentProvisioningRegistry;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => string;
  defaultTenantId?: string;
}>;

export type LearningExperimentProvisionResult = Readonly<{
  receipt: LearningExperimentProvisionReceiptV1;
  receiptJson: string;
  applicabilityManifest: LearningExperimentApplicabilityManifestV1;
  applicabilityManifestJson: string;
  replayed: boolean;
}>;

export class LearningExperimentProvisioningError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "LearningExperimentProvisioningError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function provisioningError(code: string, message: string, statusCode = 400): never {
  throw new LearningExperimentProvisioningError(code, message, statusCode);
}

function tenantScopeAuthorityProvisioningError(error: unknown): never {
  if (error instanceof LiteTenantScopeAuthorityError) {
    provisioningError(
      error.code.replace(/^lite_/u, "learning_experiment_"),
      error.message,
      409,
    );
  }
  throw error;
}

function preflightTenantScopeAuthority(
  db: SqliteDatabase,
  defaultTenantId: string,
): void {
  try {
    const existing = assertLiteTenantScopeEncodingAnchorSetIntegrity(db);
    if (existing) assertLiteTenantScopeEncodingAnchor(db, defaultTenantId);
  } catch (error) {
    tenantScopeAuthorityProvisioningError(error);
  }
}

function assertTenantScopeAuthority(
  db: SqliteDatabase,
  defaultTenantId: string,
): void {
  try {
    assertLiteTenantScopeEncodingAnchor(db, defaultTenantId);
  } catch (error) {
    tenantScopeAuthorityProvisioningError(error);
  }
}

function ensureTenantScopeAuthority(
  database: LiteRuntimeDatabase,
  defaultTenantId: string,
): void {
  try {
    ensureLiteTenantScopeEncodingAnchor(
      database.db,
      database.transaction,
      defaultTenantId,
    );
  } catch (error) {
    tenantScopeAuthorityProvisioningError(error);
  }
}

function boundedExact(value: string, field: string, max = 256): string {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > max) {
    provisioningError("learning_experiment_provision_input_invalid", `${field} must be exact bounded UTF-8 text`);
  }
  return trimmed;
}

function canonical<T>(value: T): { value: T; json: string; sha256: string } {
  const json = stableStringify(value);
  return { value, json, sha256: sha256Hex(json) };
}

function canonicalUtcMillis(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value) {
    throw new Error("learning experiment provisioning clock must return canonical UTC milliseconds");
  }
  return value;
}

function provisioningDefaultTenantId(explicit: string | undefined): string {
  const candidate = explicit ?? loadEnv().MEMORY_TENANT_ID;
  return resolveTenantScope(
    { tenant_id: candidate, scope: "__aionis_tenant_scope_encoding_probe__" },
    { defaultTenantId: candidate, defaultScope: "__aionis_tenant_scope_encoding_probe__" },
  ).tenant_id;
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicAuthorityId(domain: string, value: unknown): string {
  return `${domain}_${sha256Hex(stableStringify(value))}`;
}

function assertConfirmatoryGateDesign(
  gateConfig: unknown,
  candidateAllocationBps: number,
): void {
  if (!gateConfig || typeof gateConfig !== "object" || Array.isArray(gateConfig)) {
    provisioningError(
      "learning_experiment_gate_design_mismatch",
      "registered gate configuration is not a canonical object",
      409,
    );
  }
  const config = gateConfig as Record<string, unknown>;
  const exact = candidateAllocationBps === 5_000
    && config.confirmatory_candidate_allocation_bps === 5_000
    && config.confirmatory_pair_count === 384
    && config.confirmatory_namespace_count === 768
    && config.confirmatory_assignment_random_bytes === 48
    && config.confirmatory_assignment_bit_count === 384
    && config.confirmatory_assignment_bit_order
      === "canonical_pair_hash_ascending_bit_zero_first_msb_first"
    && config.confirmatory_randomness_rejection_or_redraw_allowed === false
    && stableStringify(config.activation_wave_pair_counts) === stableStringify([96, 96, 192]);
  if (!exact) {
    provisioningError(
      "learning_experiment_gate_design_mismatch",
      "registered gate does not match the frozen confirmatory v1 design",
      409,
    );
  }
}

function canonicalUnique(values: readonly string[] | undefined, field: string): string[] {
  const resolved = values ?? [];
  if (new Set(resolved).size !== resolved.length) {
    provisioningError("learning_experiment_profile_selector_invalid", `${field} must not contain duplicates`);
  }
  return [...resolved].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
}

function hashedSelectors(values: readonly string[] | undefined, field: string): string[] {
  return canonicalUnique(values, field).map((value) => sha256Hex(value)).sort();
}

function strictProfileRule(
  rawRule: AionisAdmissionCandidatePolicyProfileRule,
): AionisAdmissionCandidatePolicyProfileRule {
  const [rule] = parseAdmissionCandidatePolicyProfileRules(stableStringify([rawRule]));
  if (!rule) provisioningError("learning_experiment_profile_rule_invalid", "profile rule is missing");
  return rule;
}

function prepareInput(input: LearningExperimentProvisionInput) {
  const tenantId = boundedExact(input.tenantId, "tenantId");
  const actor = boundedExact(input.actor, "actor");
  const operationId = boundedExact(input.operationId, "operationId");
  const taskFamily = boundedExact(input.taskFamily, "taskFamily");
  const experimentId = boundedExact(input.experimentId, "experimentId");
  if (!Number.isInteger(input.experimentRevision) || input.experimentRevision < 1) {
    provisioningError("learning_experiment_provision_input_invalid", "experimentRevision must be positive");
  }
  const rule = strictProfileRule(input.profileRule);
  const experiment = rule.experiment;
  if (!experiment) {
    provisioningError("learning_experiment_profile_rule_invalid", "profile rule has no experiment declaration");
  }
  if (experiment.experiment_id !== experimentId || experiment.revision !== input.experimentRevision) {
    provisioningError(
      "learning_experiment_profile_identity_mismatch",
      "CLI experiment identity does not match the immutable profile declaration",
      409,
    );
  }
  if (stableStringify(rule.task_families ?? []) !== stableStringify([taskFamily])) {
    provisioningError(
      "learning_experiment_task_family_not_exact",
      "provisioning requires exactly one profile task-family selector matching --task-family",
    );
  }
  const confirmatory = experiment.evidence_intent === "confirmatory";
  let memoryNamespaceManifest: LearningMemoryNamespaceManifestV1 | null = null;
  let externalInputSet: LearningExperimentExternalInputSetV1 | null = null;
  if (confirmatory) {
    if (input.memoryNamespaceManifest === undefined || input.externalInputSet === undefined) {
      provisioningError(
        "learning_experiment_confirmatory_inputs_required",
        "confirmatory provisioning requires both immutable input manifests",
      );
    }
    memoryNamespaceManifest = LearningMemoryNamespaceManifestV1Schema.parse(
      input.memoryNamespaceManifest,
    );
    externalInputSet = LearningExperimentExternalInputSetV1Schema.parse(input.externalInputSet);
    for (const manifest of [memoryNamespaceManifest, externalInputSet]) {
      if (manifest.tenant_id !== tenantId
        || manifest.task_family !== taskFamily
        || manifest.experiment_id !== experimentId
        || manifest.experiment_revision !== input.experimentRevision) {
        provisioningError(
          "learning_experiment_confirmatory_input_identity_mismatch",
          "confirmatory input identity does not match the protected provisioning request",
          409,
        );
      }
    }
    if (stableStringify(externalInputSet.roles)
      !== stableStringify(experiment.required_external_inputs)) {
      provisioningError(
        "learning_experiment_external_input_set_mismatch",
        "external input set does not match the immutable profile declaration",
        409,
      );
    }
  } else if (input.memoryNamespaceManifest !== undefined || input.externalInputSet !== undefined) {
    provisioningError(
      "learning_experiment_integrity_inputs_forbidden",
      "integrity-only provisioning must omit confirmatory input manifests",
    );
  }
  return {
    tenantId,
    actor,
    operationId,
    taskFamily,
    experimentId,
    experimentRevision: input.experimentRevision,
    rule,
    experiment,
    memoryNamespaceManifest,
    externalInputSet,
  };
}

function profileProjection(
  rule: AionisAdmissionCandidatePolicyProfileRule,
  taskFamily: string,
): LearningExperimentApplicabilityProfileProjectionV1 {
  return LearningExperimentApplicabilityProfileProjectionV1Schema.parse({
    contract_version: "aionis_learning_experiment_applicability_profile_v1",
    profile_id: rule.profile_id,
    mode: rule.mode,
    task_family: taskFamily,
    scope_selector_sha256s: hashedSelectors(rule.scopes, "scopes"),
    scope_prefix_selector_sha256s: hashedSelectors(rule.scope_prefixes, "scope_prefixes"),
    task_signature_selector_sha256s: hashedSelectors(rule.task_signatures, "task_signatures"),
    agent_roles: canonicalUnique(rule.agent_roles, "agent_roles"),
    context_modes: canonicalUnique(rule.context_modes, "context_modes"),
    guide_modes: canonicalUnique(rule.guide_modes, "guide_modes"),
  });
}

function authorityRow(
  table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  values: Record<string, string | number | Uint8Array | null>,
): LiteLearningAuthorityRow {
  const row = Object.fromEntries(
    LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table]
      .filter((column) => column !== "row_id")
      .map((column) => [column, null]),
  );
  return Object.assign(row, values) as LiteLearningAuthorityRow;
}

type DerivedConfirmatoryNamespaceMember = Readonly<{
  storeScopeKey: string;
  memoryNamespaceSha256: string;
  assignmentUnitSha256: string;
}>;

type DerivedConfirmatoryPairInput = Readonly<{
  members: readonly [DerivedConfirmatoryNamespaceMember, DerivedConfirmatoryNamespaceMember];
  matchingCovariates: LearningMemoryNamespaceManifestV1["pairs"][number]["matching_covariates"];
  activation: LearningMemoryNamespaceManifestV1["pairs"][number]["activation"];
}>;

function deriveConfirmatoryNamespaceInput(args: {
  tenantId: string;
  defaultTenantId: string;
  manifest: LearningMemoryNamespaceManifestV1;
}): {
  pairs: readonly DerivedConfirmatoryPairInput[];
  members: readonly DerivedConfirmatoryNamespaceMember[];
  tenantScopeEncodingSha256: string;
  memoryNamespaceManifestSha256: string;
} {
  const scopeEncodingIssue = learningMemoryNamespaceManifestScopeEncodingIssue({
    manifest: args.manifest,
    defaultTenantId: args.defaultTenantId,
  });
  if (scopeEncodingIssue) {
    provisioningError(
      "learning_experiment_namespace_scope_encoding_invalid",
      `namespace pair ${scopeEncodingIssue.pair_index} member ${scopeEncodingIssue.member_index} exceeds the 256-byte store-scope limit after tenant encoding`,
      409,
    );
  }
  const pairs = args.manifest.pairs.map((pair) => {
    const members = pair.members.map((member) => {
      const tenancy = resolveTenantScope(
        { tenant_id: member.tenant_id, scope: member.public_scope },
        { defaultTenantId: args.defaultTenantId, defaultScope: member.public_scope },
      );
      if (tenancy.tenant_id !== args.tenantId) {
        provisioningError(
          "learning_experiment_namespace_cross_tenant",
          "namespace manifest member does not belong to the protected tenant",
          409,
        );
      }
      const storeScope = asStoreScope(tenancy.scope_key);
      return {
        storeScopeKey: tenancy.scope_key,
        memoryNamespaceSha256: learningMemoryNamespaceSha256(storeScope),
        assignmentUnitSha256: learningAssignmentUnitSha256({
          tenantId: args.tenantId,
          storeScope,
        }),
      };
    }).sort((left, right) => Buffer.compare(
      Buffer.from(left.memoryNamespaceSha256, "utf8"),
      Buffer.from(right.memoryNamespaceSha256, "utf8"),
    ));
    return {
      members: [members[0]!, members[1]!] as const,
      matchingCovariates: pair.matching_covariates,
      activation: pair.activation,
    };
  });
  const members = pairs.flatMap((pair) => pair.members);
  if (new Set(members.map((member) => member.storeScopeKey)).size !== 768
    || new Set(members.map((member) => member.memoryNamespaceSha256)).size !== 768
    || new Set(members.map((member) => member.assignmentUnitSha256)).size !== 768) {
    provisioningError(
      "learning_experiment_namespace_manifest_alias",
      "namespace manifest aliases one canonical store namespace",
      409,
    );
  }
  return {
    pairs,
    members,
    tenantScopeEncodingSha256: tenantScopeEncodingDigest(args.defaultTenantId),
    memoryNamespaceManifestSha256: learningMemoryNamespaceManifestDigest(args.manifest),
  };
}

function confirmatoryAttemptId(args: {
  tenantId: string;
  taskFamily: string;
  experimentId: string;
  experimentRevision: number;
  candidatePolicyImplementationSha256: string;
}): string {
  return deterministicAuthorityId("lca", {
    contract_version: "aionis_learning_confirmatory_attempt_identity_v1",
    tenant_id: args.tenantId,
    task_family: args.taskFamily,
    experiment_id: args.experimentId,
    experiment_revision: args.experimentRevision,
    candidate_policy_implementation_sha256: args.candidatePolicyImplementationSha256,
  });
}

function namespaceLeaseId(args: {
  tenantId: string;
  confirmatoryAttemptId: string;
  memoryNamespaceSha256: string;
  leaseGeneration: number;
}): string {
  return deterministicAuthorityId("lns", {
    contract_version: "aionis_learning_namespace_lease_identity_v1",
    tenant_id: args.tenantId,
    confirmatory_attempt_id: args.confirmatoryAttemptId,
    memory_namespace_sha256: args.memoryNamespaceSha256,
    lease_generation: args.leaseGeneration,
  });
}

function buildConfirmatoryPairRows(args: {
  tenantId: string;
  confirmatoryAttemptId: string;
  createdAt: string;
  derived: ReturnType<typeof deriveConfirmatoryNamespaceInput>;
  lineage: LiteLearningConfirmatoryPreTreatmentLineageSnapshot;
}): LiteLearningAuthorityRow[] {
  const snapshotByNamespace = new Map(args.lineage.members.map((snapshot) => [
    snapshot.memory_namespace_sha256,
    snapshot,
  ]));
  const unsorted = args.derived.pairs.map((pair) => {
    const memberSnapshots = pair.members.map((member, pairMemberOrdinal) => {
      const snapshot = snapshotByNamespace.get(member.memoryNamespaceSha256);
      if (!snapshot) {
        throw new Error("learning_experiment_pre_treatment_snapshot_member_missing");
      }
      return {
        pair_member_ordinal: pairMemberOrdinal,
        memory_namespace_sha256: member.memoryNamespaceSha256,
        assignment_unit_sha256: member.assignmentUnitSha256,
        prior_memory_node_count: snapshot.prior_memory_node_count,
        prior_memory_node_head_sha256: snapshot.prior_memory_node_head_sha256,
        prior_memory_commit_count: snapshot.prior_memory_commit_count,
        prior_memory_commit_head_sha256: snapshot.prior_memory_commit_head_sha256,
        prior_snapshot_sha256: snapshot.prior_snapshot_sha256,
      };
    });
    const matching = canonical({
      contract_version: "aionis_learning_confirmatory_matching_covariate_v1",
      reviewed: pair.matchingCovariates,
      pre_treatment_lineage_snapshot_sha256: args.lineage.snapshot_sha256,
      members: memberSnapshots,
    });
    if (Buffer.byteLength(matching.json, "utf8") > 4096) {
      throw new Error("learning_experiment_matching_covariate_too_large");
    }
    const base = authorityRow("lite_learning_randomization_pairs", {
      tenant_id: args.tenantId,
      confirmatory_attempt_id: args.confirmatoryAttemptId,
      randomization_pair_sha256: "0".repeat(64),
      pair_ordinal: 0,
      member_0_memory_namespace_sha256: pair.members[0].memoryNamespaceSha256,
      member_1_memory_namespace_sha256: pair.members[1].memoryNamespaceSha256,
      matching_covariate_sha256: matching.sha256,
      matching_covariate_json: matching.json,
      activation_wave_index: pair.activation.activation_wave_index,
      activation_starts_at: pair.activation.activation_starts_at,
      index_window_ends_at: pair.activation.index_window_ends_at,
      wave_analysis_at: pair.activation.wave_analysis_at,
      pair_record_sha256: "0".repeat(64),
      created_at: args.createdAt,
    });
    return {
      ...base,
      randomization_pair_sha256: learningRandomizationPairIdentityDigest(base),
    } satisfies LiteLearningAuthorityRow;
  });
  return unsorted
    .sort((left, right) => Buffer.compare(
      Buffer.from(String(left.randomization_pair_sha256), "utf8"),
      Buffer.from(String(right.randomization_pair_sha256), "utf8"),
    ))
    .map((row, pairOrdinal) => {
      const ordinalRow = { ...row, pair_ordinal: pairOrdinal } satisfies LiteLearningAuthorityRow;
      return {
        ...ordinalRow,
        pair_record_sha256: learningRandomizationPairRecordDigest(ordinalRow),
      } satisfies LiteLearningAuthorityRow;
    });
}

function nextNamespaceLeaseGeneration(
  db: SqliteDatabase,
  tenantId: string,
  memoryNamespaceSha256: string,
): number {
  const row = db.prepare(
    `SELECT MAX(lease_generation) AS generation
     FROM lite_learning_namespace_leases
     WHERE tenant_id = ? AND memory_namespace_sha256 = ?`,
  ).get(tenantId, memoryNamespaceSha256) as { generation: number | null };
  return Number(row.generation ?? 0) + 1;
}

function buildConfirmatoryLeaseRows(args: {
  db: SqliteDatabase;
  tenantId: string;
  experimentId: string;
  experimentRevision: number;
  operationId: string;
  confirmatoryAttemptId: string;
  namespaceSetSha256: string;
  createdAt: string;
  assignmentBits: Uint8Array;
  pairs: readonly LiteLearningAuthorityRow[];
}): LiteLearningAuthorityRow[] {
  return args.pairs.flatMap((pair) => ([0, 1] as const).map((pairMemberOrdinal) => {
    const memoryNamespaceSha256 = requiredRowString(
      pair,
      pairMemberOrdinal === 0
        ? "member_0_memory_namespace_sha256"
        : "member_1_memory_namespace_sha256",
    );
    const leaseGeneration = nextNamespaceLeaseGeneration(
      args.db,
      args.tenantId,
      memoryNamespaceSha256,
    );
    const assignment = confirmatoryMatchedPairAssignment({
      assignmentRandomBits: args.assignmentBits,
      canonicalPairOrdinal: requiredRowInteger(pair, "pair_ordinal"),
      pairMemberOrdinal,
    });
    return authorityRow("lite_learning_namespace_leases", {
      tenant_id: args.tenantId,
      namespace_lease_id: namespaceLeaseId({
        tenantId: args.tenantId,
        confirmatoryAttemptId: args.confirmatoryAttemptId,
        memoryNamespaceSha256,
        leaseGeneration,
      }),
      memory_namespace_sha256: memoryNamespaceSha256,
      randomization_pair_sha256: requiredRowString(pair, "randomization_pair_sha256"),
      pair_member_ordinal: pairMemberOrdinal,
      assigned_arm: assignment.arm,
      activation_wave_index: requiredRowInteger(pair, "activation_wave_index"),
      activation_starts_at: requiredRowString(pair, "activation_starts_at"),
      index_window_ends_at: requiredRowString(pair, "index_window_ends_at"),
      wave_analysis_at: requiredRowString(pair, "wave_analysis_at"),
      lease_generation: leaseGeneration,
      confirmatory_attempt_id: args.confirmatoryAttemptId,
      experiment_id: args.experimentId,
      experiment_revision: args.experimentRevision,
      namespace_set_sha256: args.namespaceSetSha256,
      acquire_operation_id: args.operationId,
      acquired_at: args.createdAt,
      status: "active",
      release_operation_id: null,
      release_ref_kind: null,
      release_ref_id: null,
      released_at: null,
    });
  }));
}

function existingCreatedAt(
  db: SqliteDatabase,
  table: string,
  where: Readonly<Record<string, string | number>>,
): string | null {
  const fields = Object.keys(where);
  const row = db.prepare(
    `SELECT created_at FROM ${table} WHERE ${fields.map((field) => `${field} = ?`).join(" AND ")} LIMIT 1`,
  ).get(...fields.map((field) => where[field])) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

function assertRegistryDigest(value: unknown, expected: string, field: string) {
  const resolved = canonical(value);
  if (resolved.sha256 !== expected) {
    provisioningError("learning_experiment_registry_digest_mismatch", `${field} registry digest mismatch`, 409);
  }
  return resolved;
}

function resolveRegistryAuthority(args: {
  registry: LearningExperimentProvisioningRegistry;
  experiment: NonNullable<AionisAdmissionCandidatePolicyProfileRule["experiment"]>;
  databaseInstanceId: string;
}) {
  const candidate = args.registry.resolveCandidatePolicy(
    args.experiment.candidate_policy_id,
    args.experiment.candidate_policy_version,
  );
  if (candidate.policy_kind !== "candidate"
    || candidate.policy_id !== args.experiment.candidate_policy_id
    || candidate.policy_version !== args.experiment.candidate_policy_version) {
    provisioningError(
      "learning_experiment_registry_tuple_mismatch",
      "candidate policy registry returned a different tuple",
      409,
    );
  }
  const candidateConfig = assertRegistryDigest(
    candidate.config,
    candidate.policy_config_sha256,
    "candidate policy",
  );
  const gate = args.registry.resolveGatePolicy(
    args.experiment.gate_policy_id,
    args.experiment.gate_policy_version,
  );
  if (gate.policy_id !== args.experiment.gate_policy_id
    || gate.policy_version !== args.experiment.gate_policy_version) {
    provisioningError(
      "learning_experiment_registry_tuple_mismatch",
      "gate policy registry returned a different tuple",
      409,
    );
  }
  if (gate.registry_status !== "registered"
    || gate.prospective_calibration_artifact_sha256 === null
    || gate.prospective_calibration_artifact === null) {
    provisioningError(
      "learning_experiment_gate_calibration_pending",
      "learning experiment provisioning requires a registered passing gate calibration",
      409,
    );
  }
  const gateConfig = assertRegistryDigest(gate.config, gate.policy_config_sha256, "gate policy");
  const gateCalibration = assertRegistryDigest(
    gate.prospective_calibration_artifact,
    gate.prospective_calibration_artifact_sha256,
    "gate calibration",
  );
  const external = args.registry.resolveExternalExecutionPolicy(
    args.experiment.external_execution_policy_ref.registry_key,
    args.databaseInstanceId,
  );
  if (!external) {
    provisioningError(
      "learning_experiment_external_execution_policy_unregistered",
      "learning experiment provisioning requires a DB-lineage-bound external execution policy",
      409,
    );
  }
  if (external.registry_key !== args.experiment.external_execution_policy_ref.registry_key
    || external.database_instance_id !== args.databaseInstanceId) {
    provisioningError(
      "learning_experiment_external_execution_policy_lineage_mismatch",
      "external execution policy registry lineage mismatch",
      409,
    );
  }
  const externalPolicy = ExternalExecutionPolicyV1Schema.parse(external.policy);
  if (externalPolicy.runtime_authority_attestor.expected_database_instance_id
      !== args.databaseInstanceId
    || externalExecutionPolicyDigest(externalPolicy) !== external.policy_sha256) {
    provisioningError(
      "learning_experiment_registry_digest_mismatch",
      "external execution policy registry digest mismatch",
      409,
    );
  }
  return {
    candidate,
    candidateConfig,
    gate,
    gateConfig,
    gateCalibration,
    external,
    externalPolicy: canonical(externalPolicy),
  };
}

function requiredRowString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing persisted ${field}`);
  return value;
}

function requiredRowInteger(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`missing persisted ${field}`);
  return value;
}

function parseCanonicalReceipt(raw: string): LearningExperimentProvisionReceiptV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("learning_experiment_provision_receipt_corrupt");
  }
  const receipt = LearningExperimentProvisionReceiptV1Schema.parse(value);
  if (stableStringify(receipt) !== raw) {
    throw new Error("learning_experiment_provision_receipt_not_canonical");
  }
  return receipt;
}

function exactReplay(args: {
  operation: LiteWriteOperationRow;
  requestSha256: string;
  tenantId: string;
  actor: string;
  operationId: string;
  experimentId: string;
  experimentRevision: number;
  profileId: string;
  profileRuleSha256: string;
  experimentDeclarationSha256: string;
  taskFamily: string;
  servingPhase: "aa" | "shadow" | "active_control";
  databaseInstanceId: string;
  db: SqliteDatabase;
}): LearningExperimentProvisionResult {
  if (args.operation.request_sha256 !== args.requestSha256) {
    provisioningError(
      "learning_experiment_operation_id_conflict",
      "operation ID is already bound to a different provisioning request",
      409,
    );
  }
  const receipt = parseCanonicalReceipt(args.operation.receipt_json);
  if (args.operation.tenant_id !== args.tenantId
    || args.operation.scope !== LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE
    || args.operation.operation_kind !== LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND
    || args.operation.operation_id !== args.operationId
    || receipt.request_sha256 !== args.requestSha256
    || receipt.tenant_id !== args.tenantId
    || receipt.actor !== args.actor
    || receipt.operation_id !== args.operationId
    || receipt.experiment.experiment_id !== args.experimentId
    || receipt.experiment.experiment_revision !== args.experimentRevision
    || receipt.experiment.profile_id !== args.profileId
    || receipt.experiment.profile_rule_sha256 !== args.profileRuleSha256
    || receipt.experiment.serving_phase !== args.servingPhase
    || receipt.applicability_manifest.experiment_declaration_sha256
      !== args.experimentDeclarationSha256
    || receipt.applicability_manifest.task_family !== args.taskFamily
    || receipt.runtime_authority_lineage_sha256 !== sha256Hex(args.databaseInstanceId)) {
    throw new Error("learning_experiment_provision_receipt_binding_mismatch");
  }
  const manifest = buildApplicabilityManifestFromDatabase({
    db: args.db,
    tenantId: args.tenantId,
    experimentId: args.experimentId,
    experimentRevision: args.experimentRevision,
  });
  if (stableStringify(manifest) !== stableStringify(receipt.applicability_manifest)
    || learningExperimentApplicabilityManifestDigest(manifest)
      !== receipt.applicability_manifest_sha256) {
    throw new Error("learning_experiment_provision_receipt_manifest_drift");
  }
  return {
    receipt,
    receiptJson: args.operation.receipt_json,
    applicabilityManifest: manifest,
    applicabilityManifestJson: stableStringify(manifest),
    replayed: true,
  };
}

function requestDigest(args: {
  tenantId: string;
  actor: string;
  databaseInstanceId: string;
  taskFamily: string;
  experimentId: string;
  experimentRevision: number;
  rule: AionisAdmissionCandidatePolicyProfileRule;
  memoryNamespaceManifestSha256: string | null;
  externalInputSetSha256: string | null;
  tenantScopeEncodingSha256: string | null;
}): string {
  const base = {
    contract_version: "aionis_learning_experiment_provision_request_v1",
    tenant_id: args.tenantId,
    actor: args.actor,
    database_instance_id: args.databaseInstanceId,
    task_family: args.taskFamily,
    experiment_id: args.experimentId,
    experiment_revision: args.experimentRevision,
    profile_rule_sha256: admissionCandidatePolicyProfileRuleDigest(args.rule),
    profile_rule: args.rule,
  };
  return sha256Hex(stableStringify(args.memoryNamespaceManifestSha256 === null
    ? base
    : {
        ...base,
        memory_namespace_manifest_sha256: args.memoryNamespaceManifestSha256,
        external_input_set_sha256: args.externalInputSetSha256,
        tenant_scope_encoding_sha256: args.tenantScopeEncodingSha256,
      }));
}

export type LiteLearningExperimentProvisioner = Readonly<{
  provision(input: LearningExperimentProvisionInput): Promise<LearningExperimentProvisionResult>;
  regenerateApplicabilityManifest(args: {
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
  }): Promise<LearningExperimentApplicabilityManifestV1>;
}>;

/** @internal Runtime composition/test factory; operator-facing code uses the production wrapper below. */
export function createLiteLearningExperimentProvisioner(args: {
  database: LiteRuntimeDatabase;
  writeStore: Pick<LiteWriteStore, "getWriteOperation" | "insertWriteOperation" | "withTx">;
  ledger?: LiteLearningEpisodeLedgerAccess;
  dependencies?: LearningExperimentProvisioningDependencies;
}): LiteLearningExperimentProvisioner {
  const ledger = args.ledger ?? createLiteLearningEpisodeLedgerAccess(args.database);
  const registry = args.dependencies?.registry ?? PRODUCTION_LEARNING_EXPERIMENT_PROVISIONING_REGISTRY;
  const randomBytes = args.dependencies?.randomBytes ?? operatingSystemRandomBytes;
  const now = args.dependencies?.now ?? (() => new Date().toISOString());

  return {
    async provision(input) {
      const prepared = prepareInput(input);
      const databaseInstanceId = await ledger.databaseInstanceId();
      const defaultTenantId = prepared.memoryNamespaceManifest === null
        ? null
        : provisioningDefaultTenantId(args.dependencies?.defaultTenantId);
      const derivedConfirmatory = prepared.memoryNamespaceManifest === null
        ? null
        : deriveConfirmatoryNamespaceInput({
            tenantId: prepared.tenantId,
            defaultTenantId: defaultTenantId!,
            manifest: prepared.memoryNamespaceManifest,
          });
      if (defaultTenantId !== null) {
        preflightTenantScopeAuthority(args.database.db, defaultTenantId);
      }
      const externalInputSetSha256 = prepared.externalInputSet === null
        ? null
        : learningExperimentExternalInputSetDigest(prepared.externalInputSet);
      const requestSha256 = requestDigest({
        ...prepared,
        databaseInstanceId,
        memoryNamespaceManifestSha256:
          derivedConfirmatory?.memoryNamespaceManifestSha256 ?? null,
        externalInputSetSha256,
        tenantScopeEncodingSha256:
          derivedConfirmatory?.tenantScopeEncodingSha256 ?? null,
      });
      const profileRuleSha256 = admissionCandidatePolicyProfileRuleDigest(prepared.rule);
      const experimentDeclarationSha256 = admissionCandidatePolicyExperimentDeclarationDigest(
        prepared.experiment,
      );
      const operationKey = {
        tenantId: prepared.tenantId,
        scope: LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
        operationKind: LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
        operationId: prepared.operationId,
      };
      const early = await args.writeStore.getWriteOperation(operationKey);
      if (early) {
        if (defaultTenantId !== null) {
          assertTenantScopeAuthority(args.database.db, defaultTenantId);
        }
        return exactReplay({
          operation: early,
          requestSha256,
          tenantId: prepared.tenantId,
          actor: prepared.actor,
          operationId: prepared.operationId,
          experimentId: prepared.experimentId,
          experimentRevision: prepared.experimentRevision,
          profileId: prepared.rule.profile_id,
          profileRuleSha256,
          experimentDeclarationSha256,
          taskFamily: prepared.taskFamily,
          servingPhase: prepared.experiment.serving_phase,
          databaseInstanceId,
          db: args.database.db,
        });
      }

      const authority = resolveRegistryAuthority({
        registry,
        experiment: prepared.experiment,
        databaseInstanceId,
      });
      const collectionSourcePolicy = canonical(learningCollectionSourcePolicyProjection(
        prepared.experiment,
      ));
      const evidenceSeries = canonical(prepared.experiment.required_evidence_series);
      const externalInputs = canonical(prepared.experiment.required_external_inputs);
      const applicabilityProfile = profileProjection(prepared.rule, prepared.taskFamily);
      if (derivedConfirmatory !== null) {
        assertConfirmatoryGateDesign(
          authority.gate.config,
          prepared.experiment.candidate_allocation_bps,
        );
      }

      return await args.writeStore.withTx(async () => {
        if (defaultTenantId !== null) {
          ensureTenantScopeAuthority(args.database, defaultTenantId);
        }
        const raced = await args.writeStore.getWriteOperation(operationKey);
        if (raced) {
          return exactReplay({
            operation: raced,
            requestSha256,
            tenantId: prepared.tenantId,
            actor: prepared.actor,
            operationId: prepared.operationId,
            experimentId: prepared.experimentId,
            experimentRevision: prepared.experimentRevision,
            profileId: prepared.rule.profile_id,
            profileRuleSha256,
            experimentDeclarationSha256,
            taskFamily: prepared.taskFamily,
            servingPhase: prepared.experiment.serving_phase,
            databaseInstanceId,
            db: args.database.db,
          });
        }
        const existingRevision = args.database.db.prepare(
          `SELECT 1 AS present FROM lite_learning_experiment_revisions
           WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
        ).get(
          prepared.tenantId,
          prepared.experimentId,
          prepared.experimentRevision,
        );
        if (existingRevision) {
          provisioningError(
            "learning_experiment_revision_already_provisioned",
            "experiment revision already belongs to another provisioning operation",
            409,
          );
        }

        const confirmatoryLineage = derivedConfirmatory === null
          ? null
          : await ledger.scanConfirmatoryPreTreatmentLineage({
              tenantId: prepared.tenantId,
              experimentId: prepared.experimentId,
              experimentRevision: prepared.experimentRevision,
              members: derivedConfirmatory.members,
            });
        const createdAt = canonicalUtcMillis(now());

        const candidateCreatedAt = existingCreatedAt(
          args.database.db,
          "lite_learning_policy_versions",
          {
            tenant_id: prepared.tenantId,
            policy_kind: "candidate",
            policy_id: authority.candidate.policy_id,
            policy_version: authority.candidate.policy_version,
          },
        ) ?? createdAt;
        await ledger.insertPolicyVersion(authorityRow("lite_learning_policy_versions", {
          tenant_id: prepared.tenantId,
          policy_kind: "candidate",
          policy_id: authority.candidate.policy_id,
          policy_version: authority.candidate.policy_version,
          policy_config_sha256: authority.candidate.policy_config_sha256,
          policy_config_json: authority.candidateConfig.json,
          implementation_contract_sha256: authority.candidate.implementation_contract_sha256,
          prospective_calibration_sha256: null,
          prospective_calibration_json: null,
          created_at: candidateCreatedAt,
        }));

        const gateCreatedAt = existingCreatedAt(
          args.database.db,
          "lite_learning_policy_versions",
          {
            tenant_id: prepared.tenantId,
            policy_kind: "gate",
            policy_id: authority.gate.policy_id,
            policy_version: authority.gate.policy_version,
          },
        ) ?? createdAt;
        await ledger.insertPolicyVersion(authorityRow("lite_learning_policy_versions", {
          tenant_id: prepared.tenantId,
          policy_kind: "gate",
          policy_id: authority.gate.policy_id,
          policy_version: authority.gate.policy_version,
          policy_config_sha256: authority.gate.policy_config_sha256,
          policy_config_json: authority.gateConfig.json,
          implementation_contract_sha256: authority.gate.implementation_contract_sha256,
          prospective_calibration_sha256: authority.gate.prospective_calibration_artifact_sha256,
          prospective_calibration_json: authority.gateCalibration.json,
          created_at: gateCreatedAt,
        }));

        for (const source of prepared.experiment.collection_sources) {
          const verifierPolicy = canonical({ allowed_verifiers: source.allowed_verifiers });
          if (verifierPolicy.sha256 !== source.verifier_policy_sha256) {
            provisioningError(
              "learning_experiment_collection_binding_digest_mismatch",
              "collection source verifier policy drifted after profile parsing",
              409,
            );
          }
          const bindingCreatedAt = existingCreatedAt(
            args.database.db,
            "lite_learning_collection_principal_bindings",
            {
              tenant_id: prepared.tenantId,
              collection_principal_sha256: source.principal_sha256,
            },
          ) ?? createdAt;
          const bindingBase = authorityRow("lite_learning_collection_principal_bindings", {
            tenant_id: prepared.tenantId,
            collection_principal_sha256: source.principal_sha256,
            collection_class: source.class,
            collector_id: source.collector_id,
            collector_version: source.collector_version,
            verifier_policy_sha256: verifierPolicy.sha256,
            verifier_policy_json: verifierPolicy.json,
            binding_sha256: "0".repeat(64),
            created_at: bindingCreatedAt,
          });
          await ledger.insertCollectionPrincipalBinding({
            ...bindingBase,
            binding_sha256: learningCollectionPrincipalBindingDigest(bindingBase),
          });
        }

        let precomputedConfirmatoryAttemptId: string | null = null;
        let precomputedConfirmatoryPairs: LiteLearningAuthorityRow[] = [];
        let precomputedPairManifestSha256: string | null = null;
        let precomputedActivationScheduleSha256: string | null = null;
        if (derivedConfirmatory !== null) {
          if (confirmatoryLineage === null) {
            throw new Error("learning_experiment_confirmatory_lineage_missing");
          }
          const spentAttempt = args.database.db.prepare(
            `SELECT confirmatory_attempt_id
             FROM lite_learning_confirmatory_attempts
             WHERE tenant_id = ? AND task_family = ?
               AND candidate_policy_implementation_sha256 = ?
             LIMIT 1`,
          ).get(
            prepared.tenantId,
            prepared.taskFamily,
            authority.candidate.implementation_contract_sha256,
          );
          if (spentAttempt) {
            provisioningError(
              "learning_experiment_confirmatory_attempt_already_spent",
              "task-family candidate implementation already owns its sole confirmatory attempt",
              409,
            );
          }
          precomputedConfirmatoryAttemptId = confirmatoryAttemptId({
            tenantId: prepared.tenantId,
            taskFamily: prepared.taskFamily,
            experimentId: prepared.experimentId,
            experimentRevision: prepared.experimentRevision,
            candidatePolicyImplementationSha256:
              authority.candidate.implementation_contract_sha256,
          });
          precomputedConfirmatoryPairs = buildConfirmatoryPairRows({
            tenantId: prepared.tenantId,
            confirmatoryAttemptId: precomputedConfirmatoryAttemptId,
            createdAt,
            derived: derivedConfirmatory,
            lineage: confirmatoryLineage,
          });
          precomputedPairManifestSha256 = learningRandomizationPairManifestDigest(
            precomputedConfirmatoryPairs,
          );
          precomputedActivationScheduleSha256 = learningActivationScheduleDigest(
            precomputedConfirmatoryPairs,
          );
          const waveOneStart = precomputedConfirmatoryPairs.find(
            (pair) => requiredRowInteger(pair, "activation_wave_index") === 1,
          );
          if (!waveOneStart
            || !(createdAt < requiredRowString(waveOneStart, "activation_starts_at"))) {
            provisioningError(
              "learning_experiment_activation_schedule_invalid",
              "confirmatory wave 1 must start after protected provisioning",
              409,
            );
          }
        }

        const generated = randomBytes(32);
        if (!(generated instanceof Uint8Array) || generated.byteLength !== 32) {
          throw new Error("learning_experiment_diagnostic_csprng_must_return_32_bytes");
        }
        const diagnosticSeed = Uint8Array.from(generated);
        const diagnosticSeedSha256 = bytesSha256(diagnosticSeed);
        const confirmatoryAssignmentBits = derivedConfirmatory === null
          ? null
          : (() => {
              const value = randomBytes(48);
              if (!(value instanceof Uint8Array) || value.byteLength !== 48) {
                throw new Error("learning_experiment_confirmatory_csprng_must_return_48_bytes");
              }
              return Uint8Array.from(value);
            })();

        const revisionConfigBase = {
          contract_version: "aionis_learning_experiment_config_v1",
          task_family: prepared.taskFamily,
          provision_operation_id_sha256: sha256Hex(prepared.operationId),
          provision_request_sha256: requestSha256,
          provisioning_actor_sha256: sha256Hex(prepared.actor),
          experiment_declaration_sha256: experimentDeclarationSha256,
          profile_rule_sha256: profileRuleSha256,
          external_execution_policy_registry_key:
            prepared.experiment.external_execution_policy_ref.registry_key,
          collection_source_policy_sha256: collectionSourcePolicy.sha256,
          collection_source_policy_validation_contract:
            LEARNING_COLLECTION_SOURCE_POLICY_STRICT_VALIDATION_CONTRACT,
          external_execution_policy_sha256: authority.external.policy_sha256,
          gate_prospective_calibration_sha256:
            authority.gate.prospective_calibration_artifact_sha256,
          required_evidence_series_sha256: evidenceSeries.sha256,
          required_external_inputs_sha256: externalInputs.sha256,
          applicability_profile_projection: applicabilityProfile,
        } as const;

        let confirmatoryAttempt: LiteLearningAuthorityRow | null = null;
        let confirmatoryPairs: LiteLearningAuthorityRow[] = [];
        let confirmatoryLeases: LiteLearningAuthorityRow[] = [];
        let confirmatoryCohort: LearningExperimentConfirmatoryApplicabilityCohortV1 | null = null;
        let revisionConfig: ReturnType<typeof canonical>;
        if (derivedConfirmatory !== null) {
          if (confirmatoryLineage === null
            || confirmatoryAssignmentBits === null
            || externalInputSetSha256 === null
            || precomputedConfirmatoryAttemptId === null
            || precomputedPairManifestSha256 === null
            || precomputedActivationScheduleSha256 === null) {
            throw new Error("learning_experiment_confirmatory_authority_incomplete");
          }
          const attemptId = precomputedConfirmatoryAttemptId;
          confirmatoryPairs = precomputedConfirmatoryPairs;
          const pairManifestSha256 = precomputedPairManifestSha256;
          const activationScheduleSha256 = precomputedActivationScheduleSha256;
          const attemptBase = authorityRow("lite_learning_confirmatory_attempts", {
            tenant_id: prepared.tenantId,
            confirmatory_attempt_id: attemptId,
            task_family: prepared.taskFamily,
            candidate_policy_id: authority.candidate.policy_id,
            candidate_policy_version: authority.candidate.policy_version,
            candidate_policy_implementation_sha256:
              authority.candidate.implementation_contract_sha256,
            experiment_id: prepared.experimentId,
            experiment_revision: prepared.experimentRevision,
            gate_policy_id: authority.gate.policy_id,
            gate_policy_version: authority.gate.policy_version,
            gate_policy_config_sha256: authority.gate.policy_config_sha256,
            eligible_memory_namespace_set_sha256: confirmatoryLineage.namespace_set_sha256,
            eligible_memory_namespace_count: 768,
            planned_candidate_namespace_count: 384,
            planned_control_namespace_count: 384,
            randomization_pair_manifest_sha256: pairManifestSha256,
            randomization_pair_count: 384,
            activation_schedule_sha256: activationScheduleSha256,
            attempt_sha256: "0".repeat(64),
            created_by: prepared.actor,
            created_at: createdAt,
          });
          confirmatoryAttempt = {
            ...attemptBase,
            attempt_sha256: learningConfirmatoryAttemptDigest(attemptBase),
          };
          confirmatoryLeases = buildConfirmatoryLeaseRows({
            db: args.database.db,
            tenantId: prepared.tenantId,
            experimentId: prepared.experimentId,
            experimentRevision: prepared.experimentRevision,
            operationId: prepared.operationId,
            confirmatoryAttemptId: attemptId,
            namespaceSetSha256: confirmatoryLineage.namespace_set_sha256,
            createdAt,
            assignmentBits: confirmatoryAssignmentBits,
            pairs: confirmatoryPairs,
          });
          confirmatoryCohort = buildConfirmatoryApplicabilityCohort({
            attempt: confirmatoryAttempt,
            pairs: confirmatoryPairs,
            leases: confirmatoryLeases,
          });
          revisionConfig = canonical({
            ...revisionConfigBase,
            confirmatory_attempt_id: attemptId,
            memory_namespace_manifest_sha256:
              derivedConfirmatory.memoryNamespaceManifestSha256,
            external_input_set_sha256: externalInputSetSha256,
            tenant_scope_encoding_sha256: derivedConfirmatory.tenantScopeEncodingSha256,
            namespace_set_sha256: confirmatoryLineage.namespace_set_sha256,
            assignment_unit_set_sha256: confirmatoryLineage.assignment_unit_set_sha256,
            pair_manifest_sha256: pairManifestSha256,
            activation_schedule_sha256: activationScheduleSha256,
            namespace_lease_membership_sha256:
              confirmatoryCohort.namespace_lease_membership_sha256,
            pre_treatment_lineage_snapshot_sha256: confirmatoryLineage.snapshot_sha256,
          });
        } else {
          revisionConfig = canonical(revisionConfigBase);
        }

        const revision = authorityRow("lite_learning_experiment_revisions", {
          tenant_id: prepared.tenantId,
          experiment_id: prepared.experimentId,
          experiment_revision: prepared.experimentRevision,
          profile_id: prepared.rule.profile_id,
          profile_rule_sha256: profileRuleSha256,
          serving_phase: prepared.experiment.serving_phase,
          evidence_intent: prepared.experiment.evidence_intent,
          eligible_memory_namespace_set_sha256: confirmatoryAttempt === null
            ? null
            : requiredRowString(confirmatoryAttempt, "eligible_memory_namespace_set_sha256"),
          eligible_memory_namespace_count: confirmatoryAttempt === null ? null : 768,
          assignment_design: prepared.experiment.assignment_design,
          randomization_pair_manifest_sha256: confirmatoryAttempt === null
            ? null
            : requiredRowString(confirmatoryAttempt, "randomization_pair_manifest_sha256"),
          randomization_pair_count: confirmatoryAttempt === null ? null : 384,
          activation_schedule_sha256: confirmatoryAttempt === null
            ? null
            : requiredRowString(confirmatoryAttempt, "activation_schedule_sha256"),
          candidate_policy_id: authority.candidate.policy_id,
          candidate_policy_version: authority.candidate.policy_version,
          candidate_policy_implementation_sha256:
            authority.candidate.implementation_contract_sha256,
          candidate_policy_config_sha256: authority.candidate.policy_config_sha256,
          assignment_unit_kind: "store_memory_namespace_cluster",
          candidate_allocation_bps: prepared.experiment.candidate_allocation_bps,
          diagnostic_assignment_seed: diagnosticSeed,
          diagnostic_assignment_seed_sha256: diagnosticSeedSha256,
          confirmatory_assignment_bits: confirmatoryAssignmentBits,
          confirmatory_assignment_bit_count: confirmatoryAssignmentBits === null ? null : 384,
          confirmatory_assignment_bits_sha256: confirmatoryAssignmentBits === null
            ? null
            : bytesSha256(confirmatoryAssignmentBits),
          collection_source_policy_sha256: collectionSourcePolicy.sha256,
          collection_source_policy_json: collectionSourcePolicy.json,
          gate_policy_id: authority.gate.policy_id,
          gate_policy_version: authority.gate.policy_version,
          gate_policy_config_sha256: authority.gate.policy_config_sha256,
          gate_prospective_calibration_sha256:
            authority.gate.prospective_calibration_artifact_sha256,
          required_evidence_series_sha256: evidenceSeries.sha256,
          required_evidence_series_json: evidenceSeries.json,
          required_external_inputs_sha256: externalInputs.sha256,
          required_external_inputs_json: externalInputs.json,
          external_execution_policy_sha256: authority.external.policy_sha256,
          external_execution_policy_json: authority.externalPolicy.json,
          safety_pause_mode: "automatic",
          config_sha256: revisionConfig.sha256,
          config_json: revisionConfig.json,
          created_at: createdAt,
        });
        if (confirmatoryAttempt === null) {
          await ledger.insertExperimentRevision(revision);
        } else {
          await ledger.provisionConfirmatorySet({
            revision,
            attempt: confirmatoryAttempt,
            pairs: confirmatoryPairs,
            leases: confirmatoryLeases,
          });
        }
        await ledger.verifyIntegrity();

        const manifest = buildApplicabilityManifestFromDatabase({
          db: args.database.db,
          tenantId: prepared.tenantId,
          experimentId: prepared.experimentId,
          experimentRevision: prepared.experimentRevision,
        });
        const manifestSha256 = learningExperimentApplicabilityManifestDigest(manifest);
        const receiptCommon = {
          contract_version: "aionis_learning_experiment_provision_receipt_v1",
          operation_kind: LEARNING_EXPERIMENT_PROVISION_OPERATION_KIND,
          operation_id: prepared.operationId,
          request_sha256: requestSha256,
          tenant_id: prepared.tenantId,
          authority_scope: LEARNING_EXPERIMENT_PROVISION_AUTHORITY_SCOPE,
          runtime_authority_lineage_sha256: sha256Hex(databaseInstanceId),
          actor: prepared.actor,
          status: "provisioned",
        } as const;
        const receipt = LearningExperimentProvisionReceiptV1Schema.parse(
          manifest.evidence_intent === "integrity_only"
            ? {
          ...receiptCommon,
          experiment: {
            experiment_id: prepared.experimentId,
            experiment_revision: prepared.experimentRevision,
            profile_id: prepared.rule.profile_id,
            profile_rule_sha256: profileRuleSha256,
            experiment_config_sha256: revisionConfig.sha256,
            serving_phase: prepared.experiment.serving_phase,
            evidence_intent: "integrity_only",
          },
          policy_bindings: manifest.policy_bindings,
          cohort: null,
          applicability_manifest_sha256: manifestSha256,
          applicability_manifest: manifest,
              }
            : {
                ...receiptCommon,
                experiment: {
                  experiment_id: prepared.experimentId,
                  experiment_revision: prepared.experimentRevision,
                  profile_id: prepared.rule.profile_id,
                  profile_rule_sha256: profileRuleSha256,
                  experiment_config_sha256: revisionConfig.sha256,
                  serving_phase: "active_control",
                  evidence_intent: "confirmatory",
                },
                policy_bindings: manifest.policy_bindings,
                input_bindings: {
                  memory_namespace_manifest_sha256:
                    manifest.memory_namespace_manifest_sha256,
                  external_input_set_sha256: manifest.external_input_set_sha256,
                  tenant_scope_encoding_sha256: manifest.tenant_scope_encoding_sha256,
                },
                cohort: {
                  contract_version: "aionis_learning_confirmatory_provision_summary_v1",
                  confirmatory_attempt_id: manifest.cohort.confirmatory_attempt_id,
                  confirmatory_attempt_sha256: manifest.cohort.confirmatory_attempt_sha256,
                  eligible_memory_namespace_set_sha256:
                    manifest.cohort.eligible_memory_namespace_set_sha256,
                  eligible_memory_namespace_count: 768,
                  randomization_pair_manifest_sha256:
                    manifest.cohort.randomization_pair_manifest_sha256,
                  randomization_pair_count: 384,
                  activation_schedule_sha256: manifest.cohort.activation_schedule_sha256,
                  namespace_lease_membership_sha256:
                    manifest.cohort.namespace_lease_membership_sha256,
                  namespace_lease_count: 768,
                  planned_candidate_namespace_count: 384,
                  planned_control_namespace_count: 384,
                  assignment: {
                    assignment_design: "matched_pair_complete_randomization_v1",
                    assignment_algorithm: "matched_pair_csprng_bit_v1",
                    confirmatory_assignment_bits_sha256:
                      requiredRowString(revision, "confirmatory_assignment_bits_sha256"),
                    confirmatory_assignment_bit_count: 384,
                    confirmatory_assignment_random_bytes: 48,
                    confirmatory_assignment_bit_order:
                      "canonical_pair_hash_ascending_bit_zero_first_msb_first",
                    randomness_rejection_or_redraw_allowed: false,
                  },
                },
                applicability_manifest_sha256: manifestSha256,
                applicability_manifest: manifest,
              },
        );
        const receiptJson = stableStringify(receipt);
        await args.writeStore.insertWriteOperation({
          ...operationKey,
          requestSha256,
          receiptJson,
          commitId: null,
        });
        return {
          receipt,
          receiptJson,
          applicabilityManifest: manifest,
          applicabilityManifestJson: stableStringify(manifest),
          replayed: false,
        };
      }, derivedConfirmatory === null
        ? undefined
        : { beginBusyRetry: CONFIRMATORY_PROVISION_BEGIN_BUSY_RETRY });
    },

    async regenerateApplicabilityManifest(input) {
      return await args.database.transaction.read(() => {
        const manifest = buildApplicabilityManifestFromDatabase({
          db: args.database.db,
          tenantId: boundedExact(input.tenantId, "tenantId"),
          experimentId: boundedExact(input.experimentId, "experimentId"),
          experimentRevision: input.experimentRevision,
        });
        if (manifest.evidence_intent === "confirmatory") {
          assertTenantScopeAuthority(
            args.database.db,
            provisioningDefaultTenantId(args.dependencies?.defaultTenantId),
          );
        }
        return manifest;
      });
    },
  };
}

export async function provisionLiteLearningExperiment(
  args: LearningExperimentProvisionInput & { path: string },
): Promise<LearningExperimentProvisionResult> {
  const database = createLiteRuntimeDatabase(args.path);
  let writeStore: LiteWriteStore | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const provisioner = createLiteLearningExperimentProvisioner({
      database,
      writeStore,
    });
    return await provisioner.provision(args);
  } finally {
    try {
      await writeStore?.close();
    } finally {
      await database.close();
    }
  }
}
