import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  compareCanonicalUtf8,
  type CapsuleRefV1,
  type ContinuationContractV1,
} from "./contract.js";
import { continuationCompilerAlgorithmContractSha256 } from "./compiler.js";
import {
  CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1,
  verifyContinuationCandidateRetrievalReceiptV1,
  type ContinuationCandidateRetrievalReceiptV1,
} from "./candidate-retrieval.js";
import {
  CONTINUATION_PROJECTION_FORMAT_V1,
  verifyRenderedContinuationProjectionV1,
} from "./renderer.js";
import { continuationAuthoritySubjectSha256V1 } from "./task-envelope.js";

const ROOT_KEYS = Object.freeze([
  "authority", "compiler", "contract_sha256", "coverage_certificate",
  "excluded_capsules", "identity", "obligations", "safe_fallback",
  "schema_version", "selected_capsules",
] as const);
const IDENTITY_KEYS = Object.freeze([
  "collection_principal_sha256", "consumer_agent_id", "consumer_team_id",
  "decision_id", "episode_id", "host_task_envelope_sha256", "host_task_id",
  "run_id", "scope", "source_event_sha256", "source_task_sha256",
  "task_family", "task_signature", "tenant_id", "workflow_signature",
  "workspace_signature", "world_snapshot_id", "world_snapshot_sha256",
] as const);
const AUTHORITY_KEYS = Object.freeze([
  "authoritative_learning_head", "authority_subject_sha256", "compiler_policy_ref",
  "evidence_policy_ref", "memory_scope_head_revision",
  "memory_scope_head_sha256", "experiment_cohort_ref",
  "served_learning_branch", "serving_assignment_receipt", "serving_mode",
] as const);
const BRANCH_REF_KEYS = Object.freeze([
  "branch_id", "branch_revision", "manifest_sha256",
] as const);
const ARTIFACT_REF_KEYS = Object.freeze([
  "artifact_sha256", "payload_sha256",
] as const);
const BRANCH_REVISION_REF_KEYS = Object.freeze([
  "branch_id", "branch_kind", "branch_revision", "manifest_sha256", "state",
] as const);
const ASSIGNMENT_RECEIPT_KEYS = Object.freeze([
  "arm", "assigned_at", "assignment_basis", "assignment_basis_sha256",
  "assignment_draw_sha256", "authority_subject_sha256",
  "candidate_learning_ref", "cohort_id", "compiler_policy_ref",
  "control_learning_ref", "evidence_policy_ref", "experiment_cohort_ref",
  "schema_version", "scope", "served_learning_ref",
  "serving_assignment_receipt_sha256", "tenant_id",
] as const);
const ASSIGNMENT_BASIS_KEYS = Object.freeze([
  "create_continuation_operation_id", "decision_id", "episode_id",
  "experiment_cohort_ref", "host_principal_sha256",
  "host_task_envelope_sha256", "host_task_id", "memory_scope_head_ref",
  "operation_request_sha256", "run_id", "schema_version",
  "source_task_sha256", "task_family", "world_snapshot_ref",
] as const);
const OBLIGATION_KEYS = Object.freeze([
  "evidence_requirement", "kind", "obligation_id", "required_probe_ids",
  "requirement", "source_refs", "statement", "target_refs",
] as const);
const TARGET_REF_KEYS = Object.freeze(["kind", "ref"] as const);
const CAPSULE_REF_KEYS = Object.freeze([
  "capsule_id", "capsule_revision", "capsule_sha256",
] as const);
const SELECTED_KEYS = Object.freeze([
  "capsule", "coverage_bindings", "satisfied_probe_ids",
  "selection_reason_codes", "surface",
] as const);
const COVERAGE_BINDING_KEYS = Object.freeze([
  "coverage_claim_sha256", "obligation_id",
] as const);
const EXCLUDED_KEYS = Object.freeze(["capsule", "reason_codes"] as const);
const CERTIFICATE_KEYS = Object.freeze([
  "budget_satisfied", "candidate_partition", "candidate_universe_sha256",
  "certificate_sha256", "certificate_version", "compilation_input_sha256",
  "conflict_free", "coverage", "direct_use_preconditions_complete",
  "hard_obligation_coverage_complete", "obligation_universe_sha256",
  "reason_codes", "required_render_bytes", "selected_surface_sha256",
  "status", "world_snapshot_sha256",
] as const);
const COVERAGE_KEYS = Object.freeze([
  "capsule_refs", "obligation_id", "reason_codes", "satisfied_probe_ids",
  "status",
] as const);
const PARTITION_KEYS = Object.freeze([
  "candidate_count", "excluded_capsule_set_sha256", "excluded_count",
  "selected_capsule_set_sha256", "selected_count",
] as const);
const FALLBACK_KEYS = Object.freeze([
  "mode", "reason_codes", "unresolved_obligation_ids",
] as const);
const COMPILER_KEYS = Object.freeze([
  "algorithm", "algorithm_contract_sha256", "candidate_limit",
  "candidate_retrieval_receipt", "compiled_at", "continuity_candidate_limit",
  "learning_candidate_limit", "obligation_limit", "render_budget", "selected_capsule_limit",
] as const);
const PROJECTION_KEYS = Object.freeze([
  "authority", "contract_sha256", "coverage_certificate_sha256", "format",
  "identity", "obligations", "rehydration_capsule_refs",
  "safe_fallback_code", "schema_version", "selected_capsules",
] as const);
const PROJECTION_SELECTION_KEYS = Object.freeze([
  "capsule", "coverage_bindings", "projection", "satisfied_probe_ids", "surface",
] as const);
const CAPSULE_PROJECTION_KEYS = Object.freeze([
  "acceptance_statements", "next_action", "projection_sha256", "summary",
  "target_refs", "workflow_steps",
] as const);

