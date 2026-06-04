import type {
  ActionIntelligencePreActionGateSummary,
  ActionRetrievalGateAction,
  ActionRetrievalGateSummary,
  ActionRetrievalUncertaintySummary,
  ActionPacketSummary,
  AuthorityVisibilitySummary,
  ContractTrust,
  FirstStepRecommendation,
  KickoffRecommendation,
  PlannerPacketSummarySurface,
  RuntimeEditBoundaryRecommendation,
  RuntimeEditFailurePhase,
  RuntimeFirstActionRecommendation,
  RuntimeEditBoundaryContext,
  RuntimeVerificationRepairFileHint,
  RuntimeVerificationRepairRecommendation,
  RuntimeVerifierFailurePhase,
  WorkflowLifecycleSummary,
} from "./planning-summary.js";
import type {
  RuntimeEntropyControlsV1,
  RuntimeEntropyProfileV1,
} from "../memory/schemas.js";
import { guardExecutionContractForConsumer, type ExecutionContractV1 } from "../memory/execution-contract.js";
import { resolveContractTrustForSteering } from "../memory/contract-trust.js";
import {
  buildAuthorityInspectionNextAction,
  demoteContractTrustForAuthorityBlock,
} from "../memory/authority-consumption.js";
import { isPromotionReadyWorkflowSignal, summarizePacketEntryLabels } from "./planning-summary-surfaces.js";
import { safeRecordArray, safeStringArray, uniqueStrings } from "./planning-summary-utils.js";

type PatternSignalSummaryLike = {
  candidate_pattern_count: number;
  candidate_pattern_tools: string[];
  trusted_pattern_count: number;
  contested_pattern_count: number;
  trusted_pattern_tools: string[];
  contested_pattern_tools: string[];
};

type ExperienceRecommendationProjectionLike = {
  history_applied: boolean;
  contract_trust: ContractTrust | null;
  execution_contract_v1: ExecutionContractV1 | null;
  selected_tool: string | null;
  task_family: string | null;
  workflow_signature: string | null;
  policy_memory_id: string | null;
  path_source_kind: "recommended_workflow" | "candidate_workflow" | "none";
  file_path: string | null;
  combined_next_action: string | null;
  action_intelligence_pre_action_gate: ActionIntelligencePreActionGateSummary | null;
  runtime_entropy_profile: RuntimeEntropyProfileV1 | null;
  runtime_entropy_controls: RuntimeEntropyControlsV1 | null;
  action_retrieval_uncertainty: ActionRetrievalUncertaintySummary | null;
  authority_blocked: boolean;
  authority_primary_blocker: string | null;
};

type RehydrationCandidateLike = {
  anchor_id: string | null;
  anchor_kind: string | null;
  anchor_level: string | null;
  title: string | null;
  summary: string | null;
  mode: "summary_only" | "partial" | "full" | "differential" | null;
  example_call: string | null;
  payload_cost_hint: "low" | "medium" | "high" | null;
};

function truncateContractText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function boundedUniqueStrings(values: unknown[], limit: number, maxLength: number): string[] {
  return uniqueStrings(
    values
      .map((value) => (typeof value === "string" ? truncateContractText(value, maxLength) : null))
      .filter((value): value is string => !!value),
    limit,
  );
}

function resolveActionRetrievalGateAction(
  uncertainty: ActionRetrievalUncertaintySummary | null | undefined,
): ActionRetrievalGateAction | null {
  if (!uncertainty) return null;
  if (uncertainty.recommended_actions.includes("request_operator_review")) return "request_operator_review";
  if (uncertainty.recommended_actions.includes("rehydrate_payload")) return "rehydrate_payload";
  if (uncertainty.recommended_actions.includes("widen_recall")) return "widen_recall";
  if (uncertainty.recommended_actions.includes("inspect_context")) return "inspect_context";
  if (uncertainty.level === "high") return "inspect_context";
  return null;
}

function resolvePreActionGateAction(
  gate: ActionIntelligencePreActionGateSummary | null | undefined,
): ActionRetrievalGateAction | null {
  if (!gate) return null;
  if (gate.authority_blocked || gate.requires_operator_review || gate.recommended_actions.includes("request_operator_review")) {
    return "request_operator_review";
  }
  if (gate.requires_rehydration || gate.recommended_actions.includes("rehydrate_payload")) return "rehydrate_payload";
  if (gate.requires_recall || gate.recommended_actions.includes("widen_recall")) return "widen_recall";
  if (!gate.known_enough || gate.recommended_actions.includes("inspect_context")) return "inspect_context";
  if (gate.uncertainty_level === "high") return "inspect_context";
  return null;
}

function resolveEffectiveGateAction(args: {
  preActionGate?: ActionIntelligencePreActionGateSummary | null;
  uncertainty?: ActionRetrievalUncertaintySummary | null;
}): ActionRetrievalGateAction | null {
  return resolvePreActionGateAction(args.preActionGate)
    ?? resolveActionRetrievalGateAction(args.uncertainty);
}

function pickPreferredRehydrationCandidate(
  plannerSurface: PlannerPacketSummarySurface,
): RehydrationCandidateLike | null {
  const candidates = safeRecordArray(plannerSurface.rehydration_candidates);
  for (const candidate of candidates) {
    const mode = candidate.mode;
    const payloadCostHint = candidate.payload_cost_hint;
    return {
      anchor_id: typeof candidate.anchor_id === "string" ? candidate.anchor_id : null,
      anchor_kind: typeof candidate.anchor_kind === "string" ? candidate.anchor_kind : null,
      anchor_level: typeof candidate.anchor_level === "string" ? candidate.anchor_level : null,
      title: typeof candidate.title === "string" ? candidate.title : null,
      summary: typeof candidate.summary === "string" ? candidate.summary : null,
      mode:
        mode === "summary_only" || mode === "partial" || mode === "full" || mode === "differential"
          ? mode
          : null,
      example_call: typeof candidate.example_call === "string" ? candidate.example_call : null,
      payload_cost_hint:
        payloadCostHint === "low" || payloadCostHint === "medium" || payloadCostHint === "high"
          ? payloadCostHint
          : null,
    };
  }
  return null;
}

function buildDefaultGateInstruction(args: {
  gateAction: ActionRetrievalGateAction;
  firstStepRecommendation: FirstStepRecommendation | null;
  preferredRehydration: RehydrationCandidateLike | null;
}): string | null {
  const selectedTool = args.firstStepRecommendation?.selected_tool ?? null;
  const filePath = args.firstStepRecommendation?.file_path ?? null;
  const rehydrationLabel =
    args.preferredRehydration?.title
    ?? args.preferredRehydration?.summary
    ?? args.preferredRehydration?.anchor_id
    ?? "the colder payload";

  if (args.gateAction === "request_operator_review") {
    return selectedTool
      ? `Request operator review before committing to ${selectedTool}.`
      : "Request operator review before committing to the next step.";
  }
  if (args.gateAction === "rehydrate_payload") {
    return filePath
      ? `Rehydrate colder payload for ${rehydrationLabel} before reusing ${selectedTool ?? "the learned path"} on ${filePath}.`
      : `Rehydrate colder payload for ${rehydrationLabel} before committing to the next step.`;
  }
  if (args.gateAction === "widen_recall") {
    return selectedTool
      ? `Widen recall before committing to ${selectedTool}${filePath ? ` on ${filePath}` : ""}.`
      : "Widen recall before committing to the next step.";
  }
  if (selectedTool && filePath) {
    return `Inspect ${filePath} and the current context before using ${selectedTool}.`;
  }
  if (selectedTool) {
    return `Inspect the current context before starting with ${selectedTool}.`;
  }
  return "Inspect the current context before taking the next step.";
}

function shouldEscalateTaskStartFromGate(args: {
  gateAction: ActionRetrievalGateAction;
  firstStepRecommendation: FirstStepRecommendation | null;
}): boolean {
  if (!args.firstStepRecommendation?.selected_tool) return true;
  if (args.gateAction !== "inspect_context") return true;
  return (
    args.firstStepRecommendation.source_kind === "experience_intelligence"
    && !args.firstStepRecommendation.file_path
  );
}

function buildUncertaintyAwareNextAction(args: {
  sourceKind: "experience_intelligence" | "tool_selection";
  selectedTool: string | null;
  filePath: string | null;
  nextAction: string | null;
  uncertainty: ActionRetrievalUncertaintySummary | null;
  preActionGate?: ActionIntelligencePreActionGateSummary | null;
}): string | null {
  const uncertainty = args.uncertainty;
  const preActionGate = args.preActionGate ?? null;
  const preActionGateAction = resolvePreActionGateAction(preActionGate);
  if (preActionGateAction && preActionGate && !preActionGate.known_enough) {
    if (preActionGateAction === "request_operator_review") {
      return args.selectedTool
        ? `Request operator review before committing to ${args.selectedTool}.`
        : "Request operator review before committing to the next step.";
    }
    if (preActionGateAction === "rehydrate_payload") {
      return args.filePath
        ? `Rehydrate colder payload before reusing ${args.selectedTool ?? "the learned path"} on ${args.filePath}.`
        : "Rehydrate colder payload before committing to the next step.";
    }
    if (preActionGateAction === "widen_recall") {
      return args.selectedTool
        ? `Widen recall before committing to ${args.selectedTool}${args.filePath ? ` on ${args.filePath}` : ""}.`
        : "Widen recall before committing to the next step.";
    }
    if (preActionGateAction === "inspect_context") {
      if (args.selectedTool && args.filePath) {
        return `Inspect ${args.filePath} and the current context before using ${args.selectedTool}.`;
      }
      if (args.selectedTool) {
        return `Inspect the current context before starting with ${args.selectedTool}.`;
      }
      return args.sourceKind === "experience_intelligence"
        ? "Inspect the current context before reusing the learned path."
        : "Inspect the current context before taking the next step.";
    }
  }
  if (!uncertainty || uncertainty.level === "low") {
    return (
      args.nextAction
      ?? (args.selectedTool && args.filePath
        ? `Use ${args.selectedTool} on ${args.filePath} as the next step.`
        : args.selectedTool
          ? `Start with ${args.selectedTool} as the next step.`
          : null)
    );
  }

  const recommendedActions = new Set(uncertainty.recommended_actions);
  if (recommendedActions.has("request_operator_review")) {
    return args.selectedTool
      ? `Request operator review before committing to ${args.selectedTool}.`
      : "Request operator review before committing to the next step.";
  }
  if (
    recommendedActions.has("widen_recall")
    && args.sourceKind === "experience_intelligence"
    && !!args.filePath
    && !!args.nextAction
    && !recommendedActions.has("rehydrate_payload")
  ) {
    return args.nextAction;
  }
  if (recommendedActions.has("inspect_context") && (!args.selectedTool || !args.filePath)) {
    if (args.selectedTool) {
      return `Inspect the current context before starting with ${args.selectedTool}.`;
    }
    return args.sourceKind === "experience_intelligence"
      ? "Inspect the current context before reusing the learned path."
      : "Inspect the current context before taking the next step.";
  }
  if (recommendedActions.has("widen_recall") && (!args.filePath || args.sourceKind === "tool_selection")) {
    return args.selectedTool
      ? `Widen recall before committing to ${args.selectedTool}${args.filePath ? ` on ${args.filePath}` : ""}.`
      : "Widen recall before committing to the next step.";
  }
  if (recommendedActions.has("rehydrate_payload")) {
    return args.filePath
      ? `Rehydrate colder payload before reusing ${args.selectedTool ?? "the learned path"} on ${args.filePath}.`
      : "Rehydrate colder payload before committing to the next step.";
  }
  if (recommendedActions.has("widen_recall")) {
    return args.selectedTool
      ? `Widen recall before committing to ${args.selectedTool}${args.filePath ? ` on ${args.filePath}` : ""}.`
      : "Widen recall before committing to the next step.";
  }
  if (recommendedActions.has("inspect_context")) {
    if (args.selectedTool && args.filePath) {
      return `Inspect ${args.filePath} and the current context before using ${args.selectedTool}.`;
    }
    if (args.selectedTool) {
      return `Inspect the current context before starting with ${args.selectedTool}.`;
    }
    return args.sourceKind === "experience_intelligence"
      ? "Inspect the current context before reusing the learned path."
      : "Inspect the current context before taking the next step.";
  }

  return (
    args.nextAction
    ?? (args.selectedTool && args.filePath
      ? `Use ${args.selectedTool} on ${args.filePath} as the next step.`
      : args.selectedTool
        ? `Start with ${args.selectedTool} as the next step.`
        : null)
  );
}

