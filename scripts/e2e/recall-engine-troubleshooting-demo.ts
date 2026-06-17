#!/usr/bin/env node
import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAionisClient,
  type AionisExternalMemoryCandidate,
} from "../../src/sdk.ts";
import { asRecord, assertCondition, repoRoot } from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type RuntimeSession = {
  baseUrl: string;
  mode: "external" | "spawned_no_embedding";
  handle: {
    child: ChildProcessWithoutNullStreams;
    tmpDir: string;
    logs: string[];
  } | null;
};

type TroubleshootingScenarioResult = {
  scenario_id: string;
  diagnosis:
    | "candidate_retrieval_gap"
    | "retrieved_but_blocked"
    | "inspect_before_use"
    | "rehydrate_required";
  expected_memory_id: string;
  agent_surface: "absent" | "do_not_use" | "inspect_before_use" | "rehydrate";
  operator_next_step: string;
  evidence: {
    use_now_memory_ids: string[];
    inspect_before_use_memory_ids: string[];
    do_not_use_memory_ids: string[];
    rehydrate_memory_ids: string[];
    admission_entry_count: number;
    memory_use_receipt_visible: boolean;
    admission_record_visible: boolean;
    prompt_payload_excluded: boolean;
  };
  checks: Record<string, boolean>;
};

const MISSING_ID = "missing:current-route";
const FAILED_ID = "retrieved:failed-route";
const UNKNOWN_ID = "retrieved:unknown-helper-note";
const REHYDRATE_ID = "retrieved:raw-verifier-trace";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function apiKey(): string | null {
  return process.env.AIONIS_RECALL_TROUBLESHOOTING_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

async function openNoEmbeddingRuntime(): Promise<RuntimeSession> {
  const externalBaseUrl = (
    process.env.AIONIS_RECALL_TROUBLESHOOTING_BASE_URL
    || process.env.AIONIS_PRODUCT_E2E_BASE_URL
    || process.env.AIONIS_BASE_URL
    || process.env.AIONIS_URL
    || ""
  ).trim();
  if (externalBaseUrl) {
    return { baseUrl: externalBaseUrl.replace(/\/+$/, ""), mode: "external", handle: null };
  }

  const port = await findFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-recall-troubleshooting-"));
  const logs: string[] = [];
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      AIONIS_LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_BYPASS_LOOPBACK: "true",
      LITE_LOCAL_ACTOR_ID: "local-user",
      LITE_WRITE_SQLITE_PATH: path.join(tmpDir, "write.sqlite"),
      LITE_REPLAY_SQLITE_PATH: path.join(tmpDir, "replay.sqlite"),
      EMBEDDING_PROVIDER: "none",
      SANDBOX_ENABLED: "false",
      SANDBOX_ADMIN_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });
  child.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, mode: "spawned_no_embedding", handle: { child, tmpDir, logs } };
    } catch {
      // Wait for startup.
    }
    await sleep(250);
  }
  closeRuntime({ baseUrl, mode: "spawned_no_embedding", handle: { child, tmpDir, logs } });
  throw new Error(`Aionis Runtime did not become healthy.\n${logs.join("").slice(-4_000)}`);
}

function closeRuntime(session: RuntimeSession): void {
  if (session.handle?.child.exitCode === null) session.handle.child.kill("SIGTERM");
}

function outputPath(): string {
  return process.env.AIONIS_RECALL_TROUBLESHOOTING_OUTPUT?.trim()
    || path.join(repoRoot, "docs/examples/recall-engine-troubleshooting-result.json");
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function rehydrateIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry)?.memory_id)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function candidate(input: {
  id: string;
  backend: string;
  text: string;
  title: string;
  lifecycle: AionisExternalMemoryCandidate["lifecycle_hint"];
  trust?: "trusted" | "known" | "unknown" | "untrusted";
  evidenceRequirement?: "none" | "inspect_before_use" | "rehydrate_before_use" | "blocked";
  targetFiles?: string[];
  evidenceRefs?: string[];
}): AionisExternalMemoryCandidate {
  return {
    external_memory_id: input.id,
    source_backend: input.backend,
    text: input.text,
    metadata: {
      title: input.title,
      ...(input.targetFiles ? { target_files: input.targetFiles } : {}),
    },
    lifecycle_hint: input.lifecycle,
    authority: {
      source_trust: input.trust ?? "trusted",
      scope: "project",
      evidence_requirement: input.evidenceRequirement ?? "none",
    },
    evidence_refs: input.evidenceRefs ?? [],
  };
}

