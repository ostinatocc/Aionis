import { stableUuid } from "../util/uuid.js";

export type AdjudicableMemoryEntry = {
  memory_id: string;
  title: string | null;
  summary: string;
  domain: "general" | "execution";
  authority: "trusted" | "advisory" | "candidate" | "blocked" | "none";
  confidence: number;
  salience: number;
  lifecycle_state: "active" | "candidate" | "contested" | "suppressed" | "demoted" | "archived" | "rehydration_candidate" | "unknown";
  scope_hint?: string | null;
  observed_at?: string | null;
  target_files?: string[];
  source_index: number;
};

export type MemoryLifecycleRelation = {
  source_memory_id: string;
  target_memory_id: string;
  relation: "supersedes" | "contradicts" | "invalidates";
  confidence: number;
  reasons: string[];
  evidence: MemoryLifecycleRelationEvidence;
};

export type MemoryLifecycleRelationSignals = {
  source_cues: string[];
  prior_cues: string[];
  topic_overlap: number;
  shared_target_paths: number;
  target_path_conflict: boolean;
  same_domain: boolean;
  source_newer: boolean;
};

export type MemoryLifecycleRelationGate = {
  source_admissible: boolean;
  target_admissible: boolean;
  source_newer: boolean;
  candidate_confidence_passed: boolean | null;
  relation_supported: boolean;
  confidence_threshold_passed: boolean;
  accepted: boolean;
};

export type MemoryLifecycleRelationEvidence = {
  producer: string;
  candidate_confidence: number | null;
  signals: MemoryLifecycleRelationSignals;
  gate: MemoryLifecycleRelationGate;
  reasons: string[];
};

export type MemoryLifecycleRelationCandidate = {
  source_memory_id: string;
  target_memory_id: string;
  relation: "supersedes" | "contradicts" | "invalidates";
  confidence: number;
  producer: string;
  reasons: string[];
};

export type MemoryLifecycleRelationCandidateProducer = (args: {
  scope: string;
  entries: AdjudicableMemoryEntry[];
  source_memory_ids: string[];
  deterministic_relations: MemoryLifecycleRelation[];
}) => Promise<MemoryLifecycleRelationCandidate[]>;

export type MemoryLifecycleAdjudication = {
  entries: AdjudicableMemoryEntry[];
  relations: MemoryLifecycleRelation[];
};

export type MemoryLifecycleEdgeInput = {
  id?: string | null;
  type: string;
  src_id: string;
  dst_id: string;
  confidence?: number | null;
  metadata?: Record<string, unknown> | null;
};

const MEMORY_LIFECYCLE_RELATION_TYPES = new Set<MemoryLifecycleRelation["relation"]>([
  "supersedes",
  "contradicts",
  "invalidates",
]);

export const MEMORY_LIFECYCLE_RELATION_EVIDENCE_METADATA_KEY = "memory_lifecycle_relation_evidence";

export function isMemoryLifecycleRelationType(value: string): value is MemoryLifecycleRelation["relation"] {
  return MEMORY_LIFECYCLE_RELATION_TYPES.has(value as MemoryLifecycleRelation["relation"]);
}

