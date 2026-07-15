# Aionis Admission Dataset Export Runbook

Status: product runbook for append-only admission evidence exports

Dataset boundary: `admission-dataset/` is a local or private data workspace. It
is intentionally ignored by the public Runtime repository. Public Runtime source
keeps the exporter, evaluator, policy-comparison code, and small sanitized
examples under `docs/examples/`; full admission rows should live in a private
data repository or another controlled data store.

This runbook turns Aionis' existing product loop into a durable JSONL dataset:

```text
remember / observe
  -> guide
  -> host Agent action
  -> feedback
  -> measure
  -> memoryAdmissionDatasetRowsFromRecord(...)
  -> append JSONL

external memory candidates
  -> governMemory(mode=firewall)
  -> memoryAdmissionDatasetRowsFromRecord(...)
  -> append JSONL
```

The export is a read-only projection. It does not train a policy, mutate memory
authority, or enter the Agent prompt.

## What To Append

Append one JSONL chunk after each completed `guide -> feedback -> measure` loop
or Memory Firewall `governMemory(mode=firewall)` pass. Use the
`memory_decision_trace.admission_record` returned by `/v1/measure` for internal
Runtime memory, and the `memory_admission_records` returned by
`/v1/memory/govern` for external backend candidates. Both paths use the same
`aionis_memory_admission_record_v1` contract.

Each row should keep:

- `guide_trace_id`
- `run_id`
- `task_id`
- `task_signature`
- `policy_id`
- `policy_version`
- `policy_mode`
- `runtime_version`
- `scope`
- `memory_id`
- `admission_action`
- `prompt_included`
- `agent_used`
- `feedback_outcome`
- `outcome_label`
- `reason_codes`
- `evidence_ids`

Each row must exclude:

- raw prompt text
- raw memory body payloads
- raw slots
- embeddings
- hidden trace internals
- mutation authority

## Label Meaning

The current SDK derives conservative labels:

| Label | Use |
|---|---|
| `positive_use` | Host reported this exposed memory was used and outcome was positive. |
| `negative_use` | Host reported this exposed memory was used and outcome was negative. |
| `neutral_use` | Host reported this exposed memory was used and outcome was neutral. |
| `unused_exposed` | Memory reached the Agent-facing context but was not attributed as used. |
| `blocked_or_suppressed` | Runtime routed memory to `do_not_use`. |
| `rehydrate_requested` | Runtime required payload recovery before exact use. |
| `not_agent_facing` | Memory stayed out of the Agent-facing surface. |

Do not treat a successful task as proof that every exposed memory was useful.
Only `agent_used=true` with host feedback should become attributed use.
`unused_exposed` and the corresponding rates are admission-visibility metrics
derived from `prompt_included`; they are not proof of a persisted learning
exposure and cannot authorize feedback. Strict SDK feedback separately requires
an exact item/surface match in the source guide's `feedback_attribution_v1`.

## File Layout

A simple local/private layout is enough:

```text
admission-dataset/
  rows.jsonl
  manifests/
    run-001.json
  reports/
    latest/
      summary.json
      leaderboard.md
      policy_comparison.json
      policy_comparison.md
      holdout.json
      holdout.md
      candidate_policy.json
      candidate_policy.md
```

Append rows to `rows.jsonl`. Write a manifest per export job with:

```json
{
  "contract_version": "aionis_admission_dataset_export_manifest_v1",
  "source": "memory_decision_trace.admission_record",
  "append_mode": "jsonl_append",
  "row_count": 4,
  "jsonl_line_count": 4,
  "chunk_count": 2
}
```

Use the offline collector for normal appends. The target directory may be a
gitignored local `admission-dataset/` directory or an external private data
checkout:

```bash
npm run -s admission:collect -- \
  --dataset-dir admission-dataset \
  --input chunks/run-001.jsonl \
  --chunk-id run-001
```

The collector validates every input chunk, rejects raw prompt/slot/embedding
payloads, appends normalized rows to `rows.jsonl`, writes a manifest under
`manifests/`, and refreshes `reports/latest/summary.json` plus
`reports/latest/leaderboard.md`. It also writes
`reports/latest/policy_comparison.json` and
`reports/latest/policy_comparison.md` so every append has a current baseline
comparison.

For a real Runtime smoke that generates rows and appends them in one step:

```bash
npm run -s runtime:e2e:admission-dataset-export -- \
  --dataset-dir admission-dataset \
  --chunk-id local-runtime-smoke
```

The e2e writes the raw exported chunk under `admission-dataset/chunks/` and then
calls the collector. This proves the durable dataset path is connected to a
real `guide -> feedback -> measure` loop instead of only static sample rows.

For repeated real Runtime collection, use the batch collector:

```bash
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 4
```

