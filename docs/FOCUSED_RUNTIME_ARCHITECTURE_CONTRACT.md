# Focused Runtime Architecture Contract

Aionis Runtime Focused is a local Persistent Cognitive Runtime for agent execution.

Its product value is not chat history, generic RAG, a host adapter, or an eval harness. Its product value is a durable execution intelligence loop that makes future agent behavior measurably better through continuity, scoped self-learning, controlled forgetting, and learning control.

This contract consolidates the current focused implementation with the v3 Persistent Cognitive Runtime direction and the earlier Action Intelligence / Dynamic Memory Evolution design notes.

## Product Thesis

Aionis is an Action Intelligence Runtime.

It should answer four execution questions for an agent:

1. What proven state should I continue from?
2. What prior action memory applies to this task?
3. What uncertainty, stale memory, or blocked authority should constrain me before acting?
4. What should be distilled, promoted, demoted, archived, or rehydrated after the action?

The focused Runtime therefore owns the execution-memory substrate and the learning-control loop around it. It does not own project-specific repair answers, host-specific adapters, broad UI surfaces, or cloud control planes.

## Canonical Runtime Loop

The formal product loop is:

```text
Recall -> Assess -> Retrieve -> Act -> Distill -> Evaluate -> Attribute -> Mutate -> Maintain -> Reuse
```

Each stage has a product obligation:

1. `Recall`: recover relevant continuity, evidence, workflows, patterns, policies, and rehydration anchors.
2. `Assess`: decide whether current memory is sufficient, uncertain, stale, contested, or blocked.
3. `Retrieve`: assemble an execution-ready action packet, not a generic context dump.
4. `Act`: let the host agent execute, while Aionis preserves boundary, authority, and evidence constraints.
5. `Distill`: convert raw execution into compact evidence, workflow candidates, pattern signals, and policy candidates.
6. `Evaluate`: grade outcomes by real evidence, verifier results, provider health, and runtime signals.
7. `Attribute`: connect success, failure, recovery cost, and counter-evidence to the responsible memory or policy.
8. `Mutate`: propose or apply scoped memory, workflow, policy, suppression, retirement, or forgetting changes.
9. `Maintain`: run immediate, daily, and long-horizon maintenance without damaging fresh continuity material.
10. `Reuse`: bias future execution through proven memory while keeping unproven candidates advisory.

Aionis source code changes are not part of this runtime loop. Source changes belong to system development mode only, and only for project-agnostic mechanism defects.

## Core Capabilities

The executable kernel boundary is `src/kernel/boundary.ts`.

The focused Runtime has exactly four primary capabilities:

1. `continuity`: persistent execution state, task start packets, handoff recovery, verified facts, and next action packets.
2. `learning`: evidence-gated workflow, pattern, tool, and policy learning.
3. `forgetting`: semantic forgetting, demotion, archive relocation, and differential rehydration.
4. `learning_control`: authority gates, promotion admissibility, suppression, retirement, reactivation, and policy mutation control.

These four capabilities are product capabilities. Real eval, verifier classifiers, edit-boundary experiments, and provider diagnostics can produce evidence or candidates, but they are not product authority by themselves.

## Runtime Layers

The focused architecture has three layers that must remain separate.

### Core Runtime

Core Runtime is the product.

It owns:

1. execution continuity
2. evidence grading
3. action retrieval
4. context packet assembly
5. memory evolution
6. workflow and pattern lifecycle
7. policy mutation and learning control
8. controlled forgetting and rehydration

It must not own:

1. external project verifier logic
2. project-specific repair answers
3. provider benchmarking as product behavior
4. eval-runner tool policy
5. testing-method preferences

### Real Eval Harness

Real Eval Harness proves or falsifies product behavior.

It owns:

1. frozen Runtime validation
2. isolated workspaces
3. real LLM provider calls
4. verifier execution
5. baseline-vs-Aionis effect comparison

It must not become Runtime policy. A passing or failing project run creates evidence, candidates, counter-evidence, reports, and maintenance signals. It does not directly create Core source rules.

### Experimental Policy

Experimental Policy contains scoped candidates:

1. verifier phase classifiers
2. edit-boundary experiments
3. tool recovery hints
4. semantic repair hypotheses
5. task-family workflow candidates

