import {
  assertCanonicalUtcMillis,
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  compareCanonicalUtf8,
  type AuthorityBranchRefV1,
  type CandidateRetrievalLaneSummaryV1,
  type CandidateRetrievalLaneV1,
  type CandidateRetrievalOverflowReasonV1,
  type CandidateRetrievalSourceLaneSummaryV1,
  type CapsuleRefV1,
  type ContinuationCandidateRetrievalReceiptV1,
  type ContinuationContractV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
  type Sha256,
} from "./contract.js";
import {
  verifyContinuationCompilerPolicyV1,
  type ContinuationCompilerPolicyV1,
} from "./compiler-policy.js";
import { assertExecutionCapsuleV1 } from "./validation.js";
import { continuationAuthoritySubjectSha256V1 } from
  "./task-envelope.js";

export const CONTINUATION_CANDIDATE_SOURCE_LIMIT_V1 = 4_096;
export const CONTINUATION_CANDIDATE_SOURCE_BYTES_LIMIT_V1 =
  64 * 1_024 * 1_024;

export const CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1 =
  canonicalContinuationSha256({
    algorithm: "deterministic_lane_bounded_candidate_retrieval_v1",
    version: 1,
    maximum_source_candidates: CONTINUATION_CANDIDATE_SOURCE_LIMIT_V1,
    maximum_source_bytes: CONTINUATION_CANDIDATE_SOURCE_BYTES_LIMIT_V1,
    invariants: [
      "ann_is_upstream_advisory_only_and_never_a_serving_rank",
      "exact_obligation_claim_matching_only",
      "continuity_and_learning_have_root_signed_disjoint_limits",
      "continuity_selection_has_no_learning_lane_dependency",
      "hard_coverage_and_safety_seeds_are_protected",
      "relationship_components_are_transitively_closed_within_one_lane",
      "protected_overflow_fails_closed_without_trimming",
      "cross_lane_mandatory_safety_respects_signed_selected_capsule_limit",
      "advisory_order_is_coverage_authority_freshness_utf8_digest",
    ],
  });

export type {
  CandidateRetrievalLaneSummaryV1,
  CandidateRetrievalSourceLaneSummaryV1,
  ContinuationCandidateRetrievalReceiptV1,
} from "./contract.js";

type LaneV1 = CandidateRetrievalLaneV1;
type OverflowReasonV1 = CandidateRetrievalOverflowReasonV1;

export type ContinuationCompilerCandidateV1 = Readonly<{
  capsule: ExecutionCapsuleV1;
  provenance:
    | Readonly<{
      lane: "governed_learning";
      branch_binding: Readonly<{
        branch_ref: AuthorityBranchRefV1;
        capsule: CapsuleRefV1;
        disposition: "include" | "exclude" | "prohibit";
        admission_authority: "candidate" | "authoritative";
        binding_sha256: Sha256;
      }>;
    }>
    | Readonly<{
      lane: "verified_continuity";
      continuity_binding: Readonly<{
        capsule: CapsuleRefV1;
        disposition: "include" | "prohibit";
        admission_authority: "verified" | "authoritative";
        memory_id: string;
        capsule_source_commit_id: string;
        memory_scope_head_revision: number;
        memory_scope_head_sha256: Sha256;
        binding_sha256: Sha256;
      }>;
    }>;
  lifecycle_fact: Readonly<{
    memory_id: string;
    lifecycle_source_commit_id: string;
    memory_projection_sha256: Sha256;
    lifecycle: "active" | "suppressed" | "archived" | "quarantined";
    memory_scope_head_revision: number;
    memory_scope_head_sha256: Sha256;
    row_sha256: Sha256;
  }>;
}>;

export type ContinuationCandidateRetrievalResultV1 =
  | Readonly<{
    status: "selected";
    candidates: readonly ContinuationCompilerCandidateV1[];
    receipt: ContinuationCandidateRetrievalReceiptV1;
  }>
  | Readonly<{
    status: "protected_overflow";
    overflow_lanes: readonly LaneV1[];
    overflow_reasons: readonly OverflowReasonV1[];
    candidates: readonly [];
    receipt: ContinuationCandidateRetrievalReceiptV1;
  }>;

export type RetrieveContinuationCandidatesV1Args = Readonly<{
  schema_version: "continuation_candidate_retrieval_input_v1";
  identity: ContinuationContractV1["identity"];
  obligations: readonly ContinuationObligationV1[];
  candidates: readonly ContinuationCompilerCandidateV1[];
  evaluated_at: string;
  policy: ContinuationCompilerPolicyV1;
}>;

export type ContinuationCandidateRetrievalErrorCodeV1 =
  | "input_shape_invalid"
  | "identity_invalid"
  | "obligation_invalid"
  | "candidate_invalid"
  | "candidate_universe_too_large"
  | "candidate_identity_conflict"
  | "relationship_ref_unresolved"
  | "cross_lane_relationship"
  | "policy_binding_invalid"
  | "receipt_invalid";

export class ContinuationCandidateRetrievalErrorV1 extends Error {
  readonly code: ContinuationCandidateRetrievalErrorCodeV1;

  constructor(code: ContinuationCandidateRetrievalErrorCodeV1, detail: string) {
    super(`continuation_candidate_retrieval_${code}: ${detail}`);
    this.name = "ContinuationCandidateRetrievalErrorV1";
    this.code = code;
  }
}

