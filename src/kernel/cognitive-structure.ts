import { z } from "zod";
import {
  ExecutionSummaryV1Schema,
  type ExecutionSummaryV1,
} from "../memory/schemas.js";
import {
  PolicyMutationV1Schema,
  type PolicyMutationV1,
} from "./policy-mutation-loop.js";

export const CognitiveStructureScopeSchema = z.enum([
  "exact_task",
  "task_family",
  "repository",
  "ecosystem",
  "global",
]);
export type CognitiveStructureScope = z.infer<typeof CognitiveStructureScopeSchema>;

export const CognitiveEvidenceGradeSchema = z.enum([
  "real_verifier_pass",
  "real_integration_pass",
  "real_provider_runtime_pass",
  "deterministic_contract_pass",
  "failed_verifier",
  "provider_failure",
  "protocol_failure",
  "user_feedback",
  "memory_reference",
]);
export type CognitiveEvidenceGrade = z.infer<typeof CognitiveEvidenceGradeSchema>;

export const CognitiveEvidenceNodeSchema = z.object({
  evidence_id: z.string().min(1),
  kind: z.enum([
    "verified_fact",
    "failed_attempt",
    "tool_result",
    "verifier_result",
    "user_feedback",
    "workflow_observation",
    "policy_observation",
    "memory_reference",
  ]),
  grade: CognitiveEvidenceGradeSchema,
  outcome: z.enum(["success", "failure", "counter_evidence", "inconclusive"]),
  source_refs: z.array(z.string().min(1)).min(1).max(64),
  claims: z.array(z.string().min(1)).max(32),
  files: z.array(z.string().min(1)).max(64),
  verifier_command: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
}).strict();
export type CognitiveEvidenceNode = z.infer<typeof CognitiveEvidenceNodeSchema>;

export const CognitiveEvidenceEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: z.enum(["supports", "contradicts", "refines", "supersedes", "depends_on"]),
  reason: z.string().min(1),
}).strict();
export type CognitiveEvidenceEdge = z.infer<typeof CognitiveEvidenceEdgeSchema>;

export const CognitiveExecutionStateSchema = z.object({
  current_stage: z.string().nullable(),
  active_role: z.string().nullable(),
  task_family: z.string().nullable(),
  family_scope: z.string(),
  selected_tool: z.string().nullable(),
  next_action: z.string().nullable(),
  target_files: z.array(z.string().min(1)),
  validation_paths: z.array(z.string().min(1)),
  unresolved_blockers: z.array(z.string().min(1)),
  evidence_refs: z.array(z.string().min(1)),
  packet_present: z.boolean(),
  state_first_assembly: z.boolean(),
  recommended_action: z.string().min(1),
}).strict();
export type CognitiveExecutionState = z.infer<typeof CognitiveExecutionStateSchema>;

export const CognitiveEvidenceGraphSchema = z.object({
  evidence_node_count: z.number().int().min(0),
  evidence_edge_count: z.number().int().min(0),
  proven_fact_count: z.number().int().min(0),
  failed_evidence_count: z.number().int().min(0),
  verifier_evidence_count: z.number().int().min(0),
  provider_or_protocol_failure_count: z.number().int().min(0),
  nodes: z.array(CognitiveEvidenceNodeSchema).max(256),
  edges: z.array(CognitiveEvidenceEdgeSchema).max(512),
}).strict();
export type CognitiveEvidenceGraph = z.infer<typeof CognitiveEvidenceGraphSchema>;

export const CognitiveWorkflowMemorySchema = z.object({
  stable_count: z.number().int().min(0),
  candidate_count: z.number().int().min(0),
  promotion_ready_count: z.number().int().min(0),
  observing_count: z.number().int().min(0),
  stable_titles: z.array(z.string().min(1)),
  promotion_ready_titles: z.array(z.string().min(1)),
  observing_titles: z.array(z.string().min(1)),
  stable_anchor_ids: z.array(z.string().min(1)),
  candidate_anchor_ids: z.array(z.string().min(1)),
  rehydration_anchor_ids: z.array(z.string().min(1)),
}).strict();
export type CognitiveWorkflowMemory = z.infer<typeof CognitiveWorkflowMemorySchema>;

export const CognitivePolicyMemorySchema = z.object({
  persisted_count: z.number().int().min(0),
  active_count: z.number().int().min(0),
  contested_count: z.number().int().min(0),
  retired_count: z.number().int().min(0),
  default_mode_count: z.number().int().min(0),
  hint_mode_count: z.number().int().min(0),
  stable_policy_count: z.number().int().min(0),
  mutation_count: z.number().int().min(0),
  admitted_mutation_count: z.number().int().min(0),
  blocked_mutation_count: z.number().int().min(0),
  mutation_ids: z.array(z.string().min(1)),
}).strict();
export type CognitivePolicyMemory = z.infer<typeof CognitivePolicyMemorySchema>;

