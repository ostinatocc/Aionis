# Aionis Governance Policy V1

Status: product contract for the current Runtime governance path

This document defines the rule surface behind Aionis memory governance. It is
intended to make governance auditable as policy, not only as an after-the-fact
result.

## Scope

This contract covers the product admission surfaces used by `POST
/v1/memory/govern` and by the Agent-facing guide output:

```text
use_now | inspect_before_use | do_not_use | rehydrate
```

The external memory gateway is read-only. It governs candidates from Mem0, Zep,
vector databases, markdown, logs, or other stores before they become Agent
context. It does not write those external candidates into Runtime memory.

## Governance Model

The current external candidate governance path is deterministic and
metadata-driven. It is not an LLM classifier, and it is not a learned policy
loop.

Inputs that affect the external admission decision:

| Field | Values | Product meaning |
|---|---|---|
| `authority.source_trust` | `trusted`, `known`, `untrusted`, `unknown` | Whether the source can directly guide an Agent. |
| `authority.scope` | `user`, `project`, `team`, `org`, `global`, `unknown` | The declared authority boundary of the candidate. |
| `authority.evidence_requirement` | `none`, `inspect_before_use`, `rehydrate_before_use`, `blocked` | Whether the candidate can be used directly, must be inspected, needs payload expansion, or is blocked. |
| `lifecycle_hint` | `current`, `procedure`, `failed`, `stale`, `contested`, `suppressed`, `archived`, `unknown` | The lifecycle state supplied by the source or host. |
| `mode` | `standard`, `strict`, `firewall` | Admission strictness for direct use and unsafe candidates. |
| text lifecycle signals | inferred from candidate text | A conservative signal that the candidate describes failed, stale, blocked, or rehydrate-required history. |

If `authority` is missing, it defaults to:

```json
{
  "source_trust": "unknown",
  "scope": "unknown",
  "evidence_requirement": "inspect_before_use"
}
```

If `lifecycle_hint` is missing, it defaults to `unknown`.

## Decision Table

The external admission policy is evaluated in this order:

| Order | Condition | `standard` result | `strict` result | `firewall` result |
|---:|---|---|---|---|
| 1 | `evidence_requirement: "blocked"` | `do_not_use` | `do_not_use` | `do_not_use` |
| 2 | `lifecycle_hint: "suppressed"` or `"archived"` | `do_not_use` | `do_not_use` | `do_not_use` |
| 3 | `evidence_requirement: "rehydrate_before_use"` | `rehydrate` | `rehydrate` | `rehydrate` |
| 4 | lifecycle is `failed`, `stale`, or `contested` | `inspect_before_use` | `inspect_before_use` | `do_not_use` |
| 5 | text signal says direct use is unsafe | `inspect_before_use` | `inspect_before_use` | `do_not_use` |
| 6 | `evidence_requirement: "inspect_before_use"` | `inspect_before_use` | `inspect_before_use` | `inspect_before_use` |
| 7 | trusted enough and lifecycle is `current` or `procedure` | `use_now` for `trusted` or `known` | `use_now` only for `trusted` | `use_now` only for `trusted` |
| 8 | anything else | `inspect_before_use` | `inspect_before_use` | `inspect_before_use` |

`authority.scope` is preserved in reason codes and audit surfaces. Tenant and
Runtime scope isolation are enforced by request identity and recall visibility,
not by this external candidate decision table alone.

## Surface Meanings

| Surface | Agent meaning | Host meaning |
|---|---|---|
| `use_now` | This memory may direct the next action. | The candidate had sufficient trust, lifecycle, and evidence state for direct use. |
| `inspect_before_use` | Inspect current evidence before acting from it. | The candidate may be useful, but it is not direct-use authority. |
| `do_not_use` | Do not let this memory direct the action. | The candidate is blocked, suppressed, archived, failed, stale, contested, or policy-blocked. |
| `rehydrate` | Open raw/source evidence before exact use. | The candidate is pointer-only or requires payload/archive expansion. |

## Audit Outputs

Every governed response should give the host enough information to reconstruct
why memory was exposed or blocked without putting raw internals in the Agent
prompt.

| Output | Purpose |
|---|---|
| `agent_context` | The bounded Agent-facing context. |
| `memory_use_receipt` | Compact read-only receipt of exposed, blocked, and rehydrate-first memory IDs. |
| `memory_admission_records` | Optional per-memory admission rows when `include_records: true`. |
| `memory_firewall` | Firewall-mode summary, including unsafe direct-use counts. |
| `admission_summary` | Counts by admission action and source backend. |
| `source_map` | Route and internal surface provenance. |

Admission records and receipts use reason codes such as:

```text
external_candidate_admission
mode:<standard|strict|firewall>
source_backend:<backend>
source_trust:<trusted|known|untrusted|unknown>
scope:<user|project|team|org|global|unknown>
evidence_requirement:<none|inspect_before_use|rehydrate_before_use|blocked>
lifecycle_hint:<current|procedure|failed|stale|contested|suppressed|archived|unknown>
lifecycle_candidate_signal:unsafe_direct_use
trusted_current_or_procedure_candidate
candidate_requires_inspection_before_direct_use
candidate_blocked_from_agent_action
candidate_requires_rehydration_before_exact_use
```

## What Governance Does Not Do

Aionis governance does not prove that a memory is true. It controls whether a
candidate is allowed to influence the Agent directly.

This policy also does not:

- use an LLM to classify external candidates;
- silently promote unknown memory into direct-use context;
- mutate Runtime memory during `/v1/memory/govern`;
- resolve all cross-Agent conflicts by itself;
- replace host feedback and verifier evidence.

## Implementation Anchors

The current implementation anchors are:

- `src/memory/product-output-contract.ts` for candidate and authority schemas.
- `src/product/guide-service.ts` for the external admission
  decision table and reason codes.
- `src/routes/product-facade.ts` for the `/v1/memory/govern` route schema and
  response shape.
- [AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md#post-v1memorygovern)
  for product API usage.
- [AIONIS_MEMORY_FIREWALL.md](AIONIS_MEMORY_FIREWALL.md) for firewall-mode
  examples and claims.
