---
name: status
description: Summarize the current Aionis Claude Code plugin state and next useful command.
allowed-tools: [Bash]
---

# Aionis Status

Use this when the user runs `/aionis:status`.

Run this exact Bash command first:

```bash
BASE_URL="${AIONIS_BASE_URL:-http://127.0.0.1:3101}"
SCOPE_FROM="${AIONIS_SCOPE_FROM:-workspace}"
GUIDE_MODE="${AIONIS_GUIDE_MODE:-full_power}"
printf 'AIONIS_BASE_URL=%s\nAIONIS_SCOPE_FROM=%s\nAIONIS_GUIDE_MODE=%s\n' "$BASE_URL" "$SCOPE_FROM" "$GUIDE_MODE"
claude plugin list 2>/dev/null | grep -A4 'aionis@aionis' || true
claude plugin list 2>/dev/null | grep -A4 'aionis@aionis-claude-code' || true
claude mcp list 2>/dev/null | grep -E 'plugin:aionis-claude-code:aionis|plugin:aionis:aionis|aionis-local' || true
```

Then summarize:

- Runtime URL.
- Scope strategy.
- Guide mode.
- Plugin status.
- MCP status.
- Product path: lifecycle hooks plus MCP tools.

Recommended next command:

- `/aionis:doctor` if the user wants to verify readiness.
- Use Aionis MCP tools explicitly if they want to record a plan, handoff, or inspect a flight recorder snapshot.
