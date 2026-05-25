# Aionis Architecture Boundary

This focused copy keeps Aionis narrow: a local Runtime for execution continuity, evidence-gated self-learning, controlled forgetting, and learning control.

The product-level architecture contract is [FOCUSED_RUNTIME_ARCHITECTURE_CONTRACT.md](FOCUSED_RUNTIME_ARCHITECTURE_CONTRACT.md). This boundary document defines what must stay separated; the architecture contract defines the focused Runtime loop and implementation map.

The project has three layers. They must not be merged back together.

Project execution experience is data, not source code. Aionis may evolve its source when improving general mechanisms, but a project run must evolve memory, scoped rules, workflows, evidence, and forgetting state first.

## 1. Core Runtime

Core Runtime is the product.

It owns:

1. execution continuity
2. evidence grading
3. context packet assembly
4. learning candidates
5. workflow promotion
6. controlled forgetting
7. learning-control decisions

It may produce:

1. runtime context packets
2. evidence reports
3. learning candidates
4. workflow lifecycle decisions
5. forgetting decisions

It must not own:

1. external project verifier logic
2. LLM provider benchmarking
3. task-specific repair rules
4. eval-runner tool policy
5. testing-method preferences

Core source code may change for project-agnostic mechanism improvements. It must not change to encode a target project's concrete solution, path quirk, package behavior, or verifier answer.

Core hard invariants stay small:

1. do not apply unverified authority
2. quarantine provider/protocol failures from learning promotion
3. require real outcome evidence for workflow promotion
4. make blocked or suppressed authority visible

## 2. Real Eval Harness

Real Eval Harness is the proof system, not the product.

It owns:

1. real LLM provider calls
2. isolated workspace setup
3. baseline-vs-Aionis comparisons
4. external project verifier execution
5. effect gate reporting

It may produce:

1. real eval reports
2. effect gate results
3. provider health results
4. holdout/regression evidence

It must not own:

1. runtime memory promotion
2. core context packet contracts
3. product default policy
4. persistent user task rules

Real eval can support promotion, but the harness itself cannot become Core Runtime policy.

During a validation run, the Runtime version is fixed so the report measures Aionis behavior rather than a live source patch. After the run, source changes are allowed only for general mechanism defects; project-specific lessons remain scoped memory or experimental candidates.

## 3. Experimental Policies

Experimental Policies are candidates. They are not product truth by default.

They may include:

1. verifier phase classifiers
2. edit boundary experiments
3. tool recovery hints
4. repair plan candidates
5. task-family hypotheses

Their default authority is `soft_guidance` or `candidate_workflow`, never `hard_invariant`.

They must not:

1. become global hard rules from a single task
2. promote failed-run behavior into stable workflow authority
3. override Core evidence grading
4. turn project-specific paths or package quirks into cross-project rules
5. hide LLM exploration without evidence

Promotion requires scoped real success plus holdout or regression evidence.

## Evidence Grading

Aionis should not turn any testing style preference into product behavior. It grades evidence by how directly it proves real agent effectiveness.

Use this ordering when evaluating Aionis effectiveness:

1. real project verifier pass
2. real integration or end-to-end pass
3. real provider/runtime interaction pass
4. deterministic local contract pass
5. synthetic or fixture-only pass

Synthetic or fixture-only evidence can support local development, but it cannot prove Aionis product effectiveness or promote a workflow by itself.

## Runtime Output Shape

Aionis should output a compact `runtime_context_packet`, not a large rule wall.

The packet should include:

1. continuity summary
2. trusted evidence
3. current failure phase when proven
4. recommended target files
5. scoped workflow candidates
6. suppressed, stale, or contested memory
7. evidence grade and promotion state

LLM reasoning remains responsible for semantic code plans. Runtime constrains authority, evidence, lifecycle, and recall quality.

## Rule For New Work

Before adding a new hard rule, answer all questions:

1. Is it a Core hard invariant, or only an eval/experimental policy?
2. What evidence promoted it?
3. What is its scope?
4. What is its escape condition?
5. What holdout or regression run proves it does not narrow Aionis incorrectly?

If these answers are missing, keep the behavior as `soft_guidance` or `candidate_workflow`.
