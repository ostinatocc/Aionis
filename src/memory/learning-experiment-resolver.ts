import stableStringify from "fast-json-stable-stringify";

import {
  admissionCandidatePolicyExperimentDeclarationDigest,
  admissionCandidatePolicyProfileRuleDigest,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../config.js";
import {
  resolveAdmissionCandidatePolicy,
} from "./admission-candidate-policy.js";
import {
  resolveLearningGatePolicy,
} from "./learning-gate-policy.js";
import {
  PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY,
  type LearningExternalExecutionPolicyRegistryEntry,
} from "./learning-external-execution-policy.js";
import {
  asPublicScope,
  asStoreScope,
  externalExecutionPolicyDigest,
  learningAssignmentUnitSha256,
  learningCollectionPrincipalSha256,
  learningMemoryNamespaceSha256,
  reconcileCanonicalLearningTaskIdentity,
  resolveLearningExperimentCompatibility,
  type HostTaskEnvelopeV1,
} from "./learning-episode-ledger.js";
import type {
  LiteLearningEpisodeLedgerAccess,
  LiteLearningExperimentAuthorityResolution,
} from "../store/lite-learning-episode-ledger.js";
import type { AuthPrincipal } from "../util/auth.js";
import { sha256Hex } from "../util/crypto.js";

type CanonicalTaskSource = Parameters<typeof reconcileCanonicalLearningTaskIdentity>[0]["sources"][number];

export type LearningExperimentResolverRegistry = Readonly<{
  resolveCandidatePolicy: (
    policyId: string,
    policyVersion: string,
  ) => Readonly<{
    policy_id: string;
    policy_version: string;
    policy_config_sha256: string;
    implementation_contract_sha256: string;
  }>;
  resolveGatePolicy: (
    policyId: string,
    policyVersion: string,
  ) => Readonly<{
    policy_id: string;
    policy_version: string;
    registry_status: "calibration_pending" | "registered";
    policy_config_sha256: string;
    implementation_contract_sha256: string;
    prospective_calibration_artifact_sha256: string | null;
  }>;
  resolveExternalExecutionPolicy: (
    registryKey: string,
    databaseInstanceId: string,
  ) => LearningExternalExecutionPolicyRegistryEntry | null;
}>;

export const PRODUCTION_LEARNING_EXPERIMENT_RESOLVER_REGISTRY: LearningExperimentResolverRegistry = {
  resolveCandidatePolicy: (policyId, policyVersion) =>
    resolveAdmissionCandidatePolicy(policyId, policyVersion),
  resolveGatePolicy: (policyId, policyVersion) => resolveLearningGatePolicy(policyId, policyVersion),
  resolveExternalExecutionPolicy: (registryKey, databaseInstanceId) =>
    PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY.resolve({
      registryKey,
      databaseInstanceId,
    }),
};

export type LearningExperimentGuideResolution = Readonly<{
  mode: "off" | "shadow" | "active";
  source: "off" | "global_env" | "legacy_profile" | "experiment";
  serving_authority: "off" | "fixed_shadow" | "fixed_active" | "experiment";
  serving_arm: "control" | "candidate";
  enrollment_state: "not_enrolled" | "diagnostic" | "enrolled";
  promotion_eligible: boolean;
  profile_id: string | null;
  experiment_id: string | null;
  experiment_revision: number | null;
  experiment_config_sha256: string | null;
  collection_class: "eligible_host" | "fixture_pilot" | "unverified";
  assignment: LiteLearningExperimentAuthorityResolution["assignment"];
  namespace_lease?: LiteLearningExperimentAuthorityResolution["namespace_lease"];
  reason_codes: readonly string[];
}>;

export type LearningExperimentResolverInput = Readonly<{
  globalMode: "off" | "shadow" | "active";
  matchedRule: AionisAdmissionCandidatePolicyProfileRule | null;
  principal: AuthPrincipal | null;
  tenantId: string;
  publicScope: string;
  storeScope: string;
  taskSources: readonly CanonicalTaskSource[];
  taskIdentityInvalid: boolean;
  operationProtected: boolean;
  projectionComplete: boolean;
  now: string;
}>;

type LearningExperimentResolverDependencies = Readonly<{
  ledger: Pick<
    LiteLearningEpisodeLedgerAccess,
    "databaseInstanceId" | "resolveGuideExperimentAuthority"
  >;
  registry?: LearningExperimentResolverRegistry;
}>;

function controlResolution(args: {
  source: LearningExperimentGuideResolution["source"];
  servingAuthority?: LearningExperimentGuideResolution["serving_authority"];
  servingArm?: LearningExperimentGuideResolution["serving_arm"];
  mode?: LearningExperimentGuideResolution["mode"];
  profileId?: string | null;
  experimentId?: string | null;
  experimentRevision?: number | null;
  experimentConfigSha256?: string | null;
  collectionClass?: LearningExperimentGuideResolution["collection_class"];
  enrollmentState?: LearningExperimentGuideResolution["enrollment_state"];
  assignment?: LiteLearningExperimentAuthorityResolution["assignment"];
  namespaceLease?: LiteLearningExperimentAuthorityResolution["namespace_lease"];
  reasons: readonly string[];
}): LearningExperimentGuideResolution {
  return {
    mode: args.mode ?? "off",
    source: args.source,
    serving_authority: args.servingAuthority ?? "off",
    serving_arm: args.servingArm ?? "control",
    enrollment_state: args.enrollmentState ?? "not_enrolled",
    promotion_eligible: false,
    profile_id: args.profileId ?? null,
    experiment_id: args.experimentId ?? null,
    experiment_revision: args.experimentRevision ?? null,
    experiment_config_sha256: args.experimentConfigSha256 ?? null,
    collection_class: args.collectionClass ?? "unverified",
    assignment: args.assignment ?? null,
    namespace_lease: args.namespaceLease ?? null,
    reason_codes: [...args.reasons],
  };
}

function digest(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function learningCollectionSourcePolicyProjection(
  experiment: NonNullable<AionisAdmissionCandidatePolicyProfileRule["experiment"]>,
) {
  return {
    contract_version: "aionis_collection_source_policy_v1" as const,
    collection_sources: experiment.collection_sources.map((source) => ({
      principal_sha256: source.principal_sha256,
      class: source.class,
      collector_id: source.collector_id,
      collector_version: source.collector_version,
      verifier_policy_sha256: source.verifier_policy_sha256,
    })),
  };
}

function principalFingerprint(principal: AuthPrincipal | null, tenantId: string): string | null {
  if (!principal || principal.tenant_id !== tenantId) return null;
  try {
    return learningCollectionPrincipalSha256({
      tenant_id: principal.tenant_id,
      agent_id: principal.agent_id,
      team_id: principal.team_id,
    });
  } catch {
    return null;
  }
}

function strongestSafetyReason(
  authority: LiteLearningExperimentAuthorityResolution,
): string | null {
  if (authority.candidate_authority_actions.includes("retire")) return "candidate_implementation_retired";
  if (authority.safety_pause_required || authority.candidate_authority_actions.includes("pause")) {
    return "candidate_implementation_paused";
  }
  if (authority.candidate_authority_actions.includes("demote")) return "candidate_implementation_demoted";
  return null;
}

function revisionMatchesDeclaration(args: {
  rule: AionisAdmissionCandidatePolicyProfileRule;
  authority: LiteLearningExperimentAuthorityResolution;
  registry: LearningExperimentResolverRegistry;
  databaseInstanceId: string;
  taskFamily: string;
}): { matches: boolean; reason: string } {
  const experiment = args.rule.experiment!;
  const revision = args.authority.revision;
  if (!revision) return { matches: false, reason: "experiment_revision_unprovisioned" };
  const compatibility = resolveLearningExperimentCompatibility({
    profileMode: args.rule.mode,
    servingPhase: experiment.serving_phase,
    evidenceIntent: experiment.evidence_intent,
    candidateAllocationBps: experiment.candidate_allocation_bps,
  });
  if (!compatibility.compatible) return { matches: false, reason: compatibility.reason };

  let candidate: ReturnType<LearningExperimentResolverRegistry["resolveCandidatePolicy"]>;
  let gate: ReturnType<LearningExperimentResolverRegistry["resolveGatePolicy"]>;
  let externalPolicy: LearningExternalExecutionPolicyRegistryEntry | null;
  try {
    candidate = args.registry.resolveCandidatePolicy(
      experiment.candidate_policy_id,
      experiment.candidate_policy_version,
    );
    gate = args.registry.resolveGatePolicy(experiment.gate_policy_id, experiment.gate_policy_version);
    externalPolicy = args.registry.resolveExternalExecutionPolicy(
      experiment.external_execution_policy_ref.registry_key,
      args.databaseInstanceId,
    );
    if (candidate.policy_id !== experiment.candidate_policy_id
      || candidate.policy_version !== experiment.candidate_policy_version
      || gate.policy_id !== experiment.gate_policy_id
      || gate.policy_version !== experiment.gate_policy_version
      || (externalPolicy !== null
        && (externalPolicy.registry_key !== experiment.external_execution_policy_ref.registry_key
          || externalPolicy.database_instance_id !== args.databaseInstanceId
          || externalPolicy.policy.runtime_authority_attestor.expected_database_instance_id
            !== args.databaseInstanceId
          || externalExecutionPolicyDigest(externalPolicy.policy) !== externalPolicy.policy_sha256))) {
      throw new Error("learning experiment policy registry tuple mismatch");
    }
  } catch {
    return { matches: false, reason: "experiment_policy_registry_unresolved" };
  }
  if (gate.registry_status !== "registered" || gate.prospective_calibration_artifact_sha256 === null) {
    return { matches: false, reason: "gate_prospective_calibration_unregistered" };
  }
  if (externalPolicy === null) {
    return { matches: false, reason: "external_execution_policy_registry_unresolved" };
  }

  const profileRuleSha256 = admissionCandidatePolicyProfileRuleDigest(args.rule);
  const declarationSha256 = admissionCandidatePolicyExperimentDeclarationDigest(experiment);
  const sourcePolicySha256 = digest(learningCollectionSourcePolicyProjection(experiment));
  const evidenceSeriesSha256 = digest(experiment.required_evidence_series);
  const requiredExternalInputsSha256 = digest(experiment.required_external_inputs);
  const config = revision.config_bindings;
  const exact = revision.profile_id === args.rule.profile_id
    && revision.profile_rule_sha256 === profileRuleSha256
    && revision.serving_phase === experiment.serving_phase
    && revision.evidence_intent === experiment.evidence_intent
    && revision.assignment_design === experiment.assignment_design
    && revision.candidate_policy_id === candidate.policy_id
    && revision.candidate_policy_version === candidate.policy_version
    && revision.candidate_policy_implementation_sha256 === candidate.implementation_contract_sha256
    && revision.candidate_policy_config_sha256 === candidate.policy_config_sha256
    && revision.candidate_allocation_bps === experiment.candidate_allocation_bps
    && revision.collection_source_policy_sha256 === sourcePolicySha256
    && revision.gate_policy_id === gate.policy_id
    && revision.gate_policy_version === gate.policy_version
    && revision.gate_policy_config_sha256 === gate.policy_config_sha256
    && revision.gate_prospective_calibration_sha256 === gate.prospective_calibration_artifact_sha256
    && revision.required_evidence_series_sha256 === evidenceSeriesSha256
    && revision.required_external_inputs_sha256 === requiredExternalInputsSha256
    && revision.external_execution_policy_sha256 === externalPolicy.policy_sha256
    && revision.safety_pause_mode === "automatic"
    && config.task_family === args.taskFamily
    && config.experiment_declaration_sha256 === declarationSha256
    && config.profile_rule_sha256 === profileRuleSha256
    && config.collection_source_policy_sha256 === sourcePolicySha256
    && config.required_evidence_series_sha256 === evidenceSeriesSha256
    && config.external_execution_policy_registry_key
      === experiment.external_execution_policy_ref.registry_key;
  return exact
    ? { matches: true, reason: "immutable_experiment_revision_matched" }
    : { matches: false, reason: "experiment_revision_config_drift" };
}

export async function resolveLearningExperimentForGuide(
  input: LearningExperimentResolverInput,
  dependencies: LearningExperimentResolverDependencies,
): Promise<LearningExperimentGuideResolution> {
  if (input.globalMode === "active") {
    return controlResolution({
      source: "global_env",
      servingAuthority: "fixed_active",
      servingArm: "candidate",
      mode: "active",
      reasons: ["global_fixed_active_override", "promotion_ineligible_non_randomized"],
    });
  }
  if (input.globalMode === "shadow") {
    return controlResolution({
      source: "global_env",
      servingAuthority: "fixed_shadow",
      mode: "shadow",
      reasons: ["global_fixed_shadow_override", "promotion_ineligible_non_randomized"],
    });
  }
  if (!input.matchedRule) {
    return controlResolution({ source: "off", reasons: ["no_matching_profile"] });
  }
  if (!input.matchedRule.experiment) {
    return controlResolution({
      source: "legacy_profile",
      servingAuthority: input.matchedRule.mode === "active" ? "fixed_active" : "fixed_shadow",
      servingArm: input.matchedRule.mode === "active" ? "candidate" : "control",
      mode: input.matchedRule.mode,
      profileId: input.matchedRule.profile_id,
      reasons: ["legacy_fixed_profile", "promotion_ineligible_non_randomized"],
    });
  }

  const rule = input.matchedRule;
  const experiment = rule.experiment!;
  const base = {
    source: "experiment" as const,
    servingAuthority: "experiment" as const,
    mode: "shadow" as const,
    profileId: rule.profile_id,
    experimentId: experiment.experiment_id,
    experimentRevision: experiment.revision,
  };
  if (input.taskIdentityInvalid || input.taskSources.length === 0) {
    return controlResolution({ ...base, reasons: ["canonical_task_identity_missing_or_invalid"] });
  }

  let taskIdentity: ReturnType<typeof reconcileCanonicalLearningTaskIdentity>;
  try {
    taskIdentity = reconcileCanonicalLearningTaskIdentity({
      tenantId: input.tenantId,
      publicScope: asPublicScope(input.publicScope),
      storeScope: asStoreScope(input.storeScope),
      sources: [...input.taskSources],
    });
  } catch {
    return controlResolution({ ...base, reasons: ["canonical_task_identity_disagreement"] });
  }
  const fingerprint = principalFingerprint(input.principal, input.tenantId);
  const declaredSource = fingerprint === null
    ? undefined
    : experiment.collection_sources.find((source) => source.principal_sha256 === fingerprint);
  const hostEnvelope = input.taskSources.find((source) => source.source === "host_task_envelope_v1");
  if (hostEnvelope && declaredSource?.class !== "eligible_host") {
    return controlResolution({
      ...base,
      reasons: ["host_task_identity_requires_eligible_host"],
    });
  }
  if (declaredSource?.class === "eligible_host") {
    if (!hostEnvelope || hostEnvelope.source !== "host_task_envelope_v1") {
      return controlResolution({ ...base, reasons: ["eligible_host_envelope_required"] });
    }
    const envelope: HostTaskEnvelopeV1 = hostEnvelope.envelope;
    if (envelope.collector_id !== declaredSource.collector_id
      || envelope.collector_version !== declaredSource.collector_version) {
      return controlResolution({ ...base, reasons: ["eligible_host_collector_mismatch"] });
    }
  }

  const memoryNamespaceSha256 = learningMemoryNamespaceSha256(taskIdentity.store_scope);
  const assignmentUnitSha256 = learningAssignmentUnitSha256({
    tenantId: input.tenantId,
    storeScope: taskIdentity.store_scope,
  });
  let authority: LiteLearningExperimentAuthorityResolution;
  let databaseInstanceId: string;
  try {
    databaseInstanceId = await dependencies.ledger.databaseInstanceId();
    authority = await dependencies.ledger.resolveGuideExperimentAuthority({
      tenantId: input.tenantId,
      experimentId: experiment.experiment_id,
      experimentRevision: experiment.revision,
      taskFamily: taskIdentity.task_family,
      collectionPrincipalSha256: fingerprint,
      memoryNamespaceSha256,
      assignmentUnitSha256,
    });
  } catch {
    return controlResolution({ ...base, reasons: ["experiment_authority_read_failed"] });
  }
  const registry = dependencies.registry ?? PRODUCTION_LEARNING_EXPERIMENT_RESOLVER_REGISTRY;
  const revisionMatch = revisionMatchesDeclaration({
    rule,
    authority,
    registry,
    databaseInstanceId,
    taskFamily: taskIdentity.task_family,
  });
  if (!revisionMatch.matches) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision?.config_sha256 ?? null,
      reasons: [revisionMatch.reason],
    });
  }
  const collectionClass = authority.collection_principal?.collection_class ?? "unverified";
  if (declaredSource && (
    !authority.collection_principal
    || authority.collection_principal.collection_principal_sha256 !== declaredSource.principal_sha256
    || authority.collection_principal.collection_class !== declaredSource.class
    || authority.collection_principal.collector_id !== declaredSource.collector_id
    || authority.collection_principal.collector_version !== declaredSource.collector_version
    || authority.collection_principal.verifier_policy_sha256 !== declaredSource.verifier_policy_sha256
  )) {
    return controlResolution({ ...base, reasons: ["collection_principal_binding_drift"] });
  }
  if (!declaredSource && authority.collection_principal) {
    return controlResolution({ ...base, reasons: ["collection_principal_not_in_revision"] });
  }
  const confirmatoryEligible = experiment.evidence_intent === "confirmatory"
    && collectionClass === "eligible_host";
  const resolvedAssignmentBinding = authority.assignment?.assignment_algorithm
    === "diagnostic_sha256_48_mod_10000_v1"
    ? {
        enrollmentState: "diagnostic" as const,
        assignment: authority.assignment,
      }
    : confirmatoryEligible
      && authority.assignment?.assignment_algorithm === "matched_pair_csprng_bit_v1"
      && authority.namespace_lease !== null
      && authority.confirmatory_attempt?.task_family === taskIdentity.task_family
      ? {
          enrollmentState: "enrolled" as const,
          assignment: authority.assignment,
          namespaceLease: authority.namespace_lease,
        }
      : {};
  const safetyReason = strongestSafetyReason(authority);
  if (authority.experiment_closed) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision!.config_sha256,
      collectionClass,
      ...resolvedAssignmentBinding,
      reasons: [...(safetyReason ? [safetyReason] : []), "experiment_closed"],
    });
  }
  if (safetyReason) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision!.config_sha256,
      collectionClass,
      ...resolvedAssignmentBinding,
      reasons: [safetyReason],
    });
  }
  if (authority.active_namespace_lease_conflict) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision!.config_sha256,
      collectionClass,
      reasons: ["namespace_actively_leased_elsewhere"],
    });
  }
  if (!input.operationProtected || !input.projectionComplete) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision!.config_sha256,
      collectionClass,
      ...resolvedAssignmentBinding,
      reasons: [
        ...(input.operationProtected ? [] : ["protected_operation_required"]),
        ...(input.projectionComplete ? [] : ["complete_projection_required"]),
      ],
    });
  }
  if (!authority.assignment) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision!.config_sha256,
      collectionClass,
      reasons: ["frozen_assignment_unresolved"],
    });
  }

  if (confirmatoryEligible) {
    const lease = authority.namespace_lease;
    const attempt = authority.confirmatory_attempt;
    if (!lease || !attempt || attempt.task_family !== taskIdentity.task_family) {
      return controlResolution({
        ...base,
        experimentConfigSha256: authority.revision!.config_sha256,
        collectionClass,
        reasons: ["confirmatory_attempt_or_lease_unresolved"],
      });
    }
    if (input.now < lease.activation_starts_at || input.now > lease.index_window_ends_at) {
      return controlResolution({
        ...base,
        experimentConfigSha256: authority.revision!.config_sha256,
        collectionClass,
        ...resolvedAssignmentBinding,
        reasons: ["confirmatory_activation_window_inactive"],
      });
    }
  }

  const phaseServesCandidate = experiment.serving_phase === "active_control"
    && authority.assignment.assignment_arm === "candidate";
  if (confirmatoryEligible) {
    return controlResolution({
      ...base,
      experimentConfigSha256: authority.revision!.config_sha256,
      collectionClass,
      enrollmentState: "enrolled",
      assignment: authority.assignment,
      namespaceLease: authority.namespace_lease,
      reasons: [
        "external_prerequisite_roots_unavailable",
        phaseServesCandidate ? "candidate_arm_failed_control" : "control_arm_observation_deferred",
      ],
    });
  }
  return {
    mode: phaseServesCandidate ? "active" : "shadow",
    source: "experiment",
    serving_authority: "experiment",
    serving_arm: phaseServesCandidate ? "candidate" : "control",
    enrollment_state: confirmatoryEligible ? "enrolled" : "diagnostic",
    promotion_eligible: confirmatoryEligible,
    profile_id: rule.profile_id,
    experiment_id: experiment.experiment_id,
    experiment_revision: experiment.revision,
    experiment_config_sha256: authority.revision!.config_sha256,
    collection_class: collectionClass,
    assignment: authority.assignment,
    namespace_lease: authority.namespace_lease,
    reason_codes: [
      confirmatoryEligible ? "confirmatory_active_lease" : "diagnostic_assignment",
      phaseServesCandidate ? "candidate_arm_served" : "control_arm_served",
    ],
  };
}
