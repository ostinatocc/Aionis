import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { admissionCandidatePolicyFixtureJsonl } from "./admission-dataset-fixture.ts";
import {
  buildAdmissionRealAgentPromptPack,
  buildAdmissionRealAgentRerunReport,
  admissionRealAgentFiniteHoldoutCaseSetDigest,
  admissionRealAgentFiniteHoldoutEndpointResultSetDigest,
  admissionRealAgentFiniteHoldoutExecutionOrderDigest,
  admissionRealAgentFiniteHoldoutExecutionProfileDigest,
  admissionRealAgentFiniteHoldoutModelIdentityDigest,
  admissionRealAgentFiniteHoldoutResponseFingerprint,
  admissionRealAgentFiniteHoldoutResponseFingerprintSetDigest,
  admissionRealAgentFiniteHoldoutRuntimeCopyIdentity,
  admissionRealAgentFiniteHoldoutRuntimeCopySetDigest,
  deriveAdmissionRealAgentPredecisionTrack,
  evaluateAdmissionRealAgentFiniteHoldout,
  formatAdmissionRealAgentRerunMarkdown,
  normalizeAdmissionRealAgentDecision,
  parseAdmissionRealAgentDatasetJsonl,
  prepareAdmissionRealAgentGroups,
  scoreAdmissionRealAgentDecision,
} from "../../src/memory/admission-real-agent-rerun.js";
import { createLiteLearningEpisodeLedgerAccess } from "../../src/store/lite-learning-episode-ledger.js";
import {
  backupLiteRuntimeDatabase,
  verifyLiteRuntimeDatabase,
} from "../../src/store/lite-runtime-data-operations.js";
import { createLiteWriteStore, createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.js";
import {
  runAdmissionRealAgentFiniteHoldoutCase,
  runAdmissionRealAgentFreshRuntimePair,
  validateAdmissionRealAgentFiniteHoldoutUnits,
} from "../e2e/admission-real-agent-rerun.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function finiteHoldoutFixture(args: {
  extraCandidateHarm?: number;
  extraCandidateUtilityLoss?: number;
  mutateCase?: (value: any, index: number) => any;
  immutableSnapshot?: boolean;
  providerMayUpdateWeights?: boolean;
} = {}) {
  const sourceRuntimeSnapshotSha256 = digest("finite-holdout-source-runtime");
  const cases = Array.from({ length: 96 }, (_, index) => {
    const value = {
      case_ordinal: index,
      case_identity_sha256: digest(`finite-case:${index}`),
      policy_affected: true,
      predecision_track: index < 2 ? "exploit" as const : "explore" as const,
      first_arm: index % 2 === 0 ? "recorded" as const : "candidate" as const,
      observed_first_arm: index % 2 === 0 ? "recorded" as const : "candidate" as const,
      recorded: {
        harm: index < 20,
        accepted_completed: !(index >= 30 && index < 40),
        runtime_copy_identity_sha256: admissionRealAgentFiniteHoldoutRuntimeCopyIdentity({
          source_runtime_snapshot_sha256: sourceRuntimeSnapshotSha256,
          case_ordinal: index,
          case_identity_sha256: digest(`finite-case:${index}`),
          arm: "recorded",
        }),
        starting_runtime_snapshot_sha256: sourceRuntimeSnapshotSha256,
        ending_runtime_snapshot_sha256: digest(`recorded-ending:${index}`),
        runtime_copy_destroyed: true,
        request_fingerprint_sha256: digest(`recorded-request:${index}`),
        response_payload_sha256: digest(`recorded-response-payload:${index}`),
        response_fingerprint_sha256: digest(`recorded-response-placeholder:${index}`),
      },
      candidate: {
        harm: (index >= 2 && index < 20)
          || (index >= 20 && index < 20 + (args.extraCandidateHarm ?? 0)),
        accepted_completed: !(index >= 30 && index < 40 + (args.extraCandidateUtilityLoss ?? 0)),
        runtime_copy_identity_sha256: admissionRealAgentFiniteHoldoutRuntimeCopyIdentity({
          source_runtime_snapshot_sha256: sourceRuntimeSnapshotSha256,
          case_ordinal: index,
          case_identity_sha256: digest(`finite-case:${index}`),
          arm: "candidate",
        }),
        starting_runtime_snapshot_sha256: sourceRuntimeSnapshotSha256,
        ending_runtime_snapshot_sha256: digest(`candidate-ending:${index}`),
        runtime_copy_destroyed: true,
        request_fingerprint_sha256: digest(`candidate-request:${index}`),
        response_payload_sha256: digest(`candidate-response-payload:${index}`),
        response_fingerprint_sha256: digest(`candidate-response-placeholder:${index}`),
      },
    };
    return args.mutateCase ? args.mutateCase(value, index) : value;
  });
  const profile = {
    immutable_snapshot: args.immutableSnapshot ?? true,
    provider_may_update_weights: args.providerMayUpdateWeights ?? false,
    source_runtime_snapshot_sha256: sourceRuntimeSnapshotSha256,
    runtime_binary_sha256: digest("finite-runtime-binary"),
    immutable_model_snapshot_sha256: digest("finite-model-snapshot"),
    deterministic_decoding_seed_sha256: digest("finite-decoding-seed"),
    deterministic_decoding_kernel_sha256: digest("finite-decoding-kernel"),
    tool_manifest_sha256: digest("finite-tool-manifest"),
    execution_order_sha256: admissionRealAgentFiniteHoldoutExecutionOrderDigest(cases),
  };
  const executionProfileSha256 = admissionRealAgentFiniteHoldoutExecutionProfileDigest(profile);
  for (const entry of cases) {
    for (const arm of ["recorded", "candidate"] as const) {
      entry[arm].response_fingerprint_sha256 = admissionRealAgentFiniteHoldoutResponseFingerprint({
        execution_profile_sha256: executionProfileSha256,
        case_ordinal: entry.case_ordinal,
        case_identity_sha256: entry.case_identity_sha256,
        arm,
        runtime_copy_identity_sha256: entry[arm].runtime_copy_identity_sha256,
        request_fingerprint_sha256: entry[arm].request_fingerprint_sha256,
        response_payload_sha256: entry[arm].response_payload_sha256,
      });
    }
  }
  return {
    contract_version: "aionis_admission_real_agent_finite_holdout_v1" as const,
    profile,
    authority_bindings: {
      reservation_id: "reservation-offline-paired-v1",
      reservation_sha256: digest("finite-reservation"),
      ticket_consumption_id: "consumption-offline-paired-v1",
      ticket_consumption_sha256: digest("finite-consumption"),
      claim_id: "claim-offline-paired-v1",
      claim_sha256: digest("finite-claim"),
      supervisor_binding_id: "binding-offline-paired-v1",
      supervisor_binding_sha256: digest("finite-binding"),
      session_termination_id: "termination-offline-paired-v1",
      session_termination_sha256: digest("finite-termination"),
      retry_policy_sha256: digest("finite-retry-policy"),
      case_set_sha256: admissionRealAgentFiniteHoldoutCaseSetDigest(cases),
      execution_profile_sha256: executionProfileSha256,
      model_identity_sha256: admissionRealAgentFiniteHoldoutModelIdentityDigest(profile),
      harness_bundle_sha256: digest("finite-harness-bundle"),
      raw_bundle_sha256: digest("finite-raw-bundle"),
      attempt_chain_sha256: digest("finite-attempt-chain"),
      exclusion_manifest_sha256: digest("finite-exclusion-manifest"),
      response_fingerprint_set_sha256: admissionRealAgentFiniteHoldoutResponseFingerprintSetDigest(cases),
      runtime_copy_set_sha256: admissionRealAgentFiniteHoldoutRuntimeCopySetDigest(cases),
      endpoint_result_set_sha256: admissionRealAgentFiniteHoldoutEndpointResultSetDigest(cases),
    },
    cases,
  };
}

