# Aionis Runtime HTTP Surface Inventory

Updated: 2026-07-11
Scope: 19 registered routes plus 53 removal records

## Decision

The Runtime now registers 19 inventoried HTTP routes: 6 product entries,
3 stable product-support contracts, and 10 operator-support contracts. Task 11
removed 45 implementation-only HTTP adapters, and the temporary-transport
phase removed the final 8 internal routes after migrating Manifest and Runtime
eval consumers. Their capabilities remain behind product contracts, typed
services, and domain functions.

This inventory remains the deletion gate and records completed removals.
AionisManifest now uses `/v1/guide` and exposure-verified `/v1/feedback` for
tool selection and learning. Runtime evals use product contracts or typed
in-process services. No route remains classified as `temporary`.

## Audit method

The audit used read-only searches under `/Volumes/ziel/new.aionis` over Runtime,
SDK, MCP, AIFS, CLI/Create, Claude Code, Manifest, Substrate, product docs, and
eval sources. Generated `dist`, `node_modules`, `runs`, and report artifacts were
excluded. SDK-indirect means the package calls a typed SDK method whose current
transport is the listed route. `none` means no production caller was found in
that column; tests are not treated as public consumers. The Runtime column
names the current route registration owner, or the former owner for a
`removed` record. Where no additional caller is named, the
audit found no in-process HTTP caller outside that registration module; facade
composition through typed functions is recorded in the replacement column.

Exposure meanings:

- `product_entry`: the six focused product verbs.
- `product_support`: a stable lower-level contract with a real external caller.
- `operator_support`: an explicitly documented review, audit, or CLI contract.
- `internal_guidance`: compiles or selects context behind `guide`.
- `internal_evidence`: records, retrieves, or reviews evidence behind a facade.
- `internal_control`: mutates lifecycle or learning-control state behind a facade.

`public_http` is `required`, `temporary`, or `removed`. There are currently no
`temporary` rows; the value remains part of the inventory vocabulary for future
migration gates and must not be treated as a public-product classification.

## Complete route inventory

