import type { AionisClientOptions, AionisGuideMode } from "@aionis/sdk";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AionisMcpConfig = {
  baseUrl: string;
  apiKey?: string;
  tenant_id?: string;
  scope?: string;
  scope_from?: AionisMcpScopeSource;
  workspace_identity_store?: AionisMcpWorkspaceIdentityStore;
  repo_root?: string;
  default_guide_mode?: AionisGuideMode | null;
};

export type AionisMcpScopeSource = "workspace" | "git" | "cwd" | "none";
export type AionisMcpWorkspaceIdentityStore = "project" | "user";

export type AionisMcpConfigParseOptions = {
  cwd?: string;
};

export type AionisMcpWorkspaceIdentity = {
  contract_version: "aionis_mcp_workspace_identity_v1";
  workspace_id: string;
  scope: string;
  created_at: string;
  updated_at: string;
  aliases: string[];
};

export const DEFAULT_AIONIS_BASE_URL = "http://127.0.0.1:3001";
export const AIONIS_WORKSPACE_IDENTITY_PATH = ".aionis/workspace.json";
export const AIONIS_USER_WORKSPACE_IDENTITY_DIR = path.join(".aionis", "claude-code", "workspaces");

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseGuideMode(value: string): AionisGuideMode | null {
  if (value === "full_power" || value === "standard") return value;
  if (value === "none" || value === "off") return null;
  throw new Error(`Unsupported guide mode "${value}". Use full_power, standard, or none.`);
}

function parseScopeSource(value: string | undefined): AionisMcpScopeSource | undefined {
  if (!value) return undefined;
  if (value === "workspace" || value === "git" || value === "cwd" || value === "none") return value;
  throw new Error(`Unsupported scope source "${value}". Use workspace, git, cwd, or none.`);
}

