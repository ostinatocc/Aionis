import test from "node:test";
import assert from "node:assert/strict";
import {
  AIONIS_KERNEL_BOUNDARY_VERSION,
  AIONIS_KERNEL_CAPABILITIES,
  AIONIS_KERNEL_FORBIDDEN_SURFACES,
  AIONIS_KERNEL_PRODUCT_CLAIM,
  AIONIS_CORE_HARD_INVARIANTS,
  aionisKernelCapability,
  aionisKernelCapabilityIds,
} from "../../src/kernel/boundary.ts";
import {
  LITE_ROUTE_CAPABILITY_MATRIX,
  LITE_ROUTE_CAPABILITY_MATRIX_VERSION,
  buildLiteRouteMatrix,
} from "../../src/server/lite-runtime-boundary.ts";

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
  assert.ok(learning.must_not_own.includes("runtime_semantic_patch_generation"));
  assert.ok(forgetting.owns.includes("semantic_forgetting"));
  assert.ok(forgetting.owns.includes("archive_relocation"));
  assert.ok(forgetting.must_not_own.includes("blind_deletion"));
  assert.equal(learning.owns.includes("semantic_forgetting"), false);
  assert.equal(forgetting.owns.includes("workflow_promotion"), false);
});

test("hard invariants stay small and evidence-centered", () => {
  assert.deepEqual(AIONIS_CORE_HARD_INVARIANTS, [
    "do_not_apply_unverified_authority",
    "quarantine_provider_or_protocol_failures_from_learning_promotion",
    "workflow_promotion_requires_real_outcome_evidence",
    "make_blocked_or_suppressed_authority_visible",
  ]);
  assert.equal(AIONIS_CORE_HARD_INVARIANTS.every((rule) => rule.length > 0), true);
});

test("Lite route capability matrix maps public routes to focused product capabilities", () => {
  assert.equal(LITE_ROUTE_CAPABILITY_MATRIX_VERSION, "lite_route_capability_matrix_v4");

  const capabilityIds = new Set(aionisKernelCapabilityIds());
  const matrix = buildLiteRouteMatrix().route_capability_matrix;
  const routeKeys = matrix.map((entry) => `${entry.method} ${entry.path}`).sort();

  assert.deepEqual(routeKeys, [
    "GET /v1/runtime/boundary-inventory",
    "POST /v1/audit/memory-decision-report",
    "POST /v1/debug/memory-decision-trace",
    "POST /v1/execution/context/assemble",
    "POST /v1/forget",
    "POST /v1/guide",
    "POST /v1/handoff/recover",
    "POST /v1/handoff/store",
    "POST /v1/measure",
    "POST /v1/memory/action/retrieval",
    "POST /v1/memory/agent/handoff-pack",
    "POST /v1/memory/agent/inspect",
    "POST /v1/memory/agent/resume-pack",
    "POST /v1/memory/agent/review-pack",
    "POST /v1/memory/anchors/rehydrate_payload",
    "POST /v1/memory/archive/rehydrate",
    "POST /v1/memory/context/assemble",
    "POST /v1/memory/continuity/review-pack",
    "POST /v1/memory/delegation/records",
    "POST /v1/memory/delegation/records/aggregate",
    "POST /v1/memory/delegation/records/find",
    "POST /v1/memory/evolution/review-pack",
    "POST /v1/memory/execution/introspect",
    "POST /v1/memory/experience/intelligence",
    "POST /v1/memory/feedback",
    "POST /v1/memory/find",
    "POST /v1/memory/learning-loop/run",
    "POST /v1/memory/nodes/activate",
    "POST /v1/memory/patterns/suppress",
    "POST /v1/memory/patterns/unsuppress",
    "POST /v1/memory/planning/context",
    "POST /v1/memory/policies/learning-control/apply",
    "POST /v1/memory/recall",
    "POST /v1/memory/recall_text",
    "POST /v1/memory/replay/playbooks/candidate",
    "POST /v1/memory/replay/playbooks/compile_from_run",
    "POST /v1/memory/replay/playbooks/dispatch",
    "POST /v1/memory/replay/playbooks/get",
    "POST /v1/memory/replay/playbooks/promote",
    "POST /v1/memory/replay/playbooks/repair",
    "POST /v1/memory/replay/playbooks/repair/review",
    "POST /v1/memory/replay/playbooks/run",
    "POST /v1/memory/replay/run/end",
    "POST /v1/memory/replay/run/start",
    "POST /v1/memory/replay/runs/get",
    "POST /v1/memory/replay/step/after",
    "POST /v1/memory/replay/step/before",
    "POST /v1/memory/resolve",
    "POST /v1/memory/rules/evaluate",
    "POST /v1/memory/rules/state",
    "POST /v1/memory/runtime-maintenance/daily",
    "POST /v1/memory/runtime-maintenance/immediate",
    "POST /v1/memory/runtime-maintenance/long-horizon",
    "POST /v1/memory/runtime-maintenance/run",
    "POST /v1/memory/tools/decision",
    "POST /v1/memory/tools/feedback",
    "POST /v1/memory/tools/rehydrate_payload",
    "POST /v1/memory/tools/run",
    "POST /v1/memory/tools/runs/list",
    "POST /v1/memory/tools/select",
    "POST /v1/memory/trajectory/compile",
    "POST /v1/memory/write",
    "POST /v1/observe",
  ]);

  assert.equal(new Set(routeKeys).size, routeKeys.length, "route capability matrix must not duplicate routes");
  assert.equal(matrix.length, LITE_ROUTE_CAPABILITY_MATRIX.length);

  for (const entry of matrix) {
    assert.ok(entry.capabilities.length > 0, `${entry.path} must map to at least one focused capability`);
    for (const capability of entry.capabilities) {
      assert.ok(capabilityIds.has(capability), `${entry.path} maps to unknown capability ${capability}`);
    }
    assert.ok(entry.product_role.length > 20, `${entry.path} must explain its focused product role`);
    assert.match(
      entry.product_exposure,
      /^(product_entry|product_support|internal_evidence|internal_guidance|internal_control|operator_support)$/,
      `${entry.path} must declare product exposure`,
    );
  }
});

