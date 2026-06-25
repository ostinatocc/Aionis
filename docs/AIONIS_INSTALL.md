# Install Aionis

Status: product install path for Runtime plus SDK and MCP packages

## One Command

Aionis publishes a top-level product CLI plus focused integration packages:

- `aionis`: guided product CLI; `npx aionis setup`
- `@aionis/create`: one-command Runtime installer
- `@aionis/sdk`: TypeScript SDK facade for product routes
- `@aionis/mcp`: MCP stdio bridge for Claude Code, Cursor, and other MCP clients
- `@aionis/claude-code`: Claude Code MCP + lifecycle hook installer

Choose the entry point by what you are connecting:

| Goal | Package or plugin | Source |
|---|---|---|
| Guided local setup | `aionis` | [ostinatocc/aionis-cli](https://github.com/ostinatocc/aionis-cli) |
| Install and run Aionis Runtime | `@aionis/create` | [ostinatocc/aionis-create](https://github.com/ostinatocc/aionis-create) |
| Call Runtime APIs from an app or agent host | `@aionis/sdk` | [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk) |
| Add Aionis tools to an MCP-capable client | `@aionis/mcp` | [ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp) |
| Give Claude Code automatic before/after hooks | Claude Code plugin or `@aionis/claude-code` | [ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code) |

Guided setup:

```bash
npx aionis setup
```

The setup command asks for the install directory, quickstart, provider, and
optional Claude Code hooks. If you choose OpenAI, MiniMax, or another provider,
it asks for the matching API key with hidden terminal input, then writes the
generated Runtime `.env` for you. You do not need to manually edit `.env` for
the first install path.

Non-interactive setup:

```bash
OPENAI_API_KEY="your-key" npx aionis setup --provider openai --quickstart sdk --yes
```

Optional local ANN candidate index:

```bash
npx aionis setup --with-zvec-ann
```

This keeps SQLite as the Runtime fact source and enables Zvec only as a local
candidate-retrieval sidecar. Aionis still applies scope, lifecycle, authority,
admission, and rehydrate governance after candidates are loaded back from
SQLite.

Direct installer path:

```bash
npx @aionis/create@latest
```

The default quickstart works without an embedding or LLM API key. It starts a
Lite Runtime with `EMBEDDING_PROVIDER=none` and shows Aionis turning raw
retrieved history into governed Agent context.

## Docker

Run the local-first Runtime in Docker:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.2.2
```

Then check readiness:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
```

Docker stores Lite Runtime SQLite state under `/data`. Bind the host port to
loopback for local use. For remote SDK/MCP clients, switch to Server mode with
API-key or JWT auth. Full release and Docker notes:
[AIONIS_RELEASES.md](AIONIS_RELEASES.md).

This installs the local-first Lite Runtime. Lite is designed for developer
machines, same-host coding agents, and first-value MCP/SDK trials. It defaults
to loopback and local development settings so a new user can see Aionis work
immediately.

Runtime editions:

| Edition | Status | Intended use |
|---|---|---|
| `lite` | Default | Local developer Runtime for first-value demos, local agents, SDK quickstarts, and MCP on the same machine. |
| `server` | Managed Server path | Remote SDK/MCP endpoint with explicit auth and request controls. Use `AIONIS_EDITION=server`, `AIONIS_MODE=service`, and `MEMORY_AUTH_MODE=api_key`, `jwt`, or `api_key_or_jwt`. |
| `cloud` | Reserved label | Product roadmap label for future hosted packaging; the install path here focuses on Lite and Server deployments. |

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

For Claude Code, install Runtime into a side directory and run Claude Code
onboarding:

```bash
npx @aionis/create@latest .aionis-runtime \
  --with-claude-code
```

Then start Runtime and run Claude Code from the project:

```bash
cd .aionis-runtime
npm run -s lite:start
cd ..
claude
```

The Claude Code path uses `http://127.0.0.1:3101` by default and writes
`PORT=3101` into `.aionis-runtime/.env`. A plain Runtime install without
`--with-claude-code` still defaults to `http://127.0.0.1:3001`.

The Claude Code integration runs `@aionis/claude-code onboard`: it installs
user-level MCP plus user-level hooks. Hooks call Aionis before user prompts,
after Bash/Edit/Write tool use, and at compact/session boundaries.

If you prefer the Claude Code plugin path after installing Runtime:

```text
/plugin marketplace add https://github.com/ostinatocc/aionis-claude-code
/plugin install aionis@aionis-claude-code
/aionis:doctor
```

The Claude Code plugin marketplace is maintained separately at
[ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code).

The installer performs product setup:

1. clone `https://github.com/ostinatocc/Aionis.git`
2. run `npm install`
3. write `.env` with `EMBEDDING_PROVIDER=none` unless a provider/key is selected
4. optionally write `RECALL_ANN_PROVIDER=zvec` when `--with-zvec-ann` is set
5. run the selected quickstart; `first-value` can run without an API key, while
   recall-backed quickstarts require the selected embedding key
6. optionally run Claude Code onboarding when `--with-claude-code` is set

The equivalent low-level installer command is:

```bash
npx @aionis/create@latest .aionis-runtime --with-zvec-ann
```

After install, validate the local ANN sidecar from the Runtime directory:

```bash
cd .aionis-runtime
npm run -s recall:ann:scale
```

Repository boundary:

| Repository | Role |
|---|---|
| [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis) | Runtime core, product HTTP APIs, docs, examples, Docker image, and product validation loops. |
| [ostinatocc/aionis-cli](https://github.com/ostinatocc/aionis-cli) | Top-level `aionis` product CLI. It owns `npx aionis setup` and delegates actual Runtime install to `@aionis/create`. |
| [ostinatocc/aionis-create](https://github.com/ostinatocc/aionis-create) | Standalone published `@aionis/create` installer package repo. |
| [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk) | Standalone published `@aionis/sdk` package repo. |
| [ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp) | Standalone published `@aionis/mcp` package repo. |
| [ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code) | Standalone Claude Code plugin and `@aionis/claude-code` helper repo. |

Runtime startup works in no-key mode. If no key is detected, the generated
`.env` keeps `EMBEDDING_PROVIDER=none`, so this works:

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
npm run -s typecheck
npm run -s lite:test
```

The installer source lives outside this repo. Use published `@aionis/create`
for install-path validation.

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
AIONIS_FRESH_INSTALL_CREATE_SPEC=@aionis/create@latest \
AIONIS_FRESH_INSTALL_SDK_SPEC=@aionis/sdk@0.2.23 \
AIONIS_FRESH_INSTALL_MCP_SPEC=@aionis/mcp@0.2.2 \
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
npx @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope-from workspace \
  --workspace-id-store user
```

For Claude Code:

```bash
claude mcp add --transport stdio --scope project aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope-from workspace \
  --workspace-id-store user
```

MCP integration guide: [AIONIS_MCP.md](AIONIS_MCP.md).

Claude Code plugin integration:
[AIONIS_CLAUDE_CODE_INTEGRATION.md](AIONIS_CLAUDE_CODE_INTEGRATION.md).
