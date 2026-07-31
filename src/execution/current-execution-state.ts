import stableStringify from "fast-json-stable-stringify";

import {
  CurrentExecutionContinuityProjectionV1Schema,
  CurrentExecutionStateRenderV1Schema,
  CurrentExecutionStateV2MaterialSchema,
  CurrentExecutionStateV2Schema,
  CurrentStateRenderPolicyV1Schema,
  currentExecutionContinuityProjectionV1Digest,
  currentExecutionStateV2Digest,
  type CurrentExecutionAcceptedBranchV1,
  type CurrentExecutionBranchCandidateV1,
  type CurrentExecutionBranchStateV1,
  type CurrentExecutionCandidateLedgerEntryV1,
  type CurrentExecutionCandidateLedgerV1,
  type CurrentExecutionContinuityProjectionV1,
  type CurrentExecutionClaimAuthorityV2,
  type CurrentExecutionDecisiveEvidenceV1,
  type CurrentExecutionDecisionV2,
  type CurrentExecutionDecisionFrontierV1,
  type CurrentExecutionEvidenceRefV2,
  type CurrentExecutionEpistemicStateV1,
  type CurrentExecutionEventRefV2,
  type CurrentExecutionFrontierItemV1,
  type CurrentExecutionItemV2,
  type CurrentExecutionJustifiedActionV2,
  type CurrentExecutionObservationV2,
  type CurrentExecutionReadinessV1,
  type CurrentExecutionRecoveryRecommendationV1,
  type CurrentExecutionStateRenderV1,
  type CurrentExecutionStateV2,
  type CurrentExecutionStateV2Material,
  type CurrentExecutionTaskContractV1,
  type CurrentExecutionTaskConstraintV1,
  type CurrentExecutionVerifiedFactV2,
  type CurrentStateRenderPolicyV1,
} from "./types.js";
import {
  buildDecisiveEvidenceExcerptV1,
  type DecisionEpisodeV1,
  type DecisiveEvidenceExcerptV1,
  type EvidenceArtifactRefV1,
  type ExecutionEpisodeEventEnvelopeV1,
  type SemanticEventAuthorityV1,
  type StateSnapshotV1,
} from "../memory/execution-episode.js";
import type {
  ExecutionStateStore,
  StoredCurrentExecutionStateV2,
} from "./state-store.js";
import type {
  LiteEvidenceArtifactStore,
} from "../store/lite-evidence-artifact-store.js";
import type {
  LiteExecutionEpisodeReplay,
} from "../store/lite-execution-episode-store.js";
import { sha256Hex } from "../util/crypto.js";

const MAX_PROJECTED_OBSERVATIONS = 256;
const MAX_PROJECTED_DECISIONS = 256;
const MAX_PROJECTED_ITEMS = 512;
const MAX_PROJECTED_ARTIFACTS = 1024;
const MAX_PROJECTED_EVIDENCE_REFS = 4096;
const MAX_PROJECTED_DECISIVE_EVIDENCE = 256;
const MAX_PROJECTED_TASK_CONSTRAINTS = 128;
const MAX_PROJECTED_BELIEFS = 256;
const MAX_PROJECTED_FRONTIER_ITEMS = 256;
const MAX_PROJECTED_CANDIDATES = 256;
const MAX_PROJECTED_CANDIDATE_CHANGED_FIELDS = 64;

export const DEFAULT_CURRENT_STATE_RENDER_POLICY_V1:
  CurrentStateRenderPolicyV1 = Object.freeze({
    contract_version: "current_state_render_policy_v1",
    audience: "agent",
    max_chars: 5_200,
    max_observations: 3,
    max_items_per_status: 5,
    max_decisions: 3,
    max_verified_facts: 4,
    max_evidence_refs: 0,
    max_decisive_evidence: 12,
    max_decisive_evidence_chars: 2_600,
  });

export const DEFAULT_CURRENT_STATE_AUDIT_RENDER_POLICY_V1:
  CurrentStateRenderPolicyV1 = Object.freeze({
    contract_version: "current_state_render_policy_v1",
    audience: "audit",
    max_chars: 6_500,
    max_observations: 6,
    max_items_per_status: 12,
    max_decisions: 8,
    max_verified_facts: 8,
    max_evidence_refs: 8,
    max_decisive_evidence: 5,
    max_decisive_evidence_chars: 2_400,
  });

export type CurrentExecutionStateProjectionInputV2 = Readonly<{
  episode: DecisionEpisodeV1;
  events: readonly ExecutionEpisodeEventEnvelopeV1[];
  current_state_snapshot_id: string;
  goal: string;
  continuation_id?: string;
  parent_episode_id?: string | null;
}>;

export type CurrentExecutionStateTokenMeasurementV1 = Readonly<{
  authority: "host_tokenizer" | "provider_tokenizer";
  tokenizer_id: string;
  count(text: string): number;
}>;

function evidenceRef(
  value: EvidenceArtifactRefV1,
): CurrentExecutionEvidenceRefV2 {
  return {
    artifact_id: value.artifact_id,
    kind: value.kind,
    sha256: value.sha256,
    storage_ref: value.storage_ref,
  };
}

function eventRef(
  value: ExecutionEpisodeEventEnvelopeV1,
): CurrentExecutionEventRefV2 {
  return {
    event_id: value.event_id,
    event_sha256: value.event_sha256,
    sequence: value.sequence,
  };
}

function candidateLedgerEntryId(
  event: ExecutionEpisodeEventEnvelopeV1,
): string {
  return `candidate-entry:${sha256Hex(
    `${event.event_id}\0${event.event_sha256}`,
  )}`;
}

function authority(
  value: SemanticEventAuthorityV1,
): CurrentExecutionClaimAuthorityV2 {
  return {
    kind: value.kind,
    actor_id: value.actor_id,
    model_id: value.model_id,
    derivation_sha256: value.derivation_sha256,
    uncertainty: value.uncertainty,
  };
}

type CanonicalGoalV1 = Readonly<{
  text: string;
  sourceCompleteInState: boolean;
}>;

function canonicalGoal(
  value: string,
  sourceSha256: string,
): CanonicalGoalV1 {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized) {
    if (Buffer.byteLength(normalized, "utf8") <= 64 * 1024) {
      return {
        text: normalized,
        sourceCompleteInState: true,
      };
    }
    let low = 0;
    let high = normalized.length;
    while (low < high) {
      const midpoint = Math.ceil((low + high) / 2);
      const candidate = `${normalized.slice(0, midpoint).trimEnd()}…`;
      if (Buffer.byteLength(candidate, "utf8") <= 64 * 1024) {
        low = midpoint;
      } else {
        high = midpoint - 1;
      }
    }
    return {
      text: `${normalized.slice(0, low).trimEnd()}…`,
      sourceCompleteInState: false,
    };
  }
  return {
    text: `Task source retained as evidence sha256=${sourceSha256}`,
    sourceCompleteInState: false,
  };
}

function currentSnapshot(
  events: readonly ExecutionEpisodeEventEnvelopeV1[],
  expectedSnapshotId: string,
): StateSnapshotV1 {
  let latest: StateSnapshotV1 | null = null;
  for (const event of events) {
    switch (event.payload.event_kind) {
      case "episode_started":
        latest = event.payload.initial_state_snapshot;
        break;
      case "action_observed":
        latest = event.payload.state_after_snapshot;
        break;
      case "verifier_recorded":
        if (
          event.payload.verified_state_snapshot.snapshot_id
          === expectedSnapshotId
        ) {
          latest = event.payload.verified_state_snapshot;
        }
        break;
      case "episode_closed":
        if (event.payload.final_state_snapshot) {
          latest = event.payload.final_state_snapshot;
        }
        break;
      case "decision_committed":
      case "semantic_observation_recorded":
      case "agent_decision_recorded":
      case "progress_state_recorded":
      case "planned_action_recorded":
        break;
    }
  }
  if (!latest || latest.snapshot_id !== expectedSnapshotId) {
    throw new Error(
      "current_execution_state_snapshot_missing_from_episode_replay",
    );
  }
  return latest;
}

function addArtifact(
  values: readonly CurrentExecutionEvidenceRefV2[],
  additions: readonly EvidenceArtifactRefV1[],
): CurrentExecutionEvidenceRefV2[] {
  const byIdentity = new Map(
    values.map((value) => [
      `${value.artifact_id}\u0000${value.sha256}`,
      value,
    ]),
  );
  for (const addition of additions) {
    const projected = evidenceRef(addition);
    byIdentity.set(
      `${projected.artifact_id}\u0000${projected.sha256}`,
      projected,
    );
  }
  const all = [...byIdentity.values()];
  return all.length <= MAX_PROJECTED_ARTIFACTS
    ? all
    : all.slice(all.length - MAX_PROJECTED_ARTIFACTS);
}

function addEvidenceIdentities(
  values: readonly string[],
  event: ExecutionEpisodeEventEnvelopeV1,
  additions: readonly EvidenceArtifactRefV1[],
): string[] {
  const next = new Set(values);
  next.add(`event:${event.event_id}:${event.event_sha256}`);
  for (const addition of additions) {
    next.add(`artifact:${addition.artifact_id}:${addition.sha256}`);
  }
  const all = [...next];
  return all.length <= MAX_PROJECTED_EVIDENCE_REFS
    ? all
    : all.slice(all.length - MAX_PROJECTED_EVIDENCE_REFS);
}

function addDecisiveEvidence(
  values: readonly CurrentExecutionDecisiveEvidenceV1[] | undefined,
  event: ExecutionEpisodeEventEnvelopeV1,
  claimKind: CurrentExecutionDecisiveEvidenceV1["claim_kind"],
  claimId: string,
  evidenceRefs: readonly EvidenceArtifactRefV1[],
  additions: readonly DecisiveEvidenceExcerptV1[] | undefined,
): CurrentExecutionDecisiveEvidenceV1[] | undefined {
  if (!additions || additions.length === 0) {
    return values ? [...values] : undefined;
  }
  const byIdentity = new Map(
    (values ?? []).map((value) => [
      `${value.evidence_id}\u0000${value.source_event.event_id}`,
      value,
    ]),
  );
  for (const addition of additions) {
    const artifact = evidenceRefs.find((candidate) =>
      candidate.artifact_id === addition.evidence_artifact_id
      && candidate.sha256 === addition.evidence_artifact_sha256
    );
    if (!artifact) {
      throw new Error(
        "current_execution_state_decisive_evidence_artifact_missing",
      );
    }
    byIdentity.set(`${addition.evidence_id}\u0000${event.event_id}`, {
      evidence_id: addition.evidence_id,
      claim_kind: claimKind,
      claim_id: claimId,
      source_ref: addition.source_ref,
      excerpt: addition.excerpt,
      excerpt_sha256: addition.excerpt_sha256,
      evidence_artifact: evidenceRef(artifact),
      source_event: eventRef(event),
    });
  }
  const all = [...byIdentity.values()];
  return all.length <= MAX_PROJECTED_DECISIVE_EVIDENCE
    ? all
    : all.slice(all.length - MAX_PROJECTED_DECISIVE_EVIDENCE);
}

