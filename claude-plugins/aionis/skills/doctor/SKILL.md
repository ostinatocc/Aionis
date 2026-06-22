---
name: doctor
description: Check whether Claude Code can reach Aionis Runtime and the plugin is ready.
allowed-tools: [Bash]
---

# Aionis Doctor

Use this when the user runs `/aionis:doctor`.

Run this exact Bash check first:

```bash
BASE_URL="${AIONIS_BASE_URL:-http://127.0.0.1:3101}"
printf 'Aionis Runtime: %s\n' "$BASE_URL"
curl -fsS "$BASE_URL/health" >/tmp/aionis-claude-code-health.json
node -e 'const fs=require("fs"); const h=JSON.parse(fs.readFileSync("/tmp/aionis-claude-code-health.json","utf8")); console.log(`Runtime reachable: ${h.ok === true ? "yes" : "no"}`); console.log(`Edition: ${h.runtime?.edition ?? "unknown"}`); console.log(`Mode: ${h.runtime?.mode ?? "unknown"}`);'
claude mcp list 2>/dev/null | grep -E 'plugin:aionis-claude-code:aionis|plugin:aionis:aionis|aionis-local' || true
```

Then report only:

- Runtime URL.
- Whether `/health` responded.
- Whether Aionis MCP appears connected.
- That Aionis lifecycle hooks inject governed execution memory before prompts and record tool outcomes.

If neither `plugin:aionis-claude-code:aionis` nor `plugin:aionis:aionis` is visible, tell the user to restart Claude Code after plugin install or run `claude plugin list && claude mcp list`.
