# Learning-Control Generalization Principles

Aionis must not become a pile of task-specific hard rules.

The product goal is agent-visible execution continuity, self-learning, controlled forgetting, and learning control. New learning should improve real future runs without making unrelated tasks brittle.

## Core Principle

Every failed real run is evidence, not automatically a new global rule.

Before adding a constraint, classify what kind of evidence it is, decide its scope, define when it expires or yields, and prove it does not regress prior real tasks.

## Source Code vs Runtime Memory

Aionis source code is the general learning system. Runtime memory is where project execution experience lives.

Project work may change:

1. execution memory
2. workflow candidates
3. scoped rule candidates
4. counter-evidence
5. promotion, demotion, retirement, archive, and forgetting state
6. evaluation reports

Project work must not directly change Aionis source code to encode that project's answer.

Self-evolution means that Aionis improves through governed memory, scoped rules, workflow promotion, counter-evidence, and controlled forgetting. It does not mean rewriting Core Runtime every time a project exposes a concrete fix.

## Development Modes

Aionis has three different modes of work. They must not be mixed.

### 1. System Development Mode

In system development mode, Aionis source code may and should change.

Allowed source changes are general mechanisms:

1. memory evolution contracts
2. evidence grading
3. scope assignment and promotion gates
4. demotion, retirement, archive, and forgetting policies
5. context packet shape
6. learning-control adjudication
7. store-port boundaries
8. provider/protocol quarantine
9. evaluation protocol correctness

Disallowed source changes are project answers:

1. repository-specific repair procedures
2. issue-specific implementation plans
3. package-specific API quirks promoted into Core
4. verifier-specific answer strings
5. path-specific fixes from one task
6. one-off hints that only help the current project pass

### 2. Task Validation Mode

In task validation mode, Aionis source code is frozen for that run.

Frozen means:

1. the Runtime version is recorded before the run starts
2. the agent may write to the target project workspace
3. Aionis may write runtime memory, reports, and scoped candidates
4. Aionis source code is not edited to satisfy that task
5. the verifier is not changed to match the attempted fix

This freeze is a measurement rule. It is not a ban on developing Aionis. It prevents a task result from being confused with a system patch.

### 3. Post-Run System Improvement Mode

After a validation run ends, Aionis source code may change again.

The source change is allowed only when the evidence shows a general mechanism defect, such as:

1. memory was extracted at the wrong scope
2. a useful workflow was not represented as a candidate
3. failed evidence was promoted too strongly
4. stale guidance was not forgotten
5. the context packet hid important evidence
6. provider/protocol failure contaminated learning
7. the evaluation protocol failed to measure the right thing

The source change must not encode the target project's concrete solution. The project trace remains data; the Runtime change must be project-agnostic.

## Constraint Hierarchy

### 1. Hard Constraints

Use hard constraints only for invariants that should never be violated:

1. do not edit forbidden files
2. run required verifiers before claiming success
3. do not use non-live pass results as effectiveness proof
4. do not claim success from memory alone
5. do not turn provider/API failures into code-learning signals
6. do not promote failed execution evidence into stable authority

Hard constraints are product safety and truthfulness boundaries. They are not the main learning mechanism.

### 2. Evidence-Scoped Governance Signals

Use strong governance only for high-confidence, current-run evidence:

1. diagnostics with concrete file and line anchors
2. verifier assertions with clear scope
3. dependency or package contract evidence
4. hidden contract failures with stable source anchors
5. destructive or out-of-bound edits
6. provider/protocol failures

These signals are not semantic repairs. They describe evidence authority, risk, scope, and consequence. They may bias the
agent toward a narrower area, require explicit verification, or lower promotion authority, but they must not turn into a
repo-specific repair script or a permanent action lock.

Every strong signal needs an escape path. If the next verifier output contradicts the current phase, Aionis must lower
confidence, preserve counter-evidence, and let the agent re-evaluate the hypothesis. Repeated failure on the same attractor
is a plasticity signal before it is a reason for another hard constraint.

Verifier output is evidence, not truth by default. Aionis should classify whether a mentioned path, symbol, line, or
assertion is anchored, incidental, stale, or provider-contaminated. Unanchored evidence can stay visible, but it should not
gain blocking authority.

No-op edits, malformed tool payloads, stale anchors, and provider protocol failures are execution-quality signals. They
should be quarantined from code-learning authority. They can lower confidence in the current candidate or trigger a
different interaction style, but they should not become product rules about how to repair a specific project.

