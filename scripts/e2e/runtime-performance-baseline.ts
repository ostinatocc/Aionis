#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  agentContextFromGuide,
  createAionisClient,
  feedbackFromGuide,
  memoryIdsFromGuide,
  type AionisClient,
} from "../../src/sdk.ts";
import { asRecord, repoRoot } from "./runtime-agent-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type ProfileName = "runtime" | "zvec" | "substrate" | "zvec_substrate";
type EmbeddingProvider = "none" | "openai" | "minimax" | "dashscope";

type Args = {
  iterations: number;
  warmups: number;
  profiles: ProfileName[];
  embeddingProvider: EmbeddingProvider;
  outputDir: string;
};

type RuntimeSession = {
  profile: ProfileName;
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
  tmpDir: string;
  writeDbPath: string;
  replayDbPath: string;
  zvecPath: string | null;
  substratePath: string | null;
  substrateCheckpointPath: string | null;
  substrateTarget: any | null;
  logs: string[];
};

type Timed<T> = {
  value: T;
  ms: number;
};

type IterationTiming = {
  baseline_guide_ms: number;
  observe_ms: number;
  substrate_sync_ms: number | null;
  guide_ms: number;
  feedback_ms: number | null;
  measure_ms: number;
  total_ms: number;
};

type IterationResult = IterationTiming & {
  iteration: number;
  run_id: string;
  scope: string;
  memory_id_count: number;
  used_memory_id_count: number;
  prompt_chars: number;
  prompt_token_estimate: number;
  history_used: boolean;
  rss_kb: number | null;
  sqlite_bytes: number;
  zvec_bytes: number | null;
};

type ProfileSummary = {
  profile: ProfileName;
  iterations: number;
  warmups: number;
  endpoint_latency_ms: {
    baseline_guide: LatencySummary;
    observe: LatencySummary;
    guide: LatencySummary;
    substrate_sync: LatencySummary | null;
    feedback: LatencySummary | null;
    measure: LatencySummary;
    total_loop: LatencySummary;
  };
  context: {
    prompt_chars_p50: number;
    prompt_chars_p95: number;
    prompt_token_estimate_p50: number;
    prompt_token_estimate_p95: number;
    history_used_rate: number;
    exposed_memory_ids_p50: number;
  };
  resources: {
    max_rss_mb: number | null;
    sqlite_bytes_final: number;
    sqlite_bytes_per_iteration: number;
    zvec_bytes_final: number | null;
  };
  checks: {
    runtime_health_ok: boolean;
    feedback_attribution_exercised: boolean;
    measure_exercised: boolean;
    zvec_profile_enabled: boolean;
  };
};

type LatencySummary = {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
};

type Report = {
  contract_version: "aionis_runtime_performance_baseline_v1";
  generated_at: string;
  host: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    cpu_count: number;
  };
  run_config: {
    iterations: number;
    warmups: number;
    profiles: ProfileName[];
    embedding_provider: EmbeddingProvider;
    embedding_model: string | null;
    llm_calls: false;
    rate_limits_disabled: true;
  };
  summaries: ProfileSummary[];
  rows: IterationResultByProfile[];
  caveats: string[];
};

type IterationResultByProfile = IterationResult & {
  profile: ProfileName;
};

const DEFAULT_OUTPUT_DIR = path.join(repoRoot, "docs/performance/runtime-end-to-end-baseline");

function parseArgs(argv: string[]): Args {
  let iterations = 24;
  let warmups = 4;
  let profiles: ProfileName[] = ["runtime", "zvec"];
  let embeddingProvider: EmbeddingProvider = "none";
  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--iterations") {
      iterations = positiveInt(argv[++index], "--iterations");
    } else if (arg === "--warmups") {
      warmups = positiveInt(argv[++index], "--warmups");
    } else if (arg === "--profiles") {
      profiles = parseProfiles(argv[++index] ?? "");
    } else if (arg === "--embedding-provider") {
      embeddingProvider = parseEmbeddingProvider(argv[++index] ?? "");
    } else if (arg === "--output-dir") {
      outputDir = path.resolve(argv[++index] ?? "");
    } else if (arg === "--runtime-only") {
      profiles = ["runtime"];
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s runtime:perf:baseline -- [--iterations 24] [--warmups 4] [--profiles runtime,zvec,substrate,zvec_substrate] [--embedding-provider none|minimax|openai|dashscope] [--output-dir PATH]",
        "",
        "Measures local Aionis Runtime HTTP/SDK product loop latency without external LLM or embedding calls.",
      ].join("\n"));
      process.stdout.write("\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { iterations, warmups, profiles, embeddingProvider, outputDir };
}

