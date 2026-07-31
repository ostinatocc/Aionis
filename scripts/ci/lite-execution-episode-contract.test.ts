import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ActionMutationReceiptV1Schema,
  DecisionEpisodeV1Schema,
  EPISODE_REWARD_OUTCOME_CLASS_MAPPING,
  EpisodeRewardV1Schema,
  EvidenceArtifactInputV1Schema,
  EvidenceArtifactRefV1Schema,
  ExecutionEpisodeEventEnvelopeV1Schema,
  ExecutionEpisodeEventPayloadV1Schema,
  StateSnapshotV1Schema,
  VerifierInvocationV1Schema,
  VerifierOutcomeReceiptV1Schema,
  actionMutationReceiptDigest,
  buildExecutionEpisodeEventEnvelopeV1,
  decisionCommittedReceiptDigest,
  decisionEpisodeDigest,
  evidenceArtifactRefDigest,
  executionEpisodeEventPayloadDigest,
  executionEpisodeSubjectIdentityDigest,
  executionEpisodeSubjectStateSpecDigest,
  isEpisodeRewardSelectorEligible,
  stateSnapshotDigest,
  verifierInvocationDigest,
  verifierOutcomeAttestationPayloadDigest,
  verifierOutcomeEvidenceDigest,
  type EvidenceArtifactKindV1,
  type EvidenceArtifactRefV1,
  type StateSnapshotV1,
  type VerifierInvocationV1,
} from "../../src/memory/execution-episode.js";

const NOW = "2026-07-27T08:00:00.000Z";
const LATER = "2026-07-27T08:01:00.000Z";
const D = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
};

function digestBytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactRef(
  kind: EvidenceArtifactKindV1,
  content: string,
  id = `artifact-${kind}`,
): EvidenceArtifactRefV1 {
  return EvidenceArtifactRefV1Schema.parse({
    contract_version: "evidence_artifact_ref_v1",
    artifact_id: id,
    kind,
    sha256: digestBytes(content),
    storage_ref: `sqlite-cas:sha256:${digestBytes(content)}`,
    byte_length: Buffer.byteLength(content, "utf8"),
    media_type: "application/json",
    encoding: "utf-8",
    redaction_policy: "episode-default-redaction-v1",
    retention_policy: "episode-replay-v1",
  });
}

function snapshot(
  id: string,
  content: string,
  capturedAt = NOW,
): StateSnapshotV1 {
  return StateSnapshotV1Schema.parse({
    contract_version: "state_snapshot_v1",
    snapshot_id: id,
    algorithm_id: "workspace-tree-sha256",
    algorithm_version: "1.0.0",
    state_kind: "workspace",
    environment_digest: D.a,
    content_digest: digestBytes(content),
    artifact_ref: artifactRef("state_snapshot", content, `artifact-${id}`),
    captured_at: capturedAt,
  });
}