function semanticProvenance(
  event: ExecutionEpisodeEventEnvelopeV1,
  value: {
    authority: SemanticEventAuthorityV1;
    target_state_snapshot_id: string;
    recorded_at: string;
  },
) {
  return {
    authority: authority(value.authority),
    evidence_refs: value.authority.evidence_refs.map(evidenceRef),
    source_event: eventRef(event),
    target_state_snapshot_id: value.target_state_snapshot_id,
    recorded_at: value.recorded_at,
  };
}

function trimTail<T>(values: readonly T[], limit: number): T[] {
  return values.length <= limit
    ? [...values]
    : values.slice(values.length - limit);
}

type CurrentExecutionContinuityDraftV1 = Omit<
  CurrentExecutionContinuityProjectionV1,
  "base_state_sha256" | "projection_sha256"
>;

function taskConstraintId(
  sourceTextSha256: string,
  startUtf8Byte: number,
  endUtf8Byte: number,
  statement: string,
): string {
  return `constraint:${sha256Hex(stableStringify({
    source_text_sha256: sourceTextSha256,
    source_start_utf8_byte: startUtf8Byte,
    source_end_utf8_byte: endUtf8Byte,
    statement,
  })).slice(0, 48)}`;
}

function goalConstraintSpans(
  goal: string,
): readonly Readonly<{
  startCharacter: number;
  endCharacter: number;
}>[] {
  const spans: Array<{
    startCharacter: number;
    endCharacter: number;
  }> = [];
  let paragraphStart: number | null = null;
  let paragraphEnd: number | null = null;
  let lineStart = 0;
  while (lineStart <= goal.length) {
    const newline = goal.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? goal.length : newline;
    const line = goal.slice(lineStart, lineEnd);
    if (line.trim().length === 0) {
      if (paragraphStart !== null && paragraphEnd !== null) {
        spans.push({
          startCharacter: paragraphStart,
          endCharacter: paragraphEnd,
        });
      }
      paragraphStart = null;
      paragraphEnd = null;
    } else {
      const leading = line.match(/^\s*/u)?.[0].length ?? 0;
      const trailing = line.match(/\s*$/u)?.[0].length ?? 0;
      paragraphStart ??= lineStart + leading;
      paragraphEnd = lineEnd - trailing;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (paragraphStart !== null && paragraphEnd !== null) {
    spans.push({
      startCharacter: paragraphStart,
      endCharacter: paragraphEnd,
    });
  }
  if (spans.length === 0) {
    return [{ startCharacter: 0, endCharacter: goal.length }];
  }
  if (spans.length <= MAX_PROJECTED_TASK_CONSTRAINTS) {
    return spans;
  }
  const retained = spans.slice(0, MAX_PROJECTED_TASK_CONSTRAINTS - 1);
  retained.push({
    startCharacter:
      spans[MAX_PROJECTED_TASK_CONSTRAINTS - 1]!.startCharacter,
    endCharacter: spans.at(-1)!.endCharacter,
  });
  return retained;
}

function taskContractCoverage(
  constraints: readonly CurrentExecutionTaskConstraintV1[],
): CurrentExecutionTaskContractV1["coverage"] {
  const satisfiedCount = constraints.filter(
    (constraint) => constraint.status === "satisfied",
  ).length;
  const violatedCount = constraints.filter(
    (constraint) => constraint.status === "violated",
  ).length;
  return {
    required_count: constraints.length,
    satisfied_count: satisfiedCount,
    violated_count: violatedCount,
    unresolved_count:
      constraints.length - satisfiedCount - violatedCount,
  };
}

function initialTaskContract(
  goal: CanonicalGoalV1,
  sourceEvidenceRef: CurrentExecutionEvidenceRefV2,
): CurrentExecutionTaskContractV1 {
  const sourceTextSha256 = sha256Hex(goal.text);
  const constraints = goalConstraintSpans(goal.text).map((span) => {
    const statement = goal.text.slice(
      span.startCharacter,
      span.endCharacter,
    );
    const startUtf8Byte = Buffer.byteLength(
      goal.text.slice(0, span.startCharacter),
      "utf8",
    );
    const endUtf8Byte = Buffer.byteLength(
      goal.text.slice(0, span.endCharacter),
      "utf8",
    );
    return {
      constraint_id: taskConstraintId(
        sourceTextSha256,
        startUtf8Byte,
        endUtf8Byte,
        statement,
      ),
      statement,
      statement_sha256: sha256Hex(statement),
      source_start_utf8_byte: startUtf8Byte,
      source_end_utf8_byte: endUtf8Byte,
      obligation: "required" as const,
      status: "unresolved" as const,
    };
  });
  return {
    contract_version: "current_execution_task_contract_v1",
    source_text_sha256: sourceTextSha256,
    source_complete_in_state: goal.sourceCompleteInState,
    source_evidence_ref: sourceEvidenceRef,
    verification_status: "unverified",
    constraints,
    coverage: taskContractCoverage(constraints),
  };
}

function taskContractForBranch(
  taskContract: CurrentExecutionTaskContractV1,
  branch: CurrentExecutionBranchStateV1,
): CurrentExecutionTaskContractV1 {
  const verificationStatus =
    branch.current_candidate.verification_status;
  const constraints = taskContract.constraints.map((constraint) => ({
    ...constraint,
    status: verificationStatus === "passed"
      ? "satisfied" as const
      : "unresolved" as const,
  }));
  return {
    ...taskContract,
    verification_status: verificationStatus,
    constraints,
    coverage: taskContractCoverage(constraints),
  };
}

function beliefId(kind: string, sourceId: string): string {
  return `belief:${sha256Hex(`${kind}\u0000${sourceId}`).slice(0, 48)}`;
}

function epistemicState(
  material: CurrentExecutionStateV2Material,
): CurrentExecutionEpistemicStateV1 {
  const projectedBeliefs: CurrentExecutionEpistemicStateV1["beliefs"] = [
    ...material.observations.map((observation) => ({
      belief_id: beliefId("observation", observation.observation_id),
      statement: observation.statement,
      epistemic_status:
        observation.authority.kind === "runtime_derived"
          ? "supported" as const
          : observation.authority.kind === "host_declared"
            ? "reported" as const
            : "hypothesis" as const,
      counter_evidence_refs: [],
      authority: observation.authority,
      evidence_refs: observation.evidence_refs,
      source_event: observation.source_event,
      target_state_snapshot_id: observation.target_state_snapshot_id,
      recorded_at: observation.recorded_at,
    })),
    ...material.unresolved.map((item) => ({
      belief_id: beliefId("unresolved", item.item_id),
      statement: item.statement,
      epistemic_status: "unknown" as const,
      counter_evidence_refs: [],
      authority: item.authority,
      evidence_refs: item.evidence_refs,
      source_event: item.source_event,
      target_state_snapshot_id: item.target_state_snapshot_id,
      recorded_at: item.recorded_at,
    })),
    ...material.blocked.map((item) => ({
      belief_id: beliefId("blocked", item.item_id),
      statement: item.statement,
      epistemic_status: "unknown" as const,
      counter_evidence_refs: [],
      authority: item.authority,
      evidence_refs: item.evidence_refs,
      source_event: item.source_event,
      target_state_snapshot_id: item.target_state_snapshot_id,
      recorded_at: item.recorded_at,
    })),
  ];
  const authoritative = projectedBeliefs.filter((belief) =>
    belief.epistemic_status === "supported"
    || belief.epistemic_status === "reported"
  );
  const conflicts = projectedBeliefs.filter(
    (belief) => belief.epistemic_status === "contradicted",
  );
  const unresolved = projectedBeliefs.filter(
    (belief) => belief.epistemic_status === "unknown",
  );
  const hypotheses = projectedBeliefs.filter(
    (belief) => belief.epistemic_status === "hypothesis",
  );
  const beliefs: CurrentExecutionEpistemicStateV1["beliefs"] = [];
  for (
    const group of
      [conflicts, authoritative, unresolved, hypotheses]
  ) {
    const remaining = MAX_PROJECTED_BELIEFS - beliefs.length;
    if (remaining <= 0) break;
    beliefs.push(...group.slice(-remaining));
  }
  return {
    contract_version: "current_execution_epistemic_state_v1",
    beliefs,
    supported_count: beliefs.filter(
      (belief) => belief.epistemic_status === "supported",
    ).length,
    reported_count: beliefs.filter(
      (belief) => belief.epistemic_status === "reported",
    ).length,
    hypothesis_count: beliefs.filter(
      (belief) => belief.epistemic_status === "hypothesis",
    ).length,
    unknown_count: beliefs.filter(
      (belief) => belief.epistemic_status === "unknown",
    ).length,
    contradicted_count: beliefs.filter(
      (belief) => belief.epistemic_status === "contradicted",
    ).length,
  };
}

function branchState(
  currentCandidate: CurrentExecutionBranchCandidateV1,
  lastVerifierAccepted: CurrentExecutionAcceptedBranchV1 | null,
  candidateLedger?: CurrentExecutionCandidateLedgerV1,
): CurrentExecutionBranchStateV1 {
  const acceptedCandidateIsCurrent = lastVerifierAccepted !== null
    && lastVerifierAccepted.snapshot_id === currentCandidate.snapshot_id
    && lastVerifierAccepted.content_sha256
      === currentCandidate.content_sha256;
  const latestCandidateEntry = candidateLedger?.entries.at(-1);
  const recoveryRecommendation:
    CurrentExecutionRecoveryRecommendationV1 | null =
      lastVerifierAccepted !== null
      && !acceptedCandidateIsCurrent
      && currentCandidate.verification_status === "failed"
      && currentCandidate.verifier_id
        === lastVerifierAccepted.verifier_id
      && latestCandidateEntry !== undefined
      && latestCandidateEntry.verification_evidence_refs.length > 0
        ? {
            contract_version:
              "current_execution_recovery_recommendation_v1",
            recommended_action: "restore_snapshot",
            reason_code:
              "current_verifier_failed_prior_snapshot_passed",
            current_failed_candidate: currentCandidate,
            current_failure_evidence_refs:
              latestCandidateEntry.verification_evidence_refs,
            target_accepted_candidate: lastVerifierAccepted,
          }
        : null;
  return {
    contract_version: "current_execution_branch_state_v1",
    current_candidate: currentCandidate,
    last_verifier_accepted: lastVerifierAccepted,
    accepted_candidate_is_current: acceptedCandidateIsCurrent,
    recovery_candidate_available:
      lastVerifierAccepted !== null && !acceptedCandidateIsCurrent,
    recovery_recommendation: recoveryRecommendation,
    ...(candidateLedger
      ? { candidate_ledger: candidateLedger }
      : {}),
  };
}

function unverifiedBranchCandidate(
  snapshot: StateSnapshotV1,
): CurrentExecutionBranchCandidateV1 {
  return {
    snapshot_id: snapshot.snapshot_id,
    content_sha256: snapshot.content_digest,
    snapshot_ref: snapshot.artifact_ref.storage_ref,
    verification_status: "unverified",
    verifier_id: null,
    verifier_receipt_id: null,
    verified_at: null,
  };
}

function candidateLedger(
  entries: readonly CurrentExecutionCandidateLedgerEntryV1[],
  totalCandidateCount: number,
): CurrentExecutionCandidateLedgerV1 {
  const retained = entries.slice(-MAX_PROJECTED_CANDIDATES);
  return {
    contract_version: "current_execution_candidate_ledger_v1",
    total_candidate_count: totalCandidateCount,
    retained_candidate_count: retained.length,
    history_complete_in_projection:
      totalCandidateCount === retained.length,
    entries: retained,
  };
}

function initialCandidateLedger(
  snapshot: StateSnapshotV1,
  event: ExecutionEpisodeEventEnvelopeV1,
): CurrentExecutionCandidateLedgerV1 {
  return candidateLedger([{
    ledger_entry_id: candidateLedgerEntryId(event),
    candidate: unverifiedBranchCandidate(snapshot),
    origin: "episode_started",
    source_event: eventRef(event),
    observed_at: event.occurred_at,
    transition: null,
    verification_evidence_refs: [],
  }], 1);
}

function appendCandidateLedgerEntry(
  ledger: CurrentExecutionCandidateLedgerV1,
  event: ExecutionEpisodeEventEnvelopeV1,
): CurrentExecutionCandidateLedgerV1 {
  if (
    event.payload.event_kind !== "action_observed"
    || !event.payload.action.mutation
  ) {
    return ledger;
  }
  const payload = event.payload;
  if (!payload.action.state_delta || !payload.action.state_delta_ref) {
    throw new Error(
      "current_execution_state_candidate_delta_missing",
    );
  }
  const changedFields = payload.action.state_delta.changed_fields;
  const entry: CurrentExecutionCandidateLedgerEntryV1 = {
    ledger_entry_id: candidateLedgerEntryId(event),
    candidate: unverifiedBranchCandidate(
      payload.state_after_snapshot,
    ),
    origin: "action_mutation",
    source_event: eventRef(event),
    observed_at: event.occurred_at,
    transition: {
      source_snapshot_id:
        payload.state_before_snapshot.snapshot_id,
      action_id: payload.action.action_id,
      action_kind: payload.action.action_kind,
      tool_name: payload.action.tool_name ?? null,
      delta_id: payload.action.state_delta.delta_id,
      delta_content_sha256:
        payload.action.state_delta.content_sha256,
      delta_ref: evidenceRef(payload.action.state_delta_ref),
      changed_field_count: changedFields.length,
      changed_fields_preview: changedFields.slice(
        0,
        MAX_PROJECTED_CANDIDATE_CHANGED_FIELDS,
      ),
      changed_fields_complete:
        changedFields.length
          <= MAX_PROJECTED_CANDIDATE_CHANGED_FIELDS,
    },
    verification_evidence_refs: [],
  };
  return candidateLedger(
    [...ledger.entries, entry],
    ledger.total_candidate_count + 1,
  );
}

function recordCandidateVerification(
  ledger: CurrentExecutionCandidateLedgerV1,
  event: ExecutionEpisodeEventEnvelopeV1,
): CurrentExecutionCandidateLedgerV1 {
  const payload = event.payload;
  if (payload.event_kind !== "verifier_recorded") {
    return ledger;
  }
  const outcome = payload.outcome;
  const evidence = [
    evidenceRef(outcome.verifier_input_ref),
    evidenceRef(outcome.verifier_output_ref),
    evidenceRef(payload.verified_state_snapshot.artifact_ref),
  ];
  let matchedIndex = -1;
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    if (
      ledger.entries[index]?.candidate.snapshot_id
        === outcome.verified_state_snapshot_id
    ) {
      matchedIndex = index;
      break;
    }
  }
  if (matchedIndex < 0) return ledger;
  const entries = ledger.entries.map((entry, index) =>
    index === matchedIndex
      ? {
        ...entry,
        candidate: {
          snapshot_id: outcome.verified_state_snapshot_id,
          content_sha256:
            payload.verified_state_snapshot.content_digest,
          snapshot_ref:
            payload.verified_state_snapshot.artifact_ref.storage_ref,
          verification_status: outcome.status,
          verifier_id: outcome.verifier_id,
          verifier_receipt_id: outcome.verifier_receipt_id,
          verified_at: outcome.completed_at,
        },
        verification_evidence_refs: evidence,
      }
      : entry
  );
  return matchedIndex >= 0
    ? candidateLedger(entries, ledger.total_candidate_count)
    : ledger;
}

function advanceBranchState(
  previous: CurrentExecutionBranchStateV1,
  event: ExecutionEpisodeEventEnvelopeV1,
  material: CurrentExecutionStateV2Material,
): CurrentExecutionBranchStateV1 {
  let currentCandidate = previous.current_candidate;
  let lastVerifierAccepted = previous.last_verifier_accepted;
  let ledger = previous.candidate_ledger;
  if (
    event.payload.event_kind === "action_observed"
    && event.payload.action.mutation
  ) {
    currentCandidate = unverifiedBranchCandidate(
      event.payload.state_after_snapshot,
    );
    if (ledger) {
      ledger = appendCandidateLedgerEntry(ledger, event);
    }
  } else if (event.payload.event_kind === "verifier_recorded") {
    const outcome = event.payload.outcome;
    if (ledger) {
      ledger = recordCandidateVerification(ledger, event);
    }
    if (
      outcome.verified_state_snapshot_id
        === material.subject.current_snapshot_id
    ) {
      currentCandidate = {
        snapshot_id: outcome.verified_state_snapshot_id,
        content_sha256:
          event.payload.verified_state_snapshot.content_digest,
        snapshot_ref:
          event.payload.verified_state_snapshot.artifact_ref.storage_ref,
        verification_status: outcome.status,
        verifier_id: outcome.verifier_id,
        verifier_receipt_id: outcome.verifier_receipt_id,
        verified_at: outcome.completed_at,
      };
    }
    if (outcome.status === "passed") {
      lastVerifierAccepted = {
        snapshot_id: outcome.verified_state_snapshot_id,
        content_sha256:
          event.payload.verified_state_snapshot.content_digest,
        snapshot_ref:
          event.payload.verified_state_snapshot.artifact_ref.storage_ref,
        verifier_id: outcome.verifier_id,
        verifier_receipt_id: outcome.verifier_receipt_id,
        verified_at: outcome.completed_at,
        evidence_refs: [
          evidenceRef(outcome.verifier_input_ref),
          evidenceRef(outcome.verifier_output_ref),
          evidenceRef(
            event.payload.verified_state_snapshot.artifact_ref,
          ),
        ],
      };
    }
  }
  return branchState(
    currentCandidate,
    lastVerifierAccepted,
    ledger,
  );
}

function frontierId(kind: string, sourceId: string): string {
  return `frontier:${sha256Hex(`${kind}\u0000${sourceId}`).slice(0, 48)}`;
}

function decisionFrontier(
  material: CurrentExecutionStateV2Material,
  taskContract: CurrentExecutionTaskContractV1,
  epistemic: CurrentExecutionEpistemicStateV1,
  branch: CurrentExecutionBranchStateV1,
): CurrentExecutionDecisionFrontierV1 {
  const items: CurrentExecutionFrontierItemV1[] = [];
  if (
    material.episode_status === "open"
    && branch.recovery_recommendation !== null
  ) {
    items.push({
      frontier_id: frontierId(
        "recovery",
        branch.recovery_recommendation
          .target_accepted_candidate.snapshot_id,
      ),
      kind: "recovery",
      statement:
        "Restore the exact verifier-passed snapshot because the exact current snapshot failed the same verifier.",
      target_state_snapshot_id:
        branch.recovery_recommendation
          .target_accepted_candidate.snapshot_id,
      source_event: null,
    });
  }
  for (
    const constraint of taskContract.constraints.filter(
      (value) => value.status === "violated",
    )
  ) {
    items.push({
      frontier_id: frontierId("constraint", constraint.constraint_id),
      kind: "constraint",
      statement: constraint.statement,
      target_state_snapshot_id: material.subject.current_snapshot_id,
      source_event: null,
    });
  }
  for (const item of material.blocked) {
    items.push({
      frontier_id: frontierId("blocked", item.item_id),
      kind: "blocked",
      statement: item.statement,
      target_state_snapshot_id: item.target_state_snapshot_id,
      source_event: item.source_event,
    });
  }
  for (const item of material.unresolved) {
    items.push({
      frontier_id: frontierId("unresolved", item.item_id),
      kind: "unresolved",
      statement: item.statement,
      target_state_snapshot_id: item.target_state_snapshot_id,
      source_event: item.source_event,
    });
  }
  for (
    const belief of epistemic.beliefs.filter(
      (value) => value.epistemic_status === "contradicted",
    )
  ) {
    items.push({
      frontier_id: frontierId("contradiction", belief.belief_id),
      kind: "contradiction",
      statement: belief.statement,
      target_state_snapshot_id: belief.target_state_snapshot_id,
      source_event: belief.source_event,
    });
  }
  for (const check of material.pending_checks) {
    items.push({
      frontier_id: frontierId("pending_check", check.check_id),
      kind: "pending_check",
      statement:
        `Obtain ${check.verifier_id} evidence for the exact current state.`,
      target_state_snapshot_id: check.target_state_snapshot_id,
      source_event: null,
    });
  }
  if (
    material.episode_status === "open"
    && material.next_action === null
  ) {
    items.push({
      frontier_id: frontierId(
        "missing_plan",
        material.subject.current_snapshot_id,
      ),
      kind: "missing_plan",
      statement:
        "Determine the next evidence-grounded action for the exact current state.",
      target_state_snapshot_id: material.subject.current_snapshot_id,
      source_event: null,
    });
  }
  return {
    contract_version: "current_execution_decision_frontier_v1",
    items: items.slice(0, MAX_PROJECTED_FRONTIER_ITEMS),
  };
}

function readiness(
  material: CurrentExecutionStateV2Material,
  taskContract: CurrentExecutionTaskContractV1,
  epistemic: CurrentExecutionEpistemicStateV1,
  branch: CurrentExecutionBranchStateV1,
): CurrentExecutionReadinessV1 {
  const safeToExecutePlannedAction =
    material.episode_status === "open"
    && branch.recovery_recommendation === null
    && material.next_action !== null
    && material.next_action.target_state_snapshot_id
      === material.subject.current_snapshot_id
    && material.blocked.length === 0
    && taskContract.coverage.violated_count === 0;
  const status: CurrentExecutionReadinessV1["status"] =
    material.episode_status === "closed"
      ? branch.accepted_candidate_is_current
        ? "verified_complete"
        : "closed_unverified"
      : branch.accepted_candidate_is_current
        ? "verified_complete"
        : branch.recovery_recommendation !== null
          ? "recovery_recommended"
        : material.blocked.length > 0
          || taskContract.coverage.violated_count > 0
          ? "blocked"
          : safeToExecutePlannedAction
            ? "ready_to_act"
            : "needs_evidence";
  return {
    contract_version: "current_execution_readiness_v1",
    status,
    safe_to_execute_planned_action: safeToExecutePlannedAction,
    required_constraint_count: taskContract.coverage.required_count,
    satisfied_constraint_count: taskContract.coverage.satisfied_count,
    unresolved_constraint_count: taskContract.coverage.unresolved_count,
    violated_constraint_count: taskContract.coverage.violated_count,
    unresolved_conflict_count: epistemic.contradicted_count,
    pending_check_count: material.pending_checks.length,
    accepted_recovery_candidate_available:
      branch.recovery_candidate_available,
  };
}

function continuityDraft(
  material: CurrentExecutionStateV2Material,
  taskContractInput: CurrentExecutionTaskContractV1,
  branch: CurrentExecutionBranchStateV1,
): CurrentExecutionContinuityDraftV1 {
  const taskContract = taskContractForBranch(
    taskContractInput,
    branch,
  );
  const epistemic = epistemicState(material);
  return {
    contract_version: "current_execution_continuity_projection_v1",
    task_contract: taskContract,
    epistemic_state: epistemic,
    branch_state: branch,
    decision_frontier: decisionFrontier(
      material,
      taskContract,
      epistemic,
      branch,
    ),
    readiness: readiness(
      material,
      taskContract,
      epistemic,
      branch,
    ),
  };
}

function finalizeContinuityProjection(
  baseStateSha256: string,
  draft: CurrentExecutionContinuityDraftV1,
): CurrentExecutionContinuityProjectionV1 {
  const material = {
    ...draft,
    base_state_sha256: baseStateSha256,
  };
  return CurrentExecutionContinuityProjectionV1Schema.parse({
    ...material,
    projection_sha256:
      currentExecutionContinuityProjectionV1Digest(material),
  });
}

function replaceProgressItem(
  material: CurrentExecutionStateV2Material,
  item: CurrentExecutionItemV2,
  state: "completed" | "failed" | "unresolved" | "blocked",
): void {
  material.completed = material.completed.filter(
    (value) => value.item_id !== item.item_id,
  );
  material.failed = material.failed.filter(
    (value) => value.item_id !== item.item_id,
  );
  material.unresolved = material.unresolved.filter(
    (value) => value.item_id !== item.item_id,
  );
  material.blocked = material.blocked.filter(
    (value) => value.item_id !== item.item_id,
  );
  material[state] = trimTail(
    [...material[state], item],
    MAX_PROJECTED_ITEMS,
  );
}

function stateFromMaterial(
  material: CurrentExecutionStateV2Material,
  updatedAt: string,
  continuity: CurrentExecutionContinuityDraftV1,
): CurrentExecutionStateV2 {
  const parsed = CurrentExecutionStateV2MaterialSchema.parse(material);
  const stateSha256 = currentExecutionStateV2Digest(parsed);
  return CurrentExecutionStateV2Schema.parse({
    ...parsed,
    state_sha256: stateSha256,
    updated_at: updatedAt,
    continuity_projection: finalizeContinuityProjection(
      stateSha256,
      continuity,
    ),
  });
}

function mutableMaterial(
  state: CurrentExecutionStateV2,
  event: ExecutionEpisodeEventEnvelopeV1,
): CurrentExecutionStateV2Material {
  const {
    state_sha256: parentStateSha256,
    updated_at: _updatedAt,
    continuity_projection: _continuityProjection,
    ...previous
  } = state;
  return {
    ...previous,
    revision: event.sequence + 1,
    parent_state_sha256: parentStateSha256,
    subject: { ...previous.subject },
    observations: [...previous.observations],
    completed: [...previous.completed],
    failed: [...previous.failed],
    unresolved: [...previous.unresolved],
    blocked: [...previous.blocked],
    decisions: [...previous.decisions],
    active_artifacts: [...previous.active_artifacts],
    verified_facts: [...previous.verified_facts],
    pending_checks: [...previous.pending_checks],
    next_action: previous.next_action
      ? {
        ...previous.next_action,
        ...(previous.next_action.action_sufficiency
          ? {
            action_sufficiency: {
              ...previous.next_action.action_sufficiency,
              reason_codes: [
                ...previous.next_action.action_sufficiency
                  .reason_codes,
              ],
            },
          }
          : {}),
      }
      : null,
    evidence_refs: [...previous.evidence_refs],
    ...(previous.decisive_evidence
      ? { decisive_evidence: [...previous.decisive_evidence] }
      : {}),
  };
}

function initialState(
  input: CurrentExecutionStateProjectionInputV2,
  event: ExecutionEpisodeEventEnvelopeV1,
): CurrentExecutionStateV2 {
  if (event.payload.event_kind !== "episode_started" || event.sequence !== 0) {
    throw new Error("current_execution_state_episode_root_invalid");
  }
  const episode = input.episode;
  const snapshot = event.payload.initial_state_snapshot;
  const initialArtifacts = [
    episode.source_task_ref,
    episode.task_envelope_ref,
    episode.task_manifest_ref,
    episode.model_config_ref,
    snapshot.artifact_ref,
  ].map(evidenceRef);
  const initialEvidence = [
    `event:${event.event_id}:${event.event_sha256}`,
    ...initialArtifacts.map(
      (value) => `artifact:${value.artifact_id}:${value.sha256}`,
    ),
  ];
  const goal = canonicalGoal(
    input.goal,
    episode.source_task_ref.sha256,
  );
  const material = CurrentExecutionStateV2MaterialSchema.parse({
    contract_version: "current_execution_state_v2",
    scope_id: episode.store_scope,
    continuation_id:
      input.continuation_id ?? `continuation:${episode.episode_id}`,
    task_run_id: episode.run_id,
    episode_id: episode.episode_id,
    parent_episode_id: input.parent_episode_id ?? null,
    revision: 1,
    parent_state_sha256: null,
    subject: {
      kind: snapshot.state_kind,
      adapter_id:
        episode.execution_subject?.adapter_id ?? snapshot.algorithm_id,
      adapter_version:
        episode.execution_subject?.adapter_version
        ?? snapshot.algorithm_version,
      identity_sha256: episode.subject_identity.identity_sha256,
      current_snapshot_id: snapshot.snapshot_id,
      current_snapshot_ref: snapshot.artifact_ref.storage_ref,
      current_content_sha256: snapshot.content_digest,
    },
    goal: goal.text,
    goal_evidence_ref: evidenceRef(episode.source_task_ref),
    phase: null,
    observations: [],
    completed: [],
    failed: [],
    unresolved: [],
    blocked: [],
    decisions: [],
    active_artifacts: initialArtifacts,
    verified_facts: [],
    pending_checks: [{
      check_id: `required-verifier:${episode.required_verifier.verifier_id}`,
      verifier_id: episode.required_verifier.verifier_id,
      verifier_definition_sha256:
        episode.required_verifier.verifier_definition_sha256,
      status: "pending",
      target_state_snapshot_id: snapshot.snapshot_id,
    }],
    next_action: null,
    episode_status: "open",
    evidence_refs: [...new Set(initialEvidence)],
  });
  const contract = initialTaskContract(
    goal,
    material.goal_evidence_ref,
  );
  const branch = branchState(
    unverifiedBranchCandidate(snapshot),
    null,
    initialCandidateLedger(snapshot, event),
  );
  return stateFromMaterial(
    material,
    event.occurred_at,
    continuityDraft(material, contract, branch),
  );
}

export function projectCurrentExecutionStateHistoryV2(
  input: CurrentExecutionStateProjectionInputV2,
): readonly CurrentExecutionStateV2[] {
  if (input.events.length === 0) {
    throw new Error("current_execution_state_episode_events_missing");
  }
  let projected = initialState(input, input.events[0]!);
  const history: CurrentExecutionStateV2[] = [projected];
  for (const event of input.events.slice(1)) {
    if (event.sequence + 1 !== projected.revision + 1) {
      throw new Error("current_execution_state_event_sequence_invalid");
    }
    const material = mutableMaterial(projected, event);
    const priorContinuity = projected.continuity_projection;
    if (!priorContinuity) {
      throw new Error(
        "current_execution_state_continuity_projection_missing",
      );
    }
    switch (event.payload.event_kind) {
      case "episode_started":
        throw new Error("current_execution_state_multiple_episode_roots");
      case "decision_committed":
        break;
      case "action_observed": {
        const snapshot = event.payload.state_after_snapshot;
        const action = event.payload.action;
        const actionArtifacts = [
          action.request_ref,
          action.result_ref,
          event.payload.state_before_snapshot.artifact_ref,
          snapshot.artifact_ref,
          ...(action.state_delta_ref
            ? [action.state_delta_ref]
            : []),
        ];
        material.subject = {
          ...material.subject,
          current_snapshot_id: snapshot.snapshot_id,
          current_snapshot_ref: snapshot.artifact_ref.storage_ref,
          current_content_sha256: snapshot.content_digest,
        };
        material.active_artifacts = addArtifact(
          material.active_artifacts,
          actionArtifacts,
        );
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          actionArtifacts,
        );
        material.pending_checks = trimTail([
          ...material.pending_checks.filter(
            (check) =>
              check.verifier_id
                !== input.episode.required_verifier.verifier_id,
          ),
          {
            check_id:
              `required-verifier:${input.episode.required_verifier.verifier_id}`,
            verifier_id:
              input.episode.required_verifier.verifier_id,
            verifier_definition_sha256:
              input.episode.required_verifier
                .verifier_definition_sha256,
            status: "pending",
            target_state_snapshot_id: snapshot.snapshot_id,
          },
        ], 64);
        const stateChanged =
          event.payload.state_before_snapshot.snapshot_id
            !== snapshot.snapshot_id;
        if (stateChanged) {
          material.next_action = null;
        }
        break;
      }
      case "semantic_observation_recorded": {
        const value = event.payload.observation;
        const observation: CurrentExecutionObservationV2 = {
          observation_id: value.semantic_event_id,
          statement: value.observation,
          ...semanticProvenance(event, value),
        };
        material.observations = trimTail(
          [...material.observations, observation],
          MAX_PROJECTED_OBSERVATIONS,
        );
        material.active_artifacts = addArtifact(
          material.active_artifacts,
          value.authority.evidence_refs,
        );
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          value.authority.evidence_refs,
        );
        material.decisive_evidence = addDecisiveEvidence(
          material.decisive_evidence,
          event,
          "observation",
          value.semantic_event_id,
          value.authority.evidence_refs,
          value.decisive_evidence,
        );
        break;
      }
      case "agent_decision_recorded": {
        const value = event.payload.decision;
        const decision: CurrentExecutionDecisionV2 = {
          decision_id: value.semantic_event_id,
          statement: value.decision,
          reasons: [...value.reasons],
          alternatives_rejected: [...value.alternatives_rejected],
          ...semanticProvenance(event, value),
        };
        material.decisions = trimTail(
          [...material.decisions, decision],
          MAX_PROJECTED_DECISIONS,
        );
        material.active_artifacts = addArtifact(
          material.active_artifacts,
          value.authority.evidence_refs,
        );
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          value.authority.evidence_refs,
        );
        material.decisive_evidence = addDecisiveEvidence(
          material.decisive_evidence,
          event,
          "decision",
          value.semantic_event_id,
          value.authority.evidence_refs,
          value.decisive_evidence,
        );
        break;
      }
      case "progress_state_recorded": {
        const value = event.payload.progress;
        const item: CurrentExecutionItemV2 = {
          item_id: value.item_id,
          statement: value.statement,
          ...semanticProvenance(event, value),
        };
        replaceProgressItem(material, item, value.state);
        material.active_artifacts = addArtifact(
          material.active_artifacts,
          value.authority.evidence_refs,
        );
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          value.authority.evidence_refs,
        );
        material.decisive_evidence = addDecisiveEvidence(
          material.decisive_evidence,
          event,
          "progress",
          value.semantic_event_id,
          value.authority.evidence_refs,
          value.decisive_evidence,
        );
        break;
      }
      case "planned_action_recorded": {
        const value = event.payload.planned_action;
        const plannedAction: CurrentExecutionJustifiedActionV2 = {
          action_id: value.action_id,
          intent: value.intent,
          justification: value.justification,
          preconditions: [...value.preconditions],
          ...semanticProvenance(event, value),
        };
        material.next_action = plannedAction;
        material.active_artifacts = addArtifact(
          material.active_artifacts,
          value.authority.evidence_refs,
        );
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          value.authority.evidence_refs,
        );
        material.decisive_evidence = addDecisiveEvidence(
          material.decisive_evidence,
          event,
          "planned_action",
          value.semantic_event_id,
          value.authority.evidence_refs,
          value.decisive_evidence,
        );
        break;
      }
      case "verifier_recorded": {
        const value = event.payload.outcome;
        const fact: CurrentExecutionVerifiedFactV2 = {
          fact_id: value.verifier_receipt_id,
          statement:
            `Verifier ${value.verifier_id} returned ${value.status} for state ${value.verified_state_snapshot_id}.`,
          status: value.status,
          verifier_id: value.verifier_id,
          target_state_snapshot_id: value.verified_state_snapshot_id,
          evidence_refs: [
            evidenceRef(value.verifier_input_ref),
            evidenceRef(value.verifier_output_ref),
          ],
          source_event: eventRef(event),
          verified_at: value.completed_at,
        };
        material.verified_facts = trimTail(
          [...material.verified_facts, fact],
          MAX_PROJECTED_DECISIONS,
        );
        material.pending_checks = material.pending_checks.filter(
          (check) =>
            check.verifier_id !== value.verifier_id
            || check.target_state_snapshot_id
              !== value.verified_state_snapshot_id,
        );
        material.active_artifacts = addArtifact(
          material.active_artifacts,
          [
            value.verifier_input_ref,
            value.verifier_output_ref,
            event.payload.verified_state_snapshot.artifact_ref,
          ],
        );
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          [
            value.verifier_input_ref,
            value.verifier_output_ref,
            event.payload.verified_state_snapshot.artifact_ref,
          ],
        );
        break;
      }
      case "episode_closed":
        material.episode_status = "closed";
        material.next_action = null;
        material.evidence_refs = addEvidenceIdentities(
          material.evidence_refs,
          event,
          event.payload.final_state_snapshot
            ? [event.payload.final_state_snapshot.artifact_ref]
            : [],
        );
        if (event.payload.final_state_snapshot) {
          material.active_artifacts = addArtifact(
            material.active_artifacts,
            [event.payload.final_state_snapshot.artifact_ref],
          );
        }
        break;
    }
    const nextBranch = advanceBranchState(
      priorContinuity.branch_state,
      event,
      material,
    );
    projected = stateFromMaterial(
      material,
      event.occurred_at,
      continuityDraft(
        material,
        priorContinuity.task_contract,
        nextBranch,
      ),
    );
    history.push(projected);
  }
  const snapshot = currentSnapshot(
    input.events,
    input.current_state_snapshot_id,
  );
  if (
    projected.subject.current_snapshot_id !== snapshot.snapshot_id
    || projected.subject.current_content_sha256 !== snapshot.content_digest
    || projected.episode_status !== (
      input.events.at(-1)?.payload.event_kind === "episode_closed"
        ? "closed"
        : "open"
    )
  ) {
    throw new Error("current_execution_state_replay_projection_mismatch");
  }
  return Object.freeze(history.map((state) =>
    CurrentExecutionStateV2Schema.parse(state)
  ));
}