function positiveInt(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseProfiles(value: string): ProfileName[] {
  const profiles = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (profiles.length === 0) throw new Error("--profiles must include at least one profile");
  for (const profile of profiles) {
    if (!isProfileName(profile)) {
      throw new Error(`invalid profile ${profile}; expected runtime, zvec, substrate, or zvec_substrate`);
    }
  }
  return Array.from(new Set(profiles)) as ProfileName[];
}

function isProfileName(value: string): value is ProfileName {
  return value === "runtime" || value === "zvec" || value === "substrate" || value === "zvec_substrate";
}

function profileUsesZvec(profile: ProfileName): boolean {
  return profile === "zvec" || profile === "zvec_substrate";
}

function profileUsesSubstrate(profile: ProfileName): boolean {
  return profile === "substrate" || profile === "zvec_substrate";
}

function parseEmbeddingProvider(value: string): EmbeddingProvider {
  if (value === "none" || value === "openai" || value === "minimax" || value === "dashscope") return value;
  throw new Error(`invalid --embedding-provider ${value}; expected none, openai, minimax, or dashscope`);
}

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
      server.close(() => resolve(address.port));
    });
  });
}

async function startRuntime(profile: ProfileName, embeddingProvider: EmbeddingProvider): Promise<RuntimeSession> {
  if (profileUsesZvec(profile)) {
    try {
      await import("@zvec/zvec");
    } catch (err) {
      throw new Error(`zvec profile requires optional dependency @zvec/zvec. ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (profileUsesSubstrate(profile)) {
    try {
      await import("@aionis/substrate");
    } catch (err) {
      throw new Error(`substrate profile requires optional dependency @aionis/substrate. ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const port = await findFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-runtime-perf-${profile}-`));
  const writeDbPath = path.join(tmpDir, "write.sqlite");
  const replayDbPath = path.join(tmpDir, "replay.sqlite");
  const zvecPath = profileUsesZvec(profile) ? path.join(tmpDir, "ann.zvec") : null;
  const substratePath = profileUsesSubstrate(profile) ? path.join(tmpDir, "substrate.sqlite") : null;
  const substrateCheckpointPath = profileUsesSubstrate(profile) ? path.join(tmpDir, "substrate-checkpoint.json") : null;
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
      LITE_LOCAL_ACTOR_ID: "perf-runner",
      LITE_WRITE_SQLITE_PATH: writeDbPath,
      LITE_REPLAY_SQLITE_PATH: replayDbPath,
      EMBEDDING_PROVIDER: embeddingProvider,
      SANDBOX_ENABLED: "false",
      SANDBOX_ADMIN_ONLY: "true",
      RECALL_ANN_PROVIDER: profileUsesZvec(profile) ? "zvec" : "off",
      RECALL_ZVEC_PATH: zvecPath ?? "",
      RECALL_ANN_REBUILD_ON_START: profileUsesZvec(profile) ? "true" : "false",
      RECALL_ANN_MAX_CANDIDATES: "200",
      RECALL_SUBSTRATE_SIDECAR_ENABLED: profileUsesSubstrate(profile) ? "true" : "false",
      RECALL_SUBSTRATE_PATH: substratePath ?? "",
      RECALL_SUBSTRATE_MAX_CANDIDATES: "200",
      RECALL_SUBSTRATE_FAIL_OPEN: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => pushLog(logs, chunk));
  child.stderr.on("data", (chunk) => pushLog(logs, chunk));

  const session: RuntimeSession = {
    profile,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    tmpDir,
    writeDbPath,
    replayDbPath,
    zvecPath,
    substratePath,
    substrateCheckpointPath,
    substrateTarget: null,
    logs,
  };

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${session.baseUrl}/health`);
      if (res.ok) {
        if (profileUsesSubstrate(profile)) {
          const substrate = await import("@aionis/substrate");
          session.substrateTarget = await substrate.openSqliteAionisSubstrate({
            path: substratePath as string,
            rebuildCandidateIndexOnOpen: false,
          });
        }
        return session;
      }
    } catch {
      // Runtime is still booting.
    }
    await sleep(200);
  }
  await stopRuntime(session);
  throw new Error(`Aionis Runtime did not become healthy for profile=${profile}.\n${logs.join("").slice(-4_000)}`);
}

