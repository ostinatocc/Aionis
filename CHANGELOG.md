# Changelog

## Unreleased - Runtime Complexity Reduction

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

### Changed

- Kept Runtime Core as a modular monolith with SQLite as truth and zvec or
  Substrate as governed candidate sources.
- Reduced the active route matrix from 72 to 27 entries, environment schema
  fields from 220 to 177, and import cycles from three to zero.
- Reduced `product-output-assembler.ts` to a narrow 31-line facade and
  `product-facade.ts` to a 279-line HTTP adapter.
- Replaced internal route-to-route composition with typed service calls and
  aligned Runtime, SDK, smoke, and end-to-end source metadata with the public
  product surface.

### Removed

- Forty-five retired internal HTTP adapters from active registration.
- Sixteen replaced Runtime source modules, including the legacy lifecycle,
  replay-route, projection, ANN no-op, and access-wrapper implementations.
- Duplicate AgentContext classification/rendering ownership and Runtime import
  cycles.

### Verified

- Runtime typecheck, SDK ownership, complexity guard, public smoke, and full
  Lite suite: 819 / 819 tests, zero skips.
- Real MiniMax-backed golden, ordinary-memory, multi-agent, negative-transfer,
  and judgment-calibration product loops.
- Native zvec ANN contract and write-through behavior, including SQLite truth
  verification after candidate retrieval.
- AionisSubstrate, AionisManifest, SDK, CLI, create, MCP, AIFS, and Claude Code
  package suites.
- Same-machine pre/post Runtime-only A/B: P50 improved 2.40%; P95 regressed
  2.69%, within the 10% budget.

No release has been prepared from this change set; release notes remain
unchanged.

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
