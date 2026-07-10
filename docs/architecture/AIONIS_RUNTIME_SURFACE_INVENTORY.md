# Aionis Runtime HTTP Surface Inventory

Updated: 2026-07-10  
Scope: the 72 routes in `LITE_ROUTE_CAPABILITY_MATRIX`

## Decision

The Runtime currently registers 72 inventoried HTTP routes, but only 19 have an
audited product, stable-support, or operator contract. The remaining 53 are
implementation surfaces: 10 guidance, 38 evidence, and 5 learning-control
routes. Their capabilities remain in Runtime, but HTTP is not their intended
long-term composition boundary.

This inventory is a deletion gate, not a deletion commit. Task 11 may remove an
internal HTTP adapter only after its named typed replacement exists and its real
consumer has migrated. In particular, AionisManifest currently calls five
internal routes directly, and Runtime evals call three; those eight routes are
marked `temporary`, not immediately removable.

## Audit method

The audit used read-only searches under `/Volumes/ziel/new.aionis` over Runtime,
SDK, MCP, AIFS, CLI/Create, Claude Code, Manifest, Substrate, product docs, and
eval sources. Generated `dist`, `node_modules`, `runs`, and report artifacts were
excluded. SDK-indirect means the package calls a typed SDK method whose current
transport is the listed route. `none` means no production caller was found in
that column; tests are not treated as public consumers. The Runtime column
names the route registration owner. Where no additional caller is named, the
audit found no in-process HTTP caller outside that registration module; facade
composition through typed functions is recorded in the replacement column.

Exposure meanings:

- `product_entry`: the six focused product verbs.
- `product_support`: a stable lower-level contract with a real external caller.
- `operator_support`: an explicitly documented review, audit, or CLI contract.
- `internal_guidance`: compiles or selects context behind `guide`.
- `internal_evidence`: records, retrieves, or reviews evidence behind a facade.
- `internal_control`: mutates lifecycle or learning-control state behind a facade.

`public_http` is `required`, `temporary`, or `remove`. A `temporary` route is
still required by a current repository caller, but that dependency is assigned
to Task 11 instead of promoted into the product API.

## Complete route inventory