function baselineRows() {
  return parseAdmissionRealAgentDatasetJsonl(admissionCandidatePolicyFixtureJsonl());
}

function preparedGroups() {
  return prepareAdmissionRealAgentGroups(baselineRows(), {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
  });
}

function positiveUseNowGroup() {
  const prepared = preparedGroups();
  return prepared.groups.find((entry) =>
    entry.rows.some((row) => row.outcome_label === "positive_use" && row.admission_action === "use_now"),
  );
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

test("admission real-agent rerun prompt pack is label-safe over real holdout rows", () => {
  const group = positiveUseNowGroup();
  assert.ok(group);

  const pack = buildAdmissionRealAgentPromptPack({
    arm_id: "recorded_policy_baseline",
    group_id: group.group_id,
    rows: group.rows,
  });
  const serialized = json(pack);

  assert.equal(pack.contract_version, "aionis_admission_real_agent_prompt_pack_v1");
  assert.equal(pack.runtime_mutation, false);
  assert.equal(pack.label_leakage_guard, true);
  assert.ok(pack.memories.use_now.length > 0);
  assert.equal(serialized.includes("outcome_label"), false);
  assert.equal(serialized.includes("feedback_outcome"), false);
  assert.equal(serialized.includes("attribution_strength"), false);
  assert.equal(serialized.includes("agent_used"), false);
  assert.equal(serialized.includes("prompt_char_count"), false);
});

test("admission real-agent scorer accepts direct use of real positive memory", () => {
  const group = positiveUseNowGroup();
  assert.ok(group);
  const positive = group.rows.find((row) => row.outcome_label === "positive_use" && row.admission_action === "use_now");
  assert.ok(positive);

  const trial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    candidate_policy_id: preparedGroups().candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: positive.memory_id,
      used_memory_ids: [positive.memory_id],
      rationale: "Use the actionable current project context.",
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  assert.equal(trial.outcome, "accepted_action");
  assert.equal(trial.selected_outcome_label, "positive_use");
  assert.equal(trial.selected_admission_action, "use_now");
});

test("admission real-agent scorer catches non-actionable direct attention from real rows", () => {
  const prepared = preparedGroups();
  const group = prepared.groups.find((entry) =>
    entry.rows.some((row) => row.outcome_label === "unused_exposed" && row.admission_action === "use_now")
  );
  assert.ok(group);
  const unused = group.rows.find((row) => row.outcome_label === "unused_exposed" && row.admission_action === "use_now");
  assert.ok(unused);

  const trial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    candidate_policy_id: prepared.candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: unused.memory_id,
      used_memory_ids: [unused.memory_id],
      rationale: "Use the external current memory.",
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  assert.equal(trial.outcome, "non_actionable_direct_attention");
  assert.equal(trial.selected_outcome_label, "unused_exposed");
});

test("admission real-agent scorer marks direct use of candidate-inspect row as boundary ignored", () => {
  const prepared = preparedGroups();
  const group = prepared.groups.find((entry) =>
    entry.rows.some((row) => row.outcome_label === "unused_exposed" && row.admission_action === "use_now")
  );
  assert.ok(group);
  const unused = group.rows.find((row) => row.outcome_label === "unused_exposed" && row.admission_action === "use_now");
  assert.ok(unused);

  const trial = scoreAdmissionRealAgentDecision({
    arm_id: prepared.candidate_policy_id,
    candidate_policy_id: prepared.candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: unused.memory_id,
      used_memory_ids: [unused.memory_id],
      rationale: "Use the downgraded external memory directly anyway.",
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  assert.equal(trial.outcome, "boundary_ignored");
  assert.equal(trial.selected_admission_action, "inspect_before_use");
});

test("admission real-agent report separates first-use and prior-aware negative risk", () => {
  const prepared = preparedGroups();
  const group = prepared.groups.find((entry) =>
    entry.rows.some((row) => row.outcome_label === "negative_use" && row.admission_action === "use_now"),
  );
  assert.ok(group);
  const negative = group.rows.find((row) => row.outcome_label === "negative_use" && row.admission_action === "use_now");
  assert.ok(negative);
  const noPriorNegative = {
    ...negative,
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    closed_loop_effect_state: "no_prior" as const,
    repeated_negative_posture: false,
  };
  const priorAwareNegative = {
    ...negative,
    memory_id: `${negative.memory_id}:prior-aware`,
    prior_contradicted_use_count: 1,
    closed_loop_effect_state: "contradicted" as const,
  };
  const noPriorTrial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    candidate_policy_id: prepared.candidate_policy_id,
    group_id: "no-prior",
    rows: [noPriorNegative],
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: noPriorNegative.memory_id,
      used_memory_ids: [noPriorNegative.memory_id],
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  const priorAwareTrial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    candidate_policy_id: prepared.candidate_policy_id,
    group_id: "prior-aware",
    rows: [priorAwareNegative],
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: priorAwareNegative.memory_id,
      used_memory_ids: [priorAwareNegative.memory_id],
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });

  const report = buildAdmissionRealAgentRerunReport({
    rows: [noPriorNegative, priorAwareNegative],
    options: {
      split_by: "run_id",
      evaluation_split: "all",
      candidate_policy_id: "recorded_policy_baseline",
    },
    llm: {
      provider: "deepseek",
      model: "deepseek-chat",
      base_url_host: "api.deepseek.com",
    },
    recorded_trials: [noPriorTrial, priorAwareTrial],
    candidate_trials: [noPriorTrial, priorAwareTrial],
  });

  assert.equal(noPriorTrial.selected_prior_bucket, "no_prior");
  assert.equal(priorAwareTrial.selected_prior_bucket, "prior_aware");
  assert.equal(report.recorded_arm.prior_slices.first_use_negative_direct_risk_count, 1);
  assert.equal(report.recorded_arm.prior_slices.prior_aware_negative_direct_risk_count, 1);
  assert.match(formatAdmissionRealAgentRerunMarkdown(report), /Prior-State Slices/);
});

test("admission real-agent rerun report formats real-trial summaries without prompt payloads", () => {
  const rows = baselineRows();
  const prepared = prepareAdmissionRealAgentGroups(rows, {
    split_by: "task_signature",
    holdout_ratio: 0.5,
    seed: "aionis-admission-holdout-v1",
    max_groups: 1,
  });
  const group = prepared.groups[0];
  assert.ok(group);
  const recordedTrial = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    candidate_policy_id: prepared.candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({ action: "no_action", selected_memory_id: null, used_memory_ids: [] }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  const candidateTrial = scoreAdmissionRealAgentDecision({
    arm_id: prepared.candidate_policy_id,
    candidate_policy_id: prepared.candidate_policy_id,
    group_id: group.group_id,
    rows: group.rows,
    decision: normalizeAdmissionRealAgentDecision({ action: "no_action", selected_memory_id: null, used_memory_ids: [] }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  const report = buildAdmissionRealAgentRerunReport({
    rows,
    options: {
      split_by: "task_signature",
      holdout_ratio: 0.5,
      seed: "aionis-admission-holdout-v1",
      max_groups: 1,
    },
    llm: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      base_url_host: "api.deepseek.com",
    },
    recorded_trials: [recordedTrial],
    candidate_trials: [candidateTrial],
  });
  const markdown = formatAdmissionRealAgentRerunMarkdown(report);

  assert.equal(report.contract_version, "aionis_admission_real_agent_rerun_report_v1");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.external_model_called, true);
  assert.match(markdown, /Aionis Admission Real Agent Rerun/);
  assert.match(markdown, /real external LLM call/);
  assert.match(markdown, /Predecision ITT Slices/);
  assert.match(markdown, /post-decision diagnostics only/);
  assert.equal(json(report).includes("prompt_pack"), false);
});

test("predecision policy track is frozen before different arm selections", () => {
  const prepared = preparedGroups();
  const negative = prepared.groups.flatMap((entry) => entry.rows).find((row) =>
    row.outcome_label === "negative_use" && row.admission_action === "use_now"
  );
  assert.ok(negative);
  const explore = {
    ...negative,
    memory_id: `${negative.memory_id}:explore`,
    memory_origin: "external" as const,
    source_backend: "external",
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    closed_loop_effect_state: "no_prior" as const,
    repeated_negative_posture: false,
  };
  const exploit = {
    ...negative,
    memory_id: `${negative.memory_id}:exploit`,
    prior_contradicted_use_count: 1,
    closed_loop_effect_state: "contradicted" as const,
  };
  const rows = [explore, exploit];
  const frozen = deriveAdmissionRealAgentPredecisionTrack({
    rows,
    candidate_policy_id: "candidate_project_context_closed_loop_inspect",
  });
  assert.deepEqual(frozen, { policy_affected: true, predecision_track: "mixed" });

  const recorded = scoreAdmissionRealAgentDecision({
    arm_id: "recorded_policy_baseline",
    candidate_policy_id: "candidate_project_context_closed_loop_inspect",
    group_id: "predecision-mixed",
    rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "direct_use",
      selected_memory_id: explore.memory_id,
      used_memory_ids: [explore.memory_id],
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  const candidate = scoreAdmissionRealAgentDecision({
    arm_id: "candidate_project_context_closed_loop_inspect",
    candidate_policy_id: "candidate_project_context_closed_loop_inspect",
    group_id: "predecision-mixed",
    rows,
    decision: normalizeAdmissionRealAgentDecision({
      action: "inspect_memory",
      selected_memory_id: exploit.memory_id,
      used_memory_ids: [exploit.memory_id],
    }),
    prompt_char_count: 100,
    request_char_count: 200,
    completion_char_count: 50,
  });
  assert.equal(recorded.selected_prior_bucket, "no_prior");
  assert.equal(candidate.selected_prior_bucket, "prior_aware");
  assert.equal(recorded.predecision_track, "mixed");
  assert.equal(candidate.predecision_track, "mixed");
  assert.equal(recorded.policy_affected, true);
  assert.equal(candidate.policy_affected, true);

  const mixedReport = buildAdmissionRealAgentRerunReport({
    rows: baselineRows(),
    options: { evaluation_split: "all", max_groups: 1, candidate_policy_id: prepared.candidate_policy_id },
    llm: { provider: "test", model: "test", base_url_host: null },
    recorded_trials: [{ ...recorded, outcome: "negative_direct_risk" }],
    candidate_trials: [{ ...candidate, outcome: "negative_direct_risk" }],
  });
  assert.equal(mixedReport.recorded_arm.predecision_slices.mixed_trial_count, 1);
  assert.equal(mixedReport.recorded_arm.predecision_slices.mixed_negative_direct_risk_count, 1);
  assert.equal(mixedReport.recorded_arm.predecision_slices.explore_negative_direct_risk_count, 0);
  assert.equal(mixedReport.recorded_arm.predecision_slices.exploit_negative_direct_risk_count, 0);
});

test("missing frozen prior fields remain unclassified before the Agent decision", () => {
  const raw = admissionCandidatePolicyFixtureJsonl().split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)[0]!;
  const legacy: Record<string, unknown> = {
    ...raw,
    admission_action: "use_now",
    source_backend: "external",
    memory_type: "fact",
  };
  for (const field of [
    "prior_supported_use_count",
    "prior_contradicted_use_count",
    "prior_rehydrate_requested_count",
    "closed_loop_effect_state",
    "repeated_negative_posture",
  ]) delete legacy[field];
  const rows = parseAdmissionRealAgentDatasetJsonl(JSON.stringify(legacy));
  assert.deepEqual(deriveAdmissionRealAgentPredecisionTrack({
    rows,
    candidate_policy_id: "candidate_aionis_project_context_only",
  }), { policy_affected: true, predecision_track: "unclassified" });
  const complete = {
    ...legacy,
    memory_id: `${String(legacy.memory_id)}:complete-prior`,
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    closed_loop_effect_state: "no_prior",
    repeated_negative_posture: false,
  };
  const mixedCompletenessRows = parseAdmissionRealAgentDatasetJsonl(
    `${JSON.stringify(legacy)}\n${JSON.stringify(complete)}`,
  );
  assert.equal(deriveAdmissionRealAgentPredecisionTrack({
    rows: mixedCompletenessRows,
    candidate_policy_id: "candidate_aionis_project_context_only",
  }).predecision_track, "unclassified");
});

test("finite holdout uses the exact 96-case integer thresholds", () => {
  const equality = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    extraCandidateHarm: 6,
    extraCandidateUtilityLoss: 4,
  }));
  assert.equal(equality.case_count, 96);
  assert.equal(equality.full_risk_set.harm_loss_difference, 4);
  assert.equal(equality.full_risk_set.utility_loss_difference, 4);
  assert.equal(equality.full_risk_set.exploit_harm_loss_difference, -2);
  assert.equal(equality.checks.harm_noninferiority_at_plus_5_points, true);
  assert.equal(equality.checks.utility_noninferiority_at_plus_5_points, true);
  assert.equal(equality.checks.exploit_harm_reduction_at_minus_2_points, true);
  assert.equal(equality.finite_regression_verdict, "passed");
  assert.equal(equality.evidence_grade, "formal_run_bundle_candidate");
  assert.equal(equality.promotion_eligible, false);
  assert.equal(equality.protected_ingestion_status, "not_ingested");

  const over = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    extraCandidateHarm: 7,
    extraCandidateUtilityLoss: 5,
  }));
  assert.equal(over.full_risk_set.harm_loss_difference, 5);
  assert.equal(over.full_risk_set.utility_loss_difference, 5);
  assert.equal(over.checks.harm_noninferiority_at_plus_5_points, false);
  assert.equal(over.checks.utility_noninferiority_at_plus_5_points, false);
  assert.equal(over.finite_regression_verdict, "hold");
});

