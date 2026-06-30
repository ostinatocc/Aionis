#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import type { RecallCandidate } from "../../src/store/recall-access.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { ORDINARY_MEMORY_SLOT_KEY } from "../../src/memory/ordinary-memory-construction.ts";

type OrdinaryMemoryRetrievalMemory = {
  client_id: string;
  type: "concept" | "entity" | "topic" | "rule" | "evidence" | "event" | "self_model";
  title: string;
  text_summary: string;
  slots?: Record<string, unknown>;
  confidence?: number;
  salience?: number;
};

type OrdinaryMemoryRetrievalCase = {
  case_id: string;
  description: string;
  query_text: string;
  expected_client_id: string;
  required_ordinary_fields: string[];
  memories: OrdinaryMemoryRetrievalMemory[];
};

type OrdinaryMemoryCaseResult = {
  case_id: string;
  description: string;
  query_text: string;
  expected_client_id: string;
  expected_node_id: string;
  lexical_top_ids: string[];
  hybrid_top_ids: string[];
  lexical_rank: number | null;
  hybrid_rank: number | null;
  lexical_top1: boolean;
  hybrid_top1: boolean;
  lexical_hit_at_5: boolean;
  hybrid_hit_at_5: boolean;
  matched_fields_for_expected: string[];
  source_kinds_for_expected: string[];
  ordinary_fields_present: string[];
  missing_ordinary_fields: string[];
  slots_text_source_hit: boolean;
};

