# External Agent Case Runbook

Status: repeatable case protocol

Date: 2026-07-01

This runbook defines how to run and record a real external Agent case for
Aionis. The current reference host is Claude Code because it exposes lifecycle
hooks and command-line automation, but the same evidence contract applies to
Codex-style hosts, Cursor-style MCP hosts, OpenClaw, Hermes Agent, or custom
Agent loops.

## Goal

Prove the product loop outside Aionis' own Runtime E2E harness:

```text
external Agent session 1
-> Aionis observes execution evidence and validation output
-> external Agent session boundary
-> Aionis compiles governed context for session 2
-> external Agent session 2 continues with shorter, auditable state
-> Aionis records outcome and attribution
```

The case should show:

- prior active state is available in the later session
- the Agent receives SDK `agent_prompt` governed context, not raw full history
- tool outcomes and validation evidence are recorded
- feedback can be attributed through `guide_trace_id` and memory IDs
- Flight Recorder or operator artifacts can explain what memory influenced the run

## Required Isolation

Run each external case in a fresh sandbox:

```text
/tmp/aionis-external-agent-case-<date>-<short-id>
```

Use a dedicated Runtime port and dedicated SQLite paths:

```bash
export PORT=3197
export LITE_WRITE_SQLITE_PATH="$CASE_DIR/.aionis/write.sqlite"
export LITE_REPLAY_SQLITE_PATH="$CASE_DIR/.aionis/replay.sqlite"
```

Do not reuse the developer Runtime from product development. The case should be
replayable without mutating local working memory.

## Setup

Install or start a local Runtime for the case:

```bash
npx @aionis/create@latest "$CASE_DIR/.aionis-runtime" \
  --provider minimax \
  --skip-quickstart

cd "$CASE_DIR/.aionis-runtime"
npm run -s lite:start
```

For a Claude Code case, install the lifecycle package from the sandbox project:

```bash
cd "$CASE_DIR/project"
npm exec --yes --package @aionis/claude-code@latest -- \
  aionis-claude-code install \
  --settings local \
  --claude-scope local \
  --base-url "http://127.0.0.1:3197" \
  --scope-from workspace \
  --mcp-name aionis-external-case
```

Check readiness:

```bash
npm exec --yes --package @aionis/claude-code@latest -- \
  aionis-claude-code doctor \
  --base-url "http://127.0.0.1:3197" \
  --scope-from workspace \
  --mcp-name aionis-external-case
```

The doctor output must show `ready: true`, `runtime_ok: true`, and hooks
installed for the intended scope.

## Case Shape

Use a two-session task that requires continuation:

1. Session 1 performs a real edit, runs validation, and leaves a clear active
   implementation surface.
2. Session 2 starts as a fresh external Agent session and continues the same
   implementation surface with an additional requirement.

Minimum project fixture:

```text
project/
  package.json
  src/<active-file>.js
  src/<legacy-or-reference-file>.js
  test/<active-test>.test.js
```

Recommended validation command:

```bash
npm test
```

## Evidence To Collect

Store all artifacts under:

```text
$CASE_DIR/reports/
```

Required artifacts:

| Artifact | Purpose |
|---|---|
| `episode-1.stream.jsonl` | Raw external Agent event stream for session 1. |
| `episode-2.stream.jsonl` | Raw external Agent event stream for session 2. |
| `episode-1-debug.log` | Hook/runtime debug output for session 1. |
| `episode-2-debug.log` | Hook/runtime debug output for session 2. |
| `aionis-guide-before-episode-2.json` | The guide/context that session 2 received. |
| `aionis-guide-after-episode-2.json` | The post-run guide showing retained state and memory IDs. |
| `operator-snapshot-after-episode-2.json` | Read-only operator snapshot, if available. |
| `flight-recorder-after-episode-2.json` | Read-only memory influence reconstruction, if available. |
| `summary.json` | Normalized case result. |

The normalized `summary.json` should include:

```json
{
  "contract_version": "aionis_external_agent_case_v1",
  "case_dir": "...",
  "runtime": {
    "base_url": "http://127.0.0.1:3197",
    "runtime_head": "..."
  },
  "external_host": {
    "name": "Claude Code",
    "version": "...",
    "integration": "@aionis/claude-code"
  },
  "episodes": [
    {
      "name": "episode_1",
      "aionis_context_injected": true,
      "validation_passed": true,
      "changed_files": []
    },
    {
      "name": "episode_2",
      "aionis_context_injected": true,
      "prior_state_present": true,
      "validation_passed": true,
      "changed_files": []
    }
  ],
  "context": {
    "history_used": true,
    "actionable_history_used": true,
    "use_now_memory_count": 0,
    "inspect_before_use_memory_count": 0,
    "do_not_use_memory_count": 0,
    "rehydrate_hint_count": 0,
    "agent_context_chars": 0
  },
  "audit": {
    "guide_trace_id_present": true,
    "memory_use_receipt_present": true,
    "flight_recorder_available": true
  },
  "result": "passed"
}
```

## Pass Criteria

The case passes when:

- Runtime health is OK before both sessions.
- The external host receives Aionis context before session 2 work begins.
- Session 2 context includes the active implementation surface from session 1.
- Session 2 completes the requested continuation and validation passes.
- The post-run guide exposes memory IDs and a traceable `guide_trace_id`.
- The result artifact states whether Flight Recorder or operator snapshot was
  available.

## Metrics To Report

| Metric | Meaning |
|---|---|
| continuation_success | Session 2 completed the requested continuation. |
| context_chars | Size of compiled Aionis context given to the external host. |
| active_state_present | The active implementation surface appeared in context. |
| validation_preserved | Previous validation evidence was visible or recoverable. |
| guide_trace_present | The run can be traced through a guide trace ID. |
| feedback_attribution_ready | Exposed memory IDs can be attributed in feedback. |
| audit_artifacts_present | Snapshot or Flight Recorder can reconstruct memory influence. |

## Existing Reference Result

The first committed v0.3 external case is:

```text
docs/AIONIS_EXTERNAL_CLAUDE_CODE_LONGFLOW.md
docs/examples/external-claude-code-longflow-result.json
```

It ran two separate Claude Code sessions, injected governed context into the
second session, continued the active route, and passed the project test suite.

## Next Case Expansion

For the next credible external case, keep the same protocol and vary one axis:

- a larger repository fixture
- a different external host
- a three-session continuation
- a multi-agent handoff shape
- a run with Substrate sidecar enabled for durable evidence mirroring

Do not combine all axes in one run. Change one axis at a time so the evidence
remains interpretable.