function summarizeGoverned(args: {
  scenarioId: string;
  governed: Record<string, unknown>;
  expectedMemoryId: string;
  diagnosis: TroubleshootingScenarioResult["diagnosis"];
  expectedSurface: TroubleshootingScenarioResult["agent_surface"];
  operatorNextStep: string;
}): TroubleshootingScenarioResult {
  const agentContext = asRecord(args.governed.agent_context);
  const receipt = asRecord(args.governed.memory_use_receipt);
  const admissionRecord = asRecord(args.governed.memory_admission_records);
  const useNowMemoryIds = textArray(agentContext?.use_now_memory_ids);
  const inspectBeforeUseMemoryIds = textArray(agentContext?.inspect_before_use_memory_ids);
  const doNotUseMemoryIds = textArray(agentContext?.do_not_use_memory_ids);
  const rehydrateMemoryIds = rehydrateIds(agentContext?.rehydrate_hints);
  const entries = recordArray(admissionRecord?.entries);
  const promptText = String(agentContext?.prompt_text ?? "");
  const promptPayloadExcluded = !promptText.includes("memory_use_receipt")
    && !promptText.includes("memory_admission_records")
    && !promptText.includes("raw_external_payload");
  const presentOnAnySurface = [
    ...useNowMemoryIds,
    ...inspectBeforeUseMemoryIds,
    ...doNotUseMemoryIds,
    ...rehydrateMemoryIds,
  ].includes(args.expectedMemoryId);
  const checks: Record<string, boolean> = {
    memory_use_receipt_visible: receipt?.contract_version === "aionis_memory_use_receipt_v1",
    admission_record_visible: admissionRecord?.contract_version === "aionis_memory_admission_record_v1",
    prompt_payload_excluded: promptPayloadExcluded,
  };
  if (args.expectedSurface === "absent") {
    checks.expected_memory_absent_from_all_surfaces = !presentOnAnySurface
      && entries.every((entry) => entry.memory_id !== args.expectedMemoryId);
  } else if (args.expectedSurface === "do_not_use") {
    checks.expected_memory_do_not_use = doNotUseMemoryIds.includes(args.expectedMemoryId);
    checks.expected_memory_not_direct_use = !useNowMemoryIds.includes(args.expectedMemoryId);
  } else if (args.expectedSurface === "inspect_before_use") {
    checks.expected_memory_inspect_before_use = inspectBeforeUseMemoryIds.includes(args.expectedMemoryId);
    checks.expected_memory_not_direct_use = !useNowMemoryIds.includes(args.expectedMemoryId);
  } else if (args.expectedSurface === "rehydrate") {
    checks.expected_memory_rehydrate = rehydrateMemoryIds.includes(args.expectedMemoryId);
    checks.expected_memory_not_direct_use = !useNowMemoryIds.includes(args.expectedMemoryId);
  }
  for (const [name, passed] of Object.entries(checks)) {
    assertCondition(passed === true, `${args.scenarioId} failed check ${name}`);
  }
  return {
    scenario_id: args.scenarioId,
    diagnosis: args.diagnosis,
    expected_memory_id: args.expectedMemoryId,
    agent_surface: args.expectedSurface,
    operator_next_step: args.operatorNextStep,
    evidence: {
      use_now_memory_ids: useNowMemoryIds,
      inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
      do_not_use_memory_ids: doNotUseMemoryIds,
      rehydrate_memory_ids: rehydrateMemoryIds,
      admission_entry_count: entries.length,
      memory_use_receipt_visible: checks.memory_use_receipt_visible,
      admission_record_visible: checks.admission_record_visible,
      prompt_payload_excluded: promptPayloadExcluded,
    },
    checks,
  };
}