| Method | Path | Exposure | Runtime owner/caller | SDK caller | MCP caller | AIFS caller | CLI/Create caller | Claude Code caller | Manifest caller | Substrate caller | Docs/eval evidence | Public HTTP | Typed replacement | Deletion phase |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST` | `/v1/observe` | `product_entry` | `routes/product-facade.ts` | `observe, remember, execution.*` | `SDK indirect` | `none` | `CLI skill materialize commit; Create prints flow only` | `SDK indirect` | `none` | `Claude flow indirect` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/guide` | `product_entry` | `routes/product-facade.ts` | `guide, guideAgentContext, execution.*` | `SDK indirect` | `SDK indirect` | `Create prints flow only` | `SDK indirect` | `none` | `Claude flow indirect` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/govern` | `product_entry` | `routes/product-facade.ts` | `governMemory, governMem0SearchResults` | `SDK indirect` | `none` | `none` | `none` | `none` | `external admission parity` | `docs:public+eval` | `required` | `none` | `retain` |
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
| `GET` | `/v1/operator/workspaces` | `operator_support` | `routes/operator-snapshot.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `none` | `Focused route audit` |
| `GET` | `/v1/operator/runs` | `operator_support` | `routes/operator-snapshot.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `none` | `Focused route audit` |
| `GET` | `/v1/operator/runs/:run_id` | `operator_support` | `routes/operator-snapshot.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `none` | `Focused route audit` |
| `GET` | `/v1/operator/memories/:memory_id` | `operator_support` | `routes/operator-snapshot.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `none` | `Focused route audit` |
| `GET` | `/v1/operator/authority-effect-audit` | `operator_support` | `routes/operator-snapshot.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/debug/memory-decision-trace` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/audit/memory-decision-report` | `operator_support` | `routes/product-facade.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/audit/flight-recorder` | `operator_support` | `routes/product-facade.ts` | `flightRecorder` | `none` | `none` | `CLI audit flight-recorder` | `none` | `none` | `none` | `docs:operator+eval` | `required` | `none` | `retain` |
| `GET` | `/v1/runtime/boundary-inventory` | `operator_support` | `server/http-server.ts` | `none` | `none` | `none` | `CLI boundary and doctor` | `none` | `none` | `none` | `docs:operator` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/write` | `internal_evidence` | `routes/memory-write.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryWriteRouteService.commit` | `Task 11 removed` |
| `POST` | `/v1/handoff/store` | `product_support` | `routes/handoff.ts` | `none` | `none` | `none` | `none` | `none` | `publish.ts` | `none` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/handoff/recover` | `product_support` | `routes/handoff.ts` | `none` | `none` | `none` | `none` | `none` | `recover.ts` | `none` | `docs:public+eval` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/archive/rehydrate` | `internal_control` | `routes/memory-lifecycle-lite.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryLifecycleService.rehydrateArchive` | `Task 11 removed` |
| `POST` | `/v1/memory/nodes/activate` | `internal_control` | `routes/memory-lifecycle-lite.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryLifecycleService.activateNodes` | `Task 11 removed` |
| `POST` | `/v1/memory/recall` | `internal_guidance` | `routes/memory-recall.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture+eval` | `removed` | `memoryRecallParsed` | `Task 11 removed after eval migration to guide` |
| `POST` | `/v1/memory/recall_text` | `internal_guidance` | `routes/memory-context-runtime.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture+eval` | `removed` | `MemoryPlanningContextService.assemble` | `Task 11 removed after eval migration to guide` |
| `POST` | `/v1/memory/planning/context` | `internal_guidance` | `routes/memory-context-runtime.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture+eval` | `removed` | `MemoryPlanningContextService.assemble` | `Task 11 removed after product guide migration` |
| `POST` | `/v1/memory/context/assemble` | `internal_guidance` | `routes/memory-context-runtime.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture+eval` | `removed` | `MemoryPlanningContextService.assemble` | `Task 11 removed after Manifest migration` |
| `POST` | `/v1/execution/context/assemble` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `buildExecutionEvidenceContextLite` | `Task 11 removed` |
| `POST` | `/v1/memory/trajectory/compile` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `TrajectoryCompilationService.compile` | `Task 11 removed` |
| `POST` | `/v1/memory/delegation/records` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `DelegationEvidenceService.record` | `Task 11 removed` |
| `POST` | `/v1/memory/delegation/records/find` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `DelegationEvidenceService.find` | `Task 11 removed` |
| `POST` | `/v1/memory/delegation/records/aggregate` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `DelegationEvidenceService.aggregate` | `Task 11 removed` |
| `POST` | `/v1/memory/find` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryAccessService.find` | `Task 11 removed` |
| `POST` | `/v1/memory/continuity/review-pack` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryReviewService.continuityPack` | `Task 11 removed` |
| `POST` | `/v1/memory/agent/inspect` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `AgentMemoryService.inspect` | `Task 11 removed` |
| `POST` | `/v1/memory/agent/review-pack` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `AgentMemoryService.reviewPack` | `Task 11 removed` |
| `POST` | `/v1/memory/agent/resume-pack` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `AgentMemoryService.resumePack` | `Task 11 removed` |
| `POST` | `/v1/memory/agent/handoff-pack` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `AgentMemoryService.handoffPack` | `Task 11 removed` |
| `POST` | `/v1/memory/execution/introspect` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ExecutionIntrospectionService.inspect` | `Task 11 removed` |
| `POST` | `/v1/memory/evolution/review-pack` | `internal_evidence` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `EvolutionReviewService.reviewPack` | `Task 11 removed` |
| `POST` | `/v1/memory/action/retrieval` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ActionRetrievalService.retrieve` | `Task 11 removed` |
| `POST` | `/v1/memory/experience/intelligence` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ExperienceIntelligenceService.assemble` | `Task 11 removed` |
| `POST` | `/v1/memory/resolve` | `product_support` | `routes/memory-access.ts` | `resolveMemory, guideAgentContext` | `SDK indirect through guide` | `SDK indirect through guide` | `none` | `SDK indirect through guide` | `none` | `none` | `docs:public` | `required` | `none` | `retain` |
| `POST` | `/v1/memory/anchors/rehydrate_payload` | `internal_guidance` | `routes/memory-access.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryAccessService.rehydrateAnchorPayload` | `Task 11 removed` |
| `POST` | `/v1/memory/feedback` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `MemoryFeedbackService.record` | `Task 11 removed` |
| `POST` | `/v1/memory/rules/state` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `RuleEvaluationService.state` | `Task 11 removed` |
| `POST` | `/v1/memory/rules/evaluate` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `RuleEvaluationService.evaluate` | `Task 11 removed` |
| `POST` | `/v1/memory/tools/select` | `internal_guidance` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `removed` | `LearningKernel.selectToolWithLearnedMemory` | `Task 11 removed after Manifest migration` |
| `POST` | `/v1/memory/tools/decision` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `removed` | `LearningKernel.readToolDecision` | `Task 11 removed after Manifest migration` |
| `POST` | `/v1/memory/tools/run` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `removed` | `LearningKernel.readToolRun` | `Task 11 removed after Manifest migration` |
| `POST` | `/v1/memory/tools/runs/list` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ToolLearningService.listRuns` | `Task 11 removed` |
| `POST` | `/v1/memory/tools/feedback` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `resume.ts` | `none` | `docs:architecture` | `removed` | `ProductToolFeedbackService.record` | `Task 11 removed after Manifest migration` |
| `POST` | `/v1/memory/learning-loop/run` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `LearningLoopService.run` | `Task 11 removed` |
| `POST` | `/v1/memory/runtime-maintenance/run` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `RuntimeMaintenanceService.run` | `Task 11 removed` |
| `POST` | `/v1/memory/runtime-maintenance/immediate` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `RuntimeMaintenanceService.runImmediate` | `Task 11 removed` |
| `POST` | `/v1/memory/runtime-maintenance/daily` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `RuntimeMaintenanceService.runDaily` | `Task 11 removed` |
| `POST` | `/v1/memory/runtime-maintenance/long-horizon` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `RuntimeMaintenanceService.runLongHorizon` | `Task 11 removed` |
| `POST` | `/v1/memory/policies/learning-control/apply` | `internal_control` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `LearningControlPolicyService.apply` | `Task 11 removed` |
| `POST` | `/v1/memory/patterns/suppress` | `internal_control` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `PatternLifecycleService.suppress` | `Task 11 removed` |
| `POST` | `/v1/memory/patterns/unsuppress` | `internal_control` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `PatternLifecycleService.unsuppress` | `Task 11 removed` |
| `POST` | `/v1/memory/tools/rehydrate_payload` | `internal_evidence` | `routes/memory-feedback-tools.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ToolLearningService.rehydratePayload` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/run/start` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayEvidenceService.startRun` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/step/before` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayEvidenceService.recordBeforeStep` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/step/after` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayEvidenceService.recordAfterStep` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/run/end` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayEvidenceService.endRun` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/runs/get` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayEvidenceService.getRun` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/compile_from_run` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.compileFromRun` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/get` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.get` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/candidate` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.candidate` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/promote` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.promote` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/repair` | `internal_evidence` | `routes/memory-replay-core.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.recordRepair` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/repair/review` | `internal_evidence` | `routes/memory-replay-learning-control.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.reviewRepair` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/run` | `internal_evidence` | `routes/memory-replay-learning-control.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.run` | `Task 11 removed` |
| `POST` | `/v1/memory/replay/playbooks/dispatch` | `internal_evidence` | `routes/memory-replay-learning-control.ts` | `none` | `none` | `none` | `none` | `none` | `none` | `none` | `docs:architecture` | `removed` | `ReplayPlaybookService.dispatch` | `Task 11 removed` |

## Consequences for the simplification plan

- Keep the 21 required routes behaviorally stable.
- Keep temporary-route count at zero; do not add compatibility replacements for
  the eight removed transports.
- Do not count former Manifest use as evidence that tool-learning internals are
  a public product API. Manifest now consumes product guide/feedback contracts.
- Evals must validate product behavior through `observe`, `guide`, `feedback`,
  `rehydrate`, `forget`, and `measure`, or through typed in-process services when
  they explicitly test an internal mechanism.
- Task 10 typed Product Services now retain continuity, evidence-gated learning,
  controlled forgetting, negative-transfer blocking, and context reduction
  without the 45 removed HTTP adapters.