Default authority is `soft_guidance` or `candidate_workflow`. Promotion requires scoped real success plus regression or holdout evidence.

## Memory Evolution Contract

Aionis memory is not a flat store. It is a cognitive substrate with lifecycle.

The current focused levels are:

1. `L0 Raw Event`: direct execution event, tool result, verifier output, or runtime observation.
2. `L1 Distilled Step`: compact execution evidence, fact, step, failure signal, or continuity carrier.
3. `L2 Workflow`: reusable execution sequence with scope, conditions, evidence, and verifier history.
4. `L3 Pattern`: repeated workflow or tool behavior with trust, confidence, counter-evidence, and lifecycle.
5. `L4 Policy`: learning-controlled reusable guidance with authority state, mutation history, and invalidation conditions.

The v3 direction adds:

1. `L5 Runtime Trait`: long-horizon execution bias such as verification depth, risk bias, retry tolerance, or retrieval dependency.
2. `L6 Cognitive Identity`: aggregate execution identity formed by durable traits.

`L5` and `L6` are architecture direction, not current product authority. They must not be faked as stable behavior until the Runtime can prove them through repeated real runs and controlled maintenance.

## Anchor-Payload Contract

Aionis uses an Anchor-Payload model.

`Anchor` is compact, recallable, and hot-path friendly:

1. task signature
2. workflow signature
3. tool preference
4. evidence refs
5. promotion state
6. lifecycle state
7. rehydration pointers

`Payload` is detailed execution material:

1. trace fragments
2. raw events
3. verifier output
4. intermediate decisions
5. full workflow evidence
6. archived context

Forgetting must not mean blind deletion. It means controlled visibility change: retain, demote, archive, suppress, retire, or rehydrate on demand.

## Action Retrieval Contract

Action retrieval is different from generic semantic recall.

Generic recall asks: "What text is related?"

Action retrieval asks: "What should the agent do next, with what confidence, from what evidence, under what authority?"

The current implementation lives primarily in:

1. `src/memory/action-retrieval.ts`
2. `src/memory/recall-action-packet.ts`
3. `src/memory/experience-intelligence.ts`
4. `src/memory/tools-select.ts`
5. `src/memory/runtime-tool-hints.ts`

The action retrieval response must preserve:

1. selected tool
2. recommended path
3. evidence entries
4. uncertainty level
5. recommended actions such as widen recall, inspect context, or rehydrate payload
6. execution contract
7. authority visibility

If the Runtime is uncertain, it should expose uncertainty directly instead of pretending to know. Uncertainty is a first-class execution signal, not a failure.

## Agent Autonomy Boundary Contract

Aionis is a cognitive runtime, not a semantic repair engine and not an agent replacement.

The Runtime owns durable structure:

1. execution continuity
2. memory evolution
3. controlled forgetting
4. dynamic governance
5. consequence persistence
6. policy and trait adaptation
7. evidence authority

The LLM/Agent owns task intelligence:

1. semantic diagnosis
2. hypothesis generation
3. code repair design
4. tool selection
5. exploration strategy
6. final implementation judgment

Aionis may expose evidence, boundaries, risk, entropy state, remembered consequences, and learning/forgetting decisions. It must not turn one project task into source code, force a repository-specific repair path, or execute semantic actions on behalf of the agent.

When Runtime guidance is uncertain, it should present uncertainty and candidate evidence instead of hardening into a rule. When repeated governance blocks do not improve outcomes, dynamic entropy should increase exploration rather than add another fixed constraint.

Evaluation harnesses may measure protocol failures, stale anchors, verifier phases, edit locality, and candidate stagnation. Those measurements are not product capabilities by themselves. A measurement can influence Aionis only after it becomes a general mechanism backed by repeated real-run evidence.

## Persistent Cognitive Structure Contract

Aionis v3 defines a Persistent Cognitive Structure: future behavior should be shaped by historical execution.

In focused Runtime, this currently means a structured snapshot of:

1. execution state
2. evidence graph
3. workflow memory
4. policy memory
5. forgetting state
6. authority state
7. policy mutations

The current implementation lives in `src/kernel/cognitive-structure.ts`.

Persistent Cognitive Structure must obey these rules:

