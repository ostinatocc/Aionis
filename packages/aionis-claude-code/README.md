# @aionis/claude-code

Claude Code lifecycle integration for Aionis execution memory.

Use this package when MCP-only is not enough and you want Claude Code turns to
pass through Aionis automatically.

Recommended Claude Code plugin setup:

```text
/plugin marketplace add https://github.com/ostinatocc/Aionis
/plugin install aionis@aionis
/aionis:onboard
```

The plugin loads user-level lifecycle hooks, an Aionis MCP server, and slash
commands. After that, run `claude` from any project. Aionis derives a stable
workspace scope per project without requiring manual project setup.

CLI fallback:

```bash
npx @aionis/claude-code@latest onboard --base-url http://127.0.0.1:3101
```

`onboard` installs the same hook + MCP integration through user-level Claude
Code settings when you do not want to use plugins.

Hooks call Aionis through the SDK:

- `SessionStart`: injects a compact Aionis activation context.
- `UserPromptSubmit`: runs Aionis guide before every user prompt.
- `PostToolUse` / `PostToolUseFailure`: records Bash/Edit/Write execution
  evidence.
- `PostCompact`: records the compacted session summary as handoff evidence.
- `SessionEnd`: records a session-end handoff marker.

MCP remains available for explicit tools such as `aionis_context`,
`aionis_record_step`, `aionis_flight_recorder`, and `aionis_snapshot`.

Check everything:

```bash
npx @aionis/claude-code@latest doctor --base-url http://127.0.0.1:3101
```

Project-only isolated install is still available:

```bash
npx @aionis/claude-code@latest install \
  --settings local \
  --claude-scope local \
  --base-url http://127.0.0.1:3101
```
