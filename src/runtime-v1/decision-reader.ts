import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  compareCanonicalUtf8,
  type CanonicalJson,
  type CapsuleRefV1,
  type ContinuationContractV1,
  type Sha256,
} from "../continuation/contract.js";
import { verifyClosedContinuationExposureProjectionV1 } from
  "../continuation/contract-verifier.js";
import { continuationAuthorityRefKey } from
  "../continuation/compiler.js";
import {
  evaluateContinuationSelectionV1,
  type ContinuationSelectionEvaluationV1,
} from "../continuation/selection-evaluation.js";
import {
  retrieveContinuationCandidatesV1,
  type ContinuationCandidateRetrievalResultV1,
} from "../continuation/candidate-retrieval.js";
import type { ContinuationCompilerPolicyV1 } from
  "../continuation/compiler-policy.js";
import type { AuthorityBranchManifestV1 } from
  "../continuation/authority-branch.js";
import {
  episodeEventRefV1,
  type EpisodeEventRefV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import {
  continuationProjectionFrameBytesV1,
  type RenderedContinuationProjectionV1,
} from "../continuation/renderer.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "../store/continuation-runtime-v1-authority-artifact-reader.js";
import {
  assertContinuationRuntimeV1AuthorityStore,
} from "../store/continuation-runtime-v1-authority-store.js";
import type {
  AuthorityBranchRevisionRecordV1,
  ContinuationRuntimeV1AuthorityStore,
} from "../store/continuation-runtime-v1-authority-types.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import {
  assertContinuationRuntimeV1EffectCertificateReader,
  type ContinuationRuntimeV1EffectCertificateReader,
} from "../store/continuation-runtime-v1-effect-certificate-reader.js";
import type { PersistedEffectCertificateV1 } from
  "../store/continuation-runtime-v1-effect-certificate-types.js";
import type { ContinuationRuntimeV1EpisodeStore } from
  "../store/continuation-runtime-v1-episode-store.js";
import {
  assertContinuationRuntimeV1MemoryHistoryStore,
  continuationServingMemoryProjectionFromHistoricalV1,
  type HistoricalMemoryProjectionV1,
} from "../store/continuation-runtime-v1-memory-history.js";
import {
  assertContinuationRuntimeV1ObservationStore,
  type ContinuationRuntimeV1ObservationStore,
} from "../store/continuation-runtime-v1-observation-store.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
} from "../store/continuation-runtime-v1-policy-authority.js";
import { ContinuationRuntimeV1ApplicationError } from "./application.js";
import type { AuthenticatedDecisionQueryV1 } from "./command.js";
import {
  continuationRuntimeV1BranchRefFromManifest,
  materializeContinuationCandidatesV1,
} from "./continuation-candidate-materializer.js";

type MemoryHistoryStore = Readonly<{
  readHistoricalProjection(
    value: Readonly<{
      tenant_id: string;
      scope: string;
      task_family: string;
      memory_scope_head_revision: number;
      memory_scope_head_sha256: string;
    }>,
  ): Promise<HistoricalMemoryProjectionV1>;
}>;

export type ContinuationRuntimeV1DecisionReaderDependencies = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  episodeStore: ContinuationRuntimeV1EpisodeStore;
  observationStore: ContinuationRuntimeV1ObservationStore;
  memoryHistory: MemoryHistoryStore;
  authorityStore: ContinuationRuntimeV1AuthorityStore;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader;
}>;

export type ContinuationRuntimeV1DecisionReader = Readonly<{
  read(query: AuthenticatedDecisionQueryV1): Promise<CanonicalJson>;
}>;

type VerifiedExposure = Readonly<{
  event: EpisodeEventV1;
  contract: ContinuationContractV1;
  render_result: RenderedContinuationProjectionV1;
}>;

type EffectProjection = Readonly<{
  event_ref: EpisodeEventRefV1;
  certificate_id: string;
  certificate_sha256: Sha256;
  admission_state: "admitted" | "rejected";
  record: PersistedEffectCertificateV1;
}>;

