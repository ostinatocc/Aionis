# Runtime Temporary Transport Removal Verification

Verified: 2026-07-11

Branch: `aionis/runtime-complexity-reduction`

Pre-phase checkpoint: `421ca12`

## Outcome

The phase removed all eight temporary Runtime HTTP transports. The active route
matrix is now 19, with no `temporary` entries and no compatibility replacement
routes. Product guidance, attributed tool selection and feedback, memory use,
negative-transfer blocking, scope isolation, run lifecycle visibility, and
native zvec candidate behavior remained available in the verified scenarios.

The replacement is a narrower boundary:

- `/v1/guide` can return a persisted, attributed tool-selection receipt.
- `/v1/feedback` accepts a strict `tool_selection` variant only after matching
  the guide exposure ledger and stored decision.
- Manifest consumes those product contracts instead of five internal routes.
- Runtime evals use product contracts or typed in-process recall/context
  services instead of three internal routes.
- SQLite remains the truth source; zvec remains a candidate sidecar.

## Removed transports

| Former path | Preserved capability |
|---|---|
| `/v1/memory/recall` | `memoryRecallParsed` typed operation |
| `/v1/memory/recall_text` | `MemoryPlanningContextService.assemble` |
| `/v1/memory/planning/context` | `MemoryPlanningContextService.assemble` and product guide |
| `/v1/memory/context/assemble` | Product guide and typed planning context |
| `/v1/memory/tools/select` | Guide tool-selection receipt and `LearningKernel` |
| `/v1/memory/tools/decision` | Receipt backed by the persisted decision |
| `/v1/memory/tools/run` | Feedback result lifecycle projection |
| `/v1/memory/tools/feedback` | Exposure-verified `/v1/feedback` tool variant |

The route-only modules `src/routes/memory-recall.ts` and
`src/routes/memory-feedback-tools.ts` were deleted. HTTP handlers were removed
from `src/routes/memory-context-runtime.ts`; that module now exposes the typed
planning-context service. Route registration and route-only test adapters were
also removed, including `scripts/ci/lite-memory-recall-route.test.ts`.

## Runtime capability evidence

These checks exercise Runtime behavior directly and are the basis for the
capability-preservation conclusion.

| Verification | Result |
|---|---|
| `npm run -s typecheck` | Pass |
| `npm run -s sdk:check` | Pass |
| `npm run -s complexity:check` | Pass |
| `npm run -s lite:test` | 63/63 JavaScript checks and 822/822 TypeScript tests; 0 failures, 0 skips |
| `npm run -s lite:smoke` | Pass; public observe/guide contracts valid and retired replay route returned 404 |
| Golden product loop | Pass; all 8 assertions, including positive learning and failed-branch isolation |
| Ordinary-memory loop | Pass; preference/fact use, stale inspection, suppression, and privacy checks |
| Multi-agent loop | Pass; successful branch inherited and failed branch avoided |
| Multi-agent negative loop | Pass; global visibility, team/private isolation, rejected cross-team feedback, and failed-branch blocking |
| Judgment-calibration loop | Pass; supported versus unused memory and read-only calibration |
| Native ANN contract | 8/8 passed, 0 skips |
| Native zvec write-through | Pass; all 4 assertions with SQLite truth verification |

The product end-to-end checks used a real spawned Runtime, real Lite SQLite,
and MiniMax embeddings where the scenario required embeddings. No behavioral
validation above was replaced with a mock.

## External compatibility evidence

These suites prove that supported repositories remain compatible with the new
contracts. They are not evidence that Aionis caused an external task-success
rate or other product effect.

| Repository/package | Result |
|---|---:|
| AionisManifest | 9 passed |
| AionisSubstrate | 77 passed |
| `@aionis/sdk` | 14 passed |
| Aionis CLI | 24 passed |
| Aionis Create | 27 passed |
| Aionis MCP | 16 passed |
| Aionis AIFS | 10 passed |
| Aionis Claude Code | 8 root CI + 25 package tests passed |
| Total compatibility checks | 210 passed; 0 failures, 0 skips |

## Deletion completeness

An exact-string scan found zero references to all eight retired paths across:

- production Runtime `src`;
- Runtime `scripts/e2e`;
- AionisManifest `src`;
- active memory-data, guide-precision, guide-visibility, self-learning-loop,
  and sparse-feedback eval scripts.

The source-scope guard was updated to assert that the deleted adapters remain
absent while their typed recall, planning, and learning capabilities remain
present. Its 39 checks passed, and the full Lite suite passed afterward.

## Final structure

| Metric | Final value |
|---|---:|
| TypeScript source modules | 283 |
| TypeScript source lines | 120,748 |
| Active route matrix entries | 19 |
| Product entry routes | 6 |
| Product support routes | 3 |
| Operator support routes | 10 |
| Temporary routes | 0 |
| Environment schema fields | 177 |
| Import cycles | 0 |
| Largest source file | 5,217 lines |

Largest source files at exit:

| File | Lines |
|---|---:|
| `src/memory/schemas.ts` | 5,217 |
| `src/sdk.ts` | 3,500 |
| `src/memory/replay.ts` | 2,953 |
| `src/store/lite-write-store.ts` | 2,804 |
| `src/memory/product-output-contract.ts` | 2,681 |
| `src/memory/product-output/decision-trace.ts` | 2,279 |
| `src/product/guide-service.ts` | 2,262 |
| `src/store/lite-recall-store.ts` | 2,124 |
| `src/routes/memory-context-runtime.ts` | 2,086 |
| `src/app/planning-summary-planner.ts` | 2,052 |

The structural budget is locked to the achieved values. Large-file splitting
was outside this phase; the retained files are recorded here rather than
presented as completed simplification work.

## Performance non-regression

The same Runtime-only, no-embedding workload ran at `421ca12` and the current
revision on the same darwin arm64 host with Node v24.12.0. Each sample used 24
measured iterations after 4 warmups, Lite SQLite, disabled rate limits, and no
LLM calls. A second round reversed execution order.

| Round | Pre-phase P50 / P95 | Current P50 / P95 | Change P50 / P95 |
|---|---:|---:|---:|
| Current then baseline | 181.074 / 334.297 ms | 92.313 / 267.684 ms | -49.02% / -19.93% |
| Baseline then current | 174.913 / 314.186 ms | 150.824 / 312.650 ms | -13.77% / -0.49% |

Both orders show no regression. The conservative reversed-order result clears
the 10% regression gate. Because adjacent local measurements varied materially,
this supports non-regression only; it is not a service-level or stable
throughput claim.

## Exit assessment

All planned transport-removal targets were met:

- 8/8 temporary transports removed;
- active route matrix reduced from 27 to 19 for this phase;
- temporary inventory reduced from 8 to 0;
- supported consumers migrated without adding a compatibility route;
- complete Runtime, native zvec, and external compatibility verification
  passed with no unexplained skip;
- no greater-than-10% P50/P95 performance regression was observed.

The remaining complexity is concentrated in domain and contract files, not in
the deleted HTTP transport layer. Further large-file decomposition can be a
separate phase and is not required to claim completion of this transport exit.