function episode(initialState: StateSnapshotV1) {
  const taskEnvelopeRef = artifactRef(
    "manifest",
    "{\"task_id\":\"task-42\",\"objective\":\"repository change\"}",
    "artifact-task-envelope-42",
  );
  const taskManifestRef = artifactRef(
    "manifest",
    "{\"contract_version\":\"execution_episode_task_manifest_v1\"}",
    "artifact-task-manifest-42",
  );
  const sourceTaskRef = artifactRef(
    "prompt",
    "Implement the repository change and satisfy the real verifier.",
    "artifact-source-task-42",
  );
  const modelConfigRef = artifactRef(
    "manifest",
    "{\"temperature\":0,\"top_p\":1}",
    "artifact-model-config-42",
  );
  const subjectStateSpec = {
    contract_version: "workspace_subject_state_spec_v2" as const,
    additional_state_roots: [],
  };
  const subjectIdentityMaterial = {
    contract_version: "execution_episode_subject_identity_v1" as const,
    state_kind: "workspace" as const,
    canonical_root_sha256: D.c,
    capture_algorithm_id: "aionis_workspace_state_capture",
    capture_algorithm_version: "2",
    subject_state_spec: subjectStateSpec,
    subject_state_spec_sha256:
      executionEpisodeSubjectStateSpecDigest(subjectStateSpec),
  };
  return DecisionEpisodeV1Schema.parse({
    contract_version: "decision_episode_v1",
    episode_id: "episode-42",
    tenant_id: "tenant-blue",
    public_scope: "public:project-blue",
    store_scope: "tenant:tenant-blue:project:blue",
    task_id: "task-42",
    task_envelope_digest: taskEnvelopeRef.sha256,
    task_envelope_ref: taskEnvelopeRef,
    task_manifest_digest: taskManifestRef.sha256,
    task_manifest_ref: taskManifestRef,
    source_task_ref: sourceTaskRef,
    task_cluster_id: "cluster-repository-change-7",
    task_cluster_policy_version: "task-cluster-policy-v1",
    run_id: "run-42",
    model_id: "deepseek-v4-flash",
    model_config_digest: modelConfigRef.sha256,
    model_config_ref: modelConfigRef,
    environment_digest: initialState.environment_digest,
    subject_identity: {
      ...subjectIdentityMaterial,
      identity_sha256:
        executionEpisodeSubjectIdentityDigest(subjectIdentityMaterial),
    },
    required_verifier: {
      contract_version: "execution_episode_required_verifier_v1",
      verifier_id: "real-verifier",
      verifier_definition_sha256: D.f,
    },
    initial_state_snapshot_id: initialState.snapshot_id,
    budget: {
      max_steps: 30,
      max_tokens: 500_000,
      max_cost_micros: 5_000_000,
      deadline_ms: 7_200_000,
    },
    opened_at: NOW,
  });
}

function verifierInvocation(
  state: StateSnapshotV1,
): VerifierInvocationV1 {
  return VerifierInvocationV1Schema.parse({
    contract_version: "verifier_invocation_v1",
    verifier_invocation_id: "verifier-invocation-42",
    episode_id: "episode-42",
    verifier_id: "real-verifier",
    verifier_definition_sha256: D.f,
    verifier_kind: "independent_executable",
    verifier_version: "1.0.0",
    verifier_issuer_id: "aionis-runtime",
    verifier_runner_instance_id: "runner-instance-42",
    launch_authority: {
      kind: "runtime_launched",
      runtime_reservation_digest: D.c,
    },
    verifier_program_digest: D.d,
    verifier_config_digest: D.e,
    verifier_environment_digest: state.environment_digest,
    target_state_snapshot_id: state.snapshot_id,
    target_state_snapshot_algorithm_version: state.algorithm_version,
    verifier_input_ref: artifactRef(
      "verifier_input",
      "{\"command\":\"npm test\"}",
      "artifact-verifier-input",
    ),
    invoked_at: LATER,
  });
}

function verifierOutcome(invocation: VerifierInvocationV1) {
  const outputRef = artifactRef(
    "verifier_output",
    "{\"exit_code\":0,\"passed\":true}",
    "artifact-verifier-output",
  );
  const material = {
    contract_version: "verifier_outcome_receipt_v1" as const,
    verifier_receipt_id: "verifier-receipt-42",
    episode_id: invocation.episode_id,
    verifier_id: invocation.verifier_id,
    verifier_definition_sha256: invocation.verifier_definition_sha256,
    verifier_kind: invocation.verifier_kind,
    verifier_version: invocation.verifier_version,
    verifier_issuer_id: invocation.verifier_issuer_id,
    verifier_runner_instance_id: invocation.verifier_runner_instance_id,
    verifier_invocation_id: invocation.verifier_invocation_id,
    verifier_invocation_digest: verifierInvocationDigest(invocation),
    verifier_program_digest: invocation.verifier_program_digest,
    verifier_config_digest: invocation.verifier_config_digest,
    verifier_environment_digest: invocation.verifier_environment_digest,
    verified_state_snapshot_id: invocation.target_state_snapshot_id,
    verified_state_snapshot_algorithm_version:
      invocation.target_state_snapshot_algorithm_version,
    verifier_input_ref: invocation.verifier_input_ref,
    verifier_output_ref: outputRef,
    execution_exit_code: 0,
    status: "passed" as const,
    infrastructure_failure_reasons: [],
    infrastructure_failure_attribution: null,
    completed_at: "2026-07-27T08:02:00.000Z",
  };
  const evidenceDigest = verifierOutcomeEvidenceDigest(material);
  return VerifierOutcomeReceiptV1Schema.parse({
    ...material,
    evidence_digest: evidenceDigest,
    attestation: {
      kind: "runtime_launched",
      runtime_launch_sha256: D.c,
    },
  });
}