export const CognitiveForgettingStateSchema = z.object({
  substrate_mode: z.enum(["stable", "suppression_present", "forgetting_active"]),
  forgotten_items: z.number().int().min(0),
  stale_signal_count: z.number().int().min(0),
  suppressed_pattern_count: z.number().int().min(0),
  archived_count: z.number().int().min(0),
  contested_count: z.number().int().min(0),
  retired_count: z.number().int().min(0),
  rehydration_candidate_count: z.number().int().min(0),
  primary_forgetting_reason: z.string().nullable(),
  recommended_action: z.string().min(1),
}).strict();
export type CognitiveForgettingState = z.infer<typeof CognitiveForgettingStateSchema>;

export const CognitiveAuthorityStateSchema = z.object({
  surface_count: z.number().int().min(0),
  authoritative_allowed_count: z.number().int().min(0),
  authoritative_blocked_count: z.number().int().min(0),
  stable_promotion_allowed_count: z.number().int().min(0),
  stable_promotion_blocked_count: z.number().int().min(0),
  blocked_by_reason: z.record(z.number().int().min(0)),
  top_blockers: z.array(z.string().min(1)),
  recommended_guardrail: z.string().min(1),
}).strict();
export type CognitiveAuthorityState = z.infer<typeof CognitiveAuthorityStateSchema>;

export const CognitiveStructureV1Schema = z.object({
  structure_version: z.literal("cognitive_structure_v1"),
  tenant_id: z.string().min(1),
  scope: z.string().min(1),
  generated_at: z.string().min(1),
  runtime_version: z.string().nullable().default(null),
  source_code_change_allowed: z.literal(false).default(false),
  execution_state: CognitiveExecutionStateSchema,
  evidence_graph: CognitiveEvidenceGraphSchema,
  workflow_memory: CognitiveWorkflowMemorySchema,
  policy_memory: CognitivePolicyMemorySchema,
  forgetting_state: CognitiveForgettingStateSchema,
  authority_state: CognitiveAuthorityStateSchema,
  policy_mutations: z.array(PolicyMutationV1Schema).max(128),
}).strict();
export type CognitiveStructureV1 = z.infer<typeof CognitiveStructureV1Schema>;

