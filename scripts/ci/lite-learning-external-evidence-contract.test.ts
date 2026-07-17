import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import { learningGatePolicyConfigDigest } from "../../src/memory/learning-gate-policy.js";

import {
  LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1,
  LearningExternalAttemptChainV1Schema,
  LearningExternalEvidenceArtifactKindSchema,
  LearningExternalEvidenceBindingV1Schema,
  LearningExternalEvidenceReportV1Schema,
  LearningExternalEvidenceRunBundleV1Schema,
  LearningExternalEvidenceStatusSchema,
  LearningExternalLifecycleAuthorityProjectionV1Schema,
  LearningExternalPreterminalPayloadSetV1Schema,
  learningExternalAttemptChainDigest,
  learningExternalEvidenceArtifactId,
  learningExternalEvidenceBindingDigest,
  learningExternalEvidenceIngestRequestDigest,
  learningExternalEvidenceLifecycleAuthorityProjectionDigest,
  learningExternalEvidenceReportDigest,
  learningExternalEvidenceReportJson,
  learningExternalEvidenceRunBundleDigest,
  learningExternalEvidenceThresholdContractDigest,
  learningExternalPreterminalPayloadSetDigest,
  learningExternalRunnerOutputManifestDigest,
  learningExternalTerminalRunManifestDigest,
  parseCanonicalLearningExternalEvidenceReportJson,
  validateLearningExternalEvidenceContractSetV1,
  type LearningExternalEvidenceArtifactKind,
  type LearningExternalEvidenceStatus,
  type LearningExternalEvidenceValidatedContractSetV1,
} from "../../src/memory/learning-external-evidence.js";

type JsonObject = Record<string, unknown>;

type EvidenceFixture = {
  binding: JsonObject;
  report: JsonObject;
  attemptChain: JsonObject;
  preterminalPayloadSet: JsonObject;
  runnerOutputManifest: JsonObject;
  terminalRunManifest: JsonObject;
  lifecycleAuthorityProjection: JsonObject;
  publicRunAuthoritySha256: string;
  runBundle: JsonObject;
};

