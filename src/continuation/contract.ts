import { sha256Hex } from "../util/crypto.js";

export type Sha256 = string;

export type CandidateRetrievalLaneV1 =
  | "verified_continuity"
  | "governed_learning";

export type CandidateRetrievalOverflowReasonV1 =
  | "verified_continuity_protected_limit_exceeded"
  | "governed_learning_protected_limit_exceeded"
  | "selected_capsule_protected_limit_exceeded";

export type CandidateRetrievalLaneSummaryV1 = Readonly<{
  count: number;
  ref_set_sha256: Sha256;
}>;

export type CandidateRetrievalSourceLaneSummaryV1 =
  CandidateRetrievalLaneSummaryV1 & Readonly<{
    candidate_universe_sha256: Sha256;
  }>;

export type ContinuationCandidateRetrievalReceiptV1 = Readonly<{
  schema_version: "continuation_candidate_retrieval_receipt_v1";
  algorithm_contract_sha256: Sha256;
  identity_sha256: Sha256;
  obligation_universe_sha256: Sha256;
  compiler_policy_payload_sha256: Sha256;
  compiler_candidate_universe_sha256: Sha256;
  lane_limits: Readonly<Record<CandidateRetrievalLaneV1, number>>;
  selected_capsule_limit: number;
  evaluated_at: string;
  source_universe: Readonly<{
    candidate_count: number;
    candidate_universe_sha256: Sha256;
    verified_continuity: CandidateRetrievalSourceLaneSummaryV1;
    governed_learning: CandidateRetrievalSourceLaneSummaryV1;
  }>;
  protected: Readonly<
    Record<CandidateRetrievalLaneV1, CandidateRetrievalLaneSummaryV1>
  >;
  mandatory_protected: CandidateRetrievalLaneSummaryV1;
  selected: Readonly<
    Record<CandidateRetrievalLaneV1, CandidateRetrievalLaneSummaryV1>
  >;
  omitted: Readonly<
    Record<CandidateRetrievalLaneV1, CandidateRetrievalLaneSummaryV1>
  >;
  overflow_status:
    | "none"
    | "verified_continuity_protected_overflow"
    | "governed_learning_protected_overflow"
    | "both_lanes_protected_overflow"
    | "selected_capsule_protected_overflow"
    | "multiple_protected_overflow";
  overflow_reasons: readonly CandidateRetrievalOverflowReasonV1[];
  receipt_sha256: Sha256;
}>;

export type TargetRefV1 = Readonly<{
  kind: "artifact" | "service" | "capability" | "memory" | "workflow" | "external_resource";
  ref: string;
}>;

export type ContinuationObligationV1 = Readonly<{
  obligation_id: string;
  kind: "active_goal" | "required_state" | "next_action" | "must_hold" | "prohibition" | "verification";
  requirement: "hard" | "advisory";
  statement: string;
  target_refs: readonly TargetRefV1[];
  required_probe_ids: readonly string[];
  evidence_requirement: "runtime_state" | "trusted_host" | "external_verifier";
  source_refs: readonly string[];
}>;

export type CapsuleRefV1 = Readonly<{
  capsule_id: string;
  capsule_revision: number;
  capsule_sha256: Sha256;
}>;

type ProbeCommonV1 = Readonly<{
  probe_id: string;
  required_for: "admission" | "before_action" | "before_merge" | "before_complete";
  observer: "trusted_host_collector" | "external_verifier";
  max_age_ms: number;
  on_unknown: "inspect" | "rehydrate" | "block";
  on_unsatisfied: "block" | "quarantine" | "expire";
}>;

export type TypedPreconditionSpecV1 =
  | (ProbeCommonV1 & Readonly<{
    kind: "artifact";
    workspace_id: string;
    relative_path: string;
    expected_presence: "present" | "absent";
    expected_kind: "file" | "directory" | null;
    expected_content_sha256: Sha256 | null;
  }>)
  | (ProbeCommonV1 & Readonly<{
    kind: "workspace";
    workspace_id: string;
    expected_revision: string | null;
    expected_tree_sha256: Sha256 | null;
    dirty_state: "clean" | "dirty" | "either";
  }>)
  | (ProbeCommonV1 & Readonly<{
    kind: "verifier";
    verifier_id: string;
    config_sha256: Sha256;
    expected_result: "passed";
    require_fresh_process: boolean;
    require_after_agent_exit: boolean;
  }>)
  | (ProbeCommonV1 & Readonly<{
    kind: "service";
    endpoint_id: string;
    protocol: "http" | "https" | "tcp" | "process";
    expected_health: "healthy";
    require_external_visibility: boolean;
    require_after_agent_exit: boolean;
  }>)
  | (ProbeCommonV1 & Readonly<{
    kind: "capability";
    capability_id: string;
    expected_version: string | null;
    expected_presence: "present" | "absent";
  }>);

