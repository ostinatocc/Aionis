---
name: status
description: Summarize the current Aionis Claude Code plugin state and next useful command.
allowed-tools: [Bash]
---

# Aionis Status

Use this when the user runs `/aionis:status`.

Run:

```bash
printf 'AIONIS_BASE_URL=%s\nAIONIS_SCOPE_FROM=%s\nAIONIS_GUIDE_MODE=%s\n' "${user_config.base_url}" "${user_config.scope_from}" "${user_config.guide_mode}"
```

Then summarize:

- Runtime URL.
- Scope strategy.
- Guide mode.
- Plugin path: lifecycle hooks plus MCP tools.

Recommended next command:

- `/aionis:doctor` if the user wants to verify readiness.
- Use Aionis MCP tools explicitly if they want to record a plan, handoff, or inspect a flight recorder snapshot.
