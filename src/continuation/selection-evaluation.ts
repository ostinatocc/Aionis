import {
  canonicalContinuationClone,
  assertCanonicalUtcMillis,
  assertSha256,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  compareCanonicalUtf8,
  type AuthorityBranchRefV1,
  type CapsuleCoverageClaimV1,
  type CapsuleRefV1,
  type ContinuationContractV1,
  type ContinuationCoverageCertificateV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
  type ExcludedCapsuleV1,
  type HostObservationV1,
  type PreconditionEvaluationV1,
  type SelectedCapsuleV1,
  type Sha256,
  type TypedPreconditionSpecV1,
} from "./contract.js";
import { evaluatePreconditionV1, validatePreconditionSpecV1 } from "./observation.js";
import {
  continuationProjectionCapsuleBytesV1,
  continuationProjectionRehydrationRefsBytesV1,
} from "./renderer.js";
import { continuationAuthoritySubjectSha256V1 } from "./task-envelope.js";
import {
  verifyWorldObservationSnapshotV1,
  type WorldObservationSnapshotV1,
} from "./world-snapshot.js";
import {
  verifyContinuationCompilerPolicyV1,
  type ContinuationCompilerPolicyV1,
} from "./compiler-policy.js";
import type { ContinuationCompilerCandidateV1 } from
  "./candidate-retrieval.js";

/**
 * Pure, authority-free selection evaluation. This module can compare a
 * hypothetical learning branch but cannot mint executable authority.
 */


type CandidateInfluenceBindingV1 =
  | ContinuationCompilerCandidateV1["provenance"] extends infer P
    ? P extends { lane: "governed_learning"; branch_binding: infer B } ? B
      : P extends { lane: "verified_continuity"; continuity_binding: infer B } ? B
        : never
    : never;

function influenceBinding(
  candidate: ContinuationCompilerCandidateV1,
): CandidateInfluenceBindingV1 {
  return candidate.provenance.lane === "governed_learning"
    ? candidate.provenance.branch_binding
    : candidate.provenance.continuity_binding;
}

export class ContinuationCompilerSelectedCapsuleCapacityErrorV1 extends Error {
  readonly selectedCount: number;
  readonly selectedLimit: number;

  constructor(selectedCount: number, selectedLimit: number) {
    super("continuation_compiler_selected_capsule_capacity_exceeded");
    this.name = "ContinuationCompilerSelectedCapsuleCapacityErrorV1";
    this.selectedCount = selectedCount;
    this.selectedLimit = selectedLimit;
  }
}

export type ContinuationSelectionFenceV1 = Readonly<{
  authority_subject_sha256: Sha256;
  evaluated_learning_branch: AuthorityBranchRefV1;
  memory_scope_head_revision: number;
  memory_scope_head_sha256: Sha256;
  compiler_policy_payload_sha256: Sha256;
}>;

export type EvaluateContinuationSelectionV1Args = Readonly<{
  schema_version: "continuation_selection_input_v1";
  identity: ContinuationContractV1["identity"];
  fence: ContinuationSelectionFenceV1;
  obligations: readonly ContinuationObligationV1[];
  candidates: readonly ContinuationCompilerCandidateV1[];
  observation_snapshot: WorldObservationSnapshotV1;
  evaluated_at: string;
  render_budget: number;
  projection_frame_bytes: number;
  forced_excluded_capsule_refs: readonly CapsuleRefV1[];
  policy: ContinuationCompilerPolicyV1;
}>;

export type ContinuationSelectionEvaluationV1 = Readonly<{
  schema_version: "continuation_selection_evaluation_v1";
  fence: ContinuationSelectionFenceV1;
  obligations: readonly ContinuationObligationV1[];
  selected_capsules: readonly SelectedCapsuleV1[];
  excluded_capsules: readonly ExcludedCapsuleV1[];
  coverage: ContinuationCoverageCertificateV1["coverage"];
  candidate_partition: ContinuationCoverageCertificateV1["candidate_partition"];
  hard_obligation_coverage_complete: boolean;
  direct_use_preconditions_complete: boolean;
  conflict_free: boolean;
  budget_satisfied: boolean;
  required_render_bytes: number;
  status: "complete" | "incomplete";
  reason_codes: readonly string[];
  safe_fallback: Readonly<{
    mode: ContinuationContractV1["safe_fallback"]["mode"];
    reason_codes: readonly string[];
    unresolved_obligation_ids: readonly string[];
    rehydration_capsule_refs: readonly CapsuleRefV1[];
  }>;
  render_plan: Readonly<{
    projection_frame_bytes: number;
    selected_capsules: readonly Readonly<{
      selection: SelectedCapsuleV1;
      capsule: ExecutionCapsuleV1;
    }>[];
    rehydration_capsule_refs: readonly CapsuleRefV1[];
  }>;
  obligation_universe_sha256: Sha256;
  candidate_universe_sha256: Sha256;
  selected_surface_sha256: Sha256;
  evaluated_at: string;
  evaluation_sha256: Sha256;
}>;

type PreparedCandidate = {
  input: ContinuationCompilerCandidateV1;
  surface: SelectedCapsuleV1["surface"];
  evaluations: PreconditionEvaluationV1[];
  coveredIds: string[];
  coverageBindings: Array<Readonly<{
    obligation_id: string;
    coverage_claim_sha256: Sha256;
  }>>;
  reasons: string[];
  mandatory: boolean;
};

function selectedCapsuleOutput(candidate: PreparedCandidate): SelectedCapsuleV1 {
  return {
    capsule: capsuleRef(candidate.input.capsule),
    surface: candidate.surface,
    coverage_bindings: candidate.coverageBindings,
    satisfied_probe_ids: candidate.evaluations
      .filter((value) => value.status === "satisfied")
      .map((value) => value.probe_id),
    selection_reason_codes: canonicalUniqueSet([...new Set(candidate.reasons)], (reason) => reason),
  };
}

function coverageClaimMatchesObligation(
  claim: CapsuleCoverageClaimV1,
  obligation: ContinuationObligationV1,
): boolean {
  return claim.obligation_kind === obligation.kind
    && claim.evidence_requirement === obligation.evidence_requirement
    && canonicalContinuationJson(claim.target_refs)
      === canonicalContinuationJson(obligation.target_refs)
    && canonicalContinuationJson(claim.required_probe_ids)
      === canonicalContinuationJson(obligation.required_probe_ids);
}

