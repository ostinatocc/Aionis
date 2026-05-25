import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPromotionEvidenceLedgerV1 } from "../../src/memory/promotion-evidence-ledger.ts";
import { scanPromotionQualitySummaryLite } from "../../src/memory/promotion-quality-summary.ts";
import { runRuntimeMaintenanceLite } from "../../src/memory/runtime-maintenance.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { PromotionQualitySummaryV1Schema } from "../../src/memory/schemas.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-promotion-quality-"));
  return path.join(dir, `${name}.sqlite`);
}

const writeOpts = {
  defaultScope: "default",
  defaultTenantId: "default",
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
  shadowDualWriteEnabled: false,
  shadowDualWriteStrict: false,
};

test("promotion quality summary aggregates persisted promotion ledgers across sqlite memory rows", async () => {
  const dbPath = tmpDbPath("summary");
  const store = createLiteWriteStore(dbPath);
  try {
    const admittedWorkflowLedger = buildPromotionEvidenceLedgerV1({
      targetKind: "workflow",
      targetId: "workflow:stable:quality-summary",
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
      sourceNodeIds: ["node:workflow-source-1", "node:workflow-source-2"],
      sourceRunIds: ["run:workflow-1", "run:workflow-2"],
      sourceCommitIds: ["commit:workflow-1"],
      promotionEvidenceRefs: ["run:workflow-1", "run:workflow-2"],
      evidence: [{
        evidence_id: "evidence:workflow-admitted",
        evidence_kind: "learning_control",
        polarity: "positive",
        source_ref: "run:workflow-2",
        claim: "Learning-control admitted stable workflow promotion.",
        confidence: 0.92,
      }],
    });
    const candidateWorkflowLedger = buildPromotionEvidenceLedgerV1({
      targetKind: "workflow",
      targetId: "workflow:candidate:quality-summary",
      sourceLayers: ["L1"],
      targetLayer: "L2",
      transition: "L1_to_L2",
      promotionState: "candidate",
      promotionOrigin: "write_projection",
      observedCount: 1,
      requiredCount: 2,
      authorityGateAdmitted: null,
      learningControlAdmitted: null,
      verifierStatus: "unknown",
      contractTrust: "advisory",
      sourceNodeIds: ["node:workflow-candidate-source"],
      sourceRunIds: ["run:workflow-candidate"],
      sourceCommitIds: ["commit:workflow-candidate"],
      promotionEvidenceRefs: ["run:workflow-candidate"],
      evidence: [{
        evidence_id: "evidence:workflow-candidate",
        evidence_kind: "execution_observation",
        polarity: "neutral",
        source_ref: "run:workflow-candidate",
        claim: "Workflow candidate still has insufficient distinct observations.",
        confidence: 0.74,
      }],
    });
    const contestedPatternLedger = buildPromotionEvidenceLedgerV1({
      targetKind: "pattern",
      targetId: "pattern:contested:quality-summary",
      sourceLayers: ["L2"],
      targetLayer: "L3",
      transition: "L2_to_L3",
      promotionState: "contested",
      promotionOrigin: "tools_feedback",
      observedCount: 2,
      requiredCount: 2,
      authorityGateAdmitted: true,
      learningControlAdmitted: false,
      verifierStatus: "succeeded",
      contractTrust: "observational",
      sourceNodeIds: ["node:pattern-source"],
      sourceRunIds: ["run:pattern"],
      sourceCommitIds: ["commit:pattern"],
      promotionEvidenceRefs: ["run:pattern-positive"],
      counterEvidenceRefs: ["run:pattern-negative"],
      evidence: [{
        evidence_id: "evidence:pattern-contested",
        evidence_kind: "counter_evidence",
        polarity: "negative",
        source_ref: "run:pattern-negative",
        claim: "Counter-evidence keeps this pattern out of stable authority.",
        confidence: 0.88,
      }],
    });
    const blockedPolicyLedger = buildPromotionEvidenceLedgerV1({
      targetKind: "policy",
      targetId: "policy:blocked:quality-summary",
      sourceLayers: ["L3"],
      targetLayer: "L4",
      transition: "L3_to_L4",
      promotionState: "active",
      promotionOrigin: "policy_memory_feedback",
      observedCount: 2,
      requiredCount: 2,
      authorityGateAdmitted: false,
      learningControlAdmitted: true,
      verifierStatus: "failed",
      contractTrust: "authoritative",
      sourceNodeIds: ["node:policy-source"],
      sourceRunIds: ["run:policy"],
      sourceCommitIds: ["commit:policy"],
      promotionEvidenceRefs: ["run:policy"],
      evidence: [{
        evidence_id: "evidence:policy-blocked",
        evidence_kind: "runtime_verifier",
        polarity: "negative",
        source_ref: "run:policy",
        claim: "Verifier failure blocks policy materialization authority.",
        confidence: 0.9,
      }],
    });

    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "Persist promotion evidence ledgers for quality aggregation.",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            client_id: "promotion-quality-workflow-admitted",
            type: "concept",
            title: "Admitted workflow promotion ledger",
            text_summary: "A workflow promotion ledger admitted by evidence and learning control.",
            slots: {
              promotion_evidence_ledger_v1: admittedWorkflowLedger,
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_anchor",
                compression_layer: "L2",
                workflow_signature: "workflow:quality-summary",
                contract_trust: "authoritative",
                promotion_evidence_ledger_v1: admittedWorkflowLedger,
              },
            },
          },
          {
            client_id: "promotion-quality-workflow-candidate",
            type: "concept",
            title: "Candidate workflow promotion ledger",
            text_summary: "A workflow candidate ledger that still needs more evidence.",
            slots: {
              promotion_evidence_ledger_v1: candidateWorkflowLedger,
            },
          },
          {
            client_id: "promotion-quality-pattern-contested",
            type: "concept",
            title: "Contested pattern promotion ledger",
            text_summary: "A pattern promotion ledger with counter-evidence.",
            slots: {
              anchor_v1: {
                schema_version: "anchor_v1",
                anchor_kind: "pattern",
                anchor_level: "L3",
                pattern_signature: "pattern:quality-summary",
                promotion_evidence_ledger_v1: contestedPatternLedger,
              },
            },
          },
          {
            client_id: "promotion-quality-policy-blocked",
            type: "concept",
            title: "Blocked policy promotion ledger",
            text_summary: "A policy promotion ledger blocked by authority and verifier evidence.",
            slots: {
              promotion_evidence_ledger_v1: blockedPolicyLedger,
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
      applyMemoryWrite({} as any, prepared, {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
        shadowDualWriteEnabled: writeOpts.shadowDualWriteEnabled,
        shadowDualWriteStrict: writeOpts.shadowDualWriteStrict,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const summary = PromotionQualitySummaryV1Schema.parse(
      await scanPromotionQualitySummaryLite(store, {
        scope: "default",
        actor: "local-user",
        limit: 20,
      }),
    );

    assert.equal(summary.source_code_change_allowed, false);
    assert.equal(summary.scanned_node_count, 4);
    assert.equal(summary.included_ledger_count, 4);
    assert.equal(summary.evidence_entry_count, 4);
    assert.equal(summary.verdict_counts.promotion_admitted, 1);
    assert.equal(summary.verdict_counts.candidate_only, 1);
    assert.equal(summary.verdict_counts.contested, 1);
    assert.equal(summary.verdict_counts.promotion_blocked, 1);
    assert.equal(summary.authority_gate_counts.admitted, 2);
    assert.equal(summary.authority_gate_counts.rejected, 1);
    assert.equal(summary.authority_gate_counts.unknown, 1);
    assert.equal(summary.learning_control_counts.rejected, 1);
    assert.equal(summary.verifier_status_counts.failed, 1);
    assert.equal(summary.contract_trust_counts.authoritative, 2);
    assert.equal(summary.counter_evidence_ref_count, 1);
    assert.equal(summary.distinct_source_run_count, 5);
    assert.equal(summary.promotion_admission_rate, 0.25);
    assert.equal(summary.contested_rate, 0.25);
    assert.equal(summary.invalidation_pressure, "high");
    assert.equal(summary.recommended_learning_posture, "invalidate");
    assert.equal(summary.transition_counts.find((count) => count.transition === "L1_to_L2")?.total, 2);
    assert.equal(summary.target_kind_counts.find((count) => count.target_kind === "workflow")?.total, 2);
    assert.ok(summary.findings.some((finding) => finding.includes("Counter-evidence")));

    const maintenance = await runRuntimeMaintenanceLite(store, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      mode: "dry_run",
      surfaces: ["workflow"],
      limit: 5,
      snapshot_limit: 20,
    }, writeOpts);

    assert.equal(maintenance.before.promotion_quality_summary.summary_version, "promotion_quality_summary_v1");
    assert.equal(maintenance.before.promotion_quality_summary.included_ledger_count, 4);
    assert.equal(maintenance.before.promotion_quality_summary.source_code_change_allowed, false);
    assert.equal(maintenance.after.promotion_quality_summary.recommended_learning_posture, "invalidate");
  } finally {
    await store.close();
  }
});
