# Aionis And OpenRouter Fusion

Aionis can work beside OpenRouter Fusion or any multi-model reviewer, but
Aionis should not become a model router.

## Product Position

Aionis is the execution memory layer. It records plans, decisions, failed
branches, acceptance checks, feedback, and admission decisions, then compiles
safe Agent context.

Fusion-style systems can help a host choose or review model output. That is
useful for planner quality, but it is outside Aionis Runtime authority.

```text
model reviewer = advisory evidence
Aionis admission gate = Runtime authority
```

## Safe Integration Shape

Use Fusion before Aionis admission, not after it:

1. A planner creates a plan.
2. Fusion or another reviewer checks the plan for blind spots.
3. The host accepts or rejects planner/reviewer suggestions.
4. Aionis observes accepted decisions as execution evidence.
5. Aionis observes rejected or failed routes as counter-evidence.
6. Aionis guide compiles worker context.
7. The worker acts.
8. Aionis feedback and measure attribute the outcome.

This keeps model review useful without allowing model review to bypass memory
governance.

## Hard Boundary

Fusion, a planner model, a worker model, or a reviewer model cannot upgrade a
memory into `use_now` if Aionis gates classify it as:

- `do_not_use`
- failed branch
- stale
- contested
- suppressed
- archived
- out of scope
- untrusted source
- rehydrate-required

The reviewer may explain why a memory looks useful. Aionis still decides whether
that memory can direct the Agent.

## Recommended Flow For Plan Assets

```text
strong planner -> plan draft
optional Fusion review -> advisory critique
host accepts final plan
-> Aionis planAssetObserveEvents()
-> Aionis guide
-> cheaper worker/reviewer
-> Aionis feedback + measure + Flight Recorder
```

The important product claim is not that Aionis picks the best model. The claim
is that a high-quality plan can survive across cheaper workers, future sessions,
and multi-agent handoffs without turning failed branches into future
instructions.

## Why This Matters

Without Aionis, a planner's output often becomes either raw prompt history or a
loose markdown artifact. Both are hard to audit and easy to misuse.

With Aionis, the plan becomes an admitted memory asset:

- accepted decisions become current execution state
- acceptance checks become worker boundaries
- rejected routes become counter-evidence
- missing artifacts become pending work, not stale memory
- feedback attributes whether the plan actually helped
- Flight Recorder can replay what the worker could see at decision time

## Non-Goals

This document does not add OpenRouter API integration to Runtime core.

Provider keys, model routing policies, cost routing, and fallback selection
belong in the host application. Aionis should stay provider-agnostic and enforce
memory admission after the host has produced candidate plans or evidence.
