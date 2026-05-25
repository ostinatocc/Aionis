import test from "node:test";
import assert from "node:assert/strict";
import {
  AIONIS_KERNEL_BOUNDARY_VERSION,
  AIONIS_KERNEL_CAPABILITIES,
  AIONIS_KERNEL_FORBIDDEN_SURFACES,
  AIONIS_KERNEL_PRODUCT_CLAIM,
  AIONIS_CORE_HARD_INVARIANTS,
  AIONIS_EXPERIMENTAL_POLICY_SURFACES,
  AIONIS_RUNTIME_LAYER_BOUNDARIES,
  AIONIS_RUNTIME_LAYER_BOUNDARY_VERSION,
  aionisKernelCapability,
  aionisKernelCapabilityIds,
  aionisRuntimeLayerIds,
} from "../../src/kernel/boundary.ts";

test("focused kernel boundary exposes the four product capabilities", () => {
  assert.equal(AIONIS_KERNEL_BOUNDARY_VERSION, "aionis_focused_kernel_boundary_v1");
  assert.equal(
    AIONIS_KERNEL_PRODUCT_CLAIM,
    "local_execution_memory_runtime_for_agent_continuity_learning_forgetting_and_learning_control",
  );
  assert.deepEqual(aionisKernelCapabilityIds(), [
    "continuity",
    "learning",
    "forgetting",
    "learning_control",
  ]);
  assert.equal(AIONIS_KERNEL_CAPABILITIES.length, 4);
});

test("learning_control capability is exposed as learning control, not platform control", () => {
  const learningControl = aionisKernelCapability("learning_control");

  assert.equal(learningControl.display_name, "Learning Control");
  assert.match(learningControl.purpose, /learned memories/);
  assert.ok(learningControl.owns.includes("authority_gate"));
  assert.ok(learningControl.owns.includes("self_modifying_policy_loop"));
  assert.ok(learningControl.owns.includes("learning_lifecycle_control"));
  assert.ok(learningControl.must_not_own.includes("admin_control_plane"));
  assert.ok(learningControl.must_not_own.includes("cloud_platform_control"));
  assert.ok(learningControl.success_signals.some((signal) => signal.includes("outcome evidence")));
});

test("focused kernel boundary rejects removed broad product surfaces", () => {
  const serializedBoundary = JSON.stringify(AIONIS_KERNEL_CAPABILITIES);

  for (const removedSurface of AIONIS_KERNEL_FORBIDDEN_SURFACES) {
    assert.equal(
      serializedBoundary.includes(`"${removedSurface}"`),
      false,
      `${removedSurface} must not be owned by the focused Runtime kernel`,
    );
  }
});

test("each capability ties to agent-visible effect and measurable signals", () => {
  for (const capability of AIONIS_KERNEL_CAPABILITIES) {
    assert.ok(capability.agent_effect.length > 20, `${capability.id} must define agent-visible effect`);
    assert.ok(capability.owns.length >= 3, `${capability.id} must own concrete mechanisms`);
    assert.ok(capability.must_not_own.length >= 3, `${capability.id} must reject non-core ownership`);
    assert.ok(capability.primary_runtime_surfaces.length > 0, `${capability.id} must map to runtime surfaces`);
    assert.ok(capability.success_signals.length >= 3, `${capability.id} must define success signals`);
  }
});

test("learning and forgetting stay separated", () => {
  const learning = aionisKernelCapability("learning");
  const forgetting = aionisKernelCapability("forgetting");

  assert.ok(learning.owns.includes("workflow_promotion"));
  assert.ok(learning.must_not_own.includes("one_success_equals_truth"));
  assert.ok(forgetting.owns.includes("semantic_forgetting"));
  assert.ok(forgetting.owns.includes("archive_relocation"));
  assert.ok(forgetting.must_not_own.includes("blind_deletion"));
  assert.equal(learning.owns.includes("semantic_forgetting"), false);
  assert.equal(forgetting.owns.includes("workflow_promotion"), false);
});

test("runtime boundary separates product core from eval and experimental policy", () => {
  assert.equal(AIONIS_RUNTIME_LAYER_BOUNDARY_VERSION, "aionis_runtime_layer_boundary_v1");
  assert.deepEqual(aionisRuntimeLayerIds(), [
    "core_runtime",
    "real_eval_harness",
    "experimental_policy",
  ]);

  const core = AIONIS_RUNTIME_LAYER_BOUNDARIES.find((layer) => layer.id === "core_runtime");
  const evalHarness = AIONIS_RUNTIME_LAYER_BOUNDARIES.find((layer) => layer.id === "real_eval_harness");
  const experimental = AIONIS_RUNTIME_LAYER_BOUNDARIES.find((layer) => layer.id === "experimental_policy");

  assert.ok(core);
  assert.ok(evalHarness);
  assert.ok(experimental);
  assert.ok(core.owns.includes("context_packet_assembly"));
  assert.ok(core.owns.includes("persistent_cognitive_structure"));
  assert.ok(core.may_produce.includes("cognitive_structure"));
  assert.ok(core.must_not_own.includes("external_project_verifier_logic"));
  assert.ok(core.must_not_own.includes("testing_method_preference"));
  assert.ok(evalHarness.owns.includes("baseline_vs_aionis_comparison"));
  assert.ok(evalHarness.must_not_own.includes("runtime_memory_promotion"));
  assert.ok(experimental.owns.includes("verifier_phase_classification"));
  assert.ok(experimental.must_not_own.includes("global_hard_rule"));
});

test("hard invariants stay small and evidence-centered", () => {
  assert.deepEqual(AIONIS_CORE_HARD_INVARIANTS, [
    "do_not_apply_unverified_authority",
    "quarantine_provider_or_protocol_failures_from_learning_promotion",
    "workflow_promotion_requires_real_outcome_evidence",
    "make_blocked_or_suppressed_authority_visible",
  ]);
  assert.equal(AIONIS_CORE_HARD_INVARIANTS.some((rule) => rule.includes("mock")), false);
});

test("experimental policies cannot masquerade as core hard rules", () => {
  assert.equal(AIONIS_EXPERIMENTAL_POLICY_SURFACES.length >= 3, true);

  for (const surface of AIONIS_EXPERIMENTAL_POLICY_SURFACES) {
    assert.equal(surface.layer, "experimental_policy");
    assert.notEqual(surface.default_authority, "hard_invariant");
    assert.ok(surface.must_not_do.includes("promote_without_verifier_success")
      || surface.must_not_do.includes("turn_project_specific_paths_into_global_rules")
      || surface.must_not_do.includes("persist_as_authority_from_failed_runs"));
    assert.match(surface.promotion_rule, /real|holdout|verifier/i);
  }
});
