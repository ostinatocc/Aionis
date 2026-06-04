import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { CognitiveStructureV1Schema } from "../../src/kernel/cognitive-structure.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import {
  DelegationRecordsWriteResponseSchema,
  ExecutionMemoryIntrospectionResponseSchema,
  MemoryAnchorV1Schema,
} from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-execution-introspection-"));
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
      WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
      RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    } as any,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

async function seedExecutionIntrospectionFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "repair-export-node-tests",
    error_signature: "node-export-mismatch",
    workflow_signature: "execution_workflow:d693c6beba272a6e135b54be",
    summary: "Inspect failing test and patch export",
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
  const trustedPattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:repair-export",
    task_family: "task:repair_export",
    error_signature: "node-export-mismatch",
    error_family: "error:node-export-mismatch",
    pattern_signature: "trusted-edit-pattern",
    summary: "Prefer edit for export repair after repeated successful runs.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    outcome: {
      status: "success",
      result_class: "tool_selection_pattern_stable",
      success_score: 0.94,
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
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_trusted",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 0,
      counter_evidence_open: false,
      credibility_state: "trusted",
      previous_credibility_state: "candidate",
      last_transition: "promoted_to_trusted",
      last_transition_at: "2026-03-20T00:00:00Z",
      stable_at: "2026-03-20T00:00:00Z",
      last_validated_at: "2026-03-20T00:00:00Z",
      last_counter_evidence_at: null,
    },
    trust_hardening: {
      task_family: "task:repair_export",
      error_family: "error:node-export-mismatch",
      observed_task_families: ["task:repair_export"],
      observed_error_families: ["error:node-export-mismatch"],
      distinct_task_family_count: 1,
      distinct_error_family_count: 1,
      post_contest_observed_run_ids: [],
      post_contest_distinct_run_count: 0,
      promotion_gate_kind: "current_distinct_runs_v1",
      promotion_gate_satisfied: true,
      revalidation_floor_kind: "post_contest_two_fresh_runs_v1",
      revalidation_floor_satisfied: true,
      task_affinity_weighting_enabled: true,
    },
    schema_version: "anchor_v1",
  });
  const contestedPattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "provisional",
    credibility_state: "contested",
    task_signature: "tools_select:repair-export",
    error_signature: "node-export-mismatch",
    pattern_signature: "contested-bash-pattern",
    summary: "Older bash-first pattern now has counter-evidence.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "bash",
    outcome: {
      status: "mixed",
      result_class: "tool_selection_pattern_contested",
      success_score: 0.41,
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
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "review",
      offline_priority: "review_counter_evidence",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 1,
      counter_evidence_open: true,
      credibility_state: "contested",
      previous_credibility_state: "trusted",
      last_transition: "counter_evidence_opened",
      last_transition_at: "2026-03-20T00:00:00Z",
      stable_at: "2026-03-20T00:00:00Z",
      last_validated_at: "2026-03-20T00:00:00Z",
      last_counter_evidence_at: "2026-03-20T00:00:00Z",
    },
    trust_hardening: {
      task_family: "task:repair_export",
      error_family: "error:node-export-mismatch",
      observed_task_families: ["task:repair_export"],
      observed_error_families: ["error:node-export-mismatch"],
      distinct_task_family_count: 1,
      distinct_error_family_count: 1,
      post_contest_observed_run_ids: [randomUUID(), randomUUID()],
      post_contest_distinct_run_count: 2,
      promotion_gate_kind: "current_distinct_runs_v1",
      promotion_gate_satisfied: true,
      revalidation_floor_kind: "post_contest_two_fresh_runs_v1",
      revalidation_floor_satisfied: true,
      task_affinity_weighting_enabled: true,
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
      input_text: [
        "Task Signature: repair-export-node-tests",
        "Error Signature: node-export-mismatch",
        "Workflow Signature: inspect-patch-rerun",
        "Export repair requires inspect, patch, and rerun.",
      ].join("\n"),
      auto_embed: false,
      distill: {
        enabled: true,
        sources: ["input_text"],
        max_evidence_nodes: 2,
        max_fact_nodes: 4,
        min_sentence_chars: 12,
        attach_edges: true,
      },
      nodes: [
        {
          id: randomUUID(),
          type: "procedure",
          title: "Fix export failure",
          text_summary: workflowAnchor.summary,
          slots: {
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            semantic_forgetting_v1: {
              action: "archive",
              current_tier: "cold",
              target_tier: "archive",
              lifecycle_state: "active",
            },
            archive_relocation_v1: {
              relocation_state: "cold_archive",
              relocation_target: "local_cold_store",
              payload_scope: "anchor_payload",
              should_relocate: true,
            },
            anchor_v1: workflowAnchor,
          },
        },
        {
          id: randomUUID(),
          type: "event",
          title: "Replay Episode: Duplicate candidate",
          text_summary: "Candidate workflow that should be suppressed by stable workflow",
          slots: {
            summary_kind: "workflow_candidate",
            compression_layer: "L1",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_candidate",
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              task_signature: "repair-export-node-tests",
              error_signature: "node-export-mismatch",
              workflow_signature: "execution_workflow:d693c6beba272a6e135b54be",
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
            workflow_write_projection: {
              generated_by: "execution_write_projection_v1",
              source_node_id: "source-duplicate",
              source_client_id: "execution-event:duplicate",
              generated_at: "2026-03-20T00:00:00Z",
            },
          },
        },
        {
          client_id: "workflow_projection:2c93d96d-ad3b-52ed-aa70-446c847ab391:execution_workflow:574d5d7f3f31626f2be7ef76",
          type: "event",
          title: "Replay Episode: Ready candidate",
          text_summary: "Candidate workflow ready for promotion",
          slots: {
            summary_kind: "workflow_candidate",
            compression_layer: "L1",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_candidate",
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              task_signature: "repair-import-node-tests",
              error_signature: "node-import-mismatch",
              workflow_signature: "execution_workflow:574d5d7f3f31626f2be7ef76",
              anchor_kind: "workflow",
              anchor_level: "L1",
              workflow_promotion: {
                promotion_state: "candidate",
                promotion_origin: "replay_learning_episode",
                required_observations: 2,
                observed_count: 2,
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
            workflow_write_projection: {
              generated_by: "execution_write_projection_v1",
              source_node_id: "2c93d96d-ad3b-52ed-aa70-446c847ab391",
              source_client_id: "execution-event:ready",
              generated_at: "2026-03-20T00:00:00Z",
            },
          },
        },
        {
          client_id: "workflow_projection:6872dfa2-6894-5d73-95e7-71e8415f4f23:execution_workflow:574d5d7f3f31626f2be7ef76",
          type: "event",
          title: "Replay Episode: Observing duplicate candidate",
          text_summary: "Older candidate workflow for the same signature",
          slots: {
            summary_kind: "workflow_candidate",
            compression_layer: "L1",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_candidate",
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              task_signature: "repair-import-node-tests",
              error_signature: "node-import-mismatch",
              workflow_signature: "execution_workflow:574d5d7f3f31626f2be7ef76",
              anchor_kind: "workflow",
              anchor_level: "L1",
              workflow_promotion: {
                promotion_state: "candidate",
                promotion_origin: "replay_learning_episode",
                required_observations: 2,
                observed_count: 1,
                last_transition: "candidate_observed",
                last_transition_at: "2026-03-19T00:00:00Z",
                source_status: null,
              },
              maintenance: {
                model: "lazy_online_v1",
                maintenance_state: "observe",
                offline_priority: "promote_candidate",
                lazy_update_fields: ["usage_count", "last_used_at"],
                last_maintenance_at: "2026-03-19T00:00:00Z",
              },
            },
            workflow_write_projection: {
              generated_by: "execution_write_projection_v1",
              source_node_id: "6872dfa2-6894-5d73-95e7-71e8415f4f23",
              source_client_id: "execution-event:observing",
              generated_at: "2026-03-19T00:00:00Z",
            },
          },
        },
        {
          client_id: "execution-event:ready",
          type: "event",
          title: "Source event for ready candidate",
          text_summary: "Raw continuity event that produced the ready candidate",
          slots: {
            execution_packet_v1: {
              version: 1,
              state_id: "state-ready",
              current_stage: "patch",
              active_role: "patch",
              task_brief: "Fix import failure in node tests",
              target_files: ["src/routes/import.ts"],
              next_action: "Patch src/routes/import.ts and rerun import tests",
              hard_constraints: [],
              accepted_facts: [],
              rejected_paths: [],
              pending_validations: ["npm run -s test:lite -- import"],
              unresolved_blockers: [],
              rollback_notes: [],
              review_contract: null,
              resume_anchor: {
                anchor: "resume:src/routes/import.ts",
                file_path: "src/routes/import.ts",
                symbol: null,
                repo_root: "/Volumes/ziel/Aionisgo",
              },
              artifact_refs: [],
              evidence_refs: [],
            },
          },
        },
        {
          client_id: "execution-event:observing",
          type: "event",
          title: "Source event for observing candidate",
          text_summary: "Raw continuity event that produced the observing duplicate candidate",
          slots: {
            execution_packet_v1: {
              version: 1,
              state_id: "state-observing",
              current_stage: "patch",
              active_role: "patch",
              task_brief: "Fix import failure in node tests",
              target_files: ["src/routes/import.ts"],
              next_action: "Patch src/routes/import.ts and rerun import tests",
              hard_constraints: [],
              accepted_facts: [],
              rejected_paths: [],
              pending_validations: ["npm run -s test:lite -- import"],
              unresolved_blockers: [],
              rollback_notes: [],
              review_contract: null,
              resume_anchor: {
                anchor: "resume:src/routes/import.ts",
                file_path: "src/routes/import.ts",
                symbol: null,
                repo_root: "/Volumes/ziel/Aionisgo",
              },
              artifact_refs: [],
              evidence_refs: [],
            },
          },
        },
        {
          client_id: "execution-event:after-stable",
          type: "event",
          title: "Source event after stable workflow exists",
          text_summary: "Raw continuity event that should now be skipped because stable workflow already exists",
          slots: {
            execution_packet_v1: {
              version: 1,
              state_id: "state-after-stable",
              current_stage: "patch",
              active_role: "patch",
              task_brief: "Inspect failing test and patch export",
              target_files: ["src/routes/export.ts"],
              next_action: "Patch src/routes/export.ts and rerun export tests",
              hard_constraints: [],
              accepted_facts: [],
              rejected_paths: [],
              pending_validations: ["npm run -s test:lite -- export"],
              unresolved_blockers: [],
              rollback_notes: [],
              review_contract: null,
              resume_anchor: {
                anchor: "resume:src/routes/export.ts",
                file_path: "src/routes/export.ts",
                symbol: null,
                repo_root: "/Volumes/ziel/Aionisgo",
              },
              artifact_refs: [],
              evidence_refs: [],
            },
          },
        },
        {
          client_id: "execution-event:no-continuity",
          type: "event",
          title: "Raw event without continuity",
          text_summary: "This event should appear as skipped_missing_execution_continuity in the projection report",
          slots: {},
        },
        {
          id: randomUUID(),
          type: "concept",
          title: "Stable edit pattern",
          text_summary: trustedPattern.summary,
          slots: {
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            anchor_v1: trustedPattern,
            operator_override_v1: {
              schema_version: "operator_override_v1",
              suppressed: true,
              reason: "operator stop-loss for trusted edit pattern",
              mode: "shadow_learn",
              until: null,
              updated_at: "2026-03-20T00:00:00Z",
              updated_by: "local-user",
              last_action: "suppress",
            },
          },
        },
        {
          id: randomUUID(),
          type: "concept",
          title: "Contested bash pattern",
          text_summary: contestedPattern.summary,
          slots: {
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            anchor_v1: contestedPattern,
          },
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
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  return { liteWriteStore };
}

async function seedExecutionNativeOnlyWorkflowIntrospectionFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: "seed execution-native-only workflow introspection fixture",
      auto_embed: false,
      nodes: [
        {
          id: randomUUID(),
          type: "procedure",
          title: "Fix export failure",
          text_summary: "Reusable repair workflow for export failure",
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
                promotion_origin: "execution_write_auto_promotion",
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
            workflow_write_projection: {
              generated_by: "execution_write_projection_v1",
              source_node_id: "55555555-5555-4555-8555-555555555555",
              source_client_id: "execution-event:stable",
              generated_at: "2026-03-20T00:20:00Z",
              auto_promoted: true,
            },
          },
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
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  return { liteWriteStore };
}

async function seedCanonicalContractPrecedenceIntrospectionFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const canonicalContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "task:canonical_export_repair",
    task_signature: "canonical-export-repair",
    workflow_signature: "execution_workflow:canonical-export-repair",
    selected_tool: "edit",
    file_path: "src/routes/canonical-export.ts",
    target_files: ["src/routes/canonical-export.ts"],
    next_action: "Follow the canonical execution contract next action.",
    workflow_steps: ["inspect canonical export failure", "patch canonical export route", "rerun canonical export checks"],
    pattern_hints: ["canonical pattern hint"],
    service_lifecycle_constraints: [
      {
        version: 1,
        service_kind: "http",
        label: "canonical export preview",
        launch_reference: "npm run preview:canonical",
        endpoint: "http://127.0.0.1:4173/canonical",
        must_survive_agent_exit: true,
        revalidate_from_fresh_shell: true,
        detach_then_probe: true,
        health_checks: ["curl -fsS http://127.0.0.1:4173/canonical"],
        teardown_notes: ["stop preview after verification"],
      },
    ],
    acceptance_checks: ["npm run -s test:canonical-export"],
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "execution_contract_v1",
      source_anchor: "canonical-introspection-test",
      evidence_refs: [],
      notes: ["canonical contract must drive introspection fields"],
    },
  });
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: "seed canonical contract precedence introspection fixture",
      auto_embed: false,
      nodes: [
        {
          id: randomUUID(),
          type: "procedure",
          title: "Canonical export workflow",
          text_summary: "Workflow with canonical contract and conflicting stale execution-native fields.",
          slots: {
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            execution_contract_v1: canonicalContract,
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_anchor",
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              contract_trust: "observational",
              task_family: "task:stale_export_repair",
              task_signature: "stale-export-repair",
              workflow_signature: "execution_workflow:stale-export-repair",
              file_path: "src/routes/stale-export.ts",
              target_files: ["src/routes/stale-export.ts"],
              next_action: "Stale execution-native next action should not steer introspection.",
              workflow_steps: ["stale inspect", "stale patch"],
              pattern_hints: ["stale pattern hint"],
              service_lifecycle_constraints: [
                {
                  version: 1,
                  service_kind: "http",
                  label: "stale export preview",
                  launch_reference: "npm run preview:stale",
                  endpoint: "http://127.0.0.1:4173/stale",
                  must_survive_agent_exit: false,
                  revalidate_from_fresh_shell: false,
                  detach_then_probe: false,
                  health_checks: ["curl -fsS http://127.0.0.1:4173/stale"],
                  teardown_notes: ["stale teardown"],
                },
              ],
              anchor_kind: "workflow",
              anchor_level: "L2",
              workflow_promotion: {
                promotion_state: "stable",
                promotion_origin: "execution_write_auto_promotion",
                required_observations: 2,
                observed_count: 2,
                last_transition: "promoted_to_stable",
                last_transition_at: "2026-03-20T00:30:00Z",
                source_status: null,
              },
              maintenance: {
                model: "lazy_online_v1",
                maintenance_state: "retain",
                offline_priority: "retain_workflow",
                lazy_update_fields: ["usage_count", "last_used_at"],
                last_maintenance_at: "2026-03-20T00:30:00Z",
              },
            },
          },
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
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  return { liteWriteStore };
}

