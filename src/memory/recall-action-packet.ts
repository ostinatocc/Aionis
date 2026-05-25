import type { RecallNodeRow } from "../store/recall-access.js";
import { AIONIS_URI_NODE_TYPES, buildAionisUri } from "./uri.js";
import { dedupeWorkflowCandidatesBySignature } from "./workflow-candidate-aggregation.js";
import {
  parseExecutionContract,
  type ExecutionContractV1,
} from "./execution-contract.js";
import {
  resolveNodeAnchorSummary,
  resolveNodeArchiveRelocationSurface,
  resolveNodeAnchorKind,
  resolveNodeAnchorLevel,
  resolveNodeDistillationSurface,
  resolveNodeExecutionContract,
  resolveNodeExecutionContractTrust,
  resolveNodeExecutionKind,
  resolveNodeLifecycleState,
  resolveNodeMaintenanceSurface,
  resolveNodePatternExecutionSurface,
  resolveNodeRehydrationSurface,
  resolveNodeSemanticForgettingSurface,
  resolveNodeToolSet,
  resolveNodeWorkflowPromotionSurface,
  resolveNodeWorkflowSignature,
  resolveNodeWorkflowSourceKind,
} from "./node-execution-surface.js";
import {
  buildRuntimeAuthorityVisibilityFromSlots,
  type RuntimeAuthorityVisibilityV1,
} from "./authority-visibility.js";
import { authorityConsumptionStateFromValue } from "./authority-consumption.js";

type NodeRow = RecallNodeRow;

export type ActionRecallWorkflow = {
  anchor_id: string;
  uri: string | null;
  type: string;
  title: string | null;
  summary: string | null;
  anchor_level: string;
  execution_contract_v1: ExecutionContractV1 | null;
  contract_trust: "authoritative" | "advisory" | "observational" | null;
  promotion_state: "candidate" | "stable" | null;
  source_kind: string | null;
  distillation_origin: string | null;
  preferred_promotion_target: "workflow" | "pattern" | "policy" | null;
  promotion_origin:
    | "replay_compile_from_run"
    | "replay_promote"
    | "replay_stable_normalization"
    | "replay_learning_episode"
    | "replay_learning_auto_promotion"
    | null;
  required_observations: number | null;
  observed_count: number | null;
  promotion_ready: boolean;
  workflow_signature: string | null;
  last_transition: "candidate_observed" | "promoted_to_stable" | "normalized_latest_stable" | null;
  last_transition_at: string | null;
  rehydration_default_mode: "summary_only" | "partial" | "full" | "differential" | null;
  tool_set: string[];
  maintenance_state: "observe" | "retain" | "review" | null;
  offline_priority:
    | "none"
    | "promote_candidate"
    | "review_counter_evidence"
    | "retain_trusted"
    | "retain_workflow"
    | null;
  last_maintenance_at: string | null;
  confidence: number | null;
  lifecycle_state?: string | null;
  semantic_forgetting_action?: "retain" | "demote" | "archive" | "review" | null;
  archive_relocation_state?: "none" | "candidate" | "cold_archive" | null;
  archive_relocation_target?: "none" | "local_cold_store" | "external_object_store" | null;
  archive_payload_scope?: "none" | "anchor_payload" | "node" | null;
  authority_visibility?: RuntimeAuthorityVisibilityV1 | null;
};

export type ActionRecallPattern = {
  anchor_id: string;
  uri: string | null;
  type: string;
  title: string | null;
  summary: string | null;
  anchor_level: string;
  selected_tool: string | null;
  tool_set: string[];
  pattern_state: "provisional" | "stable";
  credibility_state: "candidate" | "trusted" | "contested";
  trusted: boolean;
  distinct_run_count: number | null;
  required_distinct_runs: number | null;
  counter_evidence_open: boolean;
  last_transition: string | null;
  maintenance_state: "observe" | "retain" | "review" | null;
  offline_priority: "none" | "promote_candidate" | "review_counter_evidence" | "retain_trusted" | null;
  last_maintenance_at: string | null;
  confidence: number | null;
};

