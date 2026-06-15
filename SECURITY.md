# Security Policy

## Supported Versions

Aionis currently ships as a local-first Lite Runtime plus SDK and MCP packages.
Security fixes target the current `main` branch and the latest published npm
packages. Older pre-1.0 package versions are not guaranteed to receive
backports.

## Deployment Boundary

Lite is designed for developer machines, local agent hosts, and self-managed
deployments behind your own boundary. It is not a hosted multi-tenant production
control plane. By default Lite runs on loopback, uses `MEMORY_AUTH_MODE=off`,
and disables tenant quota enforcement.

Do not expose an unauthenticated Lite Runtime to an untrusted network. If you
intentionally bind it to a remote interface, put it behind your own network
controls, authentication, and logging.

## What To Report

Please report issues that can affect memory integrity, operator trust, local
data confidentiality, or Runtime availability, including:

1. memory poisoning or stale/failed memory reaching direct-use context
2. unauthorized access to local memory stores, snapshots, traces, or archives
3. remote exposure of an unauthenticated Lite Runtime
4. prompt/context injection that bypasses Aionis admission decisions
5. denial-of-service vectors against write, guide, recall, or rehydrate routes
6. package installation behavior that executes unexpected code

## Reporting

If you discover a security issue, do not open a public issue first.

Report it privately to the maintainers with:

1. impact summary
2. affected surface, package, route, or command
3. reproduction steps
4. expected versus actual behavior
5. any proof-of-concept or logs needed to verify the issue

Until a dedicated security inbox is published, coordinate through the repository
maintainers directly and avoid public disclosure before triage.

## Triage Expectations

The project is pre-1.0 and does not yet publish a formal security SLA. The
maintainers will prioritize issues that allow unauthorized memory access,
remote execution, memory poisoning, or direct-use leakage of suppressed memory.
