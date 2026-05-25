import test from "node:test";
import assert from "node:assert/strict";
import {
  hasInvalidRuntimeEntropyControls,
  runtimeEntropyRecallDefaultsApplication,
  runtimeEntropyMaintenanceDefaultsApplication,
  runtimeEntropyVerifierDefaultsApplication,
} from "../../src/memory/runtime-entropy-route-defaults.ts";

const highEntropyControls = {
  controls_version: "runtime_entropy_controls_v1",
  recall: {
    breadth: "wide",
    recommended_limit: 20,
    recommended_ranked_limit: 160,
    recommended_max_nodes: 160,
    recommended_max_edges: 100,
    reason: "High entropy requires wider recall.",
  },
  verifier: {
    verification_depth: "strict",
    schedule: "strict",
    runtime_verifier_required: true,
    reason: "Strict verifier evidence is required.",
  },
  promotion: {
    promotion_threshold: "high",
    mutation_authority: "candidate_only",
    minimum_observations: 3,
    stable_promotion_allowed: false,
    reason: "Candidate memory only.",
  },
  maintenance: {
    recommended_profile: "immediate",
    run_after_task: true,
    reason: "Preserve fresh execution material.",
  },
  source_code_change_allowed: false,
};

const dailyMaintenanceControls = {
  ...highEntropyControls,
  maintenance: {
    recommended_profile: "daily",
    run_after_task: false,
    reason: "No post-action material is present.",
  },
};

test("runtime entropy route defaults apply recall controls when caller did not set recall knobs", () => {
  const result = runtimeEntropyRecallDefaultsApplication({
    explicitRecallKnobs: false,
    body: {
      query_text: "unknown task",
      limit: 30,
      ranked_limit: 100,
      max_nodes: 50,
      max_edges: 100,
      runtime_entropy_controls: highEntropyControls,
    },
  });

  assert.equal(result.application.applied, true);
  assert.equal(result.application.reason, "applied");
  assert.equal(result.application.recall_breadth, "wide");
  assert.equal(result.body.limit, 20);
  assert.equal(result.body.ranked_limit, 160);
  assert.equal(result.body.max_nodes, 160);
  assert.equal(result.body.max_edges, 100);
});

test("runtime entropy route defaults preserve explicit caller recall knobs", () => {
  const result = runtimeEntropyRecallDefaultsApplication({
    explicitRecallKnobs: true,
    body: {
      query_text: "operator tuned recall",
      limit: 7,
      ranked_limit: 21,
      max_nodes: 25,
      max_edges: 30,
      runtime_entropy_controls: highEntropyControls,
    },
  });

  assert.equal(result.application.applied, false);
  assert.equal(result.application.reason, "explicit_recall_knobs");
  assert.equal(result.body.limit, 7);
  assert.equal(result.body.ranked_limit, 21);
  assert.equal(result.body.max_nodes, 25);
  assert.equal(result.body.max_edges, 30);
});

test("runtime entropy route defaults expose invalid controls instead of silently applying them", () => {
  const body = {
    query_text: "invalid controls",
    runtime_entropy_controls: {
      controls_version: "runtime_entropy_controls_v1",
      recall: {
        breadth: "wide",
        recommended_limit: 0,
      },
    },
  };

  assert.equal(hasInvalidRuntimeEntropyControls(body), true);
  const result = runtimeEntropyRecallDefaultsApplication({
    explicitRecallKnobs: false,
    body,
  });
  assert.equal(result.application.applied, false);
  assert.equal(result.application.reason, "invalid_runtime_entropy_controls");
});

test("runtime entropy verifier defaults apply strict schedule without executing verifier commands", () => {
  const result = runtimeEntropyVerifierDefaultsApplication({
    explicitRuntimeVerification: false,
    supportsRuntimeVerification: true,
    body: {
      query_text: "strict verification task",
      runtime_entropy_controls: highEntropyControls,
    },
  });

  assert.equal(result.application.applied, true);
  assert.equal(result.application.reason, "applied");
  assert.equal(result.application.verifier_schedule, "strict");
  assert.equal(result.application.runtime_verifier_required, true);
  assert.deepEqual(result.body.runtime_verification, {
    version: 1,
    mode: "plan",
    include_pending_validations: true,
    max_requests: 16,
  });
});

test("runtime entropy verifier defaults preserve explicit runtime verification", () => {
  const result = runtimeEntropyVerifierDefaultsApplication({
    explicitRuntimeVerification: true,
    supportsRuntimeVerification: true,
    body: {
      query_text: "operator selected verifier mode",
      runtime_verification: {
        version: 1,
        mode: "execute",
        agent_lifecycle_state: "agent_exited",
      },
      runtime_entropy_controls: highEntropyControls,
    },
  });

  assert.equal(result.application.applied, false);
  assert.equal(result.application.reason, "explicit_runtime_verification");
  assert.deepEqual(result.body.runtime_verification, {
    version: 1,
    mode: "execute",
    agent_lifecycle_state: "agent_exited",
  });
});

test("runtime entropy maintenance defaults select recommended profile and strip controls", () => {
  const result = runtimeEntropyMaintenanceDefaultsApplication({
    explicitMaintenanceProfile: false,
    body: {
      tenant_id: "default",
      scope: "default",
      mode: "dry_run",
      runtime_entropy_controls: dailyMaintenanceControls,
    },
  });

  assert.equal(result.application.applied, true);
  assert.equal(result.application.reason, "applied");
  assert.equal(result.application.recommended_profile, "daily");
  assert.equal(result.application.run_after_task, false);
  assert.equal(result.body.maintenance_profile, "daily");
  assert.equal("runtime_entropy_controls" in result.body, false);
});

test("runtime entropy maintenance defaults preserve explicit maintenance profile", () => {
  const result = runtimeEntropyMaintenanceDefaultsApplication({
    explicitMaintenanceProfile: true,
    body: {
      tenant_id: "default",
      scope: "default",
      mode: "dry_run",
      maintenance_profile: "long_horizon",
      runtime_entropy_controls: dailyMaintenanceControls,
    },
  });

  assert.equal(result.application.applied, false);
  assert.equal(result.application.reason, "explicit_maintenance_profile");
  assert.equal(result.application.recommended_profile, "daily");
  assert.equal(result.body.maintenance_profile, "long_horizon");
  assert.equal("runtime_entropy_controls" in result.body, false);
});
