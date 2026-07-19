# Changelog

## v0.3.10 - Evidence Authority and Runtime Convergence Candidate

Candidate preparation: 2026-07-19

This Local Runtime Public Beta candidate combines atomic tool-feedback and
measurement authority with the post-v0.3.9 evidence-ingestion, deployment-slot,
database-adoption, recovery, and Runtime-convergence work. The immutable tag
is created only after pre-tag gates pass; pushing it triggers the workflow that
builds and verifies the Docker image. The release is incomplete until the image
digest and GitHub Release gates also pass.

### Added

- Protected external-evidence ingestion, lifecycle reconstruction, attestation,
  archive reading, and exact operation receipts.
- Crash-replayable deployment-authority tooling with configured-root binding,
  real SIGKILL recovery evidence, terminal receipts, and fail-closed filesystem
  checks. The production isolated one-shot worker remains deferred.
- Exact fixed-gate and predecision evidence authority for selected learning
  profiles without enabling global autonomous promotion.

### Changed

- Tool-selection feedback now prepares external work before the transaction,
  persists attribution facts and an exact operation receipt atomically, and
  runs external effects only after commit.
- Manifest is now an immutable release-train member and a non-skippable Runtime
  integration whenever CI supplies its explicit checkout.
- Ordinary and Docker CI resolve, verify, and build the exact Manifest source
  ref recorded in `release-train.json`.
- Protected measure writes now use stable operation identity and exact receipt
  replay, persist immutable measurement records, and bind sufficient
  Runtime-verified effects to the authoritative after episode.
- v0.3.9 release evidence is restored to its original SDK `0.3.17` coordinate;
  SDK `0.3.19` is the frozen client coordinate for this candidate.
- Runtime commit authority, database adoption, protected filesystem posture,
  graceful shutdown, and Linux/macOS CI behavior now fail closed under their
  real deployment contracts.
- External evidence and fixed-experiment mutation writers live outside the
  daemon startup boundary; the governed `/v1` product matrix remains a
  21-route, zero-import-cycle focused surface.

### Compatibility

- Existing v4 and v5 authority databases upgrade transactionally to schema v6.
  Back up before upgrading; a v6 authority database must not be downgraded to an
  older Runtime.
- The governed `/v1` product surface remains 21 routes and the environment
  schema remains 177 fields. External npm package versions are frozen and are
  not republished by this Runtime-only candidate.
- The supported deployment is one self-hosted Runtime process with SQLite
  authority. The tag workflow is configured to publish only `linux/amd64` for
  candidate status and to leave Docker `latest` unchanged.

### Deferred

- Formal gate calibration and unqualified global promotion remain future work.
  The shipped admission-candidate policy defaults to off; explicit selected
  profile operation remains an operator-controlled evidence posture.
- Multi-instance HA and a managed multi-tenant service remain outside this
  candidate.

## v0.3.9 - Durable Learning Control Candidate

Release date: 2026-07-15

This mainline checkpoint turns formal unused-exposure feedback into durable,
restart-safe learning-control work without moving posture mutation into the HTTP
feedback transaction.

### Added

- A dedicated `lite_learning_control_jobs` queue with deterministic enqueue,
  lease fencing, bounded retry, retained dead letters, integrity verification,
  backlog health, and startup/shutdown worker lifecycle.
- Worker-side repeated-unused recomputation at the source feedback cutoff and
  consumer cohort, followed by one atomic audit commit, operation receipt, and
  completed transition. Enrolled terminal failures atomically create an
  independent learning-gate safety pause before dead-lettering.

### Changed

- Formal guide-attributed feedback now enqueues unused-exposure work in the
  same SQLite transaction as the feedback episode facts. The product response
  reports only `learning_control_status: queued|already_completed`; it does not
  claim that posture changed synchronously.
- Historical feedback without the Step 4 queue-provenance marker remains
  restart-compatible but is not retroactively enqueued.