const INPUT_KEYS = Object.freeze([
  "candidates", "evaluated_at", "identity", "obligations", "policy", "schema_version",
] as const);
const IDENTITY_KEYS = Object.freeze([
  "collection_principal_sha256", "consumer_agent_id", "consumer_team_id", "decision_id",
  "episode_id", "host_task_envelope_sha256", "host_task_id", "run_id", "scope",
  "source_event_sha256", "source_task_sha256", "task_family", "task_signature", "tenant_id",
  "workflow_signature", "workspace_signature", "world_snapshot_id", "world_snapshot_sha256",
] as const);
const OBLIGATION_KEYS = Object.freeze([
  "evidence_requirement", "kind", "obligation_id", "required_probe_ids", "requirement",
  "source_refs", "statement", "target_refs",
] as const);
const TARGET_KEYS = Object.freeze(["kind", "ref"] as const);
const CANDIDATE_KEYS = Object.freeze(["capsule", "lifecycle_fact", "provenance"] as const);
const PROVENANCE_KEYS = Object.freeze([
  "continuity_binding", "lane",
] as const);
const LEARNING_PROVENANCE_KEYS = Object.freeze(["branch_binding", "lane"] as const);
const CONTINUITY_BINDING_KEYS = Object.freeze([
  "admission_authority", "binding_sha256", "capsule", "capsule_source_commit_id",
  "disposition", "memory_id", "memory_scope_head_revision", "memory_scope_head_sha256",
] as const);
const LEARNING_BINDING_KEYS = Object.freeze([
  "admission_authority", "binding_sha256", "branch_ref", "capsule", "disposition",
] as const);
const LIFECYCLE_KEYS = Object.freeze([
  "lifecycle", "lifecycle_source_commit_id", "memory_id", "memory_projection_sha256",
  "memory_scope_head_revision", "memory_scope_head_sha256", "row_sha256",
] as const);
const OBLIGATION_KINDS = new Set<unknown>([
  "active_goal", "required_state", "next_action", "must_hold", "prohibition", "verification",
]);
const OBLIGATION_REQUIREMENTS = new Set<unknown>(["hard", "advisory"]);
const EVIDENCE_REQUIREMENTS = new Set<unknown>([
  "runtime_state", "trusted_host", "external_verifier",
]);
const TARGET_KINDS = new Set<unknown>([
  "artifact", "service", "capability", "memory", "workflow", "external_resource",
]);

function fail(
  code: ContinuationCandidateRetrievalErrorCodeV1,
  detail: string,
): never {
  throw new ContinuationCandidateRetrievalErrorV1(code, detail);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: ContinuationCandidateRetrievalErrorCodeV1,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${field} must be a plain exact record`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(code, `${field} contains unknown or missing fields`);
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(code, `${field} must contain only enumerable data properties`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function exactArray(
  value: unknown,
  maximum: number,
  code: ContinuationCandidateRetrievalErrorCodeV1,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) fail(code, `${field} must be a bounded plain array`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1
    || ownKeys.some((key) => typeof key !== "string")) {
    fail(code, `${field} must be dense without extra fields`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(code, `${field} must contain only enumerable data elements`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function canonicalText(
  value: unknown,
  code: ContinuationCandidateRetrievalErrorCodeV1,
  field: string,
  maximum = 1_024,
): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) {
    fail(code, `${field} must be canonical bounded text`);
  }
  return value;
}

function sha(value: unknown, code: ContinuationCandidateRetrievalErrorCodeV1, field: string): Sha256 {
  if (typeof value !== "string") fail(code, `${field} must be a SHA-256 digest`);
  try {
    assertSha256(value, field);
  } catch {
    fail(code, `${field} must be a SHA-256 digest`);
  }
  return value;
}

function parseIdentity(value: unknown): ContinuationContractV1["identity"] {
  const record = exactRecord(value, IDENTITY_KEYS, "identity_invalid", "identity");
  const nullableText = (field: "consumer_agent_id" | "consumer_team_id" | "workflow_signature") =>
    record[field] === null
      ? null
      : canonicalText(record[field], "identity_invalid", `identity.${field}`, 256);
  const textFields = [
    "decision_id", "tenant_id", "scope", "episode_id", "run_id", "host_task_id",
    "task_family", "task_signature", "workspace_signature", "world_snapshot_id",
  ] as const;
  const shaFields = [
    "host_task_envelope_sha256", "collection_principal_sha256", "source_task_sha256",
    "source_event_sha256", "world_snapshot_sha256",
  ] as const;
  return canonicalContinuationClone({
    ...Object.fromEntries(textFields.map((field) => [
      field, canonicalText(record[field], "identity_invalid", `identity.${field}`, 256),
    ])),
    ...Object.fromEntries(shaFields.map((field) => [
      field, sha(record[field], "identity_invalid", `identity.${field}`),
    ])),
    consumer_agent_id: nullableText("consumer_agent_id"),
    consumer_team_id: nullableText("consumer_team_id"),
    workflow_signature: nullableText("workflow_signature"),
  }) as ContinuationContractV1["identity"];
}

function parseObligations(value: unknown, limit: number): readonly ContinuationObligationV1[] {
  const input = exactArray(value, limit, "obligation_invalid", "obligations");
  const seen = new Set<string>();
  const parsed = input.map((entry, index) => {
    const record = exactRecord(entry, OBLIGATION_KEYS, "obligation_invalid", `obligations[${index}]`);
    const obligationId = canonicalText(
      record.obligation_id,
      "obligation_invalid",
      "obligation_id",
      256,
    );
    if (seen.has(obligationId)) fail("obligation_invalid", "duplicate obligation_id");
    seen.add(obligationId);
    if (!OBLIGATION_KINDS.has(record.kind)
      || !OBLIGATION_REQUIREMENTS.has(record.requirement)
      || !EVIDENCE_REQUIREMENTS.has(record.evidence_requirement)) {
      fail("obligation_invalid", "obligation enum value is invalid");
    }
    const targets = exactArray(
      record.target_refs,
      16,
      "obligation_invalid",
      "obligation.target_refs",
    ).map((target) => {
      const targetRecord = exactRecord(
        target,
        TARGET_KEYS,
        "obligation_invalid",
        "obligation.target_ref",
      );
      if (!TARGET_KINDS.has(targetRecord.kind)) {
        fail("obligation_invalid", "obligation target kind is invalid");
      }
      return {
        kind: targetRecord.kind,
        ref: canonicalText(
          targetRecord.ref,
          "obligation_invalid",
          "obligation.target_ref",
          1_024,
        ),
      } as ContinuationObligationV1["target_refs"][number];
    });
    if (targets.length === 0) fail("obligation_invalid", "target_refs cannot be empty");
    const stringSet = (inputValue: unknown, maximum: number, field: string) => {
      const strings = exactArray(inputValue, maximum, "obligation_invalid", field)
        .map((item) => canonicalText(item, "obligation_invalid", field, 256));
      if (new Set(strings).size !== strings.length) fail("obligation_invalid", `${field} is not a set`);
      return [...strings].sort(compareCanonicalUtf8);
    };
    const targetKeys = targets.map((target) => `${target.kind}\0${target.ref}`);
    if (new Set(targetKeys).size !== targets.length) {
      fail("obligation_invalid", "target_refs is not a set");
    }
    return {
      obligation_id: obligationId,
      kind: record.kind,
      requirement: record.requirement,
      statement: canonicalText(
        record.statement,
        "obligation_invalid",
        "obligation.statement",
        1_024,
      ),
      target_refs: [...targets].sort((left, right) => compareCanonicalUtf8(
        `${left.kind}\0${left.ref}`,
        `${right.kind}\0${right.ref}`,
      )),
      required_probe_ids: stringSet(record.required_probe_ids, 16, "required_probe_ids"),
      evidence_requirement: record.evidence_requirement,
      source_refs: stringSet(record.source_refs, 32, "source_refs"),
    } as ContinuationObligationV1;
  });
  return canonicalContinuationClone(parsed.sort((left, right) =>
    compareCanonicalUtf8(left.obligation_id, right.obligation_id)));
}

function capsuleRef(candidate: ContinuationCompilerCandidateV1): CapsuleRefV1 {
  return {
    capsule_id: candidate.capsule.capsule_id,
    capsule_revision: candidate.capsule.capsule_revision,
    capsule_sha256: candidate.capsule.capsule_sha256,
  };
}

function refKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision.toString().padStart(16, "0")}\0${ref.capsule_sha256}`;
}

