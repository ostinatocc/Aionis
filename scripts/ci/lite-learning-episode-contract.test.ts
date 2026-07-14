import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EffectMeasuredV1Schema,
  ExposureCommittedV1Schema,
  ExternalExecutionPolicyV1Schema,
  FeedbackAttributedV1Schema,
  HostTaskEnvelopeV1Schema,
  HostUseReceiptV1Schema,
  LearningLedgerItemSchema,
  RequiredExternalInputsV1Schema,
  asPublicScope,
  asStoreScope,
  classifyLearningTrack,
  confirmatoryMatchedPairAssignment,
  diagnosticLearningAssignment,
  frozenPriorStateFromRuntimeSlots,
  hostTaskEnvelopeDigest,
  hostUseReceiptDigest,
  isLearningExposurePromotionEligible,
  learningEpisodeEventDigest,
  learningEpisodeId,
  learningEpisodeTrackSummary,
  learningAssignmentUnitSha256,
  learningItemSetDigest,
  learningMemoryNamespaceSha256,
  reconcileCanonicalLearningTaskIdentity,
  resolveLearningAssignment,
  resolveLearningExperimentCompatibility,
} from "../../src/memory/learning-episode-ledger.js";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  admissionCandidatePolicyBehaviorVector,
  admissionCandidatePolicyImplementationContractDigest,
  decideAdmissionCandidatePolicyAction,
  resolveAdmissionCandidatePolicy,
} from "../../src/memory/admission-candidate-policy.js";
import { decideAdmissionCandidatePolicyActionForEvaluation } from "../../src/memory/admission-candidate-policy-evaluator.js";
import {
  LEARNING_GATE_POLICY_ID,
  LEARNING_GATE_POLICY_KEY,
  LEARNING_GATE_POLICY_VERSION,
  assertLearningGatePolicyCanProvisionConfirmatory,
  resolveLearningGatePolicy,
} from "../../src/memory/learning-gate-policy.js";
import {
  LearningAuthorityApprovalV1Schema,
  LearningEvidenceEvaluationV1Schema,
  LearningExperimentCloseApprovalV1Schema,
  LearningLookProposalV1Schema,
  RUNTIME_INTEGRITY_FINDING_CODES,
  RuntimeIntegrityGateReportV1Schema,
  learningAuthorityApprovalDigest,
  learningExperimentCloseApprovalDigest,
  learningLookProposalDigest,
  learningOutcomeRedactedAuthorityProjectionDigest,
  runtimeIntegrityGateReportDigest,
} from "../../src/memory/learning-authority-approval.js";

const D = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
};
const NOW = "2026-07-14T08:00:00.000Z";

function hostTaskEnvelope() {
  return {
    contract_version: "host_task_envelope_v1" as const,
    host_task_id: "host-task-42",
    collector_id: "production-host-adapter",
    collector_version: "3.2.1",
    task_family: "repository_change",
    task_signature: "fix-runtime-learning",
    repository_signature: "github:ostinatocc/Aionis",
    source_task_sha256: D.a,
    source_event_sha256: D.b,
    created_at: NOW,
  };
}

function hostUseReceiptBody() {
  const envelope = hostTaskEnvelope();
  return {
    contract_version: "host_use_receipt_v1" as const,
    receipt_id: "hur_42",
    guide_trace_id: "guide_42",
    episode_id: learningEpisodeId({ tenantId: "tenant-blue", scope: "scope-public", guideTraceId: "guide_42" }),
    operation_id: "op-feedback-42",
    run_id: "run-42",
    host_task_id: envelope.host_task_id,
    host_task_envelope_sha256: hostTaskEnvelopeDigest(envelope),
    collector_id: envelope.collector_id,
    collector_version: envelope.collector_version,
    host_trace_sha256: D.c,
    observed_at: NOW,
    items: [{
      memory_id: "memory-42",
      used_surface: "use_now" as const,
      outcome: "negative" as const,
      action_outcome: "rejected" as const,
      verifier_kind: "instrumented_agent_trace" as const,
      verifier_version: "2.0.0",
      verifier_config_sha256: D.d,
      verifier_status: "passed" as const,
      content_evidence_sha256: D.e,
      evidence_ref_sha256: D.f,
    }],
  };
}

function completeItem(memoryId: string, overrides: Record<string, unknown> = {}) {
  const prior = {
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    prior_effect_state: "no_prior" as const,
    repeated_negative_posture: false,
  };
  const classified = classifyLearningTrack(prior);
  return {
    decision_completeness: "complete" as const,
    memory_id: memoryId,
    memory_type: "project_context",
    source_backend: "aionis",
    recorded_action: "use_now" as const,
    candidate_action: "use_now" as const,
    served_action: "use_now" as const,
    policy_changed: false,
    hard_boundary_preserved: true,
    ...prior,
    learning_track: classified.track,
    track_reason: classified.reason,
    ...overrides,
  };
}