1. It summarizes runtime state; it does not write project-specific source rules.
2. It may expose policy mutations; it does not bypass learning control.
3. It must carry `source_code_change_allowed: false`.
4. It must preserve counter-evidence and provider/protocol failures instead of hiding them.
5. It must remain compact enough to guide the next execution step.

## Self-Modifying Policy Loop Contract

Aionis may evolve policy, but only through evidence-gated policy mutation.

The formal loop is:

```text
Execution -> Outcome -> Attribution -> Policy Delta -> Runtime Bias -> Future Execution
```

Policy mutation must carry:

1. target scope
2. target memory kind
3. proposed effect
4. evidence refs
5. promotion evidence
6. holdout or regression evidence when broad authority is requested
7. counter-evidence refs
8. confidence
9. escape conditions
10. rollback plan
11. forgetting plan
12. learning-control adjudication

The current implementation lives primarily in:

1. `src/kernel/policy-mutation-loop.ts`
2. `src/kernel/learning-kernel.ts`
3. `src/memory/policy-memory.ts`
4. `src/memory/learning-loop.ts`
5. `src/memory/runtime-maintenance.ts`

Provider failures, protocol failures, and failed verifier traces can inform recovery or quarantine. They cannot create broad authority.

The executable promotion evidence ledger is `promotion_evidence_ledger_v1`, implemented in `src/memory/promotion-evidence-ledger.ts`.

It records why a memory surface was promoted, blocked, contested, or kept candidate-only:

1. transition: `L0_to_L1`, `L1_to_L2`, `L2_to_L3`, or `L3_to_L4`
2. target kind: distilled step, workflow, pattern, or policy
3. source and target layers
4. observation counts and required counts
5. authority-gate result
6. learning-control result
7. verifier status
8. promotion and counter-evidence refs
9. source node, run, and commit refs
10. final verdict: `candidate_only`, `promotion_admitted`, `promotion_blocked`, or `contested`
11. `source_code_change_allowed: false`

V1 is attached to the current executable promotion surfaces:

1. workflow stable promotion from `L1` distilled execution evidence to `L2` workflow memory
2. workflow auto-promotion through the write projection path
3. tool pattern anchoring from `L2` workflow/tool behavior to `L3` pattern memory
4. policy materialization and policy lifecycle updates from `L3` pattern evidence to `L4` policy memory

`L0_to_L1` is a schema-level transition reserved for raw-event distillation audit. It is not yet a standalone broad promotion surface.

This ledger is an audit surface, not a promotion engine. It records the evidence chain produced by existing Runtime gates; it must not grant authority by itself, bypass learning control, or turn any project run into source-code policy.

The executable promotion quality summary is `promotion_quality_summary_v1`, implemented in `src/memory/promotion-quality-summary.ts`.

It aggregates persisted promotion ledgers across the current memory scan window:

1. verdict counts for candidate-only, admitted, blocked, and contested ledgers
2. transition counts across `L1_to_L2`, `L2_to_L3`, and `L3_to_L4`
3. target-kind counts for workflow, pattern, and policy surfaces
4. authority-gate, learning-control, verifier, and contract-trust counts
5. promotion-evidence and counter-evidence ref counts
6. admission and contested rates
7. invalidation pressure: `none`, `low`, `medium`, or `high`
8. recommended learning posture: `insufficient_evidence`, `candidate_only`, `promotion_ready`, `constrain`, or `invalidate`

The summary is exposed through runtime maintenance snapshots and can be carried into `action_intelligence_runtime_contract_v1`. When it reports `constrain` or `invalidate`, action intelligence treats it as a mutation/maintenance review signal and recommends long-horizon maintenance if no fresh post-action material is present.

This summary is still not authority. It measures promotion quality and invalidation pressure; it does not directly promote memory, mutate policy, or write source code.

## Consequence and Attribution Contract

Execution consequences must be persistent.

Successful outcomes may create:

1. verified facts
2. workflow candidates
3. promotion evidence
4. pattern reinforcement
5. policy refresh signals

Failed outcomes may create:

1. failed evidence
2. counter-evidence
3. suppression candidates
4. forgetting signals
5. provider/protocol quarantine
6. narrower next-action contracts

Failure is not a reason to hard-code a new rule. It is evidence that must be scoped, classified, attributed, and either retained as local memory or promoted only after broader proof.

## Controlled Forgetting Contract

Forgetting is part of intelligence, not cleanup.