function binding(candidate: ContinuationCompilerCandidateV1) {
  return candidate.provenance.lane === "verified_continuity"
    ? candidate.provenance.continuity_binding
    : candidate.provenance.branch_binding;
}

function parseCandidate(value: unknown, index: number): ContinuationCompilerCandidateV1 {
  const record = exactRecord(value, CANDIDATE_KEYS, "candidate_invalid", `candidates[${index}]`);
  try {
    assertExecutionCapsuleV1(record.capsule);
  } catch {
    fail("candidate_invalid", `candidates[${index}].capsule is invalid`);
  }
  const capsule = record.capsule;
  if (canonicalSha256Without(capsule, "capsule_sha256") !== capsule.capsule_sha256
    || canonicalSha256Without(capsule.projection, "projection_sha256")
      !== capsule.projection.projection_sha256
    || capsule.coverage_claims.some((claim) =>
      canonicalSha256Without(claim, "coverage_claim_sha256") !== claim.coverage_claim_sha256)) {
    fail("candidate_invalid", `candidates[${index}] capsule digest mismatch`);
  }
  const provenanceRecord = record.provenance as Readonly<Record<string, unknown>>;
  const lane = provenanceRecord?.lane;
  const expectedKeys = lane === "verified_continuity"
    ? PROVENANCE_KEYS
    : lane === "governed_learning" ? LEARNING_PROVENANCE_KEYS : [];
  const provenance = exactRecord(
    record.provenance,
    expectedKeys,
    "candidate_invalid",
    `candidates[${index}].provenance`,
  );
  const bindingRecord = exactRecord(
    lane === "verified_continuity" ? provenance.continuity_binding : provenance.branch_binding,
    lane === "verified_continuity" ? CONTINUITY_BINDING_KEYS : LEARNING_BINDING_KEYS,
    "candidate_invalid",
    `candidates[${index}].binding`,
  );
  const lifecycle = exactRecord(
    record.lifecycle_fact,
    LIFECYCLE_KEYS,
    "candidate_invalid",
    `candidates[${index}].lifecycle_fact`,
  );
  const parsed = canonicalContinuationClone(record) as ContinuationCompilerCandidateV1;
  const expectedRef = canonicalContinuationJson(capsuleRef(parsed));
  if (canonicalContinuationJson(bindingRecord.capsule) !== expectedRef
    || canonicalSha256Without(bindingRecord, "binding_sha256") !== bindingRecord.binding_sha256
    || canonicalSha256Without(lifecycle, "row_sha256") !== lifecycle.row_sha256
    || lifecycle.memory_id !== capsule.source.memory_id
    || lifecycle.memory_projection_sha256 !== capsule.source.source_projection_sha256) {
    fail("candidate_invalid", `candidates[${index}] authority binding digest mismatch`);
  }
  if ((lane === "verified_continuity" && ![
    "current_state", "verified_fact", "constraint",
  ].includes(capsule.kind))
    || (lane === "governed_learning" && ![
      "procedure", "counter_evidence",
    ].includes(capsule.kind))) {
    fail("candidate_invalid", `candidates[${index}] kind is invalid for its lane`);
  }
  return parsed;
}