export function projectCurrentExecutionStateV2(
  input: CurrentExecutionStateProjectionInputV2,
): CurrentExecutionStateV2 {
  const projected = projectCurrentExecutionStateHistoryV2(input).at(-1);
  if (!projected) {
    throw new Error("current_execution_state_projection_missing");
  }
  return projected;
}

export function loadCurrentExecutionStateHeadV2(
  args: Readonly<{
    replay: LiteExecutionEpisodeReplay;
    stateStore: ExecutionStateStore;
    continuationId?: string;
  }>,
): StoredCurrentExecutionStateV2 {
  const continuationId =
    args.continuationId
    ?? `continuation:${args.replay.episode.episode_id}`;
  const stored = args.stateStore.getCurrent(
    args.replay.episode.store_scope,
    continuationId,
  );
  const latestEvent = args.replay.events.at(-1);
  const snapshot = currentSnapshot(
    args.replay.events,
    args.replay.current_state_snapshot_id,
  );
  const expectedProjectionEventId =
    args.replay.events.length === 1
      ? null
      : latestEvent?.event_id ?? null;
  if (
    !stored
    || !latestEvent
    || stored.revision !== args.replay.events.length
    || stored.state.revision !== args.replay.events.length
    || stored.state.scope_id !== args.replay.episode.store_scope
    || stored.state.continuation_id !== continuationId
    || stored.state.task_run_id !== args.replay.episode.run_id
    || stored.state.episode_id !== args.replay.episode.episode_id
    || stored.state.subject.identity_sha256
      !== args.replay.episode.subject_identity.identity_sha256
    || stored.state.subject.current_snapshot_id
      !== args.replay.current_state_snapshot_id
    || stored.state.subject.current_content_sha256
      !== snapshot.content_digest
    || stored.state.episode_status
      !== (args.replay.closed ? "closed" : "open")
    || stored.last_projection_event_id !== expectedProjectionEventId
  ) {
    throw new Error("current_execution_state_head_mismatch");
  }
  return stored;
}