function assertBoundedText(value: string, maxBytes: number, field: string): void {
  if (value.length === 0 || value !== value.trim() || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be non-empty canonical text bounded to ${maxBytes} UTF-8 bytes`);
  }
}

function validateObligations(obligations: readonly ContinuationObligationV1[]): void {
  if (obligations.filter((item) => item.requirement === "hard").length > 32) {
    throw new Error("hard obligation set exceeds its structural bound");
  }
  for (const item of obligations) {
    assertBoundedText(item.obligation_id, 256, "obligation_id");
    assertBoundedText(item.statement, 1024, "obligation.statement");
    if (item.target_refs.length < 1 || item.target_refs.length > 16
      || item.required_probe_ids.length > 16 || item.source_refs.length > 32) {
      throw new Error("obligation reference set exceeds its structural bound");
    }
    const targetKeys = item.target_refs.map((target) => `${target.kind}\0${target.ref}`);
    if (new Set(targetKeys).size !== targetKeys.length
      || new Set(item.required_probe_ids).size !== item.required_probe_ids.length
      || new Set(item.source_refs).size !== item.source_refs.length) {
      throw new Error("obligation reference sets must not contain duplicates");
    }
    assertCanonicalSet(item.target_refs, (target) => `${target.kind}\0${target.ref}`, "obligation.target_refs");
    assertCanonicalSet(item.required_probe_ids, (id) => id, "obligation.required_probe_ids");
    assertCanonicalSet(item.source_refs, (ref) => ref, "obligation.source_refs");
    item.target_refs.forEach((target) => assertBoundedText(target.ref, 1024, "obligation.target_ref"));
    item.required_probe_ids.forEach((id) => assertBoundedText(id, 256, "obligation.required_probe_id"));
    item.source_refs.forEach((ref) => assertBoundedText(ref, 256, "obligation.source_ref"));
  }
}

function assertCanonicalSet<T>(values: readonly T[], key: (value: T) => string, field: string): void {
  const canonical = canonicalUniqueSet(values, key);
  if (canonical.some((value, index) => key(value) !== key(values[index]!))) {
    throw new Error(`${field} must use canonical UTF-8 set order`);
  }
}

function capsuleRef(capsule: ExecutionCapsuleV1): CapsuleRefV1 {
  return {
    capsule_id: capsule.capsule_id,
    capsule_revision: capsule.capsule_revision,
    capsule_sha256: capsule.capsule_sha256,
  };
}

function capsuleRefKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision}\0${ref.capsule_sha256}`;
}

function capsuleKey(candidate: ContinuationCompilerCandidateV1): string {
  return capsuleRefKey(candidate.capsule);
}

function authorityRefKey(ref: AuthorityBranchRefV1): string {
  return `${ref.branch_id}\0${ref.branch_revision}\0${ref.manifest_sha256}`;
}

function authorityRank(value: "candidate" | "verified" | "authoritative"): number {
  return value === "authoritative" ? 2 : value === "verified" ? 1 : 0;
}

function observerForEvidenceRequirement(
  requirement: ContinuationObligationV1["evidence_requirement"],
): TypedPreconditionSpecV1["observer"] | null {
  if (requirement === "runtime_state") return null;
  if (requirement === "trusted_host") return "trusted_host_collector";
  return "external_verifier";
}

function freshnessBucket(
  candidate: ContinuationCompilerCandidateV1,
  compiledAt: string,
  policy: ContinuationCompilerPolicyV1,
): 0 | 1 | 2 | 3 {
  const age = Math.max(0, Date.parse(compiledAt) - Date.parse(candidate.capsule.created_at));
  if (age <= policy.freshness_max_age_ms[0]) return 3;
  if (age <= policy.freshness_max_age_ms[1]) return 2;
  if (age <= policy.freshness_max_age_ms[2]) return 1;
  return 0;
}

function validatePolicy(policy: ContinuationCompilerPolicyV1, renderBudget: number): void {
  const boundedPositive = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
  if (!boundedPositive(policy.candidate_limit, 256)
    || !boundedPositive(policy.continuity_candidate_limit, 255)
    || !boundedPositive(policy.learning_candidate_limit, 255)
    || policy.continuity_candidate_limit + policy.learning_candidate_limit
      !== policy.candidate_limit
    || !boundedPositive(policy.selected_capsule_limit, 64)
    || policy.selected_capsule_limit > policy.candidate_limit
    || !boundedPositive(policy.obligation_limit, 64)
    || policy.max_render_budget < 1024
    || !boundedPositive(policy.max_render_budget, 65_536)
    || renderBudget < 1024
    || !boundedPositive(renderBudget, policy.max_render_budget)) {
    throw new Error("continuation compiler bounds are invalid");
  }
  const weights = [
    policy.hard_coverage_weight,
    policy.advisory_coverage_weight,
    ...Object.values(policy.authority_bonus),
    ...policy.freshness_bonus,
  ];
  if (weights.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
    throw new Error("continuation compiler weights must be bounded non-negative integers");
  }
  const ages = policy.freshness_max_age_ms;
  if (ages.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || !(ages[0] < ages[1] && ages[1] < ages[2])) {
    throw new Error("continuation freshness bounds must be strictly increasing positive integers");
  }
}

function prepareCandidate(args: {
  candidate: ContinuationCompilerCandidateV1;
  obligations: ReadonlyMap<string, ContinuationObligationV1>;
  observationsByProbe: Map<string, HostObservationV1>;
  trustedObserversByRole: Readonly<Record<TypedPreconditionSpecV1["observer"], ReadonlySet<Sha256>>>;
  identity: ContinuationContractV1["identity"];
  compiledAt: string;
}): PreparedCandidate | ExcludedCapsuleV1 {
  const { candidate, identity } = args;
  const capsule = candidate.capsule;
  const exclude = (...reason_codes: string[]): ExcludedCapsuleV1 => ({
    capsule: capsuleRef(capsule),
    reason_codes,
  });
  if (influenceBinding(candidate).disposition === "exclude") {
    return exclude("branch_excluded");
  }
  if (candidate.lifecycle_fact.memory_id !== capsule.source.memory_id) {
    return exclude("source_revision_stale");
  }
  if (candidate.lifecycle_fact.lifecycle === "suppressed") {
    return exclude("lifecycle_suppressed");
  }
  if (candidate.lifecycle_fact.lifecycle === "quarantined") {
    return exclude("lifecycle_quarantined");
  }
  if (candidate.lifecycle_fact.lifecycle !== "archived"
    && candidate.lifecycle_fact.memory_projection_sha256
      !== capsule.source.source_projection_sha256) {
    return exclude("source_revision_stale");
  }
  if (capsule.applicability.tenant_id !== identity.tenant_id
    || capsule.applicability.scope !== identity.scope) return exclude("scope_mismatch");
  if (capsule.applicability.task_family !== identity.task_family
    || (capsule.applicability.task_signature !== null
      && capsule.applicability.task_signature !== identity.task_signature)
    || (capsule.applicability.workflow_signature !== null
      && capsule.applicability.workflow_signature !== identity.workflow_signature)) {
    return exclude("task_binding_mismatch");
  }
  if ((capsule.applicability.workspace_signature !== null
      && capsule.applicability.workspace_signature !== identity.workspace_signature)
    || (capsule.applicability.owner_agent_id !== null
      && capsule.applicability.owner_agent_id !== identity.consumer_agent_id)
    || (capsule.applicability.owner_team_id !== null
      && capsule.applicability.owner_team_id !== identity.consumer_team_id)) {
    return exclude("workspace_or_owner_mismatch");
  }
  if (capsule.expires_at !== null && Date.parse(capsule.expires_at) <= Date.parse(args.compiledAt)) {
    return exclude("capsule_expired");
  }
  const coverageBindings = canonicalUniqueSet(
    [...args.obligations.values()].flatMap((obligation) => {
      const claim = capsule.coverage_claims.find((item) =>
        coverageClaimMatchesObligation(item, obligation));
      return claim ? [{
        obligation_id: obligation.obligation_id,
        coverage_claim_sha256: claim.coverage_claim_sha256,
      }] : [];
    }),
    (binding) => binding.obligation_id,
  );
  const coveredIds = coverageBindings.map((binding) => binding.obligation_id);
  if (coveredIds.length === 0) return exclude("no_current_obligation_coverage");
  if (candidate.lifecycle_fact.lifecycle === "archived") {
    return exclude("lifecycle_archived_rehydration_required");
  }

  const actionSpecs = capsule.precondition_specs.filter((spec) =>
    spec.required_for === "admission" || spec.required_for === "before_action"
  );
  if (new Set(actionSpecs.map((spec) => spec.probe_id)).size !== actionSpecs.length) {
    throw new Error("capsule contains duplicate serve-phase probe ids");
  }
  const requiredProbeIds = new Set(coveredIds.flatMap((id) => {
    const obligation = args.obligations.get(id);
    return obligation?.required_probe_ids ?? [];
  }));
  const missingRequiredProbe = [...requiredProbeIds]
    .some((probeId) => !actionSpecs.some((spec) => spec.probe_id === probeId));
  const mismatchedEvidenceRole = coveredIds.some((id) => {
    const obligation = args.obligations.get(id);
    if (!obligation) return true;
    const expectedObserver = observerForEvidenceRequirement(obligation.evidence_requirement);
    if (obligation.required_probe_ids.length === 0) return expectedObserver !== null;
    if (expectedObserver === null) return true;
    return obligation.required_probe_ids.some((probeId) => actionSpecs
      .find((spec) => spec.probe_id === probeId)?.observer !== expectedObserver);
  });
  const evaluations = actionSpecs.map((spec) => evaluatePreconditionV1({
    spec,
    observation: args.observationsByProbe.get(spec.probe_id) ?? null,
    host_task_envelope_sha256: identity.host_task_envelope_sha256,
    world_snapshot_id: identity.world_snapshot_id,
    trusted_observer_principal_sha256s: args.trustedObserversByRole[spec.observer],
    compiled_at: args.compiledAt,
  }));
  const hasUnknown = evaluations.some((evaluation) => evaluation.status === "unknown");
  const hasUnsatisfied = evaluations.some((evaluation) => evaluation.status === "unsatisfied");
  const reasons: string[] = [];
  let surface: SelectedCapsuleV1["surface"] = capsule.proposed_influence === "use"
    ? "use_now"
    : capsule.proposed_influence === "inspect"
      ? "inspect_before_use"
      : capsule.proposed_influence === "rehydrate" ? "rehydrate" : "do_not_use";
  if (influenceBinding(candidate).disposition === "prohibit"
    || capsule.kind === "counter_evidence"
    || hasUnsatisfied) {
    surface = "do_not_use";
    reasons.push("direct_use_blocked");
  } else if (hasUnknown) {
    const unknownActions = actionSpecs
      .filter((_, index) => evaluations[index]?.status === "unknown")
      .map((spec) => spec.on_unknown);
    if (unknownActions.includes("block")) surface = "do_not_use";
    else if (unknownActions.includes("rehydrate")) surface = "rehydrate";
    else if (surface === "use_now") surface = "inspect_before_use";
    reasons.push("direct_use_precondition_unknown");
  } else if (missingRequiredProbe || mismatchedEvidenceRole) {
    if (surface === "use_now") surface = "inspect_before_use";
    reasons.push(mismatchedEvidenceRole ? "evidence_observer_role_mismatch" : "required_serve_probe_missing");
  }
  return {
    input: candidate,
    surface,
    evaluations,
    coveredIds,
    coverageBindings,
    reasons,
    mandatory: surface === "do_not_use" || capsule.kind === "counter_evidence",
  };
}

function candidateCoversObligation(
  candidate: PreparedCandidate,
  obligation: ContinuationObligationV1,
): boolean {
  if (obligation.kind === "prohibition") {
    return candidate.surface === "do_not_use"
      && (influenceBinding(candidate.input).disposition === "prohibit"
        || candidate.input.capsule.kind === "constraint"
        || candidate.input.capsule.kind === "counter_evidence");
  }
  if (candidate.surface !== "use_now") return false;
  const expectedObserver = observerForEvidenceRequirement(obligation.evidence_requirement);
  if (obligation.required_probe_ids.length === 0) return expectedObserver === null;
  if (expectedObserver === null) return false;
  const satisfiedProbeIds = new Set(candidate.evaluations
    .filter((evaluation) => evaluation.status === "satisfied")
    .map((evaluation) => evaluation.probe_id));
  return obligation.required_probe_ids.every((probeId) => satisfiedProbeIds.has(probeId)
    && candidate.input.capsule.precondition_specs.some((spec) =>
      spec.probe_id === probeId
      && (spec.required_for === "admission" || spec.required_for === "before_action")
      && spec.observer === expectedObserver
    ));
}

function candidateBenefit(
  candidate: PreparedCandidate,
  uncovered: ReadonlySet<string>,
  obligations: ReadonlyMap<string, ContinuationObligationV1>,
  policy: ContinuationCompilerPolicyV1,
  requirement: ContinuationObligationV1["requirement"],
  compiledAt: string,
): { benefit: number; marginal: string[] } {
  const marginal = candidate.coveredIds.filter((id) => {
    if (!uncovered.has(id)) return false;
    const obligation = obligations.get(id);
    return !!obligation
      && obligation.requirement === requirement
      && candidateCoversObligation(candidate, obligation);
  });
  let benefit = policy.authority_bonus[
    influenceBinding(candidate.input).admission_authority
  ]
    + policy.freshness_bonus[freshnessBucket(candidate.input, compiledAt, policy)];
  for (const id of marginal) {
    if (obligations.get(id)?.requirement === "hard") {
      benefit += policy.hard_coverage_weight;
    } else benefit += policy.advisory_coverage_weight;
  }
  return { benefit, marginal };
}

/**
 * Pure, authority-free selection evaluator. It can compare a hypothetical
 * learning branch but can never mint an executable authority contract.
 */
export function evaluateContinuationSelectionV1(
  args: EvaluateContinuationSelectionV1Args,
): ContinuationSelectionEvaluationV1 {
  const policy = verifyContinuationCompilerPolicyV1(args.policy);
  args = { ...args, policy };
  canonicalContinuationJson(args);
  const observationSnapshot = verifyWorldObservationSnapshotV1(args.observation_snapshot);
  validatePolicy(args.policy, args.render_budget);
  assertCanonicalUtcMillis(args.evaluated_at, "evaluated_at");
  if (!Number.isSafeInteger(args.projection_frame_bytes)
    || args.projection_frame_bytes < 0
    || args.projection_frame_bytes > 262_144) {
    throw new Error("continuation projection frame bytes are invalid");
  }
  for (const [value, field] of [
    [args.identity.decision_id, "decision_id"],
    [args.identity.tenant_id, "tenant_id"],
    [args.identity.scope, "scope"],
    [args.identity.episode_id, "episode_id"],
    [args.identity.run_id, "run_id"],
    [args.identity.host_task_id, "host_task_id"],
    [args.identity.task_family, "task_family"],
    [args.identity.task_signature, "task_signature"],
    [args.identity.workspace_signature, "workspace_signature"],
    [args.identity.world_snapshot_id, "world_snapshot_id"],
  ] as const) assertBoundedText(value, 256, field);
  for (const [value, field] of [
    [args.identity.host_task_envelope_sha256, "host_task_envelope_sha256"],
    [args.identity.collection_principal_sha256, "collection_principal_sha256"],
    [args.identity.source_task_sha256, "source_task_sha256"],
    [args.identity.source_event_sha256, "source_event_sha256"],
    [args.identity.world_snapshot_sha256, "world_snapshot_sha256"],
    [args.fence.authority_subject_sha256, "authority_subject_sha256"],
    [args.fence.evaluated_learning_branch.manifest_sha256, "evaluated_learning_branch.manifest_sha256"],
    [args.fence.memory_scope_head_sha256, "memory_scope_head_sha256"],
    [args.fence.compiler_policy_payload_sha256, "compiler_policy_payload_sha256"],
  ] as const) assertSha256(value, field);
  assertBoundedText(
    args.fence.evaluated_learning_branch.branch_id,
    256,
    "evaluated_learning_branch.branch_id",
  );
  if (!Number.isSafeInteger(args.fence.evaluated_learning_branch.branch_revision)
    || args.fence.evaluated_learning_branch.branch_revision <= 0
    || !Number.isSafeInteger(args.fence.memory_scope_head_revision)
    || args.fence.memory_scope_head_revision <= 0) {
    throw new Error("continuation selection fence is invalid");
  }
  if (args.candidates.length > args.policy.candidate_limit
    || args.obligations.length > args.policy.obligation_limit
    || observationSnapshot.observations.length > 2048
    || Buffer.byteLength(canonicalContinuationJson(observationSnapshot.observations), "utf8") > 262_144
    || Buffer.byteLength(canonicalContinuationJson(args.candidates), "utf8") > 2_097_152) {
    throw new Error("continuation compiler input exceeds its bounded universe");
  }
  const obligations = canonicalUniqueSet(args.obligations, (item) => item.obligation_id);
  validateObligations(obligations);
  const candidates = canonicalUniqueSet(args.candidates, capsuleKey);
  const observations = observationSnapshot.observations;
  const trustedObserverIds = {
    trusted_host_collector: canonicalUniqueSet(
      args.policy.trusted_observer_principals.trusted_host_collector,
      (value) => value,
    ),
    external_verifier: canonicalUniqueSet(
      args.policy.trusted_observer_principals.external_verifier,
      (value) => value,
    ),
  };
  for (const [role, principals] of Object.entries(trustedObserverIds)) {
    if (principals.length > 64) throw new Error(`${role} trusted-principal set exceeds its bound`);
    principals.forEach((value) => assertSha256(value, `${role} trusted principal`));
  }
  const candidateKeys = new Set(candidates.map(capsuleKey));
  if (new Set(candidates.map((item) => item.capsule.capsule_id)).size !== candidates.length) {
    throw new Error("candidate universe contains multiple revisions of one capsule");
  }
  for (const candidate of candidates) {
    const capsule = candidate.capsule;
    if (!Number.isSafeInteger(capsule.capsule_revision) || capsule.capsule_revision <= 0) {
      throw new Error("capsule revision must be a positive safe integer");
    }
    for (const [value, field] of [
      [capsule.capsule_id, "capsule_id"],
      [capsule.source.memory_id, "capsule.source.memory_id"],
      [capsule.source.source_commit_id, "capsule.source.source_commit_id"],
      [capsule.applicability.tenant_id, "capsule.tenant_id"],
      [capsule.applicability.scope, "capsule.scope"],
      [capsule.applicability.task_family, "capsule.task_family"],
    ] as const) assertBoundedText(value, 256, field);
    assertBoundedText(capsule.projection.summary, 2048, "capsule.projection.summary");
    if (capsule.projection.next_action !== null) {
      assertBoundedText(capsule.projection.next_action, 1024, "capsule.projection.next_action");
    }
    if (capsule.projection.workflow_steps.length > 32
      || capsule.projection.acceptance_statements.length > 32
      || capsule.projection.workflow_steps.some((step) => Buffer.byteLength(step, "utf8") > 512)
      || capsule.projection.acceptance_statements.some((value) => Buffer.byteLength(value, "utf8") > 1024)) {
      throw new Error("candidate projection text exceeds its structural bound");
    }
    assertCanonicalUtcMillis(capsule.created_at, "capsule.created_at");
    if (Date.parse(capsule.created_at) > Date.parse(args.evaluated_at)) {
      throw new Error("candidate capsule cannot be created in the future");
    }
    if (capsule.expires_at !== null) assertCanonicalUtcMillis(capsule.expires_at, "capsule.expires_at");
    if (capsule.coverage_claims.length < 1
      || capsule.coverage_claims.length > 32
      || capsule.precondition_specs.length > 16
      || capsule.conflicts_with.length > 16
      || capsule.supersedes.length > 16
      || capsule.projection.target_refs.length > 16
      || capsule.evidence_refs.length > 32
      || capsule.verifier_refs.length > 32
      || Buffer.byteLength(canonicalContinuationJson(capsule.projection), "utf8") > 8192) {
      throw new Error("candidate capsule exceeds a structural bound");
    }
    assertCanonicalSet(
      capsule.coverage_claims,
      (claim) => claim.coverage_claim_sha256,
      "capsule.coverage_claims",
    );
    for (const claim of capsule.coverage_claims) {
      if (claim.target_refs.length === 0 || claim.target_refs.length > 16
        || claim.required_probe_ids.length > 16
        || canonicalSha256Without(claim, "coverage_claim_sha256")
          !== claim.coverage_claim_sha256) {
        throw new Error("candidate capsule coverage claim is invalid");
      }
      assertCanonicalSet(
        claim.target_refs,
        (target) => `${target.kind}\0${target.ref}`,
        "capsule.coverage_claim.target_refs",
      );
      assertCanonicalSet(
        claim.required_probe_ids,
        (id) => id,
        "capsule.coverage_claim.required_probe_ids",
      );
    }
    assertCanonicalSet(capsule.precondition_specs, (spec) => spec.probe_id, "capsule.precondition_specs");
    assertCanonicalSet(capsule.projection.target_refs, (target) => `${target.kind}\0${target.ref}`, "capsule.target_refs");
    assertCanonicalSet(capsule.conflicts_with, capsuleRefKey, "capsule.conflicts_with");
    assertCanonicalSet(capsule.supersedes, capsuleRefKey, "capsule.supersedes");
    assertCanonicalSet(capsule.evidence_refs, (ref) => ref, "capsule.evidence_refs");
    assertCanonicalSet(capsule.verifier_refs, (ref) => ref, "capsule.verifier_refs");
    capsule.projection.target_refs.forEach((target) => assertBoundedText(target.ref, 1024, "capsule.target_ref"));
    capsule.evidence_refs.forEach((ref) => assertBoundedText(ref, 256, "capsule.evidence_ref"));
    capsule.verifier_refs.forEach((ref) => assertBoundedText(ref, 256, "capsule.verifier_ref"));
    if ([...capsule.conflicts_with, ...capsule.supersedes].some((ref) =>
      capsuleRefKey(ref) === capsuleKey(candidate) || !candidateKeys.has(capsuleRefKey(ref)))) {
      throw new Error("capsule relationship refs must resolve inside the bounded candidate universe");
    }
    capsule.precondition_specs.forEach(validatePreconditionSpecV1);
    const influence = influenceBinding(candidate);
    if (capsuleRefKey(influence.capsule) !== capsuleKey(candidate)
      || canonicalSha256Without(influence, "binding_sha256")
        !== influence.binding_sha256) {
      throw new Error("candidate provenance binding is invalid");
    }
    if (candidate.provenance.lane === "governed_learning") {
      if ((capsule.kind !== "procedure" && capsule.kind !== "counter_evidence")
        || authorityRefKey(
          candidate.provenance.branch_binding.branch_ref,
        ) !== authorityRefKey(args.fence.evaluated_learning_branch)) {
        throw new Error("governed learning provenance is invalid");
      }
    } else if ((capsule.kind !== "current_state"
        && capsule.kind !== "verified_fact"
        && capsule.kind !== "constraint")
      || candidate.provenance.continuity_binding.memory_id
        !== candidate.lifecycle_fact.memory_id
      || candidate.provenance.continuity_binding.capsule_source_commit_id
        !== capsule.source.source_commit_id
      || candidate.provenance.continuity_binding.memory_scope_head_revision
        !== args.fence.memory_scope_head_revision
      || candidate.provenance.continuity_binding.memory_scope_head_sha256
        !== args.fence.memory_scope_head_sha256) {
      throw new Error("verified continuity provenance is invalid");
    }
    if (!Number.isSafeInteger(candidate.lifecycle_fact.memory_scope_head_revision)
      || candidate.lifecycle_fact.memory_scope_head_revision <= 0
      || candidate.lifecycle_fact.memory_scope_head_revision !== args.fence.memory_scope_head_revision
      || candidate.lifecycle_fact.memory_scope_head_sha256 !== args.fence.memory_scope_head_sha256
      || candidate.lifecycle_fact.memory_projection_sha256
        !== capsule.source.source_projection_sha256
      || canonicalSha256Without(candidate.lifecycle_fact, "row_sha256")
        !== candidate.lifecycle_fact.row_sha256) {
      throw new Error("candidate lifecycle fact is outside the authoritative memory fence");
    }
    if (canonicalSha256Without(capsule, "capsule_sha256") !== capsule.capsule_sha256) {
      throw new Error("candidate capsule digest mismatch");
    }
    if (canonicalSha256Without(capsule.projection, "projection_sha256")
      !== capsule.projection.projection_sha256) {
      throw new Error("candidate projection digest mismatch");
    }
  }
  const expectedPolicySha = canonicalContinuationSha256(args.policy);
  if (args.fence.compiler_policy_payload_sha256 !== expectedPolicySha) {
    throw new Error("compiler policy digest does not match selection fence");
  }
  if (args.policy.tenant_id !== args.identity.tenant_id
    || (args.policy.authority_subject_sha256 !== null
      && args.policy.authority_subject_sha256 !== args.fence.authority_subject_sha256)) {
    throw new Error("compiler policy tenant or authority subject does not match compilation");
  }
  const envelope = observationSnapshot.host_task_envelope;
  const expectedAuthoritySubject = continuationAuthoritySubjectSha256V1({
    tenant_id: args.identity.tenant_id,
    scope: args.identity.scope,
    task_family: args.identity.task_family,
  });
  if (observationSnapshot.tenant_id !== args.identity.tenant_id
    || observationSnapshot.scope !== args.identity.scope
    || observationSnapshot.authority_subject_sha256 !== args.fence.authority_subject_sha256
    || envelope.tenant_id !== args.identity.tenant_id
    || envelope.scope !== args.identity.scope
    || envelope.authority_subject_sha256 !== args.fence.authority_subject_sha256
    || args.fence.authority_subject_sha256 !== expectedAuthoritySubject
    || observationSnapshot.world_snapshot_id !== args.identity.world_snapshot_id
    || observationSnapshot.world_snapshot_sha256 !== args.identity.world_snapshot_sha256
    || observationSnapshot.collection_principal_sha256 !== args.identity.collection_principal_sha256
    || envelope.host_task_id !== args.identity.host_task_id
    || envelope.host_task_envelope_sha256 !== args.identity.host_task_envelope_sha256
    || envelope.episode_id !== args.identity.episode_id
    || envelope.run_id !== args.identity.run_id
    || envelope.consumer_agent_id !== args.identity.consumer_agent_id
    || envelope.consumer_team_id !== args.identity.consumer_team_id
    || envelope.task_family !== args.identity.task_family
    || envelope.task_signature !== args.identity.task_signature
    || envelope.workflow_signature !== args.identity.workflow_signature
    || envelope.workspace_signature !== args.identity.workspace_signature
    || envelope.source_task_sha256 !== args.identity.source_task_sha256
    || envelope.source_event_sha256 !== args.identity.source_event_sha256) {
    throw new Error("world snapshot does not bind the exact continuation identity");
  }
  if (args.evaluated_at < observationSnapshot.created_at
    || args.evaluated_at >= observationSnapshot.expires_at) {
    throw new Error("world snapshot is not current at compilation time");
  }
  if (!trustedObserverIds.trusted_host_collector
    .includes(observationSnapshot.collection_principal_sha256)) {
    throw new Error("world snapshot collector is not trusted");
  }
  for (const observation of observations) {
    if (Buffer.byteLength(canonicalContinuationJson(observation.value), "utf8") > 4096) {
      throw new Error("host observation value exceeds its structural bound");
    }
    if (canonicalSha256Without(observation, "observation_sha256") !== observation.observation_sha256) {
      throw new Error("host observation digest mismatch");
    }
    if (observation.world_snapshot_id !== args.identity.world_snapshot_id) {
      throw new Error("host observation belongs to another world snapshot");
    }
  }
  const observationsByProbe = new Map<string, HostObservationV1>();
  for (const observation of observations) {
    if (observationsByProbe.has(observation.probe_id)) throw new Error("duplicate probe observation");
    observationsByProbe.set(observation.probe_id, observation);
  }
  const obligationMap = new Map(obligations.map((item) => [item.obligation_id, item]));
  const trustedObserversByRole = {
    trusted_host_collector: new Set(trustedObserverIds.trusted_host_collector),
    external_verifier: new Set(trustedObserverIds.external_verifier),
  };
  const prepared: PreparedCandidate[] = [];
  const excluded: ExcludedCapsuleV1[] = [];
  const forcedExcludedRefs = canonicalUniqueSet(
    args.forced_excluded_capsule_refs,
    capsuleRefKey,
  );
  if (forcedExcludedRefs.length !== args.forced_excluded_capsule_refs.length
    || forcedExcludedRefs.some((ref, index) =>
      capsuleRefKey(ref) !== capsuleRefKey(args.forced_excluded_capsule_refs[index]!))
    || forcedExcludedRefs.some((ref) => !candidateKeys.has(capsuleRefKey(ref)))) {
    throw new Error("forced excluded capsule refs must be a canonical subset of candidates");
  }
  const forcedExcludedKeys = new Set(forcedExcludedRefs.map(capsuleRefKey));
  for (const candidate of candidates) {
    if (forcedExcludedKeys.has(capsuleKey(candidate))) {
      excluded.push({
        capsule: capsuleRef(candidate.capsule),
        reason_codes: ["counterfactual_excluded"],
      });
      continue;
    }
    const result = prepareCandidate({
      candidate,
      obligations: obligationMap,
      observationsByProbe,
      trustedObserversByRole,
      identity: args.identity,
      compiledAt: args.evaluated_at,
    });
    if ("reason_codes" in result) excluded.push(result);
    else prepared.push(result);
  }

  const selected: PreparedCandidate[] = [];
  const selectedKeys = new Set<string>();
  const rehydrationCapsuleRefs = canonicalUniqueSet(
    excluded.flatMap((item) =>
      item.reason_codes.includes("lifecycle_archived_rehydration_required")
        ? [item.capsule]
        : []
    ),
    capsuleRefKey,
  );
  let renderCost = args.projection_frame_bytes
    + continuationProjectionRehydrationRefsBytesV1(rehydrationCapsuleRefs);
  const renderIncrement = (item: PreparedCandidate, selectedCount: number) =>
    continuationProjectionCapsuleBytesV1({
      selection: selectedCapsuleOutput(item),
      capsule: item.input.capsule,
    }) + (selectedCount > 0 ? 1 : 0);
  const allPreparedByKey = new Map(prepared.map((item) => [capsuleKey(item.input), item]));
  const supersessionGraph = new Map([...allPreparedByKey.keys()].map((key) => [key, new Set<string>()]));
  for (const item of prepared) {
    const itemKey = capsuleKey(item.input);
    for (const supersededRef of item.input.capsule.supersedes) {
      const otherKey = capsuleRefKey(supersededRef);
      const other = allPreparedByKey.get(otherKey);
      if (!other) continue;
      if (authorityRank(influenceBinding(item.input).admission_authority)
        < authorityRank(influenceBinding(other.input).admission_authority)) {
        throw new Error("a lower-authority capsule cannot supersede a higher-authority capsule");
      }
      supersessionGraph.get(itemKey)?.add(otherKey);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitSupersession = (key: string): void => {
    if (visiting.has(key)) throw new Error("capsule supersession graph contains a cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of supersessionGraph.get(key) ?? []) visitSupersession(next);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of supersessionGraph.keys()) visitSupersession(key);
  const supersededKeys = new Set([...supersessionGraph.values()].flatMap((values) => [...values]));
  for (const key of supersededKeys) {
    const item = allPreparedByKey.get(key)!;
    excluded.push({ capsule: capsuleRef(item.input.capsule), reason_codes: ["superseded_by_authority"] });
  }
  const afterSupersession = prepared.filter((item) => !supersededKeys.has(capsuleKey(item.input)));
  const afterSupersessionByKey = new Map(afterSupersession.map((item) => [capsuleKey(item.input), item]));
  const lowerAuthorityConflictKeys = new Set<string>();
  const examinedConflictPairs = new Set<string>();
  for (const item of afterSupersession) {
    const itemKey = capsuleKey(item.input);
    for (const conflictRef of item.input.capsule.conflicts_with) {
      const otherKey = capsuleRefKey(conflictRef);
      const other = afterSupersessionByKey.get(otherKey);
      if (!other) continue;
      const pairKey = compareCanonicalUtf8(itemKey, otherKey) < 0
        ? `${itemKey}\u0001${otherKey}` : `${otherKey}\u0001${itemKey}`;
      if (examinedConflictPairs.has(pairKey)) continue;
      examinedConflictPairs.add(pairKey);
      if (item.surface !== "use_now" || other.surface !== "use_now") continue;
      const itemRank = authorityRank(influenceBinding(item.input).admission_authority);
      const otherRank = authorityRank(influenceBinding(other.input).admission_authority);
      if (itemRank < otherRank) lowerAuthorityConflictKeys.add(itemKey);
      else if (otherRank < itemRank) lowerAuthorityConflictKeys.add(otherKey);
    }
  }
  for (const key of lowerAuthorityConflictKeys) {
    const item = afterSupersessionByKey.get(key)!;
    excluded.push({ capsule: capsuleRef(item.input.capsule), reason_codes: ["lower_authority_conflict"] });
  }
  const eligiblePrepared = afterSupersession
    .filter((item) => !lowerAuthorityConflictKeys.has(capsuleKey(item.input)));
  const preparedByKey = new Map(eligiblePrepared.map((item) => [capsuleKey(item.input), item]));
  const conflictGraph = new Map([...preparedByKey.keys()].map((key) => [key, new Set<string>()]));
  for (const item of eligiblePrepared) {
    const itemKey = capsuleKey(item.input);
    for (const conflictRef of item.input.capsule.conflicts_with) {
      const otherKey = capsuleRefKey(conflictRef);
      const other = preparedByKey.get(otherKey);
      if (!other || itemKey === otherKey) continue;
      conflictGraph.get(itemKey)?.add(otherKey);
      conflictGraph.get(otherKey)?.add(itemKey);
    }
  }
  const unresolvedAuthorityConflictIds = new Set<string>();
  for (const [itemKey, neighbors] of conflictGraph) {
    const item = preparedByKey.get(itemKey)!;
    for (const otherKey of neighbors) {
      if (compareCanonicalUtf8(itemKey, otherKey) >= 0) continue;
      const other = preparedByKey.get(otherKey)!;
      if (influenceBinding(item.input).admission_authority
        !== influenceBinding(other.input).admission_authority
        || item.surface !== "use_now" || other.surface !== "use_now") continue;
      const shared = item.coveredIds.filter((id) => other.coveredIds.includes(id)
        && obligationMap.get(id)?.kind !== "prohibition");
      if (shared.length === 0) continue;
      item.surface = "inspect_before_use";
      other.surface = "inspect_before_use";
      item.mandatory = true;
      other.mandatory = true;
      item.reasons.push("unresolved_equal_authority_conflict");
      other.reasons.push("unresolved_equal_authority_conflict");
      shared.forEach((id) => unresolvedAuthorityConflictIds.add(id));
    }
  }
  const conflictsSelected = (item: PreparedCandidate) => {
    const neighbors = conflictGraph.get(capsuleKey(item.input));
    return !!neighbors && [...neighbors].some((key) => selectedKeys.has(key));
  };
  for (const candidate of eligiblePrepared.filter((item) => item.mandatory)) {
    selected.push(candidate);
    selectedKeys.add(capsuleKey(candidate.input));
    renderCost += renderIncrement(candidate, selected.length - 1);
  }
  if (selected.length > policy.selected_capsule_limit) {
    throw new ContinuationCompilerSelectedCapsuleCapacityErrorV1(
      selected.length,
      policy.selected_capsule_limit,
    );
  }
  const covered = new Set(selected.flatMap((item) => item.coveredIds.filter((id) => {
    const obligation = obligationMap.get(id);
    return !!obligation && candidateCoversObligation(item, obligation);
  })));
  const selectPass = (requirement: ContinuationObligationV1["requirement"]) => {
    while (true) {
      const uncovered = new Set(obligations
        .filter((obligation) => obligation.requirement === requirement && !covered.has(obligation.obligation_id))
        .map((obligation) => obligation.obligation_id));
      const choices = eligiblePrepared.filter((item) => !item.mandatory && !selectedKeys.has(capsuleKey(item.input)))
        .map((item) => ({
          item,
          score: candidateBenefit(item, uncovered, obligationMap, args.policy, requirement, args.evaluated_at),
        }))
        .filter(({ item, score }) => score.marginal.length > 0
          && selected.length < policy.selected_capsule_limit
          && renderCost + renderIncrement(item, selected.length) <= args.render_budget
          && !conflictsSelected(item));
      choices.sort((left, right) => {
        const leftCost = renderIncrement(left.item, selected.length);
        const rightCost = renderIncrement(right.item, selected.length);
        const leftRatio = BigInt(left.score.benefit) * BigInt(rightCost);
        const rightRatio = BigInt(right.score.benefit) * BigInt(leftCost);
        if (leftRatio !== rightRatio) return leftRatio > rightRatio ? -1 : 1;
        const authorityDelta = authorityRank(
          influenceBinding(right.item.input).admission_authority,
        ) - authorityRank(influenceBinding(left.item.input).admission_authority);
        if (authorityDelta !== 0) return authorityDelta;
        const costDelta = leftCost - rightCost;
        return costDelta || compareCanonicalUtf8(
          left.item.input.capsule.capsule_sha256,
          right.item.input.capsule.capsule_sha256,
        );
      });
      const next = choices[0];
      if (!next) break;
      selected.push(next.item);
      selectedKeys.add(capsuleKey(next.item.input));
      renderCost += renderIncrement(next.item, selected.length - 1);
      next.item.coveredIds.forEach((id) => {
        const obligation = obligationMap.get(id);
        if (obligation && candidateCoversObligation(next.item, obligation)) covered.add(id);
      });
    }
  };
  selectPass("hard");
  const unresolvedHard = new Set(obligations
    .filter((obligation) => obligation.requirement === "hard" && !covered.has(obligation.obligation_id))
    .map((obligation) => obligation.obligation_id));
  const pathCovered = new Set(selected.flatMap((item) => item.coveredIds.filter((id) =>
    unresolvedHard.has(id) && item.surface !== "use_now"
  )));
  while (pathCovered.size < unresolvedHard.size) {
    const choices = eligiblePrepared
      .filter((item) => !selectedKeys.has(capsuleKey(item.input)) && item.surface !== "use_now")
      .map((item) => ({
        item,
        marginal: item.coveredIds.filter((id) => unresolvedHard.has(id) && !pathCovered.has(id)),
      }))
      .filter(({ item, marginal }) => marginal.length > 0
        && selected.length < policy.selected_capsule_limit
        && renderCost + renderIncrement(item, selected.length) <= args.render_budget
        && !conflictsSelected(item));
    choices.sort((left, right) => {
      const leftCost = renderIncrement(left.item, selected.length);
      const rightCost = renderIncrement(right.item, selected.length);
      const leftRatio = BigInt(left.marginal.length) * BigInt(rightCost);
      const rightRatio = BigInt(right.marginal.length) * BigInt(leftCost);
      if (leftRatio !== rightRatio) return leftRatio > rightRatio ? -1 : 1;
      const surfaceRank = (surface: SelectedCapsuleV1["surface"]) =>
        surface === "rehydrate" ? 2 : surface === "inspect_before_use" ? 1 : 0;
      const surfaceDelta = surfaceRank(right.item.surface) - surfaceRank(left.item.surface);
      if (surfaceDelta !== 0) return surfaceDelta;
      const authorityDelta = authorityRank(
        influenceBinding(right.item.input).admission_authority,
      ) - authorityRank(influenceBinding(left.item.input).admission_authority);
      if (authorityDelta !== 0) return authorityDelta;
      return compareCanonicalUtf8(
        left.item.input.capsule.capsule_sha256,
        right.item.input.capsule.capsule_sha256,
      );
    });
    const next = choices[0];
    if (!next) break;
    selected.push(next.item);
    selectedKeys.add(capsuleKey(next.item.input));
    renderCost += renderIncrement(next.item, selected.length - 1);
    next.marginal.forEach((id) => pathCovered.add(id));
  }
  selectPass("advisory");
  for (const item of eligiblePrepared) {
    if (selectedKeys.has(capsuleKey(item.input))) continue;
    excluded.push({
      capsule: capsuleRef(item.input.capsule),
      reason_codes: [renderCost + renderIncrement(item, selected.length) > args.render_budget
        ? "render_budget_exceeded" : "lower_marginal_coverage_or_conflict"],
    });
  }

  const selectedOutput: SelectedCapsuleV1[] = selected.map(selectedCapsuleOutput);
  selectedOutput.sort((left, right) => compareCanonicalUtf8(left.capsule.capsule_sha256, right.capsule.capsule_sha256));
  excluded.sort((left, right) => compareCanonicalUtf8(left.capsule.capsule_sha256, right.capsule.capsule_sha256));
  const selectedPartitionKeys = new Set(selectedOutput.map((item) => capsuleRefKey(item.capsule)));
  const excludedPartitionKeys = new Set(excluded.map((item) => capsuleRefKey(item.capsule)));
  if (selectedPartitionKeys.size !== selectedOutput.length
    || excludedPartitionKeys.size !== excluded.length
    || [...selectedPartitionKeys].some((key) => excludedPartitionKeys.has(key))
    || selectedOutput.length + excluded.length !== candidates.length
    || candidates.some((candidate) =>
      !selectedPartitionKeys.has(capsuleKey(candidate)) && !excludedPartitionKeys.has(capsuleKey(candidate)))) {
    throw new Error("continuation candidate partition is not total, unique, and disjoint");
  }
  const hasSelectedConflict = [...conflictGraph].some(([key, neighbors]) =>
    selectedKeys.has(key) && [...neighbors].some((neighbor) => selectedKeys.has(neighbor))
  );
  const coverage = obligations.map((obligation) => {
    const related = selected.filter((item) => item.coveredIds.includes(obligation.obligation_id));
    const covering = related.filter((item) => candidateCoversObligation(item, obligation));
    const conflicted = unresolvedAuthorityConflictIds.has(obligation.obligation_id)
      || (related.length > 0 && covering.length === 0);
    return {
      obligation_id: obligation.obligation_id,
      status: covering.length > 0 && !unresolvedAuthorityConflictIds.has(obligation.obligation_id)
        ? "covered" as const : conflicted ? "conflicted" as const : "uncovered" as const,
      capsule_refs: canonicalUniqueSet(
        related.map((item) => capsuleRef(item.input.capsule)),
        capsuleRefKey,
      ),
      satisfied_probe_ids: canonicalUniqueSet([...new Set(related.flatMap((item) => item.evaluations
        .filter((evaluation) => evaluation.status === "satisfied")
        .map((evaluation) => evaluation.probe_id)))], (id) => id),
      reason_codes: covering.length > 0 && !unresolvedAuthorityConflictIds.has(obligation.obligation_id)
        ? [] : conflicted ? ["obligation_conflicted"] : ["obligation_uncovered"],
    };
  });
  const hardComplete = coverage.every((item) => obligationMap.get(item.obligation_id)?.requirement !== "hard"
    || item.status === "covered");
  const directUseComplete = selected
    .filter((item) => item.surface === "use_now")
    .every((item) => item.evaluations.every((evaluation) => evaluation.status === "satisfied"));
  const budgetSatisfied = renderCost <= args.render_budget;
  const conflictFree = !hasSelectedConflict;
  const complete = hardComplete && directUseComplete && budgetSatisfied
    && conflictFree && rehydrationCapsuleRefs.length === 0;
  const unresolvedHardIds = new Set(coverage
    .filter((item) => obligationMap.get(item.obligation_id)?.requirement === "hard" && item.status !== "covered")
    .map((item) => item.obligation_id));
  const unresolvedPaths = selected.filter((item) =>
    item.coveredIds.some((id) => unresolvedHardIds.has(id))
  );
  const fallbackMode = complete ? "execute" as const
    : !budgetSatisfied || unresolvedPaths.some((item) => item.surface === "do_not_use") ? "block" as const
      : rehydrationCapsuleRefs.length > 0
        || unresolvedPaths.some((item) => item.surface === "rehydrate") ? "rehydrate" as const
        : hasSelectedConflict || unresolvedPaths.some((item) => item.surface === "inspect_before_use")
          ? "inspect" as const : "report_unresolved" as const;
  const reasonCodes = canonicalUniqueSet([
    ...(!hardComplete ? ["hard_obligation_incomplete"] : []),
    ...(!directUseComplete ? ["direct_use_precondition_incomplete"] : []),
    ...(!conflictFree ? ["capsule_conflict"] : []),
    ...(!budgetSatisfied ? ["hard_safety_exceeds_render_budget"] : []),
    ...(rehydrationCapsuleRefs.length > 0
      ? ["archived_content_rehydration_required"]
      : []),
  ], (reason) => reason);
  const candidatePartition = {
    selected_capsule_set_sha256: canonicalContinuationSha256(
      selectedOutput.map((item) => item.capsule),
    ),
    excluded_capsule_set_sha256: canonicalContinuationSha256(
      excluded.map((item) => item.capsule),
    ),
    selected_count: selectedOutput.length,
    excluded_count: excluded.length,
    candidate_count: candidates.length,
  };
  const selectedByRef = new Map(selected.map((item) => [
    capsuleKey(item.input),
    item,
  ] as const));
  const selectedMaterializations = selectedOutput.map((selection) => {
    const item = selectedByRef.get(capsuleRefKey(selection.capsule));
    if (!item) throw new Error("selected capsule materialization is missing");
    return { selection, capsule: item.input.capsule };
  });
  const evaluationBody = {
    schema_version: "continuation_selection_evaluation_v1" as const,
    fence: args.fence,
    obligations,
    selected_capsules: selectedOutput,
    excluded_capsules: excluded,
    coverage,
    candidate_partition: candidatePartition,
    hard_obligation_coverage_complete: hardComplete,
    direct_use_preconditions_complete: directUseComplete,
    conflict_free: conflictFree,
    budget_satisfied: budgetSatisfied,
    required_render_bytes: renderCost,
    status: complete ? "complete" as const : "incomplete" as const,
    reason_codes: reasonCodes,
    safe_fallback: {
      mode: fallbackMode,
      reason_codes: reasonCodes,
      unresolved_obligation_ids: coverage
        .filter((item) => item.status !== "covered")
        .map((item) => item.obligation_id),
      rehydration_capsule_refs: rehydrationCapsuleRefs,
    },
    render_plan: {
      projection_frame_bytes: args.projection_frame_bytes
        + continuationProjectionRehydrationRefsBytesV1(rehydrationCapsuleRefs),
      selected_capsules: selectedMaterializations,
      rehydration_capsule_refs: rehydrationCapsuleRefs,
    },
    obligation_universe_sha256: canonicalContinuationSha256(obligations),
    candidate_universe_sha256: canonicalContinuationSha256(candidates),
    selected_surface_sha256: canonicalContinuationSha256(selectedOutput),
    evaluated_at: args.evaluated_at,
  };
  return canonicalContinuationClone({
    ...evaluationBody,
    evaluation_sha256: canonicalContinuationSha256(evaluationBody),
  });
}