test("episode identity, event digest, and item-set digest are deterministic and canonical", () => {
  const args = { tenantId: "tenant-blue", scope: "scope-public", guideTraceId: "guide-42" };
  assert.match(learningEpisodeId(args), /^lep_[0-9a-f]{64}$/);
  assert.equal(learningEpisodeId(args), learningEpisodeId({ ...args }));
  assert.notEqual(learningEpisodeId(args), learningEpisodeId({ ...args, scope: "scope-other" }));

  const event = {
    contract_version: "aionis_learning_episode_event_v1" as const,
    tenant_id: "tenant-blue",
    scope: "scope-public",
    event_id: "event-1",
    episode_id: learningEpisodeId(args),
    episode_sequence: 1,
    event_kind: "exposure_committed" as const,
    source_kind: "guide_receipt" as const,
    source_id: "guide-42",
    source_sha256: D.a,
    previous_event_sha256: null,
    payload_sha256: D.b,
    item_set_sha256: D.c,
    source_commit_id: "commit-42",
    supersedes_event_id: null,
    operation_id: "operation-42",
    run_id: null,
    collection_class: "eligible_host" as const,
    recorded_at: NOW,
  };
  assert.match(learningEpisodeEventDigest(event), /^[0-9a-f]{64}$/);
  assert.equal(learningEpisodeEventDigest(event), learningEpisodeEventDigest({ ...event }));

  const a = completeItem("memory-a");
  const b = completeItem("memory-b");
  assert.equal(learningItemSetDigest([a, b]), learningItemSetDigest([b, a]));
  assert.notEqual(learningItemSetDigest([a]), learningItemSetDigest([b]));
  const unicodeItems = [completeItem("mémoire"), completeItem("Memory"), completeItem("记忆")];
  assert.equal(
    learningItemSetDigest(unicodeItems),
    learningItemSetDigest([unicodeItems[2]!, unicodeItems[0]!, unicodeItems[1]!]),
  );
});

test("strict host envelope and receipt bind collector, episode, operation, verifier, and evidence", () => {
  const envelope = hostTaskEnvelope();
  assert.deepEqual(HostTaskEnvelopeV1Schema.parse(envelope), envelope);
  assert.match(hostTaskEnvelopeDigest(envelope), /^[0-9a-f]{64}$/);
  assert.throws(() => HostTaskEnvelopeV1Schema.parse({ ...envelope, assignment_arm: "candidate" }));
  assert.throws(() => HostTaskEnvelopeV1Schema.parse({ ...envelope, source_event_sha256: "bad" }));

  const body = hostUseReceiptBody();
  const receipt = { ...body, receipt_sha256: hostUseReceiptDigest(body) };
  assert.deepEqual(HostUseReceiptV1Schema.parse(receipt), receipt);
  assert.equal(receipt.receipt_sha256, hostUseReceiptDigest(body));
  assert.throws(() => HostUseReceiptV1Schema.parse({ ...receipt, receipt_sha256: D.a }));
  assert.throws(() => HostUseReceiptV1Schema.parse({ ...receipt, secret: "never-persist-me" }));
  assert.throws(() => HostUseReceiptV1Schema.parse({
    ...receipt,
    items: [...body.items, { ...body.items[0] }],
    receipt_sha256: hostUseReceiptDigest({ ...body, items: [...body.items, { ...body.items[0] }] }),
  }));
  assert.throws(() => hostUseReceiptDigest({
    ...body,
    items: [
      { ...body.items[0]!, memory_id: "memory-z" },
      { ...body.items[0]!, memory_id: "memory-a" },
    ],
  }));
});

