#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
  type RuntimeSession,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type ExternalPackageInstall = {
  tmpRoot: string;
  appDir: string;
  sdkSpec: string;
  mcpSpec: string;
  createSpec: string;
};

type ExternalSmokeEmbeddingExpectation = "available" | "unavailable";

const SDK_MARKER = "EXTERNAL_PACKAGE_SMOKE_SDK_MEMORY";
const MCP_MARKER = "EXTERNAL_PACKAGE_SMOKE_MCP_MEMORY";
const DEFAULT_SDK_SPEC = "@aionis/sdk@latest";
const DEFAULT_MCP_SPEC = "@aionis/mcp@latest";
const DEFAULT_CREATE_SPEC = "@aionis/create@latest";
const EXTERNAL_PACKAGE_SECRET_ENV_KEYS = new Set([
  "AIONIS_AGENT_E2E_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);

function run(command: string, args: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  maxOutputChars?: number;
}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${options.label} failed with exit code ${result.status ?? "unknown"}\n${output.slice(-(options.maxOutputChars ?? 6_000))}`);
  }
  return output;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeModulesBin(appDir: string, binName: string): string {
  return process.platform === "win32"
    ? path.join(appDir, "node_modules", ".bin", `${binName}.cmd`)
    : path.join(appDir, "node_modules", ".bin", binName);
}

function packageSpecFromEnv(envName: string, fallback: string): string {
  return process.env[envName]?.trim() || fallback;
}

function externalPackageChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !EXTERNAL_PACKAGE_SECRET_ENV_KEYS.has(key)) env[key] = value;
  }
  return env;
}

function embeddingExpectationForSession(
  session: RuntimeSession,
): ExternalSmokeEmbeddingExpectation {
  const explicit = process.env.AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION?.trim();
  if (explicit) {
    if (explicit === "available" || explicit === "unavailable") return explicit;
    throw new Error(
      "AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION must be available or unavailable",
    );
  }
  if (session.embedding) return "available";
  const provider = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (provider === "none") return "unavailable";
  if (provider === "openai" || provider === "minimax" || provider === "dashscope") {
    return "available";
  }
  throw new Error(
    "external Runtime smoke requires AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION=available|unavailable",
  );
}

function expectedEmbeddingModelForSession(
  session: RuntimeSession,
  expectation: ExternalSmokeEmbeddingExpectation,
): string | null {
  if (expectation === "unavailable") return null;
  const explicit = process.env.AIONIS_EXTERNAL_SMOKE_EXPECTED_EMBEDDING_MODEL?.trim();
  if (explicit) return explicit;
  const provider = session.embedding?.provider ?? process.env.EMBEDDING_PROVIDER?.trim();
  if (provider === "dashscope") {
    return `dashscope:${process.env.DASHSCOPE_EMBEDDING_MODEL?.trim() || "text-embedding-v4"}`;
  }
  if (provider === "openai") {
    return `openai:${process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small"}`;
  }
  if (provider === "minimax") {
    const model = process.env.MINIMAX_EMBED_MODEL?.trim() || "embo-01";
    const type = process.env.MINIMAX_EMBED_DB_TYPE?.trim()
      || process.env.MINIMAX_EMBED_TYPE?.trim()
      || "db";
    return `minimax:${model}:${type}`;
  }
  throw new Error(
    "embedding-available external Runtime smoke requires AIONIS_EXTERNAL_SMOKE_EXPECTED_EMBEDDING_MODEL",
  );
}

function prepareExternalInstall(): ExternalPackageInstall {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-external-package-smoke-"));
  const appDir = path.join(tmpRoot, "external-app");
  fs.mkdirSync(appDir, { recursive: true });
  const sdkSpec = packageSpecFromEnv("AIONIS_EXTERNAL_SMOKE_SDK_SPEC", DEFAULT_SDK_SPEC);
  const mcpSpec = packageSpecFromEnv("AIONIS_EXTERNAL_SMOKE_MCP_SPEC", DEFAULT_MCP_SPEC);
  const createSpec = packageSpecFromEnv("AIONIS_EXTERNAL_SMOKE_CREATE_SPEC", DEFAULT_CREATE_SPEC);

  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "aionis-external-package-smoke",
      private: true,
      type: "module",
    }, null, 2),
  );

  run(npmCommand(), [
    "install",
    "--silent",
    "--no-audit",
    "--fund=false",
    sdkSpec,
    mcpSpec,
    createSpec,
  ], {
    cwd: appDir,
    env: externalPackageChildEnv(),
    label: "external npm install",
    maxOutputChars: 10_000,
  });

  return { tmpRoot, appDir, sdkSpec, mcpSpec, createSpec };
}