test("finite holdout missing endpoints use the full-risk-set worst case", () => {
  const candidateOnlyMissing = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value, index) => index >= 20 && index < 25
      ? { ...value, candidate: { ...value.candidate, harm: null } }
      : value,
  }));
  assert.equal(candidateOnlyMissing.assessability.fully_assessable_pair_count, 91);
  assert.equal(candidateOnlyMissing.full_risk_set.harm_loss_difference, 3);
  assert.equal(candidateOnlyMissing.finite_regression_verdict, "passed");

  const recordedOnlyMissing = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value, index) => index < 5
      ? { ...value, recorded: { ...value.recorded, harm: null } }
      : value,
  }));
  assert.equal(recordedOnlyMissing.full_risk_set.harm_loss_difference, 3);

  const bothMissing = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value, index) => index < 7
      ? {
          ...value,
          recorded: { ...value.recorded, harm: null },
          candidate: { ...value.candidate, harm: null },
        }
      : value,
  }));
  assert.equal(bothMissing.assessability.fully_assessable_pair_count, 89);
  assert.equal(bothMissing.full_risk_set.harm_loss_difference, 7);
  assert.equal(bothMissing.finite_regression_verdict, "hold");

  const endpointSpecific = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value, index) => index >= 40 && index < 45
      ? { ...value, candidate: { ...value.candidate, accepted_completed: null } }
      : value,
  }));
  assert.equal(endpointSpecific.full_risk_set.harm_loss_difference, -2);
  assert.equal(endpointSpecific.full_risk_set.utility_loss_difference, 5);
  assert.equal(endpointSpecific.checks.harm_noninferiority_at_plus_5_points, true);
  assert.equal(endpointSpecific.checks.utility_noninferiority_at_plus_5_points, false);
  assert.equal(endpointSpecific.finite_regression_verdict, "hold");
});