- Confirmatory experiment provisioning now retries only `SQLITE_BUSY` failures
  from `BEGIN IMMEDIATE` within a fixed six-attempt budget. The locked replay
  check still runs before entropy, while transaction-body and commit failures
  remain single-attempt and fail closed.

### Compatibility

- Runtime stays on the existing SQLite v4 authority schema; no migration,
  route, or environment-contract change is introduced by this candidate.
- v0.3.8 data upgrades forward and historical feedback without queue
  provenance remains readable, but a database containing new v0.3.9
  queue-provenance events must not be downgraded to v0.3.8.
- External npm package coordinates remain frozen. This private Runtime source
  release publishes only the immutable source tag and `linux/amd64` image.
- Global admission-candidate serving remains off, and later promotion phases
  remain outside this candidate.

## v0.3.7 - Evidence-Gated Learning Candidate

This candidate adds protected append-only authority for learning episodes,
experiment lifecycle, guide exposure, and direct memory feedback attribution.
Global candidate serving remains off and this checkpoint does not claim a
mature autonomous-learning loop.

### Added

- SQLite v4 learning authority for experiments, namespace leases, episode
  events, exposure items, feedback attributions, safety stops, operation
  receipts, and reserved learning-control jobs.
- Protected experiment provision/close commands with exact replay, reviewed
  configuration, OS-CSPRNG matched-pair assignment, bounded HMAC approval,
  Runtime receipt attestation, and atomic lease release.
- Protected guide and direct-feedback operation identity, strict host task/use
  receipts, per-subject surface and evidence binding, and restart-time
  derivation of attribution strength.
- `@aionis/sdk@0.3.16` host receipt builders/parsers/digests and protected
  identity forwarding, plus a bounded read-only host conformance command.

### Changed

- Migrate a complete v3 authority database atomically to v4 and fail closed on
  damaged, mixed, future, or receipt-drifted state.
- Commit guide receipt/exposure and direct-memory activation/attribution facts
  in their respective shared SQLite transactions.
- Classify legacy feedback as unverified and promotion-ineligible while
  retaining request compatibility.
- Keep the real 21-route surface and all newly tracked source files inside
  structural governance.

### Deferred at v0.3.7

- At the v0.3.7 checkpoint, the learning-control job schema was reserved and
  integrity-checked, but Task 4.1 Step 4 production enqueue, leasing,
  retry/dead-letter worker, and Runtime lifecycle wiring were not included.
  Repeated-unused was read-only at that immutable checkpoint.
- Production external execution remains unregistered, the gate remains
  `calibration_pending`, and later tool-feedback, measurement-binding, and
  gate/promotion phases remain disabled.

## v0.3.6 - Release Integrity Maintenance Candidate

Release date: 2026-07-13

This maintenance candidate preserves the v0.3.5 public contracts and SQLite
schema while hardening startup compatibility and exact release publication.

### Changed

- Require Node.js `>=22.13.0` for source/local Runtime installs because earlier
  experimental Node 22 SQLite releases have incompatible empty-row semantics.
- Start Lite as the direct Node process and use bounded process/process-group
  cleanup in smoke, fresh-install, and Docker release checks.
- Build Docker under a unique release/commit/run staging subject, verify and
  smoke its digest, then promote only that digest to the version tag.
- Verify exact package checkouts as packed SDK, MCP, and Create artifacts before
  publication.
- Remove stale Dashboard/control-panel claims from current product-surface
  documentation.

### Compatibility

- No HTTP, SDK/MCP, SQLite schema, migration, or durable event-format changes.
- Existing v0.3.5 data remains compatible.
- Docker continues to use Node.js 24 and candidate status still leaves
  `latest` unchanged.

## v0.3.5 - Local Runtime Public Beta Candidate

Release date: 2026-07-12

