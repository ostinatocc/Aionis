# Aionis Product Contract

Status: focused product contract for the current Runtime implementation

This document defines the product boundary that Aionis should converge toward. It is not a new mechanism proposal. It is the contract that keeps existing Runtime capabilities understandable, useful, and hard to drift.

## Product Definition

Aionis is an evidence-gated Cognitive Memory and Execution Learning Runtime for AI Agents.

It helps an Agent recall ordinary memory with evidence, remember real execution, learn what worked, forget what hurts, and let historical evidence shape future behavior under controlled authority.

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
| `guide` | Produce the next compact cognitive and execution context from history. | recall, recall_text, context assemble, planning context, action retrieval, experience intelligence, kickoff, resume/handoff packs |
| `forget` | Control what should cool down, retire, archive, or rehydrate. | semantic forgetting, suppression, archive relocation, anchor rehydration, node activation |
| `measure` | Prove whether history changed the run positively or negatively. | runtime effect summary, promotion quality, runtime signal trends, maintenance reports, paired eval reports |

Internal mechanisms may remain richer than these verbs, but product docs, demos, and user-facing integrations should not expose every internal route as a product concept. Capability routing and deletion decisions are tracked in [AIONIS_CAPABILITY_DECISION_MATRIX.md](AIONIS_CAPABILITY_DECISION_MATRIX.md), and stable user-facing outputs are defined in [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md).

## Core Capabilities

| Capability | Product Value | Current Implementation |
|---|---|---|
| General cognitive memory | Ordinary memory is returned with evidence, confidence, scope, lifecycle, contradiction risk, and expected behavior impact. | recall/context, L0-L5 layers, semantic forgetting surfaces, `aionis_memory_packet` |
| Execution continuity | The Agent can resume from proven execution state. | execution packets, state store, handoff store/recover, resume packs |
| Evidence-gated self-learning | Successful traces can become reusable workflows/patterns/policies without single-run promotion. | replay evidence, promotion ledger, learning loop, policy memory |
| Controlled forgetting | Stale or harmful memory demotes, archives, or rehydrates on demand instead of polluting context forever. | forgetting kernel, archive relocation, node activation, rehydration |
| Dynamic learning control | Aionis adjusts authority and intervention strength based on evidence, uncertainty, and risk. | authority gates, learning-control providers, runtime entropy profile |
| History-shaped future behavior | Prior execution changes future context, first action, workflow reuse, verification posture, and memory lifecycle. | planning summaries, action retrieval, experience intelligence, effect evaluator |
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

1. external Agent framework product behavior
2. semantic patch generation for a specific task
3. repository-specific repair procedures
4. benchmark-specific action semantics
5. single-run hard rules
6. model fine-tuning execution as part of the core Runtime
7. cloud control plane, admin console, playground, or docs product

External Agents and LLMs propose actions. Aionis remembers, guides, gates, forgets, and measures.

## History Shaping Contract

Historical execution may shape future behavior only through these controlled surfaces:

| Surface | Allowed Effect |
|---|---|
| memory packet | Recall ordinary memories with evidence, lifecycle, confidence, contradiction warnings, and expected behavior impact. |
| context packet | Include proven state, useful memories, suppression notes, and uncertainty. |
| first action recommendation | Bias the Agent toward a lower-waste starting point. |
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
| first useful action | reaches relevant state/action faster |
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