async function main() {
  const runId = process.env.AIONIS_RECALL_TROUBLESHOOTING_RUN_ID?.trim()
    || "recall-engine-troubleshooting-example";
  const session = await openNoEmbeddingRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope: `recall-troubleshooting:${runId}`,
    });
    await aionis.health();

    const missingCandidate = await aionis.governMemory<Record<string, unknown>>({
      run_id: `${runId}:candidate-miss`,
      query_text: "Continue from the current route, but the expected memory candidate was not retrieved upstream.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates: [
        candidate({
          id: "retrieved:irrelevant-note",
          backend: "logs",
          title: "Irrelevant checkout note",
          text: "A harmless unrelated note was retrieved, but the expected current route candidate was not present.",
          lifecycle: "unknown",
          trust: "unknown",
          evidenceRequirement: "inspect_before_use",
        }),
      ],
    });

    const blockedCandidate = await aionis.governMemory<Record<string, unknown>>({
      run_id: `${runId}:blocked`,
      query_text: "Continue safely without reusing failed branch history.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates: [
        candidate({
          id: FAILED_ID,
          backend: "vector_db",
          title: "Failed broad checkout rewrite",
          text: "The broad checkout rewrite touched unrelated modules and failed verifier replay.",
          lifecycle: "failed",
          targetFiles: ["src/legacy/checkout.ts", "packages/api/src/search.ts"],
          evidenceRefs: [`evidence://recall-troubleshooting/${runId}/failed`],
        }),
      ],
    });

    const inspectCandidate = await aionis.governMemory<Record<string, unknown>>({
      run_id: `${runId}:inspect`,
      query_text: "Consider helper-note memory only if it is safe.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates: [
        candidate({
          id: UNKNOWN_ID,
          backend: "logs",
          title: "Unreviewed checkout helper note",
          text: "Unreviewed log note mentions a possible checkout helper, but it has no authority.",
          lifecycle: "unknown",
          trust: "unknown",
          evidenceRequirement: "inspect_before_use",
          targetFiles: ["packages/api/src/checkout-helper.ts"],
        }),
      ],
    });

    const rehydrateCandidate = await aionis.governMemory<Record<string, unknown>>({
      run_id: `${runId}:rehydrate`,
      query_text: "Use verifier trace only after raw evidence is expanded.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates: [
        candidate({
          id: REHYDRATE_ID,
          backend: "archive",
          title: "Archived verifier trace pointer",
          text: "Archived verifier trace pointer for exact replay and patch evidence.",
          lifecycle: "current",
          evidenceRequirement: "rehydrate_before_use",
          evidenceRefs: [`aionis://archives/${runId}/verifier-trace`],
        }),
      ],
    });

    const scenarios = [
      summarizeGoverned({
        scenarioId: "candidate_not_retrieved",
        governed: missingCandidate,
        expectedMemoryId: MISSING_ID,
        diagnosis: "candidate_retrieval_gap",
        expectedSurface: "absent",
        operatorNextStep:
          "Inspect upstream recall source coverage, scope, query_text, structured_recall_context, embedding availability, and visibility filters before changing admission gates.",
      }),
      summarizeGoverned({
        scenarioId: "retrieved_but_blocked",
        governed: blockedCandidate,
        expectedMemoryId: FAILED_ID,
        diagnosis: "retrieved_but_blocked",
        expectedSurface: "do_not_use",
        operatorNextStep:
          "Keep the memory as counter-evidence. Do not promote it to direct use unless new evidence changes lifecycle authority.",
      }),
      summarizeGoverned({
        scenarioId: "inspect_before_use",
        governed: inspectCandidate,
        expectedMemoryId: UNKNOWN_ID,
        diagnosis: "inspect_before_use",
        expectedSurface: "inspect_before_use",
        operatorNextStep:
          "Let the host or Agent inspect the note as reference only, or attach stronger source/evidence metadata before reuse.",
      }),
      summarizeGoverned({
        scenarioId: "rehydrate_required",
        governed: rehydrateCandidate,
        expectedMemoryId: REHYDRATE_ID,
        diagnosis: "rehydrate_required",
        expectedSurface: "rehydrate",
        operatorNextStep:
          "Fetch the raw evidence pointer before asking the Agent to act; do not increase global context budget first.",
      }),
    ];

    const result = {
      contract_version: "aionis_recall_engine_troubleshooting_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        embedding_provider: "none",
        llm_provider: "none",
      },
      methodology: {
        product_loop: "governMemory(mode=firewall) -> agent_context + receipt + admission_record",
        route: "POST /v1/memory/govern",
        purpose:
          "Provide a stable operator-facing example for classifying recall/admission/rehydrate issues without mutating Runtime memory.",
      },
      summary: {
        scenario_count: scenarios.length,
        candidate_retrieval_gap_count: scenarios.filter((entry) => entry.diagnosis === "candidate_retrieval_gap").length,
        retrieved_but_blocked_count: scenarios.filter((entry) => entry.diagnosis === "retrieved_but_blocked").length,
        inspect_before_use_count: scenarios.filter((entry) => entry.diagnosis === "inspect_before_use").length,
        rehydrate_required_count: scenarios.filter((entry) => entry.diagnosis === "rehydrate_required").length,
        prompt_payload_excluded_count: scenarios.filter((entry) => entry.evidence.prompt_payload_excluded).length,
      },
      scenarios,
      boundary:
        "This demo classifies product surfaces. It does not benchmark recall quality and does not add new governance behavior.",
    };

    fs.mkdirSync(path.dirname(outputPath()), { recursive: true });
    fs.writeFileSync(outputPath(), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    closeRuntime(session);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
