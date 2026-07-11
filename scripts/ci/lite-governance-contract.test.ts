import test from "node:test";
import assert from "node:assert/strict";
import {
  AionisGuidanceAuthoritySchema,
  AionisMemoryDecisionSurfaceSchema,
  GovernanceDecisionV1Schema,
} from "../../src/memory/governance-contract.ts";

const baseDecision = {
  memory_id: "mem-1",
  authority: "advisory",
  lifecycle_state: "active",
  reason_codes: ["authority_advisory"],
  target_files: ["src/runtime.ts"],
};

test("governance contract freezes exact decision surfaces and guidance authorities", () => {
  assert.deepEqual(AionisMemoryDecisionSurfaceSchema.options, [
    "use_now",
    "inspect_before_use",
    "do_not_use",
    "rehydrate",
    "not_agent_facing",
  ]);
  assert.deepEqual(AionisGuidanceAuthoritySchema.options, [
    "trusted",
    "advisory",
    "candidate",
    "blocked",
    "none",
  ]);
  assert.equal(AionisMemoryDecisionSurfaceSchema.safeParse("context").success, false);
  assert.equal(AionisGuidanceAuthoritySchema.safeParse("read_only").success, false);
});

test("governance decisions distinguish actionable use from read-only surfaces", () => {
  const accepted = [
    { surface: "use_now", actionable: true, requires_rehydrate: false },
    { surface: "inspect_before_use", actionable: false, requires_rehydrate: false },
    { surface: "do_not_use", actionable: false, requires_rehydrate: false },
    { surface: "rehydrate", actionable: false, requires_rehydrate: true },
    { surface: "not_agent_facing", actionable: false, requires_rehydrate: false },
  ] as const;
  for (const decision of accepted) {
    assert.equal(GovernanceDecisionV1Schema.safeParse({ ...baseDecision, ...decision }).success, true);
  }

  const rejected = [
    { surface: "use_now", actionable: false, requires_rehydrate: false },
    { surface: "inspect_before_use", actionable: true, requires_rehydrate: false },
    { surface: "rehydrate", actionable: false, requires_rehydrate: false },
    { surface: "use_now", actionable: true, requires_rehydrate: true },
  ];
  for (const decision of rejected) {
    assert.equal(GovernanceDecisionV1Schema.safeParse({ ...baseDecision, ...decision }).success, false);
  }
});

test("governance decisions strictly bound reason codes and target files", () => {
  const boundary = {
    ...baseDecision,
    surface: "use_now",
    actionable: true,
    requires_rehydrate: false,
    reason_codes: Array.from({ length: 16 }, (_, index) => index === 0 ? "r".repeat(128) : `reason_${index}`),
    target_files: Array.from({ length: 16 }, (_, index) => index === 0 ? "p".repeat(2048) : `src/file-${index}.ts`),
  };
  assert.equal(GovernanceDecisionV1Schema.safeParse(boundary).success, true);
  assert.equal(GovernanceDecisionV1Schema.safeParse({
    ...boundary,
    reason_codes: [...boundary.reason_codes, "reason_17"],
  }).success, false);
  assert.equal(GovernanceDecisionV1Schema.safeParse({
    ...boundary,
    target_files: [...boundary.target_files, "src/file-17.ts"],
  }).success, false);
  assert.equal(GovernanceDecisionV1Schema.safeParse({
    ...boundary,
    reason_codes: ["r".repeat(129)],
  }).success, false);
  assert.equal(GovernanceDecisionV1Schema.safeParse({
    ...boundary,
    target_files: ["p".repeat(2049)],
  }).success, false);
  assert.equal(GovernanceDecisionV1Schema.safeParse({ ...boundary, unexpected: true }).success, false);
});