test("exposure, feedback, and effect payloads are strict, bounded, and legacy is promotion-ineligible", () => {
  const envelope = hostTaskEnvelope();
  const exposure = {
    contract_version: "aionis_learning_exposure_v1" as const,
    guide_trace_id: "guide-42",
    guide_receipt_sha256: D.a,
    guide_commit_id: "commit-42",
    request_sha256: D.b,
    operation_protection: "protected" as const,
    collection_class: "eligible_host" as const,
    collection_principal_sha256: D.c,
    collection_source_policy_sha256: D.d,
    collector_id: envelope.collector_id,
    collector_version: envelope.collector_version,
    host_task_id: envelope.host_task_id,
    host_task_envelope: envelope,
    host_task_envelope_sha256: hostTaskEnvelopeDigest(envelope),
    profile_rule_sha256: D.e,
    experiment_config_sha256: D.f,
    evidence_intent: "confirmatory" as const,
    memory_namespace_sha256: D.a,
    namespace_set_sha256: D.b,
    namespace_lease_id: "lease-42",
    namespace_lease_generation: 1,
    assignment_reason_codes: ["eligible_host_matched_pair"],
    assignment_algorithm: "matched_pair_csprng_bit_v1" as const,
    assignment_namespace_sha256: D.c,
    candidate_allocation_bps: 5000,
    assignment_bucket: null,
    randomization_pair_sha256: D.d,
    matching_covariate_sha256: D.e,
    pair_member_ordinal: 0 as const,
    activation_wave_index: 1 as const,
    activation_starts_at: NOW,
    index_window_ends_at: "2026-07-15T08:00:00.000Z",
    wave_analysis_at: "2026-07-16T08:00:00.000Z",
    assignment_arm: "candidate" as const,
    recorded_surface_sha256: D.a,
    candidate_surface_sha256: D.b,
    served_surface_sha256: D.c,
    projection_complete: true,
    hard_boundary_upgrade_count: 0,
  };
  assert.deepEqual(ExposureCommittedV1Schema.parse(exposure), exposure);
  assert.equal(isLearningExposurePromotionEligible(exposure), true);
  assert.equal(isLearningExposurePromotionEligible({ ...exposure, operation_protection: "legacy_unprotected" }), false);
  assert.equal(isLearningExposurePromotionEligible({ ...exposure, collection_class: "fixture_pilot" }), false);
  assert.throws(() => ExposureCommittedV1Schema.parse({ ...exposure, collection_class: "fixture_pilot" }));
  assert.throws(() => ExposureCommittedV1Schema.parse({
    ...exposure,
    assignment_algorithm: "none",
    assignment_arm: "not_enrolled",
  }));
  assert.throws(() => ExposureCommittedV1Schema.parse({
    ...exposure,
    activation_starts_at: "2026-07-14T16:00:00.000+08:00",
  }));
  assert.throws(() => ExposureCommittedV1Schema.parse({
    ...exposure,
    activation_starts_at: "2026-07-17T08:00:00.000Z",
  }));
  assert.throws(() => ExposureCommittedV1Schema.parse({ ...exposure, assignment_reason_codes: Array(33).fill("x") }));
  assert.throws(() => ExposureCommittedV1Schema.parse({ ...exposure, extra_outcome: "positive" }));

  assert.doesNotThrow(() => FeedbackAttributedV1Schema.parse({
    contract_version: "aionis_learning_feedback_v1",
    feedback_kind: "memory",
    guide_trace_id: "guide-42",
    request_sha256: D.a,
    operation_protection: "protected",
    run_id: "run-42",
    source_commit_id: "commit-feedback-42",
    host_use_receipt_sha256: D.b,
    runtime_signal_refs: ["signal-1"],
    unused_exposure_ids: ["memory-unused"],
  }));
  assert.doesNotThrow(() => EffectMeasuredV1Schema.parse({
    contract_version: "aionis_learning_effect_v1",
    measurement_id: "measurement-42",
    measurement_record_sha256: D.a,
    baseline_episode_id: "lep_" + D.b,
    after_episode_id: "lep_" + D.c,
    evidence_status: "sufficient",
    eligible_for_skill_export: true,
  }));
});

test("one frozen-prior resolver owns explore/exploit and exact reason precedence", () => {
  assert.deepEqual(classifyLearningTrack({
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    prior_effect_state: "no_prior",
    repeated_negative_posture: false,
  }), { track: "explore", reason: "no_prior" });
  assert.deepEqual(classifyLearningTrack({
    prior_supported_use_count: 4,
    prior_contradicted_use_count: 2,
    prior_rehydrate_requested_count: 1,
    prior_effect_state: "mixed",
    repeated_negative_posture: true,
  }), { track: "exploit", reason: "prior_nonuse_control" });
  assert.equal(classifyLearningTrack({
    prior_supported_use_count: 1,
    prior_contradicted_use_count: 1,
    prior_rehydrate_requested_count: 1,
    prior_effect_state: "no_prior",
    repeated_negative_posture: false,
  }).reason, "prior_mixed");
  assert.equal(classifyLearningTrack({
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 1,
    prior_rehydrate_requested_count: 2,
    prior_effect_state: "rehydrate_requested",
    repeated_negative_posture: false,
  }).reason, "prior_contradicted");
  assert.equal(classifyLearningTrack({
    prior_supported_use_count: 0,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 2,
    prior_effect_state: "no_prior",
    repeated_negative_posture: false,
  }).reason, "prior_rehydrate_requested");
  assert.equal(classifyLearningTrack({
    prior_supported_use_count: 2,
    prior_contradicted_use_count: 0,
    prior_rehydrate_requested_count: 0,
    prior_effect_state: "no_prior",
    repeated_negative_posture: false,
  }).reason, "prior_supported");

  assert.deepEqual(frozenPriorStateFromRuntimeSlots({
    positive_attributed_use_count: 2,
    weak_counter_signal_count: 1,
    strong_counter_signal_count: 1,
    prior_rehydrate_requested_count: 1,
  }), {
    prior_supported_use_count: 2,
    prior_contradicted_use_count: 2,
    prior_rehydrate_requested_count: 1,
    prior_effect_state: "mixed",
    repeated_negative_posture: true,
  });
});