const READERS = new WeakMap<object, ContinuationRuntimeV1DecisionReaderDependencies>();
const QUERY_KEYS = Object.freeze([
  "actor_kind",
  "actor_principal_sha256",
  "authority_subject_sha256",
  "body",
  "body_sha256",
  "decision_id",
  "query_sha256",
  "schema_version",
  "scope",
  "tenant_id",
] as const);
const QUERY_BODY_KEYS = Object.freeze([
  "exclude_capsule", "substitute_branch", "view",
] as const);

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_decision_reader_${code}`);
}

function requestError(status: 400 | 403 | 404 | 422, code: string): never {
  throw new ContinuationRuntimeV1ApplicationError(status, code);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  field: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    requestError(400, `${field}_invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if ((prototype !== Object.prototype && prototype !== null)
    || actual.some((key) => typeof key !== "string")
    || actual.length !== keys.length
    || actual.some((key) => !expected.has(key as string))) {
    requestError(400, `${field}_invalid`);
  }
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      requestError(400, `${field}_invalid`);
    }
  }
}

function verifyQuery(query: AuthenticatedDecisionQueryV1): void {
  exactKeys(query, QUERY_KEYS, "decision_query");
  exactKeys(query.body, QUERY_BODY_KEYS, "decision_query_body");
  if (query.schema_version !== "authenticated_decision_query_v1"
    || (query.actor_kind !== "trusted_host" && query.actor_kind !== "operator")
    || (query.body.view !== "summary"
      && query.body.view !== "full"
      && query.body.view !== "counterfactual")
    || canonicalContinuationSha256(query.body) !== query.body_sha256
    || canonicalSha256Without(query, "query_sha256") !== query.query_sha256) {
    requestError(400, "decision_query_invalid");
  }
  for (const [value, field] of [
    [query.actor_principal_sha256, "actor_principal_sha256"],
    [query.authority_subject_sha256, "authority_subject_sha256"],
    [query.body_sha256, "body_sha256"],
    [query.query_sha256, "query_sha256"],
  ] as const) {
    try {
      assertSha256(value, field);
    } catch {
      requestError(400, "decision_query_invalid");
    }
  }
  if (query.body.view !== "counterfactual"
    && (query.body.exclude_capsule !== null
      || query.body.substitute_branch !== null)) {
    requestError(400, "decision_query_invalid");
  }
  if (query.body.view === "counterfactual" && query.actor_kind !== "operator") {
    requestError(403, "forbidden");
  }
}

function response<T extends Readonly<Record<string, unknown>>>(body: T): CanonicalJson {
  const value = canonicalContinuationClone({
    ...body,
    response_sha256: canonicalContinuationSha256(body),
  });
  return value as unknown as CanonicalJson;
}

function exactExposure(events: readonly EpisodeEventV1[]): VerifiedExposure {
  const exposures = events.filter((event) => event.event_kind === "contract_exposed");
  if (exposures.length !== 1) fail("corrupt_exposure_cardinality");
  const event = exposures[0]!;
  if (event.payload.payload_kind !== "contract_exposed_v1") {
    fail("corrupt_exposure_payload");
  }
  const verified = verifyClosedContinuationExposureProjectionV1({
    contract: event.payload.continuation_contract,
    renderResult: event.payload.render_result,
  });
  if (verified.contract.identity.decision_id !== event.context.decision_id
    || verified.contract.contract_sha256 !== event.context.contract_sha256
    || verified.renderResult.render_result_sha256 !== event.render_result_sha256) {
    fail("corrupt_exposure_binding");
  }
  return {
    event,
    contract: verified.contract,
    render_result: verified.renderResult,
  };
}

