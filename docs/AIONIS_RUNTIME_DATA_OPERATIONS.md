# Aionis Runtime SQLite Data Operations

This runbook covers the authoritative SQLite database configured by
`LITE_WRITE_SQLITE_PATH` and the non-authoritative replay mirror configured by
`LITE_REPLAY_SQLITE_PATH`. Backup, restore, preflight, and verify operate on the
write authority. Upgrade can additionally verify and harden the replay mirror
before either database is opened by the new Runtime.

The commands below do not call an embedding provider or ANN service. Projection
repair creates durable work that the normal Runtime worker later executes.

## Safety model

- Runtime SQLite paths must live inside a dedicated data directory (for example
  `/var/lib/aionis/runtime.sqlite` or `.tmp/runtime.sqlite`). A bare filename,
  SQLite URI, filesystem root, shared sticky directory such as `/tmp`, or a
  symbolic-link main/sidecar file fails closed instead of changing a shared
  parent or following the link. The operator must also ensure that untrusted
  local users cannot replace or rename that directory through a writable
  ancestor; Runtime validates the dedicated directory, not the full ancestor
  chain. The offline upgrade also does not claim protection from a malicious
  process running as the same operating-system user; such a process already
  has owner access to the Runtime data.
- On POSIX hosts, startup creates a missing Runtime data directory as `0700`
  and safely narrows an existing owner-controlled directory to `0700`. A new
  SQLite main file is pre-created as `0600` before SQLite opens it, and newly
  created WAL, SHM, and rollback-journal files must also verify as `0600`.
  Runtime does not change the process-wide umask.
- Before either SQLite database opens, startup requires the complete reserved
  write and replay path sets—main, `-wal`, `-shm`, and `-journal`—to be
  mutually exclusive under a conservative filesystem key that first resolves
  the nearest existing ancestor by realpath, then applies NFC normalization
  and case-insensitive comparison. Database names distinguished only by case or
  Unicode normalization are therefore rejected on every platform. Startup
  path/mode validation also rejects every existing SQLite main or sidecar
  artifact whose hard-link count is not exactly one.
- Startup does not reopen and chmod existing SQLite main, WAL, SHM, or
  rollback-journal files while SQLite connections may be active. An existing
  file with an incorrect POSIX mode fails closed and is left unchanged. Stop
  Runtime and run the explicit offline `upgrade` operation to harden legacy
  artifacts before opening the database.
- POSIX `0700`/`0600` mode checks are not a Windows ACL guarantee. This runbook
  does not claim equivalent Windows access control; a Windows deployment must
  provide and validate an owner-private volume/ACL policy separately.
- The first `SIGTERM` or `SIGINT` stops HTTP service through Fastify `app.close`,
  waits for active workers and sandbox finalization, closes every store, and
  exits `0` after a clean drain. A second signal or the 30-second shutdown
  deadline forces exit using the corresponding `128 + signal` status.
- Runtime startup performs a schema preflight before write/projection schema
  changes. The unversioned v0.3.4 layout and structurally complete versions
  v2-v5 are accepted for upgrade. A future, malformed, or partially missing
  schema fails closed.
- When `--replay-db` is supplied, upgrade first descriptor-safely narrows each
  dedicated database directory to `0700`, then binds the write/replay main
  files and existing WAL/SHM/journal files by device and inode before opening
  SQLite. The complete write and replay artifact namespaces—each database's
  main, WAL, SHM, and journal identities—must be mutually exclusive. It
  requires SQLite integrity, zero foreign-key violations, and exactly four
  schema objects: the canonical `lite_replay_nodes` v1 table, its two canonical
  non-unique indexes, and the sole `sqlite_autoindex_lite_replay_nodes_1`
  primary-key autoindex with null SQL. Any other object fails closed. Pathname,
  symlink, hard-link, identity overlap, or sidecar drift fails before file
  hardening or write-schema mutation. A sidecar created by SQLite during
  read-only validation is added to the binding and hardened.
