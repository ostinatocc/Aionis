#!/usr/bin/env node
import {
  compileExecutionAgentContext,
  createAionisClient,
  type AionisClient,
  type AionisGuideMode,
  type AionisJsonObject,
  type AionisRequestOptions,
} from "@aionis/sdk";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AionisClaudeCodeCommand = "install" | "onboard" | "doctor" | "status" | "hook";
export type AionisClaudeCodeSettingsTarget = "local" | "project" | "user";
export type AionisClaudeCodeScopeSource = "workspace" | "git" | "cwd" | "none";
export type AionisClaudeCodeWorkspaceIdentityStore = "project" | "user";

export type AionisClaudeCodeOptions = {
  command: AionisClaudeCodeCommand;
  baseUrl: string;
  apiKey?: string;
  tenant_id?: string;
  scope?: string;
  scope_from: AionisClaudeCodeScopeSource;
  repo_root?: string;
  mode: AionisGuideMode | null;
  settings: AionisClaudeCodeSettingsTarget;
  mcp_name: string;
  claude_scope: "local" | "project" | "user";
  package_spec: string;
  mcp_package_spec: string;
  workspace_identity_store: AionisClaudeCodeWorkspaceIdentityStore;
  skip_mcp: boolean;
  dry_run: boolean;
  max_prompt_chars: number;
};

export type AionisClaudeCodeWorkspaceIdentity = {
  contract_version: "aionis_mcp_workspace_identity_v1";
  workspace_id: string;
  scope: string;
  created_at: string;
  updated_at: string;
  aliases: string[];
};

export type AionisHookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  source?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  trigger?: string;
  custom_instructions?: string;
  compact_summary?: string;
  reason?: string;
  agent_type?: string;
  model?: string;
};

export type AionisHookClient = Pick<AionisClient, "health"> & {
  execution: Pick<AionisClient["execution"], "guideForRole" | "observeStep" | "handoff">;
};

export const DEFAULT_AIONIS_BASE_URL = "http://127.0.0.1:3001";
export const DEFAULT_PACKAGE_SPEC = "@aionis/claude-code@latest";
export const DEFAULT_MCP_PACKAGE_SPEC = "@aionis/mcp@latest";
export const AIONIS_WORKSPACE_IDENTITY_PATH = ".aionis/workspace.json";
export const AIONIS_USER_WORKSPACE_IDENTITY_DIR = path.join(".aionis", "claude-code", "workspaces");

