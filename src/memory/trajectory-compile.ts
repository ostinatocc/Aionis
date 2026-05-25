import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import {
  ServiceLifecycleConstraintV1Schema,
  type ServiceLifecycleConstraintV1,
} from "../execution/types.js";
import {
  TrajectoryCompileRequest,
  TrajectoryCompileResponseSchema,
  TrajectoryCompileStepSchema,
  type TrajectoryCompileInput,
  type TrajectoryCompileResponse,
} from "./schemas.js";

const NOISE_PATTERNS = [
  "can't fully execute",
  "cannot fully execute",
  "can't execute",
  "cannot execute",
  "unable to execute",
  "not installed here",
  "isn't installed here",
  "in this sandbox",
  "sandbox",
  "source-level check",
  "source level check",
  "hand this over",
];

const VALIDATION_COMMAND_PATTERNS = [
  /\bpytest\b/i,
  /\bnpm\s+test\b/i,
  /\bpnpm\s+test\b/i,
  /\byarn\s+test\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bpip\s+install\b/i,
  /\bpython(?:3)?\s+-c\b.*\bassert\b/i,
  /\bpython\s+-m\s+pytest\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bintegrity_check\b/i,
  /\bverify\b/i,
  /\bcheck\b/i,
];

const SERVICE_COMMAND_PATTERNS = [
  /\bpython\s+-m\s+http\.server\b/i,
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bnginx\b/i,
  /\b(?:python|python3|node|bash|sh)\s+\S*(?:serve|server|start)\S*/i,
  /\bnpm\s+(run\s+)?start\b/i,
  /\bpnpm\s+(run\s+)?start\b/i,
  /\byarn\s+start\b/i,
  /\bserve\b/i,
  /\bdocker\s+run\b/i,
];

const DETACH_PATTERNS = [
  /\bnohup\b/i,
  /\bsetsid\b/i,
  /\bdisown\b/i,
  /\bdaemon\b/i,
  /(^|\s)&(?:\s|$)/,
];

type NormalizedStep = {
  role: string | null;
  kind: string | null;
  tool_name: string | null;
  texts: string[];
  commands: string[];
  file_paths: string[];
  urls: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function compileCorpus(queryText: string, steps: NormalizedStep[]): string {
  return `${queryText}\n${steps.flatMap((step) => [...step.texts, ...step.commands]).join("\n")}`.toLowerCase();
}

function corpusHasFreshShellSignal(corpus: string): boolean {
  return /\bfresh\s+shell\b|\bnew\s+shell\b|\bclean\s+(?:client|shell|environment)\b/i.test(corpus);
}

function corpusHasAfterExitSignal(corpus: string): boolean {
  return /\bafter\b.*\b(?:exit|worker exits|agent exits|session ends)\b|\bsurvive\b.*\b(?:exit|agent|session|worker)\b/i.test(corpus);
}

function corpusHasDetachSignal(corpus: string): boolean {
  return /\bnohup\b|\bsetsid\b|\bdisown\b|\bdaemon\b|\bdetach(?:ed)?\b|\bbackground\s+(?:process|service|server)\b/i.test(corpus);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 3 || out.length >= 96 || value == null) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const entry of Object.values(record)) collectStrings(entry, out, depth + 1);
}

function splitCandidateLines(value: string): string[] {
  return value
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isProbablyCommand(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("$ ")) return true;
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:\.{0,2}\/)?(?:python|python3|pytest|npm|pnpm|yarn|curl|wget|pip|go|cargo|git|uv|node|bash|sh|nohup|setsid|docker|serve|nc|npx|sqlite3)\b/i.test(line);
}