test("episode summary keeps mixed items split and legacy items unclassified", () => {
  assert.equal(learningEpisodeTrackSummary([]), "unaffected");
  assert.equal(learningEpisodeTrackSummary([
    { policy_affected: true, learning_track: "explore" },
    { policy_affected: true, learning_track: "exploit" },
  ]), "mixed");
  assert.equal(learningEpisodeTrackSummary([
    { policy_affected: false, learning_track: "unclassified" },
    { policy_affected: true, learning_track: "exploit" },
  ]), "exploit");
  assert.equal(learningEpisodeTrackSummary([
    { policy_affected: true, learning_track: "unclassified" },
  ]), "unclassified");
  assert.throws(() => LearningLedgerItemSchema.parse({
    ...completeItem("memory-hard-boundary"),
    recorded_action: "do_not_use",
    candidate_action: "use_now",
    policy_changed: true,
    hard_boundary_preserved: false,
  }));
  assert.throws(() => LearningLedgerItemSchema.parse({
    ...completeItem("memory-served-upgrade"),
    recorded_action: "do_not_use",
    candidate_action: "do_not_use",
    served_action: "use_now",
    policy_changed: false,
    hard_boundary_preserved: true,
  }));
});

test("candidate registry is exact, declarative, parity-stable, and cannot upgrade hard boundaries", () => {
  const policy = resolveAdmissionCandidatePolicy(
    AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
    AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  );
  assert.equal(policy.policy_id, "candidate_project_context_closed_loop_inspect");
  assert.equal(policy.policy_version, "2026-06-18");
  assert.match(policy.policy_config_sha256, /^[0-9a-f]{64}$/);
  assert.equal(policy.implementation_contract_sha256, admissionCandidatePolicyImplementationContractDigest());
  assert.equal(policy.config.used_fields.includes("memory_origin"), true);
  assert.equal(Object.isFrozen(policy.config.direct_use_memory_types), true);
  assert.throws(() => {
    (policy.config.direct_use_memory_types as unknown as string[]).push("procedural_memory");
  });
  assert.throws(() => resolveAdmissionCandidatePolicy(policy.policy_id, "v999"));
  assert.throws(() => resolveAdmissionCandidatePolicy("unknown-policy", policy.policy_version));
  assert.throws(() => resolveAdmissionCandidatePolicy(policy.policy_id, policy.policy_version, D.a));

  const eligible = {
    recorded_action: "use_now" as const,
    memory_origin: "aionis" as const,
    source_backend: "aionis",
    memory_type: "project_context",
    closed_loop_effect_state: "no_prior" as const,
    repeated_negative_posture: false,
  };
  assert.equal(decideAdmissionCandidatePolicyAction(eligible, policy).action, "use_now");
  assert.equal(decideAdmissionCandidatePolicyAction({ ...eligible, source_backend: "external" }, policy).action, "inspect_before_use");
  assert.equal(decideAdmissionCandidatePolicyAction({ ...eligible, source_backend: null }, policy).action, "use_now");
  assert.equal(decideAdmissionCandidatePolicyAction({ ...eligible, closed_loop_effect_state: "mixed" }, policy).action, "inspect_before_use");
  const driftedPolicy = {
    ...policy,
    config: {
      ...policy.config,
      direct_use_memory_types: ["project_context", "execution_memory", "procedural_memory"],
    },
  } as unknown as typeof policy;
  assert.throws(() => decideAdmissionCandidatePolicyAction(eligible, driftedPolicy), /config|parity/);
  for (const action of ["inspect_before_use", "do_not_use", "rehydrate", "not_agent_facing"] as const) {
    const decision = decideAdmissionCandidatePolicyAction({ ...eligible, recorded_action: action }, policy);
    assert.equal(decision.action, action);
    assert.equal(decision.reason_codes[0], "hard_boundary_preserved");
  }

  for (const vector of admissionCandidatePolicyBehaviorVector()) {
    const offlineRow = {
      ...vector.input,
      admission_action: vector.input.recorded_action,
    } as unknown as Parameters<typeof decideAdmissionCandidatePolicyActionForEvaluation>[0];
    assert.equal(
      decideAdmissionCandidatePolicyActionForEvaluation(offlineRow, AIONIS_ADMISSION_CANDIDATE_POLICY_ID),
      vector.output.action,
    );
  }
});

