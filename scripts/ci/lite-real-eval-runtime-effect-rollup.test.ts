import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeEffectRollupFromTaskReports } from "../../scripts/real-llm-eval/report-runtime-effect-rollup.ts";

type JsonObject = Record<string, unknown>;

function taskReport(args: {
  id: string;
  baselinePassed: boolean;
  assistedPassed: boolean;
  comparison: JsonObject;
  runtimeEffectPosture: string;
  invalidationPressure: string;
  recommendedLearningPosture: string;
  context: JsonObject;
  continuity: JsonObject;
  verification: JsonObject;
  learning: JsonObject;
  forgetting: JsonObject;
  promotionLedgerCount: number;
  promotionAdmissionRate: number;
  promotionContestedRate: number;
  contextFeedback?: JsonObject;
}): JsonObject {
  return {
    task_id: args.id,
    baseline: {
      status: args.baselinePassed ? "success" : "failed",
      metrics: { verifier_passed: args.baselinePassed },
    },
    aionis: {
      status: args.assistedPassed ? "success" : "failed",
      metrics: { verifier_passed: args.assistedPassed },
    },
    comparison: args.comparison,
    aionis_context_feedback: args.contextFeedback ?? null,
    runtime_maintenance: {
      after: {
        runtime_effect_summary: {
          summary_version: "runtime_effect_summary_v1",
          baseline_comparison_required: true,
          included_promotion_ledger_count: args.promotionLedgerCount,
          token_context: args.context,
          continuity: args.continuity,
          verification: args.verification,
          learning: {
            ...args.learning,
            promotion_admission_rate: args.promotionAdmissionRate,
            promotion_contested_rate: args.promotionContestedRate,
            promotion_invalidation_pressure: args.invalidationPressure,
            recommended_learning_posture: args.recommendedLearningPosture,
          },
          forgetting: args.forgetting,
          measurable_effect_posture: args.runtimeEffectPosture,
          source_code_change_allowed: false,
        },
        promotion_quality_summary: {
          summary_version: "promotion_quality_summary_v1",
          included_ledger_count: args.promotionLedgerCount,
          promotion_admission_rate: args.promotionAdmissionRate,
          contested_rate: args.promotionContestedRate,
          invalidation_pressure: args.invalidationPressure,
          recommended_learning_posture: args.recommendedLearningPosture,
          source_code_change_allowed: false,
        },
      },
    },
  };
}