export async function synchronizeCurrentExecutionStateHeadV2(
  args: Readonly<{
    replay: LiteExecutionEpisodeReplay;
    stateStore: ExecutionStateStore;
    artifactStore: LiteEvidenceArtifactStore;
    sourceTaskBytes?: Buffer;
    continuationId?: string;
    parentEpisodeId?: string | null;
  }>,
): Promise<StoredCurrentExecutionStateV2> {
  const goalBytes = args.sourceTaskBytes
    ?? await args.artifactStore.readArtifactBytes({
      tenantId: args.replay.episode.tenant_id,
      scope: args.replay.episode.store_scope,
      episodeId: args.replay.episode.episode_id,
      artifactId: args.replay.episode.source_task_ref.artifact_id,
    });
  const decoded = goalBytes.toString("utf8");
  const goal = Buffer.from(decoded, "utf8").equals(goalBytes)
    ? decoded
    : `Task source retained as evidence sha256=${args.replay.episode.source_task_ref.sha256}`;
  const history = projectCurrentExecutionStateHistoryV2({
    episode: args.replay.episode,
    events: args.replay.events,
    current_state_snapshot_id: args.replay.current_state_snapshot_id,
    goal,
    ...(args.continuationId
      ? { continuation_id: args.continuationId }
      : {}),
    ...(args.parentEpisodeId !== undefined
      ? { parent_episode_id: args.parentEpisodeId }
      : {}),
  });
  const initial = history[0];
  if (!initial) {
    throw new Error("current_execution_state_projection_history_missing");
  }
  let stored = args.stateStore.getCurrent(
    initial.scope_id,
    initial.continuation_id,
  );
  if (!stored) {
    stored = args.stateStore.initializeCurrent(initial);
  }
  const expectedStoredState = history[stored.revision - 1];
  if (
    !expectedStoredState
    || expectedStoredState.state_sha256 !== stored.state.state_sha256
  ) {
    throw new Error(
      "current_execution_state_projector_cursor_head_mismatch",
    );
  }
  for (let index = stored.revision; index < history.length; index += 1) {
    const next = history[index]!;
    const sourceEvent = args.replay.events[index];
    if (!sourceEvent) {
      throw new Error(
        "current_execution_state_projection_source_event_missing",
      );
    }
    stored = args.stateStore.advanceCurrent({
      state: next,
      sourceEvent: {
        event_id: sourceEvent.event_id,
        event_sha256: sourceEvent.event_sha256,
        sequence: sourceEvent.sequence,
      },
    });
  }
  const projected = history.at(-1);
  if (
    !projected
    || stored.state.state_sha256 !== projected.state_sha256
    || stored.revision !== projected.revision
  ) {
    throw new Error(
      "current_execution_state_projection_head_incomplete",
    );
  }
  return loadCurrentExecutionStateHeadV2({
    replay: args.replay,
    stateStore: args.stateStore,
    ...(args.continuationId
      ? { continuationId: args.continuationId }
      : {}),
  });
}

