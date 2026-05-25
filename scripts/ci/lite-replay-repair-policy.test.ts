import test from "node:test";
import assert from "node:assert/strict";
import { createReplayRepairReviewPolicy } from "../../src/app/replay-repair-review-policy.ts";

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    MEMORY_TENANT_ID: "local-tenant",
    MEMORY_SCOPE: "local-scope",
    REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_PROFILE: "custom",
    REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_DEFAULT: false,
    REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_TARGET_STATUS: "active",
    REPLAY_REPAIR_REVIEW_GATE_REQUIRE_SHADOW_PASS: true,
    REPLAY_REPAIR_REVIEW_GATE_MIN_TOTAL_STEPS: 1,
    REPLAY_REPAIR_REVIEW_GATE_MAX_FAILED_STEPS: 0,
    REPLAY_REPAIR_REVIEW_GATE_MAX_BLOCKED_STEPS: 0,
    REPLAY_REPAIR_REVIEW_GATE_MAX_UNKNOWN_STEPS: 0,
    REPLAY_REPAIR_REVIEW_GATE_MIN_SUCCESS_RATIO: 1,
    REPLAY_REPAIR_REVIEW_POLICY_JSON: "{}",
    ...overrides,
  } as any;
}

test("lite replay repair review policy applies global and endpoint defaults only", () => {
  const { withReplayRepairReviewDefaults } = createReplayRepairReviewPolicy({
    env: createEnv({
      REPLAY_REPAIR_REVIEW_POLICY_JSON: JSON.stringify({
        endpoint: {
          "*": {
            auto_promote_on_pass: true,
          },
          replay_playbook_repair_review: {
            auto_promote_target_status: "shadow",
            auto_promote_gate: {
              max_unknown_steps: 2,
            },
          },
        },
      }),
    }),
    tenantFromBody: (body) => String((body as Record<string, unknown>)?.tenant_id ?? ""),
    scopeFromBody: (body) => String((body as Record<string, unknown>)?.scope ?? ""),
  });

  const out = withReplayRepairReviewDefaults({
    tenant_id: "body-tenant",
    scope: "body-scope",
  });

  assert.equal(out.body.auto_promote_on_pass, true);
  assert.equal(out.body.auto_promote_target_status, "shadow");
  assert.deepEqual(out.body.auto_promote_gate, {
    require_shadow_pass: true,
    min_total_steps: 1,
    max_failed_steps: 0,
    max_blocked_steps: 0,
    max_unknown_steps: 2,
    min_success_ratio: 1,
  });
  assert.equal(out.resolution.tenant_id, "body-tenant");
  assert.equal(out.resolution.scope, "body-scope");
  assert.deepEqual(
    out.resolution.sources_applied.map((entry) => entry.key),
    ["*", "replay_playbook_repair_review"],
  );
  assert.equal(out.resolution.sources_applied.every((entry) => entry.layer === "endpoint"), true);
});

test("lite replay repair review policy rejects tenant-scoped overlays", () => {
  assert.throws(
    () =>
      createReplayRepairReviewPolicy({
        env: createEnv({
          REPLAY_REPAIR_REVIEW_POLICY_JSON: JSON.stringify({
            tenant_default: {
              "*": { auto_promote_on_pass: true },
            },
          }),
        }),
        tenantFromBody: () => "",
        scopeFromBody: () => "",
      }),
    /REPLAY_REPAIR_REVIEW_POLICY_JSON\.tenant_default is not supported in Lite/,
  );
});
