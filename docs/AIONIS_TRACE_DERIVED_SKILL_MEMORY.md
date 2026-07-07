# Aionis Trace-Derived Skill Memory

Status: Runtime capability contract for reviewed trace-derived skill learning

Trace-Derived Skill Memory is the Aionis path for turning verified execution
traces into reviewed, governed procedure memory. It is an Execution Memory
capability: successful work can produce reusable skill candidates, but the
Runtime does not turn one run into an automatic rule or prompt instruction.

The intended product loop is:

```text
Agent execution trace
-> feedback attribution
-> measure
-> trace-derived skill candidate
-> operator or host review
-> procedure memory draft
-> explicit observe commit
-> guide recall through normal admission gates
-> feedback and measure prove reuse
```

The current Runtime implements this loop through an explicit draft-and-observe
path. Review and materialization do not mutate memory; only the host's explicit
`observe` commit can make the procedure recallable through normal `guide`
admission.

## Current Implementation

| Surface | Current state |
|---|---|
| Candidate schema | `aionis_trace_derived_skill_candidate_v1` is part of `AionisEffectReport.training_candidates`. |
| Candidate generation | `POST /v1/measure` projects positive continuity or workflow-reuse evidence into `trace_derived_skill` candidates. |
| Review ledger | `POST /v1/skills/candidates`, `GET /v1/skills/candidates`, `POST /v1/skills/candidates/:id/promote`, and `POST /v1/skills/candidates/:id/reject`. |
| Materialization | `POST /v1/skills/candidates/:id/materialize` returns an `aionis_procedure_memory_draft_v1` and a recommended `/v1/observe` payload for promoted, export-ready positive candidates only. |
| Persistence | Lite Runtime stores review rows in `lite_skill_candidate_reviews`. |
| SDK helpers | `traceDerivedSkillCandidatesFromMeasure()`, `traceDerivedSkillReviewItemsFromMeasure()`, `materializeSkillCandidate()`, and `observeMaterializedSkillCandidate()` expose the host flow. |
| Agent behavior | Candidates and drafts do not enter `agent_context`, do not mutate memory, and do not influence `guide` by themselves. A committed observe payload can later be recalled as governed execution memory. |

Current source of truth:

