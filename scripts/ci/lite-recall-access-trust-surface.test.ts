import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { adjustRecallCandidateSimilarityForTrust } from "../../src/store/recall-access.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("recall access trust adjustment resolves execution-native pattern surfaces", () => {
  assert.equal(
    adjustRecallCandidateSimilarityForTrust({
      type: "procedure",
      slots: {
        execution_native_v1: {
          execution_kind: "pattern_anchor",
          pattern_state: "stable",
          promotion: {
            counter_evidence_open: false,
          },
        },
      },
      similarity: 0.5,
    }),
    0.58,
  );
});

test("recall access trust adjustment resolves stale anchor pattern surfaces", () => {
  assert.equal(
    adjustRecallCandidateSimilarityForTrust({
      type: "procedure",
      slots: {
        anchor_v1: {
          anchor_kind: "pattern",
          pattern_state: "provisional",
        },
      },
      similarity: 0.5,
    }),
    0.45,
  );
});

test("recall access trust adjustment penalizes open counter evidence via resolver surface", () => {
  assert.equal(
    adjustRecallCandidateSimilarityForTrust({
      type: "procedure",
      slots: {
        execution_native_v1: {
          anchor_kind: "pattern",
          pattern_state: "stable",
          promotion: {
            counter_evidence_open: true,
          },
        },
      },
      similarity: 0.5,
    }),
    0.38,
  );
});

test("recall access trust adjustment promotes passed execution workflow anchors", () => {
  assert.equal(
    adjustRecallCandidateSimilarityForTrust({
      type: "procedure",
      slots: {
        execution_native_v1: {
          execution_kind: "workflow_anchor",
          execution_outcome_role: "passed_solution",
          execution_contract_v1: {
            schema_version: "execution_contract_v1",
            contract_trust: "advisory",
          },
        },
      },
      similarity: 0.5,
    }),
    0.66,
  );
});

test("recall access trust adjustment demotes unknown advisory workflow anchors", () => {
  assert.equal(
    adjustRecallCandidateSimilarityForTrust({
      type: "procedure",
      slots: {
        execution_native_v1: {
          execution_kind: "workflow_anchor",
          execution_outcome_role: "unknown",
          execution_contract_v1: {
            schema_version: "execution_contract_v1",
            contract_trust: "advisory",
          },
        },
      },
      similarity: 0.5,
    }),
    0.42,
  );
});

test("recall access trust adjustment demotes failed workflow anchors", () => {
  assert.equal(
    adjustRecallCandidateSimilarityForTrust({
      type: "procedure",
      slots: {
        execution_native_v1: {
          execution_kind: "workflow_anchor",
          execution_outcome_role: "failed_branch",
          execution_contract_v1: {
            schema_version: "execution_contract_v1",
            contract_trust: "advisory",
          },
        },
      },
      similarity: 0.5,
    }),
    0.26,
  );
});

test("recall access trust adjustment does not read slot schema fields directly", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/store/recall-access.ts"), "utf8");
  const match = source.match(/export function adjustRecallCandidateSimilarityForTrust[\s\S]*?\n}\n/);
  assert.ok(match, "adjustRecallCandidateSimilarityForTrust must be present");
  assert.equal(match[0].includes("execution_native_v1"), false);
  assert.equal(match[0].includes("anchor_v1"), false);
});