function claimMatches(
  claim: ContinuationCompilerCandidateV1["capsule"]["coverage_claims"][number],
  obligation: ContinuationObligationV1,
): boolean {
  return claim.obligation_kind === obligation.kind
    && claim.evidence_requirement === obligation.evidence_requirement
    && canonicalContinuationJson(claim.target_refs) === canonicalContinuationJson(obligation.target_refs)
    && canonicalContinuationJson(claim.required_probe_ids)
      === canonicalContinuationJson(obligation.required_probe_ids);
}

function isIdentityApplicable(
  candidate: ContinuationCompilerCandidateV1,
  identity: ContinuationContractV1["identity"],
  evaluatedAt: string,
): boolean {
  const value = candidate.capsule.applicability;
  return value.tenant_id === identity.tenant_id
    && value.scope === identity.scope
    && value.task_family === identity.task_family
    && (value.task_signature === null || value.task_signature === identity.task_signature)
    && (value.workflow_signature === null || value.workflow_signature === identity.workflow_signature)
    && (value.workspace_signature === null || value.workspace_signature === identity.workspace_signature)
    && (value.owner_agent_id === null || value.owner_agent_id === identity.consumer_agent_id)
    && (value.owner_team_id === null || value.owner_team_id === identity.consumer_team_id)
    && (candidate.capsule.expires_at === null
      || Date.parse(candidate.capsule.expires_at) > Date.parse(evaluatedAt));
}

function authorityRank(candidate: ContinuationCompilerCandidateV1): number {
  const authority = binding(candidate).admission_authority;
  return authority === "authoritative" ? 2 : authority === "verified" ? 1 : 0;
}

function laneLimit(lane: LaneV1, policy: ContinuationCompilerPolicyV1): number {
  return lane === "verified_continuity"
    ? policy.continuity_candidate_limit
    : policy.learning_candidate_limit;
}

function sortedRefs(candidates: readonly ContinuationCompilerCandidateV1[]): readonly CapsuleRefV1[] {
  return candidates.map(capsuleRef).sort((left, right) =>
    compareCanonicalUtf8(refKey(left), refKey(right)));
}

function refSummary(candidates: readonly ContinuationCompilerCandidateV1[]): CandidateRetrievalLaneSummaryV1 {
  const refs = sortedRefs(candidates);
  return {
    count: refs.length,
    ref_set_sha256: canonicalContinuationSha256({ capsule_refs: refs }),
  };
}

function sourceSummary(
  candidates: readonly ContinuationCompilerCandidateV1[],
): CandidateRetrievalSourceLaneSummaryV1 {
  const entries = candidates.map((candidate) => ({
    capsule: capsuleRef(candidate),
    candidate_sha256: canonicalContinuationSha256(candidate),
  })).sort((left, right) => compareCanonicalUtf8(refKey(left.capsule), refKey(right.capsule)));
  return {
    ...refSummary(candidates),
    candidate_universe_sha256: canonicalContinuationSha256({ candidates: entries }),
  };
}

function makeReceipt(args: Readonly<{
  identity: ContinuationContractV1["identity"];
  obligations: readonly ContinuationObligationV1[];
  policy: ContinuationCompilerPolicyV1;
  evaluated_at: string;
  source: readonly ContinuationCompilerCandidateV1[];
  protectedSet: ReadonlySet<string>;
  mandatorySet: ReadonlySet<string>;
  selectedSet: ReadonlySet<string>;
  overflowLanes: readonly LaneV1[];
  mandatoryOverflow: boolean;
}>): ContinuationCandidateRetrievalReceiptV1 {
  const forLane = (lane: LaneV1, predicate: (key: string) => boolean) =>
    args.source.filter((candidate) => candidate.provenance.lane === lane
      && predicate(refKey(capsuleRef(candidate))));
  const continuity = args.source.filter((candidate) =>
    candidate.provenance.lane === "verified_continuity");
  const learning = args.source.filter((candidate) =>
    candidate.provenance.lane === "governed_learning");
  const hasOverflow = args.overflowLanes.length > 0 || args.mandatoryOverflow;
  const selectedSet = hasOverflow ? new Set<string>() : args.selectedSet;
  const overflowReasons = [
    ...args.overflowLanes.map((lane) =>
      `${lane}_protected_limit_exceeded` as OverflowReasonV1),
    ...(args.mandatoryOverflow
      ? ["selected_capsule_protected_limit_exceeded" as const]
      : []),
  ].sort(compareCanonicalUtf8);
  const body = {
    schema_version: "continuation_candidate_retrieval_receipt_v1" as const,
    algorithm_contract_sha256: CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1,
    identity_sha256: canonicalContinuationSha256(args.identity),
    obligation_universe_sha256: canonicalContinuationSha256({ obligations: args.obligations }),
    compiler_policy_payload_sha256: canonicalContinuationSha256(args.policy),
    compiler_candidate_universe_sha256: canonicalContinuationSha256(
      !hasOverflow
        ? args.source.filter((candidate) => selectedSet.has(refKey(capsuleRef(candidate))))
        : [],
    ),
    lane_limits: {
      verified_continuity: args.policy.continuity_candidate_limit,
      governed_learning: args.policy.learning_candidate_limit,
    },
    selected_capsule_limit: args.policy.selected_capsule_limit,
    evaluated_at: args.evaluated_at,
    source_universe: {
      candidate_count: args.source.length,
      candidate_universe_sha256: canonicalContinuationSha256({
        candidates: args.source.map((candidate) => ({
          capsule: capsuleRef(candidate),
          candidate_sha256: canonicalContinuationSha256(candidate),
        })).sort((left, right) => compareCanonicalUtf8(
          refKey(left.capsule),
          refKey(right.capsule),
        )),
      }),
      verified_continuity: sourceSummary(continuity),
      governed_learning: sourceSummary(learning),
    },
    protected: {
      verified_continuity: refSummary(forLane("verified_continuity", (key) =>
        args.protectedSet.has(key))),
      governed_learning: refSummary(forLane("governed_learning", (key) =>
        args.protectedSet.has(key))),
    },
    mandatory_protected: refSummary(args.source.filter((candidate) =>
      args.mandatorySet.has(refKey(capsuleRef(candidate))))),
    selected: {
      verified_continuity: refSummary(forLane("verified_continuity", (key) =>
        selectedSet.has(key))),
      governed_learning: refSummary(forLane("governed_learning", (key) =>
        selectedSet.has(key))),
    },
    omitted: {
      verified_continuity: refSummary(forLane("verified_continuity", (key) =>
        !selectedSet.has(key))),
      governed_learning: refSummary(forLane("governed_learning", (key) =>
        !selectedSet.has(key))),
    },
    overflow_status: !hasOverflow
      ? "none" as const
      : args.mandatoryOverflow && args.overflowLanes.length > 0
        ? "multiple_protected_overflow" as const
        : args.mandatoryOverflow
          ? "selected_capsule_protected_overflow" as const
          : args.overflowLanes.length === 2
        ? "both_lanes_protected_overflow" as const
        : args.overflowLanes[0] === "verified_continuity"
          ? "verified_continuity_protected_overflow" as const
          : "governed_learning_protected_overflow" as const,
    overflow_reasons: overflowReasons,
  };
  return canonicalContinuationClone({
    ...body,
    receipt_sha256: canonicalContinuationSha256(body),
  });
}

