import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPromotionEvidenceLedgerV1 } from "../../src/memory/promotion-evidence-ledger.ts";
import { scanRuntimeEffectSummaryLite } from "../../src/memory/runtime-effect-summary.ts";
import { runRuntimeMaintenanceLite } from "../../src/memory/runtime-maintenance.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { RuntimeEffectSummaryV1Schema } from "../../src/memory/schemas.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-runtime-effect-"));
  return path.join(dir, `${name}.sqlite`);
}

const writeOpts = {
  defaultScope: "default",
  defaultTenantId: "default",
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
};

test("runtime effect summary measures persisted Runtime evidence without claiming baseline proof", async () => {
  const dbPath = tmpDbPath("summary");
  const store = createLiteWriteStore(dbPath);
  try {
    const promotionLedger = buildPromotionEvidenceLedgerV1({
      targetKind: "workflow",
      targetId: "workflow:runtime-effect",
      sourceLayers: ["L1"],
      targetLayer: "L2",
      transition: "L1_to_L2",
      promotionState: "stable",
      promotionOrigin: "learning_loop",
      observedCount: 3,
      requiredCount: 2,
      authorityGateAdmitted: true,
      learningControlAdmitted: true,
      verifierStatus: "succeeded",
      contractTrust: "authoritative",
      sourceNodeIds: ["node:runtime-effect-source"],
      sourceRunIds: ["run:runtime-effect-1", "run:runtime-effect-2"],
      sourceCommitIds: ["commit:runtime-effect"],
      promotionEvidenceRefs: ["run:runtime-effect-1", "run:runtime-effect-2"],
      evidence: [{
        evidence_id: "evidence:runtime-effect-promotion",
        evidence_kind: "learning_control",
        polarity: "positive",
        source_ref: "run:runtime-effect-2",
        claim: "Stable workflow promotion was admitted by real Runtime evidence.",
        confidence: 0.94,
      }],
    });

    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "Persist Runtime effect evidence for measurement.",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            client_id: "runtime-effect-success",
            type: "event",
            title: "Runtime effect success signal",
            text_summary: "Verifier passed, workflow reuse succeeded, and context stayed within budget.",
            slots: {
              execution_result_summary: {
                status: "succeeded",
                validation_passed: true,
                validation_boundary: "external_verifier",
                retry_count: 0,
                recovery_cost: 0,
                evidence_refs: ["verifier:runtime-effect-success"],
              },
              workflow_reuse_outcome_v1: {
                status: "succeeded",
                decision_id: "workflow:runtime-effect",
              },
              tool_selection_outcome_v1: {
                status: "succeeded",
                decision_id: "tool:runtime-effect",
              },
              rehydration_feedback_v1: {
                status: "succeeded",
                node_id: "archive:runtime-effect",
              },
              context_cost_signals_v1: {
                summary_version: "context_cost_signals_v1",
                context_est_tokens: 4200,
                context_token_budget: 8000,
                within_token_budget: true,
                forgotten_items: 3,
                filtered_by_layer_policy_count: 2,
                retrieval_filtered_by_layer_policy_count: 1,
                static_blocks_rejected: 1,
                primary_savings_levers: ["forgetting", "token_budget", "layer_policy_filtering"],
              },
              action_intelligence_runtime_contract: {
                pre_action_gate: {
                  known_enough: true,
                },
              },
              promotion_evidence_ledger_v1: promotionLedger,
            },
          },
          {
            client_id: "runtime-effect-maintenance",
            type: "event",
            title: "Runtime maintenance effect signal",
            text_summary: "Maintenance demoted and archived memory after measurement.",
            slots: {
              runtime_maintenance_effect_summary_v1: {
                effect_summary_version: "runtime_maintenance_effect_summary_v1",
                memory_demotions: 2,
                memory_archives: 1,
                workflow_promotions: 1,
                policy_retirements: 0,
              },
            },
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

    await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const summary = RuntimeEffectSummaryV1Schema.parse(
      await scanRuntimeEffectSummaryLite(store, {
        scope: "default",
        actor: "local-user",
        limit: 20,
      }),
    );

    assert.equal(summary.source_code_change_allowed, false);
    assert.equal(summary.baseline_comparison_required, true);
    assert.equal(summary.scanned_node_count, 2);
    assert.equal(summary.included_signal_ledger_count, 2);
    assert.equal(summary.included_promotion_ledger_count, 1);
    assert.equal(summary.context_cost_observation_count, 1);
    assert.equal(summary.token_context.within_budget_count, 1);
    assert.equal(summary.token_context.over_budget_count, 0);
    assert.equal(summary.token_context.average_est_tokens, 4200);
    assert.equal(summary.token_context.average_token_budget, 8000);
    assert.equal(summary.token_context.context_items_reduced_count, 7);
    assert.ok(summary.token_context.primary_savings_levers.includes("forgetting"));
    assert.equal(summary.continuity.first_action_ready_signal_count, 1);
    assert.equal(summary.verification.verifier_success_count, 1);
    assert.equal(summary.verification.verifier_failure_count, 0);
    assert.equal(summary.learning.workflow_reuse_success_count, 1);
    assert.equal(summary.learning.tool_selection_success_count, 1);
    assert.equal(summary.learning.promotion_admission_rate, 1);
    assert.equal(summary.learning.promotion_invalidation_pressure, "none");
    assert.equal(summary.forgetting.memory_demotions, 2);
    assert.equal(summary.forgetting.memory_archives, 1);
    assert.equal(summary.forgetting.rehydration_useful_count, 1);
    assert.equal(summary.measurable_effect_posture, "positive");
    assert.ok(summary.findings.some((finding) => finding.includes("Baseline comparison")));

    const maintenance = await runRuntimeMaintenanceLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      mode: "dry_run",
      surfaces: ["workflow"],
      limit: 5,
      snapshot_limit: 20,
    }, writeOpts);

    assert.equal(maintenance.before.runtime_effect_summary.summary_version, "runtime_effect_summary_v1");
    assert.equal(maintenance.before.runtime_effect_summary.baseline_comparison_required, true);
    assert.equal(maintenance.before.runtime_effect_summary.measurable_effect_posture, "positive");
  } finally {
    await store.close();
  }
});