function continuityProjectionForRender(
  state: CurrentExecutionStateV2,
): CurrentExecutionContinuityProjectionV1 {
  if (state.continuity_projection) {
    return state.continuity_projection;
  }
  const {
    state_sha256: _stateSha256,
    updated_at: _updatedAt,
    continuity_projection: _continuityProjection,
    ...materialInput
  } = state;
  const material = CurrentExecutionStateV2MaterialSchema.parse(
    materialInput,
  );
  const currentFact = [...state.verified_facts].reverse().find(
    (fact) =>
      fact.target_state_snapshot_id
        === state.subject.current_snapshot_id,
  );
  const currentCandidate: CurrentExecutionBranchCandidateV1 = currentFact
    ? {
        snapshot_id: state.subject.current_snapshot_id,
        content_sha256: state.subject.current_content_sha256,
        snapshot_ref: state.subject.current_snapshot_ref,
        verification_status: currentFact.status,
        verifier_id: currentFact.verifier_id,
        verifier_receipt_id: currentFact.fact_id,
        verified_at: currentFact.verified_at,
      }
    : {
        snapshot_id: state.subject.current_snapshot_id,
        content_sha256: state.subject.current_content_sha256,
        snapshot_ref: state.subject.current_snapshot_ref,
        verification_status: "unverified",
        verifier_id: null,
        verifier_receipt_id: null,
        verified_at: null,
      };
  const accepted: CurrentExecutionAcceptedBranchV1 | null =
    currentFact?.status === "passed"
      ? {
          snapshot_id: state.subject.current_snapshot_id,
          content_sha256: state.subject.current_content_sha256,
          snapshot_ref: state.subject.current_snapshot_ref,
          verifier_id: currentFact.verifier_id,
          verifier_receipt_id: currentFact.fact_id,
          verified_at: currentFact.verified_at,
          evidence_refs: currentFact.evidence_refs,
        }
      : null;
  const taskContract = initialTaskContract({
    text: state.goal,
    sourceCompleteInState:
      !state.goal.endsWith("…")
      && !state.goal.startsWith(
        "Task source retained as evidence sha256=",
      ),
  }, state.goal_evidence_ref);
  return finalizeContinuityProjection(
    state.state_sha256,
    continuityDraft(
      material,
      taskContract,
      branchState(currentCandidate, accepted),
    ),
  );
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function authorityLabel(value: CurrentExecutionClaimAuthorityV2): string {
  if (value.kind !== "model_derived") return value.kind;
  return `model_derived uncertainty=${value.uncertainty ?? "unknown"}`;
}

function isModelDerived(
  value: Readonly<{ authority: CurrentExecutionClaimAuthorityV2 }>,
): boolean {
  return value.authority.kind === "model_derived";
}

function evidenceLabel(
  values: readonly CurrentExecutionEvidenceRefV2[],
): string {
  return values.slice(0, 3).map((value) => value.artifact_id).join(",");
}

function bracketedDetails(values: readonly string[]): string {
  const details = values.filter((value) => value.length > 0);
  return details.length > 0 ? ` [${details.join("; ")}]` : "";
}

function itemLines(
  label: string,
  values: readonly CurrentExecutionItemV2[],
  limit: number,
  includeProvenance: boolean,
): string[] {
  if (values.length === 0 || limit === 0) return [];
  return [
    `${label}:`,
    ...values.slice(-limit).map((value) =>
      `- ${compact(value.statement, 420)}${bracketedDetails([
        authorityLabel(value.authority),
        includeProvenance ? `event=${value.source_event.event_id}` : "",
        includeProvenance
          ? `evidence=${evidenceLabel(value.evidence_refs)}`
          : "",
      ])}`
    ),
  ];
}

function decisiveEvidenceSourcePriority(
  value: CurrentExecutionDecisiveEvidenceV1,
): number {
  if (value.source_ref === "task") return 2;
  if (value.source_ref === "workspace") return 1;
  return 0;
}

const DECISIVE_EVIDENCE_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "into",
  "not",
  "that",
  "the",
  "this",
  "with",
]);

