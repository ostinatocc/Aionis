import { deriveExecutionContractFromSlots } from "./execution-contract.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function executionContextContract(context: unknown) {
  const ctx = asRecord(context);
  if (!ctx) return null;
  return deriveExecutionContractFromSlots({
    slots: ctx,
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "pattern_trust_shaping_context_v1",
      notes: ["pattern_trust_shaping:context_resolution"],
    },
  });
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function words(value: string, limit = 6): string[] {
  return value
    .split(/[\s,.;:()[\]{}"']+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeFamilyLabel(value: string | null | undefined, fallbackPrefix: string): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith(`${fallbackPrefix}:`)) {
    return truncate(trimmed, 128);
  }
  const tokens = words(value.toLowerCase(), 6)
    .map((part) => part.replace(/[^a-z0-9_-]/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return truncate(`${fallbackPrefix}:${tokens.join("-")}`, 128);
}

export function extractTaskCue(
  context: unknown,
  inputText: string | null | undefined,
  note: string | null | undefined,
): string | null {
  const ctx = asRecord(context);
  const task = asRecord(ctx?.task);
  const issue = asRecord(ctx?.issue);
  const error = asRecord(ctx?.error);
  const executionContract = executionContextContract(context);
  return firstNonEmptyString([
    executionContract?.task_signature,
    ctx?.task_signature,
    task?.signature,
    ctx?.goal,
    task?.goal,
    ctx?.objective,
    task?.objective,
    executionContract?.task_family,
    ctx?.query,
    task?.query,
    ctx?.task_kind,
    issue?.kind,
    executionContract?.next_action,
    executionContract?.target_files.join(" "),
    error?.signature,
    error?.code,
    note,
    inputText,
  ]);
}

export function extractErrorSignature(context: unknown): string | null {
  const ctx = asRecord(context);
  const error = asRecord(ctx?.error);
  return firstNonEmptyString([
    error?.signature,
    error?.code,
    ctx?.error_signature,
    ctx?.error_code,
    ctx?.failure_signature,
  ]);
}

export function extractTaskFamily(context: unknown, taskCue: string | null): string | null {
  const ctx = asRecord(context);
  const task = asRecord(ctx?.task);
  const issue = asRecord(ctx?.issue);
  const executionContract = executionContextContract(context);
  return normalizeFamilyLabel(
    firstNonEmptyString([
      executionContract?.task_family,
      ctx?.task_family,
      task?.family,
      ctx?.task_kind,
      task?.kind,
      issue?.kind,
      taskCue,
    ]),
    "task",
  );
}

export function extractErrorFamily(context: unknown, errorSignature: string | null): string | null {
  const ctx = asRecord(context);
  const error = asRecord(ctx?.error);
  return normalizeFamilyLabel(
    firstNonEmptyString([
      ctx?.error_family,
      error?.family,
      errorSignature,
    ]),
    "error",
  );
}

export function buildTaskSignature(args: {
  taskCue: string | null;
}): string {
  if (!args.taskCue) return "tools_select:unspecified-task";
  const tokens = words(args.taskCue.toLowerCase(), 6).join("-");
  if (!tokens) return "tools_select:unspecified-task";
  return truncate(`tools_select:${tokens}`, 256);
}

export type PatternAffinityLevel =
  | "exact_task_signature"
  | "same_task_family"
  | "same_error_family"
  | "broader_similarity";

export function resolvePatternTaskAffinity(args: {
  context: unknown;
  selectedTool: string;
  storedTaskSignature?: string | null;
  storedTaskFamily?: string | null;
  storedErrorFamily?: string | null;
}): {
  level: PatternAffinityLevel;
  score: number;
  current_task_signature: string | null;
  current_task_family: string | null;
  current_error_family: string | null;
} {
  const taskCue = extractTaskCue(args.context, null, null);
  const currentTaskSignature = taskCue
    ? buildTaskSignature({
        taskCue,
      })
    : null;
  const currentTaskFamily = extractTaskFamily(args.context, taskCue);
  const currentErrorFamily = extractErrorFamily(args.context, extractErrorSignature(args.context));

  if (
    currentTaskSignature
    && args.storedTaskSignature
    && currentTaskSignature === args.storedTaskSignature
  ) {
    return {
      level: "exact_task_signature",
      score: 3,
      current_task_signature: currentTaskSignature,
      current_task_family: currentTaskFamily,
      current_error_family: currentErrorFamily,
    };
  }
  if (
    currentTaskFamily
    && args.storedTaskFamily
    && currentTaskFamily === args.storedTaskFamily
  ) {
    return {
      level: "same_task_family",
      score: 2,
      current_task_signature: currentTaskSignature,
      current_task_family: currentTaskFamily,
      current_error_family: currentErrorFamily,
    };
  }
  if (
    currentErrorFamily
    && args.storedErrorFamily
    && currentErrorFamily === args.storedErrorFamily
  ) {
    return {
      level: "same_error_family",
      score: 1,
      current_task_signature: currentTaskSignature,
      current_task_family: currentTaskFamily,
      current_error_family: currentErrorFamily,
    };
  }
  return {
    level: "broader_similarity",
    score: 0,
    current_task_signature: currentTaskSignature,
    current_task_family: currentTaskFamily,
    current_error_family: currentErrorFamily,
  };
}
