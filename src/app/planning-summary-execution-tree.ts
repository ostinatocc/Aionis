import {
  deriveExecutionTreeStateV1,
  type ExecutionTreeV1,
} from "../execution/index.js";
import type { ExecutionTreeEffectSummary } from "./planning-summary.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function visibleStaticBlockIds(layeredContext: Record<string, unknown> | null): string[] {
  const layers = asRecord(layeredContext?.layers);
  const staticLayer = asRecord(layers?.static);
  const items = Array.isArray(staticLayer?.items) ? staticLayer.items : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = String(item ?? "");
    const matches = text.matchAll(/\(block:([^)]+)\)/g);
    for (const match of matches) {
      const id = String(match[1] ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function clampFindings(findings: string[]): string[] {
  return findings.map((finding) => finding.slice(0, 256)).slice(0, 8);
}

export function buildExecutionTreeEffectSummary(args: {
  executionTree?: ExecutionTreeV1 | null;
  layeredContext?: unknown;
}): ExecutionTreeEffectSummary {
  if (!args.executionTree) {
    return {
      summary_version: "execution_tree_effect_summary_v1",
      tree_present: false,
      static_selection_observed: false,
      current_compressed_node_count: 0,
      current_raw_node_count: 0,
      branch_hint_count: 0,
      failed_branch_hint_count: 0,
      alternate_branch_hint_count: 0,
      validated_current_node_count: 0,
      selected_current_block_count: 0,
      selected_failed_hint_block_count: 0,
      compression_signal_present: false,
      revision_signal_present: false,
      raw_continuation_signal_present: false,
      failed_branch_isolated: false,
      next_action_contamination_risk: "none",
      effect_posture: "absent",
      findings: ["execution tree not supplied"],
    };
  }

  const state = deriveExecutionTreeStateV1(args.executionTree);
  const layeredContext = asRecord(args.layeredContext);
  const staticInjection = asRecord(layeredContext?.static_injection);
  const selectedIds = stringList(staticInjection?.selected_ids);
  const visibleIds = visibleStaticBlockIds(layeredContext);
  const effectiveSelectedIds = visibleIds.length > 0
    ? selectedIds.filter((id) => visibleIds.includes(id))
    : selectedIds;
  const staticSelectionObserved = !!staticInjection || visibleIds.length > 0;
  const compressedBlockId = `execution-tree-${args.executionTree.tree_id}-compressed-state`;
  const rawBlockId = `execution-tree-${args.executionTree.tree_id}-raw-state`;
  const hintsBlockId = `execution-tree-${args.executionTree.tree_id}-hints`;
  const selectedCurrentBlockCount =
    Number(effectiveSelectedIds.includes(compressedBlockId)) + Number(effectiveSelectedIds.includes(rawBlockId));
  const selectedFailedHintBlockCount = Number(effectiveSelectedIds.includes(hintsBlockId));
  const failedBranchHintCount = state.execution_hints.filter((entry) => entry.status === "failed").length;
  const alternateBranchHintCount = Math.max(0, state.execution_hints.length - failedBranchHintCount);
  const validatedCurrentNodeCount = [
    ...state.compressed_state,
    ...state.raw_state,
  ].filter((entry) => entry.validated).length;
  const failedBranchIsolated = failedBranchHintCount > 0 && staticSelectionObserved && selectedFailedHintBlockCount === 0;
  const nextActionContaminationRisk =
    selectedFailedHintBlockCount > 0
      ? "possible"
      : failedBranchHintCount > 0 && !staticSelectionObserved
        ? "unobserved"
        : "none";
  const effectPosture =
    selectedFailedHintBlockCount > 0
      ? "needs_review"
      : failedBranchIsolated
        ? "branch_isolated"
        : "continuity_available";
  const findings: string[] = [];
  if (state.compressed_state.length > 0) findings.push("compressed execution state available for continuation");
  if (state.raw_state.length > 0) findings.push("raw continuation state available for next action");
  if (failedBranchIsolated) findings.push("failed branch hints are isolated from selected next-action context");
  if (selectedFailedHintBlockCount > 0) findings.push("failed branch hints entered selected context and require review");
  if (nextActionContaminationRisk === "unobserved") findings.push("static selection was not observed for failed branch hints");
  if (findings.length === 0) findings.push("execution tree supplied but no active continuation nodes were derived");

  return {
    summary_version: "execution_tree_effect_summary_v1",
    tree_present: true,
    static_selection_observed: staticSelectionObserved,
    current_compressed_node_count: state.compressed_state.length,
    current_raw_node_count: state.raw_state.length,
    branch_hint_count: state.execution_hints.length,
    failed_branch_hint_count: failedBranchHintCount,
    alternate_branch_hint_count: alternateBranchHintCount,
    validated_current_node_count: validatedCurrentNodeCount,
    selected_current_block_count: selectedCurrentBlockCount,
    selected_failed_hint_block_count: selectedFailedHintBlockCount,
    compression_signal_present: state.compressed_state.length > 0,
    revision_signal_present: failedBranchHintCount > 0,
    raw_continuation_signal_present: state.raw_state.length > 0,
    failed_branch_isolated: failedBranchIsolated,
    next_action_contamination_risk: nextActionContaminationRisk,
    effect_posture: effectPosture,
    findings: clampFindings(findings),
  };
}
