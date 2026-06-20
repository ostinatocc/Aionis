# @aionis/mcp

MCP stdio bridge for Aionis execution memory.

Docs: [https://docs.aionis.work/integrations/mcp](https://docs.aionis.work/integrations/mcp)

Use this package when you want Claude Code, Cursor, or another MCP client to
try Aionis without rewriting the host Agent loop first. MCP is the fastest
public trial path for Aionis Execution Memory: connect the bridge, call
`aionis_context`, and let the Agent continue from governed state instead of raw
chat history.

```bash
npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope-from workspace
```

Start a local Runtime first:

```bash
npx @aionis/create@latest
cd Aionis
npm run -s lite:start
```

Environment form:

```bash
AIONIS_BASE_URL=http://127.0.0.1:3001 \
AIONIS_TENANT_ID=default \
AIONIS_SCOPE_FROM=workspace \
npx @aionis/mcp@latest
```

Use `--scope my-project` when your host already knows the exact memory boundary.
Use `--scope-from workspace` for coding-agent clients so Aionis derives a stable
project scope from `.aionis/workspace.json`. If the MCP client launches outside
the repo, add `--repo-root /absolute/path/to/repo`. Git root, git remote, and cwd
identities are stored as aliases for the same `ws:<name>:<id>` scope, so
starting from a non-git directory and running `git init` later does not split
the execution memory boundary.

## Tools

The server exposes stable product tools, not internal Runtime packets:

| Tool | Purpose |
|---|---|
| `aionis_context` | Compile governed Agent context for the current run. Optionally records a lightweight observation first. |
| `aionis_record_step` | Record a planner/worker/verifier/reviewer step, including planner plan assets and rejected branch evidence. Feedback attribution is optional. |
| `aionis_handoff` | Record branch-aware multi-agent handoff state. |
| `aionis_remember` | Store ordinary project memory through the governed observe path. |
| `aionis_govern_memory` | Route external Mem0/Zep/vector/markdown candidates through Aionis Memory Firewall before prompt use. |
| `aionis_measure` | Measure whether guided memory changed the run. |
| `aionis_snapshot` | Return read-only operator/audit state. |
| `aionis_flight_recorder` | Replay what memory the Agent could see at decision time. |
| `aionis_health` | Check Runtime reachability. |

`aionis_context` is compiler-first. It calls Runtime guide through the SDK, then
renders the same `aionis_execution_agent_context_v1` contract that SDK users get
from `compileExecutionAgentContext()`. The top-level `agent_prompt` field is kept
for MCP clients that only want prompt text; richer clients should read
`structuredContent.execution_context`.

It accepts `context_mode: "compact_agent"` when an MCP client needs a shorter
Runtime guide, and `budget_profile`, `max_prompt_chars`, `repo_state`, and
`additional_instructions` when the host can provide execution-environment facts.
For example, pass `repo_state.missing_files` so Aionis can tell the Agent that a
missing active target is pending work rather than stale memory.

For Claude Code or Cursor demos, the recommended first loop is:

```text
aionis_context -> Agent action -> aionis_record_step -> aionis_flight_recorder
```

Use this flow:

1. Use `aionis_record_step` as a planner to record the accepted plan,
   active targets, acceptance checks, and execution boundary.
2. Use `aionis_record_step` again for any rejected branch as `outcome:
   "failed"` with the rejected target files.
3. Ask `aionis_context` for the worker/reviewer context before implementation.
4. Use `aionis_flight_recorder` after the run to replay which plan memories and
   failed branches were visible at decision time.

This is the MCP shape of Aionis Plan as Memory Asset: the MCP client can use a
strong planner once, then let later workers continue from adjudicated execution
memory instead of raw chat history.

The tool returns these structured fields in `structuredContent`:

| Field | Meaning |
|---|---|
| `execution_context` | SDK-compiled execution contract, including active targets, missing active targets, warnings, and final `agent_prompt`. |
| `memory_use_receipt` | Compact audit receipt showing which memories were exposed, suppressed, rehydrated, or attributed. |
| `memory_admission_record` | Read-only per-memory admission ledger for host/operator logs and future dataset export. |
| `rehydrate_requests` | Memory IDs that need raw evidence recovery before exact use. |
| `execution_warnings` | Runtime/SDK warnings such as missing active targets or blocked routes. |
| `command_posture` | Bounded Agent instructions compiled from governed memory surfaces. |
| `must_not_memory_ids` | Failed, stale, suppressed, or do-not-use memories the client should not continue. |
| `should_continue_memory_ids` | Current active state or accepted procedure memories the client should prefer. |
| `inspect_first_memory_ids` | Candidate or contested memories that require inspection before action. |
| `rehydrate_first_memory_ids` | Compact pointers that need raw payload recovery before exact use. |

Use `aionis_govern_memory` when an MCP client already has memories from Mem0,
Zep, Supermemory, Pinecone, pgvector, Chroma, Weaviate, LangGraph Store,
markdown, logs, or another backend and needs Aionis to decide which ones may
direct the Agent:

```json
{
  "query_text": "Continue without reusing failed branches.",
  "mode": "firewall",
  "candidates": [
    {
      "external_memory_id": "mem0:current",
      "source_backend": "mem0",
      "text": "Current accepted target is packages/api/src/checkout.ts.",
      "authority": {
        "source_trust": "trusted",
        "scope": "project",
        "evidence_requirement": "none"
      },
      "lifecycle_hint": "current"
    }
  ]
}
```

Use `aionis_flight_recorder` after a run to inspect the read-only incident replay
report. The report includes memory IDs and attribution surfaces, but excludes
raw prompt text and raw memory payloads.

## Claude Code / Cursor Config

Use the MCP client's command/args configuration:

```json
{
  "mcpServers": {
    "aionis": {
      "command": "npx",
      "args": [
        "-y",
        "@aionis/mcp@latest",
        "--base-url",
        "http://127.0.0.1:3001",
        "--scope-from",
        "workspace"
      ],
      "env": {
        "AIONIS_TENANT_ID": "default"
      }
    }
  }
}
```

Zed/Zcode-style clients use `context_servers`:

```json
{
  "context_servers": {
    "aionis": {
      "command": "npx",
      "args": [
        "-y",
        "@aionis/mcp@latest",
        "--base-url",
        "http://127.0.0.1:3001",
        "--scope-from",
        "workspace"
      ],
      "env": {
        "AIONIS_TENANT_ID": "default"
      }
    }
  }
}
```

When the host starts MCP from a non-repo cwd, add:

```json
"--repo-root",
"/absolute/path/to/your/repo"
```

All Agent roles that use the same derived scope can share Aionis execution
memory across sessions: planner records plan assets, worker asks
`aionis_context`, verifier records outcomes, and reviewer can inspect the run via
`aionis_flight_recorder`.

Start a local Runtime first:

```bash
cd Aionis
npm run -s lite:start
```

For deeper host integration, use `@aionis/sdk`. The MCP bridge is the
drop-in path; the SDK is the full application integration path.

Claude Code / Cursor walkthrough:
[https://docs.aionis.work/integrations/mcp](https://docs.aionis.work/integrations/mcp)

Runnable proof artifacts:
[https://docs.aionis.work/examples](https://docs.aionis.work/examples)