function writeExternalSdkSmoke(appDir: string): string {
  const scriptPath = path.join(appDir, "sdk-smoke.mjs");
  fs.writeFileSync(scriptPath, `
import {
  agentContextFromGuide,
  createAionisClient,
  feedbackAttributionFromGuide,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop
} from "@aionis/sdk";

const marker = ${JSON.stringify(SDK_MARKER)};
const taskFamily = "external_package_entrypoint";
const taskSignature = "external-package-sdk-smoke:" + (process.env.AIONIS_EXTERNAL_SMOKE_RUN_ID || "external-package-sdk-smoke");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function textArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function firstNodeId(observeBody, label) {
  const write = asRecord(observeBody.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes : [];
  const first = asRecord(nodes[0]);
  assertCondition(typeof first?.id === "string" && first.id.length > 0, label + " did not return node id");
  return first.id;
}

const baseUrl = process.env.AIONIS_EXTERNAL_SMOKE_BASE_URL;
assertCondition(baseUrl, "AIONIS_EXTERNAL_SMOKE_BASE_URL is required");
const embeddingExpectation = process.env.AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION;
assertCondition(
  embeddingExpectation === "available" || embeddingExpectation === "unavailable",
  "AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION must be available or unavailable",
);
const expectedEmbeddingModel = process.env.AIONIS_EXTERNAL_SMOKE_EXPECTED_EMBEDDING_MODEL || null;
if (embeddingExpectation === "available") {
  assertCondition(expectedEmbeddingModel, "expected embedding model is required for available mode");
}
const scope = process.env.AIONIS_EXTERNAL_SMOKE_SCOPE || "external-package-smoke-sdk";
const runId = process.env.AIONIS_EXTERNAL_SMOKE_RUN_ID || "external-package-smoke-sdk";
const client = createAionisClient({
  baseUrl,
  tenant_id: "default",
  scope,
});

await client.health();
const beforeGuide = await client.execution.guideForRole({
  agent_id: "external-sdk-agent",
  role: "reviewer",
  run_id: runId + ":before",
  task_signature: taskSignature,
  task_family: taskFamily,
  query_text: marker + " before memory exists",
  mode: "full_power",
  context_mode: "compact_agent",
  limit: 10,
  include_packets: true,
});
const beforeContext = agentContextFromGuide(beforeGuide);
assertCondition(beforeContext.actionable_history_used === false, "SDK packaged fresh task unexpectedly started with actionable history");

const remembered = await client.remember({
  kind: "project_context",
  title: "External package SDK smoke memory",
  text: marker + ": use the packaged SDK path for the external developer smoke.",
  memory_lane: "private",
  owner_agent_id: "external-sdk-agent",
  confidence: 0.93,
  target_files: ["README.md"],
  slots: { source: "external_package_smoke" },
});
const memoryId = firstNodeId(remembered, "external SDK remember");
const resolvedMemory = await client.resolveMemory({
  uri: "aionis://default/" + encodeURIComponent(scope) + "/topic/" + encodeURIComponent(memoryId),
  consumer_agent_id: "external-sdk-agent",
  include_meta: true,
  include_slots: true,
});
const resolvedNode = asRecord(resolvedMemory.node);
assertCondition(resolvedNode?.id === memoryId, "SDK packaged remember was not synchronously resolvable");
assertCondition(String(resolvedNode?.text_summary ?? "").includes(marker), "SDK packaged resolved memory missing marker");
if (embeddingExpectation === "available") {
  assertCondition(resolvedNode?.embedding_status === "ready", "SDK packaged memory embedding was not ready");
  assertCondition(
    resolvedNode?.embedding_model === expectedEmbeddingModel,
    "SDK packaged memory used unexpected embedding model: " + String(resolvedNode?.embedding_model ?? "missing"),
  );
}

const handoff = await client.execution.handoff({
  operation_id: "external-package-sdk-handoff:" + runId,
  auto_embed: false,
  agent_id: "external-sdk-agent",
  role: "worker",
  run_id: runId + ":handoff",
  task_signature: taskSignature,
  task_family: taskFamily,
  memory_lane: "private",
  title: "External package SDK continuity handoff",
  summary: marker + ": continue the packaged SDK path from the committed handoff.",
  handoff_text: marker + ": recover this structured handoff without semantic embeddings.",
  target_files: ["README.md"],
  continuation_hint: "Continue the packaged SDK entrypoint smoke.",
  acceptance_checks: ["structured handoff is exposed in actionable agent context"],
  evidence_ref: "evidence://external-package-sdk/" + runId + "/handoff",
});
const handoffEnvelope = asRecord(handoff.handoff);
assertCondition(handoffEnvelope, "SDK packaged execution handoff was not stored");
const storedHandoff = asRecord(handoffEnvelope.handoff);
const handoffMemoryId = storedHandoff?.id;
assertCondition(typeof handoffMemoryId === "string" && handoffMemoryId.length > 0, "external SDK handoff did not return node id");

const afterGuide = await client.execution.guideForRole({
  agent_id: "external-sdk-agent",
  role: "reviewer",
  run_id: runId + ":after",
  task_signature: taskSignature,
  task_family: taskFamily,
  query_text: marker + " continue with packaged SDK",
  mode: "full_power",
  context_mode: "compact_agent",
  limit: 10,
  include_packets: true,
});
const context = agentContextFromGuide(afterGuide);
const visibleMemoryIds = textArray(context.memory_ids);
const useNowMemoryIds = textArray(context.use_now_memory_ids);
const inspectBeforeUseMemoryIds = textArray(context.inspect_before_use_memory_ids);
const doNotUseMemoryIds = textArray(context.do_not_use_memory_ids);
const promptText = String(context.prompt_text ?? "");
const sourceMap = asRecord(afterGuide.source_map);
const internalSurfaces = textArray(sourceMap?.internal_surfaces_used);
const memoryPacket = asRecord(afterGuide.memory_packet);
const memoryPacketQuery = asRecord(memoryPacket?.query);
const relevantMemories = Array.isArray(memoryPacket?.relevant_memories)
  ? memoryPacket.relevant_memories.map((entry) => asRecord(entry)).filter(Boolean)
  : [];
const ordinaryPacketMemory = relevantMemories.find((entry) => entry.memory_id === memoryId) || null;
const ordinaryRecallSources = Array.isArray(ordinaryPacketMemory?.recall_sources)
  ? ordinaryPacketMemory.recall_sources.map((entry) => asRecord(entry)).filter(Boolean)
  : [];
const ordinaryEmbeddingRecallSources = ordinaryRecallSources.filter((source) =>
  source.kind === "ann"
    || (source.kind === "semantic" && textArray(source.matched_fields).includes("embedding_vector_json"))
);
const ordinaryRecallSourceKinds = ordinaryRecallSources
  .map((source) => source.kind)
  .filter((kind) => typeof kind === "string");
assertCondition(context.contract_version === "aionis_agent_context_v1", "SDK packaged guide missing agent_context");
assertCondition(context.actionable_history_used === true, "SDK packaged guide did not use actionable history");
assertCondition(
  visibleMemoryIds.includes(handoffMemoryId)
    && (useNowMemoryIds.includes(handoffMemoryId) || inspectBeforeUseMemoryIds.includes(handoffMemoryId)),
  "SDK packaged guide did not expose structured handoff memory: " + JSON.stringify({
    handoff_memory_id: handoffMemoryId,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
    do_not_use_memory_ids: doNotUseMemoryIds,
    memory_ids: visibleMemoryIds,
    rehydrate_hints: context.rehydrate_hints,
    source_map: sourceMap,
  }),
);
assertCondition(promptText.includes(marker) || textArray(context.use_now).some((entry) => entry.includes(marker)), "SDK packaged guide missing marker");
const embeddingUnavailable = internalSurfaces.includes("planning_context_embedding_unavailable");
if (embeddingExpectation === "available") {
  assertCondition(!embeddingUnavailable, "SDK packaged guide unexpectedly used the no-embedding path");
  assertCondition(internalSurfaces.includes("recall"), "SDK packaged guide did not prove semantic recall");
  assertCondition(
    memoryPacketQuery?.source === "text",
    "SDK packaged planning query did not preserve its public text-source contract",
  );
  assertCondition(memoryPacketQuery?.embedding_dims === 1536, "SDK packaged guide query did not use 1536 dimensions");
  assertCondition(
    visibleMemoryIds.includes(memoryId),
    "SDK packaged guide did not semantically recover the embedded ordinary memory",
  );
  assertCondition(
    ordinaryEmbeddingRecallSources.length > 0,
    "SDK packaged ordinary memory lacked semantic/ANN recall provenance",
  );
} else {
  assertCondition(embeddingUnavailable, "SDK packaged guide did not prove the no-embedding path");
}
assertCondition(internalSurfaces.includes("full_power_agent_context_merge"), "SDK packaged guide did not merge structured handoff context");

const feedbackAttribution = feedbackAttributionFromGuide(afterGuide);
assertCondition(feedbackAttribution.status === "available", "SDK packaged guide missing persisted feedback attribution");
const attributedMemoryIds = feedbackAttribution.items.map((item) => item.memory_id);
if (embeddingExpectation === "available") {
  assertCondition(
    attributedMemoryIds.includes(memoryId),
    "semantically recovered ordinary memory did not enter persisted feedback attribution",
  );
} else {
  assertCondition(
    !attributedMemoryIds.includes(memoryId),
    "ordinary memory unexpectedly entered attribution without semantic recall",
  );
}
const handoffFeedbackAttributable = attributedMemoryIds.includes(handoffMemoryId);
if (embeddingExpectation === "unavailable") {
  assertCondition(
    !handoffFeedbackAttributable,
    "no-embedding continuity handoff unexpectedly entered the learning exposure",
  );
}
let feedbackRejectionCode = null;
let handoffFeedbackRequest = null;
try {
  handoffFeedbackRequest = feedbackFromGuide({
    guide: afterGuide,
    run_id: runId + ":feedback",
    outcome: "neutral",
    reason: "Formal feedback authority must follow the persisted guide exposure exactly.",
    used_memory_ids: [handoffMemoryId],
  });
} catch (error) {
  feedbackRejectionCode = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}
if (handoffFeedbackAttributable) {
  assertCondition(
    handoffFeedbackRequest && feedbackRejectionCode === null,
    "SDK packaged helper rejected a handoff that the persisted exposure attributed",
  );
} else {
  assertCondition(
    feedbackRejectionCode === "guide_feedback_context_only_memory",
    "SDK packaged helper did not reject context-only handoff attribution locally",
  );
}

let semanticFeedback = null;
if (embeddingExpectation === "available") {
  semanticFeedback = await client.feedback(feedbackFromGuide({
    guide: afterGuide,
    run_id: runId + ":semantic-feedback",
    outcome: "neutral",
    reason: "External package smoke verified exact persisted attribution for semantic recall.",
    used_memory_ids: [memoryId],
  }));
  assertCondition(
    asRecord(semanticFeedback)?.contract_version === "aionis_feedback_result_v1",
    "SDK packaged semantic feedback returned an unexpected contract",
  );
}

const measureOperationId = "external-package-sdk-measure:" + runId;
const measureRequest = measureInputFromGuideLoop({
  operation_id: measureOperationId,
  task: {
    task_id: "task:" + runId,
    run_id: runId,
    task_signature: taskSignature,
    task_family: taskFamily,
  },
  before_guide: beforeGuide,
  after_guide: afterGuide,
  feedback_result: semanticFeedback,
  sufficient_evidence: false,
  evidence_ids: [],
});
const measure = await client.measure(measureRequest);
assertCondition(measure.contract_version === "aionis_measure_result_v1", "SDK packaged measure missing contract");
assertCondition(measure.operation_id === measureOperationId, "SDK packaged measure did not preserve protected operation identity");
assertCondition(measure.measurement_persisted === true, "SDK packaged measure did not persist its immutable measurement");
assertCondition(
  typeof measure.measurement_id === "string" && measure.measurement_id.length > 0,
  "SDK packaged measure missing measurement identity",
);
assertCondition(
  typeof measure.measurement_digest === "string" && /^[0-9a-f]{64}$/.test(measure.measurement_digest),
  "SDK packaged measure missing canonical measurement digest",
);
const measureReplay = await client.measure(measureRequest);
assertCondition(
  JSON.stringify(measureReplay) === JSON.stringify(measure),
  "SDK packaged protected measure did not replay its exact durable receipt",
);

const snapshot = await client.snapshot(snapshotInputFromGuideLoop({
  run_id: runId,
  task_signature: taskSignature,
  task_family: taskFamily,
  guide: afterGuide,
  measure_result: measure,
  include_markdown: false,
}));
const operatorSnapshot = asRecord(snapshot.operator_snapshot);
assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "SDK packaged snapshot missing contract");

process.stdout.write(JSON.stringify({
  ok: true,
  package: "@aionis/sdk",
  ordinary_memory_id: memoryId,
  handoff_memory_id: handoffMemoryId,
  embedding_expectation: embeddingExpectation,
  embedding_status: resolvedNode?.embedding_status ?? null,
  embedding_model: resolvedNode?.embedding_model ?? null,
  query_source: memoryPacketQuery?.source ?? null,
  query_embedding_dims: memoryPacketQuery?.embedding_dims ?? null,
  semantic_memory_recovered: visibleMemoryIds.includes(memoryId),
  ordinary_memory_recall_source_kinds: ordinaryRecallSourceKinds,
  visible_memory_ids: visibleMemoryIds,
  use_now_memory_ids: useNowMemoryIds,
  inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
  feedback_attribution_item_ids: attributedMemoryIds,
  handoff_feedback_attributable: handoffFeedbackAttributable,
  handoff_feedback_request_surface: handoffFeedbackRequest?.used_surface ?? null,
  feedback_rejection_code: feedbackRejectionCode,
  semantic_feedback_contract: asRecord(semanticFeedback)?.contract_version ?? null,
  internal_surfaces: internalSurfaces,
  measure_contract: measure.contract_version,
  measure_operation_id: measure.operation_id,
  measurement_id: measure.measurement_id,
  measurement_digest: measure.measurement_digest,
  measurement_persisted: measure.measurement_persisted,
  measure_exact_replay: JSON.stringify(measureReplay) === JSON.stringify(measure),
  snapshot_contract: operatorSnapshot.contract_version
}, null, 2) + "\\n");
`);
  return scriptPath;
}