function hasStrongContractIdentity(args: {
  taskFamily: string | null;
  workflowSignature: string | null;
  policyMemoryId: string | null;
}): boolean {
  return !!args.taskFamily || !!args.workflowSignature || !!args.policyMemoryId;
}

function resolveContractTrust(args: {
  sourceKind: "experience_intelligence" | "tool_selection";
  historyApplied: boolean;
  explicitTrust: ContractTrust | null;
  taskFamily: string | null;
  workflowSignature: string | null;
  policyMemoryId: string | null;
  executionContract: ExecutionContractV1 | null;
  uncertainty: ActionRetrievalUncertaintySummary | null;
  authorityBlocked: boolean;
}): ContractTrust {
  const strongIdentity = hasStrongContractIdentity(args);
  const computedTrust: ContractTrust =
    args.uncertainty?.level === "high" && !strongIdentity
      ? "observational"
      : (
          strongIdentity
          && (
            !args.uncertainty
            || args.uncertainty.level === "low"
            || (args.sourceKind === "experience_intelligence" && args.historyApplied)
          )
        )
        ? "authoritative"
        : "advisory";
  const resolvedTrust = resolveContractTrustForSteering({
    computedTrust,
    explicitTrust: args.explicitTrust,
    executionContract: args.executionContract,
  });
  return demoteContractTrustForAuthorityBlock(resolvedTrust, args.authorityBlocked) ?? "advisory";
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (next) return next;
  }
  return null;
}

function collectRuntimeFirstActionTargetFiles(args: {
  executionContract: ExecutionContractV1 | null;
  filePath: string | null;
}): string[] {
  return uniqueStrings([
    ...(args.executionContract?.target_files ?? []),
    args.executionContract?.file_path ?? null,
    args.filePath,
  ]);
}

function editBoundaryStringList(value: unknown, limit = 24): string[] {
  return uniqueStrings(safeStringArray(value), limit);
}

function readEditBoundaryContext(value: RuntimeEditBoundaryContext | null | undefined): Required<RuntimeEditBoundaryContext> {
  return {
    allowed_edit_files: editBoundaryStringList(value?.allowed_edit_files, 64),
    forbidden_edit_files: editBoundaryStringList(value?.forbidden_edit_files, 64),
    required_verifiers: editBoundaryStringList(value?.required_verifiers, 64),
    anti_shortcut_rules: editBoundaryStringList(value?.anti_shortcut_rules, 64),
  };
}

type RuntimeVerificationFailureSignal = {
  command: string | null;
  output: string;
  timedOut: boolean;
  fileHints: RuntimeVerificationRepairFileHint[];
  categories: string[];
  toolSchemaHints: string[];
  providerFailureHints: string[];
  editOperationFailureHints: string[];
  editFailureEvents: RuntimeEditFailureEvent[];
};

