# Aionis Task Context Profiles

Status: product contract for Runtime / SDK hosts

Aionis uses one Runtime and one governance model. Task context profiles are a
thin Agent-facing compilation layer on top of that Runtime.

They do not change memory admission, lifecycle adjudication, authority gates,
feedback attribution, or Runtime storage. They only tell the context compiler how
to phrase the governed context for the current kind of Agent work.

## Why profiles exist

Different Agent loops fail in different ways:

- a coding verifier loop needs acceptance checks to remain visible;
- a document workflow needs file identity and original bytes to survive;
- a long-QA loop needs answer evidence and source spans;
- a handoff loop needs role ownership and current state;
- a loop-engineering run needs plan, validation, repair, and stop-state.

The Runtime should not hard-code any single task's behavior. Hosts select a
profile when they know the current task posture.

## API

Pass `task_context_profile` to `/v1/guide` or the SDK `guide()` call.

```json
{
  "query_text": "Continue the repository task.",
  "context_mode": "compact_agent",
  "task_context_profile": "coding_verifier"
}
```

The returned `agent_context` includes the selected profile:

```json
{
  "contract_version": "aionis_agent_context_v1",
  "task_context_profile": "coding_verifier",
  "prompt_text": "AIONIS_CTX v2\n..."
}
```

If omitted, the profile is `general`, and no profile-specific prompt line is
added.

## Profiles

| Profile | Use when | Agent-facing emphasis |
|---|---|---|
| `general` | Default product path | No extra task-specific context line. |
| `coding_verifier` | Coding tasks with tests, verifiers, build checks, or acceptance criteria | Keep non-excluded acceptance checks visible; do not complete by skipping or narrowing required checks. |
| `document_integrity` | Document classification, migration, extraction, archiving, or movement | Preserve original file bytes, names, and identity unless transformation is explicitly required. |
| `long_qa` | Long-memory QA, fact retrieval, source-grounded answering | Answer from covered evidence; prefer answerable facts, aliases, dates, and source spans; rehydrate missing evidence. |
| `multi_agent_handoff` | Planner/worker/verifier/reviewer handoff | Preserve role ownership, current handoff state, and verifier/reviewer boundaries. |
| `loop_engineering` | Plan-execute-validate-repair loops | Preserve plan, iteration, validator result, repair attempt, and stop reason. |

## Boundary

Profiles are not solution recipes and must not contain task-specific answers,
repository paths, benchmark expected outputs, or verifier-specific shortcuts.

Allowed:

- general execution posture;
- context phrasing;
- audit-visible profile selection;
- host/SDK defaults.

Not allowed:

- changing `use_now` / `inspect_before_use` / `do_not_use` semantics for one
  task;
- mutating Runtime memory because a profile was selected;
- turning a single benchmark failure into a Runtime rule;
- bypassing memory governance or feedback attribution.

## Product shape

The public product model is:

```text
one Runtime
  -> governed memory admission
  -> selected task context profile
  -> Agent-facing context
  -> feedback attribution and measurement
```

That lets Aionis support coding agents, document workflows, long-QA memory,
multi-agent handoff, and loop-engineered agents without fragmenting the Runtime.