function runExternalSdkSmoke(
  appDir: string,
  baseUrl: string,
  runId: string,
  embeddingExpectation: ExternalSmokeEmbeddingExpectation,
  expectedEmbeddingModel: string | null,
): Record<string, unknown> {
  const script = writeExternalSdkSmoke(appDir);
  const output = run(process.execPath, [script], {
    cwd: appDir,
    env: {
      ...externalPackageChildEnv(),
      AIONIS_EXTERNAL_SMOKE_BASE_URL: baseUrl,
      AIONIS_EXTERNAL_SMOKE_EMBEDDING_EXPECTATION: embeddingExpectation,
      ...(expectedEmbeddingModel
        ? { AIONIS_EXTERNAL_SMOKE_EXPECTED_EMBEDDING_MODEL: expectedEmbeddingModel }
        : {}),
      AIONIS_EXTERNAL_SMOKE_SCOPE: `external-package-smoke:sdk:${runId}`,
      AIONIS_EXTERNAL_SMOKE_RUN_ID: `external-package-sdk-${runId}`,
    },
    label: "external SDK package smoke",
    maxOutputChars: 10_000,
  });
  return JSON.parse(output.trim()) as Record<string, unknown>;
}

async function runExternalMcpSmoke(
  appDir: string,
  baseUrl: string,
  runId: string,
  embeddingExpectation: ExternalSmokeEmbeddingExpectation,
): Promise<Record<string, unknown>> {
  const mcpMain = path.join(appDir, "node_modules", "@aionis", "mcp", "dist", "index.js");
  assertCondition(fs.existsSync(mcpMain), "@aionis/mcp dist entrypoint missing after install");

  const client = new Client({ name: "aionis-external-package-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      mcpMain,
      "--base-url",
      baseUrl,
      "--tenant",
      "default",
      "--scope",
      `external-package-smoke:mcp:${runId}`,
    ],
    env: externalPackageChildEnv(),
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assertCondition(toolNames.includes("aionis_health"), "MCP package did not expose aionis_health");
    assertCondition(toolNames.includes("aionis_remember"), "MCP package did not expose aionis_remember");
    assertCondition(toolNames.includes("aionis_context"), "MCP package did not expose aionis_context");

    const health = await client.callTool({
      name: "aionis_health",
      arguments: {},
    });
    const healthPayload = asRecord(health.structuredContent);
    assertCondition(healthPayload?.ok === true, "MCP package health tool failed");

    const beforeContext = await client.callTool({
      name: "aionis_context",
      arguments: {
        run_id: `external-package-mcp-${runId}:before`,
        task_signature: "external-package-mcp-smoke",
        task_family: "external_package_entrypoint",
        agent_id: "external-mcp-agent",
        role: "reviewer",
        query_text: `${MCP_MARKER} before packaged MCP memory exists`,
        context_mode: "compact_agent",
        budget_profile: "compact",
        max_prompt_chars: 4_000,
      },
    });
    const beforeContextPayload = asRecord(beforeContext.structuredContent);
    assertCondition(beforeContextPayload?.ok === true, "MCP package before-context tool failed");

    const remember = await client.callTool({
      name: "aionis_remember",
      arguments: {
        text: `${MCP_MARKER}: use the packaged MCP path for the external developer smoke.`,
        kind: "project_context",
        title: "External package MCP smoke memory",
        memory_lane: "private",
        owner_agent_id: "external-mcp-agent",
        confidence: 0.92,
        target_files: ["docs/AIONIS_MCP.md"],
        slots: { source: "external_package_smoke" },
      },
    });
    const rememberPayload = asRecord(remember.structuredContent);
    assertCondition(rememberPayload?.ok === true, "MCP package remember tool failed");
    const rememberedBody = asRecord(rememberPayload?.remembered);
    const rememberedWrite = asRecord(rememberedBody?.memory_write);
    const rememberedNodes = Array.isArray(rememberedWrite?.nodes) ? rememberedWrite.nodes : [];
    const rememberedNode = asRecord(rememberedNodes[0]);
    const rememberedMemoryId = rememberedNode?.id;
    assertCondition(
      typeof rememberedMemoryId === "string" && rememberedMemoryId.length > 0,
      "MCP package remember did not return a memory id",
    );

    const context = await client.callTool({
      name: "aionis_context",
      arguments: {
        run_id: `external-package-mcp-${runId}`,
        task_signature: "external-package-mcp-smoke",
        task_family: "external_package_entrypoint",
        agent_id: "external-mcp-agent",
        role: "reviewer",
        query_text: `${MCP_MARKER} continue with packaged MCP`,
        context_mode: "compact_agent",
        budget_profile: "compact",
        max_prompt_chars: 4_000,
      },
    });
    const contextPayload = asRecord(context.structuredContent);
    assertCondition(contextPayload?.ok === true, "MCP package context tool failed");
    assertCondition(String(contextPayload.agent_prompt ?? "").includes("AIONIS_EXECUTION_AGENT_CONTEXT"), "MCP package context did not compile execution prompt");
    const memoryUseReceipt = asRecord(contextPayload.memory_use_receipt);
    assertCondition(memoryUseReceipt?.contract_version === "aionis_memory_use_receipt_v1", "MCP package context missing memory use receipt");
    const guide = asRecord(contextPayload.guide);
    const memoryPacket = asRecord(guide?.memory_packet);
    const query = asRecord(memoryPacket?.query);
    const relevantMemories = Array.isArray(memoryPacket?.relevant_memories)
      ? memoryPacket.relevant_memories.map((entry) => asRecord(entry)).filter(Boolean)
      : [];
    const rememberedPacketMemory = relevantMemories.find(
      (entry) => entry.memory_id === rememberedMemoryId,
    ) ?? null;
    const recallSources = Array.isArray(rememberedPacketMemory?.recall_sources)
      ? rememberedPacketMemory.recall_sources.map((entry) => asRecord(entry)).filter(Boolean)
      : [];
    const embeddingRecallSources = recallSources.filter((source) => {
      const matchedFields = Array.isArray(source.matched_fields)
        ? source.matched_fields.filter((field) => typeof field === "string")
        : [];
      return source.kind === "ann"
        || (source.kind === "semantic" && matchedFields.includes("embedding_vector_json"));
    });
    if (embeddingExpectation === "available") {
      assertCondition(
        query?.source === "text",
        "MCP package planning query did not preserve its public text-source contract",
      );
      assertCondition(query?.embedding_dims === 1536, "MCP package guide query did not use 1536 dimensions");
      assertCondition(
        embeddingRecallSources.length > 0,
        "MCP package remembered memory lacked semantic/ANN recall provenance",
      );
    }

    const measure = await client.callTool({
      name: "aionis_measure",
      arguments: {
        run_id: `external-package-mcp-${runId}`,
        task_signature: "external-package-mcp-smoke",
        task_family: "external_package_entrypoint",
        before_guide: beforeContextPayload.guide,
        after_guide: contextPayload.guide,
        sufficient_evidence: true,
        evidence_ids: [`mcp:${runId}:context`],
      },
    });
    const measurePayload = asRecord(measure.structuredContent);
    const measureResult = asRecord(measurePayload?.measure);
    assertCondition(measurePayload?.ok === true, `MCP package measure tool failed: ${JSON.stringify(measure, null, 2)}`);
    assertCondition(measureResult?.contract_version === "aionis_measure_result_v1", "MCP package measure missing contract");

    return {
      ok: true,
      package: "@aionis/mcp",
      remembered_memory_id: rememberedMemoryId,
      tools: toolNames,
      embedding_expectation: embeddingExpectation,
      query_source: query?.source ?? null,
      query_embedding_dims: query?.embedding_dims ?? null,
      remembered_memory_recall_source_kinds: recallSources
        .map((source) => source.kind)
        .filter((kind) => typeof kind === "string"),
      context_contract: asRecord(contextPayload.execution_context)?.contract_version,
      receipt_contract: memoryUseReceipt.contract_version,
      measure_contract: measureResult.contract_version,
    };
  } finally {
    await client.close();
  }
}