const STATUSES = ["passed", "failed", "inconclusive"] as const;
const KINDS = [
  "offline_paired_rerun",
  "production_shadow_gate",
  "tool_e2e_gate",
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function objects(value: unknown): JsonObject[] {
  assert.ok(Array.isArray(value));
  return value as JsonObject[];
}

function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

function lifecycleFact(
  authorityTable: string,
  operationKind: string,
  factId: string,
): JsonObject {
  const factSha256 = sha256(`fact:${authorityTable}:${factId}`);
  return {
    authority_table: authorityTable,
    fact_id: factId,
    fact_sha256: factSha256,
    protected_operation: {
      scope: "learning_external_authority_v1",
      operation_kind: operationKind,
      operation_id: `${factId}-operation`,
      operation_request_sha256: sha256(`operation-request:${operationKind}:${factId}`),
      authority_record_sha256: factSha256,
    },
  };
}

function evidenceBinding(kind: LearningExternalEvidenceArtifactKind): JsonObject {
  return {
    contract_version: "aionis_learning_external_evidence_binding_v1",
    artifact_kind: kind,
    tenant_id: "tenant-contract",
    database_instance_id: sha256("database-instance"),
    evidence_series_id: `series-${kind}`,
    task_family: "runtime-learning",
    applicable_experiment_id: "experiment-contract",
    applicable_experiment_revision: 7,
    candidate_policy_id: "candidate-policy",
    candidate_policy_version: "candidate-policy-v1",
    candidate_policy_implementation_sha256: sha256("candidate-implementation"),
    candidate_policy_config_sha256: sha256("candidate-config"),
    gate_policy_id: "gate-policy",
    gate_policy_version: "v1",
    gate_policy_config_sha256: learningGatePolicyConfigDigest(),
    applicability_manifest_sha256: sha256("applicability-manifest"),
    evidence_scope_set_sha256: sha256("evidence-scope-set"),
    immutable_input_manifest_sha256: sha256(`immutable-input:${kind}`),
    retry_policy_sha256: sha256("retry-policy"),
    harness_bundle_sha256: sha256(`harness:${kind}`),
    source_snapshot_sha256: sha256(`source-snapshot:${kind}`),
    run_id: `run-${kind}`,
  };
}

function reportPayload(
  kind: LearningExternalEvidenceArtifactKind,
  status: LearningExternalEvidenceStatus,
): Readonly<{ payload: JsonObject; reasonCodes: string[] }> {
  if (kind === "offline_paired_rerun") {
    const failed = status === "failed";
    const inconclusive = status === "inconclusive";
    return {
      payload: {
        contract_version: "aionis_learning_external_offline_paired_report_payload_v1",
        evidence_status: status,
        case_count: 96,
        harm_pair_count: inconclusive ? 80 : 96,
        utility_pair_count: 96,
        fully_assessable_pair_count: inconclusive ? 80 : 96,
        recorded_harm_observed_loss_count: 5,
        candidate_harm_observed_loss_count: failed ? 11 : inconclusive ? 0 : 4,
        recorded_harm_missing_count: inconclusive ? 8 : 0,
        candidate_harm_missing_count: inconclusive ? 8 : 0,
        harm_both_arms_missing_count: 0,
        recorded_utility_observed_loss_count: 6,
        candidate_utility_observed_loss_count: 5,
        recorded_utility_missing_count: 0,
        candidate_utility_missing_count: 0,
        utility_both_arms_missing_count: 0,
        both_endpoints_unassessable_pair_count: 0,
        exploit_case_count: 20,
        recorded_exploit_harm_observed_loss_count: 4,
        candidate_exploit_harm_observed_loss_count: inconclusive ? 0 : 2,
        recorded_exploit_harm_missing_count: 0,
        candidate_exploit_harm_missing_count: 0,
        case_set_sha256: sha256("offline-case-set"),
        execution_profile_sha256: sha256("offline-execution-profile"),
        model_identity_sha256: sha256("offline-model-identity"),
        execution_order_sha256: sha256("offline-execution-order"),
        response_fingerprint_set_sha256: sha256("offline-response-fingerprints"),
        runtime_copy_set_sha256: sha256("offline-runtime-copy-set"),
        endpoint_result_set_sha256: sha256("offline-endpoint-results"),
        exclusion_manifest_sha256: sha256("offline-exclusion-manifest"),
        fixed_threshold_contract_sha256: learningExternalEvidenceThresholdContractDigest(),
      },
      reasonCodes: failed
        ? ["harm_noninferiority_at_plus_5_points"]
        : inconclusive ? ["harm_assessability_at_least_90_percent"] : [],
    };
  }

  if (kind === "production_shadow_gate") {
    const failed = status === "failed";
    const inconclusive = status === "inconclusive";
    const rowCount = inconclusive ? 999 : 1_000;
    return {
      payload: {
        contract_version: "aionis_learning_external_production_shadow_report_payload_v1",
        evidence_status: status,
        row_count: rowCount,
        run_count: 10,
        task_signature_count: 30,
        scope_count: 5,
        projection_present_count: rowCount,
        source_row_set_sha256: sha256("shadow-source-row-set"),
        source_run_set_sha256: sha256("shadow-source-run-set"),
        shadow_projection_set_sha256: sha256("shadow-projection-set"),
        host_adapter_conformance_sha256: sha256("shadow-host-conformance"),
        fixed_threshold_contract_sha256: learningExternalEvidenceThresholdContractDigest(),
        online_mode: "shadow",
        shadow_projection_source_count: rowCount,
        agent_prompt_included_count: 0,
        runtime_mutation_count: 0,
        hard_boundary_upgrade_count: failed ? 1 : 0,
        selected_candidate_policy_id: "candidate-policy",
        recorded_hard_boundary_direct_use_count: 10,
        candidate_hard_boundary_direct_use_count: 9,
        recorded_negative_use_count: 10,
        candidate_negative_use_count: 9,
        recorded_positive_capture_count: 10,
        candidate_positive_capture_count: 11,
        recorded_calibration_score_micros: 500_000,
        candidate_calibration_score_micros: 600_000,
        changed_action_count: 1,
      },
      reasonCodes: failed
        ? ["no_hard_boundary_upgrade"]
        : inconclusive ? ["exact_source_coverage"] : [],
    };
  }

  const failed = status === "failed";
  const inconclusive = status === "inconclusive";
  const resultCount = inconclusive ? 39 : 40;
  return {
    payload: {
      contract_version: "aionis_learning_external_tool_e2e_report_payload_v1",
      evidence_status: status,
      requested_count: 40,
      completed_count: resultCount,
      result_count: resultCount,
      difficulty_level_count: 4,
      result_set_sha256: sha256("tool-result-set"),
      tool_manifest_sha256: sha256("tool-manifest"),
      host_adapter_conformance_sha256: sha256("tool-host-conformance"),
      fixed_threshold_contract_sha256: learningExternalEvidenceThresholdContractDigest(),
      policy_mode: "active",
      policy_source: "profile_rule",
      required_policy_source: "profile_rule",
      policy_source_guide_count: resultCount,
      policy_source_matching_count: resultCount,
      required_policy_profile_id: "profile-contract",
      actual_policy_profile_id: "profile-contract",
      policy_profile_matching_count: resultCount,
      metrics: {
        route_write_violation_count: 0,
        route_action_violation_count: 0,
        direction_attention_violation_count: 0,
        terminal_inspect_count: 0,
        report_conflict_count: failed ? 1 : 0,
        accepted_route_hits: resultCount,
        action_completion_hits: resultCount,
        initial_context_chars: 1_000,
        full_history_initial_context_chars: 2_000,
        prompt_tokens: 500,
        full_history_prompt_tokens: 1_000,
      },
    },
    reasonCodes: failed
      ? ["no_report_conflict"]
      : inconclusive ? ["exact_result_coverage"] : [],
  };
}

function buildFixture(
  kind: LearningExternalEvidenceArtifactKind,
  status: LearningExternalEvidenceStatus,
): EvidenceFixture {
  const binding = evidenceBinding(kind);
  const bindingSha256 = learningExternalEvidenceBindingDigest(binding);
  const sourceBundleSha256 = sha256(`source-bundle:${kind}`);
  const sourceCommitId = sha256(`source-commit:${kind}`).slice(0, 40);
  const sourcePhase = kind === "offline_paired_rerun"
    ? "isolated_paired"
    : kind === "production_shadow_gate" ? "shadow" : "external_tool";
  const { payload, reasonCodes } = reportPayload(kind, status);
  const productionSource = kind === "production_shadow_gate";

  const report: JsonObject = {
    contract_version: "aionis_learning_external_evidence_report_v1",
    evidence_binding_sha256: bindingSha256,
    ...Object.fromEntries(Object.entries(binding).filter(([key]) => ![
      "contract_version", "artifact_kind",
    ].includes(key))),
    artifact_kind: kind,
    artifact_status: status,
    source_experiment_id: productionSource ? "source-experiment" : null,
    source_experiment_revision: productionSource ? 3 : null,
    source_serving_phase: sourcePhase,
    source_bundle_sha256: sourceBundleSha256,
    collected_at: "2026-07-17T00:00:06.000Z",
    reason_codes: reasonCodes,
    payload,
  };
  const reportSha256 = learningExternalEvidenceReportDigest(report);

  const attemptChain: JsonObject = {
    contract_version: "aionis_learning_external_attempt_chain_v1",
    evidence_binding_sha256: bindingSha256,
    reservation_id: "reservation-id",
    ticket_consumption_id: "consumption-id",
    claim_id: "claim-id",
    supervisor_binding_id: "binding-id",
    credential_session_max_calls: 2,
    attempts: [
      {
        attempt_ordinal: 1,
        call_id: "call-1",
        capability_sha256: sha256("capability-1"),
        request_sha256: sha256("request-1"),
        response_sha256: sha256("response-1"),
        result: "succeeded",
        started_at: "2026-07-17T00:00:01.000Z",
        finished_at: "2026-07-17T00:00:02.000Z",
      },
      {
        attempt_ordinal: 2,
        call_id: "call-2",
        capability_sha256: sha256("capability-2"),
        request_sha256: sha256("request-2"),
        response_sha256: null,
        result: "failed",
        started_at: "2026-07-17T00:00:03.000Z",
        finished_at: "2026-07-17T00:00:04.000Z",
      },
    ],
    sealed_at: "2026-07-17T00:00:05.000Z",
  };
  const attemptChainSha256 = learningExternalAttemptChainDigest(attemptChain);

  const preterminalPayloadSet: JsonObject = {
    contract_version: "aionis_learning_external_preterminal_payload_set_v1",
    evidence_binding_sha256: bindingSha256,
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: binding.harness_bundle_sha256,
  };
  const preterminalPayloadSetSha256 = learningExternalPreterminalPayloadSetDigest(
    preterminalPayloadSet,
  );

  const runnerOutputManifest: JsonObject = {
    contract_version: "aionis_learning_external_runner_output_manifest_v1",
    evidence_binding_sha256: bindingSha256,
    artifact_kind: kind,
    artifact_status: status,
    reservation_id: "reservation-id",
    ticket_consumption_id: "consumption-id",
    claim_id: "claim-id",
    supervisor_binding_id: "binding-id",
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: binding.harness_bundle_sha256,
    preterminal_payload_set_sha256: preterminalPayloadSetSha256,
    source_ref: `evals/learning-episode-gate-v1/runs/${kind}`,
    source_commit_id: sourceCommitId,
    collected_at: "2026-07-17T00:00:06.000Z",
  };
  const runnerOutputManifestSha256 = learningExternalRunnerOutputManifestDigest(
    runnerOutputManifest,
  );

  const terminalRunManifest: JsonObject = {
    contract_version: "aionis_learning_external_terminal_run_manifest_v1",
    evidence_binding_sha256: bindingSha256,
    artifact_kind: kind,
    artifact_status: status,
    reservation_id: "reservation-id",
    ticket_consumption_id: "consumption-id",
    claim_id: "claim-id",
    supervisor_binding_id: "binding-id",
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    runner_output_manifest_sha256: runnerOutputManifestSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: binding.harness_bundle_sha256,
    preterminal_payload_set_sha256: preterminalPayloadSetSha256,
    source_ref: runnerOutputManifest.source_ref,
    source_commit_id: sourceCommitId,
    finalized_at: "2026-07-17T00:00:07.000Z",
  };
  const terminalRunManifestSha256 = learningExternalTerminalRunManifestDigest(
    terminalRunManifest,
  );

  const terminationFactSha256 = sha256(`fact:session-termination:${kind}:${status}`);
  const lifecycleAuthorityProjection: JsonObject = {
    contract_version: "aionis_learning_external_lifecycle_authority_projection_v1",
    evidence_binding_sha256: bindingSha256,
    artifact_kind: kind,
    tenant_id: binding.tenant_id,
    database_instance_id: binding.database_instance_id,
    reservation: lifecycleFact(
      "lite_learning_external_run_reservations",
      "learning_external_run_reservation_v1",
      "reservation-id",
    ),
    ticket_consumption: lifecycleFact(
      "lite_learning_external_ticket_consumptions",
      "learning_external_ticket_consumption_v1",
      "consumption-id",
    ),
    claim: lifecycleFact(
      "lite_learning_external_run_claims",
      "learning_external_run_claim_v1",
      "claim-id",
    ),
    supervisor_binding: lifecycleFact(
      "lite_learning_external_supervisor_bindings",
      "learning_external_supervisor_binding_v1",
      "binding-id",
    ),
    session_termination: {
      authority_table: "lite_learning_external_session_terminations",
      fact_id: "termination-id",
      fact_sha256: terminationFactSha256,
      termination_reason: status,
      broker_terminal_receipt_sha256: sha256("broker-terminal-receipt"),
      broker_quiesce_receipt_sha256: sha256("broker-quiesce-receipt"),
      runner_output_manifest_sha256: runnerOutputManifestSha256,
      terminal_run_manifest_sha256: terminalRunManifestSha256,
      attempt_chain_sha256: attemptChainSha256,
      terminated_at: "2026-07-17T00:00:08.000Z",
      protected_operation: {
        scope: "learning_external_authority_v1",
        operation_kind: "learning_external_session_termination_v1",
        operation_id: "termination-id-operation",
        operation_request_sha256: sha256("session-termination-operation-request"),
        authority_record_sha256: terminationFactSha256,
      },
    },
    service_launcher_receipt_sha256: sha256("service-launcher-receipt"),
  };
  const lifecycleAuthorityProjectionSha256 =
    learningExternalEvidenceLifecycleAuthorityProjectionDigest(lifecycleAuthorityProjection);
  const publicRunAuthoritySha256 = sha256(`public-run-authority:${kind}:${status}`);

  const runBundle: JsonObject = {
    contract_version: "aionis_learning_external_evidence_run_bundle_v1",
    evidence_binding_sha256: bindingSha256,
    artifact_kind: kind,
    artifact_status: status,
    lifecycle_authority_projection_sha256: lifecycleAuthorityProjectionSha256,
    public_run_authority_sha256: publicRunAuthoritySha256,
    reservation_id: "reservation-id",
    ticket_consumption_id: "consumption-id",
    claim_id: "claim-id",
    supervisor_binding_id: "binding-id",
    session_termination_id: "termination-id",
    session_termination_sha256: terminationFactSha256,
    report_sha256: reportSha256,
    attempt_chain_sha256: attemptChainSha256,
    runner_output_manifest_sha256: runnerOutputManifestSha256,
    terminal_run_manifest_sha256: terminalRunManifestSha256,
    source_bundle_sha256: sourceBundleSha256,
    harness_bundle_sha256: binding.harness_bundle_sha256,
    preterminal_payload_set_sha256: preterminalPayloadSetSha256,
    source_ref: runnerOutputManifest.source_ref,
    source_commit_id: sourceCommitId,
    members: [
      {
        path: "attempt-chain.json",
        role: "attempt_chain",
        byte_length: canonicalByteLength(attemptChain),
        sha256: attemptChainSha256,
      },
      {
        path: "lifecycle-authority-projection.json",
        role: "lifecycle_authority_projection",
        byte_length: canonicalByteLength(lifecycleAuthorityProjection),
        sha256: lifecycleAuthorityProjectionSha256,
      },
      {
        path: "public-run-authority.json",
        role: "public_run_authority",
        byte_length: 16_384,
        sha256: publicRunAuthoritySha256,
      },
      {
        path: "report.json",
        role: "report",
        byte_length: canonicalByteLength(report),
        sha256: reportSha256,
      },
      {
        path: "runner-output-manifest.json",
        role: "runner_output_manifest",
        byte_length: canonicalByteLength(runnerOutputManifest),
        sha256: runnerOutputManifestSha256,
      },
      {
        path: "source-bundle.json",
        role: "source_bundle",
        byte_length: 4_096,
        sha256: sourceBundleSha256,
      },
      {
        path: "terminal-run-manifest.json",
        role: "terminal_run_manifest",
        byte_length: canonicalByteLength(terminalRunManifest),
        sha256: terminalRunManifestSha256,
      },
    ],
    committed_at: "2026-07-17T00:00:09.000Z",
  };

  return {
    binding,
    report,
    attemptChain,
    preterminalPayloadSet,
    runnerOutputManifest,
    terminalRunManifest,
    lifecycleAuthorityProjection,
    publicRunAuthoritySha256,
    runBundle,
  };
}

function validateFixture(
  fixture: EvidenceFixture,
): LearningExternalEvidenceValidatedContractSetV1 {
  return validateLearningExternalEvidenceContractSetV1({
    lifecycleAuthorityProjection: fixture.lifecycleAuthorityProjection,
    report: fixture.report,
    attemptChain: fixture.attemptChain,
    runnerOutputManifest: fixture.runnerOutputManifest,
    terminalRunManifest: fixture.terminalRunManifest,
    publicRunAuthoritySha256: fixture.publicRunAuthoritySha256,
    runBundle: fixture.runBundle,
  });
}

function artifactIdentity(
  validated: LearningExternalEvidenceValidatedContractSetV1,
): JsonObject {
  const authority = validated.lifecycleAuthorityProjection;
  return {
    contract_version: "aionis_learning_external_evidence_artifact_identity_v1",
    evidence_binding_sha256: validated.report.evidence_binding_sha256,
    artifact_kind: validated.report.artifact_kind,
    artifact_status: validated.report.artifact_status,
    tenant_id: validated.report.tenant_id,
    evidence_series_id: validated.report.evidence_series_id,
    task_family: validated.report.task_family,
    applicable_experiment_id: validated.report.applicable_experiment_id,
    applicable_experiment_revision: validated.report.applicable_experiment_revision,
    reservation_id: authority.reservation.fact_id,
    ticket_consumption_id: authority.ticket_consumption.fact_id,
    claim_id: authority.claim.fact_id,
    supervisor_binding_id: authority.supervisor_binding.fact_id,
    session_termination_id: authority.session_termination.fact_id,
    session_termination_sha256: authority.session_termination.fact_sha256,
    report_sha256: validated.digests.report_sha256,
    attempt_chain_sha256: validated.digests.attempt_chain_sha256,
    runner_output_manifest_sha256: validated.digests.runner_output_manifest_sha256,
    terminal_run_manifest_sha256: validated.digests.terminal_run_manifest_sha256,
    source_bundle_sha256: validated.report.source_bundle_sha256,
    harness_bundle_sha256: validated.report.harness_bundle_sha256,
    preterminal_payload_set_sha256: validated.runBundle.preterminal_payload_set_sha256,
  };
}

function mutateAndReject(
  base: EvidenceFixture,
  name: string,
  mutate: (fixture: EvidenceFixture) => void,
): void {
  const fixture = clone(base);
  mutate(fixture);
  assert.throws(() => validateFixture(fixture), name);
}

test("external evidence contracts accept all three kinds and all terminal result statuses", () => {
  for (const kind of KINDS) {
    for (const status of STATUSES) {
      const fixture = buildFixture(kind, status);
      assert.deepEqual(
        LearningExternalEvidenceBindingV1Schema.parse(fixture.binding),
        fixture.binding,
      );
      assert.deepEqual(
        LearningExternalPreterminalPayloadSetV1Schema.parse(fixture.preterminalPayloadSet),
        fixture.preterminalPayloadSet,
      );
      const validated = validateFixture(fixture);
      assert.equal(validated.report.artifact_kind, kind);
      assert.equal(validated.report.artifact_status, status);
      assert.equal(
        validated.lifecycleAuthorityProjection.session_termination.termination_reason,
        status,
      );
      assert.equal(validated.runBundle.artifact_status, status);
      assert.equal(
        validated.digests.report_sha256,
        sha256(learningExternalEvidenceReportJson(fixture.report)),
      );
      assert.equal(
        learningExternalEvidenceArtifactId(artifactIdentity(validated)),
        learningExternalEvidenceArtifactId(clone(artifactIdentity(validated))),
      );
    }
  }
});

test("report status is derived from missingness, known failures, and exact policy identity", () => {
  const offline = buildFixture("offline_paired_rerun", "passed");
  const offlinePayload = object(offline.report.payload);
  offlinePayload.harm_pair_count = 87;
  offlinePayload.utility_pair_count = 87;
  offlinePayload.fully_assessable_pair_count = 87;
  offlinePayload.recorded_harm_observed_loss_count = 2;
  offlinePayload.candidate_harm_observed_loss_count = 0;
  offlinePayload.recorded_harm_missing_count = 0;
  offlinePayload.candidate_harm_missing_count = 9;
  offlinePayload.recorded_utility_observed_loss_count = 0;
  offlinePayload.candidate_utility_observed_loss_count = 0;
  offlinePayload.recorded_utility_missing_count = 0;
  offlinePayload.candidate_utility_missing_count = 9;
  offlinePayload.both_endpoints_unassessable_pair_count = 9;
  offlinePayload.recorded_exploit_harm_observed_loss_count = 2;
  offlinePayload.candidate_exploit_harm_observed_loss_count = 0;
  assert.throws(
    () => LearningExternalEvidenceReportV1Schema.parse(offline.report),
    "candidate missing endpoints cannot be hidden by caller-supplied full-risk totals",
  );
  offline.report.artifact_status = "failed";
  offlinePayload.evidence_status = "failed";
  offline.report.reason_codes = [
    "harm_noninferiority_at_plus_5_points",
    "utility_noninferiority_at_plus_5_points",
  ];
  assert.doesNotThrow(() => LearningExternalEvidenceReportV1Schema.parse(offline.report));

  const disjointMissing = buildFixture("offline_paired_rerun", "passed");
  const disjointPayload = object(disjointMissing.report.payload);
  disjointPayload.harm_pair_count = 87;
  disjointPayload.fully_assessable_pair_count = 87;
  disjointPayload.recorded_harm_missing_count = 9;
  disjointPayload.candidate_harm_missing_count = 9;
  disjointPayload.harm_both_arms_missing_count = 0;
  disjointPayload.candidate_harm_observed_loss_count = 0;
  disjointPayload.candidate_exploit_harm_observed_loss_count = 0;
  assert.throws(
    () => LearningExternalEvidenceReportV1Schema.parse(disjointMissing.report),
    "pair coverage cannot select an overlap that contradicts the missingness contingency",
  );
  disjointPayload.harm_pair_count = 78;
  disjointPayload.fully_assessable_pair_count = 78;
  disjointMissing.report.artifact_status = "inconclusive";
  disjointPayload.evidence_status = "inconclusive";
  disjointMissing.report.reason_codes = ["harm_assessability_at_least_90_percent"];
  assert.doesNotThrow(
    () => LearningExternalEvidenceReportV1Schema.parse(disjointMissing.report),
  );

  const production = buildFixture("production_shadow_gate", "inconclusive");
  const productionPayload = object(production.report.payload);
  productionPayload.hard_boundary_upgrade_count = 1;
  assert.throws(
    () => LearningExternalEvidenceReportV1Schema.parse(production.report),
    "known safety failures take precedence over incomplete coverage",
  );
  production.report.artifact_status = "failed";
  productionPayload.evidence_status = "failed";
  production.report.reason_codes = ["exact_source_coverage", "no_hard_boundary_upgrade"];
  assert.doesNotThrow(() => LearningExternalEvidenceReportV1Schema.parse(production.report));

  const tool = buildFixture("tool_e2e_gate", "inconclusive");
  const toolPayload = object(tool.report.payload);
  object(toolPayload.metrics).report_conflict_count = 1;
  assert.throws(
    () => LearningExternalEvidenceReportV1Schema.parse(tool.report),
    "known tool failures take precedence over incomplete coverage",
  );
  tool.report.artifact_status = "failed";
  toolPayload.evidence_status = "failed";
  tool.report.reason_codes = ["exact_result_coverage", "no_report_conflict"];
  assert.doesNotThrow(() => LearningExternalEvidenceReportV1Schema.parse(tool.report));

  const wrongProfile = buildFixture("tool_e2e_gate", "passed");
  const wrongProfilePayload = object(wrongProfile.report.payload);
  wrongProfilePayload.actual_policy_profile_id = "other-profile";
  assert.throws(
    () => LearningExternalEvidenceReportV1Schema.parse(wrongProfile.report),
    "the selected profile id must match the required profile id",
  );
  wrongProfile.report.artifact_status = "inconclusive";
  wrongProfilePayload.evidence_status = "inconclusive";
  wrongProfile.report.reason_codes = ["required_policy_profile_pass"];
  assert.doesNotThrow(() => LearningExternalEvidenceReportV1Schema.parse(wrongProfile.report));

  const globalPolicy = buildFixture("tool_e2e_gate", "passed");
  const globalPolicyPayload = object(globalPolicy.report.payload);
  globalPolicyPayload.policy_source = "global_env";
  globalPolicyPayload.required_policy_source = "global_env";
  globalPolicyPayload.required_policy_profile_id = null;
  globalPolicyPayload.actual_policy_profile_id = null;
  globalPolicyPayload.policy_profile_matching_count = 0;
  assert.doesNotThrow(() => LearningExternalEvidenceReportV1Schema.parse(globalPolicy.report));
});

test("external evidence contracts reject unknown fields, Runtime-integrity, abnormal, and hold shapes", () => {
  const base = buildFixture("production_shadow_gate", "passed");

  const calibratedBinding = clone(base.binding);
  calibratedBinding.gate_policy_config_sha256 = sha256(
    "tenant-frozen-calibrated-gate-config",
  );
  const calibratedReport = clone(base.report);
  calibratedReport.gate_policy_config_sha256 = calibratedBinding.gate_policy_config_sha256;
  calibratedReport.evidence_binding_sha256 = learningExternalEvidenceBindingDigest(
    calibratedBinding,
  );
  assert.doesNotThrow(
    () => LearningExternalEvidenceReportV1Schema.parse(calibratedReport),
    "a registered base tuple accepts the tenant-frozen calibrated config digest",
  );
  const unknownGateBinding = clone(calibratedBinding);
  unknownGateBinding.gate_policy_id = "unknown-gate-policy";
  const unknownGateReport = clone(calibratedReport);
  unknownGateReport.gate_policy_id = unknownGateBinding.gate_policy_id;
  unknownGateReport.evidence_binding_sha256 = learningExternalEvidenceBindingDigest(
    unknownGateBinding,
  );
  assert.throws(
    () => LearningExternalEvidenceReportV1Schema.parse(unknownGateReport),
    /registered canonical gate-policy tuple/u,
  );

  assert.throws(() => LearningExternalEvidenceBindingV1Schema.parse({
    ...base.binding,
    caller_override: true,
  }));
  assert.throws(() => LearningExternalEvidenceReportV1Schema.parse({
    ...base.report,
    raw_provider_response: "forbidden",
  }));
  const wrongThresholdContract = clone(base.report);
  object(wrongThresholdContract.payload).fixed_threshold_contract_sha256 = sha256(
    "caller-selected-threshold-contract",
  );
  assert.throws(() => LearningExternalEvidenceReportV1Schema.parse(wrongThresholdContract));
  assert.throws(() => LearningExternalLifecycleAuthorityProjectionV1Schema.parse({
    ...base.lifecycleAuthorityProjection,
    preclaim_hold: {
      hold_id: "hold-id",
      hold_reason: "operator_abort",
    },
  }));
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse({
    ...base.runBundle,
    artifact_id: "caller-selected-artifact",
  }));
  assert.throws(() => LearningExternalPreterminalPayloadSetV1Schema.parse({
    ...base.preterminalPayloadSet,
    raw_bundle_sha256: sha256("forbidden-self-addressed-archive"),
  }));

  assert.throws(
    () => LearningExternalEvidenceArtifactKindSchema.parse("runtime_integrity_gate"),
  );
  const runtimeIntegrity = clone(base.report);
  runtimeIntegrity.artifact_kind = "runtime_integrity_gate";
  assert.throws(() => LearningExternalEvidenceReportV1Schema.parse(runtimeIntegrity));

  for (const abnormal of [
    "launch_failure",
    "binding_integrity_failure",
    "runner_crash",
    "lease_expired",
    "operator_revoke",
    "post_quiesce_revoke",
    "finalize_timeout",
    "operator_abort",
  ]) {
    assert.throws(() => LearningExternalEvidenceStatusSchema.parse(abnormal), abnormal);
    const authority = clone(base.lifecycleAuthorityProjection);
    object(authority.session_termination).termination_reason = abnormal;
    assert.throws(
      () => LearningExternalLifecycleAuthorityProjectionV1Schema.parse(authority),
      abnormal,
    );
  }
});

