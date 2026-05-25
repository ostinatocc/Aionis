import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeEntropyControlsV1 } from "../../src/memory/runtime-entropy-controls.ts";
import {
  ActionIntelligenceRuntimeLifecycleSchema,
  RuntimeEntropyProfileV1Schema,
} from "../../src/memory/schemas.ts";

const postActionLifecycle = ActionIntelligenceRuntimeLifecycleSchema.parse({
  lifecycle_version: "action_intelligence_lifecycle_v1",
  history_applied: true,
  post_action_material_present: true,
  distillation_ready: true,
  workflow_candidate_available: true,
  policy_candidate_available: false,
  mutation_candidate_available: true,
  maintenance_ready: true,
  recommended_maintenance_profile: "immediate",
});

test("runtime entropy controls turn high entropy into wide recall, strict verification, and candidate-only promotion", () => {
  const controls = buildRuntimeEntropyControlsV1({
    lifecycle: postActionLifecycle,
    profile: RuntimeEntropyProfileV1Schema.parse({
      profile_version: "runtime_entropy_profile_v1",
      entropy_level: "high",
      exploration_budget: 0.86,
      control_strength: 0.72,
      plasticity_level: "high",
      recall_breadth: "wide",
      verification_depth: "strict",
      promotion_threshold: "high",
      mutation_authority: "candidate_only",
      reason_codes: ["pre_action_requires_wider_recall"],
      source_signals: ["repeated_discovery"],
      source_code_change_allowed: false,
    }),
  });

  assert.equal(controls.controls_version, "runtime_entropy_controls_v1");
  assert.equal(controls.recall.breadth, "wide");
  assert.equal(controls.recall.recommended_limit, 20);
  assert.equal(controls.verifier.schedule, "strict");
  assert.equal(controls.verifier.runtime_verifier_required, true);
  assert.equal(controls.promotion.minimum_observations, 3);
  assert.equal(controls.promotion.stable_promotion_allowed, false);
  assert.equal(controls.maintenance.recommended_profile, "immediate");
  assert.equal(controls.source_code_change_allowed, false);
});

test("runtime entropy controls block promotion during lockdown", () => {
  const controls = buildRuntimeEntropyControlsV1({
    lifecycle: postActionLifecycle,
    profile: RuntimeEntropyProfileV1Schema.parse({
      profile_version: "runtime_entropy_profile_v1",
      entropy_level: "lockdown",
      exploration_budget: 0.1,
      control_strength: 1,
      plasticity_level: "low",
      recall_breadth: "balanced",
      verification_depth: "strict",
      promotion_threshold: "blocked",
      mutation_authority: "none",
      reason_codes: ["runtime_signal_quarantine"],
      source_signals: ["provider_protocol_failure"],
      source_code_change_allowed: false,
    }),
  });

  assert.equal(controls.recall.breadth, "narrow");
  assert.equal(controls.verifier.schedule, "blocked");
  assert.equal(controls.verifier.runtime_verifier_required, true);
  assert.equal(controls.promotion.minimum_observations, 32);
  assert.equal(controls.promotion.stable_promotion_allowed, false);
  assert.equal(controls.maintenance.run_after_task, true);
});
