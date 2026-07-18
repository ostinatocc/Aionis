import { z } from "zod";
import type {
  LearningControlHttpModelClientConfig,
  LearningControlHttpModelClientTransport,
} from "./learning-control-model-client.js";
import {
  LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
  LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
} from "./learning-control-model-client-http-contract.js";
import type {
  AdjudicableMemoryEntry,
  MemoryLifecycleRelation,
  MemoryLifecycleRelationCandidate,
  MemoryLifecycleRelationCandidateProducer,
} from "./memory-lifecycle-adjudicator.js";
import {
  extractAnthropicMessageText,
  extractChatCompletionText,
  extractJsonValueFromText,
} from "./http-model-json.js";

const LIFECYCLE_RELATION_MODEL_PROMPT_VERSION = "memory_lifecycle_relation_candidate_prompt_v2";

const CandidateSchema = z.object({
  source_memory_id: z.string().min(1),
  target_memory_id: z.string().min(1),
  relation: z.enum(["supersedes", "contradicts", "invalidates"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().trim().min(1)).max(4).default([]),
}).strict();

const CandidateResponseSchema = z.object({
  candidates: z.array(CandidateSchema).max(24).default([]),
}).strict();

function inferTransport(config: LearningControlHttpModelClientConfig): LearningControlHttpModelClientTransport {
  if (config.transport) return config.transport;
  const baseUrl = config.baseUrl.trim().toLowerCase();
  if (baseUrl.includes("/anthropic")) return LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION;
  return LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION;
}

function compactEntry(entry: AdjudicableMemoryEntry) {
  return {
    memory_id: entry.memory_id,
    title: entry.title,
    summary: entry.summary.slice(0, 1200),
    domain: entry.domain,
    authority: entry.authority,
    confidence: entry.confidence,
    lifecycle_state: entry.lifecycle_state,
    observed_at: entry.observed_at ?? null,
    target_files: entry.target_files ?? [],
    source_index: entry.source_index,
  };
}

type LifecycleRelationCandidatePair = {
  source: ReturnType<typeof compactEntry>;
  target: ReturnType<typeof compactEntry>;
  hint?: {
    kind: "ephemeral_rule_cue_hint";
    authority: "none";
    relation: MemoryLifecycleRelation["relation"];
    confidence: number;
    reasons: string[];
    signals: MemoryLifecycleRelation["evidence"]["signals"];
  };
};

function candidatePairKey(sourceMemoryId: string, targetMemoryId: string): string {
  return `${sourceMemoryId}\0${targetMemoryId}`;
}

function candidatePairs(args: {
  entries: AdjudicableMemoryEntry[];
  sourceMemoryIds: Set<string>;
  maxPairs: number;
  relationHints: MemoryLifecycleRelation[];
}): LifecycleRelationCandidatePair[] {
  const sources = args.entries.filter((entry) => args.sourceMemoryIds.has(entry.memory_id));
  const historicalTargets = args.entries.filter((entry) => !args.sourceMemoryIds.has(entry.memory_id));
  const entriesById = new Map(args.entries.map((entry) => [entry.memory_id, entry]));
  const out: LifecycleRelationCandidatePair[] = [];
  const seen = new Set<string>();
  const append = (
    source: AdjudicableMemoryEntry,
    target: AdjudicableMemoryEntry,
    hint?: LifecycleRelationCandidatePair["hint"],
  ): boolean => {
    const key = candidatePairKey(source.memory_id, target.memory_id);
    if (source.memory_id === target.memory_id || seen.has(key)) return false;
    seen.add(key);
    out.push({
      source: compactEntry(source),
      target: compactEntry(target),
      ...(hint ? { hint } : {}),
    });
    return out.length >= args.maxPairs;
  };

  for (const relation of args.relationHints) {
    if (!args.sourceMemoryIds.has(relation.source_memory_id)
      || args.sourceMemoryIds.has(relation.target_memory_id)) continue;
    const source = entriesById.get(relation.source_memory_id);
    const target = entriesById.get(relation.target_memory_id);
    if (!source || !target) continue;
    if (append(source, target, {
      kind: "ephemeral_rule_cue_hint",
      authority: "none",
      relation: relation.relation,
      confidence: relation.confidence,
      reasons: relation.reasons.slice(0, 4),
      signals: relation.evidence.signals,
    })) return out;
  }

  for (const source of sources) {
    for (const target of historicalTargets) {
      if (append(source, target)) return out;
    }
  }
  return out;
}

async function postCandidateJson(args: {
  config: LearningControlHttpModelClientConfig;
  systemPrompt: string;
  userPayload: Record<string, unknown>;
}): Promise<unknown> {
  const baseUrl = args.config.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = args.config.apiKey.trim();
  const model = args.config.model.trim();
  if (!baseUrl || !apiKey || !model) return null;
  const transport = inferTransport(args.config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.config.timeoutMs);
  try {
    const response =
      transport === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
        ? await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: Math.max(args.config.maxTokens, 800),
              system: args.systemPrompt,
              messages: [{
                role: "user",
                content: [{ type: "text", text: JSON.stringify(args.userPayload, null, 2) }],
              }],
            }),
            signal: controller.signal,
          })
        : await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              temperature: args.config.temperature,
              max_tokens: args.config.maxTokens,
              ...(args.config.openAiExtraBody ?? {}),
              messages: [
                { role: "system", content: args.systemPrompt },
                { role: "user", content: JSON.stringify(args.userPayload, null, 2) },
              ],
            }),
            signal: controller.signal,
          });
    if (!response.ok) {
      throw new Error(`memory lifecycle relation model returned HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => null);
    const content =
      transport === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
        ? extractAnthropicMessageText(payload)
        : extractChatCompletionText(payload);
    if (!content) return null;
    return extractJsonValueFromText(content);
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpMemoryLifecycleRelationCandidateProducer(args: {
  config: LearningControlHttpModelClientConfig;
  maxPairs?: number;
}): MemoryLifecycleRelationCandidateProducer {
  return async ({ entries, source_memory_ids, deterministic_relations }) => {
    const pairs = candidatePairs({
      entries,
      sourceMemoryIds: new Set(source_memory_ids),
      maxPairs: Math.min(200, Math.max(1, Math.floor(args.maxPairs ?? 60))),
      relationHints: deterministic_relations,
    });
    if (pairs.length === 0) return [];
    const parsed = await postCandidateJson({
      config: args.config,
      systemPrompt:
        "You produce semantic lifecycle relation candidates for Aionis memory. "
        + "Return strict JSON only: {\"candidates\":[...]}. "
        + "You may only propose supersedes, contradicts, or invalidates relations between supplied memory ids. "
        + "Pairs may include an ephemeral lexical rule-cue hint with authority=none; review it as a lead, never as a decision. "
        + "Do not output lifecycle_state, authority, actions, edits, filters, or final decisions. "
        + "Be conservative: propose a relation only when the source memory is a later/follow-up memory that clearly says a prior route, approach, assumption, or first-pass work area was abandoned, disproven, replaced, or should be treated as no longer usable. "
        + "If evidence is weak or both memories can coexist, return {\"candidates\":[]}.",
      userPayload: {
        prompt_version: LIFECYCLE_RELATION_MODEL_PROMPT_VERSION,
        operation: "memory_lifecycle_relation_candidate",
        response_contract: {
          kind: "strict_json",
          schema_note:
            "Return {candidates:[{source_memory_id,target_memory_id,relation,confidence,reasons}]} or {candidates:[]}.",
        },
        pair_order_policy: "ephemeral_hinted_pairs_first_then_bounded_recency_candidates",
        candidate_pairs: pairs,
      },
    });
    const result = CandidateResponseSchema.safeParse(parsed);
    if (!result.success) return [];
    const suppliedPairs = new Set(pairs.map((pair) => candidatePairKey(
      pair.source.memory_id,
      pair.target.memory_id,
    )));
    return result.data.candidates
      .filter((candidate) => suppliedPairs.has(candidatePairKey(
        candidate.source_memory_id,
        candidate.target_memory_id,
      )))
      .map((candidate): MemoryLifecycleRelationCandidate => ({
        ...candidate,
        producer: "llm_semantic_lifecycle",
      }));
  };
}
