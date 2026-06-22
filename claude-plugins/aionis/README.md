# Aionis Claude Code Plugin

This plugin gives Claude Code Aionis execution memory through two paths:

- Lifecycle hooks that inject governed context and record tool outcomes.
- MCP tools for explicit context, handoff, Memory Firewall, snapshots, and Flight Recorder.

## Install From This Marketplace

From Claude Code:

```text
/plugin marketplace add https://github.com/ostinatocc/Aionis
/plugin install aionis@aionis
/aionis:onboard
```

For local development of this repo:

```text
/plugin marketplace add /Volumes/ziel/AionisRuntime-focused
/plugin install aionis@aionis
/aionis:doctor
```

## Runtime URL

The plugin defaults to:

```text
http://127.0.0.1:3101
```

Set `AIONIS_BASE_URL` before starting Claude Code to point at a different Runtime.

## Scope

The plugin defaults to `AIONIS_SCOPE_FROM=workspace` and `AIONIS_WORKSPACE_ID_STORE=user`.
That gives each project a stable Aionis scope without writing identity files into every repo.

