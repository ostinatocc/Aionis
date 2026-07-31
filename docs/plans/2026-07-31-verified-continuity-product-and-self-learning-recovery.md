# Aionis Verified Continuity Product and Self-Learning Recovery Plan

**Date:** 2026-07-31
**Status:** Active
**Authority:** This document supersedes the Phase 3 execution status and next
steps in `2026-07-31-aionis-execution-memory-convergence-refactor.md`. It does
not rewrite or invalidate the historical evidence recorded there.

## 1. Product outcome

Aionis will first ship one understandable product:

> An Agent can stop, restart, switch model or process, and continue from the
> exact Runtime-owned current execution state without replaying the full chat
> history. A later failed branch can be restored to the exact previously
> verifier-accepted state.

The product-facing unit is `AgentSession` plus one Runtime-owned
`agent_context`. The current execution state is always first. Historical
experience is secondary and cannot impersonate current state.

Self-learning remains the long-term differentiator, but it is not allowed to
delay, obscure, or weaken Verified Continuity.

## 2. Current truth

### 2.1 Proven product effect

The existing real three-arm evidence shows:

- Aionis State preserved both tasks completed by Full History;
- Cold Restart completed none of the three tasks;
- on the two Full-History-solvable tasks, median input tokens fell 5.6%;
- one task remained unsolved by every arm, so broad task-success or universal
  token-efficiency claims are not justified.

This is enough to continue the Verified Continuity product. It is not yet broad
product proof.

### 2.2 Learning implementation truth

The Runtime currently has:

- verifier-bound execution episodes and immutable state/action evidence;
- a canonical L1 dataset with intervention, actual-use, reward, cost and
  contamination fields;
- rich canonical contracts for cohorts, procedure hypotheses, validation
  receipts and validated skills.

The Runtime does not currently have:

- a semantic/structural experience-cohort builder;
- a model-backed procedure compiler that reads real action artifacts and state
  transitions;
- authoritative skill/cohort persistence;
- a validated L3 skill that improves held-out verifier success;
- complete treatment assignment, exposure and propensity attribution;
- an L4 contextual utility selector;
- a learned L5 consolidation and forgetting policy.

The current count-based L2 and two-task L3 evaluator are experimental
prototypes. They are not completed transferable learning.

## 3. Non-negotiable decisions

### D1 — Verified Continuity is the current product mainline

No L4 selector, L5 policy, learning infrastructure, governance surface, or
additional abstraction layer may be implemented before the continuity product
is installable and usable through the canonical SDK path.

### D2 — Current state and historical learning are orthogonal

Current execution state is always available for an active episode and never
depends on L1-L5 promotion.

### D3 — L0/L1 are evidence, never reusable procedure authority

Historical L0/L1 memory may be retrieved as supporting evidence or
`inspect_before_use`. It may never enter `use_now`, even when its summary text
looks like a workflow or procedure.

### D4 — L2 is an inert hypothesis

L2 may appear only inside a named validation treatment. It cannot enter a
normal production Agent prompt.

### D5 — Only a validated L3 procedure may become reusable execution guidance

An L3 identity must bind the exact L2 procedure content admitted by a held-out
validation receipt. A semantic edit creates a new L2 version and requires new
validation.

### D6 — Do not learn selection from correlation

Selector training requires a durable candidate set, assignment, delivery,
prompt exposure, actual use, selection probability/propensity, outcome and
cost. A successful episode without these fields is outcome evidence, not a
causal selector-training row.

### D7 — One representation per learning layer

The canonical path is:

```text
CanonicalL1EpisodeV1
-> ExperienceCohortV1
-> ProcedureHypothesisV2
-> SkillValidationReceiptV1
-> ValidatedExecutionSkillV1
```

The simplified `ContrastiveL2HypothesisV1` and
`HeldoutL3SkillVersionV1` prototypes must not become a second product
authority.

### D8 — Frozen model, evolving external memory

Aionis self-learning is non-parametric runtime learning. The base Agent model
remains frozen; Aionis evolves verified external procedure memory and its
contextual utility.

## 4. Target product flow

```text
AgentSession.begin/resume
-> exact current state
-> compact Agent context
-> real action and state transition
-> Runtime-owned verifier
-> finish or exact accepted-branch recovery
-> canonical L1 evidence

shadow/offline only:
L1 cohort
-> procedure hypothesis
-> paired unseen validation
-> validated L3

only after a real L3 exists:
relevance gate
-> contextual utility selection
-> attributed outcome
-> lifecycle update
```

## 5. Phase 1 — Ship Verified Continuity

### Task 1.1 — Make historical L1 evidence-only at the first product boundary