function runCliEntrypointChecks(appDir: string): Record<string, unknown> {
  const createBin = nodeModulesBin(appDir, "create-aionis");
  const mcpBin = nodeModulesBin(appDir, "aionis-mcp");
  assertCondition(fs.existsSync(createBin), "@aionis/create bin missing after install");
  assertCondition(fs.existsSync(mcpBin), "@aionis/mcp bin missing after install");

  const createHelp = run(createBin, ["--help"], {
    cwd: appDir,
    env: externalPackageChildEnv(),
    label: "@aionis/create --help",
  });
  const mcpHelp = run(mcpBin, ["--help"], {
    cwd: appDir,
    env: externalPackageChildEnv(),
    label: "@aionis/mcp --help",
  });

  assertCondition(createHelp.includes("npx @aionis/create"), "@aionis/create help missing usage");
  assertCondition(createHelp.includes("--quickstart"), "@aionis/create help missing quickstart option");
  assertCondition(mcpHelp.includes("npx @aionis/mcp"), "@aionis/mcp help missing usage");
  assertCondition(mcpHelp.includes("--base-url"), "@aionis/mcp help missing base-url option");

  return {
    create_help_ok: true,
    mcp_help_ok: true,
  };
}

async function main() {
  const runId = Date.now().toString(36);
  const install = prepareExternalInstall();
  const session = await openRuntime();
  try {
    const embeddingExpectation = embeddingExpectationForSession(session);
    const expectedEmbeddingModel = expectedEmbeddingModelForSession(
      session,
      embeddingExpectation,
    );
    const cli = runCliEntrypointChecks(install.appDir);
    const sdk = runExternalSdkSmoke(
      install.appDir,
      session.baseUrl,
      runId,
      embeddingExpectation,
      expectedEmbeddingModel,
    );
    const mcp = await runExternalMcpSmoke(
      install.appDir,
      session.baseUrl,
      runId,
      embeddingExpectation,
    );

    const result = {
      contract_version: "aionis_external_package_entrypoint_smoke_v1",
      run_id: `external-package-smoke-${runId}`,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
        embedding_expectation: embeddingExpectation,
        expected_embedding_model: expectedEmbeddingModel,
      },
      package_install: {
        app_dir: install.appDir,
        sdk_spec: install.sdkSpec,
        mcp_spec: install.mcpSpec,
        create_spec: install.createSpec,
      },
      cli_entrypoints: cli,
      sdk_entrypoint: sdk,
      mcp_entrypoint: mcp,
      checks: {
        create_cli_available: cli.create_help_ok === true,
        mcp_cli_available: cli.mcp_help_ok === true,
        sdk_product_loop_ok: sdk.ok === true,
        mcp_stdio_tool_loop_ok: mcp.ok === true,
      },
    };

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
