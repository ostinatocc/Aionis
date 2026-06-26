# Changelog

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