- Upgrade preserves business rows. Schema v6 may add an authority-adoption
  commit that transactionally seals older terminal rows; this exact migration
  delta is not a loss or duplication of pre-existing memory.
- Backup uses SQLite `VACUUM INTO`, so committed WAL state is included in one
  consistent standalone database file. Never back up by copying only the main
  `.sqlite` file while Runtime is running.
- The backup command covers only `LITE_WRITE_SQLITE_PATH`; it does not capture
  the replay mirror or ANN files. Before a release upgrade, also preserve an
  immutable snapshot of the entire stopped Runtime data volume. That full
  snapshot is the rollback point for the old binary.
- Restore never overwrites a live database. It creates and verifies a new path;
  the operator switches `LITE_WRITE_SQLITE_PATH` only after validation.
- Projection repair rebuilds intent from current SQLite node state and current
  `commit_id`. It never blindly replays an old or corrupt payload.

All commands emit JSON. A command error exits with status `1`; `preflight` or
`verify` exits with status `2` when it successfully produced a report that is
not safe to continue with.

## Supported schema transitions

The current write/projection target is schema v6. Its accepted sources are:

- the unversioned v0.3.4 commit/node/edge layout;
- `supported_previous_v2`;
- `supported_previous_v3`;
- `supported_previous_v4`;
- `supported_previous_v5`;
- `current` (an idempotent offline verification/hardening run).

A previous-version classification is granted only after the complete structural
contract for that version passes. Hybrid, partial, malformed, or future schemas
remain `incompatible`; `CREATE IF NOT EXISTS` is not used to bless them.
`uninitialized` is also rejected by the explicit upgrade command so a mistyped
empty database path cannot be silently initialized as a successful upgrade.

## 1. Preflight

```bash
npx tsx scripts/runtime-data-ops.ts preflight \
  --db /var/lib/aionis/runtime.sqlite
```

Expected classifications:

- `legacy_v0_3_4`: supported and needs upgrade;
- `supported_previous_v2` through `supported_previous_v5`: supported and need
  an explicit offline upgrade;
- `current`: no schema upgrade needed;
- `uninitialized`: no write schema exists yet; do not run `upgrade` against it;
- `incompatible`: stop. Do not start Runtime or run upgrade against this file.

Preflight is read-only with respect to application tables. Runtime also runs
the same preflight automatically whenever the write store opens.

## 2. Create a consistent backup

Use a new destination name for every backup:

```bash
npx tsx scripts/runtime-data-ops.ts backup \
  --db /var/lib/aionis/runtime.sqlite \
  --out /var/backups/aionis/runtime-2026-07-12.sqlite
```

The operation:

1. verifies the source database;
2. creates a SQLite-consistent snapshot with `VACUUM INTO`;
3. verifies the snapshot independently;
4. writes `runtime-2026-07-12.sqlite.manifest.json` containing its byte size,
   SHA-256 digest, schema version, and semantic row counts.

The write-authority backup can run while Runtime is serving traffic. For a
release upgrade, stop Runtime after that backup, take an immutable snapshot of
the complete data volume, and keep Runtime stopped until upgrade finishes. The
complete snapshot must include write SQLite sidecars, replay SQLite sidecars,
and any ANN files present in the deployment.

## 3. Upgrade supported data

With Runtime stopped and a verified backup available:

```bash
npx tsx scripts/runtime-data-ops.ts upgrade \
  --db /var/lib/aionis/runtime.sqlite \
  --replay-db /var/lib/aionis/replay.sqlite

npx tsx scripts/runtime-data-ops.ts verify \
  --db /var/lib/aionis/runtime.sqlite
```

`upgrade` is the explicit offline permission-hardening path for existing POSIX
databases. It first restricts each owner-controlled dedicated directory to
`0700`, then validates both identity-bound files read-only before schema mutation and
hardens the bound main/WAL/SHM/journal artifacts to `0600`. `mode_before` and
`mode_after` in the replay report describe the main file; sidecars are enforced
as a postcondition. On Windows these mode fields are `null` and make no ACL
claim. Do not run this operation while Runtime or another SQLite process has
either database open.

