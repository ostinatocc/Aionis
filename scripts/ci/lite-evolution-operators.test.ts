import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDistillationMaintenanceMetadata,
  buildDistillationMetadata,
  buildPatternMaintenanceMetadata,
  buildPatternPromotionMetadata,
  buildWorkflowMaintenanceMetadata,
  buildWorkflowPromotionMetadata,
} from "../../src/memory/evolution-operators.ts";

test("workflow candidate operator metadata stays in observe/promote mode", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const maintenance = buildWorkflowMaintenanceMetadata({
    promotion_state: "candidate",
    at,
  });
  const promotion = buildWorkflowPromotionMetadata({
    promotion_state: "candidate",
    promotion_origin: "execution_write_projection",
    required_observations: 2,
    observed_count: 1,
    source_status: null,
    at,
  });

  assert.deepEqual(maintenance, {
    model: "lazy_online_v1",
    maintenance_state: "observe",
    offline_priority: "promote_candidate",
    lazy_update_fields: ["usage_count", "last_used_at"],
    last_maintenance_at: at,
  });
  assert.deepEqual(promotion, {
    promotion_state: "candidate",
    promotion_origin: "execution_write_projection",
    required_observations: 2,
    observed_count: 1,
    last_transition: "candidate_observed",
    last_transition_at: at,
    source_status: null,
  });
});

test("workflow stable operator metadata retains workflow guidance", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const maintenance = buildWorkflowMaintenanceMetadata({
    promotion_state: "stable",
    at,
  });
  const promotion = buildWorkflowPromotionMetadata({
    promotion_state: "stable",
    promotion_origin: "replay_learning_auto_promotion",
    required_observations: 2,
    observed_count: 3,
    source_status: null,
    at,
  });

  assert.equal(maintenance.maintenance_state, "retain");
  assert.equal(maintenance.offline_priority, "retain_workflow");
  assert.equal(promotion.last_transition, "promoted_to_stable");
  assert.equal(promotion.required_observations, 2);
  assert.equal(promotion.observed_count, 3);
});

test("stable normalization uses normalized transition instead of promoted transition", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const promotion = buildWorkflowPromotionMetadata({
    promotion_state: "stable",
    promotion_origin: "replay_stable_normalization",
    source_status: "active",
    at,
  });

  assert.equal(promotion.last_transition, "normalized_latest_stable");
  assert.equal(promotion.source_status, "active");
  assert.equal(promotion.required_observations, undefined);
  assert.equal(promotion.observed_count, undefined);
});

test("pattern candidate operator metadata stays in observe/promote mode", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const maintenance = buildPatternMaintenanceMetadata({
    credibility_state: "candidate",
    distinct_run_count: 2,
    required_distinct_runs: 3,
    counter_evidence_open: false,
    at,
  });
  const promotion = buildPatternPromotionMetadata({
    required_distinct_runs: 3,
    distinct_run_count: 2,
    observed_run_ids: ["run-1", "run-2"],
    counter_evidence_count: 0,
    counter_evidence_open: false,
    credibility_state: "candidate",
    previous_credibility_state: "candidate",
    at,
  });

  assert.equal(maintenance.maintenance_state, "observe");
  assert.equal(maintenance.offline_priority, "promote_candidate");
  assert.equal(promotion.last_transition, "candidate_observed");
});

test("pattern contested and trusted operators keep review and revalidation semantics", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const contestedMaintenance = buildPatternMaintenanceMetadata({
    credibility_state: "contested",
    distinct_run_count: 3,
    required_distinct_runs: 3,
    counter_evidence_open: true,
    at,
  });
  const contestedPromotion = buildPatternPromotionMetadata({
    required_distinct_runs: 3,
    distinct_run_count: 3,
    observed_run_ids: ["run-1", "run-2", "run-3"],
    counter_evidence_count: 1,
    counter_evidence_open: true,
    credibility_state: "contested",
    previous_credibility_state: "trusted",
    at,
  });
  const trustedPromotion = buildPatternPromotionMetadata({
    required_distinct_runs: 3,
    distinct_run_count: 5,
    observed_run_ids: ["run-1", "run-2", "run-3", "run-4", "run-5"],
    counter_evidence_count: 1,
    counter_evidence_open: false,
    credibility_state: "trusted",
    previous_credibility_state: "contested",
    at,
    stable_at: at,
    last_validated_at: at,
    last_counter_evidence_at: at,
  });

  assert.equal(contestedMaintenance.maintenance_state, "review");
  assert.equal(contestedMaintenance.offline_priority, "review_counter_evidence");
  assert.equal(contestedPromotion.last_transition, "counter_evidence_opened");
  assert.equal(trustedPromotion.last_transition, "revalidated_to_trusted");
});

