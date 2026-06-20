import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDashboardArtifacts } from "../e2e/dashboard-artifacts.ts";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("dashboard artifact exporter writes read-model files without prompt payloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-dashboard-artifacts-"));
  const manifest = writeDashboardArtifacts({
    outputDir: dir,
    demoName: "unit-demo",
    runId: "run-dashboard-artifacts",
    result: {
      contract_version: "unit_result_v1",
      summary: "demo summary",
    },
    operatorSnapshot: {
      contract_version: "aionis_operator_snapshot_v1",
      runtime_mutation: false,
      memory_use_receipt: {
        prompt_char_count: 120,
        use_now_memory_ids: ["mem-current"],
      },
    },
    measureResult: {
      contract_version: "aionis_measure_result_v1",
      effect_report: {
        contract_version: "aionis_effect_report_v1",
        history_impact: { impact_direction: "positive" },
      },
      memory_decision_trace: {
        contract_version: "aionis_memory_decision_trace_v1",
        memory_decisions: [{ memory_id: "mem-current", admission_action: "use_now" }],
      },
    },
    flightRecorder: {
      contract_version: "aionis_agent_flight_recorder_result_v1",
      agent_flight_recorder: {
        contract_version: "aionis_agent_flight_recorder_report_v1",
        agent_prompt_included: false,
        agent_view: {
          prompt_text_included: false,
          prompt_char_count: 120,
          use_now_memory_ids: ["mem-current"],
        },
      },
    },
  });

  assert.equal(manifest.contract_version, "aionis_dashboard_artifact_manifest_v1");
  assert.equal(manifest.files.operator_snapshot, "operator-snapshot.json");
  assert.equal(manifest.files.memory_decision_trace, "memory-decision-trace.json");
  assert.equal(manifest.files.measure, "measure.json");
  assert.equal(manifest.files.flight_recorder, "flight-recorder.json");
  assert.equal(manifest.files.demo_result, "demo-result.json");
  assert.equal(readJson(path.join(dir, "operator-snapshot.json")).contract_version, "aionis_operator_snapshot_v1");
  assert.equal(readJson(path.join(dir, "measure.json")).contract_version, "aionis_effect_report_v1");
  assert.equal(
    readJson(path.join(dir, "memory-decision-trace.json")).contract_version,
    "aionis_memory_decision_trace_v1",
  );
  assert.equal(
    readJson(path.join(dir, "flight-recorder.json")).contract_version,
    "aionis_agent_flight_recorder_report_v1",
  );
  for (const file of [
    "operator-snapshot.json",
    "memory-decision-trace.json",
    "measure.json",
    "flight-recorder.json",
    "demo-result.json",
    "manifest.json",
  ]) {
    assert.equal(fs.readFileSync(path.join(dir, file), "utf8").includes("\"prompt_text\""), false);
    assert.equal(fs.readFileSync(path.join(dir, file), "utf8").includes("\"agent_prompt\""), false);
  }
});

test("dashboard artifact exporter rejects prompt payload fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-dashboard-artifacts-"));
  assert.throws(
    () => writeDashboardArtifacts({
      outputDir: dir,
      demoName: "bad-demo",
      runId: "run-bad",
      operatorSnapshot: {
        contract_version: "aionis_operator_snapshot_v1",
        prompt_text: "do not persist prompt payloads",
      },
    }),
    /prompt payload/,
  );
});