type OrdinaryMemoryRetrievalSummary = {
  contract_version: "aionis_ordinary_memory_retrieval_baseline_v1";
  generated_at: string;
  case_count: number;
  candidate_generation: {
    write_path: "prepareMemoryWrite_applyMemoryWrite_real_lite_store";
    construction_path: "ordinary_memory_v1_deterministic_runtime_write";
    lexical_path: "lite_keyword_index_slots_text";
    hybrid_path: "rrf_merge_with_high_confidence_lexical_leader_protection_without_embedding";
    governance_admission: "out_of_scope_for_recall_only_eval";
  };
  metrics: {
    ordinary_construction_coverage: number;
    lexical_evidence_hit_at_5: number;
    hybrid_evidence_hit_at_5: number;
    lexical_evidence_top1: number;
    hybrid_evidence_top1: number;
    lexical_mean_reciprocal_rank: number;
    hybrid_mean_reciprocal_rank: number;
    slots_text_source_hit_rate: number;
  };
  metric_notes: string[];
  cases: OrdinaryMemoryCaseResult[];
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUTPUT_PATH = path.join(ROOT, "docs/examples/ordinary-memory-retrieval-baseline-summary.json");

const WRITE_OPTIONS = {
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
};

const CASES: OrdinaryMemoryRetrievalCase[] = [
  {
    case_id: "ordinary_alias_recall",
    description: "Alias-only query should hit the ordinary memory slots text.",
    query_text: "bluebird-runtime-service",
    expected_client_id: "ordinary:runtime-alias",
    required_ordinary_fields: ["aliases", "answerable_facts", "source_spans"],
    memories: [
      {
        client_id: "ordinary:runtime-alias",
        type: "concept",
        title: "Runtime connection note",
        text_summary: "The local Runtime endpoint should stay available for agent hosts.",
        slots: {
          aliases: ["bluebird-runtime-service"],
          entities: ["Aionis Runtime"],
          topic_keys: ["local-runtime"],
        },
        confidence: 0.94,
      },
      {
        client_id: "ordinary:runtime-decoy",
        type: "concept",
        title: "Runtime status note",
        text_summary: "A generic runtime setup note without the alias marker.",
      },
    ],
  },
  {
    case_id: "ordinary_answerable_fact_recall",
    description: "Fact-only query should hit answerable_facts inside ordinary_memory_v1.",
    query_text: "qaret-45d",
    expected_client_id: "ordinary:payment-retention",
    required_ordinary_fields: ["answerable_facts", "source_spans"],
    memories: [
      {
        client_id: "ordinary:payment-retention",
        type: "evidence",
        title: "Payment audit retention",
        text_summary: "The audit policy note was captured from the billing migration record.",
        slots: {
          answerable_facts: ["Payment audit trail retention uses marker qaret-45d for the active policy."],
          entities: ["Payment Audit Trail"],
          topic_keys: ["audit-retention"],
        },
        confidence: 0.93,
      },
      {
        client_id: "ordinary:payment-decoy",
        type: "evidence",
        title: "Payment migration note",
        text_summary: "Billing migration evidence without the retention marker.",
      },
    ],
  },
  {
    case_id: "ordinary_source_span_recall",
    description: "Source-span-only query should hit nested source span text.",
    query_text: "guide-trace-884",
    expected_client_id: "ordinary:guide-ledger",
    required_ordinary_fields: ["source_spans", "answerable_facts"],
    memories: [
      {
        client_id: "ordinary:guide-ledger",
        type: "evidence",
        title: "Guide ledger evidence",
        text_summary: "The ledger entry links a guide exposure to later feedback attribution.",
        slots: {
          source_spans: [{
            text: "Guide exposure ledger marker guide-trace-884 was visible before the feedback result.",
            ref: "trace://guide/884",
          }],
          topic_keys: ["guide-exposure-ledger"],
        },
        confidence: 0.91,
      },
      {
        client_id: "ordinary:guide-decoy",
        type: "evidence",
        title: "Guide receipt note",
        text_summary: "A guide receipt note without the specific trace marker.",
      },
    ],
  },
  {
    case_id: "ordinary_topic_key_recall",
    description: "Topic-key query should hit ordinary memory topic keys.",
    query_text: "handoff-continuity-omega",
    expected_client_id: "ordinary:handoff-topic",
    required_ordinary_fields: ["topic_keys", "answerable_facts"],
    memories: [
      {
        client_id: "ordinary:handoff-topic",
        type: "topic",
        title: "Cross-agent continuity topic",
        text_summary: "The host keeps continuity state across planner, worker, and reviewer sessions.",
        slots: {
          topic_keys: ["handoff-continuity-omega"],
          aliases: ["cross-agent continuity"],
        },
        confidence: 0.92,
      },
      {
        client_id: "ordinary:handoff-decoy",
        type: "topic",
        title: "General handoff note",
        text_summary: "A broad handoff topic without the exact continuity key.",
      },
    ],
  },
  {
    case_id: "ordinary_entity_recall",
    description: "Entity-only query should hit ordinary memory entity hints.",
    query_text: "CrimsonLedger9000",
    expected_client_id: "ordinary:entity-marker",
    required_ordinary_fields: ["entities", "answerable_facts"],
    memories: [
      {
        client_id: "ordinary:entity-marker",
        type: "entity",
        title: "Ledger entity note",
        text_summary: "The billing incident record references a durable ledger entity.",
        slots: {
          entities: ["CrimsonLedger9000"],
          topic_keys: ["ledger-entity"],
        },
        confidence: 0.9,
      },
      {
        client_id: "ordinary:entity-decoy",
        type: "entity",
        title: "Ledger generic entity",
        text_summary: "Generic ledger entity note without the unique marker.",
      },
    ],
  },
  {
    case_id: "ordinary_time_validity_recall",
    description: "Time-validity query should hit nested validity metadata.",
    query_text: "window-ruby-2026q2",
    expected_client_id: "ordinary:validity-window",
    required_ordinary_fields: ["time_validity", "answerable_facts"],
    memories: [
      {
        client_id: "ordinary:validity-window",
        type: "concept",
        title: "Current policy window",
        text_summary: "The operational policy has an observed validity window.",
        slots: {
          time_validity: {
            state: "current",
            observed_at: "window-ruby-2026q2",
          },
          topic_keys: ["policy-validity"],
        },
        confidence: 0.88,
      },
      {
        client_id: "ordinary:validity-decoy",
        type: "concept",
        title: "Policy window note",
        text_summary: "A generic policy window note without the observed marker.",
      },
    ],
  },
  {
    case_id: "ordinary_rank_under_noise",
    description: "Full evidence coverage should outrank many high-salience partial lexical decoys.",
    query_text: "saffron invoice retention delta",
    expected_client_id: "ordinary:rank-noise-gold",
    required_ordinary_fields: ["answerable_facts", "source_spans", "topic_keys"],
    memories: [
      {
        client_id: "ordinary:rank-noise-gold",
        type: "concept",
        title: "Invoice retention evidence",
        text_summary: "The billing policy note contains the answer span for a retention question.",
        slots: {
          answerable_facts: ["Saffron invoice retention delta is the active marker for the current billing policy."],
          source_spans: [{
            text: "Verified answer span: saffron invoice retention delta.",
            ref: "fixture://ordinary-rank-noise/gold",
          }],
          topic_keys: ["billing-retention"],
        },
        confidence: 0.9,
        salience: 0.18,
      },
      ...Array.from({ length: 56 }, (_, index): OrdinaryMemoryRetrievalMemory => {
        const token = ["saffron", "invoice", "retention", "delta"][index % 4] ?? "saffron";
        return {
          client_id: `ordinary:rank-noise-decoy-${String(index + 1).padStart(2, "0")}`,
          type: "concept",
          title: `High salience ${token} note ${index + 1}`,
          text_summary: `A noisy working-set note that mentions ${token} but not the full answer span.`,
          slots: {
            topic_keys: [`noise-${token}`],
          },
          confidence: 0.99,
          salience: 0.99,
        };
      }),
    ],
  },
];

function parseArgs(argv: string[]): { outputPath: string; deterministicLatency: boolean } {
  let outputPath = DEFAULT_OUTPUT_PATH;
  let deterministicLatency = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") {
      outputPath = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--deterministic-latency") {
      deterministicLatency = true;
    }
  }
  return { outputPath, deterministicLatency };
}

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-ordinary-memory-retrieval-eval-"));
  return path.join(dir, "ordinary-memory-retrieval.sqlite");
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function meanBooleans(values: boolean[]): number {
  if (values.length === 0) return 0;
  return round4(values.filter(Boolean).length / values.length);
}