test("contract-set validation rejects status, manifest, attempt, harness, source, and lifecycle mismatches", () => {
  const base = buildFixture("tool_e2e_gate", "passed");
  const cases: Array<readonly [string, (fixture: EvidenceFixture) => void]> = [
    ["status", (fixture) => {
      fixture.runBundle.artifact_status = "failed";
    }],
    ["terminal manifest", (fixture) => {
      object(fixture.lifecycleAuthorityProjection.session_termination)
        .terminal_run_manifest_sha256 = sha256("wrong-terminal-manifest");
    }],
    ["attempt chain", (fixture) => {
      fixture.terminalRunManifest.attempt_chain_sha256 = sha256("wrong-attempt-chain");
    }],
    ["harness", (fixture) => {
      fixture.runnerOutputManifest.harness_bundle_sha256 = sha256("wrong-harness");
    }],
    ["source bundle", (fixture) => {
      fixture.terminalRunManifest.source_bundle_sha256 = sha256("wrong-source-bundle");
    }],
    ["source ref", (fixture) => {
      fixture.runBundle.source_ref = "evals/other-source";
    }],
    ["source commit", (fixture) => {
      fixture.runBundle.source_commit_id = sha256("other-source-commit").slice(0, 40);
    }],
    ["report digest", (fixture) => {
      fixture.runnerOutputManifest.report_sha256 = sha256("wrong-report");
    }],
    ["lifecycle id", (fixture) => {
      fixture.runBundle.claim_id = "other-claim-id";
    }],
    ["lifecycle digest", (fixture) => {
      fixture.runBundle.session_termination_sha256 = sha256("wrong-termination");
    }],
    ["evidence binding", (fixture) => {
      fixture.attemptChain.evidence_binding_sha256 = sha256("wrong-binding");
    }],
    ["lifecycle projection digest", (fixture) => {
      fixture.runBundle.lifecycle_authority_projection_sha256 = sha256("wrong-authority");
    }],
    ["member digest", (fixture) => {
      const reportMember = objects(fixture.runBundle.members).find(
        (member) => member.role === "report",
      );
      assert.ok(reportMember);
      reportMember.sha256 = sha256("wrong-report-member");
    }],
    ["member byte length", (fixture) => {
      const reportMember = objects(fixture.runBundle.members).find(
        (member) => member.role === "report",
      );
      assert.ok(reportMember);
      reportMember.byte_length = Number(reportMember.byte_length) + 1;
    }],
    ["preterminal payload set", (fixture) => {
      fixture.runnerOutputManifest.preterminal_payload_set_sha256 = sha256("wrong-preterminal");
    }],
    ["database lineage", (fixture) => {
      fixture.lifecycleAuthorityProjection.database_instance_id = sha256("other-database");
    }],
    ["lifecycle time order", (fixture) => {
      fixture.runBundle.committed_at = "2026-07-17T00:00:07.500Z";
    }],
  ];
  for (const [name, mutate] of cases) mutateAndReject(base, name, mutate);
});