function decisiveEvidenceSelectionTerms(value: string): Set<string> {
  const terms = new Set<string>();
  const addTerm = (candidate: string): void => {
    const term = candidate.toLowerCase();
    if (
      term.length >= 3
      && !DECISIVE_EVIDENCE_STOP_WORDS.has(term)
    ) {
      terms.add(term);
    }
  };
  for (
    const token of
      value.match(/[a-z0-9_./:-]{3,}/giu) ?? []
  ) {
    addTerm(token);
    for (
      const part of token
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .split(/[^a-z0-9]+/giu)
    ) {
      addTerm(part);
    }
  }
  return terms;
}

function decisiveEvidenceTermsMatch(
  expected: string,
  observed: ReadonlySet<string>,
): boolean {
  if (observed.has(expected)) return true;
  if (expected.length < 5) return false;
  for (const candidate of observed) {
    const shorterLength = Math.min(
      expected.length,
      candidate.length,
    );
    if (
      shorterLength >= 5
      && (
        expected.startsWith(candidate)
        || candidate.startsWith(expected)
      )
    ) {
      return true;
    }
  }
  return false;
}

function decisiveEvidenceLexicalOverlap(
  value: CurrentExecutionDecisiveEvidenceV1,
  selectionText: string,
): number {
  const expected = decisiveEvidenceSelectionTerms(selectionText);
  if (expected.size === 0) return 0;
  const observed = decisiveEvidenceSelectionTerms(value.excerpt);
  let overlap = 0;
  for (const term of expected) {
    if (decisiveEvidenceTermsMatch(term, observed)) overlap += 1;
  }
  return overlap;
}

function decisiveEvidenceRelationPosition(
  value: CurrentExecutionDecisiveEvidenceV1,
  selectionText: string,
): Readonly<{
  resource: number;
  line: number;
}> {
  const match = /^(.+):([1-9][0-9]*):/u.exec(
    value.excerpt.trim(),
  );
  if (!match) {
    return {
      resource: Number.MAX_SAFE_INTEGER,
      line: Number.MAX_SAFE_INTEGER,
    };
  }
  const resource = match[1]!;
  const line = match[2]!;
  const resourcePosition = selectionText.indexOf(resource);
  if (resourcePosition < 0) {
    return {
      resource: Number.MAX_SAFE_INTEGER,
      line: Number.MAX_SAFE_INTEGER,
    };
  }
  const linePosition = selectionText.indexOf(
    line,
    resourcePosition + resource.length,
  );
  return {
    resource: resourcePosition,
    line:
      linePosition >= 0
        ? linePosition
        : Number.MAX_SAFE_INTEGER,
  };
}