test("real eval runtime effect rollup aggregates generic Runtime evidence without product claims", () => {
  const rollup = buildRuntimeEffectRollupFromTaskReports([
    taskReport({
      id: "task:one",
      baselinePassed: false,
      assistedPassed: true,
      comparison: {
        verifier_improved: true,
        verifier_equal_or_better: true,
        assisted_verifier_regressed: false,
        first_action_improved: true,
        repeated_discovery_delta: 2,
        wrong_file_touch_delta: 1,
        tool_step_delta: 3,
        token_delta: 500,
        assisted_assistance_mode: "semantic_evidence",
        assisted_aionis_context_char_count: 1800,
        assisted_aionis_compact_contract_char_count: 1200,
        assisted_context_budget_exceeded: false,
        assisted_prior_success_invariant_count: 4,
        assisted_prior_success_invariant_uptake_count: 3,
        assisted_prior_success_invariant_missing_count: 1,
        assisted_prior_success_invariant_uptake_rate: 0.75,
        baseline_repair_attempt_count: 0,
        assisted_repair_attempt_count: 1,
        assisted_repair_loop_succeeded: true,
        assisted_repair_failure_evidence_count: 1,
        assisted_repair_repeated_failure_count: 0,
        assisted_repair_stagnation_detected: false,
      },
      runtimeEffectPosture: "positive",
      invalidationPressure: "none",
      recommendedLearningPosture: "promotion_ready",
      context: {
        observed_count: 2,
        within_budget_count: 2,
        over_budget_count: 0,
        unknown_budget_count: 0,
        average_est_tokens: 1000,
        average_token_budget: 4000,
        max_est_tokens: 1200,
        context_items_reduced_count: 5,
      },
      continuity: {
        repeated_discovery_count: 0,
        repeated_failed_action_count: 0,
        first_action_ready_signal_count: 1,
      },
      verification: {
        verifier_success_count: 1,
        verifier_failure_count: 0,
        retry_count_total: 0,
        recovery_cost_total: 0,
        provider_quarantine_count: 0,
      },
      learning: {
        workflow_reuse_success_count: 1,
        workflow_reuse_failure_count: 0,
        tool_selection_success_count: 1,
        tool_selection_failure_count: 0,
      },
      forgetting: {
        forgetting_signal_count: 1,
        memory_demotions: 0,
        memory_archives: 1,
        rehydration_useful_count: 1,
        rehydration_unhelpful_count: 0,
      },
      promotionLedgerCount: 2,
      promotionAdmissionRate: 1,
      promotionContestedRate: 0,
    }),
    taskReport({
      id: "task:two",
      baselinePassed: true,
      assistedPassed: false,
      comparison: {
        verifier_improved: false,
        verifier_equal_or_better: false,
        assisted_verifier_regressed: true,
        first_action_improved: false,
        repeated_discovery_delta: -1,
        wrong_file_touch_delta: -1,
        tool_step_delta: -2,
        token_delta: -200,
        assisted_assistance_mode: "strict_governance",
        assisted_aionis_context_char_count: 5400,
        assisted_aionis_compact_contract_char_count: 4200,
        assisted_context_budget_exceeded: true,
        assisted_prior_success_invariant_count: 2,
        assisted_prior_success_invariant_uptake_count: 0,
        assisted_prior_success_invariant_missing_count: 2,
        assisted_prior_success_invariant_uptake_rate: 0,
        baseline_repair_attempt_count: 0,
        assisted_repair_attempt_count: 2,
        assisted_repair_loop_succeeded: false,
        assisted_repair_failure_evidence_count: 2,
        assisted_repair_repeated_failure_count: 1,
        assisted_repair_stagnation_detected: true,
      },
      runtimeEffectPosture: "constrained",
      invalidationPressure: "high",
      recommendedLearningPosture: "invalidate",
      context: {
        observed_count: 1,
        within_budget_count: 0,
        over_budget_count: 1,
        unknown_budget_count: 0,
        average_est_tokens: 3000,
        average_token_budget: 2000,
        max_est_tokens: 3000,
        context_items_reduced_count: 2,
      },
      continuity: {
        repeated_discovery_count: 2,
        repeated_failed_action_count: 1,
        first_action_ready_signal_count: 0,
      },
      verification: {
        verifier_success_count: 0,
        verifier_failure_count: 1,
        retry_count_total: 2,
        recovery_cost_total: 3,
        provider_quarantine_count: 0,
      },
      learning: {
        workflow_reuse_success_count: 0,
        workflow_reuse_failure_count: 1,
        tool_selection_success_count: 0,
        tool_selection_failure_count: 1,
      },
      forgetting: {
        forgetting_signal_count: 1,
        memory_demotions: 1,
        memory_archives: 0,
        rehydration_useful_count: 0,
        rehydration_unhelpful_count: 1,
      },
      promotionLedgerCount: 1,
      promotionAdmissionRate: 0,
      promotionContestedRate: 1,
      contextFeedback: {
        schema_version: "aionis_agent_context_feedback_v1",
        feedback_type: "baseline_comparison_negative_transfer_control",
        negative_transfer: true,
        negative_transfer_kind: "outcome_regression",
        decision: "downgrade_future_aionis_context_for_scope",
        recommended_next_assistance_mode: "minimal_boundary",
        source_code_change_allowed: false,
      },
    }),
  ]);

  const runtimeContext = rollup.runtime_context as JsonObject;
  const runtimeContinuity = rollup.runtime_continuity as JsonObject;
  const runtimeVerification = rollup.runtime_verification as JsonObject;
  const runtimeLearning = rollup.runtime_learning as JsonObject;
  const runtimeForgetting = rollup.runtime_forgetting as JsonObject;
  const baselineComparisonQuality = rollup.baseline_comparison_quality as JsonObject;
  const semanticInvariantUptake = rollup.semantic_invariant_uptake as JsonObject;
  const assistanceGate = rollup.assistance_gate as JsonObject;
  const repairLoop = rollup.verifier_feedback_repair_loop as JsonObject;
  const contextFeedback = rollup.aionis_context_feedback as JsonObject;

  assert.equal(rollup.baseline_comparison_required, true);
  assert.equal(rollup.effect_claim_status, "measurement_only_requires_effect_gate");
  assert.equal(rollup.task_count, 2);
  assert.equal(rollup.task_with_runtime_effect_summary_count, 2);
  assert.equal(rollup.baseline_success_count, 1);
  assert.equal(rollup.assisted_success_count, 1);
  assert.equal(rollup.verifier_improved_count, 1);
  assert.equal(rollup.assisted_verifier_regression_count, 1);
  assert.equal(rollup.average_repeated_discovery_delta, 0.5);
  assert.equal(rollup.average_token_delta, 150);
  assert.deepEqual(baselineComparisonQuality.quality_counts, {
    positive: 1,
    mixed_positive: 0,
    neutral: 0,
    mixed_negative: 0,
    regressed: 1,
    failed_but_improved: 0,
    failed: 0,
    insufficient_comparison: 0,
  });
  assert.equal(baselineComparisonQuality.strict_positive_count, 1);
  assert.equal(baselineComparisonQuality.positive_or_mixed_positive_count, 1);
  assert.equal(baselineComparisonQuality.regressed_or_mixed_negative_count, 1);
  assert.deepEqual(baselineComparisonQuality.positive_signal_counts, {
    verifier_improved: 1,
    first_action_improved: 1,
    fewer_repeated_discovery_steps: 1,
    fewer_wrong_file_touches: 1,
    fewer_tool_steps: 1,
    lower_token_usage: 1,
    prior_success_invariant_uptake: 1,
    verifier_feedback_repair_succeeded: 1,
  });
  assert.deepEqual(baselineComparisonQuality.regression_signal_counts, {
    assisted_verifier_failed: 1,
    verifier_regressed: 1,
    more_repeated_discovery_steps: 1,
    more_wrong_file_touches: 1,
    more_tool_steps: 1,
    higher_token_usage: 1,
    context_budget_exceeded: 1,
  });
  assert.equal(semanticInvariantUptake.observed_task_count, 2);
  assert.equal(semanticInvariantUptake.average_assisted_prior_success_invariant_uptake_rate, 0.375);
  assert.equal(semanticInvariantUptake.assisted_prior_success_invariant_count, 6);
  assert.equal(semanticInvariantUptake.assisted_prior_success_invariant_uptake_count, 3);
  assert.equal(semanticInvariantUptake.assisted_prior_success_invariant_missing_count, 3);
  assert.deepEqual(assistanceGate.mode_counts, {
    no_op: 0,
    minimal_boundary: 0,
    compact_contract: 0,
    semantic_evidence: 1,
    strict_governance: 1,
  });
  assert.equal(assistanceGate.average_assisted_aionis_context_char_count, 3600);
  assert.equal(assistanceGate.average_assisted_compact_contract_char_count, 2700);
  assert.equal(assistanceGate.assisted_context_budget_exceeded_count, 1);
  assert.equal(repairLoop.baseline_repair_used_count, 0);
  assert.equal(repairLoop.assisted_repair_used_count, 2);
  assert.equal(repairLoop.assisted_repair_succeeded_count, 1);
  assert.equal(repairLoop.average_baseline_repair_attempt_count, 0);
  assert.equal(repairLoop.average_assisted_repair_attempt_count, 1.5);
  assert.equal(repairLoop.assisted_repair_failure_evidence_count, 3);
  assert.equal(repairLoop.assisted_repair_repeated_failure_count, 1);
  assert.equal(repairLoop.assisted_repair_stagnation_detected_count, 1);
  assert.equal(contextFeedback.observed_task_count, 1);
  assert.equal(contextFeedback.negative_transfer_count, 1);
  assert.deepEqual(contextFeedback.decision_counts, {
    observe_only: 0,
    downgrade_future_aionis_context_for_scope: 1,
  });
  assert.deepEqual(contextFeedback.negative_transfer_kind_counts, {
    outcome_regression: 1,
    efficiency_regression: 0,
  });
  assert.deepEqual(contextFeedback.recommended_next_assistance_mode_counts, {
    minimal_boundary: 1,
  });
  assert.equal(contextFeedback.source_code_change_allowed, false);
  assert.deepEqual(rollup.runtime_effect_posture_counts, {
    insufficient_evidence: 0,
    positive: 1,
    mixed: 0,
    constrained: 1,
    blocked: 0,
  });
  assert.deepEqual(rollup.promotion_invalidation_pressure_counts, {
    none: 1,
    low: 0,
    medium: 0,
    high: 1,
  });
  assert.equal(runtimeContext.observation_count, 3);
  assert.equal(runtimeContext.within_budget_count, 2);
  assert.equal(runtimeContext.over_budget_count, 1);
  assert.equal(runtimeContext.average_est_tokens, 1666.666667);
  assert.equal(runtimeContext.average_token_budget, 3333.333333);
  assert.equal(runtimeContext.context_items_reduced_count, 7);
  assert.equal(runtimeContinuity.repeated_discovery_count, 2);
  assert.equal(runtimeContinuity.repeated_failed_action_count, 1);
  assert.equal(runtimeVerification.verifier_success_count, 1);
  assert.equal(runtimeVerification.verifier_failure_count, 1);
  assert.equal(runtimeLearning.workflow_reuse_success_count, 1);
  assert.equal(runtimeLearning.workflow_reuse_failure_count, 1);
  assert.equal(runtimeLearning.average_promotion_admission_rate, 0.666667);
  assert.equal(runtimeForgetting.memory_demotions, 1);
  assert.equal(runtimeForgetting.memory_archives, 1);
  assert.deepEqual(rollup.source_task_ids, ["task:one", "task:two"]);
  assert.equal(rollup.source_code_change_allowed, false);
});
