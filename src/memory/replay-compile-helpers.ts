import { assertEmbeddingSurfaceForbidden } from "../embeddings/surface-policy.js";
import { sha256Hex } from "../util/crypto.js";

export type ReplayDeterministicGateResolved = {
  enabled: boolean;
  preferDeterministicExecution: boolean;
  onMismatch: "fallback" | "reject";
  requiredStatuses: string[];
  requestMatchers: Record<string, unknown> | null;
  requestPolicyConstraints: Record<string, unknown> | null;
};

export type ReplayDeterministicGateEvaluation = {
  enabled: boolean;
  requested_mode: "simulate" | "strict" | "guided";
  effective_mode: "simulate" | "strict" | "guided";
  decision: "disabled" | "matched" | "promoted_to_strict" | "fallback_to_requested_mode" | "rejected";
  mismatch_reasons: string[];
  inference_skipped: boolean;
  playbook_status: string;
  required_statuses: string[];
  status_match: boolean;
  matchers_match: boolean;
  policy_constraints_match: boolean;
  matched: boolean;
  request_matcher_fingerprint: string | null;
  playbook_matcher_fingerprint: string | null;
  request_policy_fingerprint: string | null;
  playbook_policy_fingerprint: string | null;
};

type ReplayCompileVariableKind = "path" | "url" | "uuid" | "version";

type ReplayCompileVariableSummary = {
  name: string;
  kind: ReplayCompileVariableKind;
  sample: string;
  occurrences: number;
  step_indexes: number[];
  paths: string[];
};

const UUID_V4_OR_VX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function cloneJson<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function canonicalizeJsonForFingerprint(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => canonicalizeJsonForFingerprint(item));
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input as Record<string, unknown>).sort()) {
    out[key] = canonicalizeJsonForFingerprint((input as Record<string, unknown>)[key]);
  }
  return out;
}

function stableJsonForFingerprint(input: unknown): string {
  try {
    return JSON.stringify(canonicalizeJsonForFingerprint(input));
  } catch {
    return JSON.stringify(String(input));
  }
}

function fingerprintHexForReplay(input: unknown): string {
  return sha256Hex(stableJsonForFingerprint(input));
}

function resolveReplayDeterministicGate(input: unknown): ReplayDeterministicGateResolved {
  const obj = asObject(input);
  if (!obj) {
    return {
      enabled: false,
      preferDeterministicExecution: false,
      onMismatch: "fallback",
      requiredStatuses: ["shadow", "active"],
      requestMatchers: null,
      requestPolicyConstraints: null,
    };
  }
  const requiredStatusesRaw = Array.isArray(obj.required_statuses) ? obj.required_statuses : ["shadow", "active"];
  const requiredStatuses = requiredStatusesRaw
    .map((value) => toStringOrNull(value))
    .filter((value): value is string => Boolean(value));
  return {
    enabled: obj.enabled !== false,
    preferDeterministicExecution: obj.prefer_deterministic_execution !== false,
    onMismatch: obj.on_mismatch === "reject" ? "reject" : "fallback",
    requiredStatuses: requiredStatuses.length > 0 ? requiredStatuses : ["shadow", "active"],
    requestMatchers: asObject(obj.matchers),
    requestPolicyConstraints: asObject(obj.policy_constraints),
  };
}

