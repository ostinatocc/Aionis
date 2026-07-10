# Aionis Capability Decision Matrix

Status: product capability triage from current focused Runtime code

This document decides where each discovered Runtime capability belongs before any product entrypoint, facade, eval, or deletion work.

No source behavior should be changed from this document alone. It is a decision map, not an implementation plan.

## Decision Rule

A capability can be connected to the product surface only if it directly supports the product contract:

1. remember real execution
2. learn from evidence
3. forget or suppress what hurts
4. let history shape future behavior under controlled authority
5. measure whether the effect was positive or negative

Anything else must be internal, eval-only, training-candidate-only, or deletion-review.

## Classification Labels

| Label | Meaning |
|---|---|
| `product-core` | Directly part of user-perceived Aionis value. |
| `product-support` | Required to run the product cleanly, but not the value itself. |
| `internal-evidence` | Internal evidence, replay, promotion, authority, or measurement machinery. |
| `internal-guidance` | Internal advisory machinery that may feed product output but should not become hard control. |
| `review-support` | Operator/agent inspection surface, useful but not core product API. |
| `training-asset` | Useful for exporting future training examples after evidence gating. |
| `eval-only` | Validation carrier only; must not define Aionis source behavior. |
| `delete-review` | Keep only if dependency review proves a focused product capability still needs it. |

## Capability Decisions