- Product contract: [AIONIS_PRODUCT_CONTRACT.md](AIONIS_PRODUCT_CONTRACT.md#trace-derived-skill-candidates)
- Output schema: [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md)
- API usage: [AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md)
- Implementation plan: [plans/2026-06-30-trace-derived-skill-memory.md](plans/2026-06-30-trace-derived-skill-memory.md)

## Candidate Contract

A trace-derived skill candidate captures a reusable execution lesson without
granting it authority. The candidate may include:

- applicability conditions
- non-applicability conditions
- procedure steps
- target files or target surfaces
- acceptance checks
- failure counterexamples
- source trace ids
- source signal ids
- evidence refs

The safety fields are part of the contract:

```json
{
  "contract_version": "aionis_trace_derived_skill_candidate_v1",
  "authority_state": "candidate",
  "promotion_status": "candidate_only",
  "export_policy": {
    "agent_prompt_included": false,
    "runtime_mutation": false,
    "required_gate": "admission_and_promotion_gate"
  }
}
```

These fields mean:

| Field | Meaning |
|---|---|
| `authority_state: "candidate"` | The candidate is not stable procedure authority. |
| `agent_prompt_included: false` | The raw candidate is operator/control-plane data, not Agent prompt context. |
| `runtime_mutation: false` | Candidate generation and review do not rewrite memory rows. |
| `required_gate: "admission_and_promotion_gate"` | Later use must pass normal Aionis admission, lifecycle, feedback, and promotion gates. |

## Review API

The review ledger is intentionally separate from Agent behavior.

| Endpoint | Role | Runtime mutation |
|---|---|---|
| `POST /v1/skills/candidates` | Queue trace-derived skill candidates from a `measure_result` or `effect_report`. | Inserts or updates review rows only. |
| `GET /v1/skills/candidates` | List pending, promoted, rejected, or all candidates for a tenant/scope. | None. |
| `POST /v1/skills/candidates/:id/promote` | Record operator or host approval intent. | Updates review status only. |
| `POST /v1/skills/candidates/:id/reject` | Record operator or host rejection. | Updates review status only. |
| `POST /v1/skills/candidates/:id/materialize` | Return a reviewed procedure-memory draft and recommended observe payload. | None. |

`promote` is not prompt admission. It records that a human or host workflow
approved the candidate for the next controlled step. It does not create
procedure memory, change memory authority, or affect future guide output.
`materialize` also does not write memory; it only prepares a draft that the host
may explicitly inspect and submit to `POST /v1/observe`.

## Recommended Host Flow

1. Run the Agent with Aionis `guide`.
2. Send post-action `feedback` with `guide_trace_id`, `used_memory_ids`,
   `run_id`, `outcome`, and `used_surface`.
3. Call `measure` with the before/after guide trace and feedback result.
4. Extract `trace_derived_skill` candidates from `measure.effect_report`.
5. Queue candidates with `POST /v1/skills/candidates`.
6. Review candidates out of band.
7. Promote or reject each candidate.
8. Materialize promoted, export-ready positive candidates with
   `POST /v1/skills/candidates/:id/materialize`.
9. Inspect the returned `aionis_procedure_memory_draft_v1`.
10. Submit `recommended_observe_payload` to `POST /v1/observe` only when the
    host/operator accepts the draft.
11. Future `guide` calls can recall the committed procedure through normal
    admission, lifecycle, authority, and scope gates.

The Agent should receive SDK `agent_prompt` from `guideAgentContext()` /
`execution.guideAgentContextForRole()`. Direct HTTP hosts may use only
`agent_context.prompt_text` or selected `agent_context` fields from `guide`.
Candidate payloads, review rows, measure reports, and decision traces are
host/operator surfaces.

## Materialization Path

The explicit materialization surface is:

```text
POST /v1/skills/candidates/:id/materialize
```

This endpoint:

- require an existing promoted candidate
- reject pending and rejected candidates
- reject non-positive, non-export-ready, or non-`promotion_ready` candidates
- return an `aionis_procedure_memory_draft_v1`
- not write memory
- not include the draft in Agent prompt context
- preserve source trace, evidence, applicability, procedure, acceptance, and
  counterexample fields

The draft is committed through the normal `observe` path only after explicit
host/operator action. A committed procedure memory must still pass scope,
lifecycle, authority, source, and rehydrate gates before it can influence future
`guide` output.

Implemented route:

```text
promoted candidate
-> materialize draft
-> explicit observe commit
-> normal guide recall
-> feedback attribution
-> measure reuse contribution
```

## Boundaries

Trace-Derived Skill Memory must preserve these rules:

| Rule | Reason |
|---|---|
| Candidate is not memory | A single measured trace should not become current state by itself. |
| Review is not admission | Human or host approval records intent; it does not bypass Runtime gates. |
| Materialize returns a draft first | Operators and hosts must inspect what would be written. |
| Observe commit is explicit | Runtime memory authority should not change silently from a review row. |
| Procedure memory still passes admission | Future guide output must route through `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`. |
| Rejected candidates stay inert | Rejected candidates cannot be materialized or recalled. |
| Candidate payload stays out of prompts | Candidate contracts are audit/control data, not Agent instructions. |

Do not build automatic promotion, automatic memory row mutation after promote,
automatic Agent prompt injection, LLM rewrites of skill candidates, marketplace
sharing, or model-router behavior into this path.

## Release Gate

This capability is complete enough to call "Trace-Derived Skill Memory" when
all of the following remain true:

- materialize endpoint exists and validates `aionis_procedure_memory_draft_v1`
- promoted candidates can produce drafts
- rejected and pending candidates cannot produce drafts
- observe commit writes governed procedure memory
- guide can recall committed procedure memory
- guide still applies normal admission gates
- a Runtime E2E proves explicit observe is required before guide reuse
- docs explain the safety contract without implying automatic self-modification

## Product Claim

Current accurate claim:

> Aionis turns verified execution traces into reviewed, governed procedure
> memory that can be reused across future Agent sessions without bypassing
> admission, feedback, or audit.