Runtime should not take over semantic execution from the LLM/Agent. When Aionis has strong evidence, it should expose
that evidence with authority, uncertainty, consequence, and boundary metadata. The LLM/Agent still chooses and performs
the repair path. If repeated guidance fails to improve the run, Aionis should treat that as an entropy signal: widen
exploration, surface counter-evidence, or lower confidence instead of adding another fixed action constraint.

Sparse feedback attribution follows the product gate in
[SPARSE_FEEDBACK_LEARNING_CONTROL_GATE.md](SPARSE_FEEDBACK_LEARNING_CONTROL_GATE.md). Threshold-met negative feedback and
repeated unused exposure without positive attribution may become candidate-only learning-control evidence, but the
summary itself must not mutate authority or enter the Agent prompt.

Sparse feedback confidence decay follows
[SPARSE_FEEDBACK_CONFIDENCE_DECAY_GATE.md](SPARSE_FEEDBACK_CONFIDENCE_DECAY_GATE.md). It may surface shadow candidates
for memory that should be trusted less, including threshold-met feedback, repeated unused exposure, and temporal
staleness. Positive attribution and recent validation block decay candidacy. The summary remains measure/debug/audit
only and must not demote, suppress, archive, or rewrite guide authority.

### 3. Soft Strategies

Use soft strategies for reusable engineering heuristics:

1. repair runtime behavior before writing tests-only fixes
2. after a verifier failure, inspect the latest failing file before broad exploration
3. keep package/runtime/test/docs contracts coupled when the verifier names all of them
4. avoid repeating failed tool actions when the runner already returned corrective feedback

Soft strategies should have weights, confidence, source evidence, and scope. They may guide the agent, but they should not block valid work unless promoted by stronger evidence.

Dynamic entropy is the escape valve for over-governance. When repeated real verifier failures show that a candidate or locked repair path is becoming an attractor, Aionis should first allow a bounded counterfactual probe before adding another hard constraint. The probe is read/search-only, evidence-scoped, and must return to the verifier. It may gate the next write, verifier, or broad exploration step, but it should not block narrow diagnostic reads/searches on the current repair anchor. It is not a project-specific rule and it does not grant promotion authority.

Dynamic entropy must be balanced with fresh evidence. Concrete diagnostics can justify focused attention, but repeated
stagnation should raise exploration pressure rather than tighten the same loop. Exploration is useful for escaping
uncertain attractors; governance is useful for preserving evidence authority and preventing unsafe promotion.

Semantic candidates need lifecycle control, not execution takeover. Aionis may retain, demote, rotate, suppress, or archive
candidate hypotheses based on real verifier outcomes. It should not decide the code repair itself. The candidate remains
learning material until a real run proves it useful.

Execution failures are separate from semantic failures. Malformed payloads, stale anchors, provider truncation, and invalid
tool responses should be recorded as interaction evidence and quarantined from learning authority. They may change how much
structure Aionis gives the next agent turn, but they must not become repository-specific source policy.

### 4. Local Memory

Task-specific and project-specific findings stay local unless repeated evidence proves they generalize.

For example, one repository may teach a repository-local repair plan for a dependency or API contract. It must not become a global language or ecosystem rule unless distinct real tasks prove the wider scope.

## Scope Ladder

Promote learning through explicit scopes:

1. `exact_task`
2. `task_family`
3. `repository`
4. `ecosystem`
5. `global`

Default new learning to the narrowest valid scope. Promotion to a wider scope requires repeated real evidence from distinct tasks or projects.

## Promotion Requirements

A rule or strategy can only move upward when it has:

1. successful verifier evidence
2. no provider/protocol-only contamination
3. no forbidden-file writes
4. no regression against previously passing real tasks
5. clear applicability conditions
6. a defined escape condition

Failed evidence can create repair guidance. It cannot create stable authority by itself.

Successful replay evidence is continuity evidence first. It can prove that Aionis preserved and reused a real
verifier-passing trace, reduced rediscovery, or avoided a known failed path. It should stay scoped to `exact_task`,
`task_family`, or `repository` until a fresh holdout proves that the same guidance helps a distinct task without replaying
the exact prior patch.

## Evidence Promotion Protocol

Aionis separates local reuse from wider generalization.

A memory, workflow, pattern, or policy can be useful inside its current scope without being allowed to become a broader
Runtime behavior. Promotion evidence therefore records two independent outcomes:

1. `local_reuse_allowed`: the evidence is strong enough to reuse inside the current scope.
2. `wider_generalization_allowed`: the evidence is strong enough to widen beyond the current scope.

