# Aionis Dashboard Artifacts

Aionis Dashboard is a read-only trust window. It should not query mutable Runtime
state by guessing from `run_id`; it should render explicit product artifacts.

## Generate the flagship artifact set

Run the Plan as Memory Asset demo:

```bash
npm run -s runtime:e2e:plan-as-memory-asset
```

The demo writes:

```text
docs/examples/dashboard/plan-as-memory-asset/
  manifest.json
  operator-snapshot.json
  memory-decision-trace.json
  measure.json
  flight-recorder.json
  demo-result.json
```

These files are enough for the Dashboard zones:

| Dashboard zone | Artifact |
|---|---|
| Memory State | `operator-snapshot.json` |
| Admission Decisions | `memory-decision-trace.json` |
| Effect & Cost | `measure.json` |
| Flight Recorder | `flight-recorder.json` |

## Preview locally

In the standalone Dashboard app:

```bash
cd /Volumes/ziel/AionisDashboard
AIONIS_DASHBOARD_ARTIFACT_DIR=/Volumes/ziel/AionisRuntime-focused/docs/examples/dashboard/plan-as-memory-asset npm run dev
```

Open:

```text
http://localhost:3111
```

## Safety boundary

The exporter writes read-only product surfaces only. It rejects exact
`prompt_text` and `agent_prompt` payload fields so the Dashboard can show prompt
cost and audit decisions without persisting prompt content.

`product_trace.json` is intentionally not emitted by default. If a future demo
needs Runtime projection from `product_trace`, write it explicitly and review
payload policy first.

