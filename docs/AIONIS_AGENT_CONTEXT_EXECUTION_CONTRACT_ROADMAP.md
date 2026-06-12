# Aionis Agent Context Execution Contract Roadmap

Status: product-output roadmap, not a new Runtime core gate

This document tracks the execution-contract work that sits between Aionis memory
governance and a host Agent's next action. It exists to prevent one external
Agent run from turning into hidden core rules while still closing real product
gaps exposed by end-to-end runs.

## Problem

Aionis can correctly compile execution memory into:

1. `use_now` / `should_continue`
2. `inspect_before_use` / `inspect_first`
3. `do_not_use` / `must_not`
4. `rehydrate_hints` / `rehydrate_first`

The remaining product gap is the last mile: an Agent may abandon correct active
history when the observed workspace appears to conflict with the memory. A common
case is a `should_continue` route that points to an artifact that is not present
yet. The Agent may interpret absence as proof that the memory is stale and fall
back to an older path that merely exists on disk.

This is not the same as wrong-history reuse. It is right-history abandonment:
Aionis exposed the correct active route, but the host Agent silently downgraded
it after a local observation.

## Phase 1: Prompt-Level Contract

Implemented scope:

1. Keep the existing lifecycle, authority, recall, and command-posture gates
   unchanged.
2. Add an Agent-facing execution-contract rule:
   - a missing `SHOULD_CONTINUE` target is not, by itself, proof that the memory
     is stale
   - the Agent should restore or create the active target when consistent with
     the task, or request rehydration before falling back
   - `INSPECT_FIRST` is reference-only evidence and must not replace
     `SHOULD_CONTINUE`
   - `MUST_NOT` blocks direction; any inspection is only counter-evidence or
     reference
3. Render compact contract prompts with explicit surface markers:
   - `missing_go=restore_or_rehydrate_not_old`
   - `chk=reference_only_not_primary`
   - `no=blocked_direction`
   - `inspect: ... ref=1 primary=0`
   - `avoid: ... dir=blocked ref=counter`

This phase deliberately does not add an automatic "create missing file" rule.
Aionis should not decide the concrete action for the Agent; it should preserve
the governed priority order and make fallback unsafe unless evidence is restored.

## Phase 2: Pending Artifact Schema

Deferred scope:

Add a structured representation for active targets that may not exist yet. The
likely shape is a bounded execution-state field such as:

```json
{
  "pending_artifacts": [
    {
      "artifact": "path-or-resource",
      "status": "expected_missing",
      "reason": "accepted continuation has not materialized this target yet",
      "source_memory_id": "mem-...",
      "allowed_actions": ["create", "restore", "rehydrate"]
    }
  ]
}
```

This should be considered only after multiple unrelated E2E runs show the same
failure mode. If implemented, it must be wired through the existing product path:

1. observe / handoff structuring
2. execution-state memory packet
3. guide packet
4. `agent_context`
5. SDK and host integration docs
6. operator/audit surfaces

It must not bypass stale, failed, contested, authority, or rehydration gates.

## Non-Goals

1. Do not encode repository-specific paths or procedures into Runtime source.
2. Do not make "target missing => create it" a universal core rule.
3. Do not let an LLM candidate upgrade failed, stale, contested, or rehydrate
   memories into direct use.
4. Do not append audit internals to the Agent prompt.

## Evaluation Notes

External Agent E2E should track this as a separate failure bucket:

`right_history_abandonment`

This bucket applies when Aionis exposes the correct active route, but the Agent
abandons it because local workspace observations appear to contradict the route.
It should be reported separately from wrong-history write or wrong-history
attention.