function decisiveEvidenceLines(
  state: CurrentExecutionStateV2,
  policy: CurrentStateRenderPolicyV1,
  options: Readonly<{
    heading?: string;
    nextActionOnly?: boolean;
  }> = {},
): string[] {
  const itemLimit = policy.max_decisive_evidence ?? 0;
  const characterLimit = policy.max_decisive_evidence_chars ?? 0;
  const evidence = state.decisive_evidence ?? [];
  if (
    evidence.length === 0
    || itemLimit === 0
    || characterLimit === 0
  ) {
    return [];
  }

  const prioritizedEventIds: string[] = [];
  const seenEventIds = new Set<string>();
  const selectionTextByEventId = new Map<string, string>();
  const addEventId = (
    eventId: string,
    selectionText: string,
  ): void => {
    if (!seenEventIds.has(eventId)) {
      seenEventIds.add(eventId);
      prioritizedEventIds.push(eventId);
      selectionTextByEventId.set(eventId, selectionText);
    }
  };
  if (state.next_action) {
    addEventId(
      state.next_action.source_event.event_id,
      `${state.next_action.intent} ${state.next_action.justification}`,
    );
  }
  if (!options.nextActionOnly) {
    const addRecentItems = (
      values: readonly CurrentExecutionItemV2[],
    ): void => {
      if (policy.max_items_per_status === 0) return;
      for (
        const value of
          values.slice(-policy.max_items_per_status).reverse()
      ) {
        addEventId(value.source_event.event_id, value.statement);
      }
    };
    addRecentItems(state.completed);
    addRecentItems(state.unresolved);
    addRecentItems(state.blocked);
    addRecentItems(state.failed);
    if (policy.max_observations > 0) {
      for (
        const value of
          state.observations.slice(-policy.max_observations).reverse()
      ) {
        addEventId(value.source_event.event_id, value.statement);
      }
    }
    if (policy.max_decisions > 0) {
      for (
        const value of
          state.decisions.slice(-policy.max_decisions).reverse()
      ) {
        addEventId(
          value.source_event.event_id,
          `${value.statement} ${value.reasons.join(" ")}`,
        );
      }
    }
  }

  const byEventId = new Map<string, CurrentExecutionDecisiveEvidenceV1[]>();
  for (const value of evidence) {
    const current = byEventId.get(value.source_event.event_id) ?? [];
    current.push(value);
    byEventId.set(value.source_event.event_id, current);
  }

  const selectedLines: string[] = [];
  const selectedEvidenceIds = new Set<string>();
  const taskSelectionText =
    (state.continuity_projection?.task_contract.constraints ?? [])
      .map((constraint) => constraint.statement)
      .join(" ");
  const rankedEvidenceByEventId = new Map<
    string,
    CurrentExecutionDecisiveEvidenceV1[]
  >();
  for (const eventId of prioritizedEventIds) {
    const selectionText = [
      taskSelectionText,
      selectionTextByEventId.get(eventId) ?? "",
    ].filter(Boolean).join(" ");
    const ranked = [...(byEventId.get(eventId) ?? [])].sort(
      (left, right) => {
        const sourcePriority =
          decisiveEvidenceSourcePriority(left)
          - decisiveEvidenceSourcePriority(right);
        if (sourcePriority !== 0) return sourcePriority;
        const leftRelationPosition =
          decisiveEvidenceRelationPosition(left, selectionText);
        const rightRelationPosition =
          decisiveEvidenceRelationPosition(right, selectionText);
        const relationResourceOrder =
          leftRelationPosition.resource
          - rightRelationPosition.resource;
        if (relationResourceOrder !== 0) {
          return relationResourceOrder;
        }
        const relationLineOrder =
          leftRelationPosition.line
          - rightRelationPosition.line;
        if (relationLineOrder !== 0) return relationLineOrder;
        const overlap =
          decisiveEvidenceLexicalOverlap(right, selectionText)
          - decisiveEvidenceLexicalOverlap(left, selectionText);
        if (overlap !== 0) return overlap;
        return left.evidence_id.localeCompare(right.evidence_id);
      },
    );
    if (ranked.length > 0) {
      rankedEvidenceByEventId.set(eventId, ranked);
    }
  }
  let usedCharacters = 0;
  const appendEvidence = (
    value: CurrentExecutionDecisiveEvidenceV1,
  ): void => {
    if (
      selectedLines.length >= itemLimit
      || selectedEvidenceIds.has(value.evidence_id)
    ) {
      return;
    }
    const line =
      `- source=${JSON.stringify(value.source_ref)} excerpt=${JSON.stringify(value.excerpt)}`;
    if (usedCharacters + line.length > characterLimit) {
      return;
    }
    selectedEvidenceIds.add(value.evidence_id);
    selectedLines.push(line);
    usedCharacters += line.length;
  };
  // Reserve one exact excerpt for every evidence-bearing event before any
  // single search frontier can consume the whole compact-agent budget.
  for (const eventId of prioritizedEventIds) {
    const first = rankedEvidenceByEventId.get(eventId)?.[0];
    if (first) appendEvidence(first);
  }
  for (const eventId of prioritizedEventIds) {
    for (
      const value of
        rankedEvidenceByEventId.get(eventId)?.slice(1) ?? []
    ) {
      appendEvidence(value);
    }
  }
  return selectedLines.length > 0
    ? [options.heading ?? "decisive_evidence:", ...selectedLines]
    : [];
}