test("profile authority ceiling, evidence intent, and assignment mechanisms fail closed", () => {
  assert.deepEqual(resolveLearningExperimentCompatibility({
    profileMode: "shadow",
    servingPhase: "shadow",
    evidenceIntent: "integrity_only",
    candidateAllocationBps: 5000,
  }), { compatible: true, promotion_eligible: false, reason: "integrity_only_phase" });
  assert.equal(resolveLearningExperimentCompatibility({
    profileMode: "shadow",
    servingPhase: "active_control",
    evidenceIntent: "confirmatory",
    candidateAllocationBps: 5000,
  }).compatible, false);
  assert.equal(resolveLearningExperimentCompatibility({
    profileMode: "active",
    servingPhase: "active_control",
    evidenceIntent: "integrity_only",
    candidateAllocationBps: 5000,
  }).compatible, false);
  assert.equal(resolveLearningExperimentCompatibility({
    profileMode: "active",
    servingPhase: "active_control",
    evidenceIntent: "confirmatory",
    candidateAllocationBps: 1000,
  }).compatible, false);
  assert.equal(resolveLearningExperimentCompatibility({
    profileMode: "active",
    servingPhase: "active_control",
    evidenceIntent: "confirmatory",
    candidateAllocationBps: 5000,
  }).promotion_eligible, true);
  assert.equal(resolveLearningExperimentCompatibility({
    profileMode: "active",
    servingPhase: "shadow",
    evidenceIntent: "integrity_only",
    candidateAllocationBps: 0,
  }).compatible, false);

  const bits = Uint8Array.from({ length: 48 }, (_, index) => index);
  for (let pair = 0; pair < 384; pair += 1) {
    const member0 = confirmatoryMatchedPairAssignment({ assignmentRandomBits: bits, canonicalPairOrdinal: pair, pairMemberOrdinal: 0 });
    const member1 = confirmatoryMatchedPairAssignment({ assignmentRandomBits: bits, canonicalPairOrdinal: pair, pairMemberOrdinal: 1 });
    assert.notEqual(member0.arm, member1.arm);
    assert.equal(member0.assignment_randomness_sha256, member1.assignment_randomness_sha256);
    assert.equal("assignment_random_bits" in member0, false);
    assert.equal("candidate_member_ordinal" in member0, false);
  }
  assert.throws(() => confirmatoryMatchedPairAssignment({
    assignmentRandomBits: new Uint8Array(47), canonicalPairOrdinal: 0, pairMemberOrdinal: 0,
  }));

  const diagnostic = diagnosticLearningAssignment({
    diagnosticAssignmentSeed: new Uint8Array(32).fill(7),
    assignmentNamespace: "fixture:principal-a",
    assignmentUnit: D.a,
    candidateAllocationBps: 5000,
  });
  assert.deepEqual(diagnostic, diagnosticLearningAssignment({
    diagnosticAssignmentSeed: new Uint8Array(32).fill(7),
    assignmentNamespace: "fixture:principal-a",
    assignmentUnit: D.a,
    candidateAllocationBps: 5000,
  }));
  assert.equal("diagnostic_assignment_seed" in diagnostic, false);

  assert.throws(() => resolveLearningAssignment({
    collectionClass: "eligible_host",
    evidenceIntent: "confirmatory",
    diagnosticAssignmentSeed: new Uint8Array(32).fill(7),
    diagnosticAssignmentNamespace: "eligible:principal-a",
    assignmentUnit: D.a,
    candidateAllocationBps: 1_000,
    assignmentRandomBits: bits,
    canonicalPairOrdinal: 0,
    pairMemberOrdinal: 0,
  }), /5000/);

  const fixture = resolveLearningAssignment({
    collectionClass: "fixture_pilot",
    evidenceIntent: "confirmatory",
    diagnosticAssignmentSeed: new Uint8Array(32).fill(7),
    diagnosticAssignmentNamespace: "fixture:principal-a",
    assignmentUnit: D.a,
    candidateAllocationBps: 5000,
    assignmentRandomBits: bits,
    canonicalPairOrdinal: 0,
    pairMemberOrdinal: 0,
  });
  assert.equal(fixture.assignment_authority, "diagnostic_only");
  assert.equal("assignment_randomness_sha256" in fixture, false);
});

test("canonical task reconciliation keeps public/store scope branded and rejects disagreement", () => {
  const publicScope = asPublicScope("project-visible-scope");
  const storeScope = asStoreScope("tenant-non-default::project-visible-scope");
  const identity = reconcileCanonicalLearningTaskIdentity({
    tenantId: "tenant-non-default",
    publicScope,
    storeScope,
    sources: [
      { source: "context", task_family: "repository_change", task_signature: "task-42", repository_signature: "repo-42" },
      { source: "execution_packet_v1", task_family: "repository_change", task_signature: "task-42", repository_signature: "repo-42" },
      {
        source: "host_task_envelope_v1",
        envelope: {
          ...hostTaskEnvelope(),
          task_signature: "task-42",
          repository_signature: "repo-42",
        },
      },
    ],
  });
  assert.equal(identity.tenant_id, "tenant-non-default");
  assert.equal(identity.public_scope, "project-visible-scope");
  assert.equal(identity.store_scope, "tenant-non-default::project-visible-scope");
  assert.equal(identity.host_task_id, "host-task-42");
  assert.match(learningMemoryNamespaceSha256(storeScope), /^[0-9a-f]{64}$/);
  assert.equal(
    learningAssignmentUnitSha256({ tenantId: identity.tenant_id, storeScope }),
    learningAssignmentUnitSha256({ tenantId: "tenant-non-default", storeScope }),
  );
  assert.notEqual(
    learningAssignmentUnitSha256({ tenantId: "tenant-non-default", storeScope }),
    learningAssignmentUnitSha256({ tenantId: "tenant-other", storeScope }),
  );
  assert.throws(() => reconcileCanonicalLearningTaskIdentity({
    tenantId: "tenant-non-default",
    publicScope: asPublicScope("project-visible-scope"),
    storeScope: asStoreScope("tenant-non-default::project-visible-scope"),
    sources: [
      { source: "context", task_family: "repository_change", task_signature: "task-42", repository_signature: "repo-42" },
      { source: "execution_state_v1", task_family: "other-family", task_signature: "task-42", repository_signature: "repo-42" },
    ],
  }));
});