Each iteration runs the same real Runtime e2e, writes one chunk under
`admission-dataset/chunks/`, appends it to `rows.jsonl`, and refreshes the
latest evaluator, comparison, and batch reports. The default diverse loop emits
27 rows per iteration across 13 task signatures, including a pointer-only
`rehydrate_requested` row. Four iterations reaches the minimum 100-row
policy-claim gate and the task-signature gate. Use more iterations when you want
repeated measurements within the same task-signature set or a larger holdout
split.

When candidate-policy evaluation discovers a missing train-side bucket, collect
targeted rows without changing Runtime admission behavior:

```bash
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 1 \
  --chunk-prefix targeted-external-current \
  --profile targeted-external-current
```

The `targeted-external-current` profile emits real `governMemory(mode=firewall)`
external-current candidates across multiple task signatures. It is meant to add
train-side support for offline candidate-policy validation; it is not a Runtime
policy change.

## Validation Command

Run the product e2e:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
npm run -s runtime:e2e:admission-dataset-export
```

The expected report contract is
`aionis_admission_dataset_export_e2e_result_v1`.

The e2e currently proves:

- multiple loops can be appended into one JSONL export
- `positive_use` and `negative_use` are both represented
- suppressed memory exports as `blocked_or_suppressed`
- pointer-only raw evidence exports as `rehydrate_requested`
- row count matches JSONL line count
- prompt text, raw memory payloads, and raw slots are excluded

## Evaluate A Dataset

After appending rows, run the offline evaluator before changing any Runtime gate:

```bash
npm run -s admission:evaluate -- \
  --input admission-dataset/rows.jsonl \
  --out-dir admission-dataset/reports/latest
```

The evaluator writes:

- `summary.json`: machine-readable policy metrics and bucket counts
- `leaderboard.md`: compact human-readable report

Core metrics:

| Metric | Meaning |
|---|---|
| `use_now_positive_rate` | Attributed positive `use_now` rows divided by all `use_now` rows. |
| `use_now_negative_rate` | Attributed negative `use_now` rows divided by all `use_now` rows. |
| `blocked_or_suppressed_count` | Rows that train the hard suppression / firewall boundary. |
| `rehydrate_requested_count` | Pointer-only rows that train payload sufficiency and on-demand recovery. |
| `use_now_unused_rate` | Exposed `use_now` rows not attributed as used. |
| `unused_exposed_rate` | Prompt-included rows that received no usage attribution. |

Small-sample protection is explicit. Reports include `sample_quality`; fewer
than 100 rows sets `not_enough_rows_for_policy_claim=true`, and fewer than six
task signatures sets `not_enough_task_signatures_for_diversity_claim=true`.
Treat those reports as pipeline validation, not policy-quality evidence.

This is an audit and calibration input only. It must not mutate memory, promote a
learned policy, or override lifecycle, scope, source, suppression, authority, or
rehydrate gates.

Do not commit full generated datasets to the public Runtime repository. Commit a
small sanitized sample only when it is needed to document the contract.

## Production Guardrails

Keep these checks in any host exporter:

1. Reject exports where `jsonl_line_count !== row_count`.
2. Reject rows containing `prompt_text`, raw memory payload fields, `slots`, or
   embedding vectors.
3. Require `run_id`, `task_id`, and `guide_trace_id` for every row.
4. Keep `blocked_or_suppressed` rows; they are training evidence for unsafe
   direct-use prevention, not noise.
5. Keep the Runtime policy version or application version in the export
   manifest when available.

## How This Feeds Future Policy Work

This dataset is the evidence spine for admission-policy calibration:

```text
admission rows -> dataset evaluator -> bucket metrics -> policy comparison -> learned candidate ranking
```

It is not sufficient by itself to deploy a learned policy. A learned admission
policy must first prove that it improves holdout admission quality and cannot
bypass lifecycle, scope, source, suppression, authority, or rehydrate gates.

## Compare Policy Baselines

Use the offline policy comparator to compare the recorded Aionis admission
actions against simple proxy baselines:

```bash
npm run -s admission:compare -- \
  --input admission-dataset/rows.jsonl \
  --out-dir admission-dataset/reports/latest
```

It writes:

- `policy_comparison.json`: machine-readable comparison across policy arms
- `policy_comparison.md`: markdown leaderboard

The first comparison arms are:

| Arm | Meaning |
|---|---|
| `aionis_recorded_policy` | Uses each row's recorded `admission_action`. |
| `raw_retrieval_prompt_proxy` | Treats every prompt-included candidate as direct-use memory. |
| `always_use` | Routes every candidate to `use_now`. |
| `always_block` | Routes every candidate to `do_not_use`. |

This comparison is an offline proxy over exported rows. It is useful for policy
calibration and obvious baseline sanity checks, but it is not a counterfactual
Agent rerun and must not mutate Runtime gates by itself.

## Holdout Validation

Before tuning rules or training a learned admission policy, split the dataset
into train and holdout groups:

```bash
npm run -s admission:holdout -- \
  --input admission-dataset/rows.jsonl \
  --out-dir admission-dataset/reports/latest \
  --split-by task_signature \
  --holdout-ratio 0.5