test("distillation operators route L1 artifacts toward workflow or pattern evolution", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const evidence = buildDistillationMetadata({
    source_kind: "event_nodes",
    distillation_kind: "write_distillation_evidence",
    at,
    source_node_id: "event-1",
  });
  const fact = buildDistillationMetadata({
    source_kind: "input_text",
    distillation_kind: "write_distillation_fact",
    at,
    extraction_pattern: "colon",
    has_execution_signature: true,
  });
  const evidenceMaintenance = buildDistillationMaintenanceMetadata({
    preferred_promotion_target: evidence.preferred_promotion_target,
    at,
  });
  const factMaintenance = buildDistillationMaintenanceMetadata({
    preferred_promotion_target: fact.preferred_promotion_target,
    at,
  });

  assert.equal(evidence.distillation_origin, "write_distillation_event_node");
  assert.equal(evidence.last_transition, "distilled_from_event_node");
  assert.equal(evidence.preferred_promotion_target, "workflow");
  assert.equal(evidence.source_node_id, "event-1");
  assert.equal(evidenceMaintenance.maintenance_state, "observe");
  assert.equal(evidenceMaintenance.offline_priority, "promote_to_workflow");

  assert.equal(fact.distillation_origin, "write_distillation_input_text");
  assert.equal(fact.last_transition, "distilled_from_input_text");
  assert.equal(fact.preferred_promotion_target, "workflow");
  assert.equal(fact.extraction_pattern, "colon");
  assert.equal(fact.has_execution_signature, true);
  assert.equal(factMaintenance.offline_priority, "promote_to_workflow");
});

test("distillation operators map projected workflow candidates to workflow promotion path", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const projection = buildDistillationMetadata({
    source_kind: "execution_projection",
    distillation_kind: "workflow_candidate",
    at,
    source_node_id: "event-1",
  });
  const replay = buildDistillationMetadata({
    source_kind: "replay_learning",
    distillation_kind: "workflow_candidate",
    at,
    source_node_id: "playbook-1",
  });

  assert.equal(projection.distillation_origin, "execution_write_projection");
  assert.equal(projection.last_transition, "projected_from_execution_write");
  assert.equal(projection.preferred_promotion_target, "workflow");
  assert.equal(replay.distillation_origin, "replay_learning_episode");
  assert.equal(replay.last_transition, "projected_from_replay_learning");
  assert.equal(replay.preferred_promotion_target, "workflow");
});

test("distillation operators preserve continuity carrier provenance for workflow candidates", () => {
  const at = "2026-04-18T12:00:00.000Z";
  const handoff = buildDistillationMetadata({
    source_kind: "handoff_carrier",
    distillation_kind: "workflow_candidate",
    at,
    source_node_id: "handoff-1",
  });
  const sessionEvent = buildDistillationMetadata({
    source_kind: "session_event_carrier",
    distillation_kind: "workflow_candidate",
    at,
    source_node_id: "session-event-1",
  });

  assert.equal(handoff.distillation_origin, "handoff_continuity_carrier");
  assert.equal(handoff.last_transition, "projected_from_handoff_carrier");
  assert.equal(handoff.preferred_promotion_target, "workflow");
  assert.equal(sessionEvent.distillation_origin, "session_event_continuity_carrier");
  assert.equal(sessionEvent.last_transition, "projected_from_session_event_carrier");
  assert.equal(sessionEvent.preferred_promotion_target, "workflow");
});
