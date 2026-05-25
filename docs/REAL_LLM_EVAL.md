# Real LLM Evaluation Protocol

Real LLM evaluation is the proof system for Aionis. It is not the product layer.

The harness exists to answer one question:

> Does a frozen Aionis Runtime improve real agent execution on unseen or holdout tasks without narrowing the agent into project-specific behavior?

## Boundary

Real eval may own:

1. real provider calls
2. isolated workspace creation
3. baseline-vs-Aionis comparison
4. required verifier execution
5. effect-gate reports
6. provider/protocol health evidence

Real eval must not own:

1. Core Runtime policy
2. runtime memory promotion
3. persistent task rules
4. project-specific repair hints in `src/`
5. product claims without a passing effect gate

Every report produced by the runner includes a `layer_boundary` section. The harness has measurement authority only. Failed runs can produce evidence, counter-evidence, and experimental candidates; they cannot promote Runtime authority by themselves.

## Frozen-Version Rule

Aionis must be frozen before a task run starts.

This is a validation rule, not a development freeze. Aionis can be developed before or after the run. During the run, the source code must not change to satisfy the current task.

During one task run:

1. do not edit Aionis Runtime to satisfy the task
2. do not add a project-specific rule to Core
3. do not change the verifier
4. do not treat provider/protocol failure as product learning
5. do not claim success unless the required verifier passes

If a task fails, analyze the run after it finishes. Any Runtime change must be a general mechanism improvement, then validated against prior and holdout tasks.

Project experience from the run belongs in runtime memory, scoped rule candidates, workflow candidates, counter-evidence, forgetting signals, and reports. It does not belong in Core source code.

## Task Selection

Use tasks that represent real agent work:

1. medium multi-file changes
2. issue or PR level changes
3. module-boundary refactors
4. regression-sensitive behavior fixes
5. tasks with required verifier commands

Do not evaluate only on known tasks that shaped the current Runtime. Keep a holdout set that is not used while designing the mechanism.

## Required Arms

A useful report should include:

1. baseline agent run without Aionis guidance
2. Aionis-assisted run using the same model and task
3. required verifier output for each arm
4. provider/protocol health status
5. action trace summary
6. effect-gate comparison

The Aionis arm must show measurable improvement, not just more activity.

## Evidence Grades

Evidence is graded by product relevance:

1. required verifier pass on an isolated real workspace
2. real integration or end-to-end pass
3. real provider/runtime interaction pass
4. deterministic local contract pass
5. synthetic or fixture-only pass

Only the first three grades can prove real product effectiveness. Lower grades can protect contracts during development but cannot prove Aionis works as a runtime product.

## Promotion Discipline

Successful real eval evidence may support promotion only when it is scoped:

1. exact task
2. task family
3. repository
4. ecosystem
5. global

Promotion beyond the narrowest scope requires repeated real success plus holdout or regression evidence. A single project pass is not a global rule.

## Failure Analysis

Classify failed runs by phase:

1. provider failure
2. tool protocol failure
3. edit operation failure
4. lint or type failure
5. authored test failure
6. hidden contract failure
7. environment or dependency failure
8. unknown verifier failure

The classifier may propose semantic candidates, but those candidates remain experimental until a later frozen run proves them.

## Report Contract

The real eval report carries `summary.runtime_effect_rollup`.

That rollup aggregates Runtime evidence already produced by maintenance snapshots:

1. baseline-vs-Aionis success, verifier, first-action, tool-step, repeated-discovery, wrong-file-touch, and token deltas
2. baseline comparison quality, separating strict positive effects from mixed wins and regressions
3. verifier feedback repair-loop usage and success counts when an Agent is given structured verifier failure evidence for another pass
4. `runtime_effect_summary_v1` posture counts, token/context observations, continuity signals, verifier signals, workflow/tool reuse signals, and forgetting signals
5. `promotion_quality_summary_v1` invalidation pressure and learning-posture movement

The rollup is measurement evidence only. It keeps `baseline_comparison_required: true` and `effect_claim_status: measurement_only_requires_effect_gate` when evidence is present. It cannot promote Core source rules or prove product effectiveness without the frozen real eval gate.

## Commands

Typecheck the harness:

```bash
npm run -s eval:real-llm:typecheck
```

Run a real evaluation suite:

```bash
npm run -s eval:real-llm -- --suite <suite.json> --out <report-dir>
```

Run the same real-task suite through external SWE-agent A/B integration:

```bash
npm run -s eval:swe-agent -- --suite <suite.json> --out <report-dir> --runtime-url <lite-runtime-url>
```

Roll up reports:

```bash
npm run -s eval:real-llm-rollup -- --reports <report-dir>
```

See `docs/SWE_AGENT_EVAL.md` for the SWE-agent boundary contract. SWE-agent owns reasoning and code edits; Aionis owns advisory runtime context, evidence capture, scoped learning, controlled forgetting, and maintenance.

## Success Standard

Aionis is effective when frozen Runtime runs show:

1. fewer repeated discovery steps
2. better first repair target selection
3. fewer repeated failed actions
4. cleaner edit-boundary adherence
5. higher required-verifier pass rate
6. no regression on prior and holdout tasks

If a change improves one known task but harms unknown tasks, it is overfitting and must stay out of Core.
