# Aionis Substrate Integration

Status: external durable evidence sidecar path

Aionis Runtime remains the active memory Runtime. It owns observe, guide,
feedback, measure, lifecycle governance, admission decisions, learning policy,
and Agent-facing context compilation.

Aionis Substrate is the external durable evidence sidecar. It mirrors Runtime
Lite SQLite evidence into a separate store for backup, audit, migration review,
context preview, and external observability. The first product path is read-only
from Runtime to Substrate.

## Product Position

Use Substrate when a team wants a durable evidence layer around Aionis Runtime:

- backup and restore planning for memory evidence;
- audit reads over nodes, relations, feedback, decisions, and scopes;
- migration previews before moving evidence between stores;
- external observability without changing Runtime guide behavior;
- sidecar search and preview over mirrored evidence;
- optional Zvec-backed candidate search over the mirrored Substrate store.

This is intentionally not a Runtime-native storage replacement. Runtime writes
to its own Lite SQLite stores. Substrate opens those stores read-only, mirrors
mapped evidence into a separate target, then provides inspection and preview
surfaces.

## Boundary

| Plane | Runtime | Substrate |
|---|---|---|
| Memory writes | Owns `/v1/observe`, write commit, lifecycle writes, feedback, and learning state. | Mirrors committed evidence from Runtime read-only. |
| Guide/admission | Owns `/v1/guide`, Memory Firewall, admission receipts, rehydrate pointers, and Agent context. | Can preview governed buckets over mirrored evidence, but does not replace Runtime guide authority. |
| Learning policy | Owns admission policy, learning-control, promotion, feedback attribution, and measure. | Stores evidence and decision receipts for audit and migration. |
| Storage truth | Runtime Lite SQLite remains the Runtime fact source. | Substrate target is an external evidence mirror. |
| Candidate index | Runtime may use SQLite scan, optional Runtime Zvec, or optional Substrate sidecar candidate IDs for preselection. Runtime reloads final candidate rows from Runtime SQLite. | Substrate may use optional Zvec for sidecar search, then reloads truth nodes from Substrate before returning search results. |

Substrate must not mutate Runtime SQLite, Runtime source files, Runtime guide
behavior, Runtime learning policy, or Runtime admission outputs.

## Runtime Source Files

Lite Runtime defaults to local SQLite files under `.tmp/`:

```text
.tmp/aionis-lite-write.sqlite
.tmp/aionis-lite-replay.sqlite
```

`@aionis/substrate` is a separate Node 24+ sidecar package. Runtime can still run
on its own Node baseline; only the external Substrate CLI/process needs Node 24+.

For the first sidecar path, mirror the write store:

```bash
npx @aionis/substrate@latest mirror-runtime \
  --source .tmp/aionis-lite-write.sqlite \
  --target .aionis-substrate/substrate.sqlite \
  --adapter sqlite \
  --checkpoint .aionis-substrate/runtime-mirror-checkpoint.json
```

Add `--scope <scope>` when you want a scoped mirror. Re-run the same command
from a scheduler or host process. The checkpoint skips unchanged rows.

Dry run before writing the Substrate target:

```bash
npx @aionis/substrate@latest mirror-runtime \
  --source .tmp/aionis-lite-write.sqlite \
  --target .aionis-substrate/substrate.sqlite \
  --adapter sqlite \
  --checkpoint .aionis-substrate/runtime-mirror-checkpoint.json \
  --dry-run
```

Bounded polling loop:

```bash
npx @aionis/substrate@latest mirror-runtime \
  --source .tmp/aionis-lite-write.sqlite \
  --target .aionis-substrate/substrate.sqlite \
  --adapter sqlite \
  --checkpoint .aionis-substrate/runtime-mirror-checkpoint.json \
  --watch \
  --iterations 20 \
  --interval-ms 5000
```

`live-sidecar` remains a lower-level command name in the Substrate package.
Product integrations should use `mirror-runtime`.

## Preview And Audit

After mirroring, inspect the Substrate store:

```bash
npx @aionis/substrate@latest inspect \
  --adapter sqlite \
  --path .aionis-substrate/substrate.sqlite \
  --scope my-project
```

Preview governed context buckets without writing a Runtime decision receipt:

```bash
npx @aionis/substrate@latest preview-context \
  --adapter sqlite \
  --path .aionis-substrate/substrate.sqlite \
  --scope my-project \
  --query "continue the current implementation"
```

Preview is for operator review, backup validation, and external observability.
The Agent-facing guide path remains Runtime `/v1/guide`.

## Optional Runtime Candidate Source

Runtime can optionally use a mirrored Substrate store as an additional hybrid
recall candidate source. Install the optional Substrate package inside the
Runtime directory first, because the Runtime process dynamically loads it when
the sidecar is enabled:

```bash
cd .aionis-runtime
npm install --save-dev @aionis/substrate@latest
```

Then start Runtime with:

```env
RECALL_ENGINE_MODE=hybrid
RECALL_SUBSTRATE_SIDECAR_ENABLED=true
RECALL_SUBSTRATE_PATH=.aionis-substrate/substrate.sqlite
RECALL_SUBSTRATE_MAX_CANDIDATES=200
RECALL_SUBSTRATE_FAIL_OPEN=true
```

This path is candidate-only:

```text
Substrate search proposes memory IDs
  -> Runtime reloads those IDs from Runtime Lite SQLite
  -> Runtime applies scope, visibility, recall-surface, lifecycle, authority, admission, and rehydrate governance
```

The recall source trace is:

```text
substrate / substrate_sidecar_search / aionis_substrate_sidecar
```

Use this when Substrate has been mirrored from the same Runtime SQLite and you
want its durable evidence/search layer to improve candidate coverage. Do not use
it as a write path, admission override, or guide replacement.

## Backup And Restore Planning

Export a checksum-covered backup:

```bash
npx @aionis/substrate@latest backup \
  --adapter sqlite \
  --path .aionis-substrate/substrate.sqlite \
  --output .aionis-substrate/backup.json
```

Verify what would be restored before writing a target:

```bash
npx @aionis/substrate@latest restore-plan \
  --input .aionis-substrate/backup.json \
  --adapter sqlite \
  --path .aionis-substrate/restored.sqlite
```

`restore-plan` is read-only. It verifies backup checksums and prints scoped
counts, source metadata, and the intended target. Run `restore` only after an
operator accepts the plan.

## Optional Zvec In Substrate

Substrate can use Zvec as an optional candidate index for large mirrored stores.
The index is not authority. The product rule is:

```text
Zvec proposes candidates -> Substrate reloads truth nodes -> scope/lifecycle/authority/relations are checked -> preview buckets are compiled
```

Use Zvec for search speed and candidate coverage. Do not use Zvec as the final
memory truth store, admission decision maker, or lifecycle authority.

## Promotion Criteria For Native Storage Replacement

Do not promote Substrate into Runtime-native storage until the sidecar path has
shown all of the following on real Runtime data:

1. `mirror-runtime` is idempotent across repeated long-running syncs.
2. backup, restore-plan, restore, and preview preserve scoped evidence counts.
3. optional Zvec improves candidate coverage without changing governance
   semantics.
4. Runtime guide outputs remain stable when Substrate is present as a sidecar.
5. user setup remains simple enough that Runtime installation is not harder.
6. migration and rollback have explicit operator-readable plans.

Until those gates pass repeatedly, the product path is:

```text
Runtime writes and guides -> Substrate mirrors read-only -> Substrate audits, previews, backs up, and searches external evidence
```
