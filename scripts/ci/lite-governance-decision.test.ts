import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGovernedMemory,
  type FeedbackPostureInput,
  type GovernanceRequestContext,
  type MemoryStateInput,
} from "../../src/memory/governance-decision.ts";
import { authorityConsumptionStateFromValue } from "../../src/memory/authority-consumption.ts";
import { lifecycleDecisionInputForMemory } from "../../src/memory/memory-lifecycle-adjudicator.ts";

const baseMemory: MemoryStateInput = {
  memory_id: "mem-current",
  authority: "trusted",
  lifecycle_state: "active",
  domain: "execution",
  execution_kind: "current_state",
  memory_contract: "direct_use",
  target_files: ["src/runtime.ts"],
};

const baseRequest: GovernanceRequestContext = {
  scope_match: "exact_task",
  premise_conflict: "none",
  trusted_workflow_conflict: false,
  verified_recovered_handoff: false,
  rehydrate_requested: false,
  lifecycle_candidate: "none",
  projected_surface: null,
};

const noFeedback: FeedbackPostureInput = { posture: "none" };

function decide(args: {
  memory?: Partial<MemoryStateInput>;
  request?: Partial<GovernanceRequestContext>;
  outcome?: "passed_solution" | "failed_branch" | "blocked" | "unknown";
  transition?: "request_rehydrate" | "other" | null;
  feedback?: FeedbackPostureInput;
}) {
  const memory = { ...baseMemory, ...args.memory };
  return decideGovernedMemory({
    memory,
    request: { ...baseRequest, ...args.request },
    lifecycle: lifecycleDecisionInputForMemory({
      lifecycle_state: memory.lifecycle_state,
      execution_outcome_role: args.outcome ?? "passed_solution",
      transition_kind: args.transition ?? null,
    }),
    authority: authorityConsumptionStateFromValue({ authority_blocked: memory.authority === "blocked" }),
    feedback: args.feedback ?? noFeedback,
  });
}

test("governance decision hard boundaries dominate every direct-use signal", () => {
  const cases = [
    {
      name: "blocked authority",
      args: { memory: { authority: "blocked" as const } },
      reasons: ["lifecycle_active", "blocked_authority", "scope_exact_task", "blocked_from_agent_use"],
    },
    {
      name: "suppressed lifecycle",
      args: { memory: { lifecycle_state: "suppressed" as const } },
      reasons: ["lifecycle_suppressed", "authority_trusted", "scope_exact_task", "blocked_from_agent_use"],
    },
    {
      name: "archived lifecycle",
      args: { memory: { lifecycle_state: "archived" as const }, request: { rehydrate_requested: true } },
      reasons: ["lifecycle_archived", "authority_trusted", "scope_exact_task", "blocked_from_agent_use"],
    },
    {
      name: "failed execution",
      args: { outcome: "failed_branch" as const },
      reasons: ["lifecycle_active", "execution_outcome_failed_branch", "authority_trusted", "scope_exact_task", "blocked_from_agent_use"],
    },
    {
      name: "blocked premise",
      args: { request: { premise_conflict: "block" as const } },
      reasons: ["lifecycle_active", "authority_trusted", "scope_exact_task", "premise_conflict_block", "blocked_from_agent_use"],
    },
  ];

  for (const entry of cases) {
    const decision = decide(entry.args);
    assert.equal(decision.surface, "do_not_use", entry.name);
    assert.equal(decision.actionable, false, entry.name);
    assert.deepEqual(decision.reason_codes, entry.reasons, entry.name);
  }
});