test("artifact inputs verify canonical bytes, length, digest, and strict shape", () => {
  const bytes = Buffer.from([0, 255, 17, 42, 128]);
  const valid = {
    contract_version: "evidence_artifact_input_v1",
    kind: "tool_result",
    declared_sha256: digestBytes(bytes),
    declared_byte_length: bytes.byteLength,
    media_type: "application/octet-stream",
    encoding: "identity",
    ingest: {
      mode: "bounded_inline_base64",
      data: bytes.toString("base64"),
    },
  };
  assert.equal(EvidenceArtifactInputV1Schema.parse(valid).declared_sha256, digestBytes(bytes));

  assert.equal(EvidenceArtifactInputV1Schema.safeParse({
    ...valid,
    declared_sha256: D.a,
  }).success, false);
  assert.equal(EvidenceArtifactInputV1Schema.safeParse({
    ...valid,
    declared_byte_length: bytes.byteLength + 1,
  }).success, false);
  assert.equal(EvidenceArtifactInputV1Schema.safeParse({
    ...valid,
    unexpected_host_storage_ref: "/tmp/host-selected-path",
  }).success, false);

  assert.equal(EvidenceArtifactInputV1Schema.safeParse({
    ...valid,
    declared_sha256: D.b,
    declared_byte_length: 10_000,
    ingest: {
      mode: "finalized_runtime_upload",
      upload_id: "runtime-upload-42",
      finalize_receipt_digest: D.c,
    },
  }).success, true);
});

test("state and episode contracts are strict and canonically digestible", () => {
  const initial = snapshot("snapshot-initial", "tree-initial");
  const value = episode(initial);

  assert.equal(decisionEpisodeDigest(value), decisionEpisodeDigest({ ...value }));
  assert.equal(stateSnapshotDigest(initial), stateSnapshotDigest({ ...initial }));
  assert.match(evidenceArtifactRefDigest(initial.artifact_ref), /^[0-9a-f]{64}$/u);

  assert.equal(StateSnapshotV1Schema.safeParse({
    ...initial,
    artifact_ref: artifactRef("workspace_diff", "tree-initial"),
  }).success, false);
  assert.equal(StateSnapshotV1Schema.safeParse({
    ...initial,
    content_digest: D.f,
  }).success, false);
  assert.equal(DecisionEpisodeV1Schema.safeParse({
    ...value,
    unknown_host_claim: true,
  }).success, false);
  assert.equal(DecisionEpisodeV1Schema.safeParse({
    ...value,
    task_envelope_digest: D.f,
  }).success, false);
  assert.equal(DecisionEpisodeV1Schema.safeParse({
    ...value,
    task_envelope_ref: artifactRef(
      "prompt",
      "{\"task_id\":\"task-42\"}",
      "artifact-not-task-envelope",
    ),
  }).success, false);
  assert.equal(DecisionEpisodeV1Schema.safeParse({
    ...value,
    closed_at: "2026-07-27T07:59:59.999Z",
  }).success, false);
});

