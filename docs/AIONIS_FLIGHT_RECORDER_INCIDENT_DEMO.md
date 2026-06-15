# Aionis Flight Recorder Incident Demo

This demo shows the Agent Flight Recorder as an operator-facing incident replay
surface.

It runs three deterministic incident scenarios against a real local Runtime:

1. a healthy run where the Agent used the admitted current route
2. a negative run where the Agent claims it used a blocked failed memory
3. an incomplete run where the operator did not provide feedback attribution

Run it:

```bash
npm run -s runtime:e2e:flight-recorder-incident
```

The loop is:

```text
governMemory(mode=firewall)
-> simulated agent attribution
-> flightRecorder
-> deterministic incident classification
```

The demo verifies:

- `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate` were replayed
- blocked failed memory is visible to the operator
- blocked-memory misuse is detected when feedback attributes usage to a blocked ID
- missing feedback attribution is reported as insufficient evidence
- `agent_context.prompt_text` is excluded from the incident report
- the replay is read-only and does not mutate Runtime state

Example result:
[examples/flight-recorder-incident-demo-result.json](examples/flight-recorder-incident-demo-result.json).

## Boundary

This is an audit demo, not an Agent obedience guarantee. It proves that after a
run Aionis can reconstruct what memory was admitted or blocked, join feedback
attribution, and flag a blocked-memory misuse claim. It does not prove the Agent
followed the guidance during execution.
