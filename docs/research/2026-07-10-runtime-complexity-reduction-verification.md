# Runtime Complexity Reduction Verification

Date: 2026-07-10

Scope: `AionisRuntime-focused` and its supported integration repositories

Code checkpoint: `3060ca1fdb5e77470f1c7b853eeeecc50c96c6e4`

## Decision

The capability and performance exit is **accepted**. The aggressive structural
exit is **partially accepted with recorded debt**.

The simplified Runtime passed real SQLite, HTTP, SDK, embedding, native zvec,
and external-package validation. The refactor preserves the Aionis-owned
effects in scope and stays within the 10% same-machine performance budget.

The implementation did not reach the plan's source-line, environment-field,
or largest-file stretch targets. Eight typed-service-backed internal HTTP
transports also remain temporarily registered for Manifest and historical eval
consumers. Consequently this report does not claim that every migration path
or all accidental complexity has been removed.

No release was prepared. `RELEASE_NOTES.md` was intentionally left unchanged.

## Verification Matrix

### Runtime

| Check | Result |
|---|---|
| TypeScript typecheck | pass |
| SDK contract ownership and sync check | pass |
| Complexity collector and committed budget | pass |
| Full Lite suite | 819 / 819 pass, 0 fail, 0 skip |
| Public Lite smoke | pass; observe -> guide and retired replay route returns 404 |
| Golden product loop | pass with real MiniMax embeddings |
| Ordinary-memory loop | pass with real MiniMax embeddings |
| Multi-agent loop | pass with real MiniMax embeddings |
| Multi-agent negative-transfer loop | pass with real MiniMax embeddings |
| Judgment-calibration loop | pass with real MiniMax embeddings |
| Additional four-API, fresh-host, and engineering-profile loops | pass |

The SQLite experimental warning emitted by Node is a runtime warning, not a
test skip or failure.

### Native zvec

| Check | Result |
|---|---|
| ANN index contract | 8 / 8 pass, 0 skip |
| Weak inline embedding update | pass |
| ANN candidate without exact recovery | pass |
| Write-through visibility without restart | pass |
| Failed embedding mutation removes the target | pass |

The native macOS arm64 binding was exercised. The upstream `@zvec/zvec@0.5.0`
installer could not resolve its optional sibling binding from its install
script, so the already installed binding was linked inside `node_modules` for
the run. No source, dependency declaration, or lockfile workaround was added.
SQLite reload and governance remained authoritative after ANN retrieval.

### Integration repositories

| Repository/package | Result |
|---|---|
| AionisSubstrate | typecheck; 77 / 77 pass, including 3 zvec tests |
| AionisManifest | 4 / 4 verify checks pass |
| aionis-sdk | 14 / 14 pass |
| aionis-cli | 24 / 24 pass |
| aionis-create | 27 / 27 pass |
| aionis-mcp | 16 / 16 pass |
| aionis-aifs | 10 / 10 pass |
| aionis-claude-code | typecheck; repository 8 / 8 and package 25 / 25 pass |

External package pass rates are compatibility evidence, not the primary proof
of Runtime product effects.

## Aionis-Owned Effects

### Continuity recovery

The golden and multi-agent loops recovered the current branch, verified state,
target files, and next action. The direct execution path stayed actionable,
while stale or family-only context remained inspect-first. Team and private
handoffs remained isolated.

### Repeated-discovery reduction

In the golden loop the relevant action was not available before observation
and became actionable after the governed observe/guide cycle. The four-API and
engineering-profile loops reused known execution state on later iterations
instead of reconstructing it from an empty context.

### Context and token reduction

The canonical compiler and renderer passed explicit prompt-budget and profile
tests. Real ordinary-memory scenarios produced bounded prompts while keeping
`use_now`, `inspect_before_use`, and `do_not_use` disjoint. The no-embedding
performance workload produced a 192-character prompt. This proves bounded
projection, not a universal token-reduction percentage across arbitrary tasks.

### Evidence-gated learning

A single successful execution memory remained inspect-first unless the host
provided explicit, attributable use evidence. Feedback was accepted only for
memory exposed by the referenced guide trace. Stable workflow, policy, pattern,
and procedure promotion remained behind outcome and learning-control gates.

### Controlled forgetting and rehydration

Suppression moved unsafe memory to `do_not_use`; archive rehydration restored
the selected record through the public lifecycle service. Positive evidence
continued to protect useful recent memory from premature decay.

### Negative-transfer blocking

The golden loop kept unrelated branches isolated. The negative multi-agent
loop blocked failed-branch guidance, enforced team/private visibility, and
kept failed evidence out of direct use.

### History-shaped future behavior

The real closed loops reported a positive effect only after later guidance
changed due to persisted, attributable history. Effect assembly continued to
reject broad claims when comparison evidence was insufficient.

## Performance Exit

