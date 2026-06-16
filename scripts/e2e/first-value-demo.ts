#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
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

const CURRENT_ID = "demo:current-checkout-route";
const FAILED_ID = "demo:failed-broad-rewrite";
const STALE_ID = "demo:stale-legacy-target";
const REHYDRATE_ID = "demo:archived-verifier-trace";
const UNKNOWN_ID = "demo:unknown-helper-note";

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

async function openNoEmbeddingRuntime(): Promise<RuntimeSession> {
  const externalBaseUrl = (
    process.env.AIONIS_FIRST_VALUE_DEMO_BASE_URL
    || process.env.AIONIS_PRODUCT_E2E_BASE_URL
    || process.env.AIONIS_BASE_URL
    || process.env.AIONIS_URL
    || ""
  ).trim();
  if (externalBaseUrl) {
    return { baseUrl: externalBaseUrl.replace(/\/+$/, ""), mode: "external", handle: null };
  }

  const port = await findFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-first-value-"));
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
      // wait for startup
    }
    await sleep(250);
  }
  closeRuntime({ baseUrl, mode: "spawned_no_embedding", handle: { child, tmpDir, logs } });
  throw new Error(`Aionis Runtime did not become healthy.\n${logs.join("").slice(-4_000)}`);
}

function closeRuntime(session: RuntimeSession): void {
  if (session.handle?.child.exitCode === null) session.handle.child.kill("SIGTERM");
}