export function memoryLifecycleRelationEdgeId(scope: string, relation: Pick<MemoryLifecycleRelation, "source_memory_id" | "target_memory_id" | "relation">): string {
  return stableUuid(`${scope}:memory_lifecycle_relation:${relation.relation}:${relation.source_memory_id}:${relation.target_memory_id}`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function emptyRelationSignals(args?: { sourceNewer?: boolean }): MemoryLifecycleRelationSignals {
  return {
    source_cues: [],
    prior_cues: [],
    topic_overlap: 0,
    shared_target_paths: 0,
    target_path_conflict: false,
    same_domain: false,
    source_newer: args?.sourceNewer ?? false,
  };
}

function memoryLifecycleRelationEvidence(args: {
  producer: string;
  candidateConfidence: number | null;
  signals: MemoryLifecycleRelationSignals;
  sourceAdmissible: boolean;
  targetAdmissible: boolean;
  sourceNewer: boolean;
  relationSupported: boolean;
  confidenceThresholdPassed: boolean;
  accepted: boolean;
  reasons: string[];
}): MemoryLifecycleRelationEvidence {
  return {
    producer: args.producer || "unknown",
    candidate_confidence: args.candidateConfidence === null
      ? null
      : Math.max(0, Math.min(1, Number(args.candidateConfidence.toFixed(6)))),
    signals: args.signals,
    gate: {
      source_admissible: args.sourceAdmissible,
      target_admissible: args.targetAdmissible,
      source_newer: args.sourceNewer,
      candidate_confidence_passed: args.candidateConfidence === null ? null : args.candidateConfidence >= 0.72,
      relation_supported: args.relationSupported,
      confidence_threshold_passed: args.confidenceThresholdPassed,
      accepted: args.accepted,
    },
    reasons: args.reasons,
  };
}

function memoryLifecycleRelationEvidenceFromMetadata(metadata: Record<string, unknown> | null | undefined): MemoryLifecycleRelationEvidence | null {
  const root = asRecord(metadata);
  const raw = asRecord(root?.[MEMORY_LIFECYCLE_RELATION_EVIDENCE_METADATA_KEY]);
  if (!raw) return null;
  const signalsRaw = asRecord(raw.signals);
  const gateRaw = asRecord(raw.gate);
  const candidateConfidence = raw.candidate_confidence === null ? null : finiteNumber(raw.candidate_confidence);
  return {
    producer: typeof raw.producer === "string" && raw.producer.length > 0 ? raw.producer : "persisted_relation",
    candidate_confidence: candidateConfidence === null ? null : Math.max(0, Math.min(1, Number(candidateConfidence.toFixed(6)))),
    signals: {
      source_cues: stringList(signalsRaw?.source_cues),
      prior_cues: stringList(signalsRaw?.prior_cues),
      topic_overlap: Math.max(0, finiteNumber(signalsRaw?.topic_overlap) ?? 0),
      shared_target_paths: Math.max(0, finiteNumber(signalsRaw?.shared_target_paths) ?? 0),
      target_path_conflict: booleanValue(signalsRaw?.target_path_conflict, false),
      same_domain: booleanValue(signalsRaw?.same_domain, false),
      source_newer: booleanValue(signalsRaw?.source_newer, true),
    },
    gate: {
      source_admissible: booleanValue(gateRaw?.source_admissible, true),
      target_admissible: booleanValue(gateRaw?.target_admissible, true),
      source_newer: booleanValue(gateRaw?.source_newer, true),
      candidate_confidence_passed:
        typeof gateRaw?.candidate_confidence_passed === "boolean" ? gateRaw.candidate_confidence_passed : null,
      relation_supported: booleanValue(gateRaw?.relation_supported, true),
      confidence_threshold_passed: booleanValue(gateRaw?.confidence_threshold_passed, true),
      accepted: booleanValue(gateRaw?.accepted, true),
    },
    reasons: stringList(raw.reasons),
  };
}

export function memoryLifecycleRelationsFromEdges(edges: MemoryLifecycleEdgeInput[]): MemoryLifecycleRelation[] {
  const out: MemoryLifecycleRelation[] = [];
  for (const edge of edges) {
    if (!isMemoryLifecycleRelationType(edge.type)) continue;
    const confidence = Number(edge.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0.7) continue;
    const evidence = memoryLifecycleRelationEvidenceFromMetadata(edge.metadata);
    const reasons = [
      "persisted_lifecycle_relation",
      edge.id ? `edge_id=${edge.id}` : null,
      ...(evidence?.reasons ?? []),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    out.push({
      source_memory_id: edge.src_id,
      target_memory_id: edge.dst_id,
      relation: edge.type,
      confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(6)))),
      reasons,
      evidence: evidence ?? memoryLifecycleRelationEvidence({
        producer: "persisted_relation",
        candidateConfidence: null,
        sourceAdmissible: true,
        targetAdmissible: true,
        sourceNewer: true,
        relationSupported: true,
        confidenceThresholdPassed: true,
        accepted: true,
        signals: emptyRelationSignals({ sourceNewer: true }),
        reasons,
      }),
    });
  }
  return out;
}

const DIRECT_CORRECTION_CUES = [
  "corrected",
  "correction",
  "revised",
  "updated",
  "invalidated",
  "invalidates",
  "superseded",
  "supersedes",
  "replaced",
  "replaces",
  "subsequent evidence",
  "later evidence",
  "new evidence",
  "current evidence",
  "contradicted",
  "contradicts",
  "counter-evidence",
  "counter evidence",
  "unverified prior",
  "not direct action context",
  "should not be used",
  "should not direct",
  "do not use",
  "no longer",
];