type RuntimeEditFailureEvent = {
  tool: RuntimeEditFailurePhase["source_tool"];
  phase: RuntimeEditFailurePhase["phase"];
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  message: string | null;
  nextInstruction: string | null;
  nextReason: string | null;
  evidenceText: string;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function commandFromEvidence(record: Record<string, unknown>): string | null {
  const verifier = recordValue(record.verifier);
  const request = recordValue(record.request);
  return firstNonEmptyString(
    stringValue(record.command),
    stringValue(verifier?.command),
    stringValue(request?.command),
  );
}

function evidenceOutputText(record: Record<string, unknown>): string {
  const verifier = recordValue(record.verifier);
  const commandResult = recordValue(record.command_result);
  return [
    stringValue(record.stderr_tail),
    stringValue(record.stdout_tail),
    stringValue(record.stderr),
    stringValue(record.stdout),
    stringValue(verifier?.stderr_tail),
    stringValue(verifier?.stdout_tail),
    stringValue(verifier?.stderr),
    stringValue(verifier?.stdout),
    stringValue(commandResult?.stderr_tail),
    stringValue(commandResult?.stdout_tail),
  ]
    .filter((value): value is string => !!value)
    .join("\n")
    .trim();
}

function evidenceTimedOut(record: Record<string, unknown>): boolean {
  const verifier = recordValue(record.verifier);
  const commandResult = recordValue(record.command_result);
  return record.timed_out === true || verifier?.timed_out === true || commandResult?.timed_out === true;
}

function evidenceFailed(record: Record<string, unknown>): boolean {
  const verifier = recordValue(record.verifier);
  const commandResult = recordValue(record.command_result);
  const executionEvidence = recordValue(record.execution_evidence_v1);
  const explicitPassed =
    booleanValue(record.passed)
    ?? booleanValue(record.verifier_passed)
    ?? booleanValue(verifier?.passed)
    ?? booleanValue(verifier?.success)
    ?? booleanValue(commandResult?.success)
    ?? booleanValue(executionEvidence?.validation_passed)
    ?? booleanValue(record.validation_passed);
  if (explicitPassed === false) return true;
  if (evidenceTimedOut(record)) return true;
  const exitCode =
    typeof record.exit_code === "number" ? record.exit_code
    : typeof verifier?.exit_code === "number" ? verifier.exit_code
    : typeof commandResult?.exit_code === "number" ? commandResult.exit_code
    : null;
  return exitCode !== null && exitCode !== 0;
}

function normalizeVerifierPath(value: string): string | null {
  const trimmed = value.trim();
  if (/^(?:at\s+)?(?:async\s+)?file:\/\//i.test(trimmed)) return null;
  if (/^(?:at\s+)?(?:async\s+)?\/.+/i.test(trimmed)) return null;
  if (!trimmed || trimmed.startsWith("node:") || trimmed.startsWith("<")) return null;
  if (/^(?:at|file|line|error)$/i.test(trimmed)) return null;
  return trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
}

function collectFileHintsFromOutput(output: string): RuntimeVerificationRepairFileHint[] {
  const hints: RuntimeVerificationRepairFileHint[] = [];
  const seen = new Set<string>();
  const sourceFilePattern = "[A-Za-z0-9_./-]+\\.(?:[cm]?[jt]sx?|d\\.ts)";
  const addHint = (pathRaw: string, lineRaw: string, columnRaw: string | null, messageRaw: string | null) => {
    const path = normalizeVerifierPath(pathRaw);
    if (!path) return;
    const line = Number(lineRaw);
    const column = columnRaw ? Number(columnRaw) : null;
    if (!Number.isFinite(line) || line <= 0) return;
    const message = messageRaw?.trim().slice(0, 800) || null;
    const key = `${path}:${line}:${column ?? ""}:${message ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({
      path,
      line: Math.floor(line),
      column: column && Number.isFinite(column) && column > 0 ? Math.floor(column) : null,
      message,
    });
  };
  for (const match of output.matchAll(new RegExp(`^\\s*(${sourceFilePattern}):(\\d+):(\\d+)[^\\S\\r\\n]+(.+)$`, "gm"))) {
    addHint(match[1] ?? "", match[2] ?? "", match[3] ?? null, match[4] ?? null);
  }
  for (const match of output.matchAll(new RegExp(`^\\s*(${sourceFilePattern})\\((\\d+),(\\d+)\\):[^\\S\\r\\n]+(.+)$`, "gm"))) {
    addHint(match[1] ?? "", match[2] ?? "", match[3] ?? null, match[4] ?? null);
  }

  let currentDiagnosticFile: string | null = null;
  const standaloneHeaders: Array<{ path: string; line: string; column: string | null }> = [];
  const headerPattern = new RegExp(`^\\s*(${sourceFilePattern}):(\\d+)(?::(\\d+))?\\s*$`);
  const diagnosticPattern = /^\s*([✖⚠])?\s*(\d+):(\d+)[^\S\r\n]+(.+)$/u;
  for (const line of output.split(/\r?\n/)) {
    const headerMatch = line.match(headerPattern);
    if (headerMatch) {
      const path = normalizeVerifierPath(headerMatch[1] ?? "");
      if (path) {
        currentDiagnosticFile = path;
        standaloneHeaders.push({
          path,
          line: headerMatch[2] ?? "",
          column: headerMatch[3] ?? null,
        });
      }
      continue;
    }
    const diagnosticMatch = line.match(diagnosticPattern);
    if (diagnosticMatch && currentDiagnosticFile) {
      const marker = diagnosticMatch[1] ? `${diagnosticMatch[1]}  ` : "";
      addHint(
        currentDiagnosticFile,
        diagnosticMatch[2] ?? "",
        diagnosticMatch[3] ?? null,
        `${marker}${diagnosticMatch[4] ?? ""}`,
      );
    }
  }
  for (const header of standaloneHeaders) {
    const alreadyCovered = hints.some((hint) => hint.path === header.path && hint.line === Number(header.line));
    if (!alreadyCovered) addHint(header.path, header.line, header.column, null);
  }
  return hints
    .map((hint, index) => ({ hint, index }))
    .sort((left, right) => {
      const leftMessage = left.hint.message ?? "";
      const rightMessage = right.hint.message ?? "";
      const leftRank = leftMessage.startsWith("⚠") || /\bwarning\b/i.test(leftMessage) ? 1 : 0;
      const rightRank = rightMessage.startsWith("⚠") || /\bwarning\b/i.test(rightMessage) ? 1 : 0;
      return leftRank - rightRank || left.index - right.index;
    })
    .map((entry) => entry.hint)
    .slice(0, 64);
}

function collectFailureCategories(args: {
  output: string;
  timedOut: boolean;
  toolSchemaHints: string[];
}): string[] {
  const lower = args.output.toLowerCase();
  return uniqueStrings([
    args.timedOut ? "verifier_timeout" : null,
    args.toolSchemaHints.length > 0 ? "tool_schema_input_error" : null,
    /expected indentation|indentation|xo|eslint|prettier/.test(lower) ? "lint_or_format_failure" : null,
    /tsd|expecttype|typescript|type error|\.d\.ts/.test(lower) ? "type_contract_failure" : null,
    /assertionerror|not equal|expected .* actual|strict equal|test failed/.test(lower) ? "assertion_failure" : null,
    /aborterror|unhandledrejection|assert\.rejects|promise/.test(lower) ? "async_rejection_handling" : null,
    /ava|t\.throwsasync|promise rejected with exception that is not an error/.test(lower) ? "test_assertion_contract_failure" : null,
    /async|promise|iterator|iterable|stream|yielded/.test(lower) ? "async_contract_failure" : null,
    /cannot find module|module not found|enoent/.test(lower) ? "environment_or_dependency_failure" : null,
    "verifier_failure",
  ].filter((value): value is string => !!value), 32);
}

function collectToolSchemaHints(record: Record<string, unknown>): string[] {
  const failedCalls = Array.isArray(record.failed_tool_calls) ? record.failed_tool_calls : [];
  const hints: string[] = [];
  for (const call of failedCalls) {
    const entry = recordValue(call);
    if (!entry) continue;
    const toolName = stringValue(entry.tool_name) ?? stringValue(entry.action);
    const input = recordValue(entry.tool_input) ?? recordValue(entry.input);
    const output = recordValue(entry.output_signature) ?? recordValue(entry.output);
    const error = stringValue(entry.error) ?? stringValue(output?.error) ?? "";
    if (toolName === "read_file" && (input?.file_path || /read_file\.input\.path|input\.path|required/i.test(error))) {
      hints.push("For read_file, pass the target as input.path; do not use input.file_path.");
    }
    if (toolName === "replace_text" && /replace_text\.input\.path|input\.path|required/i.test(error)) {
      hints.push("For replace_text, pass input.path together with exact find/replace text.");
    }
  }
  return uniqueStrings(hints, 32);
}

function collectEvidenceCategoryHints(record: Record<string, unknown>): string[] {
  const metrics = recordValue(record.metrics);
  return uniqueStrings([
    ...safeStringArray(record.failure_categories),
    ...safeStringArray(metrics?.failure_categories),
  ], 64);
}

function collectProviderFailureHints(record: Record<string, unknown>): string[] {
  const metrics = recordValue(record.metrics);
  const failedCalls = Array.isArray(record.failed_tool_calls) ? record.failed_tool_calls : [];
  const hints: string[] = [];
  if (typeof metrics?.llm_api_error_count === "number" && metrics.llm_api_error_count > 0) {
    hints.push("Provider/API failure was recorded in run metrics; do not treat it as code behavior evidence.");
  }
  for (const call of failedCalls) {
    const entry = recordValue(call);
    if (!entry) continue;
    const output = recordValue(entry.output_signature) ?? recordValue(entry.output);
    const apiError = stringValue(output?.llm_api_error) ?? stringValue(output?.provider_error);
    if (apiError) hints.push(apiError.slice(0, 400));
  }
  for (const category of collectEvidenceCategoryHints(record)) {
    if (/llm_api_error|provider|rate_limit|429|timeout/i.test(category)) {
      hints.push("Provider/API failure was present in prior execution categories.");
    }
  }
  return uniqueStrings(hints, 16);
}

function normalizeEditFailureTool(value: unknown): RuntimeEditFailureEvent["tool"] | null {
  const raw = stringValue(value);
  if (raw === "replace_text" || raw === "replace_lines" || raw === "apply_patch") return raw;
  return null;
}

function positiveIntegerValue(value: unknown): number | null {
  const next = numberValue(value);
  if (next === null || next <= 0) return null;
  return Math.floor(next);
}

function firstFileHintFromText(text: string): RuntimeVerificationRepairFileHint | null {
  const sourceFilePattern = /\b([A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|d\.ts))(?::|\()(\d+)(?::|,)?(\d+)?/;
  const match = text.match(sourceFilePattern);
  if (!match) return null;
  const path = normalizeVerifierPath(match[1] ?? "");
  const line = Number(match[2]);
  const column = match[3] ? Number(match[3]) : null;
  if (!path || !Number.isFinite(line) || line <= 0) return null;
  return {
    path,
    line: Math.floor(line),
    column: column && Number.isFinite(column) && column > 0 ? Math.floor(column) : null,
    message: truncateContractText(text, 800),
  };
}

function classifyEditFailureEvent(args: {
  tool: RuntimeEditFailureEvent["tool"];
  evidenceText: string;
  output: Record<string, unknown> | null;
}): RuntimeEditFailureEvent["phase"] {
  const lower = args.evidenceText.toLowerCase();
  if (/edit boundary|outside allowed|forbidden edit|write policy|policy block|edit_policy_block/.test(lower)) {
    return "edit_policy_block";
  }
  if (
    args.tool === "replace_lines"
    && (
      args.output?.expected_old_lines_match === false
      || /expected_old_lines.*(?:did not match|mismatch)|stale_line_anchor|current_anchor_required|line anchor/.test(lower)
    )
  ) {
    return "stale_line_anchor";
  }
  if (args.output?.edit_unchanged === true || /unchanged|no changes|identical replacement/.test(lower)) {
    return "unchanged_edit";
  }
  if (
    args.tool === "replace_text"
    && /expected\s+\d+\s+replacement|found\s+\d+|find text|anchor|current_anchor_required|not found/.test(lower)
  ) {
    return "replace_text_anchor_failure";
  }
  if (
    args.tool === "replace_lines"
    && /payload|range|start_line|end_line|too large|multiple ranges|compact|expected_old_lines/.test(lower)
  ) {
    return "replace_lines_payload_failure";
  }
  if (
    args.tool === "apply_patch"
    && /patch failed|does not apply|malformed|corrupt|hunk|payload|current_anchor_required|context/.test(lower)
  ) {
    return "apply_patch_payload_failure";
  }
  if (/schema|input\.path|required|invalid tool input|missing required/.test(lower)) {
    return "edit_tool_schema_failure";
  }
  return "edit_operation_failure";
}

function collectEditOperationFailureEvents(record: Record<string, unknown>): RuntimeEditFailureEvent[] {
  const failedCalls = Array.isArray(record.failed_tool_calls) ? record.failed_tool_calls : [];
  const events: RuntimeEditFailureEvent[] = [];
  for (const call of failedCalls) {
    const entry = recordValue(call);
    if (!entry) continue;
    const tool = normalizeEditFailureTool(entry.tool_name) ?? normalizeEditFailureTool(entry.action);
    if (!tool) continue;
    const input = recordValue(entry.tool_input) ?? recordValue(entry.input);
    const output = recordValue(entry.output_signature) ?? recordValue(entry.output);
    const nextAction = recordValue(output?.edit_operation_next_action);
    const sequenceNextAction = recordValue(output?.sequence_policy_next_action);
    const error = firstNonEmptyString(
      stringValue(output?.error),
      stringValue(entry.error),
      stringValue(output?.message),
    );
    const nextInstruction = firstNonEmptyString(
      stringValue(nextAction?.instruction),
      stringValue(sequenceNextAction?.instruction),
    );
    const nextReason = firstNonEmptyString(
      stringValue(nextAction?.reason),
      stringValue(sequenceNextAction?.reason),
    );
    const categoryText = collectEvidenceCategoryHints(record).join("\n");
    const evidenceText = [
      tool,
      error,
      nextInstruction,
      nextReason,
      categoryText,
      output?.expected_old_lines_match === false ? "expected_old_lines_match=false" : null,
      output?.edit_unchanged === true ? "edit_unchanged=true" : null,
    ].filter((value): value is string => !!value).join("\n");
    const textHint = firstFileHintFromText(evidenceText);
    const rawPath = firstNonEmptyString(
      stringValue(input?.path),
      stringValue(input?.file_path),
      stringValue(input?.target_path),
      stringValue(output?.path),
      textHint?.path,
    );
    const path = rawPath ? normalizeVerifierPath(rawPath) ?? rawPath.replace(/\\/g, "/").replace(/^\.\//, "") : null;
    const line = positiveIntegerValue(input?.start_line)
      ?? positiveIntegerValue(input?.line)
      ?? positiveIntegerValue(output?.line)
      ?? textHint?.line
      ?? null;
    const column = positiveIntegerValue(input?.column) ?? textHint?.column ?? null;
    const endLine = positiveIntegerValue(input?.end_line) ?? null;
    events.push({
      tool,
      phase: classifyEditFailureEvent({ tool, evidenceText, output }),
      path,
      line,
      column,
      endLine,
      message: error ? truncateContractText(error, 360) : null,
      nextInstruction,
      nextReason,
      evidenceText,
    });
  }
  return events;
}

function collectEditOperationFailureHints(record: Record<string, unknown>): string[] {
  const editFailureEvents = collectEditOperationFailureEvents(record);
  const hints: string[] = [];
  for (const event of editFailureEvents) {
    hints.push(event.message ? `${event.tool}: ${event.message}` : `${event.tool} failed; reread the target lines before editing again.`);
    if (event.nextInstruction) hints.push(event.nextInstruction);
    if (event.nextReason) hints.push(`edit operation next action: ${event.nextReason}`);
    if (event.phase === "stale_line_anchor") {
      hints.push("replace_lines expected_old_lines did not match current content; read the current target range and retry with expected_old_lines from the latest read_file output.");
    }
  }
  for (const category of collectEvidenceCategoryHints(record)) {
    if (/replace_lines_failure|replace_text_failure|apply_patch_failure|edit_operation|stale_line_anchor_failure/i.test(category)) {
      hints.push("Prior edit operation failed; reread the exact target range before another write.");
    }
  }
  return uniqueStrings(hints, 16);
}

function collectSourceAssertionHints(output: string): string[] {
  const hints: string[] = [];
  const assertionLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => (
      /AssertionError|assert|expected|actual|must|should|required|contract|verifier/i.test(line)
      && !/node_modules|internal\/modules|ModuleJob\.run|asyncRunEntryPoint/i.test(line)
    ))
    .slice(0, 4);
  for (const line of assertionLines) {
    hints.push(`Verifier assertion evidence: ${truncateContractText(line, 260)}`);
  }
  if (/source_contract_failure|hidden verifier|hidden contract|AssertionError/i.test(output)) {
    hints.push("Treat verifier assertion text as scoped acceptance evidence. Prefer repairing verifier-named implementation files unless the phase classifier selects an authored-test failure.");
  }
  if (/test(?:s|ing)?[\s\S]{0,120}(?:must|should|required|coverage)|coverage[\s\S]{0,120}(?:must|should|required)/i.test(output)) {
    hints.push("If the verifier names a test or type-test contract, use the failure phase and allowed files to decide whether the next edit belongs in tests or implementation; do not promote this as a project-specific rule.");
  }
  if (/replace_lines_current_anchor_required|stale_line_anchor_failure|expected_old_lines did not match current file content/i.test(output)) {
    hints.push("Before retrying a failed replace_lines edit, read the current target range and copy expected_old_lines from the latest read_file output instead of reusing stale line anchors.");
  }
  if (/TS\d{4}|TypeScript|No overload matches this call|is declared but its value is never read|Cannot find name|possibly undefined/i.test(output)) {
    hints.push("Treat TypeScript diagnostics as line-scoped compile evidence. Repair the reported call site, import, declaration, or narrowing before continuing hidden-contract edits.");
  }
  return uniqueStrings(hints, 16);
}

function collectFileHintsFromSourceAssertionHints(hints: string[]): RuntimeVerificationRepairFileHint[] {
  const out: RuntimeVerificationRepairFileHint[] = [];
  const seen = new Set<string>();
  const sourceFilePattern = /\b([A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?|d\.ts))\b/g;
  for (const hint of hints) {
    for (const match of hint.matchAll(sourceFilePattern)) {
      const path = normalizeVerifierPath(match[1] ?? "");
      if (!path) continue;
      const key = `${path}:${hint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path,
        line: null,
        column: null,
        message: hint,
      });
    }
  }
  return out;
}

function collectRuntimeVerificationFailureSignals(executionEvidence: unknown): RuntimeVerificationFailureSignal[] {
  return safeRecordArray(executionEvidence)
    .filter(evidenceFailed)
    .map((record) => {
      const output = evidenceOutputText(record);
      const timedOut = evidenceTimedOut(record);
      const toolSchemaHints = collectToolSchemaHints(record);
      const providerFailureHints = collectProviderFailureHints(record);
      const editFailureEvents = collectEditOperationFailureEvents(record);
      const editOperationFailureHints = collectEditOperationFailureHints(record);
      const evidenceCategoryHints = collectEvidenceCategoryHints(record);
      const sourceAssertionHints = collectSourceAssertionHints(output);
      return {
        command: commandFromEvidence(record),
        output,
        timedOut,
        fileHints: uniqueFileHints([
          ...collectFileHintsFromOutput(output),
          ...collectFileHintsFromSourceAssertionHints(sourceAssertionHints),
        ]),
        categories: uniqueStrings([
          collectFailureCategories({ output, timedOut, toolSchemaHints }),
          evidenceCategoryHints,
          providerFailureHints.length > 0 ? "provider_failure" : null,
          editOperationFailureHints.length > 0 ? "edit_operation_failure" : null,
        ].flat().filter((value): value is string => !!value), 64),
        toolSchemaHints,
        providerFailureHints,
        editOperationFailureHints,
        editFailureEvents,
      };
    });
}

