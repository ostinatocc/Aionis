# SWE-agent Aionis Evaluation

This integration measures whether a frozen Aionis Runtime improves a mature external software-engineering Agent.

It does not turn Aionis into an Agent. SWE-agent owns reasoning, tool use, code edits, and submission. Aionis owns execution continuity, advisory runtime context, evidence capture, scoped learning, controlled forgetting, and runtime maintenance.

## Boundary Contract

The adapter may:

1. create isolated workspaces for real GitHub or local tasks
2. run baseline SWE-agent without Aionis context
3. run Aionis-assisted SWE-agent with Runtime context appended to the problem statement
4. run the required verifier command in the real workspace
5. parse SWE-agent trajectory files
6. write replay, handoff, verifier evidence, scoped semantic invariants, workflow candidates, and maintenance evidence back to Aionis Runtime
7. choose an Aionis assistance mode before rendering Agent context
8. produce a baseline-vs-Aionis report

The adapter must not:

1. modify Aionis source during a task run
2. encode project-specific repair rules into `src/`
3. let Aionis generate or apply semantic patches
4. let Aionis execute SWE-agent actions
5. treat one project success as global Runtime policy
6. store provider or protocol failures as product learning
7. turn a successful patch invariant into a Core source rule

## Why SWE-agent

SWE-agent is an external open-source software-engineering Agent for repository-level issue work. Its current CLI entry point is `sweagent run`; official docs show local repository usage with `--env.repo.path`, `--problem_statement.path`, and `--actions.apply_patch_locally`.

This gives Aionis a cleaner product test than a self-built Agent layer:

1. same Agent
2. same model
3. same task
4. same verifier
5. only Aionis Runtime changes between arms

## Install SWE-agent

Follow the SWE-agent source install path:

```bash
git clone https://github.com/SWE-agent/SWE-agent.git
cd SWE-agent
python -m pip install --upgrade pip
pip install --editable .
sweagent --help
```

The focused Aionis eval path runs SWE-agent with `env.deployment.type=local` by default. It does not use Docker. The adapter creates a temporary real workspace, runs setup commands there, and points SWE-agent at that existing workspace through `preexisting` repo mode.

Suite config must not include Docker image arguments:

```json
{
  "swe_agent": {
    "model": "your-model-name",
    "cost_limit": 2,
    "deployment": "local",
    "config_files": ["scripts/swe-agent-eval/config/aionis-swe-agent.yaml"]
  }
}
```

If a suite contains Docker deployment settings such as `--env.deployment.image`, `--env.deployment.pull`, or `deployment: "docker"`, the focused adapter fails fast. That keeps this validation path local and avoids carrying a second runtime surface.

The included `scripts/swe-agent-eval/config/aionis-swe-agent.yaml` uses SWE-agent's `thought_action` parser with a shell-first tool surface: direct shell commands plus `submit`. This keeps the external Agent in charge of reasoning, editing, and validation while avoiding extra window/editor command protocol noise. The local wrapper also treats a model-emitted `submit` action as submit intent and derives the patch from the current git diff, so local PATH differences do not prevent submission capture. It does not tell the Agent to avoid tests, because many real issue tasks require code, tests, and type declarations to change together.

Provider keys and model names are owned by SWE-agent/LiteLLM configuration. Do not commit secrets.

## Start Aionis Lite Runtime

```bash
PORT=3100 npm run -s lite:start
```

Use the printed Lite Runtime URL as `--runtime-url`.

## Run A/B Evaluation

The adapter can reuse existing real-task suites:

```bash
npm run -s eval:swe-agent -- \
  --suite scripts/real-llm-eval/suites/github-real-holdouts-v1.json \
  --out /tmp/aionis-swe-agent-eval \
  --runtime-url http://127.0.0.1:3100 \
  --model your-model-name \
  --cost-limit 2 \
  --task p-limit-clear-queue-return-count
```

Report output:

```text
/tmp/aionis-swe-agent-eval/swe-agent-aionis-eval-report.json
```

Per-task output:

```text
tasks/<task-id>/baseline/run.json
tasks/<task-id>/baseline/patch.diff
tasks/<task-id>/aionis/run.json
tasks/<task-id>/aionis/patch.diff
tasks/<task-id>/task-report.json
```

## Integration Flow

Baseline arm:

1. clone or copy workspace
2. run setup commands
3. write original problem statement
4. run `sweagent run`
5. run verifier
6. parse trajectory and diff
7. write replay/handoff evidence to Aionis if `--runtime-url` is set

Aionis arm:

1. clone or copy a fresh workspace
2. run setup commands
3. run the Aionis assistance gate:
   - `no_op`
   - `minimal_boundary`
   - `compact_contract`
   - `semantic_evidence`
   - `strict_governance`
4. call Aionis through the generic Agent Runtime adapter only when the gate needs Runtime-derived compact contract signals:
   - `/v1/memory/experience/intelligence`
   - `/v1/memory/planning/context`
   - `/v1/memory/context/assemble`
   - `/v1/memory/tools/select`