test("action receipts bind request/result artifacts and distinct mutation states", () => {
  const before = snapshot("snapshot-before", "tree-before");
  const after = snapshot("snapshot-after", "tree-after", LATER);
  const request = artifactRef("tool_request", "{\"patch\":\"change\"}", "request-42");
  const result = artifactRef("tool_result", "{\"applied\":true}", "result-42");
  const valid = {
    contract_version: "action_mutation_receipt_v1",
    action_id: "action-42",
    episode_id: "episode-42",
    sequence: 0,
    action_kind: "edit",
    tool_name: "apply_patch",
    request_digest: request.sha256,
    request_ref: request,
    result_digest: result.sha256,
    result_ref: result,
    state_before_snapshot_id: before.snapshot_id,
    state_after_snapshot_id: after.snapshot_id,
    mutation: true,
    occurred_at: LATER,
  };

  const parsed = ActionMutationReceiptV1Schema.parse(valid);
  assert.equal(parsed.mutation, true);
  assert.notEqual(
    actionMutationReceiptDigest(parsed),
    actionMutationReceiptDigest({
      ...parsed,
      action_id: "action-relabeled",
    }),
  );
  const {
    action_id: _actionId,
    ...withoutActionId
  } = valid;
  assert.equal(ActionMutationReceiptV1Schema.safeParse(withoutActionId).success, false);
  assert.equal(ActionMutationReceiptV1Schema.safeParse({
    ...valid,
    request_digest: D.f,
  }).success, false);
  assert.equal(ActionMutationReceiptV1Schema.safeParse({
    ...valid,
    state_after_snapshot_id: before.snapshot_id,
  }).success, false);
  assert.equal(ActionMutationReceiptV1Schema.safeParse({
    ...valid,
    mutation: false,
  }).success, false);
  assert.equal(ActionMutationReceiptV1Schema.safeParse({
    ...valid,
    mutation: false,
    state_after_snapshot_id: before.snapshot_id,
  }).success, true);
});