Omit `--replay-db` only when replay persistence is deliberately disabled or no
replay database exists. If the deployment configures `LITE_REPLAY_SQLITE_PATH`,
the release upgrade must supply that exact path.

The upgrade report must show:

- `before.classification` is `legacy_v0_3_4`, a supported previous version, or
  `current`;
- `after.classification` is `current`;
- `replay_database.quick_check` is exactly `["ok"]`, its foreign-key violation
  count is zero, all replay table-definition, column/primary-key, and index
  booleans are `true`, and its schema is exactly the canonical table, two
  explicit indexes, and sole primary-key autoindex described above;
- every `preserved_counts` field except `commits` is unchanged;
- `commits.after` equals `commits.before` plus the exact increase in
  `commit_authority.adoption_manifest_count` reported by before/after
  verification.

Do not proceed if `verify.ok` is false. Warnings about legacy pending
projections or dead letters are handled in the next section; they are not
SQLite corruption.

Three authority warnings are intentionally more conservative. A
`memory_commit_authority_legacy_opaque_rows_present` warning means rows adopted
from v1 history cannot be reconstructed from a canonical v2 mutation.
`runtime_operation_receipts_use_delegated_authority` means operation receipts
are checked by their product or learning ledger rather than directly claimed
by the memory commit chain. `memory_commit_authority_v5_adoption_present` means
the v6 migration transactionally enumerated and sealed historical v5 terminal
rows in an exact adoption manifest instead of rewriting their original
evidence. These warnings are not corruption, but a formal release audit must
count and explain all three instead of describing an upgraded database as
entirely native-v2 history.

`verify` also runs the same full-history integrity audit used when the real
execution state and execution tree stores start. It rejects a current
projection that differs from the latest event, invalid or broken event chains,
revision gaps/mismatches, duplicate revisions, and orphan events. An invalid
pending/retry/running/dead-letter projection payload is likewise a hard
verification failure. `backup` runs this verification against both its source
and the resulting snapshot, so it will not bless either form of corruption.

## 4. Inspect projection state

List repairable state without exposing stored embedding text:

```bash
npx tsx scripts/runtime-data-ops.ts projection-list \
  --db /var/lib/aionis/runtime.sqlite \
  --status pending,retry,running,dead_letter \
  --limit 500
```

Optional filters:

```text
--kind embedding_generate,ann_reconcile
--scope INTERNAL_SCOPE_KEY
--node NODE_ID
```

`legacy_pending` means a node has `embedding_status='pending'` but no durable
embedding job. The report classifies each node:

- `recoverable=true`: current authoritative `text_summary` or `title` can
  rebuild the embedding input;
- `recoverable=false` with `missing_text_summary_and_title`: v0.3.4 did not
  persist enough source text. The tool refuses to invent it.

A `running` job with an expired lease does not need operator repair; the worker
reclaims it automatically. A scheduled `retry` likewise remains worker-owned.

## 5. Repair legacy pending and dead-letter jobs

The provider contract must exactly match the Runtime write embedding provider.
The current Runtime dimension is `1536`.

Common provider names are:

- OpenAI: `openai:<OPENAI_EMBEDDING_MODEL>`;
- DashScope: `dashscope:<DASHSCOPE_EMBEDDING_MODEL>`;
- MiniMax: `minimax:<MINIMAX_EMBED_MODEL>:<db-embed-type>`.

Example:

```bash
npx tsx scripts/runtime-data-ops.ts projection-repair \
  --db /var/lib/aionis/runtime.sqlite \
  --provider-name openai:text-embedding-3-small \
  --provider-dim 1536 \
  --default-tenant default \
  --limit 500
```

By default this repairs:

- recoverable legacy pending embedding nodes;
- dead-letter embedding jobs by deriving a new payload from current node text
  and current `commit_id`;
