# Aionis Continuation Runtime V1

Aionis compiles the smallest verified execution state an Agent needs for its
next action, records exactly which state influenced that action, learns only
from bound outcomes, and changes serving authority only through explicit
evidence.

This repository is the clean-break V1 Runtime. It is not compatible with the
v0.3.x Lite, MCP, guide, or installer surfaces, and it does not migrate their
databases. Start V1 with a fresh dedicated database.

The Runtime and SDK candidates are currently `1.0.0-alpha.1`. The operational
boundary is a single-host beta: one authoritative SQLite database, one write
transaction at a time, no HA, no multi-host shared filesystem, and no rolling
schema migration. The root manifest is a private OCI build manifest, not an npm
artifact. The separate SDK package also remains private until the exact-commit
real-Agent pilot and bounded soak in the release boundary have passed.

The canonical design is
[AIONIS_CONTINUATION_RUNTIME_V1.md](docs/architecture/AIONIS_CONTINUATION_RUNTIME_V1.md);
the convergence boundary is [FOCUS.md](docs/FOCUS.md).

## What V1 provides

- verified observations and immutable execution capsules;
- deterministic continuation contracts with explicit selected and excluded
  evidence;
- exact exposure, use, outcome, and effect attribution;
- isolated candidate branches and evidence-gated authority changes;
- controlled forgetting with rebuildable sidecars outside authority;
- durable, idempotent operations and role-confined background work;
- structural decision reads, including bounded counterfactual views.

The daemon owns no embedding provider credential, effect-signing private key,
or authority-root private key. Offline policy authors sign authority artifacts
outside Runtime. The daemon and every worker receive only the capability their
role requires.

## Public surface

The HTTP server registers exactly five product routes and two unauthenticated
probes. Fastify's implicit `HEAD` routes are disabled.

| Method | Path | Principal | Purpose |
|---|---|---|---|
| `POST` | `/v1/observations` | trusted host | Record current-world and memory-input evidence |
| `POST` | `/v1/continuations` | trusted host | Compile and persist one continuation decision |
| `POST` | `/v1/outcomes` | trusted host | Bind use and outcome evidence to a decision |
| `POST` | `/v1/authority-decisions` | operator | Apply an explicit authority transition |
| `GET` | `/v1/decisions/:decision_id` | trusted host or operator | Read summary, full, or counterfactual decision state |
| `GET` | `/healthz` | none | Process liveness |
| `GET` | `/readyz` | none | Signed-policy readiness |

All product requests use exactly one `Authorization: Bearer <token>` header.
Host and operator tokens must be distinct and at least 32 bytes. Request bodies
and query selectors are exact contracts: unknown fields fail closed.

`GET /healthz` returns `200` when the process is serving HTTP. It does not mean
the Runtime can compile a continuation. `GET /readyz` returns:

- `200 ready` when the database identity is valid and at least one
  non-expired, unambiguous compiler/evidence policy pair can be resolved under
  the pinned root for the configured tenant;
- `503 not_ready` for a fresh database, missing or expired policies, ambiguity,
  or a failed authority check. The response includes stable `reason_codes`.

There is no unsigned built-in policy and no readiness override.

## Requirements

- Node.js `>=22.15.0 <23` or `>=24.0.0 <25` (CI verifies the Node 22.15 and
  Node 24.0 lower bounds plus the current Node 24 release; non-LTS Node 23 and
  untested future majors are rejected);
- Linux or macOS on a local POSIX filesystem; the native Runtime is not
  supported on Windows because its ownership, mode, no-follow, signal, and
  SQLite recovery guarantees cannot be enforced there;
- a local filesystem that provides normal ownership, mode, rename, lock, and
  `fsync` semantics;
- an Ed25519 authority-root public key and its SHA-256 SPKI digest;
- separately generated host and operator bearer tokens;
- signed V1 compiler and evidence policy artifacts produced outside Runtime.

Do not place the database on NFS or another shared/network filesystem. V1 is a
single-host SQLite authority, not a distributed database.

