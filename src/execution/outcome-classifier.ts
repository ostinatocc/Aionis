export type ExecutionOutcomeClass = "passed" | "failed" | "unknown";

export type ExecutionOutcomeClassification = {
  outcome: ExecutionOutcomeClass;
  conflict: boolean;
};

const UNKNOWN_OUTCOME: ExecutionOutcomeClassification = {
  outcome: "unknown",
  conflict: false,
};

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function classifyNormalizedText(normalized: string): ExecutionOutcomeClassification {
  const negatedConflict =
    /\b(?:not|no|without|never)\s+(?:known\s+)?(?:conflict|conflicts|conflicted|conflicting|contradict|contradicts|contradicted|contradicting|contradiction|contradictions|contradictory|inconsistency|inconsistencies|inconsistent|disagreement|disagreements|divergence|divergent)\b/.test(normalized)
    || /\b(?:conflict|conflicts|conflicted|conflicting|contradict|contradicts|contradicted|contradicting|contradiction|contradictions|inconsistency|inconsistencies|disagreement|disagreements)\s*[:=]\s*(?:false|no|0)\b/.test(normalized);
  const hasConflict =
    /\b(?:conflict|conflicts|conflicted|conflicting|contradict|contradicts|contradicted|contradicting|contradiction|contradictions|contradictory|inconsistency|inconsistencies|inconsistent|disagreement|disagreements|divergence|divergent)\b/.test(normalized);
  if (hasConflict && !negatedConflict) {
    return {
      outcome: "failed",
      conflict: true,
    };
  }

  const negatedFailure =
    /\b(?:not|no|without|never)\s+(?:known\s+)?(?:failed|failing|failure|failures|error|errors|errored|blocked|blocker|blockers|rejected|invalid|unsuccessful|regression|regressions|timeout|crash|crashed|wrong)\b/.test(normalized)
    || /\b(?:failed|failing|failure|failures|error|errors|errored|blocked|blocker|blockers|rejected|invalid|unsuccessful|regression|regressions|timeout|crash|crashed|wrong)\s+(?:not|never)\s+(?:observed|found|detected|present)\b/.test(normalized)
    || /\b(?:failed|failing|failure|failures|error|errors|errored|blocked|blocker|blockers|rejected|invalid|unsuccessful|regression|regressions|timeout|crash|crashed|wrong)\s*[:=]\s*(?:false|no|0)\b/.test(normalized);
  const negatedSuccess =
    /\b(?:not|no|without|never)\s+(?:passed|passing|pass|accepted|valid|verified|successful|success|succeeded|resolved|fixed|complete|completed|ok)\b/.test(normalized)
    || /\b(?:passed|passing|pass|accepted|valid|verified|successful|success|succeeded|resolved|fixed|complete|completed|ok)\s+(?:not|never)\s+(?:observed|found|detected|present)\b/.test(normalized);
  const hasFailure =
    /\b(?:failed|failing|failure|failures|error|errors|errored|blocked|blocker|blockers|rejected|invalid|unsuccessful|regression|regressions|timeout|crash|crashed|wrong)\b/.test(normalized);
  const hasSuccess =
    /\b(?:passed|passing|pass|accepted|valid|verified|successful|success|succeeded|resolved|fixed|complete|completed|ok)\b/.test(normalized);

  if (hasFailure && !negatedFailure) return { outcome: "failed", conflict: false };
  if (hasSuccess && !negatedSuccess) return { outcome: "passed", conflict: false };
  return UNKNOWN_OUTCOME;
}

export function classifyExecutionOutcomeText(text: string | null | undefined): ExecutionOutcomeClassification {
  const normalized = text?.trim().toLowerCase();
  return normalized ? classifyNormalizedText(normalized) : UNKNOWN_OUTCOME;
}

export function classifyExecutionOutcomeRecord(record: Record<string, unknown> | null): ExecutionOutcomeClassification {
  if (!record) return UNKNOWN_OUTCOME;
  for (const key of [
    "status",
    "outcome",
    "result",
    "verdict",
    "state",
    "summary",
    "message",
    "diagnostic_note",
    "diagnostic",
    "notes",
  ] as const) {
    const classified = classifyExecutionOutcomeText(stringValue(record[key]));
    if (classified.conflict) return classified;
  }

  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "boolean") continue;
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("conflict")
      || normalizedKey.includes("contradiction")
      || normalizedKey.includes("inconsistent")
    ) {
      if (value) return { outcome: "failed", conflict: true };
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "boolean") continue;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "failed" || normalizedKey === "failure" || normalizedKey.includes("failure")) {
      if (value) return { outcome: "failed", conflict: false };
      continue;
    }
    if (
      normalizedKey.includes("passed")
      || normalizedKey.includes("success")
      || normalizedKey.includes("validated")
      || normalizedKey === "ok"
    ) {
      return {
        outcome: value ? "passed" : "failed",
        conflict: false,
      };
    }
  }

  for (const key of [
    "status",
    "outcome",
    "result",
    "verdict",
    "state",
    "summary",
    "message",
    "diagnostic_note",
    "diagnostic",
    "notes",
  ] as const) {
    const classified = classifyExecutionOutcomeText(stringValue(record[key]));
    if (classified.outcome !== "unknown") return classified;
  }
  return UNKNOWN_OUTCOME;
}

export function classifyExecutionOutcomeFromSlots(slots: unknown): ExecutionOutcomeClassification {
  const slotRecord = asRecord(slots);
  return classifyExecutionOutcomeRecord(asRecord(slotRecord?.execution_result_summary));
}