function sourceAssertionHintsTargetAuthoredTests(hints: string[]): boolean {
  return hints.some((hint) => /(?:^|\b)(?:test\.js|index\.test-d\.ts|tests\/|\.test\.[cm]?[jt]sx?)/i.test(hint));
}

function hasVerificationFailureEvidence(executionEvidence: unknown): boolean {
  return collectRuntimeVerificationFailureSignals(executionEvidence).length > 0;
}

function uniqueFileHints(hints: RuntimeVerificationRepairFileHint[], limit = 64): RuntimeVerificationRepairFileHint[] {
  const out: RuntimeVerificationRepairFileHint[] = [];
  const seen = new Set<string>();
  for (const hint of hints) {
    const key = `${hint.path}:${hint.line ?? ""}:${hint.column ?? ""}:${hint.message ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hint);
    if (out.length >= limit) break;
  }
  return out;
}

function fileHintLabel(hint: RuntimeVerificationRepairFileHint): string {
  return `${hint.path}${hint.line ? `:${hint.line}${hint.column ? `:${hint.column}` : ""}` : ""}`;
}

function fileAllowedByEditBoundary(path: string, editBoundary: Required<RuntimeEditBoundaryContext>): boolean {
  if (editBoundary.forbidden_edit_files.includes(path)) return false;
  if (editBoundary.allowed_edit_files.length === 0) return true;
  return editBoundary.allowed_edit_files.includes(path);
}

function filesMentionedInText(text: string, files: string[]): string[] {
  return files.filter((file) => text.includes(file));
}

function implementationFiles(files: string[]): string[] {
  return files.filter((file) => /\.(?:[cm]?js|ts|tsx)$/.test(file) && !/\.d\.ts$|test/i.test(file));
}

function testFiles(files: string[]): string[] {
  return files.filter((file) => /(?:^|\/)test\.[cm]?js$|\.test\.[cm]?[jt]sx?$|test-d\.ts$/i.test(file));
}

function typeFiles(files: string[]): string[] {
  return files.filter((file) => /\.d\.ts$|test-d\.ts$/i.test(file));
}

function packageManifestFiles(files: string[]): string[] {
  return files.filter((file) => /(?:^|\/)package\.json$/i.test(file));
}

function phaseFiles(args: {
  phase: RuntimeVerifierFailurePhase["phase"];
  outputText: string;
  affectedFiles: RuntimeVerificationRepairFileHint[];
  editBoundary: Required<RuntimeEditBoundaryContext>;
}): string[] {
  const allowed = args.editBoundary.allowed_edit_files;
  const hintFiles = uniqueStrings(args.affectedFiles.map((hint) => hint.path), 16);
  const mentionedAllowed = filesMentionedInText(args.outputText, allowed);
  if (args.phase === "provider_failure" || args.phase === "tool_protocol_failure") return [];
  if (args.phase === "lint_type_failure") {
    return uniqueStrings([
      hintFiles,
      typeFiles(allowed).filter((file) => args.outputText.includes(file)),
      mentionedAllowed,
    ].flat(), 16);
  }
  if (args.phase === "authored_test_failure") {
    return uniqueStrings([
      hintFiles,
      testFiles(allowed).filter((file) => mentionedAllowed.includes(file)),
      implementationFiles(allowed).slice(0, 2),
    ].flat(), 16);
  }
  if (args.phase === "hidden_contract_failure") {
    const mentionedImplementation = implementationFiles(mentionedAllowed);
    const hintedImplementation = implementationFiles(hintFiles);
    const mentionedPackage = packageManifestFiles(mentionedAllowed);
    const packageContract = mentionedPackage.length > 0 && /package\.json|package manifest|dependency|runtime dependency/i.test(args.outputText);
    return uniqueStrings([
      hintedImplementation,
      mentionedImplementation,
      implementationFiles(allowed).slice(0, 2),
      packageContract ? mentionedPackage : [],
    ].flat(), 16);
  }
  return uniqueStrings([hintFiles, mentionedAllowed, implementationFiles(allowed).slice(0, 2)].flat(), 16);
}

function buildPhaseRecommendedFocus(args: {
  phase: RuntimeVerifierFailurePhase["phase"];
  files: string[];
  lineHints: RuntimeVerificationRepairFileHint[];
  command: string | null;
  reason: string;
}): string {
  const firstHint = args.lineHints[0] ?? null;
  const lineTarget = firstHint
    ? `${firstHint.path}${firstHint.line ? `:${firstHint.line}${firstHint.column ? `:${firstHint.column}` : ""}` : ""}`
    : null;
  const fileList = args.files.length > 0 ? args.files.join(", ") : "the verifier-reported target file";
  if (args.phase === "provider_failure") {
    return "Do not edit code from provider/API failure evidence; retry the provider call or request operator review before learning from this run.";
  }
  if (args.phase === "tool_protocol_failure") {
    return "Repair the LLM/tool protocol first: retry with a strict JSON tool contract or correct the tool call shape; do not change repository code because of protocol evidence alone.";
  }
  if (args.phase === "edit_operation_failure") {
    return `Reread ${lineTarget ?? fileList} before another write, then apply one localized edit and rerun the failed verifier.`;
  }
  if (args.phase === "lint_type_failure") {
    return `Read ${lineTarget ?? fileList}, fix only the reported lint/type contract location, then rerun ${args.command ?? "the failed verifier"}.`;
  }
  if (args.phase === "authored_test_failure") {
    return `Read ${lineTarget ?? fileList}; verify whether the self-authored test matches the task contract before changing implementation, then rerun ${args.command ?? "the failed verifier"}.`;
  }
  if (args.phase === "hidden_contract_failure") {
    return `Repair the hidden verifier contract in ${fileList}; start from ${lineTarget ?? args.files[0] ?? "the implementation file"} and rerun ${args.command ?? "the failed verifier"}.`;
  }
  if (args.phase === "environment_failure") {
    return `Resolve the environment/dependency verifier failure before changing behavior, then rerun ${args.command ?? "the failed verifier"}.`;
  }
  return `Use verifier evidence to repair ${fileList}, then rerun ${args.command ?? "the failed verifier"}.`;
}

function editFailureLineTarget(args: {
  primaryFile: string | null;
  lineHints: RuntimeVerificationRepairFileHint[];
}): string {
  const firstHint = args.lineHints[0] ?? null;
  if (firstHint) {
    return `${firstHint.path}${firstHint.line ? `:${firstHint.line}${firstHint.column ? `:${firstHint.column}` : ""}` : ""}`;
  }
  return args.primaryFile ?? "the failed edit target";
}

function editFailureAllowedActions(phase: RuntimeEditFailurePhase["phase"]): RuntimeEditFailurePhase["allowed_next_actions"] {
  if (phase === "edit_policy_block") return ["read_file", "request_operator_review"];
  if (phase === "stale_line_anchor") return ["read_file", "replace_lines", "request_operator_review"];
  if (phase === "replace_text_anchor_failure") return ["read_file", "replace_text", "replace_lines", "request_operator_review"];
  if (phase === "apply_patch_payload_failure") return ["read_file", "replace_lines", "apply_patch", "request_operator_review"];
  if (phase === "replace_lines_payload_failure") return ["read_file", "replace_lines", "apply_patch", "request_operator_review"];
  return ["read_file", "replace_text", "replace_lines", "apply_patch", "request_operator_review"];
}

function editFailureForbiddenActions(phase: RuntimeEditFailurePhase["phase"]): RuntimeEditFailurePhase["forbidden_next_actions"] {
  return uniqueStrings([
    "list_files",
    "search",
    "edit_unrelated_files",
    "run_unrelated_command",
    "persist_learning",
    phase === "stale_line_anchor" || phase === "replace_text_anchor_failure" ? "reuse_stale_anchor" : null,
    phase === "stale_line_anchor" || phase === "unchanged_edit" || phase === "replace_text_anchor_failure" || phase === "replace_lines_payload_failure"
      ? "repeat_same_edit"
      : null,
    phase === "apply_patch_payload_failure" ? "repeat_same_patch" : null,
  ].filter((value): value is RuntimeEditFailurePhase["forbidden_next_actions"][number] => !!value), 16) as RuntimeEditFailurePhase["forbidden_next_actions"];
}

function buildEditFailureRecommendedFocus(args: {
  phase: RuntimeEditFailurePhase["phase"];
  primaryFile: string | null;
  lineHints: RuntimeVerificationRepairFileHint[];
  sourceTool: RuntimeEditFailurePhase["source_tool"];
}): string {
  const target = editFailureLineTarget({ primaryFile: args.primaryFile, lineHints: args.lineHints });
  if (args.phase === "stale_line_anchor") {
    return `Read ${target} from current file state, copy expected_old_lines from the latest read_file output, then make one compact replace_lines edit on the same span.`;
  }
  if (args.phase === "unchanged_edit") {
    return `Do not repeat the identical replacement on ${target}; make one localized meaningful semantic edit or stop editing until current evidence proves a required change.`;
  }
  if (args.phase === "apply_patch_payload_failure") {
    return `Read the current span around ${target}, then use compact replace_lines or one small apply_patch hunk that matches current context exactly.`;
  }
  if (args.phase === "replace_text_anchor_failure") {
    return `Read the current section around ${target}, then use exact current find text or switch to one compact replace_lines span.`;
  }
  if (args.phase === "replace_lines_payload_failure") {
    return `Retry ${target} with one compact contiguous replace_lines span; do not send whole functions, whole files, or multiple ranges in one edit.`;
  }
  if (args.phase === "edit_policy_block") {
    return `Obey the edit boundary before writing ${target}; do not write outside allowed files or continue with unrelated edits.`;
  }
  if (args.phase === "edit_tool_schema_failure") {
    return `Retry ${args.sourceTool} with the valid tool input shape for ${target}; do not change repository code from schema failure evidence alone.`;
  }
  return `Read ${target} from current file state, then retry with one localized edit and rerun the failed verifier.`;
}

function editFailureEventFileHint(event: RuntimeEditFailureEvent): RuntimeVerificationRepairFileHint | null {
  if (!event.path) return null;
  return {
    path: event.path,
    line: event.line,
    column: event.column,
    message: event.message ?? event.nextInstruction ?? event.nextReason ?? `${event.tool} failed`,
  };
}

function classifyEditFailurePhase(args: {
  signals: RuntimeVerificationFailureSignal[];
  editBoundary: Required<RuntimeEditBoundaryContext>;
}): RuntimeEditFailurePhase | null {
  const events = args.signals.flatMap((signal) => signal.editFailureEvents);
  const latest = events.at(-1) ?? null;
  if (!latest) return null;
  const samePhaseEvents = events.filter((event) => event.phase === latest.phase);
  const lineHints = uniqueFileHints(
    samePhaseEvents
      .map(editFailureEventFileHint)
      .filter((hint): hint is RuntimeVerificationRepairFileHint => !!hint)
      .filter((hint) => fileAllowedByEditBoundary(hint.path, args.editBoundary)),
    32,
  );
  const latestPathAllowed = latest.path ? fileAllowedByEditBoundary(latest.path, args.editBoundary) : false;
  const primaryFile = latestPathAllowed
    ? latest.path
    : lineHints[0]?.path ?? null;
  return {
    summary_version: "edit_failure_phase_v1",
    phase: latest.phase,
    confidence: latest.phase === "edit_operation_failure" ? 0.72 : 0.9,
    source_tool: latest.tool,
    failure_count: samePhaseEvents.length,
    primary_file: primaryFile,
    line_hints: lineHints,
    allowed_next_actions: editFailureAllowedActions(latest.phase),
    forbidden_next_actions: editFailureForbiddenActions(latest.phase),
    recommended_focus: buildEditFailureRecommendedFocus({
      phase: latest.phase,
      primaryFile,
      lineHints,
      sourceTool: latest.tool,
    }),
    evidence_summary: truncateContractText(
      [
        `${latest.tool} produced ${latest.phase}`,
        latest.message,
        latest.nextReason,
        latest.nextInstruction,
      ].filter((value): value is string => !!value).join("; "),
      800,
    ),
  };
}

function classifyVerifierFailurePhase(args: {
  signals: RuntimeVerificationFailureSignal[];
  categories: string[];
  affectedFiles: RuntimeVerificationRepairFileHint[];
  failedCommands: string[];
  sourceAssertionHints: string[];
  failedToolSchemaHints: string[];
  editBoundary: Required<RuntimeEditBoundaryContext>;
}): RuntimeVerifierFailurePhase {
  const outputText = args.signals.map((signal) => signal.output).join("\n");
  const combined = [
    outputText,
    args.categories.join("\n"),
    args.sourceAssertionHints.join("\n"),
    args.failedToolSchemaHints.join("\n"),
    args.signals.flatMap((signal) => signal.providerFailureHints).join("\n"),
    args.signals.flatMap((signal) => signal.editOperationFailureHints).join("\n"),
  ].join("\n");
  const lower = combined.toLowerCase();
  const hasProviderFailure = args.categories.includes("provider_failure") || /llm_api_error|provider\/api|rate limit|429/.test(lower);
  const hasNonProviderVerifierEvidence = args.categories.some((category) => (
    category !== "provider_failure"
    && category !== "llm_api_error"
    && category !== "llm_call_failure"
    && category !== "llm_protocol_error"
    && category !== "llm_protocol_fatal"
    && category !== "tool_protocol_failure"
    && category !== "verifier_failure"
  ));
  const hasToolProtocol = args.failedToolSchemaHints.length > 0
    || /tool_schema|schema_correction|input\.path|required|tool_protocol_failure|llm_protocol_error|llm_protocol_fatal|llm_protocol_exhausted|invalid_assistant_response_discarded|did not return a valid tool JSON object|Return one raw JSON object/i.test(combined);
  const hasEditOperation = args.categories.includes("edit_operation_failure") || /replace_lines_failure|replace_text_failure|apply_patch_failure/.test(lower);
  const hasLintType = args.categories.some((category) => /lint_or_format|type_contract/.test(category))
    || /xo|eslint|prettier|tsd|typescript|expecttype|\.d\.ts|\berror\s+ts\d{4}\b|no-undef-init|padding-line-between-statements/.test(lower);
  const hasHiddenContract = args.sourceAssertionHints.length > 0
    || args.categories.some((category) => /source_contract|async_contract|async_rejection/.test(category));
  const hasAuthoredTest = /(?:^|\n)\s*(?:›\s*)?(?:file:\/\/)?test\.[cm]?js:\d+|test\.js:\d+|ava|t\.throwsAsync|test failed/i.test(combined)
    && !hasHiddenContract;
  const hasEnvironment = args.categories.includes("environment_or_dependency_failure")
    || /cannot find module|module not found|enoent|npm install|dependency/.test(lower);
  const latestSignal = args.signals.at(-1) ?? null;
  const latestSourceAssertionHints = latestSignal ? collectSourceAssertionHints(latestSignal.output) : [];
  const latestCategories = latestSignal
    ? uniqueStrings([
      ...latestSignal.categories,
      latestSourceAssertionHints.length > 0 ? "source_contract_failure" : null,
    ].filter((value): value is string => !!value), 32)
    : [];
  const latestCombined = latestSignal
    ? [
      latestSignal.output,
      latestCategories.join("\n"),
      latestSourceAssertionHints.join("\n"),
      latestSignal.toolSchemaHints.join("\n"),
      latestSignal.providerFailureHints.join("\n"),
      latestSignal.editOperationFailureHints.join("\n"),
    ].join("\n")
    : "";
  const latestLower = latestCombined.toLowerCase();
  const latestHasProviderFailure = latestCategories.includes("provider_failure")
    || /llm_api_error|provider\/api|rate limit|429/.test(latestLower);
  const latestHasNonProviderVerifierEvidence = latestCategories.some((category) => (
    category !== "provider_failure"
    && category !== "llm_api_error"
    && category !== "llm_call_failure"
    && category !== "llm_protocol_error"
    && category !== "llm_protocol_fatal"
    && category !== "tool_protocol_failure"
    && category !== "verifier_failure"
  ));
  const latestHasToolProtocol = (latestSignal?.toolSchemaHints.length ?? 0) > 0
    || /tool_schema|schema_correction|input\.path|required|tool_protocol_failure|llm_protocol_error|llm_protocol_fatal|llm_protocol_exhausted|invalid_assistant_response_discarded|did not return a valid tool JSON object|Return one raw JSON object/i.test(latestCombined);
  const latestHasEditOperation = latestCategories.includes("edit_operation_failure")
    || /replace_lines_failure|replace_text_failure|apply_patch_failure/.test(latestLower);
  const latestHasLintType = latestCategories.some((category) => /lint_or_format|type_contract/.test(category))
    || /xo|eslint|prettier|tsd|typescript|expecttype|\.d\.ts|\berror\s+ts\d{4}\b|no-undef-init|padding-line-between-statements/.test(latestLower);
  const latestHasHiddenContract = latestSourceAssertionHints.length > 0
    || latestCategories.some((category) => /source_contract|async_contract|async_rejection/.test(category));
  const latestHasAuthoredTestContract = sourceAssertionHintsTargetAuthoredTests(latestSourceAssertionHints)
    || /(?:tests?\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?|index\.test-d\.ts|test\.js)\s+must\b|tests must (?:include|assert|preserve)/i.test(latestCombined);
  const latestHasAuthoredTest = /(?:^|\n)\s*(?:›\s*)?(?:file:\/\/)?test\.[cm]?js:\d+|test\.js:\d+|ava|t\.throwsAsync|test failed/i.test(latestCombined)
    && !latestHasHiddenContract;
  const latestHasEnvironment = latestCategories.includes("environment_or_dependency_failure")
    || /cannot find module|module not found|enoent|npm install|dependency/.test(latestLower);

  let phase: RuntimeVerifierFailurePhase["phase"] = "unknown_verifier_failure";
  let confidence = 0.55;
  let primaryReason = "Verifier failed but Runtime could not isolate a more specific phase.";
  let phaseOutputText = combined;
  let phaseAffectedFiles = args.affectedFiles;
  let phaseFailedCommand = args.failedCommands[0] ?? null;
  const useLatestSignal = () => {
    if (!latestSignal) return;
    phaseOutputText = latestCombined;
    phaseAffectedFiles = latestSignal.fileHints.filter((hint) => fileAllowedByEditBoundary(hint.path, args.editBoundary));
    phaseFailedCommand = latestSignal.command ?? phaseFailedCommand;
  };

  if (latestSignal && latestHasProviderFailure && !latestHasNonProviderVerifierEvidence) {
    phase = "provider_failure";
    confidence = 0.95;
    primaryReason = "Latest failed evidence is a provider/API failure without code verifier evidence.";
    useLatestSignal();
  } else if (latestSignal && latestHasToolProtocol && !latestHasNonProviderVerifierEvidence) {
    phase = "tool_protocol_failure";
    confidence = 0.9;
    primaryReason = "Latest failed evidence is a tool protocol/schema error before repository behavior was validated.";
    useLatestSignal();
  } else if (latestSignal && latestHasLintType) {
    phase = "lint_type_failure";
    confidence = 0.92;
    primaryReason = "Latest failed verifier evidence reports lint, formatter, TypeScript, or type-test contract failures.";
    useLatestSignal();
  } else if (latestSignal && latestHasAuthoredTestContract) {
    phase = "authored_test_failure";
    confidence = 0.88;
    primaryReason = "Latest failed verifier evidence points at self-authored test coverage or type-test contract output.";
    useLatestSignal();
  } else if (latestSignal && latestHasHiddenContract) {
    phase = "hidden_contract_failure";
    confidence = 0.9;
    primaryReason = "Latest failed verifier evidence points at a hidden/source contract assertion.";
    useLatestSignal();
  } else if (latestSignal && latestHasAuthoredTest) {
    phase = "authored_test_failure";
    confidence = 0.82;
    primaryReason = "Latest failed evidence points at self-authored runtime tests.";
    useLatestSignal();
  } else if (latestSignal && latestHasEditOperation) {
    phase = "edit_operation_failure";
    confidence = 0.78;
    primaryReason = "Latest failed evidence came from an edit operation.";
    useLatestSignal();
  } else if (latestSignal && latestHasEnvironment) {
    phase = "environment_failure";
    confidence = 0.82;
    primaryReason = "Latest failed evidence is an environment/dependency error.";
    useLatestSignal();
  } else if (hasProviderFailure && !hasNonProviderVerifierEvidence) {
    phase = "provider_failure";
    confidence = 0.95;
    primaryReason = "Provider/API failure is present without code verifier evidence.";
  } else if (hasToolProtocol && !hasNonProviderVerifierEvidence) {
    phase = "tool_protocol_failure";
    confidence = 0.9;
    primaryReason = "The failure is a tool protocol/schema error before repository behavior was validated.";
  } else if (hasLintType) {
    phase = "lint_type_failure";
    confidence = 0.92;
    primaryReason = "Verifier output reports lint, formatter, TypeScript, or type-test contract failures.";
  } else if (sourceAssertionHintsTargetAuthoredTests(args.sourceAssertionHints)) {
    phase = "authored_test_failure";
    confidence = 0.86;
    primaryReason = "Verifier assertions point at self-authored test coverage or type-test contract output.";
  } else if (hasHiddenContract) {
    phase = "hidden_contract_failure";
    confidence = 0.88;
    primaryReason = "Hidden verifier/source contract assertions are failing.";
  } else if (hasAuthoredTest) {
    phase = "authored_test_failure";
    confidence = 0.82;
    primaryReason = "The failing evidence points at self-authored runtime tests.";
  } else if (hasEditOperation) {
    phase = "edit_operation_failure";
    confidence = 0.78;
    primaryReason = "The prior attempt failed while applying an edit operation.";
  } else if (hasEnvironment) {
    phase = "environment_failure";
    confidence = 0.82;
    primaryReason = "The verifier failed before code behavior could be assessed because of environment/dependency errors.";
  }

  const lineHints = uniqueFileHints(phaseAffectedFiles, 32);
  const primaryFiles = phaseFiles({
    phase,
    outputText: phaseOutputText,
    affectedFiles: lineHints,
    editBoundary: args.editBoundary,
  });
  const failedCommand = phaseFailedCommand;
  const allowedNextActions: RuntimeVerifierFailurePhase["allowed_next_actions"] =
    phase === "provider_failure"
      ? ["request_operator_review", "run_command"]
      : phase === "tool_protocol_failure"
        ? ["read_file", "request_operator_review"]
        : ["read_file", "replace_text", "replace_lines", "apply_patch", "run_command"];
  const forbiddenNextActions = uniqueStrings([
    phase === "provider_failure" ? "persist_learning" : null,
    phase === "tool_protocol_failure" ? "persist_learning" : null,
    phase === "provider_failure" ? "edit_unrelated_files" : null,
    phase !== "provider_failure" ? "list_files" : null,
    phase !== "provider_failure" ? "search" : null,
    phase !== "provider_failure" ? "edit_unrelated_files" : null,
    phase === "hidden_contract_failure" ? "write_tests_only" : null,
    "run_unrelated_command",
  ].filter((value): value is RuntimeVerifierFailurePhase["forbidden_next_actions"][number] => !!value), 16) as RuntimeVerifierFailurePhase["forbidden_next_actions"];

  return {
    summary_version: "verifier_failure_phase_v1",
    phase,
    confidence,
    primary_reason: primaryReason,
    failing_command: failedCommand,
    primary_files: primaryFiles,
    line_hints: lineHints,
    allowed_next_actions: allowedNextActions,
    forbidden_next_actions: forbiddenNextActions,
    recommended_focus: buildPhaseRecommendedFocus({
      phase,
      files: primaryFiles,
      lineHints,
      command: failedCommand,
      reason: primaryReason,
    }),
  };
}

function buildRuntimeVerificationRepairRecommendation(args: {
  contractTrust: ContractTrust;
  executionEvidence?: unknown;
  editBoundaryContext?: RuntimeEditBoundaryContext | null;
}): RuntimeVerificationRepairRecommendation | null {
  const signals = collectRuntimeVerificationFailureSignals(args.executionEvidence);
  if (signals.length === 0) return null;
  const editBoundary = readEditBoundaryContext(args.editBoundaryContext);
  const failedCommands = boundedUniqueStrings(signals.map((signal) => signal.command).filter((value): value is string => !!value), 32, 800);
  const sourceAssertionHints = uniqueStrings(signals.flatMap((signal) => collectSourceAssertionHints(signal.output)), 32);
  const categories = uniqueStrings([
    ...signals.flatMap((signal) => signal.categories),
    sourceAssertionHints.length > 0 ? "source_contract_failure" : null,
  ].filter((value): value is string => !!value), 32);
  const affectedFiles = uniqueFileHints(
    signals
      .flatMap((signal) => signal.fileHints)
      .filter((hint) => fileAllowedByEditBoundary(hint.path, editBoundary)),
    64,
  );
  const failedToolSchemaHints = boundedUniqueStrings(signals.flatMap((signal) => signal.toolSchemaHints), 32, 400);
  const failurePhase = classifyVerifierFailurePhase({
    signals,
    categories,
    affectedFiles,
    failedCommands,
    sourceAssertionHints,
    failedToolSchemaHints,
    editBoundary,
  });
  const editFailurePhase = classifyEditFailurePhase({
    signals,
    editBoundary,
  });
  const phaseScopedSourceAssertionHints = (
    failurePhase.phase === "hidden_contract_failure" || failurePhase.phase === "authored_test_failure"
  )
    ? sourceAssertionHints
    : [];
  const affectedFileLabels = uniqueStrings(affectedFiles.map(fileHintLabel), 12);
  const formatterFiles = uniqueStrings(
    affectedFiles
      .map((hint) => hint.path)
      .filter((file) => /\.(?:[cm]?js|ts|tsx|d\.ts)$/.test(file)),
    24,
  );
  const nextActions = boundedUniqueStrings([
    editFailurePhase ? `Use edit_failure_phase_v1 as evidence focus: ${editFailurePhase.recommended_focus}` : null,
    `Use verifier_failure_phase_v1 as evidence focus: ${failurePhase.recommended_focus}`,
    ...failedToolSchemaHints,
    ...phaseScopedSourceAssertionHints,
    sourceAssertionHints.length > 0 && phaseScopedSourceAssertionHints.length === 0
      ? `Defer hidden/source contract edits until ${failurePhase.phase} is repaired and the failed verifier is rerun.`
      : null,
    failurePhase.primary_files.length > 0
      ? `Prefer phase primary_files before broad repair: ${failurePhase.primary_files.join(", ")}.`
      : null,
    failurePhase.line_hints.length > 0
      ? `Start at verifier line hint(s): ${failurePhase.line_hints.map(fileHintLabel).join(", ")}.`
      : null,
    affectedFileLabels.length > 0
      ? `Repair verifier-reported locations first: ${affectedFileLabels.join(", ")}.`
      : null,
    categories.includes("lint_or_format_failure") && formatterFiles.length > 0
      ? `If indentation errors remain after edits, run the project formatter on allowed affected files: npx xo --fix ${formatterFiles.join(" ")}.`
      : null,
    categories.includes("lint_or_format_failure")
      ? "For formatter/linter indentation failures, replace the complete enclosing block once with the repository's existing tab style instead of making repeated single-line tab edits."
      : null,
    categories.includes("type_contract_failure")
      ? "Update runtime behavior and public type/type-test surfaces together."
      : null,
    failedCommands.length > 0
      ? `Rerun failed verifier(s) before finishing: ${failedCommands.join(" | ")}.`
      : "Rerun the failed verifier before finishing.",
  ].filter((value): value is string => !!value), 32, 800);
  const instruction = truncateContractText(nextActions.join(" "), 2000);
  return {
    summary_version: "kickoff_verification_repair_v1",
    priority: "required",
    contract_trust: args.contractTrust,
    failed_verifier_count: signals.length,
    failed_commands: failedCommands,
    categories,
    affected_files: affectedFiles,
    verifier_failure_phase_v1: failurePhase,
    edit_failure_phase_v1: editFailurePhase,
    failed_tool_schema_hints: failedToolSchemaHints,
    next_actions: nextActions,
    reason: "Runtime found failed verifier/tool evidence from prior real execution and converted it into a concrete repair contract.",
    instruction,
  };
}

function prefixedContractNotes(args: {
  executionContract: ExecutionContractV1 | null;
  prefix: string;
  limit?: number;
}): string[] {
  const notes = args.executionContract?.provenance.notes ?? [];
  const prefix = `${args.prefix}:`;
  return uniqueStrings(
    notes
      .filter((note) => note.startsWith(prefix))
      .map((note) => note.slice(prefix.length).trim()),
    args.limit ?? 24,
  );
}

function buildRuntimeEditBoundaryRecommendation(args: {
  contractTrust: ContractTrust;
  filePath: string | null;
  executionContract: ExecutionContractV1 | null;
  editBoundaryContext?: RuntimeEditBoundaryContext | null;
}): RuntimeEditBoundaryRecommendation | null {
  const editBoundary = readEditBoundaryContext(args.editBoundaryContext);
  const contractTargetFiles =
    args.contractTrust === "observational"
      ? []
      : collectRuntimeFirstActionTargetFiles({
          executionContract: args.executionContract,
          filePath: args.filePath,
        });
  const allowedEditFiles = uniqueStrings([
    ...editBoundary.allowed_edit_files,
    ...prefixedContractNotes({
      executionContract: args.executionContract,
      prefix: "allowed_edit_file",
      limit: 24,
    }),
    ...contractTargetFiles,
  ], 64);
  const forbiddenEditFiles = uniqueStrings([
    ...editBoundary.forbidden_edit_files,
    ...prefixedContractNotes({
      executionContract: args.executionContract,
      prefix: "forbidden_edit_file",
      limit: 24,
    }),
  ], 64);
  const requiredVerifiers = uniqueStrings([
    ...editBoundary.required_verifiers,
    ...(args.contractTrust === "observational" ? [] : (args.executionContract?.outcome.acceptance_checks ?? [])),
    ...prefixedContractNotes({
      executionContract: args.executionContract,
      prefix: "required_verifier",
      limit: 24,
    }),
  ], 64);
  const learnedAntiShortcutRules = uniqueStrings([
    ...editBoundary.anti_shortcut_rules,
    ...prefixedContractNotes({
      executionContract: args.executionContract,
      prefix: "anti_shortcut_rule",
      limit: 24,
    }),
  ], 64);
  const hasEditBoundaryEvidence =
    allowedEditFiles.length > 0
    || forbiddenEditFiles.length > 0
    || requiredVerifiers.length > 0
    || learnedAntiShortcutRules.length > 0;
  const antiShortcutRules = uniqueStrings([
    ...learnedAntiShortcutRules,
    allowedEditFiles.length > 0
      ? "Only edit files in allowed_edit_files unless current file content or verifier output proves the boundary is wrong."
      : null,
    forbiddenEditFiles.length > 0 ? "Do not edit forbidden_edit_files." : null,
    requiredVerifiers.length > 0 ? "Run required_verifiers before declaring success." : null,
    hasEditBoundaryEvidence && args.contractTrust !== "authoritative"
      ? "Treat learned edit boundaries as advisory until current file content confirms them."
      : null,
  ], 64);

  if (
    allowedEditFiles.length === 0
    && forbiddenEditFiles.length === 0
    && requiredVerifiers.length === 0
    && antiShortcutRules.length === 0
  ) {
    return null;
  }

  const instructionParts = [
    allowedEditFiles.length > 0 ? `Restrict writes to: ${allowedEditFiles.join(", ")}.` : null,
    forbiddenEditFiles.length > 0 ? `Do not write: ${forbiddenEditFiles.join(", ")}.` : null,
    requiredVerifiers.length > 0 ? `Required verifier(s): ${requiredVerifiers.join(" | ")}.` : null,
  ].filter((value): value is string => !!value);

  return {
    summary_version: "kickoff_edit_boundary_v1",
    contract_trust: args.contractTrust,
    allowed_edit_files: allowedEditFiles,
    forbidden_edit_files: forbiddenEditFiles,
    required_verifiers: requiredVerifiers,
    anti_shortcut_rules: antiShortcutRules,
    reason:
      editBoundary.allowed_edit_files.length > 0
      || editBoundary.forbidden_edit_files.length > 0
      || editBoundary.required_verifiers.length > 0
      || editBoundary.anti_shortcut_rules.length > 0
        ? "Runtime combined the current edit-boundary context with learned execution memory."
        : "Runtime derived the edit boundary from learned execution memory.",
    instruction: instructionParts.length > 0
      ? instructionParts.join(" ")
      : "Use this edit boundary before widening the execution surface.",
  };
}

function buildRuntimeFirstActionRecommendation(args: {
  sourceKind: "experience_intelligence" | "tool_selection";
  historyApplied: boolean;
  contractTrust: ContractTrust;
  selectedTool: string | null;
  filePath: string | null;
  executionContract: ExecutionContractV1 | null;
  uncertainty: ActionRetrievalUncertaintySummary | null;
  preActionGate?: ActionIntelligencePreActionGateSummary | null;
  authorityBlocked: boolean;
  authorityPrimaryBlocker: string | null;
}): RuntimeFirstActionRecommendation | null {
  const targetFiles = collectRuntimeFirstActionTargetFiles({
    executionContract: args.executionContract,
    filePath: args.filePath,
  });
  const filePath = firstNonEmptyString(args.filePath, args.executionContract?.file_path, targetFiles[0] ?? null);
  const preActionGate = args.preActionGate ?? null;
  const gateAction = resolveEffectiveGateAction({
    preActionGate,
    uncertainty: args.uncertainty,
  });
  const learnedTool = firstNonEmptyString(args.selectedTool, args.executionContract?.selected_tool);

  if (args.authorityBlocked || preActionGate?.authority_blocked === true) {
    const blocker = args.authorityPrimaryBlocker ?? "authority evidence is insufficient";
    return {
      summary_version: "kickoff_first_action_v1",
      action: "request_operator_review",
      priority: "required",
      contract_trust: args.contractTrust,
      tool_name: null,
      learned_tool: learnedTool,
      file_path: filePath,
      target_files: targetFiles,
      reason: `Authoritative reuse is blocked because ${blocker}.`,
      instruction: learnedTool
        ? `Request operator review before reusing ${learnedTool}${filePath ? ` on ${filePath}` : ""}.`
        : "Request operator review before reusing learned execution memory.",
    };
  }

  if (gateAction === "request_operator_review" || gateAction === "rehydrate_payload") {
    return {
      summary_version: "kickoff_first_action_v1",
      action: gateAction,
      priority: "required",
      contract_trust: args.contractTrust,
      tool_name: gateAction,
      learned_tool: learnedTool,
      file_path: filePath,
      target_files: targetFiles,
      reason:
        gateAction === "request_operator_review"
          ? "Action retrieval requires operator review before committing to the learned execution path."
          : "Action retrieval requires payload rehydration before the learned execution path can be reused.",
      instruction:
        gateAction === "request_operator_review"
          ? (learnedTool
            ? `Request operator review before committing to ${learnedTool}${filePath ? ` on ${filePath}` : ""}.`
            : "Request operator review before committing to the next step.")
          : (filePath
            ? `Rehydrate the colder payload before reusing ${learnedTool ?? "the learned path"} on ${filePath}.`
            : "Rehydrate the colder payload before committing to the next step."),
    };
  }

  if (gateAction === "widen_recall") {
    return {
      summary_version: "kickoff_first_action_v1",
      action: "widen_recall",
      priority: "required",
      contract_trust: args.contractTrust,
      tool_name: "widen_recall",
      learned_tool: learnedTool,
      file_path: null,
      target_files: [],
      reason: preActionGate
        ? "Action intelligence pre-action gate does not have enough evidence to commit to one execution path."
        : "Action retrieval does not have enough evidence to commit to one execution path.",
      instruction: "Widen recall before committing to a file or tool.",
    };
  }

  if (filePath && args.contractTrust !== "observational") {
    const required =
      args.sourceKind === "experience_intelligence"
      && args.historyApplied;
    return {
      summary_version: "kickoff_first_action_v1",
      action: "read_file",
      priority: required ? "required" : "recommended",
      contract_trust: args.contractTrust,
      tool_name: "read_file",
      learned_tool: learnedTool,
      file_path: filePath,
      target_files: targetFiles.length > 0 ? targetFiles : [filePath],
      reason: required
        ? "Learned execution memory selected a concrete target file; inspect it before broad discovery."
        : "Execution memory selected a concrete target file; inspect it before broad discovery.",
      instruction: `Read ${filePath} before list/search discovery, then apply the learned path only if the file matches the task.`,
    };
  }

  if (gateAction === "inspect_context") {
    return {
      summary_version: "kickoff_first_action_v1",
      action: gateAction,
      priority: "recommended",
      contract_trust: args.contractTrust,
      tool_name: gateAction,
      learned_tool: learnedTool,
      file_path: null,
      target_files: [],
      reason:
        "Action intelligence pre-action gate asks the agent runtime to inspect current context before reusing memory.",
      instruction: "Inspect the current context before taking the next execution step.",
    };
  }

  if (learnedTool) {
    return {
      summary_version: "kickoff_first_action_v1",
      action: "inspect_context",
      priority: "recommended",
      contract_trust: args.contractTrust,
      tool_name: "inspect_context",
      learned_tool: learnedTool,
      file_path: null,
      target_files: [],
      reason: "A learned tool exists, but no concrete target file is available yet.",
      instruction: `Inspect the current context before starting with ${learnedTool}.`,
    };
  }

  return null;
}

function applyContractTrustGuard(args: {
  sourceKind: "experience_intelligence" | "tool_selection";
  historyApplied: boolean;
  explicitTrust: ContractTrust | null;
  selectedTool: string | null;
  taskFamily: string | null;
  workflowSignature: string | null;
  policyMemoryId: string | null;
  filePath: string | null;
  executionContract: ExecutionContractV1 | null;
  nextAction: string | null;
  uncertainty: ActionRetrievalUncertaintySummary | null;
  preActionGate?: ActionIntelligencePreActionGateSummary | null;
  authorityBlocked?: boolean;
  authorityPrimaryBlocker?: string | null;
  editBoundaryContext?: RuntimeEditBoundaryContext | null;
  executionEvidence?: unknown;
}): FirstStepRecommendation {
  const authorityBlocked = args.authorityBlocked === true;
  const effectiveNextAction = authorityBlocked
    ? buildAuthorityInspectionNextAction({
        selectedTool: args.selectedTool,
        filePath: args.filePath,
        blocker: args.authorityPrimaryBlocker ?? null,
        reuseTarget: "learned execution memory",
      })
    : args.nextAction;
  const contractTrust = resolveContractTrust({
    sourceKind: args.sourceKind,
    historyApplied: args.historyApplied,
    explicitTrust: args.explicitTrust,
    taskFamily: args.taskFamily,
    workflowSignature: args.workflowSignature,
    policyMemoryId: args.policyMemoryId,
    executionContract: args.executionContract,
    uncertainty: args.uncertainty,
    authorityBlocked,
  });
  const guardedContract = guardExecutionContractForConsumer({
    contract: args.executionContract,
    trust: contractTrust,
  });
  const trustGuardedContract = guardedContract
    ? {
        ...guardedContract,
        contract_trust: contractTrust,
      }
    : null;
  const effectiveExecutionContract = authorityBlocked && trustGuardedContract
    ? {
        ...trustGuardedContract,
        next_action: effectiveNextAction,
      }
    : trustGuardedContract;
  const firstAction = buildRuntimeFirstActionRecommendation({
    sourceKind: args.sourceKind,
    historyApplied: args.historyApplied,
    contractTrust,
    selectedTool: args.selectedTool,
    filePath: contractTrust === "observational" ? null : args.filePath,
    executionContract: effectiveExecutionContract,
    uncertainty: args.uncertainty,
    preActionGate: args.preActionGate ?? null,
    authorityBlocked,
    authorityPrimaryBlocker: args.authorityPrimaryBlocker ?? null,
  });
  const editBoundary = buildRuntimeEditBoundaryRecommendation({
    contractTrust,
    filePath: contractTrust === "observational" ? null : args.filePath,
    executionContract: effectiveExecutionContract,
    editBoundaryContext: args.editBoundaryContext ?? null,
  });
  const verificationRepair = buildRuntimeVerificationRepairRecommendation({
    contractTrust,
    executionEvidence: args.executionEvidence,
    editBoundaryContext: args.editBoundaryContext ?? null,
  });

  if (contractTrust !== "observational") {
    return {
      source_kind: args.sourceKind,
      history_applied: args.historyApplied,
      contract_trust: contractTrust,
      execution_contract_v1: effectiveExecutionContract,
      first_action_v1: firstAction,
      edit_boundary_v1: editBoundary,
      verification_repair_v1: verificationRepair,
      selected_tool: args.selectedTool,
      task_family: args.taskFamily,
      workflow_signature: args.workflowSignature,
      policy_memory_id: args.policyMemoryId,
      file_path: args.filePath,
      next_action: effectiveNextAction,
    };
  }

  return {
    source_kind: args.sourceKind,
    history_applied: args.historyApplied,
    contract_trust: contractTrust,
    execution_contract_v1: effectiveExecutionContract,
    first_action_v1: firstAction,
    edit_boundary_v1: editBoundary,
    verification_repair_v1: verificationRepair,
    selected_tool: args.selectedTool,
    task_family: null,
    workflow_signature: null,
    policy_memory_id: null,
    file_path: null,
    next_action: buildUncertaintyAwareNextAction({
      sourceKind: args.sourceKind,
      selectedTool: args.selectedTool,
      filePath: null,
      nextAction: null,
      uncertainty: args.uncertainty,
    }),
  };
}

export function buildPlannerExplanation(args: {
  selectedTool: string | null;
  decision: Record<string, unknown>;
  patternSignalSummary: PatternSignalSummaryLike;
  plannerSurface: PlannerPacketSummarySurface;
  actionPacketSummary: ActionPacketSummary;
  workflowLifecycleSummary: WorkflowLifecycleSummary;
  authorityVisibilitySummary?: AuthorityVisibilitySummary | null;
  runtimeEntropyProfile?: RuntimeEntropyProfileV1 | null;
  actionRetrievalUncertainty?: ActionRetrievalUncertaintySummary | null;
}): string | null {
  const patternSummary =
    args.decision.pattern_summary && typeof args.decision.pattern_summary === "object"
      ? (args.decision.pattern_summary as Record<string, unknown>)
      : {};
  const actionPacket =
    args.plannerSurface.action_recall_packet && typeof args.plannerSurface.action_recall_packet === "object"
      ? (args.plannerSurface.action_recall_packet as Record<string, unknown>)
      : {};
  const workflowLabels = summarizePacketEntryLabels(safeRecordArray(actionPacket.recommended_workflows), "title");
  const candidateWorkflowEntries = safeRecordArray(actionPacket.candidate_workflows);
  const candidateWorkflowLabels = summarizePacketEntryLabels(candidateWorkflowEntries, "title");
  const readyCandidateWorkflowLabels = summarizePacketEntryLabels(
    candidateWorkflowEntries.filter((entry) => isPromotionReadyWorkflowSignal(entry)),
    "title",
  );
  const rehydrationLabels = summarizePacketEntryLabels(safeRecordArray(actionPacket.rehydration_candidates), "title");
  const usedTrustedPatternTools = uniqueStrings(safeStringArray(patternSummary.used_trusted_pattern_tools));
  const skippedContestedPatternTools = uniqueStrings(safeStringArray(patternSummary.skipped_contested_pattern_tools));
  const selectedTool = args.selectedTool;
  if (
    !selectedTool
    && usedTrustedPatternTools.length === 0
    && skippedContestedPatternTools.length === 0
    && args.actionPacketSummary.recommended_workflow_count === 0
    && args.actionPacketSummary.candidate_workflow_count === 0
    && args.actionPacketSummary.rehydration_candidate_count === 0
    && args.actionPacketSummary.supporting_knowledge_count === 0
  ) {
    return null;
  }
  const parts: string[] = [];
  if (args.actionPacketSummary.recommended_workflow_count > 0) {
    const workflowLead =
      workflowLabels.length > 0
        ? `workflow guidance: ${workflowLabels.join(", ")}`
        : `workflow guidance: ${args.actionPacketSummary.recommended_workflow_count} recommended`;
    parts.push(workflowLead);
  }
  if (args.actionPacketSummary.candidate_workflow_count > 0) {
    if (args.workflowLifecycleSummary.promotion_ready_count > 0) {
      const readyWorkflowLead =
        readyCandidateWorkflowLabels.length > 0
          ? `promotion-ready workflow candidates: ${readyCandidateWorkflowLabels.join(", ")}`
          : `promotion-ready workflow candidates: ${args.workflowLifecycleSummary.promotion_ready_count}`;
      parts.push(readyWorkflowLead);
    }
    const remainingCandidateCount = Math.max(
      0,
      args.actionPacketSummary.candidate_workflow_count - args.workflowLifecycleSummary.promotion_ready_count,
    );
    if (remainingCandidateCount > 0) {
      const nonReadyCandidateLabels = summarizePacketEntryLabels(
        candidateWorkflowEntries.filter((entry) => !isPromotionReadyWorkflowSignal(entry)),
        "title",
      );
      const candidateWorkflowLead =
        nonReadyCandidateLabels.length > 0
          ? `candidate workflows visible but not yet promoted: ${nonReadyCandidateLabels.join(", ")}`
          : candidateWorkflowLabels.length > 0
            ? `candidate workflows visible but not yet promoted: ${candidateWorkflowLabels.join(", ")}`
            : `candidate workflows visible but not yet promoted: ${remainingCandidateCount}`;
      parts.push(candidateWorkflowLead);
    }
  }
  if (selectedTool) {
    parts.push(`selected tool: ${selectedTool}`);
  }
  if (usedTrustedPatternTools.length > 0) {
    parts.push(`trusted pattern support: ${usedTrustedPatternTools.join(", ")}`);
  } else if (args.patternSignalSummary.trusted_pattern_count > 0) {
    parts.push(`trusted patterns available but not used: ${args.patternSignalSummary.trusted_pattern_tools.join(", ")}`);
  }
  if (args.patternSignalSummary.candidate_pattern_count > 0) {
    parts.push(`candidate patterns visible but not yet trusted: ${args.patternSignalSummary.candidate_pattern_tools.join(", ")}`);
  }
  if (skippedContestedPatternTools.length > 0) {
    parts.push(`contested patterns visible but not trusted: ${skippedContestedPatternTools.join(", ")}`);
  } else if (args.patternSignalSummary.contested_pattern_count > 0) {
    parts.push(`contested patterns visible but not trusted: ${args.patternSignalSummary.contested_pattern_tools.join(", ")}`);
  }
  if (args.actionPacketSummary.rehydration_candidate_count > 0) {
    const rehydrationLead =
      rehydrationLabels.length > 0
        ? `rehydration available: ${rehydrationLabels.join(", ")}`
        : `rehydration available: ${args.actionPacketSummary.rehydration_candidate_count} candidate`;
    parts.push(rehydrationLead);
  }
  if (args.actionPacketSummary.supporting_knowledge_count > 0) {
    parts.push(`supporting knowledge appended: ${args.actionPacketSummary.supporting_knowledge_count}`);
  }
  if (args.authorityVisibilitySummary && args.authorityVisibilitySummary.authoritative_blocked_count > 0) {
    const blocker = args.authorityVisibilitySummary.top_blockers[0] ?? "unknown";
    parts.push(`authority blocked: ${args.authorityVisibilitySummary.authoritative_blocked_count}; blocker=${blocker}`);
  }
  if (args.authorityVisibilitySummary && args.authorityVisibilitySummary.execution_evidence_failed_count > 0) {
    parts.push(`execution evidence failed: ${args.authorityVisibilitySummary.execution_evidence_failed_count}`);
  }
  if (args.runtimeEntropyProfile && args.runtimeEntropyProfile.entropy_level !== "medium") {
    parts.push(
      `runtime entropy: ${args.runtimeEntropyProfile.entropy_level}; recall=${args.runtimeEntropyProfile.recall_breadth}; verify=${args.runtimeEntropyProfile.verification_depth}`,
    );
  }
  if (args.actionRetrievalUncertainty && args.actionRetrievalUncertainty.level !== "low") {
    const uncertaintyLead = [
      `action retrieval uncertainty: ${args.actionRetrievalUncertainty.level}`,
      args.actionRetrievalUncertainty.reasons[0] ?? null,
      args.actionRetrievalUncertainty.recommended_actions.length > 0
        ? `recommended follow-up: ${args.actionRetrievalUncertainty.recommended_actions.join(", ")}`
        : null,
    ].filter((value): value is string => !!value).join("; ");
    if (uncertaintyLead) parts.push(uncertaintyLead);
  }
  if (parts.length === 0) return null;
  return parts.join("; ");
}

export function buildActionRetrievalGate(args: {
  firstStepRecommendation: FirstStepRecommendation | null;
  plannerSurface: PlannerPacketSummarySurface;
  preActionGate?: ActionIntelligencePreActionGateSummary | null;
  uncertainty: ActionRetrievalUncertaintySummary | null;
}): ActionRetrievalGateSummary | null {
  const gateAction = resolveEffectiveGateAction({
    preActionGate: args.preActionGate ?? null,
    uncertainty: args.uncertainty,
  });
  if (!gateAction) return null;
  const confidence = args.preActionGate?.confidence ?? args.uncertainty?.confidence ?? 0;
  const primaryReason = args.preActionGate?.primary_reason ?? args.uncertainty?.reasons[0] ?? null;
  const preferredRehydration = gateAction === "rehydrate_payload"
    ? pickPreferredRehydrationCandidate(args.plannerSurface)
    : null;
  const recommendedActionsRaw = args.preActionGate?.recommended_actions ?? args.uncertainty?.recommended_actions ?? [];
  const recommendedActions = recommendedActionsRaw.filter(
    (entry): entry is ActionRetrievalGateAction => entry !== "proceed",
  );
  if (!recommendedActions.includes(gateAction)) {
    recommendedActions.unshift(gateAction);
  }
  return {
    summary_version: "action_retrieval_gate_v1",
    gate_action: gateAction,
    escalates_task_start: shouldEscalateTaskStartFromGate({
      gateAction,
      firstStepRecommendation: args.firstStepRecommendation,
    }),
    confidence,
    primary_reason: primaryReason,
    recommended_actions: recommendedActions,
    instruction:
      args.firstStepRecommendation?.next_action
      ?? buildDefaultGateInstruction({
        gateAction,
        firstStepRecommendation: args.firstStepRecommendation,
        preferredRehydration,
      }),
    rehydration_candidate_count: safeRecordArray(args.plannerSurface.rehydration_candidates).length,
    preferred_rehydration: preferredRehydration,
  };
}

export function buildFirstStepRecommendation(args: {
  selectedTool: string | null;
  experienceSummary: ExperienceRecommendationProjectionLike | null;
  editBoundaryContext?: RuntimeEditBoundaryContext | null;
  executionEvidence?: unknown;
}): FirstStepRecommendation | null {
  const experience = args.experienceSummary;
  if (
    experience
    && (
      experience.history_applied
      || experience.path_source_kind !== "none"
      || !!experience.file_path
      || !!experience.combined_next_action
      || !!experience.action_retrieval_uncertainty
    )
  ) {
    const selectedTool = experience.selected_tool ?? args.selectedTool ?? null;
    return applyContractTrustGuard({
      sourceKind: "experience_intelligence",
      historyApplied: experience.history_applied,
      explicitTrust: experience.contract_trust,
      selectedTool,
      taskFamily: experience.task_family,
      workflowSignature: experience.workflow_signature,
      policyMemoryId: experience.policy_memory_id,
      filePath: experience.file_path,
      executionContract: experience.execution_contract_v1,
      nextAction: buildUncertaintyAwareNextAction({
        sourceKind: "experience_intelligence",
        selectedTool,
        filePath: experience.file_path,
        nextAction: experience.combined_next_action,
        uncertainty: experience.action_retrieval_uncertainty,
        preActionGate: experience.action_intelligence_pre_action_gate,
      }),
      uncertainty: experience.action_retrieval_uncertainty,
      preActionGate: experience.action_intelligence_pre_action_gate,
      authorityBlocked: experience.authority_blocked || experience.action_intelligence_pre_action_gate?.authority_blocked === true,
      authorityPrimaryBlocker: experience.authority_primary_blocker,
      editBoundaryContext: args.editBoundaryContext ?? null,
      executionEvidence: args.executionEvidence,
    });
  }
  if (!args.selectedTool && !hasVerificationFailureEvidence(args.executionEvidence)) return null;
  return applyContractTrustGuard({
    sourceKind: "tool_selection",
    historyApplied: false,
    explicitTrust: experience?.contract_trust ?? null,
    selectedTool: args.selectedTool,
    taskFamily: null,
    workflowSignature: null,
    policyMemoryId: null,
    filePath: null,
    executionContract: experience?.execution_contract_v1 ?? null,
      nextAction: buildUncertaintyAwareNextAction({
        sourceKind: "tool_selection",
        selectedTool: args.selectedTool,
        filePath: null,
        nextAction: null,
        uncertainty: experience?.action_retrieval_uncertainty ?? null,
        preActionGate: experience?.action_intelligence_pre_action_gate ?? null,
      }),
      uncertainty: experience?.action_retrieval_uncertainty ?? null,
    preActionGate: experience?.action_intelligence_pre_action_gate ?? null,
    authorityBlocked: (experience?.authority_blocked ?? false) || experience?.action_intelligence_pre_action_gate?.authority_blocked === true,
    authorityPrimaryBlocker: experience?.authority_primary_blocker ?? null,
    editBoundaryContext: args.editBoundaryContext ?? null,
    executionEvidence: args.executionEvidence,
  });
}

export function buildKickoffRecommendation(
  firstStepRecommendation: FirstStepRecommendation | null | undefined,
): KickoffRecommendation | null {
  if (!firstStepRecommendation) return null;
  return {
    source_kind: firstStepRecommendation.source_kind,
    history_applied: firstStepRecommendation.history_applied,
    contract_trust: firstStepRecommendation.contract_trust,
    execution_contract_v1: firstStepRecommendation.execution_contract_v1,
    first_action_v1: firstStepRecommendation.first_action_v1,
    edit_boundary_v1: firstStepRecommendation.edit_boundary_v1,
    verification_repair_v1: firstStepRecommendation.verification_repair_v1,
    selected_tool: firstStepRecommendation.selected_tool,
    task_family: firstStepRecommendation.task_family,
    workflow_signature: firstStepRecommendation.workflow_signature,
    policy_memory_id: firstStepRecommendation.policy_memory_id,
    file_path: firstStepRecommendation.file_path,
    next_action: firstStepRecommendation.next_action,
  };
}

export function buildKickoffRecommendationFromExperience(args: {
  historyApplied: boolean;
  contractTrustHint: ContractTrust | null;
  selectedTool: string | null;
  taskFamily: string | null;
  workflowSignature: string | null;
  policyMemoryId: string | null;
  filePath: string | null;
  nextAction: string | null;
  executionContract: ExecutionContractV1 | null;
  uncertainty?: ActionRetrievalUncertaintySummary | null;
  editBoundaryContext?: RuntimeEditBoundaryContext | null;
  executionEvidence?: unknown;
}): KickoffRecommendation | null {
  if (
    !args.selectedTool
    && !args.filePath
    && !args.nextAction
    && !args.uncertainty
    && !hasVerificationFailureEvidence(args.executionEvidence)
  ) return null;
  const firstStep = applyContractTrustGuard({
    sourceKind: args.historyApplied ? "experience_intelligence" : "tool_selection",
    historyApplied: args.historyApplied,
    explicitTrust: args.contractTrustHint,
    selectedTool: args.selectedTool,
    taskFamily: args.taskFamily,
    workflowSignature: args.workflowSignature,
    policyMemoryId: args.policyMemoryId,
    filePath: args.filePath,
    executionContract: args.executionContract,
    nextAction: buildUncertaintyAwareNextAction({
      sourceKind: args.historyApplied ? "experience_intelligence" : "tool_selection",
      selectedTool: args.selectedTool,
      filePath: args.filePath,
      nextAction: args.nextAction,
      uncertainty: args.uncertainty ?? null,
    }),
    uncertainty: args.uncertainty ?? null,
    editBoundaryContext: args.editBoundaryContext ?? null,
    executionEvidence: args.executionEvidence,
  });
  return {
    source_kind: firstStep.source_kind,
    history_applied: firstStep.history_applied,
    contract_trust: firstStep.contract_trust,
    execution_contract_v1: firstStep.execution_contract_v1,
    first_action_v1: firstStep.first_action_v1,
    edit_boundary_v1: firstStep.edit_boundary_v1,
    verification_repair_v1: firstStep.verification_repair_v1,
    selected_tool: firstStep.selected_tool,
    task_family: firstStep.task_family,
    workflow_signature: firstStep.workflow_signature,
    policy_memory_id: firstStep.policy_memory_id,
    file_path: firstStep.file_path,
    next_action: firstStep.next_action,
  };
}