Wider generalization requires more than a successful current task. It needs:

1. clean leakage posture
2. holdout or distinct-task evidence
3. no regression or negative-transfer evidence
4. provider/protocol contamination quarantined away from learning authority
5. task-specific details kept out of Runtime source behavior
6. sublinear growth when a learned structure claims to cover multiple tasks

If these gates are missing, the learning can remain useful local memory, but it must not become a global rule, source-code
mechanism, host policy, provider policy, or architecture vocabulary.

This protocol is inspired by evidence-gated research discipline, but Aionis does not import external research harnesses,
symbolic primitives, basis catalogs, repository tasks, or task solutions. The product mechanism is only the generic
promotion discipline.

## Regression Discipline

Every new hard constraint or strong repair gate must be checked against:

1. focused unit and contract tests
2. prior passing real-eval reports when applicable
3. at least one holdout task family before being treated as general
4. the current failing task through a fresh real run when behavior changed

Passing the current task is not enough. Aionis must avoid overfitting to the latest failure.

## Generalization Workflow

When a real task fails:

1. classify the failure phase: provider, tool protocol, edit operation, lint/type, authored test, package/dependency, hidden contract, or environment
2. extract concrete file, line, command, and verifier assertions
3. choose the narrowest scope for the lesson
4. decide whether the lesson is a hard constraint, phase-local gate, soft strategy, or local memory
5. add escape conditions before enforcing the lesson
6. verify that previous passing tasks still pass
7. only then promote the lesson into broader Runtime guidance

When a real task succeeds:

1. store the execution trace and verifier evidence
2. extract the workflow candidate at the narrowest correct scope
3. record the exact conditions that made the workflow valid
4. record what would make the workflow invalid
5. keep the candidate scoped until distinct evidence promotes it
6. use forgetting and counter-evidence when later runs conflict

The first destination for both failure and success is runtime memory. Aionis source code changes only when the run exposes a general system mechanism gap.

Control improvements from failed real runs are allowed, but they have lower authority than successful repair workflows.
A failed run may justify better phase classification, stronger provider/protocol quarantine, clearer evidence authority,
or a safer promotion threshold. It must not promote the attempted code repair itself, and it must not turn the failed
project's details into Runtime source policy.

Repeated verifier or interaction failure should become candidate forgetting signals. Aionis should record what failed,
why the failure is scoped, what evidence would revive the candidate, and whether the failure is semantic, interactional,
provider-related, or boundary-related. The Runtime response is confidence adjustment and lifecycle control, not hard-coded
repair behavior.

## Source Change Checklist

Before changing Aionis source code from real-task evidence, answer all of these:

1. What is the general Runtime mechanism defect?
2. Would the same source change make sense if all project names and file paths were removed?
3. Which memory object should hold the project-specific lesson instead?
4. What scope does the lesson start in?
5. What promotion evidence is required before the lesson widens?
6. What counter-evidence or expiry condition demotes or forgets it?
7. Which guard prevents the project-specific content from entering Core?

If any answer is missing, write memory or an experimental candidate instead of source code.

## Design Bias

Prefer better failure classification, scoped confidence, and adaptive next-action selection over adding permanent rules.

Prefer reversible guidance over one-way locks.

Prefer evidence-gated promotion over automatic self-learning.

Prefer controlled forgetting of stale or harmful guidance over accumulating every lesson forever.

## LLM Semantic Candidates

LLM classification may extend Aionis's generalization radius, but it must stay a candidate producer. It can name a semantic hypothesis for unknown or hidden verifier failures, but it cannot create a hard rule, mark a workflow reusable, or override verifier phase, edit boundary, provider/protocol quarantine, or promotion gates.

Every LLM semantic candidate must carry:

1. source phase
2. semantic hypothesis
3. contract kind
4. target files inside the edit boundary
5. concrete evidence from verifier output or failed tool results
6. suggested actions
7. scope
8. confidence
9. escape condition
10. promotion requirements

Runtime adjudication must keep new semantic candidates in `candidate` state until a later real run passes the verifier with the candidate in the guidance packet. Promotion beyond task-local guidance also requires clean provider/protocol diagnostics, no edit-boundary violation, and regression or holdout evidence.

## Success Standard

Aionis is improving when it:

1. reduces repeated discovery
2. reaches the correct first repair area earlier
3. avoids repeating known failed actions
4. keeps the edit boundary clean
5. passes the real verifier more often
6. preserves performance on previous and holdout tasks

If a new rule improves one task but harms general execution, the rule is too broad.