export function evaluateReplayDeterministicGate(args: {
  requestedMode: "simulate" | "strict" | "guided";
  gateInput: unknown;
  playbookStatus: string | null;
  playbookSlots: Record<string, unknown>;
}): ReplayDeterministicGateEvaluation {
  assertEmbeddingSurfaceForbidden("replay_deterministic_gate");
  const gate = resolveReplayDeterministicGate(args.gateInput);
  const playbookStatus = args.playbookStatus ?? "draft";
  const playbookMatchers = asObject(args.playbookSlots.matchers) ?? {};
  const playbookPolicyConstraints = asObject(args.playbookSlots.policy_constraints) ?? {};
  const requestMatcherFingerprint = gate.requestMatchers ? fingerprintHexForReplay(gate.requestMatchers) : null;
  const playbookMatcherFingerprint = fingerprintHexForReplay(playbookMatchers);
  const requestPolicyFingerprint = gate.requestPolicyConstraints ? fingerprintHexForReplay(gate.requestPolicyConstraints) : null;
  const playbookPolicyFingerprint = fingerprintHexForReplay(playbookPolicyConstraints);
  const statusMatch = gate.requiredStatuses.includes(playbookStatus);
  const matchersMatch =
    gate.requestMatchers == null || stableJsonForFingerprint(gate.requestMatchers) === stableJsonForFingerprint(playbookMatchers);
  const policyConstraintsMatch =
    gate.requestPolicyConstraints == null
      || stableJsonForFingerprint(gate.requestPolicyConstraints) === stableJsonForFingerprint(playbookPolicyConstraints);
  const matched = gate.enabled && statusMatch && matchersMatch && policyConstraintsMatch;
  const mismatchReasons: string[] = [];
  if (gate.enabled && !statusMatch) mismatchReasons.push("status_not_allowed_for_deterministic_replay");
  if (gate.enabled && !matchersMatch) mismatchReasons.push("matcher_fingerprint_mismatch");
  if (gate.enabled && !policyConstraintsMatch) mismatchReasons.push("policy_constraints_fingerprint_mismatch");
  const effectiveMode =
    matched && gate.preferDeterministicExecution && args.requestedMode === "simulate"
      ? "strict"
      : args.requestedMode;
  return {
    enabled: gate.enabled,
    requested_mode: args.requestedMode,
    effective_mode: effectiveMode,
    decision:
      !gate.enabled
        ? "disabled"
        : matched
          ? effectiveMode === "strict" && args.requestedMode === "simulate"
            ? "promoted_to_strict"
            : "matched"
          : gate.onMismatch === "reject"
            ? "rejected"
            : "fallback_to_requested_mode",
    mismatch_reasons: mismatchReasons,
    inference_skipped: matched && effectiveMode === "strict",
    playbook_status: playbookStatus,
    required_statuses: gate.requiredStatuses,
    status_match: statusMatch,
    matchers_match: matchersMatch,
    policy_constraints_match: policyConstraintsMatch,
    matched,
    request_matcher_fingerprint: requestMatcherFingerprint,
    playbook_matcher_fingerprint: playbookMatcherFingerprint,
    request_policy_fingerprint: requestPolicyFingerprint,
    playbook_policy_fingerprint: playbookPolicyFingerprint,
  };
}

export function nextActionForReplayDeterministicGate(evaluation: ReplayDeterministicGateEvaluation): string {
  if (!evaluation.enabled) return "deterministic_gate_not_requested";
  if (evaluation.matched) return "safe_to_skip_primary_inference";
  if (evaluation.decision === "rejected") return "inspect_gate_mismatch_before_execution";
  if (evaluation.mismatch_reasons.includes("status_not_allowed_for_deterministic_replay")) {
    return "promote_or_select_a_replayable_playbook_version";
  }
  return "fallback_to_normal_planner_or_simulate";
}

export function dedupeReplayCompileSteps(
  steps: Array<Record<string, unknown>>,
): {
  steps: Array<Record<string, unknown>>;
  removed_count: number;
  removed_step_indexes: number[];
} {
  const kept: Array<Record<string, unknown>> = [];
  const removedStepIndexes: number[] = [];
  let previousFingerprint: string | null = null;
  let previousWasRepair = false;

  for (const raw of steps) {
    const step = asObject(raw) ? cloneJson(asObject(raw)!) : {};
    const stepIndex = Number(step.step_index ?? NaN);
    const fingerprint = stableJsonForFingerprint({
      tool_name: toStringOrNull(step.tool_name),
      tool_input_template: step.tool_input_template ?? {},
      expected_output_signature: step.expected_output_signature ?? null,
      preconditions: Array.isArray(step.preconditions) ? step.preconditions : [],
      postconditions: Array.isArray(step.postconditions) ? step.postconditions : [],
      retry_policy: asObject(step.retry_policy) ?? null,
      safety_level: toStringOrNull(step.safety_level) ?? "needs_confirm",
      last_outcome: toStringOrNull(step.last_outcome) ?? "pending",
    });
    const outcome = toStringOrNull(step.last_outcome) ?? "pending";
    const isRepair = Boolean(step.repair_applied_last_run === true);
    const canDropAsDuplicate =
      previousFingerprint != null
      && previousFingerprint === fingerprint
      && outcome === "success"
      && !isRepair
      && !previousWasRepair;
    if (canDropAsDuplicate) {
      if (Number.isFinite(stepIndex)) removedStepIndexes.push(Math.trunc(stepIndex));
      continue;
    }
    kept.push(step);
    previousFingerprint = fingerprint;
    previousWasRepair = isRepair;
  }

  return {
    steps: kept,
    removed_count: Math.max(0, steps.length - kept.length),
    removed_step_indexes: removedStepIndexes,
  };
}

