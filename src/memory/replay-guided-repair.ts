export type ReplayGuidedRepairStrategy = "agent_repair_request";

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

export function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

export function asStringRecord(input: unknown): Record<string, string> {
  const obj = asObject(input);
  if (!obj) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = toStringOrNull(k);
    const value = toStringOrNull(v);
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

export function mergeReplayUsage(
  target: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    source: string;
  },
  usage: unknown,
) {
  const obj = asObject(usage);
  if (!obj) return;
  const prompt = Number(obj.prompt_tokens);
  const completion = Number(obj.completion_tokens);
  const total = Number(obj.total_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || !Number.isFinite(total)) return;
  target.prompt_tokens += Math.max(0, Math.trunc(prompt));
  target.completion_tokens += Math.max(0, Math.trunc(completion));
  target.total_tokens += Math.max(0, Math.trunc(total));
  const source = toStringOrNull(obj.source);
  if (source && target.source === "no_model_call" && target.total_tokens > 0) target.source = source;
}

export function isReplayCommandTool(toolName: string | null): boolean {
  if (!toolName) return false;
  return toolName === "command" || toolName === "shell" || toolName === "exec" || toolName === "bash";
}

export function parseStepArgv(stepObj: Record<string, unknown>, toolName: string | null): string[] {
  const rawTemplate = asObject(stepObj.tool_input_template) ?? asObject(stepObj.tool_input) ?? {};
  const argv = asStringArray(rawTemplate.argv);
  if (argv.length > 0) return argv;

  const command = toStringOrNull(rawTemplate.command) ?? (toolName === "bash" ? "bash" : null);
  const args = asStringArray(rawTemplate.args);
  if (!command) return [];
  return [command, ...args];
}

function truncateRepairDetail(detail: string | null | undefined, maxChars: number): string | null {
  if (!detail) return null;
  const normalized = detail.trim();
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

export async function buildAgentRepairRequest(input: {
  strategy: ReplayGuidedRepairStrategy;
  stepIndex: number | null;
  toolName: string | null;
  reason: string;
  detail?: string | null;
  stepObj?: Record<string, unknown> | null;
  command?: string | null;
  argv?: string[];
  allowedCommands: Set<string>;
  maxErrorChars: number;
  mode: "guided";
}) {
  const detail = truncateRepairDetail(input.detail ?? null, input.maxErrorChars);
  return {
    strategy: input.strategy,
    source: "runtime_observation",
    kind: "agent_repair_request",
    authority: "candidate_only",
    repair_applied: false,
    runtime_patch_generated: false,
    runtime_semantic_repair_allowed: false,
    reason: input.reason,
    detail,
    step_index: input.stepIndex,
    tool_name: input.toolName,
    command: input.command ?? null,
    argv: input.argv ?? [],
    allowed_commands: [...input.allowedCommands.values()],
    step: input.stepObj ?? {},
    next_actor: "agent_or_external_llm_candidate_producer",
    next_action:
      "Use this structured failure evidence to propose a candidate playbook change outside Runtime source code.",
  };
}
