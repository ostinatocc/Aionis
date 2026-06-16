# Aionis Loop Engineering Profile

Aionis fits Loop Engineering as the memory governance layer, not as the loop
executor.

The host owns the execution loop:

```text
plan -> act -> validate -> observe -> revise
```

Aionis owns the memory and governance loop around it:

```text
observe loop evidence -> guide next iteration -> attribute feedback -> measure -> snapshot -> flight recorder
```

In product terms:

```text
Aionis is the memory governance runtime for loop-engineered Agents.
```

It can also be stated more sharply for planner/worker systems:

```text
Aionis is the execution memory layer that makes high-quality planning reusable,
auditable, and executable across agents, sessions, and models.
```

## What Aionis Owns

For loop-engineered Agents, Aionis should own:

- loop trace memory: goal, plan, action, validation, repair, and outcome
- loop guide: current state, reusable procedures, failed attempts to avoid, and rehydrate pointers
- feedback attribution: which admitted memory the Agent actually used
- promotion evidence: repeated successful loop traces can become workflow or procedure memory
- effect measurement: whether loop history changed future context or behavior
- incident replay: what the Agent could see when a decision was made

Aionis should not own:

- shell, browser, IDE, or CI execution
- autonomous task scheduling
- repository-specific repair logic
- benchmark-specific action semantics
- single-run hard rules

The host runs tools and validators. Aionis records evidence, governs memory
admission, attributes outcomes, measures effect, and exposes read-only audit
surfaces.

## Planner / Worker Split

The host may use a stronger model to create the plan and a cheaper model to
execute it. Aionis does not route those models. Aionis records the plan's
decisions, acceptance checks, failed branches, and execution boundaries, then
compiles them into governed context for the next loop iteration.

A plan becomes an Aionis memory asset when it carries:

- resolved decisions
- acceptance checks
- rejected or failed branches
- active targets
- execution boundaries
- evidence pointers for rehydration
- feedback attribution after execution

The planner model is not Runtime authority. The worker model is not Runtime
authority. Aionis gates decide which parts of the plan can enter actionable
context.

## Loop Metadata

Hosts can use the existing `observe` / SDK execution helpers and place loop
metadata in execution slots:

| Field | Meaning |
|---|---|
| `loop_id` | Stable host loop identifier. |
| `iteration_index` | 1-based iteration index inside the loop. |
| `validator_kind` | Validator class such as `unit_test`, `integration_test`, `lint`, or `human_review`. |
| `validation_result` | `passed`, `failed`, `blocked`, or `unknown`. |
| `repair_attempt` | Repair attempt count after the first failure. |
| `stop_reason` | Why the iteration stopped or handed off. |

These fields are evidence, not Runtime authority. They help Aionis compile
better context and audit reports without turning one loop run into a core rule.

## Runnable Profile

Run the profile:

```bash
npm run -s runtime:e2e:loop-engineering-profile
```

The profile uses a real local Runtime and verifies:

- a fresh loop starts without actionable history
- failed and passed iterations are observed as execution evidence
- the next iteration receives governed execution context
- the passed iteration is reusable
- the failed iteration is visible as counter-evidence to avoid
- feedback is attributed to an admitted memory ID
- `measure` reports that history changed future behavior
- `snapshot` and Flight Recorder expose read-only audit state
- prompt payload is excluded from audit surfaces

Example result:
[examples/loop-engineering-profile-result.json](examples/loop-engineering-profile-result.json).

## Measurement Boundary

The profile does not require `measure` to say the loop was purely positive.
When failed branches remain visible as risk or counter-evidence, Aionis may
report a negative-transfer risk while still reporting workflow reuse success and
changed future behavior.

That is intentional. Loop Engineering needs honest measurement, not just success
claims.
