# Changelog

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
- Made MCP the fastest recommended path for external users to try Aionis before
  writing a custom host adapter.
- Clarified the product boundary between Lite Runtime, Managed Server beta, and
  future Cloud.

### Verified

- TypeScript Runtime typecheck.
- Workspace package builds and tests.
- Lite Runtime test suite.
- SDK/MCP/create external package smoke.
- Fresh install smoke through public npm entrypoints.
- Product e2e coverage for Memory Firewall, Flight Recorder, Managed Server
  hybrid recall, and golden observe-guide-feedback-measure loop.

### Known Boundaries

- Aionis v0.2.0 is not a hosted Cloud SaaS. Billing, org management, hosted
  multi-tenant control plane, and fleet operations are not included.
- Local recall has hybrid semantic/lexical/structured/execution-native
  candidate generation, but true large-scale ANN/vector backend work remains
  future roadmap.
- Admission candidate policies are evaluated and can be shadowed, but the
  learned admission-policy flywheel is not yet a fully automated production
  policy.
