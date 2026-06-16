import { z } from "zod";
import type {
  LearningControlHttpModelClientConfig,
  LearningControlHttpModelClientTransport,
} from "./learning-control-model-client.js";
import {
  LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
  LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
} from "./learning-control-model-client-http-contract.js";
import {
  AionisLifecycleCandidateSignalSchema,
  type AionisLifecycleCandidateSignal,
} from "./product-output-contract.js";
import type { LifecycleCandidateEntry } from "./lifecycle-candidate-inference.js";

export const LIFECYCLE_SHADOW_MODEL_PROMPT_VERSION = "memory_lifecycle_shadow_candidate_prompt_v2";
export const LIFECYCLE_SHADOW_MODEL_MIN_OUTPUT_TOKENS = 3000;
export const LIFECYCLE_SHADOW_MODEL_PROTOCOL_ATTEMPTS = 3;
export const LIFECYCLE_SHADOW_MODEL_FALLBACK_PROTOCOL_ATTEMPTS = 1;

const LifecycleShadowCandidateSchema = z
  .object({
    memory_id: z.string().min(1),
    signal_type: z.enum(["current", "procedure", "negative", "stale", "contested", "rehydrate"]),
    confidence: z.number().min(0).max(1),
    evidence_span: z
      .object({
        source_field: z.enum(["title", "text_summary", "slots", "query"]),
        quote: z.string().min(1),
      })
      .strict(),
    reason: z.string().trim().min(1),
  })
  .strict();

const LifecycleShadowCandidateResponseSchema = z
  .object({
    candidates: z.array(LifecycleShadowCandidateSchema).max(64).default([]),
  })
  .strict();

type LifecycleShadowCandidate = z.infer<typeof LifecycleShadowCandidateSchema>;

