import fs from "node:fs";
import path from "node:path";

export type DashboardArtifactManifest = {
  contract_version: "aionis_dashboard_artifact_manifest_v1";
  demo_name: string;
  run_id: string;
  generated_at: string;
  output_dir: string;
  files: Record<string, string>;
  prompt_payload_policy: {
    prompt_text_excluded: true;
    agent_prompt_excluded: true;
    product_trace_excluded_by_default: true;
  };
};

type WriteDashboardArtifactsArgs = {
  outputDir: string;
  demoName: string;
  runId: string;
  result?: unknown;
  operatorSnapshot?: unknown;
  memoryDecisionTrace?: unknown;
  measureResult?: unknown;
  effectReport?: unknown;
  flightRecorder?: unknown;
  flightReport?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nested(value: unknown, key: string): unknown {
  const record = asRecord(value);
  return record ? record[key] : undefined;
}

function assertNoPromptPayload(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPromptPayload(entry, [...pathParts, String(index)]));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (key === "prompt_text" || key === "agent_prompt") {
      throw new Error(`Dashboard artifact would include prompt payload at ${[...pathParts, key].join(".")}`);
    }
    assertNoPromptPayload(entry, [...pathParts, key]);
  }
}

function writeJson(file: string, value: unknown): void {
  assertNoPromptPayload(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function basename(file: string): string {
  return path.basename(file);
}

export function writeDashboardArtifacts(args: WriteDashboardArtifactsArgs): DashboardArtifactManifest {
  fs.mkdirSync(args.outputDir, { recursive: true });

  const files: Record<string, string> = {};

  const operatorSnapshot = args.operatorSnapshot ?? nested(args.result, "operator_snapshot");
  if (operatorSnapshot !== undefined) {
    const file = path.join(args.outputDir, "operator-snapshot.json");
    writeJson(file, operatorSnapshot);
    files.operator_snapshot = basename(file);
  }

  const decisionTrace = args.memoryDecisionTrace
    ?? nested(args.measureResult, "memory_decision_trace")
    ?? nested(args.result, "memory_decision_trace");
  if (decisionTrace !== undefined) {
    const file = path.join(args.outputDir, "memory-decision-trace.json");
    writeJson(file, decisionTrace);
    files.memory_decision_trace = basename(file);
  }

  const effectReport = args.effectReport
    ?? nested(args.measureResult, "effect_report")
    ?? nested(args.result, "effect_report")
    ?? nested(args.result, "measure");
  if (effectReport !== undefined) {
    const file = path.join(args.outputDir, "measure.json");
    writeJson(file, effectReport);
    files.measure = basename(file);
  }

  const flightReport = args.flightReport
    ?? nested(args.flightRecorder, "agent_flight_recorder")
    ?? nested(args.result, "agent_flight_recorder")
    ?? nested(args.result, "flight_recorder");
  if (flightReport !== undefined) {
    const file = path.join(args.outputDir, "flight-recorder.json");
    writeJson(file, flightReport);
    files.flight_recorder = basename(file);
  }

  if (args.result !== undefined) {
    const file = path.join(args.outputDir, "demo-result.json");
    writeJson(file, args.result);
    files.demo_result = basename(file);
  }

  const manifest: DashboardArtifactManifest = {
    contract_version: "aionis_dashboard_artifact_manifest_v1",
    demo_name: args.demoName,
    run_id: args.runId,
    generated_at: new Date().toISOString(),
    output_dir: args.outputDir,
    files,
    prompt_payload_policy: {
      prompt_text_excluded: true,
      agent_prompt_excluded: true,
      product_trace_excluded_by_default: true,
    },
  };

  writeJson(path.join(args.outputDir, "manifest.json"), manifest);
  return manifest;
}

