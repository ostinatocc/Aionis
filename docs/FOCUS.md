# Focus Boundary

Aionis Runtime Focused is the clean-break Continuation Runtime V1. Its job is
to compile the smallest verified execution state an Agent needs next, record
exactly how that state was used, learn only from bound outcomes, forget state
that has lost authority, and make every serving change explainable from durable
evidence.

The canonical contract is
[AIONIS_CONTINUATION_RUNTIME_V1.md](architecture/AIONIS_CONTINUATION_RUNTIME_V1.md),
adopted by
[ADR-0003](adr/0003-adopt-verified-branching-continuation-runtime.md). Earlier
v0.3.x product, route, guide, Lite, MCP, and database shapes are historical
material only. They are not compatibility targets.

## Product promise

An Agent using Aionis should:

1. resume from verified current state instead of rediscovering it;
2. receive a deterministic continuation contract, not an unbounded memory dump;
3. expose which capsule revisions influenced each decision and action;
4. turn verified outcomes into isolated learning evidence;
5. prevent weak, stale, conflicting, or harmful evidence from gaining direct
   authority;
6. remove rebuildable state only after an explicit lifecycle decision; and
7. reconstruct why present history changed future behavior.

## Four kernel capabilities

The focused Runtime has exactly four primary capabilities:

1. **Continuity** — typed observations, immutable capsules, world snapshots,
   bounded candidate retrieval, and deterministic continuation compilation.
2. **Learning** — append-only exposure/use/outcome episodes, isolated candidate
   branches, exact treatment membership, and signed effect evidence.
3. **Forgetting** — lifecycle authority, suppression/quarantine/expiry, archive
   references, and retention of rebuildable sidecars only.
4. **Learning control** — root-signed policies, deterministic cohort assignment,
   effect-gated merge, CAS heads, rejection, and forward revert.

The product-level effect is history-shaped future behavior: a later
continuation contract, verification obligation, suppression decision, or
authority branch must differ only when durable evidence justifies that
difference.

## In scope

- the five-route V1 HTTP product surface and separately packaged exact
  five-method SDK;
- strict trusted-host and operator authentication;
- offline root-signed policy, cohort, and rotation provisioning;
- one authoritative local SQLite database with durable idempotent operations;
- complete decision reconstruction and bounded counterfactual reads;
- independent `embedding`, `ann`, `effect`, and `retention` workers;
- content-addressed rebuildable vector and ANN sidecars;
- graceful process shutdown and private local data posture;
- evidence that directly measures continuity, learning, forgetting, and
  learning-control effects.

## Out of scope

- external Agent frameworks, runners, or framework-specific repair rules;
- a generic memory graph, automation platform, sandbox, or admin control plane;
- hosted multi-tenant service, HA, multi-host writers, or network filesystems;
- product UI, inspector, playground, hosted docs, and example applications;
- benchmark-specific policy in the daemon;
- provider-specific embedding policy outside the embedding worker;
- vector-search serving until an explicit authority-safe retrieval port exists;
- root private-key custody or artifact signing inside Runtime;
- v0.3.x payload aliases, package compatibility, database migration, or dual
  registration.

## Executable boundary

The daemon exposes exactly:

- `POST /v1/observations`
- `POST /v1/continuations`
- `POST /v1/outcomes`
- `POST /v1/authority-decisions`
- `GET /v1/decisions/:decision_id`
- `GET /healthz`
- `GET /readyz`

No implicit `HEAD`, compatibility route, debug facade, browser route, or hidden
operator route may be registered. The route inventory in
`src/runtime-v1/http-surface.ts` is the single authority for registration and
tests.

The daemon receives caller credentials and a pinned root public key. It never
receives an embedding API key, effect private key, or root private key. A cohort
seed reaches the daemon only by reading the exact protected authority row from
SQLite during assignment; it is never accepted through HTTP or environment,
never returned or logged, and its transient buffer is cleared after HMAC use.
Each worker is a separate process and receives only its role-specific
capability. ANN currently builds immutable segments only; it does not influence
serving decisions.

## Authority and storage rules

- A fresh database is unready until a current, unambiguous compiler/evidence
  policy pair has been installed through the offline provisioner.
- SQLite is the sole authority. Vector and ANN artifacts are rebuildable
  candidates and cannot grant serving authority.
- One local database permits one write transaction at a time. V1 makes no HA or
  distributed-writer claim.
- The dedicated data directory is `0700`; SQLite and its WAL/SHM/journal files
  are `0600`.
- Authority changes require exact evidence, root-signed policy, and CAS. Text
  similarity or an operator click alone cannot create positive learning credit.
- Unknown configuration, ambiguous policy, stale binding, mismatched digest,
  unsafe file posture, and unavailable authority fail closed.

## Decision rule

Keep code when it directly strengthens continuity, learning, forgetting, or
learning control while preserving the narrow daemon and authority closure.

Delete or extract code when it primarily serves an external framework,
deployment authority, fixed experiment protocol, benchmark, UI, sample,
compatibility layer, or offline analysis workflow.

Single-task failures may produce scoped evidence or a candidate hypothesis.
They must not become Runtime source rules without repeated cross-task evidence
that the change generalizes and simplifies the existing system.

## Release boundary

V1 is releaseable only from a clean exact commit for which:

1. `npm run check` and `npm run build` pass;
2. the schema manifest matches the shipped SQL;
3. a fresh database is provisioned with external root-signed policies;
4. liveness and readiness semantics are verified separately;
5. crash/reopen, permission, idempotency, and ordered-shutdown evidence passes;
6. the five product routes and two probes exactly match the governed inventory;
7. the image contains compiled output, production dependencies, and required
   license notices only, runs non-root, and contains no credential or private
   key;
8. the single-host, single-SQLite-writer beta limitations are stated without an
   HA or production-scale claim;
9. a protected real-Agent pilot on that exact commit demonstrates verifier-safe
   behavior and a measurable advantage over baseline and observe-only controls;
10. the frozen split delivery boundary is verified from clean artifacts: the
    zero-runtime-dependency SDK npm package contains no Runtime/SQL/tooling, the
    runnable non-root OCI Runtime contains no Aionis SDK, repository source,
    repository tooling, declaration, or source-map file, and neither artifact
    has dangling repository-only commands; and
11. the same commit completes a 24–36 hour bounded soak without integrity,
    recovery, shutdown, queue, or authority drift.

Passing the internal gates alone makes a build a release candidate. It is not
evidence that Aionis improves real Agent outcomes; the external and delivery
gates above are required before an effectiveness or operational-readiness
claim.
