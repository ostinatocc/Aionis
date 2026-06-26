import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteSkillCandidateReviewStore } from "../../src/store/lite-skill-candidate-review-store.ts";
import type { TraceDerivedSkillTrainingCandidate } from "../../src/store/skill-candidate-review-access.ts";

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

test("trace-derived skill review store queues candidates idempotently", async () => {
  const store = createLiteSkillCandidateReviewStore(tmpDbPath("queue"));
  const access = store.createSkillCandidateReviewAccess();
  try {
    const first = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [candidate()],
      source: "effect_report",
      now: "2026-06-26T01:00:00.000Z",
    });
    const second = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [candidate()],
      source: "measure_result",
      now: "2026-06-26T01:05:00.000Z",
    });

    assert.equal(first.inserted, 1);
    assert.equal(first.updated, 0);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
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
    const queued = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [
        candidate({ sourceTraceId: "effect_kernel:continuity" }),
        candidate({ skillName: "Reuse verified workflow", sourceTraceId: "effect_kernel:learning" }),
      ],
      source: "effect_report",
      now: "2026-06-26T01:00:00.000Z",
    });
    const promoted = await access.reviewTraceDerivedSkillCandidate({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidateId: queued.rows[0]!.candidate_id,
      reviewStatus: "promoted",
      reviewerId: "operator-1",
      reason: "Strong evidence and matching task family.",
      now: "2026-06-26T02:00:00.000Z",
    });
    const rejected = await access.reviewTraceDerivedSkillCandidate({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidateId: queued.rows[1]!.candidate_id,
      reviewStatus: "rejected",
      reviewerId: "operator-1",
      reason: "Needs more cross-task evidence.",
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
