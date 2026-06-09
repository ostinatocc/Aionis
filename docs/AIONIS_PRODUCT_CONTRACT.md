# Aionis Product Contract

Status: focused product contract for the current Runtime implementation

This document defines the product boundary that Aionis should converge toward. It is not a new mechanism proposal. It is the contract that keeps existing Runtime capabilities understandable, useful, and hard to drift.

## Product Definition

Aionis is an evidence-gated Cognitive Memory and Execution Learning Runtime for AI Agents.

It helps an Agent recall ordinary memory with evidence, remember real execution, learn what worked, forget what hurts, and let historical evidence shape future behavior under controlled authority.

Aionis is not a recall-only memory system. It is a state-adjudicated memory
runtime: it governs memory authority, lifecycle, scope, attribution, and risk
before compiling bounded context for an Agent.

The product is not "cross-thread handoff" alone. Cross-thread, cross-Agent, and cross-LLM continuity are proof surfaces for a larger product promise:

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

## Four Product Actions

The product surface should collapse around four verbs.

| Product Action | User Meaning | Current Runtime Capabilities |
|---|---|---|
| `observe` | Record what actually happened during execution. | memory write, handoff store, trajectory compile, replay step evidence, delegation records, tool feedback |
| `guide` | Produce the next compact cognitive and execution context from history. | recall, recall_text, context assemble, planning context, action retrieval, experience intelligence, resume/handoff packs |
| `forget` | Control what should cool down, retire, archive, or rehydrate. | semantic forgetting, suppression, archive relocation, anchor rehydration, node activation |
| `measure` | Prove whether history changed the run positively or negatively. | runtime effect summary, promotion quality, runtime signal trends, maintenance reports, paired eval reports |

Internal mechanisms may remain richer than these verbs, but product docs, demos, and user-facing integrations should not expose every internal route as a product concept. Concrete product API usage is defined in [AIONIS_PRODUCT_API_USAGE.md](AIONIS_PRODUCT_API_USAGE.md), host integration templates are defined in [AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md), capability routing and deletion decisions are tracked in [AIONIS_CAPABILITY_DECISION_MATRIX.md](AIONIS_CAPABILITY_DECISION_MATRIX.md), and stable user-facing outputs are defined in [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md).

The shortest runnable product flow is [AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md](AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md). It demonstrates `observe -> guide -> audit` without adding an Agent harness or benchmark runner. External Agent hosts should use [AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md) for the full `observe -> guide -> agent action -> feedback -> measure -> snapshot` loop.

## Multi-Agent Execution Memory Position

Aionis should be a Multi-Agent execution memory backend, not a Multi-Agent
orchestrator.

External hosts decide which Agent acts next. Aionis records what each Agent did,
compiles branch-aware execution state, controls which history can be reused, and
measures whether that shared history helped.

The product contract for Multi-Agent execution memory is:

| Field / Surface | Meaning |
|---|---|
| `producer_agent_id` | Agent that wrote an observed memory or execution event. |
| `consumer_agent_id` | Agent receiving guide context. Private memory is visible only when this identity is aligned with the writer/owner. |
| `owner_team_id` / `consumer_team_id` | Team boundary for shared multi-agent memory. |
| `memory_lane: "private"` | Agent-local memory. Use only when the same Agent should retrieve it later. |
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
team-owned shared memory does not leak across teams, private memory does not
leak across agents, cross-team attribution is rejected, and failed execution
branches do not enter `use_now`.

## Observe Input Contract

`POST /v1/observe` is the product entry for writing history. Users should not need to know the internal node and slot schema for common writes.

Supported product inputs:

| Input | Product Meaning | Runtime Projection |
|---|---|---|
| `input_text` | Plain ordinary memory, preference, fact, or project context. | Auto-structured into a recallable general memory node when no lower-level node is supplied. |
| `memory` / `nodes` | Explicit advanced memory write. | Passed through existing memory write structuring, with execution surfaces normalized when present. |
| `execution` | One observed execution experience, with task/run identity, outcome, workflow steps, tools, evidence, and continuation hint. | Auto-structured into an execution workflow memory candidate with evidence and advisory authority. |
| `handoff` | Resumable state for future continuation. | Stored through the handoff continuity engine. |

This facade is a product input adapter only. It must not add host-specific behavior, benchmark-specific actions, or single-task repair rules. Internal routes may still use richer schemas after the facade has normalized user input.

### Execution State Tree Default

Execution-tree state is a default internal product path for execution continuity, not a replacement for ordinary memory.

Default tree construction applies when `POST /v1/handoff/store` or `POST /v1/memory/write` carries execution continuity slots such as `execution_state_v1`, `execution_packet_v1`, `execution_result_summary`, `execution_artifacts`, or `execution_evidence`. The Runtime records the current execution branch, compressed progress, validation outcome, and failed/alternate branch hints so later `guide`, planning, context assembly, and recover surfaces can use the current branch without promoting failed branches as next-action context.

This default path must stay scoped to execution state. Plain facts, preferences, and general cognitive memory must not be auto-converted into execution trees. Callers can disable only the automatic tree side effect by setting `execution_tree_disabled: true` or `execution_tree_default_disabled: true` on handoff/write requests; explicit `execution_tree_v1` and `execution_tree_operations_v1` remain caller-owned state and are still applied. Operators can disable the default globally with `EXECUTION_TREE_DEFAULT_ENABLED=false`.

## Guide Output Contract

`POST /v1/guide` is the product entry for giving an Agent usable historical context.

Default output:

| Field | Product Meaning |
|---|---|
| `agent_context` | Short Agent-facing context with summary, authority, risk, target files, use/inspect/do-not-use lists, memory IDs, and rehydration hints. |

Optional audit output:

| Request Flag | Additional Fields |
|---|---|
| `include_packets: true` | Adds `memory_packet` and `guide_packet` for measurement, debugging, or advanced integrations. |
| `mode: "full_power"` or `context_mode: "full_power"` | Internally merges semantic recall with safe full-power execution context while still exposing only `agent_context` to the Agent. |

The SDK defaults `guide()` calls to `mode: "full_power"` because that is the
recommended product adapter path. Raw HTTP callers may still omit mode for the
legacy standard route behavior or set `mode: "standard"` explicitly.

The default Agent surface must not be the full `memory_packet + guide_packet`. Full packets remain available for audit and `measure`, but they are not the default prompt surface.

Full-power guide mode must preserve the same Agent boundary: raw evidence,
gated abstractions, selection trace, and audit prompt text are internal or
operator surfaces. Only the safe merged `agent_context` reaches the Agent.

Decision trace and audit surfaces are separate operator/debug outputs. The usage boundary is defined in [AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md](AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md): Agents consume `agent_context`; developers inspect `memory_decision_trace` and `memory_decision_audit`.

Generated `memory_decision_trace` and `operator_snapshot` outputs include
`memory_use_receipt`, a compact read-only receipt of the memory IDs exposed as
`use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate`, plus feedback
attribution and risk flags. It is for host/operator audit only and must not be
used as Agent prompt content.

## Forget Input Contract

`POST /v1/forget` is the product entry for controlled forgetting, suppression, rehydration, and reuse feedback. Users should not need to know the internal lifecycle route names.

Supported product operations:

| Operation | Product Meaning | Runtime Projection |
|---|---|---|
| `suppress` | Temporarily or strongly suppress a learned pattern from future guidance. | Pattern suppression with `shadow_learn` or `hard_freeze` mode. |
| `unsuppress` | Restore a previously suppressed pattern when it becomes valid again. | Pattern unsuppression. |
| `rehydrate` | Bring archived memory or anchor payload back into usable context on demand. | Archive rehydration for memory IDs, or anchor payload rehydration for anchors. |
| `activate` | Record that a recalled memory was actually useful in a run. | Node activation feedback with outcome and run evidence. |