test("canonical collections reject duplicates, bad order, unsafe paths, and broken authority links", () => {
  const base = buildFixture("production_shadow_gate", "failed");

  const twoReasons = clone(base.report);
  const twoReasonPayload = object(twoReasons.payload);
  twoReasonPayload.candidate_calibration_score_micros = 500_000;
  twoReasons.reason_codes = [
    "candidate_policy_calibration_improved",
    "no_hard_boundary_upgrade",
  ];
  assert.doesNotThrow(() => LearningExternalEvidenceReportV1Schema.parse(twoReasons));

  const reversedReasons = clone(twoReasons);
  reversedReasons.reason_codes = [...(reversedReasons.reason_codes as string[])].reverse();
  assert.throws(() => LearningExternalEvidenceReportV1Schema.parse(reversedReasons));

  const duplicateReasons = clone(twoReasons);
  duplicateReasons.reason_codes = [
    "candidate_policy_calibration_improved",
    "candidate_policy_calibration_improved",
    "no_hard_boundary_upgrade",
  ];
  assert.throws(() => LearningExternalEvidenceReportV1Schema.parse(duplicateReasons));

  const duplicateCall = clone(base.attemptChain);
  const duplicateAttempts = objects(duplicateCall.attempts);
  duplicateAttempts[1]!.call_id = duplicateAttempts[0]!.call_id;
  assert.throws(() => LearningExternalAttemptChainV1Schema.parse(duplicateCall));

  const wrongOrdinal = clone(base.attemptChain);
  objects(wrongOrdinal.attempts)[1]!.attempt_ordinal = 3;
  assert.throws(() => LearningExternalAttemptChainV1Schema.parse(wrongOrdinal));

  const outOfOrder = clone(base.attemptChain);
  objects(outOfOrder.attempts)[1]!.started_at = "2026-07-17T00:00:00.000Z";
  objects(outOfOrder.attempts)[1]!.finished_at = "2026-07-17T00:00:00.500Z";
  assert.throws(() => LearningExternalAttemptChainV1Schema.parse(outOfOrder));

  const parallelOverlap = clone(base.attemptChain);
  objects(parallelOverlap.attempts)[1]!.started_at = "2026-07-17T00:00:01.500Z";
  assert.doesNotThrow(() => LearningExternalAttemptChainV1Schema.parse(parallelOverlap));

  const authorityWrongDigest = clone(base.lifecycleAuthorityProjection);
  object(object(authorityWrongDigest.claim).protected_operation).authority_record_sha256 = sha256(
    "wrong-claim-record",
  );
  assert.throws(
    () => LearningExternalLifecycleAuthorityProjectionV1Schema.parse(authorityWrongDigest),
  );

  const reversed = clone(base.runBundle);
  reversed.members = [...objects(reversed.members)].reverse();
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse(reversed));

  const duplicatePath = clone(base.runBundle);
  const duplicateMembers = objects(duplicatePath.members);
  duplicateMembers[1]!.path = duplicateMembers[0]!.path;
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse(duplicatePath));

  const duplicateRole = clone(base.runBundle);
  objects(duplicateRole.members)[0]!.role = "report";
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse(duplicateRole));

  for (const unsafePath of [
    "/absolute.json",
    "../escape.json",
    "nested/../escape.json",
    "nested\\windows.json",
    "nested//empty.json",
    "./relative.json",
    " trailing.json ",
    "nested/\u0000control.json",
    "nested/é.json",
  ]) {
    const unsafe = clone(base.runBundle);
    objects(unsafe.members)[0]!.path = unsafePath;
    assert.throws(
      () => LearningExternalEvidenceRunBundleV1Schema.parse(unsafe),
      JSON.stringify(unsafePath),
    );
  }
});