test("Lite route capability matrix separates product entries from internal surfaces", () => {
  const matrix = buildLiteRouteMatrix().route_capability_matrix;
  const exposureByRoute = new Map(matrix.map((entry) => [`${entry.method} ${entry.path}`, entry.product_exposure]));

  for (const route of [
    "POST /v1/observe",
    "POST /v1/guide",
    "POST /v1/forget",
    "POST /v1/measure",
  ]) {
    assert.equal(exposureByRoute.get(route), "product_entry", `${route} must stay product-facing`);
  }

  for (const route of [
    "POST /v1/memory/write",
    "POST /v1/memory/context/assemble",
    "POST /v1/execution/context/assemble",
    "POST /v1/memory/experience/intelligence",
    "POST /v1/handoff/recover",
    "POST /v1/memory/find",
    "POST /v1/memory/resolve",
    "POST /v1/memory/rules/state",
    "POST /v1/memory/rules/evaluate",
    "POST /v1/memory/replay/playbooks/repair",
    "POST /v1/memory/replay/playbooks/repair/review",
    "POST /v1/memory/replay/playbooks/run",
    "POST /v1/memory/replay/playbooks/dispatch",
  ]) {
    assert.notEqual(exposureByRoute.get(route), "product_entry", `${route} must not be presented as a product entry`);
  }

  assert.equal(exposureByRoute.get("POST /v1/memory/action/retrieval"), "internal_guidance");
  assert.equal(exposureByRoute.get("POST /v1/execution/context/assemble"), "internal_evidence");
  assert.equal(exposureByRoute.get("POST /v1/memory/replay/playbooks/repair"), "internal_evidence");
  assert.equal(exposureByRoute.get("POST /v1/memory/policies/learning-control/apply"), "internal_control");
  assert.equal(exposureByRoute.get("POST /v1/debug/memory-decision-trace"), "operator_support");
  assert.equal(exposureByRoute.get("POST /v1/audit/memory-decision-report"), "operator_support");
});

test("Lite route capability matrix keeps removed product surfaces out", () => {
  const serialized = JSON.stringify(buildLiteRouteMatrix().route_capability_matrix);
  for (const removed of [
    "/v1/memory/sandbox",
    "/v1/memory/packs",
    "/v1/memory/sessions",
    "/v1/memory/events",
  ]) {
    assert.equal(serialized.includes(removed), false, `${removed} must not return to the focused route matrix`);
  }
});

test("Lite route capability matrix makes history-shaped behavior explicit", () => {
  const matrix = buildLiteRouteMatrix().route_capability_matrix;
  const historyRoutes = matrix.filter((entry) => entry.product_effects.includes("history_shaped_future_behavior"));

  assert.ok(historyRoutes.length > matrix.length * 0.7, "most focused routes should expose history-shaped product effect");
  assert.ok(
    historyRoutes.some((entry) => entry.path === "/v1/measure"),
    "measure facade must expose history-shaped future behavior",
  );
  assert.ok(
    historyRoutes.some((entry) => entry.path === "/v1/guide"),
    "guide facade must expose history-shaped future behavior",
  );
  assert.ok(
    historyRoutes.some((entry) => entry.path === "/v1/forget"),
    "forget facade must expose history-shaped future behavior",
  );
});