const CONTEXTUAL_CORRECTION_CUES = [
  "obsolete",
  "outdated",
  "stale",
  "invalid",
  "wrong",
  "failed",
  "deprecated",
];

const PRIOR_CUES = [
  "earlier",
  "initial",
  "prior",
  "previous",
  "old",
  "legacy",
  "former",
  "before later",
  "at that time",
];

const STOPWORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "before",
  "being",
  "between",
  "could",
  "current",
  "direct",
  "during",
  "early",
  "earlier",
  "evidence",
  "first",
  "from",
  "have",
  "into",
  "issue",
  "later",
  "likely",
  "memory",
  "note",
  "only",
  "prior",
  "project",
  "should",
  "surface",
  "that",
  "their",
  "there",
  "this",
  "time",
  "used",
  "with",
  "working",
]);

function textOf(entry: AdjudicableMemoryEntry): string {
  return `${entry.title ?? ""}\n${entry.summary}`.toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordOrPhrase(text: string, cue: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(cue).replace(/\s+/g, "\\s+")}([^a-z0-9]|$)`, "i");
  return pattern.test(text);
}

function includesAny(text: string, cues: string[]): string[] {
  return cues.filter((cue) => hasWordOrPhrase(text, cue));
}

const LIFECYCLE_TARGET_WORD_PATTERN = [
  "approach",
  "assumption",
  "attempt",
  "change\\s+surface",
  "decision",
  "first[\\s-]+pass",
  "former",
  "hypothesis",
  "initial",
  "legacy",
  "old",
  "path",
  "plan",
  "previous",
  "prior",
  "route",
  "workflow",
].join("|");

const NEGATED_LIFECYCLE_CUE_PATTERN = /\b(?:not|never|no|without|still|remains|remain)\b[\w\s-]{0,48}$/i;

function isNegatedCue(text: string, cueStart: number): boolean {
  return NEGATED_LIFECYCLE_CUE_PATTERN.test(text.slice(Math.max(0, cueStart - 64), cueStart));
}

function includesContextualCorrectionCues(text: string): string[] {
  const out: string[] = [];
  for (const cue of CONTEXTUAL_CORRECTION_CUES) {
    const cuePattern = escapeRegExp(cue);
    const targetBefore = new RegExp(`\\b(?:${LIFECYCLE_TARGET_WORD_PATTERN})\\b[\\w\\s.,;:()"'` + "`" + `/-]{0,96}\\b${cuePattern}\\b`, "ig");
    const cueBeforeTarget = new RegExp(`\\b${cuePattern}\\b[\\w\\s.,;:()"'` + "`" + `/-]{0,96}\\b(?:${LIFECYCLE_TARGET_WORD_PATTERN})\\b`, "ig");
    let matched = false;
    for (const match of text.matchAll(targetBefore)) {
      const cueIndex = match.index === undefined ? -1 : match.index + match[0].toLowerCase().lastIndexOf(cue);
      if (cueIndex >= 0 && !isNegatedCue(text, cueIndex)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const match of text.matchAll(cueBeforeTarget)) {
        const cueIndex = match.index ?? -1;
        if (cueIndex >= 0 && !isNegatedCue(text, cueIndex)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) out.push(cue);
  }
  return out;
}

function extractCorrectionCues(text: string): string[] {
  return [
    ...includesAny(text, DIRECT_CORRECTION_CUES),
    ...includesContextualCorrectionCues(text),
  ];
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pathTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pathPattern = /(?:^|[\s"'`([])(\.?\.?\/?[A-Za-z0-9_.@+-]+\/[A-Za-z0-9_./@+-]*(?:\.[A-Za-z0-9]+)?)/g;
  for (const match of text.matchAll(pathPattern)) {
    const value = match[1]?.replace(/[),.;:]+$/g, "");
    if (!value || value.startsWith("http") || value.length < 5 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 32);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/^[._-]+|[._-]+$/g, "");
}

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = text
    .toLowerCase()
    .replace(/[/_.:-]+/g, " ")
    .match(/[a-z0-9]{4,}/g) ?? [];
  for (const word of words) {
    const token = normalizeToken(word);
    if (!token || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function intersectionCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function pathOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  let count = 0;
  for (const value of right) {
    if (leftSet.has(value)) count += 1;
  }
  return count;
}

function hasUsableAuthority(entry: AdjudicableMemoryEntry): boolean {
  return entry.authority === "trusted" || entry.authority === "advisory";
}

function canAdjudicateSource(entry: AdjudicableMemoryEntry): boolean {
  return entry.lifecycle_state === "active"
    && hasUsableAuthority(entry)
    && entry.confidence >= 0.65;
}

function canAdjudicateTarget(entry: AdjudicableMemoryEntry): boolean {
  return entry.lifecycle_state === "active"
    && hasUsableAuthority(entry)
    && entry.confidence >= 0.55;
}

function sourceIsNewer(source: AdjudicableMemoryEntry, target: AdjudicableMemoryEntry, sourceText: string): boolean {
  const sourceTime = parseTime(source.observed_at);
  const targetTime = parseTime(target.observed_at);
  if (sourceTime !== null && targetTime !== null && sourceTime !== targetTime) return sourceTime > targetTime;
  if (sourceTime !== null && targetTime === null) return true;
  if (sourceTime === null && targetTime !== null) return false;
  if (
    sourceText.includes("later")
    || sourceText.includes("subsequent")
    || sourceText.includes("new evidence")
    || sourceText.includes("current evidence")
    || sourceText.includes("current change")
    || sourceText.includes("corrected")
    || sourceText.includes("updated")
    || sourceText.includes("revised")
  ) {
    return true;
  }
  return source.source_index < target.source_index;
}

function relationConfidence(args: {
  correctionCueCount: number;
  priorCueCount: number;
  tokenOverlap: number;
  sharedPathCount: number;
  hasPathConflict: boolean;
  sameDomain: boolean;
  sourceNewer: boolean;
}): number {
  let score = 0.42;
  score += Math.min(0.18, args.correctionCueCount * 0.06);
  score += Math.min(0.1, args.priorCueCount * 0.04);
  score += Math.min(0.14, args.tokenOverlap * 0.025);
  score += Math.min(0.12, args.sharedPathCount * 0.06);
  if (args.hasPathConflict) score += 0.08;
  if (args.sameDomain) score += 0.04;
  if (args.sourceNewer) score += 0.06;
  return Math.max(0, Math.min(0.96, Number(score.toFixed(6))));
}

function relationSurface(source: AdjudicableMemoryEntry, target: AdjudicableMemoryEntry) {
  const sourceText = textOf(source);
  const targetText = textOf(target);
  const sourcePaths = pathTargets(sourceText);
  const targetPaths = pathTargets(targetText);
  const sharedPathCount = pathOverlap(sourcePaths, targetPaths);
  const hasPathConflict = sourcePaths.length > 0 && targetPaths.length > 0 && sharedPathCount === 0;
  const tokenOverlap = intersectionCount(contentTokens(sourceText), contentTokens(targetText));
  const priorCues = includesAny(sourceText, PRIOR_CUES);
  return {
    sourceText,
    targetText,
    sourcePaths,
    targetPaths,
    sharedPathCount,
    hasPathConflict,
    tokenOverlap,
    priorCues,
    relatedByText: tokenOverlap >= 3,
    relatedByPath: sharedPathCount > 0 || (hasPathConflict && tokenOverlap >= 2),
    relatedByPriorCue: priorCues.length > 0 && tokenOverlap >= 2,
  };
}

function relationSignals(args: {
  sourceCues: string[];
  surface: ReturnType<typeof relationSurface>;
  sameDomain: boolean;
  sourceNewer: boolean;
}): MemoryLifecycleRelationSignals {
  return {
    source_cues: args.sourceCues,
    prior_cues: args.surface.priorCues,
    topic_overlap: args.surface.tokenOverlap,
    shared_target_paths: args.surface.sharedPathCount,
    target_path_conflict: args.surface.hasPathConflict,
    same_domain: args.sameDomain,
    source_newer: args.sourceNewer,
  };
}

function candidateRelationConfidence(args: {
  candidateConfidence: number;
  tokenOverlap: number;
  sharedPathCount: number;
  hasPathConflict: boolean;
  sameDomain: boolean;
  sourceNewer: boolean;
}): number {
  let score = 0.3;
  score += Math.min(0.28, args.candidateConfidence * 0.28);
  score += Math.min(0.14, args.tokenOverlap * 0.025);
  score += Math.min(0.12, args.sharedPathCount * 0.06);
  if (args.hasPathConflict) score += 0.04;
  if (args.sameDomain) score += 0.04;
  if (args.sourceNewer) score += 0.08;
  return Math.max(0, Math.min(0.96, Number(score.toFixed(6))));
}

function inferCandidateRelation(
  candidate: MemoryLifecycleRelationCandidate,
  entriesById: Map<string, AdjudicableMemoryEntry>,
): MemoryLifecycleRelation | null {
  if (!isMemoryLifecycleRelationType(candidate.relation)) return null;
  if (candidate.source_memory_id === candidate.target_memory_id) return null;
  const source = entriesById.get(candidate.source_memory_id);
  const target = entriesById.get(candidate.target_memory_id);
  if (!source || !target) return null;
  if (!canAdjudicateSource(source) || !canAdjudicateTarget(target)) return null;
  const sourceText = textOf(source);
  const sourceAdmissible = canAdjudicateSource(source);
  const targetAdmissible = canAdjudicateTarget(target);
  const sourceNewer = sourceIsNewer(source, target, sourceText);
  if (!sourceNewer) return null;
  const candidateConfidence = Math.max(0, Math.min(1, Number(candidate.confidence)));
  if (!Number.isFinite(candidateConfidence) || candidateConfidence < 0.72) return null;
  const surface = relationSurface(source, target);
  const relationSupported = surface.relatedByText || surface.relatedByPath || surface.relatedByPriorCue;
  if (!relationSupported) return null;
  const sameDomain = source.domain === target.domain;
  const confidence = candidateRelationConfidence({
    candidateConfidence,
    tokenOverlap: surface.tokenOverlap,
    sharedPathCount: surface.sharedPathCount,
    hasPathConflict: surface.hasPathConflict,
    sameDomain,
    sourceNewer,
  });
  const confidenceThresholdPassed = confidence >= 0.7;
  if (!confidenceThresholdPassed) return null;
  const reasons = [
    `candidate_producer=${candidate.producer || "unknown"}`,
    `candidate_confidence=${Number(candidateConfidence.toFixed(3))}`,
    ...candidate.reasons.slice(0, 3).map((reason) => `candidate_reason=${reason}`),
    surface.tokenOverlap > 0 ? `topic_overlap=${surface.tokenOverlap}` : null,
    surface.sharedPathCount > 0 ? `shared_target_paths=${surface.sharedPathCount}` : null,
    surface.hasPathConflict ? "candidate_target_path_conflict" : null,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    source_memory_id: candidate.source_memory_id,
    target_memory_id: candidate.target_memory_id,
    relation: candidate.relation,
    confidence,
    reasons,
    evidence: memoryLifecycleRelationEvidence({
      producer: candidate.producer || "unknown",
      candidateConfidence,
      signals: relationSignals({ sourceCues: [], surface, sameDomain, sourceNewer }),
      sourceAdmissible,
      targetAdmissible,
      sourceNewer,
      relationSupported,
      confidenceThresholdPassed,
      accepted: true,
      reasons,
    }),
  };
}

function inferRelation(source: AdjudicableMemoryEntry, target: AdjudicableMemoryEntry): MemoryLifecycleRelation | null {
  if (source.memory_id === target.memory_id) return null;
  if (!canAdjudicateSource(source) || !canAdjudicateTarget(target)) return null;
  const sourceText = textOf(source);
  const sourceAdmissible = canAdjudicateSource(source);
  const targetAdmissible = canAdjudicateTarget(target);
  const sourceNewer = sourceIsNewer(source, target, sourceText);
  if (!sourceNewer) return null;

  const correctionCues = extractCorrectionCues(sourceText);
  if (correctionCues.length === 0) return null;

  const surface = relationSurface(source, target);
  const relationSupported = surface.relatedByText || surface.relatedByPath || surface.relatedByPriorCue;
  if (!relationSupported) return null;
  const sameDomain = source.domain === target.domain;

  const confidence = relationConfidence({
    correctionCueCount: correctionCues.length,
    priorCueCount: surface.priorCues.length,
    tokenOverlap: surface.tokenOverlap,
    sharedPathCount: surface.sharedPathCount,
    hasPathConflict: surface.hasPathConflict,
    sameDomain,
    sourceNewer,
  });
  const confidenceThresholdPassed = confidence >= 0.7;
  if (!confidenceThresholdPassed) return null;

  const relation: MemoryLifecycleRelation["relation"] =
    correctionCues.some((cue) => cue.includes("contradict") || cue.includes("counter"))
      ? "contradicts"
      : correctionCues.some((cue) => cue.includes("invalid") || cue.includes("wrong") || cue.includes("do not use"))
        ? "invalidates"
        : "supersedes";
  const reasons = [
    `source_cues=${correctionCues.slice(0, 4).join(",")}`,
    surface.priorCues.length > 0 ? `prior_cues=${surface.priorCues.slice(0, 3).join(",")}` : null,
    surface.tokenOverlap > 0 ? `topic_overlap=${surface.tokenOverlap}` : null,
    surface.sharedPathCount > 0 ? `shared_target_paths=${surface.sharedPathCount}` : null,
    surface.hasPathConflict ? "corrective_target_path_conflict" : null,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    source_memory_id: source.memory_id,
    target_memory_id: target.memory_id,
    relation,
    confidence,
    reasons,
    evidence: memoryLifecycleRelationEvidence({
      producer: "rule_cue",
      candidateConfidence: null,
      signals: relationSignals({ sourceCues: correctionCues, surface, sameDomain, sourceNewer }),
      sourceAdmissible,
      targetAdmissible,
      sourceNewer,
      relationSupported,
      confidenceThresholdPassed,
      accepted: true,
      reasons,
    }),
  };
}

function strongerRelation(left: MemoryLifecycleRelation, right: MemoryLifecycleRelation): MemoryLifecycleRelation {
  return left.confidence >= right.confidence ? left : right;
}

export function adjudicateMemoryLifecycle(
  entries: AdjudicableMemoryEntry[],
  options?: {
    persisted_relations?: MemoryLifecycleRelation[];
    candidate_relations?: MemoryLifecycleRelationCandidate[];
  },
): MemoryLifecycleAdjudication {
  const relationsByTarget = new Map<string, MemoryLifecycleRelation>();
  const entryIds = new Set(entries.map((entry) => entry.memory_id));
  const entriesById = new Map(entries.map((entry) => [entry.memory_id, entry]));
  for (const relation of options?.persisted_relations ?? []) {
    if (!isMemoryLifecycleRelationType(relation.relation)) continue;
    if (relation.confidence < 0.7) continue;
    if (!entryIds.has(relation.target_memory_id)) continue;
    const existing = relationsByTarget.get(relation.target_memory_id);
    relationsByTarget.set(relation.target_memory_id, existing ? strongerRelation(existing, relation) : relation);
  }
  for (const source of entries) {
    for (const target of entries) {
      const relation = inferRelation(source, target);
      if (!relation) continue;
      const existing = relationsByTarget.get(relation.target_memory_id);
      relationsByTarget.set(relation.target_memory_id, existing ? strongerRelation(existing, relation) : relation);
    }
  }
  for (const candidate of options?.candidate_relations ?? []) {
    const relation = inferCandidateRelation(candidate, entriesById);
    if (!relation) continue;
    const existing = relationsByTarget.get(relation.target_memory_id);
    relationsByTarget.set(relation.target_memory_id, existing ? strongerRelation(existing, relation) : relation);
  }

  const relations = Array.from(relationsByTarget.values())
    .sort((left, right) => right.confidence - left.confidence || left.target_memory_id.localeCompare(right.target_memory_id));
  if (relations.length === 0) return { entries, relations };

  const relationByTarget = new Map(relations.map((relation) => [relation.target_memory_id, relation]));
  return {
    relations,
    entries: entries.map((entry) => {
      const relation = relationByTarget.get(entry.memory_id);
      if (!relation) return entry;
      return {
        ...entry,
        authority: "candidate",
        lifecycle_state: "contested",
        scope_hint: [
          entry.scope_hint,
          `lifecycle adjudication: ${relation.relation} by newer related memory ${relation.source_memory_id}`,
        ].filter(Boolean).join("; "),
      };
    }),
  };
}