- **Files:**
  - `src/memory/product-output/memory-packet.ts`
  - `src/memory/agent-context-compiler.ts`
- **Work:**
  1. classify every L0/L1 memory as `supporting_evidence_only`;
  2. ensure execution L1 cannot bypass the boundary by being textually
     recognized as a procedure;
  3. keep canonical current execution state on its separate authoritative path;
  4. preserve failed-branch blocking and evidence rehydration.
- **Output:** no historical L1 ID can appear in `use_now_memory_ids`.
- **Verification:** build a real Memory Packet and Agent Context containing a
  successful canonical L1 event; it remains inspect/evidence-only while the
  canonical current state remains first and usable.

### Task 1.2 — Make `AgentSession` the canonical developer quickstart

- **Files:**
  - `README.md`
  - `/Volumes/ziel/Ai/aionis-sdk/README.md`
- **Work:**
  1. put `agentSession.begin()/turn()/aroundAction()/runVerifier()/finish()` in
     the first executable integration example;
  2. remove the deleted measure/snapshot/candidate-export loop from the SDK
     product quickstart;
  3. describe ordinary memory APIs as supporting capabilities, not the primary
     continuity integration.
- **Output:** a normal developer encounters the working Verified Continuity
  path first.
- **Verification:** every method and route in the first example exists in the
  synchronized Runtime-owned SDK source.

### Task 1.3 — Align the installer with the current product

- **Files:**
  - `/Volumes/ziel/Ai/aionis-create/src/index.ts`
  - `/Volumes/ziel/Ai/aionis-create/test/create-aionis.test.ts`
- **Work:**
  1. update the default Runtime ref from `v0.3.6` to the current tagged
     `v0.3.12`;
  2. remove `/v1/measure` from the completion message;
  3. make the completion message point developers to `AgentSession` and the
     current five product POST routes.
- **Output:** a new installation no longer teaches a deleted product.
- **Verification:** package build plus the existing completion-message test.

### Task 1.4 — Make verifier onboarding a usable product flow

- **Scope:** `@aionis/create` and the top-level setup flow.
- **Work:**
  1. accept one explicit developer verification command during setup;
  2. generate a generic Runtime-owned verifier wrapper and immutable verifier
     definition outside the Agent subject;
  3. enable verifier execution only when the developer explicitly selects it;
  4. print the resulting `required_verifier_id` and use it in the generated
     `AgentSession` starter;
  5. never install a fake always-pass verifier.
- **Output:** a developer can install, register a real project check and run the
  AgentSession Quickstart without manually constructing
  `AIONIS_EPISODE_VERIFIERS_JSON`.
- **Verification:** run a fresh install against a disposable project with a
  real deterministic acceptance command; one passing state completes and one
  failing state returns `continue`.

### Task 1.5 — Converge thin integrations onto the SDK

- **Scope:** `aionis-mcp`, `aionis-cli`, and `aionis-aifs`.
- **Work:**
  1. remove calls to deleted Runtime routes;
  2. remove duplicate continuation rendering or learning decisions;
  3. map each integration to the canonical SDK `AgentSession`, Guide, feedback,
     rehydrate and forget surfaces.
- **Output:** every public integration reaches the same product behavior.
- **Verification:** one real local Runtime flow per integration; no model call
  is required unless the integration actually executes an Agent.

### Task 1.6 — Expand continuity product evidence only after integration works

- Add unrelated tasks and at least one additional model family.
- Measure exact recovery, repeated-discovery reduction, context size, input
  tokens and verifier-confirmed continuation.
- For DeepSeek-backed validation, request
  `DeepSeek-V4-Flash-0731` and bind the provider-served model receipt.
- Do not turn one failure into Runtime source rules.

## 6. Phase 2 — Repair transferable self-learning

Phase 2 begins only after Tasks 1.1-1.5 are complete.

### Task 2.1 — Retire the simplified L2/L3 product path

- Preserve its existing real receipts as external negative evidence.
- Remove the simplified contracts from the canonical learning-artifact union.
- Remove the count-only compiler, renderer and validator after their evidence
  exports no longer import Runtime source.
- Keep `ProcedureHypothesisV2` and `ValidatedExecutionSkillV1` as the only
  L2/L3 authorities.

### Task 2.2 — Build reproducible experience cohorts

- Construct semantic and bounded structural neighborhoods across unrelated
  repositories/environments.
- Include successes, related failures, counterexamples and negative neighbors.
- Keep exact task/repository signatures for identity and deduplication, not
  transfer discovery.
- Persist membership, exclusions, projection identity and construction receipt.

### Task 2.3 — Build the real procedure compiler

- Read bound request/result artifacts, state deltas, decisive observations and
  verifier evidence.