export type HostObservationValueV1 =
  | Readonly<{
    kind: "artifact";
    presence: "present" | "absent";
    artifact_kind: "file" | "directory" | null;
    content_sha256: Sha256 | null;
  }>
  | Readonly<{
    kind: "workspace";
    revision: string | null;
    tree_sha256: Sha256 | null;
    dirty_state: "clean" | "dirty";
  }>
  | Readonly<{
    kind: "verifier";
    verifier_id: string;
    config_sha256: Sha256;
    result: "passed" | "failed";
    fresh_process: boolean;
    after_agent_exit: boolean;
  }>
  | Readonly<{
    kind: "service";
    endpoint_id: string;
    protocol: "http" | "https" | "tcp" | "process";
    health: "healthy" | "unhealthy";
    externally_visible: boolean;
    after_agent_exit: boolean;
  }>
  | Readonly<{
    kind: "capability";
    capability_id: string;
    version: string | null;
    presence: "present" | "absent";
  }>;

export type HostObservationV1 = Readonly<{
  schema_version: "host_observation_v1";
  observation_id: string;
  probe_id: string;
  probe_spec_sha256: Sha256;
  observer: "trusted_host_collector" | "external_verifier";
  observer_principal_sha256: Sha256;
  host_task_envelope_sha256: Sha256;
  world_snapshot_id: string;
  observed_at: string;
  expires_at: string;
  value: HostObservationValueV1;
  evidence_sha256: Sha256;
  attestation:
    | Readonly<{
      kind: "authenticated_collector";
    }>
    | Readonly<{
      kind: "ed25519";
      public_key_spki_base64url: string;
      signature: string;
    }>;
  observation_sha256: Sha256;
}>;

export type PreconditionEvaluationV1 = Readonly<{
  probe_id: string;
  status: "satisfied" | "unsatisfied" | "unknown";
  observation_id: string | null;
  reason_codes: readonly string[];
}>;

/**
 * A stable semantic claim that can be matched against future obligations.
 *
 * Obligation IDs are decision-local and therefore must never be persisted in
 * reusable memory. Coverage is granted only when kind, target set, evidence
 * class, and probe set match a current obligation exactly.
 */
export type CapsuleCoverageClaimV1 = Readonly<{
  obligation_kind: ContinuationObligationV1["kind"];
  target_refs: readonly TargetRefV1[];
  evidence_requirement: ContinuationObligationV1["evidence_requirement"];
  required_probe_ids: readonly string[];
  coverage_claim_sha256: Sha256;
}>;

export type ExecutionCapsuleV1 = CapsuleRefV1 & Readonly<{
  schema_version: "execution_capsule_v1";
  created_at: string;
  parent_capsule_sha256: Sha256 | null;
  source: Readonly<{
    memory_id: string;
    source_commit_id: string;
    source_projection_sha256: Sha256;
  }>;
  kind: "current_state" | "verified_fact" | "procedure" | "constraint" | "counter_evidence" | "rehydration_pointer";
  proposed_influence: "use" | "inspect" | "block" | "rehydrate";
  applicability: Readonly<{
    tenant_id: string;
    scope: string;
    task_family: string;
    task_signature: string | null;
    workflow_signature: string | null;
    workspace_signature: string | null;
    producer_agent_id: string | null;
    owner_agent_id: string | null;
    owner_team_id: string | null;
  }>;
  projection: Readonly<{
    summary: string;
    next_action: string | null;
    target_refs: readonly TargetRefV1[];
    workflow_steps: readonly string[];
    acceptance_statements: readonly string[];
    projection_sha256: Sha256;
  }>;
  coverage_claims: readonly CapsuleCoverageClaimV1[];
  precondition_specs: readonly TypedPreconditionSpecV1[];
  evidence_refs: readonly string[];
  verifier_refs: readonly string[];
  conflicts_with: readonly CapsuleRefV1[];
  supersedes: readonly CapsuleRefV1[];
  expires_at: string | null;
}>;

export type AuthorityBranchRefV1 = Readonly<{
  branch_id: string;
  branch_revision: number;
  manifest_sha256: Sha256;
}>;

export type AuthorityArtifactRefV1 = Readonly<{
  artifact_sha256: Sha256;
  payload_sha256: Sha256;
}>;