test("execution introspection route exposes operator-facing workflow and pattern surfaces", async () => {
  const dbPath = tmpDbPath("execution-introspect");
  const app = Fastify();
  const { liteWriteStore } = await seedExecutionIntrospectionFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerMemoryAccessRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        APP_ENV: "test",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10_000,
        PII_REDACTION: false,
        ALLOW_CROSS_SCOPE_EDGES: false,
      } as any,
      embedder: null,
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = ExecutionMemoryIntrospectionResponseSchema.parse(response.json());
    assert.equal(body.summary_version, "execution_memory_introspection_v1");
    assert.equal(body.recommended_workflows.length, 1);
    assert.equal(typeof body.recommended_workflows[0]?.semantic_forgetting_action, "string");
    assert.equal(typeof body.recommended_workflows[0]?.archive_relocation_state, "string");
    assert.equal(typeof body.recommended_workflows[0]?.archive_relocation_target, "string");
    assert.equal(body.candidate_workflows.length, 1);
    assert.equal(body.rehydration_candidates.length, 1);
    assert.equal(body.trusted_patterns.length, 1);
    assert.equal(body.contested_patterns.length, 1);
    assert.equal(body.authority_decision_report.report_version, "runtime_authority_decision_report_v1");
    assert.equal(body.authority_decision_report.summary.summary_version, "runtime_authority_decision_summary_v1");
    assert.equal(body.authority_decision_report.summary.decisions_by_surface.candidate_workflow_reuse.inspect_or_rehydrate_only, 1);
    assert.equal(body.authority_decision_report.summary.decisions_by_surface.trusted_pattern_policy_materialization.advisory_only, 1);
    assert.equal(body.authority_decision_report.summary.decisions_by_surface.policy_default_materialization.blocked, 2);
    assert.equal(body.authority_decision_report.summary.unblocked_false_confidence_count, 0);
    assert.ok(body.authority_decision_report.read_side_rules.some((entry) =>
      entry.source_id === "execution_introspection"
      && entry.authority_rules.includes("execution_introspection_reports_authority_decisions_read_only")
    ));
    assert.equal(body.recommended_workflows[0]?.authority_decision_report?.report_version, "runtime_authority_decision_report_v1");
    assert.equal(body.candidate_workflows[0]?.authority_decision_report?.summary.decisions_by_surface.candidate_workflow_reuse.inspect_or_rehydrate_only, 1);
    assert.equal(body.trusted_patterns[0]?.authority_decision_report?.summary.decisions_by_surface.trusted_pattern_policy_materialization.advisory_only, 1);
    assert.equal(body.pattern_signals.length, 2);
    assert.equal(body.workflow_signals.length, 2);
    assert.equal(body.inventory.raw_workflow_anchor_count, 1);
    assert.equal(body.inventory.raw_workflow_candidate_count, 3);
    assert.equal(body.inventory.suppressed_candidate_workflow_count, 2);
    assert.equal(body.inventory.continuity_projected_candidate_count, 3);
    assert.equal(body.inventory.continuity_auto_promoted_workflow_count, 0);
    assert.equal(body.inventory.raw_pattern_anchor_count, 2);
    assert.equal(body.inventory.raw_distilled_evidence_count, 1);
    assert.equal(body.inventory.raw_distilled_fact_count, 3);
    assert.equal(body.distillation_signal_summary.distilled_evidence_count, 1);
    assert.equal(body.distillation_signal_summary.distilled_fact_count, 3);
    assert.equal(body.distillation_signal_summary.projected_workflow_candidate_count, 0);
    assert.equal(body.distillation_signal_summary.origin_counts.write_distillation_input_text, 4);
    assert.equal(body.distillation_signal_summary.origin_counts.execution_write_projection, 0);
    assert.equal(body.distillation_signal_summary.promotion_target_counts.workflow, 4);
    assert.equal(body.continuity_carrier_summary.total_count, 0);
    assert.equal(body.continuity_carrier_summary.handoff_count, 0);
    assert.equal(body.continuity_carrier_summary.session_event_count, 0);
    assert.equal(body.continuity_projection_report.sampled_source_event_count, 4);
    assert.equal(body.continuity_projection_report.decision_counts.projected, 2);
    assert.equal(body.continuity_projection_report.decision_counts.skipped_stable_exists, 1);
    assert.equal(body.continuity_projection_report.decision_counts.skipped_missing_execution_continuity, 1);
    assert.equal(body.continuity_projection_report.decision_counts.eligible_without_projection, 0);
    assert.ok(body.continuity_projection_report.samples.some((sample) => sample.source_client_id === "execution-event:ready" && sample.decision === "projected"));
    assert.ok(body.continuity_projection_report.samples.some((sample) => sample.source_client_id === "execution-event:observing" && sample.decision === "projected"));
    assert.ok(body.continuity_projection_report.samples.some((sample) => sample.source_client_id === "execution-event:after-stable" && sample.decision === "skipped_stable_exists"));
    assert.ok(body.continuity_projection_report.samples.some((sample) => sample.source_client_id === "execution-event:no-continuity" && sample.decision === "skipped_missing_execution_continuity"));
    assert.equal(body.workflow_signal_summary.stable_workflow_count, 1);
    assert.equal(body.workflow_signal_summary.promotion_ready_workflow_count, 1);
    assert.ok(body.supporting_knowledge.some((item: any) => item.summary_kind === "write_distillation_evidence"));
    assert.ok(body.supporting_knowledge.some((item: any) => item.summary_kind === "write_distillation_fact"));
    assert.equal(body.workflow_signal_summary.observing_workflow_count, 0);
    assert.equal(body.execution_summary.summary_version, "execution_summary_v1");
    const cognitiveStructure = CognitiveStructureV1Schema.parse(body.cognitive_structure_v1);
    assert.equal(cognitiveStructure.structure_version, "cognitive_structure_v1");
    assert.equal(cognitiveStructure.source_code_change_allowed, false);
    assert.equal(cognitiveStructure.execution_state.task_family, body.execution_summary.routing_signal_summary.task_family);
    assert.equal(cognitiveStructure.execution_state.selected_tool, body.execution_summary.routing_signal_summary.selected_tool);
    assert.deepEqual(cognitiveStructure.workflow_memory.stable_anchor_ids, body.action_packet_summary.workflow_anchor_ids);
    assert.equal(cognitiveStructure.workflow_memory.promotion_ready_count, body.workflow_lifecycle_summary.promotion_ready_count);
    assert.equal(cognitiveStructure.policy_memory.persisted_count, body.policy_lifecycle_summary.persisted_count);
    assert.equal(cognitiveStructure.forgetting_state.suppressed_pattern_count, body.execution_summary.forgetting_summary.suppressed_pattern_count);
    assert.equal(cognitiveStructure.authority_state.authoritative_blocked_count, body.authority_visibility_summary.authoritative_blocked_count);
    assert.equal(body.execution_summary.planner_packet, null);
    assert.deepEqual(body.execution_summary.pattern_signals, body.pattern_signals);
    assert.deepEqual(body.execution_summary.workflow_signals, body.workflow_signals);
    assert.equal(body.execution_summary.packet_assembly.packet_source_mode, null);
    assert.equal(body.execution_summary.packet_assembly.state_first_assembly, null);
    assert.equal(body.execution_summary.packet_assembly.execution_packet_v1_present, null);
    assert.equal(body.execution_summary.packet_assembly.execution_state_v1_present, null);
    assert.equal(body.execution_summary.strategy_summary.summary_version, "execution_strategy_summary_v1");
    assert.equal(body.execution_summary.strategy_summary.trust_signal, body.execution_summary.routing_signal_summary.family_scope);
    assert.equal(body.execution_summary.strategy_summary.task_family, body.execution_summary.routing_signal_summary.task_family);
    assert.equal(body.execution_summary.strategy_summary.family_scope, body.execution_summary.routing_signal_summary.family_scope);
    assert.equal(body.execution_summary.strategy_summary.strategy_profile, "rehydration_first");
    assert.equal(body.execution_summary.strategy_summary.validation_style, "validate_before_expansion");
    assert.ok(body.execution_summary.strategy_summary.family_candidate_count >= 1);
    assert.ok(body.execution_summary.strategy_summary.selected_working_set.includes("workflow:Fix export failure"));
    assert.ok(body.execution_summary.strategy_summary.selected_pattern_summaries.some((line) => line.includes("Prefer edit")));
    assert.ok(body.execution_summary.strategy_summary.preferred_artifact_refs.length > 0);
    assert.match(body.execution_summary.strategy_summary.explanation, /Selected because/);
    assert.equal(body.execution_summary.collaboration_summary.summary_version, "execution_collaboration_summary_v1");
    assert.equal(body.execution_summary.collaboration_summary.packet_present, false);
    assert.equal(body.execution_summary.collaboration_summary.coordination_mode, "memory_only");
    assert.equal(body.execution_summary.collaboration_summary.review_contract_present, false);
    assert.equal(body.execution_summary.collaboration_summary.resume_anchor_present, false);
    assert.equal(body.execution_summary.collaboration_summary.artifact_ref_count, 0);
    assert.equal(body.execution_summary.collaboration_summary.evidence_ref_count, 0);
    assert.equal(body.execution_summary.continuity_snapshot_summary.summary_version, "execution_continuity_snapshot_v1");
    assert.equal(body.execution_summary.continuity_snapshot_summary.snapshot_mode, "memory_only");
    assert.equal(body.execution_summary.continuity_snapshot_summary.coordination_mode, "memory_only");
    assert.equal(body.execution_summary.continuity_snapshot_summary.trust_signal, body.execution_summary.strategy_summary.trust_signal);
    assert.equal(body.execution_summary.continuity_snapshot_summary.strategy_profile, "rehydration_first");
    assert.equal(body.execution_summary.continuity_snapshot_summary.validation_style, "validate_before_expansion");
    assert.equal(body.execution_summary.continuity_snapshot_summary.selected_tool, body.execution_summary.routing_signal_summary.selected_tool);
    assert.deepEqual(
      body.execution_summary.continuity_snapshot_summary.selected_pattern_summaries,
      body.execution_summary.strategy_summary.selected_pattern_summaries,
    );
    assert.ok(body.execution_summary.continuity_snapshot_summary.preferred_artifact_refs.length > 0);
    assert.equal(body.execution_summary.routing_signal_summary.summary_version, "execution_routing_summary_v1");
    assert.deepEqual(body.execution_summary.routing_signal_summary.stable_workflow_anchor_ids, body.action_packet_summary.workflow_anchor_ids);
    assert.deepEqual(body.execution_summary.routing_signal_summary.candidate_workflow_anchor_ids, body.action_packet_summary.candidate_workflow_anchor_ids);
    assert.deepEqual(body.execution_summary.routing_signal_summary.rehydration_anchor_ids, body.action_packet_summary.rehydration_anchor_ids);
    assert.equal(body.execution_summary.maintenance_summary.summary_version, "execution_maintenance_summary_v1");
    assert.equal(body.execution_summary.maintenance_summary.stable_workflow_count, body.workflow_signal_summary.stable_workflow_count);
    assert.equal(
      body.execution_summary.maintenance_summary.promotion_ready_workflow_count,
      body.workflow_signal_summary.promotion_ready_workflow_count,
    );
    const suppressedPatternAnchorIds = body.trusted_patterns
      .filter((entry) => entry.suppressed === true && typeof entry.anchor_id === "string")
      .map((entry) => entry.anchor_id);
    assert.equal(body.execution_summary.forgetting_summary.summary_version, "execution_forgetting_summary_v1");
    assert.equal(body.execution_summary.forgetting_summary.substrate_mode, "suppression_present");
    assert.equal(body.execution_summary.forgetting_summary.forgotten_items, 0);
    assert.deepEqual(body.execution_summary.forgetting_summary.forgotten_by_reason, {});
    assert.equal(body.execution_summary.forgetting_summary.primary_forgetting_reason, null);
    assert.equal(body.execution_summary.forgetting_summary.suppressed_pattern_count, 1);
    assert.deepEqual(
      body.execution_summary.forgetting_summary.suppressed_pattern_anchor_ids,
      suppressedPatternAnchorIds,
    );
    assert.deepEqual(body.execution_summary.forgetting_summary.suppressed_pattern_sources, ["trusted_patterns"]);
    assert.deepEqual(body.execution_summary.forgetting_summary.selected_memory_layers, []);
    assert.equal(typeof body.execution_summary.forgetting_summary.semantic_action_counts.retain, "number");
    assert.equal(
      body.execution_summary.forgetting_summary.semantic_action_counts.archive
        + body.execution_summary.forgetting_summary.semantic_action_counts.demote
        + body.execution_summary.forgetting_summary.semantic_action_counts.retain
        + body.execution_summary.forgetting_summary.semantic_action_counts.review
        >= 1,
      true,
    );
    assert.equal(typeof body.execution_summary.forgetting_summary.lifecycle_state_counts.active, "number");
    assert.equal(
      body.execution_summary.forgetting_summary.archive_relocation_state_counts.none
        + body.execution_summary.forgetting_summary.archive_relocation_state_counts.candidate
        + body.execution_summary.forgetting_summary.archive_relocation_state_counts.cold_archive
        >= 1,
      true,
    );
    assert.equal(
      body.execution_summary.forgetting_summary.archive_relocation_target_counts.none
        + body.execution_summary.forgetting_summary.archive_relocation_target_counts.local_cold_store
        + body.execution_summary.forgetting_summary.archive_relocation_target_counts.external_object_store
        >= 1,
      true,
    );
    assert.equal(
      body.execution_summary.forgetting_summary.archive_payload_scope_counts.none
        + body.execution_summary.forgetting_summary.archive_payload_scope_counts.anchor_payload
        + body.execution_summary.forgetting_summary.archive_payload_scope_counts.node
        >= 1,
      true,
    );
    assert.equal(body.execution_summary.forgetting_summary.rehydration_mode_counts.partial >= 1, true);
    assert.equal(
      body.execution_summary.forgetting_summary.differential_rehydration_candidate_count,
      body.execution_summary.forgetting_summary.rehydration_mode_counts.differential,
    );
    assert.deepEqual(body.execution_summary.forgetting_summary.primary_savings_levers, []);
    assert.equal(body.execution_summary.forgetting_summary.stale_signal_count, 1);
    assert.equal(
      body.execution_summary.forgetting_summary.recommended_action,
      body.execution_summary.maintenance_summary.recommended_action,
    );
    assert.equal(
      body.execution_summary.collaboration_routing_summary.summary_version,
      "execution_collaboration_routing_v1",
    );
    assert.equal(body.execution_summary.collaboration_routing_summary.route_mode, "memory_only");
    assert.equal(body.execution_summary.collaboration_routing_summary.coordination_mode, "memory_only");
    assert.equal(body.execution_summary.collaboration_routing_summary.route_intent, "memory_guided");
    assert.equal(body.execution_summary.collaboration_routing_summary.task_brief, null);
    assert.equal(body.execution_summary.collaboration_routing_summary.current_stage, null);
    assert.equal(body.execution_summary.collaboration_routing_summary.active_role, null);
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
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.target_files, []);
    assert.deepEqual(
      body.execution_summary.collaboration_routing_summary.validation_paths,
      body.execution_summary.strategy_summary.selected_validation_paths,
    );
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.unresolved_blockers, []);
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.hard_constraints, []);
    assert.equal(body.execution_summary.collaboration_routing_summary.review_standard, null);
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.required_outputs, []);
    assert.deepEqual(body.execution_summary.collaboration_routing_summary.acceptance_checks, []);
    assert.deepEqual(
      body.execution_summary.collaboration_routing_summary.preferred_artifact_refs,
      body.execution_summary.continuity_snapshot_summary.preferred_artifact_refs,
    );
    assert.deepEqual(
      body.execution_summary.collaboration_routing_summary.preferred_evidence_refs,
      body.execution_summary.continuity_snapshot_summary.preferred_evidence_refs,
    );
    for (const driver of [
      `family_scope:${body.execution_summary.routing_signal_summary.family_scope}`,
      "artifact_preference",
      "stable_workflow_available",
      "rehydration_candidate_available",
    ]) {
      assert.ok(body.execution_summary.collaboration_routing_summary.routing_drivers.includes(driver));
    }
    assert.equal(
      body.execution_summary.delegation_records_summary.summary_version,
      "execution_delegation_records_v1",
    );
    assert.equal(body.execution_summary.delegation_records_summary.record_mode, "memory_only");
    assert.equal(body.execution_summary.delegation_records_summary.route_role, "orchestrator");
    assert.equal(body.execution_summary.delegation_records_summary.packet_count, 1);
    assert.equal(body.execution_summary.delegation_records_summary.return_count, 0);
    assert.ok(body.execution_summary.delegation_records_summary.missing_record_types.includes("delegation_returns"));
    const packetRecord = body.execution_summary.delegation_records_summary.delegation_packets[0];
    assert.equal(packetRecord.role, "orchestrator");
    assert.ok(packetRecord.mission.length > 0);
    assert.deepEqual(packetRecord.preferred_artifact_refs, body.execution_summary.collaboration_routing_summary.preferred_artifact_refs);
    assert.deepEqual(packetRecord.inherited_evidence, []);
    assert.equal(packetRecord.task_family, body.execution_summary.collaboration_routing_summary.task_family);
    assert.equal(packetRecord.family_scope, body.execution_summary.collaboration_routing_summary.family_scope);
    assert.equal(packetRecord.source_mode, "memory_only");
    assert.equal(
      body.execution_summary.delegation_records_summary.artifact_routing_count,
      body.execution_summary.collaboration_routing_summary.preferred_artifact_refs.length,
    );
    assert.ok(
      body.execution_summary.delegation_records_summary.artifact_routing_records.every(
        (record) =>
          record.ref_kind === "artifact"
          && record.route_role === "orchestrator"
          && record.route_intent === "memory_guided"
          && record.route_mode === "memory_only"
          && record.source === "strategy_summary",
      ),
    );
    assert.equal(body.execution_summary.instrumentation_summary.summary_version, "execution_instrumentation_summary_v1");
    assert.equal(
      body.execution_summary.instrumentation_summary.rehydration_candidate_count,
      body.action_packet_summary.rehydration_candidate_count,
    );
    assert.deepEqual(body.execution_summary.action_packet_summary, body.action_packet_summary);
    assert.deepEqual(body.execution_summary.pattern_signal_summary, body.pattern_signal_summary);
    assert.deepEqual(body.execution_summary.workflow_signal_summary, body.workflow_signal_summary);
    assert.deepEqual(body.execution_summary.workflow_lifecycle_summary, body.workflow_lifecycle_summary);
    assert.deepEqual(body.execution_summary.workflow_maintenance_summary, body.workflow_maintenance_summary);
    assert.deepEqual(body.execution_summary.pattern_lifecycle_summary, body.pattern_lifecycle_summary);
    assert.deepEqual(body.execution_summary.pattern_maintenance_summary, body.pattern_maintenance_summary);
    assert.equal(body.pattern_signal_summary.trusted_pattern_count, 1);
    assert.equal(body.pattern_signal_summary.contested_pattern_count, 1);
    assert.equal(body.pattern_signal_summary.candidate_pattern_count, 0);
    assert.equal(body.action_packet_summary.recommended_workflow_count, 1);
    assert.equal(body.action_packet_summary.candidate_workflow_count, 1);
    assert.equal(body.workflow_lifecycle_summary.promotion_ready_count, 1);
    assert.equal(body.workflow_maintenance_summary.observe_count, 1);
    assert.equal(body.workflow_maintenance_summary.retain_count, 1);
    assert.equal(body.pattern_maintenance_summary.retain_count, 1);
    assert.equal(body.pattern_maintenance_summary.review_count, 1);
    assert.equal(body.trusted_patterns[0]?.suppressed, true);
    assert.equal(body.trusted_patterns[0]?.suppression_mode, "shadow_learn");
    assert.equal(body.trusted_patterns[0]?.trust_hardening?.promotion_gate_kind, "current_distinct_runs_v1");
    assert.equal(body.trusted_patterns[0]?.trust_hardening?.task_affinity_weighting_enabled, true);
    assert.equal(body.contested_patterns[0]?.trust_hardening?.post_contest_distinct_run_count, 2);
    assert.equal(body.contested_patterns[0]?.trust_hardening?.revalidation_floor_kind, "post_contest_two_fresh_runs_v1");
    assert.ok(body.pattern_signals.some((entry) => entry.anchor_id === body.trusted_patterns[0]?.anchor_id && entry.trust_hardening?.promotion_gate_kind === "current_distinct_runs_v1"));
    assert.ok(body.pattern_signals.some((entry) => entry.anchor_id === body.trusted_patterns[0]?.anchor_id && entry.suppressed === true));
    assert.equal(body.candidate_workflows[0]?.projection_generated_by, "execution_write_projection_v1");
    assert.equal(body.candidate_workflows[0]?.projection_source_client_id, "execution-event:ready");
    assert.match(body.operator_surface.headline, /stable workflows=1/);
    assert.match(body.operator_surface.headline, /promotion-ready workflows=1/);
    assert.match(body.operator_surface.headline, /trusted patterns=1/);
    assert.match(body.operator_surface.headline, /contested patterns=1/);
    assert.ok(body.operator_surface.sections.workflows.some((line) => line.includes("stable workflow: Fix export failure")));
    assert.ok(body.operator_surface.sections.workflows.some((line) => line.includes("promotion=ready")));
    assert.ok(body.operator_surface.sections.workflows.some((line) => line.includes("projection=execution_write_projection_v1")));
    assert.ok(body.operator_surface.sections.patterns.some((line) => line.includes("trusted pattern: prefer edit")));
    assert.ok(body.operator_surface.sections.patterns.some((line) => line.includes("suppressed=shadow_learn")));
    assert.ok(body.operator_surface.sections.patterns.some((line) => line.includes("contested pattern: prefer bash")));
    assert.ok(body.operator_surface.sections.maintenance.some((line) => line.includes("workflow maintenance:")));
    assert.ok(body.operator_surface.sections.maintenance.some((line) => line.includes("pattern maintenance:")));
    assert.match(body.operator_surface.merged_text, /# Execution Memory Operator Surface/);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("execution introspection prefers recent persisted delegation records over derived defaults", async () => {
  const dbPath = tmpDbPath("execution-introspect-delegation-records");
  const app = Fastify();
  const { liteWriteStore } = await seedExecutionIntrospectionFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerMemoryAccessRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        APP_ENV: "test",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10_000,
        PII_REDACTION: false,
        ALLOW_CROSS_SCOPE_EDGES: false,
      } as any,
      embedder: null,
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const writeResponse = await app.inject({
      method: "POST",
      url: "/v1/memory/delegation/records",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "review-worker",
        route_role: "review",
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
              mission: "Review the export fix and verify the final test run.",
              working_set: ["src/routes/export.ts"],
              acceptance_checks: ["npm run -s test:lite -- export"],
              output_contract: "Return the review disposition with attached evidence.",
              preferred_artifact_refs: ["artifact://patch/export.diff"],
              inherited_evidence: ["evidence://tests/export.log"],
              routing_reason: "Recent persisted review packet for execution introspection.",
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
              summary: "Review completed with export validations passing.",
              evidence: ["evidence://tests/export.log"],
              working_set: ["src/routes/export.ts"],
              acceptance_checks: ["npm run -s test:lite -- export"],
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
              routing_reason: "Recent patch artifact for reviewer context.",
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
              routing_reason: "Recent test evidence for reviewer context.",
              source: "execution_packet",
            },
          ],
        },
      },
    });
    assert.equal(writeResponse.statusCode, 200);
    const writeBody = DelegationRecordsWriteResponseSchema.parse(writeResponse.json());
    assert.equal(writeBody.delegation_records_v1.return_count, 1);

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = ExecutionMemoryIntrospectionResponseSchema.parse(response.json());
    assert.equal(body.execution_summary.delegation_records_summary.record_mode, "packet_backed");
    assert.equal(body.execution_summary.delegation_records_summary.route_role, "review");
    assert.equal(body.execution_summary.delegation_records_summary.packet_count, 1);
    assert.equal(body.execution_summary.delegation_records_summary.return_count, 1);
    assert.deepEqual(body.execution_summary.delegation_records_summary.missing_record_types, []);
    assert.equal(
      body.execution_summary.delegation_records_summary.delegation_returns[0]?.summary,
      "Review completed with export validations passing.",
    );
    assert.deepEqual(
      body.execution_summary.delegation_records_summary.artifact_routing_records.map((record) => record.ref),
      ["artifact://patch/export.diff", "evidence://tests/export.log"],
    );
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("execution introspection operator workflow lines keep source and tools for execution-native-only stable workflows", async () => {
  const dbPath = tmpDbPath("execution-introspect-execution-native-only");
  const app = Fastify();
  const { liteWriteStore } = await seedExecutionNativeOnlyWorkflowIntrospectionFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerMemoryAccessRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        APP_ENV: "test",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10_000,
        PII_REDACTION: false,
        ALLOW_CROSS_SCOPE_EDGES: false,
      } as any,
      embedder: null,
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = ExecutionMemoryIntrospectionResponseSchema.parse(response.json());
    assert.equal(body.recommended_workflows.length, 1);
    assert.equal(body.inventory.continuity_auto_promoted_workflow_count, 1);
    assert.equal(body.execution_summary.summary_version, "execution_summary_v1");
    assert.equal(body.execution_summary.strategy_summary.summary_version, "execution_strategy_summary_v1");
    assert.equal(body.execution_summary.collaboration_summary.summary_version, "execution_collaboration_summary_v1");
    assert.equal(body.execution_summary.continuity_snapshot_summary.summary_version, "execution_continuity_snapshot_v1");
    assert.equal(body.execution_summary.routing_signal_summary.summary_version, "execution_routing_summary_v1");
    assert.deepEqual(body.execution_summary.action_packet_summary, body.action_packet_summary);
    assert.ok(body.operator_surface.sections.workflows.some((line) => line.includes("source=playbook")));
    assert.ok(body.operator_surface.sections.workflows.some((line) => line.includes("tools=edit, test")));
    assert.ok(body.operator_surface.sections.workflows.some((line) => line.includes("projection=execution_write_projection_v1")));
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("execution introspection derives workflow fields through canonical execution contract surface", async () => {
  const dbPath = tmpDbPath("execution-introspect-canonical-contract-precedence");
  const app = Fastify();
  const { liteWriteStore } = await seedCanonicalContractPrecedenceIntrospectionFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerMemoryAccessRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        APP_ENV: "test",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10_000,
        PII_REDACTION: false,
        ALLOW_CROSS_SCOPE_EDGES: false,
      } as any,
      embedder: null,
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = ExecutionMemoryIntrospectionResponseSchema.parse(response.json());
    const workflow = body.recommended_workflows[0];
    assert.equal(workflow?.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(workflow?.contract_trust, "authoritative");
    assert.equal((workflow as any)?.outcome_contract_gate?.allows_authoritative, true);
    assert.equal(body.outcome_contract_gate_summary.authoritative_allowed_count, 1);
    assert.equal(workflow?.task_family, "task:canonical_export_repair");
    assert.equal(workflow?.task_signature, "canonical-export-repair");
    assert.equal(workflow?.workflow_signature, "execution_workflow:canonical-export-repair");
    assert.equal(workflow?.file_path, "src/routes/canonical-export.ts");
    assert.deepEqual(workflow?.target_files, ["src/routes/canonical-export.ts"]);
    assert.equal(workflow?.next_action, "Follow the canonical execution contract next action.");
    assert.deepEqual(workflow?.workflow_steps, ["inspect canonical export failure", "patch canonical export route", "rerun canonical export checks"]);
    assert.deepEqual(workflow?.pattern_hints, ["canonical pattern hint"]);
    assert.deepEqual(
      workflow?.service_lifecycle_constraints.map((constraint) => constraint.label),
      ["canonical export preview"],
    );
    assert.equal(workflow?.service_lifecycle_constraints[0]?.must_survive_agent_exit, true);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});
