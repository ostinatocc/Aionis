import stableStringify from "fast-json-stable-stringify";

import {
  isEpisodeRewardSelectorEligible,
  episodeRewardDigest,
  type DecisionCommittedReceiptV1,
} from "../memory/execution-episode.js";
import {
  parseGuideExposureLedger,
  type ProductGuideExposureLedger,
} from "../product/product-services.js";
import type {
  LiteExecutionEpisodeReplay,
} from "../store/lite-execution-episode-store.js";
import type {
  LiteFindNodeRow,
  LiteProductGuideReceiptRow,
  LiteWriteOperationRow,
} from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";
import {
  CanonicalL1EpisodeV1Schema,
  canonicalL1EpisodeDigest,
  type CanonicalL1EpisodeV1,
  type CanonicalL1InterventionKindV1,
  type CanonicalL1MemoryLayerV1,
} from "./canonical-l1-contract.js";

type JsonRecord = Record<string, unknown>;

type ParsedGuideReceipt = Readonly<{
  row: LiteProductGuideReceiptRow;
  ledger: ProductGuideExposureLedger;
}>;

type ParsedFeedbackUse = Readonly<{
  feedback_operation_id: string;
  feedback_request_sha256: string;
  guide_trace_id: string;
  memory_ids: readonly string[];
  reported_surface:
    | "use_now"
    | "inspect_before_use"
    | "do_not_use"
    | "explicit_host_assertion";
  outcome: "positive" | "negative" | "neutral";
  verifier_status: "passed" | "failed" | "not_run" | "unknown" | null;
  tool_status: "succeeded" | "failed" | "not_run" | "unknown" | null;
  verified_host_receipt: boolean;
  runtime_signal_refs: readonly string[];
  recorded_at: string;
}>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = stringValue(entry);
    return text ? [text] : [];
  });
}

function canonicalSort(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

function artifactReference(ref: {
  artifact_id: string;
  sha256: string;
}): string {
  return `artifact:${ref.artifact_id}:sha256:${ref.sha256}`;
}

function parseGuideReceipt(
  row: LiteProductGuideReceiptRow,
): ParsedGuideReceipt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.ledger_json) as unknown;
  } catch {
    return null;
  }
  if (
    stableStringify(parsed) !== row.ledger_json
    || sha256Hex(row.ledger_json) !== row.ledger_sha256
  ) {
    return null;
  }
  const ledger = parseGuideExposureLedger(parsed);
  if (
    !ledger
    || ledger.tenant_id !== row.tenant_id
    || ledger.scope !== row.scope
    || ledger.guide_trace_id !== row.guide_trace_id
    || ledger.run_id !== row.run_id
  ) {
    return null;
  }
  return { row, ledger };
}

