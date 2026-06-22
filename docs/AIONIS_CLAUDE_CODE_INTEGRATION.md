# Aionis Claude Code Integration

Aionis has two Claude Code integration levels.

## MCP Only

MCP exposes Aionis tools to Claude Code:

- `aionis_context`
- `aionis_record_step`
- `aionis_handoff`
- `aionis_flight_recorder`
- `aionis_snapshot`

This is useful, but the Agent still has to decide to call the tools.

## MCP + Lifecycle Hooks

For a stronger integration, install the Claude Code lifecycle pack:

```bash
npx @aionis/claude-code@latest install \
  --base-url http://127.0.0.1:3101 \
  --scope-from workspace
```

This writes `.claude/settings.local.json` and installs hooks that call Aionis
through the SDK:

| Hook | Aionis action |
|---|---|
| `SessionStart` | Inject Aionis activation context and workspace scope. |
| `UserPromptSubmit` | Run `/v1/guide` before every user prompt and inject governed execution context. |
| `PostToolUse` | Record successful Bash/Edit/Write execution evidence. |
| `PostToolUseFailure` | Record failed Bash/Edit/Write execution evidence. |
| `PreCompact` | Record a compaction boundary marker. |
| `PostCompact` | Record compacted summary as handoff evidence. |
| `SessionEnd` | Record a session-end handoff marker. |

MCP stays installed for explicit interactive actions. Hooks make Aionis part of
the Claude Code lifecycle even when the Agent does not proactively call a tool.

## Local Isolated Runtime Example

If Runtime is running on a non-default port:

```bash
npx @aionis/claude-code@latest install \
  --base-url http://127.0.0.1:3101 \
  --scope-from workspace \
  --mcp-name aionis-local
```

Check status:

```bash
npx @aionis/claude-code@latest status \
  --base-url http://127.0.0.1:3101
```

The default settings target is local, so the hook config goes into
`.claude/settings.local.json` and does not need to be committed.

## Runtime Installer Shortcut

If you are installing Runtime and Claude Code integration together, use:

```bash
npx @aionis/create@latest .aionis-runtime \
  --with-claude-code \
  --claude-code-dir . \
  --claude-code-base-url http://127.0.0.1:3001
```

`--claude-code-dir` should point at the project where you run `claude`. This is
usually not the same directory as the Runtime checkout.

## Scope

Use `--scope-from workspace` for coding agents. Aionis writes
`.aionis/workspace.json` and keeps a stable project scope even if the directory
later becomes a git repo or gets a remote.

Use `--scope <scope>` only when the host already owns scope assignment.

## Why This Exists

MCP is a capability bridge. Hooks are the lifecycle layer. Aionis needs both:

```text
User prompt
  -> UserPromptSubmit hook
  -> Aionis guide
  -> governed execution context
  -> Claude Code action
  -> PostToolUse hook
  -> Aionis observe
```

That loop is the product path for execution memory in Claude Code.
