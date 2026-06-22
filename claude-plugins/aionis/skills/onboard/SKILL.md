---
name: onboard
description: Verify and explain the Aionis Claude Code plugin onboarding path.
allowed-tools: [Bash]
---

# Aionis Onboard

Use this when the user runs `/aionis:onboard`.

## What This Plugin Already Installs

When this plugin is enabled, Claude Code automatically loads:

- Aionis MCP server `aionis`.
- Aionis lifecycle hooks for session start, user prompts, tool results, compaction, and session end.
- User-level workspace identity storage, so different projects get stable Aionis scopes without writing `.aionis/workspace.json` into every repo.

## Check Runtime

Run:

```bash
curl -fsS "${user_config.base_url}/health"
```

If it succeeds, tell the user Aionis Runtime is reachable.

If it fails, tell the user to start Runtime or update this plugin's `base_url` setting.

## Explain Usage

Tell the user:

- Continue using Claude Code normally.
- Aionis hooks inject governed execution context before prompts and record tool outcomes after actions.
- Use MCP tools such as `aionis_context`, `aionis_record_step`, `aionis_handoff`, `aionis_snapshot`, and `aionis_flight_recorder` when they want explicit control.
- Use `/aionis:doctor` to verify the connection.
