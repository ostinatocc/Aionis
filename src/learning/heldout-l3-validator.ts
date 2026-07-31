import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";
import {
  ContrastiveL2HypothesisV1Schema,
  type ContrastiveL2HypothesisV1,
} from "./contrastive-l2-contract.js";
import {
  HeldoutL3CellReceiptV1Schema,
  HeldoutL3SkillVersionV1Schema,
  heldoutL3CellDigest,
  heldoutL3SkillVersionDigest,
  type HeldoutL3CellReceiptV1,
  type HeldoutL3SkillVersionV1,
} from "./heldout-l3-contract.js";

function canonicalCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function buildHeldoutL3CellReceipt(
  input: Omit<HeldoutL3CellReceiptV1, "cell_sha256">,
): HeldoutL3CellReceiptV1 {
  return HeldoutL3CellReceiptV1Schema.parse({
    ...input,
    cell_sha256: heldoutL3CellDigest(input),
  });
}

export function evaluateHeldoutL3Candidate(args: {
  hypothesis: ContrastiveL2HypothesisV1;
  candidateContextSha256: string;
  protocolSha256: string;
  cells: readonly HeldoutL3CellReceiptV1[];
}): HeldoutL3SkillVersionV1 {
  const hypothesis = ContrastiveL2HypothesisV1Schema.parse(args.hypothesis);
  const cells = args.cells.map((cell) =>
    HeldoutL3CellReceiptV1Schema.parse(cell));
  const byTask = new Map<string, HeldoutL3CellReceiptV1[]>();
  for (const cell of cells) {
    const rows = byTask.get(cell.task_id) ?? [];
    rows.push(cell);
    byTask.set(cell.task_id, rows);
  }

  const taskPairs = [...byTask.keys()].sort(canonicalCompare).map((taskId) => {
    const rows = byTask.get(taskId)!;
    const control = rows.filter((cell) => cell.arm === "state_only");
    const candidate = rows.filter((cell) =>
      cell.arm === "state_plus_candidate_skill");
    if (control.length !== 1 || candidate.length !== 1) {
      throw new Error(`heldout_l3_pair_incomplete:${taskId}`);
    }
    const controlCell = control[0]!;
    const candidateCell = candidate[0]!;
    if (
      controlCell.task_source_id !== candidateCell.task_source_id
      || controlCell.task_seed_sha256 !== candidateCell.task_seed_sha256
      || controlCell.requested_model_version_label
        !== candidateCell.requested_model_version_label
      || controlCell.provider_api_model_id
        !== candidateCell.provider_api_model_id
      || controlCell.served_model_id !== candidateCell.served_model_id
      || controlCell.system_fingerprint
        !== candidateCell.system_fingerprint
      || candidateCell.candidate_context_sha256
        !== args.candidateContextSha256
      || controlCell.candidate_context_sha256 !== null
    ) {
      throw new Error(`heldout_l3_pair_authority_mismatch:${taskId}`);
    }
    return {
      task_id: taskId,
      task_source_id: controlCell.task_source_id,
      task_seed_sha256: controlCell.task_seed_sha256,
      control: controlCell,
      candidate: candidateCell,
      verified_success_delta: (
        candidateCell.verified_success - controlCell.verified_success
      ) as -1 | 0 | 1,
      token_delta: candidateCell.total_tokens - controlCell.total_tokens,
      tool_call_delta:
        candidateCell.tool_call_count - controlCell.tool_call_count,
      elapsed_ms_delta: candidateCell.elapsed_ms - controlCell.elapsed_ms,
    };
  });

  const modelAuthorities = new Set(taskPairs.map((pair) =>
    stableStringify({
      requested_model_version_label:
        pair.control.requested_model_version_label,
      provider_api_model_id: pair.control.provider_api_model_id,
      served_model_id: pair.control.served_model_id,
      system_fingerprint: pair.control.system_fingerprint,
    })));
  if (modelAuthorities.size !== 1) {
    throw new Error("heldout_l3_cross_pair_model_authority_mismatch");
  }

  const distinctTaskSources = new Set(
    taskPairs.map((pair) => pair.task_source_id),
  ).size;
  const positiveTransferCount = taskPairs.filter((pair) =>
    pair.verified_success_delta > 0).length;
  const negativeTransferCount = taskPairs.filter((pair) =>
    pair.verified_success_delta < 0).length;
  const status = negativeTransferCount > 0
    ? "rejected" as const
    : distinctTaskSources >= 2 && positiveTransferCount >= 2
      ? "validated" as const
      : "contested" as const;

  const totalTokenDelta = taskPairs.reduce(
    (sum, pair) => sum + pair.token_delta,
    0,
  );
  const totalToolCallDelta = taskPairs.reduce(
    (sum, pair) => sum + pair.tool_call_delta,
    0,
  );
  const totalElapsedMsDelta = taskPairs.reduce(
    (sum, pair) => sum + pair.elapsed_ms_delta,
    0,
  );
  const decisionReasons = [
    status === "validated"
      ? "verified_success_uplift_across_two_sources"
      : status === "rejected"
        ? "verified_negative_transfer_observed"
        : "validation_threshold_not_met",
    ...(positiveTransferCount === 0
      ? ["no_verified_success_uplift"]
      : []),
    ...(totalTokenDelta > 0
      ? ["candidate_token_cost_increased"]
      : totalTokenDelta < 0
        ? ["candidate_token_cost_decreased"]
        : ["candidate_token_cost_unchanged"]),
  ].sort(canonicalCompare);

  const material = {
    contract_version: "heldout_l3_skill_version_v1" as const,
    layer: "L3" as const,
    skill_id: `l3s_${sha256Hex(stableStringify({
      hypothesis_id: hypothesis.hypothesis_id,
      hypothesis_sha256: hypothesis.hypothesis_sha256,
    }))}`,
    version: 1 as const,
    status,
    source_hypothesis_id: hypothesis.hypothesis_id,
    source_hypothesis_sha256: hypothesis.hypothesis_sha256,
    candidate_context_sha256: args.candidateContextSha256,
    protocol_sha256: args.protocolSha256,
    model_authority: {
      requested_model_version_label:
        taskPairs[0]!.control.requested_model_version_label,
      provider_api_model_id:
        taskPairs[0]!.control.provider_api_model_id,
      served_model_id: taskPairs[0]!.control.served_model_id,
      system_fingerprint: taskPairs[0]!.control.system_fingerprint,
    },
    task_pairs: taskPairs,
    aggregate: {
      distinct_task_source_count: distinctTaskSources,
      control_verified_pass_count: taskPairs.filter((pair) =>
        pair.control.verified_success === 1).length,
      candidate_verified_pass_count: taskPairs.filter((pair) =>
        pair.candidate.verified_success === 1).length,
      positive_transfer_count: positiveTransferCount,
      negative_transfer_count: negativeTransferCount,
      total_token_delta: totalTokenDelta,
      total_tool_call_delta: totalToolCallDelta,
      total_elapsed_ms_delta: totalElapsedMsDelta,
    },
    decision_policy:
      "two_source_verified_uplift_no_negative_transfer_v1" as const,
    decision_reason_codes: decisionReasons,
    production_prompt_eligible: status === "validated",
    validation_prompt_eligible: status === "contested",
  };
  return HeldoutL3SkillVersionV1Schema.parse({
    ...material,
    skill_version_sha256: heldoutL3SkillVersionDigest(material),
  });
}
