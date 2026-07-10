#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeServices } from "../../src/app/runtime-services.js";
import { loadEnv, type Env } from "../../src/config.js";
import { createRuntimeConfig } from "../../src/config/runtime-config.js";
import { memoryRecallParsed } from "../../src/memory/recall.js";
import { MemoryRecallRequest } from "../../src/memory/schemas.js";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.js";
import {
  DeterministicEmbeddingProvider,
  deterministicEmbed,
} from "../ci/support/deterministic-embedding.js";

type JsonObject = Record<string, unknown>;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "docs/examples/zvec-ann-write-through-smoke");
const TARGET_ID = "00000000-0000-4000-8000-00000000a111";
const DISTRACTOR_ID = "00000000-0000-4000-8000-00000000a222";
const SCOPE = "zvec-ann-write-through/default";
const TENANT_ID = "zvec-ann-write-through";
const TARGET_TITLE = "fresh zvec write-through target";
const DISTRACTOR_TITLE = "weak zvec write-through distractor";

function parseArgs(argv: string[]): { outputDir: string } {
  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output-dir") {
      outputDir = path.resolve(argv[i + 1] ?? "");
      i += 1;
    }
  }
  return { outputDir };
}

async function withIsolatedEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    return await fn();
  } finally {
    process.env = previous;
  }
}

async function buildEnv(paths: { writePath: string; replayPath: string; zvecPath: string }): Promise<Env> {
  return await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      MEMORY_AUTH_MODE: "off",
      MEMORY_TENANT_ID: TENANT_ID,
      MEMORY_SCOPE: SCOPE,
      LITE_LOCAL_ACTOR_ID: "zvec-ann-smoke-local",
      LITE_WRITE_SQLITE_PATH: paths.writePath,
      LITE_REPLAY_SQLITE_PATH: paths.replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      AUTO_TOPIC_CLUSTER_ON_WRITE: "false",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
      RECALL_ANN_PROVIDER: "zvec",
      RECALL_ENGINE_MODE: "semantic_scan",
      RECALL_ZVEC_PATH: paths.zvecPath,
      RECALL_ANN_REBUILD_ON_START: "false",
      RECALL_ANN_MAX_CANDIDATES: "32",
      MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: "true",
    },
    async () => loadEnv(),
  );
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstSeedId(body: JsonObject): string | null {
  const seeds = asArray(body.seeds);
  const first = asRecord(seeds[0]);
  return typeof first.id === "string" ? first.id : null;
}

function seedIds(body: JsonObject): string[] {
  return asArray(body.seeds)
    .map((seed) => asRecord(seed).id)
    .filter((id): id is string => typeof id === "string");
}

function stage1(body: JsonObject): JsonObject {
  return asRecord(asRecord(body.debug).stage1);
}

function inlineEmbeddingUpdatedNodes(body: JsonObject): number {
  for (const warning of asArray(body.warnings)) {
    const record = asRecord(warning);
    if (record.code !== "lite_embedding_backfill_completed_inline") continue;
    const updatedNodes = asRecord(record.details).updated_nodes;
    return typeof updatedNodes === "number" && Number.isFinite(updatedNodes) ? updatedNodes : 0;
  }
  return 0;
}

