# Aionis Rehydrate Contract

Status: product contract for the current Runtime rehydration path

This document defines what `rehydrate` means in Aionis. Rehydrate is a
host-controlled lifecycle and payload expansion action. It is not a hidden
prompt injection path.

## Product Boundary

Aionis keeps compact Agent context small by carrying summaries, memory IDs, and
rehydration hints instead of replaying full raw history. When compact context is
not enough for exact action, the host can call:

```http
POST /v1/rehydrate
```

The result can expand archived memory or anchor payloads for inspection and
follow-up. It does not automatically append the expanded payload to the Agent
prompt, and it does not bypass the normal `use_now`, `inspect_before_use`,
`do_not_use`, and `rehydrate` admission surfaces.

## When To Rehydrate

The host should call `POST /v1/rehydrate` only when one of these surfaces says
the compact context is insufficient:

| Trigger | Meaning |
|---|---|
| `agent_context.rehydrate_hints[]` | A memory needs raw/source evidence before exact use. |
| `command_posture[].posture: "rehydrate_first"` | The Agent should recover payload or trace before relying on exact details. |
| `route_contract.pending_artifacts[].allowed_actions` includes `rehydrate` | A governed continuation target may need restoration or evidence expansion. |
| `/v1/memory/govern` returns a candidate under `rehydrate` | External memory is pointer-only or requires source evidence. |
| Operator or host evidence says compact context is insufficient | Manual lifecycle control through the product route. |

## Request Targets

`POST /v1/rehydrate` maps to one of two internal targets.

| Target | How it is selected | What it does |
|---|---|---|
| `payload` | `anchor_id` or `anchor_uri` is present | Expands the payload refs behind an anchor. |
| `archive` | no anchor is present | Moves archived or colder memory nodes back to `warm` or `hot`. |

The product request supports:

| Field | Required | Meaning |
|---|---:|---|
| `reason` | Yes | Why compact context is insufficient. |
| `memory_ids` / `node_ids` / `client_ids` | Conditional | Memory nodes to rehydrate from archive. |
| `anchor_id` / `anchor_uri` | Conditional | Anchor payload to expand. |
| `target` | No | `archive`, `payload`, or `memory`; inferred when possible. |
| `target_tier` | No | `warm` or `hot` for archive rehydration. |
| `mode` | No | `summary_only`, `partial`, `full`, or `differential`. |
| `include_linked_decisions` | No | Whether payload rehydration should include linked execution decisions. |

## Rehydration Modes

| Mode | Use when | Output behavior |
|---|---|---|
| `summary_only` | The host only needs to know what payload is available. | Returns anchor metadata and linked counts without expanding nodes or decisions. |
| `partial` | The host needs compact supporting evidence. | Returns summaries for linked nodes, decisions, and commits. |
| `full` | Operator/debug flow needs exact stored refs. | Adds node slots, `raw_ref`, `evidence_ref`, and decision metadata where available. |
| `differential` | The host has a reason and wants only the most relevant linked payload. | Builds a selection plan and returns only selected nodes and decisions. |

`full` is not the default product path. Hosts should prefer `summary_only`,
`partial`, or `differential` unless they are building an operator/debug view.

## Archive Rehydration

Archive rehydration operates on memory nodes. It:

1. resolves requested node IDs or client IDs inside the tenant and scope;
2. checks visibility using the actor and optional `consumer_team_id`;
3. moves eligible nodes to `target_tier`;
4. writes a lifecycle commit;
5. records rehydration metadata such as time, reason, source tier, target tier,
   and input hash.

The response reports counts and IDs:

```json
{
  "target_tier": "warm",
  "commit_id": "commit-...",
  "rehydrated": {
    "resolved_node_ids": 2,
    "moved_nodes": 1,
    "unchanged_nodes": 1,
    "missing_node_ids": []
  }
}
```

Archive rehydration restores availability. It does not declare the memory safe
for direct use. The next guide still runs normal governance.

## Payload Rehydration

Payload rehydration operates on anchors. It:

1. resolves `anchor_id` or `anchor_uri`;
2. verifies tenant, scope, and visibility;
3. reads the anchor's `anchor_v1.payload_refs`;
4. expands linked nodes, decisions, and commits according to `mode`;
5. reports missing refs without silently fabricating payload.

The expanded payload can include:

| Payload part | Included when |
|---|---|
| anchor metadata | always |
| linked node summaries | `partial`, `full`, or `differential` |
| linked decisions | `partial`, `full`, or `differential`, when linked or requested by run |
| linked commits | `partial`, `full`, or `differential` |
| raw refs, evidence refs, slots, decision metadata | `full` |
| selected subset and rationale | `differential` |

## Merge Policy

Rehydration is a separate product action. The normal loop is:

```text
guide -> rehydrate hint -> POST /v1/rehydrate -> host inspection or next guide
```

Expanded payload should be used in one of these ways:

1. operator/debug inspection;
2. host-side evidence check before acting;
3. follow-up `observe` or `feedback` if the host learned a new outcome;
4. another `guide` call so Aionis can compile context under governance again.

A rehydrated payload does not automatically move into `use_now`. It remains
subject to lifecycle, authority, scope, feedback, and risk gates.

## Boundedness

Aionis avoids context explosion through three boundaries:

1. `guide` returns compact `rehydrate_hints` rather than raw payloads.
2. task context profiles cap how many rehydrate hints enter Agent context.
3. `/v1/rehydrate` is host-controlled and mode-based; hosts should not pass raw
   full payloads directly into an Agent prompt.

Current request schemas also cap fanout for common inputs, such as memory IDs,
anchor payload refs, linked decisions, and Runtime guide context budgets.

The v1 contract intentionally separates payload expansion from prompt
compilation. If a host wants the Agent to use rehydrated evidence, the safer
path is to re-run `guide` or render a bounded host summary from the rehydrated
payload.

## Failure Cases

Expected failure or partial-success cases include:

- anchor not found in the requested tenant/scope/visibility;
- node or client ID not found;
- anchor payload does not contain a valid `anchor_v1`;
- linked node, decision, or commit refs are missing;
- requested node is already at or above the target tier;
- the host asks for payload but supplies no anchor;
- the host asks for archive rehydration but supplies no memory identifiers.

These cases should be logged as lifecycle evidence. They should not silently
promote memory into direct Agent use.

## Implementation Anchors

The current implementation anchors are:

- `src/routes/product-facade.ts` for `POST /v1/rehydrate` request parsing and
  dispatch.
- `src/memory/lifecycle-lite.ts` for archive node rehydration.
- `src/memory/rehydrate-anchor.ts` for anchor payload rehydration.
- `src/memory/product-output-assembler.ts` for guide rehydrate hints and
  decision trace details.
- [AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md#post-v1rehydrate)
  for product API usage.
