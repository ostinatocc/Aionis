import { clampInt } from "./replay-execution-helpers.js";

export type ReplayGuidedRepairStrategy = "deterministic_skip" | "heuristic_patch" | "http_synth" | "builtin_llm";

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

function extractJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return asObject(parsed);
  } catch {
    // continue
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      return asObject(parsed);
    } catch {
      // continue
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1));
      return asObject(parsed);
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
        return toStringOrNull(obj.text) ?? "";
      })
      .filter((v) => v.length > 0);
    if (fragments.length > 0) return fragments.join("\n");
  }
  return null;
}

function looksLikeReplayPatchObject(obj: Record<string, unknown>): boolean {
  if (Array.isArray(obj.steps_override)) return true;
  if (Array.isArray(obj.remove_step_indices)) return true;
  if (Array.isArray(obj.step_patches)) return true;
  if (asObject(obj.matchers)) return true;
  if (asObject(obj.success_criteria)) return true;
  const riskProfile = toStringOrNull(obj.risk_profile);
  if (riskProfile === "low" || riskProfile === "medium" || riskProfile === "high") return true;
  if (asObject(obj.policy_constraints)) return true;
  return false;
}

async function synthesizeGuidedRepairWithBuiltinLLM(input: {
  stepIndex: number | null;
  toolName: string | null;
  reason: string;
  detail: string | null;
  stepObj: Record<string, unknown> | null;
  command: string | null;
  argv: string[];
  allowedCommands: Set<string>;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}): Promise<
  | {
      strategy: string;
      patch: Record<string, unknown>;
      llm_model: string;
      llm_endpoint: string;
      llm_response_preview: string;
      reasoning: string | null;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        source: string;
      };
    }
  | { error: string }
> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const minimaxCompat = /minimax/i.test(baseUrl) || /minimax/i.test(input.model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: input.model,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      messages: [
        {
          role: "system",
          content:
            "You synthesize replay repair patches. Return strict JSON only. "
            + "Use patch schema keys from this set: steps_override, remove_step_indices, step_patches, "
            + "matchers, success_criteria, risk_profile, policy_constraints. "
            + "Prefer minimal, safe, one-step patch changes.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Generate replay repair patch for one failing guided step.",
              constraints: {
                step_index_required: input.stepIndex,
                tool_name: input.toolName,
                allowed_commands: [...input.allowedCommands.values()],
                reason: input.reason,
                detail: input.detail,
                command: input.command,
                argv: input.argv,
                step: input.stepObj ?? {},
              },
              output_schema: {
                strategy: "string",
                reasoning: "string (optional)",
                patch: {
                  step_patches: [
                    {
                      step_index: "number",
                      set: "object",
                    },
                  ],
                  remove_step_indices: ["number"],
                },
              },
            },
            null,
            2,
          ),
        },
      ],
    };
    if (minimaxCompat) {
      body.reasoning_split = true;
      body.response_format = { type: "json_object" };
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: `builtin_llm_http_${res.status}` };
    }
    const content = extractChatCompletionText(payload);
    if (!content) return { error: "builtin_llm_empty_content" };
    const parsed = extractJsonObjectFromText(content);
    if (!parsed) return { error: "builtin_llm_invalid_json" };
    const patchObj = asObject(parsed.patch) ?? (looksLikeReplayPatchObject(parsed) ? parsed : null);
    if (!patchObj || !looksLikeReplayPatchObject(patchObj)) {
      return { error: "builtin_llm_missing_patch" };
    }
    const usageObj = asObject((payload as Record<string, unknown>).usage) ?? {};
    const promptTokens = Number(
      usageObj.prompt_tokens ?? usageObj.input_tokens ?? usageObj.promptTokens ?? usageObj.inputTokens ?? 0,
    );
    const completionTokens = Number(
      usageObj.completion_tokens ?? usageObj.output_tokens ?? usageObj.completionTokens ?? usageObj.outputTokens ?? 0,
    );
    const totalTokensRaw = Number(
      usageObj.total_tokens ?? usageObj.totalTokens ?? (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
        ? promptTokens + completionTokens
        : 0),
    );
    const usage =
      Number.isFinite(promptTokens) && Number.isFinite(completionTokens) && Number.isFinite(totalTokensRaw)
        ? {
            prompt_tokens: Math.max(0, Math.trunc(promptTokens)),
            completion_tokens: Math.max(0, Math.trunc(completionTokens)),
            total_tokens: Math.max(0, Math.trunc(totalTokensRaw)),
            source: "builtin_llm",
          }
        : undefined;
    return {
      strategy: toStringOrNull(parsed.strategy) ?? "builtin_llm_patch",
      patch: patchObj,
      llm_model: input.model,
      llm_endpoint: endpoint,
      llm_response_preview: content.slice(0, 800),
      reasoning: toStringOrNull(parsed.reasoning),
      usage,
    };
  } catch (err: any) {
    return { error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
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

function buildDeterministicGuidedRepairPatch(input: {
  stepIndex: number | null;
  toolName: string | null;
  reason: string;
  detail?: string | null;
}) {
  const removeStepIndices = input.stepIndex != null ? [input.stepIndex] : [];
  return {
    strategy: "remove_step_keep_flow",
    reason: input.reason,
    detail: input.detail ?? null,
    patch: removeStepIndices.length > 0 ? { remove_step_indices: removeStepIndices } : {},
    fallback_action_patch: {
      step_index: input.stepIndex,
      tool_name: input.toolName,
      action: "skip",
      reason: input.reason,
      detail: input.detail ?? null,
    },
  };
}

function pickGuidedRepairReplacementCommand(
  command: string | null,
  allowedCommands: Set<string>,
  commandAliasMap: Record<string, string>,
): string | null {
  const normalized = command ? command.trim() : "";
  if (normalized) {
    const directAlias = commandAliasMap[normalized];
    if (directAlias && allowedCommands.has(directAlias)) return directAlias;
  }
  const fallback = [...allowedCommands.values()].find((candidate) => candidate !== normalized) ?? null;
  if (fallback) return fallback;
  if (normalized && allowedCommands.has(normalized)) return normalized;
  return null;
}

function buildHeuristicGuidedRepairPatch(input: {
  stepIndex: number | null;
  toolName: string | null;
  reason: string;
  detail?: string | null;
  stepObj?: Record<string, unknown> | null;
  command?: string | null;
  argv?: string[];
  allowedCommands: Set<string>;
  commandAliasMap: Record<string, string>;
}) {
  const fallback = buildDeterministicGuidedRepairPatch(input);
  if (input.stepIndex == null) {
    return {
      ...fallback,
      strategy: "heuristic_fallback_remove_step",
      heuristic_applied: false,
    };
  }

  const stepIndex = input.stepIndex;
  const stepObj = input.stepObj ?? {};
  const currentArgv = input.argv ?? [];

  if (input.reason === "command_not_allowed_or_missing") {
    const replacement = pickGuidedRepairReplacementCommand(
      input.command ?? null,
      input.allowedCommands,
      input.commandAliasMap,
    );
    if (replacement && currentArgv.length > 0) {
      const baseToolInput = asObject(stepObj.tool_input_template) ?? asObject(stepObj.tool_input) ?? {};
      const nextArgv = [replacement, ...currentArgv.slice(1)];
      return {
        strategy: "replace_command_then_retry",
        reason: input.reason,
        detail: input.detail ?? null,
        heuristic_applied: true,
        patch: {
          step_patches: [
            {
              step_index: stepIndex,
              set: {
                tool_input_template: {
                  ...baseToolInput,
                  argv: nextArgv,
                },
                retry_policy: {
                  max_retries: 1,
                  backoff_ms: 250,
                },
              },
            },
          ],
        },
        fallback_patch: fallback.patch,
        fallback_action_patch: fallback.fallback_action_patch,
      };
    }
  }

  if (input.reason === "execution_failed_guided_skip") {
    const retryPolicy = asObject(stepObj.retry_policy) ?? {};
    const maxRetriesRaw = Number(retryPolicy.max_retries ?? 0);
    const baseMaxRetries = Number.isFinite(maxRetriesRaw) ? Math.max(0, Math.trunc(maxRetriesRaw)) : 0;
    const backoffRaw = Number(retryPolicy.backoff_ms ?? 250);
    const baseBackoff = Number.isFinite(backoffRaw) ? Math.max(0, Math.trunc(backoffRaw)) : 250;
    return {
      strategy: "increase_retry_budget_then_retry",
      reason: input.reason,
      detail: input.detail ?? null,
      heuristic_applied: true,
      patch: {
        step_patches: [
          {
            step_index: stepIndex,
            set: {
              retry_policy: {
                ...retryPolicy,
                max_retries: Math.max(1, baseMaxRetries + 1),
                backoff_ms: Math.max(250, baseBackoff),
              },
            },
          },
        ],
      },
      fallback_patch: fallback.patch,
      fallback_action_patch: fallback.fallback_action_patch,
    };
  }

  return {
    ...fallback,
    strategy: "heuristic_fallback_remove_step",
    heuristic_applied: false,
  };
}

export async function makeGuidedRepairPatch(input: {
  strategy: ReplayGuidedRepairStrategy;
  stepIndex: number | null;
  toolName: string | null;
  reason: string;
  detail?: string | null;
  stepObj?: Record<string, unknown> | null;
  command?: string | null;
  argv?: string[];
  allowedCommands: Set<string>;
  commandAliasMap: Record<string, string>;
  maxErrorChars: number;
  httpEndpoint?: string | null;
  httpTimeoutMs?: number;
  httpAuthToken?: string | null;
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  llmModel?: string | null;
  llmTimeoutMs?: number;
  llmMaxTokens?: number;
  llmTemperature?: number;
  mode: "guided";
}) {
  const detail = truncateRepairDetail(input.detail ?? null, input.maxErrorChars);
  if (input.strategy === "builtin_llm") {
    const llmBaseUrl = toStringOrNull(input.llmBaseUrl);
    const llmApiKey = toStringOrNull(input.llmApiKey);
    const llmModel = toStringOrNull(input.llmModel);
    if (llmBaseUrl && llmApiKey && llmModel) {
      const timeoutMs = clampInt(Number(input.llmTimeoutMs ?? 7000), 200, 60000);
      const maxTokens = clampInt(Number(input.llmMaxTokens ?? 500), 64, 4000);
      const temperatureRaw = Number(input.llmTemperature ?? 0.1);
      const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(1, temperatureRaw)) : 0.1;
      const llm = await synthesizeGuidedRepairWithBuiltinLLM({
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        reason: input.reason,
        detail,
        stepObj: input.stepObj ?? null,
        command: input.command ?? null,
        argv: input.argv ?? [],
        allowedCommands: input.allowedCommands,
        baseUrl: llmBaseUrl,
        apiKey: llmApiKey,
        model: llmModel,
        timeoutMs,
        maxTokens,
        temperature,
      });
      if (!("error" in llm)) {
        return {
          strategy: llm.strategy,
          reason: input.reason,
          detail,
          source: "builtin_llm",
          patch: llm.patch,
          reasoning: llm.reasoning,
          llm_model: llm.llm_model,
          llm_endpoint: llm.llm_endpoint,
          llm_response_preview: llm.llm_response_preview,
          usage: llm.usage,
          fallback_patch: buildDeterministicGuidedRepairPatch({
            stepIndex: input.stepIndex,
            toolName: input.toolName,
            reason: input.reason,
            detail,
          }).patch,
        };
      }
      return {
        ...buildHeuristicGuidedRepairPatch({
          stepIndex: input.stepIndex,
          toolName: input.toolName,
          reason: input.reason,
          detail,
          stepObj: input.stepObj,
          command: input.command,
          argv: input.argv,
          allowedCommands: input.allowedCommands,
          commandAliasMap: input.commandAliasMap,
        }),
        source: "builtin_llm_fallback",
        synth_error: llm.error,
      };
    }
    return {
      ...buildHeuristicGuidedRepairPatch({
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        reason: input.reason,
        detail,
        stepObj: input.stepObj,
        command: input.command,
        argv: input.argv,
        allowedCommands: input.allowedCommands,
        commandAliasMap: input.commandAliasMap,
      }),
      source: "builtin_llm_fallback",
      synth_error: "builtin_llm_not_configured",
    };
  }
  if (input.strategy === "http_synth") {
    const endpoint = toStringOrNull(input.httpEndpoint);
    if (endpoint) {
      const timeoutMs = clampInt(Number(input.httpTimeoutMs ?? 5000), 200, 60000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(toStringOrNull(input.httpAuthToken)
              ? { authorization: `Bearer ${toStringOrNull(input.httpAuthToken)}` }
              : {}),
          },
          body: JSON.stringify({
            mode: input.mode,
            reason: input.reason,
            detail,
            step_index: input.stepIndex,
            tool_name: input.toolName,
            command: input.command ?? null,
            argv: input.argv ?? [],
            step: input.stepObj ?? {},
            allowed_commands: [...input.allowedCommands.values()],
          }),
          signal: controller.signal,
        });
        const payload = await resp.json().catch(() => ({}));
        const payloadObj = asObject(payload);
        const payloadPatch = payloadObj ? asObject(payloadObj.patch) : null;
        if (resp.ok && payloadPatch) {
          const strategy = toStringOrNull(payloadObj?.strategy) ?? "http_synth_patch";
          return {
            strategy,
            reason: input.reason,
            detail,
            source: "http_synth",
            patch: payloadPatch,
            fallback_patch: buildDeterministicGuidedRepairPatch({
              stepIndex: input.stepIndex,
              toolName: input.toolName,
              reason: input.reason,
              detail,
            }).patch,
          };
        }
        return {
          ...buildHeuristicGuidedRepairPatch({
            stepIndex: input.stepIndex,
            toolName: input.toolName,
            reason: input.reason,
            detail,
            stepObj: input.stepObj,
            command: input.command,
            argv: input.argv,
            allowedCommands: input.allowedCommands,
            commandAliasMap: input.commandAliasMap,
          }),
          source: "http_synth_fallback",
          synth_error: `http_status_${resp.status}`,
        };
      } catch (err: any) {
        return {
          ...buildHeuristicGuidedRepairPatch({
            stepIndex: input.stepIndex,
            toolName: input.toolName,
            reason: input.reason,
            detail,
            stepObj: input.stepObj,
            command: input.command,
            argv: input.argv,
            allowedCommands: input.allowedCommands,
            commandAliasMap: input.commandAliasMap,
          }),
          source: "http_synth_fallback",
          synth_error: String(err?.message ?? err),
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  if (input.strategy === "heuristic_patch") {
    return buildHeuristicGuidedRepairPatch({
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      reason: input.reason,
      detail,
      stepObj: input.stepObj,
      command: input.command,
      argv: input.argv,
      allowedCommands: input.allowedCommands,
      commandAliasMap: input.commandAliasMap,
    });
  }

  return buildDeterministicGuidedRepairPatch({
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    reason: input.reason,
    detail,
  });
}