Supported targets:

| Target | Product Meaning |
|---|---|
| `memory` | A remembered node selected by `memory_ids`, `node_ids`, or `client_ids`. |
| `archive` | Archived memory that should move back to `warm` or `hot`. |
| `payload` | The payload behind an anchor, rehydrated by `anchor_id` or `anchor_uri` only when requested. |
| `pattern` | A learned pattern controlled by suppression or unsuppression through `anchor_id`. |

This facade may return an internal `source_map` for auditability, but user integrations should consume `forget_effect`: action, target, reason, changed count, reversibility, affected IDs, and anchor identity. Forget operations must control memory lifecycle and authority; they must not delete source evidence silently or add task-specific behavior.

## Measure Input Contract

`POST /v1/measure` is the product entry for proving whether history changed future behavior positively or negatively.

Supported measurement inputs:

| Input | Product Meaning | Runtime Projection |
|---|---|---|
| `baseline` + `aionis` | Advanced caller supplies direct effect observations. | Evaluated by the focused effect evaluator. |
| `product_trace.before_guide` + `product_trace.after_guide` | Caller supplies two product guide outputs, usually before and after `observe` or `forget`. | Projected into continuity, learning, forgetting, and learning-control observations. |
| `product_trace.baseline` + `product_trace.after_guide` | Caller supplies a direct baseline plus one active Aionis guide output. | Uses the direct baseline and packet-derived Aionis observation. |
| `product_trace.forget_result` | Caller supplies the product forget result used between guide snapshots. | Counts suppression or rehydration effect without exposing internal lifecycle route schemas. |

Product trace measurement proves packet-level Aionis effects: history used, repeated-discovery reduction signal, useful context ratio, stale-memory suppression, rehydration, workflow candidate reuse, and authority blocking. It must not be described as proof that an external Agent completed a task unless an external validation layer supplies that outcome as separate evidence.

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

## What Aionis Must Not Own

Aionis must not own:

1. external host framework product behavior
2. semantic patch generation for a specific task
3. repository-specific repair procedures
4. benchmark-specific action semantics
5. single-run hard rules
6. model fine-tuning execution as part of the core Runtime
7. cloud control plane, admin console, playground, or docs product

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

Historical execution must not directly become source-code rules, task-specific fixes, or hard Runtime behavior.

## Replay Position

Replay is not the product face.

Replay is an internal evidence engine. It proves what happened, supplies workflow learning evidence, supports promotion/demotion, and helps measure whether a reused path worked.

The product should say:

Aionis learns from real execution traces.

It should not lead with:

Aionis is a playbook repair system.

## Training Data Position

Aionis execution memory can become a training data asset, but only after distillation and evidence gating.

| Data Source | Training Value | Use Condition |
|---|---|---|
| handoff/resume packets | Train state compression and task continuation. | Must be outcome-labeled and privacy-filtered. |
| successful workflow traces | Train planning, tool selection, and verification habits. | Must have repeated positive transfer evidence. |
| failed traces | Train avoidance and recovery judgment. | Must be labeled as negative/counter-evidence. |
| promotion/demotion records | Train trust and transfer judgment. | Must include authority and lifecycle labels. |
| forgetting/suppression records | Train memory hygiene. | Must include why the memory stopped helping. |

Raw traces and raw chat are not training-ready data. Aionis should export distilled, evidence-labeled execution examples first.

The first training candidates should be:

1. handoff distillation examples
2. transfer-judge examples
3. workflow-selector examples
4. forgetting/suppression examples

LoRA or adapter training is a downstream consolidation path, not the core Runtime product.

## Product Proof Contract

Aionis should not primarily try to prove generic Agent issue success-rate lift first. That is too entangled with Agent quality, model quality, repo difficulty, provider stability, and verifier quality.

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