test("verifier receipt binds canonical invocation, exact state, evidence, and attestation", () => {
  const finalState = snapshot("snapshot-final", "tree-final", LATER);
  const invocation = verifierInvocation(finalState);
  const outcome = verifierOutcome(invocation);

  assert.equal(outcome.status, "passed");
  assert.equal(outcome.verifier_invocation_digest, verifierInvocationDigest(invocation));
  assert.equal(ExecutionEpisodeEventPayloadV1Schema.safeParse({
    event_kind: "verifier_recorded",
    invocation,
    outcome,
    verified_state_snapshot: finalState,
  }).success, true);

  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...outcome,
    status: "failed",
  }).success, false);
  const {
    attestation: outcomeAttestation,
    evidence_digest: _outcomeEvidenceDigest,
    ...outcomeMaterial
  } = outcome;
  const infrastructureMaterial = {
    ...outcomeMaterial,
    execution_exit_code: null,
    status: "infrastructure_error" as const,
    infrastructure_failure_reasons: ["real verifier process unavailable"],
    infrastructure_failure_attribution: "arm_independent" as const,
  };
  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...infrastructureMaterial,
    evidence_digest: verifierOutcomeEvidenceDigest(infrastructureMaterial),
    attestation: outcomeAttestation,
  }).success, true);
  const invalidPassedMaterial = {
    ...outcomeMaterial,
    execution_exit_code: null,
    status: "passed" as const,
  };
  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...invalidPassedMaterial,
    evidence_digest: verifierOutcomeEvidenceDigest(invalidPassedMaterial),
    attestation: outcomeAttestation,
  }).success, false);
  const nonzeroPassedMaterial = {
    ...outcomeMaterial,
    execution_exit_code: 1,
    status: "passed" as const,
  };
  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...nonzeroPassedMaterial,
    evidence_digest: verifierOutcomeEvidenceDigest(nonzeroPassedMaterial),
    attestation: outcomeAttestation,
  }).success, false);
  const semanticFailureMaterial = {
    ...outcomeMaterial,
    execution_exit_code: 0,
    status: "failed" as const,
  };
  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...semanticFailureMaterial,
    evidence_digest: verifierOutcomeEvidenceDigest(semanticFailureMaterial),
    attestation: outcomeAttestation,
  }).success, true);
  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...outcome,
    verifier_output_ref: artifactRef(
      "tool_result",
      "{\"exit_code\":0}",
      "not-verifier-output",
    ),
  }).success, false);
  assert.equal(ExecutionEpisodeEventPayloadV1Schema.safeParse({
    event_kind: "verifier_recorded",
    invocation: {
      ...invocation,
      verifier_config_digest: D.f,
    },
    outcome,
    verified_state_snapshot: finalState,
  }).success, false);
  assert.equal(ExecutionEpisodeEventPayloadV1Schema.safeParse({
    event_kind: "verifier_recorded",
    invocation: {
      ...invocation,
      verifier_program_digest: D.f,
    },
    outcome,
    verified_state_snapshot: finalState,
  }).success, false);

  const signedInvocation = VerifierInvocationV1Schema.parse({
    ...invocation,
    launch_authority: {
      kind: "trusted_runner",
      principal_id: "configured-verifier-principal",
      key_id: "verifier-key-1",
    },
  });
  const baseOutcome = verifierOutcome(signedInvocation);
  const {
    attestation: _oldAttestation,
    ...signedMaterial
  } = baseOutcome;
  const signedPayloadDigest = verifierOutcomeAttestationPayloadDigest(signedMaterial);
  const signedOutcome = VerifierOutcomeReceiptV1Schema.parse({
    ...signedMaterial,
    attestation: {
      kind: "trusted_runner_signature",
      principal_id: "configured-verifier-principal",
      key_id: "verifier-key-1",
      signed_payload_digest: signedPayloadDigest,
      signature: "transported-signature-bytes",
    },
  });
  assert.equal(
    signedOutcome.attestation.kind,
    "trusted_runner_signature",
  );
  assert.equal(VerifierOutcomeReceiptV1Schema.safeParse({
    ...signedOutcome,
    attestation: {
      ...signedOutcome.attestation,
      signed_payload_digest: D.a,
    },
  }).success, false);
});