function usage(): string {
  return `Usage:
  npx @aionis/claude-code onboard [options]
  npx @aionis/claude-code install [options]
  npx @aionis/claude-code doctor [options]
  npx @aionis/claude-code status [options]
  npx @aionis/claude-code hook [options]

Options:
  --base-url <url>          Aionis Runtime URL. Defaults to AIONIS_BASE_URL or ${DEFAULT_AIONIS_BASE_URL}
  --api-key <key>           Runtime bearer token. Prefer AIONIS_API_KEY for shell history safety.
  --tenant <id>             Aionis tenant id. Defaults to AIONIS_TENANT_ID.
  --scope <scope>           Explicit Aionis scope. Defaults to AIONIS_SCOPE.
  --scope-from <source>     workspace, git, cwd, or none. Defaults to workspace.
  --repo-root <path>        Workspace root for install/status. Hooks use Claude's cwd by default.
  --mode <name>             full_power, standard, or none. Defaults to full_power.
  --settings <target>       local, project, or user. Defaults to local (.claude/settings.local.json).
                            onboard defaults to user-level hooks.
  --mcp-name <name>         Claude MCP server name. Defaults to aionis-local.
  --claude-scope <scope>    MCP config scope: local, project, or user. Defaults to local.
                            onboard defaults to user.
  --global                  Shortcut for --settings user --claude-scope user --workspace-id-store user.
  --package <spec>          Hook package spec written to settings. Defaults to ${DEFAULT_PACKAGE_SPEC}
  --mcp-package <spec>      MCP package spec. Defaults to ${DEFAULT_MCP_PACKAGE_SPEC}
  --workspace-id-store <project|user>
                            Where stable workspace ids are stored. onboard defaults to user.
  --skip-mcp               Write hooks but do not run claude mcp add.
  --dry-run                Print planned changes without writing files or running claude mcp add.
  --max-prompt-chars <n>   Maximum injected Aionis prompt chars. Defaults to 8000.
  -h, --help               Show help.
`;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseGuideMode(value: string): AionisGuideMode | null {
  if (value === "full_power" || value === "standard") return value;
  if (value === "none" || value === "off") return null;
  throw new Error(`Unsupported mode "${value}". Use full_power, standard, or none.`);
}

function parseScopeSource(value: string): AionisClaudeCodeScopeSource {
  if (value === "workspace" || value === "git" || value === "cwd" || value === "none") return value;
  throw new Error(`Unsupported scope source "${value}". Use workspace, git, cwd, or none.`);
}

function parseSettingsTarget(value: string): AionisClaudeCodeSettingsTarget {
  if (value === "local" || value === "project" || value === "user") return value;
  throw new Error(`Unsupported settings target "${value}". Use local, project, or user.`);
}

function parseClaudeScope(value: string): "local" | "project" | "user" {
  if (value === "local" || value === "project" || value === "user") return value;
  throw new Error(`Unsupported Claude MCP scope "${value}". Use local, project, or user.`);
}

function parseWorkspaceIdentityStore(value: string): AionisClaudeCodeWorkspaceIdentityStore {
  if (value === "project" || value === "user") return value;
  throw new Error(`Unsupported workspace id store "${value}". Use project or user.`);
}

export function parseAionisClaudeCodeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): AionisClaudeCodeOptions {
  const commandArg = argv[0] && !argv[0].startsWith("-") ? argv[0] : "install";
  if (commandArg === "-h" || commandArg === "--help") {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (commandArg !== "install" && commandArg !== "onboard" && commandArg !== "doctor" && commandArg !== "status" && commandArg !== "hook") {
    throw new Error(`Unknown command "${commandArg}". Use install, onboard, doctor, status, or hook.`);
  }
  const command = commandArg;
  const rest = commandArg === argv[0] ? argv.slice(1) : argv;
  const onboardDefaults = command === "onboard";

  const options: AionisClaudeCodeOptions = {
    command,
    baseUrl: env.AIONIS_BASE_URL?.trim() || DEFAULT_AIONIS_BASE_URL,
    apiKey: env.AIONIS_API_KEY?.trim() || undefined,
    tenant_id: env.AIONIS_TENANT_ID?.trim() || "default",
    scope: env.AIONIS_SCOPE?.trim() || undefined,
    scope_from: parseScopeSource(env.AIONIS_SCOPE_FROM?.trim() || "workspace"),
    repo_root: env.AIONIS_REPO_ROOT?.trim() || undefined,
    mode: parseGuideMode(env.AIONIS_GUIDE_MODE?.trim() || "full_power"),
    settings: onboardDefaults ? "user" : "local",
    mcp_name: "aionis-local",
    claude_scope: onboardDefaults ? "user" : "local",
    package_spec: DEFAULT_PACKAGE_SPEC,
    mcp_package_spec: DEFAULT_MCP_PACKAGE_SPEC,
    workspace_identity_store: parseWorkspaceIdentityStore(
      env.AIONIS_WORKSPACE_ID_STORE?.trim() || (onboardDefaults ? "user" : "project"),
    ),
    skip_mcp: false,
    dry_run: false,
    max_prompt_chars: Number.parseInt(env.AIONIS_CLAUDE_CODE_MAX_PROMPT_CHARS || "8000", 10),
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--base-url") {
      options.baseUrl = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      options.apiKey = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--tenant") {
      options.tenant_id = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--scope") {
      options.scope = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--scope-from") {
      options.scope_from = parseScopeSource(readFlagValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--repo-root") {
      options.repo_root = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      options.mode = parseGuideMode(readFlagValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--settings") {
      options.settings = parseSettingsTarget(readFlagValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--global") {
      options.settings = "user";
      options.claude_scope = "user";
      options.workspace_identity_store = "user";
      continue;
    }
    if (arg === "--mcp-name") {
      options.mcp_name = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--claude-scope") {
      options.claude_scope = parseClaudeScope(readFlagValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--package") {
      options.package_spec = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--mcp-package") {
      options.mcp_package_spec = readFlagValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--workspace-id-store") {
      options.workspace_identity_store = parseWorkspaceIdentityStore(readFlagValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--skip-mcp") {
      options.skip_mcp = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dry_run = true;
      continue;
    }
    if (arg === "--max-prompt-chars") {
      const parsed = Number.parseInt(readFlagValue(rest, i, arg), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--max-prompt-chars must be a positive integer");
      options.max_prompt_chars = parsed;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option "${arg}"`);
  }

  return options;
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function slugifyScopePart(value: string): string {
  const slug = value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "workspace";
}

function directoryBasename(value: string): string {
  return path.basename(path.resolve(value)) || "workspace";
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveRoot(inputRoot: string | undefined, fallbackCwd: string): string {
  const root = inputRoot ? path.resolve(fallbackCwd, inputRoot) : fallbackCwd;
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

function deriveGitScopeStrict(root: string): string | undefined {
  const gitRoot = tryGit(["rev-parse", "--show-toplevel"], root);
  if (!gitRoot) return undefined;
  const workspaceRoot = resolveRoot(gitRoot, root);
  const origin = tryGit(["remote", "get-url", "origin"], workspaceRoot);
  const identity = origin || workspaceRoot;
  const basenameSource = origin
    ? origin.split(/[/:]/).filter(Boolean).at(-1) ?? directoryBasename(workspaceRoot)
    : directoryBasename(workspaceRoot);
  return `git:${slugifyScopePart(basenameSource)}:${shortHash(identity)}`;
}

function deriveCwdScope(root: string): string {
  return `cwd:${slugifyScopePart(directoryBasename(root))}:${shortHash(root)}`;
}

function workspaceIdentityFile(root: string, store: AionisClaudeCodeWorkspaceIdentityStore = "project"): string {
  if (store === "user") {
    return path.join(
      os.homedir(),
      AIONIS_USER_WORKSPACE_IDENTITY_DIR,
      `${shortHash(resolveRoot(root, process.cwd()))}.json`,
    );
  }
  return path.join(root, AIONIS_WORKSPACE_IDENTITY_PATH);
}

function stableAliases(root: string): string[] {
  const aliases = [deriveCwdScope(root)];
  const gitScope = deriveGitScopeStrict(root);
  if (gitScope) aliases.push(gitScope);
  return Array.from(new Set(aliases));
}

function isWorkspaceIdentity(value: unknown): value is AionisClaudeCodeWorkspaceIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AionisClaudeCodeWorkspaceIdentity>;
  return record.contract_version === "aionis_mcp_workspace_identity_v1"
    && typeof record.workspace_id === "string"
    && typeof record.scope === "string"
    && typeof record.created_at === "string"
    && typeof record.updated_at === "string"
    && Array.isArray(record.aliases)
    && record.aliases.every((alias) => typeof alias === "string");
}

function readWorkspaceIdentity(file: string): AionisClaudeCodeWorkspaceIdentity | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isWorkspaceIdentity(parsed)) throw new Error(`Invalid Aionis workspace identity file at ${file}`);
  return parsed;
}

function writeWorkspaceIdentity(file: string, identity: AionisClaudeCodeWorkspaceIdentity): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

function createWorkspaceIdentity(root: string, now = new Date().toISOString()): AionisClaudeCodeWorkspaceIdentity {
  const workspaceId = crypto.randomBytes(6).toString("hex");
  return {
    contract_version: "aionis_mcp_workspace_identity_v1",
    workspace_id: workspaceId,
    scope: `ws:${slugifyScopePart(directoryBasename(root))}:${workspaceId}`,
    created_at: now,
    updated_at: now,
    aliases: stableAliases(root),
  };
}

function deriveWorkspaceScope(root: string, store: AionisClaudeCodeWorkspaceIdentityStore = "project"): string {
  const file = workspaceIdentityFile(root, store);
  const now = new Date().toISOString();
  const existing = readWorkspaceIdentity(file);
  if (!existing) {
    const created = createWorkspaceIdentity(root, now);
    writeWorkspaceIdentity(file, created);
    return created.scope;
  }

  const aliases = Array.from(new Set([...existing.aliases, ...stableAliases(root)]));
  const updated: AionisClaudeCodeWorkspaceIdentity = {
    ...existing,
    aliases,
    updated_at: aliases.length === existing.aliases.length ? existing.updated_at : now,
  };
  if (updated.updated_at !== existing.updated_at) writeWorkspaceIdentity(file, updated);
  return existing.scope;
}

export function deriveAionisClaudeCodeScope(input: {
  explicitScope?: string;
  source: AionisClaudeCodeScopeSource;
  repoRoot?: string;
  cwd?: string;
  workspaceIdentityStore?: AionisClaudeCodeWorkspaceIdentityStore;
}): string | undefined {
  const explicit = input.explicitScope?.trim();
  if (explicit) return explicit;
  if (input.source === "none") return undefined;
  const cwd = resolveRoot(input.cwd, process.cwd());
  const root = resolveRoot(input.repoRoot, cwd);
  if (input.source === "workspace") return deriveWorkspaceScope(root, input.workspaceIdentityStore ?? "project");
  if (input.source === "git") return deriveGitScopeStrict(root) ?? deriveCwdScope(root);
  return deriveCwdScope(root);
}

function settingsPath(target: AionisClaudeCodeSettingsTarget, root: string): string {
  if (target === "user") return path.join(os.homedir(), ".claude", "settings.json");
  const filename = target === "local" ? "settings.local.json" : "settings.json";
  return path.join(root, ".claude", filename);
}

function readJsonFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected object JSON in ${file}`);
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAionisHookGroup(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  return hooks.some((hook) => {
    if (!isRecord(hook)) return false;
    const command = typeof hook.command === "string" ? hook.command : "";
    const args = Array.isArray(hook.args) ? hook.args.filter((arg): arg is string => typeof arg === "string") : [];
    return command.includes("@aionis/claude-code")
      || command.includes("aionis-claude-code")
      || args.some((arg) => arg.includes("@aionis/claude-code") || arg === "hook");
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function filePackageEntrypoint(packageSpec: string): string | null {
  if (!packageSpec.startsWith("file:")) return null;
  const raw = packageSpec.slice("file:".length);
  const packageRoot = raw.startsWith("/")
    ? raw
    : fileURLToPath(packageSpec.endsWith("/") ? packageSpec : `${packageSpec}/`);
  const entrypoint = path.join(packageRoot, "dist", "index.js");
  return fs.existsSync(entrypoint) ? entrypoint : null;
}

function hookCommand(options: AionisClaudeCodeOptions): string {
  const fileEntrypoint = filePackageEntrypoint(options.package_spec);
  const prefix = fileEntrypoint
    ? ["node", fileEntrypoint]
    : ["npx", "-y", options.package_spec];
  const args = [
    "hook",
    "--base-url",
    options.baseUrl,
    "--scope-from",
    options.scope_from,
    "--workspace-id-store",
    options.workspace_identity_store,
    "--mode",
    options.mode ?? "none",
    "--max-prompt-chars",
    String(options.max_prompt_chars),
  ];
  if (options.apiKey) args.push("--api-key", options.apiKey);
  if (options.tenant_id) args.push("--tenant", options.tenant_id);
  if (options.scope) args.push("--scope", options.scope);
  return [prefix[0], ...prefix.slice(1).map(shellQuote), ...args.map(shellQuote)].join(" ");
}

function aionisHookGroup(
  options: AionisClaudeCodeOptions,
  matcher: string,
  timeout: number,
): Record<string, unknown> {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command: hookCommand(options),
        timeout,
      },
    ],
  };
}

export function nextClaudeCodeSettings(
  current: Record<string, unknown>,
  options: AionisClaudeCodeOptions,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const hooks = isRecord(next.hooks) ? { ...next.hooks } : {};
  const desired: Array<[string, string, number]> = [
    ["SessionStart", "startup|resume|clear|compact", 10],
    ["UserPromptSubmit", "", 25],
    ["PostToolUse", "Bash|Edit|Write", 10],
    ["PostToolUseFailure", "Bash|Edit|Write", 10],
    ["PreCompact", "manual|auto", 10],
    ["PostCompact", "manual|auto", 10],
    ["SessionEnd", "clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other", 10],
  ];

  for (const [event, matcher, timeout] of desired) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    hooks[event] = [
      ...existing.filter((group) => !isAionisHookGroup(group)),
      aionisHookGroup(options, matcher, timeout),
    ];
  }
  next.hooks = hooks;
  return next;
}

function instructionsPath(options: AionisClaudeCodeOptions, root: string): string {
  if (options.settings === "user") return path.join(os.homedir(), ".claude", "aionis-instructions.md");
  return path.join(root, ".claude", "aionis-instructions.md");
}

function writeInstructions(options: AionisClaudeCodeOptions, root: string, dryRun: boolean): string {
  const instructionsPathValue = instructionsPath(options, root);
  const body = `# Aionis Claude Code Integration

Aionis is active for this workspace.

- Use the Aionis context injected before each prompt as the current execution-memory contract.
- Treat use_now and CURRENT_ACTIVE_PATH as actionable.
- Treat inspect_before_use as reference only.
- Treat do_not_use / failed / stale / contested memory as blocked for direct action.
- Preserve important decisions, failed branches, acceptance checks, and handoff state through Aionis tools when useful.
`;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(instructionsPathValue), { recursive: true });
    fs.writeFileSync(instructionsPathValue, body, "utf8");
  }
  return instructionsPathValue;
}

export function installPlan(options: AionisClaudeCodeOptions, cwd = process.cwd()): {
  root: string;
  settings_file: string;
  instructions_file: string;
  mcp_command: string[] | null;
} {
  const root = resolveRoot(options.repo_root, cwd);
  const mcpCommand = options.skip_mcp ? null : [
    "claude",
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    options.claude_scope,
    options.mcp_name,
    "--",
    "npx",
    "-y",
    options.mcp_package_spec,
    "--base-url",
    options.baseUrl,
    "--scope-from",
    options.scope_from,
    "--mode",
    options.mode ?? "none",
  ];
  if (mcpCommand && options.apiKey) mcpCommand.push("--api-key", options.apiKey);
  if (mcpCommand && options.tenant_id) mcpCommand.push("--tenant", options.tenant_id);
  if (mcpCommand && options.scope) mcpCommand.push("--scope", options.scope);
  return {
    root,
    settings_file: settingsPath(options.settings, root),
    instructions_file: instructionsPath(options, root),
    mcp_command: mcpCommand,
  };
}

function run(command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

export async function installAionisClaudeCode(options: AionisClaudeCodeOptions, cwd = process.cwd()): Promise<{
  root: string;
  settings_file: string;
  instructions_file: string;
  mcp_status: "skipped" | "planned" | "installed" | "failed";
  mcp_error?: string;
}> {
  const plan = installPlan(options, cwd);
  if (!options.dry_run) {
    const current = readJsonFile(plan.settings_file);
    const next = nextClaudeCodeSettings(current, options);
    fs.mkdirSync(path.dirname(plan.settings_file), { recursive: true });
    fs.writeFileSync(plan.settings_file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  const instructionsFile = writeInstructions(options, plan.root, options.dry_run);
  let mcpStatus: "skipped" | "planned" | "installed" | "failed" = options.skip_mcp ? "skipped" : options.dry_run ? "planned" : "installed";
  let mcpError: string | undefined;
  if (plan.mcp_command && !options.dry_run) {
    const [command, ...args] = plan.mcp_command;
    const result = run(command, args, plan.root);
    if (result.status !== 0) {
      const errorText = result.stderr.trim() || result.stdout.trim() || `claude mcp add exited with ${result.status ?? "unknown"}`;
      if (/already exists/i.test(errorText)) {
        mcpStatus = "installed";
      } else {
        mcpStatus = "failed";
        mcpError = errorText;
      }
    }
  }

  return {
    root: plan.root,
    settings_file: plan.settings_file,
    instructions_file: instructionsFile,
    mcp_status: mcpStatus,
    mcp_error: mcpError,
  };
}

function hooksInstalledForTarget(target: AionisClaudeCodeSettingsTarget, root: string): {
  target: AionisClaudeCodeSettingsTarget;
  settings_file: string;
  hooks_installed: boolean;
} {
  const file = settingsPath(target, root);
  const settings = readJsonFile(file);
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  return {
    target,
    settings_file: file,
    hooks_installed: Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(isAionisHookGroup)),
  };
}

export async function doctorAionisClaudeCode(options: AionisClaudeCodeOptions, cwd = process.cwd()): Promise<{
  ready: boolean;
  runtime_ok: boolean;
  base_url: string;
  scope?: string;
  workspace_identity_store: AionisClaudeCodeWorkspaceIdentityStore;
  hooks: Array<ReturnType<typeof hooksInstalledForTarget>>;
  mcp: {
    checked: boolean;
    installed: boolean;
    command: string;
    error?: string;
  };
  recommendation: string;
}> {
  const root = resolveRoot(options.repo_root, cwd);
  const scope = deriveAionisClaudeCodeScope({
    explicitScope: options.scope,
    source: options.scope_from,
    repoRoot: root,
    cwd: root,
    workspaceIdentityStore: options.workspace_identity_store,
  });
  const client = createAionisClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    tenant_id: options.tenant_id,
    scope,
  });
  let runtimeOk = false;
  try {
    await client.health();
    runtimeOk = true;
  } catch {
    runtimeOk = false;
  }

  const hooks = [
    hooksInstalledForTarget("user", root),
    hooksInstalledForTarget("project", root),
    hooksInstalledForTarget("local", root),
  ];
  const mcpResult = run("claude", ["mcp", "list"], root);
  const mcpOutput = `${mcpResult.stdout}\n${mcpResult.stderr}`;
  const mcpInstalled = mcpResult.status === 0
    && mcpOutput.includes(options.mcp_name)
    && /Connected|✓/i.test(mcpOutput);
  const hooksReady = hooks.some((entry) => entry.hooks_installed);
  const ready = runtimeOk && hooksReady && mcpInstalled;
  const recommendation = ready
    ? "Aionis is ready for Claude Code. Run claude from any project."
    : "Run: npx @aionis/claude-code@latest onboard --base-url <runtime-url>";

  return {
    ready,
    runtime_ok: runtimeOk,
    base_url: options.baseUrl,
    scope,
    workspace_identity_store: options.workspace_identity_store,
    hooks,
    mcp: {
      checked: mcpResult.status !== null,
      installed: mcpInstalled,
      command: `claude mcp list`,
      ...(mcpResult.status === 0 ? {} : { error: mcpOutput.trim() || `claude mcp list exited with ${mcpResult.status ?? "unknown"}` }),
    },
    recommendation,
  };
}

export async function onboardAionisClaudeCode(options: AionisClaudeCodeOptions, cwd = process.cwd()): Promise<{
  ready: boolean;
  install: Awaited<ReturnType<typeof installAionisClaudeCode>>;
  doctor: Awaited<ReturnType<typeof doctorAionisClaudeCode>>;
  next: string[];
}> {
  const install = await installAionisClaudeCode(options, cwd);
  const doctor = await doctorAionisClaudeCode(options, cwd);
  return {
    ready: doctor.ready && install.mcp_status !== "failed",
    install,
    doctor,
    next: doctor.ready
      ? ["Open any project directory.", "Run: claude", "Aionis will inject governed execution memory automatically."]
      : [doctor.recommendation],
  };
}

function truncate(value: string, max = 800): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function textFromUnknown(value: unknown, max = 1000): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncate(value, max);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return truncate(String(value), max);
  }
}

function targetFilesFromTool(toolName: string | undefined, toolInput: unknown): string[] {
  if (!isRecord(toolInput)) return [];
  const candidates: string[] = [];
  for (const key of ["file_path", "path"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.trim()) candidates.push(value.trim());
  }
  if ((toolName === "Edit" || toolName === "Write") && candidates.length === 0) {
    const filePath = toolInput.filePath;
    if (typeof filePath === "string" && filePath.trim()) candidates.push(filePath.trim());
  }
  return Array.from(new Set(candidates));
}

function toolSummary(input: AionisHookInput): string {
  const toolName = input.tool_name ?? "tool";
  if (isRecord(input.tool_input)) {
    if (typeof input.tool_input.command === "string") return `${toolName}: ${truncate(input.tool_input.command, 600)}`;
    if (typeof input.tool_input.file_path === "string") return `${toolName}: ${input.tool_input.file_path}`;
    if (typeof input.tool_input.path === "string") return `${toolName}: ${input.tool_input.path}`;
  }
  return `${toolName}: ${textFromUnknown(input.tool_input, 600)}`;
}

function taskSignature(root: string, eventName: string | undefined): string {
  return `claude-code:${slugifyScopePart(directoryBasename(root))}:${eventName ?? "event"}`;
}

function runId(input: AionisHookInput): string {
  return `claude:${input.session_id || "session"}`;
}

function requestOptions(options: AionisClaudeCodeOptions, scope: string | undefined): AionisRequestOptions {
  return {
    tenant_id: options.tenant_id,
    scope,
  };
}

function hookJson(eventName: string, additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  });
}

function activationContext(input: AionisHookInput, scope: string | undefined, root: string, healthOk: boolean): string {
  return [
    "AIONIS_CLAUDE_CODE_ACTIVE",
    `Runtime: ${healthOk ? "reachable" : "unverified"}`,
    `Scope: ${scope ?? "default"}`,
    `Workspace: ${root}`,
    "Aionis injects governed execution memory before user prompts and records important tool outcomes after Bash/Edit/Write.",
    "Use Aionis context as a contract: use_now is actionable, inspect_before_use is reference-only, do_not_use is blocked.",
    `Session source: ${input.source ?? "unknown"}`,
  ].join("\n");
}

async function guideAdditionalContext(
  client: AionisHookClient,
  input: AionisHookInput,
  options: AionisClaudeCodeOptions,
  root: string,
  scope: string | undefined,
): Promise<string> {
  const prompt = input.prompt?.trim() || `Claude Code ${input.hook_event_name ?? "session"} in ${directoryBasename(root)}`;
  const guide = await client.execution.guideForRole({
    agent_id: "claude-code",
    role: "worker",
    run_id: runId(input),
    task_signature: taskSignature(root, input.hook_event_name),
    query_text: prompt,
    limit: 8,
    mode: options.mode ?? undefined,
    context_mode: "compact_agent",
    context_char_budget: options.max_prompt_chars,
    context_optimization_profile: "balanced",
    context: {
      hook_event_name: input.hook_event_name,
      cwd: root,
      source: input.source,
      model: input.model,
    },
    tenant_id: options.tenant_id,
    scope,
  }, requestOptions(options, scope));
  const compiled = compileExecutionAgentContext({
    guide,
    task: {
      run_id: runId(input),
      task_signature: taskSignature(root, input.hook_event_name),
      query_text: prompt,
    },
    budget_profile: "compact",
    max_prompt_chars: options.max_prompt_chars,
  });
  return [
    "AIONIS_EXECUTION_MEMORY_CONTEXT",
    "This context was injected before Claude Code processed the user prompt.",
    "Follow it as the current memory contract: use_now/CURRENT_ACTIVE_PATH are actionable; inspect_before_use is reference-only; do_not_use is blocked.",
    compiled.agent_prompt,
  ].join("\n\n");
}

export async function handleAionisClaudeCodeHook(
  input: AionisHookInput,
  options: AionisClaudeCodeOptions,
  client?: AionisHookClient,
): Promise<string | null> {
  const root = resolveRoot(options.repo_root, input.cwd ? path.resolve(input.cwd) : process.cwd());
  const scope = deriveAionisClaudeCodeScope({
    explicitScope: options.scope,
    source: options.scope_from,
    repoRoot: root,
    cwd: root,
    workspaceIdentityStore: options.workspace_identity_store,
  });
  const hookClient = client ?? createAionisClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    tenant_id: options.tenant_id,
    scope,
  });
  const eventName = input.hook_event_name ?? "Unknown";

  if (eventName === "SessionStart") {
    let healthOk = false;
    try {
      await hookClient.health();
      healthOk = true;
    } catch {
      healthOk = false;
    }
    return hookJson("SessionStart", activationContext(input, scope, root, healthOk));
  }

  if (eventName === "UserPromptSubmit") {
    const context = await guideAdditionalContext(hookClient, input, options, root, scope);
    return hookJson("UserPromptSubmit", context);
  }

  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
    const failed = eventName === "PostToolUseFailure";
    await hookClient.execution.observeStep({
      tenant_id: options.tenant_id,
      scope,
      agent_id: "claude-code",
      role: "worker",
      memory_lane: "private",
      run_id: runId(input),
      task_signature: taskSignature(root, eventName),
      title: `Claude Code ${input.tool_name ?? "tool"} ${failed ? "failed" : "completed"}`,
      summary: failed
        ? `${toolSummary(input)} failed. Response: ${textFromUnknown(input.tool_response, 700)}`
        : `${toolSummary(input)} completed. Response: ${textFromUnknown(input.tool_response, 700)}`,
      outcome: failed ? "failed" : "succeeded",
      target_files: targetFilesFromTool(input.tool_name, input.tool_input),
      tool_set: input.tool_name ? [input.tool_name] : undefined,
      raw_ref: input.tool_use_id,
      confidence: failed ? 0.7 : 0.8,
      slots: {
        hook_event_name: eventName,
        tool_name: input.tool_name,
      },
    }, requestOptions(options, scope));
    return null;
  }

  if (eventName === "PreCompact") {
    await hookClient.execution.observeStep({
      tenant_id: options.tenant_id,
      scope,
      agent_id: "claude-code",
      role: "worker",
      memory_lane: "private",
      run_id: runId(input),
      task_signature: taskSignature(root, eventName),
      title: "Claude Code compact starting",
      summary: `Claude Code is about to compact context (${input.trigger ?? "unknown"}). ${input.custom_instructions ? `Instructions: ${truncate(input.custom_instructions, 500)}` : ""}`.trim(),
      outcome: "unknown",
      slots: {
        hook_event_name: eventName,
        trigger: input.trigger,
      },
    }, requestOptions(options, scope));
    return null;
  }

  if (eventName === "PostCompact") {
    await hookClient.execution.handoff({
      tenant_id: options.tenant_id,
      scope,
      agent_id: "claude-code",
      role: "worker",
      memory_lane: "private",
      run_id: runId(input),
      task_signature: taskSignature(root, eventName),
      title: "Claude Code compacted session handoff",
      summary: input.compact_summary ? truncate(input.compact_summary, 1500) : "Claude Code compacted the session.",
      handoff_text: input.compact_summary ? truncate(input.compact_summary, 3000) : "Claude Code compacted the session.",
      outcome: "succeeded",
      handoff_kind: "task_handoff",
      continuation_hint: "Use this compacted summary as handoff evidence for future Claude Code continuation.",
      slots: {
        hook_event_name: eventName,
        trigger: input.trigger,
      },
    }, requestOptions(options, scope));
    return null;
  }

  if (eventName === "SessionEnd") {
    await hookClient.execution.handoff({
      tenant_id: options.tenant_id,
      scope,
      agent_id: "claude-code",
      role: "worker",
      memory_lane: "private",
      run_id: runId(input),
      task_signature: taskSignature(root, eventName),
      title: "Claude Code session ended",
      summary: `Claude Code session ended: ${input.reason ?? "unknown"}.`,
      handoff_text: `Claude Code session ended: ${input.reason ?? "unknown"}. Use prior Aionis records for continuation.`,
      outcome: "unknown",
      handoff_kind: "task_handoff",
      slots: {
        hook_event_name: eventName,
        reason: input.reason,
      },
    }, requestOptions(options, scope));
    return null;
  }

  return null;
}

