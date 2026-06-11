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
type LifecycleCandidateSignalDraft = Pick<
  AionisLifecycleCandidateSignal,
  "memory_id" | "signal_type" | "confidence" | "evidence_span" | "reason"
>;

type RulePattern = {
  signal_type: LifecycleCandidateSignalType;
  source_field: LifecycleCandidateEvidenceField;
  pattern: RegExp;
  confidence: number;
  reason: string;
};

const EXECUTION_TARGET_PATH = /(?:^|[.\s])(?:src|app|lib|packages|tests?|scripts|docs|services|routes|components)\//i;
const NEGATED_SELF_CONTINUATION_PATTERN = /\b(?:did\s+not|didn't|does\s+not|doesn't|never|not)\b[^.!?\n]{0,120}\b(?:become|serve\s+as|remain|work\s+as|act\s+as|use|execute|run|follow|adopt|rely|continue|resume)\b[^.!?\n]{0,120}\b(?:handoff|route|path|branch|continuation|current|accepted|direct(?:\s+use)?|next[-\s]?action|execution)\b/i;
const RETIRED_OR_FAILED_ROUTE_PATTERN = /\b(?:retired|abandoned|discarded|failed|non-current|dead[-\s]?end|did\s+not\s+pan\s+out|didn't\s+pan\s+out|did\s+not\s+become|didn't\s+become|was\s+not\s+accepted|not\s+accepted)\b[^.!?\n]{0,120}\b(?:route|path|branch|handoff|continuation|approach)\b/i;
const DIRECT_USE_EXCLUSION_PATTERN = /\b(?:keep|kept)\s+(?:it|this|the\s+(?:route|path|branch|entry|note|approach))\s+(?:out|outside)\b[^.!?\n]{0,100}\b(?:immediate|direct|next[-\s]?action|use_now|use\s+now|direct\s+use|agent\s+context)\b/i;
const BACKGROUND_NOT_ROUTE_PATTERN = /\b(?:treat|keep|preserve)\s+(?:this|it|the\s+(?:route|path|branch|entry|note|approach))\b[^.!?\n]{0,100}\b(?:background|audit|cautionary)\b[^.!?\n]{0,140}\b(?:not\s+as|rather\s+than|instead\s+of)\b[^.!?\n]{0,100}\b(?:route|path|direct|instruction|next\s+step|next[-\s]?action|execute)\b/i;
const EARLIER_ROUND_PATTERN = /\b(?:previous[-\s]?round|earlier\s+round|earlier\s+note|previous\s+note|belongs\s+to\s+an?\s+earlier|from\s+an?\s+earlier|prior\s+round)\b/i;
const NEWER_CONTINUATION_ELSEWHERE_PATTERN = /\b(?:continuation|handoff|current\s+state|accepted\s+state)\b[^.!?\n]{0,80}\b(?:now|later|subsequently)\b[^.!?\n]{0,80}\b(?:orbits|moved|returned|shifted|points?)\b/i;

const TITLE_RULES: RulePattern[] = [
  {
    signal_type: "current",
    source_field: "title",
    pattern: /\b(?:current|active|accepted|resume|handoff|next continuation|continuation picks up|live continuation)\b/i,
    confidence: 0.78,
    reason: "Title carries a current or active continuation cue.",
  },
  {
    signal_type: "procedure",
    source_field: "title",
    pattern: /\b(?:procedure|workflow|playbook|steps?|adapter|migration|handoff|reusable part|operating pattern|operating recipe)\b/i,
    confidence: 0.76,
    reason: "Title carries a reusable procedure or workflow cue.",
  },
  {
    signal_type: "negative",
    source_field: "title",
    pattern: /\b(?:failed|failure|rejected|invalidated|counter[-\s]?evidence|non-current branch|retired route|route that did not become|did not become (?:the )?(?:handoff|route|continuation)|dead[-\s]?end)\b/i,
    confidence: 0.9,
    reason: "Title carries a failed or counter-evidence cue.",
  },
  {
    signal_type: "stale",
    source_field: "title",
    pattern: /\b(?:stale|outdated|obsolete|older|earlier|legacy|previous[-\s]?round|previous note|earlier note)\b/i,
    confidence: 0.84,
    reason: "Title carries an older or stale-state cue.",
  },
  {
    signal_type: "contested",
    source_field: "title",
    pattern: /\b(?:contested|conflicting|contradicted|disagreeing continuation)\b/i,
    confidence: 0.86,
    reason: "Title carries a conflict or disagreeing-continuation cue.",
  },
  {
    signal_type: "rehydrate",
    source_field: "title",
    pattern: /\b(?:raw|trace|payload|pointer|source evidence|evidence pointer|exact evidence|exact supporting material)\b/i,
    confidence: 0.82,
    reason: "Title carries an explicit raw evidence, trace, payload, or pointer cue.",
  },
];