function pushLog(logs: string[], chunk: unknown): void {
  logs.push(String(chunk));
  if (logs.length > 120) logs.splice(0, logs.length - 120);
}

async function stopRuntime(session: RuntimeSession): Promise<void> {
  await session.substrateTarget?.close?.();
  if (session.child.exitCode === null) session.child.kill("SIGTERM");
}

async function syncSubstrate(session: RuntimeSession, scope: string): Promise<Timed<unknown> | null> {
  if (!session.substrateTarget || !session.substrateCheckpointPath) return null;
  return await timed(async () => {
    const substrate = await import("@aionis/substrate");
    return await substrate.runRuntimeLiveSidecarOnce({
      sourcePath: session.writeDbPath,
      target: session.substrateTarget,
      checkpointPath: session.substrateCheckpointPath as string,
      scope,
    });
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - start) };
}

function nodeIdFromObserve(payload: unknown): string | null {
  const record = asRecord(payload);
  const write = asRecord(record?.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes : [];
  const first = asRecord(nodes[0]);
  const id = first?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function runIteration(args: {
  client: AionisClient;
  session: RuntimeSession;
  iteration: number;
  includeInReport: boolean;
  embeddingProvider: EmbeddingProvider;
}): Promise<IterationResult> {
  const runId = `runtime-perf-${args.session.profile}-${randomUUID()}`;
  const scope = `runtime-performance/${args.session.profile}`;
  const taskSignature = `runtime-performance-baseline:${args.session.profile}:${args.iteration}`;
  const taskFamily = "runtime_performance_baseline";
  const workflowSignature = "local-http-sdk-observe-guide-feedback-measure";
  const targetFile = `src/perf/current-${String(args.iteration).padStart(3, "0")}.ts`;
  const marker = `AIONIS_PERF_${args.session.profile.toUpperCase()}_${String(args.iteration).padStart(3, "0")}`;
  const queryText = [
    marker,
    `Continue ${taskSignature}.`,
    `Use the current accepted route for ${targetFile}.`,
    "Return compact execution context and admission receipt.",
  ].join(" ");

  const beforeGuide = await timed(() => args.client.guide<Record<string, unknown>>({
    mode: "standard",
    tenant_id: "default",
    scope,
    run_id: runId,
    query_text: queryText,
    consumer_agent_id: "perf-worker",
    limit: 8,
    include_packets: true,
    context_char_budget: 12_000,
    context_compaction_profile: "balanced",
    context_optimization_profile: "balanced",
  }));

  const observe = await timed(() => args.client.remember<Record<string, unknown>>({
    kind: "project_context",
    client_id: `runtime-performance:${args.session.profile}:${args.iteration}:${runId}`,
    title: `Runtime performance accepted route ${args.iteration}`,
    text: `${marker}: Current accepted route is ${targetFile}. Keep this compact execution state and reuse the verifier-backed path for ${taskSignature}.`,
    memory_lane: "shared",
    auto_embed: args.embeddingProvider !== "none",
    target_files: [targetFile],
    confidence: 0.92,
    slots: {
      source: "runtime_performance_baseline",
      run_id: runId,
      task_signature: taskSignature,
      task_family: taskFamily,
      workflow_signature: workflowSignature,
      acceptance_check: "focused verifier passed",
      evidence_ref: `evidence://runtime-performance/${runId}/verifier`,
    },
  }));
  const observedMemoryId = nodeIdFromObserve(observe.value);
  const substrateSync = await syncSubstrate(args.session, scope);

  const guide = await timed(() => args.client.guide<Record<string, unknown>>({
    mode: "standard",
    tenant_id: "default",
    scope,
    run_id: runId,
    query_text: queryText,
    consumer_agent_id: "perf-worker",
    limit: 8,
    include_packets: true,
    context_char_budget: 12_000,
    context_compaction_profile: "balanced",
    context_optimization_profile: "balanced",
  }));
  const agentContext = asRecord(agentContextFromGuide(guide.value)) ?? {};
  const promptText = typeof agentContext.prompt_text === "string" ? agentContext.prompt_text : "";
  const memoryIds = memoryIdsFromGuide(guide.value);
  const usedMemoryIds = observedMemoryId && memoryIds.includes(observedMemoryId)
    ? [observedMemoryId]
    : memoryIds.slice(0, 1);

  let feedback: Timed<Record<string, unknown> | null>;
  if (usedMemoryIds.length > 0) {
    feedback = await timed(() => args.client.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide: guide.value,
      reason: "Performance baseline agent used the compact governed context.",
      run_id: `feedback:${runId}`,
      outcome: "positive",
      used_memory_ids: usedMemoryIds,
      used_surface: "use_now",
      actor: "perf-worker",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: [`evidence://runtime-performance/${runId}/verifier`],
    })));
  } else {
    feedback = { value: null, ms: 0 };
  }

  const measure = await timed(() => args.client.execution.measureRun<Record<string, unknown>>({
    tenant_id: "default",
    scope,
    run_id: runId,
    task_id: `task:${runId}`,
    task_signature: taskSignature,
    task_family: taskFamily,
    workflow_signature: workflowSignature,
    before_guide: beforeGuide.value,
    after_guide: guide.value,
    feedback_result: feedback.value,
    sufficient_evidence: true,
    evidence_ids: [
      ...(observedMemoryId ? [`memory:${observedMemoryId}`] : []),
      `guide:${runId}`,
      `measure:${runId}`,
    ],
  }));

  const timings: IterationTiming = {
    baseline_guide_ms: beforeGuide.ms,
    observe_ms: observe.ms,
    substrate_sync_ms: substrateSync?.ms ?? null,
    guide_ms: guide.ms,
    feedback_ms: usedMemoryIds.length > 0 ? feedback.ms : null,
    measure_ms: measure.ms,
    total_ms: round(beforeGuide.ms + observe.ms + (substrateSync?.ms ?? 0) + guide.ms + feedback.ms + measure.ms),
  };

  return {
    iteration: args.iteration,
    run_id: runId,
    scope,
    ...timings,
    memory_id_count: memoryIds.length,
    used_memory_id_count: usedMemoryIds.length,
    prompt_chars: promptText.length,
    prompt_token_estimate: estimateTokens(promptText),
    history_used: agentContext.history_used === true,
    rss_kb: rssKb(args.session.child.pid),
    sqlite_bytes: sqliteBytes(args.session),
    zvec_bytes: args.session.zvecPath ? directoryBytes(args.session.zvecPath) : null,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function rssKb(pid: number | undefined): number | null {
  if (!pid) return null;
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function sqliteBytes(session: RuntimeSession): number {
  return [
    session.writeDbPath,
    `${session.writeDbPath}-wal`,
    `${session.writeDbPath}-shm`,
    session.replayDbPath,
    `${session.replayDbPath}-wal`,
    `${session.replayDbPath}-shm`,
  ].reduce((sum, entry) => sum + fileBytes(entry), 0);
}

function fileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(root)) {
    total += directoryBytes(path.join(root, entry));
  }
  return total;
}