async function readStdinJson(): Promise<AionisHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude Code hook input must be a JSON object");
  return parsed as AionisHookInput;
}

export async function statusAionisClaudeCode(options: AionisClaudeCodeOptions, cwd = process.cwd()): Promise<{
  runtime_ok: boolean;
  base_url: string;
  settings_file: string;
  hooks_installed: boolean;
  scope?: string;
}> {
  const root = resolveRoot(options.repo_root, cwd);
  const settingsFile = settingsPath(options.settings, root);
  const settings = readJsonFile(settingsFile);
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const hooksInstalled = Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(isAionisHookGroup));
  const scope = deriveAionisClaudeCodeScope({
    explicitScope: options.scope,
    source: options.scope_from,
    repoRoot: root,
    cwd: root,
    workspaceIdentityStore: options.workspace_identity_store,
  });
  const client = createAionisClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    tenant_id: options.tenant_id,
    scope,
  });
  let runtimeOk = false;
  try {
    await client.health();
    runtimeOk = true;
  } catch {
    runtimeOk = false;
  }
  return {
    runtime_ok: runtimeOk,
    base_url: options.baseUrl,
    settings_file: settingsFile,
    hooks_installed: hooksInstalled,
    scope,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseAionisClaudeCodeArgs(argv);
  if (options.command === "onboard") {
    const result = await onboardAionisClaudeCode(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (options.command === "doctor") {
    const result = await doctorAionisClaudeCode(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (options.command === "install") {
    const result = await installAionisClaudeCode(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.mcp_status === "failed") process.exitCode = 1;
    return;
  }
  if (options.command === "status") {
    process.stdout.write(`${JSON.stringify(await statusAionisClaudeCode(options), null, 2)}\n`);
    return;
  }
  try {
    const input = await readStdinJson();
    const output = await handleAionisClaudeCodeHook(input, options);
    if (output) process.stdout.write(`${output}\n`);
  } catch (err) {
    if (process.env.AIONIS_CLAUDE_CODE_DEBUG === "1") {
      process.stderr.write(`Aionis Claude Code hook skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

export function isCliEntrypoint(argvEntry: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvEntry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(argvEntry) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argvEntry) === path.resolve(modulePath);
  }
}

if (isCliEntrypoint(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`Aionis Claude Code integration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
