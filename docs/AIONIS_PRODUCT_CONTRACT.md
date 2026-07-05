# Aionis Product Contract

Status: focused product contract for the current Runtime implementation

This document defines the product contract Aionis exposes to hosts,
integrators, and operators. It keeps the Runtime capabilities understandable,
useful, and consistent across SDK, MCP, HTTP, and operator surfaces.

## Product Definition

Aionis is an evidence-gated Cognitive Memory and Execution Learning Runtime for AI Agents.

It helps an Agent recall ordinary memory with evidence, remember real execution, learn what worked, forget what hurts, and let historical evidence shape future behavior under controlled authority.

Aionis is a state-adjudicated memory runtime: it governs memory authority,
lifecycle, scope, attribution, and risk before compiling bounded context for an
Agent.

Forget is a core Aionis capability. Controlled forgetting means stale, harmful,
weak, contradicted, or over-exposed memory can
be suppressed, demoted, archived, rehydrated, or restored with evidence and
auditability instead of being blindly recalled forever or silently deleted.

The implemented state model is documented in [AIONIS_STATE_MODEL.md](AIONIS_STATE_MODEL.md).
Aionis owns the state governance planes under memory and execution: execution
state, execution tree branches, lifecycle/forgetting, workflow promotion,
learning-control gates, and read-only operator projections.

Cross-thread, cross-Agent, and cross-LLM continuity are proof surfaces for the
larger product promise:

History should change future behavior in a measurable, positive, and controllable way.

## User-Facing Promise

An Agent using Aionis should:

1. avoid restarting from zero when related work already happened
2. recall user preferences, facts, and project context with evidence, confidence, lifecycle, and scope
3. recover proven execution state without replaying full chat history
4. reuse workflows only when real evidence supports reuse
5. suppress stale, weak, harmful, or contradicted memory
6. expose when learned guidance is advisory, blocked, contested, or trusted
7. measure whether history helped or hurt the current run
8. produce reusable memory and execution evidence that can later become training data

## Product Actions

The HTTP product surface should collapse around a small set of verbs that match
the host loop. Advanced lifecycle controls stay available, but ordinary hosts
can use product verbs without learning internal route names or lifecycle
operation codes.

| Product Action | User Meaning | Current Runtime Capabilities |
|---|---|---|
| `observe` | Record what actually happened during execution. | memory write, handoff store, trajectory compile, replay step evidence, delegation records, tool feedback |
| `guide` | Produce the next compact cognitive and execution context from history. | recall, recall_text, context assemble, planning context, action retrieval, experience intelligence, resume/handoff packs |
| `feedback` | Attribute run outcome to exposed memory actually used by the host. | node activation, guide exposure ledger verification, feedback learning-control persistence |
| `rehydrate` | Expand archived memory or anchor payload only when compact context needs it. | archive relocation, anchor payload rehydration, linked decision rehydration |
| `forget` | Explicitly control memory lifecycle when a host or operator knows memory should be suppressed, restored, archived, activated, or rehydrated. | semantic forgetting, suppression, unsuppression, archive relocation, anchor rehydration, node activation |
| `measure` | Prove whether history changed the run positively or negatively. | runtime effect summary, promotion quality, runtime signal trends, maintenance reports, paired eval reports |
| `snapshot` | Inspect memory use, branch isolation, and effect without mutating Runtime state. | operator snapshot, memory use receipt, trace-to-procedure readiness |

Internal mechanisms may remain richer than these verbs. Product docs, demos, and
user-facing integrations should center these verbs so users can adopt Aionis
without learning internal route names. Concrete product API usage is defined in
[AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md), host integration
templates are defined in [AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md),
capability routing and deletion decisions are tracked in
[AIONIS_CAPABILITY_DECISION_MATRIX.md](AIONIS_CAPABILITY_DECISION_MATRIX.md), and
stable user-facing outputs are defined in
[AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md).
The governance decision table is defined in
[AIONIS_GOVERNANCE_POLICY_V1.md](AIONIS_GOVERNANCE_POLICY_V1.md), the rehydrate
contract is defined in [AIONIS_REHYDRATE_CONTRACT.md](AIONIS_REHYDRATE_CONTRACT.md),
multi-Agent scope boundaries are defined in
[AIONIS_MULTI_AGENT_SCOPE_MODEL.md](AIONIS_MULTI_AGENT_SCOPE_MODEL.md), and
trace-derived skill learning is defined in
[AIONIS_TRACE_DERIVED_SKILL_MEMORY.md](AIONIS_TRACE_DERIVED_SKILL_MEMORY.md).