export type ActionRecallRehydrationCandidate = {
  anchor_id: string;
  anchor_uri: string;
  anchor_kind: string;
  anchor_level: string;
  title: string | null;
  summary: string | null;
  mode: "summary_only" | "partial" | "full" | "differential";
  payload_cost_hint: "low" | "medium" | "high" | null;
  recommended_when: string[];
  trusted: boolean;
  selected_tool: string | null;
  example_call: string;
};

export type ActionRecallSupportingKnowledge = {
  kind: string;
  node_id: string;
  uri: string | null;
  title: string | null;
  summary: string | null;
  execution_contract_v1?: ExecutionContractV1 | null;
  summary_kind?: string | null;
  execution_kind?: string | null;
  compression_layer: string | null;
  tier: string | null;
  salience: number | null;
  lifecycle_state?: string | null;
  semantic_forgetting_action?: "retain" | "demote" | "archive" | "review" | null;
  archive_relocation_state?: "none" | "candidate" | "cold_archive" | null;
  archive_relocation_target?: "none" | "local_cold_store" | "external_object_store" | null;
  archive_payload_scope?: "none" | "anchor_payload" | "node" | null;
  rehydration_default_mode?: "summary_only" | "partial" | "full" | "differential" | null;
};

export type ActionRecallPacket = {
  packet_version: "action_recall_v1";
  recommended_workflows: ActionRecallWorkflow[];
  candidate_workflows: ActionRecallWorkflow[];
  candidate_patterns: ActionRecallPattern[];
  trusted_patterns: ActionRecallPattern[];
  contested_patterns: ActionRecallPattern[];
  rehydration_candidates: ActionRecallRehydrationCandidate[];
  supporting_knowledge: ActionRecallSupportingKnowledge[];
};

const URI_NODE_TYPES = new Set<string>(AIONIS_URI_NODE_TYPES);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function recallAnchorMeta(node: NodeRow): {
  slots: Record<string, unknown> | null;
  anchorSummary: string | null;
  executionContract: ExecutionContractV1 | null;
  anchorKind: string | null;
  anchorLevel: string | null;
  executionKind: string | null;
  workflowSignature: string | null;
  workflowSourceKind: string | null;
  patternState: "provisional" | "stable";
  credibilityState: "candidate" | "trusted" | "contested";
  workflowPromotion: Record<string, unknown> | null;
  promotion: Record<string, unknown> | null;
  maintenance: Record<string, unknown> | null;
  rehydration: Record<string, unknown> | null;
  distillation: Record<string, unknown> | null;
  counterEvidenceOpen: boolean;
  trusted: boolean;
  selectedTool: string | null;
  toolSet: string[];
  contractTrust: "authoritative" | "advisory" | "observational" | null;
} {
  const slots = asRecord(node.slots);
  const executionContract = resolveNodeExecutionContract({ slots });
  const anchorKind = resolveNodeAnchorKind(slots);
  const anchorLevel = resolveNodeAnchorLevel(slots);
  const executionKind = resolveNodeExecutionKind(slots);
  const patternSurface = resolveNodePatternExecutionSurface({ slots });
  const patternState =
    patternSurface.pattern_state === "stable" ? "stable" : "provisional";
  const workflowPromotion = resolveNodeWorkflowPromotionSurface(slots);
  const promotion = {
    distinct_run_count: patternSurface.promotion.distinct_run_count,
    required_distinct_runs: patternSurface.promotion.required_distinct_runs,
    counter_evidence_count: patternSurface.promotion.counter_evidence_count,
    counter_evidence_open: patternSurface.promotion.counter_evidence_open,
    last_transition: patternSurface.promotion.last_transition,
  };
  const maintenance = patternSurface.maintenance ?? resolveNodeMaintenanceSurface(slots);
  const rehydration = resolveNodeRehydrationSurface(slots);
  const distillation = resolveNodeDistillationSurface(slots);
  const counterEvidenceOpen = patternSurface.promotion.counter_evidence_open;
  const credibilityState = patternSurface.credibility_state ?? (patternState === "stable" ? "trusted" : "candidate");
  const trusted = anchorKind === "pattern" ? credibilityState === "trusted" : false;
  const selectedTool = patternSurface.selected_tool;
  const contractTrust = resolveNodeExecutionContractTrust({ slots });
  return {
    slots,
    anchorSummary: resolveNodeAnchorSummary(slots),
    executionContract,
    anchorKind,
    anchorLevel,
    executionKind,
    workflowSignature: resolveNodeWorkflowSignature({ slots }),
    workflowSourceKind: resolveNodeWorkflowSourceKind(slots),
    patternState,
    credibilityState,
    workflowPromotion,
    promotion,
    maintenance,
    rehydration,
    distillation,
    counterEvidenceOpen,
    trusted,
    selectedTool,
    toolSet: resolveNodeToolSet({ slots }),
    contractTrust,
  };
}

