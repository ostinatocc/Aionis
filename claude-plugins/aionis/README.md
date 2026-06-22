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

Runtime should be reachable before you run the doctor command. For the
recommended isolated Claude Code Runtime, install with:

```bash
npx @aionis/create@latest .aionis-runtime --with-claude-code
cd .aionis-runtime
npm run -s lite:start
```

For local development of this repo:

```text
/plugin marketplace add /Volumes/ziel/AionisRuntime-focused
/plugin install aionis@aionis
/aionis:doctor
```

## Runtime URL

The plugin defaults to the isolated Claude Code Runtime URL:

```text
http://127.0.0.1:3101
```

Set `AIONIS_BASE_URL` before starting Claude Code to point at a different
Runtime. A plain Aionis Runtime still defaults to `http://127.0.0.1:3001`;
the `@aionis/create --with-claude-code` path writes `PORT=3101` so plugin and
Runtime match out of the box.

## Scope

The plugin defaults to `AIONIS_SCOPE_FROM=workspace` and `AIONIS_WORKSPACE_ID_STORE=user`.
That gives each project a stable Aionis scope without writing identity files into every repo.