| Method | Path | Exposure | Runtime owner/caller | SDK caller | MCP caller | AIFS caller | CLI/Create caller | Claude Code caller | Manifest caller | Substrate caller | Docs/eval evidence | Public HTTP | Typed replacement | Deletion phase |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST` | `/v1/observe` | `product_entry` | `routes/product-facade.ts` | `observe, remember, execution.*` | `SDK indirect` | `none` | `CLI skill materialize commit; Create prints flow only` | `SDK indirect` | `none` | `Claude flow indirect` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/guide` | `product_entry` | `routes/product-facade.ts` | `guide, guideAgentContext, execution.*` | `SDK indirect` | `SDK indirect` | `Create prints flow only` | `SDK indirect` | `none` | `Claude flow indirect` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/forget` | `product_entry` | `routes/product-facade.ts` | `forget` | `none` | `none` | `CLI forget` | `none` | `none` | `none` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/feedback` | `product_entry` | `routes/product-facade.ts` | `feedback, execution.feedbackFromOutcome` | `SDK indirect` | `none` | `Create prints flow only` | `none` | `none` | `real-flow script` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/rehydrate` | `product_entry` | `routes/product-facade.ts` | `rehydrate` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:public` | `required` | `none` | `retain` |
| `POST` | `/v1/measure` | `product_entry` | `routes/product-facade.ts` | `measure, execution.measureRun` | `SDK indirect` | `none` | `Create prints flow only` | `none` | `none` | `none` | `docs:public+eval` | `required` | `none` | `retain` |
| `GET` | `/v1/skills/candidates` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `CLI skills list` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/skills/candidates` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/skills/candidates/:id/promote` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `CLI skills promote` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/skills/candidates/:id/reject` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `CLI skills reject` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/skills/candidates/:id/materialize` | `operator_support` | `routes/product-facade.ts` | `materializeSkillCandidate` | `none` | `none` | `CLI skills materialize` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/operator/snapshot` | `operator_support` | `routes/operator-snapshot.ts` | `snapshot, operatorSnapshot` | `SDK indirect` | `SDK indirect` | `CLI snapshot` | `none` | `none` | `none` | `docs:operator+eval` | `required` | `none` | `retain` |
| `GET` | `/v1/operator/authority-effect-audit` | `operator_support` | `routes/operator-snapshot.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/debug/memory-decision-trace` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/audit/memory-decision-report` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `GET` | `/v1/runtime/boundary-inventory` | `operator_support` | `server/http-server.ts` | `none` | `none` | `none` | `CLI boundary and doctor` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/write` | `internal_evidence` | `routes/memory-write.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryWriteRouteService.commit` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/handoff/store` | `product_support` | `routes/handoff.ts` | `none` | `none` | `none` | `none` | `none` | `publish.ts` | `none` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/handoff/recover` | `product_support` | `routes/handoff.ts` | `none` | `none` | `none` | `none` | `none` | `recover.ts` | `none` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/archive/rehydrate` | `internal_control` | `routes/memory-lifecycle-lite.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryLifecycleService.rehydrateArchive` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/memory/nodes/activate` | `internal_control` | `routes/memory-lifecycle-lite.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryLifecycleService.activateNodes` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/memory/recall` | `internal_guidance` | `routes/memory-recall.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture+eval` | `temporary` | `MemoryRecallService.recall` | `Task 11 after eval migration to guide` |
| `POST` | `/v1/memory/recall_text` | `internal_guidance` | `routes/memory-context-runtime.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture+eval` | `temporary` | `MemoryRecallService.recallText` | `Task 11 after eval migration to guide` |
| `POST` | `/v1/memory/planning/context` | `internal_guidance` | `routes/memory-context-runtime.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture+eval` | `temporary` | `MemoryPlanningContextRouteService.assemble` | `Task 11 after eval migration to guide` |
| `POST` | `/v1/memory/context/assemble` | `internal_guidance` | `routes/memory-context-runtime.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture+eval` | `temporary` | `MemoryContextAssemblyService.assemble` | `Task 11 after Manifest migration` |
| `POST` | `/v1/execution/context/assemble` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `buildExecutionEvidenceContextLite` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/memory/trajectory/compile` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `TrajectoryCompilationService.compile` | `Task 11 remove` |
| `POST` | `/v1/memory/delegation/records` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `DelegationEvidenceService.record` | `Task 11 remove` |
| `POST` | `/v1/memory/delegation/records/find` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `DelegationEvidenceService.find` | `Task 11 remove` |
| `POST` | `/v1/memory/delegation/records/aggregate` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `DelegationEvidenceService.aggregate` | `Task 11 remove` |
| `POST` | `/v1/memory/find` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryAccessService.find` | `Task 11 remove` |
| `POST` | `/v1/memory/continuity/review-pack` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryReviewService.continuityPack` | `Task 11 remove` |
| `POST` | `/v1/memory/agent/inspect` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `AgentMemoryService.inspect` | `Task 11 remove` |
| `POST` | `/v1/memory/agent/review-pack` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `AgentMemoryService.reviewPack` | `Task 11 remove` |
| `POST` | `/v1/memory/agent/resume-pack` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `AgentMemoryService.resumePack` | `Task 11 remove` |
| `POST` | `/v1/memory/agent/handoff-pack` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `AgentMemoryService.handoffPack` | `Task 11 remove` |
| `POST` | `/v1/memory/execution/introspect` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ExecutionIntrospectionService.inspect` | `Task 11 remove` |
| `POST` | `/v1/memory/evolution/review-pack` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `EvolutionReviewService.reviewPack` | `Task 11 remove` |
| `POST` | `/v1/memory/action/retrieval` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ActionRetrievalService.retrieve` | `Task 11 remove` |
| `POST` | `/v1/memory/experience/intelligence` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ExperienceIntelligenceService.assemble` | `Task 11 remove` |
| `POST` | `/v1/memory/resolve` | `product_support` | `routes/memory-access.ts` | `resolveMemory, guideAgentContext` | `SDK indirect through guide` | `SDK indirect through guide` | `none` | `SDK indirect through guide` | `none` | `none` | `docs:public` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/anchors/rehydrate_payload` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryAccessService.rehydrateAnchorPayload` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/memory/feedback` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `MemoryFeedbackService.record` | `Task 11 remove` |
| `POST` | `/v1/memory/rules/state` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `RuleEvaluationService.state` | `Task 11 remove` |
| `POST` | `/v1/memory/rules/evaluate` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `RuleEvaluationService.evaluate` | `Task 11 remove` |
| `POST` | `/v1/memory/tools/select` | `internal_guidance` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `temporary` | `ToolLearningService.select` | `Task 11 after Manifest migration` |
| `POST` | `/v1/memory/tools/decision` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `temporary` | `ToolLearningService.recordDecision` | `Task 11 after Manifest migration` |
| `POST` | `/v1/memory/tools/run` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `temporary` | `ToolLearningService.recordRun` | `Task 11 after Manifest migration` |
| `POST` | `/v1/memory/tools/runs/list` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ToolLearningService.listRuns` | `Task 11 remove` |
| `POST` | `/v1/memory/tools/feedback` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `temporary` | `ToolLearningService.recordFeedback` | `Task 11 after Manifest migration` |
| `POST` | `/v1/memory/learning-loop/run` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `LearningLoopService.run` | `Task 11 remove` |
| `POST` | `/v1/memory/runtime-maintenance/run` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `RuntimeMaintenanceService.run` | `Task 11 remove` |
| `POST` | `/v1/memory/runtime-maintenance/immediate` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `RuntimeMaintenanceService.runImmediate` | `Task 11 remove` |
| `POST` | `/v1/memory/runtime-maintenance/daily` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `RuntimeMaintenanceService.runDaily` | `Task 11 remove` |
| `POST` | `/v1/memory/runtime-maintenance/long-horizon` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `RuntimeMaintenanceService.runLongHorizon` | `Task 11 remove` |
| `POST` | `/v1/memory/policies/learning-control/apply` | `internal_control` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `LearningControlPolicyService.apply` | `Task 11 remove` |
| `POST` | `/v1/memory/patterns/suppress` | `internal_control` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `PatternLifecycleService.suppress` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/memory/patterns/unsuppress` | `internal_control` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `PatternLifecycleService.unsuppress` | `Task 11 remove after Task 10 facade extraction` |
| `POST` | `/v1/memory/tools/rehydrate_payload` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ToolLearningService.rehydratePayload` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/run/start` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayEvidenceService.startRun` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/step/before` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayEvidenceService.recordBeforeStep` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/step/after` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayEvidenceService.recordAfterStep` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/run/end` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayEvidenceService.endRun` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/runs/get` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayEvidenceService.getRun` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/compile_from_run` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.compileFromRun` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/get` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.get` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/candidate` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.candidate` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/promote` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.promote` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/repair` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.recordRepair` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/repair/review` | `internal_evidence` | `routes/memory-replay-learning-control.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.reviewRepair` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/run` | `internal_evidence` | `routes/memory-replay-learning-control.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.run` | `Task 11 remove` |
| `POST` | `/v1/memory/replay/playbooks/dispatch` | `internal_evidence` | `routes/memory-replay-learning-control.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `remove` | `ReplayPlaybookService.dispatch` | `Task 11 remove` |

## Consequences for the simplification plan

- Keep the 19 required routes behaviorally stable.
- Do not count direct Manifest use as evidence that tool-learning internals are a
  public product API. Migrate Manifest first, then remove those HTTP adapters.
- Evals must validate product behavior through `observe`, `guide`, `feedback`,
  `rehydrate`, `forget`, and `measure`, or through typed in-process services when
  they explicitly test an internal mechanism.
- Task 10 must leave product facade composition on typed services so Task 11 can
  delete adapters without deleting continuity, evidence-gated learning,
  controlled forgetting, negative-transfer blocking, or context reduction.
