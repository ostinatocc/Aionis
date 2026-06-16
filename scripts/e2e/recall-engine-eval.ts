#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import {
  EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS,
  type RecallCandidate,
  type RecallMemoryTier,
} from "../../src/store/recall-access.ts";

type RecallEngineFixture = {
  version: number;
  description: string;
  cases: RecallEngineCase[];
};

type RecallEngineCase = {
  case_id: string;
  description: string;
  query_text?: string;
  query_vector: number[];
  expected: {
    must_recall_ids: string[];
    preferred_direct_use_ids: string[];
    must_not_direct_use_ids: string[];
    stale_ids: string[];
    failed_branch_ids: string[];
    rehydrate_ids: string[];
    required_sources: string[];
  };
  memories: RecallEngineMemory[];
};

type RecallEngineMemory = {
  id: string;
  type: string;
  tier: RecallMemoryTier;
  title: string;
  text_summary: string;
  vector: number[];
  lifecycle: string;
  target_files?: string[];
  workflow_signature?: string;
  task_signature?: string;
  task_family?: string;
  repo_signature?: string;
  file_cluster?: string;
  tool_chain_signature?: string;
  failure_mode?: string;
  verification_signature?: string;
  acceptance_check_signature?: string;
  execution_outcome_role?: string;
  requires_rehydrate?: boolean;
};

type CandidateSource =
  | "semantic"
  | "lexical"
  | "structured"
  | "execution_native"
  | "graph"
  | "recent"
  | "exact_recovery"
  | "ann";

type RecallEngineCaseResult = {
  case_id: string;
  description: string;
  recalled_ids: string[];
  missed_required_ids: string[];
  candidate_sources: Record<string, CandidateSource[]>;
  required_sources: string[];
  covered_required_sources: string[];
  missing_required_sources: string[];
  recall_at_50: number;
  source_coverage: number;
  failed_branch_blocking_proxy: number | null;
  do_not_use_stale_suppression_proxy: number | null;
  rehydrate_hit_rate: number | null;
  latency_ms: number | null;
};

type RecallEngineSummary = {
  contract_version: "aionis_recall_engine_baseline_v1";
  generated_at: string;
  fixture_version: number;
  case_count: number;
  recall_access_capability_version: number;
  candidate_generation: {
    semantic_path: "bounded_sqlite_scan_plus_js_cosine_with_source_trace";
    lexical_path: "lite_keyword_index_like_match";
    structured_path: "lite_execution_native_index_signature_match";
    execution_native_path: "lite_execution_native_index_anchor_match";
    exact_recovery_path: "unbounded_lite_exact_recovery_with_source_trace";
    governance_admission: "out_of_scope_for_recall_only_baseline";
  };
  metrics: {
    recall_at_50: number;
    candidate_source_coverage: number;
    use_now_precision_after_governance: null;
    inspect_before_use_correctness: null;
    do_not_use_stale_suppression: number | null;
    failed_branch_blocking: number | null;
    rehydrate_hit_rate: number | null;
    p50_recall_latency_ms: number | null;
    p95_recall_latency_ms: number | null;
    index_rebuild_time_ms: null;
    embedding_backfill_delay_ms: number;
  };
  metric_notes: string[];
  cases: RecallEngineCaseResult[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_FIXTURE_PATH = path.join(ROOT, "scripts/e2e/fixtures/recall-engine-cases.json");
const DEFAULT_OUTPUT_PATH = path.join(ROOT, "docs/examples/recall-engine-baseline-summary.json");

function parseArgs(argv: string[]): { fixturePath: string; outputPath: string; deterministicLatency: boolean } {
  let fixturePath = DEFAULT_FIXTURE_PATH;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let deterministicLatency = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture") {
      fixturePath = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--output") {
      outputPath = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--deterministic-latency") {
      deterministicLatency = true;
    }
  }
  return { fixturePath, outputPath, deterministicLatency };
}

function readFixture(fixturePath: string): RecallEngineFixture {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as RecallEngineFixture;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`recall engine fixture has no cases: ${fixturePath}`);
  }
  return parsed;
}

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-recall-engine-eval-"));
  return path.join(dir, "recall-engine.sqlite");
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round4(sorted[idx] ?? 0);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function intersectionCount(a: readonly string[], b: ReadonlySet<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) count += 1;
  }
  return count;
}