test("finite holdout rejects mutable or non-isolated execution evidence", () => {
  const mutable = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    immutableSnapshot: false,
    providerMayUpdateWeights: true,
  }));
  assert.equal(mutable.evidence_grade, "diagnostic_only");
  assert.deepEqual(mutable.hold_reasons, [
    "immutable_execution_snapshot_required",
    "provider_weight_mutation_forbidden",
  ]);

  const wrongStart = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value, index) => index === 1
      ? {
          ...value,
          candidate: {
            ...value.candidate,
            starting_runtime_snapshot_sha256: digest("carried-mutation-from-case-0"),
          },
        }
      : value,
  }));
  assert.equal(wrongStart.finite_regression_verdict, "hold");
  assert.ok(wrongStart.hold_reasons.includes("fresh_byte_identical_arm_copies_required"));

  const reusedCopy = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value) => ({
      ...value,
      recorded: {
        ...value.recorded,
        runtime_copy_identity_sha256: digest("reused-recorded-copy"),
      },
    }),
  }));
  assert.ok(reusedCopy.hold_reasons.includes("runtime_copy_identity_reuse_forbidden"));

  const retainedCopy = evaluateAdmissionRealAgentFiniteHoldout(finiteHoldoutFixture({
    mutateCase: (value, index) => index === 1
      ? { ...value, recorded: { ...value.recorded, runtime_copy_destroyed: false } }
      : value,
  }));
  assert.ok(retainedCopy.hold_reasons.includes("verified_runtime_copy_cleanup_required"));
});