```

It writes:

- `holdout.json`: machine-readable train/holdout evaluator and policy-comparison reports
- `holdout.md`: compact human-readable holdout report

The default split is by `task_signature`, not by individual row. This prevents
the same task from leaking into both train and holdout. `--split-by run_id` is
also available for chunk-like validation, but the current dataset row contract
does not yet include a true `chunk_id`.

Holdout reports are still offline validation. They must not mutate Runtime
gates, and they do not replace counterfactual Agent reruns. A policy change is
not promotion-ready unless it improves holdout quality while preserving hard
lifecycle, scope, source, suppression, authority, and rehydrate boundaries.

## Evaluate Candidate Policies

After the dataset clears holdout row and task-signature gates, evaluate any
tuned rule or lightweight classifier candidate offline:

```bash
npm run -s admission:candidate-policy -- \
  --input admission-dataset/rows.jsonl \
  --out-dir admission-dataset/reports/latest \
  --split-by task_signature \
  --holdout-ratio 0.5
```

It writes:

- `candidate_policy.json`: machine-readable candidate leaderboard, guards, and promotion gates
- `candidate_policy.md`: compact human-readable report

Candidate evaluation is intentionally stricter than baseline comparison:

- candidates may only use label-safe feature fields;
- `outcome_label`, `feedback_outcome`, `agent_used`, IDs, titles, task
  signatures, and prompt-cost fields are forbidden decision inputs;
- candidates cannot upgrade `do_not_use`, `rehydrate`, or other non-direct hard
  actions into `use_now`;
- candidates can only become eligible for manual review if they improve holdout
  quality without hard-boundary, negative-use, or positive-capture regression;
- candidates must also make supported action changes on train, so a holdout-only
  surprise is treated as a discovery, not as promotion evidence.

As of the 2026-06-18 targeted batch baseline, the selected offline candidate
improved holdout calibration score from `0.7739` to `0.7918`, and the train
split now contains supported candidate action changes. The report therefore
sets `eligible_for_manual_review=true`. This means manual review is allowed. It
still does not authorize Runtime admission changes; the next gate is a
counterfactual Agent rerun.

## Runtime Shadow And Gray Projection

Candidate policies stay offline by default. After a candidate has passed
holdout evaluation, counterfactual rerun, and real-Agent rerun, operators should
first run an online shadow experiment:

For the current candidate status and exact active gray operating procedure, see:

- `docs/AIONIS_ADMISSION_POLICY_PROMOTION_STATUS.md`
- `docs/AIONIS_ADMISSION_ACTIVE_GRAY_RUNBOOK.md`

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=shadow
```

Shadow mode is read-only:

- default is `off`;
- it only applies inside `/v1/guide`;
- it emits `admission_candidate_policy_projection` on the guide response;
- it records `admission_candidate_policy_shadow_projection` in the source map;
- it does not change `agent_context`, prompt contents, stored memory rows,
  lifecycle state, authority state, or feedback counters.

Shadow evidence is promotion evidence only when all of these gates pass:

- at least `100` admission dataset rows;
- at least `6` task signatures;
- `agent_prompt_included_count = 0` in shadow;
- `runtime_mutation_count = 0` in shadow;
- `hard_boundary_upgrade_count = 0` in shadow;
- `missed_positive_delta = 0`;
- `negative_direct_delta < 0`;
- real-Agent rerun shows no hard-boundary, positive-capture, or completion
  regression.

These gates allow an active gray run to begin; they do not authorize a default
Runtime policy change. A shadow result from one profile is evidence for that
profile only. Repeat the gate on another profile before broadening the rollout.

Only after shadow evidence has been reviewed against those gates should
operators run a local gray experiment by enabling:

```bash
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active
```

The active mode is intentionally narrow:

- it only applies inside `/v1/guide`;
- it emits the same `admission_candidate_policy_projection` audit object;
- it only downgrades current `use_now` memories to `inspect_before_use`;
- it never upgrades `inspect_before_use`, `do_not_use`, `rehydrate`, or
  `not_agent_facing` decisions into `use_now`;
- it does not mutate stored memory rows, lifecycle state, authority state, or
  feedback counters;
- the source map includes `admission_candidate_policy_active_projection` only
  when the Agent prompt surface was actually changed.

This is a gray projection gate, not a learned-policy deployment. If it improves
real task behavior without positive-capture or completion regression, the next
step is a separately reviewed Runtime policy promotion.

As of 2026-06-28, the selected closed-loop candidate has passed the
cross-repository tool-executing Agent gate for default-active review. That makes
`active` a validated operator-controlled review path for the current guide
surface. It still does not make active mode the Runtime default; see
`docs/AIONIS_ADMISSION_POLICY_PROMOTION_STATUS.md` for the current promotion
state and required review items.