function slotsForMemory(memory: RecallEngineMemory): Record<string, unknown> {
  const base: Record<string, unknown> = {
    recall_engine_eval_v1: true,
    lifecycle_hint: memory.lifecycle,
    target_files: memory.target_files ?? [],
    task_signature: memory.task_signature ?? null,
    task_family: memory.task_family ?? null,
    workflow_signature: memory.workflow_signature ?? null,
    repo_signature: memory.repo_signature ?? null,
    file_cluster: memory.file_cluster ?? null,
    tool_chain_signature: memory.tool_chain_signature ?? null,
    failure_mode: memory.failure_mode ?? null,
    verification_signature: memory.verification_signature ?? null,
    acceptance_check_signature: memory.acceptance_check_signature ?? null,
    requires_rehydrate: memory.requires_rehydrate === true,
  };
  if (memory.type === "procedure") {
    base.execution_native_v1 = {
      execution_kind: "workflow_anchor",
      anchor_kind: "workflow",
      task_signature: memory.task_signature ?? null,
      task_family: memory.task_family ?? null,
      workflow_signature: memory.workflow_signature ?? null,
      target_files: memory.target_files ?? [],
      repo_signature: memory.repo_signature ?? null,
      file_cluster: memory.file_cluster ?? null,
      tool_chain_signature: memory.tool_chain_signature ?? null,
      failure_mode: memory.failure_mode ?? null,
      verification_signature: memory.verification_signature ?? null,
      acceptance_check_signature: memory.acceptance_check_signature ?? null,
      execution_outcome_role: memory.execution_outcome_role ?? "unknown",
    };
    base.execution_result_summary = {
      status: memory.execution_outcome_role === "passed_solution"
        ? "passed"
        : memory.execution_outcome_role === "failed_branch"
          ? "failed"
          : "unknown",
      execution_outcome_role: memory.execution_outcome_role ?? "unknown",
    };
    base.anchor_v1 = {
      anchor_kind: "workflow",
      anchor_level: "L2",
      payload_refs: memory.requires_rehydrate
        ? {
            raw_trace: `archive://recall-engine/${memory.id}`,
          }
        : {},
    };
  }
  return base;
}

async function insertFixtureCase(args: {
  writeStore: ReturnType<typeof createLiteWriteStore>;
  testCase: RecallEngineCase;
}): Promise<void> {
  const scope = `recall-engine:${args.testCase.case_id}`;
  const commitId = await args.writeStore.insertCommit({
    scope,
    parentCommitId: null,
    inputSha256: `recall-engine-${args.testCase.case_id}`,
    diffJson: "{}",
    actor: "recall-engine-eval",
    modelVersion: null,
    promptVersion: null,
    commitHash: `recall-engine-${args.testCase.case_id}`,
  });
  for (const memory of args.testCase.memories) {
    await args.writeStore.insertNode({
      id: memory.id,
      scope,
      clientId: null,
      type: memory.type,
      tier: memory.tier,
      title: memory.title,
      textSummary: memory.text_summary,
      slotsJson: JSON.stringify(slotsForMemory(memory)),
      rawRef: memory.requires_rehydrate ? `archive://recall-engine/${memory.id}/raw` : null,
      evidenceRef: `fixture://recall-engine/${args.testCase.case_id}/${memory.id}`,
      embeddingVector: JSON.stringify(memory.vector),
      embeddingModel: "deterministic-recall-engine-fixture",
      memoryLane: "shared",
      producerAgentId: null,
      ownerAgentId: null,
      ownerTeamId: null,
      embeddingStatus: "ready",
      embeddingLastError: null,
      salience: memory.tier === "cold" ? 0.2 : 0.9,
      importance: 0.5,
      confidence: memory.lifecycle === "contested" ? 0.55 : 0.9,
      redactionVersion: 0,
      commitId,
    });
  }
}

function collectCoveredRequiredSources(sourceMap: Map<string, Set<CandidateSource>>, requiredSources: string[]): {
  covered: string[];
  missing: string[];
} {
  const available = new Set<string>();
  for (const sources of sourceMap.values()) {
    for (const source of sources) {
      available.add(source);
    }
  }
  const covered: string[] = [];
  const missing: string[] = [];
  for (const source of requiredSources) {
    if (available.has(source)) covered.push(source);
    else missing.push(source);
  }
  return { covered, missing };
}