function authorize(
  query: AuthenticatedDecisionQueryV1,
  exposure: VerifiedExposure,
): void {
  const contract = exposure.contract;
  if (contract.identity.decision_id !== query.decision_id
    || contract.identity.tenant_id !== query.tenant_id
    || contract.identity.scope !== query.scope
    || contract.authority.authority_subject_sha256
      !== query.authority_subject_sha256) {
    requestError(404, "decision_not_found");
  }
  if (query.actor_kind === "trusted_host"
    && contract.identity.collection_principal_sha256
      !== query.actor_principal_sha256) {
    requestError(404, "decision_not_found");
  }
}

function sameBranch(
  manifest: AuthorityBranchManifestV1,
  ref: ContinuationContractV1["authority"]["served_learning_branch"],
): boolean {
  return manifest.branch_id === ref.branch_id
    && manifest.branch_revision === ref.branch_revision
    && manifest.manifest_sha256 === ref.manifest_sha256;
}

function basicBranchRef(manifest: AuthorityBranchManifestV1) {
  return canonicalContinuationClone({
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
  });
}

async function readExactBranch(
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
  tenantId: string,
  subject: Sha256,
  ref: ContinuationContractV1["authority"]["served_learning_branch"],
): Promise<AuthorityBranchRevisionRecordV1> {
  const record = await dependencies.authorityStore.readRevision({
    tenant_id: tenantId,
    authority_subject_sha256: subject,
    branch_id: ref.branch_id,
    branch_revision: ref.branch_revision,
  });
  if (!record || !sameBranch(record.manifest, ref)) {
    fail("corrupt_authority_revision_missing");
  }
  return record;
}

function outcomeProjection(events: readonly EpisodeEventV1[]) {
  const uses = events.filter((event) => event.event_kind === "capsule_use_observed");
  const outcomes = events.filter((event) => event.event_kind === "outcome_observed");
  if (uses.length > 1 || outcomes.length > 1
    || (outcomes.length === 1 && uses.length !== 1)) {
    fail("corrupt_outcome_cardinality");
  }
  return canonicalContinuationClone({
    state: outcomes.length === 1
      ? "outcome_observed" as const
      : uses.length === 1
        ? "use_observed" as const
        : "not_observed" as const,
    use_event_ref: uses.length === 1 ? episodeEventRefV1(uses[0]!) : null,
    outcome_event_ref: outcomes.length === 1
      ? episodeEventRefV1(outcomes[0]!)
      : null,
  });
}

async function effectProjection(
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
  exposure: VerifiedExposure,
  events: readonly EpisodeEventV1[],
): Promise<Readonly<{
  state: "not_applicable" | "pending" | "admitted" | "rejected";
  certificates: readonly EffectProjection[];
}>> {
  const effectEvents = events.filter((event) => event.event_kind === "effect_certified");
  if (exposure.contract.authority.experiment_cohort_ref === null) {
    if (effectEvents.length !== 0) fail("corrupt_unassigned_effect_event");
    return { state: "not_applicable", certificates: [] };
  }
  if (effectEvents.length === 0) return { state: "pending", certificates: [] };
  const certificateShas = canonicalUniqueSet(
    effectEvents.map((event) => {
      if (event.effect_certificate_sha256 === null
        || event.payload.payload_kind !== "effect_certified_v1"
        || event.payload.evidence_member.decision_id
          !== exposure.contract.identity.decision_id) {
        fail("corrupt_effect_event");
      }
      return event.effect_certificate_sha256;
    }),
    (value) => value,
  );
  if (certificateShas.length !== 1) fail("corrupt_effect_certificate_cardinality");
  const persisted = await dependencies.effectCertificateReader.read({
    tenant_id: exposure.contract.identity.tenant_id,
    certificate_sha256: certificateShas[0]!,
  });
  if (!persisted) fail("corrupt_effect_certificate_missing");
  const certificate = persisted.record.signed_certificate;
  if (certificate.authority_subject_sha256
      !== exposure.contract.authority.authority_subject_sha256
    || (certificate.admission_state !== "admitted"
      && certificate.admission_state !== "rejected")) {
    fail("corrupt_effect_certificate_binding");
  }
  const event = effectEvents.find((item) =>
    item.effect_certificate_sha256 === certificate.certificate_sha256);
  if (!event) fail("corrupt_effect_event_missing");
  return canonicalContinuationClone({
    state: certificate.admission_state,
    certificates: [{
      event_ref: episodeEventRefV1(event),
      certificate_id: certificate.certificate_id,
      certificate_sha256: certificate.certificate_sha256,
      admission_state: certificate.admission_state,
      record: persisted.record,
    }],
  });
}

