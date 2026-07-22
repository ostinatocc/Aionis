# Changelog

## 1.0.0-alpha.1 — unreleased

This is the clean-break Continuation Runtime V1 alpha. It replaces the v0.3.x
HTTP, SDK, output, database, deployment-authority, and evaluation surfaces; it
does not provide compatibility aliases or a database migration path.

### Runtime contract

- Five product operations: record observations, create a continuation, record
  an outcome, decide authority, and read a durable decision.
- One immutable continuation contract records the exact memory head, authority
  branches, signed policies, selected capsules, exclusions, obligations, and
  safe fallback that governed an Agent decision.
- Verified continuity and governed learning are separate lanes. Candidate
  learning cannot enter the continuity lane or become authoritative without an
  explicit evidence-bound decision.
- Exposure, host use, outcome, cohort assignment, whole-treatment effect, and
  later authority changes are joined by immutable digests in one SQLite
  authority database.
- Archive is a terminal, body-free logical tombstone. A dedicated retention
  worker removes rebuildable vector and ANN sidecars without mutating memory or
  effect authority.

### Authority and operations

- Fresh databases fail readiness until root-signed compiler and evidence
  policies plus an authoritative learning genesis are provisioned offline.
- The daemon has no provider credential, effect signing key, or root private
  key. Embedding, ANN, effect settlement, and retention run as isolated worker
  roles.
- Cohort assignment is deterministic, signed-policy-bound, and made atomically
  with continuation creation. Effect settlement evaluates the complete ITT
  census and the whole candidate treatment delta.
- SQLite, WAL, SHM, vector artifacts, and ANN segments use private local
  permissions and fail closed on replacement, symlink, digest, or manifest
  drift.

### Release status

The delivery boundary is split between a runnable OCI Runtime and the separate
zero-runtime-dependency `@aionis/continuation-sdk` package. Both remain private
while the exact-commit external Agent pilot and 24–36 hour soak are pending.
Passing unit and integration tests is necessary, but is not treated as
product-effect evidence.

The OCI artifact is now assembled from an exact content-addressed
daemon/provisioner/worker closure with a script-free runtime manifest. The SDK
package manifest is also script-free; neither artifact carries repository-only
commands.