function detectReplayCompileVariableKind(raw: string): ReplayCompileVariableKind | null {
  const v = raw.trim();
  if (!v) return null;
  if (UUID_V4_OR_VX.test(v)) return "uuid";
  if (/^https?:\/\/[^\s]+$/i.test(v)) return "url";
  if (/^(\/|~\/|\.\.?\/)[^\s]*$/.test(v)) return "path";
  if (/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)) return "version";
  return null;
}

function collectReplayCompileVariableStrings(
  value: unknown,
  path: string,
  out: Array<{ path: string; value: string }>,
) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) out.push({ path, value: normalized });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectReplayCompileVariableStrings(value[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    collectReplayCompileVariableStrings(v, `${path}.${key}`, out);
  }
}

export function enrichReplayCompileStepsWithVariables(
  steps: Array<Record<string, unknown>>,
): {
  steps: Array<Record<string, unknown>>;
  summary: {
    variable_count: number;
    steps_with_variables: number;
    variables: ReplayCompileVariableSummary[];
  };
} {
  type Candidate = {
    kind: ReplayCompileVariableKind;
    sample: string;
    step_index: number;
    path: string;
  };
  const allCandidates: Candidate[] = [];
  const stepCandidates = new Map<number, Candidate[]>();
  const nextSteps = steps.map((raw) => {
    const step = asObject(raw) ? cloneJson(asObject(raw)!) : {};
    const stepIndex = Number(step.step_index ?? NaN);
    if (!Number.isFinite(stepIndex)) return step;
    const idx = Math.trunc(stepIndex);
    const rawStrings: Array<{ path: string; value: string }> = [];
    collectReplayCompileVariableStrings(step.tool_input_template ?? {}, "tool_input_template", rawStrings);
    collectReplayCompileVariableStrings(step.expected_output_signature ?? null, "expected_output_signature", rawStrings);
    collectReplayCompileVariableStrings(step.preconditions ?? [], "preconditions", rawStrings);
    collectReplayCompileVariableStrings(step.postconditions ?? [], "postconditions", rawStrings);
    for (const entry of rawStrings) {
      const kind = detectReplayCompileVariableKind(entry.value);
      if (!kind) continue;
      const candidate: Candidate = {
        kind,
        sample: entry.value.slice(0, 160),
        step_index: idx,
        path: entry.path,
      };
      allCandidates.push(candidate);
      const bucket = stepCandidates.get(idx) ?? [];
      bucket.push(candidate);
      stepCandidates.set(idx, bucket);
    }
    return step;
  });

  const grouped = new Map<string, ReplayCompileVariableSummary>();
  for (const c of allCandidates) {
    const key = `${c.kind}:${c.sample}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        name: "",
        kind: c.kind,
        sample: c.sample,
        occurrences: 1,
        step_indexes: [c.step_index],
        paths: [c.path],
      });
      continue;
    }
    existing.occurrences += 1;
    if (!existing.step_indexes.includes(c.step_index)) existing.step_indexes.push(c.step_index);
    if (!existing.paths.includes(c.path)) existing.paths.push(c.path);
  }

  const kindSeq = new Map<ReplayCompileVariableKind, number>();
  const variables = Array.from(grouped.values())
    .sort((a, b) => {
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.sample.localeCompare(b.sample);
    })
    .map((v) => {
      const seq = (kindSeq.get(v.kind) ?? 0) + 1;
      kindSeq.set(v.kind, seq);
      return {
        ...v,
        name: `${v.kind}_${seq}`,
        step_indexes: v.step_indexes.slice().sort((x, y) => x - y),
        paths: v.paths.slice(0, 12),
      };
    });

  const nameByKey = new Map<string, string>();
  for (const v of variables) nameByKey.set(`${v.kind}:${v.sample}`, v.name);

  const enriched = nextSteps.map((raw) => {
    const step = asObject(raw) ? cloneJson(asObject(raw)!) : {};
    const stepIndex = Number(step.step_index ?? NaN);
    if (!Number.isFinite(stepIndex)) return step;
    const idx = Math.trunc(stepIndex);
    const candidates = stepCandidates.get(idx) ?? [];
    const templateVars = candidates
      .map((c) => ({
        name: nameByKey.get(`${c.kind}:${c.sample}`) ?? "",
        kind: c.kind,
        sample: c.sample,
        path: c.path,
      }))
      .filter((v) => v.name.length > 0)
      .slice(0, 16);
    if (templateVars.length > 0) {
      step.template_variables = templateVars;
    }
    return step;
  });

  return {
    steps: enriched,
    summary: {
      variable_count: variables.length,
      steps_with_variables: new Set(variables.flatMap((v) => v.step_indexes)).size,
      variables: variables.slice(0, 100),
    },
  };
}

function scoreReplayCompileStep(
  step: Record<string, unknown>,
): {
  score: number;
  flags: string[];
} {
  const flags: string[] = [];
  let score = 0.25;
  const toolName = toStringOrNull(step.tool_name);
  const preconditions = Array.isArray(step.preconditions) ? step.preconditions : [];
  const postconditions = Array.isArray(step.postconditions) ? step.postconditions : [];
  const expected = step.expected_output_signature;
  const hasExpected = expected != null && (typeof expected !== "object" || Object.keys(asObject(expected) ?? {}).length > 0);
  const safety = toStringOrNull(step.safety_level) ?? "needs_confirm";
  const outcome = toStringOrNull(step.last_outcome) ?? "pending";
  const repairApplied = Boolean(step.repair_applied_last_run === true);

  if (!toolName) {
    flags.push("missing_tool_name");
    score -= 0.25;
  }
  if (preconditions.length > 0) {
    score += 0.2;
  } else {
    flags.push("missing_preconditions");
  }
  if (postconditions.length > 0) {
    score += 0.15;
  } else {
    flags.push("missing_postconditions");
  }
  if (hasExpected) {
    score += 0.15;
  } else {
    flags.push("missing_expected_signature");
  }
  if (safety === "auto_ok") score += 0.1;
  else if (safety === "needs_confirm") score += 0.05;
  else flags.push("manual_only_step");

  if (outcome === "success") score += 0.15;
  else if (outcome === "failed") {
    score -= 0.1;
    flags.push("last_outcome_failed");
  }

  if (repairApplied) {
    score -= 0.15;
    flags.push("repair_applied_last_run");
  }

  const bounded = Math.max(0, Math.min(1, score));
  if (bounded < 0.5) flags.push("low_quality");
  return { score: Number(bounded.toFixed(3)), flags };
}

export function enrichReplayCompileStepsWithQuality(
  steps: Array<Record<string, unknown>>,
): {
  steps: Array<Record<string, unknown>>;
  summary: {
    average_step_quality_score: number;
    low_quality_steps: number;
    low_quality_step_indexes: number[];
    repaired_steps: number;
    recommendations: string[];
  };
} {
  let totalScore = 0;
  let totalSteps = 0;
  let lowQualitySteps = 0;
  let repairedSteps = 0;
  const lowQualityIndexes: number[] = [];
  const enriched = steps.map((raw) => {
    const step = asObject(raw) ? cloneJson(asObject(raw)!) : {};
    const scored = scoreReplayCompileStep(step);
    const idx = Number(step.step_index ?? NaN);
    step.quality_score = scored.score;
    step.quality_flags = scored.flags;
    totalSteps += 1;
    totalScore += scored.score;
    if (scored.score < 0.5) {
      lowQualitySteps += 1;
      if (Number.isFinite(idx)) lowQualityIndexes.push(Math.trunc(idx));
    }
    if (step.repair_applied_last_run === true) repairedSteps += 1;
    return step;
  });

  const recommendations: string[] = [];
  if (lowQualitySteps > 0) {
    recommendations.push("improve low-quality steps by adding preconditions, postconditions, and expected output signatures");
  }
  if (repairedSteps > 0) {
    recommendations.push("review repaired steps and keep strict safety_level for unstable tool calls");
  }

  return {
    steps: enriched,
    summary: {
      average_step_quality_score: totalSteps > 0 ? Number((totalScore / totalSteps).toFixed(3)) : 0,
      low_quality_steps: lowQualitySteps,
      low_quality_step_indexes: lowQualityIndexes.sort((a, b) => a - b),
      repaired_steps: repairedSteps,
      recommendations,
    },
  };
}
