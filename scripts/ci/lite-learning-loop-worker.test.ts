import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sealAuthorityReceiptsForPreparedWrite } from "./authority-fixture-helpers.ts";
import { buildRuntimeAuthorityGate } from "../../src/memory/authority-gate.ts";
import { buildExecutionEvidenceFromValidation } from "../../src/memory/execution-evidence.ts";
import { ExecutionContractV1Schema } from "../../src/memory/execution-contract.ts";
import {
  buildWorkflowMaintenanceMetadata,
  buildWorkflowPromotionMetadata,
} from "../../src/memory/evolution-operators.ts";
import { ExecutionNativeV1Schema, PromotionEvidenceLedgerV1Schema } from "../../src/memory/schemas.ts";
import { runLearningLoopLite } from "../../src/memory/learning-loop.ts";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { stableUuid } from "../../src/util/uuid.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-learning-loop-"));
  return path.join(dir, `${name}.sqlite`);
}

const writeOpts = {
  defaultScope: "default",
  defaultTenantId: "default",
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
};

test("learning loop promotes evidence-gated workflow candidates into stable workflow memory", async () => {
  const dbPath = tmpDbPath("workflow");
  const store = createLiteWriteStore(dbPath);
  const now = "2026-05-23T00:00:00.000Z";
  const workflowSignature = "learning-loop:test:workflow";
  const candidateId = stableUuid(`default:node:learning-loop:candidate:${workflowSignature}`);
  const contract = ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: "authoritative",
    task_family: "task:learning_loop_test",
    task_signature: "learning-loop-test",
    workflow_signature: workflowSignature,
    policy_memory_id: null,
    selected_tool: "edit",
    file_path: "src/runtime.ts",
    target_files: ["src/runtime.ts"],
    next_action: "Apply the known runtime change and run the real verifier.",
    workflow_steps: ["inspect runtime state", "apply scoped change", "run verifier"],
    pattern_hints: ["prefer evidence before promotion"],
    service_lifecycle_constraints: [],
    outcome: {
      acceptance_checks: ["real verifier exits 0"],
      success_invariants: ["real verifier confirms runtime behavior"],
      dependency_requirements: [],
      environment_assumptions: [],
      must_hold_after_exit: [],
      external_visibility_requirements: [],
    },
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "learning_loop_test_v1",
      source_anchor: candidateId,
      evidence_refs: ["evidence://learning-loop/verifier-pass"],
      notes: [],
    },
  });
  const evidence = buildExecutionEvidenceFromValidation({
    validationPassed: true,
    validationBoundary: "external_verifier",
    evidenceRefs: ["evidence://learning-loop/verifier-pass"],
  });
  const {
    authorityGate,
    outcomeContractGate,
    executionEvidenceAssessment,
  } = buildRuntimeAuthorityGate({
    executionContract: contract,
    requestedTrust: "authoritative",
    evidence,
  });
  assert.equal(authorityGate.allows_authoritative, true);
  assert.equal(authorityGate.allows_stable_promotion, true);

  try {
    const candidateSlots = {
      summary_kind: "workflow_candidate",
      compression_layer: "L1",
      contract_trust: "authoritative",
      execution_contract_v1: contract,
      outcome_contract_gate: outcomeContractGate,
      execution_evidence_v1: evidence,
      execution_evidence_assessment: executionEvidenceAssessment,
      authority_gate_v1: authorityGate,
      execution_native_v1: ExecutionNativeV1Schema.parse({
        schema_version: "execution_native_v1",
        execution_kind: "workflow_candidate",
        summary_kind: "workflow_candidate",
        compression_layer: "L1",
        contract_trust: "authoritative",
        task_signature: "learning-loop-test",
        task_family: "task:learning_loop_test",
        workflow_signature: workflowSignature,
        anchor_kind: "workflow",
        anchor_level: "L1",
        tool_set: ["edit", "bash"],
        file_path: "src/runtime.ts",
        target_files: ["src/runtime.ts"],
        next_action: "Apply the known runtime change and run the real verifier.",
        workflow_steps: ["inspect runtime state", "apply scoped change", "run verifier"],
        pattern_hints: ["prefer evidence before promotion"],
        outcome_contract_gate: outcomeContractGate,
        workflow_promotion: buildWorkflowPromotionMetadata({
          promotion_state: "candidate",
          promotion_origin: "execution_write_projection",
          observed_count: 2,
          required_observations: 2,
          at: now,
        }),
        maintenance: buildWorkflowMaintenanceMetadata({
          promotion_state: "candidate",
          at: now,
        }),
      }),
    };
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "learning-loop-test",
        input_text: "seed evidence-gated workflow candidate",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [{
          id: candidateId,
          client_id: `learning-loop:candidate:${workflowSignature}`,
          type: "event",
          memory_lane: "shared",
          producer_agent_id: "learning-loop-test",
          title: "Learning loop workflow candidate",
          text_summary: "Candidate workflow with real verifier evidence and sufficient observations.",
          slots: candidateSlots,
          salience: 0.68,
          importance: 0.7,
          confidence: 0.8,
        }],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    await applyPreparedMemoryWrite(store, prepared, {
      maxTextLen: writeOpts.maxTextLen,
      piiRedaction: writeOpts.piiRedaction,
      allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
    });

    const dryRun = await runLearningLoopLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-test",
      mode: "dry_run",
      surfaces: ["workflow"],
    }, writeOpts);
    assert.equal(dryRun.applied_count, 0);
    assert.equal(dryRun.decisions[0]?.action, "promote_workflow");

    const applied = await runLearningLoopLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-test",
      mode: "apply",
      surfaces: ["workflow"],
    }, writeOpts);
    assert.equal(applied.applied_count, 1);
    assert.equal(applied.decisions[0]?.action, "promote_workflow");
    assert.equal(applied.decisions[0]?.source_code_change_allowed, false);
    assert.equal(applied.decisions[0]?.policy_mutation_v1?.source_code_change_allowed, false);

    const stable = await store.findExecutionNativeNodes({
      scope: "default",
      executionKind: "workflow_anchor",
      workflowSignature,
      limit: 10,
      offset: 0,
    });
    assert.equal(stable.rows.length, 1);
    assert.equal(stable.rows[0]?.type, "procedure");
    assert.equal(stable.rows[0]?.slots?.learning_loop_v1?.action, "promote_workflow");
    assert.equal(stable.rows[0]?.slots?.policy_mutation_v1?.target?.kind, "workflow_memory");
    const promotionLedger = PromotionEvidenceLedgerV1Schema.parse(stable.rows[0]?.slots?.promotion_evidence_ledger_v1);
    assert.equal(promotionLedger.transition, "L1_to_L2");
    assert.equal(promotionLedger.target_kind, "workflow");
    assert.equal(promotionLedger.verdict, "promotion_admitted");
    assert.equal(promotionLedger.source_code_change_allowed, false);
    assert.equal((stable.rows[0]?.slots?.anchor_v1 as any)?.promotion_evidence_ledger_v1?.ledger_id, promotionLedger.ledger_id);
    assert.equal((stable.rows[0]?.slots?.execution_native_v1 as any)?.promotion_evidence_ledger_v1?.ledger_id, promotionLedger.ledger_id);

    const secondRun = await runLearningLoopLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-test",
      mode: "apply",
      surfaces: ["workflow"],
    }, writeOpts);
    assert.equal(secondRun.applied_count, 0);
    assert.ok(secondRun.decisions.some((entry) => entry.reasons.includes("stable_workflow_already_exists")));
  } finally {
    await store.close();
  }
});

