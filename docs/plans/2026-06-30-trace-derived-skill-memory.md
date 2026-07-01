# Trace-Derived Skill Memory Plan

Status: product execution plan

Date: 2026-06-30

## Goal

Turn Trace-Derived Skill Candidates into reviewed, governed, reusable execution
skill memory.

The target product loop is:

```text
execution trace
-> feedback attribution
-> measure
-> trace-derived skill candidate
-> operator or host review
-> procedure memory draft
-> observe commit
-> guide recall
-> feedback and measure prove reuse
```

This is an Execution Memory capability. It is not an autonomous training loop,
not an Agent runner, and not a direct prompt-injection path.

## Current Implementation

Aionis already has the first half of the loop:

| Surface | Current state |
|---|---|
| Candidate schema | `aionis_trace_derived_skill_candidate_v1` exists in `AionisEffectReport.training_candidates`. |
| Candidate generation | `POST /v1/measure` projects positive continuity and workflow-reuse evidence into `trace_derived_skill` candidates. |
| Safety contract | Candidates are always `authority_state: "candidate"`, `agent_prompt_included: false`, and `runtime_mutation: false`. |
| Review ledger | `POST /v1/skills/candidates`, `GET /v1/skills/candidates`, `POST /v1/skills/candidates/:id/promote`, and `POST /v1/skills/candidates/:id/reject` exist. |
| Persistence | Lite Runtime stores review rows in `lite_skill_candidate_reviews`. |
| SDK projection | `@aionis/sdk` exposes candidate and review-item helpers for measure outputs. |
| Tests | Contract, assembler, review-store, and product-route tests cover the conservative candidate path. |

The missing half is deliberate: a promoted candidate is not yet materialized
into governed procedure memory that can be recalled by future guide calls.

## Product Contract

Trace-Derived Skill Memory must preserve these boundaries:

| Rule | Reason |
|---|---|
| Candidate is not memory | A single measured trace should not become current state by itself. |
| Promote is not prompt admission | Review approval records intent; it does not bypass Aionis admission. |
| Materialize returns a draft first | Operators and hosts must see what will be written before commit. |
| Observe commit is explicit | The Runtime should not silently mutate memory authority from review alone. |
| Procedure memory still passes admission | Future guide output must still route through `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`. |
| Rejected candidates stay inert | A rejected candidate cannot be materialized or recalled. |
| Candidate payload stays out of prompts | Candidate contracts are operator/control-plane data, not Agent instruction text. |

## Phase 1: Contract and Documentation

Lock the public contract before adding mutation paths.

Deliverables:

- Document Trace-Derived Skill Memory as a reviewed procedure-memory path.
- Keep candidate behavior conservative in product docs:
  - candidate-only
  - no prompt inclusion
  - no Runtime mutation
  - promotion gate required
- Add a focused output contract for `aionis_procedure_memory_draft_v1`.

Exit criteria:

- Product contract clearly distinguishes candidate, review, draft, commit, and
  admitted procedure memory.
- Docs do not imply automatic self-modification.

## Phase 2: Materialize Candidate Into Procedure Memory Draft

Add an explicit materialization surface:

```text
POST /v1/skills/candidates/:id/materialize
```

The endpoint should:

- require an existing promoted candidate
- reject pending and rejected candidates
- return a draft object
- not write a memory row
- not include the draft in Agent prompt context
- preserve source trace, evidence, applicability, non-applicability, procedure,
  acceptance, and counterexample fields

Draft contract:

```json
{
  "contract_version": "aionis_procedure_memory_draft_v1",
  "source_candidate_id": "skillcand_...",
  "source": "trace_derived_skill",
  "memory_kind": "procedure",
  "authority_state": "reviewed_candidate",
  "applies_when": [],
  "does_not_apply_when": [],
  "procedure_steps": [],
  "target_files": [],
  "acceptance_checks": [],
  "failure_counterexamples": [],
  "evidence_refs": [],
  "write_policy": {
    "requires_observe_commit": true,
    "agent_prompt_included": false,
    "runtime_mutation": false
  }
}
```

Exit criteria:

- Materialize works only for promoted candidates.
- Materialize output validates against schema.
- Materialize does not mutate memory.

## Phase 3: Explicit Observe Commit

Allow a host/operator to commit a procedure draft through existing observe
semantics.

Preferred path:

```text
POST /v1/observe
```

Recommended committed memory shape:

```json
{
  "input_text": "Procedure: continue verified execution state across sessions...",
  "memory": {
    "kind": "procedure",
    "authority_state": "reviewed_candidate",
    "source": "trace_derived_skill",
    "source_candidate_id": "skillcand_...",
    "promotion_status": "operator_promoted"
  },
  "execution": {
    "task_signature": "checkout-migration",
    "task_family": "coding",
    "target_files": ["src/checkout/adapter.ts"],
    "acceptance_checks": ["tests passed", "reviewer accepted"],
    "evidence_refs": ["effect_kernel:continuity", "run:run-001"]
  }
}
```

Exit criteria:

- Commit requires explicit host action.
- The committed procedure is recallable.
- Candidate rows remain unchanged except for review state.

## Phase 4: Guide Recall and Admission

Future guide calls should treat committed procedure memory as normal governed
memory.

Expected routing:

| Situation | Expected guide surface |
|---|---|
| Same `task_signature` or matching task family, current evidence, no conflicts | `use_now` or high-priority procedure candidate |
| Scope mismatch or weak applicability | `inspect_before_use` |
| Newer contested/suppressed evidence exists | `do_not_use` |
| Evidence is too large for compact context | `rehydrate` pointer |
| Candidate was not committed | not recalled as procedure memory |

Exit criteria:

- A promoted and committed procedure can help a future guide.
- A rejected or uncommitted candidate cannot influence guide.
- Procedure memory does not bypass lifecycle, authority, scope, source, or
  rehydrate gates.

## Phase 5: SDK Support

Add SDK helpers after Runtime contracts are stable.

Candidate helpers already exist:

```ts
traceDerivedSkillCandidatesFromMeasure(measure)
traceDerivedSkillReviewItemsFromMeasure(measure)
```

Proposed additions:

```ts
const draft = await aionis.materializeSkillCandidate(candidateId);
await aionis.commitProcedureMemoryDraft(draft);
```

Alternative namespace if the SDK adds grouped surfaces later:

```ts
const draft = await aionis.skills.materialize(candidateId);
await aionis.skills.commitProcedure(draft);
```

Exit criteria:

- SDK hides low-level draft boilerplate.
- SDK still requires explicit commit.
- SDK does not add any prompt-inclusion shortcut.

## Phase 6: Runtime E2E

Add a product E2E:

```text
trace-derived-skill-memory-loop.ts
```

Flow:

1. Observe an execution trace.
2. Guide the Agent.
3. Send positive feedback.
4. Measure the loop.
5. Assert `trace_derived_skill` candidate was generated.
6. Queue the candidate.
7. Promote the candidate.
8. Materialize a procedure memory draft.
9. Commit the draft through observe.
10. Start a fresh run with the same task family.
11. Guide recalls the committed procedure.
12. Feedback and measure show reuse contribution.

Required assertions:

- Candidate generated.
- Candidate queued.
- Candidate promoted.
- Draft materialized.
- Draft committed.
- Candidate itself never enters prompt context.
- Committed procedure still passes admission.
- Rejected candidate cannot be materialized.
- Uncommitted candidate cannot be recalled.
- Measure shows workflow or continuity reuse.

## Phase 7: Docs and Product Surface

Docs should position this as:

> Aionis turns verified execution traces into reviewed, governed procedure
> memory that can be reused across future Agent sessions.

Recommended docs:

- Runtime doc: `docs/AIONIS_TRACE_DERIVED_SKILL_MEMORY.md`
- Product contract section update.
- API usage section for:
  - queue
  - promote/reject
  - materialize
  - observe commit
  - guide reuse
- SDK quickstart section once helper methods exist.

Website positioning can come later. Until the E2E proves the closed loop, keep
it as an advanced Execution Memory capability rather than a homepage headline.

## Do Not Build Yet

Do not add these in the first implementation:

- automatic promotion
- automatic memory row mutation after promote
- automatic Agent prompt injection
- LLM rewrite of skill candidate payloads
- UI review console
- marketplace or shared skill library
- model-router behavior

## Release Gate

This capability is ready to call "Trace-Derived Skill Memory" when all of the
following are true:

- materialize endpoint exists and validates `aionis_procedure_memory_draft_v1`
- promoted candidate can produce a draft
- rejected or pending candidate cannot produce a draft
- observe commit writes a governed procedure memory
- guide can recall the committed procedure
- guide still applies normal admission gates
- E2E proves reuse in a fresh run
- docs explain the safety contract clearly

## Final Product Claim

After the release gate passes, Aionis can say:

> Aionis turns verified execution traces into reviewed, governed procedure
> memory that can be reused across future Agent sessions without bypassing
> admission, feedback, or audit.
