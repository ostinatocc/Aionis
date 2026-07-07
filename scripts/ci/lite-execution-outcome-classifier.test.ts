import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExecutionOutcomeFromSlots,
  classifyExecutionOutcomeRecord,
  classifyExecutionOutcomeText,
} from "../../src/execution/outcome-classifier.js";

test("execution outcome classifier treats conflict as failed with conflict metadata", () => {
  assert.deepEqual(classifyExecutionOutcomeText("passed, but verifier reported a conflict"), {
    outcome: "failed",
    conflict: true,
  });
  assert.deepEqual(classifyExecutionOutcomeRecord({
    status: "passed",
    summary: "Route contradicts canonical evidence.",
  }), {
    outcome: "failed",
    conflict: true,
  });
  assert.deepEqual(classifyExecutionOutcomeFromSlots({
    execution_result_summary: {
      ok: true,
      diagnostic_note: "conflict with accepted branch",
    },
  }), {
    outcome: "failed",
    conflict: true,
  });
});

test("execution outcome classifier keeps negated failures and negated conflicts neutral", () => {
  assert.deepEqual(classifyExecutionOutcomeText("no conflict and completed successfully"), {
    outcome: "passed",
    conflict: false,
  });
  assert.deepEqual(classifyExecutionOutcomeText("failure not observed"), {
    outcome: "unknown",
    conflict: false,
  });
  assert.deepEqual(classifyExecutionOutcomeText("not failed; accepted"), {
    outcome: "passed",
    conflict: false,
  });
});

test("execution outcome classifier normalizes boolean success and failure fields", () => {
  assert.deepEqual(classifyExecutionOutcomeRecord({ success: false }), {
    outcome: "failed",
    conflict: false,
  });
  assert.deepEqual(classifyExecutionOutcomeRecord({ failure: false }), {
    outcome: "unknown",
    conflict: false,
  });
  assert.deepEqual(classifyExecutionOutcomeRecord({ has_conflict: true, success: true }), {
    outcome: "failed",
    conflict: true,
  });
});

test("execution outcome classifier uses the same slots-level evidence sources", () => {
  assert.deepEqual(classifyExecutionOutcomeFromSlots({
    execution_evidence: [
      {
        status: "failed",
        summary: "Verifier failed after clean-shell replay.",
      },
    ],
  }), {
    outcome: "failed",
    conflict: false,
  });
  assert.deepEqual(classifyExecutionOutcomeFromSlots({
    execution_evidence_v1: {
      schema_version: "execution_evidence_v1",
      validation_passed: false,
      evidence_refs: ["test:classifier:evidence-v1"],
    },
  }), {
    outcome: "failed",
    conflict: false,
  });
});