The shortest no-key value demo is [AIONIS_FIRST_VALUE_DEMO.md](AIONIS_FIRST_VALUE_DEMO.md). It demonstrates external memory admission and audit without an embedding provider, LLM, Agent harness, or benchmark runner. The shortest write-and-guide product flow is [AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md](AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md). It demonstrates `observe -> guide -> audit`. External Agent hosts should use [AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md) for the full `observe -> guide -> agent action -> feedback -> measure -> snapshot` loop.

The primary product proof loop is [AIONIS_GOLDEN_PRODUCT_LOOP.md](AIONIS_GOLDEN_PRODUCT_LOOP.md):

```bash
npm run -s runtime:e2e:golden-product-loop
```

It runs the full host path over a real Runtime and proves actionable history,
failed-branch isolation, feedback attribution, measured effect, memory receipt,
and trace-to-procedure readiness.

## Recall vs Admission Boundary

Aionis can improve recall without changing its product contract.

The Recall Engine finds candidate memories from semantic, lexical, structured,
execution-native, graph, recent, exact-recovery, optional ANN, and optional
Substrate sidecar sources. It may explain why a candidate was found and how
strong the retrieval signal was. Admission decides whether that memory is safe
to use.

Admission remains governed by lifecycle, authority, scope, source, risk,
feedback attribution, and rehydration state. A recalled memory becomes useful
only after the Runtime places it into one of the product surfaces:

```text
use_now | inspect_before_use | do_not_use | rehydrate
```

This is the Aionis difference from recall-only memory systems. Better retrieval
raises the ceiling for what governance can inspect; governance controls what
reaches the Agent. The implementation roadmap is
[AIONIS_RECALL_ENGINE_ROADMAP.md](AIONIS_RECALL_ENGINE_ROADMAP.md), and the
operator runbook is
[AIONIS_RECALL_ENGINE_RUNBOOK.md](AIONIS_RECALL_ENGINE_RUNBOOK.md). The
versioned admission policy is [AIONIS_GOVERNANCE_POLICY_V1.md](AIONIS_GOVERNANCE_POLICY_V1.md).

## Multi-Agent Execution Memory Position

Aionis is a Multi-Agent execution memory backend. External hosts decide which
Agent acts next; Aionis records what each Agent did, compiles branch-aware
execution state, controls which history can be reused, and measures whether
that shared history helped.

The product contract for Multi-Agent execution memory is:

The full scope, lane, team, and identity contract is
[AIONIS_MULTI_AGENT_SCOPE_MODEL.md](AIONIS_MULTI_AGENT_SCOPE_MODEL.md).

| Field / Surface | Meaning |
|---|---|
| `producer_agent_id` | Agent that wrote an observed memory or execution event. |
| `consumer_agent_id` | Agent receiving guide context. Agent-private memory is visible only when this identity is aligned with the writer/owner. |
| `owner_team_id` / `consumer_team_id` | Team boundary for shared or team-private multi-agent memory. |
| `memory_lane: "private"` with `owner_agent_id` | Agent-local memory. Use only when the same Agent should retrieve it later. |
| `memory_lane: "private"` with `owner_team_id` | Team-private memory. Visible only to consumers carrying the same `consumer_team_id`; not scope-wide shared memory. |
| `memory_lane: "shared"` without `owner_team_id` | Scope-wide shared memory. |
| `memory_lane: "shared"` with `owner_team_id` | Team-visible execution memory for planner/worker/verifier/reviewer handoff. |
| `agent_role` | Product-level role hint such as `planner`, `worker`, `verifier`, or `reviewer`; legacy `context.agent_role` remains accepted as a compatibility fallback. |
| `execution_tree_v1` | Branch-aware state: current path, passed branches, failed branches, and revisions. |
| `guide_trace_id` + `used_memory_ids` | Feedback attribution path after an Agent actually uses recalled memory. Attribution is limited to memory IDs exposed by that guide. |

