import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveAionisClaudeCodeScope,
  handleAionisClaudeCodeHook,
  installAionisClaudeCode,
  installPlan,
  nextClaudeCodeSettings,
  onboardAionisClaudeCode,
  parseAionisClaudeCodeArgs,
  statusAionisClaudeCode,
  type AionisClaudeCodeOptions,
  type AionisHookClient,
} from "../src/index.ts";

function baseOptions(overrides: Partial<AionisClaudeCodeOptions> = {}): AionisClaudeCodeOptions {
  return {
    command: "install",
    baseUrl: "http://127.0.0.1:3101",
    tenant_id: "default",
    scope_from: "workspace",
    mode: "full_power",
    settings: "local",
    mcp_name: "aionis-local",
    claude_scope: "local",
    package_spec: "@aionis/claude-code@latest",
    mcp_package_spec: "@aionis/mcp@latest",
    workspace_identity_store: "project",
    skip_mcp: true,
    dry_run: false,
    max_prompt_chars: 4000,
    ...overrides,
  };
}

function fakeClient(calls: Array<{ method: string; input?: unknown; options?: unknown }>): AionisHookClient {
  return {
    health: async () => {
      calls.push({ method: "health" });
      return { ok: true };
    },
    execution: {
      guideForRole: async (input, options) => {
        calls.push({ method: "guideForRole", input, options });
        return {
          guide_trace_id: "guide-test",
          agent_context: {
            prompt_text: [
              "AIONIS_CTX v2",
              "CURRENT_ACTIVE_PATH",
              "- Continue the verified Claude Code route.",
              "FAILED_BRANCHES",
              "- Do not reuse the retired implementation.",
            ].join("\n"),
            use_now_memory_ids: ["mem-current"],
            inspect_before_use_memory_ids: [],
            do_not_use_memory_ids: ["mem-failed"],
          },
        };
      },
      observeStep: async (input, options) => {
        calls.push({ method: "observeStep", input, options });
        return { observed: true };
      },
      handoff: async (input, options) => {
        calls.push({ method: "handoff", input, options });
        return { handoff: true };
      },
    },
  };
}

test("@aionis/claude-code parses install options", () => {
  const parsed = parseAionisClaudeCodeArgs([
    "install",
    "--base-url",
    "http://127.0.0.1:3101",
    "--settings",
    "project",
    "--scope-from",
    "git",
    "--mcp-name",
    "aionis",
    "--skip-mcp",
  ], {});

  assert.equal(parsed.command, "install");
  assert.equal(parsed.baseUrl, "http://127.0.0.1:3101");
  assert.equal(parsed.settings, "project");
  assert.equal(parsed.scope_from, "git");
  assert.equal(parsed.mcp_name, "aionis");
  assert.equal(parsed.skip_mcp, true);
});

test("@aionis/claude-code onboard defaults to user-level hooks and MCP", () => {
  const parsed = parseAionisClaudeCodeArgs(["onboard"], {});

  assert.equal(parsed.command, "onboard");
  assert.equal(parsed.settings, "user");
  assert.equal(parsed.claude_scope, "user");
  assert.equal(parsed.workspace_identity_store, "user");
  assert.equal(parsed.scope_from, "workspace");
});

test("@aionis/claude-code doctor defaults to the same user-level posture as onboard", () => {
  const parsed = parseAionisClaudeCodeArgs(["doctor"], {});

  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.settings, "user");
  assert.equal(parsed.claude_scope, "user");
  assert.equal(parsed.workspace_identity_store, "user");
});

test("@aionis/claude-code writes idempotent Claude Code hook settings", () => {
  const current = {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: "echo",
              args: ["keep-me"],
            },
          ],
        },
      ],
    },
  };

  const once = nextClaudeCodeSettings(current, baseOptions());
  const twice = nextClaudeCodeSettings(once, baseOptions());
  assert.deepEqual(twice, once);

  const hooks = twice.hooks as Record<string, unknown[]>;
  assert.equal(hooks.UserPromptSubmit.length, 2);
  assert.equal(hooks.SessionStart.length, 1);
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(hooks.PostCompact.length, 1);
  const aionisHook = (hooks.SessionStart[0] as { hooks: Array<{ command: string; args?: string[] }> }).hooks[0];
  assert.match(aionisHook.command, /^npx '-y' '@aionis\/claude-code@latest' 'hook'/);
  assert.match(aionisHook.command, /'--workspace-id-store' 'project'/);
  assert.equal(aionisHook.args, undefined);
});