type Row = Readonly<Record<string, unknown>>;

function fail(message: string): never {
  throw new Error(`continuation_contract_v1_invalid:${message}`);
}

function record(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_shape`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.some((key) => typeof key !== "string")
    || ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => !expected.has(key as string))) fail(`${field}_shape`);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function array(value: unknown, maximum: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) fail(`${field}_shape`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) fail(`${field}_shape`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string") fail(field);
  assertUnicodeScalarString(value, field);
  if (!value || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(field);
  return value;
}

function nullableText(value: unknown, field: string, maximum = 256): string | null {
  return value === null ? null : text(value, field, maximum);
}

function sha(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field);
  try {
    assertSha256(value, field);
  } catch {
    fail(field);
  }
  return value;
}

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum) fail(field);
  return value as number;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(field);
  return value as T;
}

function canonicalStrings(
  value: unknown,
  maximum: number,
  field: string,
  allowEmpty = true,
): readonly string[] {
  const values = array(value, maximum, field).map((item, index) =>
    text(item, `${field}_${index}`)
  );
  if ((!allowEmpty && values.length === 0)
    || values.some((item, index) => index > 0
      && compareCanonicalUtf8(values[index - 1]!, item) >= 0)) fail(`${field}_canonical`);
  return values;
}

function capsuleRef(value: unknown, field: string): CapsuleRefV1 {
  const ref = record(value, CAPSULE_REF_KEYS, field);
  return {
    capsule_id: text(ref.capsule_id, `${field}_id`),
    capsule_revision: integer(ref.capsule_revision, `${field}_revision`, 1),
    capsule_sha256: sha(ref.capsule_sha256, `${field}_sha256`),
  };
}

function capsuleKey(value: CapsuleRefV1): string {
  return canonicalContinuationJson(value);
}

function branchRef(value: unknown, field: string): Row {
  const ref = record(value, BRANCH_REF_KEYS, field);
  text(ref.branch_id, `${field}_id`);
  integer(ref.branch_revision, `${field}_revision`, 1);
  sha(ref.manifest_sha256, `${field}_sha256`);
  return ref;
}

function artifactRef(value: unknown, field: string): Row {
  const ref = record(value, ARTIFACT_REF_KEYS, field);
  sha(ref.artifact_sha256, `${field}_artifact_sha256`);
  sha(ref.payload_sha256, `${field}_payload_sha256`);
  return ref;
}

function branchRevisionRef(value: unknown, field: string): Row {
  const ref = record(value, BRANCH_REVISION_REF_KEYS, field);
  branchRef({
    branch_id: ref.branch_id,
    branch_revision: ref.branch_revision,
    manifest_sha256: ref.manifest_sha256,
  }, field);
  const kind = oneOf(
    ref.branch_kind,
    ["authoritative", "candidate"] as const,
    `${field}_kind`,
  );
  const state = oneOf(
    ref.state,
    ["authoritative", "active_candidate"] as const,
    `${field}_state`,
  );
  if ((kind === "authoritative" && state !== "authoritative")
    || (kind === "candidate" && state !== "active_candidate")) {
    fail(`${field}_kind_state`);
  }
  return ref;
}

function parseServingAssignmentReceipt(
  value: unknown,
  identity: Row,
  expected: Readonly<{
    subject: string;
    head: Row;
    served: Row;
    cohort: Row;
    compiler: Row;
    evidence: Row;
    memoryRevision: number;
    memorySha256: string;
    mode: "assigned_control" | "assigned_candidate";
  }>,
): Row {
  const receipt = record(value, ASSIGNMENT_RECEIPT_KEYS, "serving_assignment_receipt");
  if (receipt.schema_version !== "serving_assignment_receipt_v1") {
    fail("serving_assignment_receipt_schema");
  }
  text(receipt.tenant_id, "assignment_tenant_id");
  text(receipt.scope, "assignment_scope");
  text(receipt.cohort_id, "assignment_cohort_id");
  sha(receipt.authority_subject_sha256, "assignment_subject");
  const cohort = artifactRef(receipt.experiment_cohort_ref, "assignment_cohort_ref");
  const control = branchRevisionRef(receipt.control_learning_ref, "assignment_control_ref");
  const candidate = branchRevisionRef(
    receipt.candidate_learning_ref,
    "assignment_candidate_ref",
  );
  const served = branchRevisionRef(receipt.served_learning_ref, "assignment_served_ref");
  const compiler = artifactRef(receipt.compiler_policy_ref, "assignment_compiler_ref");
  const evidence = artifactRef(receipt.evidence_policy_ref, "assignment_evidence_ref");
  const arm = oneOf(receipt.arm, ["control", "candidate"] as const, "assignment_arm");
  const basis = record(receipt.assignment_basis, ASSIGNMENT_BASIS_KEYS, "assignment_basis");
  if (basis.schema_version !== "serving_assignment_basis_v1") {
    fail("assignment_basis_schema");
  }
  const basisCohort = artifactRef(basis.experiment_cohort_ref, "basis_cohort_ref");
  for (const field of [
    "create_continuation_operation_id", "decision_id", "episode_id", "run_id",
    "host_task_id", "task_family",
  ] as const) text(basis[field], `assignment_basis_${field}`);
  for (const field of [
    "operation_request_sha256", "host_task_envelope_sha256",
    "host_principal_sha256", "source_task_sha256",
  ] as const) sha(basis[field], `assignment_basis_${field}`);
  const snapshot = record(
    basis.world_snapshot_ref,
    ["world_snapshot_id", "world_snapshot_sha256"],
    "assignment_basis_snapshot",
  );
  text(snapshot.world_snapshot_id, "assignment_basis_snapshot_id");
  sha(snapshot.world_snapshot_sha256, "assignment_basis_snapshot_sha256");
  const memory = record(
    basis.memory_scope_head_ref,
    ["head_sha256", "revision"],
    "assignment_basis_memory_head",
  );
  integer(memory.revision, "assignment_basis_memory_revision", 1);
  sha(memory.head_sha256, "assignment_basis_memory_sha256");
  const basisSha = sha(receipt.assignment_basis_sha256, "assignment_basis_sha256");
  sha(receipt.assignment_draw_sha256, "assignment_draw_sha256");
  if (typeof receipt.assigned_at !== "string") fail("assignment_assigned_at");
  try {
    assertCanonicalUtcMillis(receipt.assigned_at, "assignment_assigned_at");
  } catch {
    fail("assignment_assigned_at");
  }
  const receiptSha = sha(
    receipt.serving_assignment_receipt_sha256,
    "serving_assignment_receipt_sha256",
  );
  const expectedArm = expected.mode === "assigned_control" ? "control" : "candidate";
  if (control.branch_kind !== "authoritative" || control.state !== "authoritative"
    || candidate.branch_kind !== "candidate" || candidate.state !== "active_candidate"
    || receipt.tenant_id !== identity.tenant_id
    || receipt.scope !== identity.scope
    || receipt.authority_subject_sha256 !== expected.subject
    || canonicalContinuationJson(cohort) !== canonicalContinuationJson(expected.cohort)
    || canonicalContinuationJson(basisCohort) !== canonicalContinuationJson(expected.cohort)
    || canonicalContinuationJson(control) !== canonicalContinuationJson({
      ...expected.head,
      branch_kind: "authoritative",
      state: "authoritative",
    })
    || canonicalContinuationJson({
      branch_id: served.branch_id,
      branch_revision: served.branch_revision,
      manifest_sha256: served.manifest_sha256,
    }) !== canonicalContinuationJson(expected.served)
    || canonicalContinuationJson(compiler) !== canonicalContinuationJson(expected.compiler)
    || canonicalContinuationJson(evidence) !== canonicalContinuationJson(expected.evidence)
    || arm !== expectedArm
    || (arm === "control"
      && canonicalContinuationJson(served) !== canonicalContinuationJson(control))
    || (arm === "candidate"
      && canonicalContinuationJson(served) !== canonicalContinuationJson(candidate))
    || basis.decision_id !== identity.decision_id
    || basis.episode_id !== identity.episode_id
    || basis.run_id !== identity.run_id
    || basis.host_task_id !== identity.host_task_id
    || basis.host_task_envelope_sha256 !== identity.host_task_envelope_sha256
    || basis.task_family !== identity.task_family
    || basis.source_task_sha256 !== identity.source_task_sha256
    || snapshot.world_snapshot_id !== identity.world_snapshot_id
    || snapshot.world_snapshot_sha256 !== identity.world_snapshot_sha256
    || memory.revision !== expected.memoryRevision
    || memory.head_sha256 !== expected.memorySha256
    || basisSha !== canonicalContinuationSha256(basis)
    || receiptSha !== canonicalSha256Without(
      receipt,
      "serving_assignment_receipt_sha256",
    )) {
    fail("serving_assignment_receipt_binding");
  }
  return receipt;
}

function targetRefs(value: unknown, field: string, requireNonEmpty = true): readonly Row[] {
  const refs = array(value, 16, field).map((item, index) => {
    const ref = record(item, TARGET_REF_KEYS, `${field}_${index}`);
    oneOf(ref.kind, [
      "artifact", "service", "capability", "memory", "workflow",
      "external_resource",
    ] as const, `${field}_${index}_kind`);
    text(ref.ref, `${field}_${index}_ref`, 1_024);
    return ref;
  });
  if ((requireNonEmpty && refs.length === 0) || refs.some((item, index) => index > 0
    && compareCanonicalUtf8(
      `${refs[index - 1]!.kind}\0${refs[index - 1]!.ref}`,
      `${item.kind}\0${item.ref}`,
    ) >= 0)) fail(`${field}_canonical`);
  return refs;
}

function parseIdentity(value: unknown): Row {
  const identity = record(value, IDENTITY_KEYS, "identity");
  for (const field of [
    "decision_id", "tenant_id", "scope", "episode_id", "run_id",
    "host_task_id", "task_family", "world_snapshot_id",
  ] as const) text(identity[field], `identity_${field}`);
  text(identity.task_signature, "identity_task_signature", 512);
  text(identity.workspace_signature, "identity_workspace_signature", 512);
  nullableText(identity.workflow_signature, "identity_workflow_signature", 512);
  nullableText(identity.consumer_agent_id, "identity_consumer_agent_id");
  nullableText(identity.consumer_team_id, "identity_consumer_team_id");
  for (const field of [
    "host_task_envelope_sha256", "collection_principal_sha256",
    "source_task_sha256", "source_event_sha256", "world_snapshot_sha256",
  ] as const) sha(identity[field], `identity_${field}`);
  return identity;
}

function parseAuthority(value: unknown, identity: Row): Row {
  const authority = record(value, AUTHORITY_KEYS, "authority");
  const subject = sha(authority.authority_subject_sha256, "authority_subject_sha256");
  if (subject !== continuationAuthoritySubjectSha256V1({
    tenant_id: identity.tenant_id as string,
    scope: identity.scope as string,
    task_family: identity.task_family as string,
  })) fail("authority_subject_binding");
  const head = branchRef(
    authority.authoritative_learning_head,
    "authoritative_learning_head",
  );
  const served = branchRef(
    authority.served_learning_branch,
    "served_learning_branch",
  );
  const compiler = artifactRef(authority.compiler_policy_ref, "compiler_policy_ref");
  const evidence = artifactRef(authority.evidence_policy_ref, "evidence_policy_ref");
  void compiler;
  void evidence;
  integer(authority.memory_scope_head_revision, "memory_scope_head_revision", 1);
  sha(authority.memory_scope_head_sha256, "memory_scope_head_sha256");
  const mode = oneOf(
    authority.serving_mode,
    [
      "authoritative_unassigned", "assigned_control", "assigned_candidate",
    ] as const,
    "serving_mode",
  );
  if (mode === "authoritative_unassigned") {
    if (canonicalContinuationJson(head) !== canonicalContinuationJson(served)
      || authority.experiment_cohort_ref !== null
      || authority.serving_assignment_receipt !== null) {
      fail("authoritative_serving_binding");
    }
  } else {
    if ((mode === "assigned_control"
        && canonicalContinuationJson(head) !== canonicalContinuationJson(served))
      || (mode === "assigned_candidate"
        && canonicalContinuationJson(head) === canonicalContinuationJson(served))
      || authority.experiment_cohort_ref === null
      || authority.serving_assignment_receipt === null) {
      fail("assigned_serving_binding");
    }
    const cohort = artifactRef(authority.experiment_cohort_ref, "experiment_cohort_ref");
    parseServingAssignmentReceipt(
      authority.serving_assignment_receipt,
      identity,
      {
        subject,
        head,
        served,
        cohort,
        compiler,
        evidence,
        memoryRevision: integer(
          authority.memory_scope_head_revision,
          "memory_scope_head_revision",
          1,
        ),
        memorySha256: sha(
          authority.memory_scope_head_sha256,
          "memory_scope_head_sha256",
        ),
        mode,
      },
    );
  }
  return authority;
}

function parseObligations(value: unknown): readonly Row[] {
  const obligations = array(value, 64, "obligations").map((item, index) => {
    const obligation = record(item, OBLIGATION_KEYS, `obligation_${index}`);
    text(obligation.obligation_id, `obligation_${index}_id`);
    oneOf(obligation.kind, [
      "active_goal", "required_state", "next_action", "must_hold",
      "prohibition", "verification",
    ] as const, `obligation_${index}_kind`);
    oneOf(obligation.requirement, ["hard", "advisory"] as const,
      `obligation_${index}_requirement`);
    text(obligation.statement, `obligation_${index}_statement`, 1_024);
    targetRefs(obligation.target_refs, `obligation_${index}_targets`);
    const probes = canonicalStrings(
      obligation.required_probe_ids,
      16,
      `obligation_${index}_probes`,
    );
    canonicalStrings(obligation.source_refs, 32, `obligation_${index}_sources`);
    const evidence = oneOf(obligation.evidence_requirement, [
      "runtime_state", "trusted_host", "external_verifier",
    ] as const, `obligation_${index}_evidence`);
    if ((evidence === "runtime_state" && probes.length !== 0)
      || (evidence !== "runtime_state" && probes.length === 0)) {
      fail(`obligation_${index}_evidence_probe_binding`);
    }
    return obligation;
  });
  if (obligations.filter((item) => item.requirement === "hard").length > 32
    || obligations.some((item, index) => index > 0
      && compareCanonicalUtf8(
        obligations[index - 1]!.obligation_id as string,
        item.obligation_id as string,
      ) >= 0)) fail("obligation_universe_canonical");
  return obligations;
}

type ParsedSelection = Readonly<{
  row: Row;
  ref: CapsuleRefV1;
  coverageBindings: readonly Row[];
  satisfiedProbeIds: readonly string[];
  surface: string;
}>;

function parseSelections(
  value: unknown,
  obligations: ReadonlyMap<string, Row>,
): readonly ParsedSelection[] {
  const selections = array(value, 64, "selected_capsules").map((item, index) => {
    const selection = record(item, SELECTED_KEYS, `selection_${index}`);
    const ref = capsuleRef(selection.capsule, `selection_${index}_capsule`);
    const surface = oneOf(selection.surface, [
      "use_now", "inspect_before_use", "do_not_use", "rehydrate",
    ] as const, `selection_${index}_surface`);
    const coverageBindings = array(
      selection.coverage_bindings,
      64,
      `selection_${index}_coverage_bindings`,
    ).map((raw, bindingIndex) => {
      const binding = record(
        raw,
        COVERAGE_BINDING_KEYS,
        `selection_${index}_coverage_${bindingIndex}`,
      );
      const obligationId = text(
        binding.obligation_id,
        `selection_${index}_coverage_${bindingIndex}_obligation`,
      );
      if (!obligations.has(obligationId)) fail("selection_unknown_obligation");
      sha(
        binding.coverage_claim_sha256,
        `selection_${index}_coverage_${bindingIndex}_claim`,
      );
      return binding;
    });
    if (coverageBindings.length === 0 || coverageBindings.some((binding, bindingIndex) =>
      bindingIndex > 0 && compareCanonicalUtf8(
        coverageBindings[bindingIndex - 1]!.obligation_id as string,
        binding.obligation_id as string,
      ) >= 0)) fail("selection_coverage_canonical");
    const satisfiedProbeIds = canonicalStrings(
      selection.satisfied_probe_ids,
      64,
      `selection_${index}_satisfied_probes`,
    );
    canonicalStrings(
      selection.selection_reason_codes,
      64,
      `selection_${index}_reason_codes`,
    );
    return { row: selection, ref, coverageBindings, satisfiedProbeIds, surface };
  });
  if (selections.some((item, index) => index > 0
    && compareCanonicalUtf8(
      selections[index - 1]!.ref.capsule_sha256,
      item.ref.capsule_sha256,
    ) >= 0)) fail("selected_capsule_order");
  return selections;
}

type ParsedExclusion = Readonly<{ row: Row; ref: CapsuleRefV1 }>;

function parseExclusions(value: unknown): readonly ParsedExclusion[] {
  const exclusions = array(value, 256, "excluded_capsules").map((item, index) => {
    const exclusion = record(item, EXCLUDED_KEYS, `exclusion_${index}`);
    const ref = capsuleRef(exclusion.capsule, `exclusion_${index}_capsule`);
    canonicalStrings(exclusion.reason_codes, 64, `exclusion_${index}_reasons`, false);
    return { row: exclusion, ref };
  });
  if (exclusions.some((item, index) => index > 0
    && compareCanonicalUtf8(
      exclusions[index - 1]!.ref.capsule_sha256,
      item.ref.capsule_sha256,
    ) >= 0)) fail("excluded_capsule_order");
  return exclusions;
}

function parseCompiler(value: unknown): Row {
  const compiler = record(value, COMPILER_KEYS, "compiler");
  if (compiler.algorithm !== "bounded_greedy_coverage_v1"
    || sha(compiler.algorithm_contract_sha256, "algorithm_contract_sha256")
      !== continuationCompilerAlgorithmContractSha256()) fail("compiler_algorithm");
  if (typeof compiler.compiled_at !== "string") fail("compiler_compiled_at");
  try {
    assertCanonicalUtcMillis(compiler.compiled_at, "contract.compiler.compiled_at");
  } catch {
    fail("compiler_compiled_at");
  }
  const candidateLimit = integer(compiler.candidate_limit, "candidate_limit", 2, 256);
  const continuityLimit = integer(
    compiler.continuity_candidate_limit,
    "continuity_candidate_limit",
    1,
    255,
  );
  const learningLimit = integer(
    compiler.learning_candidate_limit,
    "learning_candidate_limit",
    1,
    255,
  );
  if (continuityLimit + learningLimit !== candidateLimit) fail("compiler_lane_limits");
  const selectedLimit = integer(
    compiler.selected_capsule_limit,
    "selected_capsule_limit",
    1,
    64,
  );
  if (selectedLimit > candidateLimit) fail("compiler_selected_limit");
  integer(compiler.obligation_limit, "obligation_limit", 1, 64);
  integer(compiler.render_budget, "render_budget", 1_024, 65_536);
  let receipt: ContinuationCandidateRetrievalReceiptV1;
  try {
    receipt = verifyContinuationCandidateRetrievalReceiptV1(
      compiler.candidate_retrieval_receipt,
    );
  } catch {
    fail("candidate_retrieval_receipt");
  }
  if (receipt.algorithm_contract_sha256
      !== CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1
    || receipt.overflow_status !== "none"
    || receipt.lane_limits.verified_continuity !== continuityLimit
    || receipt.lane_limits.governed_learning !== learningLimit
    || receipt.selected_capsule_limit !== selectedLimit) {
    fail("candidate_retrieval_receipt_binding");
  }
  return { ...compiler, candidate_retrieval_receipt: receipt };
}

function refsForObligation(
  selections: readonly ParsedSelection[],
  obligationId: string,
): readonly CapsuleRefV1[] {
  return selections.flatMap((selection) => selection.coverageBindings.some(
    (binding) => binding.obligation_id === obligationId,
  ) ? [selection.ref] : []);
}

function probesForObligation(
  selections: readonly ParsedSelection[],
  obligationId: string,
): readonly string[] {
  return [...new Set(selections.flatMap((selection) => selection.coverageBindings.some(
    (binding) => binding.obligation_id === obligationId,
  ) ? selection.satisfiedProbeIds : []))].sort(compareCanonicalUtf8);
}

function parseCertificate(args: Readonly<{
  value: unknown;
  identity: Row;
  obligations: readonly Row[];
  selected: readonly ParsedSelection[];
  excluded: readonly ParsedExclusion[];
  compiler: Row;
}>): Row {
  const certificate = record(args.value, CERTIFICATE_KEYS, "coverage_certificate");
  if (certificate.certificate_version !== "continuation_coverage_certificate_v1") {
    fail("coverage_certificate_version");
  }
  for (const field of [
    "compilation_input_sha256", "candidate_universe_sha256",
  ] as const) sha(certificate[field], field);
  if (sha(certificate.obligation_universe_sha256, "obligation_universe_sha256")
      !== canonicalContinuationSha256(args.obligations)
    || sha(certificate.world_snapshot_sha256, "certificate_world_snapshot_sha256")
      !== args.identity.world_snapshot_sha256
    || sha(certificate.selected_surface_sha256, "selected_surface_sha256")
      !== canonicalContinuationSha256(args.selected.map((item) => item.row))) {
    fail("coverage_universe_binding");
  }
  const partition = record(certificate.candidate_partition, PARTITION_KEYS, "candidate_partition");
  const candidateCount = integer(partition.candidate_count, "candidate_count", 0, 256);
  const selectedCount = integer(partition.selected_count, "selected_count", 0, 64);
  const receipt = args.compiler.candidate_retrieval_receipt as
    ContinuationCandidateRetrievalReceiptV1;
  if (selectedCount !== args.selected.length
    || selectedCount > (args.compiler.selected_capsule_limit as number)
    || integer(partition.excluded_count, "excluded_count", 0, 256) !== args.excluded.length
    || candidateCount !== args.selected.length + args.excluded.length
    || candidateCount > (args.compiler.candidate_limit as number)
    || candidateCount !== receipt.selected.verified_continuity.count
      + receipt.selected.governed_learning.count
    || certificate.candidate_universe_sha256
      !== receipt.compiler_candidate_universe_sha256
    || sha(partition.selected_capsule_set_sha256, "selected_capsule_set_sha256")
      !== canonicalContinuationSha256(args.selected.map((item) => item.ref))
    || sha(partition.excluded_capsule_set_sha256, "excluded_capsule_set_sha256")
      !== canonicalContinuationSha256(args.excluded.map((item) => item.ref))) {
    fail("candidate_partition");
  }
  const selectedKeys = new Set(args.selected.map((item) => capsuleKey(item.ref)));
  const excludedKeys = new Set(args.excluded.map((item) => capsuleKey(item.ref)));
  if (selectedKeys.size !== args.selected.length
    || excludedKeys.size !== args.excluded.length
    || [...selectedKeys].some((key) => excludedKeys.has(key))) fail("candidate_partition_disjoint");

  const coverage = array(certificate.coverage, 64, "coverage");
  if (coverage.length !== args.obligations.length) fail("coverage_cardinality");
  const coverageStatuses = new Map<string, string>();
  for (let index = 0; index < coverage.length; index += 1) {
    const item = record(coverage[index], COVERAGE_KEYS, `coverage_${index}`);
    const obligation = args.obligations[index]!;
    if (text(item.obligation_id, `coverage_${index}_obligation`)
      !== obligation.obligation_id) fail("coverage_obligation_order");
    const status = oneOf(
      item.status,
      ["covered", "uncovered", "conflicted"] as const,
      `coverage_${index}_status`,
    );
    const refs = array(item.capsule_refs, 64, `coverage_${index}_refs`).map(
      (ref, refIndex) => capsuleRef(ref, `coverage_${index}_ref_${refIndex}`),
    );
    const expectedRefs = refsForObligation(args.selected, item.obligation_id as string);
    if (canonicalContinuationJson(refs) !== canonicalContinuationJson(expectedRefs)) {
      fail("coverage_capsule_ref_binding");
    }
    const probes = canonicalStrings(
      item.satisfied_probe_ids,
      64,
      `coverage_${index}_probes`,
    );
    if (canonicalContinuationJson(probes) !== canonicalContinuationJson(
      probesForObligation(args.selected, item.obligation_id as string),
    )) fail("coverage_probe_binding");
    const reasons = canonicalStrings(item.reason_codes, 8, `coverage_${index}_reasons`);
    const expectedReasons = status === "covered" ? []
      : status === "conflicted" ? ["obligation_conflicted"]
        : ["obligation_uncovered"];
    if (canonicalContinuationJson(reasons) !== canonicalContinuationJson(expectedReasons)
      || (status === "uncovered" && refs.length !== 0)
      || (status === "conflicted" && refs.length === 0)
      || (status === "covered" && refs.length === 0)) fail("coverage_status_binding");
    if (status === "covered" && obligation.kind !== "prohibition") {
      const required = obligation.required_probe_ids as readonly string[];
      if (!args.selected.some((selection) =>
        selection.surface === "use_now"
        && selection.coverageBindings.some(
          (binding) => binding.obligation_id === obligation.obligation_id,
        )
        && required.every((probe) => selection.satisfiedProbeIds.includes(probe)))) {
        fail("covered_obligation_has_no_executable_surface");
      }
    }
    coverageStatuses.set(item.obligation_id as string, status);
  }

  const hardComplete = args.obligations.every((obligation) =>
    obligation.requirement !== "hard"
      || coverageStatuses.get(obligation.obligation_id as string) === "covered"
  );
  const budget = bool(certificate.budget_satisfied, "budget_satisfied");
  const requiredBytes = integer(
    certificate.required_render_bytes,
    "required_render_bytes",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (budget !== (requiredBytes <= (args.compiler.render_budget as number))) {
    fail("budget_satisfied_binding");
  }
  const directUse = bool(
    certificate.direct_use_preconditions_complete,
    "direct_use_preconditions_complete",
  );
  const conflictFree = bool(certificate.conflict_free, "conflict_free");
  if (bool(certificate.hard_obligation_coverage_complete, "hard_coverage_complete")
      !== hardComplete) fail("hard_coverage_binding");
  const complete = hardComplete && directUse && conflictFree && budget;
  if (oneOf(certificate.status, ["complete", "incomplete"] as const, "certificate_status")
      !== (complete ? "complete" : "incomplete")) fail("certificate_status_binding");
  const reasons = canonicalStrings(certificate.reason_codes, 4, "certificate_reasons");
  const expectedReasons = [
    ...(!hardComplete ? ["hard_obligation_incomplete"] : []),
    ...(!directUse ? ["direct_use_precondition_incomplete"] : []),
    ...(!conflictFree ? ["capsule_conflict"] : []),
    ...(!budget ? ["hard_safety_exceeds_render_budget"] : []),
  ].sort(compareCanonicalUtf8);
  if (canonicalContinuationJson(reasons) !== canonicalContinuationJson(expectedReasons)) {
    fail("certificate_reason_binding");
  }
  const certificateSha = sha(certificate.certificate_sha256, "certificate_sha256");
  if (canonicalSha256Without(certificate, "certificate_sha256") !== certificateSha) {
    fail("certificate_sha256_mismatch");
  }
  return certificate;
}

function parseFallback(args: Readonly<{
  value: unknown;
  certificate: Row;
  obligations: readonly Row[];
  selected: readonly ParsedSelection[];
}>): Row {
  const fallback = record(args.value, FALLBACK_KEYS, "safe_fallback");
  const mode = oneOf(fallback.mode, [
    "execute", "inspect", "rehydrate", "block", "report_unresolved",
  ] as const, "fallback_mode");
  if (canonicalContinuationJson(canonicalStrings(
    fallback.reason_codes,
    4,
    "fallback_reasons",
  )) !== canonicalContinuationJson(args.certificate.reason_codes)) {
    fail("fallback_reason_binding");
  }
  const coverage = args.certificate.coverage as readonly Row[];
  const unresolved = coverage.filter((item) => item.status !== "covered")
    .map((item) => item.obligation_id as string);
  if (canonicalContinuationJson(canonicalStrings(
    fallback.unresolved_obligation_ids,
    64,
    "fallback_unresolved",
  )) !== canonicalContinuationJson(unresolved)) fail("fallback_unresolved_binding");
  const unresolvedHard = new Set(args.obligations.filter((obligation) =>
    obligation.requirement === "hard"
      && unresolved.includes(obligation.obligation_id as string)
  ).map((obligation) => obligation.obligation_id as string));
  const paths = args.selected.filter((selection) => selection.coverageBindings.some(
    (binding) => unresolvedHard.has(binding.obligation_id as string),
  ));
  const expected = args.certificate.status === "complete" ? "execute"
    : args.certificate.budget_satisfied === false
      || paths.some((path) => path.surface === "do_not_use") ? "block"
      : paths.some((path) => path.surface === "rehydrate") ? "rehydrate"
        : args.certificate.conflict_free === false
          || paths.some((path) => path.surface === "inspect_before_use") ? "inspect"
          : "report_unresolved";
  if (mode !== expected) fail("fallback_mode_binding");
  return fallback;
}

function parseProjection(value: unknown, field: string): Row {
  const projection = record(value, CAPSULE_PROJECTION_KEYS, field);
  text(projection.summary, `${field}_summary`, 2_048);
  nullableText(projection.next_action, `${field}_next_action`, 1_024);
  targetRefs(projection.target_refs, `${field}_targets`, false);
  const workflow = array(projection.workflow_steps, 32, `${field}_workflow`);
  workflow.forEach((step, index) => text(step, `${field}_workflow_${index}`, 512));
  const acceptance = array(projection.acceptance_statements, 32, `${field}_acceptance`);
  acceptance.forEach((item, index) => text(item, `${field}_acceptance_${index}`, 1_024));
  if (canonicalSha256Without(projection, "projection_sha256")
    !== sha(projection.projection_sha256, `${field}_sha256`)) fail("projection_digest");
  return projection;
}

/**
 * Verifies the complete closed persisted projection and every relation that
 * can be derived from it. This deliberately does not claim to replay the
 * discarded candidate/evaluation inputs behind compilation_input_sha256 or
 * candidate_universe_sha256; durable exactness is provided by the DB-backed
 * historical decision reader.
 */
export function verifyClosedContinuationContractProjectionV1(
  value: unknown,
): ContinuationContractV1 {
  canonicalContinuationJson(value);
  const contract = record(value, ROOT_KEYS, "root");
  if (contract.schema_version !== "continuation_contract_v1") fail("schema_version");
  const identity = parseIdentity(contract.identity);
  const authority = parseAuthority(contract.authority, identity);
  const compiler = parseCompiler(contract.compiler);
  const obligations = parseObligations(contract.obligations);
  const retrievalReceipt = compiler.candidate_retrieval_receipt as
    ContinuationCandidateRetrievalReceiptV1;
  if (retrievalReceipt.identity_sha256 !== canonicalContinuationSha256(identity)
    || retrievalReceipt.obligation_universe_sha256
      !== canonicalContinuationSha256({ obligations })
    || retrievalReceipt.compiler_policy_payload_sha256
      !== (authority.compiler_policy_ref as Row).payload_sha256
    || retrievalReceipt.evaluated_at !== compiler.compiled_at) {
    fail("candidate_retrieval_receipt_contract_binding");
  }
  if (obligations.length > (compiler.obligation_limit as number)) {
    fail("obligation_limit_binding");
  }
  const obligationMap = new Map(obligations.map(
    (obligation) => [obligation.obligation_id as string, obligation],
  ));
  const selected = parseSelections(contract.selected_capsules, obligationMap);
  const excluded = parseExclusions(contract.excluded_capsules);
  const certificate = parseCertificate({
    value: contract.coverage_certificate,
    identity,
    obligations,
    selected,
    excluded,
    compiler,
  });
  parseFallback({
    value: contract.safe_fallback,
    certificate,
    obligations,
    selected,
  });
  const contractSha = sha(contract.contract_sha256, "contract_sha256");
  if (canonicalSha256Without(contract, "contract_sha256") !== contractSha) {
    fail("contract_sha256_mismatch");
  }
  return canonicalContinuationClone(value as ContinuationContractV1);
}

export function verifyClosedContinuationExposureProjectionV1(args: Readonly<{
  contract: unknown;
  renderResult: unknown;
}>): Readonly<{
  contract: ContinuationContractV1;
  renderResult: ReturnType<typeof verifyRenderedContinuationProjectionV1>;
}> {
  const input = record(args, ["contract", "renderResult"], "exposure");
  const contract = verifyClosedContinuationContractProjectionV1(input.contract);
  const renderResult = verifyRenderedContinuationProjectionV1(input.renderResult);
  if (renderResult.status === "rendered") {
    const projection = record(JSON.parse(renderResult.content), PROJECTION_KEYS, "render_projection");
    if (projection.schema_version !== "continuation_agent_projection_v1"
      || projection.format !== CONTINUATION_PROJECTION_FORMAT_V1
      || projection.contract_sha256 !== contract.contract_sha256
      || projection.coverage_certificate_sha256
        !== contract.coverage_certificate.certificate_sha256
      || canonicalContinuationJson(projection.identity)
        !== canonicalContinuationJson(contract.identity)
      || canonicalContinuationJson(projection.authority)
        !== canonicalContinuationJson(contract.authority)
      || canonicalContinuationJson(projection.obligations)
        !== canonicalContinuationJson(contract.obligations)) fail("render_projection_binding");
    const expectedFallbackCode = contract.safe_fallback.mode === "execute" ? "E"
      : contract.safe_fallback.mode === "inspect" ? "I"
        : contract.safe_fallback.mode === "rehydrate" ? "R"
          : contract.safe_fallback.mode === "block" ? "B" : "U";
    if (projection.safe_fallback_code !== expectedFallbackCode) fail("render_fallback_binding");
    const projectedRehydrationRefs = array(
      projection.rehydration_capsule_refs,
      256,
      "rendered_rehydration_capsule_refs",
    ).map((value, index) => capsuleRef(
      value,
      `rendered_rehydration_capsule_ref_${index}`,
    ));
    const expectedRehydrationRefs = canonicalUniqueSet(
      contract.excluded_capsules.flatMap((excluded) =>
        excluded.reason_codes.includes("lifecycle_archived_rehydration_required")
          ? [excluded.capsule]
          : []
      ),
      capsuleKey,
    );
    if (canonicalContinuationJson(projectedRehydrationRefs)
      !== canonicalContinuationJson(expectedRehydrationRefs)) {
      fail("render_rehydration_binding");
    }
    const projected = array(projection.selected_capsules, 64, "rendered_selected_capsules");
    if (projected.length !== contract.selected_capsules.length) fail("render_selection_count");
    for (let index = 0; index < projected.length; index += 1) {
      const item = record(
        projected[index],
        PROJECTION_SELECTION_KEYS,
        `rendered_selection_${index}`,
      );
      const selected = contract.selected_capsules[index]!;
      capsuleRef(item.capsule, `rendered_selection_${index}_capsule`);
      parseProjection(item.projection, `rendered_selection_${index}_projection`);
      if (canonicalContinuationJson(item.capsule)
          !== canonicalContinuationJson(selected.capsule)
        || item.surface !== selected.surface
        || canonicalContinuationJson(item.coverage_bindings)
          !== canonicalContinuationJson(selected.coverage_bindings)
        || canonicalContinuationJson(item.satisfied_probe_ids)
          !== canonicalContinuationJson(selected.satisfied_probe_ids)) {
        fail("render_selected_surface_binding");
      }
    }
  }
  if (renderResult.required_bytes !== contract.coverage_certificate.required_render_bytes
    || renderResult.budget_bytes !== contract.compiler.render_budget
    || (renderResult.status === "rendered")
      !== contract.coverage_certificate.budget_satisfied) fail("render_budget_binding");
  return canonicalContinuationClone({ contract, renderResult });
}