async function main(): Promise<void> {
  try {
    await import("@zvec/zvec");
  } catch {
    console.log(JSON.stringify({
      contract_version: "aionis_zvec_ann_write_through_smoke_v1",
      skipped: true,
      reason: "@zvec/zvec optional dependency is not available on this platform",
    }, null, 2));
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outputDir, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-zvec-write-through-smoke-"));
  const paths = {
    writePath: path.join(tmpRoot, "runtime.sqlite"),
    replayPath: path.join(tmpRoot, "replay.sqlite"),
    zvecPath: path.join(tmpRoot, "ann.zvec"),
  };

  const env = await buildEnv(paths);
  const runtimeConfig = createRuntimeConfig(env);
  const services = await createRuntimeServices(runtimeConfig);
  const memoryWriteService = createMemoryWriteRouteService({
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: services.liteWriteStore,
    executionStateStore: services.executionStateStore,
    executionTreeStore: services.executionTreeStore,
  });
  const recallAccess = services.liteRecallStore.createRecallAccess();

  try {
    const write = async (payload: JsonObject): Promise<JsonObject> => {
      const committed = await memoryWriteService.commit(payload, {
        executionTreeDefaultDisabled: false,
        startedAt: performance.now(),
      });
      return committed.response as JsonObject;
    };

    const recall = async (): Promise<JsonObject> => {
      const request = MemoryRecallRequest.parse({
        tenant_id: TENANT_ID,
        scope: SCOPE,
        query_embedding: deterministicEmbed(TARGET_TITLE),
        limit: 3,
        neighborhood_hops: 1,
        max_nodes: 3,
        max_edges: 1,
        ranked_limit: 3,
        return_debug: true,
      });
      return await memoryRecallParsed(request, SCOPE, TENANT_ID, {
        allow_debug_embeddings: false,
      }, undefined, "recall", {
        stage1_exact_recovery_on_empty: env.MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY,
        recall_access: recallAccess,
        recall_engine_mode: env.RECALL_ENGINE_MODE,
      }) as JsonObject;
    };

    const weakWrite = await write({
      tenant_id: TENANT_ID,
      scope: SCOPE,
      input_text: "Seed a weak distractor before the fresh target exists.",
      auto_embed: true,
      nodes: [
        {
          id: DISTRACTOR_ID,
          type: "concept",
          title: DISTRACTOR_TITLE,
          text_summary: "A weak candidate that should prove the ANN path is already populated.",
          tier: "hot",
          memory_lane: "shared",
          salience: 0.8,
          confidence: 0.8,
          slots: { lifecycle_state: "active" },
        },
      ],
    });
    assert.equal(inlineEmbeddingUpdatedNodes(weakWrite), 1);

    const beforeTarget = await recall();
    assert.notEqual(firstSeedId(beforeTarget), TARGET_ID);
    assert.equal(stage1(beforeTarget).mode, "ann");
    assert.equal(stage1(beforeTarget).exact_recovery_attempted, false);

    const targetWrite = await write({
      tenant_id: TENANT_ID,
      scope: SCOPE,
      input_text: "Write the fresh target while Runtime is already running.",
      auto_embed: true,
      nodes: [
        {
          id: TARGET_ID,
          type: "concept",
          title: TARGET_TITLE,
          text_summary: "This fresh target must be visible through Zvec ANN without restart or rebuild.",
          tier: "hot",
          memory_lane: "shared",
          salience: 0.95,
          confidence: 0.95,
          slots: { lifecycle_state: "active", authority_state: "trusted" },
        },
      ],
    });
    assert.equal(inlineEmbeddingUpdatedNodes(targetWrite), 1);

    const afterTarget = await recall();
    assert.equal(firstSeedId(afterTarget), TARGET_ID);
    assert.equal(stage1(afterTarget).mode, "ann");
    assert.equal(stage1(afterTarget).exact_recovery_attempted, false);

    await services.liteWriteStore.withTx(async () => {
      await services.liteWriteStore.setNodeEmbeddingFailed({
        scope: SCOPE,
        id: TARGET_ID,
        error: "zvec write-through smoke forced failure",
      });
    });

    const afterFailed = await recall();
    assert.ok(!seedIds(afterFailed).includes(TARGET_ID));
    assert.equal(stage1(afterFailed).mode, "ann");
    assert.equal(stage1(afterFailed).exact_recovery_attempted, false);

    const report = {
      contract_version: "aionis_zvec_ann_write_through_smoke_v1",
      generated_at: new Date().toISOString(),
      provider: "zvec",
      rebuild_on_start: false,
      sqlite_truth_source: true,
      runtime_surfaces: ["memory_write_service", "memory_recall_service"],
      checks: {
        weak_write_inline_embedding_updated: inlineEmbeddingUpdatedNodes(weakWrite) === 1,
        before_target_uses_ann_without_exact_recovery: stage1(beforeTarget).mode === "ann" && stage1(beforeTarget).exact_recovery_attempted === false,
        target_visible_after_running_write_without_restart: firstSeedId(afterTarget) === TARGET_ID,
        target_removed_after_embedding_failed_mutation: !seedIds(afterFailed).includes(TARGET_ID),
      },
      stage1: {
        before_target: stage1(beforeTarget),
        after_target: stage1(afterTarget),
        after_failed: stage1(afterFailed),
      },
      seed_ids: {
        before_target: seedIds(beforeTarget),
        after_target: seedIds(afterTarget),
        after_failed: seedIds(afterFailed),
      },
    };

    const summaryPath = path.join(args.outputDir, "summary.json");
    const markdownPath = path.join(args.outputDir, "summary.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, [
      "# Zvec ANN Write-Through Smoke",
      "",
      "This smoke verifies that Zvec is a candidate sidecar synchronized after SQLite commits, not only at process startup.",
      "",
      `- Provider: \`${report.provider}\``,
      `- Rebuild on start: \`${String(report.rebuild_on_start)}\``,
      `- Runtime surfaces: \`${report.runtime_surfaces.join("`, `")}\``,
      "",
      "| Check | Result |",
      "|---|---:|",
      ...Object.entries(report.checks).map(([key, value]) => `| ${key} | ${value ? "pass" : "fail"} |`),
      "",
      "Summary JSON: `summary.json`",
      "",
    ].join("\n"));

    console.log(JSON.stringify({ ok: true, summary: summaryPath, markdown: markdownPath, checks: report.checks }, null, 2));
  } finally {
    await services.executionTreeStore.close();
    await services.executionStateStore.close();
    await services.liteClaimLedgerStore.close();
    await services.liteRecallStore.close();
    await services.liteReplayStore?.close();
    await services.liteWriteStore.close();
    await services.store.close();
    services.sandboxExecutor.shutdown();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