test("@aionis/claude-code global install shortcut targets user settings", () => {
  const options = parseAionisClaudeCodeArgs(["install", "--global"], {});
  assert.equal(options.settings, "user");
  assert.equal(options.claude_scope, "user");
  assert.equal(options.workspace_identity_store, "user");

  const settings = nextClaudeCodeSettings({}, options);
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>;
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /'--workspace-id-store' 'user'/);
});

test("@aionis/claude-code uses direct node hook command for file package installs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-filepkg-"));
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "#!/usr/bin/env node\n");
  const settings = nextClaudeCodeSettings({}, baseOptions({ package_spec: `file:${dir}` }));
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>;
  const command = hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(command, new RegExp(`^node '${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dist/index\\.js' 'hook'`));
  assert.doesNotMatch(command, /npx/);
});

test("@aionis/claude-code derives stable workspace scope", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-scope-"));
  const first = deriveAionisClaudeCodeScope({ source: "workspace", cwd: dir, repoRoot: dir });
  const second = deriveAionisClaudeCodeScope({ source: "workspace", cwd: dir, repoRoot: dir });

  assert.equal(first, second);
  assert.match(first ?? "", /^ws:aionis-claude-code-scope-[A-Za-z0-9._-]+:[a-f0-9]{12}$/);
  assert.ok(fs.existsSync(path.join(dir, ".aionis", "workspace.json")));
});

test("@aionis/claude-code can keep workspace identity outside the project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-user-scope-"));
  const first = deriveAionisClaudeCodeScope({
    source: "workspace",
    cwd: dir,
    repoRoot: dir,
    workspaceIdentityStore: "user",
  });
  const second = deriveAionisClaudeCodeScope({
    source: "workspace",
    cwd: dir,
    repoRoot: dir,
    workspaceIdentityStore: "user",
  });

  assert.equal(first, second);
  assert.match(first ?? "", /^ws:aionis-claude-code-user-scope-[A-Za-z0-9._-]+:[a-f0-9]{12}$/);
  assert.equal(fs.existsSync(path.join(dir, ".aionis", "workspace.json")), false);
});

test("@aionis/claude-code install writes local settings and instructions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-install-"));
  const result = await installAionisClaudeCode(baseOptions({ repo_root: dir }), dir);
  const realDir = fs.realpathSync(dir);

  assert.equal(result.mcp_status, "skipped");
  assert.equal(result.settings_file, path.join(realDir, ".claude", "settings.local.json"));
  assert.ok(fs.existsSync(result.settings_file));
  assert.ok(fs.existsSync(result.instructions_file));

  const settings = JSON.parse(fs.readFileSync(result.settings_file, "utf8")) as { hooks: Record<string, unknown[]> };
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.ok(settings.hooks.PostToolUse);
});

test("@aionis/claude-code dry-run install does not write files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-dry-"));
  const result = await installAionisClaudeCode(baseOptions({ repo_root: dir, dry_run: true, skip_mcp: false }), dir);
  const plan = installPlan(baseOptions({ repo_root: dir, dry_run: true, skip_mcp: false }), dir);

  assert.equal(result.mcp_status, "planned");
  assert.equal(result.settings_file, plan.settings_file);
  assert.equal(fs.existsSync(result.settings_file), false);
  assert.equal(fs.existsSync(result.instructions_file), false);
  assert.ok(plan.mcp_command?.includes("@aionis/mcp@latest"));
});