test("bundle and report contracts enforce member, aggregate, count, and 512 KiB bounds", () => {
  const base = buildFixture("production_shadow_gate", "failed");
  const overMember = clone(base.runBundle);
  objects(overMember.members)[0]!.byte_length = (512 * 1024 * 1024) + 1;
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse(overMember));

  const overTotal = clone(base.runBundle);
  for (const member of objects(overTotal.members)) member.byte_length = 512 * 1024 * 1024;
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse(overTotal));

  const overCount = clone(base.runBundle);
  const members = objects(overCount.members);
  for (let index = 0; index < 4_090; index += 1) {
    members.push({
      path: `support/${String(index).padStart(4, "0")}.json`,
      role: "supporting_evidence",
      byte_length: 0,
      sha256: sha256(`support:${String(index)}`),
    });
  }
  members.sort((left, right) => Buffer.compare(
    Buffer.from(String(left.path)),
    Buffer.from(String(right.path)),
  ));
  assert.equal(members.length, 4_097);
  assert.throws(() => LearningExternalEvidenceRunBundleV1Schema.parse(overCount));

  const oversizedReportBytes = Buffer.alloc((512 * 1024) + 1, 0x20);
  assert.throws(
    () => parseCanonicalLearningExternalEvidenceReportJson(oversizedReportBytes),
    /byte limit/u,
  );
});

