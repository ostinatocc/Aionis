# Contributing

## Baseline

Use a Node version accepted by `package.json` (`>=22.15.0 <23` or
`>=24.0.0 <25`; CI verifies Node 22.15, Node 24.0, and the current Node 24).
Native Runtime development is supported on Linux and macOS only.

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run build:sdk
```

`npm run check` is the required local gate: strict no-legacy complexity
verification, schema-manifest verification, TypeScript checks, and the V1 test
suite. `npm run build` must also pass and must produce a clean V1-only compiler
tree with the SQL and manifest assets. The Docker build must derive its exact
daemon/provisioner/worker staging closure from that tree; copying all of
`dist/` into the image is forbidden. `npm run build:sdk` must derive the
standalone SDK closure without copying Runtime, SQL, worker, or tooling files.

## Scope

This repository contains the Aionis Continuation Runtime V1:

1. verified observation, capsule, snapshot, and continuation contracts;
2. evidence-bound learning, controlled forgetting, and learning control;
3. one local SQLite authority with durable operations and CAS heads;
4. strict HTTP daemon, separately packaged exact SDK, offline provisioner, and
   role-confined durable workers; and
5. rebuildable embedding and ANN sidecars that never replace SQLite authority.

External Agent frameworks, UI, hosted control planes, generic automation,
benchmark policy, compatibility adapters, and deployment authority do not
belong in the daemon closure.

## Clean-break rules

- Do not restore v0.3.x Lite, MCP, guide, installer, or old database contracts.
- Do not add aliases, redirects, dual registration, payload translation, or an
  automatic migration path.
- Do not add an unsigned default policy, readiness override, or secret fallback.
- Do not move provider keys, effect private keys, cohort seeds, or a root private
  key into the daemon.
- Do not turn one task, repository, model, provider, or benchmark failure into a
  permanent Runtime rule.
- Prefer deletion or extraction when code does not directly strengthen
  continuity, learning, forgetting, or learning control.

## Public contract

The product surface is exactly five routes:

1. `POST /v1/observations`
2. `POST /v1/continuations`
3. `POST /v1/outcomes`
4. `POST /v1/authority-decisions`
5. `GET /v1/decisions/:decision_id`

`GET /healthz` and `GET /readyz` are the only probes. Do not add implicit
`HEAD`, debug, browser, facade, or hidden operator routes. Route registration,
tests, SDK behavior, README, and security documentation must remain coherent
with `src/runtime-v1/http-surface.ts`.

The SDK remains exactly `recordObservations`, `createContinuation`,
`recordOutcome`, `decideAuthority`, and `readDecision`.
The repository root is a private OCI build manifest and must not expose an npm
entry point. `packages/sdk` is the only Node consumer artifact.

## Authority and process boundaries

- SQLite is the only authority; keyword, vector, and ANN data are rebuildable.
- Daemon, provisioner, and worker environment parsers stay separate and strict.
- Worker roles are separate processes: `embedding`, `ann`, `effect`, and
  `retention`. A role may consume only its own durable jobs.
- ANN remains build-only until an explicit authority-safe serving port is
  designed and tested.
- The effect worker uses a dedicated Ed25519 signer that cannot equal the
  offline authority root.
- V1 remains a local single-authority-database, one-write-transaction-at-a-time
  beta with no HA or network-filesystem claim.

## Pull request expectations

Before opening a pull request:

1. rebase the change on one exact commit and keep unrelated work out;
2. run `npm run check`;
3. run `npm run build`;
4. for database changes, prove the SQL and generated manifest are identical and
   test fresh bootstrap, reopen, crash recovery, and `0700`/`0600` posture;
5. for HTTP changes, prove the exact five-route/two-probe inventory and strict
   host/operator authentication;
6. for worker changes, test lease, retry/dead classification, idempotent
   completion, signal drain, and role/secret confinement;
7. for container changes, render Compose and build the non-root runtime image;
   verify it contains compiled output, production dependencies, and required
   license notices only;
8. for SDK changes, pack `packages/sdk` and verify fresh JavaScript and strict
   TypeScript consumers, exact exports, and rejection of deep imports; and
9. update architecture, README, security, and focus documents when an external
   contract or deployment invariant changes.

Use real store, process, HTTP, crash, or provider integration at the relevant
boundary. A hand-written fixture alone is not effectiveness or recovery proof.

## Contract-change discipline

Any external change must keep these authorities coherent:

1. canonical TypeScript contract and validation;
2. SQL schema and generated manifest, when persistence changes;
3. operation digest and idempotency semantics;
4. HTTP handler and exact route inventory;
5. SDK transport method and bounds;
6. role-specific environment allowlist;
7. architecture and security documentation; and
8. tests that prove fail-closed behavior.

Do not edit the complexity budget merely to match growth. New code must remove
or replace at least as much obsolete daemon closure, or be justified as a
strictly necessary V1 mechanism with a downward-ratchet plan.
