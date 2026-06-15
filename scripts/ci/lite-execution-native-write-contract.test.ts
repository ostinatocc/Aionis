import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryAnchorV1Schema } from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-execution-native-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildContinuityPayload(filePath: string) {
  return {
    execution_state_v1: {
      task_brief: "Recover durable workflow from failed validation",
      owned_files: [],
      modified_files: [filePath],
      resume_anchor: {
        anchor: `resume:${filePath}`,
        file_path: filePath,
        symbol: null,
        repo_root: "/Volumes/ziel/Aionisgo",
      },
    },
    execution_packet_v1: {
      target_files: [filePath],
      next_action: `Patch ${filePath} and rerun export tests`,
      resume_anchor: {
        anchor: `resume:${filePath}`,
        file_path: filePath,
        symbol: null,
        repo_root: "/Volumes/ziel/Aionisgo",
      },
    },
  };
}

test("prepare/apply write normalizes execution-native metadata for anchors and distillation outputs", async () => {
  const dbPath = tmpDbPath("normalize");
  const store = createLiteWriteStore(dbPath);
  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "workflow-validation-recovery-node-tests",
    error_signature: "workflow-validation-mismatch",
    workflow_signature: "inspect-patch-rerun",
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
    schema_version: "anchor_v1",
  });
  const patternAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    task_signature: "tools_select:workflow-validation-recovery",
    task_family: "task:workflow_validation_recovery",
    error_signature: "workflow-validation-mismatch",
    error_family: "error:workflow-validation-mismatch",
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
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: [
          "Task Signature: workflow-validation-recovery-node-tests",
          "Error Signature: workflow-validation-mismatch",
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
            type: "procedure",
            title: "Recover workflow validation failure",
            text_summary: workflowAnchor.summary,
            slots: {
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              anchor_v1: workflowAnchor,
            },
          },
          {
            type: "concept",
            title: "Stable edit pattern",
            text_summary: patternAnchor.summary,
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: patternAnchor,
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

    const workflowPrepared = prepared.nodes.find((node) => node.slots?.summary_kind === "workflow_anchor");
    const patternPrepared = prepared.nodes.find((node) => node.slots?.summary_kind === "pattern_anchor");
    const distilledEvidencePrepared = prepared.nodes.find(
      (node) => node.slots?.summary_kind === "write_distillation_evidence",
    );
    const distilledFactPrepared = prepared.nodes.find((node) => node.slots?.summary_kind === "write_distillation_fact");
    const taskSignatureFactPrepared = prepared.nodes.find(
      (node) => node.slots?.summary_kind === "write_distillation_fact" && node.title === "Task Signature",
    );
    const errorSignatureFactPrepared = prepared.nodes.find(
      (node) => node.slots?.summary_kind === "write_distillation_fact" && node.title === "Error Signature",
    );
    const workflowSignatureFactPrepared = prepared.nodes.find(
      (node) => node.slots?.summary_kind === "write_distillation_fact" && node.title === "Workflow Signature",
    );
    assert.ok(workflowPrepared);
    assert.ok(patternPrepared);
    assert.ok(distilledEvidencePrepared);
    assert.ok(distilledFactPrepared);
    assert.ok(taskSignatureFactPrepared);
    assert.ok(errorSignatureFactPrepared);
    assert.ok(workflowSignatureFactPrepared);
    assert.equal(workflowPrepared?.slots.execution_native_v1.execution_kind, "workflow_anchor");
    assert.equal(workflowPrepared?.slots.execution_native_v1.task_signature, "workflow-validation-recovery-node-tests");
    assert.equal(workflowPrepared?.slots.execution_native_v1.error_signature, "workflow-validation-mismatch");
    assert.equal(workflowPrepared?.slots.abstraction_boundary_v1?.boundary_version, "abstraction_boundary_v1");
    assert.equal(workflowPrepared?.slots.abstraction_boundary_v1?.abstraction_kind, "workflow");
    assert.ok(workflowPrepared?.slots.abstraction_boundary_v1?.applies_when.includes("task_signature=workflow-validation-recovery-node-tests"));
    assert.ok(workflowPrepared?.slots.abstraction_boundary_v1?.applies_when.includes("workflow_signature=inspect-patch-rerun"));
    assert.ok(workflowPrepared?.slots.abstraction_boundary_v1?.source_episode_refs.includes(workflowAnchor.source.node_id));
    assert.equal(
      workflowPrepared?.slots.execution_native_v1.abstraction_boundary_v1?.gate_contract,
      "raw_episode_first_bounded_abstraction",
    );
    assert.equal(workflowPrepared?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(workflowPrepared?.slots.execution_contract_v1?.task_signature, "workflow-validation-recovery-node-tests");
    assert.equal(workflowPrepared?.slots.execution_contract_v1?.workflow_signature, "inspect-patch-rerun");
    assert.equal(workflowPrepared?.slots.execution_contract_v1?.provenance?.source_kind, "slot_projection");
    assert.equal(workflowPrepared?.slots.semantic_forgetting_v1?.action, "retain");
    assert.equal(workflowPrepared?.slots.archive_relocation_v1?.relocation_state, "none");
    assert.ok(typeof workflowPrepared?.salience === "number");
    assert.equal(patternPrepared?.slots.execution_native_v1.execution_kind, "pattern_anchor");
    assert.equal(patternPrepared?.slots.execution_native_v1.pattern_state, "stable");
    assert.equal(patternPrepared?.slots.execution_native_v1.selected_tool, "edit");
    assert.equal(patternPrepared?.slots.abstraction_boundary_v1?.abstraction_kind, "pattern");
    assert.ok(patternPrepared?.slots.abstraction_boundary_v1?.applies_when.includes("pattern_signature=stable-edit-pattern"));
    assert.ok(patternPrepared?.slots.abstraction_boundary_v1?.applies_when.includes("error_signature=workflow-validation-mismatch"));
    assert.ok(patternPrepared?.slots.abstraction_boundary_v1?.source_episode_refs.includes(patternAnchor.source.decision_id));
    assert.ok(patternPrepared?.slots.abstraction_boundary_v1?.source_episode_refs.includes(patternAnchor.payload_refs.run_ids[0]));
    assert.deepEqual(patternPrepared?.slots.abstraction_boundary_v1?.counterexamples, []);
    assert.equal(patternPrepared?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(patternPrepared?.slots.execution_contract_v1?.selected_tool, "edit");
    assert.equal(patternPrepared?.slots.execution_contract_v1?.task_family, "task:workflow_validation_recovery");
    assert.equal(distilledEvidencePrepared?.slots.execution_native_v1.execution_kind, "distilled_evidence");
    assert.equal(distilledEvidencePrepared?.slots.execution_native_v1.distillation?.preferred_promotion_target, "workflow");
    assert.equal(distilledEvidencePrepared?.slots.execution_native_v1.maintenance?.offline_priority, "promote_to_workflow");
    assert.equal(distilledEvidencePrepared?.slots.abstraction_boundary_v1?.abstraction_kind, "distillation");
    assert.ok(
      distilledEvidencePrepared?.slots.abstraction_boundary_v1?.source_episode_refs.some((ref: string) =>
        ref.startsWith("source_sha256:")
      ),
    );
    assert.equal(distilledEvidencePrepared?.slots.execution_contract_v1 ?? null, null);
    assert.equal(distilledFactPrepared?.slots.execution_native_v1.execution_kind, "distilled_fact");
    assert.equal(distilledFactPrepared?.slots.execution_native_v1.compression_layer, "L1");
    assert.equal(distilledFactPrepared?.slots.execution_native_v1.distillation?.preferred_promotion_target, "workflow");
    assert.equal(distilledFactPrepared?.slots.execution_native_v1.distillation?.extraction_pattern, "colon");
    assert.equal(distilledFactPrepared?.slots.execution_native_v1.maintenance?.offline_priority, "promote_to_workflow");
    assert.equal(distilledFactPrepared?.slots.abstraction_boundary_v1?.abstraction_kind, "distillation");
    assert.ok(
      distilledFactPrepared?.slots.abstraction_boundary_v1?.source_episode_refs.some((ref: string) =>
        ref.startsWith("source_sha256:")
      ),
    );
    assert.equal(taskSignatureFactPrepared?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(taskSignatureFactPrepared?.slots.execution_contract_v1?.task_signature, "workflow-validation-recovery-node-tests");
    assert.equal(taskSignatureFactPrepared?.slots.execution_contract_v1?.provenance?.source_kind, "write_distillation");
    assert.equal(errorSignatureFactPrepared?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(workflowSignatureFactPrepared?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(workflowSignatureFactPrepared?.slots.execution_contract_v1?.workflow_signature, "inspect-patch-rerun");
    assert.equal(taskSignatureFactPrepared?.slots.execution_native_v1.task_signature, "workflow-validation-recovery-node-tests");
    assert.equal(errorSignatureFactPrepared?.slots.execution_native_v1.error_signature, "workflow-validation-mismatch");
    assert.equal(workflowSignatureFactPrepared?.slots.execution_native_v1.workflow_signature, "inspect-patch-rerun");

    await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const { rows } = await store.findNodes({
      scope: "default",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const storedWorkflow = rows.find((row) => row.slots?.summary_kind === "workflow_anchor");
    const storedPattern = rows.find((row) => row.slots?.summary_kind === "pattern_anchor");
    const storedDistilledEvidence = rows.find((row) => row.slots?.summary_kind === "write_distillation_evidence");
    const storedDistilledFact = rows.find((row) => row.slots?.summary_kind === "write_distillation_fact");
    const storedTaskSignatureFact = rows.find(
      (row) => row.slots?.summary_kind === "write_distillation_fact" && row.title === "Task Signature",
    );
    const storedErrorSignatureFact = rows.find(
      (row) => row.slots?.summary_kind === "write_distillation_fact" && row.title === "Error Signature",
    );
    const storedWorkflowSignatureFact = rows.find(
      (row) => row.slots?.summary_kind === "write_distillation_fact" && row.title === "Workflow Signature",
    );
    assert.equal(storedWorkflow?.slots.execution_native_v1.anchor_kind, "workflow");
    assert.equal(storedWorkflow?.slots.abstraction_boundary_v1?.abstraction_kind, "workflow");
    assert.ok(storedWorkflow?.slots.applies_when.includes("workflow_signature=inspect-patch-rerun"));
    assert.equal(storedWorkflow?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(storedWorkflow?.slots.execution_contract_v1?.workflow_signature, "inspect-patch-rerun");
    assert.equal(storedPattern?.slots.execution_native_v1.anchor_kind, "pattern");
    assert.equal(storedPattern?.slots.abstraction_boundary_v1?.abstraction_kind, "pattern");
    assert.ok(storedPattern?.slots.source_episode_refs.includes(patternAnchor.source.decision_id));
    assert.equal(storedPattern?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(storedPattern?.slots.execution_contract_v1?.selected_tool, "edit");
    assert.equal(storedDistilledEvidence?.slots.execution_native_v1.execution_kind, "distilled_evidence");
    assert.equal(storedDistilledEvidence?.slots.abstraction_boundary_v1?.abstraction_kind, "distillation");
    assert.equal(storedDistilledEvidence?.slots.execution_native_v1.distillation?.preferred_promotion_target, "workflow");
    assert.equal(storedDistilledEvidence?.slots.execution_contract_v1 ?? null, null);
    assert.equal(storedDistilledFact?.slots.execution_native_v1.execution_kind, "distilled_fact");
    assert.equal(storedDistilledFact?.slots.execution_native_v1.distillation?.preferred_promotion_target, "workflow");
    assert.equal(storedDistilledFact?.slots.execution_native_v1.maintenance?.offline_priority, "promote_to_workflow");
    assert.equal(storedTaskSignatureFact?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(storedTaskSignatureFact?.slots.execution_contract_v1?.task_signature, "workflow-validation-recovery-node-tests");
    assert.equal(storedTaskSignatureFact?.slots.execution_contract_v1?.provenance?.source_kind, "write_distillation");
    assert.equal(storedWorkflowSignatureFact?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(storedWorkflowSignatureFact?.slots.execution_contract_v1?.workflow_signature, "inspect-patch-rerun");
    assert.equal(storedWorkflow?.slots.semantic_forgetting_v1?.action, "retain");
    assert.equal(storedWorkflow?.slots.archive_relocation_v1?.relocation_state, "none");
    assert.equal(storedTaskSignatureFact?.slots.execution_native_v1.task_signature, "workflow-validation-recovery-node-tests");
    assert.equal(storedErrorSignatureFact?.slots.execution_native_v1.error_signature, "workflow-validation-mismatch");
    assert.equal(storedWorkflowSignatureFact?.slots.execution_native_v1.workflow_signature, "inspect-patch-rerun");
  } finally {
    await store.close();
  }
});

test("lite write store exposes execution-first query filters over execution_native_v1", async () => {
  const dbPath = tmpDbPath("query");
  const store = createLiteWriteStore(dbPath);
  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "workflow-validation-recovery-node-tests",
    error_signature: "workflow-validation-mismatch",
    workflow_signature: "inspect-patch-rerun",
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
    schema_version: "anchor_v1",
  });
  const patternAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    task_signature: "tools_select:workflow-validation-recovery",
    task_family: "task:workflow_validation_recovery",
    error_signature: "workflow-validation-mismatch",
    error_family: "error:workflow-validation-mismatch",
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
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: [
          "Task Signature: workflow-validation-recovery-node-tests",
          "Error Signature: workflow-validation-mismatch",
          "Workflow Signature: inspect-patch-rerun",
          "Execution-native query contract should keep signature facts addressable.",
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
            type: "procedure",
            title: "Recover workflow validation failure",
            text_summary: workflowAnchor.summary,
            slots: {
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              anchor_v1: workflowAnchor,
            },
          },
          {
            type: "concept",
            title: "Stable edit pattern",
            text_summary: patternAnchor.summary,
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: patternAnchor,
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
    await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const workflowRows = await store.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "workflow_anchor",
      taskSignature: "workflow-validation-recovery-node-tests",
      compressionLayer: "L2",
      limit: 10,
      offset: 0,
    });
    assert.equal(workflowRows.rows.length, 1);
    assert.equal(workflowRows.rows[0]?.execution_native.anchor_kind, "workflow");

    const patternRows = await store.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "pattern_anchor",
      anchorKind: "pattern",
      patternState: "stable",
      patternSignature: "stable-edit-pattern",
      limit: 10,
      offset: 0,
    });
    assert.equal(patternRows.rows.length, 1);
    assert.equal(patternRows.rows[0]?.execution_native.selected_tool, "edit");

    const signatureFactRows = await store.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "distilled_fact",
      taskSignature: "workflow-validation-recovery-node-tests",
      limit: 10,
      offset: 0,
    });
    assert.equal(signatureFactRows.rows.length, 1);
    assert.equal(signatureFactRows.rows[0]?.title, "Task Signature");
  } finally {
    await store.close();
  }
});

test("lite write store finds older execution-native nodes beyond ordinary memory window", async () => {
  const dbPath = tmpDbPath("execution-window");
  const store = createLiteWriteStore(dbPath);
  const targetFile = "src/runtime/recover.ts";
  try {
    const executionPrepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "Store an older execution-native runtime handoff.",
        auto_embed: false,
        nodes: [
          {
            type: "event",
            title: "Recover runtime handoff",
            text_summary: "Continue the runtime recovery path from the active handoff.",
            slots: {
              summary_kind: "handoff",
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "execution_native",
                summary_kind: "handoff",
                compression_layer: "L0",
                file_path: targetFile,
                target_files: [targetFile],
                next_action: `Patch ${targetFile} and rerun runtime tests`,
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
    await store.withTx(() =>
      applyMemoryWrite(executionPrepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const ordinaryPrepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "Store ordinary memories after the execution-native handoff.",
        auto_embed: false,
        nodes: Array.from({ length: 80 }, (_, index) => ({
          type: "event",
          title: `Ordinary memory ${index}`,
          text_summary: `Ordinary non-execution memory ${index}`,
          slots: { category: "ordinary", index },
        })),
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
    await store.withTx(() =>
      applyMemoryWrite(ordinaryPrepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const rows = await store.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "execution_native",
      compressionLayer: "L0",
      limit: 1,
      offset: 0,
    });

    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.execution_native.file_path, targetFile);
    assert.equal(rows.has_more, false);
  } finally {
    await store.close();
  }
});

test("prepare/apply write normalizes execution-native metadata for handoff and session continuity carriers", async () => {
  const dbPath = tmpDbPath("continuity");
  const store = createLiteWriteStore(dbPath);
  const filePath = "src/routes/export.ts";
  const continuity = buildContinuityPayload(filePath);
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "resume export repair continuity",
        auto_embed: false,
        nodes: [
          {
            type: "event",
            title: "Export repair handoff",
            text_summary: "Recover durable workflow from failed validation",
            slots: {
              summary_kind: "handoff",
              handoff_kind: "patch_handoff",
              anchor: `resume:${filePath}`,
              file_path: filePath,
              target_files: [filePath],
              next_action: `Patch ${filePath} and rerun export tests`,
              handoff_text: "Resume export repair",
              ...continuity,
            },
          },
          {
            type: "event",
            title: "Export session event",
            text_summary: "Recover durable workflow from failed validation",
            slots: {
              system_kind: "session_event",
              session_id: "session-export",
              event_id: randomUUID(),
              ...continuity,
            },
          },
          {
            type: "topic",
            title: "Session session-export",
            text_summary: "Session session-export",
            slots: {
              system_kind: "session",
              session_id: "session-export",
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

    const preparedHandoff = prepared.nodes.find((node) => node.slots?.summary_kind === "handoff");
    const preparedSessionEvent = prepared.nodes.find((node) => node.slots?.system_kind === "session_event");
    const preparedSession = prepared.nodes.find((node) => node.slots?.system_kind === "session");
    assert.ok(preparedHandoff);
    assert.ok(preparedSessionEvent);
    assert.ok(preparedSession);
    assert.equal(preparedHandoff?.slots.execution_native_v1.execution_kind, "execution_native");
    assert.equal(preparedHandoff?.slots.execution_native_v1.summary_kind, "handoff");
    assert.equal(preparedHandoff?.slots.execution_native_v1.compression_layer, "L0");
    assert.equal(preparedHandoff?.slots.execution_native_v1.file_path, filePath);
    assert.deepEqual(preparedHandoff?.slots.execution_native_v1.target_files, [filePath]);
    assert.equal(preparedHandoff?.slots.execution_native_v1.next_action, `Patch ${filePath} and rerun export tests`);
    assert.equal(preparedHandoff?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(preparedHandoff?.slots.execution_contract_v1?.file_path, filePath);
    assert.deepEqual(preparedHandoff?.slots.execution_contract_v1?.target_files, [filePath]);
    assert.equal(preparedSessionEvent?.slots.execution_native_v1.execution_kind, "execution_native");
    assert.equal(preparedSessionEvent?.slots.execution_native_v1.summary_kind, "session_event");
    assert.equal(preparedSessionEvent?.slots.execution_native_v1.compression_layer, "L0");
    assert.equal(preparedSessionEvent?.slots.execution_native_v1.file_path, filePath);
    assert.deepEqual(preparedSessionEvent?.slots.execution_native_v1.target_files, [filePath]);
    assert.equal(preparedSessionEvent?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(preparedSessionEvent?.slots.execution_contract_v1?.file_path, filePath);
    assert.equal(preparedSession?.slots.execution_native_v1.execution_kind, "execution_native");
    assert.equal(preparedSession?.slots.execution_native_v1.summary_kind, "session");
    assert.equal(preparedSession?.slots.execution_native_v1.compression_layer, "L0");

    await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const continuityRows = await store.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "execution_native",
      compressionLayer: "L0",
      limit: 10,
      offset: 0,
    });
    assert.ok(continuityRows.rows.some((row) => row.execution_native.summary_kind === "handoff" && row.execution_native.file_path === filePath && row.slots?.execution_contract_v1?.file_path === filePath));
    assert.ok(continuityRows.rows.some((row) => row.execution_native.summary_kind === "session_event" && row.execution_native.file_path === filePath && row.slots?.execution_contract_v1?.file_path === filePath));
    assert.ok(continuityRows.rows.some((row) => row.execution_native.summary_kind === "session"));
  } finally {
    await store.close();
  }
});