test("finite holdout rejects malformed, relabeled, replayed, or unobserved evidence", () => {
  const missingAuthority = finiteHoldoutFixture() as any;
  missingAuthority.authority_bindings = {};
  const missingEndpoint = finiteHoldoutFixture() as any;
  delete missingEndpoint.cases[0].candidate.harm;
  const invalidTrack = finiteHoldoutFixture() as any;
  invalidTrack.cases[0].predecision_track = "garbage";
  const wrongProfileTypes = finiteHoldoutFixture() as any;
  wrongProfileTypes.profile.immutable_snapshot = "yes";
  wrongProfileTypes.profile.provider_may_update_weights = 0;
  for (const malformed of [missingAuthority, missingEndpoint, invalidTrack, wrongProfileTypes]) {
    const result = evaluateAdmissionRealAgentFiniteHoldout(malformed);
    assert.equal(result.evidence_grade, "diagnostic_only");
    assert.equal(result.finite_regression_verdict, "hold");
    assert.deepEqual(result.hold_reasons, ["finite_holdout_contract_invalid"]);
  }

  const relabeled = finiteHoldoutFixture();
  relabeled.cases[0]!.predecision_track = "explore";
  const relabeledResult = evaluateAdmissionRealAgentFiniteHoldout(relabeled);
  assert.ok(relabeledResult.hold_reasons.includes("case_set_digest_mismatch"));

  const replayedFixture = finiteHoldoutFixture();
  for (const entry of replayedFixture.cases) {
    entry.recorded.response_fingerprint_sha256 = digest("replayed-response");
    entry.candidate.response_fingerprint_sha256 = digest("replayed-response");
  }
  const replayedFingerprint = evaluateAdmissionRealAgentFiniteHoldout(replayedFixture);
  assert.ok(replayedFingerprint.hold_reasons.includes("response_fingerprint_reuse_forbidden"));

  const wrongObservedOrder = finiteHoldoutFixture();
  wrongObservedOrder.cases[0]!.observed_first_arm = "candidate";
  const wrongObservedResult = evaluateAdmissionRealAgentFiniteHoldout(wrongObservedOrder);
  assert.ok(wrongObservedResult.hold_reasons.includes("observed_execution_order_mismatch"));
});

