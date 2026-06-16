# ANN Backend Evaluation for Aionis Recall Engine

Date: 2026-06-16

Status: research note. No dependency has been added to Runtime.

## Decision Context

Aionis already has the product boundary it needs:

```text
candidate retrieval below
strict governance above
auditable memory influence throughout
```

The ANN backend must improve candidate generation only. It must not decide
`use_now`, `inspect_before_use`, `do_not_use`, `rehydrate`, lifecycle state,
authority, scope, or prompt admission. Every backend candidate must be checked
against the SQLite fact source before governance.

Current opt-in implementation:

- `RECALL_ANN_PROVIDER=off|local`
- `off` remains the default
- `local` uses the in-memory exact sidecar behind the stable
  `AionisLocalAnnIndex` contract
- source trace: `ann / local_ann_index / aionis_local_ann`

## Candidates

### USearch

Official sources:

- GitHub: https://github.com/unum-cloud/usearch
- JavaScript docs are linked from the project README.
- npm snapshot checked on 2026-06-16: `usearch@2.25.3`,
  license `Apache 2.0`, unpacked package size about 21.5 MB.

Fit:

- Best first production local sidecar candidate.
- Designed as a compact HNSW-style vector index with native bindings.
- Supports JavaScript, persistence, deletion/update-oriented index operations,
  and external predicate-style filtering patterns.
- Matches Aionis's desired shape: SQLite remains the fact source, USearch only
  maps vectors to candidate IDs.

Risks:

- Native package install/build reliability must be tested across macOS/Linux,
  Intel/ARM, Node 22.x.
- Predicate filtering should remain outside the ANN trust boundary. Even if
  USearch can filter, Aionis must still verify through SQLite.
- Package size is non-trivial for a Lite Runtime dependency, so it should be
  optional until install risk is proven.

### sqlite-vec

Official sources:

- GitHub: https://github.com/asg017/sqlite-vec
- npm snapshot checked on 2026-06-16: `sqlite-vec@0.1.9`,
  license `MIT OR Apache`, npm package metadata reports a tiny JS package.

Fit:

- Best conceptual fit for a SQLite-native Lite Runtime if extension loading is
  reliable.
- Keeps storage and vector query semantics near the existing SQLite fact source.
- Could simplify persistence and rebuild operations compared with a separate
  sidecar file.

Risks:

- The project has presented itself as pre-v1; API and storage behavior may
  change.
- Node integration depends on SQLite extension loading and deployment packaging.
- It may be harder to keep the ANN candidate layer operationally separate from
  the fact source if teams start treating vector tables as the source of truth.

### LanceDB

Official sources:

- JavaScript docs: https://lancedb.github.io/lancedb/js/
- GitHub/npm package: `@lancedb/lancedb`
- npm snapshot checked on 2026-06-16: `@lancedb/lancedb@0.30.0`,
  license `Apache-2.0`, unpacked package size about 1.3 MB.

Fit:

- Stronger full store candidate for Managed Server Edition than Lite.
- Offers a broader vector/search storage model and is closer to a real vector
  database layer than a small sidecar index.
- Useful if hosted Aionis needs larger persistent vector collections, hybrid
  search, or operational APIs beyond local sidecar rebuild.

Risks:

- Heavier storage shape than the current focused Runtime.
- Could blur Aionis's product boundary if adopted too early. Aionis is not a
  vector DB wrapper.
- Needs explicit tenant/scope partitioning and recovery design before being
  viable for Server Edition.

## Criteria Matrix

| Criterion | USearch | sqlite-vec | LanceDB |
|---|---|---|---|
| Node.js compatibility | JavaScript package exists; must verify Node 22.x native install. | JS package exists; runtime depends on SQLite extension loading. | JS package exists; Server fit looks better than Lite fit. |
| Native build reliability | Unknown until matrix probe; likely main risk. | Extension loading/package compatibility is main risk. | Lower build concern than raw native addon, but storage/runtime footprint must be tested. |
| Local install size | Medium; npm snapshot ~21.5 MB unpacked. | Small JS package metadata, but native artifact path must be checked. | Medium-light npm metadata, but actual storage/runtime deps need probe. |
| Filter support | Can use external predicates, but Aionis should verify in SQLite anyway. | SQL filtering can be close to fact source. | Has richer search/table semantics; scope filters need explicit design. |
| Persistence model | Index file or memory-mapped index. | SQLite extension/vector tables. | Lance table/database directory. |
| Rebuild speed | Likely good; must measure with 1536-d vectors. | Must measure insert/build and query speed inside SQLite. | Must measure create table/index and query speed. |
| Deletion/update support | Supports delete/update style index operations; verify JS API. | SQL row deletion/update possible; vector table behavior must be verified. | Table row management likely strongest, but needs storage policy. |
| Production maturity | Stronger than sqlite-vec for local ANN sidecar. | Promising but pre-v1 risk. | Stronger hosted-store candidate, larger operational surface. |
| License | Apache 2.0. | MIT OR Apache. | Apache-2.0. |
| Operational complexity | Moderate. | Low if extension loading is reliable; high if packaging is brittle. | Highest for Lite; acceptable later for Managed Server. |

## Current Recommendation

1. Keep `RECALL_ANN_PROVIDER=off` as the default.
2. Keep the current local exact provider as the contract test bed.
3. Evaluate USearch first as the production local sidecar backend.
4. Keep sqlite-vec as a SQLite-native backup, gated by extension-loading proof.
5. Defer LanceDB to Managed Server Edition research unless Lite recall evals show
   a strong need for a heavier persistent vector store.

## Dependency Gate

Do not add any ANN dependency to Runtime until all three are true:

1. Recall eval or production trace shows bounded scan is a bottleneck.
2. Source tracing proves candidate loss from scan caps or unacceptable recall
   latency, not governance blocking.
3. Install/build risk is acceptable on the supported Node/macOS/Linux matrix.

The first dependency should remain optional and provider-gated. Aionis should
continue to boot and pass tests with no ANN backend installed.

## Probe Procedure

Manual probe only:

```bash
node scripts/research/ann-backend-probe.mjs --provider local --vectors 10000 --dim 1536 --queries 20 --k 10
```

Optional provider probes after local package installation:

```bash
npm install --no-save usearch
node scripts/research/ann-backend-probe.mjs --provider usearch --vectors 10000 --dim 1536

npm install --no-save sqlite-vec
node scripts/research/ann-backend-probe.mjs --provider sqlite-vec --vectors 10000 --dim 1536

npm install --no-save @lancedb/lancedb
node scripts/research/ann-backend-probe.mjs --provider lancedb --vectors 10000 --dim 1536
```

Do not commit package changes from those manual installs.