test("reward outcome classes enforce ITT, missingness, and selector eligibility", () => {
  const verifiedPass = EpisodeRewardV1Schema.parse({
    reward_id: "reward-pass",
    episode_id: "episode-42",
    reward_contract_version: "episode_reward_v1",
    verified_success: 1,
    outcome_class: "verified_pass",
    reward_authority: "independent_executable",
    final_state_snapshot_id: "snapshot-final",
    verifier_receipt_id: "verifier-receipt-42",
    token_count: null,
    token_usage_authority: "unavailable",
    tool_call_count: 12,
    elapsed_ms: 60_000,
    outcome_reasons: [],
    contamination_reasons: [],
  });
  const armCausedIncomplete = EpisodeRewardV1Schema.parse({
    reward_id: "reward-timeout",
    episode_id: "episode-43",
    reward_contract_version: "episode_reward_v1",
    verified_success: 0,
    outcome_class: "arm_caused_incomplete",
    reward_authority: "protocol_itt_failure",
    token_count: null,
    token_usage_authority: "unavailable",
    tool_call_count: 20,
    elapsed_ms: 120_000,
    outcome_reasons: ["episode_timeout_after_arm_start"],
    contamination_reasons: [],
  });
  const independentInfrastructure = EpisodeRewardV1Schema.parse({
    reward_id: "reward-provider-outage",
    episode_id: "episode-44",
    reward_contract_version: "episode_reward_v1",
    verified_success: null,
    outcome_class: "arm_independent_infrastructure",
    reward_authority: "missing",
    token_count: null,
    token_usage_authority: "unavailable",
    tool_call_count: 0,
    elapsed_ms: 1_000,
    outcome_reasons: ["predeclared_arm_blind_provider_outage"],
    contamination_reasons: [],
  });

  assert.equal(isEpisodeRewardSelectorEligible(verifiedPass), true);
  assert.equal(isEpisodeRewardSelectorEligible(armCausedIncomplete), true);
  assert.equal(isEpisodeRewardSelectorEligible(independentInfrastructure), false);
  assert.equal(isEpisodeRewardSelectorEligible(EpisodeRewardV1Schema.parse({
    ...verifiedPass,
    contamination_reasons: ["post_verifier_integrity_warning"],
  })), false);
  assert.equal(
    EPISODE_REWARD_OUTCOME_CLASS_MAPPING.arm_caused_incomplete.reward_authorities[0],
    "protocol_itt_failure",
  );

  assert.equal(EpisodeRewardV1Schema.safeParse({
    ...armCausedIncomplete,
    verified_success: null,
  }).success, false);
  assert.equal(EpisodeRewardV1Schema.safeParse({
    ...armCausedIncomplete,
    reward_authority: "missing",
  }).success, false);
  assert.equal(EpisodeRewardV1Schema.safeParse({
    ...independentInfrastructure,
    outcome_reasons: [],
  }).success, false);
  assert.equal(EpisodeRewardV1Schema.safeParse({
    ...verifiedPass,
    final_state_snapshot_id: undefined,
  }).success, false);
  assert.equal(EpisodeRewardV1Schema.safeParse({
    ...verifiedPass,
    token_count: 0,
  }).success, false);
  assert.equal(EpisodeRewardV1Schema.safeParse({
    ...verifiedPass,
    token_usage_authority: "provider_receipt",
  }).success, false);
});

