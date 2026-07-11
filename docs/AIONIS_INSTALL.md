# Install Aionis

Status: product install path for Runtime plus SDK and MCP packages

## One Command

Aionis publishes a top-level product CLI plus focused integration packages:

- `aionis`: guided product CLI; `npx aionis setup`
- `@aionis/create`: one-command Runtime installer
- `@aionis/sdk`: TypeScript SDK facade for product routes
- `@aionis/mcp`: MCP stdio bridge for Claude Code, Cursor, and other MCP clients
- `@aionis/aifs`: file surface for `.aionis` execution context snapshots
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

The setup command asks for the install directory, provider, optional
AIFS/Zvec/Claude Code setup. If you choose OpenAI, DashScope, MiniMax, or another
provider, it asks for the matching API key with hidden terminal input, then
writes the generated Runtime `.env` for you. Verification flows are disabled by
default; the completion output shows how to start Runtime and connect SDK,
HTTP, MCP, AIFS, or native adapter surfaces.

Non-interactive setup:

```bash
OPENAI_API_KEY="your-key" npx aionis setup --provider openai --yes
DASHSCOPE_API_KEY="your-key" npx aionis setup --provider dashscope --yes
```

Optional local ANN candidate index:

```bash
npx aionis setup --with-zvec-ann
```

This keeps SQLite as the Runtime fact source and enables Zvec only as a local
candidate-retrieval sidecar. Aionis still applies scope, lifecycle, authority,
admission, and rehydrate governance after candidates are loaded back from
SQLite.