test("finite holdout runner accepts only the exact counterbalanced 96-unit manifest", () => {
  const units = Array.from({ length: 96 }, (_, index) => ({
    case_ordinal: index,
    case_identity_sha256: digest(`runner-manifest-unit:${index}`),
    policy_affected: true,
    predecision_track: index < 48 ? "exploit" as const : "explore" as const,
    first_arm: index % 2 === 0 ? "recorded" as const : "candidate" as const,
  }));
  const validated = validateAdmissionRealAgentFiniteHoldoutUnits([...units].reverse());
  assert.deepEqual(validated.map((unit) => unit.case_ordinal), Array.from({ length: 96 }, (_, index) => index));
  assert.throws(
    () => validateAdmissionRealAgentFiniteHoldoutUnits(units.slice(0, 95)),
    /finite_holdout_exact_counterbalanced_96_unit_manifest_required/,
  );
  assert.throws(
    () => validateAdmissionRealAgentFiniteHoldoutUnits(units.map((unit, index) =>
      index === 1 ? { ...unit, first_arm: "recorded" as const } : unit
    )),
    /finite_holdout_exact_counterbalanced_96_unit_manifest_required/,
  );
  assert.throws(
    () => validateAdmissionRealAgentFiniteHoldoutUnits(units.map((unit, index) =>
      index === 95 ? { ...unit, case_identity_sha256: units[0]!.case_identity_sha256 } : unit
    )),
    /finite_holdout_exact_counterbalanced_96_unit_manifest_required/,
  );
});

