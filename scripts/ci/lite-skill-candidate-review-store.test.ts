import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteSkillCandidateReviewStore } from "../../src/store/lite-skill-candidate-review-store.ts";
import {
  productMeasurementDigest,
  type ProductMeasurementRecord,
  type TraceDerivedSkillTrainingCandidate,
} from "../../src/store/memory-store.ts";
import { buildAionisEffectReport } from "../../src/memory/product-output/learning-effect.ts";
import { evaluateAionisEffect } from "../../src/kernel/effect-evaluator.ts";

function tmpDbPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aionis-skill-candidate-review-")), `${name}.sqlite`);
}

function candidate(input: { skillName?: string; sourceTraceId?: string } = {}): TraceDerivedSkillTrainingCandidate {
  return {
    candidate_type: "trace_derived_skill",
    source_ids: [input.sourceTraceId ?? "effect_kernel:continuity", "run:run-aionis"],
    label: "positive",
    export_ready: true,
    reason: "Positive continuity evidence produced a governed trace-derived skill candidate.",
    trace_derived_skill: {
      contract_version: "aionis_trace_derived_skill_candidate_v1",
      skill_name: input.skillName ?? "Continue verified execution state across sessions",
      source_trace_ids: [input.sourceTraceId ?? "effect_kernel:continuity", "run:run-aionis"],
      source_signal_ids: ["continuity_guidance_matches_expected"],
      applies_when: ["task_signature:runtime-continuation", "future_session_needs_verified_continuation"],
      does_not_apply_when: ["No validation evidence is available for the source trace."],
      procedure_steps: [
        "Recover the current Aionis guide before continuing the task.",
        "Run the recorded acceptance checks before treating the continuation as reusable.",
      ],
      target_files: ["src/runtime.ts"],
      acceptance_checks: ["npm test passed"],
      failure_counterexamples: ["legacy route failed verifier"],
      evidence_refs: ["ev-1"],
      authority_state: "candidate",
      promotion_status: "promotion_ready",
      export_policy: {
        agent_prompt_included: false,
        runtime_mutation: false,
        required_gate: "admission_and_promotion_gate",
      },
    },
  };
}

function measurement(candidates: TraceDerivedSkillTrainingCandidate[]): ProductMeasurementRecord {
  const effectReport = buildAionisEffectReport({
    tenant_id: "tenant-a",
    scope: "scope-a",
    comparison: { mode: "baseline_vs_aionis", sufficient_evidence: true },
    evidence_ids: ["guide_receipt:before", "guide_receipt:after", "tool_feedback:positive"],
    report: evaluateAionisEffect({
      baseline: {
        continuity: {
          repeatedDiscoverySteps: 4,
          continuityGuidanceCorrect: false,
          recoveredStateFacts: 0,
          expectedStateFacts: 4,
          verifiedFactsCarried: 0,
          verifiedFactsExpected: 4,
        },
        learning: {
          workflowReused: false,
          stableWorkflowReused: false,
          provisionalMemoriesWritten: 1,
          trustedPromotions: 0,
          weakEvidencePromoted: 0,
          counterEvidenceDemotions: 0,
        },
        forgetting: {
          contextItems: 4,
          usefulContextItems: 1,
          staleMemorySurfaced: 1,
          staleMemorySuppressed: 0,
          archivedMemoryRehydratedOnDemand: 0,
          unnecessaryRehydrations: 1,
        },
        learning_control: {
          weakEvidenceBlocked: 0,
          authorityRequiresEvidence: false,
          blockedAuthorityVisible: false,
          unverifiedAuthorityApplied: 1,
        },
      },
      aionis: {
        continuity: {
          repeatedDiscoverySteps: 0,
          continuityGuidanceCorrect: true,
          recoveredStateFacts: 4,
          expectedStateFacts: 4,
          verifiedFactsCarried: 4,
          verifiedFactsExpected: 4,
        },
        learning: {
          workflowReused: true,
          stableWorkflowReused: true,
          provisionalMemoriesWritten: 0,
          trustedPromotions: 1,
          weakEvidencePromoted: 0,
          counterEvidenceDemotions: 1,
        },
        forgetting: {
          contextItems: 4,
          usefulContextItems: 4,
          staleMemorySurfaced: 0,
          staleMemorySuppressed: 1,
          archivedMemoryRehydratedOnDemand: 1,
          unnecessaryRehydrations: 0,
        },
        learning_control: {
          weakEvidenceBlocked: 1,
          authorityRequiresEvidence: true,
          blockedAuthorityVisible: true,
          unverifiedAuthorityApplied: 0,
        },
      },
    }),
  });
  effectReport.training_candidates = candidates;
  const recordWithoutDigest = {
    measurement_id: "measurement:test-runtime",
    tenant_id: "tenant-a",
    scope: "scope-a",
    source: "product_trace",
    effect_report: effectReport,
    eligible_for_skill_export: true,
    evidence_status: "sufficient",
    runtime_evidence_ids: ["guide_receipt:before", "guide_receipt:after", "tool_feedback:positive"],
    eligibility_reasons: ["runtime evidence verified"],
    created_by: "aionis-runtime",
    created_at: "2026-06-26T00:30:00.000Z",
  };
  return {
    ...recordWithoutDigest,
    measurement_digest: productMeasurementDigest(recordWithoutDigest),
  };
}

