# Aionis Agent Flight Recorder

Agent Flight Recorder is the read-only incident replay surface for Aionis.

It answers one operational question:

```text
When the Agent made a decision, what memory was it allowed to see?
```

Use it after an Agent run, customer incident, unexpected action, or evaluation
failure to inspect:

- which memories entered `use_now`
- which memories required `inspect_before_use`
- which memories were blocked through `do_not_use`
- which memories required `rehydrate`
- which blocked or suppressed memories were visible to the operator
- whether feedback was attributed to the memory IDs the Agent could see
- whether the replay includes decision trace, receipt, admission record, and
  operator snapshot coverage

The report is not an Agent prompt. It excludes `agent_context.prompt_text`, raw
memory rows, raw slots, and embedding vectors.

## Route

```http
POST /v1/audit/flight-recorder
```

Runnable SDK quickstart:

```bash
npm run -s runtime:quickstart:flight-recorder
```

Runnable incident demo:

```bash
npm run -s runtime:e2e:flight-recorder-incident
```

Example output:
[docs/examples/flight-recorder-quickstart-result.json](examples/flight-recorder-quickstart-result.json).

Incident demo guide:
[AIONIS_FLIGHT_RECORDER_INCIDENT_DEMO.md](AIONIS_FLIGHT_RECORDER_INCIDENT_DEMO.md).

Incident demo output:
[docs/examples/flight-recorder-incident-demo-result.json](examples/flight-recorder-incident-demo-result.json).

## With Product Trace

If the host has the same product trace used by `/v1/measure`, pass it directly:

```json
{
  "tenant_id": "default",
  "scope": "checkout-agent",
  "run_id": "run-123",
  "guide_trace_id": "guide-trace-123",
  "product_trace": {
    "before_guide": { "...": "..." },
    "after_guide": { "...": "..." }
  },
  "feedback_result": {
    "run_id": "run-123",
    "outcome": "positive",
    "used_memory_ids": ["mem-current"]
  }
}
```

Aionis derives the memory decision trace and operator snapshot as read-only
projections, then compiles the flight recorder report.

## With Existing Audit Artifacts

If the host already stored a decision trace or operator snapshot, pass them:

```json
{
  "tenant_id": "default",
  "scope": "checkout-agent",
  "run_id": "run-123",
  "memory_decision_trace": { "...": "..." },
  "operator_snapshot": { "...": "..." },
  "feedback_result": {
    "run_id": "run-123",
    "outcome": "negative",
    "used_memory_ids": ["mem-stale"]
  }
}
```

## Response

```json
{
  "contract_version": "aionis_agent_flight_recorder_result_v1",
  "agent_flight_recorder": {
    "contract_version": "aionis_agent_flight_recorder_report_v1",
    "intended_use": "incident_replay_audit",
    "agent_prompt_included": false,
    "runtime_mutation": false,
    "agent_view": {
      "prompt_text_included": false,
      "exposed_memory_ids": ["mem-current", "mem-failed"],
      "use_now_memory_ids": ["mem-current"],
      "do_not_use_memory_ids": ["mem-failed"],
      "rehydrate_memory_ids": []
    },
    "blocked_or_suppressed": [
      {
        "memory_id": "mem-failed",
        "agent_surface": "do_not_use",
        "reason_codes": ["suppressed_lifecycle"]
      }
    ],
    "attribution": {
      "present": true,
      "outcome": "positive",
      "used_memory_ids": ["mem-current"],
      "attributed_memory_ids": ["mem-current"]
    }
  }
}
```

## SDK

```ts
import { createAionisClient } from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: "http://127.0.0.1:3001",
  tenant_id: "default",
  scope: "checkout-agent",
});

const replay = await aionis.flightRecorder({
  run_id: "run-123",
  guide_trace_id: "guide-trace-123",
  product_trace: {
    before_guide,
    after_guide,
  },
  feedback_result: {
    run_id: "run-123",
    outcome: "positive",
    used_memory_ids: ["mem-current"],
  },
});

console.log(replay.agent_flight_recorder.agent_view.use_now_memory_ids);
```

## Limits

Agent Flight Recorder can replay only the artifacts the host provides or the
product trace can derive. If no feedback result is supplied, attribution will be
reported as absent. If the host did not log the guide or trace for a historical
run, the recorder cannot reconstruct hidden prompt details.

That boundary is intentional: Aionis records auditable admission state, not raw
private prompt payloads.