- Contrast success with failure and negative neighbors.
- Emit applicability, diagnosis, parameters, procedure steps, expected
  transitions, termination, verification, recovery, boundaries and unresolved
  assumptions.
- Abstain when evidence cannot support a portable procedure.
- No task path, answer or single-repository rule may enter Runtime source.

### Task 2.4 — Promote only through held-out incremental value

- Freeze the exact L2 content and validation protocol before execution.
- Run cloned state-only and state-plus-L2 pairs on unseen tasks.
- Primary outcome: verifier-success uplift.
- Guardrails: severe negative transfer, prompt tokens, tool calls and elapsed
  time.
- Produce `limited` or `validated` L3 only through an immutable validation
  receipt.

### Phase 2 stop condition

If no procedure improves held-out verifier success over Verified Continuity
alone, stop and repair cohort construction or compilation. Do not implement L4
or L5.

## 7. Phase 3 — Learn when to use validated memory

Phase 3 requires at least one real limited/validated L3 with positive held-out
incremental value.

### Task 3.1 — Complete causal intervention logging

Persist candidate set, assignment, selected arm, joint probability/propensity,
delivery, prompt exposure, actual use, outcome and cost.

### Task 3.2 — Two-stage selection

1. hard semantic/structural applicability gate;
2. contextual expected utility using verifier benefit, token cost,
   uncertainty and negative-transfer risk.

Select state-only or at most one compatible L3. Abstention is a first-class
decision.

### Task 3.3 — Controlled lifecycle

Use attributed outcomes and drift evidence to strengthen, weaken, split,
contest, supersede or deprecate immutable skill versions. Never rewrite source
evidence or silently mutate validated content.

## 8. Product gates

### Gate A — Continuity usable

- a developer can install Aionis and reach `AgentSession`;
- interruption/resume and exact recovery work through the public SDK;
- current state is first in the Agent prompt;
- L0/L1 history is never direct procedure authority.

### Gate B — Learning is real

- at least one parameterized L2 is compiled from full semantic execution
  evidence;
- an unseen paired block shows positive verifier-success uplift;
- the admitted L3 content exactly matches the tested L2 content;
- unrelated tasks do not receive the skill.

### Gate C — Selection is learned

- every training row has complete assignment/exposure/propensity attribution;
- the learned selector beats state-only/fixed-policy serving on held-out
  expected utility;
- negative-transfer and forgetting rates remain inside predeclared bounds.

## 9. Explicit non-goals

- no engineering-quality or CI expansion before product behavior;
- no new operator, audit, governance or experiment routes;
- no weight fine-tuning;
- no self-editing Runtime source;
- no L1 success promoted directly to procedure;
- no selector trained from unassigned observational rewards;
- no task-specific solution encoded in Runtime.

## 10. Execution status

| Task | Status |
|---|---|
| Plan authority established | Complete |
| 1.1 Historical L1 product boundary | Complete |
| 1.2 AgentSession developer quickstart | Complete |
| 1.3 Installer alignment | In progress — public Runtime/create RC tags verified; npm installer distribution pending |
| 1.4 Verifier onboarding | In progress — public GitHub install effect verified; npm installer distribution pending |
| 1.5 Thin integration convergence | Pending |
| 1.6 Expanded continuity evidence | Pending |
| Phase 2 self-learning repair | Blocked on Phase 1 |
| Phase 3 L4/L5 | Blocked on real validated L3 |

## 11. First execution batch evidence

Completed on 2026-07-31:

- every historical L0/L1 receives `evidence_only` and
  `supporting_evidence_only` at Memory Packet construction and is normalized
  again at Agent Context compilation;
- the Runtime and standalone SDK README now encounter the real
  `AgentSession.begin -> turn -> aroundAction -> runVerifier -> finish` path
  before ordinary memory APIs;
- the public SDK README no longer teaches the deleted
  measure/snapshot/candidate-export route;
- `@aionis/create` now selects Runtime `v0.3.12`, points to `AgentSession`, and
  prints the five current product POST routes without `/v1/measure`.

Direct product verification used a temporary local Runtime with real SQLite, a
real workspace file, a separately executed Runtime verifier and two real
`AgentSession` episodes. The first episode passed and closed; the Runtime
background compiler then produced canonical L1 memory
`65be9218-9eb5-5b75-b45d-1d370b2b2589`. The second active episode recalled that
L1 alongside its canonical current state. Observed result:

```text
L1 use_policy: evidence_only
L1 allowed_scope: supporting_evidence_only
L1 in use_now: false
L1 in inspect_before_use: true
current execution state first in agent_prompt: true
```

Additional checks:

- Runtime typecheck passed;
- the existing real local-Runtime SDK AgentSession flow passed;
- `@aionis/create` build and all 27 existing package checks passed;
- Runtime `v0.3.12` exists as a local tag;
- every method used by the new Quickstart exists in both Runtime-owned
  `src/sdk.ts` and synchronized standalone SDK source.

## 12. Verifier onboarding implementation evidence

Implemented on 2026-07-31 in `@aionis/create` and the top-level `aionis setup`
flow:

- `--verify-command <command>` is the explicit opt-in for a real project
  acceptance command; no command leaves Runtime verifier execution disabled;
- setup generates a content-bound `project-check` wrapper and immutable
  definition outside the Agent project, writes the Runtime verifier env, and
  never creates an always-pass verifier;
- setup prints `required_verifier_id: project-check` and a generated
  AgentSession starter already bound to that verifier and project root;
- the starter imports the exact SDK source owned by the installed Runtime,
  rather than relying on an independently published SDK version;
- interactive `aionis setup` exposes the same explicit product choice and the
  non-interactive CLI forwards the command and project root without rebuilding
  verifier logic.

Direct product verification used a disposable Git project, the generated
Runtime-owned wrapper and definition, real workspace snapshot
materialization, real verifier child processes, real SQLite and the current
Runtime `AgentSession` implementation. No model or mock verifier was used.
Observed result:

```text
project state = pass -> verifier_status = passed -> finish_status = completed
project state = fail -> verifier_status = failed -> finish_status = continue
```

The fresh-install check also exposed a release truth that reopens Task 1.3:
the currently pinned Runtime tag `v0.3.12` does not contain `AgentSession`, and
the currently published `@aionis/sdk@0.3.19` package does not expose
`client.agentSession`. The new starter no longer depends on the independently
published SDK, but a new Runtime ref containing the current AgentSession source
must be released and selected before a clean public install can pass the same
flow. Product Gate A therefore remains incomplete; this is a product
availability blocker, not an engineering-quality expansion.

## 13. Clean-install release-candidate evidence

Completed locally on 2026-07-31 without changing or committing the active
Runtime worktree:

- built an isolated Git release-candidate snapshot from the current converged
  Runtime source;
- cloned that ref through the real `@aionis/create` install path into an empty
  directory;
- ran `npm install` and the Runtime build inside the fresh clone;
- started the freshly installed Runtime with the generated verifier
  definition loaded from `.env`;
- ran the generated `AgentSession` starter against a real Git workspace and
  real child-process verifier.

The first clean-install attempt exposed a product bug in `@aionis/create`:
double-quoted dotenv serialization preserved escaped JSON quotes, so the
Runtime rejected `AIONIS_EPISODE_VERIFIERS_JSON` and could not start. The
installer now writes normalized JSON in a dotenv-compatible single-quoted
value while encoding any apostrophe inside JSON strings as `\u0027`.

Observed clean-install behavior after the fix:

```text
project state = pass
-> candidate_verifier_status = passed
-> finish_status = completed
-> process exit = 0

project state = fail
-> candidate_verifier_status = failed
-> finish_status = continue
-> continuation.reason = verifier_failed
-> process exit = 2
```

This proved that the current source could be packaged and installed with the
intended product effect. At that checkpoint it did not create a public release:
the active Runtime tree contained the full convergence refactor (`536`
tracked-file changes plus `67` new files), and GitHub had no ref containing
that tree. Section 14 records the subsequent authorized publication.

## 14. Public release-candidate evidence

Published and verified on 2026-07-31:

- Runtime commit `6fb4052e62c49c15808680e23f297f1568f1b51a` is available through the
  annotated public tag `v0.4.0-rc.1` in `ostinatocc/Aionis`;
- installer commit `9b1bd3f0a5802754ddbbbd9831da8429e301188c` is available through the
  annotated public tag `v0.3.9-rc.1` in `ostinatocc/aionis-create`;
- the installer source defaults to Runtime `v0.4.0-rc.1`;
- a new installation with no `--repo` or `--branch` override cloned the public
  GitHub Runtime tag, installed dependencies, built, and started successfully;
- the installed Runtime reported package version `0.4.0-rc.1` and Git commit
  `6fb4052e62c49c15808680e23f297f1568f1b51a`.

Observed public-ref product behavior:

```text
project state = pass
-> candidate_verifier_status = passed
-> finish_status = completed
-> process exit = 0

project state = fail
-> candidate_verifier_status = failed
-> finish_status = continue
-> continuation.reason = verifier_failed
-> process exit = 2
```

The public source release path is therefore proven. Product Gate A remains
open only because the newly tagged installer has not yet been published to
npm; `npx @aionis/create` still resolves the previous npm release until that
explicit external publication occurs.
