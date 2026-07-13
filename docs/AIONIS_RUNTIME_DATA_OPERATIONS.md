# Aionis Runtime SQLite Data Operations

This runbook covers the file-backed SQLite database configured by
`LITE_WRITE_SQLITE_PATH`. It is the authority for memory, execution state,
durable write receipts, embedding vectors, and projection work.

The commands below do not call an embedding provider or ANN service. Projection
repair creates durable work that the normal Runtime worker later executes.

## Safety model

- Runtime startup performs a schema preflight before write/projection schema
  changes. A database from v0.3.4 is accepted for upgrade. A future, malformed,
  or partially missing schema that already claims the current version fails
  closed.
- Upgrade only adds current tables, columns, indexes, and schema metadata. It
  verifies that commit, node, and edge row counts did not change.
- Backup uses SQLite `VACUUM INTO`, so committed WAL state is included in one
  consistent standalone database file. Never back up by copying only the main
  `.sqlite` file while Runtime is running.
- Restore never overwrites a live database. It creates and verifies a new path;
  the operator switches `LITE_WRITE_SQLITE_PATH` only after validation.
- Projection repair rebuilds intent from current SQLite node state and current
  `commit_id`. It never blindly replays an old or corrupt payload.

All commands emit JSON. A command error exits with status `1`; `preflight` or
`verify` exits with status `2` when it successfully produced a report that is
not safe to continue with.

## Schema transition from v0.3.4

The v0.3.4 commit/node/edge rows remain the semantic baseline. The current
write/projection schema adds these durable operational surfaces:

- `lite_runtime_write_operations` for operation-id receipts;
- `lite_product_guide_receipts` for guide evidence linkage;
- `lite_memory_projection_jobs` for embedding and ANN recovery;
- `lite_runtime_schema_metadata` for component-scoped schema versioning.

Existing unversioned databases that already contain some or all of these new
tables remain supported: `CREATE IF NOT EXISTS`/guarded column migrations are
idempotent, and metadata is recorded only after current schema initialization
finishes. The upgrader proves that commit, node, and edge counts are unchanged.

## 1. Preflight

```bash
npx tsx scripts/runtime-data-ops.ts preflight \
  --db /var/lib/aionis/runtime.sqlite
```

Expected classifications:

- `legacy_v0_3_4`: supported and needs upgrade;
- `current`: no schema upgrade needed;
- `uninitialized`: no write schema exists yet;
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

The backup can run while Runtime is serving traffic. For a release upgrade,
stop Runtime after backup and before running the upgrade so no old binary can
write during the release transition.

## 3. Upgrade v0.3.4 data

With Runtime stopped and a verified backup available:

```bash
npx tsx scripts/runtime-data-ops.ts upgrade \
  --db /var/lib/aionis/runtime.sqlite

npx tsx scripts/runtime-data-ops.ts verify \
  --db /var/lib/aionis/runtime.sqlite
```

The upgrade report must show:

- `before.classification` is `legacy_v0_3_4` or `current`;
- `after.classification` is `current`;
- `preserved_counts.before` equals `preserved_counts.after`.

Do not proceed if `verify.ok` is false. Warnings about legacy pending
projections or dead letters are handled in the next section; they are not
SQLite corruption.

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

Stop Runtime. Restore the backup to a new path:

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

## 7. Incident checklist

1. Stop Runtime for upgrade/restore/repair involving release transition.
2. Preserve logs and the original database path.
3. Run `preflight` and `verify`; save their JSON output.
4. Take a new consistent backup before mutation.
5. Run a scoped projection list.
6. Repair the smallest reviewed batch.
7. Run `verify` again.
8. Start Runtime and observe projection worker health.
9. Keep backup manifest and operation reports with the release record.