The historical July 1 Runtime-only result was 21.344 / 45.521 ms P50/P95.
Current machine load could not reproduce that absolute number in either
worktree, so the exit decision uses a same-command, same-machine A/B run:

| Revision | Total P50 | Total P95 |
|---|---:|---:|
| Pre-refactor `ca4725d` | 79.924 ms | 238.709 ms |
| Refactored `3060ca1` | 78.004 ms | 245.123 ms |
| Change | -2.40% | +2.69% |

P50 improved and P95 remained within the allowed 10% regression budget. No
new large-model call or internal network hop was introduced.

## Final Complexity Measurements

The authoritative structural baseline is the first committed complexity
budget in `5bbdff5`, measured at code commit `f3f6d89`. It differs slightly
from the plan prose because the collector counts tracked TypeScript source
deterministically.

| Measure | Baseline | Final | Change | Stretch target | Result |
|---|---:|---:|---:|---:|---|
| Source modules | 284 | 284 | 0 | no growth | met |
| Source lines | 123,785 | 121,604 | -2,181 (-1.76%) | <= 95,000 | missed by 26,604 |
| Route matrix entries | 72 | 27 | -45 (-62.50%) | <= 35 | met |
| Environment schema fields | 220 | 177 | -43 (-19.55%) | <= 120 | missed by 57 |
| Import cycles | 3 | 0 | -3 | 0 | met |
| Largest source file | 7,405 | 5,217 | -2,188 (-29.55%) | <= 1,500 | missed by 3,717 |
| `product-output-assembler.ts` | 7,405 | 31 | -7,374 | <= 800 | met |
| `product-facade.ts` | 4,786 | 279 | -4,507 | <= 800 | met |

Active route exposure is now:

| Exposure | Count |
|---|---:|
| Product entry | 6 |
| Product support | 3 |
| Operator support | 10 |
| Internal guidance compatibility transport | 5 |
| Internal evidence compatibility transport | 3 |

Largest remaining source files are:

| File | Lines |
|---|---:|
| `src/memory/schemas.ts` | 5,217 |
| `src/sdk.ts` | 3,456 |
| `src/memory/replay.ts` | 2,953 |
| `src/store/lite-write-store.ts` | 2,804 |
| `src/routes/memory-context-runtime.ts` | 2,707 |
| `src/memory/product-output-contract.ts` | 2,681 |
| `src/memory/product-output/decision-trace.ts` | 2,279 |
| `src/product/guide-service.ts` | 2,202 |
| `src/store/lite-recall-store.ts` | 2,124 |
| `src/app/planning-summary-planner.ts` | 2,052 |

The missed stretch targets are concentrated in retained domain contracts,
replay, storage, and compatibility transport code. Reaching them safely needs
another evidence-backed deletion tranche; splitting these files mechanically
would lower no real complexity and was not counted as success.

## Deletion Audit

The refactor deleted sixteen tracked source modules:

- legacy admission active/shadow projections;
- agent flight recorder, claim-ledger projection, archive relocation,
  differential rehydration, external admission, and semantic-forgetting
  wrappers;
- lifecycle, replay-core, replay-learning-control, observe-structuring, and
  boundary-inventory route modules;
- no-op ANN, claim-ledger access, and skill-review access wrappers.

All 45 inventory entries marked `removed` are absent from active route
registration, and CI compares the inventory against the route matrix. Public
smoke no longer depends on replay internals. Product E2E scripts use public
observe/guide contracts. Unit tests may still mount removed adapters through
test-only helpers to prove typed-route behavior; those helpers are not part of
production application registration.

Search and ownership checks found one canonical
`compileAionisAgentContext`, one prompt renderer, and one governance decision
owner. Runtime source imports are acyclic and Runtime does not reverse-depend
on SDK implementation code. No behavioral fallback preserves the deleted
internal route composition.

Eight temporary transports remain, each delegating to the same typed service
used by the product path:

- `/v1/memory/recall`
- `/v1/memory/recall_text`
- `/v1/memory/planning/context`
- `/v1/memory/context/assemble`
- `/v1/memory/tools/select`
- `/v1/memory/tools/decision`
- `/v1/memory/tools/run`
- `/v1/memory/tools/feedback`

These transports preserve Manifest and historical eval integration. They do
not constitute a second compiler, governance engine, or storage authority, but
they do mean the literal "no temporary migration path remains" criterion is
not met.

## Remaining Debt and Next Decision

1. Migrate Manifest and historical eval consumers from the eight temporary
   transports to public product contracts or direct typed services, then
   remove those registrations.
2. Reduce first-class environment fields through cohesive profiles without
   hiding equivalent knobs in untyped JSON.
3. Decompose or delete responsibility from schemas, replay, stores, SDK, and
   context transport only where the ownership boundary becomes simpler.
4. Lower the structural budget after each real deletion; do not claim progress
   from file splitting alone.

The present branch is ready for review as a capability-preserving complexity
reduction, with the remaining structural debt explicitly bounded rather than
silently carried.
