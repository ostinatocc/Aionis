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
   - `missing_go=create_restore_raw_or_report_conflict_no_old`
   - `old_ref_not_supersede_go=1`
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
      "allowed_actions": ["create", "restore", "rehydrate", "report_conflict"],
      "preferred_action_order": ["create", "restore", "rehydrate", "report_conflict"],
      "terminal_inspect_allowed": false
    }
  ],
  "reference_only_targets": [],
  "blocked_direction_targets": [],
  "evidence_sources": [],
  "blocked_routes": [],
  "conflict_policy": "do_not_treat_missing_active_target_as_superseded",
  "fallback_policy": "do_not_promote_reference_or_blocked_targets",
  "action_policy": {
    "missing_active_target_preferred_order": ["create", "restore", "rehydrate", "report_conflict"],
    "terminal_inspect_allowed": false,
    "reference_fallback_requires": "explicit_raw_evidence_or_operator_confirmation"
  }
}
```

The field is rendered into both standard `AIONIS_AGENT_CONTEXT v1` prompts and
compact `AIONIS_CTX v2` prompts. The wording is conditional: Aionis does not
claim a file is missing. It says that if the host observes an active target is
missing, absence alone is not stale proof; the Agent should restore, create, or
rehydrate before falling back to reference-only or blocked routes.

## Phase 3: Active-Route Conflict Resolution

Implemented scope:

1. Keep the Phase 1/2 fields and lifecycle gates intact.
2. Add `agent_context.route_contract.conflict_policy`:
   `do_not_treat_missing_active_target_as_superseded`.
3. Render the conflict policy before long target lists so it survives compact
   prompt truncation:
   - `conflict=missing_active_not_superseded`
   - `missing_action=create/restore/rehydrate/report`
   - `old_ref_not_supersede=1`
4. Strengthen standard prompt wording so an existing `INSPECT_FIRST` or
   `MUST_NOT` target cannot supersede `SHOULD_CONTINUE` merely because it
   exists in the workspace.

This phase still does not make Aionis an executor. If the Agent cannot safely
create or restore the active target, it should report the conflict or request
rehydration. It should not silently abandon the active route in favor of a
reference-only or blocked target.

## Phase 4: Active-Target Action Policy

Implemented scope:

1. Keep `route_contract` as the host-facing surface; do not add a parallel
   executor or task-specific rule layer.
2. Add ordered action policy for missing active targets:
   `create -> restore -> rehydrate -> report_conflict`.
3. Mark `terminal_inspect_allowed=false`. Inspection can gather evidence, but
   it is not a terminal action when Aionis has already provided a clear active
   route.
4. Require explicit raw evidence or operator confirmation before falling back
   from a missing active target to a reference-only or blocked target.
5. Render the policy as a separate prompt line so it is not lost behind long
   route target lists.

This still does not force the Agent to edit files. It makes the action contract
unambiguous for hosts and Agents: if the active target is absent, the next
decision must be create, restore, rehydrate, or report conflict, not quiet
abandonment of the active route after reading reference files.

Wired product path:

1. execution-state memory packet / command posture
2. `agent_context.route_contract`
3. standard and compact Agent prompt rendering
4. SDK route-contract helpers
5. MCP structured output

It must not bypass stale, failed, contested, authority, or rehydration gates.

## Phase 5: Structured Evidence And Blocked Route Projection

Implemented scope:

1. Keep the existing lifecycle, authority, premise, and rehydration gates
   unchanged.
2. Keep `reference_only_targets` and `blocked_direction_targets` for backwards
   compatibility.
3. Add explicit host-facing aliases:
   - `route_contract.evidence_sources`
   - `route_contract.blocked_routes`
4. Use the aliases to expose the same route semantics that external Agent E2E
   already measures as `active_target`, `evidence_source`, and blocked route
   behavior.

This phase avoids adding more prompt-level constraints. It makes the distinction
machine-readable:

1. `active_targets` are the governed continuation route.
2. `pending_artifacts` tell the host what to do if an active target is absent.
3. `evidence_sources` are readable reference evidence, not the primary route.
4. `blocked_routes` are blocked directions that can only be used as
   counter-evidence.

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