function meanNumbers(values: number[]): number {
  if (values.length === 0) return 0;
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function rankOf(candidates: RecallCandidate[], id: string): number | null {
  const index = candidates.findIndex((candidate) => candidate.id === id);
  return index >= 0 ? index + 1 : null;
}

function reciprocalRank(rank: number | null): number {
  return typeof rank === "number" && rank > 0 ? 1 / rank : 0;
}

function ordinaryFields(slots: Record<string, unknown> | undefined, requiredFields: string[]): {
  present: string[];
  missing: string[];
} {
  const ordinary = slots?.[ORDINARY_MEMORY_SLOT_KEY];
  const record = ordinary && typeof ordinary === "object" && !Array.isArray(ordinary)
    ? ordinary as Record<string, unknown>
    : {};
  const present: string[] = [];
  const missing: string[] = [];
  for (const field of requiredFields) {
    if (record[field] !== undefined) present.push(field);
    else missing.push(field);
  }
  return { present, missing };
}

function expectedCandidate(candidates: RecallCandidate[], expectedNodeId: string): RecallCandidate | undefined {
  return candidates.find((candidate) => candidate.id === expectedNodeId);
}

function sourceKinds(candidate: RecallCandidate | undefined): string[] {
  return Array.from(new Set((candidate?.sources ?? []).map((source) => source.kind))).sort();
}

function matchedFields(candidate: RecallCandidate | undefined): string[] {
  const fields = new Set<string>();
  for (const source of candidate?.sources ?? []) {
    for (const field of source.matched_fields ?? []) fields.add(field);
  }
  return Array.from(fields).sort();
}

async function insertCase(args: {
  writeStore: ReturnType<typeof createLiteWriteStore>;
  testCase: OrdinaryMemoryRetrievalCase;
}): Promise<Map<string, { id: string; slots: Record<string, unknown> }>> {
  const scope = `ordinary-retrieval:${args.testCase.case_id}`;
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope,
      actor: "ordinary-retrieval-eval",
      producer_agent_id: "ordinary-retrieval-eval",
      owner_agent_id: "ordinary-retrieval-eval",
      input_text: `Ordinary memory retrieval eval case ${args.testCase.case_id}.`,
      auto_embed: false,
      nodes: args.testCase.memories.map((memory) => ({
        client_id: memory.client_id,
        type: memory.type,
        title: memory.title,
        text_summary: memory.text_summary,
        slots: memory.slots ?? {},
        confidence: memory.confidence ?? 0.86,
        salience: memory.salience ?? (memory.client_id === args.testCase.expected_client_id ? 0.9 : 0.72),
        memory_lane: "shared",
      })),
    },
    "default",
    "default",
    WRITE_OPTIONS,
    null,
  );
  await args.writeStore.withTx(() =>
    applyMemoryWrite(prepared, {
      ...WRITE_OPTIONS,
      write_access: args.writeStore,
    }),
  );
  return new Map(
    prepared.nodes.map((node) => [node.client_id ?? node.id, { id: node.id, slots: node.slots ?? {} }]),
  );
}