function extractFilePathsFromText(value: string): string[] {
  const sanitized = value.replace(/https?:\/\/[^\s)"']+/g, " ");
  const matches = sanitized.match(
    /(?:\/[\w@./-]+(?:\.[A-Za-z0-9_-]+)?|(?:\.{0,2}\/)?[\w@-]+(?:\/[\w@.-]+)+|\b[\w@.-]+\.[A-Za-z0-9_-]{1,16}\b)/g,
  ) ?? [];
  return uniqueStrings(
    matches
      .map((entry) => entry.replace(/[),.;:]+$/g, ""))
      .filter((entry) => entry.length > 1)
      .filter((entry) => !entry.startsWith("//"))
      .filter((entry) => !/^https?:\/\//i.test(entry))
      .filter((entry) => !/^(localhost|127\.0\.0\.1)$/i.test(entry))
      .filter((entry) => !entry.startsWith("--"))
      .filter((entry) => !/^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(entry))
      .filter((entry) => !/^\/(?:tmp|var\/tmp)\//.test(entry))
      .filter((entry) => !/\.(?:log|pid|sock|tmp)$/i.test(entry))
      .filter((entry) => !new RegExp(`--(?:directory|dir|output|out|cache-dir)\\s+${escapeRegExp(entry)}(?:\\s|$)`, "i").test(sanitized))
      .filter((entry) => !new RegExp(`\\b(?:python|python3)\\s+-m\\s+${escapeRegExp(entry)}(?:\\s|$)`, "i").test(sanitized)),
    64,
  );
}

function extractUrlsFromText(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s)"']+/g) ?? [];
  return uniqueStrings(matches.map((entry) => entry.replace(/[),.;:]+$/g, "")), 32);
}

function normalizeStep(step: unknown): NormalizedStep {
  const parsed = TrajectoryCompileStepSchema.parse(step);
  const rawStrings: string[] = [];
  collectStrings(parsed.tool_input, rawStrings);
  collectStrings(parsed.observation, rawStrings);
  collectStrings(parsed.result, rawStrings);
  const directStrings = [
    parsed.title,
    parsed.text,
    parsed.content,
    parsed.summary,
    parsed.command,
    ...rawStrings,
  ];
  const texts = uniqueStrings(directStrings.flatMap((entry) => entry ? splitCandidateLines(entry) : []), 128);
  const commands = uniqueStrings(
    [
      parsed.command,
      ...texts.filter(isProbablyCommand).map((line) => line.startsWith("$ ") ? line.slice(2).trim() : line),
    ],
    48,
  );
  const filePaths = uniqueStrings(
    [
      ...(parsed.file_paths ?? []),
      ...texts.flatMap(extractFilePathsFromText),
      ...commands.flatMap(extractFilePathsFromText),
    ],
    64,
  );
  const urls = uniqueStrings(
    [
      ...(parsed.urls ?? []),
      ...texts.flatMap(extractUrlsFromText),
      ...commands.flatMap(extractUrlsFromText),
    ],
    32,
  );
  return {
    role: firstString(parsed.role),
    kind: firstString(parsed.kind),
    tool_name: firstString(parsed.tool_name),
    texts,
    commands,
    file_paths: filePaths,
    urls,
  };
}

function inferTaskFamily(queryText: string, steps: NormalizedStep[], explicitTaskFamily?: string | null): string | null {
  const explicit = firstString(explicitTaskFamily);
  if (explicit) return explicit;
  const corpus = `${queryText}\n${steps.flatMap((step) => [...step.texts, ...step.commands]).join("\n")}`.toLowerCase();
  if (
    /\b(ai[- ]generated|almost[- ]right|ci failure|failing test|test failure|red test|patch review|unit test failure|targeted ci)\b/.test(corpus)
    && /\b(repair|fix|debug|verify|test|pass)\b/.test(corpus)
  ) return "ai_code_ci_repair";
  if ((/\bgit\b/.test(corpus) && /\b(webserver|hook|deploy|nginx|publish)\b/.test(corpus))) return "git_deploy_webserver";
  if ((/\b(pypi|pip install|package index|wheel|simple\/)\b/.test(corpus))) return "package_publish_validate";
  if ((/\b(sqlite|database|db|wal|integrity_check|truncate)\b/.test(corpus))) return "database_recovery";
  if ((/\b(server|service|localhost|127\.0\.0\.1|http:\/\/|https:\/\/)\b/.test(corpus) && /\b(validate|verify|publish|serve|install)\b/.test(corpus))) {
    return "service_publish_validate";
  }
  const tokens = uniqueStrings(
    queryText
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4)
      .slice(0, 4),
    4,
  );
  return tokens.length > 0 ? `task_${tokens.join("_")}` : null;
}

