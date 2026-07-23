# Security Policy

## Supported versions

Security fixes target the current Continuation Runtime V1 `main` branch and the
latest V1 package/image when one is published. The project is pre-1.0 and does
not promise backports. v0.3.x Lite, MCP, and database surfaces are unsupported
and are not compatibility targets.

## Deployment boundary

V1 is a self-managed, single-host Runtime around one authoritative SQLite
database. It is not a hosted control plane, HA service, distributed writer, or
network-filesystem deployment.

The native Runtime supports Linux and macOS only. Windows cannot provide the
POSIX uid, mode, no-follow, signal, and SQLite artifact guarantees this release
enforces, so database open and secret-bearing entry points fail closed there.

The daemon defaults to loopback and has no unauthenticated product mode. Every
product request requires exactly one bearer credential:

- a trusted-host key for observations, continuations, and outcomes;
- an operator key for authority decisions;
- either key for decision reads.

The keys must be distinct and at least 32 bytes. `/healthz` and `/readyz` are
the only unauthenticated routes; they return bounded operational state and no
tenant, principal, path, credential, policy payload, or memory content. The
server exposes exactly five product routes plus these two probes and registers
no implicit `HEAD` routes.

Do not publish the daemon directly to an untrusted network. Bind to loopback or
place it behind a trusted transport and network boundary. V1 does not itself
terminate TLS or provide a cloud identity layer.

## Capability separation

- The daemon receives host/operator credentials and the pinned authority-root
  public key. It receives no provider API key or private signing key.
- Offline provisioning receives canonical signed artifacts, the public root,
  and—only for cohort install—a 32-byte seed over a separate inherited file
  descriptor. It never receives the root private key.
- The `embedding` worker alone receives the embedding provider credential from
  a single-link owner-private stable file. The raw credential is excluded from
  process and container environment and its worker-owned buffer is destroyed
  after in-flight work drains.
- The `effect` worker alone receives a dedicated owner-private Ed25519 signing
  key. That key must not reuse the authority root. The provided Compose profile
  also removes networking from this worker.
- `ann` and `retention` workers receive neither provider nor signing secrets.

The provided Compose configuration uses `network_mode: none` for both
provisioners and the `ann`, `effect`, and `retention` workers. Only the HTTP
daemon and the provider-calling `embedding` worker retain network access.

The per-cohort assignment seed is provisioned over the separate descriptor and
stored only in the protected SQLite authority row. The daemon may read that
exact seed transiently to derive an HMAC assignment; it does not accept the seed
through HTTP or environment, and does not return or log it.

Each process rejects unknown `AIONIS_*` fields and rejects role-specific fields
in the wrong process. Do not use a shared `env_file` across Runtime roles.

Generate and sign authority artifacts outside Runtime. Never copy the
authority-root private key into the repository, image, Compose file, named
volume, Runtime environment, or Runtime host directory.

## Local data posture

Runtime requires a dedicated local data directory. It enforces mode `0700` on
that directory and `0600` on the SQLite database, WAL, SHM, and rollback
journal. It rejects symlink substitution, unsafe ownership/modes, unexpected
bootstrap sidecars, schema drift, and trust-root pin mismatch.

Run the image as its non-root `node` user. Mount public and private key files
read-only. The effect private key must remain exact `0400` or `0600`; a
world-readable container secret is deliberately rejected.

SQLite authority and its sidecars form one recovery unit. Stop all Runtime
processes before filesystem-level backup or restore. Do not split, copy, or
restore the database independently of an active WAL/SHM namespace.

The provided Compose services use a fixed `305s` stop grace period, which is
longer than Runtime's maximum accepted `300000ms` drain budget. Shortening the
outer container grace below the configured Runtime timeout can turn an orderly
close into `SIGKILL` and is unsupported.

## Fail-closed behavior

A fresh database is alive but not ready. `/readyz` remains `503` until a
current, unambiguous compiler/evidence policy pair signed under the pinned root
is available for the configured tenant. There is no unsigned default, forced
readiness flag, database migration, or compatibility bootstrap.

ANN artifacts and embeddings are rebuildable sidecars, not authority. ANN
segment generation is currently build-only and cannot influence decision
serving. Authority changes require exact evidence bindings, signed policy, and
CAS; similarity alone cannot grant direct-use authority.

## What to report

Please report issues that can affect confidentiality, integrity, authority, or
availability, including:

1. authentication bypass or principal confusion on any of the five routes;
2. memory, observation, decision, episode, policy, cohort, or effect poisoning;
3. a way to bypass signed-policy, digest, subject, use, outcome, or CAS binding;
4. private-key, provider-key, bearer-token, cohort-seed, path, or raw-payload
   leakage through responses, logs, receipts, or job failures;
5. unsafe database permissions, symlink races, WAL/SHM recovery errors, or
   cross-tenant access;
6. a worker consuming another role's job or receiving another role's secret;
7. denial-of-service against provisioning, product routes, durable jobs, or
   ordered shutdown; and
8. package or container behavior that executes or includes unexpected source,
   credentials, or private material.

## Reporting

Do not open a public issue for a suspected vulnerability. Contact the repository
maintainers privately and include:

1. an impact summary;
2. the affected exact commit, package/image version, route, process role, or
   artifact kind;
3. minimal reproduction steps;
4. expected versus actual behavior; and
5. only the redacted logs or proof needed to verify the issue.

Do not include live credentials, private keys, cohort seeds, or user memory in
the report. Until a dedicated security inbox and SLA are published, coordinate
disclosure timing directly with the maintainers.