- dead-letter ANN jobs with a new `reconcile_from_sqlite_truth` generation.

The entire selected batch is transactional. If embedding repair is selected
but the provider contract is absent or invalid, no ANN or embedding repair is
applied.

Repair is safe against a running projection worker at the SQLite boundary:

- candidate selection and generation replacement share one `BEGIN IMMEDIATE`
  transaction;
- SQLite serializes that transaction with worker claim/completion writes;
- repair only selects `dead_letter` jobs and legacy nodes with no job, so it
  does not take ownership of `running` or scheduled `retry` work;
- after repair commits, a running worker may immediately claim the new
  `pending` generation. Consequently, a live `after` report may already show
  `running` or even `succeeded` instead of `pending`.

For a deterministic release migration report, keep Runtime stopped through
inspection and repair. Live repair is suitable for a scoped incident operation
when immediate worker pickup is desired.

Narrow operations when needed:

```bash
# Only legacy nodes
npx tsx scripts/runtime-data-ops.ts projection-repair --db DB \
  --legacy-only --provider-name PROVIDER --provider-dim 1536

# Only dead letters
npx tsx scripts/runtime-data-ops.ts projection-repair --db DB \
  --dead-letter-only --provider-name PROVIDER --provider-dim 1536

# Only ANN dead letters; no provider is needed
npx tsx scripts/runtime-data-ops.ts projection-repair --db DB \
  --dead-letter-only --ann-only
```

For a legacy node that has neither summary nor title, first review the node.
If no trustworthy source text exists, explicitly end the unresolved pending
state instead of fabricating content:

```bash
npx tsx scripts/runtime-data-ops.ts projection-repair \
  --db /var/lib/aionis/runtime.sqlite \
  --legacy-only \
  --node REVIEWED_UNRECOVERABLE_NODE_ID \
  --mark-unrecoverable-failed
```

This sets `embedding_status='failed'` with
`legacy_embedding_source_text_unavailable`. It does not delete memory. If a
reviewed source later becomes available, write a new authoritative memory
revision through the normal Runtime API.

After repair, start Runtime with the same provider contract. The durable worker
generates embeddings and reconciles ANN. Check `/health` until projection
`pending`, `retry`, `running`, and `dead_letter` reach the expected values.

## 6. Restore and rollback

Stop Runtime. To recover the current release's write authority, restore its
verified backup to a new path:

```bash
npx tsx scripts/runtime-data-ops.ts restore \
  --backup /var/backups/aionis/runtime-2026-07-12.sqlite \
  --to /var/lib/aionis/restored/runtime.sqlite
```

Restore verifies the adjacent manifest when present, verifies the backup as a
SQLite database, creates a new consistent database, and verifies the result.
It refuses an existing destination.

Then point `LITE_WRITE_SQLITE_PATH` at the restored path and start Runtime.
Keep the failed database and its WAL/SHM files for incident analysis; do not
copy them over the verified restore.

A release rollback is different. Never start an older Runtime against a write
database already migrated to schema v6. Mount a new volume restored from the
immutable, complete pre-upgrade data-volume snapshot and start the exact old
image against that volume. Verify old memory resolution and operation replay
there before switching traffic. Keep the upgraded volume untouched for forward
recovery and incident analysis.

The write-only backup above is sufficient for authority recovery by a compatible
Runtime, but it is not an exact old-release rollback artifact because it omits
replay and ANN files. If no complete pre-upgrade volume snapshot exists, stop:
do not improvise an in-place downgrade.

## 7. Incident checklist

1. Stop Runtime for upgrade/restore/repair involving a release transition.
2. Preserve logs, the original database paths, and the complete data volume.
3. Run `preflight` and `verify`; save their JSON output.
4. Take a new consistent write-authority backup and a stopped full-volume
   snapshot before mutation.
5. Run a scoped projection list.
6. Repair the smallest reviewed batch.
7. Run `verify` again.
8. Start Runtime and observe projection worker health.
9. Keep backup manifest and operation reports with the release record.