function parseWorkspaceIdentityStore(value: string | undefined): AionisMcpWorkspaceIdentityStore | undefined {
  if (!value) return undefined;
  if (value === "project" || value === "user") return value;
  throw new Error(`Unsupported workspace id store "${value}". Use project or user.`);
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

function resolveRepoRoot(inputRoot: string, cwd: string): string {
  const resolved = path.resolve(cwd, inputRoot);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function deriveGitScopeStrict(root: string): string | undefined {
  const gitRoot = tryGit(["rev-parse", "--show-toplevel"], root);
  if (!gitRoot) return undefined;
  const workspaceRoot = resolveRepoRoot(gitRoot, root);
  const origin = tryGit(["remote", "get-url", "origin"], workspaceRoot);
  const identity = origin || workspaceRoot;
  const basenameSource = origin ? origin.split(/[/:]/).filter(Boolean).at(-1) ?? directoryBasename(workspaceRoot) : directoryBasename(workspaceRoot);
  return `git:${slugifyScopePart(basenameSource)}:${shortHash(identity)}`;
}

function deriveGitScope(root: string): string {
  return deriveGitScopeStrict(root) ?? deriveCwdScope(root);
}

function deriveCwdScope(root: string): string {
  const workspaceRoot = resolveRepoRoot(root, process.cwd());
  return `cwd:${slugifyScopePart(directoryBasename(workspaceRoot))}:${shortHash(workspaceRoot)}`;
}

function workspaceIdentityFile(root: string, store: AionisMcpWorkspaceIdentityStore = "project"): string {
  if (store === "user") {
    return path.join(
      os.homedir(),
      AIONIS_USER_WORKSPACE_IDENTITY_DIR,
      `${shortHash(resolveRepoRoot(root, process.cwd()))}.json`,
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

function isWorkspaceIdentity(value: unknown): value is AionisMcpWorkspaceIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AionisMcpWorkspaceIdentity>;
  return record.contract_version === "aionis_mcp_workspace_identity_v1"
    && typeof record.workspace_id === "string"
    && typeof record.scope === "string"
    && typeof record.created_at === "string"
    && typeof record.updated_at === "string"
    && Array.isArray(record.aliases)
    && record.aliases.every((alias) => typeof alias === "string");
}

function readWorkspaceIdentity(file: string): AionisMcpWorkspaceIdentity | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isWorkspaceIdentity(parsed)) {
    throw new Error(`Invalid Aionis workspace identity file at ${file}`);
  }
  return parsed;
}

function writeWorkspaceIdentity(file: string, identity: AionisMcpWorkspaceIdentity): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

function createWorkspaceIdentity(root: string, now = new Date().toISOString()): AionisMcpWorkspaceIdentity {
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

function deriveWorkspaceScope(root: string, store: AionisMcpWorkspaceIdentityStore = "project"): string {
  const file = workspaceIdentityFile(root, store);
  const now = new Date().toISOString();
  const existing = readWorkspaceIdentity(file);
  if (!existing) {
    const created = createWorkspaceIdentity(root, now);
    writeWorkspaceIdentity(file, created);
    return created.scope;
  }

  const aliases = Array.from(new Set([...existing.aliases, ...stableAliases(root)]));
  const updated: AionisMcpWorkspaceIdentity = {
    ...existing,
    updated_at: aliases.length === existing.aliases.length ? existing.updated_at : now,
    aliases,
  };
  if (updated.updated_at !== existing.updated_at) {
    writeWorkspaceIdentity(file, updated);
  }
  return existing.scope;
}

export function deriveAionisMcpScope(input: {
  source: AionisMcpScopeSource;
  repoRoot?: string;
  cwd?: string;
  workspaceIdentityStore?: AionisMcpWorkspaceIdentityStore;
}): string | undefined {
  if (input.source === "none") return undefined;
  const cwd = input.cwd ? resolveRepoRoot(input.cwd, process.cwd()) : process.cwd();
  const root = input.repoRoot ? resolveRepoRoot(input.repoRoot, cwd) : cwd;
  if (input.source === "workspace") return deriveWorkspaceScope(root, input.workspaceIdentityStore ?? "project");
  if (input.source === "git") return deriveGitScope(root);
  return deriveCwdScope(root);
}

export function aionisMcpUsage(): string {
  return `Usage:
  npx @aionis/mcp [options]

Options:
  --base-url <url>          Aionis Runtime URL. Defaults to AIONIS_BASE_URL or ${DEFAULT_AIONIS_BASE_URL}
  --api-key <key>           Runtime bearer token. Prefer AIONIS_API_KEY for shell history safety.
  --tenant <id>             Default tenant id. Defaults to AIONIS_TENANT_ID.
  --scope <scope>           Default memory scope. Defaults to AIONIS_SCOPE.
  --scope-from <workspace|git|cwd|none>
                            Derive default scope when --scope is not set.
                            workspace persists .aionis/workspace.json and keeps git/cwd aliases stable.
                            Defaults to AIONIS_SCOPE_FROM, or none.
  --workspace-id-store <project|user>
                            Where workspace scope ids are stored when --scope-from workspace is used.
                            project writes .aionis/workspace.json. user writes ~/.aionis/claude-code/workspaces.
                            Defaults to AIONIS_WORKSPACE_ID_STORE, or project.
  --repo-root <path>         Workspace/repo root used by --scope-from. Defaults to AIONIS_REPO_ROOT or cwd.
  --mode <name>             full_power, standard, or none. Defaults to AIONIS_GUIDE_MODE or full_power.
  -h, --help                Show help.

Examples:
  npx @aionis/mcp --base-url http://127.0.0.1:3001 --tenant local --scope my-project
  npx @aionis/mcp --base-url http://127.0.0.1:3001 --scope-from workspace
  npx @aionis/mcp --base-url http://127.0.0.1:3001 --scope-from git
  npx @aionis/mcp --base-url http://127.0.0.1:3001 --scope-from workspace --repo-root /path/to/repo
  npx @aionis/mcp --base-url http://127.0.0.1:3001 --scope-from workspace --workspace-id-store user
  AIONIS_BASE_URL=http://127.0.0.1:3001 AIONIS_SCOPE=my-project npx @aionis/mcp
`;
}

export function parseAionisMcpConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  options: AionisMcpConfigParseOptions = {},
): AionisMcpConfig {
  let baseUrl = env.AIONIS_BASE_URL?.trim() || env.AIONIS_PRODUCT_E2E_BASE_URL?.trim() || DEFAULT_AIONIS_BASE_URL;
  let apiKey = env.AIONIS_API_KEY?.trim() || undefined;
  let tenantId = env.AIONIS_TENANT_ID?.trim() || env.AIONIS_TENANT?.trim() || undefined;
  let scope = env.AIONIS_SCOPE?.trim() || undefined;
  let scopeFrom = parseScopeSource(env.AIONIS_SCOPE_FROM?.trim());
  let workspaceIdentityStore = parseWorkspaceIdentityStore(env.AIONIS_WORKSPACE_ID_STORE?.trim()) ?? "project";
  let repoRoot = env.AIONIS_REPO_ROOT?.trim() || undefined;
  let defaultGuideMode = parseGuideMode(env.AIONIS_GUIDE_MODE?.trim() || "full_power");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(aionisMcpUsage());
      process.exit(0);
    }
    if (arg === "--base-url") {
      baseUrl = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      apiKey = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--tenant") {
      tenantId = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--scope") {
      scope = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--scope-from") {
      scopeFrom = parseScopeSource(readFlagValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--workspace-id-store") {
      workspaceIdentityStore = parseWorkspaceIdentityStore(readFlagValue(argv, i, arg)) ?? "project";
      i += 1;
      continue;
    }
    if (arg === "--repo-root") {
      repoRoot = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      defaultGuideMode = parseGuideMode(readFlagValue(argv, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown option "${arg}"`);
  }

  if (!scope && scopeFrom && scopeFrom !== "none") {
    scope = deriveAionisMcpScope({
      source: scopeFrom,
      repoRoot,
      cwd: options.cwd,
      workspaceIdentityStore,
    });
  }

  return {
    baseUrl,
    apiKey,
    tenant_id: tenantId,
    scope,
    ...(scopeFrom ? { scope_from: scopeFrom } : {}),
    ...(scopeFrom === "workspace" ? { workspace_identity_store: workspaceIdentityStore } : {}),
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    default_guide_mode: defaultGuideMode,
  };
}

export function clientOptionsFromMcpConfig(config: AionisMcpConfig): AionisClientOptions {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenant_id: config.tenant_id,
    scope: config.scope,
    default_guide_mode: config.default_guide_mode,
  };
}