test("governance decision preserves rehydrate and inspect-only states", () => {
  const rehydrate = decide({ transition: "request_rehydrate" });
  assert.equal(rehydrate.surface, "rehydrate");
  assert.equal(rehydrate.requires_rehydrate, true);
  assert.deepEqual(rehydrate.reason_codes, [
    "lifecycle_active",
    "transition_request_rehydrate",
    "authority_trusted",
    "scope_exact_task",
    "requires_differential_rehydration",
  ]);

  const candidate = decide({ memory: { authority: "candidate" } });
  assert.equal(candidate.surface, "inspect_before_use");
  assert.deepEqual(candidate.reason_codes, [
    "lifecycle_active",
    "candidate_authority",
    "scope_exact_task",
    "authority_requires_inspection",
    "kept_out_of_direct_use",
  ]);

  const contested = decide({ memory: { lifecycle_state: "contested", authority: "advisory" } });
  assert.equal(contested.surface, "inspect_before_use");
  assert.deepEqual(contested.reason_codes, [
    "lifecycle_contested",
    "authority_advisory",
    "scope_exact_task",
    "lifecycle_requires_inspection",
    "kept_out_of_direct_use",
  ]);
});

test("governance decision keeps task, workflow, and family scope while excluding unrelated memory", () => {
  const scopeCases = [
    ["exact_task", "scope_exact_task", "use_now"],
    ["workflow", "scope_workflow", "use_now"],
    ["task_family", "scope_task_family", "use_now"],
    ["unrelated", "scope_unrelated", "not_agent_facing"],
  ] as const;
  for (const [scopeMatch, scopeReason, surface] of scopeCases) {
    const decision = decide({ request: { scope_match: scopeMatch } });
    assert.equal(decision.surface, surface);
    assert.deepEqual(decision.reason_codes, [
      "lifecycle_active",
      "authority_trusted",
      scopeReason,
      surface === "use_now" ? "direct_use_eligible" : "scope_excluded_from_agent_context",
      surface === "use_now" ? "available_for_agent_use" : "not_agent_facing",
    ]);
  }
});

test("governance decision applies conflict, handoff, lifecycle-candidate, and feedback precedence", () => {
  const premise = decide({ request: { premise_conflict: "inspect" } });
  assert.equal(premise.surface, "inspect_before_use");
  assert.ok(premise.reason_codes.includes("premise_conflict_requires_inspection"));

  const workflowConflict = decide({ request: { trusted_workflow_conflict: true } });
  assert.equal(workflowConflict.surface, "inspect_before_use");
  assert.ok(workflowConflict.reason_codes.includes("trusted_workflow_conflict_requires_inspection"));

  const handoff = decide({
    memory: { authority: "candidate", lifecycle_state: "candidate", execution_kind: "handoff" },
    request: { verified_recovered_handoff: true },
  });
  assert.equal(handoff.surface, "use_now");
  assert.ok(handoff.reason_codes.includes("verified_recovered_handoff"));

  const admittedCandidate = decide({
    memory: { authority: "candidate" },
    request: { lifecycle_candidate: "direct_use" },
  });
  assert.equal(admittedCandidate.surface, "use_now");
  assert.ok(admittedCandidate.reason_codes.includes("lifecycle_candidate_direct_use_admitted"));

  const positiveDoesNotPromote = decide({
    memory: { authority: "candidate" },
    feedback: { posture: "positive_attribution" },
  });
  assert.equal(positiveDoesNotPromote.surface, "inspect_before_use");
  assert.ok(positiveDoesNotPromote.reason_codes.includes("feedback_positive_attribution"));

  const strongNegative = decide({ feedback: { posture: "strong_counter_signal" } });
  assert.equal(strongNegative.surface, "inspect_before_use");
  assert.ok(strongNegative.reason_codes.includes("feedback_strong_counter_signal"));
});

test("governance decision is deterministic and does not mutate domain records", () => {
  const memory = { ...baseMemory, target_files: ["src/runtime.ts", "src/guide.ts"] };
  const input = {
    memory,
    request: baseRequest,
    lifecycle: lifecycleDecisionInputForMemory({
      lifecycle_state: memory.lifecycle_state,
      execution_outcome_role: "passed_solution",
      transition_kind: null,
    }),
    authority: authorityConsumptionStateFromValue({ authority_blocked: memory.authority === "blocked" }),
    feedback: noFeedback,
  } as const;
  const before = structuredClone(input);
  assert.deepEqual(decideGovernedMemory(input), decideGovernedMemory(input));
  assert.deepEqual(input, before);
});