| # | Capability | Code Location | Real Role | Product Action | Product Exposure | Decision | Why |
|---|---|---|---|---|---|---|---|
| 1 | Local Lite Runtime daemon | `src/index.ts`, `src/runtime-entry.ts`, `src/server/*`, `scripts/start-lite.sh` | Runs the local Runtime. | support | Visible as runtime process only. | `product-support` keep | Needed for local-first product. |
| 2 | Tenant/scope isolation | `src/memory/tenant.ts`, `src/app/request-guards.ts` | Separates memory by tenant/scope. | all | Visible as config fields. | `product-core` keep | Required for scoped continuity and learning. |
| 3 | Agent identity and memory lane | `src/app/request-guards.ts`, `src/store/lite-*` | Separates producer/owner/consumer/team/private/shared memory. | observe, guide | Visible as identity/lane fields. | `product-core` keep | Required for cross-Agent and team memory. |
| 4 | Cross-thread / cross-run handoff | `src/routes/handoff.ts`, `src/memory/handoff.ts`, `src/execution/*` | Stores and recovers resumable execution state. | observe, guide | Yes. Product capability. | `product-core` keep | Strong continuity value. |
| 5 | Agent inspect/review/resume/handoff packs | `src/routes/memory-access.ts`, `src/memory/agent-memory-inspect-core.ts` | Produces agent-facing recovery/review packets. | guide | Resume/handoff visible; inspect/review support. | `product-core` keep | Converts memory into usable agent context. |
| 6 | Cross-LLM continuity substrate | `src/memory/experience-intelligence.ts`, `src/app/planning-summary.ts`, `src/memory/execution-contract.ts` | Provider-neutral structured packets. | guide, measure | Claim only after cross-provider proof. | `product-core` keep with proof gap | Core differentiator, but validation is incomplete. |
| 7 | Execution state transitions | `src/execution/state-store.ts`, `src/execution/transitions.ts` | Revisioned state and transition history. | observe, guide | Hidden behind packets. | `product-core` keep | Real continuity needs durable state, not chat text. |
| 8 | Execution packet assembly | `src/execution/assemble.ts`, `src/execution/packet.ts`, `src/execution/profiles.ts` | Builds compact state/evidence packet. | guide | Visible as output packet. | `product-core` keep | Main product artifact for future runs. |
| 9 | Memory write and projection | `src/routes/memory-write.ts`, `src/memory/write*.ts` | Writes nodes, edges, commits, workflows, execution-native surfaces. | observe | Visible as observe/write contract. | `product-core` keep | Entry point for real execution memory. |
| 10 | Recall with lifecycle/trust | `src/routes/memory-recall.ts`, `src/memory/recall.ts`, `src/app/recall-policy.ts` | Retrieves scoped, filtered memory. | guide | Visible only through guide/context outputs. | `product-core` keep | Needed for memory usefulness. |
| 11 | Planning/context assembly | `src/routes/memory-context-runtime.ts`, `src/app/planning-summary*.ts` | Builds internal planning summaries behind the compact guide packet. | guide | Yes. Internal backing output. | `product-core` keep | This is how history reaches the Agent without exposing internal packets. |
| 12 | History-shaped future behavior | `src/app/planning-summary.ts`, `src/memory/experience-intelligence.ts`, `src/kernel/effect-evaluator.ts` | Shows how prior history changed the next packet/action. | guide, measure | Yes. Product outcome. | `product-core` keep | This is the top-level value claim. |
| 13 | Action retrieval | `src/memory/action-retrieval.ts` | Ranks workflows, patterns, continuity carriers, policies. | guide | Visible as advisory suggestions with authority. | `internal-guidance` keep | Useful only if advisory, not hard task control. |
| 14 | Experience intelligence | `src/memory/experience-intelligence.ts` | Composes action retrieval, tools, delegation, policy, introspection. | guide | Visible as guide output, not as a separate product concept. | `product-core` keep | Converts many memories into one agent-usable recommendation. |
| 15 | Continuity guidance | `src/memory/experience-intelligence.ts`, `src/app/planning-summary.ts` | Suggests continuity signal. | guide | Visible as recommendation with uncertainty. | `product-core` keep | Directly reduces repeated discovery. |
| 16 | Execution contract and outcome gate | `src/memory/execution-contract.ts`, `src/memory/contract-trust.ts` | Structures selected tool/path/workflow/acceptance checks/trust. | observe, measure | Visible as evidence/trust fields. | `internal-evidence` keep | Prevents vague memory and unearned authority. |
| 17 | Trajectory compile | `src/memory/trajectory-compile*.ts` | Converts step traces into evidence/workflow seed surfaces. | observe | Not primary product API. | `internal-evidence` keep | Needed for learning from real traces. |
| 18 | Delegation records | `src/memory/delegation-records*.ts`, `src/memory/delegation-learning.ts` | Records cross-Agent handoff/delegation evidence. | observe, guide | Visible for cross-Agent product mode. | `product-core` keep | Supports multi-Agent continuity without binding to one framework. |
| 19 | Evidence-gated workflow learning | `src/kernel/learning-kernel.ts`, `src/memory/learning-loop.ts` | Promotes workflows from evidence. | observe, measure | Hidden; product sees learned guidance and evidence. | `product-core` keep | Core self-learning mechanism. |
| 20 | Promotion evidence protocol | `src/memory/promotion-evidence-ledger.ts`, `src/memory/promotion-quality-summary.ts` | Separates candidate, local reuse, and broader trust. | measure | Visible in effect/report output. | `internal-evidence` keep | Prevents single-task pollution. |
| 21 | Pattern trust and suppression | `src/memory/pattern-trust-shaping.ts`, `src/memory/pattern-operator-override.ts` | Handles candidate/trusted/contested/suppressed patterns. | forget, measure | Visible as memory lifecycle status. | `product-core` keep | Directly supports controlled learning and forgetting. |
| 22 | Policy memory materialization | `src/memory/policy-memory.ts`, `src/memory/policy-materialization-surface.ts` | Materializes derived policy memory. | guide, measure | Hidden unless included as trusted guidance. | `internal-guidance` keep | Useful, but product should not overclaim policy self-modification. |
| 23 | Policy mutation loop | `src/kernel/policy-mutation-loop.ts` | Creates/adjudicates policy mutation candidates. | measure | Internal only. | `internal-evidence` keep | Research-grade mechanism; not product-facing yet. |
| 24 | Learning-control providers | `src/memory/learning-control-provider*.ts`, `src/app/learning-control-runtime-providers.ts` | Produces semantic candidate reviews from deterministic/evidence/model/http providers. | measure | Internal only. | `internal-guidance` keep | Must stay candidate/advisory to avoid over-governance. |
| 25 | Authority visibility and consumption | `src/memory/authority-*.ts`, `src/kernel/boundary.ts` | Makes authority/trust/blocking visible. | guide, measure | Visible as authority labels. | `product-core` keep | Trust differentiation versus simple memory systems. |
| 26 | Rule feedback/evaluation | `src/memory/rules*.ts`, `src/memory/rule-policy.ts` | Stores/evaluates scoped advisory rule state used by recall/tools/learning. | observe, guide | Do not expose as product rule engine. | `internal-guidance` keep | Dependency review shows recall/tools/learning still use it; keep hidden and subordinate to scoped policy/pattern memory. |
| 27 | Tool selection memory | `src/memory/tools-*.ts`, `src/memory/tool-*.ts` | Learns tool preferences and tool run feedback. | guide, observe | Hidden/advisory. | `internal-guidance` keep | Product value is learned preference, not tool router ownership. |
| 28 | Replay run lifecycle | `src/memory/replay*.ts`, `src/routes/memory-replay-core.ts` | Records replay/evidence runs and step outcomes. | observe, measure | Internal only. | `internal-evidence` keep | Replay is evidence engine, not product face. |
| 29 | Replay playbooks | `src/memory/replay*.ts`, `src/routes/memory-replay-*` | Compiles/candidates/promotes/repairs/runs playbooks. | observe, guide, measure | Internal; product wording is workflow reuse. | `internal-evidence` keep | Keep for workflow learning; avoid repair-system positioning. |
| 30 | Controlled semantic forgetting | `src/kernel/forgetting-kernel.ts` | Scores retain/demote/archive/review. | forget | Yes. Product capability. | `product-core` keep | One of the main product differentiators. |
| 31 | Archive relocation | `src/kernel/forgetting-kernel.ts` | Moves cold memory while preserving payload refs. | forget | Visible as archive summary. | `product-core` keep | Better than blind deletion. |
| 32 | Rehydration | `src/kernel/forgetting-kernel.ts`, `src/memory/lifecycle-lite.ts`, `src/memory/rehydrate-anchor.ts` | Restores archived/payload memory when needed. | forget, guide | Visible as rehydration event. | `product-core` keep | Makes forgetting controllable. |
| 33 | Node activation feedback | `src/memory/lifecycle-lite.ts`, `src/memory/node-feedback-state.ts` | Warms useful memory after use. | forget, measure | Hidden except lifecycle summary. | `product-core` keep | Needed for positive transfer and retention. |
| 34 | Runtime maintenance | `src/memory/runtime-maintenance.ts`, `src/kernel/learning-kernel.ts` | Runs maintenance across learning/forgetting/authority/signals. | measure | Visible as maintenance/effect report, not manual control surface. | `internal-evidence` keep | Product needs its output, not its internal knobs. |
| 35 | Runtime signal ledger/trends | `src/memory/runtime-signal-ledger.ts`, `src/memory/runtime-signal-trends.ts` | Aggregates verifier/provider/retry/recovery/token trends. | measure | Visible as effect/risk summary. | `internal-evidence` keep | Required for dynamic governance and negative transfer detection. |
| 36 | Runtime effect summary | `src/memory/runtime-effect-summary.ts`, `src/kernel/effect-evaluator.ts` | Measures whether Aionis improved/worsened a run. | measure | Yes. Product capability. | `product-core` keep | Proves value. |
| 37 | Runtime entropy profile | `src/memory/runtime-entropy-profile.ts`, `src/memory/runtime-entropy-controls.ts` | Balances exploration/control intensity. | guide, measure | Hidden; expose only outcome posture. | `internal-guidance` keep | Useful if it controls intensity, not task behavior. |
| 38 | Adaptive guidance | `src/memory/adaptive-guidance.ts`, `src/memory/schemas.ts` | Produces decomposed guidance candidates and uncertainty adjustment. | guide | Only as advisory candidate. | `internal-guidance` keep | Must not become hard constraints. |
| 39 | Cognitive structure | `src/kernel/cognitive-structure.ts`, `src/memory/execution-introspection.ts` | Builds evidence/workflow/policy/forgetting/authority graph. | measure | Review/report only. | `review-support` keep | Useful for inspection and future training data labels. |
| 40 | Runtime boundary inventory | `src/server/lite-runtime-boundary.ts`, `src/server/http-server.ts` | Reports product/kernel boundary and route matrix. | support | Visible support route. | `product-support` keep | Helps keep product boundary honest. |
| 41 | Embedding providers and surface policy | `src/embeddings/*` | Provides semantic retrieval embeddings and surface controls. | guide | Config visible; internals hidden. | `product-support` keep | Required for semantic recall and provider hygiene. |
| 42 | Local SQLite stores | `src/store/*` | Persists write/recall/replay/runtime/execution state locally. | support | Hidden. | `product-support` keep | Local-first base. |
| 43 | Request guards | `src/app/request-guards.ts`, `src/util/inflight_gate.ts`, `src/util/ratelimit.ts` | Rate/inflight/quota/identity defaults. | support | Hidden except config. | `product-support` keep | Runtime hygiene. |
| 44 | Sandbox executor remnants | `src/memory/sandbox*.ts`, `src/store/sandbox-access.ts`, `src/app/sandbox-budget.ts` | Internal sandbox execution support used by replay execution and runtime services after public routes were removed. | measure | No product exposure. | `internal-evidence` keep | Dependency review shows replay still depends on sandbox execution/backends; keep internal and keep public sandbox product out of scope. |
| 49 | CI contract tests | `scripts/ci/*` | Verifies mechanism contracts. | support | Developer-only. | `product-support` keep | Needed to avoid regressions. |
| 50 | L0-L5 execution memory levels | `src/memory/schemas.ts`, `src/memory/write-execution-native.ts`, `src/memory/workflow-write-projection.ts`, `src/memory/policy-memory.ts` | Memory spine from raw event to policy/cognitive structures. | observe, guide, forget, measure | Concept visible; internals hidden. | `product-core` keep | Differentiates execution memory from chat memory. |
| 51 | Runtime verification surface | `src/execution/verification.ts` | Builds verification requests/results/evidence. | measure | Visible as evidence summary only. | `internal-evidence` keep | Measures execution; should not solve tasks. |
| 52 | Execution evidence and provenance | `src/memory/execution-evidence.ts`, `src/memory/execution-provenance.ts` | Tracks fact/source/trust provenance. | observe, measure | Visible in evidence fields. | `product-core` keep | Needed for trustworthy memory. |
| 53 | Execution agent contract packet | `src/memory/execution-agent-contract-packet.ts`, `src/memory/action-intelligence-runtime-contract.ts` | Agent-consumable contract and action intelligence packet. | guide | Yes, but under guide product output. | `product-core` keep | The Agent needs a compact actionable packet. |
| 54 | Recall observability and audit | `src/app/recall-observability.ts`, `src/memory/recall-debug-layer-helpers.ts` | Shows why recall behaved as it did. | measure | Effect/debug summary only. | `internal-evidence` keep | Needed to diagnose context pollution. |
| 55 | Recall ranking and serialization | `src/memory/recall-ranking.ts`, `src/memory/recall-serialization.ts`, `src/memory/recall-action-packet.ts` | Ranks and serializes recall output. | guide | Hidden. | `internal-guidance` keep | Retrieval quality support. |
| 56 | Recall text embedding | `src/app/recall-text-embed.ts`, `src/routes/memory-context-runtime.ts` | Embeds ad hoc text for recall/context. | guide | Hidden except provider config. | `product-support` keep | Required for semantic continuity. |
| 57 | Context optimization profile | `src/app/context-optimization-profile.ts` | Applies context budget strategy. | guide, measure | Hidden; expose cost effect. | `internal-guidance` keep | Helps token efficiency without being product face. |
| 58 | Planning summaries by subdomain | `src/app/planning-summary*.ts` | Summarizes execution, routing, forgetting, maintenance, workflow, policy, authority. | guide, measure | Visible as guide/effect sections. | `product-core` keep | Translates internals into usable output. |
| 59 | Cost and importance dynamics | `src/memory/cost-signals.ts`, `src/memory/importance-dynamics.ts` | Scores cost/importance for learning/forgetting. | forget, measure | Hidden; expose summary only. | `internal-evidence` keep | Enables controlled forgetting and value metrics. |
| 60 | Associative linking substrate | `src/jobs/associative-linking-lib.ts`, `src/memory/associative-*.ts` | Related-memory candidate/linking support used by write post-commit and projection paths. | guide | No direct exposure. | `internal-evidence` keep | Dependency review shows active write/projection integration; keep internal and measure later. |
| 61 | Raw memory find/resolve | `src/memory/find.ts`, `src/memory/resolve.ts`, `src/routes/memory-access.ts` | Low-level memory lookup. | support | Operator/internal only. | `review-support` hide | Useful for debugging, not product API. |
| 62 | Reviewer packs | `src/memory/reviewer-packs.ts`, `src/routes/memory-access.ts` | Continuity/evolution review packs. | measure | Review/support only. | `review-support` keep | Useful for audit, not default user path. |
| 63 | Evolution operators and inspect | `src/memory/evolution-operators.ts`, `src/memory/evolution-inspect.ts` | Review surfaces for learning evolution. | measure | Review/support only. | `review-support` keep | Helps inspect learning quality. |
| 64 | Layer policy | `src/memory/layer-policy.ts` | Encodes tier/layer/lifecycle treatment. | all | Hidden. | `product-core` keep | Underpins L0-L5 memory lifecycle. |
| 65 | Node execution surface and slot surface | `src/memory/node-execution-surface.ts`, `src/memory/execution-slot-surface.ts` | Normalizes execution-native node/slot surfaces. | observe | Hidden. | `internal-evidence` keep | Required for structured execution writes. |
| 66 | Workflow candidate aggregation | `src/memory/workflow-candidate-aggregation.ts` | Aggregates workflow candidates before promotion/reuse. | observe, guide | Hidden. | `internal-evidence` keep | Needed for evidence-gated workflow learning. |
| 67 | Passthrough schema registry | `src/memory/passthrough-schema-registry.ts` | Registered structured payload schema names for a standalone CI check. | none | Removed. | removed | Deleted because Runtime did not import it; only its own unlisted CI test depended on it. |
| 68 | HTTP observability and error handling | `src/app/http-observability.ts`, `src/server/http-server.ts`, `src/util/*` | Request ids, logs, health, errors, redaction, IP/rate controls. | support | Visible as clean errors/health. | `product-support` keep | Product hygiene. |
| 69 | Service lifecycle constraints | `src/execution/types.ts`, `src/execution/assemble.ts` | Represents service/process constraints in execution packet. | guide | Visible in execution packet if relevant. | `product-core` keep | Helps real agent continuation. |
| 70 | Config and provider environment | `src/config.ts`, `scripts/start-lite.sh` | Centralizes mode, DB, embedding/LLM provider, limits, listen posture. | support | Visible as setup/config. | `product-support` keep | Must be simplified, not removed. |