## Build and verify

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run build:sdk
```

`npm run check` enforces the strict no-legacy complexity ratchet, verifies its
gate implementation and generated schema manifest, typechecks the V1 closure,
and runs the complete V1 test suite. `npm run build` replaces `dist/`, compiles
only the V1 source closure, and copies the pinned SQL and schema manifest into
`dist/store/sql/`. `npm run build:sdk` derives the exact SDK closure into
`packages/sdk/dist/`. CI packs only `packages/sdk`, installs that tarball into
fresh JavaScript and strict TypeScript consumers, and verifies its exact
two-export/five-method surface. The Runtime itself is built and tested as the
hardened OCI image; the repository root is never treated as an npm artifact.

## Offline provisioning

Provision before starting product traffic. A fresh database has the exact V1
schema identity but no signed policy authority, and remains unready until a
root-signed compiler/evidence policy bundle is installed.

The one-shot provisioner allowlists exactly these three base environment
fields, plus cohort-only `AIONIS_PROVISIONING_SEED_FD`:

```bash
export AIONIS_DATA_PATH=/absolute/path/to/private/aionis/runtime.sqlite
export AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH=/absolute/path/to/root-public.pem
export AIONIS_TRUST_ROOT_SHA256=<64-lowercase-hex-spki-digest>
```

`AIONIS_PROVISIONING_SEED_FD` is allowed only for cohort installation. The
provisioner reads one canonical JSON command from stdin, bounded to 4 MiB, then
closes SQLite before exiting. It accepts three command kinds:

- `policy_bundle_install` — installs one compiler/evidence policy pair;
- `experiment_cohort_install` — installs a signed cohort and a separately
  supplied 32-byte assignment seed;
- `policy_rotation_install` — installs a signed policy rotation.

Each JSON command has schema `offline_provisioning_command_v1` and binds
`tenant_id`, `scope`, `task_family`, `operation_id`, `actor_kind: "operator"`,
`actor_principal_sha256`, and `authority_subject_sha256`. Runtime never accepts
an authority-root private key.

The repository-local authoring sources are first compiled without a private key
into a deterministic plain-Node closure. The build writes a canonical manifest
with every file digest and one `closure_sha256`; review and record that manifest
before opening the root-key descriptor:

```bash
REPOSITORY_ROOT="$PWD"
NODE_BIN="$(node -p 'process.execPath')"
case "$NODE_BIN" in /*) ;; *) exit 1 ;; esac
AUTHORITY_BUILD_STATUS="$("$NODE_BIN" tools/build-continuation-runtime-v1-authority.mjs)"
cat dist-authority/authority-build-manifest.canonical.json
AUTHORITY_AUTHOR="$REPOSITORY_ROOT/dist-authority/tools/author-continuation-runtime-v1-authority.js"
PROVISIONER="$REPOSITORY_ROOT/dist/runtime-v1/provisioning-entry.js"
```

The compiled entry is the official offline authoring boundary. It accepts one bounded canonical
`offline_authority_authoring_request_v1` on stdin and the Ed25519 PKCS#8 root
private key only on inherited file descriptor 3. It derives the authority
subject and operator principal digest, validates every payload binding and
validity window, signs with the existing V1 artifact contract, self-verifies
the signatures, and writes only the seedless canonical provisioning command to
stdout. Replaying the same request bytes with the same key produces identical
output.

Create the two role-separated key pairs in a fresh private directory. This
Linux/macOS plain-Node tool uses exclusive creation, makes the directory `0700`
and all four source key files `0600`, and prints only public digests and safe
status. The destination must not already exist, so it cannot overwrite a root:

```bash
AUTHORITY_DIR="$HOME/.aionis-authority-v1"
KEY_STATUS="$(/usr/bin/env -i "$NODE_BIN" \
  "$REPOSITORY_ROOT/tools/generate-continuation-runtime-v1-authority-keys.mjs" \
  "$AUTHORITY_DIR")"

TRUST_ROOT_PUBLIC_KEY_PATH="$AUTHORITY_DIR/root-public.pem"
EFFECT_SIGNER_PRIVATE_KEY_PATH="$AUTHORITY_DIR/effect-private.pem"
TRUST_ROOT_SHA256="$(node -e '
  process.stdout.write(JSON.parse(process.argv[1]).trust_root_sha256)
' "$KEY_STATUS")"
EFFECT_SIGNER_SHA256="$(node -e '
  process.stdout.write(JSON.parse(process.argv[1]).effect_signer_sha256)
' "$KEY_STATUS")"
test "$EFFECT_SIGNER_SHA256" != "$TRUST_ROOT_SHA256"
```

The tracked [canonical policy authoring request](docs/examples/continuation-runtime-v1-policy-bundle-authoring-request.canonical.json)
is a schema-valid canonical template, not deployment authority. Its repeated
`1`/`2` digests are deliberately invalid placeholders. Derive the authenticated
host principal with the same shared function used by HTTP authentication, and
derive the effect-verifier principal from the dedicated effect key's SPKI:

```bash
export AIONIS_TENANT_ID=tenant-1
export AIONIS_HOST_PRINCIPAL_ID=host-1
export AIONIS_OPERATOR_PRINCIPAL_ID=operator-1
AIONIS_SCOPE=default
AIONIS_TASK_FAMILY=coding

HOST_PRINCIPAL_SHA256="$(node --import tsx --input-type=module -e '
  import { continuationRuntimeV1PrincipalSha256 } from "./src/runtime-v1/auth.ts";
  process.stdout.write(continuationRuntimeV1PrincipalSha256({
    tenant_id: process.argv[1], principal_kind: "trusted_host",
    principal_id: process.argv[2],
  }));
' "$AIONIS_TENANT_ID" "$AIONIS_HOST_PRINCIPAL_ID")"
AUTHORITY_SUBJECT_SHA256="$(node --import tsx --input-type=module -e '
  import { continuationAuthoritySubjectSha256V1 } from "./src/continuation/task-envelope.ts";
  process.stdout.write(continuationAuthoritySubjectSha256V1({
    tenant_id: process.argv[1], scope: process.argv[2], task_family: process.argv[3],
  }));
' "$AIONIS_TENANT_ID" "$AIONIS_SCOPE" "$AIONIS_TASK_FAMILY")"
```

Create a deployment request from the template and rewrite it with the Runtime's
own canonical JSON implementation. This command updates every repeated
tenant/subject/principal binding together; it does not touch a private key:

```bash
POLICY_TEMPLATE=docs/examples/continuation-runtime-v1-policy-bundle-authoring-request.canonical.json
POLICY_REQUEST="$AUTHORITY_DIR/policy-bundle-authoring-request.canonical.json"
node --import tsx --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { canonicalContinuationJson } from "./src/continuation/contract.ts";
  const [source, destination, tenant, scope, family, operator, host, effect, subject]
    = process.argv.slice(1);
  const request = JSON.parse(readFileSync(source, "utf8"));
  Object.assign(request, {
    tenant_id: tenant, scope, task_family: family, operator_principal_id: operator,
  });
  for (const draft of [request.compiler_policy, request.evidence_policy]) {
    draft.payload.tenant_id = tenant;
    draft.payload.authority_subject_sha256 = subject;
  }
  request.compiler_policy.payload.trusted_observer_principals = {
    trusted_host_collector: [host], external_verifier: [],
  };
  request.evidence_policy.payload.trusted_effect_verifier_principals = [effect];
  writeFileSync(destination, canonicalContinuationJson(request) + "\n", { mode: 0o600 });
' "$POLICY_TEMPLATE" "$POLICY_REQUEST" \
  "$AIONIS_TENANT_ID" "$AIONIS_SCOPE" "$AIONIS_TASK_FAMILY" \
  "$AIONIS_OPERATOR_PRINCIPAL_ID" "$HOST_PRINCIPAL_SHA256" \
  "$EFFECT_SIGNER_SHA256" "$AUTHORITY_SUBJECT_SHA256"
```

Install a policy bundle:

```bash
POLICY_COMMAND="$AUTHORITY_DIR/policy-bundle-install.canonical.json"
/usr/bin/env -i /bin/sh -c '
  exec "$1" "$2" 3<"$3" <"$4" >"$5"
' authority-sign "$NODE_BIN" "$AUTHORITY_AUTHOR" \
  "$AUTHORITY_DIR/root-private.pem" "$POLICY_REQUEST" "$POLICY_COMMAND"

DATA_PATH=/absolute/path/to/private/aionis/runtime.sqlite
/usr/bin/env -i \
  AIONIS_DATA_PATH="$DATA_PATH" \
  AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH="$TRUST_ROOT_PUBLIC_KEY_PATH" \
  AIONIS_TRUST_ROOT_SHA256="$TRUST_ROOT_SHA256" \
  "$NODE_BIN" "$PROVISIONER" < "$POLICY_COMMAND"
```

The request is strict at both the top level and each unsigned artifact draft:
unknown fields, noncanonical JSON, payload schema/binding errors, invalid
windows, and files above 1 MiB are rejected before any output. A regular FD 3
key must be a single-link file owned by the current uid or root with exact mode
`0400` or `0600`; a bounded inherited FIFO secret broker is accepted only with
the same owner, link-count, and exact-mode posture.
Errors use stable safe codes on stderr and never echo request, path, or key
material.

Install a cohort. Start by generating a fresh independent seed; the tool uses
exclusive creation, exact mode `0600`, 32 cryptographically random bytes, and
prints only its public commitment:

```bash
COHORT_SEED="$AUTHORITY_DIR/cohort-assignment-seed.bin"
SEED_STATUS="$(/usr/bin/env -i "$NODE_BIN" \
  "$REPOSITORY_ROOT/tools/generate-continuation-runtime-v1-cohort-seed.mjs" \
  "$COHORT_SEED")"
ASSIGNMENT_SEED_COMMITMENT_SHA256="$(node -e '
  process.stdout.write(JSON.parse(process.argv[1]).assignment_seed_commitment_sha256)
' "$SEED_STATUS")"
```

The seed must not appear in JSON, arguments, environment
values, operation receipts, or logs; pass exactly 32 raw bytes on an inherited
descriptor. Regular files and FIFOs must be single-link, use exact mode `0400`
or `0600`, and be owned by the Runtime process uid or root. The provisioner
fences descriptor identity before and after its bounded read; regular files
must additionally contain exactly 32 bytes:

```bash
COHORT_TEMPLATE=docs/examples/continuation-runtime-v1-experiment-cohort-authoring-request.canonical.json
COHORT_REQUEST="$AUTHORITY_DIR/cohort-authoring-request.canonical.json"
# First rewrite $COHORT_TEMPLATE into $COHORT_REQUEST with the actual refs and
# commitment described below, using canonicalContinuationJson.
COHORT_COMMAND="$AUTHORITY_DIR/cohort-install.canonical.json"
/usr/bin/env -i /bin/sh -c '
  exec "$1" "$2" 3<"$3" <"$4" >"$5"
' authority-sign "$NODE_BIN" "$AUTHORITY_AUTHOR" \
  "$AUTHORITY_DIR/root-private.pem" "$COHORT_REQUEST" "$COHORT_COMMAND"

/usr/bin/env -i /bin/sh -c '
  export AIONIS_DATA_PATH="$2"
  export AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH="$3"
  export AIONIS_TRUST_ROOT_SHA256="$4"
  export AIONIS_PROVISIONING_SEED_FD=3
  exec "$1" "$5" 3<"$6" <"$7"
' cohort-provision "$NODE_BIN" "$DATA_PATH" "$TRUST_ROOT_PUBLIC_KEY_PATH" \
  "$TRUST_ROOT_SHA256" "$PROVISIONER" "$COHORT_SEED" "$COHORT_COMMAND"
```

The tracked [cohort template](docs/examples/continuation-runtime-v1-experiment-cohort-authoring-request.canonical.json)
and [rotation template](docs/examples/continuation-runtime-v1-policy-rotation-authoring-request.canonical.json)
are schema-valid templates, not ready deployment authority. For a real cohort,
take the authoritative ref from `recordObservations` response
`.result.authority_branch_set.refs[]`, advance the actual candidate through
`draft → shadow → eligible → active_candidate`, and take the final candidate
ref from `.result.branch_revision_set.refs[]`. Map public `branch_state` to the
cohort payload field `state`; bind policy refs from the installed signed policy
command and bind `ASSIGNMENT_SEED_COMMITMENT_SHA256`. Cohort installation fails
closed if the control is no longer the current head or the candidate is not its
active latest child.

Every observation receipt that creates a candidate includes both that draft and
its immutable base authoritative ref, including the head revision and digest
needed for operator CAS. This remains true after genesis already exists;
callers must not depend on retaining the first observation response.

For rotation, install a genuinely changed revision of the compiler/evidence
policy bundle first. A fresh authenticated `readDecision({view: "full"})`
provides `.authority_revisions.authoritative.manifest`: use its branch ref,
old policy refs, and the canonical digest of its `capsule_bindings`; take new
refs from the newly installed signed policy artifacts. After installing the
rotation artifact, pass the provision result's
`policy_rotation_artifact_ref` to online `decideAuthority` with
`kind: "policy_rotate"` and the current expected head. An active cohort freezes
head mutation, so close/settle it before applying rotation.

The same authoring tool supports `experiment_cohort_install` with an
`experiment_cohort` unsigned draft and `policy_rotation_install` with a
`policy_rotation` unsigned draft. Cohort requests must bind the actual installed
policy/branch refs and the commitment of the separately provisioned seed;
rotation requests must bind the actual old/new policy and prior authority refs.
The authoring tool checks those exact schemas, refs, subject, and cohort window.
Use its seedless stdout as the provisioner stdin. For rotation, run the same
authoring command with the canonical rotation request and feed its output to
`start:provision`; no additional secret descriptor is used. Reusing an
`operation_id` is idempotent only when the authenticated canonical request is
identical.

Both descriptor-bearing commands deliberately bypass npm: npm reserves file
descriptor 3 for its own process plumbing and therefore cannot be either the
root-key or assignment-seed boundary. The signer also uses no `tsx`/esbuild
loader after the root key is opened; TypeScript compilation finishes in the
unprivileged pre-key build step. The closure manifest is integrity evidence,
not a substitute for reviewing and pinning the source/compiler supply chain.
The clean environment is established before the inner shell opens FD 3; do not
replace it with a direct inherited-environment Node launch. In particular,
`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, and `DYLD_*` must not enter a secret
process. Begin the ceremony from a trusted host/session and use the reviewed
absolute Node binary recorded above.
`tools/` is neither in the SDK package nor copied into the Docker runtime stage.
Keep the root private key offline after authoring; only the public key and its
SPKI digest belong in Runtime configuration.

## Start the daemon

The direct host commands in this section are for local development and
evaluation only. A parent process can inject `NODE_OPTIONS`, loader state, or
other environment before JavaScript gets a chance to validate it. The hardened
Compose/OCI path below, with its exact per-process environment and capability
mounts, is the only formal secret-bearing deployment path.

Export only daemon fields into the daemon process. Unknown `AIONIS_*` fields,
including worker credentials, abort startup.

```bash
export AIONIS_DATA_PATH=/absolute/path/to/private/aionis/runtime.sqlite
export AIONIS_TENANT_ID=tenant-1
export AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH=/absolute/path/to/root-public.pem
export AIONIS_TRUST_ROOT_SHA256=<64-lowercase-hex-spki-digest>
export AIONIS_HOST_PRINCIPAL_ID=host-1
export AIONIS_HOST_API_KEY=<random-token-at-least-32-bytes>
export AIONIS_OPERATOR_PRINCIPAL_ID=operator-1
export AIONIS_OPERATOR_API_KEY=<different-random-token-at-least-32-bytes>
export AIONIS_HTTP_HOST=127.0.0.1
export AIONIS_HTTP_PORT=3000
export AIONIS_LOG_LEVEL=info

npm run -s start
```

Optional daemon settings are `AIONIS_HTTP_BODY_LIMIT_BYTES` (default
`1048576`) and `AIONIS_SHUTDOWN_TIMEOUT_MS` (default `30000`).

Check the two distinct states:

```bash
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
```

The daemon handles `SIGINT` and `SIGTERM`, stops accepting work, drains the HTTP
server, and closes SQLite within the configured shutdown budget.
Compose fixes its outer stop grace period at `305s`, five seconds beyond the
Runtime's maximum accepted `AIONIS_SHUTDOWN_TIMEOUT_MS=300000`. Normal shutdown
still exits immediately; raising the Runtime drain budget cannot make Docker
send `SIGKILL` before that budget expires.

## Workers

As with the direct daemon command, direct host worker launches are development
and evaluation conveniences, not the formal secret-bearing deployment path.
Use the hardened Compose/OCI services for provider credentials and effect
signing keys.

Each durable role runs as its own process with `npm run -s start:worker` and one
of these exact roles:

| Role | Additional capability | Result |
|---|---|---|
| `embedding` | provider URL, model, dimensions, API key | content-addressed vector artifacts |
| `ann` | none | verified immutable ANN index segments |
| `effect` | dedicated Ed25519 effect-signing key | evidence-bound effect certificates |
| `retention` | none | deletion of authority-approved rebuildable sidecars |

Every worker needs the database path, tenant, pinned root public key, role, and
optional queue timing fields:

```bash
export AIONIS_DATA_PATH=/absolute/path/to/private/aionis/runtime.sqlite
export AIONIS_TENANT_ID=tenant-1
export AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH=/absolute/path/to/root-public.pem
export AIONIS_TRUST_ROOT_SHA256=<64-lowercase-hex-spki-digest>
export AIONIS_WORKER_ROLE=ann
export AIONIS_LOG_LEVEL=info

npm run -s start:worker
```

Queue defaults are `AIONIS_JOB_POLL_MS=250`,
`AIONIS_JOB_BATCH_SIZE=16`, and `AIONIS_JOB_LEASE_MS=60000`.

For `embedding`, all four provider fields are required and are forbidden for
other roles:

```bash
export AIONIS_WORKER_ROLE=embedding
export AIONIS_EMBEDDING_BASE_URL=https://provider.example/v1
export AIONIS_EMBEDDING_MODEL=<model-id>
export AIONIS_EMBEDDING_DIMENSIONS=<positive-integer>
export AIONIS_EMBEDDING_API_KEY=<provider-token>
```

The provider key exists only in this process. The ANN worker consumes verified
vector artifacts and receives no provider credential. V1 ANN is currently
build-only: it creates immutable segments, but decision assembly exposes no
vector-search serving port. Do not claim ANN-backed serving from segment-build
success.

For `effect`, both signer fields are required and forbidden elsewhere:

```bash
export AIONIS_WORKER_ROLE=effect
export AIONIS_EFFECT_SIGNER_PRIVATE_KEY_PATH=/absolute/path/to/effect-ed25519-private.pem
export AIONIS_EFFECT_SIGNER_SHA256=<64-lowercase-hex-spki-digest>
```

The effect key must use exact mode `0400` or `0600` and be an unencrypted
PKCS#8 Ed25519 file. Its public-key digest must not equal the authority-root digest. The root
private key must never enter any Runtime container or process.

## TypeScript SDK

The standalone `@aionis/continuation-sdk` package exports one exact client. It
contains no daemon, worker, SQL, provisioner, or Runtime dependency:

```ts
import { createAionisRuntimeV1Client } from "@aionis/continuation-sdk";

const runtime = createAionisRuntimeV1Client({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.AIONIS_HOST_API_KEY!,
  timeoutMs: 10_000,
  requestBodyLimitBytes: 1_048_576,
  responseBodyLimitBytes: 4_194_304,
});
```

Its surface is exactly:

- `recordObservations`
- `createContinuation`
- `recordOutcome`
- `decideAuthority`
- `readDecision`

Use a host-key client for the first three methods. Use an operator-key client
for `decideAuthority`; either principal can call `readDecision`. The SDK is a
strict bounded transport client. It does not compile policy, infer authority,
or silently translate legacy payloads.

The repository root deliberately exports no npm entry point. Its formal
delivery artifact is the OCI Runtime described below; the SDK tarball is the
only Node consumer artifact.

## Docker and Compose

The Docker image is multi-stage. Its runtime stage contains a content-addressed
closure derived only from the daemon, provisioner, and worker entry points,
the two required schema resources, a minimal script-free package manifest,
production dependencies, `LICENSE`, and `NOTICE`. The closure manifest and CI
fail on any extra Aionis SDK, declaration, source-map, repository-source, or
repository-tooling file. The image runs as the non-root `node` user, writes
only under `/data`, and has no built-in API key, provider credential, private
key, or policy default.

Copy [.env.example](.env.example) to `.env` and fill every value required by
the services you intend to run. Compose passes an exact environment subset to
each process; never add `env_file: .env` to a Runtime service. Secret bind
mounts set `create_host_path: false`, so a missing key or seed path fails before
container startup instead of being silently created as a host directory.

The image runs as `node` (`uid=1000`, `gid=1000`). Do not bind-mount the host
keygen originals directly unless their numeric ownership already matches. Make
deployment copies with the permissions the container can actually open. In a
standard rootful Docker deployment, the trust-root public key may be
`root:root 0444`; the effect private key and cohort seed must be private files
owned by `1000:1000`. The root private key is never copied:

```bash
COMPOSE_SECRET_DIR=/absolute/private/path/aionis-compose-secrets
sudo install -d -o root -g root -m 0700 "$COMPOSE_SECRET_DIR"
sudo install -o root -g root -m 0444 \
  "$AUTHORITY_DIR/root-public.pem" "$COMPOSE_SECRET_DIR/root-public.pem"
sudo install -o 1000 -g 1000 -m 0400 \
  "$AUTHORITY_DIR/effect-private.pem" "$COMPOSE_SECRET_DIR/effect-private.pem"
sudo install -o 1000 -g 1000 -m 0400 \
  "$AUTHORITY_DIR/cohort-assignment-seed.bin" "$COMPOSE_SECRET_DIR/cohort-seed.bin"

export TRUST_ROOT_PUBLIC_KEY_FILE="$COMPOSE_SECRET_DIR/root-public.pem"
export EFFECT_SIGNER_PRIVATE_KEY_FILE="$COMPOSE_SECRET_DIR/effect-private.pem"
export COHORT_SEED_FILE="$COMPOSE_SECRET_DIR/cohort-seed.bin"
```

For rootless Docker or user-namespace remapping, replace `1000:1000` with the
host numeric ids mapped to container uid/gid `1000`. Create the secret
directory under, and as `0700` owned by, the rootless daemon user as well; a
root-owned `0700` parent is not traversable by that daemon. Verify the resulting
ownership from inside the container namespace before provisioning.

Build the image:

```bash
docker compose build
```

Provision the fresh named volume before daemon traffic:

```bash
docker compose --profile provision run --rm -T provision \
  < "$POLICY_COMMAND"
```

Provisioning does not require tenant, host, or operator daemon fields. Compose
leaves fields that belong only to dormant services empty so one profile cannot
force another role's configuration. Attempting to start the daemon or a worker
still fails closed until every field required by that process is configured.

For cohort installation, set `COHORT_SEED_FILE` to an absolute path containing
exactly 32 bytes. The standard Compose path above uses container-visible owner
`1000:1000` and mode `0400`; a root-owned private file is not readable by the
non-root container process merely because the descriptor validator permits a
root owner. Then run:

```bash
docker compose --profile provision run --rm -T provision-cohort \
  < "$COHORT_COMMAND"
```

Start the daemon and inspect both probes:

```bash
docker compose up -d daemon
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
```

`docker compose up` is deliberately not a one-command bootstrap. It does not
generate keys, sign policies, provision authority, or force readiness.

Enable only the worker profiles whose capabilities you have configured:

```bash
docker compose --profile embedding up -d worker-embedding
docker compose --profile ann up -d worker-ann
docker compose --profile effect up -d worker-effect
docker compose --profile retention up -d worker-retention
```

All services share one local named volume and therefore one authoritative
SQLite database. SQLite serializes write transactions; these services are not
an HA or multi-writer cluster. Back up and restore the database and its WAL/SHM
namespace as one unit while Runtime is stopped.

Compose gives network access only to the HTTP daemon and the embedding worker.
The provisioners and the `ann`, `effect`, and `retention` workers run with
`network_mode: none`; in particular, the process holding the effect-signing
private key has no network namespace.

## Data and release boundary

Runtime creates the dedicated database directory as `0700` and the SQLite
database, WAL, SHM, and rollback journal as `0600`. Startup rejects unsafe
ownership, symlinks, unexpected sidecars, schema drift, a mismatched trust-root
pin, unknown `AIONIS_*` fields, and capability-bearing fields in the wrong
process.

V1 intentionally has:

- no v0.3.x compatibility aliases or database migration;
- no unauthenticated product mode;
- no MCP or external-Agent framework runtime surface;
- no hosted control plane or HA guarantee;
- no ANN serving path yet;
- no authority-root private key inside Runtime.

The delivery boundary is deliberately split: a runnable, non-root OCI Runtime
and a zero-runtime-dependency SDK npm package. Neither artifact contains the
other, and both remain unpublished candidates until the external release gates
pass on one clean exact commit.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