function inferLikelyTool(steps: NormalizedStep[]): string | null {
  const toolCounts = new Map<string, number>();
  for (const step of steps) {
    const tool = step.tool_name ?? (step.commands.length > 0 ? "bash" : null);
    if (!tool) continue;
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }
  return Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function extractAcceptanceChecks(steps: NormalizedStep[], hintChecks: string[] = []): string[] {
  return uniqueStrings(
    [
      ...hintChecks,
      ...steps.flatMap((step) => step.commands.filter((command) => VALIDATION_COMMAND_PATTERNS.some((pattern) => pattern.test(command)))),
    ],
    24,
  );
}

function extractWorkflowSteps(steps: NormalizedStep[]): string[] {
  return uniqueStrings(
    steps.flatMap((step) => {
      if (step.commands.length > 0) return step.commands;
      return step.texts.filter((line) => !NOISE_PATTERNS.some((pattern) => line.toLowerCase().includes(pattern))).slice(0, 1);
    }),
    16,
  );
}

function extractNoiseMarkers(steps: NormalizedStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    for (const text of step.texts) {
      const lowered = text.toLowerCase();
      for (const pattern of NOISE_PATTERNS) {
        if (lowered.includes(pattern)) out.push(pattern);
      }
    }
  }
  return uniqueStrings(out, 16);
}