/**
 * Bounds a materialized universe before compilation. ANN may decide which
 * records arrive upstream, but no ANN score or order is accepted by this API.
 */
export function retrieveContinuationCandidatesV1(
  raw: RetrieveContinuationCandidatesV1Args,
): ContinuationCandidateRetrievalResultV1 {
  const input = exactRecord(raw, INPUT_KEYS, "input_shape_invalid", "input");
  if (input.schema_version !== "continuation_candidate_retrieval_input_v1") {
    fail("input_shape_invalid", "schema_version is invalid");
  }
  let policy: ContinuationCompilerPolicyV1;
  try {
    policy = verifyContinuationCompilerPolicyV1(input.policy);
  } catch {
    fail("policy_binding_invalid", "compiler policy is invalid");
  }
  const identity = parseIdentity(input.identity);
  if (policy.tenant_id !== identity.tenant_id) {
    fail("policy_binding_invalid", "policy tenant does not match identity");
  }
  const expectedAuthoritySubject = continuationAuthoritySubjectSha256V1({
    tenant_id: identity.tenant_id,
    scope: identity.scope,
    task_family: identity.task_family,
  });
  if (policy.authority_subject_sha256 !== null
    && policy.authority_subject_sha256 !== expectedAuthoritySubject) {
    fail("policy_binding_invalid", "policy authority subject does not match identity");
  }
  try {
    if (typeof input.evaluated_at !== "string") throw new Error("invalid");
    assertCanonicalUtcMillis(input.evaluated_at, "evaluated_at");
  } catch {
    fail("input_shape_invalid", "evaluated_at must be canonical UTC milliseconds");
  }
  const obligations = parseObligations(input.obligations, policy.obligation_limit);
  const sourceInput = exactArray(
    input.candidates,
    CONTINUATION_CANDIDATE_SOURCE_LIMIT_V1,
    "candidate_universe_too_large",
    "candidates",
  );
  if (Buffer.byteLength(canonicalContinuationJson(sourceInput), "utf8")
      > CONTINUATION_CANDIDATE_SOURCE_BYTES_LIMIT_V1) {
    fail("candidate_universe_too_large", "candidate universe exceeds 64 MiB");
  }
  const source = sourceInput.map(parseCandidate).sort((left, right) =>
    compareCanonicalUtf8(refKey(capsuleRef(left)), refKey(capsuleRef(right))));
  const byRef = new Map<string, ContinuationCompilerCandidateV1>();
  const candidateDigests = new Map<string, Sha256>();
  const capsuleIds = new Set<string>();
  for (const candidate of source) {
    const key = refKey(capsuleRef(candidate));
    if (byRef.has(key) || capsuleIds.has(candidate.capsule.capsule_id)) {
      fail("candidate_identity_conflict", "candidate refs and capsule ids must be unique");
    }
    byRef.set(key, candidate);
    candidateDigests.set(key, canonicalContinuationSha256(candidate));
    capsuleIds.add(candidate.capsule.capsule_id);
    if (Date.parse(candidate.capsule.created_at) > Date.parse(input.evaluated_at as string)) {
      fail("candidate_invalid", "candidate cannot be created after evaluated_at");
    }
  }
  const adjacency = new Map<string, Set<string>>(
    [...byRef.keys()].map((key) => [key, new Set<string>()]),
  );
  for (const [key, candidate] of byRef) {
    for (const relatedRef of [
      ...candidate.capsule.conflicts_with,
      ...candidate.capsule.supersedes,
    ]) {
      const relatedKey = refKey(relatedRef);
      const related = byRef.get(relatedKey);
      if (!related) fail("relationship_ref_unresolved", `relationship from ${key} is unresolved`);
      if (related.provenance.lane !== candidate.provenance.lane) {
        fail("cross_lane_relationship", "relationships cannot cross serving lanes");
      }
      adjacency.get(key)!.add(relatedKey);
      adjacency.get(relatedKey)!.add(key);
    }
  }
  const componentCache = new Map<string, readonly string[]>();
  const component = (seed: string): readonly string[] => {
    const cached = componentCache.get(seed);
    if (cached) return cached;
    const visited = new Set<string>();
    const queue = [seed];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of adjacency.get(current) ?? []) queue.push(neighbor);
    }
    const result = [...visited].sort(compareCanonicalUtf8);
    for (const key of result) componentCache.set(key, result);
    return result;
  };
  const exactCoverage = new Map<string, readonly ContinuationObligationV1[]>();
  const applicable = new Set<string>();
  const auditOnly = new Set<string>();
  const protectedSeeds = new Set<string>();
  const mandatorySeeds = new Set<string>();
  for (const [key, candidate] of byRef) {
    const matches = obligations.filter((obligation) =>
      candidate.capsule.coverage_claims.some((claim) => claimMatches(claim, obligation)));
    exactCoverage.set(key, matches);
    if (!isIdentityApplicable(candidate, identity, input.evaluated_at as string)
      || matches.length === 0) {
      continue;
    }
    if (candidate.lifecycle_fact.lifecycle !== "active"
      || binding(candidate).disposition === "exclude") {
      auditOnly.add(key);
      continue;
    }
    applicable.add(key);
    if (matches.some((obligation) => obligation.requirement === "hard")
      || binding(candidate).disposition === "prohibit"
      || candidate.capsule.kind === "constraint"
      || candidate.capsule.kind === "counter_evidence") {
      protectedSeeds.add(key);
    }
    if (binding(candidate).disposition === "prohibit"
      || candidate.capsule.kind === "constraint"
      || candidate.capsule.kind === "counter_evidence"
      || candidate.capsule.proposed_influence === "block") {
      mandatorySeeds.add(key);
    }
  }
  const protectedSet = new Set<string>();
  for (const key of protectedSeeds) {
    for (const member of component(key)) protectedSet.add(member);
  }
  const mandatorySet = new Set<string>();
  for (const key of mandatorySeeds) {
    for (const member of component(key)) mandatorySet.add(member);
  }
  const overflowLanes = (["verified_continuity", "governed_learning"] as const)
    .filter((lane) => [...protectedSet].filter((key) =>
      byRef.get(key)!.provenance.lane === lane).length > laneLimit(lane, policy));
  const mandatoryOverflow = mandatorySet.size > policy.selected_capsule_limit;
  const selected = new Set(protectedSet);
  if (overflowLanes.length === 0 && !mandatoryOverflow) {
    for (const lane of ["verified_continuity", "governed_learning"] as const) {
      const coveredObligationIds = new Set(
        [...selected].flatMap((key) => applicable.has(key)
          ? exactCoverage.get(key)!.map((item) => item.obligation_id)
          : []),
      );
      const remaining = new Set([...applicable].filter((key) =>
        byRef.get(key)!.provenance.lane === lane && !selected.has(key)));
      while (remaining.size > 0) {
        const compareRank = (leftKey: string, rightKey: string) => {
          const left = byRef.get(leftKey)!;
          const right = byRef.get(rightKey)!;
          const leftMarginal = exactCoverage.get(leftKey)!.filter((item) =>
            !coveredObligationIds.has(item.obligation_id)).length;
          const rightMarginal = exactCoverage.get(rightKey)!.filter((item) =>
            !coveredObligationIds.has(item.obligation_id)).length;
          const coverageDelta = rightMarginal - leftMarginal;
          if (coverageDelta !== 0) return coverageDelta;
          const authorityDelta = authorityRank(right) - authorityRank(left);
          if (authorityDelta !== 0) return authorityDelta;
          const freshnessDelta = Date.parse(right.capsule.created_at)
            - Date.parse(left.capsule.created_at);
          if (freshnessDelta !== 0) return freshnessDelta;
          return compareCanonicalUtf8(
            candidateDigests.get(leftKey)!,
            candidateDigests.get(rightKey)!,
          );
        };
        let seed: string | null = null;
        for (const key of remaining) {
          if (seed === null || compareRank(key, seed) < 0) seed = key;
        }
        if (seed === null) break;
        remaining.delete(seed);
        if (selected.has(seed)) continue;
        const additions = component(seed).filter((key) => !selected.has(key));
        const laneSelected = [...selected].filter((key) =>
          byRef.get(key)!.provenance.lane === lane).length;
        if (laneSelected + additions.length <= laneLimit(lane, policy)) {
          additions.forEach((key) => {
            selected.add(key);
            remaining.delete(key);
            if (applicable.has(key)) {
              exactCoverage.get(key)!.forEach((item) =>
                coveredObligationIds.add(item.obligation_id));
            }
          });
        }
      }
      const auditRanked = [...auditOnly]
        .filter((key) => byRef.get(key)!.provenance.lane === lane && !selected.has(key))
        .sort((left, right) => {
          const coverageDelta = exactCoverage.get(right)!.length
            - exactCoverage.get(left)!.length;
          if (coverageDelta !== 0) return coverageDelta;
          const authorityDelta = authorityRank(byRef.get(right)!)
            - authorityRank(byRef.get(left)!);
          if (authorityDelta !== 0) return authorityDelta;
          const freshnessDelta = Date.parse(byRef.get(right)!.capsule.created_at)
            - Date.parse(byRef.get(left)!.capsule.created_at);
          if (freshnessDelta !== 0) return freshnessDelta;
          return compareCanonicalUtf8(
            candidateDigests.get(left)!,
            candidateDigests.get(right)!,
          );
        });
      for (const seed of auditRanked) {
        if (selected.has(seed)) continue;
        const additions = component(seed).filter((key) => !selected.has(key));
        const laneSelected = [...selected].filter((key) =>
          byRef.get(key)!.provenance.lane === lane).length;
        if (laneSelected + additions.length <= laneLimit(lane, policy)) {
          additions.forEach((key) => selected.add(key));
        }
      }
    }
  }
  const receipt = makeReceipt({
    identity,
    obligations,
    policy,
    evaluated_at: input.evaluated_at as string,
    source,
    protectedSet,
    mandatorySet,
    selectedSet: selected,
    overflowLanes,
    mandatoryOverflow,
  });
  if (overflowLanes.length > 0 || mandatoryOverflow) {
    return canonicalContinuationClone({
      status: "protected_overflow" as const,
      overflow_lanes: overflowLanes,
      overflow_reasons: receipt.overflow_reasons,
      candidates: [] as const,
      receipt,
    });
  }
  return canonicalContinuationClone({
    status: "selected" as const,
    candidates: source.filter((candidate) => selected.has(refKey(capsuleRef(candidate)))),
    receipt,
  });
}

