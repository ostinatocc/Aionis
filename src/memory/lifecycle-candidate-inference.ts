import type {
  AionisLifecycleCandidateSignal,
  AionisMemoryDecisionSurface,
} from "./product-output-contract.js";

export type LifecycleCandidateEntry = {
  memory_id: string;
  title: string | null;
  summary: string;
  memory_type: string;
  domain: string;
  lifecycle_state: string;
  authority: string;
  target_files?: string[];
  execution_state?: {
    summary_kind?: string | null;
    execution_kind?: string | null;
    transition_kind?: string | null;
  };
};

type LifecycleCandidateSignalType = AionisLifecycleCandidateSignal["signal_type"];
type LifecycleCandidateEvidenceField = AionisLifecycleCandidateSignal["evidence_span"]["source_field"];

type RulePattern = {
  signal_type: LifecycleCandidateSignalType;
  source_field: LifecycleCandidateEvidenceField;
  pattern: RegExp;
  confidence: number;
  reason: string;
};

const EXECUTION_TARGET_PATH = /(?:^|[.\s])(?:src|app|lib|packages|tests?|scripts|docs|services|routes|components)\//i;

const TITLE_RULES: RulePattern[] = [
  {
    signal_type: "current",
    source_field: "title",
    pattern: /\b(?:current|active|accepted|resume|continuation|handoff)\b/i,
    confidence: 0.78,
    reason: "Title carries a current or active continuation cue.",
  },
  {
    signal_type: "procedure",
    source_field: "title",
    pattern: /\b(?:procedure|workflow|playbook|steps?|adapter|migration|handoff)\b/i,
    confidence: 0.76,
    reason: "Title carries a reusable procedure or workflow cue.",
  },
  {
    signal_type: "negative",
    source_field: "title",
    pattern: /\b(?:failed|failure|rejected|invalidated|counter[-\s]?evidence|non-current branch)\b/i,
    confidence: 0.9,
    reason: "Title carries a failed or counter-evidence cue.",
  },
  {
    signal_type: "stale",
    source_field: "title",
    pattern: /\b(?:stale|outdated|obsolete|older|earlier|legacy)\b/i,
    confidence: 0.84,
    reason: "Title carries an older or stale-state cue.",
  },
];

const SUMMARY_RULES: RulePattern[] = [
  {
    signal_type: "current",
    source_field: "text_summary",
    pattern: /\b(?:current valid state|current executable state|accepted continuation|resume from|active continuation|current active path)\b/i,
    confidence: 0.86,
    reason: "Summary states a current executable continuation.",
  },
  {
    signal_type: "procedure",
    source_field: "text_summary",
    pattern: /\b(?:reusable procedure|procedure:|workflow:|playbook:|steps?:|run or review tests|keep changes scoped)\b/i,
    confidence: 0.82,
    reason: "Summary states reusable workflow or procedure content.",
  },
  {
    signal_type: "negative",
    source_field: "text_summary",
    pattern: /\b(?:failed branch|failure branch|rejected|invalidated|counter[-\s]?evidence|non-current branch|check before direct use|should be checked before)\b/i,
    confidence: 0.92,
    reason: "Summary marks this memory as failed, rejected, or counter-evidence.",
  },
  {
    signal_type: "stale",
    source_field: "text_summary",
    pattern: /\b(?:stale|outdated|obsolete|no longer usable|older execution note|older .* newer .* evidence|earlier premise|newer .* current)\b/i,
    confidence: 0.88,
    reason: "Summary marks this memory as older than newer/current evidence.",
  },
  {
    signal_type: "contested",
    source_field: "text_summary",
    pattern: /\b(?:contested|conflicting|conflicts with|contradicted|contradicts|requires inspection|inspect before reuse)\b/i,
    confidence: 0.86,
    reason: "Summary carries conflict or inspect-before-reuse evidence.",
  },
  {
    signal_type: "rehydrate",
    source_field: "text_summary",
    pattern: /\b(?:rehydrate|expand|exact raw|raw diff|raw trace|raw trajectory|payload|source evidence pointer|file-level evidence|full context)\b/i,
    confidence: 0.78,
    reason: "Summary points to raw or full evidence that may require rehydration.",
  },
];

export function inferLifecycleCandidateSignals(args: {
  entries: LifecycleCandidateEntry[];
  query_intent?: string | null;
  producer?: AionisLifecycleCandidateSignal["producer"];
}): AionisLifecycleCandidateSignal[] {
  const producer = args.producer ?? "rule_v1";
  const signals: AionisLifecycleCandidateSignal[] = [];
  const seen = new Set<string>();
  for (const entry of args.entries) {
    if (!entryEligibleForLifecycleCandidateInference(entry)) continue;
    for (const rule of [...TITLE_RULES, ...SUMMARY_RULES]) {
      const source = rule.source_field === "title" ? entry.title : entry.summary;
      const quote = evidenceQuote(source, rule.pattern);
      if (!quote) continue;
      const key = `${entry.memory_id}:${rule.signal_type}:${rule.source_field}:${quote.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({
        memory_id: entry.memory_id,
        signal_type: rule.signal_type,
        confidence: rule.confidence,
        evidence_span: {
          source_field: rule.source_field,
          quote,
        },
        producer,
        reason: rule.reason,
      });
    }
  }
  return signals.slice(0, 64);
}

export function lifecycleCandidateDirectUseUnsafe(signal: AionisLifecycleCandidateSignal): boolean {
  return signal.producer === "rule_v1"
    && signal.confidence >= 0.84
    && (
      signal.signal_type === "negative"
      || signal.signal_type === "stale"
      || signal.signal_type === "contested"
    );
}

export function lifecycleCandidateAllowsRehydrate(args: {
  signal: AionisLifecycleCandidateSignal;
  surface: AionisMemoryDecisionSurface;
  memory_lifecycle_state: string;
  rehydration_requested: boolean;
}): boolean {
  return args.signal.signal_type === "rehydrate"
    && args.rehydration_requested
    && (args.surface === "rehydrate" || args.memory_lifecycle_state === "rehydration_candidate");
}

function entryEligibleForLifecycleCandidateInference(entry: LifecycleCandidateEntry): boolean {
  if (entry.memory_type === "fact" || entry.memory_type === "preference" || entry.memory_type === "project_context") {
    return false;
  }
  if (entry.domain === "execution" || entry.memory_type === "execution_memory" || entry.memory_type === "procedure") {
    return true;
  }
  if (entry.execution_state) return true;
  if ((entry.target_files ?? []).some((target) => EXECUTION_TARGET_PATH.test(target))) return true;
  return EXECUTION_TARGET_PATH.test(`${entry.title ?? ""}\n${entry.summary}`);
}

function evidenceQuote(value: string | null | undefined, pattern: RegExp): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  const match = pattern.exec(text);
  if (!match || match.index < 0) return null;
  const start = Math.max(0, match.index - 60);
  const end = Math.min(text.length, match.index + (match[0]?.length ?? 0) + 80);
  return text.slice(start, end).trim();
}