Role-specific prompt building should start from Aionis `agent_context`.
Aionis returns `agent_context.agent_role`, adds a role focus line to
`agent_context.prompt_text`, and keeps the same core boundary for every role:

1. reusable execution history enters `use_now`
2. candidate or ambiguous history enters `inspect_before_use`
3. failed branches and blocked authority enter `do_not_use`
4. raw evidence and traces stay on audit/debug surfaces
5. feedback attribution is explicit through `guide_trace_id`
6. execution handoff/resume intent is explicit through
   `execution_state.transition_kind`

Runnable proof surface:

```bash
npm run -s runtime:e2e:multi-agent
npm run -s runtime:e2e:multi-agent-negative
```

The positive e2e starts a planner/worker/verifier/reviewer loop over the real Runtime:
planner writes a plan, worker creates failed and passed branches, verifier marks
branch outcomes, reviewer inherits the active path, feedback is attributed to
the guide trace, and `measure` reports whether history changed future behavior.

The negative e2e proves the isolation side of the same product contract:
team-owned shared memory stays team-scoped, private memory stays agent-scoped,
cross-team attribution is rejected, and failed execution branches stay out of
`use_now`.

## Observe Input Contract

`POST /v1/observe` is the product entry for writing history. Common writes use
product-level fields while the Runtime handles the internal node and slot
projection.

Supported product inputs:

| Input | Product Meaning | Runtime Projection |
|---|---|---|
| `input_text` | Plain ordinary memory, preference, fact, or project context. | Auto-structured into a recallable general memory node when no lower-level node is supplied. |
| `memory` / `nodes` | Explicit advanced memory write. | Passed through existing memory write structuring, with execution surfaces normalized when present. |
| `execution` | One observed execution experience, with task/run identity, outcome, workflow steps, tools, evidence, and continuation hint. | Auto-structured into an execution workflow memory candidate with evidence and advisory authority. |
| `handoff` | Resumable state for future continuation. | Stored through the handoff continuity engine. |

This facade keeps product input generic: host-specific behavior,
benchmark-specific actions, and single-task repair rules belong in observed
evidence. Internal routes may still use richer schemas after the facade has
normalized user input.

### Execution State Tree Default

Execution-tree state is a default internal product path for execution continuity.
Ordinary facts, preferences, and general memory continue to use the ordinary
memory path.

Default tree construction applies when `POST /v1/handoff/store` or `POST /v1/memory/write` carries execution continuity slots such as `execution_state_v1`, `execution_packet_v1`, `execution_result_summary`, `execution_artifacts`, or `execution_evidence`. The Runtime records the current execution branch, compressed progress, validation outcome, and failed/alternate branch hints so later `guide`, planning, context assembly, and recover surfaces can use the current branch without promoting failed branches as next-action context.

This default path stays scoped to execution state. Plain facts, preferences, and
general cognitive memory stay on the ordinary memory path. Callers can disable
only the automatic tree side effect by setting `execution_tree_disabled: true` or
`execution_tree_default_disabled: true` on handoff/write requests; explicit
`execution_tree_v1` and `execution_tree_operations_v1` remain caller-owned state
and are still applied. Operators can disable the default globally with
`EXECUTION_TREE_DEFAULT_ENABLED=false`.

### Trace-to-Procedure Product Surface

Trace-to-Procedure is the product-visible projection that explains how existing
execution evidence can become reusable procedure memory.

Current implementation surface:

| Field | Meaning |
|---|---|
| `operator_snapshot.trace_to_procedure.source_surfaces` | Which existing surfaces are visible: execution tree, workflow projection, replay playbook, execution contract, memory decision trace, or promotion evidence. |
| `procedure_memory_ids` / `workflow_ids` | The execution memory and workflow identifiers currently visible to the host/operator. |
| `candidate_visible` | A trace-derived or workflow-derived procedure candidate is visible, but may still be advisory. |
| `stable_reuse_visible` | Stable workflow/procedure reuse is visible through trusted authority or promoted workflow evidence. |
| `promotion_status` | `stable_ready`, `candidate_only`, `blocked`, `insufficient_evidence`, or `not_applicable`. |