test("external execution policy requires immutable global attestor and exact role set", () => {
  const attestorPublicKey = Buffer.alloc(32, 1);
  const launcherPublicKey = Buffer.alloc(32, 2);
  const launcherPublicKeySha256 = createHash("sha256").update(launcherPublicKey).digest("hex");
  const role = {
    runner_principal_sha256: D.a,
    credential_session_class: "eligible_host_adapter" as const,
    broker_policy_sha256: D.b,
    broker_binary_sha256: D.c,
    broker_public_key_sha256: D.d,
    broker_key_id: "broker-key",
    service_launcher_policy_sha256: D.d,
    service_launcher_binary_sha256: D.e,
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: "authority-launcher-key",
    supervisor_executable_sha256: D.b,
    supervisor_argv_policy_sha256: D.c,
    supervisor_sandbox_policy_sha256: D.d,
    receipt_signature_algorithm: "ed25519-v1" as const,
    credential_scope_sha256: D.e,
    supervisor_bind_ttl_seconds: 60,
    credential_session_hard_ttl_seconds: 3600,
    credential_session_heartbeat_seconds: 15,
    credential_session_max_calls: 500,
    per_call_capability_ttl_seconds: 30,
    post_quiesce_finalize_ttl_seconds: 120,
  };
  const policy = {
    policy_version: "external-execution-v1" as const,
    runtime_authority_attestor: {
      service_identity: "svc:aionis-runtime-authority-attestor",
      attestor_binary_sha256: D.a,
      attestor_policy_sha256: D.b,
      attestor_public_key_base64: attestorPublicKey.toString("base64"),
      attestor_public_key_sha256: createHash("sha256").update(attestorPublicKey).digest("hex"),
      attestor_key_id: "attestor-key",
      service_launcher_policy_sha256: D.d,
      service_launcher_binary_sha256: D.e,
      service_launcher_public_key_base64: launcherPublicKey.toString("base64"),
      service_launcher_public_key_sha256: launcherPublicKeySha256,
      service_launcher_key_id: "authority-launcher-key",
      receipt_signature_algorithm: "ed25519-v1" as const,
      expected_database_instance_id: D.a,
    },
    roles: {
      offline_paired: { ...role, credential_session_class: "immutable_paired_eval" as const },
      production_shadow: { ...role, credential_session_class: "eligible_host_adapter" as const },
      tool_e2e: { ...role, credential_session_class: "formal_tool_eval" as const },
    },
  };
  assert.deepEqual(ExternalExecutionPolicyV1Schema.parse(policy), policy);
  assert.throws(() => ExternalExecutionPolicyV1Schema.parse({
    ...policy,
    runtime_authority_attestor: undefined,
  }));
  assert.throws(() => ExternalExecutionPolicyV1Schema.parse({
    ...policy,
    roles: { ...policy.roles, caller_override: role },
  }));
  assert.throws(() => ExternalExecutionPolicyV1Schema.parse({
    ...policy,
    roles: {
      ...policy.roles,
      tool_e2e: { ...policy.roles.tool_e2e, service_launcher_binary_sha256: D.f },
    },
  }));
  assert.doesNotThrow(() => RequiredExternalInputsV1Schema.parse({
    offline_paired: { immutable_input_manifest_sha256: D.a, retry_policy_sha256: D.b, planned_run_id: "offline-run" },
    production_shadow: { immutable_input_manifest_sha256: D.c, retry_policy_sha256: D.d, planned_run_id: "shadow-run" },
    tool_e2e: { immutable_input_manifest_sha256: D.e, retry_policy_sha256: D.f, planned_run_id: "tool-run" },
  }));
});

test("gate registry freezes v1 tuple, schedule, exact rational budgets, and pending calibration", () => {
  assert.equal(LEARNING_GATE_POLICY_ID, "gate-policy");
  assert.equal(LEARNING_GATE_POLICY_VERSION, "v1");
  assert.equal(LEARNING_GATE_POLICY_KEY, "gate-policy-v1");
  const gate = resolveLearningGatePolicy("gate-policy", "v1");
  assert.equal(gate.registry_status, "calibration_pending");
  assert.deepEqual(gate.config.activation_wave_pair_counts, [96, 96, 192]);
  assert.deepEqual(gate.config.checkpoint_cumulative_matched_pairs, [96, 192, 384]);
  assert.deepEqual(gate.config.checkpoint_kinds, ["safety_integrity_only", "confirmatory", "confirmatory"]);
  assert.deepEqual(gate.config.familywise_any_direction_alpha, { numerator: 1, denominator: 20 });
  assert.deepEqual(gate.config.directional_family_alpha, { numerator: 1, denominator: 40 });
  assert.deepEqual(gate.config.alpha_per_direction_per_formal_look, { numerator: 1, denominator: 80 });
  assert.equal(gate.config.online_assignment_design, "matched_pair_complete_randomization_v1");
  assert.equal(gate.config.confirmatory_assignment_random_bytes, 48);
  assert.equal(gate.config.diagnostic_assignment_random_bytes, 32);
  assert.equal(gate.config.diagnostic_assignment_hash_prefix_bytes, 6);
  assert.equal(gate.config.diagnostic_assignment_bucket_count, 10_000);
  assert.equal(gate.config.confirmatory_attempt_limit_per_task_family_candidate_implementation, 1);
  assert.equal(gate.config.assignment_unit, "store_memory_namespace");
  assert.match(gate.policy_config_sha256, /^[0-9a-f]{64}$/);
  assert.match(gate.implementation_contract_sha256, /^[0-9a-f]{64}$/);
  assert.match(gate.prospective_calibration_contract_sha256, /^[0-9a-f]{64}$/);
  assert.equal(gate.prospective_calibration_artifact_sha256, null);
  assert.throws(() => resolveLearningGatePolicy("learning-gate-v1", "v1"));
  assert.throws(() => resolveLearningGatePolicy("gate-policy", "v2"));
  assert.throws(() => assertLearningGatePolicyCanProvisionConfirmatory(gate), /calibration_pending/);
});