test("raw report parsing requires canonical, duplicate-free, valid UTF-8 JSON", () => {
  const fixture = buildFixture("offline_paired_rerun", "passed");
  const canonical = Buffer.from(learningExternalEvidenceReportJson(fixture.report), "utf8");
  assert.deepEqual(
    parseCanonicalLearningExternalEvidenceReportJson(canonical),
    LearningExternalEvidenceReportV1Schema.parse(fixture.report),
  );

  assert.throws(() => parseCanonicalLearningExternalEvidenceReportJson(
    Buffer.from(JSON.stringify(fixture.report, null, 2), "utf8"),
  ), /canonical JSON/u);
  assert.throws(() => parseCanonicalLearningExternalEvidenceReportJson(
    Buffer.from('{"a":1,"a":1}', "utf8"),
  ), /canonical JSON/u);
  assert.throws(() => parseCanonicalLearningExternalEvidenceReportJson(
    Uint8Array.from([0xff]),
  ), /valid UTF-8/u);
  assert.throws(() => parseCanonicalLearningExternalEvidenceReportJson(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
  ), /byte-order mark/u);
});

test("canonical digests are deterministic, key-order independent, and tamper-sensitive", () => {
  const thresholdDigest = learningExternalEvidenceThresholdContractDigest();
  assert.match(thresholdDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    thresholdDigest,
    sha256(stableStringify(LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1)),
  );
  assert.ok(Object.isFrozen(LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1));
  assert.ok(Object.isFrozen(
    LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1.tool_e2e_gate.maximum_context_ratio,
  ));
  const changedThresholdContract = clone(LEARNING_EXTERNAL_EVIDENCE_THRESHOLD_CONTRACT_V1);
  object(changedThresholdContract.tool_e2e_gate).requested_count = 41;
  assert.notEqual(sha256(stableStringify(changedThresholdContract)), thresholdDigest);

  const fixture = buildFixture("production_shadow_gate", "passed");
  const validated = validateFixture(fixture);
  const reversedReport = Object.fromEntries(Object.entries(fixture.report).reverse());
  assert.equal(
    learningExternalEvidenceReportJson(reversedReport),
    learningExternalEvidenceReportJson(fixture.report),
  );
  assert.equal(
    learningExternalEvidenceReportDigest(reversedReport),
    learningExternalEvidenceReportDigest(fixture.report),
  );
  assert.equal(
    learningExternalEvidenceReportDigest(fixture.report),
    sha256(learningExternalEvidenceReportJson(fixture.report)),
  );

  const changedReport = clone(fixture.report);
  changedReport.collected_at = "2026-07-17T00:00:06.001Z";
  assert.notEqual(
    learningExternalEvidenceReportDigest(changedReport),
    validated.digests.report_sha256,
  );

  const changedAuthority = clone(fixture.lifecycleAuthorityProjection);
  changedAuthority.service_launcher_receipt_sha256 = sha256("changed-launcher-receipt");
  assert.notEqual(
    learningExternalEvidenceLifecycleAuthorityProjectionDigest(changedAuthority),
    validated.digests.lifecycle_authority_projection_sha256,
  );

  const changedPreterminal = clone(fixture.preterminalPayloadSet);
  changedPreterminal.source_bundle_sha256 = sha256("changed-source-bundle");
  assert.notEqual(
    learningExternalPreterminalPayloadSetDigest(changedPreterminal),
    learningExternalPreterminalPayloadSetDigest(fixture.preterminalPayloadSet),
  );

  const changedBundle = clone(fixture.runBundle);
  changedBundle.committed_at = "2026-07-17T00:00:09.001Z";
  assert.notEqual(
    learningExternalEvidenceRunBundleDigest(changedBundle),
    validated.digests.run_bundle_sha256,
  );

  const identity = artifactIdentity(validated);
  const changedIdentity = clone(identity);
  changedIdentity.report_sha256 = sha256("changed-report-identity");
  assert.match(learningExternalEvidenceArtifactId(identity), /^lea_[0-9a-f]{64}$/u);
  assert.notEqual(
    learningExternalEvidenceArtifactId(changedIdentity),
    learningExternalEvidenceArtifactId(identity),
  );

  const request = {
    contract_version: "aionis_learning_external_evidence_ingest_request_v1",
    tenant_id: validated.report.tenant_id,
    actor_id: "evidence-ingester",
    operation_id: "ingest-operation",
    artifact_kind: validated.report.artifact_kind,
    evidence_series_id: validated.report.evidence_series_id,
    task_family: validated.report.task_family,
    applicable_experiment_id: validated.report.applicable_experiment_id,
    applicable_experiment_revision: validated.report.applicable_experiment_revision,
    lifecycle_authority_projection_sha256:
      validated.digests.lifecycle_authority_projection_sha256,
    public_run_authority_sha256: fixture.publicRunAuthoritySha256,
    run_bundle_manifest_sha256: validated.digests.run_bundle_sha256,
    run_bundle_archive_sha256: sha256("outer-run-bundle-archive"),
    bundle_commit_id: sha256("bundle-commit").slice(0, 40),
  };
  assert.equal(
    learningExternalEvidenceIngestRequestDigest(request),
    learningExternalEvidenceIngestRequestDigest(clone(request)),
  );
  assert.notEqual(
    learningExternalEvidenceIngestRequestDigest({
      ...request,
      operation_id: "different-ingest-operation",
    }),
    learningExternalEvidenceIngestRequestDigest(request),
  );
});

