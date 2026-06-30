export const ORDINARY_MEMORY_SLOT_KEY = "ordinary_memory_v1";

type OrdinaryMemoryConstructionInput = {
  type: string;
  title?: string | null;
  textSummary?: string | null;
  slots: Record<string, unknown>;
  rawRef?: string | null;
  evidenceRef?: string | null;
};

const ORDINARY_MEMORY_TYPES = new Set(["event", "entity", "topic", "rule", "evidence", "concept", "self_model"]);
const EXECUTION_SLOT_KEYS = new Set([
  "anchor_v1",
  "execution_contract_v1",
  "execution_kind",
  "execution_native_v1",
  "execution_observation_v1",
  "execution_result_summary",
  "recovery_contract_v1",
  "task_family",
  "task_signature",
  "target_files",
  "verification_signature",
  "workflow_signature",
  "workflow_steps",
]);
const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "already",
  "also",
  "before",
  "current",
  "during",
  "from",
  "have",
  "into",
  "local",
  "memory",
  "node",
  "route",
  "should",
  "summary",
  "that",
  "their",
  "there",
  "this",
  "when",
  "with",
]);

const COMMON_RELATION_ATTRIBUTES: Array<{
  attribute: string;
  verbs: RegExp;
}> = [
  {
    attribute: "hobby",
    verbs: /\b(?:enjoys?|likes?|loves?|prefers?|is into|favorite hobby is|hobby is)\b/i,
  },
  {
    attribute: "workplace",
    verbs: /\b(?:works at|works for|works in|is employed at|is employed by)\b/i,
  },
  {
    attribute: "hometown",
    verbs: /\b(?:hails from|is from|comes from|hometown is)\b/i,
  },
  {
    attribute: "birthday",
    verbs: /\b(?:birthday is|was born on|birth date is)\b/i,
  },
  {
    attribute: "height",
    verbs: /\b(?:stands at|standing at|height is|is)\b/i,
  },
  {
    attribute: "education",
    verbs: /\b(?:has|holds|earned|completed)\b/i,
  },
  {
    attribute: "contact",
    verbs: /\b(?:contact number is|phone number is|email address is|email is|has a contact number)\b/i,
  },
];

const RELATION_PREFIX_RE = /\b(?:my|our)\s+([a-z][a-z0-9' -]{1,42}?)(?=\s+(?:really\s+)?(?:enjoys?|likes?|loves?|prefers?|is into|favorite hobby is|hobby is|works at|works for|works in|is employed at|is employed by|hails from|is from|comes from|hometown is|birthday is|was born on|birth date is|stands at|standing at|height is|is|has|holds|earned|completed|contact number is|phone number is|email address is|email is|has a contact number)\b)/gi;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function uniqueStrings(values: Array<unknown>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function stringList(value: unknown, limit = 32): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value, limit);
}

function splitRefList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value, 64);
  const normalized = normalizeString(value);
  if (!normalized) return [];
  return uniqueStrings(normalized.split(/[,\s]+/g), 64);
}

function existingOrTopLevelList(slots: Record<string, unknown>, ordinary: Record<string, unknown>, key: string, limit = 32): string[] {
  return uniqueStrings([
    ...stringList(ordinary[key], limit),
    ...stringList(slots[key], limit),
  ], limit);
}

function shouldEnrichOrdinaryMemory(input: OrdinaryMemoryConstructionInput): boolean {
  if (!ORDINARY_MEMORY_TYPES.has(input.type)) return false;
  for (const key of EXECUTION_SLOT_KEYS) {
    if (key in input.slots) return false;
  }
  return true;
}

function extractEntityHints(text: string, limit = 16): string[] {
  const hints: string[] = [];
  const capitalized = text.match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,4}\b/g) ?? [];
  hints.push(...capitalized);
  const codeLike = text.match(/\b[a-zA-Z][\w.-]*(?:[/.:][\w.-]+)+\b/g) ?? [];
  hints.push(...codeLike);
  return uniqueStrings(hints, limit);
}

function deriveTopicKeys(text: string, limit = 20): string[] {
  const tokens = text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return uniqueStrings(tokens.filter((token) => !STOPWORDS.has(token)), limit);
}

function compactValueText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
    .replace(/\b(?:which|that|so|and|but)\b.*$/i, "")
    .trim();
}