test("trace-derived skill review store queues candidates idempotently", async () => {
  const store = createLiteSkillCandidateReviewStore(tmpDbPath("queue"));
  const access = store.createSkillCandidateReviewAccess();
  try {
    const record = measurement([candidate()]);
    await access.recordMeasurement({ record });
    const first = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [candidate()],
      measurementId: record.measurement_id,
      measurementDigest: record.measurement_digest,
      eligibleForPromotion: true,
      now: "2026-06-26T01:00:00.000Z",
    });
    const second = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [candidate()],
      measurementId: record.measurement_id,
      measurementDigest: record.measurement_digest,
      eligibleForPromotion: true,
      now: "2026-06-26T01:05:00.000Z",
    });

    assert.equal(first.inserted, 1);
    assert.equal(first.updated, 0);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);
    assert.equal(first.rows[0]?.candidate_id, second.rows[0]?.candidate_id);
    assert.equal(second.rows[0]?.review_status, "pending_review");
    assert.equal(second.rows[0]?.candidate.trace_derived_skill.export_policy.agent_prompt_included, false);

    const listed = await access.listTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      reviewStatus: "pending_review",
      limit: 10,
    });
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0]?.skill_name, "Continue verified execution state across sessions");
  } finally {
    await store.close();
  }
});

test("trace-derived skill review store records promote and reject decisions without changing candidate payload", async () => {
  const store = createLiteSkillCandidateReviewStore(tmpDbPath("review"));
  const access = store.createSkillCandidateReviewAccess();
  try {
    const candidates = [
      candidate({ sourceTraceId: "effect_kernel:continuity" }),
      candidate({ skillName: "Reuse verified workflow", sourceTraceId: "effect_kernel:learning" }),
    ];
    const record = measurement(candidates);
    await access.recordMeasurement({ record });
    const queued = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates,
      measurementId: record.measurement_id,
      measurementDigest: record.measurement_digest,
      eligibleForPromotion: true,
      now: "2026-06-26T01:00:00.000Z",
    });
    const promoted = await access.reviewTraceDerivedSkillCandidate({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidateId: queued.rows[0]!.candidate_id,
      reviewStatus: "promoted",
      reviewerId: "operator-1",
      reason: "Strong evidence and matching task family.",
      expectedVersion: queued.rows[0]!.row_version,
      now: "2026-06-26T02:00:00.000Z",
    });
    const rejected = await access.reviewTraceDerivedSkillCandidate({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidateId: queued.rows[1]!.candidate_id,
      reviewStatus: "rejected",
      reviewerId: "operator-1",
      reason: "Needs more cross-task evidence.",
      expectedVersion: queued.rows[1]!.row_version,
      now: "2026-06-26T02:05:00.000Z",
    });

    assert.equal(promoted?.review_status, "promoted");
    assert.equal(promoted?.reviewer_id, "operator-1");
    assert.equal(promoted?.reviewed_at, "2026-06-26T02:00:00.000Z");
    assert.equal(promoted?.candidate.trace_derived_skill.authority_state, "candidate");
    assert.equal(promoted?.candidate.trace_derived_skill.export_policy.runtime_mutation, false);
    assert.equal(rejected?.review_status, "rejected");

    const all = await access.listTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      reviewStatus: "all",
      limit: 10,
    });
    assert.equal(all.rows.length, 2);
    assert.deepEqual(new Set(all.rows.map((row) => row.review_status)), new Set(["promoted", "rejected"]));
  } finally {
    await store.close();
  }
});