## Product Surface Decisions

These are decisions, not implementation instructions.

| Product Action | Must Include | Must Not Include |
|---|---|---|
| `observe` | memory write, execution state/handoff store, trajectory evidence, delegation records, execution evidence/provenance | benchmark-specific traces, external host assumptions, source-code rules from a single run |
| `guide` | context assembly, execution packet, resume/handoff packet, action retrieval, experience intelligence, workflow candidates, authority labels | semantic patch generation, hard task constraints, direct replay repair as product promise |
| `forget` | semantic forgetting, suppression, archive relocation, rehydration, node activation, lifecycle summary | blind deletion, irreversible loss, hidden suppression with no explanation |
| `measure` | effect summary, promotion quality, runtime signals, recall observability, negative-transfer report, token/context/repeated-discovery deltas | pass/fail claims based only on one issue, one repo, one model, or one host |

## Route Exposure Contract

The Runtime may keep internal routes for evidence, review, and control, but the route matrix must not present every route as a product entry.

| `product_exposure` | Meaning |
|---|---|
| `product_entry` | User-facing product action or packet route. |
| `product_support` | Product support surface such as health/boundary metadata. |
| `internal_evidence` | Replay, trajectory, maintenance, feedback, or measurement machinery. |
| `internal_guidance` | Advisory guidance machinery that feeds product output but should not be the product face. |
| `internal_control` | Learning-control lifecycle operation, not a user feature. |
| `operator_support` | Review/debug/inspection route. |