export type ContractServingAssignmentReceiptV1 = Readonly<{
  schema_version: "serving_assignment_receipt_v1";
  tenant_id: string;
  scope: string;
  cohort_id: string;
  authority_subject_sha256: Sha256;
  experiment_cohort_ref: AuthorityArtifactRefV1;
  arm: "control" | "candidate";
  control_learning_ref: AuthorityBranchRefV1 & Readonly<{
    branch_kind: "authoritative";
    state: "authoritative";
  }>;
  candidate_learning_ref: AuthorityBranchRefV1 & Readonly<{
    branch_kind: "candidate";
    state: "active_candidate";
  }>;
  served_learning_ref: AuthorityBranchRefV1 & Readonly<{
    branch_kind: "authoritative" | "candidate";
    state: "authoritative" | "active_candidate";
  }>;
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
  assignment_basis: Readonly<{
    schema_version: "serving_assignment_basis_v1";
    experiment_cohort_ref: AuthorityArtifactRefV1;
    create_continuation_operation_id: string;
    operation_request_sha256: Sha256;
    decision_id: string;
    episode_id: string;
    run_id: string;
    host_task_id: string;
    host_task_envelope_sha256: Sha256;
    host_principal_sha256: Sha256;
    task_family: string;
    source_task_sha256: Sha256;
    world_snapshot_ref: Readonly<{
      world_snapshot_id: string;
      world_snapshot_sha256: Sha256;
    }>;
    memory_scope_head_ref: Readonly<{
      revision: number;
      head_sha256: Sha256;
    }>;
  }>;
  assignment_basis_sha256: Sha256;
  assignment_draw_sha256: Sha256;
  assigned_at: string;
  serving_assignment_receipt_sha256: Sha256;
}>;

export type SelectedCapsuleV1 = Readonly<{
  capsule: CapsuleRefV1;
  surface: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate";
  coverage_bindings: readonly Readonly<{
    obligation_id: string;
    coverage_claim_sha256: Sha256;
  }>[];
  satisfied_probe_ids: readonly string[];
  selection_reason_codes: readonly string[];
}>;

export type ExcludedCapsuleV1 = Readonly<{
  capsule: CapsuleRefV1;
  reason_codes: readonly string[];
}>;

export type ContinuationCoverageCertificateV1 = Readonly<{
  certificate_version: "continuation_coverage_certificate_v1";
  compilation_input_sha256: Sha256;
  obligation_universe_sha256: Sha256;
  candidate_universe_sha256: Sha256;
  world_snapshot_sha256: Sha256;
  selected_surface_sha256: Sha256;
  coverage: readonly Readonly<{
    obligation_id: string;
    status: "covered" | "uncovered" | "conflicted";
    capsule_refs: readonly CapsuleRefV1[];
    satisfied_probe_ids: readonly string[];
    reason_codes: readonly string[];
  }>[];
  candidate_partition: Readonly<{
    selected_capsule_set_sha256: Sha256;
    excluded_capsule_set_sha256: Sha256;
    selected_count: number;
    excluded_count: number;
    candidate_count: number;
  }>;
  hard_obligation_coverage_complete: boolean;
  direct_use_preconditions_complete: boolean;
  conflict_free: boolean;
  budget_satisfied: boolean;
  required_render_bytes: number;
  status: "complete" | "incomplete";
  reason_codes: readonly string[];
  certificate_sha256: Sha256;
}>;

export type ContinuationContractV1 = Readonly<{
  schema_version: "continuation_contract_v1";
  identity: Readonly<{
    decision_id: string;
    tenant_id: string;
    scope: string;
    episode_id: string;
    run_id: string;
    host_task_id: string;
    host_task_envelope_sha256: Sha256;
    collection_principal_sha256: Sha256;
    consumer_agent_id: string | null;
    consumer_team_id: string | null;
    task_family: string;
    task_signature: string;
    workflow_signature: string | null;
    workspace_signature: string;
    source_task_sha256: Sha256;
    source_event_sha256: Sha256;
    world_snapshot_id: string;
    world_snapshot_sha256: Sha256;
  }>;
  authority: Readonly<{
    authority_subject_sha256: Sha256;
    authoritative_learning_head: AuthorityBranchRefV1;
    served_learning_branch: AuthorityBranchRefV1;
    serving_mode:
      | "authoritative_unassigned"
      | "assigned_control"
      | "assigned_candidate";
    experiment_cohort_ref: AuthorityArtifactRefV1 | null;
    serving_assignment_receipt: ContractServingAssignmentReceiptV1 | null;
    compiler_policy_ref: AuthorityArtifactRefV1;
    evidence_policy_ref: AuthorityArtifactRefV1;
    memory_scope_head_revision: number;
    memory_scope_head_sha256: Sha256;
  }>;
  obligations: readonly ContinuationObligationV1[];
  selected_capsules: readonly SelectedCapsuleV1[];
  excluded_capsules: readonly ExcludedCapsuleV1[];
  coverage_certificate: ContinuationCoverageCertificateV1;
  safe_fallback: Readonly<{
    mode: "execute" | "inspect" | "rehydrate" | "block" | "report_unresolved";
    reason_codes: readonly string[];
    unresolved_obligation_ids: readonly string[];
  }>;
  compiler: Readonly<{
    algorithm: "bounded_greedy_coverage_v1";
    algorithm_contract_sha256: Sha256;
    compiled_at: string;
    candidate_limit: number;
    continuity_candidate_limit: number;
    learning_candidate_limit: number;
    selected_capsule_limit: number;
    obligation_limit: number;
    render_budget: number;
    candidate_retrieval_receipt: ContinuationCandidateRetrievalReceiptV1;
  }>;
  contract_sha256: Sha256;
}>;