function parseFeedbackUse(
  row: LiteWriteOperationRow,
  runId: string,
  closedAt: string,
): ParsedFeedbackUse | null {
  if (
    row.operation_kind !== "product_feedback_v1"
    || row.created_at > closedAt
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_json) as unknown;
  } catch {
    return null;
  }
  if (stableStringify(parsed) !== row.receipt_json) return null;
  const result = asRecord(parsed);
  const body = asRecord(result?.body);
  const effect = asRecord(body?.forget_effect);
  const guideTrace = asRecord(effect?.guide_trace);
  const attribution = asRecord(effect?.attribution);
  const guideTraceId = stringValue(guideTrace?.guide_trace_id);
  const outcome = attribution?.outcome;
  const reportedSurface = attribution?.used_surface;
  if (
    result?.ok !== true
    || result.statusCode !== 200
    || body?.contract_version !== "aionis_feedback_result_v1"
    || attribution?.run_id !== runId
    || !guideTraceId
    || (outcome !== "positive"
      && outcome !== "negative"
      && outcome !== "neutral")
    || (reportedSurface !== "use_now"
      && reportedSurface !== "inspect_before_use"
      && reportedSurface !== "do_not_use"
      && reportedSurface !== "explicit_host_assertion")
  ) {
    return null;
  }
  const verifierStatus = attribution.verifier_status;
  const toolStatus = attribution.tool_status;
  return {
    feedback_operation_id: row.operation_id,
    feedback_request_sha256: row.request_sha256,
    guide_trace_id: guideTraceId,
    memory_ids: canonicalSort(
      stringArray(guideTrace?.attributed_memory_ids),
    ),
    reported_surface: reportedSurface,
    outcome,
    verifier_status:
      verifierStatus === "passed"
      || verifierStatus === "failed"
      || verifierStatus === "not_run"
      || verifierStatus === "unknown"
        ? verifierStatus
        : null,
    tool_status:
      toolStatus === "succeeded"
      || toolStatus === "failed"
      || toolStatus === "not_run"
      || toolStatus === "unknown"
        ? toolStatus
        : null,
    verified_host_receipt:
      effect?.learning_attribution_status === "verified_host_receipt",
    runtime_signal_refs: canonicalSort(
      stringArray(attribution.runtime_signal_refs),
    ),
    recorded_at: row.created_at,
  };
}

function learningArtifact(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    record.contract_version === "canonical_l1_episode_v1"
    || record.contract_version === "contrastive_l2_hypothesis_v1"
    || record.contract_version === "heldout_l3_skill_version_v1"
    || record.contract_version === "procedure_hypothesis_v2"
    || record.contract_version === "validated_execution_skill_v1"
    || record.contract_version === "skill_validation_receipt_v1"
    || record.contract_version === "skill_lifecycle_receipt_v1"
  ) {
    return record;
  }
  return null;
}

function nodeLearningLayer(node: LiteFindNodeRow | undefined):
  CanonicalL1MemoryLayerV1 {
  if (!node) return "unknown";
  const artifact =
    learningArtifact(node.slots.execution_learning_artifact_v1)
    ?? learningArtifact(node.slots.canonical_l1_episode_v1)
    ?? learningArtifact(node.slots.contrastive_l2_hypothesis_v1)
    ?? learningArtifact(node.slots.heldout_l3_skill_version_v1)
    ?? learningArtifact(node.slots.procedure_hypothesis_v2)
    ?? learningArtifact(node.slots.validated_execution_skill_v1);
  const layer = artifact?.layer;
  if (
    layer === "L1"
    || layer === "L2"
    || layer === "L3"
    || layer === "L4"
    || layer === "L5"
  ) {
    return layer;
  }
  return "ordinary_memory";
}

function nodeArtifactDigest(node: LiteFindNodeRow | undefined): string | null {
  if (!node) return null;
  const artifact =
    learningArtifact(node.slots.execution_learning_artifact_v1)
    ?? learningArtifact(node.slots.canonical_l1_episode_v1)
    ?? learningArtifact(node.slots.contrastive_l2_hypothesis_v1)
    ?? learningArtifact(node.slots.heldout_l3_skill_version_v1)
    ?? learningArtifact(node.slots.procedure_hypothesis_v2)
    ?? learningArtifact(node.slots.validated_execution_skill_v1);
  if (!artifact) return null;
  for (const key of [
    "l1_sha256",
    "hypothesis_sha256",
    "skill_version_sha256",
    "content_sha256",
    "receipt_sha256",
    "capsule_sha256",
  ]) {
    const value = artifact[key];
    if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) {
      return value;
    }
  }
  return sha256Hex(stableStringify(artifact));
}

function servedSurface(
  ledger: ProductGuideExposureLedger,
  memoryId: string,
): "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate" {
  if (ledger.use_now_memory_ids.includes(memoryId)) return "use_now";
  if (ledger.inspect_before_use_memory_ids.includes(memoryId)) {
    return "inspect_before_use";
  }
  if (ledger.do_not_use_memory_ids.includes(memoryId)) return "do_not_use";
  if (ledger.rehydrate_memory_ids.includes(memoryId)) return "rehydrate";
  throw new Error(
    `canonical_l1_decision_memory_not_in_guide:${memoryId}`,
  );
}

