import { randomUUID } from "node:crypto";
import {
  createExampleClient,
  createScope,
  DEFAULT_TENANT_ID,
  isMain,
  printHeading,
  printJson,
  printStep,
  runExample,
} from "./shared.js";

const QUERY_TEXT = "rehydrate archived export repair workflow memory";
const TOOL_CANDIDATES = ["bash", "edit", "test"] as const;

function buildWorkflowAnchor(args: { payloadNodeId: string }) {
  return {
    anchor_kind: "workflow" as const,
    anchor_level: "L2" as const,
    task_signature: "repair-export-archived-workflow",
    task_family: "task:repair_export",
    error_signature: "node-export-mismatch",
    error_family: "error:node-export-mismatch",
    workflow_signature: `execution_workflow:${randomUUID()}`,
    summary: "Archived workflow guidance for export repair that should only be rehydrated on demand.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Rehydrate the archived workflow guidance before patching export handling.",
    outcome: {
      status: "mixed" as const,
      result_class: "workflow_archived_forgettable",
      success_score: 0.38,
    },
    source: {
      source_kind: "execution_write" as const,
      node_id: args.payloadNodeId,
      run_id: `run:${randomUUID()}`,
    },
    payload_refs: {
      node_ids: [args.payloadNodeId],
      decision_ids: [],
      run_ids: [],
      step_ids: [],
      commit_ids: [],
    },
    rehydration: {
      default_mode: "differential" as const,
      payload_cost_hint: "high" as const,
      recommended_when: ["need_archived_log_detail", "policy_review"],
    },
    maintenance: {
      model: "lazy_online_v1" as const,
      maintenance_state: "review" as const,
      offline_priority: "retain_workflow" as const,
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    workflow_promotion: {
      promotion_state: "stable" as const,
      promotion_origin: "replay_promote" as const,
      required_observations: 2,
      observed_count: 2,
      last_transition: "promoted_to_stable" as const,
      last_transition_at: "2026-03-20T00:00:00Z",
      source_status: "active" as const,
    },
    metrics: {
      usage_count: 1,
      reuse_success_count: 0,
      reuse_failure_count: 2,
      distinct_run_count: 1,
      last_used_at: "2025-12-01T00:00:00Z",
    },
    schema_version: "anchor_v1" as const,
  };
}

function summarizeResolvedNode(node: Record<string, any> | null | undefined) {
  const slots = node?.slots ?? {};
  return {
    id: node?.id ?? null,
    uri: node?.uri ?? null,
    tier: node?.tier ?? null,
    summary_kind: slots?.summary_kind ?? null,
    semantic_forgetting: slots?.semantic_forgetting_v1 ?? null,
    archive_relocation: slots?.archive_relocation_v1 ?? null,
    rehydration_default_mode: slots?.anchor_v1?.rehydration?.default_mode ?? null,
  };
}

function summarizeForgettingSurface(summary: Record<string, any> | null | undefined) {
  return {
    substrate_mode: summary?.substrate_mode ?? null,
    semantic_action_counts: summary?.semantic_action_counts ?? null,
    lifecycle_state_counts: summary?.lifecycle_state_counts ?? null,
    archive_relocation_state_counts: summary?.archive_relocation_state_counts ?? null,
    archive_relocation_target_counts: summary?.archive_relocation_target_counts ?? null,
    archive_payload_scope_counts: summary?.archive_payload_scope_counts ?? null,
    rehydration_mode_counts: summary?.rehydration_mode_counts ?? null,
    differential_rehydration_candidate_count: summary?.differential_rehydration_candidate_count ?? null,
    stale_signal_count: summary?.stale_signal_count ?? null,
    recommended_action: summary?.recommended_action ?? null,
  };
}

function assertArchivedWorkflowNode(node: Record<string, any> | null | undefined) {
  const semantic = node?.slots?.semantic_forgetting_v1 ?? {};
  const relocation = node?.slots?.archive_relocation_v1 ?? {};
  if (semantic.action !== "archive") {
    throw new Error(`expected semantic forgetting action=archive, got ${semantic.action ?? "null"}`);
  }
  if (relocation.relocation_state !== "cold_archive") {
    throw new Error(`expected archive relocation state=cold_archive, got ${relocation.relocation_state ?? "null"}`);
  }
}

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("semantic-forgetting-proof");
  const payloadNodeId = randomUUID();
  const workflowNodeId = randomUUID();

  printHeading("Demo 6: Semantic forgetting archives and rehydrates execution memory");

  printStep("1. Write a cold workflow anchor whose lifecycle signals should archive it by default.");
  const write = await aionis.memory.write({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "sdk-example",
    input_text: QUERY_TEXT,
    auto_embed: true,
    memory_lane: "shared",
    nodes: [
      {
        id: payloadNodeId,
        type: "event",
        tier: "hot",
        title: "Failure evidence: export retry log",
        text_summary: "Detailed export retry log that should stay cold unless a review explicitly needs it.",
        slots: {
          summary_kind: "supporting_evidence",
          lifecycle_state: "active",
        },
      },
      {
        id: workflowNodeId,
        type: "procedure",
        tier: "cold",
        title: "Archived export repair workflow guidance",
        text_summary: QUERY_TEXT,
        slots: {
          summary_kind: "workflow_anchor",
          compression_layer: "L2",
          feedback_negative: 4,
          feedback_quality: -0.8,
          anchor_v1: buildWorkflowAnchor({ payloadNodeId }),
        },
      },
    ],
    edges: [],
  }) as Record<string, any>;

  const workflowNode = Array.isArray(write.nodes)
    ? write.nodes.find((entry: Record<string, any>) => entry.id === workflowNodeId)
    : null;
  if (!workflowNode?.uri) {
    throw new Error("write did not return a workflow anchor uri");
  }

  const beforeResolve = await aionis.memory.resolve({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    uri: workflowNode.uri,
    include_meta: true,
    include_slots: true,
  }) as Record<string, any>;
  assertArchivedWorkflowNode(beforeResolve.node);
  printJson("Archived workflow node", summarizeResolvedNode(beforeResolve.node));

  printStep("2. Show that planning and introspection surfaces now explain why this memory stays cold.");
  const planning = await aionis.memory.planningContext({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: QUERY_TEXT,
    context: {
      goal: QUERY_TEXT,
      task_kind: "repair_export",
    },
    recall_strategy: "global",
    limit: 12,
    ranked_limit: 64,
    return_layered_context: true,
    memory_layer_preference: {
      allowed_layers: ["L2", "L3", "L4", "L5"],
    },
    tool_candidates: [...TOOL_CANDIDATES],
  }) as Record<string, any>;
  const planningForgetting = summarizeForgettingSurface(planning?.planning_summary?.forgetting_summary);
  if ((planningForgetting.semantic_action_counts?.demote ?? 0) < 1) {
    throw new Error("planning summary did not surface hotter-memory demotion pressure");
  }
  if ((planningForgetting.stale_signal_count ?? 0) < 1) {
    throw new Error("planning summary did not surface stale/cold-memory pressure");
  }
  const planningRecommendedAction = String(planningForgetting.recommended_action ?? "");
  if (!planningRecommendedAction.includes("widen recall")) {
    throw new Error("planning summary did not explain that colder memory should only be widened on demand");
  }
  printJson("Planning forgetting summary", planningForgetting);

  const introspect = await aionis.memory.executionIntrospect({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: QUERY_TEXT,
    context: {
      goal: QUERY_TEXT,
      task_kind: "repair_export",
    },
    limit: 8,
  }) as Record<string, any>;
  const introspectionForgetting = summarizeForgettingSurface(introspect?.execution_summary?.forgetting_summary);
  if ((introspectionForgetting.semantic_action_counts?.archive ?? 0) < 1) {
    throw new Error("execution introspection did not surface archived semantic forgetting counts");
  }
  if ((introspectionForgetting.archive_relocation_state_counts?.cold_archive ?? 0) < 1) {
    throw new Error("execution introspection did not surface cold archive relocation counts");
  }
  const introspectionWorkflow = Array.isArray(introspect?.recommended_workflows) ? introspect.recommended_workflows[0] : null;
  if (introspectionWorkflow?.semantic_forgetting_action !== "archive") {
    throw new Error("execution introspection did not expose workflow-level semantic forgetting state");
  }
  if (introspectionWorkflow?.archive_relocation_state !== "cold_archive") {
    throw new Error("execution introspection did not expose workflow-level archive relocation state");
  }
  printJson("Execution forgetting summary", introspectionForgetting);
  printJson("Execution introspection workflow", introspectionWorkflow);

  printStep("3. Use public differential payload rehydration to restore only the needed archived detail.");
  const differential = await aionis.memory.anchors.rehydratePayload({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    anchor_id: workflowNodeId,
    mode: "differential",
    reason: "need archived log detail for export workflow review",
  }) as Record<string, any>;
  const selectedNodeIds = differential?.rehydrated?.summary?.differential_selected_node_ids ?? [];
  if (!Array.isArray(selectedNodeIds) || !selectedNodeIds.includes(payloadNodeId)) {
    throw new Error("differential rehydration did not select the archived payload node");
  }
  printJson("Differential payload rehydration", {
    selected_node_ids: selectedNodeIds,
    rationale: differential?.rehydrated?.summary?.differential_rationale ?? [],
  });

  printStep("4. Rehydrate the archived workflow anchor back into the active working tier without erasing its cold-storage recommendation.");
  const rehydrated = await aionis.memory.archive.rehydrate({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    node_ids: [workflowNodeId],
    target_tier: "warm",
    input_text: QUERY_TEXT,
    reason: "bring archived workflow guidance back into the active set for review",
  }) as Record<string, any>;
  if ((rehydrated?.rehydrated?.moved_nodes ?? 0) !== 1) {
    throw new Error("archive.rehydrate did not move the archived workflow anchor");
  }

  const afterResolve = await aionis.memory.resolve({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    uri: workflowNode.uri,
    include_meta: true,
    include_slots: true,
  }) as Record<string, any>;
  printJson("Post-rehydrate workflow node", summarizeResolvedNode(afterResolve.node));

  printJson("Proof summary", {
    scope,
    workflow_anchor_id: workflowNodeId,
    payload_node_id: payloadNodeId,
    before_action: beforeResolve?.node?.slots?.semantic_forgetting_v1?.action ?? null,
    before_relocation_state: beforeResolve?.node?.slots?.archive_relocation_v1?.relocation_state ?? null,
    planning_demote_count: planningForgetting.semantic_action_counts?.demote ?? 0,
    planning_stale_signal_count: planningForgetting.stale_signal_count ?? 0,
    planning_recommended_action: planningForgetting.recommended_action ?? null,
    planning_differential_count: planningForgetting.rehydration_mode_counts?.differential ?? 0,
    execution_archive_count: introspectionForgetting.semantic_action_counts?.archive ?? 0,
    execution_cold_archive_count: introspectionForgetting.archive_relocation_state_counts?.cold_archive ?? 0,
    execution_differential_count: introspectionForgetting.rehydration_mode_counts?.differential ?? 0,
    differential_selected_node_ids: selectedNodeIds,
    after_current_tier: afterResolve?.node?.slots?.semantic_forgetting_v1?.current_tier ?? null,
    after_action: afterResolve?.node?.slots?.semantic_forgetting_v1?.action ?? null,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
