# Focus Boundary

Aionis Runtime Focused is scoped to the local Runtime kernel.

The focused architecture contract is [FOCUSED_RUNTIME_ARCHITECTURE_CONTRACT.md](FOCUSED_RUNTIME_ARCHITECTURE_CONTRACT.md). It is the canonical product-level contract for the Action Intelligence loop, Persistent Cognitive Structure, memory evolution, policy mutation, and controlled forgetting surfaces.

## In Scope

1. execution continuity
2. task start and resume packets
3. handoff and recovery anchors
4. replay-derived workflow learning
5. learning-controlled promotion, suppression, and counter-evidence
6. semantic forgetting and archive rehydration
7. Lite/Postgres store-port decoupling

## Out of Scope

1. host-specific agent adapters
2. hosted docs site
3. inspector/playground/product UI
4. Aionis Doc
5. broad automation product surface
6. generic sandbox product surface
7. cloud multi-tenant control plane
8. release/dogfood flows tied to removed adapters

## Decision Rule

Keep code when it directly strengthens continuity, learning, forgetting, or learning control.

Delete or extract code when it primarily exists for an adapter, demo, product UI, broad platform surface, or internal extension shim.

Learning-control development follows [LEARNING_CONTROL_PRINCIPLES.md](LEARNING_CONTROL_PRINCIPLES.md). Do not treat every real-task failure as a reason to add a permanent hard rule. Classify the failure, scope the lesson, add escape conditions, and verify against prior and holdout tasks before broadening Runtime guidance.

The product/eval boundary is defined in [ARCHITECTURE_BOUNDARY.md](ARCHITECTURE_BOUNDARY.md). Core Runtime, Real Eval Harness, and Experimental Policies are separate layers. Real eval proves or falsifies Aionis behavior; it is not itself the product. Experimental policies start as scoped guidance or workflow candidates, not global Runtime truth.

## Kernel Contract

The executable boundary lives in `src/kernel/boundary.ts`.

The focused Runtime has exactly four primary kernel capabilities:

1. continuity
2. learning
3. forgetting
4. learning control

The capability id is `learning_control`. Routes, payloads, traces, env vars, and SDK contracts use the learning-control vocabulary directly.

Internal implementation files must not keep old extension shims. Canonical Runtime code uses `learning-control-*` names.

Learning control means authority gates, promotion admissibility, suppression overlays, and memory lifecycle control. It does not mean admin control planes, cloud control, enterprise policy consoles, or adapter management.

LLM classification is allowed only as a semantic candidate producer. Deterministic Runtime mechanisms still decide verifier phase, edit boundary, provider/protocol quarantine, learning-control adjudication, and workflow promotion.

## Effect Contract

Focused Aionis must prove agent-visible improvement, not just store more memory.

The executable effect harness lives in `src/kernel/effect-harness.ts`. It compares a baseline run with an Aionis-backed run across the four kernel capabilities:

1. continuity: fewer repeated discovery steps, correct first action, recovered state facts, carried verified facts
2. learning: workflow reuse, stable promotion, weak-evidence rejection, counter-evidence demotion
3. forgetting: context precision, stale-memory suppression, archive rehydration only when needed
4. learning control: evidence-gated authority, visible blocked authority, no unverified authority application

A run only passes when all four kernels pass and the measured Aionis score improves beyond the configured effect threshold. Safe runs with no measured improvement warn instead of passing.

## Real LLM Validation

Fixture-only trace files and hand-written metric suites are not accepted as effectiveness proof.

Real effectiveness validation lives behind `npm run eval:real-llm`. It requires a real LLM provider key, a real model, a real Lite Runtime, isolated workspace copies, real agent tool execution, real verifier commands, and baseline-vs-Aionis comparison. Missing provider configuration fails the run instead of falling back to a fake provider.

The real-eval command also fails when the Aionis-assisted arm does not satisfy the suite effect gate. A report that merely records activity is not enough; the report must show verifier-safe, measurable improvement over baseline.
