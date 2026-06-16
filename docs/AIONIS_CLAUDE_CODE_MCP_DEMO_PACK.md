# Aionis Claude Code MCP Demo Pack

Status: external demo script for Claude Code, Cursor-style MCP clients, and
developer launch material

This pack turns the existing Aionis MCP quickstart into a 3-5 minute demo. It
is designed for a screen recording, live walkthrough, launch post, or customer
call.

## Core Story

Most memory tools retrieve related history. Aionis decides what history is
allowed to affect the next action.

In the demo, Claude Code records three execution memories:

1. a planner plan asset with decisions and acceptance checks
2. a failed legacy route
3. an accepted current route

Then Claude Code asks Aionis for context. Aionis compiles an execution-memory
contract that tells the Agent what to continue, what to inspect, and what not to
turn into a direct instruction. The same trace can be replayed through Agent
Flight Recorder.

The demo claim is intentionally narrow:

> Claude Code can use Aionis over MCP to get governed execution memory without a
> custom host adapter.

## What The Viewer Should Remember

- Aionis is not a second Agent. Claude Code still reasons and acts.
- Aionis is the memory and governance layer before the next Agent turn.
- Failed branches stay visible as evidence, but they do not become the next
  implementation instruction.
- The operator can replay what memory was visible at decision time.
- The first integration can be drop-in: MCP context first, feedback loop later.

## Prerequisites

- Node.js `>=22.5.0`
- Claude Code CLI
- Aionis Runtime installed from GitHub or `@aionis/create`
- Embedding provider configured for guide/context

Install Aionis from npm:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart sdk
```

Or run from a local checkout:

```bash
export EMBEDDING_PROVIDER=minimax
export MINIMAX_API_KEY="your-key"
npm run -s lite:start
```

## Demo Flow

### 1. Show The Problem

Narration:

```text
Coding Agents do not only need more memory. They need memory that knows which
branch succeeded, which branch failed, and what is safe to continue.
```

Show this simple branch history:

```text
planner plan -> scoped checkout route is the intended continuation
legacy checkout route -> verifier failed
scoped checkout route -> accepted
```

### 2. Add Aionis To Claude Code

In the project where Claude Code runs:

```bash
claude mcp add --transport stdio --scope project aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope checkout-migration
```

Then verify:

```text
/mcp
```

Expected visual point:

```text
aionis_context
aionis_record_step
aionis_flight_recorder
aionis_health
```

### 3. Record Execution Evidence

Paste the demo prompt from:

[examples/claude-code-aionis-demo-prompt.md](examples/claude-code-aionis-demo-prompt.md)

The prompt asks Claude Code to call:

```text
aionis_health
-> aionis_record_step planner plan asset
-> aionis_record_step failed legacy branch
-> aionis_record_step accepted current branch
-> aionis_context
-> aionis_flight_recorder
```

### 4. Show Governed Context

Narration:

```text
This is the difference between recall and state. Both memories are related, but
only one is allowed to guide the next action.
```

Point to these fields in `aionis_context`:

```text
plan asset recorded            planner decisions and acceptance checks were observed
use_now_memory_ids              accepted current route
inspect_before_use_memory_ids   failed legacy route as reference-only evidence
memory_use_receipt              why each memory was exposed or suppressed
memory_admission_record         per-memory admission decision
agent_prompt                    bounded contract for Claude Code
```

Expected contract shape:

```text
AIONIS_EXECUTION_AGENT_CONTEXT
- continue accepted route
- inspect failed route only as counter-evidence
- do not promote reference-only targets into primary direction
- rehydrate raw evidence on demand
```

### 5. Show Flight Recorder

Narration:

```text
After an Agent decision, Aionis can answer what the Agent could see and why.
That is the flight recorder for memory-driven Agent behavior.
```

Point to:

```text
agent_prompt_included: false
runtime_mutation: false
use_now_memory_ids: [...]
blocked_or_suppressed_count: ...
replay_sources.has_memory_use_receipt: true
```

The operator gets replay without dumping raw prompt payloads.

## 3-Minute Talk Track

```text
Most Agent memory products optimize for recall: bring back related history.
Aionis starts one step later: should this history be allowed to affect the next
action?

Here Claude Code has three pieces of execution memory. A planner produced a
route plan with acceptance checks. One route failed verifier checks. Another
route was accepted. A normal recall layer can retrieve all of them because they
are semantically related to the current task.

Now Claude Code asks Aionis for context over MCP. Aionis compiles the execution
state into a contract. The accepted branch goes into use_now. The failed branch
is still visible, but only as inspect-first counter-evidence. It is not allowed
to become the next implementation instruction.

That is the product difference: Aionis does not just remember. It adjudicates
state, compiles context, and leaves an audit trail.

The same run can be replayed through Agent Flight Recorder. We can see what
memory was visible at decision time, what was blocked or downgraded, and
whether feedback was attributed. Claude Code remains the Agent. Aionis is the
memory governance Runtime beside it.
```

## One-Screen Terminal Version

For a short terminal-only demo, run:

```bash
export EMBEDDING_PROVIDER=minimax
export MINIMAX_API_KEY="your-key"
npm run -s runtime:quickstart:claude-code-mcp
```

Expected checks:

```json
{
  "context_compiled": true,
  "should_continue_present": true,
  "failed_branch_guard_present": true,
  "memory_use_receipt_visible": true,
  "memory_admission_record_visible": true,
  "flight_recorder_replayed": true,
  "no_prompt_payload_in_recorder": true,
  "no_runtime_mutation_in_recorder": true
}
```

## What Not To Claim

Do not claim this demo proves Aionis solves arbitrary coding tasks. Aionis does
not replace Claude Code, the shell, CI, or the verifier.

Claim this instead:

```text
Aionis gives Claude Code governed execution memory over MCP: what to continue,
what to inspect, what not to reuse, and what can be replayed later.
```

## Links

- Docs: <https://docs.aionis.work>
- MCP integration: <https://docs.aionis.work/integrations/mcp>
- Examples and proof artifacts: <https://docs.aionis.work/examples>
- MCP package: `@aionis/mcp`
- SDK package: `@aionis/sdk`
- Installer: `@aionis/create`
- Detailed MCP guide: [AIONIS_MCP.md](AIONIS_MCP.md)
- Claude Code demo guide: [AIONIS_CLAUDE_CODE_DEMO.md](AIONIS_CLAUDE_CODE_DEMO.md)
- Real transcript: [examples/claude-code-real-demo-transcript.md](examples/claude-code-real-demo-transcript.md)