const RECEIPT_KEYS = Object.freeze([
  "algorithm_contract_sha256", "compiler_candidate_universe_sha256",
  "compiler_policy_payload_sha256", "evaluated_at",
  "identity_sha256", "lane_limits", "mandatory_protected", "obligation_universe_sha256",
  "omitted", "overflow_reasons", "overflow_status", "protected", "receipt_sha256",
  "schema_version", "selected", "selected_capsule_limit", "source_universe",
] as const);
const LANE_SUMMARY_KEYS = Object.freeze(["count", "ref_set_sha256"] as const);
const SOURCE_LANE_SUMMARY_KEYS = Object.freeze([
  "candidate_universe_sha256", "count", "ref_set_sha256",
] as const);

export function verifyContinuationCandidateRetrievalReceiptV1(
  value: unknown,
): ContinuationCandidateRetrievalReceiptV1 {
  const record = exactRecord(value, RECEIPT_KEYS, "receipt_invalid", "receipt");
  if (record.schema_version !== "continuation_candidate_retrieval_receipt_v1"
    || record.algorithm_contract_sha256
      !== CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1
    || !["none", "verified_continuity_protected_overflow",
      "governed_learning_protected_overflow", "both_lanes_protected_overflow",
      "selected_capsule_protected_overflow", "multiple_protected_overflow"]
      .includes(record.overflow_status as string)) {
    fail("receipt_invalid", "receipt discriminator is invalid");
  }
  const counts = Object.create(null) as Record<
    "protected" | "selected" | "omitted",
    Record<LaneV1, number>
  >;
  for (const [field, summaryValue] of [
    ["protected", record.protected],
    ["selected", record.selected],
    ["omitted", record.omitted],
  ] as const) {
    counts[field] = Object.create(null) as Record<LaneV1, number>;
    const lanes = exactRecord(
      summaryValue,
      ["governed_learning", "verified_continuity"],
      "receipt_invalid",
      field,
    );
    for (const lane of ["verified_continuity", "governed_learning"] as const) {
      const summary = exactRecord(
        lanes[lane],
        LANE_SUMMARY_KEYS,
        "receipt_invalid",
        `${field}.${lane}`,
      );
      if (!Number.isSafeInteger(summary.count) || (summary.count as number) < 0) {
        fail("receipt_invalid", `${field}.${lane}.count is invalid`);
      }
      counts[field][lane] = summary.count as number;
      const refSetSha = sha(
        summary.ref_set_sha256,
        "receipt_invalid",
        `${field}.${lane}.ref_set_sha256`,
      );
      if (summary.count === 0
        && refSetSha !== canonicalContinuationSha256({ capsule_refs: [] })) {
        fail("receipt_invalid", `${field}.${lane} empty ref-set digest is invalid`);
      }
    }
  }
  const mandatorySummary = exactRecord(
    record.mandatory_protected,
    LANE_SUMMARY_KEYS,
    "receipt_invalid",
    "mandatory_protected",
  );
  if (!Number.isSafeInteger(mandatorySummary.count)
    || (mandatorySummary.count as number) < 0) {
    fail("receipt_invalid", "mandatory protected count is invalid");
  }
  const mandatoryCount = mandatorySummary.count as number;
  const mandatoryRefSetSha = sha(
    mandatorySummary.ref_set_sha256,
    "receipt_invalid",
    "mandatory_protected.ref_set_sha256",
  );
  if (mandatoryCount === 0
    && mandatoryRefSetSha !== canonicalContinuationSha256({ capsule_refs: [] })) {
    fail("receipt_invalid", "mandatory protected empty ref-set digest is invalid");
  }
  const source = exactRecord(
    record.source_universe,
    ["candidate_count", "candidate_universe_sha256", "governed_learning", "verified_continuity"],
    "receipt_invalid",
    "source_universe",
  );
  if (!Number.isSafeInteger(source.candidate_count) || (source.candidate_count as number) < 0) {
    fail("receipt_invalid", "source candidate_count is invalid");
  }
  sha(source.candidate_universe_sha256, "receipt_invalid", "source candidate digest");
  const sourceCounts = Object.create(null) as Record<LaneV1, number>;
  for (const lane of ["verified_continuity", "governed_learning"] as const) {
    const summary = exactRecord(
      source[lane],
      SOURCE_LANE_SUMMARY_KEYS,
      "receipt_invalid",
      `source_universe.${lane}`,
    );
    if (!Number.isSafeInteger(summary.count) || (summary.count as number) < 0) {
      fail("receipt_invalid", `source_universe.${lane}.count is invalid`);
    }
    sourceCounts[lane] = summary.count as number;
    const sourceRefSetSha = sha(
      summary.ref_set_sha256,
      "receipt_invalid",
      `${lane}.ref_set_sha256`,
    );
    const sourceUniverseSha = sha(
      summary.candidate_universe_sha256,
      "receipt_invalid",
      `${lane}.candidate_universe_sha256`,
    );
    if (summary.count === 0 && (
      sourceRefSetSha !== canonicalContinuationSha256({ capsule_refs: [] })
      || sourceUniverseSha !== canonicalContinuationSha256({ candidates: [] })
    )) fail("receipt_invalid", `${lane} empty source digests are invalid`);
  }
  const limits = exactRecord(
    record.lane_limits,
    ["governed_learning", "verified_continuity"],
    "receipt_invalid",
    "lane_limits",
  );
  const laneLimits = Object.create(null) as Record<LaneV1, number>;
  for (const lane of ["verified_continuity", "governed_learning"] as const) {
    if (!Number.isSafeInteger(limits[lane])
      || (limits[lane] as number) < 1 || (limits[lane] as number) > 255) {
      fail("receipt_invalid", `lane_limits.${lane} is invalid`);
    }
    laneLimits[lane] = limits[lane] as number;
  }
  if (!Number.isSafeInteger(record.selected_capsule_limit)
    || (record.selected_capsule_limit as number) < 1
    || (record.selected_capsule_limit as number) > 64) {
    fail("receipt_invalid", "selected_capsule_limit is invalid");
  }
  const selectedCapsuleLimit = record.selected_capsule_limit as number;
  if (source.candidate_count !== sourceCounts.verified_continuity
      + sourceCounts.governed_learning) {
    fail("receipt_invalid", "source candidate count does not equal its lane counts");
  }
  for (const lane of ["verified_continuity", "governed_learning"] as const) {
    if (counts.selected[lane] + counts.omitted[lane] !== sourceCounts[lane]
      || counts.protected[lane] > sourceCounts[lane]) {
      fail("receipt_invalid", `${lane} selection counts do not partition source lane`);
    }
  }
  if (mandatoryCount > counts.protected.verified_continuity
      + counts.protected.governed_learning) {
    fail("receipt_invalid", "mandatory protected set exceeds protected universe");
  }
  const expectedOverflowLanes = (["verified_continuity", "governed_learning"] as const)
    .filter((lane) => counts.protected[lane] > laneLimits[lane]);
  const mandatoryOverflow = mandatoryCount > selectedCapsuleLimit;
  const expectedOverflowStatus = mandatoryOverflow && expectedOverflowLanes.length > 0
    ? "multiple_protected_overflow"
    : mandatoryOverflow
      ? "selected_capsule_protected_overflow"
      : expectedOverflowLanes.length === 0
        ? "none"
        : expectedOverflowLanes.length === 2
          ? "both_lanes_protected_overflow"
          : expectedOverflowLanes[0] === "verified_continuity"
            ? "verified_continuity_protected_overflow"
            : "governed_learning_protected_overflow";
  if (record.overflow_status !== expectedOverflowStatus) {
    fail("receipt_invalid", "overflow status does not match protected lane limits");
  }
  const overflowReasons = exactArray(
    record.overflow_reasons,
    3,
    "receipt_invalid",
    "overflow_reasons",
  );
  const expectedOverflowReasons = [
    ...expectedOverflowLanes.map((lane) => `${lane}_protected_limit_exceeded`),
    ...(mandatoryOverflow ? ["selected_capsule_protected_limit_exceeded"] : []),
  ].sort(compareCanonicalUtf8);
  if (canonicalContinuationJson(overflowReasons)
    !== canonicalContinuationJson(expectedOverflowReasons)) {
    fail("receipt_invalid", "overflow reasons do not match protected limits");
  }
  if (expectedOverflowLanes.length === 0 && !mandatoryOverflow) {
    for (const lane of ["verified_continuity", "governed_learning"] as const) {
      if (counts.protected[lane] > counts.selected[lane]
        || counts.selected[lane] > laneLimits[lane]) {
        fail("receipt_invalid", `${lane} selected count violates protected or lane limit`);
      }
    }
    if (mandatoryCount > counts.selected.verified_continuity
        + counts.selected.governed_learning) {
      fail("receipt_invalid", "selected set does not contain mandatory protected set");
    }
  } else if (counts.selected.verified_continuity !== 0
    || counts.selected.governed_learning !== 0) {
    fail("receipt_invalid", "protected overflow receipt must have an empty selected set");
  }
  for (const field of [
    "identity_sha256", "obligation_universe_sha256", "compiler_policy_payload_sha256",
    "compiler_candidate_universe_sha256", "receipt_sha256",
  ] as const) sha(record[field], "receipt_invalid", field);
  if ((expectedOverflowLanes.length > 0 || mandatoryOverflow)
    && record.compiler_candidate_universe_sha256
      !== canonicalContinuationSha256([])) {
    fail("receipt_invalid", "protected overflow compiler universe must be empty");
  }
  try {
    if (typeof record.evaluated_at !== "string") throw new Error("invalid");
    assertCanonicalUtcMillis(record.evaluated_at, "receipt.evaluated_at");
  } catch {
    fail("receipt_invalid", "evaluated_at is invalid");
  }
  if (canonicalSha256Without(record, "receipt_sha256") !== record.receipt_sha256) {
    fail("receipt_invalid", "receipt digest mismatch");
  }
  return canonicalContinuationClone(record) as ContinuationCandidateRetrievalReceiptV1;
}
