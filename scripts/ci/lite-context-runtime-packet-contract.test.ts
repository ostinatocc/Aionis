import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { FakeEmbeddingProvider } from "../../src/embeddings/fake.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerHostErrorHandler } from "../../src/host/http-host.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import {
  ActionRetrievalGateSummarySchema,
  ContextAssembleRouteContractSchema,
  DelegationRecordsWriteResponseSchema,
  MemoryAnchorV1Schema,
  PlanningContextRouteContractSchema,
} from "../../src/memory/schemas.ts";
import { buildExecutionMemorySummaryBundle, summarizePatternSignals } from "../../src/app/planning-summary.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function parseSectionAnchorIds(lines: string[]): string[] {
  return lines
    .map((line) => {
      const match = /(?:anchor|id)=([^;,\s]+)/.exec(line);
      return match?.[1] ?? null;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function assertNoStalePlannerMirrors(body: Record<string, unknown>) {
  const removedFields = [
    "action_recall_packet",
    "recommended_workflows",
    "candidate_workflows",
    "candidate_patterns",
    "trusted_patterns",
    "contested_patterns",
    "rehydration_candidates",
    "supporting_knowledge",
  ];
  for (const field of removedFields) {
    assert.ok(!(field in body), `${field} should not be present on the slim default route surface`);
  }
}

function runtimeEntropyControlsFixture() {
  return {
    controls_version: "runtime_entropy_controls_v1",
    recall: {
      breadth: "wide",
      recommended_limit: 20,
      recommended_ranked_limit: 160,
      recommended_max_nodes: 160,
      recommended_max_edges: 100,
      reason: "High entropy requires wider recall before action.",
    },
    verifier: {
      verification_depth: "strict",
      schedule: "strict",
      runtime_verifier_required: true,
      reason: "Strict verifier evidence is required.",
    },
    promotion: {
      promotion_threshold: "high",
      mutation_authority: "candidate_only",
      minimum_observations: 3,
      stable_promotion_allowed: false,
      reason: "Keep learning candidate-only until broader evidence exists.",
    },
    maintenance: {
      recommended_profile: "immediate",
      run_after_task: true,
      reason: "Preserve fresh execution evidence after task exit.",
    },
    source_code_change_allowed: false,
  };
}

function assertActionPacketSummaryMatchesPacket(summary: {
  recommended_workflow_count: number;
  candidate_workflow_count: number;
  candidate_pattern_count: number;
  trusted_pattern_count: number;
  contested_pattern_count: number;
  rehydration_candidate_count: number;
  supporting_knowledge_count: number;
  workflow_anchor_ids: string[];
  candidate_workflow_anchor_ids: string[];
  candidate_pattern_anchor_ids: string[];
  trusted_pattern_anchor_ids: string[];
  contested_pattern_anchor_ids: string[];
  rehydration_anchor_ids: string[];
}, body: {
  planner_packet: {
    sections: Record<string, string[]>;
  };
}) {
  const sections = body.planner_packet.sections;
  assert.equal(summary.recommended_workflow_count, (sections.recommended_workflows ?? []).length);
  assert.equal(summary.candidate_workflow_count, (sections.candidate_workflows ?? []).length);
  assert.equal(summary.candidate_pattern_count, (sections.candidate_patterns ?? []).length);
  assert.equal(summary.trusted_pattern_count, (sections.trusted_patterns ?? []).length);
  assert.equal(summary.contested_pattern_count, (sections.contested_patterns ?? []).length);
  assert.equal(summary.rehydration_candidate_count, (sections.rehydration_candidates ?? []).length);
  assert.equal(summary.supporting_knowledge_count, (sections.supporting_knowledge ?? []).length);
  assert.deepEqual(summary.workflow_anchor_ids, parseSectionAnchorIds(sections.recommended_workflows ?? []));
  assert.deepEqual(summary.candidate_workflow_anchor_ids, parseSectionAnchorIds(sections.candidate_workflows ?? []));
  assert.deepEqual(summary.candidate_pattern_anchor_ids, parseSectionAnchorIds(sections.candidate_patterns ?? []));
  assert.deepEqual(summary.trusted_pattern_anchor_ids, parseSectionAnchorIds(sections.trusted_patterns ?? []));
  assert.deepEqual(summary.contested_pattern_anchor_ids, parseSectionAnchorIds(sections.contested_patterns ?? []));
  assert.deepEqual(summary.rehydration_anchor_ids, parseSectionAnchorIds(sections.rehydration_candidates ?? []));
}

function assertExecutionKernelBundle(body: {
  layered_context: Record<string, unknown>;
  execution_kernel: {
    packet_source_mode: string;
    state_first_assembly: boolean;
    execution_packet_v1_present: boolean;
    execution_state_v1_present: boolean;
    action_packet_summary: unknown;
    pattern_signal_summary: unknown;
    workflow_signal_summary: unknown;
    workflow_lifecycle_summary: unknown;
    workflow_maintenance_summary: unknown;
    distillation_signal_summary: unknown;
    pattern_lifecycle_summary: unknown;
    pattern_maintenance_summary: unknown;
    policy_lifecycle_summary: unknown;
    policy_maintenance_summary: unknown;
    continuity_carrier_summary: unknown;
  };
  execution_summary: {
    action_packet_summary: unknown;
    pattern_signal_summary: unknown;
    workflow_signal_summary: unknown;
    workflow_lifecycle_summary: unknown;
    workflow_maintenance_summary: unknown;
    distillation_signal_summary: unknown;
    pattern_lifecycle_summary: unknown;
    pattern_maintenance_summary: unknown;
    policy_lifecycle_summary: unknown;
    policy_maintenance_summary: unknown;
    continuity_carrier_summary: unknown;
  };
}) {
  const layered = body.layered_context;
  const expected = buildExecutionMemorySummaryBundle({
    action_recall_packet: layered.action_recall_packet,
    recommended_workflows: layered.recommended_workflows,
    candidate_workflows: layered.candidate_workflows,
    candidate_patterns: layered.candidate_patterns,
    trusted_patterns: layered.trusted_patterns,
    contested_patterns: layered.contested_patterns,
    rehydration_candidates: layered.rehydration_candidates,
    supporting_knowledge: layered.supporting_knowledge,
    pattern_signals: layered.pattern_signals,
    workflow_signals: layered.workflow_signals,
  });
  assert.deepEqual(body.execution_kernel.action_packet_summary, expected.action_packet_summary);
  assert.deepEqual(body.execution_kernel.pattern_signal_summary, expected.pattern_signal_summary);
  assert.deepEqual(body.execution_kernel.workflow_signal_summary, expected.workflow_signal_summary);
  assert.deepEqual(body.execution_kernel.workflow_lifecycle_summary, expected.workflow_lifecycle_summary);
  assert.deepEqual(body.execution_kernel.workflow_maintenance_summary, expected.workflow_maintenance_summary);
  assert.deepEqual(body.execution_kernel.distillation_signal_summary, expected.distillation_signal_summary);
  assert.deepEqual(body.execution_kernel.pattern_lifecycle_summary, expected.pattern_lifecycle_summary);
  assert.deepEqual(body.execution_kernel.pattern_maintenance_summary, expected.pattern_maintenance_summary);
  assert.deepEqual(body.execution_kernel.policy_lifecycle_summary, expected.policy_lifecycle_summary);
  assert.deepEqual(body.execution_kernel.policy_maintenance_summary, expected.policy_maintenance_summary);
  assert.deepEqual(body.execution_kernel.continuity_carrier_summary, expected.continuity_carrier_summary);
  assert.deepEqual(body.execution_summary.action_packet_summary, expected.action_packet_summary);
  assert.deepEqual(body.execution_summary.pattern_signal_summary, expected.pattern_signal_summary);
  assert.deepEqual(body.execution_summary.workflow_signal_summary, expected.workflow_signal_summary);
  assert.deepEqual(body.execution_summary.workflow_lifecycle_summary, expected.workflow_lifecycle_summary);
  assert.deepEqual(body.execution_summary.workflow_maintenance_summary, expected.workflow_maintenance_summary);
  assert.deepEqual(body.execution_summary.distillation_signal_summary, expected.distillation_signal_summary);
  assert.deepEqual(body.execution_summary.pattern_lifecycle_summary, expected.pattern_lifecycle_summary);
  assert.deepEqual(body.execution_summary.pattern_maintenance_summary, expected.pattern_maintenance_summary);
  assert.deepEqual(body.execution_summary.policy_lifecycle_summary, expected.policy_lifecycle_summary);
  assert.deepEqual(body.execution_summary.policy_maintenance_summary, expected.policy_maintenance_summary);
  assert.deepEqual(body.execution_summary.continuity_carrier_summary, expected.continuity_carrier_summary);
}

const EXECUTION_FORGETTING_SUMMARY_KEYS = [
  "archive_payload_scope_counts",
  "archive_relocation_state_counts",
  "archive_relocation_target_counts",
  "differential_rehydration_candidate_count",
  "forgotten_by_reason",
  "forgotten_items",
  "lifecycle_state_counts",
  "primary_forgetting_reason",
  "primary_savings_levers",
  "recommended_action",
  "rehydration_mode_counts",
  "selected_memory_layers",
  "semantic_action_counts",
  "stale_signal_count",
  "substrate_mode",
  "summary_version",
  "suppressed_pattern_anchor_ids",
  "suppressed_pattern_count",
  "suppressed_pattern_sources",
].sort();

const EXECUTION_FORGETTING_ACTION_COUNT_KEYS = ["archive", "demote", "retain", "review"].sort();
const EXECUTION_FORGETTING_LIFECYCLE_COUNT_KEYS = ["active", "archived", "contested", "retired"].sort();
const EXECUTION_ARCHIVE_RELOCATION_STATE_COUNT_KEYS = ["candidate", "cold_archive", "none"].sort();
const EXECUTION_ARCHIVE_RELOCATION_TARGET_COUNT_KEYS = ["external_object_store", "local_cold_store", "none"].sort();
const EXECUTION_ARCHIVE_PAYLOAD_SCOPE_COUNT_KEYS = ["anchor_payload", "node", "none"].sort();
const EXECUTION_REHYDRATION_MODE_COUNT_KEYS = ["differential", "full", "partial", "summary_only"].sort();

const EXECUTION_PACKET_ASSEMBLY_KEYS = [
  "execution_packet_v1_present",
  "execution_state_v1_present",
  "packet_source_mode",
  "state_first_assembly",
].sort();

const EXECUTION_STRATEGY_SUMMARY_KEYS = [
  "explanation",
  "family_candidate_count",
  "family_scope",
  "preferred_artifact_refs",
  "selected_pattern_summaries",
  "selected_validation_paths",
  "selected_working_set",
  "strategy_profile",
  "summary_version",
  "task_family",
  "trust_signal",
  "validation_style",
].sort();

const EXECUTION_COLLABORATION_SUMMARY_KEYS = [
  "acceptance_check_count",
  "active_role",
  "artifact_ref_count",
  "artifact_refs",
  "coordination_mode",
  "current_stage",
  "evidence_ref_count",
  "evidence_refs",
  "next_action",
  "packet_present",
  "pending_validation_count",
  "resume_anchor_file_path",
  "resume_anchor_present",
  "resume_anchor_symbol",
  "review_contract_present",
  "review_standard",
  "rollback_required",
  "side_output_artifact_count",
  "side_output_evidence_count",
  "summary_version",
  "target_file_count",
  "unresolved_blocker_count",
].sort();

const EXECUTION_CONTINUITY_SNAPSHOT_KEYS = [
  "active_role",
  "coordination_mode",
  "current_stage",
  "family_scope",
  "next_action",
  "preferred_artifact_refs",
  "preferred_evidence_refs",
  "recommended_action",
  "resume_anchor_file_path",
  "reviewer_ready",
  "selected_memory_layers",
  "selected_pattern_summaries",
  "selected_tool",
  "snapshot_mode",
  "strategy_profile",
  "summary_version",
  "task_family",
  "trust_signal",
  "validation_paths",
  "validation_style",
  "working_set",
].sort();

const EXECUTION_COLLABORATION_ROUTING_KEYS = [
  "acceptance_checks",
  "active_role",
  "coordination_mode",
  "current_stage",
  "family_scope",
  "hard_constraints",
  "next_action",
  "preferred_artifact_refs",
  "preferred_evidence_refs",
  "required_outputs",
  "review_standard",
  "route_intent",
  "route_mode",
  "routing_drivers",
  "selected_tool",
  "summary_version",
  "target_files",
  "task_brief",
  "task_family",
  "unresolved_blockers",
  "validation_paths",
].sort();

const EXECUTION_ROUTING_SIGNAL_KEYS = [
  "candidate_workflow_anchor_ids",
  "family_scope",
  "other_family_rehydration_anchor_ids",
  "rehydration_anchor_ids",
  "same_family_rehydration_anchor_ids",
  "selected_tool",
  "stable_workflow_anchor_ids",
  "summary_version",
  "task_family",
  "unknown_family_rehydration_anchor_ids",
  "workflow_source_kinds",
].sort();

const EXECUTION_MAINTENANCE_SUMMARY_KEYS = [
  "forgotten_by_reason",
  "forgotten_items",
  "primary_savings_levers",
  "promotion_ready_workflow_count",
  "recommended_action",
  "selected_memory_layers",
  "stable_workflow_count",
  "summary_version",
  "suppressed_pattern_count",
].sort();

const EXECUTION_INSTRUMENTATION_SUMMARY_KEYS = [
  "family_hit",
  "family_reason",
  "family_scope",
  "known_family_rehydration_count",
  "other_family_rehydration_anchor_ids",
  "other_family_rehydration_count",
  "rehydration_candidate_count",
  "rehydration_family_hit_rate",
  "same_family_rehydration_anchor_ids",
  "same_family_rehydration_count",
  "selected_pattern_hit_count",
  "selected_pattern_miss_count",
  "summary_version",
  "task_family",
  "unknown_family_rehydration_count",
].sort();

const EXECUTION_SUMMARY_V1_KEYS = [
  "action_packet_summary",
  "authority_visibility_summary",
  "collaboration_routing_summary",
  "collaboration_summary",
  "continuity_carrier_summary",
  "continuity_snapshot_summary",
  "delegation_records_summary",
  "distillation_signal_summary",
  "forgetting_summary",
  "instrumentation_summary",
  "maintenance_summary",
  "packet_assembly",
  "pattern_lifecycle_summary",
  "pattern_maintenance_summary",
  "pattern_signal_summary",
  "pattern_signals",
  "planner_packet",
  "policy_lifecycle_summary",
  "policy_maintenance_summary",
  "routing_signal_summary",
  "strategy_summary",
  "summary_version",
  "workflow_lifecycle_summary",
  "workflow_maintenance_summary",
  "workflow_signal_summary",
  "workflow_signals",
].sort();

const EXECUTION_DELEGATION_RECORDS_SUMMARY_KEYS = [
  "artifact_routing_count",
  "artifact_routing_records",
  "delegation_packets",
  "delegation_returns",
  "missing_record_types",
  "packet_count",
  "record_mode",
  "return_count",
  "route_role",
  "summary_version",
].sort();

const EXECUTION_DELEGATION_PACKET_RECORD_KEYS = [
  "acceptance_checks",
  "family_scope",
  "inherited_evidence",
  "mission",
  "output_contract",
  "preferred_artifact_refs",
  "role",
  "routing_reason",
  "source_mode",
  "task_family",
  "version",
  "working_set",
].sort();

const EXECUTION_DELEGATION_RETURN_RECORD_KEYS = [
  "acceptance_checks",
  "evidence",
  "role",
  "source_mode",
  "status",
  "summary",
  "version",
  "working_set",
].sort();

const EXECUTION_ARTIFACT_ROUTING_RECORD_KEYS = [
  "family_scope",
  "ref",
  "ref_kind",
  "route_intent",
  "route_mode",
  "route_role",
  "routing_reason",
  "source",
  "task_family",
  "version",
].sort();

function assertDelegationRecordsExactKeySurface(summary: {
  delegation_packets: unknown[];
  delegation_returns: unknown[];
  artifact_routing_records: unknown[];
}) {
  assert.deepEqual(
    Object.keys(summary as Record<string, unknown>).sort(),
    EXECUTION_DELEGATION_RECORDS_SUMMARY_KEYS,
  );
  for (const packet of summary.delegation_packets) {
    assert.deepEqual(
      Object.keys(packet as Record<string, unknown>).sort(),
      EXECUTION_DELEGATION_PACKET_RECORD_KEYS,
    );
  }
  for (const returnRecord of summary.delegation_returns) {
    assert.deepEqual(
      Object.keys(returnRecord as Record<string, unknown>).sort(),
      EXECUTION_DELEGATION_RETURN_RECORD_KEYS,
    );
  }
  for (const artifactRecord of summary.artifact_routing_records) {
    assert.deepEqual(
      Object.keys(artifactRecord as Record<string, unknown>).sort(),
      EXECUTION_ARTIFACT_ROUTING_RECORD_KEYS,
    );
  }
}

function assertKernelMatchesRouteSurface(body: {
  planner_packet: unknown;
  pattern_signals: unknown[];
  workflow_signals: unknown[];
  execution_kernel: {
    packet_source_mode: string;
    state_first_assembly: boolean;
    execution_packet_v1_present: boolean;
    execution_state_v1_present: boolean;
    action_packet_summary: unknown;
    pattern_signal_summary: unknown;
    workflow_signal_summary: unknown;
    workflow_lifecycle_summary: unknown;
    workflow_maintenance_summary: unknown;
    authority_visibility_summary: unknown;
    distillation_signal_summary: unknown;
    pattern_lifecycle_summary: unknown;
    pattern_maintenance_summary: unknown;
    policy_lifecycle_summary: unknown;
    policy_maintenance_summary: unknown;
    continuity_carrier_summary: unknown;
  };
  execution_summary: {
    planner_packet: unknown;
    pattern_signals: unknown[];
    workflow_signals: unknown[];
    packet_assembly: {
      packet_source_mode: string | null;
      state_first_assembly: boolean | null;
      execution_packet_v1_present: boolean | null;
      execution_state_v1_present: boolean | null;
    };
    strategy_summary: {
      summary_version: string;
      trust_signal: string;
      strategy_profile: string;
      validation_style: string;
      task_family: string | null;
      family_scope: string;
      family_candidate_count: number;
      selected_working_set: string[];
      selected_validation_paths: string[];
      selected_pattern_summaries: string[];
      preferred_artifact_refs: string[];
      explanation: string;
    };
    collaboration_summary: {
      summary_version: string;
      packet_present: boolean;
      coordination_mode: string;
      current_stage: string | null;
      active_role: string | null;
      next_action: string | null;
      target_file_count: number;
      pending_validation_count: number;
      unresolved_blocker_count: number;
      review_contract_present: boolean;
      review_standard: string | null;
      acceptance_check_count: number;
      rollback_required: boolean;
      resume_anchor_present: boolean;
      resume_anchor_file_path: string | null;
      resume_anchor_symbol: string | null;
      artifact_ref_count: number;
      evidence_ref_count: number;
      side_output_artifact_count: number;
      side_output_evidence_count: number;
      artifact_refs: string[];
      evidence_refs: string[];
    };
    continuity_snapshot_summary: {
      summary_version: string;
      snapshot_mode: string;
      coordination_mode: string;
      trust_signal: string;
      strategy_profile: string;
      validation_style: string;
      task_family: string | null;
      family_scope: string;
      selected_tool: string | null;
      current_stage: string | null;
      active_role: string | null;
      next_action: string | null;
      working_set: string[];
      validation_paths: string[];
      selected_pattern_summaries: string[];
      preferred_artifact_refs: string[];
      preferred_evidence_refs: string[];
      reviewer_ready: boolean;
      resume_anchor_file_path: string | null;
      selected_memory_layers: string[];
      recommended_action: string;
    };
    forgetting_summary: {
      summary_version: string;
      substrate_mode: string;
      forgotten_items: number;
      forgotten_by_reason: Record<string, number>;
      primary_forgetting_reason: string | null;
      suppressed_pattern_count: number;
      suppressed_pattern_anchor_ids: string[];
      suppressed_pattern_sources: string[];
      selected_memory_layers: string[];
      primary_savings_levers: string[];
      stale_signal_count: number;
      recommended_action: string;
    };
    collaboration_routing_summary: {
      summary_version: string;
      route_mode: string;
      coordination_mode: string;
      route_intent: string;
      task_brief: string | null;
      current_stage: string | null;
      active_role: string | null;
      selected_tool: string | null;
      task_family: string | null;
      family_scope: string;
      next_action: string | null;
      target_files: string[];
      validation_paths: string[];
      unresolved_blockers: string[];
      hard_constraints: string[];
      review_standard: string | null;
      required_outputs: string[];
      acceptance_checks: string[];
      preferred_artifact_refs: string[];
      preferred_evidence_refs: string[];
      routing_drivers: string[];
    };
    delegation_records_summary: {
      summary_version: string;
      record_mode: string;
      route_role: string;
      packet_count: number;
      return_count: number;
      artifact_routing_count: number;
      missing_record_types: string[];
      delegation_packets: Array<{
        version: number;
        role: string;
        mission: string;
        working_set: string[];
        acceptance_checks: string[];
        output_contract: string;
        preferred_artifact_refs: string[];
        inherited_evidence: string[];
        routing_reason: string;
        task_family: string | null;
        family_scope: string;
        source_mode: string;
      }>;
      delegation_returns: Array<{
        version: number;
        role: string;
        status: string;
        summary: string;
        evidence: string[];
        working_set: string[];
        acceptance_checks: string[];
        source_mode: string;
      }>;
      artifact_routing_records: Array<{
        version: number;
        ref: string;
        ref_kind: string;
        route_role: string;
        route_intent: string;
        route_mode: string;
        task_family: string | null;
        family_scope: string;
        routing_reason: string;
        source: string;
      }>;
    };
    action_packet_summary: unknown;
    pattern_signal_summary: unknown;
    workflow_signal_summary: unknown;
    workflow_lifecycle_summary: unknown;
    workflow_maintenance_summary: unknown;
    pattern_lifecycle_summary: unknown;
    pattern_maintenance_summary: unknown;
    routing_signal_summary: {
      stable_workflow_anchor_ids: string[];
      candidate_workflow_anchor_ids: string[];
      rehydration_anchor_ids: string[];
      selected_tool: string | null;
    };
    maintenance_summary: {
      forgotten_items: number;
      suppressed_pattern_count: number;
      selected_memory_layers: string[];
      primary_savings_levers: string[];
      recommended_action: string;
    };
    instrumentation_summary: {
      rehydration_candidate_count: number;
    };
  };
  cost_signals?: {
    forgotten_items: number;
    selected_memory_layers: string[];
  };
  tools?: {
    selection?: {
      selected?: string | null;
    };
  };
  planning_summary?: {
    action_packet_summary: unknown;
    workflow_signal_summary: unknown;
    workflow_lifecycle_summary: unknown;
    workflow_maintenance_summary: unknown;
    distillation_signal_summary: unknown;
    pattern_lifecycle_summary: unknown;
    pattern_maintenance_summary: unknown;
    policy_lifecycle_summary: unknown;
    policy_maintenance_summary: unknown;
    continuity_carrier_summary: unknown;
    trusted_pattern_count: number;
    contested_pattern_count: number;
    trusted_pattern_tools: string[];
    contested_pattern_tools: string[];
  };
  assembly_summary?: {
    action_packet_summary: unknown;
    workflow_signal_summary: unknown;
    workflow_lifecycle_summary: unknown;
    workflow_maintenance_summary: unknown;
    distillation_signal_summary: unknown;
    pattern_lifecycle_summary: unknown;
    pattern_maintenance_summary: unknown;
    policy_lifecycle_summary: unknown;
    policy_maintenance_summary: unknown;
    continuity_carrier_summary: unknown;
    trusted_pattern_count: number;
    contested_pattern_count: number;
    trusted_pattern_tools: string[];
    contested_pattern_tools: string[];
  };
}) {
  const routeSummary = body.planning_summary ?? body.assembly_summary;
  assert.ok(routeSummary, "route summary should exist");
  const executionSummary = body.execution_summary as Record<string, unknown>;
  assert.deepEqual(Object.keys(executionSummary).sort(), EXECUTION_SUMMARY_V1_KEYS);
  assert.deepEqual(body.execution_summary.planner_packet, body.planner_packet);
  assert.deepEqual(body.execution_summary.pattern_signals, body.pattern_signals);
  assert.deepEqual(body.execution_summary.workflow_signals, body.workflow_signals);
  assert.equal(body.execution_summary.packet_assembly.packet_source_mode, body.execution_kernel.packet_source_mode);
  assert.equal(body.execution_summary.packet_assembly.state_first_assembly, body.execution_kernel.state_first_assembly);
  assert.equal(
    body.execution_summary.packet_assembly.execution_packet_v1_present,
    body.execution_kernel.execution_packet_v1_present,
  );
  assert.equal(
    body.execution_summary.packet_assembly.execution_state_v1_present,
    body.execution_kernel.execution_state_v1_present,
  );
  assert.deepEqual(
    Object.keys(executionSummary.packet_assembly as Record<string, unknown>).sort(),
    EXECUTION_PACKET_ASSEMBLY_KEYS,
  );
  assert.deepEqual(
    body.execution_summary.routing_signal_summary.stable_workflow_anchor_ids,
    (body.execution_kernel.action_packet_summary as any).workflow_anchor_ids,
  );
  assert.deepEqual(
    body.execution_summary.routing_signal_summary.candidate_workflow_anchor_ids,
    (body.execution_kernel.action_packet_summary as any).candidate_workflow_anchor_ids,
  );
  assert.deepEqual(
    body.execution_summary.routing_signal_summary.rehydration_anchor_ids,
    (body.execution_kernel.action_packet_summary as any).rehydration_anchor_ids,
  );
  assert.equal(
    body.execution_summary.routing_signal_summary.selected_tool,
    body.tools?.selection?.selected ?? null,
  );
  assert.equal(body.execution_summary.strategy_summary.summary_version, "execution_strategy_summary_v1");
  assert.equal(
    body.execution_summary.strategy_summary.trust_signal,
    body.execution_summary.routing_signal_summary.family_scope,
  );
  assert.equal(
    body.execution_summary.strategy_summary.task_family,
    body.execution_summary.routing_signal_summary.task_family,
  );
  assert.equal(
    body.execution_summary.strategy_summary.family_scope,
    body.execution_summary.routing_signal_summary.family_scope,
  );
  assert.ok(body.execution_summary.strategy_summary.family_candidate_count >= 0);
  assert.equal(body.execution_summary.strategy_summary.strategy_profile, "rehydration_first");
  assert.equal(body.execution_summary.strategy_summary.validation_style, "candidate_promotion_validation");
  assert.ok(body.execution_summary.strategy_summary.selected_working_set.includes("tool:edit"));
  for (const layer of body.cost_signals?.selected_memory_layers ?? []) {
    assert.ok(
      body.execution_summary.strategy_summary.selected_working_set.includes(`memory:${layer}`),
      `strategy summary should surface selected memory layer ${layer}`,
    );
  }
  assert.ok(body.execution_summary.strategy_summary.selected_validation_paths.length > 0);
  assert.ok(body.execution_summary.strategy_summary.preferred_artifact_refs.length > 0);
  assert.ok(body.execution_summary.strategy_summary.explanation.length > 0);
  assert.deepEqual(
    Object.keys(executionSummary.strategy_summary as Record<string, unknown>).sort(),
    EXECUTION_STRATEGY_SUMMARY_KEYS,
  );
  assert.equal(body.execution_summary.collaboration_summary.summary_version, "execution_collaboration_summary_v1");
  assert.equal(body.execution_summary.collaboration_summary.packet_present, false);
  assert.equal(body.execution_summary.collaboration_summary.coordination_mode, "memory_only");
  assert.equal(body.execution_summary.collaboration_summary.current_stage, null);
  assert.equal(body.execution_summary.collaboration_summary.active_role, null);
  assert.equal(body.execution_summary.collaboration_summary.review_contract_present, false);
  assert.equal(body.execution_summary.collaboration_summary.resume_anchor_present, false);
  assert.equal(body.execution_summary.collaboration_summary.artifact_ref_count, 0);
  assert.equal(body.execution_summary.collaboration_summary.evidence_ref_count, 0);
  assert.equal(body.execution_summary.collaboration_summary.side_output_artifact_count, 0);
  assert.equal(body.execution_summary.collaboration_summary.side_output_evidence_count, 0);
  assert.deepEqual(
    Object.keys(executionSummary.collaboration_summary as Record<string, unknown>).sort(),
    EXECUTION_COLLABORATION_SUMMARY_KEYS,
  );
  assert.equal(body.execution_summary.continuity_snapshot_summary.summary_version, "execution_continuity_snapshot_v1");
  assert.equal(body.execution_summary.continuity_snapshot_summary.snapshot_mode, "memory_only");
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.coordination_mode,
    body.execution_summary.collaboration_summary.coordination_mode,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.trust_signal,
    body.execution_summary.strategy_summary.trust_signal,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.strategy_profile,
    body.execution_summary.strategy_summary.strategy_profile,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.validation_style,
    body.execution_summary.strategy_summary.validation_style,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.task_family,
    body.execution_summary.strategy_summary.task_family,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.family_scope,
    body.execution_summary.strategy_summary.family_scope,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.selected_tool,
    body.execution_summary.routing_signal_summary.selected_tool,
  );
  assert.equal(body.execution_summary.continuity_snapshot_summary.current_stage, null);
  assert.equal(body.execution_summary.continuity_snapshot_summary.active_role, null);
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.reviewer_ready,
    body.execution_summary.collaboration_summary.review_contract_present,
  );
  assert.equal(body.execution_summary.continuity_snapshot_summary.resume_anchor_file_path, null);
  assert.deepEqual(
    body.execution_summary.continuity_snapshot_summary.selected_memory_layers,
    body.execution_summary.maintenance_summary.selected_memory_layers,
  );
  assert.equal(
    body.execution_summary.continuity_snapshot_summary.recommended_action,
    body.execution_summary.maintenance_summary.recommended_action,
  );
  assert.deepEqual(
    body.execution_summary.continuity_snapshot_summary.selected_pattern_summaries,
    body.execution_summary.strategy_summary.selected_pattern_summaries,
  );
  assert.deepEqual(
    body.execution_summary.continuity_snapshot_summary.validation_paths,
    body.execution_summary.strategy_summary.selected_validation_paths,
  );
  assert.ok(body.execution_summary.continuity_snapshot_summary.preferred_artifact_refs.length > 0);
  assert.deepEqual(
    Object.keys(executionSummary.continuity_snapshot_summary as Record<string, unknown>).sort(),
    EXECUTION_CONTINUITY_SNAPSHOT_KEYS,
  );
  assert.equal(
    body.execution_summary.maintenance_summary.forgotten_items,
    body.cost_signals?.forgotten_items ?? 0,
  );
  assert.deepEqual(
    body.execution_summary.maintenance_summary.selected_memory_layers,
    body.cost_signals?.selected_memory_layers ?? [],
  );
  assert.deepEqual(
    Object.keys(executionSummary.routing_signal_summary as Record<string, unknown>).sort(),
    EXECUTION_ROUTING_SIGNAL_KEYS,
  );
  assert.deepEqual(
    Object.keys(executionSummary.maintenance_summary as Record<string, unknown>).sort(),
    EXECUTION_MAINTENANCE_SUMMARY_KEYS,
  );
  assert.equal(body.execution_summary.forgetting_summary.summary_version, "execution_forgetting_summary_v1");
  assert.equal(
    body.execution_summary.forgetting_summary.forgotten_items,
    body.execution_summary.maintenance_summary.forgotten_items,
  );
  assert.equal(
    body.execution_summary.forgetting_summary.suppressed_pattern_count,
    body.execution_summary.maintenance_summary.suppressed_pattern_count,
  );
  assert.deepEqual(
    body.execution_summary.forgetting_summary.selected_memory_layers,
    body.execution_summary.maintenance_summary.selected_memory_layers,
  );
  assert.deepEqual(
    body.execution_summary.forgetting_summary.primary_savings_levers,
    body.execution_summary.maintenance_summary.primary_savings_levers,
  );
  assert.equal(
    body.execution_summary.forgetting_summary.recommended_action,
    body.execution_summary.maintenance_summary.recommended_action,
  );
  assert.equal(
    body.execution_summary.forgetting_summary.stale_signal_count,
    body.execution_summary.forgetting_summary.forgotten_items
      + body.execution_summary.forgetting_summary.suppressed_pattern_count,
  );
  assert.equal(
    body.execution_summary.forgetting_summary.substrate_mode,
    body.execution_summary.forgetting_summary.forgotten_items > 0
      ? "forgetting_active"
      : body.execution_summary.forgetting_summary.suppressed_pattern_count > 0
        ? "suppression_present"
        : "stable",
  );
  const forgettingReasons = Object.entries(body.execution_summary.forgetting_summary.forgotten_by_reason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  assert.equal(
    body.execution_summary.forgetting_summary.primary_forgetting_reason,
    forgettingReasons[0]?.[0] ?? null,
  );
  const forgettingSummary = body.execution_summary.forgetting_summary as Record<string, unknown>;
  assert.deepEqual(Object.keys(forgettingSummary).sort(), EXECUTION_FORGETTING_SUMMARY_KEYS);
  assert.deepEqual(
    Object.keys(forgettingSummary.semantic_action_counts as Record<string, unknown>).sort(),
    EXECUTION_FORGETTING_ACTION_COUNT_KEYS,
  );
  assert.deepEqual(
    Object.keys(forgettingSummary.lifecycle_state_counts as Record<string, unknown>).sort(),
    EXECUTION_FORGETTING_LIFECYCLE_COUNT_KEYS,
  );
  assert.deepEqual(
    Object.keys(forgettingSummary.archive_relocation_state_counts as Record<string, unknown>).sort(),
    EXECUTION_ARCHIVE_RELOCATION_STATE_COUNT_KEYS,
  );
  assert.deepEqual(
    Object.keys(forgettingSummary.archive_relocation_target_counts as Record<string, unknown>).sort(),
    EXECUTION_ARCHIVE_RELOCATION_TARGET_COUNT_KEYS,
  );
  assert.deepEqual(
    Object.keys(forgettingSummary.archive_payload_scope_counts as Record<string, unknown>).sort(),
    EXECUTION_ARCHIVE_PAYLOAD_SCOPE_COUNT_KEYS,
  );
  assert.deepEqual(
    Object.keys(forgettingSummary.rehydration_mode_counts as Record<string, unknown>).sort(),
    EXECUTION_REHYDRATION_MODE_COUNT_KEYS,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.summary_version,
    "execution_collaboration_routing_v1",
  );
  assert.deepEqual(
    Object.keys(executionSummary.collaboration_routing_summary as Record<string, unknown>).sort(),
    EXECUTION_COLLABORATION_ROUTING_KEYS,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.route_mode,
    body.execution_summary.collaboration_summary.packet_present ? "packet_backed" : "memory_only",
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.coordination_mode,
    body.execution_summary.collaboration_summary.coordination_mode,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.current_stage,
    body.execution_summary.collaboration_summary.current_stage,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.active_role,
    body.execution_summary.collaboration_summary.active_role,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.selected_tool,
    body.execution_summary.routing_signal_summary.selected_tool,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.task_family,
    body.execution_summary.routing_signal_summary.task_family,
  );
  assert.equal(
    body.execution_summary.collaboration_routing_summary.family_scope,
    body.execution_summary.routing_signal_summary.family_scope,
  );
  assert.deepEqual(
    body.execution_summary.collaboration_routing_summary.preferred_artifact_refs,
    body.execution_summary.continuity_snapshot_summary.preferred_artifact_refs,
  );
  assert.deepEqual(
    body.execution_summary.collaboration_routing_summary.preferred_evidence_refs,
    body.execution_summary.continuity_snapshot_summary.preferred_evidence_refs,
  );
  assert.ok(
    body.execution_summary.collaboration_routing_summary.validation_paths.length
      >= body.execution_summary.strategy_summary.selected_validation_paths.length,
  );
  assert.ok(
    body.execution_summary.collaboration_routing_summary.routing_drivers.includes(
      `family_scope:${body.execution_summary.routing_signal_summary.family_scope}`,
    ),
  );
  if (body.execution_summary.routing_signal_summary.selected_tool) {
    assert.ok(
      body.execution_summary.collaboration_routing_summary.routing_drivers.includes(
        `selected_tool:${body.execution_summary.routing_signal_summary.selected_tool}`,
      ),
    );
  }
  assert.equal(
    body.execution_summary.delegation_records_summary.summary_version,
    "execution_delegation_records_v1",
  );
  assertDelegationRecordsExactKeySurface(body.execution_summary.delegation_records_summary);
  assert.equal(
    body.execution_summary.delegation_records_summary.record_mode,
    body.execution_summary.collaboration_routing_summary.route_mode,
  );
  assert.equal(body.execution_summary.delegation_records_summary.packet_count, 1);
  assert.equal(
    body.execution_summary.delegation_records_summary.packet_count,
    body.execution_summary.delegation_records_summary.delegation_packets.length,
  );
  assert.equal(body.execution_summary.delegation_records_summary.return_count, 0);
  assert.deepEqual(body.execution_summary.delegation_records_summary.delegation_returns, []);
  assert.ok(body.execution_summary.delegation_records_summary.missing_record_types.includes("delegation_returns"));
  assert.equal(
    body.execution_summary.delegation_records_summary.route_role,
    body.execution_summary.collaboration_summary.active_role ?? "orchestrator",
  );
  const packetRecord = body.execution_summary.delegation_records_summary.delegation_packets[0];
  assert.ok(packetRecord);
  assert.equal(packetRecord.version, 1);
  assert.equal(packetRecord.role, body.execution_summary.delegation_records_summary.route_role);
  assert.equal(packetRecord.source_mode, body.execution_summary.delegation_records_summary.record_mode);
  assert.deepEqual(
    packetRecord.preferred_artifact_refs,
    body.execution_summary.collaboration_routing_summary.preferred_artifact_refs,
  );
  assert.deepEqual(
    packetRecord.inherited_evidence,
    body.execution_summary.collaboration_routing_summary.preferred_evidence_refs,
  );
  assert.equal(packetRecord.task_family, body.execution_summary.collaboration_routing_summary.task_family);
  assert.equal(packetRecord.family_scope, body.execution_summary.collaboration_routing_summary.family_scope);
  assert.equal(
    body.execution_summary.delegation_records_summary.artifact_routing_count,
    body.execution_summary.delegation_records_summary.artifact_routing_records.length,
  );
  assert.equal(
    body.execution_summary.delegation_records_summary.artifact_routing_count,
    body.execution_summary.collaboration_routing_summary.preferred_artifact_refs.length
      + body.execution_summary.collaboration_routing_summary.preferred_evidence_refs.length,
  );
  for (const record of body.execution_summary.delegation_records_summary.artifact_routing_records) {
    assert.equal(record.version, 1);
    assert.equal(record.route_role, body.execution_summary.delegation_records_summary.route_role);
    assert.equal(record.route_intent, body.execution_summary.collaboration_routing_summary.route_intent);
    assert.equal(record.route_mode, body.execution_summary.delegation_records_summary.record_mode);
    assert.equal(record.task_family, body.execution_summary.collaboration_routing_summary.task_family);
    assert.equal(record.family_scope, body.execution_summary.collaboration_routing_summary.family_scope);
  }
  assert.equal(
    body.execution_summary.instrumentation_summary.rehydration_candidate_count,
    (body.execution_kernel.action_packet_summary as any).rehydration_candidate_count,
  );
  assert.deepEqual(
    Object.keys(executionSummary.instrumentation_summary as Record<string, unknown>).sort(),
    EXECUTION_INSTRUMENTATION_SUMMARY_KEYS,
  );
  assert.deepEqual(body.execution_summary.action_packet_summary, body.execution_kernel.action_packet_summary);
  assert.deepEqual(body.execution_summary.workflow_signal_summary, body.execution_kernel.workflow_signal_summary);
  assert.deepEqual(body.execution_summary.workflow_lifecycle_summary, body.execution_kernel.workflow_lifecycle_summary);
  assert.deepEqual(body.execution_summary.workflow_maintenance_summary, body.execution_kernel.workflow_maintenance_summary);
  assert.deepEqual(body.execution_summary.distillation_signal_summary, body.execution_kernel.distillation_signal_summary);
  assert.deepEqual(body.execution_summary.pattern_lifecycle_summary, body.execution_kernel.pattern_lifecycle_summary);
  assert.deepEqual(body.execution_summary.pattern_maintenance_summary, body.execution_kernel.pattern_maintenance_summary);
  assert.deepEqual(body.execution_summary.policy_lifecycle_summary, body.execution_kernel.policy_lifecycle_summary);
  assert.deepEqual(body.execution_summary.policy_maintenance_summary, body.execution_kernel.policy_maintenance_summary);
  assert.deepEqual(body.execution_summary.continuity_carrier_summary, body.execution_kernel.continuity_carrier_summary);
  assert.deepEqual(body.execution_kernel.action_packet_summary, routeSummary.action_packet_summary);
  assert.deepEqual(body.execution_kernel.workflow_signal_summary, routeSummary.workflow_signal_summary);
  assert.deepEqual(body.execution_kernel.workflow_lifecycle_summary, routeSummary.workflow_lifecycle_summary);
  assert.deepEqual(body.execution_kernel.workflow_maintenance_summary, routeSummary.workflow_maintenance_summary);
  assert.deepEqual(body.execution_kernel.distillation_signal_summary, routeSummary.distillation_signal_summary);
  assert.deepEqual(body.execution_kernel.pattern_lifecycle_summary, routeSummary.pattern_lifecycle_summary);
  assert.deepEqual(body.execution_kernel.pattern_maintenance_summary, routeSummary.pattern_maintenance_summary);
  assert.deepEqual(body.execution_kernel.policy_lifecycle_summary, routeSummary.policy_lifecycle_summary);
  assert.deepEqual(body.execution_kernel.policy_maintenance_summary, routeSummary.policy_maintenance_summary);
  assert.deepEqual(body.execution_kernel.continuity_carrier_summary, routeSummary.continuity_carrier_summary);
  const signalOnlyPatternSummary = summarizePatternSignals({ pattern_signals: body.pattern_signals });
  assert.deepEqual(body.execution_kernel.pattern_signal_summary, {
    candidate_pattern_count: signalOnlyPatternSummary.candidate_pattern_count,
    candidate_pattern_tools: signalOnlyPatternSummary.candidate_pattern_tools,
    trusted_pattern_count: routeSummary.trusted_pattern_count,
    contested_pattern_count: routeSummary.contested_pattern_count,
    trusted_pattern_tools: routeSummary.trusted_pattern_tools,
    contested_pattern_tools: routeSummary.contested_pattern_tools,
  });
  assert.deepEqual(body.execution_summary.pattern_signal_summary, body.execution_kernel.pattern_signal_summary);
}

function assertDelegationLearningProjection(body: Record<string, unknown>, expected: {
  task_family: string | null;
  matched_records: number;
  truncated: boolean;
  route_role_counts: Record<string, number>;
  record_outcome_counts: Record<string, number>;
  recommendation_count: number;
  recommendation_kinds: string[];
}) {
  const layered = body.layered_context as Record<string, unknown>;
  const projection = layered.delegation_learning as Record<string, unknown>;
  assert.equal(projection.summary_version, "delegation_learning_projection_v1");
  assert.deepEqual(projection.learning_summary, {
    task_family: expected.task_family,
    matched_records: expected.matched_records,
    truncated: expected.truncated,
    route_role_counts: expected.route_role_counts,
    record_outcome_counts: expected.record_outcome_counts,
    recommendation_count: expected.recommendation_count,
  });
  assert.deepEqual(
    Array.isArray(projection.learning_recommendations)
      ? projection.learning_recommendations.map((entry) => (entry as Record<string, unknown>).recommendation_kind)
      : [],
    expected.recommendation_kinds,
  );
}

function assertOperatorDelegationLearningProjection(body: Record<string, unknown>, expected: {
  task_family: string | null;
  matched_records: number;
  truncated: boolean;
  route_role_counts: Record<string, number>;
  record_outcome_counts: Record<string, number>;
  recommendation_count: number;
  recommendation_kinds: string[];
}) {
  const operatorProjection = body.operator_projection as Record<string, unknown>;
  const projection = operatorProjection.delegation_learning as Record<string, unknown>;
  assert.equal(projection.summary_version, "delegation_learning_projection_v1");
  assert.deepEqual(projection.learning_summary, {
    task_family: expected.task_family,
    matched_records: expected.matched_records,
    truncated: expected.truncated,
    route_role_counts: expected.route_role_counts,
    record_outcome_counts: expected.record_outcome_counts,
    recommendation_count: expected.recommendation_count,
  });
  assert.deepEqual(
    Array.isArray(projection.learning_recommendations)
      ? projection.learning_recommendations.map((entry) => (entry as Record<string, unknown>).recommendation_kind)
      : [],
    expected.recommendation_kinds,
  );
}

function assertOperatorActionHintProjection(body: Record<string, unknown>, expected: {
  gate_action: string;
  instruction: string;
  tool_route: string | null;
  priority: string;
  contract_trust: string;
  selected_tool: string | null;
  file_path: string | null;
  task_family?: string | null;
  workflow_signature?: string | null;
  policy_memory_id?: string | null;
}) {
  const operatorProjection = body.operator_projection as Record<string, unknown>;
  const actionGate = operatorProjection.action_retrieval_gate as Record<string, unknown>;
  const actionHints = Array.isArray(operatorProjection.action_hints)
    ? operatorProjection.action_hints as Array<Record<string, unknown>>
    : [];
  assert.equal(actionGate.summary_version, "action_retrieval_gate_v1");
  assert.equal(actionGate.gate_action, expected.gate_action);
  assert.ok(actionHints.length >= 1);
  assert.equal(actionHints[0]?.summary_version, "context_operator_action_hint_v1");
  assert.equal(actionHints[0]?.action, expected.gate_action);
  assert.equal(actionHints[0]?.priority, expected.priority);
  assert.equal(actionHints[0]?.contract_trust, expected.contract_trust);
  assert.equal(actionHints[0]?.instruction, expected.instruction);
  assert.equal(actionHints[0]?.tool_route ?? null, expected.tool_route);
  assert.equal(actionHints[0]?.selected_tool ?? null, expected.selected_tool);
  assert.equal(actionHints[0]?.file_path ?? null, expected.file_path);
  if ("task_family" in expected) {
    assert.equal(actionHints[0]?.task_family ?? null, expected.task_family ?? null);
  }
  if ("workflow_signature" in expected) {
    assert.equal(actionHints[0]?.workflow_signature ?? null, expected.workflow_signature ?? null);
  }
  if ("policy_memory_id" in expected) {
    assert.equal(actionHints[0]?.policy_memory_id ?? null, expected.policy_memory_id ?? null);
  }
}

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-context-runtime-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildRequestGuards() {
  return createRequestGuards({
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: false,
      LITE_LOCAL_ACTOR_ID: "local-user",
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
      APP_ENV: "test",
      ADMIN_TOKEN: "",
      TRUST_PROXY: false,
      TRUSTED_PROXY_CIDRS: [],
      RATE_LIMIT_ENABLED: false,
      RATE_LIMIT_BYPASS_LOOPBACK: false,
      WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
      RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    } as any,
    embedder: FakeEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    sandboxWriteLimiter: null,
    sandboxReadLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

async function seedContextRuntimeFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const queryText = "repair export failure in node tests";
  const [sharedEmbedding] = await FakeEmbeddingProvider.embed([queryText]);
  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "repair-export-node-tests",
    workflow_signature: "fix-export-failure-workflow",
    summary: "Inspect failing test and patch export",
    tool_set: ["edit", "test"],
    outcome: {
      status: "success",
      result_class: "workflow_reuse",
      success_score: 0.91,
    },
    source: {
      source_kind: "playbook",
      node_id: randomUUID(),
      run_id: randomUUID(),
      playbook_id: randomUUID(),
    },
    payload_refs: {
      node_ids: [],
      decision_ids: [],
      run_ids: [],
      step_ids: [],
      commit_ids: [],
    },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: "medium",
      recommended_when: ["missing_log_detail"],
    },
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_workflow",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    workflow_promotion: {
      promotion_state: "stable",
      promotion_origin: "replay_promote",
      last_transition: "promoted_to_stable",
      last_transition_at: "2026-03-20T00:00:00Z",
      source_status: "active",
    },
    schema_version: "anchor_v1",
  });
  const patternAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    task_signature: "tools_select:repair-export",
    task_class: "tools_select_pattern",
    task_family: "task:repair_export",
    error_family: "error:node-export-mismatch",
    pattern_signature: "stable-edit-pattern",
    summary: "Stable pattern: prefer edit for export repair after repeated successful runs.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    outcome: {
      status: "success",
      result_class: "tool_selection_pattern_stable",
      success_score: 0.93,
    },
    source: {
      source_kind: "tool_decision",
      decision_id: randomUUID(),
    },
    payload_refs: {
      node_ids: [],
      decision_ids: [],
      run_ids: [randomUUID(), randomUUID()],
      step_ids: [],
      commit_ids: [],
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 2,
      reuse_failure_count: 0,
      distinct_run_count: 2,
      last_used_at: null,
    },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 0,
      counter_evidence_open: false,
      stable_at: new Date().toISOString(),
      last_validated_at: new Date().toISOString(),
      last_counter_evidence_at: null,
    },
    schema_version: "anchor_v1",
  });

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "seed context runtime planner packet contract fixture",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          id: randomUUID(),
          type: "procedure",
          title: "Fix export failure",
          text_summary: workflowAnchor.summary,
          slots: {
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            anchor_v1: workflowAnchor,
          },
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.9,
          importance: 0.9,
          confidence: 0.9,
        },
        {
          id: randomUUID(),
          type: "event",
          title: "Replay Episode: Fix export failure",
          text_summary: "Replay repair learning episode for export failure",
          slots: {
            summary_kind: "workflow_candidate",
            compression_layer: "L1",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_candidate",
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              task_signature: "repair-export-node-tests",
              workflow_signature: "replay-learning-candidate-export-fix",
              anchor_kind: "workflow",
              anchor_level: "L1",
              workflow_promotion: {
                promotion_state: "candidate",
                promotion_origin: "replay_learning_episode",
                required_observations: 2,
                observed_count: 1,
                last_transition: "candidate_observed",
                last_transition_at: "2026-03-20T00:00:00Z",
                source_status: null,
              },
              maintenance: {
                model: "lazy_online_v1",
                maintenance_state: "observe",
                offline_priority: "promote_candidate",
                lazy_update_fields: ["usage_count", "last_used_at"],
                last_maintenance_at: "2026-03-20T00:00:00Z",
              },
            },
          },
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.82,
          importance: 0.81,
          confidence: 0.78,
        },
        {
          id: randomUUID(),
          type: "event",
          title: "Replay Episode: Fix export failure",
          text_summary: "Replay repair learning episode for export failure",
          slots: {
            summary_kind: "workflow_candidate",
            compression_layer: "L1",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_candidate",
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              task_signature: "repair-export-node-tests",
              workflow_signature: "replay-learning-candidate-export-fix",
              anchor_kind: "workflow",
              anchor_level: "L1",
              workflow_promotion: {
                promotion_state: "candidate",
                promotion_origin: "replay_learning_episode",
                required_observations: 2,
                observed_count: 2,
                last_transition: "candidate_observed",
                last_transition_at: "2026-03-20T00:10:00Z",
                source_status: null,
              },
              maintenance: {
                model: "lazy_online_v1",
                maintenance_state: "observe",
                offline_priority: "promote_candidate",
                lazy_update_fields: ["usage_count", "last_used_at"],
                last_maintenance_at: "2026-03-20T00:10:00Z",
              },
            },
          },
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.83,
          importance: 0.82,
          confidence: 0.79,
        },
        {
          id: randomUUID(),
          type: "concept",
          title: "Stable edit pattern",
          text_summary: patternAnchor.summary,
          slots: {
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            anchor_v1: patternAnchor,
          },
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.85,
          importance: 0.88,
          confidence: 0.88,
        },
        {
          client_id: "rule:prefer-edit:repair-export",
          type: "rule",
          title: "Prefer edit for export repair",
          text_summary: "For repair_export tasks, prefer edit over the other tools.",
          slots: {
            if: {
              task_kind: { $eq: "repair_export" },
            },
            then: {
              tool: {
                prefer: ["edit"],
              },
            },
            exceptions: [],
            rule_scope: "global",
          },
        },
        {
          id: randomUUID(),
          type: "concept",
          title: "Exports often break on stale default export wiring",
          text_summary: "Generic export debugging note",
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.4,
          importance: 0.35,
          confidence: 0.42,
        },
      ],
      edges: [],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  const out = await liteWriteStore.withTx(() =>
    applyMemoryWrite({} as any, prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      shadowDualWriteEnabled: false,
      shadowDualWriteStrict: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );
  const ruleNodeId = out.nodes.find((node) => node.type === "rule")?.id;
  assert.ok(ruleNodeId);

  await liteWriteStore.withTx(() =>
    updateRuleState({} as any, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      rule_node_id: ruleNodeId,
      state: "active",
      input_text: "activate prefer edit rule",
    }, "default", "default", {
      liteWriteStore,
    }),
  );

  return { liteWriteStore, liteRecallStore };
}