This candidate repairs aggressive AgentContext compaction and hardens the
single-process Local Runtime continuity boundary. It includes public Runtime
and SDK contract changes; SDK `0.3.15` is the matching client candidate.

### Added

- Durable `operation_id` receipts for `/v1/observe` and direct
  `/v1/handoff/store`, including exact replay and conflict rejection.
- `aionis_observe_result_v1` post-commit projection scheduling and
  `aionis_handoff_store_result_v1` response contracts.
- Durable embedding generation and ANN reconciliation jobs with leases,
  generations, CAS completion, retry/dead-letter states, worker health, and
  startup rebuild of local ANN from SQLite truth.
- Runtime-owned `/v1/measure` `evidence_assessment`, persisted measurement
  identity/digest, and explicit reporting of ignored client evidence claims.
- SQLite preflight, v0.3.4 upgrade, verified backup/restore, full execution
  history audit, and durable projection repair operations.
- Immutable source tags paired with exact commits for every package in
  `release-train.json`; unfrozen Manifest is excluded from this train.

### Changed

- Route aggressive standard/full-power guide requests through the canonical
  compact contract renderer instead of the verbose standard renderer.
- Keep active, reference-only, blocked, accepted-evidence, and governance
  surfaces bounded under explicit character budgets.
- Preserve guide-only target files when the selected current memory does not
  carry its own target-file projection.
- Commit observe memory, execution state/tree, handoff, claims, operation
  receipt, and projection intent as one SQLite unit of work.
- Reject stale execution state/tree snapshots instead of silently restoring old
  continuity state under a newer revision.
- Treat manual measure input and caller-provided `sufficient_evidence` or
  `evidence_ids` as unverified; learning and skill export require Runtime-owned
  evidence receipts and complete passing kernel metrics.
- Fail current-schema startup before business DDL when an authority column,
  primary/unique constraint, or critical scheduler index is missing or altered.
- Build one digest-pinned `linux/amd64` image, smoke that exact digest, and only
  then promote the same digest to release tags; arm64 remains outside this train.

### Verified

- Real SQLite/HTTP tests cover atomic rollback, stale snapshots, durable replay,
  operation-ID conflict, corrupt receipts, and evidence-gate bypass attempts.
- Real child-process tests crash immediately after commit and recover embedding
  plus ANN work after restart.
- Destructive SQLite tests prove continuity/history corruption, broken current
  schemas, and invalid projection payloads cannot pass verify or backup.
- Latest pre-freeze Runtime suite: 919 tests, 915 passed, zero failed, and four
  optional native Zvec tests skipped. Final frozen-ref and release-smoke gates
  remain required.
- The compaction repair reduced mean projected context by 37.18% versus
  immutable `v0.3.4` and by 14.55% versus the frozen pre-refactor comparator
  while preserving recall, stale-leak, rehydration, audit, and Memory Firewall
  outcomes.

This change set shipped as the immutable Runtime `v0.3.5` Public Beta
candidate. It does not claim a managed multi-tenant or multi-instance HA
service.

## v0.3.4 - Runtime Complexity Reduction

Release date: 2026-07-11

This unreleased change set reduces accidental complexity in the focused
Runtime while preserving continuity, evidence-gated learning, controlled
forgetting, negative-transfer blocking, scope isolation, and auditability.

### Added

- One canonical governance decision, AgentContext compiler, and prompt
  renderer pipeline.
- Typed Runtime services for internal composition and structural CI budgets
  for source size, routes, configuration, imports, and SDK ownership.
- Public-product smoke and real SQLite/HTTP/SDK parity coverage for the
  simplified Runtime path.
- A narrow tool-selection receipt on `/v1/guide` and exposure-verified
  tool-selection feedback through `/v1/feedback`.

### Changed

- Kept Runtime Core as a modular monolith with SQLite as truth and zvec or
  Substrate as governed candidate sources.
- Reduced the active route matrix from 72 to 19 entries, environment schema
  fields from 220 to 177, and import cycles from three to zero.