The Runtime must be able to:

1. retain useful active memory
2. demote stale or weak memory
3. archive retired or low-retention memory
4. suppress contested guidance
5. rehydrate archived payloads on demand
6. preserve fresh continuity material after a run
7. expose forgetting diagnostics

The current implementation lives primarily in:

1. `src/kernel/forgetting-kernel.ts`
2. `src/memory/runtime-maintenance.ts`
3. `src/memory/learning-loop.ts`
4. `src/memory/archive-relocation.ts`
5. `src/memory/rehydrate-anchor.ts`
6. `src/memory/differential-rehydration.ts`

Maintenance profiles have different horizons:

1. `immediate`: protect fresh low-level continuity material after a task.
2. `daily`: demote stale low-level memory after a shorter grace period.
3. `long_horizon`: focus on policy, forgetting, archive, and longer-term structure.

## LLM Candidate Contract

LLMs can expand Aionis's generalization radius, but they are candidate producers.

LLM-produced classifications may propose:

1. semantic failure phase
2. likely contract kind
3. target files inside the active boundary
4. candidate workflow
5. candidate policy
6. candidate forgetting signal

They must not:

1. create global authority
2. override evidence grading
3. bypass edit boundary or learning control
4. turn a single project quirk into Core source code
5. hide provider/protocol failure

Runtime adjudication decides whether the candidate is retained, suppressed, promoted, demoted, archived, or forgotten.

## Runtime Signals

Aionis should track signals that can shape future behavior:

1. verifier result
2. recovery cost
3. retry count
4. repeated discovery
5. repeated failed action
6. provider/protocol failure
7. edit-boundary rejection
8. tool selection success or failure
9. workflow reuse success or failure
10. maintenance mutation effect
11. token/context pressure
12. rehydration usefulness

Signals become product value only when they change future behavior through learning-controlled memory and policy surfaces.

The first executable ledger is `runtime_signal_ledger_v1`, implemented in `src/memory/runtime-signal-ledger.ts` and persisted through the memory write normalization path. It records node-scoped execution consequence signals such as verifier result, recovery cost, retry count, provider/protocol failure, edit-boundary rejection, tool/workflow outcome, maintenance effect, token/context pressure, and rehydration usefulness.

This ledger is evidence, not authority. Positive signals can become promotion evidence candidates. Negative signals can become counter-evidence, quarantine, or forgetting signals. None of them may directly create Core source rules.

The first executable scan-window trend summary is `runtime_signal_trend_summary_v1`, implemented in `src/memory/runtime-signal-trends.ts` and exposed through runtime maintenance snapshots. It aggregates persisted ledgers across visible local memory nodes into signal counts, polarity counts, authority-effect counts, capability counts, numeric trends, dominant positive or negative signals, findings, and a recommended Runtime posture.

This trend summary is still evidence, not authority. Its recommendation now feeds Dynamic Entropy and the promotion-control projection when carried into the next action-intelligence request, but it does not create promotion authority or source-code rules by itself.

The first executable effect summary is `runtime_effect_summary_v1`, implemented in `src/memory/runtime-effect-summary.ts`.

It aggregates measurable effect evidence from persisted Runtime data:

1. token/context budget observations, average estimated tokens, and context reduction levers
2. repeated discovery and repeated failed action pressure
3. verifier success/failure, retry count, recovery cost, and provider quarantine
4. workflow reuse and tool-selection outcomes
5. promotion admission, contested rate, invalidation pressure, and learning posture
6. forgetting signals, maintenance demotions/archives, and rehydration usefulness
7. a measurable effect posture: `insufficient_evidence`, `positive`, `mixed`, `constrained`, or `blocked`

This summary is exposed through runtime maintenance snapshots and can be carried into `action_intelligence_runtime_contract_v1`. If it reports `constrained` or `blocked`, action intelligence treats it as maintenance-review evidence and recommends long-horizon maintenance when no fresh post-action material is present.

It explicitly carries `baseline_comparison_required: true`. That means it prepares product metrics for real evaluation, but it does not by itself prove Aionis improved over a baseline. Product effectiveness claims still require frozen Runtime, real LLM calls, real workspaces, real verifiers, and baseline-vs-Aionis comparison.