test("event payloads are discriminated and envelopes detect chain or payload tampering", () => {
  const initial = snapshot("snapshot-initial", "tree-initial");
  const startedPayload = ExecutionEpisodeEventPayloadV1Schema.parse({
    event_kind: "episode_started",
    episode: episode(initial),
    initial_state_snapshot: initial,
  });
  const first = buildExecutionEpisodeEventEnvelopeV1({
    event_id: "episode-event-0",
    episode_id: "episode-42",
    operation_kind: "execution_episode_start_v1",
    operation_id: "operation-start-42",
    request_sha256: D.a,
    sequence: 0,
    previous_event_sha256: null,
    payload: startedPayload,
    occurred_at: NOW,
  });

  assert.equal(first.payload_sha256, executionEpisodeEventPayloadDigest(startedPayload));
  assert.equal(
    buildExecutionEpisodeEventEnvelopeV1({
      event_id: "episode-event-0",
      episode_id: "episode-42",
      operation_kind: "execution_episode_start_v1",
      operation_id: "operation-start-42",
      request_sha256: D.a,
      sequence: 0,
      previous_event_sha256: null,
      payload: startedPayload,
      occurred_at: NOW,
    }).event_sha256,
    first.event_sha256,
  );

  const before = initial;
  const after = snapshot("snapshot-after", "tree-after", LATER);
  const request = artifactRef("tool_request", "request", "request-event");
  const result = artifactRef("tool_result", "result", "result-event");
  const actionPayload = ExecutionEpisodeEventPayloadV1Schema.parse({
    event_kind: "action_observed",
    action: {
      contract_version: "action_mutation_receipt_v1",
      action_id: "action-event-42",
      episode_id: "episode-42",
      sequence: 0,
      action_kind: "edit",
      tool_name: "apply_patch",
      request_digest: request.sha256,
      request_ref: request,
      result_digest: result.sha256,
      result_ref: result,
      state_before_snapshot_id: before.snapshot_id,
      state_after_snapshot_id: after.snapshot_id,
      mutation: true,
      occurred_at: LATER,
    },
    state_before_snapshot: before,
    state_after_snapshot: after,
  });
  const decisionMaterial = {
    contract_version: "decision_committed_receipt_v1" as const,
    episode_id: "episode-42",
    decision_id: "decision-42",
    target_state_snapshot_id: before.snapshot_id,
    guide_trace_id: "guide-trace-42",
    guide_receipt_digest: D.c,
    treatment_assignment_id: "assignment-42",
    candidate_set_digest: D.d,
    selected_candidate_ids: ["candidate-no-memory"],
    policy_id: "correctness-selector-v1",
    policy_version: "1.0.0",
    policy_artifact_digest: D.e,
    learning_exposure_event_id: null,
    learning_exposure_event_digest: null,
    committed_at: LATER,
  };
  const decisionPayload = ExecutionEpisodeEventPayloadV1Schema.parse({
    event_kind: "decision_committed",
    decision: {
      ...decisionMaterial,
      decision_digest: decisionCommittedReceiptDigest(decisionMaterial),
    },
  });
  const invocation = verifierInvocation(after);
  const outcome = verifierOutcome(invocation);
  const verifierPayload = ExecutionEpisodeEventPayloadV1Schema.parse({
    event_kind: "verifier_recorded",
    invocation,
    outcome,
    verified_state_snapshot: after,
  });
  const closePayload = ExecutionEpisodeEventPayloadV1Schema.parse({
    event_kind: "episode_closed",
    termination: "completed",
    outcome_details: [],
    reward: {
      reward_id: "reward-42",
      episode_id: "episode-42",
      reward_contract_version: "episode_reward_v1",
      verified_success: 1,
      outcome_class: "verified_pass",
      reward_authority: "independent_executable",
      final_state_snapshot_id: after.snapshot_id,
      verifier_receipt_id: outcome.verifier_receipt_id,
      token_count: null,
      token_usage_authority: "unavailable",
      tool_call_count: 8,
      elapsed_ms: 60_000,
      outcome_reasons: [],
      contamination_reasons: [],
    },
    final_state_snapshot: after,
    closed_at: "2026-07-27T08:03:00.000Z",
  });
  assert.deepEqual(
    [
      startedPayload,
      decisionPayload,
      actionPayload,
      verifierPayload,
      closePayload,
    ].map((payload) => payload.event_kind),
    [
      "episode_started",
      "decision_committed",
      "action_observed",
      "verifier_recorded",
      "episode_closed",
    ],
  );
  const second = buildExecutionEpisodeEventEnvelopeV1({
    event_id: "episode-event-1",
    episode_id: "episode-42",
    operation_kind: "execution_episode_action_v1",
    operation_id: "operation-action-42",
    request_sha256: D.b,
    sequence: 1,
    previous_event_sha256: first.event_sha256,
    payload: actionPayload,
    occurred_at: LATER,
  });
  assert.equal(
    ExecutionEpisodeEventEnvelopeV1Schema.parse(second).previous_event_sha256,
    first.event_sha256,
  );

  const tampered = structuredClone(second);
  if (tampered.payload.event_kind !== "action_observed") {
    throw new Error("unexpected_test_payload_kind");
  }
  tampered.payload.action.action_kind = "delete";
  assert.equal(ExecutionEpisodeEventEnvelopeV1Schema.safeParse(tampered).success, false);
  assert.equal(ExecutionEpisodeEventEnvelopeV1Schema.safeParse({
    ...second,
    previous_event_sha256: null,
  }).success, false);
  assert.equal(ExecutionEpisodeEventEnvelopeV1Schema.safeParse({
    ...second,
    operation_id: "relabeled-operation",
  }).success, false);
  assert.throws(() => buildExecutionEpisodeEventEnvelopeV1({
    event_id: "episode-event-wrong",
    episode_id: "episode-other",
    operation_kind: "execution_episode_action_v1",
    operation_id: "operation-action-wrong",
    request_sha256: D.b,
    sequence: 1,
    previous_event_sha256: first.event_sha256,
    payload: actionPayload,
    occurred_at: LATER,
  }));
});