function stringList(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = typeof item === "string" ? item.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

export function isWorkflowPromotionReady(workflowPromotion: Record<string, unknown> | null): boolean {
  const promotionState = firstString(workflowPromotion?.promotion_state);
  if (promotionState !== "candidate") return false;
  const observedCount = firstFinite(workflowPromotion?.observed_count);
  const requiredObservations = firstFinite(workflowPromotion?.required_observations);
  return observedCount != null && requiredObservations != null && observedCount >= requiredObservations;
}

export function buildActionRecallPacket(args: {
  tenant_id: string;
  scope: string;
  nodes: NodeRow[];
  runtimeToolHints: Array<Record<string, unknown>>;
  contextItems: Array<Record<string, unknown>>;
}): ActionRecallPacket {
  const recommendedWorkflows: ActionRecallWorkflow[] = [];
  const candidateWorkflows: ActionRecallWorkflow[] = [];
  const deferredCandidateWorkflows: ActionRecallWorkflow[] = [];
  const candidatePatterns: ActionRecallPattern[] = [];
  const trustedPatterns: ActionRecallPattern[] = [];
  const contestedPatterns: ActionRecallPattern[] = [];
  const supportingKnowledge: ActionRecallSupportingKnowledge[] = [];
  const actionAnchorIds = new Set<string>();
  const stableWorkflowSignatures = new Set<string>();

  for (const node of args.nodes) {
    const meta = recallAnchorMeta(node);
    const anchorKind = meta.anchorKind;
    const anchorLevel = meta.anchorLevel;
    if (!anchorKind || !anchorLevel) continue;
    const uri = URI_NODE_TYPES.has(node.type)
      ? buildAionisUri({ tenant_id: args.tenant_id, scope: args.scope, type: node.type, id: node.id })
      : null;
    actionAnchorIds.add(node.id);
    if (anchorKind === "workflow") {
      const distillation = meta.distillation;
      const semanticForgetting = resolveNodeSemanticForgettingSurface(meta.slots);
      const archiveRelocation = resolveNodeArchiveRelocationSurface(meta.slots);
      const title = node.title ?? null;
      const summary = meta.anchorSummary ?? node.text_summary ?? node.title ?? null;
      const authorityVisibility = buildRuntimeAuthorityVisibilityFromSlots({
        nodeId: node.id,
        nodeKind: "workflow",
        title: title ?? summary,
        slots: meta.slots,
      });
      const authorityState = authorityConsumptionStateFromValue({ authority_visibility: authorityVisibility });
      const workflowEntry: ActionRecallWorkflow = {
        anchor_id: node.id,
        uri,
        type: node.type,
        title,
        summary,
        anchor_level: anchorLevel,
        execution_contract_v1: meta.executionContract,
        contract_trust: meta.contractTrust,
        promotion_state: firstString(meta.workflowPromotion?.promotion_state) as any,
        source_kind: meta.workflowSourceKind,
        distillation_origin: firstString(distillation?.distillation_origin),
        preferred_promotion_target: firstString(distillation?.preferred_promotion_target) as any,
        promotion_origin: firstString(meta.workflowPromotion?.promotion_origin) as any,
        required_observations: firstFinite(meta.workflowPromotion?.required_observations),
        observed_count: firstFinite(meta.workflowPromotion?.observed_count),
        promotion_ready: isWorkflowPromotionReady(meta.workflowPromotion) && !authorityState.blocks_promotion_readiness,
        workflow_signature: meta.workflowSignature,
        last_transition: firstString(meta.workflowPromotion?.last_transition) as any,
        last_transition_at: firstString(meta.workflowPromotion?.last_transition_at),
        rehydration_default_mode: firstString(meta.rehydration?.default_mode) as any,
        tool_set: meta.toolSet,
        maintenance_state: firstString(meta.maintenance?.maintenance_state) as any,
        offline_priority: firstString(meta.maintenance?.offline_priority) as any,
        last_maintenance_at: firstString(meta.maintenance?.last_maintenance_at),
        confidence: firstFinite(node.confidence),
        lifecycle_state: resolveNodeLifecycleState(meta.slots),
        semantic_forgetting_action: semanticForgetting.action,
        archive_relocation_state: archiveRelocation.relocation_state,
        archive_relocation_target: archiveRelocation.relocation_target,
        archive_payload_scope: archiveRelocation.payload_scope,
        authority_visibility: authorityVisibility,
      };
      if (meta.executionKind === "workflow_candidate" || firstString(meta.workflowPromotion?.promotion_state) === "candidate") {
        deferredCandidateWorkflows.push(workflowEntry);
      } else {
        recommendedWorkflows.push(workflowEntry);
        if (workflowEntry.workflow_signature) stableWorkflowSignatures.add(workflowEntry.workflow_signature);
      }
      continue;
    }
    if (anchorKind === "pattern") {
      const packetEntry: ActionRecallPattern = {
        anchor_id: node.id,
        uri,
        type: node.type,
        title: node.title ?? null,
        summary: meta.anchorSummary ?? node.text_summary ?? node.title ?? null,
        anchor_level: anchorLevel,
        selected_tool: meta.selectedTool,
        tool_set: meta.toolSet,
        pattern_state: meta.patternState,
        credibility_state: meta.credibilityState,
        trusted: meta.trusted,
        distinct_run_count: firstFinite(meta.promotion?.distinct_run_count),
        required_distinct_runs: firstFinite(meta.promotion?.required_distinct_runs),
        counter_evidence_open: meta.counterEvidenceOpen,
        last_transition: firstString(meta.promotion?.last_transition),
        maintenance_state: firstString(meta.maintenance?.maintenance_state) as any,
        offline_priority: firstString(meta.maintenance?.offline_priority) as any,
        last_maintenance_at: firstString(meta.maintenance?.last_maintenance_at),
        confidence: firstFinite(node.confidence),
      };
      if (meta.credibilityState === "trusted") trustedPatterns.push(packetEntry);
      else if (meta.credibilityState === "contested") contestedPatterns.push(packetEntry);
      else candidatePatterns.push(packetEntry);
    }
  }

  const aggregatedDeferredCandidates = dedupeWorkflowCandidatesBySignature(deferredCandidateWorkflows);
  for (const pending of aggregatedDeferredCandidates) {
    if (pending.workflow_signature && stableWorkflowSignatures.has(pending.workflow_signature)) continue;
    candidateWorkflows.push(pending);
  }

  const uriByAnchorId = new Map<string, string>();
  const rehydrationCandidates: ActionRecallRehydrationCandidate[] = [];
  for (const rawHint of args.runtimeToolHints.slice(0, 8)) {
    const hint = asRecord(rawHint);
    const anchor = asRecord(hint?.anchor);
    const invocation = asRecord(hint?.invocation);
    const anchorId = firstString(anchor?.id);
    const anchorUri = firstString(invocation?.anchor_uri) ?? firstString(anchor?.uri);
    const anchorKind = firstString(anchor?.anchor_kind);
    const anchorLevel = firstString(anchor?.anchor_level);
    const modeRaw = firstString(invocation?.mode);
    const mode =
      modeRaw === "summary_only" || modeRaw === "full" || modeRaw === "partial" || modeRaw === "differential"
        ? modeRaw
        : "partial";
    const payloadCostHintRaw = firstString(hint?.payload_cost_hint);
    const payloadCostHint =
      payloadCostHintRaw === "low" || payloadCostHintRaw === "medium" || payloadCostHintRaw === "high"
        ? payloadCostHintRaw
        : null;
    if (!anchorId || !anchorUri || !anchorKind || !anchorLevel) continue;
    uriByAnchorId.set(anchorId, anchorUri);
    rehydrationCandidates.push({
      anchor_id: anchorId,
      anchor_uri: anchorUri,
      anchor_kind: anchorKind,
      anchor_level: anchorLevel,
      title: firstString(anchor?.title),
      summary: firstString(anchor?.summary),
      mode,
      payload_cost_hint: payloadCostHint,
      recommended_when: stringList(hint?.recommended_when),
      trusted: anchor?.trusted === true,
      selected_tool: firstString(anchor?.selected_tool),
      example_call: firstString(invocation?.example_call) ?? "",
    });
  }

  for (const workflow of recommendedWorkflows) workflow.uri = uriByAnchorId.get(workflow.anchor_id) ?? workflow.uri;
  for (const workflow of candidateWorkflows) workflow.uri = uriByAnchorId.get(workflow.anchor_id) ?? workflow.uri;
  for (const pattern of candidatePatterns) pattern.uri = uriByAnchorId.get(pattern.anchor_id) ?? pattern.uri;
  for (const pattern of trustedPatterns) pattern.uri = uriByAnchorId.get(pattern.anchor_id) ?? pattern.uri;
  for (const pattern of contestedPatterns) pattern.uri = uriByAnchorId.get(pattern.anchor_id) ?? pattern.uri;

  for (const rawItem of args.contextItems.slice(0, 32)) {
    const item = asRecord(rawItem);
    const nodeId = firstString(item?.node_id);
    if (!nodeId || actionAnchorIds.has(nodeId)) continue;
    supportingKnowledge.push({
      kind: firstString(item?.kind) ?? "unknown",
      node_id: nodeId,
      uri: firstString(item?.uri),
      title: firstString(item?.title),
      summary: firstString(item?.summary),
      execution_contract_v1: parseExecutionContract(item?.execution_contract_v1),
      summary_kind: firstString(item?.summary_kind),
      execution_kind: firstString(item?.execution_kind),
      compression_layer: firstString(item?.compression_layer),
      tier: firstString(item?.tier),
      salience: firstFinite(item?.salience),
      lifecycle_state: firstString(item?.lifecycle_state),
      semantic_forgetting_action:
        firstString(item?.semantic_forgetting_action) as "retain" | "demote" | "archive" | "review" | null,
      archive_relocation_state:
        firstString(item?.archive_relocation_state) as "none" | "candidate" | "cold_archive" | null,
      archive_relocation_target:
        firstString(item?.archive_relocation_target) as "none" | "local_cold_store" | "external_object_store" | null,
      archive_payload_scope:
        firstString(item?.archive_payload_scope) as "none" | "anchor_payload" | "node" | null,
      rehydration_default_mode:
        firstString(item?.rehydration_default_mode) as "summary_only" | "partial" | "full" | "differential" | null,
    });
    if (supportingKnowledge.length >= 16) break;
  }

  return {
    packet_version: "action_recall_v1",
    recommended_workflows: recommendedWorkflows,
    candidate_workflows: candidateWorkflows,
    candidate_patterns: candidatePatterns,
    trusted_patterns: trustedPatterns,
    contested_patterns: contestedPatterns,
    rehydration_candidates: rehydrationCandidates,
    supporting_knowledge: supportingKnowledge,
  };
}
