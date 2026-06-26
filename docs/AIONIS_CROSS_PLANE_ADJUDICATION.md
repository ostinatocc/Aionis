# Aionis Cross-Plane Adjudication

Status: implemented product contract for Agent Context compilation

Aionis does not use one central state machine for every subsystem. The Runtime
is built from bounded state planes: execution state, execution tree, lifecycle,
tier, workflow promotion, pattern credibility, learning-control, and operator
projection.

Cross-plane adjudication is the product contract that decides how those planes
collapse into one Agent-facing context.

## Boundary

This contract is not an Agent scheduler, workflow engine, or model router.

External hosts still own:

1. which Agent acts next
2. which model is called
3. which tool is executed
4. when a task is complete
5. retry and queue policy

Aionis owns the memory state decision:

1. which memory can directly shape action
2. which memory must be inspected first
3. which memory is blocked as direction
4. which memory requires raw payload rehydration
5. which decision trace explains the result

## Output Surfaces

The adjudication result is visible in these product surfaces:

| Surface | Meaning |
|---|---|
| `use_now` | Memory survived lifecycle, authority, and risk gates and can shape the current context. |
| `inspect_before_use` | Memory is relevant but candidate, contested, stale-risk, or review-gated. |
| `do_not_use` | Memory is blocked, archived, retired, failed, suppressed, or unsafe as direction. |
| `rehydrate` | Memory is a compact pointer or raw-trace candidate; recover payload before relying on exact details. |
| `command_posture` | Agent-readable action posture: `should_continue`, `inspect_first`, `must_not`, `rehydrate_first`, or `optional_context`. |
| `memory_decision_trace` | Audit trail for why the memory landed on a surface. |

## Precedence

When planes disagree, the more conservative state wins before Agent Context is
rendered.

1. **Hard block/archive wins.**
   Suppression, archive relocation, explicit `lifecycle_state=archived`,
   `policy_memory_state=retired`, failed branches, and blocked authority cannot
   enter `use_now`.

2. **Rehydrate wins over direct use.**
   `rehydration_candidate`, raw payload pointers, trace-only summaries, or
   `request_rehydrate` transitions become `rehydrate` hints. The Agent receives
   a pointer first, not an unsupported exact instruction.

3. **Inspect wins over direct use.**
   Candidate lifecycle, contested policy/credibility, demotion,
   learning-control `inspect_before_use`, or repeated counter-signals move the
   memory to `inspect_before_use`.

4. **Direct use requires aligned positive state.**
   `use_now` requires active lifecycle plus enough authority for the memory
   family. Execution current-state and procedure memories become direct
   commands only after they survive lifecycle, authority, and negative-transfer
   gates.

5. **Everything else is context, not command.**
   Relevant memory that lacks execution command authority may appear only as
   optional context.

## Conflict Examples

| Plane Conflict | Agent Context Result |
|---|---|
| `tier=hot` but `lifecycle_state=contested` | `inspect_before_use`; hot tier does not override lifecycle risk. |
| Stable promotion evidence but learning-control asks inspection | `inspect_before_use`; promotion cannot bypass review posture. |
| Execution says continue but memory is `rehydration_candidate` | `rehydrate`; exact action waits for raw payload recovery. |
| Trusted pattern but `policy_memory_state=retired` | `do_not_use`; retired policy blocks direct reuse. |
| Positive feedback exists but repeated counter-signals exist | `inspect_before_use`; counter-evidence prevents direct use. |
| High authority but explicit `lifecycle_state=archived` | `do_not_use`; archive state blocks prompt influence. |

## Implementation Anchors

Current focused Runtime anchors:

1. `src/memory/product-output-assembler.ts`
   - computes memory lifecycle, authority, rehydration, command posture, and
     Agent Context surfaces.
2. `src/memory/node-execution-surface.ts`
   - resolves execution-native policy, credibility, target, trust, and
     lifecycle-adjacent slot signals.
3. `src/memory/memory-lifecycle-adjudicator.ts`
   - adjudicates lifecycle relations before product output assembly.
4. `src/routes/product-facade.ts`
   - exposes `/v1/observe`, `/v1/guide`, feedback, measure, govern, and
     operator-facing product routes.

Regression coverage lives in
`scripts/ci/lite-cross-plane-adjudication.test.ts`.

## Product Rule

Aionis is allowed to be conservative. A relevant memory can be useful evidence
without being safe as a next-action instruction.

That is the distinction this contract protects.
