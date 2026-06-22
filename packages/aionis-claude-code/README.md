# @aionis/claude-code

Claude Code lifecycle integration for Aionis execution memory.

Use this package when MCP-only is not enough and you want Claude Code turns to
pass through Aionis automatically.

```bash
npx @aionis/claude-code@latest install \
  --base-url http://127.0.0.1:3101 \
  --scope-from workspace
```

The installer writes Claude Code hooks into `.claude/settings.local.json` and
adds an Aionis MCP server. Hooks call Aionis through the SDK:

- `SessionStart`: injects a compact Aionis activation context.
- `UserPromptSubmit`: runs Aionis guide before every user prompt.
- `PostToolUse` / `PostToolUseFailure`: records Bash/Edit/Write execution
  evidence.
- `PostCompact`: records the compacted session summary as handoff evidence.
- `SessionEnd`: records a session-end handoff marker.

MCP remains available for explicit tools such as `aionis_context`,
`aionis_record_step`, `aionis_flight_recorder`, and `aionis_snapshot`.

Check status:

```bash
npx @aionis/claude-code@latest status --base-url http://127.0.0.1:3101
```
