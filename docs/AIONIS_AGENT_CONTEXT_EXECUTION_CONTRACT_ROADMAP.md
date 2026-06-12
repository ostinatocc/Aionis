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

## Phase 2: Route Contract Projection

Implemented scope:

Add a structured `agent_context.route_contract` projection. This is still a
product-output contract, not a new lifecycle gate. It makes the governed route
machine-readable for SDK, MCP, host adapters, and Agent prompts:

```json
{
  "active_targets": [
    {
      "target": "path-or-resource",
      "source_memory_id": "mem-...",
      "source": "should_continue",
      "artifact_status": "may_be_absent",
      "missing_policy": "restore_or_create_if_task_consistent_or_rehydrate"
    }
  ],
  "pending_artifacts": [
    {
      "target": "path-or-resource",
      "status": "unknown_until_host_observation",
      "when": "if_active_target_is_missing",
      "source_memory_id": "mem-...",
      "allowed_actions": ["create", "restore", "rehydrate"]
    }
  ],
  "reference_only_targets": [],
  "blocked_direction_targets": [],
  "fallback_policy": "do_not_promote_reference_or_blocked_targets"
}
```

The field is rendered into both standard `AIONIS_AGENT_CONTEXT v1` prompts and
compact `AIONIS_CTX v2` prompts. The wording is conditional: Aionis does not
claim a file is missing. It says that if the host observes an active target is
missing, absence alone is not stale proof; the Agent should restore, create, or
rehydrate before falling back to reference-only or blocked routes.

Wired product path:

1. execution-state memory packet / command posture
2. `agent_context.route_contract`
3. standard and compact Agent prompt rendering
4. SDK route-contract helpers
5. MCP structured output

It must not bypass stale, failed, contested, authority, or rehydration gates.

Deferred deeper scope:

1. observe / handoff inputs can eventually mark explicit `pending_artifacts`
   when the host knows an intended artifact does not exist yet
2. operator/audit surfaces can summarize route-contract adherence and
   right-history abandonment as a first-class metric
3. feedback/measure can attribute deviations from `active_targets` separately
   from wrong-history direct use

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
