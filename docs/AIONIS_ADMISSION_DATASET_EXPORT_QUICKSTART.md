# Aionis Admission Dataset Export Quickstart

Status: SDK v0.3.19 read-only export path for Runtime v0.3.11 candidate memory admission
audit rows

This quickstart shows how to turn a real Aionis guide/feedback/measure loop
into JSONL rows that a host can append to logs or a data lake.

The export is not an Agent prompt surface. It does not create a Runtime table,
does not mutate memory authority, and does not train a policy by itself.

## Product Loop

```text
observe or remember -> guide -> agent action -> feedback -> measure -> admission dataset JSONL export
```

The key point is that export should happen after feedback and measure, because
that is when Aionis can join:

- candidate memory
- admission action
- prompt exposure
- host-instrumented actual use
- outcome
- reason codes and evidence IDs

## Minimal SDK Example

```ts
import {
  createAionisClient,
  feedbackAttributionFromGuide,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  measureInputFromGuideLoop,
  type AionisGuideFeedbackAttributionV1,
  type AionisMemoryAdmissionRecord,
} from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: "my-agent-scope",
});

await aionis.remember({
  kind: "project_context",
  text: "The active integration target is packages/api/src/checkout.ts.",
  memory_lane: "private",
  owner_agent_id: "agent-1",
});

const beforeGuide = await aionis.guide({
  query_text: "Continue the checkout integration before memory is available.",
  consumer_agent_id: "agent-1",
  include_packets: true,
});

const afterGuide = await aionis.guide<{
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  feedback_attribution_v1: AionisGuideFeedbackAttributionV1;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids: string[];
  };
}>({
  query_text: "Continue the checkout integration.",
  consumer_agent_id: "agent-1",
  include_packets: true,
});

// Prefer guideAgentContext().agent_prompt for real Agent runs.
// This raw guide example still retains the complete guide response, including
// feedback_attribution_v1. AgentContext IDs are visibility/correlation data;
// they are not actual-use evidence or feedback authorization.
const agentResult = await runInstrumentedAgent(afterGuide.agent_context.prompt_text);

let feedback: unknown = null;
if (agentResult.used_memory_ids.length > 0) {
  const attribution = feedbackAttributionFromGuide(afterGuide);
  if (attribution.status !== "available") {
    throw new Error(
      `Feedback attribution is unavailable (${attribution.reason_code}); `
      + "request a new guide instead of falling back to agent_context IDs.",
    );
  }

  feedback = await aionis.feedback(feedbackFromGuide({
    guide: afterGuide,
    reason: "Host instrumentation verified use of checkout integration memory.",
    run_id: "run-001",
    outcome: "positive",
    used_memory_ids: agentResult.used_memory_ids,
  }));
}

// Allocate once and persist this ID before the first logical measure attempt.
const measureOperationId = "measure:task-001:run-001:attempt-1";
const measureRequest = measureInputFromGuideLoop({
  operation_id: measureOperationId,
  task: {
    task_id: "task-001",
    run_id: "run-001",
    task_signature: "checkout-integration",
    task_family: "developer_sdk",
  },
  before_guide: beforeGuide,
  after_guide: afterGuide,
  feedback_result: feedback,
});
const measure = await aionis.measure(measureRequest);

// If the transport outcome is unknown, retry aionis.measure(measureRequest)
// unchanged. A changed request must use a new operation_id.

console.log(measure.evidence_assessment);

const admissionRecord =
  measure.memory_decision_trace.admission_record as AionisMemoryAdmissionRecord;

const rows = memoryAdmissionDatasetRowsFromRecord(admissionRecord, {
  run_id: "run-001",
  task_id: "task-001",
  task_signature: "checkout-integration",
});

const jsonl = memoryAdmissionDatasetJsonlFromRows(rows);

// Append jsonl to your host log, object store, warehouse, or audit pipeline.
process.stdout.write(jsonl);
```

Admission-row export is read-only audit export; it does not imply that the
measurement is eligible for learning or skill export. Client-supplied
`sufficient_evidence` and `evidence_ids` are ignored by the evidence gate. Only
Runtime-verified receipts can make
`measure.evidence_assessment.eligible_for_skill_export` true.
The protected measurement authority also depends on the stable
`operation_id`: allocate it before the first attempt and reuse it only for an
exact retry of the same measure request. The Runtime persists the immutable
measurement and exact receipt; the JSONL projection remains a read-only export
and grants no posture or promotion authority.