function extractCommonRelationFacts(text: string): Array<Record<string, string>> {
  const facts: Array<Record<string, string>> = [];
  for (const match of text.matchAll(RELATION_PREFIX_RE)) {
    const relation = compactValueText(match[1] ?? "");
    if (!relation) continue;
    const rest = text.slice(match.index! + match[0].length);
    for (const spec of COMMON_RELATION_ATTRIBUTES) {
      const verbMatch = spec.verbs.exec(rest);
      if (!verbMatch || verbMatch.index > 8) continue;
      const rawValue = rest.slice(verbMatch.index + verbMatch[0].length).split(/[.!?\n]/, 1)[0] ?? "";
      const value = compactValueText(rawValue);
      if (!value || value.length > 80) continue;
      if (spec.attribute === "height" && !/\b\d{2,3}\s?cm\b/i.test(value)) continue;
      if (spec.attribute === "education" && !/\b(?:degree|phd|school|college|university|diploma)\b/i.test(value)) continue;
      facts.push({
        relation,
        attribute: spec.attribute,
        value,
        text: `${relation} ${spec.attribute} ${value}`,
      });
      break;
    }
    if (facts.length >= 8) break;
  }
  return facts;
}

function normalizeSourceSpans(value: unknown, fallbackText: string | null, refs: string[]): Array<Record<string, string>> {
  const explicit = Array.isArray(value) ? value : [];
  const out: Array<Record<string, string>> = [];
  for (const entry of explicit) {
    if (out.length >= 8) break;
    const record = asRecord(entry);
    const text = normalizeString(record?.text ?? entry);
    if (!text) continue;
    const ref = normalizeString(record?.ref ?? record?.uri ?? record?.id);
    out.push(ref ? { text, ref } : { text });
  }
  if (out.length === 0 && fallbackText) {
    const ref = refs[0];
    out.push(ref ? { text: fallbackText, ref } : { text: fallbackText });
  }
  return out;
}

function normalizeTimeValidity(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const key of ["state", "current", "valid_from", "valid_until", "observed_at"]) {
      const next = record[key];
      if (typeof next === "string" || typeof next === "boolean") out[key] = next;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return { state: "unspecified" };
}

export function enrichOrdinaryMemorySlots(input: OrdinaryMemoryConstructionInput): Record<string, unknown> {
  if (!shouldEnrichOrdinaryMemory(input)) return input.slots;

  const existing = asRecord(input.slots[ORDINARY_MEMORY_SLOT_KEY]) ?? {};
  const title = normalizeString(input.title);
  const summary = normalizeString(input.textSummary);
  const text = [title, summary].filter((value): value is string => Boolean(value)).join(" ");
  const relationFacts = extractCommonRelationFacts(text);
  const sourceRefs = uniqueStrings([
    input.rawRef,
    ...splitRefList(input.evidenceRef),
    ...stringList(input.slots.source_refs, 16),
    ...splitRefList(input.slots.source_ids),
  ], 32);

  const answerableFacts = uniqueStrings([
    ...existingOrTopLevelList(input.slots, existing, "answerable_facts", 16),
    ...relationFacts.map((fact) => fact.text),
    summary,
    title,
  ], 16);
  const entities = uniqueStrings([
    ...existingOrTopLevelList(input.slots, existing, "entities", 24),
    ...relationFacts.flatMap((fact) => [fact.relation, fact.value]),
    ...extractEntityHints(text),
  ], 24);
  const aliases = uniqueStrings([
    ...existingOrTopLevelList(input.slots, existing, "aliases", 24),
    ...relationFacts.map((fact) => fact.relation),
  ], 24);
  const topicKeys = uniqueStrings([
    ...existingOrTopLevelList(input.slots, existing, "topic_keys", 24),
    ...relationFacts.flatMap((fact) => [fact.relation, fact.attribute]),
    ...deriveTopicKeys(text),
  ], 24);
  const questionKeys = uniqueStrings([
    ...existingOrTopLevelList(input.slots, existing, "question_keys", 24),
    ...relationFacts.flatMap((fact) => [fact.relation, fact.attribute]),
  ], 24);

  const ordinary: Record<string, unknown> = {
    schema_version: "ordinary_memory_v1",
    construction: "deterministic_runtime_write",
    answerable_facts: answerableFacts,
    entities,
    topic_keys: topicKeys,
    time_validity: normalizeTimeValidity(existing.time_validity ?? input.slots.time_validity),
    source_spans: normalizeSourceSpans(existing.source_spans ?? input.slots.source_spans, summary ?? title, sourceRefs),
  };
  if (aliases.length > 0) ordinary.aliases = aliases;
  if (questionKeys.length > 0) ordinary.question_keys = questionKeys;
  if (relationFacts.length > 0) ordinary.relation_facts = relationFacts;
  if (sourceRefs.length > 0) ordinary.source_ids = sourceRefs;

  return {
    ...input.slots,
    [ORDINARY_MEMORY_SLOT_KEY]: ordinary,
  };
}