function decisionSummary(
  query: AuthenticatedDecisionQueryV1,
  exposure: VerifiedExposure,
  events: readonly EpisodeEventV1[],
  effect: Awaited<ReturnType<typeof effectProjection>>,
) {
  const contract = exposure.contract;
  return canonicalContinuationClone({
    schema_version: "continuation_decision_summary_v1" as const,
    query_sha256: query.query_sha256,
    decision_id: contract.identity.decision_id,
    episode_id: contract.identity.episode_id,
    run_id: contract.identity.run_id,
    task_identity: contract.identity,
    authority: contract.authority,
    contract_sha256: contract.contract_sha256,
    coverage_certificate_sha256:
      contract.coverage_certificate.certificate_sha256,
    exposure_event_ref: episodeEventRefV1(exposure.event),
    selected_capsules: contract.selected_capsules,
    excluded_capsules: contract.excluded_capsules,
    coverage_status: contract.coverage_certificate.status,
    safe_fallback: contract.safe_fallback,
    render: {
      status: exposure.render_result.status,
      render_result_sha256: exposure.render_result.render_result_sha256,
      projection_sha256: exposure.render_result.projection_sha256,
      required_bytes: exposure.render_result.required_bytes,
      budget_bytes: exposure.render_result.budget_bytes,
    },
    outcome: outcomeProjection(events),
    effect: {
      state: effect.state,
      certificate_refs: effect.certificates.map((item) => ({
        event_ref: item.event_ref,
        certificate_id: item.certificate_id,
        certificate_sha256: item.certificate_sha256,
        admission_state: item.admission_state,
      })),
    },
  });
}

function capsuleRefKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision}\0${ref.capsule_sha256}`;
}

function selectionDiff(
  contract: ContinuationContractV1,
  evaluation: ContinuationSelectionEvaluationV1,
) {
  const originalSelected = new Map(contract.selected_capsules.map((item) => [
    capsuleRefKey(item.capsule), item,
  ] as const));
  const hypotheticalSelected = new Map(evaluation.selected_capsules.map((item) => [
    capsuleRefKey(item.capsule), item,
  ] as const));
  const originalCoverage = new Map(contract.coverage_certificate.coverage.map((item) => [
    item.obligation_id, item,
  ] as const));
  const hypotheticalCoverage = new Map(evaluation.coverage.map((item) => [
    item.obligation_id, item,
  ] as const));
  const added = [...hypotheticalSelected]
    .filter(([key]) => !originalSelected.has(key))
    .map(([, value]) => value);
  const removed = [...originalSelected]
    .filter(([key]) => !hypotheticalSelected.has(key))
    .map(([, value]) => value);
  const changed = [...hypotheticalSelected].flatMap(([key, value]) => {
    const original = originalSelected.get(key);
    return original && canonicalContinuationJson(original)
      !== canonicalContinuationJson(value)
      ? [{ capsule: value.capsule, before: original, after: value }]
      : [];
  });
  const coverageChanges = [...hypotheticalCoverage].flatMap(([id, value]) => {
    const original = originalCoverage.get(id);
    return original && canonicalContinuationJson(original)
      !== canonicalContinuationJson(value)
      ? [{ obligation_id: id, before: original, after: value }]
      : [];
  });
  const byDigest = <T extends { capsule: CapsuleRefV1 }>(left: T, right: T) =>
    compareCanonicalUtf8(capsuleRefKey(left.capsule), capsuleRefKey(right.capsule));
  return canonicalContinuationClone({
    selected_added: added.sort(byDigest),
    selected_removed: removed.sort(byDigest),
    selected_changed: changed.sort(byDigest),
    coverage_changed: coverageChanges.sort((left, right) =>
      compareCanonicalUtf8(left.obligation_id, right.obligation_id)),
    safe_fallback_before: contract.safe_fallback,
    safe_fallback_after: {
      mode: evaluation.safe_fallback.mode,
      reason_codes: evaluation.safe_fallback.reason_codes,
      unresolved_obligation_ids:
        evaluation.safe_fallback.unresolved_obligation_ids,
      rehydration_capsule_refs:
        evaluation.safe_fallback.rehydration_capsule_refs,
    },
    required_render_bytes_before:
      contract.coverage_certificate.required_render_bytes,
    required_render_bytes_after: evaluation.required_render_bytes,
  });
}

function counterfactualProjection(
  contract: ContinuationContractV1,
  evaluation: ContinuationSelectionEvaluationV1,
) {
  const body = canonicalContinuationClone({
    schema_version: "counterfactual_continuation_projection_v1" as const,
    counterfactual_only: true as const,
    executable_authority: false as const,
    source_contract_sha256: contract.contract_sha256,
    identity: contract.identity,
    fence: evaluation.fence,
    obligations: evaluation.obligations,
    selected_capsules: evaluation.render_plan.selected_capsules.map((item) => ({
      capsule: item.selection.capsule,
      surface: item.selection.surface,
      coverage_bindings: item.selection.coverage_bindings,
      satisfied_probe_ids: item.selection.satisfied_probe_ids,
      projection: item.capsule.projection,
    })),
    rehydration_capsule_refs:
      evaluation.safe_fallback.rehydration_capsule_refs,
    safe_fallback: evaluation.safe_fallback,
  });
  const content = canonicalContinuationJson(body);
  const requiredBytes = Buffer.byteLength(content, "utf8");
  const budgetBytes = contract.compiler.render_budget;
  return canonicalContinuationClone(requiredBytes <= budgetBytes ? {
    status: "rendered" as const,
    projection: body,
    projection_sha256: canonicalContinuationSha256(body),
    required_bytes: requiredBytes,
    budget_bytes: budgetBytes,
  } : {
    status: "not_renderable" as const,
    projection: null,
    projection_sha256: null,
    required_bytes: requiredBytes,
    budget_bytes: budgetBytes,
  });
}

type HistoricalCandidateReplayV1 = Readonly<{
  authoritative: AuthorityBranchRevisionRecordV1;
  served: AuthorityBranchRevisionRecordV1;
  compiler_policy: ContinuationCompilerPolicyV1;
  memory_projection: HistoricalMemoryProjectionV1;
  retrieval: Extract<ContinuationCandidateRetrievalResultV1, { status: "selected" }>;
}>;

async function replayOriginalCandidateRetrieval(
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
  exposure: VerifiedExposure,
): Promise<HistoricalCandidateReplayV1> {
  const contract = exposure.contract;
  const authority = contract.authority;
  const subject = authority.authority_subject_sha256;
  const served = await readExactBranch(
    dependencies,
    contract.identity.tenant_id,
    subject,
    authority.served_learning_branch,
  );
  const authoritative = await readExactBranch(
    dependencies,
    contract.identity.tenant_id,
    subject,
    authority.authoritative_learning_head,
  );
  const compilerCapability = await dependencies.policyAuthority.resolveExact({
    tenant_id: contract.identity.tenant_id,
    authority_subject_sha256: subject,
    artifact_kind: "compiler_policy",
    artifact_ref: authority.compiler_policy_ref,
    at: contract.compiler.compiled_at,
  });
  if (canonicalContinuationJson(dependencies.policyAuthority.ref(compilerCapability))
      !== canonicalContinuationJson(authority.compiler_policy_ref)) {
    fail("corrupt_policy_resolution");
  }
  const compilerPolicy = dependencies.policyAuthority.payload(compilerCapability);
  const memoryProjection = await dependencies.memoryHistory.readHistoricalProjection({
    tenant_id: contract.identity.tenant_id,
    scope: contract.identity.scope,
    task_family: contract.identity.task_family,
    memory_scope_head_revision: authority.memory_scope_head_revision,
    memory_scope_head_sha256: authority.memory_scope_head_sha256,
  });
  const source = materializeContinuationCandidatesV1({
    scope: contract.identity.scope,
    served_manifest: served.manifest,
    memory_projection:
      continuationServingMemoryProjectionFromHistoricalV1(memoryProjection),
    evaluated_at: contract.compiler.compiled_at,
  });
  const retrieval = retrieveContinuationCandidatesV1({
    schema_version: "continuation_candidate_retrieval_input_v1",
    identity: contract.identity,
    obligations: contract.obligations,
    candidates: source,
    evaluated_at: contract.compiler.compiled_at,
    policy: compilerPolicy,
  });
  if (retrieval.status !== "selected"
    || canonicalContinuationJson(retrieval.receipt)
      !== canonicalContinuationJson(contract.compiler.candidate_retrieval_receipt)) {
    fail("corrupt_candidate_retrieval_replay");
  }
  return {
    authoritative,
    served,
    compiler_policy: compilerPolicy,
    memory_projection: memoryProjection,
    retrieval,
  };
}

async function counterfactual(
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
  query: AuthenticatedDecisionQueryV1,
  exposure: VerifiedExposure,
  originalReplay: HistoricalCandidateReplayV1,
) {
  const contract = exposure.contract;
  const authority = contract.authority;
  const subject = authority.authority_subject_sha256;
  const originalServed = originalReplay.served;

  let evaluatedBranch = originalServed;
  const substitute = query.body.substitute_branch;
  const substituteIsOriginal = substitute !== null
    && continuationAuthorityRefKey(substitute)
      === continuationAuthorityRefKey(authority.served_learning_branch);
  if (substitute !== null && !substituteIsOriginal) {
    const latest = await dependencies.authorityStore.readLatestRevision({
      tenant_id: query.tenant_id,
      authority_subject_sha256: subject,
      branch_id: substitute.branch_id,
    });
    if (!latest || !sameBranch(latest.manifest, substitute)
      || latest.manifest.branch_kind !== "candidate"
      || (latest.manifest.state !== "eligible"
        && latest.manifest.state !== "active_candidate")
      || latest.manifest.tenant_id !== query.tenant_id
      || latest.manifest.authority_subject_sha256 !== subject
      || latest.manifest.base_authoritative_ref === null
      || continuationAuthorityRefKey(latest.manifest.base_authoritative_ref)
        !== continuationAuthorityRefKey(authority.authoritative_learning_head)
      || canonicalContinuationJson(latest.manifest.compiler_policy_ref)
        !== canonicalContinuationJson(authority.compiler_policy_ref)
      || canonicalContinuationJson(latest.manifest.evidence_policy_ref)
        !== canonicalContinuationJson(authority.evidence_policy_ref)
      || latest.manifest.created_at > contract.compiler.compiled_at) {
      requestError(422, "counterfactual_branch_not_serviceable");
    }
    evaluatedBranch = latest;
  }

  const evidenceCapability = await dependencies.policyAuthority.resolveExact({
    tenant_id: query.tenant_id,
    authority_subject_sha256: subject,
    artifact_kind: "evidence_policy",
    artifact_ref: authority.evidence_policy_ref,
    at: contract.compiler.compiled_at,
  });
  if (canonicalContinuationJson(dependencies.policyAuthority.ref(evidenceCapability))
      !== canonicalContinuationJson(authority.evidence_policy_ref)) {
    fail("corrupt_policy_resolution");
  }
  const snapshot = await dependencies.observationStore.read({
    tenant_id: query.tenant_id,
    scope: query.scope,
    world_snapshot_id: contract.identity.world_snapshot_id,
  });
  if (!snapshot
    || snapshot.snapshot.world_snapshot_sha256
      !== contract.identity.world_snapshot_sha256) {
    fail("corrupt_world_snapshot_missing");
  }
  const memoryProjection = originalReplay.memory_projection;
  let retrieval = originalReplay.retrieval;
  if (evaluatedBranch !== originalServed) {
    const source = materializeContinuationCandidatesV1({
      scope: query.scope,
      served_manifest: evaluatedBranch.manifest,
      memory_projection:
        continuationServingMemoryProjectionFromHistoricalV1(memoryProjection),
      evaluated_at: contract.compiler.compiled_at,
    });
    const hypothetical = retrieveContinuationCandidatesV1({
      schema_version: "continuation_candidate_retrieval_input_v1",
      identity: contract.identity,
      obligations: contract.obligations,
      candidates: source,
      evaluated_at: contract.compiler.compiled_at,
      policy: originalReplay.compiler_policy,
    });
    if (hypothetical.status !== "selected") {
      requestError(422, "counterfactual_candidate_policy_capacity_exceeded");
    }
    const originalReceipt = originalReplay.retrieval.receipt;
    if (canonicalContinuationJson(
      hypothetical.receipt.source_universe.verified_continuity,
    ) !== canonicalContinuationJson(
      originalReceipt.source_universe.verified_continuity,
    ) || canonicalContinuationJson(
      hypothetical.receipt.selected.verified_continuity,
    ) !== canonicalContinuationJson(
      originalReceipt.selected.verified_continuity,
    )) {
      fail("counterfactual_continuity_universe_drift");
    }
    retrieval = hypothetical;
  }
  const candidates = retrieval.candidates;
  let evaluation: ContinuationSelectionEvaluationV1;
  try {
    evaluation = evaluateContinuationSelectionV1({
      schema_version: "continuation_selection_input_v1",
      identity: contract.identity,
      fence: {
        authority_subject_sha256: subject,
        evaluated_learning_branch: basicBranchRef(evaluatedBranch.manifest),
        memory_scope_head_revision: authority.memory_scope_head_revision,
        memory_scope_head_sha256: authority.memory_scope_head_sha256,
        compiler_policy_payload_sha256:
          authority.compiler_policy_ref.payload_sha256,
      },
      obligations: contract.obligations,
      candidates,
      observation_snapshot: snapshot.snapshot,
      evaluated_at: contract.compiler.compiled_at,
      render_budget: contract.compiler.render_budget,
      projection_frame_bytes: continuationProjectionFrameBytesV1({
        identity: contract.identity,
        authority,
        obligations: contract.obligations,
        rehydration_capsule_refs: [],
      }),
      forced_excluded_capsule_refs: query.body.exclude_capsule === null
        ? []
        : [query.body.exclude_capsule],
      policy: originalReplay.compiler_policy,
    });
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1ApplicationError) throw error;
    if (error instanceof Error
      && error.message.includes("forced excluded capsule refs")) {
      requestError(422, "counterfactual_capsule_not_found");
    }
    throw error;
  }
  return canonicalContinuationClone({
    schema_version: "continuation_decision_counterfactual_v1" as const,
    counterfactual_only: true as const,
    executable_authority: false as const,
    query_sha256: query.query_sha256,
    decision_id: contract.identity.decision_id,
    source_contract_sha256: contract.contract_sha256,
    candidate_retrieval_receipt: retrieval.receipt,
    hypothesis: {
      exclude_capsule: query.body.exclude_capsule,
      substitute_branch: substitute,
      evaluated_learning_branch:
        continuationRuntimeV1BranchRefFromManifest(evaluatedBranch.manifest),
      continuity_memory_fence: {
        memory_scope_head_revision: authority.memory_scope_head_revision,
        memory_scope_head_sha256: authority.memory_scope_head_sha256,
        historical_projection_sha256: memoryProjection.projection_sha256,
      },
      compiled_at: contract.compiler.compiled_at,
      compiler_policy_ref: authority.compiler_policy_ref,
      evidence_policy_ref: authority.evidence_policy_ref,
    },
    selection: {
      selected_capsules: evaluation.selected_capsules,
      excluded_capsules: evaluation.excluded_capsules,
      coverage: evaluation.coverage,
      status: evaluation.status,
      safe_fallback: evaluation.safe_fallback,
      required_render_bytes: evaluation.required_render_bytes,
      evaluation_sha256: evaluation.evaluation_sha256,
    },
    diff: selectionDiff(contract, evaluation),
    render_projection: counterfactualProjection(contract, evaluation),
  });
}

function validateDependencies(
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
): void {
  assertContinuationRuntimeV1AuthorityArtifactReader(
    dependencies.artifactStore,
    dependencies.database,
  );
  assertContinuationRuntimeV1PolicyAuthority(
    dependencies.policyAuthority,
    dependencies.database,
    dependencies.artifactStore,
  );
  assertContinuationRuntimeV1EffectCertificateReader(
    dependencies.effectCertificateReader,
    dependencies.database,
    dependencies.artifactStore,
    dependencies.policyAuthority,
  );
  assertContinuationRuntimeV1AuthorityStore(
    dependencies.authorityStore,
    dependencies.database,
    dependencies.artifactStore,
    dependencies.policyAuthority,
    dependencies.effectCertificateReader,
  );
  assertContinuationRuntimeV1ObservationStore(
    dependencies.observationStore,
    dependencies.database,
  );
  assertContinuationRuntimeV1MemoryHistoryStore(
    dependencies.memoryHistory,
    dependencies.database,
  );
  for (const method of ["readDecision"] as const) {
    if (!dependencies.episodeStore
      || typeof dependencies.episodeStore[method] !== "function") {
      fail("episode_store_invalid");
    }
  }
}

export function assertContinuationRuntimeV1DecisionReader(
  value: unknown,
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
): asserts value is ContinuationRuntimeV1DecisionReader {
  validateDependencies(dependencies);
  if (value === null || typeof value !== "object"
    || READERS.get(value) !== dependencies) fail("service_invalid");
}

export function createContinuationRuntimeV1DecisionReader(
  dependencies: ContinuationRuntimeV1DecisionReaderDependencies,
): ContinuationRuntimeV1DecisionReader {
  validateDependencies(dependencies);
  const reader: ContinuationRuntimeV1DecisionReader = Object.freeze({
    async read(query) {
      verifyQuery(query);
      const events = await dependencies.episodeStore.readDecision(
        query.tenant_id,
        query.scope,
        query.decision_id,
      );
      if (events.length === 0) requestError(404, "decision_not_found");
      const exposure = exactExposure(events);
      authorize(query, exposure);
      const originalReplay = await replayOriginalCandidateRetrieval(
        dependencies,
        exposure,
      );
      const effect = await effectProjection(
        dependencies,
        exposure,
        events,
      );
      const summary = decisionSummary(query, exposure, events, effect);
      if (query.body.view === "summary") return response(summary);
      if (query.body.view === "full") {
        // Full is an authenticated historical audit view. It intentionally
        // returns the immutable exposure served at the time, even if source
        // memory is later logically archived. It is not a current serve path.
        return response({
          schema_version: "continuation_decision_full_v1" as const,
          query_sha256: query.query_sha256,
          summary,
          continuation_contract: exposure.contract,
          render_result: exposure.render_result,
          events,
          authority_revisions: {
            authoritative: originalReplay.authoritative,
            served: originalReplay.served,
          },
          effect_certificates: effect.certificates.map((item) => item.record),
        });
      }
      const projection = await counterfactual(
        dependencies,
        query,
        exposure,
        originalReplay,
      );
      return response(projection);
    },
  });
  READERS.set(reader, dependencies);
  return reader;
}