async function seedPrivateWorkflowFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const queryText = "repair export failure in node tests";
  const [sharedEmbedding] = await FakeEmbeddingProvider.embed([queryText]);
  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "repair-export-node-tests",
    error_signature: "node-export-mismatch",
    workflow_signature: "private-export-fix-workflow",
    summary: "Inspect failing export test, patch the export, rerun the focused test.",
    tool_set: ["edit", "test"],
    outcome: {
      status: "success",
      result_class: "workflow_reuse",
      success_score: 0.93,
    },
    source: {
      source_kind: "playbook",
      node_id: randomUUID(),
      run_id: randomUUID(),
      playbook_id: randomUUID(),
    },
    payload_refs: {
      node_ids: [],
      decision_ids: [],
      run_ids: [],
      step_ids: [],
      commit_ids: [],
    },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: "medium",
      recommended_when: ["missing_log_detail"],
    },
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_workflow",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    workflow_promotion: {
      promotion_state: "stable",
      promotion_origin: "replay_promote",
      required_observations: 2,
      observed_count: 2,
      last_transition: "promoted_to_stable",
      last_transition_at: "2026-03-20T00:00:00Z",
      source_status: "active",
    },
    schema_version: "anchor_v1",
  });

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: "seed private workflow planning fixture",
      auto_embed: false,
      memory_lane: "private",
      nodes: [
        {
          id: randomUUID(),
          type: "procedure",
          title: "Fix export failure",
          text_summary: workflowAnchor.summary,
          text: queryText,
          slots: {
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            anchor_v1: workflowAnchor,
          },
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.9,
          importance: 0.9,
          confidence: 0.93,
        },
      ],
      edges: [],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  await liteWriteStore.withTx(() =>
    applyMemoryWrite({} as any, prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      shadowDualWriteEnabled: false,
      shadowDualWriteStrict: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  return { liteWriteStore, liteRecallStore };
}

async function seedExecutionNativeOnlyPrivateWorkflowFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const queryText = "repair export failure in node tests";
  const [sharedEmbedding] = await FakeEmbeddingProvider.embed([queryText]);

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: "seed execution-native-only private workflow planning fixture",
      auto_embed: false,
      memory_lane: "private",
      nodes: [
        {
          id: randomUUID(),
          type: "procedure",
          title: "Fix export failure",
          text_summary: "Reusable repair workflow for export failure",
          text: queryText,
          slots: {
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_anchor",
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              task_signature: "repair-export-node-tests",
              workflow_signature: "execution-native-only-export-fix",
              anchor_kind: "workflow",
              anchor_level: "L2",
              tool_set: ["edit", "test"],
              workflow_promotion: {
                promotion_state: "stable",
                promotion_origin: "replay_learning_auto_promotion",
                required_observations: 2,
                observed_count: 2,
                last_transition: "promoted_to_stable",
                last_transition_at: "2026-03-20T00:20:00Z",
                source_status: null,
              },
              maintenance: {
                model: "lazy_online_v1",
                maintenance_state: "retain",
                offline_priority: "retain_workflow",
                lazy_update_fields: ["usage_count", "last_used_at"],
                last_maintenance_at: "2026-03-20T00:20:00Z",
              },
            },
          },
          embedding: sharedEmbedding,
          embedding_model: FakeEmbeddingProvider.name,
          salience: 0.9,
          importance: 0.9,
          confidence: 0.93,
        },
      ],
      edges: [],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );

  await liteWriteStore.withTx(() =>
    applyMemoryWrite({} as any, prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      shadowDualWriteEnabled: false,
      shadowDualWriteStrict: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  return { liteWriteStore, liteRecallStore };
}

function registerContextRuntimeApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  const guards = buildRequestGuards();
  registerHostErrorHandler(args.app);
  registerMemoryAccessRoutes({
    app: args.app,
    env: {
      AIONIS_EDITION: "lite",
      APP_ENV: "test",
      MEMORY_SCOPE: "default",
      MEMORY_TENANT_ID: "default",
      LITE_LOCAL_ACTOR_ID: "local-user",
      MAX_TEXT_LEN: 10_000,
      PII_REDACTION: false,
      ALLOW_CROSS_SCOPE_EDGES: false,
      MEMORY_SHADOW_DUAL_WRITE_ENABLED: false,
      MEMORY_SHADOW_DUAL_WRITE_STRICT: false,
    } as any,
    embedder: null,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    writeAccessShadowMirrorV2: false,
    requireStoreFeatureCapability: () => {},
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
  registerMemoryContextRuntimeRoutes({
    app: args.app,
    env: {
      AIONIS_EDITION: "lite",
      APP_ENV: "test",
      MEMORY_SCOPE: "default",
      MEMORY_TENANT_ID: "default",
      LITE_LOCAL_ACTOR_ID: "local-user",
      MAX_TEXT_LEN: 10_000,
      PII_REDACTION: false,
      MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
      MEMORY_RECALL_STAGE1_EXACT_FALLBACK_ON_EMPTY: true,
      MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
      MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
      MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    } as any,
    embedder: FakeEmbeddingProvider,
    embeddedRuntime: null,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    recallTextEmbedBatcher: { stats: () => null },
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    enforceRecallTextEmbedQuota: guards.enforceRecallTextEmbedQuota,
    buildRecallAuth: guards.buildRecallAuth,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    hasExplicitRecallKnobs: () => false,
    resolveRecallProfile: () => ({ profile: "balanced", source: "test" }),
    resolveExplicitRecallMode: () => ({
      mode: null,
      profile: "balanced",
      defaults: {},
      applied: false,
      reason: "test_default",
      source: "test",
    }),
    resolveClassAwareRecallProfile: (_endpoint, _body, baseProfile) => ({
      profile: baseProfile,
      defaults: {},
      enabled: false,
      applied: false,
      reason: "test_default",
      source: "test",
      workload_class: null,
      signals: [],
    }),
    withRecallProfileDefaults: (body) => ({ ...(body as Record<string, unknown>) }),
    resolveRecallStrategy: () => ({
      strategy: "local",
      defaults: {},
      applied: false,
    }),
    resolveAdaptiveRecallProfile: (profile) => ({
      profile,
      defaults: {},
      applied: false,
      reason: "test_default",
    }),
    resolveAdaptiveRecallHardCap: () => ({
      defaults: {},
      applied: false,
      reason: "test_default",
    }),
    inferRecallStrategyFromKnobs: () => "local",
    buildRecallTrajectory: () => ({ strategy: "local" }),
    embedRecallTextQuery: async (provider, queryText) => {
      const [vec] = await provider.embed([queryText]);
      return {
        vec,
        ms: 0,
        cache_hit: false,
        singleflight_join: false,
        queue_wait_ms: 0,
        batch_size: 1,
      };
    },
    mapRecallTextEmbeddingError: () => ({
      statusCode: 500,
      code: "embed_failed",
      message: "embedding failed",
    }),
    recordContextAssemblyTelemetryBestEffort: async () => {},
  });
}

test("planning_context returns aligned planner packet, action packet summary, and planner explanation", async () => {
  const dbPath = tmpDbPath("planning-context");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json());
    assertNoStalePlannerMirrors(body as Record<string, unknown>);
    assert.ok(!("layered_context" in (body as Record<string, unknown>)), "default planning_context should not expose layered_context");
    assert.ok(!("operator_projection" in (body as Record<string, unknown>)), "default planning_context should not expose operator_projection");
    const planningFirstStep = body.planning_summary.first_step_recommendation;
    assert.equal(planningFirstStep?.source_kind, "experience_intelligence");
    assert.equal(planningFirstStep?.history_applied, true);
    assert.equal(planningFirstStep?.contract_trust, "advisory");
    assert.equal(planningFirstStep?.selected_tool, body.planning_summary.selected_tool);
    assert.equal(planningFirstStep?.task_family ?? null, null);
    assert.equal(planningFirstStep?.workflow_signature, "fix-export-failure-workflow");
    assert.equal(planningFirstStep?.policy_memory_id ?? null, null);
    assert.equal(planningFirstStep?.file_path ?? null, null);
    assert.equal(planningFirstStep?.next_action, "Inspect the current context before starting with edit.");
    assert.equal(planningFirstStep?.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(planningFirstStep?.execution_contract_v1?.selected_tool, body.planning_summary.selected_tool);
    assert.equal(planningFirstStep?.execution_contract_v1?.workflow_signature, "fix-export-failure-workflow");
    assert.equal(body.planning_summary.action_retrieval_uncertainty?.summary_version, "action_retrieval_uncertainty_v1");
    assert.ok(body.planning_summary.action_retrieval_uncertainty?.recommended_actions.includes("inspect_context"));
    const planningActionRetrievalGate = body.planning_summary.action_retrieval_gate;
    assert.ok(planningActionRetrievalGate);
    assert.deepEqual(planningActionRetrievalGate, {
      summary_version: "action_retrieval_gate_v1",
      gate_action: "inspect_context",
      escalates_task_start: true,
      confidence: body.planning_summary.action_retrieval_uncertainty?.confidence ?? 0,
      primary_reason: body.planning_summary.action_retrieval_uncertainty?.reasons?.[0] ?? null,
      recommended_actions: ["inspect_context"],
      instruction: "Inspect the current context before starting with edit.",
      rehydration_candidate_count: body.planning_summary.action_packet_summary.rehydration_candidate_count,
      preferred_rehydration: null,
    });
    assert.deepEqual(
      ActionRetrievalGateSummarySchema.parse(planningActionRetrievalGate),
      planningActionRetrievalGate,
    );
    assert.throws(() =>
      ActionRetrievalGateSummarySchema.parse({
        ...planningActionRetrievalGate,
        debug_passthrough: true,
      }),
    );
    assert.ok(!("first_step_recommendation" in body), "default planning_context should not expose the stale top-level first_step_recommendation mirror");
    assert.deepEqual(body.kickoff_recommendation, body.planning_summary.first_step_recommendation);
    assertActionPacketSummaryMatchesPacket(body.planning_summary.action_packet_summary, body);
    assertActionPacketSummaryMatchesPacket(body.execution_kernel.action_packet_summary, body);
    assertKernelMatchesRouteSurface(body);
    assert.equal(body.planner_packet.packet_version, "planner_packet_v1");
    assert.equal(body.planner_packet.sections.recommended_workflows.length, 1);
    assert.equal(body.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(body.workflow_signals.length, 2);
    assert.equal(body.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(body.planning_summary.action_packet_summary.candidate_workflow_count, 1);
    assert.equal(body.execution_kernel.action_packet_summary.candidate_workflow_count, 1);
    assert.equal(body.planner_packet.sections.candidate_patterns.length, body.planning_summary.action_packet_summary.candidate_pattern_count);
    assert.equal(body.planner_packet.sections.trusted_patterns.length, 1);
    assert.equal(body.planner_packet.sections.contested_patterns.length, body.planning_summary.action_packet_summary.contested_pattern_count);
    assert.ok(body.planner_packet.sections.rehydration_candidates.length >= 1);
    assert.ok(body.planner_packet.sections.supporting_knowledge.length >= 1);
    assert.equal(body.planning_summary.action_packet_summary.recommended_workflow_count, 1);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.stable_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.replay_source_count, 2);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.rehydration_ready_count, 1);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.promotion_ready_count, 1);
    assert.equal(body.planning_summary.workflow_signal_summary.stable_workflow_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.planning_summary.workflow_signal_summary.observing_workflow_count, 0);
    assert.equal(body.planning_summary.workflow_signal_summary.promotion_ready_workflow_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.transition_counts.candidate_observed, 1);
    assert.equal(body.planning_summary.workflow_lifecycle_summary.transition_counts.promoted_to_stable, 1);
    assert.equal(body.planning_summary.workflow_maintenance_summary.observe_count, 1);
    assert.equal(body.planning_summary.workflow_maintenance_summary.retain_count, 1);
    assert.equal(body.planning_summary.workflow_maintenance_summary.promote_candidate_count, 1);
    assert.equal(body.planning_summary.workflow_maintenance_summary.retain_workflow_count, 1);
    assert.equal(body.planning_summary.action_packet_summary.candidate_pattern_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.planning_summary.action_packet_summary.trusted_pattern_count, 1);
    assert.equal(body.planning_summary.action_packet_summary.rehydration_candidate_count, body.planner_packet.sections.rehydration_candidates.length);
    assert.equal(body.planning_summary.action_packet_summary.supporting_knowledge_count, body.planner_packet.sections.supporting_knowledge.length);
    assert.equal(body.execution_kernel.action_packet_summary.recommended_workflow_count, 1);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.stable_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.promotion_ready_count, 1);
    assert.equal(body.execution_kernel.workflow_signal_summary.stable_workflow_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.execution_kernel.workflow_signal_summary.observing_workflow_count, 0);
    assert.equal(body.execution_kernel.workflow_signal_summary.promotion_ready_workflow_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.transition_counts.candidate_observed, 1);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.transition_counts.promoted_to_stable, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.observe_count, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.retain_count, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.promote_candidate_count, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.retain_workflow_count, 1);
    assert.equal(body.execution_kernel.action_packet_summary.candidate_pattern_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.action_packet_summary.trusted_pattern_count, 1);
    assert.equal(body.execution_kernel.action_packet_summary.rehydration_candidate_count, body.planner_packet.sections.rehydration_candidates.length);
    assert.equal(body.execution_kernel.action_packet_summary.supporting_knowledge_count, body.planner_packet.sections.supporting_knowledge.length);
    assert.equal(body.execution_kernel.pattern_signal_summary.trusted_pattern_count, 1);
    assert.equal(body.execution_kernel.pattern_signal_summary.candidate_pattern_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.pattern_signal_summary.contested_pattern_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.planning_summary.pattern_lifecycle_summary.trusted_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.planning_summary.pattern_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.planning_summary.pattern_lifecycle_summary.contested_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.planning_summary.pattern_maintenance_summary.retain_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.planning_summary.pattern_maintenance_summary.observe_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.planning_summary.pattern_maintenance_summary.review_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.execution_kernel.pattern_lifecycle_summary.trusted_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.execution_kernel.pattern_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.pattern_lifecycle_summary.contested_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.execution_kernel.pattern_maintenance_summary.retain_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.execution_kernel.pattern_maintenance_summary.observe_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.pattern_maintenance_summary.review_count, body.planner_packet.sections.contested_patterns.length);
    assert.match(body.planning_summary.planner_explanation, /workflow guidance: Fix export failure/);
    assert.match(body.planning_summary.planner_explanation, /promotion-ready workflow candidates: Replay Episode: Fix export failure/);
    assert.match(body.planning_summary.planner_explanation, /selected tool: edit/);
    assert.match(body.planning_summary.planner_explanation, /trusted patterns available but not used: edit/);
    assert.match(body.planning_summary.planner_explanation, /rehydration available: Fix export failure/);
    assert.match(body.planning_summary.planner_explanation, new RegExp(`supporting knowledge appended: ${body.planner_packet.sections.supporting_knowledge.length}`));
    assert.equal(body.tools.selection_summary.provenance_explanation, "selected tool: edit; candidate patterns visible but not yet trusted: edit");
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning_context applies runtime entropy recall defaults when recall knobs are not explicit", async () => {
  const dbPath = tmpDbPath("planning-context-entropy-defaults");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
        },
        tool_candidates: ["bash", "edit", "test"],
        runtime_entropy_controls: runtimeEntropyControlsFixture(),
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json());
    const entropyDefaults = (body.recall as Record<string, any>).observability?.adaptive?.runtime_entropy_defaults;
    assert.equal(entropyDefaults?.applied, true);
    assert.equal(entropyDefaults?.reason, "applied");
    assert.equal(entropyDefaults?.recall_breadth, "wide");
    assert.equal(entropyDefaults?.defaults?.limit, 20);
    assert.equal(entropyDefaults?.defaults?.ranked_limit, 160);
    assert.equal(entropyDefaults?.defaults?.max_nodes, 160);
    assert.equal(entropyDefaults?.defaults?.max_edges, 100);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning_context prefers persisted delegation records matched by run_id", async () => {
  const dbPath = tmpDbPath("planning-context-persisted-delegation-records");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  const runId = randomUUID();
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const writeResponse = await app.inject({
      method: "POST",
      url: "/v1/memory/delegation/records",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "review-worker",
        run_id: runId,
        route_role: "review",
        task_family: "task:repair_export",
        delegation_records_v1: {
          summary_version: "execution_delegation_records_v1",
          record_mode: "packet_backed",
          route_role: "review",
          packet_count: 1,
          return_count: 1,
          artifact_routing_count: 2,
          missing_record_types: [],
          delegation_packets: [
            {
              version: 1,
              role: "review",
              mission: "Review the export patch, confirm the API stays stable, and rerun export tests.",
              working_set: ["src/routes/export.ts", "src/lib/export.ts"],
              acceptance_checks: ["npm run -s test:lite -- export", "npm run -s lint"],
              output_contract: "Return review status with exact acceptance check outcomes.",
              preferred_artifact_refs: ["artifact://patch/export.diff"],
              inherited_evidence: ["evidence://tests/export.log"],
              routing_reason: "Persisted from the review handoff for the same run.",
              task_family: "task:repair_export",
              family_scope: "default",
              source_mode: "packet_backed",
            },
          ],
          delegation_returns: [
            {
              version: 1,
              role: "review",
              status: "completed",
              summary: "Reviewer confirmed the export patch and validation results.",
              evidence: ["evidence://tests/export.log"],
              working_set: ["src/routes/export.ts", "src/lib/export.ts"],
              acceptance_checks: ["npm run -s test:lite -- export", "npm run -s lint"],
              source_mode: "packet_backed",
            },
          ],
          artifact_routing_records: [
            {
              version: 1,
              ref: "artifact://patch/export.diff",
              ref_kind: "artifact",
              route_role: "review",
              route_intent: "review",
              route_mode: "packet_backed",
              task_family: "task:repair_export",
              family_scope: "default",
              routing_reason: "Carry the patch diff into the review step.",
              source: "execution_packet",
            },
            {
              version: 1,
              ref: "evidence://tests/export.log",
              ref_kind: "evidence",
              route_role: "review",
              route_intent: "review",
              route_mode: "packet_backed",
              task_family: "task:repair_export",
              family_scope: "default",
              routing_reason: "Carry the validation evidence into the review step.",
              source: "execution_packet",
            },
          ],
        },
      },
    });
    assert.equal(writeResponse.statusCode, 200);
    const writeBody = DelegationRecordsWriteResponseSchema.parse(writeResponse.json());
    assert.equal(writeBody.record_event?.run_id, runId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json());
    assertDelegationRecordsExactKeySurface(body.execution_summary.delegation_records_summary);
    assert.equal(body.execution_summary.delegation_records_summary.record_mode, "packet_backed");
    assert.equal(body.execution_summary.delegation_records_summary.route_role, "review");
    assert.equal(body.execution_summary.delegation_records_summary.packet_count, 1);
    assert.equal(body.execution_summary.delegation_records_summary.return_count, 1);
    assert.deepEqual(body.execution_summary.delegation_records_summary.missing_record_types, []);
    assert.equal(
      body.execution_summary.delegation_records_summary.delegation_returns[0]?.summary,
      "Reviewer confirmed the export patch and validation results.",
    );
    assert.deepEqual(
      body.execution_summary.delegation_records_summary.delegation_packets[0]?.preferred_artifact_refs,
      ["artifact://patch/export.diff"],
    );
    assert.deepEqual(
      body.execution_summary.delegation_records_summary.artifact_routing_records.map((record) => record.ref),
      ["artifact://patch/export.diff", "evidence://tests/export.log"],
    );
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning_context debug layered_context projects delegation learning without widening the default surface", async () => {
  const dbPath = tmpDbPath("planning-context-delegation-learning-debug");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });

    for (const payload of [
      {
        tenant_id: "default",
        scope: "default",
        run_id: "run:context-export-001",
        route_role: "patch",
        task_family: "task:repair_export",
        delegation_records_v1: {
          summary_version: "execution_delegation_records_v1",
          record_mode: "packet_backed",
          route_role: "patch",
          packet_count: 1,
          return_count: 1,
          artifact_routing_count: 2,
          missing_record_types: [],
          delegation_packets: [{
            version: 1,
            role: "patch",
            mission: "Apply the export repair patch and rerun node tests.",
            working_set: ["src/routes/export.ts"],
            acceptance_checks: ["npm run -s test:lite -- export"],
            output_contract: "Return patch result and final node test status.",
            preferred_artifact_refs: ["artifact://repair-export/patch"],
            inherited_evidence: ["evidence://repair-export/failure"],
            routing_reason: "repair patch route",
            task_family: "task:repair_export",
            family_scope: "aionis://runtime/repair-export",
            source_mode: "packet_backed",
          }],
          delegation_returns: [{
            version: 1,
            role: "patch",
            status: "passed",
            summary: "Patch applied and export tests passed.",
            evidence: ["evidence://repair-export/test"],
            working_set: ["src/routes/export.ts"],
            acceptance_checks: ["npm run -s test:lite -- export"],
            source_mode: "packet_backed",
          }],
          artifact_routing_records: [{
            version: 1,
            ref: "artifact://repair-export/patch",
            ref_kind: "artifact",
            route_role: "patch",
            route_intent: "patch",
            route_mode: "packet_backed",
            task_family: "task:repair_export",
            family_scope: "aionis://runtime/repair-export",
            routing_reason: "patch artifact route",
            source: "execution_packet",
          }, {
            version: 1,
            ref: "evidence://repair-export/test",
            ref_kind: "evidence",
            route_role: "patch",
            route_intent: "patch",
            route_mode: "packet_backed",
            task_family: "task:repair_export",
            family_scope: "aionis://runtime/repair-export",
            routing_reason: "patch evidence route",
            source: "execution_packet",
          }],
        },
        execution_result_summary: {
          status: "passed",
          summary: "Patch applied and export tests passed.",
        },
        execution_artifacts: [{ ref: "artifact://repair-export/patch" }],
        execution_evidence: [{ ref: "evidence://repair-export/test" }],
      },
      {
        tenant_id: "default",
        scope: "default",
        memory_lane: "private",
        run_id: "run:context-export-002",
        route_role: "patch",
        task_family: "task:repair_export",
        delegation_records_v1: {
          summary_version: "execution_delegation_records_v1",
          record_mode: "memory_only",
          route_role: "patch",
          packet_count: 1,
          return_count: 0,
          artifact_routing_count: 1,
          missing_record_types: ["delegation_returns"],
          delegation_packets: [{
            version: 1,
            role: "patch",
            mission: "Apply the export fallback patch before retrying tests.",
            working_set: ["src/routes/export.ts"],
            acceptance_checks: ["npm run -s test:lite -- export"],
            output_contract: "Return applied patch metadata.",
            preferred_artifact_refs: ["artifact://repair-export/fallback-patch"],
            inherited_evidence: [],
            routing_reason: "fallback memory patch route",
            task_family: "task:repair_export",
            family_scope: "aionis://runtime/repair-export",
            source_mode: "memory_only",
          }],
          delegation_returns: [],
          artifact_routing_records: [{
            version: 1,
            ref: "artifact://repair-export/fallback-patch",
            ref_kind: "artifact",
            route_role: "patch",
            route_intent: "memory_guided",
            route_mode: "memory_only",
            task_family: "task:repair_export",
            family_scope: "aionis://runtime/repair-export",
            routing_reason: "memory-guided patch route",
            source: "strategy_summary",
          }],
        },
      },
    ]) {
      const writeResponse = await app.inject({
        method: "POST",
        url: "/v1/memory/delegation/records",
        payload,
      });
      assert.equal(writeResponse.statusCode, 200, writeResponse.body);
    }

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        return_layered_context: true,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json()) as Record<string, unknown>;
    assert.ok("layered_context" in body);
    assert.ok("operator_projection" in body);
    assert.ok(!("first_step_recommendation" in body), "debug planning_context should still avoid the stale top-level first_step_recommendation mirror");
    assertDelegationLearningProjection(body, {
      task_family: "task:repair_export",
      matched_records: 2,
      truncated: false,
      route_role_counts: {
        patch: 2,
      },
      record_outcome_counts: {
        completed: 1,
        missing_return: 1,
      },
      recommendation_count: 3,
      recommendation_kinds: ["capture_missing_returns", "increase_artifact_capture", "promote_reusable_pattern"],
    });
    assertOperatorDelegationLearningProjection(body, {
      task_family: "task:repair_export",
      matched_records: 2,
      truncated: false,
      route_role_counts: {
        patch: 2,
      },
      record_outcome_counts: {
        completed: 1,
        missing_return: 1,
      },
      recommendation_count: 3,
      recommendation_kinds: ["capture_missing_returns", "increase_artifact_capture", "promote_reusable_pattern"],
    });
    assertOperatorActionHintProjection(body, {
      gate_action: "inspect_context",
      instruction: "Inspect the current context before starting with edit.",
      tool_route: null,
      priority: "recommended",
      contract_trust: "advisory",
      selected_tool: "edit",
      file_path: null,
      task_family: null,
      workflow_signature: "fix-export-failure-workflow",
      policy_memory_id: null,
    });
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning_context surfaces collaboration summary from execution packet and side outputs", async () => {
  const dbPath = tmpDbPath("planning-context-collaboration");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        execution_artifacts: [
          {
            ref: "artifact://patch/export.diff",
            kind: "patch",
            label: "export diff",
          },
        ],
        execution_evidence: [
          {
            uri: "evidence://tests/export.log",
            kind: "test_log",
            label: "export test log",
          },
        ],
        execution_packet_v1: {
          version: 1,
          state_id: "packet-review-1",
          current_stage: "review",
          active_role: "review",
          task_brief: "Review export repair and rerun tests",
          target_files: ["src/routes/export.ts", "src/lib/export.ts"],
          next_action: "Review the export patch and rerun export tests",
          hard_constraints: ["keep public export API stable"],
          accepted_facts: ["accepted_hypothesis:export path mismatch"],
          rejected_paths: ["reject broad refactor"],
          pending_validations: ["npm run -s test:lite -- export"],
          unresolved_blockers: ["needs reviewer sign-off"],
          rollback_notes: ["revert export helper if tests regress"],
          review_contract: {
            standard: "review_contract_v1",
            required_outputs: ["patch", "tests"],
            acceptance_checks: ["npm run -s test:lite -- export", "npm run -s lint"],
            rollback_required: true,
          },
          resume_anchor: {
            anchor: "resume:src/routes/export.ts",
            file_path: "src/routes/export.ts",
            symbol: null,
            repo_root: "/Volumes/ziel/AionisRuntime",
          },
          artifact_refs: ["artifact://patch/export.diff", "artifact://notes/export-review.md"],
          evidence_refs: ["evidence://tests/export.log"],
        },
        include_shadow: false,
        rules_limit: 20,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json());
    assert.equal(body.execution_summary.collaboration_summary.summary_version, "execution_collaboration_summary_v1");
    assert.equal(body.execution_summary.collaboration_summary.packet_present, true);
    assert.equal(body.execution_summary.collaboration_summary.coordination_mode, "reviewer_ready");
    assert.equal(body.execution_summary.collaboration_summary.current_stage, "review");
    assert.equal(body.execution_summary.collaboration_summary.active_role, "review");
    assert.equal(
      body.execution_summary.collaboration_summary.next_action,
      "Review the export patch and rerun export tests",
    );
    assert.equal(body.execution_summary.collaboration_summary.target_file_count, 2);
    assert.equal(body.execution_summary.collaboration_summary.pending_validation_count, 1);
    assert.equal(body.execution_summary.collaboration_summary.unresolved_blocker_count, 1);
    assert.equal(body.execution_summary.collaboration_summary.review_contract_present, true);
    assert.equal(body.execution_summary.collaboration_summary.review_standard, "review_contract_v1");
    assert.equal(body.execution_summary.collaboration_summary.acceptance_check_count, 2);
    assert.equal(body.execution_summary.collaboration_summary.rollback_required, true);
    assert.equal(body.execution_summary.collaboration_summary.resume_anchor_present, true);
    assert.equal(body.execution_summary.collaboration_summary.resume_anchor_file_path, "src/routes/export.ts");
    assert.equal(body.execution_summary.collaboration_summary.artifact_ref_count, 2);
    assert.equal(body.execution_summary.collaboration_summary.evidence_ref_count, 1);
    assert.equal(body.execution_summary.collaboration_summary.side_output_artifact_count, 1);
    assert.equal(body.execution_summary.collaboration_summary.side_output_evidence_count, 1);
    assert.deepEqual(body.execution_summary.collaboration_summary.artifact_refs, [
      "artifact://patch/export.diff",
      "artifact://notes/export-review.md",
    ]);
    assert.deepEqual(body.execution_summary.collaboration_summary.evidence_refs, [
      "evidence://tests/export.log",
    ]);
    assert.equal(
      body.execution_summary.collaboration_routing_summary.summary_version,
      "execution_collaboration_routing_v1",
    );
    assert.equal(body.execution_summary.collaboration_routing_summary.route_mode, "packet_backed");
    assert.equal(body.execution_summary.collaboration_routing_summary.coordination_mode, "reviewer_ready");
    assert.equal(body.execution_summary.collaboration_routing_summary.route_intent, "review");
    assert.equal(
      body.execution_summary.collaboration_routing_summary.task_brief,
      "Review export repair and rerun tests",
    );
    assert.equal(body.execution_summary.collaboration_routing_summary.current_stage, "review");
    assert.equal(body.execution_summary.collaboration_routing_summary.active_role, "review");
    assert.equal(body.execution_summary.collaboration_routing_summary.selected_tool, "edit");
    assert.equal(
      body.execution_summary.collaboration_routing_summary.task_family,
      body.execution_summary.routing_signal_summary.task_family,
    );
    assert.equal(
      body.execution_summary.collaboration_routing_summary.family_scope,
      body.execution_summary.routing_signal_summary.family_scope,
    );
    assert.equal(
      body.execution_summary.collaboration_routing_summary.next_action,
      "Review the export patch and rerun export tests",
    );
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.target_files, [
      "src/routes/export.ts",
      "src/lib/export.ts",
    ]);
    assert.ok(
      body.execution_summary.collaboration_routing_summary.validation_paths.includes("npm run -s test:lite -- export"),
    );
    assert.ok(body.execution_summary.collaboration_routing_summary.validation_paths.length >= 2);
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.unresolved_blockers, [
      "needs reviewer sign-off",
    ]);
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.hard_constraints, [
      "keep public export API stable",
    ]);
    assert.equal(body.execution_summary.collaboration_routing_summary.review_standard, "review_contract_v1");
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.required_outputs, [
      "patch",
      "tests",
    ]);
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.acceptance_checks, [
      "npm run -s test:lite -- export",
      "npm run -s lint",
    ]);
    assert.ok(
      body.execution_summary.collaboration_routing_summary.preferred_artifact_refs.includes("artifact://patch/export.diff"),
    );
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.preferred_evidence_refs, [
      "evidence://tests/export.log",
    ]);
    for (const driver of [
      "review_contract",
      "rollback_required",
      "resume_anchor",
      "target_files",
      "validation_paths",
      "unresolved_blockers",
      "hard_constraints",
      "artifact_preference",
      "evidence_preference",
      "selected_tool:edit",
      `family_scope:${body.execution_summary.routing_signal_summary.family_scope}`,
    ]) {
      assert.ok(body.execution_summary.collaboration_routing_summary.routing_drivers.includes(driver));
    }
    if (body.execution_summary.routing_signal_summary.task_family) {
      assert.ok(
        body.execution_summary.collaboration_routing_summary.routing_drivers.includes(
          `task_family:${body.execution_summary.routing_signal_summary.task_family}`,
        ),
      );
    }
    assert.equal(
      body.execution_summary.delegation_records_summary.summary_version,
      "execution_delegation_records_v1",
    );
    assertDelegationRecordsExactKeySurface(body.execution_summary.delegation_records_summary);
    assert.equal(body.execution_summary.delegation_records_summary.record_mode, "packet_backed");
    assert.equal(body.execution_summary.delegation_records_summary.route_role, "review");
    assert.equal(body.execution_summary.delegation_records_summary.packet_count, 1);
    assert.equal(body.execution_summary.delegation_records_summary.return_count, 0);
    assert.ok(body.execution_summary.delegation_records_summary.missing_record_types.includes("delegation_returns"));
    const packetRecord = body.execution_summary.delegation_records_summary.delegation_packets[0];
    assert.equal(packetRecord.role, "review");
    assert.match(packetRecord.mission, /Review export repair and rerun tests/);
    assert.match(packetRecord.mission, /Review the export patch and rerun export tests/);
    assert.ok(packetRecord.working_set.includes("src/routes/export.ts"));
    assert.ok(packetRecord.working_set.includes("src/lib/export.ts"));
    assert.ok(packetRecord.acceptance_checks.includes("npm run -s test:lite -- export"));
    assert.ok(packetRecord.acceptance_checks.includes("npm run -s lint"));
    assert.ok(packetRecord.acceptance_checks.length >= 2);
    assert.equal(
      packetRecord.output_contract,
      "Satisfy review_contract_v1 and return the required outputs with exact validation status.",
    );
    assert.ok(packetRecord.preferred_artifact_refs.includes("artifact://patch/export.diff"));
    assert.deepEqual(packetRecord.inherited_evidence, ["evidence://tests/export.log"]);
    assert.equal(packetRecord.task_family, body.execution_summary.routing_signal_summary.task_family);
    assert.equal(packetRecord.family_scope, body.execution_summary.routing_signal_summary.family_scope);
    assert.match(packetRecord.routing_reason, /review_contract/);
    assert.equal(packetRecord.source_mode, "packet_backed");
    const packetArtifactRecord = body.execution_summary.delegation_records_summary.artifact_routing_records.find(
      (record) => record.ref === "artifact://patch/export.diff",
    );
    assert.ok(packetArtifactRecord);
    assert.equal(packetArtifactRecord?.ref_kind, "artifact");
    assert.equal(packetArtifactRecord?.route_role, "review");
    assert.equal(packetArtifactRecord?.route_intent, "review");
    assert.equal(packetArtifactRecord?.route_mode, "packet_backed");
    assert.equal(packetArtifactRecord?.source, "execution_packet");
    const packetEvidenceRecord = body.execution_summary.delegation_records_summary.artifact_routing_records.find(
      (record) => record.ref === "evidence://tests/export.log",
    );
    assert.ok(packetEvidenceRecord);
    assert.equal(packetEvidenceRecord?.ref_kind, "evidence");
    assert.equal(packetEvidenceRecord?.source, "execution_packet");
    assert.equal(body.execution_summary.continuity_snapshot_summary.summary_version, "execution_continuity_snapshot_v1");
    assert.equal(body.execution_summary.continuity_snapshot_summary.snapshot_mode, "packet_backed");
    assert.equal(body.execution_summary.continuity_snapshot_summary.coordination_mode, "reviewer_ready");
    assert.equal(body.execution_summary.continuity_snapshot_summary.current_stage, "review");
    assert.equal(body.execution_summary.continuity_snapshot_summary.active_role, "review");
    assert.equal(
      body.execution_summary.continuity_snapshot_summary.next_action,
      "Review the export patch and rerun export tests",
    );
    assert.equal(body.execution_summary.continuity_snapshot_summary.reviewer_ready, true);
    assert.equal(body.execution_summary.continuity_snapshot_summary.resume_anchor_file_path, "src/routes/export.ts");
    assert.ok(
      body.execution_summary.continuity_snapshot_summary.working_set.includes("resume:src/routes/export.ts"),
    );
    assert.ok(
      body.execution_summary.continuity_snapshot_summary.preferred_artifact_refs.includes("artifact://patch/export.diff"),
    );
    assert.deepEqual(body.execution_summary.continuity_snapshot_summary.preferred_evidence_refs, [
      "evidence://tests/export.log",
    ]);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning_context defaults the local consumer identity so private workflow anchors are recallable", async () => {
  const dbPath = tmpDbPath("planning-context-private-workflow");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedPrivateWorkflowFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json());
    assert.equal(body.planner_packet.sections.recommended_workflows.length, 1);
    assert.equal(body.workflow_signals.length, 1);
    assert.equal(body.workflow_signals[0]?.promotion_state, "stable");
    assert.match(body.planning_summary.planner_explanation, /workflow guidance: Fix export failure/);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning_context recommended workflow lines keep source and tools for execution-native-only workflows", async () => {
  const dbPath = tmpDbPath("planning-context-execution-native-only-workflow");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedExecutionNativeOnlyPrivateWorkflowFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(response.json());
    assert.equal(body.planner_packet.sections.recommended_workflows.length, 1);
    assert.match(body.planner_packet.sections.recommended_workflows[0] ?? "", /source=playbook/);
    assert.match(body.planner_packet.sections.recommended_workflows[0] ?? "", /tools=edit, test/);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("context_assemble returns aligned planner packet, assembly summary, and execution kernel packet summary", async () => {
  const dbPath = tmpDbPath("context-assemble");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/context/assemble",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        include_rules: true,
        include_shadow: false,
        rules_limit: 20,
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(response.statusCode, 200);
    const body = ContextAssembleRouteContractSchema.parse(response.json());
    assertNoStalePlannerMirrors(body as Record<string, unknown>);
    assert.ok(!("layered_context" in (body as Record<string, unknown>)), "default context_assemble should not expose layered_context");
    assert.ok(!("operator_projection" in (body as Record<string, unknown>)), "default context_assemble should not expose operator_projection");
    const assemblyFirstStep = body.assembly_summary.first_step_recommendation;
    assert.equal(assemblyFirstStep?.source_kind, "experience_intelligence");
    assert.equal(assemblyFirstStep?.history_applied, true);
    assert.equal(assemblyFirstStep?.contract_trust, "advisory");
    assert.equal(assemblyFirstStep?.selected_tool, body.assembly_summary.selected_tool);
    assert.equal(assemblyFirstStep?.task_family ?? null, null);
    assert.equal(assemblyFirstStep?.workflow_signature, "fix-export-failure-workflow");
    assert.equal(assemblyFirstStep?.policy_memory_id ?? null, null);
    assert.equal(assemblyFirstStep?.file_path ?? null, null);
    assert.equal(assemblyFirstStep?.next_action, "Inspect the current context before starting with edit.");
    assert.equal(assemblyFirstStep?.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(assemblyFirstStep?.execution_contract_v1?.selected_tool, body.assembly_summary.selected_tool);
    assert.equal(assemblyFirstStep?.execution_contract_v1?.workflow_signature, "fix-export-failure-workflow");
    assert.equal(body.assembly_summary.action_retrieval_uncertainty?.summary_version, "action_retrieval_uncertainty_v1");
    assert.ok(body.assembly_summary.action_retrieval_uncertainty?.recommended_actions.includes("inspect_context"));
    const assemblyActionRetrievalGate = body.assembly_summary.action_retrieval_gate;
    assert.ok(assemblyActionRetrievalGate);
    assert.deepEqual(assemblyActionRetrievalGate, {
      summary_version: "action_retrieval_gate_v1",
      gate_action: "inspect_context",
      escalates_task_start: true,
      confidence: body.assembly_summary.action_retrieval_uncertainty?.confidence ?? 0,
      primary_reason: body.assembly_summary.action_retrieval_uncertainty?.reasons?.[0] ?? null,
      recommended_actions: ["inspect_context"],
      instruction: "Inspect the current context before starting with edit.",
      rehydration_candidate_count: body.assembly_summary.action_packet_summary.rehydration_candidate_count,
      preferred_rehydration: null,
    });
    assert.deepEqual(
      ActionRetrievalGateSummarySchema.parse(assemblyActionRetrievalGate),
      assemblyActionRetrievalGate,
    );
    assert.throws(() =>
      ActionRetrievalGateSummarySchema.parse({
        ...assemblyActionRetrievalGate,
        debug_passthrough: true,
      }),
    );
    assert.ok(!("first_step_recommendation" in body), "default context_assemble should not expose the stale top-level first_step_recommendation mirror");
    assert.deepEqual(body.kickoff_recommendation, body.assembly_summary.first_step_recommendation);
    assertActionPacketSummaryMatchesPacket(body.assembly_summary.action_packet_summary, body);
    assertActionPacketSummaryMatchesPacket(body.execution_kernel.action_packet_summary, body);
    assertKernelMatchesRouteSurface(body);
    assert.equal(body.planner_packet.packet_version, "planner_packet_v1");
    assert.deepEqual(body.planner_packet.sections.recommended_workflows.length, 1);
    assert.deepEqual(body.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(body.workflow_signals.length, 2);
    assert.equal(body.planner_packet.sections.candidate_patterns.length, body.assembly_summary.action_packet_summary.candidate_pattern_count);
    assert.deepEqual(body.planner_packet.sections.trusted_patterns.length, 1);
    assert.equal(body.assembly_summary.action_packet_summary.recommended_workflow_count, 1);
    assert.equal(body.assembly_summary.action_packet_summary.candidate_workflow_count, 1);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.stable_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.replay_source_count, 2);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.rehydration_ready_count, 1);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.promotion_ready_count, 1);
    assert.equal(body.assembly_summary.workflow_signal_summary.stable_workflow_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.assembly_summary.workflow_signal_summary.observing_workflow_count, 0);
    assert.equal(body.assembly_summary.workflow_signal_summary.promotion_ready_workflow_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.transition_counts.candidate_observed, 1);
    assert.equal(body.assembly_summary.workflow_lifecycle_summary.transition_counts.promoted_to_stable, 1);
    assert.equal(body.assembly_summary.workflow_maintenance_summary.observe_count, 1);
    assert.equal(body.assembly_summary.workflow_maintenance_summary.retain_count, 1);
    assert.equal(body.assembly_summary.workflow_maintenance_summary.promote_candidate_count, 1);
    assert.equal(body.assembly_summary.workflow_maintenance_summary.retain_workflow_count, 1);
    assert.equal(body.assembly_summary.action_packet_summary.candidate_pattern_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.assembly_summary.action_packet_summary.trusted_pattern_count, 1);
    assert.equal(body.assembly_summary.action_packet_summary.rehydration_candidate_count, body.planner_packet.sections.rehydration_candidates.length);
    assert.equal(body.assembly_summary.action_packet_summary.supporting_knowledge_count, body.planner_packet.sections.supporting_knowledge.length);
    assert.equal(body.execution_kernel.action_packet_summary.candidate_pattern_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.stable_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.promotion_ready_count, 1);
    assert.equal(body.execution_kernel.workflow_signal_summary.stable_workflow_count, body.planner_packet.sections.recommended_workflows.length);
    assert.equal(body.execution_kernel.workflow_signal_summary.observing_workflow_count, 0);
    assert.equal(body.execution_kernel.workflow_signal_summary.promotion_ready_workflow_count, body.planner_packet.sections.candidate_workflows.length);
    assert.equal(body.execution_kernel.workflow_lifecycle_summary.transition_counts.candidate_observed, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.observe_count, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.retain_count, 1);
    assert.equal(body.execution_kernel.workflow_maintenance_summary.promote_candidate_count, 1);
    assert.equal(body.execution_kernel.action_packet_summary.rehydration_candidate_count, body.planner_packet.sections.rehydration_candidates.length);
    assert.equal(body.execution_kernel.pattern_signal_summary.trusted_pattern_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.execution_kernel.pattern_signal_summary.candidate_pattern_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.pattern_signal_summary.contested_pattern_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.assembly_summary.pattern_lifecycle_summary.trusted_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.assembly_summary.pattern_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.assembly_summary.pattern_lifecycle_summary.contested_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.assembly_summary.pattern_maintenance_summary.retain_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.assembly_summary.pattern_maintenance_summary.observe_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.assembly_summary.pattern_maintenance_summary.review_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.execution_kernel.pattern_lifecycle_summary.trusted_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.execution_kernel.pattern_lifecycle_summary.candidate_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.pattern_lifecycle_summary.contested_count, body.planner_packet.sections.contested_patterns.length);
    assert.equal(body.execution_kernel.pattern_maintenance_summary.retain_count, body.planner_packet.sections.trusted_patterns.length);
    assert.equal(body.execution_kernel.pattern_maintenance_summary.observe_count, body.planner_packet.sections.candidate_patterns.length);
    assert.equal(body.execution_kernel.pattern_maintenance_summary.review_count, body.planner_packet.sections.contested_patterns.length);
    assert.match(body.assembly_summary.planner_explanation, /workflow guidance: Fix export failure/);
    assert.match(body.assembly_summary.planner_explanation, /promotion-ready workflow candidates: Replay Episode: Fix export failure/);
    assert.match(body.assembly_summary.planner_explanation, /trusted patterns available but not used: edit/);
    assert.match(body.assembly_summary.planner_explanation, new RegExp(`supporting knowledge appended: ${body.planner_packet.sections.supporting_knowledge.length}`));
    assert.equal(body.tools.selection_summary.provenance_explanation, "selected tool: edit; candidate patterns visible but not yet trusted: edit");
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("context_assemble can still return layered_context when explicitly requested for debug/operator inspection", async () => {
  const dbPath = tmpDbPath("context-assemble-debug");
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedContextRuntimeFixture(dbPath);
  try {
    registerContextRuntimeApp({ app, liteWriteStore, liteRecallStore });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/context/assemble",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair export failure in node tests",
        context: {
          task_kind: "repair_export",
          goal: "repair export failure in node tests",
          error: {
            signature: "node-export-mismatch",
          },
        },
        include_rules: true,
        include_shadow: false,
        rules_limit: 20,
        tool_candidates: ["bash", "edit", "test"],
        return_layered_context: true,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = ContextAssembleRouteContractSchema.parse(response.json()) as Record<string, unknown>;
    assert.ok("layered_context" in body, "debug/operator context_assemble should expose layered_context when requested");
    assert.ok("operator_projection" in body, "debug/operator context_assemble should expose operator_projection when requested");
    assert.equal(body.workflow_signals.length, (body.layered_context as Record<string, unknown>).workflow_signals.length);
    assert.equal(body.pattern_signals.length, (body.layered_context as Record<string, unknown>).pattern_signals.length);
    assertDelegationLearningProjection(body, {
      task_family: "task:repair_export",
      matched_records: 0,
      truncated: false,
      route_role_counts: {},
      record_outcome_counts: {},
      recommendation_count: 0,
      recommendation_kinds: [],
    });
    assertOperatorDelegationLearningProjection(body, {
      task_family: "task:repair_export",
      matched_records: 0,
      truncated: false,
      route_role_counts: {},
      record_outcome_counts: {},
      recommendation_count: 0,
      recommendation_kinds: [],
    });
    assertOperatorActionHintProjection(body, {
      gate_action: "inspect_context",
      instruction: "Inspect the current context before starting with edit.",
      tool_route: null,
      priority: "recommended",
      contract_trust: "advisory",
      selected_tool: "edit",
      file_path: null,
      task_family: null,
      workflow_signature: "fix-export-failure-workflow",
      policy_memory_id: null,
    });
    assertExecutionKernelBundle(body as {
      layered_context: Record<string, unknown>;
      execution_kernel: {
        action_packet_summary: unknown;
        pattern_signal_summary: unknown;
        workflow_signal_summary: unknown;
        workflow_lifecycle_summary: unknown;
        workflow_maintenance_summary: unknown;
        pattern_lifecycle_summary: unknown;
        pattern_maintenance_summary: unknown;
      };
    });
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