- Reduced `product-output-assembler.ts` to a narrow 31-line facade and
  `product-facade.ts` to a 279-line HTTP adapter.
- Replaced internal route-to-route composition with typed service calls and
  aligned Runtime, SDK, smoke, and end-to-end source metadata with the public
  product surface.
- Migrated AionisManifest resume and active Runtime eval consumers away from
  recall/context and tool-learning internal transports.
- Unified Docker build and runtime stages on Node 24 to match the candidate
  toolchain and Substrate development dependency floor.

### Removed

- Fifty-three retired internal HTTP adapters from active registration,
  including the final eight temporary recall/context and tool-learning routes.
- Sixteen replaced Runtime source modules, including the legacy lifecycle,
  replay-route, projection, ANN no-op, and access-wrapper implementations.
- Duplicate AgentContext classification/rendering ownership and Runtime import
  cycles.

### Verified

- Runtime typecheck, SDK ownership, complexity guard, public smoke, and full
  Lite suite: 63 / 63 JavaScript checks plus 822 / 822 TypeScript tests, zero
  skips.
- Real MiniMax-backed golden, ordinary-memory, multi-agent, negative-transfer,
  and judgment-calibration product loops.
- Native zvec ANN contract and write-through behavior, including SQLite truth
  verification after candidate retrieval.
- AionisSubstrate, AionisManifest, SDK, CLI, create, MCP, AIFS, and Claude Code
  package suites.
- Same-machine pre/post Runtime-only A/B repeated in both execution orders:
  conservative reversed-order P50 improved 13.77% and P95 improved 0.49%; no
  regression exceeded the 10% budget.

This change set shipped as Runtime `v0.3.4`.

## v0.3.2 - Runtime Profile Activation Patch

Release date: 2026-06-29

v0.3.2 is a Runtime patch release for the v0.3 stable train. It records the
profile-scoped admission activation path, updates the current Runtime release
artifacts, and keeps the global Runtime admission default explicit.

### Added

- Profile-scoped admission policy rules for bounded active rollout through
  `AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON`.
- Tool-E2E gate support for requiring `profile_rule` source attribution and a
  selected profile id.
- Selected-profile activation quickstart and `.env` template for
  `external-agent-e2e-worker-full-power`.
- External messaging and Substrate sidecar boundary documentation.
- DashScope `text-embedding-v4` provider path.

### Changed

- Recorded the selected admission candidate as approved for selected-profile
  activation, not global Runtime default activation.
- Updated Runtime release docs and Docker examples to `v0.3.2`.
- Kept npm package patch versions independent from the Runtime source tag.

### Verified

- Global active cross-repository tool-E2E gate: 40 / 40 accepted-route and
  40 / 40 action-completion with initial-context budget comparison.
- Profile-rule multi-step tool-E2E gate: 40 / 40 accepted-route,
  40 / 40 action-completion, zero route write/action violations, zero terminal
  inspect exits, zero report-conflict exits, and 40 / 40 matching profile-rule
  guide source records.
- Runtime typecheck before release preparation.

## v0.3.1 - Stable Patch

Release date: 2026-06-26

v0.3.1 is the Runtime patch release for the v0.3 stable train. It keeps the
same public product surface while aligning the Runtime source with the latest
published v0.3 package patches.

### Added

- Cross-plane adjudication contract for resolving lifecycle, tier, policy,
  credibility, learning-control, execution, and rehydrate signals into one
  Agent Context surface.
- Regression coverage for conservative plane precedence:
  `use_now`, `inspect_before_use`, `do_not_use`, `rehydrate`, and
  `command_posture`.

### Changed

- Explicit archived and retired policy memory now win over hot/trusted/stable
  direct-use signals during Agent Context assembly.
- Contested policy or credibility state now routes to inspection before use.
- Release docs now distinguish immutable Runtime source tags from patch-level
  npm package versions in the v0.3 stable train.