test("@aionis/claude-code UserPromptSubmit injects compiled Aionis context", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-hook-"));
  const output = await handleAionisClaudeCodeHook({
    session_id: "session-1",
    cwd: dir,
    hook_event_name: "UserPromptSubmit",
    prompt: "Continue the checkout migration.",
  }, baseOptions({ repo_root: dir }), fakeClient(calls));

  assert.equal(calls[0].method, "guideForRole");
  assert.ok(output);
  const parsed = JSON.parse(output ?? "{}") as { hookSpecificOutput: { additionalContext: string } };
  assert.match(parsed.hookSpecificOutput.additionalContext, /AIONIS_EXECUTION_MEMORY_CONTEXT/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /CURRENT_ACTIVE_PATH/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Do not reuse/);
});

test("@aionis/claude-code PostToolUse records execution evidence", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-posttool-"));
  const output = await handleAionisClaudeCodeHook({
    session_id: "session-2",
    cwd: dir,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_use_id: "tool-1",
    tool_input: {
      file_path: "/tmp/project/src/app.ts",
      old_string: "old",
      new_string: "new",
    },
    tool_response: { ok: true },
  }, baseOptions({ repo_root: dir }), fakeClient(calls));

  assert.equal(output, null);
  assert.equal(calls[0].method, "observeStep");
  const input = calls[0].input as { outcome: string; target_files: string[]; tool_set: string[] };
  assert.equal(input.outcome, "succeeded");
  assert.deepEqual(input.target_files, ["/tmp/project/src/app.ts"]);
  assert.deepEqual(input.tool_set, ["Edit"]);
});

test("@aionis/claude-code PostCompact records handoff", async () => {
  const calls: Array<{ method: string; input?: unknown; options?: unknown }> = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-postcompact-"));
  await handleAionisClaudeCodeHook({
    session_id: "session-3",
    cwd: dir,
    hook_event_name: "PostCompact",
    trigger: "manual",
    compact_summary: "Implemented the active route and preserved the verifier checklist.",
  }, baseOptions({ repo_root: dir }), fakeClient(calls));

  assert.equal(calls[0].method, "handoff");
  const input = calls[0].input as { handoff_text: string; handoff_kind: string };
  assert.match(input.handoff_text, /verifier checklist/);
  assert.equal(input.handoff_kind, "task_handoff");
});

test("@aionis/claude-code status reports installed hooks with fake fetch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-status-"));
  await installAionisClaudeCode(baseOptions({ repo_root: dir, baseUrl: "http://runtime.test" }), dir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  try {
    const status = await statusAionisClaudeCode(baseOptions({ repo_root: dir, baseUrl: "http://runtime.test" }), dir);
    assert.equal(status.runtime_ok, true);
    assert.equal(status.hooks_installed, true);
    assert.match(status.scope ?? "", /^ws:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("@aionis/claude-code install is idempotent when MCP already exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-mcp-exists-"));
  const script = path.join(dir, "claude");
  fs.writeFileSync(script, [
    "#!/usr/bin/env bash",
    "echo 'MCP server aionis-local already exists in local config' >&2",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
  try {
    const result = await installAionisClaudeCode(baseOptions({
      repo_root: dir,
      skip_mcp: false,
    }), dir);
    assert.equal(result.mcp_status, "installed");
    assert.equal(result.mcp_error, undefined);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("@aionis/claude-code onboard returns a ready bundle when local fake Claude and Runtime pass", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claude-code-onboard-"));
  const script = path.join(dir, "claude");
  fs.writeFileSync(script, [
    "#!/usr/bin/env bash",
    "if [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"add\" ]; then exit 0; fi",
    "if [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"list\" ]; then echo 'aionis-local - ✓ Connected'; exit 0; fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const previousPath = process.env.PATH;
  const originalFetch = globalThis.fetch;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  try {
    const result = await onboardAionisClaudeCode(baseOptions({
      command: "onboard",
      repo_root: dir,
      baseUrl: "http://runtime.test",
      settings: "local",
      claude_scope: "local",
      workspace_identity_store: "project",
      skip_mcp: false,
    }), dir);
    assert.equal(result.ready, true);
    assert.equal(result.install.mcp_status, "installed");
    assert.equal(result.doctor.ready, true);
    assert.ok(result.next.some((line) => /claude/.test(line)));
  } finally {
    process.env.PATH = previousPath;
    globalThis.fetch = originalFetch;
  }
});
