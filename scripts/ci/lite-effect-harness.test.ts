import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAionisEffect,
  scoreAionisEffectObservation,
} from "../../src/kernel/effect-harness.ts";
import { aionisKernelCapabilityIds } from "../../src/kernel/boundary.ts";

test("effect harness scores every focused kernel capability", () => {
  const scores = scoreAionisEffectObservation({
    continuity: {
      repeatedDiscoverySteps: 0,
      firstActionCorrect: true,
      recoveredStateFacts: 3,
      expectedStateFacts: 3,
      verifiedFactsCarried: 2,
      verifiedFactsExpected: 2,
    },
    learning: {
      workflowReused: true,
      stableWorkflowReused: true,
      trustedPromotions: 1,
      weakEvidencePromoted: 0,
      counterEvidenceDemotions: 1,
    },
    forgetting: {
      contextItems: 8,
      usefulContextItems: 7,
      staleMemorySuppressed: 2,
      archivedMemoryRehydratedOnDemand: 1,
    },
    learning_control: {
      weakEvidenceBlocked: 2,
      authorityRequiresEvidence: true,
      blockedAuthorityVisible: true,
      unverifiedAuthorityApplied: 0,
    },
  });

  assert.deepEqual(scores.map((score) => score.capability_id), aionisKernelCapabilityIds());
  assert.equal(scores.every((score) => score.status === "pass"), true);
});

test("effect harness proves Aionis improves execution behavior over a baseline run", () => {
  const report = evaluateAionisEffect({
    baseline: {
      continuity: {
        repeatedDiscoverySteps: 4,
        firstActionCorrect: false,
        recoveredStateFacts: 1,
        expectedStateFacts: 4,
        verifiedFactsCarried: 0,
        verifiedFactsExpected: 2,
      },
      learning: {
        workflowReused: false,
        stableWorkflowReused: false,
        provisionalMemoriesWritten: 0,
        trustedPromotions: 0,
        weakEvidencePromoted: 0,
      },
      forgetting: {
        contextItems: 14,
        usefulContextItems: 5,
        staleMemorySurfaced: 3,
        staleMemorySuppressed: 0,
        archivedMemoryRehydratedOnDemand: 0,
      },
      learning_control: {
        weakEvidenceBlocked: 0,
        authorityRequiresEvidence: false,
        blockedAuthorityVisible: false,
        unverifiedAuthorityApplied: 0,
      },
    },
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 0,
        firstActionCorrect: true,
        recoveredStateFacts: 4,
        expectedStateFacts: 4,
        verifiedFactsCarried: 2,
        verifiedFactsExpected: 2,
      },
      learning: {
        workflowReused: true,
        stableWorkflowReused: true,
        provisionalMemoriesWritten: 2,
        trustedPromotions: 1,
        weakEvidencePromoted: 0,
        counterEvidenceDemotions: 1,
      },
      forgetting: {
        contextItems: 8,
        usefulContextItems: 7,
        staleMemorySurfaced: 0,
        staleMemorySuppressed: 3,
        archivedMemoryRehydratedOnDemand: 1,
        unnecessaryRehydrations: 0,
      },
      learning_control: {
        weakEvidenceBlocked: 2,
        authorityRequiresEvidence: true,
        blockedAuthorityVisible: true,
        unverifiedAuthorityApplied: 0,
      },
    },
  });

  assert.equal(report.report_version, "aionis_effect_harness_v1");
  assert.equal(report.status, "pass");
  assert.ok(report.effect_delta >= 0.4);
  assert.equal(report.proof_summary.improved_kernel_count, 4);
  assert.equal(report.proof_summary.failed_kernel_count, 0);
  assert.equal(report.kernel_scores.every((score) => score.delta > 0), true);
  assert.equal(report.kernel_scores.every((score) => score.baseline_score < score.score), true);
  assert.equal(report.proof_summary.repeated_discovery_delta, 4);
  assert.equal(report.proof_summary.first_action_improved, true);
  assert.equal(report.proof_summary.workflow_reuse_improved, true);
  assert.ok(report.proof_summary.context_precision_delta > 0.4);
  assert.equal(report.proof_summary.stale_memory_delta, 3);
  assert.equal(report.proof_summary.weak_authority_blocked, true);
});

