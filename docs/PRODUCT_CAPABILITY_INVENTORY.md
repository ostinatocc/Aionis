# Aionis Product Capability Inventory

Status: focused Runtime product inventory

This document inventories product capabilities that are implemented inside `src/`.
It is not an eval runner plan and it must not introduce external host, repository,
benchmark, or task-specific behavior.

## Product Position

Aionis Runtime Focused is a local execution memory and learning-control Runtime.
It helps an Agent carry execution continuity across runs, learn only from evidence,
forget or suppress stale memory, and show how history changed future behavior.

## Capability Table

| Product Capability | Implemented Surfaces | Product Value | Boundary |
|---|---|---|---|
| Execution continuity | `src/execution/*`, `src/routes/handoff.ts`, `src/memory/handoff.ts`, `src/memory/execution-contract.ts` | Recover prior state, verified facts, handoff targets, and execution constraints across runs. | Does not solve the task for the Agent. |
| Cross-thread, cross-Agent, cross-LLM substrate | `src/app/request-guards.ts`, `src/memory/tenant.ts`, `src/memory/delegation-*.ts`, structured packets in `src/app/planning-summary*.ts` | Stores structured execution memory independently of one chat thread, one Agent identity, or one model. | Needs external validation outside this product tree before market claims. |
| Evidence-scoped recall | `src/routes/memory-recall.ts`, `src/memory/recall*.ts`, `src/app/recall-policy.ts`, `src/store/lite-recall-store.ts` | Retrieves useful ordinary and execution memory with lifecycle, authority, and trust state. | Recall is advisory unless evidence grants authority. |
| Guide packet assembly | `src/routes/memory-context-runtime.ts`, `src/app/planning-summary*.ts`, `src/memory/experience-intelligence.ts`, `src/memory/product-output-assembler.ts` | Produces compact context and guide packets showing trusted evidence, uncertainty, stale memory, and next-run bias. | Must stay compact; no rule wall. |
| Evidence-gated self-learning | `src/kernel/learning-kernel.ts`, `src/kernel/learning-promotion-kernel.ts`, `src/memory/learning-loop.ts`, `src/memory/promotion-evidence-ledger.ts` | Promotes reusable workflows or policies only when evidence supports them. | Single task evidence stays scoped and candidate-level. |
| Controlled forgetting | `src/kernel/forgetting-kernel.ts`, `src/memory/semantic-forgetting.ts`, `src/memory/archive-relocation.ts`, `src/memory/lifecycle-lite.ts`, `src/memory/rehydrate-anchor.ts` | Demotes, archives, suppresses, or rehydrates memory instead of accumulating stale guidance forever. | Forgetting must be reversible or explainable when possible. |
| Dynamic learning control | `src/memory/authority-*.ts`, `src/memory/runtime-entropy-*.ts`, `src/memory/runtime-signal-*.ts`, `src/kernel/policy-mutation-loop.ts` | Adjusts authority, promotion posture, entropy, and intervention intensity from evidence. | Does not replace LLM reasoning or semantic repair. |
| History-shaped future behavior | `src/memory/action-retrieval.ts`, `src/memory/experience-intelligence.ts`, `src/app/planning-summary*.ts`, `src/kernel/effect-evaluator.ts`, `src/memory/product-output-assembler.ts` | Makes visible what prior execution changed in the next packet, recommendation, verification posture, or suppression state. | Must prove effect through product outputs or external validation outside this tree. |
| Local storage and provider decoupling | `src/store/*`, `src/embeddings/*`, `src/config.ts`, `src/server/*` | Keeps Lite local-first while allowing provider and storage surfaces to stay behind ports. | No hosted cloud control plane in focused Runtime. |

## Product Outputs

| Output | Backing Code | Purpose |
|---|---|---|
| `aionis_agent_context` | `src/memory/product-output-contract.ts`, `src/memory/product-output-assembler.ts`, `/v1/guide` facade | Give Agents the compact default context with authority, risk, target files, memory IDs, and rehydration hints. |
| `aionis_memory_packet` | `src/memory/product-output-contract.ts`, `src/memory/product-output-assembler.ts`, recall routes | Show relevant memories, lifecycle, authority, trust, and shaping effect. |
| `aionis_guide_packet` | `src/app/planning-summary*.ts`, `src/memory/experience-intelligence.ts`, product assembler | Preserve the structured audit packet behind the compact Agent context. |
| `aionis_learning_packet` | learning loop, promotion ledger, forgetting and authority state | Show learning candidates, promotion state, blocked authority, and counter-evidence. |
| `aionis_effect_report` | `src/kernel/effect-evaluator.ts`, product assembler | Report whether history helped, hurt, or lacked sufficient evidence. |

## Non-Product Surfaces

The focused Runtime product tree must not contain external validation runners,
benchmark-specific tracks, or task-specific validation hosts.
Those can exist in a separate evaluation workspace, but not as package scripts,
product docs, or Runtime source behavior.

## Current Gaps

| Gap | Why It Matters | Correct Next Work |
|---|---|---|
| Product facade still exposes many internal routes | Users should not need to understand every Runtime subsystem. | Collapse output usage around observe, guide, feedback, controlled forget, measure, rehydrate, and snapshot. |
| Cross-Agent and cross-LLM proof is under-validated | The substrate exists, but proof is not strong enough for claims. | Validate externally without adding host code to this tree. |
| History-shaped behavior can be too strong or too weak | Positive transfer requires calibrated authority and entropy. | Improve generic effect reporting and intervention intensity, not task rules. |
| Ordinary memory is less productized than execution memory | Aionis can differentiate by applying lifecycle, authority, and forgetting to ordinary memory too. | Strengthen memory packet quality through existing recall/write surfaces. |

## Cleanup Rule

If a file exists primarily to run one Agent host, one benchmark, one repository pool,
or one task matrix, it does not belong in this focused Runtime product tree.
External runs may produce reports and scoped evidence, but they must not become
source-code policy or product architecture.