async function runProfile(args: Args, profile: ProfileName): Promise<{
  summary: ProfileSummary;
  rows: IterationResultByProfile[];
}> {
  const session = await startRuntime(profile, args.embeddingProvider);
  try {
    const client = createAionisClient({
      baseUrl: session.baseUrl,
      tenant_id: "default",
      scope: `runtime-performance/${profile}`,
      default_guide_mode: "full_power",
    });
    await client.health();
    for (let warmup = 0; warmup < args.warmups; warmup += 1) {
      await runIteration({ client, session, iteration: warmup, includeInReport: false, embeddingProvider: args.embeddingProvider });
    }
    const rows: IterationResultByProfile[] = [];
    for (let iteration = 0; iteration < args.iterations; iteration += 1) {
      const row = await runIteration({ client, session, iteration, includeInReport: true, embeddingProvider: args.embeddingProvider });
      rows.push({ profile, ...row });
    }
    return { summary: summarizeProfile(profile, args, rows), rows };
  } finally {
    await stopRuntime(session);
  }
}

function summarizeProfile(profile: ProfileName, args: Args, rows: IterationResultByProfile[]): ProfileSummary {
  const feedbackRows = rows.filter((row) => row.feedback_ms !== null).map((row) => row.feedback_ms as number);
  const substrateRows = rows.filter((row) => row.substrate_sync_ms !== null).map((row) => row.substrate_sync_ms as number);
  const sqliteFinal = rows.at(-1)?.sqlite_bytes ?? 0;
  const zvecFinal = rows.at(-1)?.zvec_bytes ?? null;
  const maxRss = compactNumbers(rows.map((row) => row.rss_kb)).reduce((max, value) => Math.max(max, value), 0);
  return {
    profile,
    iterations: rows.length,
    warmups: args.warmups,
    endpoint_latency_ms: {
      baseline_guide: latency(rows.map((row) => row.baseline_guide_ms)),
      observe: latency(rows.map((row) => row.observe_ms)),
      guide: latency(rows.map((row) => row.guide_ms)),
      substrate_sync: substrateRows.length > 0 ? latency(substrateRows) : null,
      feedback: feedbackRows.length > 0 ? latency(feedbackRows) : null,
      measure: latency(rows.map((row) => row.measure_ms)),
      total_loop: latency(rows.map((row) => row.total_ms)),
    },
    context: {
      prompt_chars_p50: percentile(rows.map((row) => row.prompt_chars), 0.5),
      prompt_chars_p95: percentile(rows.map((row) => row.prompt_chars), 0.95),
      prompt_token_estimate_p50: percentile(rows.map((row) => row.prompt_token_estimate), 0.5),
      prompt_token_estimate_p95: percentile(rows.map((row) => row.prompt_token_estimate), 0.95),
      history_used_rate: round(rows.filter((row) => row.history_used).length / Math.max(1, rows.length)),
      exposed_memory_ids_p50: percentile(rows.map((row) => row.memory_id_count), 0.5),
    },
    resources: {
      max_rss_mb: maxRss > 0 ? round(maxRss / 1024) : null,
      sqlite_bytes_final: sqliteFinal,
      sqlite_bytes_per_iteration: round(sqliteFinal / Math.max(1, rows.length + args.warmups)),
      zvec_bytes_final: zvecFinal,
    },
    checks: {
      runtime_health_ok: true,
      feedback_attribution_exercised: rows.some((row) => row.used_memory_id_count > 0),
      measure_exercised: rows.every((row) => row.measure_ms > 0),
      zvec_profile_enabled: profileUsesZvec(profile),
    },
  };
}

function compactNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function latency(values: number[]): LatencySummary {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return round(sorted[index]);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function renderMarkdown(report: Report): string {
  const lines = [
    "# Aionis Runtime End-to-End Performance Baseline",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "This report measures the local Aionis product loop over real HTTP/SDK calls:",
    "",
    "`/v1/guide (baseline) -> /v1/observe -> /v1/guide -> /v1/measure`",
    "",
    "`/v1/feedback` is included when the guide exposes attributable memory ids for the referenced guide trace.",
    "",
    report.run_config.embedding_provider === "none"
      ? "It does not include external LLM latency or external embedding provider latency. Embedding is disabled so the numbers isolate Runtime overhead."
      : `It does not include external LLM latency. It does include ${report.run_config.embedding_provider}${report.run_config.embedding_model ? `/${report.run_config.embedding_model}` : ""} embedding latency for write/guide surfaces.`,
    "",
    `Embedding profile: ${report.run_config.embedding_provider}${report.run_config.embedding_model ? ` / ${report.run_config.embedding_model}` : ""}`,
    "",
    "## Summary",
    "",
    "| Profile | Iterations | Baseline Guide P50/P95 | Observe P50/P95 | Substrate Sync P50/P95 | After Guide P50/P95 | Feedback P50/P95 | Measure P50/P95 | Total Loop P50/P95 | Prompt chars P50/P95 | Max RSS | SQLite final |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.summaries.map((entry) => {
      const feedback = entry.endpoint_latency_ms.feedback;
      const substrateSync = entry.endpoint_latency_ms.substrate_sync;
      return [
        `| ${entry.profile}`,
        String(entry.iterations),
        `${entry.endpoint_latency_ms.baseline_guide.p50} / ${entry.endpoint_latency_ms.baseline_guide.p95} ms`,
        `${entry.endpoint_latency_ms.observe.p50} / ${entry.endpoint_latency_ms.observe.p95} ms`,
        substrateSync ? `${substrateSync.p50} / ${substrateSync.p95} ms` : "n/a",
        `${entry.endpoint_latency_ms.guide.p50} / ${entry.endpoint_latency_ms.guide.p95} ms`,
        feedback ? `${feedback.p50} / ${feedback.p95} ms` : "n/a",
        `${entry.endpoint_latency_ms.measure.p50} / ${entry.endpoint_latency_ms.measure.p95} ms`,
        `${entry.endpoint_latency_ms.total_loop.p50} / ${entry.endpoint_latency_ms.total_loop.p95} ms`,
        `${entry.context.prompt_chars_p50} / ${entry.context.prompt_chars_p95}`,
        entry.resources.max_rss_mb === null ? "n/a" : `${entry.resources.max_rss_mb} MB`,
        `${Math.round(entry.resources.sqlite_bytes_final / 1024)} KB |`,
      ].join(" | ");
    }),
    "",
    "## Profile Notes",
    "",
    ...report.summaries.flatMap((entry) => [
      `### ${entry.profile}`,
      "",
      `- History-used rate: ${Math.round(entry.context.history_used_rate * 100)}%`,
      `- Exposed memory IDs P50: ${entry.context.exposed_memory_ids_p50}`,
      `- Feedback attribution exercised: ${entry.checks.feedback_attribution_exercised ? "yes" : "no"}`,
      `- Zvec bytes final: ${entry.resources.zvec_bytes_final === null ? "n/a" : `${Math.round(entry.resources.zvec_bytes_final / 1024)} KB`}`,
      "",
    ]),
    "## Caveats",
    "",
    ...report.caveats.map((entry) => `- ${entry}`),
    "",
    "## Raw Data",
    "",
    "See `summary.json` in this directory for per-iteration rows.",
    "",
  ];
  return lines.join("\n");
}