test("digest dependencies form a one-way acyclic chain with archive identity outside manifests", () => {
  const base = buildFixture("tool_e2e_gate", "inconclusive");
  const before = validateFixture(base);
  assert.equal(Object.hasOwn(base.binding, "evidence_binding_sha256"), false);
  assert.equal(Object.hasOwn(base.report, "report_sha256"), false);
  assert.equal(Object.hasOwn(base.attemptChain, "attempt_chain_sha256"), false);
  assert.equal(Object.hasOwn(base.preterminalPayloadSet, "preterminal_payload_set_sha256"), false);
  assert.equal(Object.hasOwn(base.runnerOutputManifest, "runner_output_manifest_sha256"), false);
  assert.equal(Object.hasOwn(base.terminalRunManifest, "terminal_run_manifest_sha256"), false);
  assert.equal(
    Object.hasOwn(base.lifecycleAuthorityProjection, "lifecycle_authority_projection_sha256"),
    false,
  );
  assert.equal(Object.hasOwn(base.runBundle, "run_bundle_manifest_sha256"), false);
  assert.equal(Object.hasOwn(base.runBundle, "run_bundle_archive_sha256"), false);
  assert.equal(Object.hasOwn(base.runBundle, "bundle_commit_id"), false);
  assert.equal(Object.hasOwn(base.runBundle, "raw_bundle_sha256"), false);

  const rebuilt = clone(base);
  rebuilt.terminalRunManifest.finalized_at = "2026-07-17T00:00:07.001Z";
  const terminalRunManifestSha256 = learningExternalTerminalRunManifestDigest(
    rebuilt.terminalRunManifest,
  );
  const termination = object(rebuilt.lifecycleAuthorityProjection.session_termination);
  termination.terminal_run_manifest_sha256 = terminalRunManifestSha256;
  termination.broker_terminal_receipt_sha256 = sha256("rebuilt-terminal-receipt");
  const terminationFactSha256 = sha256("rebuilt-termination-fact");
  termination.fact_sha256 = terminationFactSha256;
  object(termination.protected_operation).authority_record_sha256 = terminationFactSha256;
  const lifecycleAuthorityProjectionSha256 =
    learningExternalEvidenceLifecycleAuthorityProjectionDigest(
      rebuilt.lifecycleAuthorityProjection,
    );

  rebuilt.runBundle.terminal_run_manifest_sha256 = terminalRunManifestSha256;
  rebuilt.runBundle.session_termination_sha256 = terminationFactSha256;
  rebuilt.runBundle.lifecycle_authority_projection_sha256 =
    lifecycleAuthorityProjectionSha256;
  const terminalMember = objects(rebuilt.runBundle.members).find(
    (member) => member.role === "terminal_run_manifest",
  );
  const authorityMember = objects(rebuilt.runBundle.members).find(
    (member) => member.role === "lifecycle_authority_projection",
  );
  assert.ok(terminalMember);
  assert.ok(authorityMember);
  terminalMember.sha256 = terminalRunManifestSha256;
  terminalMember.byte_length = canonicalByteLength(rebuilt.terminalRunManifest);
  authorityMember.sha256 = lifecycleAuthorityProjectionSha256;
  authorityMember.byte_length = canonicalByteLength(rebuilt.lifecycleAuthorityProjection);

  const after = validateFixture(rebuilt);
  assert.notEqual(
    after.digests.terminal_run_manifest_sha256,
    before.digests.terminal_run_manifest_sha256,
  );
  assert.notEqual(
    after.digests.lifecycle_authority_projection_sha256,
    before.digests.lifecycle_authority_projection_sha256,
  );
  assert.notEqual(after.digests.run_bundle_sha256, before.digests.run_bundle_sha256);
  assert.equal(
    after.runBundle.preterminal_payload_set_sha256,
    before.runBundle.preterminal_payload_set_sha256,
  );
  assert.equal(
    after.digests.runner_output_manifest_sha256,
    before.digests.runner_output_manifest_sha256,
  );
  assert.notEqual(
    learningExternalEvidenceArtifactId(artifactIdentity(after)),
    learningExternalEvidenceArtifactId(artifactIdentity(before)),
  );
});