test("evidence evaluation is not authority adjudication", () => {
  const evidence = {
    contract_version: "learning_evidence_evaluation_v1" as const,
    decision_kind: "evidence_evaluation" as const,
    evidence_verdict: "promotion_ready" as const,
    authority_action: null,
    authority_mutation: false as const,
    decision_id: "decision-42",
    look_reservation_id: "look-42",
    evidence_cohort_sha256: D.a,
    evidence_artifact_set_sha256: D.b,
  };
  assert.deepEqual(LearningEvidenceEvaluationV1Schema.parse(evidence), evidence);
  assert.throws(() => LearningEvidenceEvaluationV1Schema.parse({ ...evidence, authority_action: "promote" }));
});

test("authority and experiment-close approvals have distinct bounded action domains and canonical digests", () => {
  const authority = {
    contract_version: "learning_authority_approval_v1" as const,
    authorization_kind: "gate_adjudication" as const,
    action: "promote" as const,
    tenant_id: "tenant-blue",
    task_family: "repository_change",
    authority_scope: "learning:repository_change:" + D.a,
    authority_operation_kind: "learning_gate_authority_v1" as const,
    authority_operation_id: "authority-operation-42",
    experiment_id: "experiment-42",
    experiment_revision: 1,
    experiment_config_sha256: D.f,
    evidence_decision_id: "decision-42",
    look_reservation_id: "look-42",
    look_reservation_sha256: D.f,
    evidence_scope_set_sha256: D.f,
    evidence_cohort_sha256: D.a,
    evidence_artifact_set_sha256: D.b,
    candidate_policy_id: AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
    candidate_policy_version: AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
    candidate_policy_implementation_sha256: D.c,
    candidate_policy_config_sha256: D.d,
    gate_policy_id: LEARNING_GATE_POLICY_ID,
    gate_policy_version: LEARNING_GATE_POLICY_VERSION,
    gate_policy_implementation_sha256: D.f,
    gate_policy_config_sha256: D.e,
    approved_by: "operator@example.com",
    authorization_key_id: "authority-key-1",
    authorization_nonce: "nonce-authority-42",
    authorization_expires_at: "2026-07-14T09:00:00.000Z",
  };
  assert.deepEqual(LearningAuthorityApprovalV1Schema.parse(authority), authority);
  assert.match(learningAuthorityApprovalDigest(authority), /^[0-9a-f]{64}$/);
  assert.throws(() => LearningAuthorityApprovalV1Schema.parse({ ...authority, action: "close" }));
  assert.throws(() => LearningAuthorityApprovalV1Schema.parse({ ...authority, secret: "not-allowed" }));

  const close = {
    contract_version: "learning_experiment_close_approval_v1" as const,
    authorization_kind: "experiment_close" as const,
    action: "close_experiment" as const,
    tenant_id: "tenant-blue",
    confirmatory_attempt_id: "attempt-42",
    experiment_id: "experiment-42",
    experiment_revision: 1,
    namespace_set_sha256: D.a,
    close_reason: "operator_stop" as const,
    candidate_policy_implementation_sha256: D.b,
    gate_policy_implementation_sha256: D.c,
    authority_scope: "learning:repository_change:" + D.a,
    authority_operation_kind: "learning_experiment_close_v1" as const,
    authority_operation_id: "close-operation-42",
    approved_by: "operator@example.com",
    authorization_key_id: "authority-key-1",
    authorization_nonce: "nonce-close-42",
    authorization_expires_at: "2026-07-14T09:00:00.000Z",
  };
  assert.deepEqual(LearningExperimentCloseApprovalV1Schema.parse(close), close);
  assert.match(learningExperimentCloseApprovalDigest(close), /^[0-9a-f]{64}$/);
  assert.notEqual(learningExperimentCloseApprovalDigest(close), learningAuthorityApprovalDigest(authority));
  assert.throws(() => LearningExperimentCloseApprovalV1Schema.parse({ ...close, action: "promote" }));
});