function writeReport(report: Report, outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "summary.md"), renderMarkdown(report));
}

function embeddingModel(provider: EmbeddingProvider): string | null {
  if (provider === "dashscope") return process.env.DASHSCOPE_EMBEDDING_MODEL?.trim() || "text-embedding-v4";
  if (provider === "openai") return process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  if (provider === "minimax") return process.env.MINIMAX_EMBED_MODEL?.trim() || "embo-01";
  return null;
}

function reportCaveats(embeddingProvider: EmbeddingProvider, model: string | null): string[] {
  return [
    "Local-machine diagnostic baseline; do not compare across machines without rerunning.",
    embeddingProvider === "none"
      ? "Embedding provider and LLM calls are disabled to isolate Runtime HTTP/SDK overhead."
      : `LLM calls are disabled; ${embeddingProvider}${model ? `/${model}` : ""} embedding provider latency is included for write and guide surfaces.`,
    embeddingProvider === "none"
      ? "The no-embedding profile may not exercise feedback attribution because guide only accepts feedback for memory ids exposed by the referenced guide trace."
      : "Feedback attribution is measured only when the guide exposes memory ids for the referenced guide trace.",
    "Zvec, when present, is an optional candidate index profile; SQLite remains the truth source and governance still runs after candidate retrieval.",
    "This report measures product loop latency and resource footprint, not external task success rate.",
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summaries: ProfileSummary[] = [];
  const rows: IterationResultByProfile[] = [];
  for (const profile of args.profiles) {
    try {
      const result = await runProfile(args, profile);
      summaries.push(result.summary);
      rows.push(...result.rows);
    } catch (err) {
      if (profile === "zvec") {
        process.stderr.write(`Skipping zvec profile: ${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
      throw err;
    }
  }
  const selectedEmbeddingModel = embeddingModel(args.embeddingProvider);
  const report: Report = {
    contract_version: "aionis_runtime_performance_baseline_v1",
    generated_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu_count: os.cpus().length,
    },
    run_config: {
      iterations: args.iterations,
      warmups: args.warmups,
      profiles: summaries.map((entry) => entry.profile),
      embedding_provider: args.embeddingProvider,
      embedding_model: selectedEmbeddingModel,
      llm_calls: false,
      rate_limits_disabled: true,
    },
    summaries,
    rows,
    caveats: reportCaveats(args.embeddingProvider, selectedEmbeddingModel),
  };
  writeReport(report, args.outputDir);
  process.stdout.write(`${JSON.stringify({
    contract_version: report.contract_version,
    output_dir: args.outputDir,
    summaries,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
