---
name: doctor
description: Check whether Claude Code can reach Aionis Runtime and the plugin is ready.
allowed-tools: [Bash]
---

# Aionis Doctor

Use this when the user runs `/aionis:doctor`.

## Runtime Check

Run:

```bash
curl -fsS "${user_config.base_url}/health"
```

Report:

- Runtime URL.
- Whether `/health` responded.
- The effective scope strategy: `${user_config.scope_from}`.
- That the plugin uses user-level workspace identity storage for stable cross-agent continuity.

If available in the current Claude Code session, also use the Aionis MCP health/context tool to verify MCP connectivity. If the MCP tool is not visible yet, tell the user to restart Claude Code after plugin install.