test("learning loop applies controlled forgetting tier transitions without deleting memory", async () => {
  const dbPath = tmpDbPath("forgetting");
  const store = createLiteWriteStore(dbPath);
  const retiredPolicyId = stableUuid("default:node:learning-loop:forgetting:retired-policy");
  const contestedPatternId = stableUuid("default:node:learning-loop:forgetting:contested-pattern");

  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "learning-loop-test",
        input_text: "seed memories that should be cooled by controlled forgetting",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            id: retiredPolicyId,
            client_id: "learning-loop:forgetting:retired-policy",
            type: "concept",
            tier: "cold",
            memory_lane: "shared",
            producer_agent_id: "learning-loop-test",
            title: "Retired policy memory",
            text_summary: "Retired policy with strong negative feedback should move to archive tier.",
            slots: {
              summary_kind: "policy_memory",
              compression_layer: "L4",
              policy_memory_state: "retired",
              feedback_negative: 4,
              feedback_quality: -0.8,
            },
            salience: 0.2,
            importance: 0.2,
            confidence: 0.2,
          },
          {
            id: contestedPatternId,
            client_id: "learning-loop:forgetting:contested-pattern",
            type: "concept",
            tier: "hot",
            memory_lane: "shared",
            producer_agent_id: "learning-loop-test",
            title: "Contested pattern memory",
            text_summary: "Contested pattern should be demoted one tier before any archive transition.",
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: {
                anchor_kind: "pattern",
                credibility_state: "contested",
              },
              feedback_positive: 1,
              feedback_negative: 2,
              feedback_quality: -0.2,
            },
            salience: 0.55,
            importance: 0.55,
            confidence: 0.55,
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    await applyPreparedMemoryWrite(store, prepared, {
      maxTextLen: writeOpts.maxTextLen,
      piiRedaction: writeOpts.piiRedaction,
      allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
    });

    const dryRun = await runLearningLoopLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-test",
      mode: "dry_run",
      surfaces: ["forgetting"],
      limit: 10,
    }, writeOpts);
    assert.equal(dryRun.applied_count, 0);
    assert.ok(dryRun.decisions.some((entry) => entry.target_id === retiredPolicyId && entry.action === "archive_memory"));
    assert.ok(dryRun.decisions.some((entry) => entry.target_id === contestedPatternId && entry.action === "demote_memory"));

    const applied = await runLearningLoopLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-test",
      mode: "apply",
      surfaces: ["forgetting"],
      limit: 10,
    }, writeOpts);
    assert.equal(applied.applied_count, 2);
    assert.ok(applied.decisions.every((entry) => entry.source_code_change_allowed === false));

    const archived = await store.findNodes({
      scope: "default",
      id: retiredPolicyId,
      limit: 1,
      offset: 0,
    });
    assert.equal(archived.rows.length, 1);
    assert.equal(archived.rows[0]?.tier, "archive");
    assert.equal(archived.rows[0]?.slots?.learning_loop_v1?.action, "archive_memory");
    assert.equal(archived.rows[0]?.slots?.controlled_forgetting_v1?.source_code_change_allowed, false);

    const demoted = await store.findNodes({
      scope: "default",
      id: contestedPatternId,
      limit: 1,
      offset: 0,
    });
    assert.equal(demoted.rows.length, 1);
    assert.equal(demoted.rows[0]?.tier, "warm");
    assert.equal(demoted.rows[0]?.slots?.learning_loop_v1?.action, "demote_memory");
    assert.equal(demoted.rows[0]?.slots?.semantic_forgetting_v1?.action, "demote");
  } finally {
    await store.close();
  }
});