5. append only the compact Aionis execution contract selected by the gate; the full Runtime packet stays diagnostic evidence, not Agent instructions
6. append scoped prior-success semantic invariants when prior verifier-passing runs exist and the gate admits them
7. run the same `sweagent run`
8. run the same verifier, except when SWE-agent itself ends in a non-learning failure before producing changed files
9. if the verifier fails and the task permits more Agent attempts, render a verifier feedback repair packet and run another SWE-agent pass in the same workspace
10. parse trajectory and diff from all passes
11. write replay/handoff/verifier evidence and semantic invariant evidence to Aionis
12. run `/v1/memory/runtime-maintenance/run`
13. produce baseline-vs-Aionis comparison, baseline comparison quality, assistance-gate metrics, verifier feedback repair metrics, semantic-invariant uptake metrics, and `runtime_effect_rollup`

## Assistance Gate

Aionis must not always intervene with the same strength. The adapter renders one compact contract shape based on task complexity and prior evidence:

1. `no_op`: no meaningful Runtime value is available; do not add Aionis context.
2. `minimal_boundary`: render only small edit/verifier boundary material.
3. `compact_contract`: render bounded target files, verifier, first-action signal when useful, and operating rules.
4. `semantic_evidence`: render scoped prior-success semantic invariants without dumping Runtime internals.
5. `strict_governance`: render a larger but still bounded contract when prior failures, forbidden writes, or high complexity justify stronger control.

The gate is a cost-control mechanism. It should protect simple tasks from Runtime overhead while still allowing stronger historical shaping when real evidence says it is useful. SWE-agent is only one consumer of the generic adapter contract; Runtime learning must remain agent-agnostic and must not promote project-specific fixes into source code.

## Baseline Comparison Quality

Verifier pass is necessary but not enough. The rollup derives `baseline_comparison_quality` from generic A/B signals:

1. positive signals: verifier improvement, first-action improvement, fewer repeated discovery steps, fewer wrong-file touches, fewer tool steps, lower token use, faster completion, and prior-success invariant uptake
2. regression signals: assisted verifier failure, verifier regression, more repeated discovery, more wrong-file touches, more tool steps, higher token use, slower completion, and context budget overflow
3. quality labels: `positive`, `mixed_positive`, `neutral`, `mixed_negative`, `regressed`, `failed_but_improved`, `failed`, and `insufficient_comparison`

This prevents a passing Aionis-assisted run from being treated as a clean win when it also increases discovery churn or context cost.

## Verifier Feedback Repair Loop

The SWE-agent adapter can run multiple Agent passes in the same workspace when a verifier fails. This is not Runtime-owned semantic repair. The loop gives the LLM/Agent a structured verifier failure packet containing generic evidence:

1. assertion or lint message
2. diff or actual/expected line when present
3. stack anchor when present
4. previous changed files
5. verifier command and exit code

The repair prompt tells the Agent to inspect current files, focus on the failing contract, and keep the original edit boundary. It does not contain repository-specific repair procedures. Reports expose:

1. `swe_agent_pass_count`
2. `verifier_attempt_count`
3. `repair_attempt_count`
4. `repair_loop_used`
5. `repair_loop_succeeded`
6. `repair_failure_evidence_count`
7. `repair_repeated_failure_count`
8. `repair_stagnation_detected`

When the same verifier failure repeats across repair passes, the next repair packet includes failure history and marks `stagnation_detected`. This tells the Agent to change repair hypothesis instead of repeating the same edit shape.

If SWE-agent fails at the provider, deployment, framework, protocol, timeout, or process-signal level before producing changed files, the adapter treats that pass as non-learning evidence. It records the Agent failure, skips the verifier for that pass, and does not feed a misleading verifier error into the repair loop. If changed files exist, the verifier still runs because there is a real patch to evaluate.

## Scoped Semantic Evidence

The adapter extracts compact evidence from verifier-passing prior patches:

1. return expressions
2. state captured before mutation
3. runtime and type assertions
4. test names
5. public type or API signatures

This evidence is scoped to the current task family or eval pair. It is advisory evidence for the LLM/Agent, not a Runtime-authored repair and not a source-code rule. The report measures whether the assisted run reused the prior successful invariants through:

1. `prior_success_invariant_count`
2. `prior_success_invariant_uptake_count`
3. `prior_success_invariant_uptake_rate`
4. `prior_success_invariant_missing_count`
5. `aionis_assistance_mode`
6. `aionis_context_char_count`
7. `aionis_context_budget_exceeded`

Low uptake with verifier regression means Aionis preserved process continuity but failed to rehydrate the decisive semantic evidence.

## Success Standard

Aionis is useful only when repeated frozen SWE-agent runs show:

1. higher verifier pass rate or no regression
2. fewer repeated discovery steps
3. fewer wrong-file touches
4. cleaner edit-boundary adherence
5. better first-action targeting
6. reusable scoped workflow candidates
7. controlled forgetting and maintenance evidence

The report also records SWE-agent trajectory token statistics when the trajectory exposes them through `info.model_stats`, including sent tokens, received tokens, API call count, and instance cost.

The report is measurement evidence only. It does not promote source-code rules by itself.