This surface is read-only. Promotion, authority mutation, playbook compilation,
and Agent prompt rendering stay on their dedicated paths. This lets hosts and
operators see whether Aionis has enough evidence to reuse operational experience
without turning one run into a hard rule.

### Trace-Derived Skill Candidates

Aionis can project measured execution traces into `trace_derived_skill`
training candidates. This is the Runtime-facing version of "plans, failures,
validation, and repair patterns become reusable skill assets." A candidate
contains applicability conditions, non-applicability conditions, procedure
steps, acceptance checks, failure counterexamples, and source trace/evidence
ids.

The product path is intentionally review-first:

```text
agent execution trace -> feedback attribution -> measure -> trace-derived skill candidate -> review -> draft -> explicit observe commit
```

This makes Trace-Derived Skill Candidates a learning surface inside Execution
Memory. They help operators and hosts identify reusable execution lessons, but
they are not current route state and are not prompt instructions by default.

The first implementation is deliberately conservative:

| Property | Contract |
|---|---|
| Source | Positive continuity or workflow-reuse effect evidence from `AionisEffectReport`. |
| Authority | Always `authority_state: candidate`; never direct authority. |
| Prompt behavior | `agent_prompt_included: false`; candidates do not enter Agent context by themselves. |
| Runtime mutation | `runtime_mutation: false`; no memory row is promoted or rewritten by the projection. |
| Promotion path | `required_gate: admission_and_promotion_gate`; later use must pass materialization, explicit observe commit, normal admission, feedback, and promotion gates. |

#### Review API

Aionis exposes a review ledger for trace-derived skill candidates:

| Endpoint | Role |
|---|---|
| `POST /v1/skills/candidates` | Queue trace-derived skill candidates from a `measure_result` or `effect_report`. |
| `GET /v1/skills/candidates` | List queued, promoted, rejected, or all trace-derived skill candidates for a tenant/scope. |
| `POST /v1/skills/candidates/:id/promote` | Record an operator promotion review decision. |
| `POST /v1/skills/candidates/:id/reject` | Record an operator rejection review decision. |
| `POST /v1/skills/candidates/:id/materialize` | Return an `aionis_procedure_memory_draft_v1` and recommended `/v1/observe` payload for a promoted, export-ready positive candidate. |

These routes are review surfaces. A `promote` decision records operator intent in
the candidate ledger; it does not rewrite memory rows, inject the candidate into
Agent context, or bypass admission. `materialize` also does not write memory; it
returns a draft and recommended observe payload. The host must explicitly commit
that payload through `POST /v1/observe` before future `guide` calls can recall
the procedure through normal admission and lifecycle gates.

This gives Aionis a product path for trace-to-skill learning without turning the
Runtime into an autonomous training loop.

Detailed Runtime boundary:
[AIONIS_TRACE_DERIVED_SKILL_MEMORY.md](AIONIS_TRACE_DERIVED_SKILL_MEMORY.md).
Implementation plan:
[Trace-Derived Skill Memory Plan](plans/2026-06-30-trace-derived-skill-memory.md)
defines how reviewed candidates become explicit procedure-memory drafts,
committed through `observe`, and later recalled through normal admission gates.

## Guide Output Contract

`POST /v1/guide` is the product entry for giving an Agent usable historical context.

Default output:

| Field | Product Meaning |
|---|---|
| `agent_context` | Short Agent-facing context with summary, authority, risk, target files, use/inspect/do-not-use lists, command posture, memory IDs, and rehydration hints. |

Optional audit output:

| Request Flag | Additional Fields |
|---|---|
| `include_packets: true` | Adds `memory_packet` and `guide_packet` for measurement, debugging, or advanced integrations. |
| `mode: "full_power"` or `context_mode: "full_power"` | Internally merges semantic recall with safe full-power execution context while still exposing only `agent_context` to the Agent. |
| `context_mode: "compact_agent"` | Uses the same governed full-power guide path but emits a shorter contract-style Agent prompt. Structured `use_now`, `inspect_before_use`, `do_not_use`, `command_posture`, `rehydrate_hints`, IDs, receipts, and traces remain available outside the prompt. |