function extractServiceLifecycleConstraints(
  queryText: string,
  steps: NormalizedStep[],
  acceptanceChecks: string[],
  taskFamily: string | null,
): ServiceLifecycleConstraintV1[] {
  const commands = steps.flatMap((step) => step.commands);
  const corpus = compileCorpus(queryText, steps);
  const urls = uniqueStrings(steps.flatMap((step) => step.urls), 16);
  const serviceCommands = commands.filter((command) => {
    if (!SERVICE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return false;
    if (
      taskFamily === "package_publish_validate"
      && /\bpython(?:3)?\s+-m\s+http\.server\b/i.test(command)
      && /\b(?:pip\s+install|package index|simple\/|wheel|clean client|clean-client)\b/i.test(corpus)
    ) {
      return false;
    }
    return true;
  });
  const hasLaunchEvidence = serviceCommands.length > 0;
  if (!hasLaunchEvidence) return [];
  const launchReference = serviceCommands[0] ?? null;
  const endpoint = urls.find((url) => /localhost|127\.0\.0\.1/i.test(url)) ?? null;
  const hasDetach = commands.some((command) => DETACH_PATTERNS.some((pattern) => pattern.test(command)))
    || corpusHasDetachSignal(corpus);
  const serviceKind: ServiceLifecycleConstraintV1["service_kind"] =
    endpoint?.startsWith("http://") || endpoint?.startsWith("https://") ? "http" : "generic";
  const healthChecks = acceptanceChecks.filter((command) => /\bcurl\b|\bwget\b|\bpip\s+install\b|\bnc\b/i.test(command));
  const shouldSurviveAgentExit = corpusHasAfterExitSignal(corpus) || hasDetach;
  const shouldRevalidateFromFreshShell =
    corpusHasFreshShellSignal(corpus)
    || healthChecks.length > 0
    || !!endpoint;
  return [
    ServiceLifecycleConstraintV1Schema.parse({
      version: 1,
      service_kind: serviceKind,
      label: endpoint ? `service:${endpoint}` : "background_service",
      launch_reference: launchReference,
      endpoint,
      must_survive_agent_exit: shouldSurviveAgentExit,
      revalidate_from_fresh_shell: shouldRevalidateFromFreshShell,
      detach_then_probe: hasDetach && shouldRevalidateFromFreshShell,
      health_checks: healthChecks,
      teardown_notes: [],
    }),
  ];
}

function hasFreshShellSignal(corpus: string, acceptanceChecks: string[], serviceConstraints: ServiceLifecycleConstraintV1[]): boolean {
  return corpusHasFreshShellSignal(corpus)
    || acceptanceChecks.some((check) => /\bpip\s+install\b|\bcurl\b|\bwget\b|\bnc\b/i.test(check))
    || serviceConstraints.some((constraint) => constraint.revalidate_from_fresh_shell);
}

function hasAfterExitSignal(corpus: string, serviceConstraints: ServiceLifecycleConstraintV1[]): boolean {
  return corpusHasAfterExitSignal(corpus)
    || serviceConstraints.some((constraint) => constraint.must_survive_agent_exit);
}

function extractDependencyRequirements(args: {
  queryText: string;
  steps: NormalizedStep[];
  taskFamily: string | null;
  serviceConstraints: ServiceLifecycleConstraintV1[];
  hintRequirements?: string[];
}): string[] {
  const corpus = compileCorpus(args.queryText, args.steps);
  const out: Array<string | null> = [...(args.hintRequirements ?? [])];
  if (/\b(pip\s+install|pypi|package index|simple\/|wheel|pyproject\.toml)\b/i.test(corpus)) {
    out.push("package artifacts and index metadata must exist before clean-client install validation");
    out.push("install validation must use the intended package index, not ambient cached packages");
  }
  if (
    args.taskFamily === "package_publish_validate"
    && /\b(installed api|installed package behavior|package payload|vector_norm|clean-client api)\b/i.test(corpus)
  ) {
    out.push("installed package API behavior must match the clean-client contract");
  }
  if (/\b(git)\b/i.test(corpus) && /\b(webserver|hook|deploy|receive\.denycurrentbranch|post-receive|updateinstead|document root|\/var\/www)\b/i.test(corpus)) {
    out.push("git deploy or hook path must publish into the externally served document root");
    out.push("webserver content must come from the deployed revision under validation");
  }
  if (/\b(sqlite|database|db|wal|integrity_check)\b/i.test(corpus)) {
    out.push("database files and journal state must be consistent before declaring recovery complete");
  }
  if (args.taskFamily === "ai_code_ci_repair") {
    out.push("existing failing tests define the behavior contract for the repair");
    out.push("repair must satisfy targeted CI or test evidence without broad unrelated edits");
    out.push("test files are read-only acceptance evidence and must not be edited to manufacture success");
    if (/\b(discount-policy|policy helper|helper module|dependency surface|implementation dependenc(?:y|ies))\b/i.test(corpus)) {
      out.push("implementation dependencies that feed the targeted entrypoint must be traced before patching");
    }
  }
  if (args.serviceConstraints.length > 0) {
    out.push("service launch must not depend on the agent shell remaining attached");
  }
  if (args.taskFamily === "service_publish_validate") {
    out.push("service must be reachable through its published validation endpoint");
  }
  return uniqueStrings(out, 24);
}

function extractEnvironmentAssumptions(args: {
  queryText: string;
  steps: NormalizedStep[];
  repoRoot?: string | null;
  acceptanceChecks: string[];
  serviceConstraints: ServiceLifecycleConstraintV1[];
  hintAssumptions?: string[];
}): string[] {
  const corpus = compileCorpus(args.queryText, args.steps);
  const out: Array<string | null> = [
    ...(args.hintAssumptions ?? []),
    args.repoRoot ? `repo_root:${args.repoRoot}` : null,
  ];
  for (const constraint of args.serviceConstraints) {
    if (constraint.endpoint) out.push(`local_endpoint:${constraint.endpoint}`);
    if (constraint.detach_then_probe) out.push("detached_process_supported");
    if (constraint.revalidate_from_fresh_shell) out.push("fresh_shell_available_for_revalidation");
  }
  if (hasFreshShellSignal(corpus, args.acceptanceChecks, args.serviceConstraints)) {
    out.push("validation_can_run_from_fresh_shell");
  }
  if (/\blocalhost\b|\b127\.0\.0\.1\b/i.test(corpus)) {
    out.push("localhost_reachable_from_validation_environment");
  }
  return uniqueStrings(out, 24);
}

function extractSuccessInvariants(args: {
  queryText: string;
  steps: NormalizedStep[];
  taskFamily: string | null;
  targetFiles: string[];
  acceptanceChecks: string[];
  serviceConstraints: ServiceLifecycleConstraintV1[];
  hintInvariants?: string[];
}): string[] {
  const corpus = compileCorpus(args.queryText, args.steps);
  const out: Array<string | null> = [...(args.hintInvariants ?? [])];
  if (args.targetFiles.length > 0) out.push("target_files_reflect_the_intended_change_surface");
  if (args.acceptanceChecks.length > 0) out.push("all_acceptance_checks_pass");
  if (hasFreshShellSignal(corpus, args.acceptanceChecks, args.serviceConstraints)) out.push("fresh_shell_revalidation_passes");
  if (/\bpip\s+install\b/i.test(corpus)) out.push("clean_client_install_succeeds");
  if (
    args.taskFamily === "package_publish_validate"
    && /\b(installed api|installed package behavior|package payload|vector_norm|clean-client api)\b/i.test(corpus)
  ) {
    out.push("clean_client_import_contract_succeeds");
    out.push("wheel_payload_matches_source_api");
  }
  if (args.taskFamily === "git_deploy_webserver") out.push("deployed_web_content_visible_from_served_endpoint");
  if (args.taskFamily === "ai_code_ci_repair") out.push("targeted_ci_repair_passes");
  if (/\bintegrity_check\b|\bsqlite\b|\bdatabase\b|\bwal\b/i.test(corpus)) out.push("database_integrity_check_passes");
  for (const constraint of args.serviceConstraints) {
    if (constraint.endpoint) out.push(`service_endpoint_reachable:${constraint.endpoint}`);
  }
  return uniqueStrings(out, 24);
}

function extractMustHoldAfterExit(args: {
  queryText: string;
  steps: NormalizedStep[];
  taskFamily: string | null;
  acceptanceChecks: string[];
  serviceConstraints: ServiceLifecycleConstraintV1[];
  hintMustHold?: string[];
}): string[] {
  const corpus = compileCorpus(args.queryText, args.steps);
  const out: Array<string | null> = [...(args.hintMustHold ?? [])];
  if (args.taskFamily !== "service_publish_validate") {
    return uniqueStrings(out, 24);
  }
  const afterExitRequired = hasAfterExitSignal(corpus, args.serviceConstraints);
  for (const constraint of args.serviceConstraints) {
    if (!constraint.must_survive_agent_exit) continue;
    out.push(`service_survives_agent_exit:${constraint.label}`);
    if (constraint.endpoint) out.push(`service_endpoint_still_serves_after_exit:${constraint.endpoint}`);
  }
  if (afterExitRequired) {
    out.push("task_result_remains_valid_after_agent_exit");
  }
  if (afterExitRequired && hasFreshShellSignal(corpus, args.acceptanceChecks, args.serviceConstraints)) {
    out.push("fresh_shell_revalidation_still_passes_after_agent_exit");
  }
  return uniqueStrings(out, 24);
}

function extractExternalVisibilityRequirements(args: {
  queryText: string;
  steps: NormalizedStep[];
  taskFamily: string | null;
  acceptanceChecks: string[];
  serviceConstraints: ServiceLifecycleConstraintV1[];
  hintRequirements?: string[];
}): string[] {
  const corpus = compileCorpus(args.queryText, args.steps);
  const out: Array<string | null> = [...(args.hintRequirements ?? [])];
  for (const constraint of args.serviceConstraints) {
    if (constraint.endpoint) out.push(`endpoint_reachable:${constraint.endpoint}`);
    out.push(...constraint.health_checks.map((check) => `health_check:${check}`));
  }
  if (/\bpip\s+install\b/i.test(corpus)) out.push("package_install_visible_to_clean_client");
  if (
    args.taskFamily === "package_publish_validate"
    && /\b(installed api|installed package behavior|package payload|vector_norm|clean-client api)\b/i.test(corpus)
  ) {
    out.push("installed_api_visible_to_clean_client");
  }
  if (args.taskFamily === "git_deploy_webserver") out.push("served_web_content_matches_deployed_revision");
  for (const check of args.acceptanceChecks) {
    if (/\bcurl\b|\bwget\b|\bnc\b/i.test(check)) out.push(`external_probe:${check}`);
  }
  return uniqueStrings(out, 24);
}

function extractPatternHints(args: {
  taskFamily: string | null;
  targetFiles: string[];
  acceptanceChecks: string[];
  serviceConstraints: ServiceLifecycleConstraintV1[];
  likelyTool: string | null;
}): string[] {
  const out: string[] = [];
  if (args.targetFiles.length > 0) out.push("keep_changes_scoped_to_target_files");
  if (args.acceptanceChecks.length > 0) out.push("rerun_acceptance_checks_after_changes");
  if (args.serviceConstraints.length > 0) {
    out.push("detach_long_running_service_before_validation");
    out.push("revalidate_service_from_fresh_shell");
  }
  if (args.taskFamily === "ai_code_ci_repair") {
    out.push("inspect_failing_test_before_patch");
    out.push("avoid_unrelated_file_changes");
    out.push("keep_tests_read_only_unless_task_explicitly_requests_test_changes");
    out.push("rerun_targeted_test_before_success");
  }
  if (args.taskFamily === "git_deploy_webserver") out.push("validate_hook_or_publish_path_before_declaring_success");
  if (args.taskFamily === "package_publish_validate") out.push("publish_then_install_from_clean_client_path");
  if (args.likelyTool) out.push(`prefer_tool:${args.likelyTool}`);
  return uniqueStrings(out, 12);
}

function synthesizeNextAction(args: {
  steps: NormalizedStep[];
  taskFamily: string | null;
  targetFiles: string[];
  acceptanceChecks: string[];
  serviceConstraints: ServiceLifecycleConstraintV1[];
}): string | null {
  if (args.taskFamily === "package_publish_validate") {
    const target = args.targetFiles.slice(0, 2).join(" and ") || "the package index and package payload";
    const includesApiContract = args.acceptanceChecks.some((check) => /\bpython(?:3)?\s+-c\b.*\bassert\b|\bvector_norm\b|\bping\(\)/i.test(check));
    const validation = includesApiContract
      ? "index visibility, clean-client install, and installed package API behavior"
      : "index visibility and clean-client install";
    return `Update ${target}, rebuild the package artifacts and simple index, then validate ${validation} from a fresh shell.`;
  }
  for (const step of [...args.steps].reverse()) {
    for (const text of step.texts) {
      const lowered = text.toLowerCase();
      if (NOISE_PATTERNS.some((pattern) => lowered.includes(pattern))) continue;
      if (text.length < 16) continue;
      if (text.length > 400) continue;
      if (step.role === "assistant" || step.role === "system" || step.kind === "summary") return text;
    }
  }
  const target = args.targetFiles[0] ?? "the narrow target files";
  const check = args.acceptanceChecks[0] ?? null;
  if (args.serviceConstraints.length > 0 && check) {
    return `Update ${target}, relaunch the service in detached mode, and rerun ${check} from a fresh shell.`;
  }
  if (check) return `Update ${target} and rerun ${check}.`;
  if (args.targetFiles.length > 0) return `Continue on ${args.targetFiles.join(" | ")} and validate the narrowest failing slice.`;
  return null;
}

function deriveSignature(prefix: string, payload: unknown): string {
  return `${prefix}:${sha256Hex(stableStringify(payload)).slice(0, 24)}`;
}

function buildRecallKeywords(args: {
  taskFamily: string | null;
  targetFiles: string[];
  patternHints: string[];
  workflowSteps: string[];
}): string[] {
  const fileNames = args.targetFiles.map((file) => file.split("/").pop() ?? file);
  return uniqueStrings([
    args.taskFamily,
    ...fileNames,
    ...args.patternHints.map((hint) => hint.replace(/^prefer_tool:/, "")),
    ...args.workflowSteps.slice(0, 4).map((step) => step.split(/\s+/).slice(0, 3).join("_")),
  ], 12);
}

export function buildTrajectoryCompileLite(body: unknown, defaults: {
  defaultScope: string;
  defaultTenantId: string;
}): TrajectoryCompileResponse {
  const parsed: TrajectoryCompileInput = TrajectoryCompileRequest.parse(body);
  const steps = parsed.trajectory.steps.map(normalizeStep);
  const targetFiles = uniqueStrings(
    [
      ...(parsed.hints?.target_files ?? []),
      ...steps.flatMap((step) => step.file_paths),
    ],
    24,
  );
  const acceptanceChecks = extractAcceptanceChecks(steps, parsed.hints?.acceptance_checks ?? []);
  const likelyTool = inferLikelyTool(steps);
  const workflowSteps = extractWorkflowSteps(steps);
  const taskFamily = inferTaskFamily(parsed.query_text, steps, parsed.trajectory.task_family ?? null);
  const serviceConstraints = extractServiceLifecycleConstraints(parsed.query_text, steps, acceptanceChecks, taskFamily);
  const successInvariants = extractSuccessInvariants({
    queryText: parsed.query_text,
    steps,
    taskFamily,
    targetFiles,
    acceptanceChecks,
    serviceConstraints,
    hintInvariants: parsed.hints?.success_invariants ?? [],
  });
  const dependencyRequirements = extractDependencyRequirements({
    queryText: parsed.query_text,
    steps,
    taskFamily,
    serviceConstraints,
    hintRequirements: parsed.hints?.dependency_requirements ?? [],
  });
  const environmentAssumptions = extractEnvironmentAssumptions({
    queryText: parsed.query_text,
    steps,
    repoRoot: parsed.hints?.repo_root ?? null,
    acceptanceChecks,
    serviceConstraints,
    hintAssumptions: parsed.hints?.environment_assumptions ?? [],
  });
  const mustHoldAfterExit = extractMustHoldAfterExit({
    queryText: parsed.query_text,
    steps,
    taskFamily,
    acceptanceChecks,
    serviceConstraints,
    hintMustHold: parsed.hints?.must_hold_after_exit ?? [],
  });
  const externalVisibilityRequirements = extractExternalVisibilityRequirements({
    queryText: parsed.query_text,
    steps,
    taskFamily,
    acceptanceChecks,
    serviceConstraints,
    hintRequirements: parsed.hints?.external_visibility_requirements ?? [],
  });
  const patternHints = extractPatternHints({
    taskFamily,
    targetFiles,
    acceptanceChecks,
    serviceConstraints,
    likelyTool,
  });
  const noiseMarkers = extractNoiseMarkers(steps);
  const nextAction = synthesizeNextAction({
    steps,
    taskFamily,
    targetFiles,
    acceptanceChecks,
    serviceConstraints,
  });
  const taskSignature = deriveSignature("trajectory_task", {
    query_text: parsed.query_text,
    task_family: taskFamily,
    target_files: targetFiles,
  });
  const workflowSignature = deriveSignature("trajectory_workflow", {
    task_family: taskFamily,
    target_files: targetFiles,
    workflow_steps: workflowSteps,
    acceptance_checks: acceptanceChecks,
  });
  const keySteps = workflowSteps.slice(0, 12);
  const recallKeywords = buildRecallKeywords({
    taskFamily,
    targetFiles,
    patternHints,
    workflowSteps,
  });

  return TrajectoryCompileResponseSchema.parse({
    summary_version: "trajectory_compile_v1",
    tenant_id: parsed.tenant_id ?? defaults.defaultTenantId,
    scope: parsed.scope ?? defaults.defaultScope,
    query_text: parsed.query_text,
    compiler_version: "trajectory_compile_v1",
    task_family: taskFamily,
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    contract: {
      target_files: targetFiles,
      acceptance_checks: acceptanceChecks,
      success_invariants: successInvariants,
      dependency_requirements: dependencyRequirements,
      environment_assumptions: environmentAssumptions,
      must_hold_after_exit: mustHoldAfterExit,
      external_visibility_requirements: externalVisibilityRequirements,
      next_action: nextAction,
      workflow_steps: workflowSteps,
      pattern_hints: patternHints,
      likely_tool: likelyTool,
      service_lifecycle_constraints: serviceConstraints,
      noise_markers: noiseMarkers,
    },
    promotion_seed: {
      task_family: taskFamily,
      task_signature: taskSignature,
      workflow_signature: workflowSignature,
      key_steps: keySteps,
      recall_keywords: recallKeywords,
    },
    diagnostics: {
      step_count: steps.length,
      command_count: steps.reduce((sum, step) => sum + step.commands.length, 0),
      target_file_count: targetFiles.length,
      acceptance_check_count: acceptanceChecks.length,
      workflow_step_count: workflowSteps.length,
      service_constraint_count: serviceConstraints.length,
      noise_marker_count: noiseMarkers.length,
    },
  });
}
