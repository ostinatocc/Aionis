# Install Aionis

Status: product install path for Runtime plus SDK and MCP packages

## One Command

Aionis publishes three npm packages:

- `@aionis/create`: one-command Runtime installer
- `@aionis/sdk`: TypeScript SDK facade for product routes
- `@aionis/mcp`: MCP stdio bridge for Claude Code, Cursor, and other MCP clients

Install Runtime plus SDK/MCP packages and run the first-value demo:

```bash
npx @aionis/create@latest
```

The default quickstart does not require an embedding or LLM API key. It starts a
temporary Lite Runtime with `EMBEDDING_PROVIDER=none` and shows Aionis blocking
failed/stale memory before prompt use.

This installs the local-first Lite Runtime. Lite is designed for developer
machines and local agent hosts. It is not a hosted multi-tenant production
service: Lite defaults to loopback, `MEMORY_AUTH_MODE=off`, and
`TENANT_QUOTA_ENABLED=false`.

Runtime editions:

| Edition | Status | Intended use |
|---|---|---|
| `lite` | Default | Local developer Runtime for first-value demos, local agents, SDK quickstarts, and MCP on the same machine. |
| `server` | Managed Server path | Remote SDK/MCP endpoint with explicit auth and request controls. Use `AIONIS_EDITION=server`, `AIONIS_MODE=service`, and `MEMORY_AUTH_MODE=api_key`, `jwt`, or `api_key_or_jwt`. |
| `cloud` | Reserved | Future SaaS control plane. Billing, org management, hosted multi-tenancy, and fleet operations are not implemented in this Runtime package. |

Managed Server exposes hosted-safe probes:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
```

`/healthz` returns liveness metadata such as edition, mode, auth mode, and
package version. `/readyz` returns boolean dependency checks. Neither endpoint
returns API keys, raw environment values, or local SQLite file paths.

Runtime requirement: Node.js `>=22.5.0` with the built-in experimental
`node:sqlite` module available. The installer checks both the version and the
SQLite feature because Lite stores local memory state in SQLite.

For full SDK integration with OpenAI-compatible embeddings:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart sdk
```

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
3. write `.env` with `EMBEDDING_PROVIDER=none` unless a provider/key is selected
4. build `@aionis/sdk`, `@aionis/mcp`, and `@aionis/create`
5. run the selected quickstart; `first-value` can run without an API key, while
   recall-backed quickstarts require the selected embedding key

Runtime startup does not require an embedding provider in no-key mode. If no key
is detected, the generated `.env` keeps `EMBEDDING_PROVIDER=none`, so this works:

```bash
cd Aionis
npm run -s lite:start
```

Enable semantic recall and recall-backed quickstarts later by setting a provider
and matching key in `.env`. For `EMBEDDING_PROVIDER=openai`, that key is
`OPENAI_API_KEY`.

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

## Fresh Install Smoke

After publishing `@aionis/create`, run the release smoke against the public npm
entrypoint:

```bash
npm run -s runtime:smoke:fresh-install
```

The smoke creates a temporary project and runs the same path a new user takes:

1. `npm exec --package @aionis/create@latest -- create-aionis FreshRuntime --quickstart none`
2. assert the generated `.env` uses `EMBEDDING_PROVIDER=none`
3. start the installed Runtime without any embedding key
4. run `@aionis/mcp@latest` over stdio
5. call `aionis_record_step -> aionis_context`

Use overrides when validating a candidate package or branch:

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC=@aionis/create@0.1.9 \
AIONIS_FRESH_INSTALL_MCP_SPEC=@aionis/mcp@0.1.9 \
AIONIS_FRESH_INSTALL_REPO=https://github.com/ostinatocc/Aionis.git \
npm run -s runtime:smoke:fresh-install
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