test("effect harness warns when the run is safe but not measurably better", () => {
  const safeRun = {
    continuity: {
      repeatedDiscoverySteps: 0,
      firstActionCorrect: true,
      recoveredStateFacts: 3,
      expectedStateFacts: 3,
      verifiedFactsCarried: 2,
      verifiedFactsExpected: 2,
    },
    learning: {
      workflowReused: true,
      stableWorkflowReused: true,
      trustedPromotions: 1,
      weakEvidencePromoted: 0,
      counterEvidenceDemotions: 1,
    },
    forgetting: {
      contextItems: 6,
      usefulContextItems: 6,
      staleMemorySurfaced: 0,
      staleMemorySuppressed: 2,
      archivedMemoryRehydratedOnDemand: 1,
      unnecessaryRehydrations: 0,
    },
    learning_control: {
      weakEvidenceBlocked: 1,
      authorityRequiresEvidence: true,
      blockedAuthorityVisible: true,
      unverifiedAuthorityApplied: 0,
    },
  };

  const report = evaluateAionisEffect({
    baseline: safeRun,
    aionis: safeRun,
  });

  assert.equal(report.status, "warn");
  assert.equal(report.effect_delta, 0);
  assert.equal(report.proof_summary.improved_kernel_count, 0);
  assert.equal(report.proof_summary.regressed_kernel_count, 0);
  assert.ok(report.next_actions.includes("raise_measured_effect_delta_with_real_agent_runs"));
});

test("effect harness fails when weak evidence becomes authority", () => {
  const report = evaluateAionisEffect({
    baseline: {
      continuity: { repeatedDiscoverySteps: 2 },
      learning: { workflowReused: false },
      forgetting: { contextItems: 5, usefulContextItems: 3 },
      learning_control: { authorityRequiresEvidence: false },
    },
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 0,
        firstActionCorrect: true,
        recoveredStateFacts: 2,
        expectedStateFacts: 2,
        verifiedFactsCarried: 1,
        verifiedFactsExpected: 1,
      },
      learning: {
        workflowReused: true,
        trustedPromotions: 1,
        weakEvidencePromoted: 1,
      },
      forgetting: {
        contextItems: 4,
        usefulContextItems: 4,
        staleMemorySurfaced: 0,
      },
      learning_control: {
        weakEvidenceBlocked: 0,
        authorityRequiresEvidence: false,
        blockedAuthorityVisible: false,
        unverifiedAuthorityApplied: 1,
      },
    },
  });

  assert.equal(report.status, "fail");
  const learning = report.kernel_scores.find((score) => score.capability_id === "learning");
  const control = report.kernel_scores.find((score) => score.capability_id === "learning_control");
  assert.deepEqual(learning?.regressions, ["weak_evidence_promoted"]);
  assert.ok(control?.regressions.includes("unverified_authority_applied"));
  assert.ok(report.next_actions.includes("add_more_evidence_before_trusted_promotion"));
  assert.ok(report.next_actions.includes("block_authority_until_outcome_evidence_is_visible"));
});

test("effect harness fails when forgetting allows stale context bloat", () => {
  const report = evaluateAionisEffect({
    baseline: {
      continuity: { repeatedDiscoverySteps: 4 },
      learning: { workflowReused: false },
      forgetting: { contextItems: 6, usefulContextItems: 3, staleMemorySurfaced: 2 },
      learning_control: { authorityRequiresEvidence: false },
    },
    aionis: {
      continuity: {
        repeatedDiscoverySteps: 0,
        firstActionCorrect: true,
        recoveredStateFacts: 3,
        expectedStateFacts: 3,
        verifiedFactsCarried: 1,
        verifiedFactsExpected: 1,
      },
      learning: {
        workflowReused: true,
        stableWorkflowReused: true,
        trustedPromotions: 1,
        weakEvidencePromoted: 0,
        counterEvidenceDemotions: 1,
      },
      forgetting: {
        contextItems: 12,
        usefulContextItems: 2,
        staleMemorySurfaced: 5,
        staleMemorySuppressed: 0,
        archivedMemoryRehydratedOnDemand: 0,
        unnecessaryRehydrations: 1,
      },
      learning_control: {
        weakEvidenceBlocked: 1,
        authorityRequiresEvidence: true,
        blockedAuthorityVisible: true,
        unverifiedAuthorityApplied: 0,
      },
    },
  });

  const forgetting = report.kernel_scores.find((score) => score.capability_id === "forgetting");

  assert.equal(report.status, "fail");
  assert.equal(forgetting?.status, "fail");
  assert.ok(forgetting?.regressions.includes("stale_memory_reached_context"));
  assert.ok(forgetting?.regressions.includes("context_precision_low"));
  assert.ok(report.next_actions.includes("improve_context_precision_and_stale_memory_suppression"));
});