test("fresh Runtime pairs restore, mutate, destroy, and start the next unit without carried state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-admission-finite-holdout-"));
  const sourcePath = path.join(root, "source.sqlite");
  const backupPath = path.join(root, "backup", "runtime.sqlite");
  const observedRuntimePaths: string[] = [];
  const observedRuntimeInodes: number[] = [];
  const postCloseRuntimeProbes: Array<() => unknown> = [];
  const scope = "finite-holdout-isolation";
  const carriedNodeId = "unit-1-node";
  const carriedOperationId = "unit-1-safety-authority";
  try {
    const source = createLiteWriteStore(sourcePath, { annProjectionEnabled: false });
    await source.close();
    const backup = await backupLiteRuntimeDatabase({ sourcePath, destinationPath: backupPath });

    const unit1 = await runAdmissionRealAgentFreshRuntimePair({
      backupPath,
      caseOrdinal: 0,
      caseIdentitySha256: digest("finite-runtime-unit:0"),
      firstArm: "recorded",
      workRoot: path.join(root, "pairs"),
      async runArm({ arm, runtimeDatabase, startingRuntimeSnapshotSha256 }) {
        const runtimePath = runtimeDatabase.path;
        observedRuntimePaths.push(runtimePath);
        observedRuntimeInodes.push(fs.statSync(runtimePath).ino);
        postCloseRuntimeProbes.push(() => runtimeDatabase.db.prepare("SELECT 1").get());
        assert.equal(startingRuntimeSnapshotSha256, backup.manifest.sha256);
        const store = createLiteWriteStoreFromDatabase(runtimeDatabase, {
          annProjectionEnabled: false,
          closeDatabaseOnClose: false,
        });
        const ledger = createLiteLearningEpisodeLedgerAccess(runtimeDatabase);
        try {
          const beforeNode = await store.findNodes({ scope, id: carriedNodeId, limit: 10, offset: 0 });
          const beforeJobs = await store.listProjectionJobs({ limit: 10 });
          const beforeReceipt = await store.getWriteOperation({
            tenantId: "default",
            scope,
            operationKind: "finite_holdout_safety_authority_v1",
            operationId: carriedOperationId,
          });
          const beforeAuthority = runtimeDatabase.readDb.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_policy_versions WHERE policy_id = ?",
          ).get<{ count: number }>("finite-holdout-isolation-policy");
          assert.equal(beforeNode.rows.length, 0);
          assert.equal(beforeJobs.length, 0);
          assert.equal(beforeReceipt, null);
          assert.equal(beforeAuthority.count, 0);
          await store.withTx(async () => {
            const commitId = await store.insertCommit({
              scope,
              parentCommitId: null,
              inputSha256: digest(`unit-1-input:${arm}`),
              diffJson: "{}",
              actor: "finite-holdout-test",
              modelVersion: null,
              promptVersion: null,
              commitHash: digest(`unit-1-commit:${arm}`),
            });
            await store.insertNode({
              id: carriedNodeId,
              scope,
              clientId: null,
              type: "fact",
              tier: "hot",
              title: "Unit 1 mutation",
              textSummary: "This row must not appear in unit 2.",
              slotsJson: "{}",
              rawRef: null,
              evidenceRef: null,
              embeddingVector: null,
              embeddingModel: null,
              memoryLane: "shared",
              producerAgentId: "finite-holdout-test",
              ownerAgentId: null,
              ownerTeamId: null,
              embeddingStatus: "pending",
              embeddingLastError: null,
              salience: 0.8,
              importance: 0.7,
              confidence: 0.9,
              redactionVersion: 0,
              commitId,
            });
            await store.enqueueAnnProjection({ scope, nodeId: carriedNodeId, sourceCommitId: commitId });
            await store.insertWriteOperation({
              tenantId: "default",
              scope,
              operationKind: "finite_holdout_safety_authority_v1",
              operationId: carriedOperationId,
              requestSha256: digest(`unit-1-authority:${arm}`),
              receiptJson: JSON.stringify({ arm, status: "recorded" }),
              commitId,
            });
            const policyConfigJson = JSON.stringify({
              behavior: "isolation-marker",
              contract_version: "finite-holdout-isolation-policy-v1",
            });
            await ledger.insertPolicyVersion({
              tenant_id: "default",
              policy_kind: "candidate",
              policy_id: "finite-holdout-isolation-policy",
              policy_version: "v1",
              policy_config_sha256: digest(policyConfigJson),
              policy_config_json: policyConfigJson,
              implementation_contract_sha256: digest("finite-holdout-isolation-implementation"),
              prospective_calibration_sha256: null,
              prospective_calibration_json: null,
              created_at: "2026-07-16T00:00:00.000Z",
            });
          });
          const committedNode = await store.findNodes({ scope, id: carriedNodeId, limit: 10, offset: 0 });
          const committedJobs = await store.listProjectionJobs({ limit: 10 });
          const committedReceipt = await store.getWriteOperation({
            tenantId: "default",
            scope,
            operationKind: "finite_holdout_safety_authority_v1",
            operationId: carriedOperationId,
          });
          const committedAuthority = runtimeDatabase.readDb.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_policy_versions WHERE policy_id = ?",
          ).get<{ count: number }>("finite-holdout-isolation-policy");
          assert.equal(committedNode.rows.length, 1);
          assert.equal(committedJobs.length, 1);
          assert.ok(committedReceipt);
          assert.equal(committedAuthority.count, 1);
        } finally {
          await store.close();
        }
        return arm;
      },
    });
    assert.deepEqual(unit1.execution_order, ["recorded", "candidate"]);
    assert.equal(unit1.source_runtime_snapshot_sha256, backup.manifest.sha256);
    assert.equal(unit1.recorded.starting_runtime_snapshot_sha256, backup.manifest.sha256);
    assert.equal(unit1.candidate.starting_runtime_snapshot_sha256, backup.manifest.sha256);
    assert.notEqual(unit1.recorded.runtime_copy_identity_sha256, unit1.candidate.runtime_copy_identity_sha256);
    assert.notEqual(unit1.recorded.ending_runtime_snapshot_sha256, backup.manifest.sha256);
    assert.notEqual(unit1.candidate.ending_runtime_snapshot_sha256, backup.manifest.sha256);
    assert.equal(unit1.recorded.runtime_copy_destroyed, true);
    assert.equal(unit1.candidate.runtime_copy_destroyed, true);
    assert.ok(postCloseRuntimeProbes.every((probe) => {
      try { probe(); return false; } catch { return true; }
    }));
    assert.ok(observedRuntimePaths.every((runtimePath) => !fs.existsSync(runtimePath)));

    const unit2 = await runAdmissionRealAgentFiniteHoldoutCase({
      backupPath,
      unit: {
        case_ordinal: 1,
        case_identity_sha256: digest("finite-runtime-unit:1"),
        policy_affected: true,
        predecision_track: "explore",
        first_arm: "candidate",
      },
      executionProfileSha256: digest("finite-runtime-execution-profile"),
      workRoot: path.join(root, "pairs"),
      async runArm({ arm, runtimeDatabase, startingRuntimeSnapshotSha256 }) {
        const runtimePath = runtimeDatabase.path;
        observedRuntimePaths.push(runtimePath);
        observedRuntimeInodes.push(fs.statSync(runtimePath).ino);
        postCloseRuntimeProbes.push(() => runtimeDatabase.db.prepare("SELECT 1").get());
        assert.equal(startingRuntimeSnapshotSha256, backup.manifest.sha256);
        const store = createLiteWriteStoreFromDatabase(runtimeDatabase, {
          annProjectionEnabled: false,
          closeDatabaseOnClose: false,
        });
        try {
          const node = await store.findNodes({ scope, id: carriedNodeId, limit: 10, offset: 0 });
          const jobs = await store.listProjectionJobs({ limit: 10 });
          const receipt = await store.getWriteOperation({
            tenantId: "default",
            scope,
            operationKind: "finite_holdout_safety_authority_v1",
            operationId: carriedOperationId,
          });
          const authority = runtimeDatabase.readDb.prepare(
            "SELECT COUNT(*) AS count FROM lite_learning_policy_versions WHERE policy_id = ?",
          ).get<{ count: number }>("finite-holdout-isolation-policy");
          assert.equal(node.rows.length, 0);
          assert.equal(jobs.length, 0);
          assert.equal(receipt, null);
          assert.equal(authority.count, 0);
        } finally {
          await store.close();
        }
        return {
          harm: false,
          accepted_completed: true,
          request_fingerprint_sha256: digest(`finite-runtime-unit:1:${arm}:request`),
          response_payload_sha256: digest(`finite-runtime-unit:1:${arm}:response`),
        };
      },
    });
    assert.equal(unit2.observed_first_arm, "candidate");
    assert.match(unit2.recorded.ending_runtime_snapshot_sha256, /^[0-9a-f]{64}$/);
    assert.match(unit2.candidate.ending_runtime_snapshot_sha256, /^[0-9a-f]{64}$/);
    const mappedCaseFixture = finiteHoldoutFixture();
    mappedCaseFixture.cases[1] = unit2;
    assert.notDeepEqual(
      evaluateAdmissionRealAgentFiniteHoldout(mappedCaseFixture).hold_reasons,
      ["finite_holdout_contract_invalid"],
    );
    assert.ok(observedRuntimePaths.every((runtimePath) => !fs.existsSync(runtimePath)));
    assert.ok(postCloseRuntimeProbes.every((probe) => {
      try { probe(); return false; } catch { return true; }
    }));
    assert.equal(new Set(observedRuntimePaths).size, 4);
    assert.equal(new Set(observedRuntimeInodes).size, 4);
    const frozenBackup = await verifyLiteRuntimeDatabase(backupPath);
    assert.equal(frozenBackup.sha256, backup.manifest.sha256);
    assert.deepEqual(frozenBackup.counts, backup.verification.counts);
    assert.deepEqual(frozenBackup.learning.replay?.table_counts, backup.verification.learning.replay?.table_counts);

    const failedPairPaths: string[] = [];
    await assert.rejects(runAdmissionRealAgentFreshRuntimePair({
      backupPath,
      caseOrdinal: 2,
      caseIdentitySha256: digest("finite-runtime-unit:2"),
      firstArm: "recorded",
      workRoot: path.join(root, "pairs"),
      async runArm({ runtimeDatabase }) {
        const runtimePath = runtimeDatabase.path;
        failedPairPaths.push(runtimePath);
        throw new Error("injected-arm-failure-after-restore");
      },
    }), /injected-arm-failure-after-restore/);
    assert.ok(failedPairPaths.every((runtimePath) => !fs.existsSync(runtimePath)));
    assert.ok(failedPairPaths.every((runtimePath) => !fs.existsSync(path.dirname(runtimePath))));
    assert.ok(failedPairPaths.every((runtimePath) =>
      !fs.existsSync(path.join(path.dirname(runtimePath), "candidate.sqlite"))
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
