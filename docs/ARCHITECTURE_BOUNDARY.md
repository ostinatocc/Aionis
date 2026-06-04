# Aionis Architecture Boundary

This focused copy keeps Aionis narrow: a local continuity memory Runtime for execution continuity, evidence-gated self-learning, controlled forgetting, dynamic learning control, and history-shaped future behavior.

Project execution experience is data, not source code. Aionis may evolve its source when improving general mechanisms, but a project run must evolve memory, scoped rules, workflows, evidence, and forgetting state first.

## Core Runtime

It owns:

1. execution continuity
2. evidence grading
3. context packet assembly
4. learning candidates
5. workflow promotion
6. controlled forgetting
7. learning-control decisions
8. history impact reporting

It may produce:

1. runtime context packets
2. evidence reports
3. learning candidates
4. workflow lifecycle decisions
5. forgetting decisions
6. history impact summaries

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

## Evidence Grading

Aionis should not turn any testing style preference into product behavior. It grades evidence by how directly it proves real agent effectiveness.

Use this ordering when evaluating Aionis effectiveness:

1. real project verifier pass
2. real integration or end-to-end pass
3. real provider/runtime interaction pass
4. deterministic local contract pass
5. local-only pass

Local-only evidence can support development, but it cannot prove Aionis product effectiveness or promote a workflow by itself.

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
8. history impact: what prior execution changed in this packet

LLM reasoning remains responsible for semantic code plans. Runtime constrains authority, evidence, lifecycle, and recall quality.

## Promotion Authority Boundary

Aionis promotion evidence separates two claims:

1. local reuse is allowed inside the current evidence scope
2. wider generalization is allowed beyond that scope

The first claim can be useful product memory. The second claim requires clean leakage posture, distinct-task or holdout
evidence, no regression or negative-transfer evidence, and sublinear growth when a learned structure claims to cover
multiple tasks.

Missing wider-generalization evidence must keep the behavior scoped. It must not become source code, a global Runtime rule,
host-specific policy, provider-specific policy, or architecture vocabulary.

## Rule For New Work

Before adding a new hard rule, answer all questions:

1. Is it one of the small Core hard invariants?
2. What evidence promoted it?
3. What is its scope?
4. What is its escape condition?
5. What holdout or regression run proves it does not narrow Aionis incorrectly?

If these answers are missing, keep the behavior as `soft_guidance` or `candidate_workflow`.
