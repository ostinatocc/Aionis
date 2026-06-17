# Aionis Admission Dataset Export Runbook

Status: product runbook for append-only admission evidence exports

This runbook turns Aionis' existing product loop into a durable JSONL dataset:

```text
remember / observe
  -> guide
  -> host Agent action
  -> feedback
  -> measure
  -> memoryAdmissionDatasetRowsFromRecord(...)
  -> append JSONL
```

The export is a read-only projection. It does not train a policy, mutate memory
authority, or enter the Agent prompt.

## What To Append

Append one JSONL chunk after each completed `guide -> feedback -> measure` loop.
Use the `memory_decision_trace.admission_record` returned by `/v1/measure` as
the source record.

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

## File Layout

A simple local layout is enough:

```text
admission-dataset/
  rows.jsonl
  manifests/
    2026-06-17T120000Z.json
  reports/
    latest-summary.json
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
| `use_now_unused_rate` | Exposed `use_now` rows not attributed as used. |
| `unused_exposed_rate` | Prompt-included rows that received no usage attribution. |
| `blocked_or_suppressed_count` | Rows that train the hard suppression / firewall boundary. |
| `rehydrate_requested_count` | Rows that train payload sufficiency and on-demand recovery. |

This is an audit and calibration input only. It must not mutate memory, promote a
learned policy, or override lifecycle, scope, source, suppression, authority, or
rehydrate gates.

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