## What A Row Contains

Each JSONL row uses `aionis_memory_admission_dataset_row_v1` and contains:

- `memory_id`
- `admission_action`
- `decision_kind`
- `prompt_included`
- `agent_used`
- `feedback_outcome`
- `outcome_label`
- `reason_codes`
- `evidence_ids`
- `guide_trace_id`
- `run_id`, `task_id`, and `task_signature`

`outcome_label` is a compact derived label:

| Label | Meaning |
|---|---|
| `positive_use` | Host said the Agent used this memory and outcome was positive. |
| `negative_use` | Host said the Agent used this memory and outcome was negative. |
| `neutral_use` | Host said the Agent used this memory and outcome was neutral. |
| `unused_exposed` | Memory reached the context surface but was not attributed as used. |
| `blocked_or_suppressed` | Memory was routed to `do_not_use`. |
| `rehydrate_requested` | Memory required raw evidence recovery before exact use. |
| `not_agent_facing` | Memory stayed out of the Agent-facing surface. |

`unused_exposed` is an admission-dataset visibility label derived from
`prompt_included`; it is not feedback authority and does not imply that a
learning exposure item was persisted. Feedback eligibility comes only from the
guide's `feedback_attribution_v1`. A context-only row may be useful for audit,
but must never be converted into direct feedback.

## What It Excludes

The dataset export intentionally excludes:

- raw Agent prompt text
- raw memory body payloads
- raw slots
- embeddings
- hidden trace internals
- Runtime mutation authority

Memory `title` metadata may appear in a row so operators can identify what was
admitted. Do not put secrets in titles.

## Runnable Validation

Run the dedicated Admission Dataset Export e2e:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
npm run -s runtime:e2e:admission-dataset-export
```

The output contract is `aionis_admission_dataset_export_e2e_result_v1`.
The script verifies that:

- a directly used memory becomes `positive_use` after host feedback
- a directly used memory can become `negative_use` after negative host feedback
- a suppressed memory becomes `blocked_or_suppressed`
- JSONL line count matches row count
- prompt text, raw memory payloads, and raw slots are excluded

See [admission-dataset-export-result.json](examples/admission-dataset-export-result.json)
for a compact example report.

To collect real e2e rows into the durable local dataset layout in one command,
pass `--dataset-dir`:

```bash
npm run -s runtime:e2e:admission-dataset-export -- \
  --dataset-dir admission-dataset \
  --chunk-id local-runtime-smoke
```

This writes:

```text
admission-dataset/
  chunks/local-runtime-smoke.jsonl
  rows.jsonl
  manifests/local-runtime-smoke.json
  reports/latest/summary.json
  reports/latest/leaderboard.md
  reports/latest/policy_comparison.json
  reports/latest/policy_comparison.md
```

The e2e still runs a real Runtime `guide -> feedback -> measure` loop first;
the collector only appends the resulting rows and refreshes offline reports.

To collect enough rows for policy-comparison work, run the batch collector:

```bash
npm run -s admission:batch-collect -- \
  --dataset-dir admission-dataset \
  --iterations 4
```

With the default diverse validation loop, each iteration exports 27 rows across
13 task signatures, including a pointer-only `rehydrate_requested` row.
Reports remain marked
`not_enough_rows_for_policy_claim=true` until the dataset reaches 100 rows, and
`not_enough_task_signatures_for_diversity_claim=true` until enough task
signatures are represented. Four iterations are enough to cross the default
row/signature gates; use more iterations when you need a larger holdout split.

For production append guidance, see
[AIONIS_ADMISSION_DATASET_EXPORT_RUNBOOK.md](AIONIS_ADMISSION_DATASET_EXPORT_RUNBOOK.md).

Run the SDK quickstart against a real local Runtime:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
npm run -s runtime:quickstart:sdk
```

MiniMax is also supported with `EMBEDDING_PROVIDER=minimax` and
`MINIMAX_API_KEY`.

The output includes an `admission_dataset_export` section. The script verifies
that JSONL rows are produced after feedback/measure, positive attribution is
joined, and prompt payload is not exported.

The broader product e2e also validates the same loop as part of the full
product surface:

```bash
npm run -s runtime:e2e:product-loop
```