The real eval harness now rolls these snapshot summaries into `summary.runtime_effect_rollup`. That rollup is a reporting bridge from Runtime evidence to suite-level product measurement: it combines baseline-vs-Aionis deltas with token/context, continuity, verifier, reuse, promotion-quality, and forgetting signals. It remains measurement evidence only and carries no authority to create Core rules.

## Dynamic Entropy Control

Aionis should not be permanently strict or permanently permissive.

The focused Runtime uses Dynamic Entropy Control as a regulation mechanism inside the Persistent Cognitive Runtime. Its contract is `runtime_entropy_profile_v1`.

The profile decides how much exploration and control the current task should receive:

1. `entropy_level`: `low`, `medium`, `high`, or `lockdown`.
2. `exploration_budget`: how much candidate generation and wider recall should be allowed.
3. `control_strength`: how strongly verification, authority, and learning-control gates should constrain execution.
4. `plasticity_level`: how open the Runtime should be to new candidate memory.
5. `recall_breadth`: `narrow`, `balanced`, or `wide`.
6. `verification_depth`: `light`, `normal`, or `strict`.
7. `promotion_threshold`: `low`, `normal`, `high`, or `blocked`.
8. `mutation_authority`: `none`, `candidate_only`, `scoped`, or `stable_allowed`.
9. `runtime_signal_trend_posture`: `none`, `reuse`, `explore`, `constrain`, or `quarantine`.

Dynamic entropy is not a project repair rule. It changes general Runtime posture only.

Examples:

1. Stable workflow, trusted pattern, low uncertainty, and positive verifier signal can reduce entropy and favor reuse.
2. Unknown task, missing history, repeated discovery, or high uncertainty can raise entropy and widen recall while keeping mutations candidate-only.
3. Provider/protocol quarantine, blocked authority, or required operator review forces lockdown and blocks promotion.
4. Token/context pressure can narrow recall or increase forgetting pressure without deleting useful anchors.
5. Cross-run trend counter-evidence can raise promotion threshold and reduce mutation authority to candidate-only even when the current request has a stable workflow.
6. Repeated verifier/candidate failures can raise bounded divergence instead of adding another hard repair constraint.
7. A bounded counterfactual probe may request one alternative observation before another same-attractor loop, but it should not become a prewritten repair script.
8. Candidate evidence can carry coupled files, contracts, and consequences across phase shifts, but the LLM/Agent still owns how to use that evidence.
9. Fresh diagnostics can lower entropy and narrow attention. Repeated stagnation can raise entropy and widen exploration.

The implementation lives in `src/memory/runtime-entropy-profile.ts` and is exposed through `action_intelligence_runtime_contract_v1`, planning summary, assembly summary, and context operator projection.

The executable control projection is `runtime_entropy_controls_v1`, implemented in `src/memory/runtime-entropy-controls.ts`.

It translates entropy posture into concrete Runtime controls:

1. `recall`: recommended `limit`, `ranked_limit`, `max_nodes`, and `max_edges` for the next recall phase.
2. `verifier`: verifier scheduling posture and whether runtime verifier evidence is required.
3. `promotion`: minimum observations, mutation authority, and whether stable promotion is allowed.
4. `maintenance`: immediate, daily, or long-horizon maintenance profile recommendation.

This control projection must not silently override explicit agent or host choices. Its first role is to make Runtime posture inspectable through action intelligence, planning, assembly, and context projection. Automatic application to route defaults must preserve explicit caller knobs and remain auditable.

The route-level applications are `runtime_entropy_recall_defaults_v1`, `runtime_entropy_verifier_defaults_v1`, and `runtime_entropy_maintenance_defaults_v1`, implemented in `src/memory/runtime-entropy-route-defaults.ts`.

Entropy route defaults apply only to the next request that carries `runtime_entropy_controls_v1`, which keeps the loop causal:

1. request N produces entropy controls through action intelligence
2. host or operator may carry those controls into request N+1
3. request N+1 applies recall defaults only if the caller did not set explicit recall knobs
4. request N+1 applies runtime verifier defaults only if the caller did not set explicit `runtime_verification`
5. request N+1 applies runtime maintenance profile defaults only if the caller did not set explicit `maintenance_profile`
6. observability or route response records whether the defaults were applied, skipped, or rejected as invalid

Runtime signal trend feedback also stays causal:

1. maintenance produces `runtime_signal_trend_summary_v1`
2. host or operator may carry that summary into request N+1 context
3. action intelligence records the carried trend summary
4. Dynamic Entropy uses it to adjust exploration, control, verification depth, promotion threshold, and mutation authority
5. stable promotion is still impossible unless ordinary evidence and learning-control gates separately admit it

Verifier scheduling maps entropy controls onto the existing runtime verifier contract instead of inventing new verifier modes:

1. `light` or `skip` can default to verifier `off` when runtime verifier evidence is not required.
2. `normal`, `strict`, and `blocked` default to verifier `plan`, never automatic execution.
3. Explicit caller `runtime_verification` always wins, including `execute`.
4. Execution remains controlled by the existing runtime verifier execution boundary and environment checks.

Maintenance selection maps entropy controls onto the existing runtime maintenance profile contract:

1. `recommended_profile` can default `/v1/memory/runtime-maintenance/run`.
2. Explicit caller `maintenance_profile` always wins.
3. Profile-specific endpoints such as `/immediate`, `/daily`, and `/long-horizon` remain explicit route choices and are not overridden by entropy controls.
4. `run_after_task` is surfaced as scheduler guidance; it does not silently cancel an explicitly requested maintenance run.

This means Dynamic Entropy changes Runtime posture without hiding control from the operator and without turning one project run into Core source behavior.

The real-execution harness also exposes `aionis_cognitive_entropy_engine_v1` as an experimental operator guidance surface. It is deliberately generic:

1. It detects attractor pressure from repeated failed real runs, candidate pressure, verifier stagnation, payload exhaustion, and policy-block pressure.
2. It can require `cognitive_entropy_counterfactual_probe_v1`: a bounded read/search-only probe on allowed files outside the current attractor when possible, capped by the attempt-level divergence budget.
3. It cannot write during the probe, cannot promote memory, and cannot override `edit_boundary_v1`.
4. After the probe, execution must return to scoped repair and the required real verifier.
5. A passing verifier plus holdout/regression evidence is still required before any workflow or policy promotion.

This is the focused Runtime balance point: governance remains the immune system, while counterfactual probing preserves cognitive plasticity when the Runtime is becoming obedient but not effective.

## Current Implementation Map

| Contract area | Current implementation |
| --- | --- |
| Kernel boundary | `src/kernel/boundary.ts` |
| Continuity | `src/kernel/execution-continuity-kernel.ts`, `src/execution/*`, `src/memory/handoff.ts` |
| Action retrieval | `src/memory/action-retrieval.ts`, `src/memory/recall-action-packet.ts`, `src/memory/experience-intelligence.ts` |
| Recall and context | `src/memory/recall.ts`, `src/memory/context-orchestrator.ts`, `src/routes/memory-context-runtime.ts` |
| Distillation | `src/memory/write-distillation.ts`, `src/memory/write-execution-native.ts`, `src/memory/workflow-write-projection.ts` |
| Runtime signal ledger and trends | `src/memory/runtime-signal-ledger.ts`, `src/memory/runtime-signal-trends.ts`, `src/memory/write-execution-native.ts` |
| Runtime effect summary | `src/memory/runtime-effect-summary.ts`, `src/memory/runtime-maintenance.ts`, `src/memory/action-intelligence-runtime-contract.ts` |
| Dynamic entropy control | `src/memory/runtime-entropy-profile.ts`, `src/memory/runtime-entropy-controls.ts`, `src/memory/runtime-entropy-route-defaults.ts` |
| Promotion evidence ledger | `src/memory/promotion-evidence-ledger.ts`, `src/memory/learning-loop.ts`, `src/memory/workflow-write-projection.ts`, `src/memory/tools-pattern-anchor.ts`, `src/memory/policy-memory.ts` |
| Promotion quality summary | `src/memory/promotion-quality-summary.ts`, `src/memory/runtime-maintenance.ts`, `src/memory/action-intelligence-runtime-contract.ts` |
| Workflow and replay learning | `src/memory/replay-learning.ts`, `src/memory/replay-run-*`, `src/memory/workflow-candidate-aggregation.ts` |
| Tool learning | `src/memory/tools-select.ts`, `src/memory/tools-feedback.ts`, `src/memory/tools-pattern-anchor.ts` |
| Policy memory | `src/memory/policy-memory.ts`, `src/memory/policy-materialization-surface.ts` |
| Policy mutation | `src/kernel/policy-mutation-loop.ts`, `src/kernel/learning-kernel.ts` |
| Cognitive structure | `src/kernel/cognitive-structure.ts` |
| Forgetting and rehydration | `src/kernel/forgetting-kernel.ts`, `src/memory/runtime-maintenance.ts`, `src/memory/rehydrate-anchor.ts` |
| Learning control | `src/memory/learning-control-*`, `src/memory/authority-*`, `src/kernel/learning-decision-kernel.ts` |
| Real eval proof | `scripts/real-llm-eval/*`, `docs/REAL_LLM_EVAL.md` |