test("look proposal and Runtime integrity report are strict, outcome-redacted, and digest-bound", () => {
  const authorityProjection = {
    contract_version: "learning_outcome_redacted_authority_projection_v1" as const,
    schema_version: 3 as const,
    database_instance_id: D.a,
    confirmatory_attempt_sha256: D.b,
    experiment_config_sha256: D.f,
    candidate_policy_config_sha256: D.f,
    candidate_policy_implementation_sha256: D.a,
    gate_policy_config_sha256: D.b,
    gate_policy_implementation_sha256: D.f,
    look_schedule_sha256: D.c,
    randomization_pair_manifest_sha256: D.d,
    activation_schedule_sha256: D.e,
    collection_source_policy_sha256: D.f,
    required_evidence_series_sha256: D.e,
    required_artifact_heads_sha256: D.a,
    event_cutoff_row_id: 100,
    artifact_cutoff_row_id: 12,
    event_head_sha256: D.c,
    artifact_head_sha256: D.d,
  };
  const proposal = {
    contract_version: "learning_look_proposal_v1" as const,
    tenant_id: "tenant-blue",
    confirmatory_attempt_id: "attempt-42",
    experiment_id: "experiment-42",
    experiment_revision: 1,
    experiment_config_sha256: D.f,
    task_family: "repository_change",
    candidate_policy_id: AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
    candidate_policy_version: AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
    candidate_policy_config_sha256: D.f,
    candidate_policy_implementation_sha256: D.a,
    gate_policy_id: LEARNING_GATE_POLICY_ID,
    gate_policy_version: LEARNING_GATE_POLICY_VERSION,
    gate_policy_config_sha256: D.b,
    gate_policy_implementation_sha256: D.f,
    look_index: 1,
    target_cumulative_pair_count: 96,
    checkpoint_kind: "safety_integrity_only" as const,
    cutoff: {
      event_row_id: 100,
      artifact_row_id: 12,
      recorded_at: NOW,
      event_head_sha256: D.c,
      artifact_head_sha256: D.d,
    },
    outcome_redacted_authority_projection: authorityProjection,
    outcome_redacted_authority_projection_sha256: learningOutcomeRedactedAuthorityProjectionDigest(authorityProjection),
  };
  assert.deepEqual(LearningLookProposalV1Schema.parse(proposal), proposal);
  const proposalDigest = learningLookProposalDigest(proposal);
  assert.match(proposalDigest, /^[0-9a-f]{64}$/);
  assert.throws(() => LearningLookProposalV1Schema.parse({ ...proposal, outcome_labels: ["negative"] }));

  const report = {
    contract_version: "runtime_integrity_gate_report_v1" as const,
    tenant_id: proposal.tenant_id,
    confirmatory_attempt_id: proposal.confirmatory_attempt_id,
    experiment_id: proposal.experiment_id,
    experiment_revision: proposal.experiment_revision,
    experiment_config_sha256: proposal.experiment_config_sha256,
    task_family: proposal.task_family,
    candidate_policy_id: proposal.candidate_policy_id,
    candidate_policy_version: proposal.candidate_policy_version,
    candidate_policy_config_sha256: proposal.candidate_policy_config_sha256,
    candidate_policy_implementation_sha256: proposal.candidate_policy_implementation_sha256,
    gate_policy_id: proposal.gate_policy_id,
    gate_policy_version: proposal.gate_policy_version,
    gate_policy_config_sha256: proposal.gate_policy_config_sha256,
    gate_policy_implementation_sha256: proposal.gate_policy_implementation_sha256,
    look_index: proposal.look_index,
    target_cumulative_pair_count: proposal.target_cumulative_pair_count,
    checkpoint_kind: proposal.checkpoint_kind,
    cutoff: proposal.cutoff,
    outcome_redacted_authority_projection: proposal.outcome_redacted_authority_projection,
    outcome_redacted_authority_projection_sha256: proposal.outcome_redacted_authority_projection_sha256,
    proposal_sha256: proposalDigest,
    verifier_id: "aionis_lite_learning_ledger_replay" as const,
    verifier_version: 1 as const,
    integrity_status: "passed" as const,
    findings: RUNTIME_INTEGRITY_FINDING_CODES.map((code) => ({
      code,
      severity: "info" as const,
      count: 0,
      evidence_sha256: D.a,
    })),
  };
  assert.deepEqual(RuntimeIntegrityGateReportV1Schema.parse(report), report);
  assert.match(runtimeIntegrityGateReportDigest(report), /^[0-9a-f]{64}$/);
  assert.throws(() => RuntimeIntegrityGateReportV1Schema.parse({ ...report, proposal_sha256: D.f }));
  assert.throws(() => RuntimeIntegrityGateReportV1Schema.parse({ ...report, findings: [] }));
  assert.throws(() => RuntimeIntegrityGateReportV1Schema.parse({
    ...report,
    findings: report.findings.slice().reverse(),
  }));
  assert.throws(() => RuntimeIntegrityGateReportV1Schema.parse({ ...report, effects: [{ outcome: "negative" }] }));
});