function uniqueStrings(values: unknown[], limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function evidenceRefsFromExecutionSummary(summary: ExecutionSummaryV1): string[] {
  return uniqueStrings([
    ...summary.collaboration_summary.evidence_refs,
    ...summary.collaboration_routing_summary.preferred_evidence_refs,
    ...summary.delegation_records_summary.delegation_returns.flatMap((record) => record.evidence ?? []),
  ], 64);
}

function evidenceNodesFromSummary(summary: ExecutionSummaryV1): CognitiveEvidenceNode[] {
  return evidenceRefsFromExecutionSummary(summary).map((ref, index) => CognitiveEvidenceNodeSchema.parse({
    evidence_id: `execution_evidence_ref_${index + 1}`,
    kind: "memory_reference",
    grade: "memory_reference",
    outcome: "inconclusive",
    source_refs: [ref],
    claims: [],
    files: [],
    verifier_command: null,
    confidence: 0.6,
  }));
}

function countMutationEffect(mutations: PolicyMutationV1[], effects: string[]): number {
  return mutations.filter((mutation) => effects.includes(mutation.proposed_effect)).length;
}

export function buildCognitiveStructureV1(args: {
  tenant_id: string;
  scope: string;
  runtime_version?: string | null;
  generated_at?: string | null;
  execution_summary: ExecutionSummaryV1;
  evidence_nodes?: CognitiveEvidenceNode[];
  evidence_edges?: CognitiveEvidenceEdge[];
  policy_mutations?: PolicyMutationV1[];
}): CognitiveStructureV1 {
  const executionSummary = ExecutionSummaryV1Schema.parse(args.execution_summary);
  const policyMutations = (args.policy_mutations ?? []).map((mutation) => PolicyMutationV1Schema.parse(mutation));
  const providedEvidenceNodes = (args.evidence_nodes ?? []).map((node) => CognitiveEvidenceNodeSchema.parse(node));
  const inferredEvidenceNodes = evidenceNodesFromSummary(executionSummary);
  const evidenceNodes = [...providedEvidenceNodes, ...inferredEvidenceNodes].slice(0, 256);
  const evidenceEdges = (args.evidence_edges ?? []).map((edge) => CognitiveEvidenceEdgeSchema.parse(edge)).slice(0, 512);
  const routing = executionSummary.collaboration_routing_summary;
  const continuity = executionSummary.continuity_snapshot_summary;
  const actionPacket = executionSummary.action_packet_summary;
  const workflowSignals = executionSummary.workflow_signal_summary;
  const workflowLifecycle = executionSummary.workflow_lifecycle_summary;
  const forgetting = executionSummary.forgetting_summary;
  const authority = executionSummary.authority_visibility_summary;
  const policyLifecycle = executionSummary.policy_lifecycle_summary;

  return CognitiveStructureV1Schema.parse({
    structure_version: "cognitive_structure_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    generated_at: args.generated_at ?? new Date().toISOString(),
    runtime_version: args.runtime_version ?? null,
    source_code_change_allowed: false,
    execution_state: {
      current_stage: routing.current_stage ?? continuity.current_stage,
      active_role: routing.active_role ?? continuity.active_role,
      task_family: routing.task_family ?? continuity.task_family,
      family_scope: routing.family_scope || continuity.family_scope,
      selected_tool: routing.selected_tool ?? continuity.selected_tool,
      next_action: routing.next_action ?? continuity.next_action,
      target_files: uniqueStrings([...routing.target_files, ...continuity.working_set], 64),
      validation_paths: uniqueStrings([...routing.validation_paths, ...continuity.validation_paths], 64),
      unresolved_blockers: uniqueStrings(routing.unresolved_blockers, 64),
      evidence_refs: evidenceRefsFromExecutionSummary(executionSummary),
      packet_present: executionSummary.packet_assembly.execution_packet_v1_present === true,
      state_first_assembly: executionSummary.packet_assembly.state_first_assembly === true,
      recommended_action: continuity.recommended_action,
    },
    evidence_graph: {
      evidence_node_count: evidenceNodes.length,
      evidence_edge_count: evidenceEdges.length,
      proven_fact_count: evidenceNodes.filter((node) => node.outcome === "success").length,
      failed_evidence_count: evidenceNodes.filter((node) => node.outcome === "failure" || node.outcome === "counter_evidence").length,
      verifier_evidence_count: evidenceNodes.filter((node) => node.kind === "verifier_result").length,
      provider_or_protocol_failure_count: evidenceNodes.filter((node) => node.grade === "provider_failure" || node.grade === "protocol_failure").length,
      nodes: evidenceNodes,
      edges: evidenceEdges,
    },
    workflow_memory: {
      stable_count: workflowLifecycle.stable_count,
      candidate_count: workflowLifecycle.candidate_count,
      promotion_ready_count: workflowLifecycle.promotion_ready_count,
      observing_count: workflowSignals.observing_workflow_count,
      stable_titles: workflowSignals.stable_workflow_titles,
      promotion_ready_titles: workflowSignals.promotion_ready_workflow_titles,
      observing_titles: workflowSignals.observing_workflow_titles,
      stable_anchor_ids: executionSummary.routing_signal_summary.stable_workflow_anchor_ids,
      candidate_anchor_ids: actionPacket.candidate_workflow_anchor_ids,
      rehydration_anchor_ids: actionPacket.rehydration_anchor_ids,
    },
    policy_memory: {
      persisted_count: policyLifecycle.persisted_count,
      active_count: policyLifecycle.active_count,
      contested_count: policyLifecycle.contested_count,
      retired_count: policyLifecycle.retired_count,
      default_mode_count: policyLifecycle.default_mode_count,
      hint_mode_count: policyLifecycle.hint_mode_count,
      stable_policy_count: policyLifecycle.stable_policy_count,
      mutation_count: policyMutations.length,
      admitted_mutation_count: countMutationEffect(policyMutations, ["active", "default", "stable", "retired", "archived", "suppressed"]),
      blocked_mutation_count: policyMutations.filter((mutation) => mutation.adjudication.decision === "reject").length,
      mutation_ids: policyMutations.map((mutation) => mutation.mutation_id),
    },
    forgetting_state: {
      substrate_mode: forgetting.substrate_mode,
      forgotten_items: forgetting.forgotten_items,
      stale_signal_count: forgetting.stale_signal_count,
      suppressed_pattern_count: forgetting.suppressed_pattern_count,
      archived_count: forgetting.lifecycle_state_counts.archived,
      contested_count: forgetting.lifecycle_state_counts.contested,
      retired_count: forgetting.lifecycle_state_counts.retired,
      rehydration_candidate_count: forgetting.differential_rehydration_candidate_count,
      primary_forgetting_reason: forgetting.primary_forgetting_reason,
      recommended_action: forgetting.recommended_action,
    },
    authority_state: {
      surface_count: authority.surface_count,
      authoritative_allowed_count: authority.authoritative_allowed_count,
      authoritative_blocked_count: authority.authoritative_blocked_count,
      stable_promotion_allowed_count: authority.stable_promotion_allowed_count,
      stable_promotion_blocked_count: authority.stable_promotion_blocked_count,
      blocked_by_reason: authority.reason_counts,
      top_blockers: authority.top_blockers,
      recommended_guardrail: authority.authoritative_blocked_count > 0
        ? "inspect blocked authority before applying learned guidance"
        : "learned authority may be considered according to evidence grade",
    },
    policy_mutations: policyMutations,
  });
}