export type LifecycleShadowCandidateProducer = (args: {
  entries: LifecycleCandidateEntry[];
  query_intent?: string | null;
}) => Promise<AionisLifecycleCandidateSignal[]>;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function candidateCount(value: unknown): number | null {
  const root = asObject(value);
  if (!root) return null;
  return Array.isArray(root.candidates) ? root.candidates.length : null;
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

function compactText(value: string | null | undefined, max = 1200): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function slotEvidenceText(entry: LifecycleCandidateEntry): string {
  return JSON.stringify({
    target_files: entry.target_files ?? [],
    execution_state: entry.execution_state ?? null,
    memory_type: entry.memory_type,
    domain: entry.domain,
    lifecycle_state: entry.lifecycle_state,
    authority: entry.authority,
  });
}

function sourceEvidenceText(args: {
  entry: LifecycleCandidateEntry;
  query_intent?: string | null;
  source_field: LifecycleShadowCandidate["evidence_span"]["source_field"];
}): string {
  if (args.source_field === "title") return compactText(args.entry.title, 2000);
  if (args.source_field === "text_summary") return compactText(args.entry.summary, 20000);
  if (args.source_field === "slots") return slotEvidenceText(args.entry);
  return compactText(args.query_intent, 20000);
}

function normalizedContains(source: string, quote: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedSource = normalize(source);
  const normalizedQuote = normalize(quote);
  return !!normalizedQuote && normalizedSource.includes(normalizedQuote);
}

const REHYDRATE_QUERY_REQUEST_PATTERN = /\b(?:raw|exact|payload|trace|diff|source\s+evidence|supporting\s+material|file[-\s]?level\s+evidence|complete\s+surrounding\s+material|rehydrat(?:e|ion))\b|\b(?:evidence|trace|payload|raw|source\s+evidence|supporting\s+material)\s+pointers?\b|\b(?:expand|open|recover|load|fetch)\b[^.!?\n]{0,120}\b(?:raw|full\s+context|exact|payload|trace|diff|evidence|pointer|supporting\s+material|source\s+material|complete\s+surrounding\s+material)\b/i;
const SUMMARY_ONLY_EXCLUSION_PATTERN = /\b(?:do\s+not|don't|cannot|can't|should\s+not|must\s+not)\b[^.!?\n]{0,120}\b(?:rely|depend)\b[^.!?\n]{0,120}\b(?:summary|summaries|summarized\s+context|brief)\b/i;
const REHYDRATE_MEMORY_POINTER_PATTERN = /\b(?:trace:\/\/|payload:\/\/|archive:\/\/|raw\s+(?:trace|diff|payload|evidence|commit\s+evidence)|exact\s+(?:supporting\s+material|patch\s+details|evidence)|source\s+evidence\s+pointer|evidence\s+pointer|evidence\s+locator|payload\s+pointer|raw\s+execution\s+trace|file[-\s]?level\s+evidence|complete\s+surrounding\s+material|full\s+context)\b/i;
const REHYDRATE_MEMORY_REQUIREMENT_PATTERN = /\b(?:open(?:ed)?|load(?:ed)?|fetch(?:ed)?|recover(?:ed)?|expand(?:ed)?|rehydrat(?:e|ed|ion))\b[^.!?\n]{0,140}\b(?:raw|full|exact|payload|trace|diff|evidence|supporting\s+material|commit\s+evidence|source\s+material|complete\s+surrounding\s+material|file[-\s]?level)\b|\b(?:raw|full|exact|payload|trace|diff|evidence|supporting\s+material|commit\s+evidence|source\s+material|complete\s+surrounding\s+material|file[-\s]?level)\b[^.!?\n]{0,140}\b(?:must|needs?|requires?|should)\b[^.!?\n]{0,100}\b(?:open(?:ed)?|load(?:ed)?|fetch(?:ed)?|recover(?:ed)?|expand(?:ed)?|rehydrat(?:e|ed|ion))\b|\bsummary\s+is\s+not\s+enough\b/i;
const CONDITIONAL_REHYDRATE_REQUIREMENT_PATTERN = /\b(?:when|if|only\s+when|only\s+if|as\s+needed)\b[^.!?\n]{0,120}\b(?:summary\s+is\s+not\s+enough|raw|full|exact|payload|trace|diff|evidence|pointer|open|load|fetch|recover|expand|rehydrat(?:e|ion))\b/i;
const GENERIC_SOURCE_ONLY_PATTERN = /\b(?:real\s+github\s+source|source\s+from|source\s+data|github\s+source|supporting\s+source)\b/i;

function entryRehydrateEvidenceText(entry: LifecycleCandidateEntry): string {
  return [
    entry.title ?? "",
    entry.summary,
    slotEvidenceText(entry),
  ].join("\n");
}

function queryRequestsRehydrate(queryIntent: string | null | undefined): boolean {
  const query = queryIntent ?? "";
  return REHYDRATE_QUERY_REQUEST_PATTERN.test(query) || SUMMARY_ONLY_EXCLUSION_PATTERN.test(query);
}

function memoryCanServeRehydrate(entry: LifecycleCandidateEntry): boolean {
  const source = entryRehydrateEvidenceText(entry);
  return REHYDRATE_MEMORY_POINTER_PATTERN.test(source) || REHYDRATE_MEMORY_REQUIREMENT_PATTERN.test(source);
}

function memoryExplicitlyRequiresRehydrate(args: {
  entry: LifecycleCandidateEntry;
  evidence_source: string;
  quote: string;
}): boolean {
  const source = [
    entryRehydrateEvidenceText(args.entry),
    args.evidence_source,
    args.quote,
  ].join("\n");
  if (CONDITIONAL_REHYDRATE_REQUIREMENT_PATTERN.test(source)) return false;
  return REHYDRATE_MEMORY_REQUIREMENT_PATTERN.test(source);
}

function rehydrateCandidateAllowed(args: {
  entry: LifecycleCandidateEntry;
  query_intent?: string | null;
  evidence_source: string;
  quote: string;
}): boolean {
  const queryRequested = queryRequestsRehydrate(args.query_intent);
  const canServe = memoryCanServeRehydrate(args.entry);
  if (queryRequested && canServe) return true;
  if (memoryExplicitlyRequiresRehydrate(args)) return true;

  const candidateEvidence = [
    args.evidence_source,
    args.quote,
    entryRehydrateEvidenceText(args.entry),
  ].join("\n");
  if (GENERIC_SOURCE_ONLY_PATTERN.test(candidateEvidence)) return false;
  return false;
}

function hasRehydrateOpportunity(args: {
  entries: LifecycleCandidateEntry[];
  query_intent?: string | null;
}): boolean {
  return queryRequestsRehydrate(args.query_intent)
    && args.entries.some((entry) => memoryCanServeRehydrate(entry));
}

function mergeLifecycleCandidateSignals(
  existing: AionisLifecycleCandidateSignal[],
  next: AionisLifecycleCandidateSignal[],
): AionisLifecycleCandidateSignal[] {
  const out = [...existing];
  const seen = new Set(out.map((signal) => [
    signal.memory_id,
    signal.signal_type,
    signal.evidence_span.source_field,
    signal.evidence_span.quote.toLowerCase(),
  ].join(":")));
  for (const signal of next) {
    const key = [
      signal.memory_id,
      signal.signal_type,
      signal.evidence_span.source_field,
      signal.evidence_span.quote.toLowerCase(),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out.slice(0, 64);
}

export function validateLifecycleShadowCandidateSignals(args: {
  entries: LifecycleCandidateEntry[];
  query_intent?: string | null;
  response: unknown;
  minimum_confidence?: number;
}): AionisLifecycleCandidateSignal[] {
  const parsed = LifecycleShadowCandidateResponseSchema.safeParse(args.response);
  if (!parsed.success) return [];
  const entriesById = new Map(args.entries.map((entry) => [entry.memory_id, entry]));
  const minimumConfidence = args.minimum_confidence ?? 0.5;
  const out: AionisLifecycleCandidateSignal[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.data.candidates) {
    if (candidate.confidence < minimumConfidence) continue;
    const entry = entriesById.get(candidate.memory_id);
    if (!entry) continue;
    const evidenceSource = sourceEvidenceText({
      entry,
      query_intent: args.query_intent,
      source_field: candidate.evidence_span.source_field,
    });
    if (!normalizedContains(evidenceSource, candidate.evidence_span.quote)) continue;
    if (
      candidate.signal_type === "rehydrate"
      && !rehydrateCandidateAllowed({
        entry,
        query_intent: args.query_intent,
        evidence_source: evidenceSource,
        quote: candidate.evidence_span.quote,
      })
    ) continue;
    const signal = AionisLifecycleCandidateSignalSchema.safeParse({
      memory_id: candidate.memory_id,
      signal_type: candidate.signal_type,
      confidence: candidate.confidence,
      evidence_span: candidate.evidence_span,
      producer: "llm_shadow_v1",
      reason: candidate.reason,
    });
    if (!signal.success) continue;
    const key = [
      signal.data.memory_id,
      signal.data.signal_type,
      signal.data.evidence_span.source_field,
      signal.data.evidence_span.quote.toLowerCase(),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal.data);
  }
  return out.slice(0, 64);
}

function compactEntry(entry: LifecycleCandidateEntry) {
  return {
    memory_id: entry.memory_id,
    title: compactText(entry.title, 400),
    text_summary: compactText(entry.summary, 1200),
    memory_type: entry.memory_type,
    domain: entry.domain,
    lifecycle_state: entry.lifecycle_state,
    authority: entry.authority,
    target_files: entry.target_files ?? [],
    execution_state: entry.execution_state ?? null,
    slots_text: slotEvidenceText(entry),
  };
}

function compactFallbackPromptPayload(payload: ReturnType<typeof buildLifecycleShadowCandidatePromptPayload>) {
  return {
    prompt_version: payload.prompt_version,
    operation: payload.operation,
    query_intent: payload.query_intent,
    entries: payload.entries,
    output:
      "Return JSON only as {candidates:[{memory_id,signal_type,confidence,evidence_span:{source_field,quote},reason}]}. confidence must be a number from 0 to 1. quote must be an exact short substring.",
  };
}

export function buildLifecycleShadowCandidatePromptPayload(args: {
  entries: LifecycleCandidateEntry[];
  query_intent?: string | null;
  max_entries?: number;
}) {
  return {
    prompt_version: LIFECYCLE_SHADOW_MODEL_PROMPT_VERSION,
    operation: "memory_lifecycle_shadow_candidate",
    response_contract: {
      kind: "strict_json",
      schema_note:
        "Return {candidates:[{memory_id,signal_type,confidence,evidence_span:{source_field,quote},reason}]} or {candidates:[]}.",
      allowed_signal_type:
        ["current", "procedure", "negative", "stale", "contested", "rehydrate"],
      evidence_requirement:
        "evidence_span.quote must be copied verbatim from the selected title, text_summary, slots_text, or query_intent field. Prefer the shortest distinctive quote that proves the signal.",
      coverage_requirement:
        "Emit every clearly grounded lifecycle candidate you can prove from the supplied fields. Do not stop after the first category when current, procedure, negative/stale, and rehydrate evidence are all present.",
      rehydrate_guard:
        "Emit rehydrate when query_intent asks for raw/full/exact/payload/trace/diff evidence or explicitly refers to evidence/trace/payload pointers and the memory is a raw/trace/payload/evidence pointer. Also emit rehydrate when the memory unconditionally says raw/full evidence must be opened before direct use. Conditional pointers such as 'when summary is not enough' are rehydrate candidates only when query_intent asks for raw evidence or explicitly refers to evidence/trace/payload pointers. Do not mark ordinary source/supporting memories as rehydrate merely because they contain source data.",
    },
    derived_hints: {
      query_requests_rehydrate: queryRequestsRehydrate(args.query_intent),
    },
    query_intent: args.query_intent ?? null,
    entries: args.entries.slice(0, args.max_entries ?? 32).map(compactEntry),
  };
}

async function postCandidateJson(args: {
  config: LearningControlHttpModelClientConfig;
  systemPrompt: string;
  userPayload: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const baseUrl = args.config.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = args.config.apiKey.trim();
  const model = args.config.model.trim();
  if (!baseUrl || !apiKey || !model) return null;
  const fetchFn = args.fetchImpl ?? fetch;
  const transport = inferTransport(args.config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.config.timeoutMs);
  try {
    const response =
      transport === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
        ? await fetchFn(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: Math.max(args.config.maxTokens, LIFECYCLE_SHADOW_MODEL_MIN_OUTPUT_TOKENS),
              system: args.systemPrompt,
              messages: [{
                role: "user",
                content: [{ type: "text", text: JSON.stringify(args.userPayload) }],
              }],
            }),
            signal: controller.signal,
          })
        : await fetchFn(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              temperature: args.config.temperature,
              max_tokens: Math.max(args.config.maxTokens, LIFECYCLE_SHADOW_MODEL_MIN_OUTPUT_TOKENS),
              ...(args.config.openAiExtraBody ?? {}),
              messages: [
                { role: "system", content: args.systemPrompt },
                { role: "user", content: JSON.stringify(args.userPayload) },
              ],
            }),
            signal: controller.signal,
          });
    if (!response.ok) {
      throw new Error(`memory lifecycle shadow model returned HTTP ${response.status}`);
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

export function createHttpLifecycleShadowCandidateProducer(args: {
  config: LearningControlHttpModelClientConfig;
  max_entries?: number;
  fetchImpl?: typeof fetch;
}): LifecycleShadowCandidateProducer {
  return async ({ entries, query_intent }) => {
    if (entries.length === 0) return [];
    const promptPayload = buildLifecycleShadowCandidatePromptPayload({
      entries,
      query_intent,
      max_entries: args.max_entries,
    });
    const systemPrompt =
      "You produce audit-only lifecycle candidate signals for Aionis memory. "
      + "Return strict JSON only. "
      + "You may only emit candidate signal_type values for supplied memory_id values. "
      + "Do not output use_now, inspect_before_use, do_not_use, authority, lifecycle_state, edits, filters, or final admission decisions. "
      + "Every candidate must include a short evidence_span.quote copied verbatim from the selected title, text_summary, slots_text, or query_intent field. "
      + "Emit every clearly grounded lifecycle candidate you can prove from the supplied fields; do not stop after one category. "
      + "Emit rehydrate when the query asks for raw/full/exact/payload/trace/diff evidence or explicitly refers to evidence/trace/payload pointers and a memory is a raw/trace/payload/evidence pointer. "
      + "Emit rehydrate when a memory unconditionally says raw evidence must be opened before direct use. "
      + "Do not emit rehydrate for conditional pointers unless the query asks for raw evidence or explicitly refers to evidence/trace/payload pointers, and do not emit it for ordinary source/supporting memories. "
      + "If evidence is weak or not explicitly grounded in the supplied text, return {\"candidates\":[]}.";
    const fallbackSystemPrompt =
      "JSON only. Produce audit-only lifecycle candidate signals. "
      + "Use supplied memory_id values only. signal_type must be current, procedure, negative, stale, contested, or rehydrate. "
      + "confidence must be numeric. quote must be copied exactly. "
      + "Do not output final admission actions. Ordinary source notes are not rehydrate.";
    let lastSignals: AionisLifecycleCandidateSignal[] = [];
    const shouldCoverRehydrate = hasRehydrateOpportunity({ entries, query_intent });
    for (const prompt of [
      {
        systemPrompt,
        userPayload: promptPayload,
        attempts: LIFECYCLE_SHADOW_MODEL_PROTOCOL_ATTEMPTS,
      },
      {
        systemPrompt: fallbackSystemPrompt,
        userPayload: compactFallbackPromptPayload(promptPayload),
        attempts: LIFECYCLE_SHADOW_MODEL_FALLBACK_PROTOCOL_ATTEMPTS,
      },
    ]) {
      for (let attempt = 0; attempt < prompt.attempts; attempt += 1) {
        const parsed = await postCandidateJson({
          config: args.config,
          fetchImpl: args.fetchImpl,
          systemPrompt: prompt.systemPrompt,
          userPayload: prompt.userPayload,
        });
        if (parsed === null) continue;
        const validatedSignals = validateLifecycleShadowCandidateSignals({
          entries,
          query_intent,
          response: parsed,
        });
        if (validatedSignals.length > 0) {
          lastSignals = mergeLifecycleCandidateSignals(lastSignals, validatedSignals);
        }
        const count = candidateCount(parsed);
        const hasRehydrate = lastSignals.some((signal) => signal.signal_type === "rehydrate");
        if (
          lastSignals.length > 0
          && (!shouldCoverRehydrate || hasRehydrate)
        ) return lastSignals;
        if (count === 0 && !shouldCoverRehydrate) return lastSignals;
      }
    }
    return lastSignals;
  };
}