function boundedRenderText(lines: readonly string[], maxChars: number): string {
  const text = lines.filter(Boolean).join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function semanticItemLines(
  state: CurrentExecutionStateV2,
  policy: CurrentStateRenderPolicyV1,
): string[] {
  const groups = [
    ["blocked", state.blocked],
    ["unresolved", state.unresolved],
    ["failed", state.failed],
    ["completed", state.completed],
  ] as const;
  const values = groups.flatMap(([status, items]) =>
    items.slice(-policy.max_items_per_status).map((item) => ({
      status,
      item,
    }))
  );
  if (values.length === 0) return [];
  return [
    "progress:",
    ...values.map(({ status, item }) =>
      `- [${status}${isModelDerived(item) ? ", hypothesis" : ""}] ${compact(item.statement, 300)}`
    ),
  ];
}

function protectedTaskContractLines(
  continuity: CurrentExecutionContinuityProjectionV1,
  maxChars: number,
): string[] {
  const contract = continuity.task_contract;
  const header =
    `protected_task_contract: verification=${contract.verification_status} coverage=${contract.coverage.satisfied_count}/${contract.coverage.required_count} source_complete=${contract.source_complete_in_state}`;
  const lines = [header];
  let used = header.length;
  let retainedCount = 0;
  for (const constraint of contract.constraints) {
    const prefix = `- [required/${constraint.status}] `;
    const exactStatement = constraint.statement.replace(/\s+/gu, " ").trim();
    const remaining = maxChars - used - 1;
    if (remaining <= prefix.length + 80) break;
    const truncationMarker =
      ` [excerpt; exact_sha256=${constraint.statement_sha256}]`;
    const fullLine = `${prefix}${exactStatement}`;
    const line = fullLine.length <= remaining
      ? fullLine
      : `${prefix}${compact(
        exactStatement,
        Math.max(
          40,
          remaining - prefix.length - truncationMarker.length,
        ),
      )}${truncationMarker}`;
    if (used + line.length + 1 > maxChars) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
    retainedCount += 1;
  }
  if (retainedCount < contract.constraints.length) {
    const omitted =
      `- ${contract.constraints.length - retainedCount} additional required constraint(s) retained by source_sha256=${contract.source_text_sha256}`;
    if (used + omitted.length + 1 <= maxChars) {
      lines.push(omitted);
    }
  }
  return lines;
}

function branchAndReadinessLines(
  continuity: CurrentExecutionContinuityProjectionV1,
): string[] {
  const branch = continuity.branch_state;
  const readinessValue = continuity.readiness;
  const lines = [
    `readiness: ${readinessValue.status} safe_to_execute_planned_action=${readinessValue.safe_to_execute_planned_action} unresolved_constraints=${readinessValue.unresolved_constraint_count} conflicts=${readinessValue.unresolved_conflict_count}`,
    `current_branch: snapshot=${branch.current_candidate.snapshot_id} verification=${branch.current_candidate.verification_status}`,
  ];
  const ledger = branch.candidate_ledger;
  if (ledger && ledger.total_candidate_count > 1) {
    lines.push(
      `candidate_ledger: retained=${ledger.retained_candidate_count}/${ledger.total_candidate_count} complete=${ledger.history_complete_in_projection}; unverified candidates are preserved, not evidence-ranked`,
    );
    const latestPrior = ledger.entries.at(-2);
    if (latestPrior) {
      const delta = latestPrior.transition;
      const changed = delta?.changed_fields_preview.slice(0, 3).join(",")
        ?? "episode-root";
      lines.push(
        `latest_prior_candidate: snapshot=${latestPrior.candidate.snapshot_id} verification=${latestPrior.candidate.verification_status} action=${delta?.action_kind ?? "none"} changed=${compact(changed, 220)}`,
      );
    }
  }
  if (branch.last_verifier_accepted) {
    lines.push(
      `last_verifier_accepted: snapshot=${branch.last_verifier_accepted.snapshot_id} verifier=${branch.last_verifier_accepted.verifier_id} current=${branch.accepted_candidate_is_current}`,
    );
  }
  if (branch.recovery_candidate_available) {
    const recommendation = branch.recovery_recommendation;
    if (recommendation) {
      lines.push(
        `recovery_action: restore_snapshot target=${recommendation.target_accepted_candidate.snapshot_id} reason=${recommendation.reason_code}`,
        `recovery_evidence: current_failed_receipt=${recommendation.current_failed_candidate.verifier_receipt_id} target_passed_receipt=${recommendation.target_accepted_candidate.verifier_receipt_id}`,
      );
    } else {
      lines.push(
        "branch_guard: the exact last verifier-accepted snapshot remains available; the current branch has not been proven superior, so verify it before choosing either branch",
      );
    }
  }
  return lines;
}

function semanticActionLines(
  state: CurrentExecutionStateV2,
): string[] {
  const action = state.next_action;
  if (!action) {
    return [
      "next_action: none recorded; resolve the decision frontier from current evidence before mutation",
    ];
  }
  const actionSufficiency = action.action_sufficiency;
  return [
    `${isModelDerived(action) ? "proposed_next_action" : "next_action"}: ${compact(action.intent, 460)}`,
    `next_action_why: ${compact(action.justification, 460)}`,
    `next_action_bound_snapshot: ${action.target_state_snapshot_id}`,
    ...(actionSufficiency
      ? [
        `action_sufficiency: status=${actionSufficiency.status} mode=${actionSufficiency.recommended_mode} maximum_additional_observations=${actionSufficiency.maximum_additional_observations}`,
        `information_value_rule: ${actionSufficiency.information_value_rule} reasons=${actionSufficiency.reason_codes.join(",")}`,
      ]
      : []),
    ...(action.preconditions.length > 0
      ? [
          "next_action_preconditions:",
          ...action.preconditions.slice(0, 4).map(
            (precondition) => `- ${compact(precondition, 260)}`,
          ),
          ...(action.preconditions.length > 4
            ? [
                `- ${action.preconditions.length - 4} additional precondition(s) retained in structured state`,
              ]
            : []),
        ]
      : []),
  ];
}

function decisionFrontierLines(
  continuity: CurrentExecutionContinuityProjectionV1,
): string[] {
  if (continuity.decision_frontier.items.length === 0) {
    return [];
  }
  return [
    "decision_frontier:",
    ...continuity.decision_frontier.items.slice(0, 5).map(
      (item) => `- [${item.kind}] ${compact(item.statement, 300)}`,
    ),
  ];
}

function epistemicStateLines(
  continuity: CurrentExecutionContinuityProjectionV1,
  policy: CurrentStateRenderPolicyV1,
): string[] {
  const beliefs = continuity.epistemic_state.beliefs;
  if (policy.max_observations === 0 || beliefs.length === 0) {
    return [];
  }
  const authoritative = beliefs.filter((belief) =>
    belief.epistemic_status === "supported"
    || belief.epistemic_status === "reported"
  );
  const contradictions = beliefs.filter(
    (belief) => belief.epistemic_status === "contradicted",
  );
  const unresolved = beliefs.filter(
    (belief) => belief.epistemic_status === "unknown",
  );
  const hypotheses = beliefs.filter(
    (belief) => belief.epistemic_status === "hypothesis",
  );
  const selected = [
    ...contradictions.slice(-policy.max_observations),
    ...authoritative.slice(-policy.max_observations),
    ...unresolved.slice(-policy.max_observations),
    ...hypotheses.slice(-policy.max_observations),
  ].slice(0, policy.max_observations);
  return [
    "belief_ledger:",
    ...selected.map((belief) =>
      `- [${belief.epistemic_status}] ${compact(belief.statement, 300)}`
    ),
  ];
}

function semanticStateLines(
  state: CurrentExecutionStateV2,
  policy: CurrentStateRenderPolicyV1,
): string[] {
  const continuity = continuityProjectionForRender(state);
  const taskContractBudget = Math.min(
    1_150,
    Math.max(560, Math.floor(policy.max_chars * 0.38)),
  );
  const lines: string[] = [
    "[Aionis Current Execution State v2]",
    `state: status=${state.episode_status} revision=${state.revision} subject=${state.subject.kind}`,
    ...protectedTaskContractLines(continuity, taskContractBudget),
    ...branchAndReadinessLines(continuity),
    ...semanticActionLines(state),
    ...decisiveEvidenceLines(state, policy, {
      heading: "continuation_evidence:",
    }),
  ];
  if (state.verified_facts.length > 0 && policy.max_verified_facts > 0) {
    lines.push("verified:");
    for (
      const fact of
        state.verified_facts.slice(-policy.max_verified_facts)
    ) {
      lines.push(
        `- [${fact.status}] ${compact(fact.statement, 300)}`,
      );
    }
  }
  lines.push(...decisionFrontierLines(continuity));
  lines.push(...semanticItemLines(state, policy));
  if (state.decisions.length > 0 && policy.max_decisions > 0) {
    lines.push("decisions:");
    for (const decision of state.decisions.slice(-policy.max_decisions)) {
      lines.push(
        `- ${isModelDerived(decision) ? "[hypothesis] " : ""}${compact(decision.statement, 300)}`,
      );
    }
  }
  lines.push(...epistemicStateLines(continuity, policy));
  if (state.pending_checks.length > 0) {
    lines.push(
      `pending_checks: ${state.pending_checks.slice(0, 5).map((check) =>
        check.verifier_id
      ).join(", ")}`,
    );
  }
  return lines;
}

function finalizeCurrentStateRender(args: Readonly<{
  state: CurrentExecutionStateV2;
  policy: CurrentStateRenderPolicyV1;
  lines: readonly string[];
  tokenMeasurement?: CurrentExecutionStateTokenMeasurementV1 | null;
}>): CurrentExecutionStateRenderV1 {
  const text = boundedRenderText(args.lines, args.policy.max_chars);
  const measurement = args.tokenMeasurement ?? null;
  const tokenCount = measurement ? measurement.count(text) : null;
  if (
    tokenCount !== null
    && (!Number.isSafeInteger(tokenCount) || tokenCount < 0)
  ) {
    throw new Error("current_execution_state_token_count_invalid");
  }
  const material = {
    contract_version: "current_execution_state_render_v1" as const,
    state_sha256: args.state.state_sha256,
    policy: args.policy,
    text,
    character_count: text.length,
    utf8_byte_count: Buffer.byteLength(text, "utf8"),
    token_count: tokenCount,
    token_measurement: measurement
      ? {
          authority: measurement.authority,
          tokenizer_id: measurement.tokenizer_id,
        }
      : {
          authority: "unavailable" as const,
          tokenizer_id: null,
        },
  };
  return CurrentExecutionStateRenderV1Schema.parse({
    ...material,
    render_sha256: sha256Hex(stableStringify(material)),
  });
}

export function renderCurrentExecutionStateV2(args: Readonly<{
  state: CurrentExecutionStateV2;
  policy?: CurrentStateRenderPolicyV1;
  tokenMeasurement?: CurrentExecutionStateTokenMeasurementV1 | null;
}>): CurrentExecutionStateRenderV1 {
  const state = CurrentExecutionStateV2Schema.parse(args.state);
  const policy = CurrentStateRenderPolicyV1Schema.parse(
    args.policy ?? DEFAULT_CURRENT_STATE_RENDER_POLICY_V1,
  );
  if (policy.audience === "agent") {
    return finalizeCurrentStateRender({
      state,
      policy,
      lines: semanticStateLines(state, policy),
      tokenMeasurement: args.tokenMeasurement,
    });
  }
  const includeProvenance = policy.max_evidence_refs > 0;
  const nextAction = state.next_action;
  const hasModelDerivedGuidance =
    (nextAction !== null && isModelDerived(nextAction))
    || state.decisions.some(isModelDerived);
  const lines: string[] = [
    "[Aionis Current Execution State v2]",
    includeProvenance
      ? `continuation=${state.continuation_id} episode=${state.episode_id} revision=${state.revision} status=${state.episode_status}`
      : `revision=${state.revision} status=${state.episode_status}`,
    includeProvenance
      ? `subject=${state.subject.kind}:${state.subject.adapter_id}@${state.subject.adapter_version} snapshot=${state.subject.current_snapshot_id} content_sha256=${state.subject.current_content_sha256}`
      : `subject=${state.subject.kind}:${state.subject.adapter_id}@${state.subject.adapter_version}`,
    `goal: ${compact(state.goal, 1_000)}`,
    ...(hasModelDerivedGuidance
      ? [
          "epistemic_boundary: model-derived decisions and proposed actions are unverified working hypotheses; validate their assumptions against the current subject before mutation",
        ]
      : []),
    nextAction
      ? `${isModelDerived(nextAction) ? "proposed_next_action" : "next_action"}: ${compact(nextAction.intent, 600)}${bracketedDetails([
        authorityLabel(nextAction.authority),
        `why=${compact(nextAction.justification, 420)}`,
        nextAction.preconditions.length > 0
          ? `preconditions=${nextAction.preconditions.slice(0, 3).map((value) => compact(value, 160)).join(" | ")}`
          : "",
        nextAction.action_sufficiency
          ? `action_sufficiency=${nextAction.action_sufficiency.status}/${nextAction.action_sufficiency.recommended_mode}/max_observations:${nextAction.action_sufficiency.maximum_additional_observations}`
          : "",
        includeProvenance
          ? `event=${nextAction.source_event.event_id}`
          : "",
        includeProvenance
          ? `evidence=${evidenceLabel(nextAction.evidence_refs)}`
          : "",
      ])}`
      : "next_action: none recorded; choose from current evidence and record a new justified plan before acting",
  ];
  lines.push(...decisiveEvidenceLines(state, policy));
  if (state.verified_facts.length > 0 && policy.max_verified_facts > 0) {
    lines.push("verifier_facts:");
    for (
      const fact of
        state.verified_facts.slice(-policy.max_verified_facts)
    ) {
      lines.push(
        `- ${compact(fact.statement, 420)}${bracketedDetails([
          includeProvenance ? `event=${fact.source_event.event_id}` : "",
          includeProvenance
            ? `evidence=${evidenceLabel(fact.evidence_refs)}`
            : "",
        ])}`,
      );
    }
  }
  if (state.pending_checks.length > 0) {
    lines.push(
      `pending_checks: ${state.pending_checks.slice(0, 8).map((check) =>
        includeProvenance
          ? `${check.verifier_id}@${check.target_state_snapshot_id}`
          : check.verifier_id
      ).join(", ")}`,
    );
  }
  lines.push(
    ...itemLines(
      "blocked",
      state.blocked,
      policy.max_items_per_status,
      includeProvenance,
    ),
    ...itemLines(
      "unresolved",
      state.unresolved,
      policy.max_items_per_status,
      includeProvenance,
    ),
    ...itemLines(
      "failed",
      state.failed,
      policy.max_items_per_status,
      includeProvenance,
    ),
    ...itemLines(
      "completed",
      state.completed,
      policy.max_items_per_status,
      includeProvenance,
    ),
  );
  if (state.decisions.length > 0 && policy.max_decisions > 0) {
    lines.push("decisions:");
    for (const decision of state.decisions.slice(-policy.max_decisions)) {
      lines.push(
        `- ${isModelDerived(decision) ? "model-derived hypothesis: " : ""}${compact(decision.statement, 420)}${bracketedDetails([
          authorityLabel(decision.authority),
          `reasons=${decision.reasons.slice(0, 3).map((value) => compact(value, 180)).join(" | ")}`,
          includeProvenance
            ? `event=${decision.source_event.event_id}`
            : "",
          includeProvenance
            ? `evidence=${evidenceLabel(decision.evidence_refs)}`
            : "",
        ])}`,
      );
    }
  }
  if (state.observations.length > 0 && policy.max_observations > 0) {
    lines.push("latest_observations:");
    for (
      const observation of
        state.observations.slice(-policy.max_observations)
    ) {
      lines.push(
        `- ${compact(observation.statement, 420)}${bracketedDetails([
          authorityLabel(observation.authority),
          includeProvenance
            ? `event=${observation.source_event.event_id}`
            : "",
          includeProvenance
            ? `evidence=${evidenceLabel(observation.evidence_refs)}`
            : "",
        ])}`,
      );
    }
  }
  if (policy.max_evidence_refs > 0) {
    lines.push(
      `evidence_refs: ${state.evidence_refs.slice(-policy.max_evidence_refs).join(" | ")}`,
    );
  }
  return finalizeCurrentStateRender({
    state,
    policy,
    lines,
    tokenMeasurement: args.tokenMeasurement,
  });
}