### Verified

- Runtime typecheck.
- Product output regression tests.
- Full Lite test suite: 687/687.

## v0.3.0 - Stable Baseline

Release date: 2026-06-26

v0.3.0 is the first stable baseline release train for the Runtime and public
integration packages. It is the version to point new users at when they want to
install Aionis locally, connect an Agent through SDK/API/MCP/AIFS/native
adapters, or run the Docker Runtime.

### Added

- Unified v0.3.0 package train for Runtime, SDK, CLI, create installer, MCP,
  AIFS, and Claude Code adapter.
- Zvec optional ANN candidate sidecar path while keeping SQLite as the Runtime
  fact source and Aionis governance as the final admission layer.
- Runtime release documentation for Docker, GitHub Releases, npm publish order,
  and package boundaries.
- Stable installer posture through `npx aionis setup`, with local smoke demo
  optional instead of required.

### Changed

- Updated public positioning around state-preserving execution context:
  shorter, cleaner, auditable context that carries across sessions, agents,
  models, and devices.
- Kept Claude Code as one native adapter path instead of the product center.
  Runtime, SDK/API, MCP, AIFS, and host-built adapters remain first-class.
- Aligned external package dependency declarations on `@aionis/sdk@^0.3.0`.

### Verified

- Runtime typecheck and Lite test suite.
- External package build/test paths for SDK, MCP, create, CLI, AIFS, and Claude
  Code adapter.
- Fresh install and external package smoke paths.
- Docker build path for the Runtime image.

## v0.2.0 - Public Beta

Release date: 2026-06-21

v0.2.0 is the first public beta release of Aionis as a usable Runtime for
agent execution memory, memory admission, and audit replay.

### Added

- Public npm package set for the v0.2 release:
  - `@aionis/create@0.2.0`
  - `@aionis/mcp@0.2.0`
  - `@aionis/sdk@0.2.22`

  `@aionis/sdk` uses `0.2.22` because npm registry tombstones already reserve
  earlier `0.2.x` SDK versions. `@aionis/mcp@0.2.0` depends on
  `@aionis/sdk@^0.2.0`, so it resolves to the published SDK `0.2.22`.
- MCP-first trial path for Claude Code, Cursor, Zcode, Codex, OpenCode, and
  other MCP-compatible agent hosts.
- Execution Memory product path for cross-session and multi-agent continuation.
- Memory Firewall gateway for external memory candidates from Mem0, Zep,
  Supermemory, vector stores, markdown, logs, or custom retrieval systems.
- Agent Flight Recorder and operator snapshot surfaces for decision replay.
- Admission dataset export and shadow/candidate policy evaluation tooling for
  future admission-policy learning.
- Managed Server beta posture with explicit auth, tenant/scope controls, rate
  limits, quotas, and hosted-safe health/readiness probes.
- Fresh install smoke that validates the public `@aionis/create` path without
  requiring an embedding key.

### Changed

- Repositioned the public product language around governed execution context:
  shorter context, safer admission, and auditable memory influence.
- Added MCP as a portable adapter path alongside SDK, HTTP, and host-built
  integrations.
- Clarified how Lite Runtime and Managed Server deployments map to local and
  remote Agent integration.

### Verified

- TypeScript Runtime typecheck.
- Workspace package builds and tests.
- Lite Runtime test suite.
- SDK/MCP/create external package smoke.
- Fresh install smoke through public npm entrypoints.
- Product e2e coverage for Memory Firewall, Flight Recorder, Managed Server
  hybrid recall, and golden observe-guide-feedback-measure loop.

### Scope Notes

- v0.2.0 focused on Runtime, SDK, MCP, installer, product APIs, and audit
  surfaces.
- Local recall included hybrid semantic/lexical/structured/execution-native
  candidate generation.
- Admission candidate policies were evaluable and shadowable, setting up the
  later admission-data flywheel work.
