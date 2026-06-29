# Aionis Admission Profile Activation Quickstart

Status: selected-profile activation guide for v0.3.x

This guide shows how to turn on the reviewed closed-loop admission candidate for
one bounded guide profile while keeping the Runtime global default off.

Use this when a host already calls `/v1/guide` with stable scope, role, and
context-mode fields and wants Aionis to apply the selected admission policy only
to that profile.

## What This Enables

The selected candidate policy is:

```text
candidate_project_context_closed_loop_inspect
```

When active for a matching profile, it can downgrade prompt-facing direct-use
memory from `use_now` to `inspect_before_use` when closed-loop evidence says the
memory should not be trusted as immediate instruction.

It does not:

- make the policy global;
- mutate stored memories;
- change lifecycle or authority states;
- activate external-backend candidates;
- upgrade hard-boundary memory into `use_now`.

## Reviewed Profile

The current v0.3 selected profile id is:

```text
external-agent-e2e-worker-full-power
```

That id is a label emitted in `source_map.admission_candidate_policy.profile_id`.
It is not a selector by itself. The rule must also include real selectors such
as scope, scope prefix, task family, task signature, agent role, context mode,
or guide mode.

## Runtime Configuration

Keep the global mode off and add a narrow profile rule:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
export AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON='[
  {
    "profile_id": "external-agent-e2e-worker-full-power",
    "mode": "active",
    "scope_prefixes": ["my-project:"],
    "agent_roles": ["worker"],
    "context_modes": ["compact_agent"],
    "guide_modes": ["full_power"]
  }
]'
```

For a local `.env`, keep it on one line:

```env
AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON=[{"profile_id":"external-agent-e2e-worker-full-power","mode":"active","scope_prefixes":["my-project:"],"agent_roles":["worker"],"context_modes":["compact_agent"],"guide_modes":["full_power"]}]
```

Replace `my-project:` with the prefix your host actually uses for Aionis
scopes. The rule above only matches guide calls whose scope starts with
`my-project:`, whose `agent_role` is `worker`, whose `context_mode` is
`compact_agent`, and whose guide `mode` is `full_power`.

Template file:
[examples/admission-profile-rules.env](examples/admission-profile-rules.env).

Copy the two `AIONIS_ADMISSION_*` variables from that file into the Runtime
`.env`, replacing any existing values for the same keys.

## Matching Guide Request

The host must send the fields that the profile rule selects on:

```bash
curl -s http://127.0.0.1:3001/v1/guide \
  -H 'content-type: application/json' \
  -d '{
    "tenant_id": "default",
    "scope": "my-project:checkout-runtime",
    "mode": "full_power",
    "context_mode": "compact_agent",
    "agent_role": "worker",
    "consumer_agent_id": "worker-1",
    "query_text": "Continue the current implementation path.",
    "limit": 8
  }' | jq '.source_map.admission_candidate_policy'
```

Expected shape:

```json
{
  "mode": "active",
  "source": "profile_rule",
  "profile_id": "external-agent-e2e-worker-full-power"
}
```

If the response shows `"source": "off"`, the rule did not match. Check the
actual `scope`, `mode`, `context_mode`, `agent_role`, `context.task_family`, or
`context.task_signature` fields your host sends.

## Optional Task Selectors

Use task selectors when your host emits stable task metadata:

```json
{
  "profile_id": "external-agent-e2e-worker-full-power",
  "mode": "active",
  "scope_prefixes": ["repo:"],
  "task_families": ["coding_continuation"],
  "agent_roles": ["worker"],
  "context_modes": ["compact_agent"],
  "guide_modes": ["full_power"]
}
```

Matching guide request:

```json
{
  "scope": "repo:aionis-runtime",
  "mode": "full_power",
  "context_mode": "compact_agent",
  "agent_role": "worker",
  "context": {
    "task_family": "coding_continuation"
  }
}
```

## Rollback

Rollback is immediate:

```bash
export AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=off
export AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON='[]'
```

Restart the Runtime after changing `.env` values.

## Evidence Boundary

The profile-scoped multi-step tool-E2E gate passed for the selected profile:

- `40 / 40` accepted-route;
- `40 / 40` action-completion;
- `0` route write/action violations;
- `0` terminal inspect exits;
- `0` report-conflict exits;
- `40 / 40` guide source checks from `profile_rule`;
- `40 / 40` guide profile checks for
  `external-agent-e2e-worker-full-power`.

The global Runtime default remains `off`. Additional profiles should pass the
same profile-source and tool-E2E gate before being treated as default product
guide paths.

See also:

- [AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md](AIONIS_ADMISSION_DEFAULT_ACTIVE_REVIEW.md)
- [AIONIS_ADMISSION_POLICY_PROMOTION_STATUS.md](AIONIS_ADMISSION_POLICY_PROMOTION_STATUS.md)
- [AIONIS_ADMISSION_TOOL_E2E_GATE_RUNBOOK.md](AIONIS_ADMISSION_TOOL_E2E_GATE_RUNBOOK.md)
