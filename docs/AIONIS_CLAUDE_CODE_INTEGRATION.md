# Aionis Claude Code Integration

Aionis has three Claude Code integration levels.

## Plugin Path

For the normal Claude Code path, use an isolated local Runtime on `3101` and
install the Aionis plugin:

```bash
npx @aionis/create@latest .aionis-runtime --with-claude-code
cd .aionis-runtime
npm run -s lite:start
```

Then in Claude Code:

```text
/plugin marketplace add https://github.com/ostinatocc/Aionis
/plugin install aionis@aionis
/aionis:onboard
```

The plugin loads:

- Aionis MCP server `aionis`.
- Aionis lifecycle hooks.
- User-level workspace identity storage for stable cross-project scopes.

Use `/aionis:doctor` to verify Runtime connectivity.

The plugin defaults to `http://127.0.0.1:3101`. A plain Runtime still defaults
to `http://127.0.0.1:3001`; the `@aionis/create --with-claude-code` path writes
`PORT=3101` so the plugin and local Runtime match.

## MCP Only

MCP exposes Aionis tools to Claude Code:

- `aionis_context`
- `aionis_record_step`
- `aionis_handoff`
- `aionis_flight_recorder`
- `aionis_snapshot`

This is useful, but the Agent still has to decide to call the tools.

## CLI Fallback: MCP + Lifecycle Hooks

If you do not want to use Claude Code plugins, onboard Claude Code once:

```bash
npx @aionis/claude-code@latest onboard --base-url http://127.0.0.1:3101
```

This installs user-level Claude Code hooks plus a user-level Aionis MCP server.
After that, run `claude` from any project. Hooks call Aionis through the SDK:

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
npx @aionis/claude-code@latest onboard \
  --base-url http://127.0.0.1:3101 \
  --mcp-name aionis-local
```

Check everything:

```bash
npx @aionis/claude-code@latest doctor \
  --base-url http://127.0.0.1:3101
```

For the plugin path, set the plugin `base_url` option to the same Runtime URL.

For a deliberately isolated project-only install, use:

```bash
npx @aionis/claude-code@latest install \
  --settings local \
  --claude-scope local \
  --base-url http://127.0.0.1:3101
```

## Runtime Installer Shortcut

If you are installing Runtime and Claude Code integration together, use:

```bash
npx @aionis/create@latest .aionis-runtime \
  --with-claude-code
```

This writes `PORT=3101` into the installed Runtime `.env` and runs the
`@aionis/claude-code onboard` fallback. You can then also install the Claude
Code plugin from the marketplace; the plugin uses the same Runtime URL and
user-level workspace identity model.

## Scope

Use `--scope-from workspace` for coding agents. `onboard` stores stable
workspace identities under the user's Aionis Claude Code cache, so new projects
do not need manual hook files before they can use Aionis.

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