function apiKey(): string | null {
  return process.env.AIONIS_FIRST_VALUE_DEMO_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function rehydrateIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry)?.memory_id)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function candidate(input: {
  id: string;
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
    source_backend: "demo_memory",
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

function noisyFailureText(marker: string): string {
  const repeated = Array.from({ length: 18 }, (_, index) => (
    `${marker} noisy retrieval paragraph ${index + 1}: broad rewrite touched checkout, search, payments, metrics, and adapter files; verifier replay rejected it; do not extend this route.`
  )).join(" ");
  return `${marker}: rejected broad rewrite route. ${repeated}`;
}

function demoCandidates(runId: string): AionisExternalMemoryCandidate[] {
  return [
    candidate({
      id: FAILED_ID,
      title: "Rejected broad rewrite",
      lifecycle: "failed",
      text: noisyFailureText("FAILED_ROUTE"),
      targetFiles: [
        "packages/api/src/search.ts",
        "packages/api/src/payments.ts",
        "packages/api/src/metrics.ts",
      ],
      evidenceRefs: [`evidence://first-value/${runId}/failed-broad-rewrite`],
    }),
    candidate({
      id: STALE_ID,
      title: "Older legacy target",
      lifecycle: "stale",
      trust: "known",
      text: noisyFailureText("STALE_ROUTE"),
      targetFiles: ["src/legacy/checkout.ts"],
    }),
    candidate({
      id: CURRENT_ID,
      title: "Accepted checkout target",
      lifecycle: "current",
      text: "CURRENT_ROUTE: accepted target is packages/api/src/checkout.ts. Continue this route and keep the focused verifier replay.",
      targetFiles: ["packages/api/src/checkout.ts"],
      evidenceRefs: [`evidence://first-value/${runId}/current-checkout-route`],
    }),
    candidate({
      id: REHYDRATE_ID,
      title: "Archived verifier trace",
      lifecycle: "current",
      evidenceRequirement: "rehydrate_before_use",
      text: "RAW_EVIDENCE pointer exists for exact checkout verifier output; fetch only if the worker needs the full trace.",
      evidenceRefs: [`aionis://archive/${runId}/checkout-verifier-trace`],
    }),
    candidate({
      id: UNKNOWN_ID,
      title: "Unreviewed helper note",
      lifecycle: "unknown",
      trust: "unknown",
      evidenceRequirement: "inspect_before_use",
      text: "Unreviewed log note mentions a possible checkout helper, but no verifier evidence is attached.",
    }),
  ];
}

function rawPrompt(candidates: AionisExternalMemoryCandidate[]): string {
  return [
    "RAW RETRIEVAL CONTEXT",
    "Every retrieved memory below is direct Agent context.",
    ...candidates.map((candidateValue, index) => [
      `MEMORY ${index + 1}`,
      `id=${candidateValue.external_memory_id}`,
      `lifecycle=${candidateValue.lifecycle_hint ?? "unknown"}`,
      `title=${String(asRecord(candidateValue.metadata)?.title ?? candidateValue.external_memory_id)}`,
      candidateValue.text,
    ].join("\n")),
  ].join("\n\n");
}

async function main() {
  const runId = `first-value-${randomUUID().slice(0, 8)}`;
  const session = await openNoEmbeddingRuntime();
  try {
    const client = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope: `first-value:${runId}`,
    });
    await client.health();

    const candidates = demoCandidates(runId);
    const rawPromptText = rawPrompt(candidates);
    const governed = await client.governMemory<Record<string, unknown>>({
      run_id: runId,
      query_text: "Continue checkout migration without retrying failed or stale branches.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates,
    });

    const agentContext = asRecord(governed.agent_context);
    const firewall = asRecord(governed.memory_firewall);
    const receipt = asRecord(governed.memory_use_receipt);
    const admissionRecord = asRecord(governed.memory_admission_records);
    const promptText = String(agentContext?.prompt_text ?? "");
    const useNow = textArray(agentContext?.use_now_memory_ids);
    const inspect = textArray(agentContext?.inspect_before_use_memory_ids);
    const doNotUse = textArray(agentContext?.do_not_use_memory_ids);
    const rehydrate = rehydrateIds(agentContext?.rehydrate_hints);

    assertCondition(governed.contract_version === "aionis_memory_admission_gateway_result_v1", "first-value demo missing gateway contract");
    assertCondition(agentContext?.contract_version === "aionis_agent_context_v1", "first-value demo missing agent context");
    assertCondition(firewall?.contract_version === "aionis_memory_firewall_summary_v1", "first-value demo missing firewall summary");
    assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", "first-value demo missing memory use receipt");
    assertCondition(admissionRecord?.contract_version === "aionis_memory_admission_record_v1", "first-value demo missing admission record");
    assertCondition(useNow.includes(CURRENT_ID), "current accepted route did not enter use_now");
    assertCondition(doNotUse.includes(FAILED_ID), "failed branch was not blocked");
    assertCondition(doNotUse.includes(STALE_ID), "stale branch was not blocked");
    assertCondition(inspect.includes(UNKNOWN_ID), "unknown memory did not remain inspect-first");
    assertCondition(rehydrate.includes(REHYDRATE_ID), "rehydrate-required memory did not remain pointer-only");
    assertCondition(firewall.unsafe_direct_use_count === 0, "Aionis allowed unsafe direct use");
    assertCondition(firewall.runtime_mutation === false, "first-value governance mutated Runtime memory");
    assertCondition(!promptText.includes("noisy retrieval paragraph"), "Aionis prompt included noisy unsafe raw retrieval payload");
    assertCondition(!promptText.includes("memory_admission_records"), "Aionis prompt leaked admission record internals");
    assertCondition(!promptText.includes("memory_use_receipt"), "Aionis prompt leaked receipt internals");

    const rawUnsafeDirectUseIds = [FAILED_ID, STALE_ID, UNKNOWN_ID];
    const promptReductionPct = Number((((rawPromptText.length - promptText.length) / rawPromptText.length) * 100).toFixed(1));
    const result = {
      contract_version: "aionis_first_value_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: "none",
      },
      aha:
        "Raw retrieval would place failed and stale memories in direct Agent context. Aionis admits the current route, blocks unsafe branches, keeps rehydrate pointer-only, and emits an audit receipt.",
      no_key_required: true,
      product_path: "external candidates -> governMemory(mode=firewall) -> compact agent_context + memory_use_receipt",
      raw_retrieval: {
        direct_use_memory_ids: candidates.map((entry) => entry.external_memory_id),
        unsafe_direct_use_memory_ids: rawUnsafeDirectUseIds,
        prompt_char_count: rawPromptText.length,
        audit_coverage: false,
      },
      aionis: {
        use_now_memory_ids: useNow,
        inspect_before_use_memory_ids: inspect,
        do_not_use_memory_ids: doNotUse,
        rehydrate_memory_ids: rehydrate,
        unsafe_direct_use_memory_ids: rawUnsafeDirectUseIds.filter((id) => useNow.includes(id)),
        prompt_char_count: promptText.length,
        prompt_reduction_vs_raw_pct: promptReductionPct,
        audit_coverage: true,
        memory_use_receipt: {
          contract_version: receipt.contract_version,
          prompt_char_count: receipt.prompt_char_count,
          exposed_memory_ids: textArray(receipt.exposed_memory_ids),
          risk_flags: textArray(receipt.risk_flags),
        },
      },
      checks: {
        current_route_preserved: useNow.includes(CURRENT_ID),
        failed_branch_blocked: doNotUse.includes(FAILED_ID),
        stale_branch_blocked: doNotUse.includes(STALE_ID),
        unknown_memory_inspect_first: inspect.includes(UNKNOWN_ID),
        rehydrate_pointer_only: rehydrate.includes(REHYDRATE_ID),
        unsafe_direct_use_zero: firewall.unsafe_direct_use_count === 0,
        receipt_visible: receipt.contract_version === "aionis_memory_use_receipt_v1",
        prompt_smaller_than_raw: promptText.length < rawPromptText.length,
      },
      boundary:
        "This demo does not require embeddings or an LLM. It proves Aionis admission and audit behavior on the first local run, not final Agent task success.",
    };

    const outputPath = path.join(repoRoot, "docs/examples/first-value-demo-result.json");
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
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
