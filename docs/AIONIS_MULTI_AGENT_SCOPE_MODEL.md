# Aionis Multi-Agent Scope Model

Status: product contract for multi-Agent memory visibility and isolation

This document defines the tenant, scope, lane, agent, and team boundaries used
by Aionis when multiple Agents share execution memory.

## Product Boundary

Aionis is a multi-Agent execution memory backend. It records what Agents did,
controls which memory is visible to a later Agent, compiles branch-aware
context, and attributes feedback to the memory that was actually exposed.

Aionis does not schedule Agents and does not own host orchestration. The host
decides which Agent acts next.

## Identity Fields

| Field | Meaning |
|---|---|
| `tenant_id` | Top-level tenant boundary. |
| `scope` | Project or workspace memory boundary. Agents sharing a scope can share memory according to lane and owner fields. |
| `producer_agent_id` | Agent that wrote an observed memory or execution event. |
| `consumer_agent_id` | Agent receiving guide, recall, rehydrate, or context output. |
| `owner_agent_id` | Agent owner for agent-private memory. |
| `owner_team_id` | Team owner for team-visible or team-private memory. |
| `consumer_team_id` | Team identity used when reading team-owned memory. |
| `memory_lane` | `private` or `shared`. Controls the default visibility lane. |
| `agent_role` | Product role hint such as `planner`, `worker`, `verifier`, or `reviewer`. It does not override visibility. |

## Scope

`scope` is the project/workspace boundary. It is not a role, not a single task,
and not an Agent identity.

Examples:

```text
payments-service
checkout-migration
ws:checkout-service:<id>
```

The MCP bridge can derive a stable workspace scope with `--scope-from workspace`.
An explicit `--scope` has highest priority when the host already knows the
memory boundary.

## Visibility Matrix

Memory is visible only inside the same tenant and scope, then filtered by lane
and owner fields.

| Write lane and owner | Visible to |
|---|---|
| `memory_lane: "shared"` with no `owner_team_id` | Any consumer in the same tenant and scope. |
| `memory_lane: "shared"` with `owner_team_id` | Consumers carrying the same `consumer_team_id`. |
| `memory_lane: "private"` with `owner_agent_id` | The same `consumer_agent_id`. |
| `memory_lane: "private"` with `owner_team_id` | Consumers carrying the same `consumer_team_id`. |

The implementation also preserves explicit owner access when `owner_agent_id`
is set on a shared row. Product integrations should still treat team-owned
shared memory as team-boundary memory and pass `consumer_team_id` on reads.

## Defaults

The focused Runtime fills local defaults so single-Agent local usage works
without requiring every host to pass every identity field.

Important defaults:

- write paths default `memory_lane` to `private`;
- missing write actor and producer default to the local actor;
- private writes default `owner_agent_id` to the local actor when no owner is
  supplied;
- many read/context paths default `consumer_agent_id` to the local actor;
- shared multi-Agent adapters should require a team boundary.

These defaults are convenient for local single-Agent use. Multi-Agent hosts
should pass identity explicitly.

## Recommended Multi-Agent Pattern

For planner, worker, verifier, reviewer, or similar teams:

1. Use one stable `scope` for the project or workspace.
2. Write execution memory with `memory_lane: "shared"` and `owner_team_id`.
3. Set `producer_agent_id` on every `observe`.
4. Set `consumer_agent_id` and `consumer_team_id` on every `guide`.
5. Put role hints in top-level `agent_role`.
6. After action, call `feedback` with `guide_trace_id`, `used_memory_ids`,
   `run_id`, `outcome`, and `used_surface`.
7. Use private memory only when it should remain local to one Agent or one team.

For a single Agent, prefer `memory_lane: "private"` and a stable
`owner_agent_id`.

## Conflict Model

Aionis is not a distributed lock manager and does not use a silent
last-writer-wins rule for multi-Agent memory.

Multiple Agents can write into the same scope. The Runtime keeps those writes as
evidence and uses governance to decide what can influence the next action.

Conflict handling is evidence-driven:

| Conflict signal | Expected governance effect |
|---|---|
| failed execution branch | stays out of `use_now` and can appear as `do_not_use` or counter-evidence |
| stale or superseded memory | demoted or kept out of direct use when lifecycle evidence exists |
| contested memory | kept out of direct use until inspected or resolved |
| verifier/reviewer feedback | attribution can strengthen or weaken future use of exposed memory |
| missing active target | host should create, restore, rehydrate, or report conflict before falling back |
| unknown authority | defaults to inspect-before-use rather than direct use |

If two Agents write conflicting "current" memories without verifier,
lifecycle, or feedback evidence, the host should not assume Aionis has enough
information to pick the correct one. Mark the conflict, provide verifier
evidence, or route the result through reviewer feedback. Ambiguous memory should
be inspected before it directs action.

## Attribution Boundary

Feedback must be tied to memory that was exposed by a guide.

The normal attribution path is:

```text
guide -> Agent action -> feedback(guide_trace_id, used_memory_ids, outcome)
```

For `guide_trace_id` feedback, Aionis verifies the used memory IDs were exposed
by that guide. This prevents a later host from attributing success or failure to
memory that the Agent did not actually receive.

## Common Integration Failures

| Failure | Result | Fix |
|---|---|---|
| Wrong `scope` | Expected memory is not recalled. | Use stable workspace/project scope and keep it consistent across observe, guide, feedback, and rehydrate. |
| Missing `consumer_team_id` | Team-owned memory is invisible. | Pass the team ID on guide, recall, context, and rehydrate reads. |
| Accidental scope-wide shared memory | Other Agents in the same scope can see it. | Use `owner_team_id` or `memory_lane: "private"`. |
| Wrong `owner_agent_id` on private memory | The intended Agent cannot retrieve it. | Set explicit owner on write and matching consumer on read. |
| Feedback without guide exposure | Feedback is rejected or cannot be attributed. | Use `guide_trace_id` and `used_memory_ids` from the guide output. |
| Treating `agent_role` as access control | Role labels do not isolate memory. | Use lane, owner, team, and scope fields for visibility. |

## Audit Surfaces

Use these outputs to audit multi-Agent memory behavior:

| Surface | What it shows |
|---|---|
| `agent_context.memory_ids` and per-surface memory IDs | Which memory reached the Agent-facing context. |
| `memory_use_receipt` | Which memory was exposed, blocked, rehydrated, attributed, or left unattributed. |
| `memory_decision_trace` | Why a memory entered `use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate`. |
| `operator_snapshot` | Read-only summary of guide trace, branch isolation, and feedback attribution. |
| `measure` | Whether shared history changed the run positively or negatively. |

## Implementation Anchors

The current implementation anchors are:

- `src/memory/tenant.ts` for tenant-derived scope keys.
- `src/app/request-guards.ts` for identity defaults and server scope checks.
- `src/store/memory-visibility.ts` for lane/owner visibility.
- `src/store/lite-recall-store.ts` for SQL recall visibility filtering.
- `src/routes/product-facade.ts` for product guide, feedback, and rehydrate
  identity wiring.
- [AIONIS_MCP.md](AIONIS_MCP.md) for workspace scope derivation.
- [AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md#multi-agent-execution-memory)
  for host integration rules.