function interventionKind(
  layers: readonly CanonicalL1MemoryLayerV1[],
): CanonicalL1InterventionKindV1 {
  if (layers.length === 0) return "state_only";
  const hasCandidate = layers.includes("L2");
  const hasValidated = layers.includes("L3");
  if (hasCandidate && hasValidated) return "mixed_skill";
  if (hasValidated) return "state_plus_validated_skill";
  if (hasCandidate) return "state_plus_candidate_skill";
  return "state_plus_memory";
}

function decisionEvents(
  replay: LiteExecutionEpisodeReplay,
): Array<{
  eventId: string;
  decision: DecisionCommittedReceiptV1;
}> {
  return replay.events.flatMap((event) =>
    event.payload.event_kind === "decision_committed"
      ? [{ eventId: event.event_id, decision: event.payload.decision }]
      : []);
}

export type BuildCanonicalL1EpisodeInput = Readonly<{
  replay: LiteExecutionEpisodeReplay;
  guideReceipts: readonly LiteProductGuideReceiptRow[];
  feedbackOperations: readonly LiteWriteOperationRow[];
  memoryNodes: readonly LiteFindNodeRow[];
}>;

export function buildCanonicalL1EpisodeV1(
  input: BuildCanonicalL1EpisodeInput,
): CanonicalL1EpisodeV1 {
  const { replay } = input;
  const closeEvent = replay.events.at(-1);
  if (
    !replay.closed
    || !replay.reward
    || !closeEvent
    || closeEvent.payload.event_kind !== "episode_closed"
    || (replay.reward.outcome_class !== "verified_pass"
      && replay.reward.outcome_class !== "verified_failure")
  ) {
    throw new Error("canonical_l1_requires_closed_verifier_backed_episode");
  }
  const closedAt = closeEvent.payload.closed_at;

  const parsedGuideReceipts = input.guideReceipts
    .map(parseGuideReceipt)
    .filter((entry): entry is ParsedGuideReceipt => entry !== null);
  const guideByTrace = new Map(
    parsedGuideReceipts.map((entry) => [entry.ledger.guide_trace_id, entry]),
  );
  const nodeById = new Map(input.memoryNodes.map((node) => [node.id, node]));
  const eligibilityReasons: string[] = [];

  const interventions = decisionEvents(replay).map((entry) => {
    const receipt = guideByTrace.get(entry.decision.guide_trace_id);
    if (
      !receipt
      || receipt.row.ledger_sha256 !== entry.decision.guide_receipt_digest
    ) {
      eligibilityReasons.push("guide_intervention_receipt_missing");
      return {
        contractMissing: true as const,
        entry,
      };
    }
    const deliveredMemory = canonicalSort(
      entry.decision.selected_candidate_ids,
    ).map((memoryId) => {
      const node = nodeById.get(memoryId);
      return {
        memory_id: memoryId,
        served_surface: servedSurface(receipt.ledger, memoryId),
        learning_layer: nodeLearningLayer(node),
        source_commit_id: node?.commit_id ?? null,
        artifact_sha256: nodeArtifactDigest(node),
      };
    });
    return {
      contractMissing: false as const,
      value: {
        decision_event_id: entry.eventId,
        decision_id: entry.decision.decision_id,
        decision_sha256: entry.decision.decision_digest,
        target_state_snapshot_id:
          entry.decision.target_state_snapshot_id,
        guide_trace_id: entry.decision.guide_trace_id,
        guide_receipt_sha256: receipt.row.ledger_sha256,
        candidate_set_sha256: entry.decision.candidate_set_digest,
        policy_id: entry.decision.policy_id,
        policy_version: entry.decision.policy_version,
        intervention_kind: interventionKind(
          deliveredMemory.map((item) => item.learning_layer),
        ),
        delivered_memory: deliveredMemory,
        committed_at: entry.decision.committed_at,
      },
    };
  }).flatMap((entry) => entry.contractMissing ? [] : [entry.value]);

  if (decisionEvents(replay).length === 0) {
    eligibilityReasons.push("guide_intervention_decision_missing");
  }

  const interventionByTrace = new Map(
    interventions.map((entry) => [entry.guide_trace_id, entry]),
  );
  const feedbackUses = input.feedbackOperations
    .map((row) => parseFeedbackUse(
      row,
      replay.episode.run_id,
      closedAt,
    ))
    .filter((entry): entry is ParsedFeedbackUse => entry !== null)
    .filter((entry) => interventionByTrace.has(entry.guide_trace_id));

  const actualUse = feedbackUses.flatMap((feedback) => {
    const intervention = interventionByTrace.get(feedback.guide_trace_id)!;
    const deliveredById = new Map(
      intervention.delivered_memory.map((item) => [item.memory_id, item]),
    );
    return feedback.memory_ids.map((memoryId) => {
      const delivered = deliveredById.get(memoryId);
      if (!delivered) {
        throw new Error(
          `canonical_l1_feedback_memory_not_delivered:${memoryId}`,
        );
      }
      return {
        feedback_operation_id: feedback.feedback_operation_id,
        feedback_request_sha256: feedback.feedback_request_sha256,
        guide_trace_id: feedback.guide_trace_id,
        memory_id: memoryId,
        served_surface: delivered.served_surface,
        reported_surface: feedback.reported_surface,
        outcome: feedback.outcome,
        verifier_status: feedback.verifier_status,
        tool_status: feedback.tool_status,
        verified_host_receipt: feedback.verified_host_receipt,
        runtime_signal_refs: [...feedback.runtime_signal_refs],
        recorded_at: feedback.recorded_at,
      };
    });
  }).sort((left, right) =>
    Buffer.compare(
      Buffer.from(
        `${left.guide_trace_id}\u0000${left.feedback_operation_id}\u0000${left.memory_id}`,
        "utf8",
      ),
      Buffer.from(
        `${right.guide_trace_id}\u0000${right.feedback_operation_id}\u0000${right.memory_id}`,
        "utf8",
      ),
    ));

  const contaminationReasons = canonicalSort(
    replay.reward.contamination_reasons,
  );
  const trajectory = replay.events.flatMap((event) => {
    if (event.payload.event_kind !== "action_observed") return [];
    const action = event.payload.action;
    return [{
      event_id: event.event_id,
      sequence: action.sequence,
      action_id: action.action_id,
      action_kind: action.action_kind,
      capability_id: action.tool_name ?? action.action_kind,
      mutation: action.mutation,
      request_ref: artifactReference(action.request_ref),
      result_ref: artifactReference(action.result_ref),
      state_before_snapshot_id: action.state_before_snapshot_id,
      state_after_snapshot_id: action.state_after_snapshot_id,
      state_delta_ref: action.state_delta_ref
        ? artifactReference(action.state_delta_ref)
        : null,
      occurred_at: action.occurred_at,
    }];
  });
  const verifierEvent = replay.events.find((event) =>
    event.payload.event_kind === "verifier_recorded"
    && event.payload.outcome.verifier_receipt_id
      === replay.reward?.verifier_receipt_id);
  if (
    !verifierEvent
    || verifierEvent.payload.event_kind !== "verifier_recorded"
    || (verifierEvent.payload.outcome.status !== "passed"
      && verifierEvent.payload.outcome.status !== "failed")
  ) {
    throw new Error("canonical_l1_verifier_binding_missing");
  }
  const verifierOutcome = verifierEvent.payload.outcome;
  const verifierStatus = verifierOutcome.status === "passed"
    ? "passed" as const
    : "failed" as const;
  if (!isEpisodeRewardSelectorEligible(replay.reward)) {
    eligibilityReasons.push("reward_not_learning_eligible");
  }
  if (contaminationReasons.length > 0) {
    eligibilityReasons.push("episode_contaminated");
  }
  const interventionKinds = interventions.map((entry) =>
    entry.intervention_kind);
  const episodeInterventionKind = interventionKind(
    interventions.flatMap((entry) =>
      entry.delivered_memory.map((item) => item.learning_layer)),
  );
  if (
    interventionKinds.includes("mixed_skill")
    || (interventionKinds.includes("state_plus_candidate_skill")
      && interventionKinds.includes("state_plus_validated_skill"))
  ) {
    eligibilityReasons.push("mixed_skill_intervention");
  }
  const reasonCodes = canonicalSort(eligibilityReasons);
  const rewardDigest = episodeRewardDigest(replay.reward);
  const material = {
    contract_version: "canonical_l1_episode_v1" as const,
    dataset_version: "canonical_l1_dataset_v1" as const,
    layer: "L1" as const,
    l1_episode_id: `l1_${sha256Hex(stableStringify({
      episode_id: replay.episode.episode_id,
      reward_sha256: rewardDigest,
    }))}`,
    episode_id: replay.episode.episode_id,
    tenant_id: replay.episode.tenant_id,
    public_scope: replay.episode.public_scope,
    store_scope: replay.episode.store_scope,
    task_id: replay.episode.task_id,
    task_cluster_id: replay.episode.task_cluster_id,
    task_cluster_policy_version:
      replay.episode.task_cluster_policy_version,
    task_envelope_sha256: replay.episode.task_envelope_digest,
    task_manifest_sha256: replay.episode.task_manifest_digest,
    source_task_ref: artifactReference(replay.episode.source_task_ref),
    run_id: replay.episode.run_id,
    model_id: replay.episode.model_id,
    model_config_sha256: replay.episode.model_config_digest,
    subject_kind:
      replay.episode.execution_subject?.kind
      ?? replay.episode.subject_identity.state_kind,
    subject_identity_sha256:
      replay.episode.subject_identity.identity_sha256,
    trajectory,
    verifier: {
      verifier_receipt_id: verifierOutcome.verifier_receipt_id,
      verifier_id: verifierOutcome.verifier_id,
      verifier_kind: verifierOutcome.verifier_kind,
      verifier_version: verifierOutcome.verifier_version,
      verifier_program_sha256: verifierOutcome.verifier_program_digest,
      verifier_config_sha256: verifierOutcome.verifier_config_digest,
      verified_state_snapshot_id:
        verifierOutcome.verified_state_snapshot_id,
      output_ref: artifactReference(verifierOutcome.verifier_output_ref),
      status: verifierStatus,
    },
    event_count: replay.events.length,
    event_chain_head_sha256: closeEvent.event_sha256,
    intervention_kind: episodeInterventionKind,
    interventions,
    actual_use: actualUse,
    reward: replay.reward,
    cost_receipt: replay.cost_receipt,
    contamination: {
      status: contaminationReasons.length === 0
        ? "clean" as const
        : "contaminated" as const,
      reasons: contaminationReasons,
    },
    learning_eligibility: {
      eligible: reasonCodes.length === 0,
      reason_codes: reasonCodes,
    },
    source_guide_receipt_sha256s: canonicalSort(
      interventions.map((entry) => entry.guide_receipt_sha256),
    ),
    source_feedback_request_sha256s: canonicalSort(
      feedbackUses.map((entry) => entry.feedback_request_sha256),
    ),
    closed_at: closedAt,
  };
  return CanonicalL1EpisodeV1Schema.parse({
    ...material,
    l1_sha256: canonicalL1EpisodeDigest(material),
  });
}