Routes such as raw `find`, raw `resolve`, `rules/state`, `rules/evaluate`, and replay repair/run/dispatch must not be classified as `product_entry`.

## Delete-Review Queue

These items are not deleted by this document. They are queued for dependency review.

| Item | Why It Is Suspicious | Required Before Deletion |
|---|---|---|
| Rule feedback/evaluation public surface | Can look like hard rule accumulation and overlap with policy/pattern memory. | Keep internal only; do not present as product rule engine. |
| Raw `find`/`resolve` routes | Useful for debugging but not a product experience. | Keep only as internal/operator support or remove from public route docs. |

## Training Asset Queue

These are not Runtime behavior changes. They are candidate data products that can be exported later.

| Training Candidate | Source Capabilities | Label Needed |
|---|---|---|
| Handoff distillation examples | handoff store/recover, resume/handoff packs, execution packets | whether a new run recovered correct state without old chat |
| Transfer-judge examples | action retrieval, experience intelligence, promotion/demotion evidence | positive, negative, or neutral transfer |
| Workflow-selector examples | replay runs, workflow candidates, promotion evidence | whether workflow reuse succeeded, failed, or was blocked |
| Forgetting/suppression examples | semantic forgetting, suppression, archive, rehydration, node activation | why memory was demoted, retired, archived, or rehydrated |
| Authority judgment examples | authority visibility, contract trust, learning-control decisions | advisory, candidate, trusted, blocked, contested |

## Implementation Gate

Do not implement product entrypoints, facade routes, or demos until this matrix is accepted and the delete-review queue is addressed enough to avoid wrapping messy internal surfaces.

Valid next implementation work after acceptance:

1. hide or delete confirmed delete-review items
2. accept the stable product output schema in [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md)
3. connect only accepted `product-core` and `product-support` capabilities
4. build a history-impact demo against the accepted product surface
5. export training-candidate records from accepted evidence sources