## Implementation Maturity

Implemented or substantially implemented:

1. focused kernel boundary
2. continuity packets and handoff recovery
3. action retrieval packet, uncertainty summary, `action_intelligence_runtime_contract_v1`, and planning/assembly pre-action gate enforcement
4. node-scoped `runtime_signal_ledger_v1` persisted through memory writes
5. scan-window `runtime_signal_trend_summary_v1` aggregation over persisted signal ledgers
6. `runtime_signal_trend_summary_v1` feedback into Dynamic Entropy and promotion controls without automatic authority
7. `runtime_entropy_profile_v1` dynamic exploration/control posture exposed through action intelligence and planning
8. `runtime_entropy_controls_v1` concrete recall, verifier, promotion, and maintenance control projection
9. `runtime_entropy_recall_defaults_v1` guarded route-level recall default application for carried entropy controls
10. `runtime_entropy_verifier_defaults_v1` guarded route-level verifier scheduling defaults for carried entropy controls
11. `runtime_entropy_maintenance_defaults_v1` guarded route-level maintenance profile defaults for carried entropy controls
12. L0-L4 memory surfaces
13. workflow candidates and replay learning surfaces
14. policy memory and policy mutation schemas
15. `promotion_evidence_ledger_v1` on workflow `L1_to_L2`, pattern `L2_to_L3`, and policy `L3_to_L4` promotion surfaces
16. scan-window `promotion_quality_summary_v1` aggregation over persisted promotion ledgers, exposed through maintenance and action intelligence
17. scan-window `runtime_effect_summary_v1` over persisted runtime evidence, exposed through maintenance and action intelligence
18. tool payload and tool-executability exhaustion stop signals in the real-eval execution harness
19. semantic forgetting, archive relocation, differential rehydration
20. runtime maintenance profiles, diagnostics, signal trend snapshots, promotion quality snapshots, and effect snapshots
21. learning-control principles and authority gates
22. real LLM eval harness boundary

Partially implemented:

1. consequence attribution across full task runs
2. cross-project promotion quality baselining across frozen real runs and holdout tasks
3. candidate-to-policy competition and invalidation workflows
4. cold payload storage as a productized local store
5. baseline-vs-Aionis runtime effect aggregation across frozen real project suites

Not productized yet:

1. L5 Runtime Traits
2. L6 Cognitive Identity
3. counterfactual replay
4. autonomous tool discovery
5. broad hosted/cloud control plane

## Non-Negotiable Invariants

1. Aionis Core source must not encode a target project's concrete answer.
2. Project execution experience is runtime data, not source code.
3. Failed runs create evidence, candidates, counter-evidence, or forgetting signals.
4. Successful real runs can support promotion, but only with scope and escape conditions.
5. Provider/protocol failures are quarantined from learning promotion.
6. Unverified authority must remain advisory or blocked.
7. Controlled forgetting must preserve rehydration paths for useful cold memory.
8. Real effectiveness must be proven with frozen Runtime, real LLM calls, real workspaces, and real verifiers.

## Next Engineering Contract

The next focused implementation should deepen the executable Runtime contracts in this order:

1. Productize local cold payload storage for archived payloads and differential rehydration.
2. Run unrelated frozen real suites through `summary.runtime_effect_rollup` and the effect gate to measure promotion quality movement, invalidation pressure, token/context movement, repeated discovery, workflow reuse, and verifier outcome movement.
3. Add holdout/regression reporting across unrelated real projects before broadening any candidate workflow or policy scope.

This is the narrow path: make Aionis a useful Persistent Cognitive Runtime before adding any broader product surface.
