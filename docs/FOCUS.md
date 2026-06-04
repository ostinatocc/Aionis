# Focus Boundary

Aionis Runtime Focused is scoped to the local evidence-gated cognitive memory and execution learning Runtime. This document is a convergence boundary, not a broad architecture proposal.

The product promise is narrow: an agent that uses Aionis should recover prior execution context, learn from real outcomes, forget harmful or stale memory, expose authority and evidence, and let history shape future behavior without turning single-task fixes into source code.

The formal product contract is [AIONIS_PRODUCT_CONTRACT.md](AIONIS_PRODUCT_CONTRACT.md). Capability routing and delete-review decisions are tracked in [AIONIS_CAPABILITY_DECISION_MATRIX.md](AIONIS_CAPABILITY_DECISION_MATRIX.md). Stable product outputs are defined in [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md). Cross-thread, cross-Agent, and cross-LLM continuity are proof surfaces for the larger product, not the total product positioning.

## In Scope

1. execution continuity
2. evidence-scoped ordinary memory recall
3. task start and resume packets
4. handoff and recovery anchors
5. replay-derived workflow learning
6. learning-controlled promotion, suppression, and counter-evidence
7. semantic forgetting and archive rehydration
8. local Lite store-port decoupling
9. compact guide packets that show how prior history changed memory selection, workflow reuse, risk, and forgetting

## Out of Scope

1. external host framework products
2. hosted docs site
3. inspector/playground/product UI
4. Aionis Doc
5. broad automation product surface
6. generic sandbox product surface
7. cloud multi-tenant control plane
8. SDK/package release wrappers
9. examples and sample surfaces
10. removed real-agent runners tied to external frameworks
11. release/dogfood flows tied to external frameworks
12. benchmark-specific tracks

## Decision Rule

Keep code when it directly strengthens continuity, learning, forgetting, or learning control.

Delete or extract code when it primarily exists for an external framework, sample flow, product UI, broad platform surface, or obsolete extension surface.

Learning-control development follows [LEARNING_CONTROL_PRINCIPLES.md](LEARNING_CONTROL_PRINCIPLES.md). Do not treat every real-task failure as a reason to add a permanent hard rule. Classify the failure, scope the lesson, add escape conditions, and verify against prior and holdout tasks before broadening Runtime guidance.

Aionis source code should describe the Runtime product, not external runners. Real agent evaluation can prove or falsify behavior, but it is not itself the product. Scoped guidance and workflow candidates belong in memory/evidence state, not as a separate source-code layer.

## Kernel Contract

The executable boundary lives in `src/kernel/boundary.ts`.

The focused Runtime has exactly four primary kernel capabilities:

1. continuity
2. learning
3. forgetting
4. learning control

The product-level effect of these four capabilities is history-shaped future behavior: future guide packets, workflow reuse, verification posture, suppression, and forgetting decisions must be measurably different because of prior real execution evidence.

The capability id is `learning_control`. Routes, payloads, traces, env vars, and Runtime contracts use the learning-control vocabulary directly.

Internal implementation files must not keep obsolete extension surfaces. Canonical Runtime code uses `learning-control-*` names.

Learning control means authority gates, promotion admissibility, suppression overlays, and memory lifecycle control. It does not mean admin control planes, cloud control, enterprise policy consoles, or external framework management.

LLM classification is allowed only as a semantic candidate producer. Deterministic Runtime mechanisms still decide verifier phase, edit boundary, provider/protocol quarantine, learning-control adjudication, and workflow promotion.

Guided replay follows the same rule: Runtime may emit `agent_repair_request` evidence, but it must not synthesize semantic patches through built-in LLM calls, HTTP repair hooks, or heuristic patch synthesis.

## Effect Contract

Focused Aionis must prove agent-visible improvement, not just store more memory.

The executable effect evaluator lives in `src/kernel/effect-evaluator.ts`. It compares a baseline run with an Aionis-backed run across the four kernel capabilities:

1. continuity: fewer repeated discovery steps, recovered state facts, carried verified facts, and earlier useful evidence recovery
2. learning: workflow reuse, stable promotion, weak-evidence rejection, counter-evidence demotion
3. forgetting: context precision, stale-memory suppression, archive rehydration only when needed
4. learning control: evidence-gated authority, visible blocked authority, no unverified authority application

A run only passes when all four kernels pass and the measured Aionis score improves beyond the configured effect threshold. Safe runs with no measured improvement warn instead of passing.

## Real Agent Validation

Fixture-only trace files and hand-written metric suites are not accepted as effectiveness proof.

Real effectiveness validation requires a real LLM provider key, a real model, a real focused Runtime, isolated workspace copies, real agent tool execution, real verifier commands, and baseline-vs-Aionis comparison. Missing provider configuration fails the run instead of pretending the provider is available.

The eval command is measurement-only unless the report shows verifier-safe, measurable improvement over baseline and observe-only controls. A report that merely records activity is not enough.