Low-level installer package:
[`@aionis/create`](https://github.com/ostinatocc/aionis-create).
Most users should start with `npx aionis setup`, which wraps that package and
prints Runtime start and integration next steps.

## Docker

Run the local-first Runtime in Docker:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.4
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

The container process listens on `0.0.0.0` inside its isolated network
namespace because Docker cannot publish a process bound only to the
container's loopback device. The host mapping stays
`127.0.0.1:3001:3001`, which keeps the unauthenticated Lite endpoint local to
the host. A direct host install still defaults to
`AIONIS_LISTEN_HOST=127.0.0.1`. Do not attach this Lite container to an
untrusted shared Docker network; use authenticated Server mode for remote
access.

This installs the local-first Lite Runtime. Lite is designed for developer
machines, same-host coding agents, and SDK/MCP verification. It defaults to
loopback and local development settings so a new user can connect an Agent
immediately.

Runtime editions:

| Edition | Status | Intended use |
|---|---|---|
| `lite` | Default | Local developer Runtime for local agents, SDK/HTTP integrations, and MCP on the same machine. |
| `server` | Managed Server path | Remote SDK/MCP endpoint with explicit auth and request controls. Use `AIONIS_EDITION=server`, `AIONIS_MODE=service`, and `MEMORY_AUTH_MODE=api_key`, `jwt`, or `api_key_or_jwt`. |

## Runtime Configuration

Start from the local core posture and add only the components you need. Runtime
resolves one typed internal profile at startup; there is no separate profile
name to keep synchronized with the component settings.

| Posture | Required settings | Runtime composition |
|---|---|---|
| Local core | Defaults from `.env.example` | SQLite truth store |
| Local + Zvec | `RECALL_ANN_PROVIDER=zvec` | SQLite plus local ANN candidates |
| Local + Substrate | `RECALL_SUBSTRATE_SIDECAR_ENABLED=true` | SQLite plus Substrate candidates |
| Full local | Enable both settings above | SQLite plus both candidate sources |
| Server development | `AIONIS_EDITION=server`, `AIONIS_MODE=service`, `APP_ENV=dev`, explicit auth | Authenticated development endpoint |
| Server production | Server settings with `APP_ENV=prod`, request controls, and authority signing keys | Fail-closed managed endpoint |

Explicit advanced values override profile defaults when they are compatible
with the selected posture. Safety invariants still fail closed: Lite cannot be
exposed remotely without an explicit opt-in, Server cannot run unauthenticated
unless the development override is set, and production requires auth, rate
limits, tenant quotas, and durable authority receipt keys.

The checked-in [`.env.example`](../.env.example) is organized in this order:

1. normal local core settings;
2. optional embedding, Zvec, and Substrate components;
3. advanced Server, sandbox, replay, and admission settings.

Settings not shown use validated Runtime defaults. Removed PostgreSQL pool,
Control Plane telemetry, and dormant tier/compression/consolidation variables
are not accepted as Runtime configuration in the focused build.

Server production deployments must configure authority receipt signing keys.
The Runtime signs authority-bearing memory receipts with the active key and
verifies older receipts by their `key_id`, so keep previous keys in the keyring
until stored receipts no longer need to be accepted:

```env
AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID=authority-2026-07
AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON={"authority-2026-07":"current-32-byte-or-longer-secret","authority-2026-06":"previous-32-byte-or-longer-secret"}
```

Generate these secrets outside the repository with a high-entropy source, for
example `openssl rand -base64 48`, and store them in the deployment secret
manager. The JSON value may map key ids directly to secret strings or to
objects with a `secret` field. `AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET` is
accepted for single-key deployments, but the JSON keyring is preferred because
it supports safe rotation.

Rotation procedure:

1. Add the new key id and secret to `AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON`.
2. Set `AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID` to the new key id.
3. Keep the previous key in the JSON until all receipts signed with it are no
   longer present or no longer need verification.
4. Remove the retired key only after that retention window has passed.

`APP_ENV=prod` rejects ephemeral authority receipt keys and rejects active
secrets shorter than 32 bytes.

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

For a non-interactive OpenAI-compatible install:

```bash
OPENAI_API_KEY="your-key" npx aionis setup --provider openai --yes
```

For DashScope text-embedding-v4:

```bash
DASHSCOPE_API_KEY="your-key" npx aionis setup --provider dashscope --yes
```

Optional post-install SDK verification:

```bash
cd .aionis-runtime
npm run -s runtime:quickstart:sdk
```

Optional post-install raw HTTP verification:

```bash
npm run -s runtime:quickstart:http
```

For Claude Code, install Runtime into a side directory and run Claude Code
onboarding:

```bash
npx aionis setup .aionis-runtime --with-claude-code
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
5. optionally run the selected verification flow when explicitly requested
6. optionally run Claude Code onboarding when `--with-claude-code` is set

The equivalent guided setup command is:

```bash
npx aionis setup .aionis-runtime --with-zvec-ann --yes
```

After install, validate the local ANN sidecar from the Runtime directory:

```bash
cd .aionis-runtime
npm run -s recall:ann:scale
```

Repository boundary:

| Repository | Role |
|---|---|
| [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis) | Runtime core, product HTTP APIs, docs, Docker image, and product validation loops. |
| [ostinatocc/aionis-cli](https://github.com/ostinatocc/aionis-cli) | Top-level `aionis` product CLI. It owns `npx aionis setup` and delegates actual Runtime install to `@aionis/create`. |
| [ostinatocc/aionis-create](https://github.com/ostinatocc/aionis-create) | Standalone published `@aionis/create` installer package repo. |
| [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk) | Standalone published `@aionis/sdk` package repo. |
| [ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp) | Standalone published `@aionis/mcp` package repo. |
| [ostinatocc/aionis-aifs](https://github.com/ostinatocc/aionis-aifs) | Standalone published `@aionis/aifs` file-surface package repo. |
| [ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code) | Standalone Claude Code plugin and `@aionis/claude-code` helper repo. |

Runtime startup works in no-key mode. If no key is detected, the generated
`.env` keeps `EMBEDDING_PROVIDER=none`, so this works:

```bash
cd Aionis
npm run -s lite:start
```

Enable semantic recall and recall-backed verification later by setting a provider
and matching key in `.env`. For `EMBEDDING_PROVIDER=openai`, that key is
`OPENAI_API_KEY`.

DashScope text-embedding-v4 is supported with `EMBEDDING_PROVIDER=dashscope`
and `DASHSCOPE_API_KEY`. Runtime uses the DashScope OpenAI-compatible embedding
endpoint and requests the configured `EMBEDDING_DIM` value.

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

After publishing installer packages, run the release smoke against the public npm
entrypoint:

```bash
npm run -s runtime:smoke:fresh-install
```

The smoke creates a temporary project and runs the same install path a new user
takes:

1. install a clean Runtime through the published installer package
2. assert the generated `.env` uses `EMBEDDING_PROVIDER=none`
3. start the installed Runtime without any embedding key
4. run `@aionis/mcp@latest` over stdio
5. call `aionis_record_step -> aionis_context`

Use overrides when validating a candidate package or branch:

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC=@aionis/create@latest \
AIONIS_FRESH_INSTALL_SDK_SPEC=@aionis/sdk@latest \
AIONIS_FRESH_INSTALL_MCP_SPEC=@aionis/mcp@latest \
AIONIS_FRESH_INSTALL_REPO=https://github.com/ostinatocc/Aionis.git \
AIONIS_FRESH_INSTALL_RUNTIME_REF=main \
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