The SDK defaults `guide()` calls to `mode: "full_power"` because that is the
recommended product adapter path. Raw HTTP callers may still omit mode for the
legacy standard route behavior or set `mode: "standard"` explicitly.

The default Agent surface is the compiled `agent_context`. Full packets remain
available for audit and `measure` as operator/developer surfaces.

Full-power guide mode must preserve the same Agent boundary: raw evidence,
gated abstractions, selection trace, and audit prompt text are internal or
operator surfaces. Only the safe merged `agent_context` reaches the Agent.

Compact Agent context is an Agent-facing rendering choice on the same governed
memory decision path. When requested, `agent_context.agent_context_mode` is
`compact_agent`; the prompt may start with `AIONIS_CTX compact_agent`, while
the governed memory buckets, attribution IDs, lifecycle decisions, and audit
surfaces stay aligned with the standard guide result.

Decision trace and audit surfaces are separate operator/debug outputs. The usage boundary is defined in [AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md](AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md): Agents consume `agent_context`; developers inspect `memory_decision_trace` and `memory_decision_audit`.

Generated `memory_decision_trace` and `operator_snapshot` outputs include
`memory_use_receipt`, a compact read-only receipt of the memory IDs exposed as
`use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate`, plus feedback
attribution and risk flags. It is a host/operator audit surface paired with the
Agent-facing `agent_context`.

Generated `memory_decision_trace`, `memory_decision_audit`, and
`operator_snapshot` outputs also include `judgment_calibration_summary`, a
read-only Judgment Ledger projection over the current decision trace. It
summarizes supported, contradicted, unused, weak, and inconclusive memory
judgments without changing memory authority, ranking, suppression, or lifecycle
state.

The guide path also includes a Premise Firewall projection. When the current
query appears to reuse a stale, blocked, contested, or superseded premise and
Aionis has accepted current-state counter-evidence, the product exposes the
risk through existing `agent_context.risk.reasons`, `inspect_before_use`, and
`do_not_use` fields. This is state governance before context compilation, with
task execution and memory mutation still handled by their dedicated host and
Runtime paths.

Memory Contract is now explicit on each relevant memory. Aionis derives a
read-only `memory_contract` from existing authority, lifecycle, scope hint,
source layer, and evidence IDs before compiling context. Hosts should treat
`use_policy: "direct_use"` as eligible for `use_now`, and should treat
`inspect_before_use`, `do_not_use`, and `evidence_only` as governed surfaces
rather than raw recall results. The contract is a read-only admission view; tree
creation, promotion, and authority mutation remain on their dedicated Runtime
paths.

## Feedback, Rehydrate, And Forget Input Contract

`POST /v1/feedback` is the normal HTTP product entry for attributing run
outcomes to memory actually exposed by a guide. It maps to controlled
activation feedback internally while callers use the product-level feedback
shape.

`POST /v1/rehydrate` is the normal HTTP product entry for expanding archived
memory or anchor payload on demand. It maps to controlled rehydration internally
while callers use the product-level rehydrate shape. The host-visible lifecycle,
payload mode, and merge policy is defined in
[AIONIS_REHYDRATE_CONTRACT.md](AIONIS_REHYDRATE_CONTRACT.md).

`POST /v1/forget` is the explicit lifecycle-control API for controlled
forgetting: suppressing stale or harmful memory, unsuppressing reviewed memory,
activating directly attributed memory, moving archived memory, and rehydrating
payloads. SDK users should prefer `client.feedback()` and `client.rehydrate()`
for the common feedback and pointer-expansion paths, while `/v1/forget` remains
a first-class product surface for deliberate lifecycle control. The Runtime maps
these product verbs onto the internal lifecycle route names.

Supported product operations:

| Operation | Product Meaning | Runtime Projection |
|---|---|---|
| `suppress` | Temporarily or strongly suppress a learned pattern from future guidance. | Pattern suppression with `shadow_learn` or `hard_freeze` mode. |
| `unsuppress` | Restore a previously suppressed pattern when it becomes valid again. | Pattern unsuppression. |
| `rehydrate` | Bring archived memory or anchor payload back into usable context on demand. Prefer `/v1/rehydrate` for normal product loops. | Archive rehydration for memory IDs, or anchor payload rehydration for anchors. |
| `activate` | Record that a recalled memory was actually useful in a run. Prefer `/v1/feedback` for normal product loops. | Node activation feedback with outcome and run evidence. |

Supported targets:

| Target | Product Meaning |
|---|---|
| `memory` | A remembered node selected by `memory_ids`, `node_ids`, or `client_ids`. |
| `archive` | Archived memory that should move back to `warm` or `hot`. |
| `payload` | The payload behind an anchor, rehydrated by `anchor_id` or `anchor_uri` only when requested. |
| `pattern` | A learned pattern controlled by suppression or unsuppression through `anchor_id`. |

This facade may return an internal `source_map` for auditability, while user
integrations should consume `forget_effect`: action, target, reason, changed
count, reversibility, affected IDs, and anchor identity. Forget operations
control memory lifecycle and authority while preserving source evidence and
keeping task-specific behavior in observed evidence.

## Measure Input Contract

`POST /v1/measure` is the product entry for proving whether history changed future behavior positively or negatively.

Supported measurement inputs:

| Input | Product Meaning | Runtime Projection |
|---|---|---|
| `baseline` + `aionis` | Advanced caller supplies direct effect observations. | Evaluated by the focused effect evaluator. |
| `product_trace.before_guide` + `product_trace.after_guide` | Caller supplies two product guide outputs, usually before and after `observe` or `forget`. | Projected into continuity, learning, forgetting, and learning-control observations. |
| `product_trace.baseline` + `product_trace.after_guide` | Caller supplies a direct baseline plus one active Aionis guide output. | Uses the direct baseline and packet-derived Aionis observation. |
| `product_trace.forget_result` | Caller supplies the product forget result used between guide snapshots. | Counts suppression or rehydration effect without exposing internal lifecycle route schemas. |

Product trace measurement proves packet-level Aionis effects: history used,
repeated-discovery reduction signal, useful context ratio, stale-memory
suppression, rehydration, workflow candidate reuse, and authority blocking.
External task-completion claims use an external validation layer as separate
evidence.

`npm run -s runtime:e2e:agent-suite` is the focused downstream Agent-context
demo. It supplies that separate external validation layer with a real LLM and
compares `baseline`, `long_context`, and `aionis` contexts. Its product gates
are scoped to Aionis-owned effects: active-path recovery, failed-branch leakage
blocking, execution-context compression, and evidence-backed feedback. External
Agent task behavior remains observed evidence rather than a Runtime rule.

## Core Capabilities

| Capability | Product Value | Current Implementation |
|---|---|---|
| General cognitive memory | Ordinary memory is returned with evidence, confidence, scope, lifecycle, contradiction risk, and expected behavior impact. | recall/context, L0-L5 layers, semantic forgetting surfaces, `aionis_memory_packet` |
| Execution continuity | The Agent can resume from proven execution state. | execution packets, state store, handoff store/recover, resume packs |
| Evidence-gated self-learning | Successful traces can become reusable workflows/patterns/policies without single-run promotion. | replay evidence, promotion ledger, learning loop, policy memory |
| Controlled forgetting | Stale or harmful memory demotes, archives, or rehydrates on demand instead of polluting context forever. | forgetting kernel, archive relocation, node activation, rehydration |
| Dynamic learning control | Aionis adjusts authority and intervention strength based on evidence, uncertainty, and risk. | authority gates, learning-control providers, runtime entropy profile |
| History-shaped future behavior | Prior execution changes future context, workflow reuse, verification posture, and memory lifecycle. | planning summaries, action retrieval, experience intelligence, effect evaluator |
| Execution data asset | Real traces can become evidence-labeled training candidates. | execution evidence, handoff/resume packets, replay runs, promotion/demotion records |

## What Aionis Owns

Aionis owns:

1. general cognitive memory structure
2. execution memory structure
3. execution state continuity
4. evidence and provenance of recalled memory and learned guidance
5. lifecycle of memory, workflow, pattern, and policy objects
6. controlled forgetting and rehydration
7. authority visibility and promotion/demotion decisions
8. measurement of positive transfer, negative transfer, token/context savings, and repeated discovery reduction
9. distillation of memory and execution traces into training-candidate records

## Host-Owned Execution Surfaces

External hosts and models own:

1. external host framework product behavior
2. semantic patch generation for a specific task
3. repository-specific repair procedures
4. benchmark-specific action semantics
5. single-run hard rules
6. model fine-tuning execution as part of the core Runtime
7. deployment-specific control planes and product shells

External hosts and LLMs propose actions. Aionis remembers, guides, gates, forgets, and measures.

## History Shaping Contract

Historical execution may shape future behavior only through these controlled surfaces:

| Surface | Allowed Effect |
|---|---|
| memory packet | Recall ordinary memories with evidence, lifecycle, confidence, contradiction warnings, and expected behavior impact. |
| guide packet | Include proven state, useful memories, workflow candidates, suppression notes, and uncertainty. |
| workflow candidate | Recommend a reusable path with evidence and authority level. |
| tool preference | Prefer tools that repeatedly worked in scoped contexts. |
| verification posture | Suggest deeper or lighter verification based on evidence and risk. |
| forgetting lifecycle | Demote, retire, archive, or rehydrate memory based on quality and use. |
| effect report | Show whether this history actually helped or hurt. |

Historical execution shapes future behavior through these controlled surfaces
rather than direct source-code rules, task-specific fixes, or hard Runtime
behavior.

## Replay Position

Replay is the internal evidence engine behind the product face. It proves what
happened, supplies workflow learning evidence, supports promotion/demotion, and
helps measure whether a reused path worked.

The product should say:

Aionis learns from real execution traces.

## Training Data Position

Aionis execution memory can become a training data asset, but only after distillation and evidence gating.

| Data Source | Training Value | Use Condition |
|---|---|---|
| handoff/resume packets | Train state compression and task continuation. | Must be outcome-labeled and privacy-filtered. |
| successful workflow traces | Train planning, tool selection, and verification habits. | Must have repeated positive transfer evidence. |
| failed traces | Train avoidance and recovery judgment. | Must be labeled as negative/counter-evidence. |
| promotion/demotion records | Train trust and transfer judgment. | Must include authority and lifecycle labels. |
| forgetting/suppression records | Train memory hygiene. | Must include why the memory stopped helping. |

Raw traces and raw chat become training-ready through distillation and evidence
labeling. Aionis exports distilled, evidence-labeled execution examples first.

The first training candidates should be:

1. handoff distillation examples
2. transfer-judge examples
3. workflow-selector examples
4. forgetting/suppression examples

LoRA or adapter training is a downstream consolidation path built on top of the
core Runtime evidence pipeline.

## Product Proof Contract

The first product proof should focus on Aionis-owned effects before broad
external Agent issue-success claims, because generic issue success combines
Agent quality, model quality, repo difficulty, provider stability, and verifier
quality.

The first product proof should measure Aionis-owned effects:

| Metric | Positive Signal |
|---|---|
| repeated discovery | fewer repeated `list/search/read` style steps |
| continuity signal | reaches relevant state/action faster |
| recovered facts | new run recovers prior verified facts without full chat |
| token/context cost | less irrelevant context and lower provider token use |
| workflow reuse | proven workflow reused only when evidence supports it |
| negative transfer | harmful guidance detected, blocked, demoted, or measured |
| forgetting quality | stale memory suppressed and archived memory rehydrated only when useful |
| cross-boundary continuation | another thread, Agent, or LLM can continue from Aionis packet |

Issue success-rate lift can become a later claim only after these lower-level effects repeatedly hold.

## Product Direction

The next version should converge toward:

Execution Memory and Learning Runtime for AI Agents

with the user-facing promise:

Make Agents remember what happened, learn what worked, forget what hurts, and prove when history made future execution better.

No product entrypoint should be implemented before the capability decision matrix and product output contract are accepted. Wrapping an unclear internal surface is not product convergence.