const SUMMARY_RULES: RulePattern[] = [
  {
    signal_type: "current",
    source_field: "text_summary",
    pattern: /\b(?:current valid state|current executable state|accepted continuation|resume from|active continuation|current active path|work resumes now|thread picks up|picks up around|live continuation point|accepted file family)\b/i,
    confidence: 0.86,
    reason: "Summary states a current executable continuation.",
  },
  {
    signal_type: "procedure",
    source_field: "text_summary",
    pattern: /\b(?:reusable procedure|procedure:|workflow:|playbook:|steps?:|run or review tests|keep changes scoped|reusable part|narrow operating pattern|operating pattern|operating recipe|scoped apply and verify)\b/i,
    confidence: 0.82,
    reason: "Summary states reusable workflow or procedure content.",
  },
  {
    signal_type: "negative",
    source_field: "text_summary",
    pattern: /\b(?:failed branch|failure branch|rejected|invalidated|counter[-\s]?evidence|non-current branch|check before direct use|should be checked before|treated as (?:an? )?retired route|retired route for|did not become (?:the )?(?:accepted continuation|handoff|route|path)|didn't become (?:the )?(?:accepted continuation|handoff|route|path)|did not become accepted|didn't become accepted|keep (?:it|this|the (?:route|path|branch|entry|note|approach)) (?:out|outside) (?:of )?(?:the )?(?:immediate|direct|next[-\s]?action)|cautionary background|what not to execute directly|not as (?:the )?(?:route|path|direct instruction|next step))\b/i,
    confidence: 0.92,
    reason: "Summary marks this memory as failed, rejected, or counter-evidence.",
  },
  {
    signal_type: "stale",
    source_field: "text_summary",
    pattern: /\b(?:stale|outdated|obsolete|no longer usable|older execution note|older .* newer .* evidence|earlier premise|newer .* current|previous[-\s]?round|earlier round|earlier note|previous note|belongs to an? earlier|available for audit rather than making it the path|continuation now orbits|current state now orbits)\b/i,
    confidence: 0.88,
    reason: "Summary marks this memory as older than newer/current evidence.",
  },
  {
    signal_type: "contested",
    source_field: "text_summary",
    pattern: /\b(?:contested|conflicting|conflicts with|contradicted|contradicts|requires inspection|inspect before reuse|audit before adopting|prior memory says[^.]{0,200}\bbut\b[^.]{0,200}\baccepted\b[^.]{0,80}\bevidence\b[^.]{0,80}\bpoints?)\b/i,
    confidence: 0.86,
    reason: "Summary carries conflict or inspect-before-reuse evidence.",
  },
  {
    signal_type: "rehydrate",
    source_field: "text_summary",
    pattern: /\b(?:rehydrate|expand|exact raw|raw diff|raw trace|raw trajectory|raw evidence|payload|source evidence pointer|file-level evidence|full context|exact patch details|review trace|per-file proof|open this pointer|pointer to (?:the )?exact supporting material|exact supporting material|raw commit evidence must be opened)\b/i,
    confidence: 0.82,
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
  const textSignalDrafts: LifecycleCandidateSignalDraft[] = [];
  const seen = new Set<string>();
  const addSignal = (signal: LifecycleCandidateSignalDraft) => {
    const key = [
      signal.memory_id,
      signal.signal_type,
      signal.evidence_span.source_field,
      signal.evidence_span.quote.toLowerCase(),
    ].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    signals.push({
      ...signal,
      producer,
    });
  };
  for (const entry of args.entries) {
    if (!entryEligibleForLifecycleCandidateInference(entry)) continue;
    for (const rule of [...TITLE_RULES, ...SUMMARY_RULES]) {
      const source = rule.source_field === "title" ? entry.title : entry.summary;
      const quote = evidenceQuote(source, rule.pattern);
      if (!quote) continue;
      if (positiveSignalSuppressedBySelfNegation(rule.signal_type, source)) continue;
      const signal = {
        memory_id: entry.memory_id,
        signal_type: rule.signal_type,
        confidence: rule.confidence,
        evidence_span: {
          source_field: rule.source_field,
          quote,
        },
        reason: rule.reason,
      } satisfies LifecycleCandidateSignalDraft;
      textSignalDrafts.push(signal);
      addSignal(signal);
    }
  }
  for (const signal of inferTargetClusterSignals(args.entries, textSignalDrafts)) {
    addSignal(signal);
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

function sourceText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function selfNegatedContinuationCue(value: string | null | undefined): boolean {
  const text = sourceText(value);
  if (!text) return false;
  return NEGATED_SELF_CONTINUATION_PATTERN.test(text)
    || RETIRED_OR_FAILED_ROUTE_PATTERN.test(text)
    || DIRECT_USE_EXCLUSION_PATTERN.test(text)
    || BACKGROUND_NOT_ROUTE_PATTERN.test(text)
    || EARLIER_ROUND_PATTERN.test(text)
    || NEWER_CONTINUATION_ELSEWHERE_PATTERN.test(text);
}

function positiveSignalSuppressedBySelfNegation(
  signalType: LifecycleCandidateSignalType,
  value: string | null | undefined,
): boolean {
  if (signalType !== "current" && signalType !== "procedure") return false;
  return selfNegatedContinuationCue(value);
}

function signalDraftDirectUseUnsafe(signal: LifecycleCandidateSignalDraft): boolean {
  return signal.confidence >= 0.84
    && (
      signal.signal_type === "negative"
      || signal.signal_type === "stale"
      || signal.signal_type === "contested"
    );
}

function inferTargetClusterSignals(
  entries: LifecycleCandidateEntry[],
  textSignals: LifecycleCandidateSignalDraft[],
): LifecycleCandidateSignalDraft[] {
  const unsafeSignalMemoryIds = new Set(
    textSignals
      .filter(signalDraftDirectUseUnsafe)
      .map((signal) => signal.memory_id),
  );
  const affirmativeSignalMemoryIds = new Set(
    textSignals
      .filter((signal) =>
        (signal.signal_type === "current" || signal.signal_type === "procedure")
        && !unsafeSignalMemoryIds.has(signal.memory_id)
      )
      .map((signal) => signal.memory_id),
  );
  const projections = entries
    .filter((entry) => entryEligibleForLifecycleCandidateInference(entry))
    .map((entry) => ({
      entry,
      targets: normalizedTargetFiles(entry),
      targetQuote: targetFilesQuote(entry.target_files ?? []),
    }))
    .filter((projection) => projection.targets.length > 0);
  const supportByTargetSet = new Map<string, Set<string>>();
  for (const projection of projections) {
    const key = targetSetKey(projection.targets);
    const ids = supportByTargetSet.get(key) ?? new Set<string>();
    ids.add(projection.entry.memory_id);
    supportByTargetSet.set(key, ids);
  }
  const supportedTargetSets = [...supportByTargetSet.entries()]
    .map(([targetSet, ids]) => ({
      targetSet,
      support: ids.size,
      targets: targetSetTargets(targetSet),
    }))
    .filter((entry) => entry.support >= 2);
  if (supportedTargetSets.length === 0) return [];
  const structuralActiveTargetSets = supportedTargetSets
    .filter((entry) => !supportedTargetSets.some((other) =>
      other.targetSet !== entry.targetSet
      && other.support >= entry.support
      && targetSetIsStrictSubset(entry.targets, other.targets)
    ));
  const affirmativeStructuralActiveTargetSets = structuralActiveTargetSets.filter((entry) =>
    [...(supportByTargetSet.get(entry.targetSet) ?? [])].some((memoryId) => affirmativeSignalMemoryIds.has(memoryId))
  );
  const activeClusterTargetSets = new Set(
    (affirmativeStructuralActiveTargetSets.length > 0
      ? affirmativeStructuralActiveTargetSets
      : structuralActiveTargetSets
    ).map((entry) => entry.targetSet),
  );

  const inActiveCluster = projections.filter((projection) =>
    activeClusterTargetSets.has(targetSetKey(projection.targets))
  );
  if (new Set(inActiveCluster.map((projection) => projection.entry.memory_id)).size < 2) return [];

  const signals: LifecycleCandidateSignalDraft[] = [];
  for (const projection of projections) {
    const matchesActiveCluster = activeClusterTargetSets.has(targetSetKey(projection.targets));
    if (matchesActiveCluster) {
      if (unsafeSignalMemoryIds.has(projection.entry.memory_id)) continue;
      signals.push({
        memory_id: projection.entry.memory_id,
        signal_type: "current",
        confidence: 0.78,
        evidence_span: {
          source_field: "slots",
          quote: `target_files match active execution cluster: ${projection.targetQuote}`,
        },
        reason: "Exact target-file relation places this memory in the supported active execution cluster.",
      });
      continue;
    }
    signals.push({
      memory_id: projection.entry.memory_id,
      signal_type: "contested",
      confidence: 0.86,
      evidence_span: {
        source_field: "slots",
        quote: `target_files outside active execution cluster: ${projection.targetQuote}`,
      },
      reason: "Target-file relation places this memory outside the supported active execution cluster; inspect before direct reuse.",
    });
  }
  return signals;
}

function normalizedTargetFiles(entry: LifecycleCandidateEntry): string[] {
  const targets = (entry.target_files ?? [])
    .map(normalizeTargetFile)
    .filter((value): value is string => !!value);
  return [...new Set(targets)];
}

function targetSetKey(targets: string[]): string {
  return [...targets].sort().join("\n");
}

function targetSetTargets(targetSet: string): string[] {
  return targetSet.split("\n").filter(Boolean);
}

function targetSetIsStrictSubset(candidate: string[], container: string[]): boolean {
  if (candidate.length === 0 || candidate.length >= container.length) return false;
  const containerSet = new Set(container);
  return candidate.every((target) => containerSet.has(target));
}

function normalizeTargetFile(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function targetFilesQuote(values: string[]): string {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}