async function evaluateCase(args: {
  access: ReturnType<ReturnType<typeof createLiteRecallStore>["createRecallAccess"]>;
  testCase: OrdinaryMemoryRetrievalCase;
  expected: { id: string; slots: Record<string, unknown> };
}): Promise<OrdinaryMemoryCaseResult> {
  const scope = `ordinary-retrieval:${args.testCase.case_id}`;
  const lexical = await args.access.stage1LexicalCandidates({
    queryText: args.testCase.query_text,
    scope,
    limit: 5,
    consumerAgentId: "ordinary-retrieval-eval",
    consumerTeamId: null,
  });
  const hybrid = await args.access.stage1HybridCandidates({
    queryText: args.testCase.query_text,
    scope,
    limit: 5,
    consumerAgentId: "ordinary-retrieval-eval",
    consumerTeamId: null,
  });
  const lexicalExpected = expectedCandidate(lexical, args.expected.id);
  const hybridExpected = expectedCandidate(hybrid, args.expected.id);
  const lexicalRank = rankOf(lexical, args.expected.id);
  const hybridRank = rankOf(hybrid, args.expected.id);
  const fields = ordinaryFields(args.expected.slots, args.testCase.required_ordinary_fields);
  const expectedMatchedFields = matchedFields(lexicalExpected ?? hybridExpected);
  return {
    case_id: args.testCase.case_id,
    description: args.testCase.description,
    query_text: args.testCase.query_text,
    expected_client_id: args.testCase.expected_client_id,
    expected_node_id: args.expected.id,
    lexical_top_ids: lexical.map((candidate) => candidate.id),
    hybrid_top_ids: hybrid.map((candidate) => candidate.id),
    lexical_rank: lexicalRank,
    hybrid_rank: hybridRank,
    lexical_top1: lexicalRank === 1,
    hybrid_top1: hybridRank === 1,
    lexical_hit_at_5: Boolean(lexicalExpected),
    hybrid_hit_at_5: Boolean(hybridExpected),
    matched_fields_for_expected: expectedMatchedFields,
    source_kinds_for_expected: sourceKinds(lexicalExpected ?? hybridExpected),
    ordinary_fields_present: fields.present,
    missing_ordinary_fields: fields.missing,
    slots_text_source_hit: expectedMatchedFields.includes("slots_text"),
  };
}

export async function runOrdinaryMemoryRetrievalEval(options: {
  outputPath?: string;
  deterministicLatency?: boolean;
} = {}): Promise<OrdinaryMemoryRetrievalSummary> {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const dbPath = tmpDbPath();
  const writeStore = createLiteWriteStore(dbPath);
  const recallStore = createLiteRecallStore(dbPath);
  try {
    const access = recallStore.createRecallAccess();
    const results: OrdinaryMemoryCaseResult[] = [];
    for (const testCase of CASES) {
      const nodeByClientId = await insertCase({ writeStore, testCase });
      const expected = nodeByClientId.get(testCase.expected_client_id);
      if (!expected) throw new Error(`expected client id not prepared: ${testCase.expected_client_id}`);
      results.push(await evaluateCase({ access, testCase, expected }));
    }

    const constructionHits = results.map((result) => result.missing_ordinary_fields.length === 0);
    const summary: OrdinaryMemoryRetrievalSummary = {
      contract_version: "aionis_ordinary_memory_retrieval_baseline_v1",
      generated_at: options.deterministicLatency ? "1970-01-01T00:00:00.000Z" : new Date().toISOString(),
      case_count: results.length,
      candidate_generation: {
        write_path: "prepareMemoryWrite_applyMemoryWrite_real_lite_store",
        construction_path: "ordinary_memory_v1_deterministic_runtime_write",
        lexical_path: "lite_keyword_index_slots_text",
        hybrid_path: "rrf_merge_with_high_confidence_lexical_leader_protection_without_embedding",
        governance_admission: "out_of_scope_for_recall_only_eval",
      },
      metrics: {
        ordinary_construction_coverage: meanBooleans(constructionHits),
        lexical_evidence_hit_at_5: meanBooleans(results.map((result) => result.lexical_hit_at_5)),
        hybrid_evidence_hit_at_5: meanBooleans(results.map((result) => result.hybrid_hit_at_5)),
        lexical_evidence_top1: meanBooleans(results.map((result) => result.lexical_top1)),
        hybrid_evidence_top1: meanBooleans(results.map((result) => result.hybrid_top1)),
        lexical_mean_reciprocal_rank: meanNumbers(results.map((result) => reciprocalRank(result.lexical_rank))),
        hybrid_mean_reciprocal_rank: meanNumbers(results.map((result) => reciprocalRank(result.hybrid_rank))),
        slots_text_source_hit_rate: meanBooleans(results.map((result) => result.slots_text_source_hit)),
      },
      metric_notes: [
        "This is a recall-only eval for ordinary memory construction and candidate retrieval.",
        "It does not evaluate answer generation, guide admission, lifecycle governance, or downstream task success.",
        "All writes use the real Lite write path so ordinary_memory_v1 is produced by Runtime construction, not by direct fixture insertion.",
      ],
      cases: results,
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    await recallStore.close();
    await writeStore.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  runOrdinaryMemoryRetrievalEval(args)
    .then((summary) => {
      process.stdout.write(`${JSON.stringify({
        output: args.outputPath,
        case_count: summary.case_count,
        metrics: summary.metrics,
      }, null, 2)}\n`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