function firstMemoryField(
  testCase: RecallEngineCase,
  field: keyof Pick<
    RecallEngineMemory,
    | "task_signature"
    | "workflow_signature"
    | "failure_mode"
    | "repo_signature"
    | "task_family"
    | "file_cluster"
    | "tool_chain_signature"
    | "verification_signature"
    | "acceptance_check_signature"
  >,
): string | null {
  const mustRecall = new Set(testCase.expected.must_recall_ids);
  for (const memory of testCase.memories) {
    if (!mustRecall.has(memory.id)) continue;
    const value = memory[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const memory of testCase.memories) {
    const value = memory[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function targetFilesForCase(testCase: RecallEngineCase): string[] {
  const mustRecall = new Set(testCase.expected.must_recall_ids);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const memory of testCase.memories) {
    if (!mustRecall.has(memory.id)) continue;
    for (const file of memory.target_files ?? []) {
      const normalized = file.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function structuredParamsForCase(testCase: RecallEngineCase, scope: string) {
  return {
    scope,
    limit: 50,
    taskSignature: firstMemoryField(testCase, "task_signature"),
    workflowSignature: firstMemoryField(testCase, "workflow_signature"),
    taskFamily: firstMemoryField(testCase, "task_family"),
    repoSignature: firstMemoryField(testCase, "repo_signature"),
    fileCluster: firstMemoryField(testCase, "file_cluster"),
    toolChainSignature: firstMemoryField(testCase, "tool_chain_signature"),
    failureMode: firstMemoryField(testCase, "failure_mode"),
    verificationSignature: firstMemoryField(testCase, "verification_signature"),
    acceptanceCheckSignature: firstMemoryField(testCase, "acceptance_check_signature"),
    targetFiles: targetFilesForCase(testCase),
    consumerAgentId: null,
    consumerTeamId: null,
  };
}

async function evaluateCase(args: {
  access: ReturnType<ReturnType<typeof createLiteRecallStore>["createRecallAccess"]>;
  testCase: RecallEngineCase;
  deterministicLatency: boolean;
}): Promise<RecallEngineCaseResult> {
  const scope = `recall-engine:${args.testCase.case_id}`;
  const start = performance.now();
  const ann = await args.access.stage1CandidatesAnn({
    queryEmbedding: args.testCase.query_vector,
    scope,
    oversample: 50,
    limit: 50,
    consumerAgentId: null,
    consumerTeamId: null,
  });
  const exact = await args.access.stage1CandidatesExactRecovery({
    queryEmbedding: args.testCase.query_vector,
    scope,
    oversample: 50,
    limit: 50,
    allowedTiers: [...EXACT_RECOVERY_RECALL_STAGE1_ALLOWED_TIERS],
    scanLimit: null,
    consumerAgentId: null,
    consumerTeamId: null,
  });
  const lexical = await args.access.stage1LexicalCandidates({
    queryText: args.testCase.query_text ?? args.testCase.description,
    scope,
    limit: 50,
    consumerAgentId: null,
    consumerTeamId: null,
  });
  const structuredParams = structuredParamsForCase(args.testCase, scope);
  const structured = await args.access.stage1StructuredCandidates(structuredParams);
  const executionNative = await args.access.stage1ExecutionNativeCandidates(structuredParams);
  const elapsed = performance.now() - start;

  const candidateById = new Map<string, RecallCandidate>();
  const sourceMap = new Map<string, Set<CandidateSource>>();
  for (const candidate of ann.concat(exact, lexical, structured, executionNative)) {
    const id = candidate.id;
    if (!candidateById.has(id)) candidateById.set(id, candidate);
    sourceMap.set(id, sourceMap.get(id) ?? new Set<CandidateSource>());
    for (const source of candidate.sources ?? []) {
      if (
        source.kind === "semantic"
        || source.kind === "exact_recovery"
        || source.kind === "lexical"
        || source.kind === "structured"
        || source.kind === "execution_native"
        || source.kind === "graph"
        || source.kind === "recent"
        || source.kind === "ann"
      ) {
        sourceMap.get(id)?.add(source.kind);
      }
    }
  }

  const recalledIds = Array.from(candidateById.keys()).slice(0, 50);
  const recalledSet = new Set(recalledIds);
  const mustRecall = args.testCase.expected.must_recall_ids;
  const missedRequiredIds = mustRecall.filter((id) => !recalledSet.has(id));
  const recallAt50 = mustRecall.length > 0 ? intersectionCount(mustRecall, recalledSet) / mustRecall.length : 1;
  const sourceCoverage = collectCoveredRequiredSources(sourceMap, args.testCase.expected.required_sources);
  const sourceCoverageScore = args.testCase.expected.required_sources.length > 0
    ? sourceCoverage.covered.length / args.testCase.expected.required_sources.length
    : 1;

  const failedIds = args.testCase.expected.failed_branch_ids;
  const staleIds = args.testCase.expected.stale_ids;
  const rehydrateIds = args.testCase.expected.rehydrate_ids;
  const failedBranchBlockingProxy = failedIds.length > 0
    ? intersectionCount(failedIds, recalledSet) / failedIds.length
    : null;
  const staleSuppressionProxy = staleIds.length > 0
    ? intersectionCount(staleIds, recalledSet) / staleIds.length
    : null;
  const rehydrateHitRate = rehydrateIds.length > 0
    ? intersectionCount(rehydrateIds, recalledSet) / rehydrateIds.length
    : null;

  return {
    case_id: args.testCase.case_id,
    description: args.testCase.description,
    recalled_ids: recalledIds,
    missed_required_ids: missedRequiredIds,
    candidate_sources: Object.fromEntries(
      Array.from(sourceMap.entries()).map(([id, sources]) => [id, Array.from(sources).sort()]),
    ),
    required_sources: args.testCase.expected.required_sources,
    covered_required_sources: sourceCoverage.covered,
    missing_required_sources: sourceCoverage.missing,
    recall_at_50: round4(recallAt50),
    source_coverage: round4(sourceCoverageScore),
    failed_branch_blocking_proxy: failedBranchBlockingProxy === null ? null : round4(failedBranchBlockingProxy),
    do_not_use_stale_suppression_proxy: staleSuppressionProxy === null ? null : round4(staleSuppressionProxy),
    rehydrate_hit_rate: rehydrateHitRate === null ? null : round4(rehydrateHitRate),
    latency_ms: args.deterministicLatency ? null : round4(elapsed),
  };
}

export async function runRecallEngineEval(options: {
  fixturePath?: string;
  outputPath?: string;
  deterministicLatency?: boolean;
} = {}): Promise<RecallEngineSummary> {
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE_PATH;
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const fixture = readFixture(fixturePath);
  const dbPath = tmpDbPath();
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    await writeStore.withTx(async () => {
      for (const testCase of fixture.cases) {
        await insertFixtureCase({ writeStore, testCase });
      }
    });
    const access = recallStore.createRecallAccess();
    const cases: RecallEngineCaseResult[] = [];
    for (const testCase of fixture.cases) {
      cases.push(await evaluateCase({
        access,
        testCase,
        deterministicLatency: options.deterministicLatency === true,
      }));
    }
    const latencyValues = cases
      .map((result) => result.latency_ms)
      .filter((value): value is number => typeof value === "number");
    const failedBranchValues = cases
      .map((result) => result.failed_branch_blocking_proxy)
      .filter((value): value is number => typeof value === "number");
    const staleValues = cases
      .map((result) => result.do_not_use_stale_suppression_proxy)
      .filter((value): value is number => typeof value === "number");
    const rehydrateValues = cases
      .map((result) => result.rehydrate_hit_rate)
      .filter((value): value is number => typeof value === "number");

    const summary: RecallEngineSummary = {
      contract_version: "aionis_recall_engine_baseline_v1",
      generated_at: new Date().toISOString(),
      fixture_version: fixture.version,
      case_count: fixture.cases.length,
      recall_access_capability_version: access.capability_version,
      candidate_generation: {
        semantic_path: "bounded_sqlite_scan_plus_js_cosine_with_source_trace",
        lexical_path: "lite_keyword_index_like_match",
        structured_path: "lite_execution_native_index_signature_match",
        execution_native_path: "lite_execution_native_index_anchor_match",
        exact_recovery_path: "unbounded_lite_exact_recovery_with_source_trace",
        governance_admission: "out_of_scope_for_recall_only_baseline",
      },
      metrics: {
        recall_at_50: mean(cases.map((result) => result.recall_at_50)) ?? 0,
        candidate_source_coverage: mean(cases.map((result) => result.source_coverage)) ?? 0,
        use_now_precision_after_governance: null,
        inspect_before_use_correctness: null,
        do_not_use_stale_suppression: mean(staleValues),
        failed_branch_blocking: mean(failedBranchValues),
        rehydrate_hit_rate: mean(rehydrateValues),
        p50_recall_latency_ms: percentile(latencyValues, 50),
        p95_recall_latency_ms: percentile(latencyValues, 95),
        index_rebuild_time_ms: null,
        embedding_backfill_delay_ms: 0,
      },
      metric_notes: [
        "This is a recall-only baseline over real Lite SQLite stores and RecallStoreAccess.",
        "stage1 semantic path is bounded SQLite scan plus JavaScript cosine ranking, not true ANN.",
        "use_now_precision_after_governance and inspect_before_use_correctness are deferred to guide/product evals because recall is not admission.",
        "failed_branch_blocking and do_not_use_stale_suppression are recall-readiness proxies: the unsafe memory must be retrieved so governance can block it.",
      ],
      cases,
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runRecallEngineEval(args);
  console.log(JSON.stringify({
    output: args.outputPath,
    case_count: summary.case_count,
    metrics: summary.metrics,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