export type CanonicalJson = null | boolean | string | number | readonly CanonicalJson[] | {
  readonly [key: string]: CanonicalJson;
};

const MAX_CANONICAL_ARRAY_LENGTH = 1_000_000;

export function assertUnicodeScalarString(value: string, field = "string"): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${field} must contain only Unicode scalar values`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${field} must contain only Unicode scalar values`);
    }
  }
}

export function compareCanonicalUtf8(left: string, right: string): number {
  assertUnicodeScalarString(left, "canonical comparison value");
  assertUnicodeScalarString(right, "canonical comparison value");
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalUniqueSet<T>(values: readonly T[], key: (value: T) => string): T[] {
  const sorted = [...values].sort((left, right) => compareCanonicalUtf8(key(left), key(right)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index - 1]!) === key(sorted[index]!)) {
      throw new Error("canonical set contains a duplicate key");
    }
  }
  return sorted;
}

export function canonicalContinuationJson(value: unknown, maxDepth = 48): string {
  const active = new WeakSet<object>();
  const encode = (current: unknown, depth: number): string => {
    if (depth > maxDepth) throw new Error(`canonical JSON exceeds max depth ${maxDepth}`);
    if (current === null || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "string") {
      assertUnicodeScalarString(current, "canonical JSON string");
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw new Error("canonical JSON numbers must be safe integers and must not be negative zero");
      }
      return JSON.stringify(current);
    }
    if (typeof current !== "object") throw new Error("canonical JSON contains a non-JSON value");
    if (active.has(current)) throw new Error("canonical JSON contains a cycle");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype
          || !Number.isSafeInteger(current.length)
          || current.length > MAX_CANONICAL_ARRAY_LENGTH) {
          throw new Error("canonical JSON arrays must be bounded plain arrays");
        }
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.length !== current.length + 1
          || ownKeys.some((key) => typeof key !== "string")) {
          throw new Error(
            "canonical JSON arrays must be dense and contain no extra properties",
          );
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        if (!lengthDescriptor || lengthDescriptor.enumerable
          || !("value" in lengthDescriptor)
          || lengthDescriptor.value !== current.length) {
          throw new Error("canonical JSON arrays must have a canonical length property");
        }
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(
              "canonical JSON arrays must contain only enumerable data elements",
            );
          }
          items.push(encode(descriptor.value, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("canonical JSON objects must be plain records");
      }
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record);
      keys.forEach((key) => assertUnicodeScalarString(key, "canonical JSON object key"));
      keys.sort(compareCanonicalUtf8);
      if (Reflect.ownKeys(current).length !== keys.length) {
        throw new Error("canonical JSON objects must contain only enumerable string keys");
      }
      return `{${keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("canonical JSON objects must not contain accessors");
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    } finally {
      active.delete(current);
    }
  };
  return encode(value, 0);
}

export function canonicalContinuationSha256(value: unknown): Sha256 {
  return sha256Hex(canonicalContinuationJson(value));
}

/**
 * Takes an authority-shaped value out of caller-owned memory. The canonical
 * round trip both strips object identity and gives the returned graph the same
 * byte representation that its digest authenticates. Deep freezing then makes
 * the runtime "immutable" contract true at runtime, not only in TypeScript.
 */
export function canonicalContinuationClone<T>(value: T): T {
  const cloned = JSON.parse(canonicalContinuationJson(value)) as T;
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(cloned);
  return cloned;
}

export function canonicalSha256Without(
  value: Readonly<Record<string, unknown>>,
  digestField: string,
): Sha256 {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("canonical digest source must be a plain record");
  }
  const keys = Reflect.ownKeys(value);
  if (!keys.includes(digestField)) throw new Error(`missing digest field ${digestField}`);
  const body = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new Error("canonical digest source must contain only string keys");
    }
    assertUnicodeScalarString(key, "canonical digest key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("canonical digest source must contain only enumerable data properties");
    }
    if (key !== digestField) body[key] = descriptor.value;
  }
  // Validate the complete source as well as the omitted-field body without
  // invoking accessors or silently discarding hidden authority fields.
  canonicalContinuationJson(value);
  return canonicalContinuationSha256(body);
}

export function assertSha256(value: string, field = "digest"): asserts value is Sha256 {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
}

export function assertCanonicalUtcMillis(value: string, field = "timestamp"): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC millisecond timestamp`);
  }
}
