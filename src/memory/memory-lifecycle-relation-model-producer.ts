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
  MemoryLifecycleRelationCandidate,
  MemoryLifecycleRelationCandidateProducer,
} from "./memory-lifecycle-adjudicator.js";

const LIFECYCLE_RELATION_MODEL_PROMPT_VERSION = "memory_lifecycle_relation_candidate_prompt_v1";

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

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractJsonValueFromText(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function extractChatCompletionText(payload: unknown): string | null {
  const root = asObject(payload);
  if (!root) return null;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asObject(choices[0]);
  if (!first) return null;
  const msg = asObject(first.message);
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const fragments = content
      .map((item) => {
        const obj = asObject(item);
        if (!obj) return "";
        const text = obj.text;
        return typeof text === "string" ? text : "";
      })
      .filter((entry) => entry.length > 0);
    if (fragments.length > 0) return fragments.join("\n");
  }
  return null;
}

function extractAnthropicMessageText(payload: unknown): string | null {
  const root = asObject(payload);
  if (!root) return null;
  const content = Array.isArray(root.content) ? root.content : [];
  const fragments = content
    .map((item) => {
      const obj = asObject(item);
      if (!obj) return "";
      const text = obj.text;
      return typeof text === "string" ? text : "";
    })
    .filter((entry) => entry.length > 0);
  return fragments.length > 0 ? fragments.join("\n") : null;
}

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
    source_index: entry.source_index,
  };
}

function candidatePairs(args: {
  entries: AdjudicableMemoryEntry[];
  sourceMemoryIds: Set<string>;
  maxPairs: number;
}) {
  const sources = args.entries.filter((entry) => args.sourceMemoryIds.has(entry.memory_id));
  const out: Array<{ source: ReturnType<typeof compactEntry>; target: ReturnType<typeof compactEntry> }> = [];
  for (const source of sources) {
    for (const target of args.entries) {
      if (source.memory_id === target.memory_id) continue;
      out.push({ source: compactEntry(source), target: compactEntry(target) });
      if (out.length >= args.maxPairs) return out;
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
    if (deterministic_relations.length > 0) return [];
    const pairs = candidatePairs({
      entries,
      sourceMemoryIds: new Set(source_memory_ids),
      maxPairs: args.maxPairs ?? 60,
    });
    if (pairs.length === 0) return [];
    const parsed = await postCandidateJson({
      config: args.config,
      systemPrompt:
        "You produce semantic lifecycle relation candidates for Aionis memory. "
        + "Return strict JSON only: {\"candidates\":[...]}. "
        + "You may only propose supersedes, contradicts, or invalidates relations between supplied memory ids. "
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
        candidate_pairs: pairs,
      },
    });
    const result = CandidateResponseSchema.safeParse(parsed);
    if (!result.success) return [];
    return result.data.candidates.map((candidate): MemoryLifecycleRelationCandidate => ({
      ...candidate,
      producer: "llm_semantic_lifecycle",
    }));
  };
}
