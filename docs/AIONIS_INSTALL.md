# Install Aionis

Status: product install path for Runtime plus SDK and MCP packages

## One Command

Aionis publishes three npm packages:

- `@aionis/create`: one-command Runtime installer
- `@aionis/sdk`: TypeScript SDK facade for product routes
- `@aionis/mcp`: MCP stdio bridge for Claude Code, Cursor, and other MCP clients

Install Runtime plus SDK and run the SDK quickstart:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart sdk
```

This installs the local-first Lite Runtime. Lite is designed for developer
machines, local agent hosts, and self-managed deployments behind your own
boundary. It is not a hosted multi-tenant production service: Lite defaults to
loopback, `MEMORY_AUTH_MODE=off`, and `TENANT_QUOTA_ENABLED=false`.

Runtime requirement: Node.js `>=22.5.0` with the built-in experimental
`node:sqlite` module available. The installer checks both the version and the
SQLite feature because Lite stores local memory state in SQLite.

For raw HTTP users:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart http
```

For multi-agent execution memory:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart multi-agent
```

The installer does not change Runtime core. It performs product setup:

1. clone `https://github.com/ostinatocc/Aionis.git`
2. run `npm install`
3. write `.env` with the selected embedding provider
4. build `@aionis/sdk`, `@aionis/mcp`, and `@aionis/create`
5. run the selected quickstart when an API key is available

Runtime startup needs the selected embedding provider key. If you install with
`--skip-quickstart` or without an API key, set the required key in the generated
`.env` before running `npm run -s lite:start`. The default provider is OpenAI;
for `--provider openai`, that key is `OPENAI_API_KEY`.

MiniMax remains supported with `--provider minimax` and `MINIMAX_API_KEY`.
MiniMax embeddings default to separate surfaces: stored memory is embedded with
`MINIMAX_EMBED_DB_TYPE=db`, while recall queries use
`MINIMAX_EMBED_QUERY_TYPE=query`. The legacy `MINIMAX_EMBED_TYPE` setting is
still accepted when you intentionally want one type for both directions.

## Local Development

From this repo:

```bash
node --version   # must be >= 22.5.0 and include node:sqlite
npm install
npm run -s packages:build
npm run -s packages:test
```

Run the installer locally:

```bash
npx tsx packages/create-aionis/src/index.ts ./Aionis-local \
  --provider openai \
  --quickstart none
```

## SDK Package

For hosts that already have an Aionis Runtime URL:

```bash
npm install @aionis/sdk
```

```ts
import {
  compileExecutionAgentContext,
  createAionisClient,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
} from "@aionis/sdk";
```

Use the SDK only as a facade over the product routes. The Runtime still owns
memory governance, context compilation, feedback attribution, measurement, and
operator snapshots. For coding and multi-agent hosts, prefer
`compileExecutionAgentContext()` over passing raw `agent_context.prompt_text`
directly; it turns the governed guide into a contract-style Agent prompt plus
route, rehydrate, and receipt metadata.

## MCP Package

For MCP clients that can spawn a local stdio server:

```bash
npm install -g @aionis/mcp
```

Or use it directly:

```bash
npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope my-project
```

For Claude Code:

```bash
claude mcp add --transport stdio --scope project aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope my-project
```

MCP integration guide: [AIONIS_MCP.md](AIONIS_MCP.md).

Claude Code demo: [AIONIS_CLAUDE_CODE_DEMO.md](AIONIS_CLAUDE_CODE_DEMO.md).
