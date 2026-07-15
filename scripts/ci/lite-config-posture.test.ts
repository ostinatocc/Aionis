import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import {
  admissionCandidatePolicyExperimentDeclarationDigest,
  admissionCandidatePolicyProfileRuleDigest,
  loadEnv,
  parseAdmissionCandidatePolicyProfileRules,
} from "../../src/config.ts";
import {
  LearningExperimentApplicabilityManifestV1Schema,
  LearningExperimentExternalInputSetV1Schema,
  LearningExperimentProvisionReceiptV1Schema,
  LearningMemoryNamespacePublicScopeV1Schema,
  LearningMemoryNamespaceManifestV1Schema,
  learningConfirmatoryActivationScheduleDigest,
  learningConfirmatoryNamespaceLeaseMembershipDigest,
  learningConfirmatoryNamespaceSetDigest,
  learningConfirmatoryPairManifestDigest,
  learningExperimentApplicabilityManifestDigest,
  learningExperimentExternalInputSetDigest,
  learningMemoryNamespaceManifestScopeEncodingIssue,
  learningMemoryNamespaceManifestDigest,
  type LearningExperimentConfirmatoryCohortPairV1,
} from "../../src/memory/learning-experiment-provisioning.ts";

const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const rawDigest = (value: string) => createHash("sha256").update(value).digest("hex");

function requiredExternalInputs() {
  return {
    offline_paired: {
      immutable_input_manifest_sha256: "1".repeat(64),
      retry_policy_sha256: "2".repeat(64),
      planned_run_id: "offline-run-v1",
    },
    production_shadow: {
      immutable_input_manifest_sha256: "3".repeat(64),
      retry_policy_sha256: "4".repeat(64),
      planned_run_id: "shadow-run-v1",
    },
    tool_e2e: {
      immutable_input_manifest_sha256: "5".repeat(64),
      retry_policy_sha256: "6".repeat(64),
      planned_run_id: "tool-run-v1",
    },
  };
}

const WAVE_TIMES = {
  1: ["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"],
  2: ["2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"],
  3: ["2026-08-07T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
} as const;

function memoryNamespaceManifest() {
  return {
    contract_version: "aionis_learning_memory_namespace_manifest_v1" as const,
    tenant_id: "tenant-a",
    task_family: "validated_coding_continuation",
    experiment_id: "admission-candidate-r1",
    experiment_revision: 1,
    pairs: Array.from({ length: 384 }, (_, index) => {
      const activationWaveIndex = index < 96 ? 1 : index < 192 ? 2 : 3;
      const times = WAVE_TIMES[activationWaveIndex];
      const pair = String(index).padStart(3, "0");
      return {
        members: [
          { tenant_id: "tenant-a", public_scope: `reviewed-scope-${pair}-0` },
          { tenant_id: "tenant-a", public_scope: `reviewed-scope-${pair}-1` },
        ],
        matching_covariates: {
          contract_version: "aionis_learning_matching_covariates_v1" as const,
          host_adapter_sha256: "7".repeat(64),
          provider_model_route_sha256: "8".repeat(64),
          region: "test-region",
          workload_stratum: `stratum-${pair}`,
        },
        activation: {
          activation_wave_index: activationWaveIndex,
          activation_starts_at: times[0],
          index_window_ends_at: times[1],
          wave_analysis_at: times[2],
        },
      };
    }),
  };
}

function confirmatoryCohortPairs(): LearningExperimentConfirmatoryCohortPairV1[] {
  const pairSeeds = Array.from({ length: 384 }, (_, sourceOrdinal) => ({
    sourceOrdinal,
    randomizationPairSha256: digest({
      contract_version: "test_randomization_pair_identity_v1",
      source_ordinal: sourceOrdinal,
    }),
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.randomizationPairSha256, "utf8"),
    Buffer.from(right.randomizationPairSha256, "utf8"),
  ));
  return pairSeeds.map<LearningExperimentConfirmatoryCohortPairV1>((seed, pairOrdinal) => {
    const activationWaveIndex: 1 | 2 | 3 = pairOrdinal < 96 ? 1 : pairOrdinal < 192 ? 2 : 3;
    const times = WAVE_TIMES[activationWaveIndex];
    return {
      pair_ordinal: pairOrdinal,
      randomization_pair_sha256: seed.randomizationPairSha256,
      pair_record_sha256: digest({ pair_record: seed.sourceOrdinal }),
      matching_covariate_sha256: digest({ matching_covariate: seed.sourceOrdinal }),
      activation_wave_index: activationWaveIndex,
      activation_starts_at: times[0],
      index_window_ends_at: times[1],
      wave_analysis_at: times[2],
      members: [0, 1].map((pairMemberOrdinal) => ({
        pair_member_ordinal: pairMemberOrdinal as 0 | 1,
        memory_namespace_sha256: digest({
          memory_namespace: seed.sourceOrdinal,
          pair_member_ordinal: pairMemberOrdinal,
        }),
        namespace_lease_id_sha256: digest({
          namespace_lease_id: seed.sourceOrdinal,
          pair_member_ordinal: pairMemberOrdinal,
        }),
        namespace_lease_generation: 1,
      })) as [
        LearningExperimentConfirmatoryCohortPairV1["members"][0],
        LearningExperimentConfirmatoryCohortPairV1["members"][1],
      ],
    };
  });
}

function confirmatoryApplicabilityFixture() {
  const namespaceManifest = LearningMemoryNamespaceManifestV1Schema.parse(memoryNamespaceManifest());
  const externalInputSet = LearningExperimentExternalInputSetV1Schema.parse({
    contract_version: "aionis_learning_experiment_external_input_set_v1",
    tenant_id: "tenant-a",
    task_family: "validated_coding_continuation",
    experiment_id: "admission-candidate-r1",
    experiment_revision: 1,
    roles: requiredExternalInputs(),
  });
  const pairs = confirmatoryCohortPairs();
  const confirmatoryAttemptId = "attempt-admission-candidate-r1-v1";
  const tenantScopeEncodingSha256 = digest({
    contract_version: "aionis_tenant_scope_encoding_v1",
    trusted_default_tenant_id: "tenant-a",
    scope_key_algorithm: "resolve_tenant_scope_v1",
  });
  const cohort = {
    contract_version: "aionis_learning_confirmatory_applicability_cohort_v1" as const,
    confirmatory_attempt_id: confirmatoryAttemptId,
    confirmatory_attempt_sha256: digest({ confirmatory_attempt_id: confirmatoryAttemptId }),
    eligible_memory_namespace_set_sha256: learningConfirmatoryNamespaceSetDigest(pairs),
    eligible_memory_namespace_count: 768 as const,
    randomization_pair_manifest_sha256: learningConfirmatoryPairManifestDigest(pairs),
    randomization_pair_count: 384 as const,
    activation_schedule_sha256: learningConfirmatoryActivationScheduleDigest(pairs),
    namespace_lease_membership_sha256: learningConfirmatoryNamespaceLeaseMembershipDigest(pairs),
    namespace_lease_count: 768 as const,
    pairs,
  };
  const policyBindings = {
    candidate_policy_config_sha256: "1".repeat(64),
    candidate_policy_implementation_sha256: "2".repeat(64),
    gate_policy_config_sha256: "3".repeat(64),
    gate_prospective_calibration_sha256: "4".repeat(64),
    collection_source_policy_sha256: "5".repeat(64),
    required_evidence_series_sha256: "6".repeat(64),
    required_external_inputs_sha256: digest(externalInputSet.roles),
    external_execution_policy_sha256: "7".repeat(64),
  };
  const operationId = "provision-confirmatory-v1";
  const actor = "experiment-provisioner";
  const manifest = LearningExperimentApplicabilityManifestV1Schema.parse({
    contract_version: "aionis_learning_experiment_applicability_manifest_v1",
    tenant_id: "tenant-a",
    provision_operation_id_sha256: rawDigest(operationId),
    provision_request_sha256: digest({ request: "confirmatory-v1" }),
    provisioning_actor_sha256: rawDigest(actor),
    runtime_authority_lineage_sha256: rawDigest("runtime-authority-v1"),
    experiment_id: "admission-candidate-r1",
    experiment_revision: 1,
    profile_rule_sha256: "8".repeat(64),
    experiment_declaration_sha256: "9".repeat(64),
    experiment_config_sha256: "a".repeat(64),
    serving_phase: "active_control",
    evidence_intent: "confirmatory",
    assignment_design: "matched_pair_complete_randomization_v1",
    task_family: "validated_coding_continuation",
    profile: {
      contract_version: "aionis_learning_experiment_applicability_profile_v1",
      profile_id: "validated-coding-worker",
      mode: "active",
      task_family: "validated_coding_continuation",
      scope_selector_sha256s: [],
      scope_prefix_selector_sha256s: [],
      task_signature_selector_sha256s: [],
      agent_roles: ["worker"],
      context_modes: ["compact_agent"],
      guide_modes: [],
    },
    policy_bindings: policyBindings,
    diagnostic_assignment_seed_sha256: "b".repeat(64),
    collection_sources: [],
    memory_namespace_manifest_sha256: learningMemoryNamespaceManifestDigest(namespaceManifest),
    external_input_set_sha256: learningExperimentExternalInputSetDigest(externalInputSet),
    tenant_scope_encoding_sha256: tenantScopeEncodingSha256,
    confirmatory_assignment_bits_sha256: createHash("sha256")
      .update(Buffer.alloc(48, 0xa5)).digest("hex"),
    cohort,
    provisioned_at: "2026-07-14T00:00:00.000Z",
  });
  if (manifest.evidence_intent !== "confirmatory") {
    throw new Error("expected confirmatory applicability fixture");
  }
  return {
    actor,
    cohort,
    externalInputSet,
    manifest,
    namespaceManifest,
    operationId,
    policyBindings,
    tenantScopeEncodingSha256,
  };
}

function immutableExperiment(overrides: Record<string, unknown> = {}) {
  const allowedVerifiers = [
    {
      kind: "deterministic_scorer",
      version: "scorer-v1",
      config_sha256: "1".repeat(64),
    },
  ];
  return {
    experiment_id: "admission-candidate-r1",
    revision: 1,
    serving_phase: "shadow",
    evidence_intent: "integrity_only",
    assignment_design: "diagnostic_hash_v1",
    candidate_policy_id: "candidate_project_context_closed_loop_inspect",
    candidate_policy_version: "2026-06-18",
    candidate_allocation_bps: 5000,
    gate_policy_id: "gate-policy",
    gate_policy_version: "v1",
    required_evidence_series: {
      offline_paired: "series-offline-v1",
      production_shadow: "series-production-v1",
      tool_e2e: "series-tool-v1",
      runtime_integrity: "series-runtime-v1",
    },
    external_execution_policy_ref: {
      registry_key: "external-execution-v1",
    },
    collection_sources: [
      {
        principal_sha256: "a".repeat(64),
        class: "eligible_host",
        collector_id: "host-collector",
        collector_version: "collector-v1",
        verifier_policy_sha256: digest({ allowed_verifiers: allowedVerifiers }),
        allowed_verifiers: allowedVerifiers,
      },
    ],
    safety_pause_mode: "automatic",
    ...overrides,
  };
}

function experimentProfile(
  experiment: Record<string, unknown> = immutableExperiment(),
  overrides: Record<string, unknown> = {},
) {
  return {
    profile_id: "validated-coding-worker",
    mode: "active",
    task_families: ["validated_coding_continuation"],
    agent_roles: ["worker"],
    context_modes: ["compact_agent"],
    experiment,
    ...overrides,
  };
}

async function withIsolatedEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    await fn();
  } finally {
    process.env = previous;
  }
}

test("shipped source tree defaults to lite posture", async () => {
  await withIsolatedEnv({}, () => {
    const env = loadEnv();
    assert.equal(env.AIONIS_EDITION, "lite");
    assert.equal(env.AIONIS_MODE, "local");
    assert.equal(env.AIONIS_INSPECT_BEFORE_USE_MODE, "shadow");
    assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "off");
    assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON, "[]");
    assert.equal(env.MEMORY_AUTH_MODE, "off");
    assert.equal(env.TENANT_QUOTA_ENABLED, false);
    assert.equal(env.RECALL_ENGINE_MODE, "hybrid");
  });
});

test("inspect-before-use active projection is explicit opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_INSPECT_BEFORE_USE_MODE: "active",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_INSPECT_BEFORE_USE_MODE, "active");
    },
  );
});

test("admission candidate policy active projection is explicit opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "shadow",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "shadow");
    },
  );
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "active",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "active");
    },
  );
});

test("admission candidate policy profile rules are explicit and scoped", async () => {
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: JSON.stringify([
        {
          profile_id: "validated-coding-worker",
          mode: "active",
          task_families: ["validated_coding_continuation"],
          agent_roles: ["worker"],
          context_modes: ["compact_agent"],
        },
      ]),
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "off");
      assert.match(env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON, /validated-coding-worker/);
    },
  );
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: JSON.stringify([
        {
          profile_id: "unsafe-catch-all",
          mode: "active",
        },
      ]),
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /profile rule must include at least one selector/,
      );
    },
  );
});

test("legacy admission profiles remain valid without experiment enrollment", () => {
  const rules = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
    {
      profile_id: "legacy-profile",
      mode: "active",
      task_families: ["legacy-task-family"],
    },
  ]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.profile_id, "legacy-profile");
  assert.equal(rules[0]?.experiment, undefined);
});

test("admission profiles accept a strict registry-referenced immutable experiment declaration", () => {
  const rules = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
    experimentProfile(),
  ]));
  const experiment = rules[0]?.experiment;
  assert.ok(experiment);
  assert.equal(experiment.serving_phase, "shadow");
  assert.equal(experiment.evidence_intent, "integrity_only");
  assert.equal(experiment.external_execution_policy_ref.registry_key, "external-execution-v1");
  assert.deepEqual(experiment.required_external_inputs, {});
  assert.equal(experiment.collection_sources[0]?.class, "eligible_host");
  assert.equal(
    admissionCandidatePolicyExperimentDeclarationDigest(experiment),
    digest(experiment),
  );
  assert.equal(
    admissionCandidatePolicyProfileRuleDigest(rules[0]!),
    digest(rules[0]),
  );
});

test("experiment declarations freeze phase-compatible exact external inputs", () => {
  const required = requiredExternalInputs();
  const [confirmatoryRule] = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
    experimentProfile(immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      required_external_inputs: required,
    })),
  ]));
  assert.deepEqual(confirmatoryRule?.experiment?.required_external_inputs, required);

  const invalidExperiments = [
    immutableExperiment({ required_external_inputs: required }),
    {
      ...immutableExperiment({
        serving_phase: "active_control",
        evidence_intent: "confirmatory",
        assignment_design: "matched_pair_complete_randomization_v1",
      }),
    },
    immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      required_external_inputs: {
        ...required,
        tool_e2e: { ...required.tool_e2e, planned_run_id: required.offline_paired.planned_run_id },
      },
    }),
    immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      required_external_inputs: {
        ...required,
        tool_e2e: { ...required.tool_e2e, planned_run_id: ` ${required.tool_e2e.planned_run_id}` },
      },
    }),
  ];
  for (const experiment of invalidExperiments) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(experiment),
      ])),
      /external|confirmatory|integrity|planned|exact|unique|required/i,
    );
  }
});

test("external input set and reviewed namespace population use strict canonical contracts", () => {
  const externalInputSet = {
    contract_version: "aionis_learning_experiment_external_input_set_v1" as const,
    tenant_id: "tenant-a",
    task_family: "validated_coding_continuation",
    experiment_id: "admission-candidate-r1",
    experiment_revision: 1,
    roles: requiredExternalInputs(),
  };
  assert.deepEqual(LearningExperimentExternalInputSetV1Schema.parse(externalInputSet), externalInputSet);
  assert.equal(learningExperimentExternalInputSetDigest(externalInputSet), digest(externalInputSet));
  assert.throws(() => LearningExperimentExternalInputSetV1Schema.parse({
    ...externalInputSet,
    roles: {
      ...externalInputSet.roles,
      tool_e2e: { ...externalInputSet.roles.tool_e2e, planned_run_id: " tool-run-v1" },
    },
  }));
  assert.throws(() => LearningExperimentExternalInputSetV1Schema.parse({
    ...externalInputSet,
    outcome_summary: { status: "passed" },
  }));

  const namespaceManifest = memoryNamespaceManifest();
  assert.deepEqual(LearningMemoryNamespaceManifestV1Schema.parse(namespaceManifest), namespaceManifest);
  assert.equal(learningMemoryNamespaceManifestDigest(namespaceManifest), digest(namespaceManifest));
  assert.equal(LearningMemoryNamespacePublicScopeV1Schema.parse("a".repeat(256)).length, 256);
  assert.equal(LearningMemoryNamespacePublicScopeV1Schema.parse("界".repeat(85)).length, 85);
  assert.throws(() => LearningMemoryNamespacePublicScopeV1Schema.parse("a".repeat(257)));
  assert.throws(() => LearningMemoryNamespacePublicScopeV1Schema.parse("界".repeat(86)));

  const defaultTenantBoundary = structuredClone(namespaceManifest);
  defaultTenantBoundary.pairs[0]!.members[0]!.public_scope = "a".repeat(256);
  assert.equal(learningMemoryNamespaceManifestScopeEncodingIssue({
    manifest: defaultTenantBoundary,
    defaultTenantId: "tenant-a",
  }), null);
  const nonDefaultPrefix = Buffer.byteLength("tenant:tenant-a::scope:", "utf8");
  defaultTenantBoundary.pairs[0]!.members[0]!.public_scope = "a".repeat(256 - nonDefaultPrefix);
  assert.equal(learningMemoryNamespaceManifestScopeEncodingIssue({
    manifest: defaultTenantBoundary,
    defaultTenantId: "another-default",
  }), null);
  defaultTenantBoundary.pairs[0]!.members[0]!.public_scope += "a";
  assert.deepEqual(learningMemoryNamespaceManifestScopeEncodingIssue({
    manifest: defaultTenantBoundary,
    defaultTenantId: "another-default",
  }), {
    pair_index: 0,
    member_index: 0,
    scope_key_utf8_bytes: 257,
  });
  const maxTenantBoundary = structuredClone(namespaceManifest);
  maxTenantBoundary.pairs[0]!.members[0]!.tenant_id = "t".repeat(64);
  maxTenantBoundary.pairs[0]!.members[0]!.public_scope = "a".repeat(177);
  assert.equal(learningMemoryNamespaceManifestScopeEncodingIssue({
    manifest: maxTenantBoundary,
    defaultTenantId: "another-default",
  }), null);
  maxTenantBoundary.pairs[0]!.members[0]!.public_scope += "a";
  assert.equal(
    learningMemoryNamespaceManifestScopeEncodingIssue({
      manifest: maxTenantBoundary,
      defaultTenantId: "another-default",
    })?.scope_key_utf8_bytes,
    257,
  );

  const duplicateScope = structuredClone(namespaceManifest);
  duplicateScope.pairs[1]!.members[0]!.public_scope = duplicateScope.pairs[0]!.members[0]!.public_scope;
  assert.throws(() => LearningMemoryNamespaceManifestV1Schema.parse(duplicateScope));
  const wrongWaveCount = structuredClone(namespaceManifest);
  wrongWaveCount.pairs[95]!.activation.activation_wave_index = 2;
  assert.throws(() => LearningMemoryNamespaceManifestV1Schema.parse(wrongWaveCount));
  const nonCanonicalTime = structuredClone(namespaceManifest);
  nonCanonicalTime.pairs[0]!.activation.activation_starts_at = "2026-08-01T00:00:00Z";
  assert.throws(() => LearningMemoryNamespaceManifestV1Schema.parse(nonCanonicalTime));
  const nonCanonicalOrder = structuredClone(namespaceManifest);
  [nonCanonicalOrder.pairs[0], nonCanonicalOrder.pairs[1]] = [
    nonCanonicalOrder.pairs[1]!,
    nonCanonicalOrder.pairs[0]!,
  ];
  assert.throws(() => LearningMemoryNamespaceManifestV1Schema.parse(nonCanonicalOrder));
  assert.throws(() => LearningMemoryNamespaceManifestV1Schema.parse({
    ...namespaceManifest,
    assignment_randomness_sha256: "9".repeat(64),
  }));
});

test("confirmatory applicability and receipt bind reviewed inputs without leaking assignment authority", () => {
  const fixture = confirmatoryApplicabilityFixture();
  const { manifest } = fixture;
  const manifestSha256 = learningExperimentApplicabilityManifestDigest(manifest);
  assert.equal(manifestSha256, digest(manifest));
  assert.equal(manifest.cohort.confirmatory_attempt_id, "attempt-admission-candidate-r1-v1");
  assert.equal(manifest.tenant_scope_encoding_sha256, fixture.tenantScopeEncodingSha256);
  assert.equal(
    manifest.cohort.eligible_memory_namespace_set_sha256,
    digest(manifest.cohort.pairs
      .flatMap((pair) => pair.members.map((member) => member.memory_namespace_sha256))
      .sort()),
  );
  assert.equal(
    manifest.cohort.randomization_pair_manifest_sha256,
    digest(manifest.cohort.pairs.map((pair) => ({
      pair_ordinal: pair.pair_ordinal,
      randomization_pair_sha256: pair.randomization_pair_sha256,
      pair_record_sha256: pair.pair_record_sha256,
    }))),
  );
  const manifestJson = stableStringify(manifest);
  for (const forbiddenKey of [
    '"public_scope"',
    '"store_scope"',
    '"assigned_arm"',
    '"confirmatory_assignment_bits"',
    '"namespace_lease_id"',
  ]) {
    assert.equal(manifestJson.includes(forbiddenKey), false, forbiddenKey);
  }

  const firstPair = manifest.cohort.pairs[0]!;
  const leakyPairs = [
    { ...firstPair, store_scope: "tenant:tenant-a:scope:private" },
    {
      ...firstPair,
      members: [
        { ...firstPair.members[0], assigned_arm: "candidate" },
        firstPair.members[1],
      ],
    },
    {
      ...firstPair,
      members: [
        { ...firstPair.members[0], namespace_lease_id: "lease-secret" },
        firstPair.members[1],
      ],
    },
  ];
  for (const leakyPair of leakyPairs) {
    assert.throws(() => LearningExperimentApplicabilityManifestV1Schema.parse({
      ...manifest,
      cohort: {
        ...manifest.cohort,
        pairs: [leakyPair, ...manifest.cohort.pairs.slice(1)],
      },
    }));
  }
  assert.throws(() => LearningExperimentApplicabilityManifestV1Schema.parse({
    ...manifest,
    cohort: {
      ...manifest.cohort,
      confirmatory_assignment_bits: "must-never-leave-authority-storage",
    },
  }));

  const assignmentBitsSha256 = manifest.confirmatory_assignment_bits_sha256;
  const receiptInput = {
    contract_version: "aionis_learning_experiment_provision_receipt_v1",
    operation_kind: "learning_experiment_provision_v1",
    operation_id: fixture.operationId,
    request_sha256: manifest.provision_request_sha256,
    tenant_id: manifest.tenant_id,
    authority_scope: "learning-experiment-authority-v1",
    runtime_authority_lineage_sha256: manifest.runtime_authority_lineage_sha256,
    actor: fixture.actor,
    status: "provisioned",
    experiment: {
      experiment_id: manifest.experiment_id,
      experiment_revision: manifest.experiment_revision,
      profile_id: manifest.profile.profile_id,
      profile_rule_sha256: manifest.profile_rule_sha256,
      experiment_config_sha256: manifest.experiment_config_sha256,
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
    },
    policy_bindings: fixture.policyBindings,
    input_bindings: {
      memory_namespace_manifest_sha256: manifest.memory_namespace_manifest_sha256,
      external_input_set_sha256: manifest.external_input_set_sha256,
      tenant_scope_encoding_sha256: manifest.tenant_scope_encoding_sha256,
    },
    cohort: {
      contract_version: "aionis_learning_confirmatory_provision_summary_v1",
      confirmatory_attempt_id: manifest.cohort.confirmatory_attempt_id,
      confirmatory_attempt_sha256: manifest.cohort.confirmatory_attempt_sha256,
      eligible_memory_namespace_set_sha256:
        manifest.cohort.eligible_memory_namespace_set_sha256,
      eligible_memory_namespace_count: 768,
      randomization_pair_manifest_sha256:
        manifest.cohort.randomization_pair_manifest_sha256,
      randomization_pair_count: 384,
      activation_schedule_sha256: manifest.cohort.activation_schedule_sha256,
      namespace_lease_membership_sha256:
        manifest.cohort.namespace_lease_membership_sha256,
      namespace_lease_count: 768,
      planned_candidate_namespace_count: 384,
      planned_control_namespace_count: 384,
      assignment: {
        assignment_design: "matched_pair_complete_randomization_v1",
        assignment_algorithm: "matched_pair_csprng_bit_v1",
        confirmatory_assignment_bits_sha256: assignmentBitsSha256,
        confirmatory_assignment_bit_count: 384,
        confirmatory_assignment_random_bytes: 48,
        confirmatory_assignment_bit_order:
          "canonical_pair_hash_ascending_bit_zero_first_msb_first",
        randomness_rejection_or_redraw_allowed: false,
      },
    },
    applicability_manifest_sha256: manifestSha256,
    applicability_manifest: manifest,
  };
  const receipt = LearningExperimentProvisionReceiptV1Schema.parse(receiptInput);
  assert.deepEqual(receipt, receiptInput);
  assert.equal(receipt.cohort?.assignment.confirmatory_assignment_bits_sha256, assignmentBitsSha256);
  const receiptJson = stableStringify(receipt);
  assert.equal(receiptJson.includes('"confirmatory_assignment_bits":'), false);
  assert.equal(receiptJson.includes('"assigned_arm":'), false);

  for (const invalidReceipt of [
    {
      ...receiptInput,
      input_bindings: {
        ...receiptInput.input_bindings,
        external_input_set_sha256: "f".repeat(64),
      },
    },
    {
      ...receiptInput,
      input_bindings: {
        ...receiptInput.input_bindings,
        tenant_scope_encoding_sha256: "f".repeat(64),
      },
    },
    {
      ...receiptInput,
      cohort: {
        ...receiptInput.cohort,
        confirmatory_attempt_id: "different-attempt",
      },
    },
    {
      ...receiptInput,
      cohort: {
        ...receiptInput.cohort,
        assignment: {
          ...receiptInput.cohort.assignment,
          confirmatory_assignment_bits: "must-never-leave-authority-storage",
        },
      },
    },
  ]) {
    assert.throws(() => LearningExperimentProvisionReceiptV1Schema.parse(invalidReceipt));
  }
});

test("immutable experiment declarations reject authority claims and raw execution policy", () => {
  for (const forbidden of [
    { assignment_arm: "candidate" },
    { assignment_randomness_sha256: "a".repeat(64) },
    { diagnostic_assignment_seed: "secret" },
    { confirmatory_assignment_bits: "secret" },
    { collection_class: "eligible_host" },
    { external_execution_policy: { roles: {} } },
  ]) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(immutableExperiment(forbidden)),
      ])),
      /unrecognized key|invalid/i,
    );
  }
});

test("immutable experiment declarations enforce the profile ceiling and gate-policy phase matrix", () => {
  const invalidProfiles = [
    experimentProfile(immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
    }), { mode: "shadow" }),
    experimentProfile(immutableExperiment({ evidence_intent: "confirmatory" })),
    experimentProfile(immutableExperiment({ assignment_design: "matched_pair_complete_randomization_v1" })),
    experimentProfile(immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      candidate_allocation_bps: 4000,
    })),
    experimentProfile(immutableExperiment({ safety_pause_mode: "manual" })),
  ];
  for (const profile of invalidProfiles) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([profile])),
      /shadow|evidence|assignment|5000|automatic/i,
    );
  }
});

test("immutable experiment declarations require canonical policy tuples and four distinct evidence series", () => {
  for (const experiment of [
    immutableExperiment({ revision: 0 }),
    immutableExperiment({ candidate_policy_version: "unknown" }),
    immutableExperiment({ gate_policy_version: "v2" }),
    immutableExperiment({
      required_evidence_series: {
        offline_paired: "same-series",
        production_shadow: "same-series",
        tool_e2e: "series-tool-v1",
        runtime_integrity: "series-runtime-v1",
      },
    }),
  ]) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(experiment),
      ])),
      /revision|candidate|gate|distinct|literal/i,
    );
  }
});

test("collection source declarations bind canonical verifier allowlists and unique principal fingerprints", () => {
  const base = immutableExperiment();
  const source = (base.collection_sources as Array<Record<string, unknown>>)[0]!;
  const verifierPolicy = source.allowed_verifiers as Array<Record<string, unknown>>;
  const secondVerifier = {
    kind: "instrumented_agent_trace",
    version: "trace-v1",
    config_sha256: "2".repeat(64),
  };
  const unsortedVerifiers = [secondVerifier, ...verifierPolicy];
  const secondSource = {
    ...source,
    principal_sha256: "b".repeat(64),
  };
  const sourceWithVerifierVersion = (version: string) => {
    const allowedVerifiers = [{ ...verifierPolicy[0]!, version }];
    return {
      ...source,
      allowed_verifiers: allowedVerifiers,
      verifier_policy_sha256: digest({ allowed_verifiers: allowedVerifiers }),
    };
  };
  assert.doesNotThrow(() => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
    experimentProfile(immutableExperiment({
      collection_sources: [sourceWithVerifierVersion("界".repeat(40))],
    })),
  ])));
  assert.throws(
    () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
      experimentProfile(immutableExperiment({
        collection_sources: [sourceWithVerifierVersion("界".repeat(41))],
      })),
    ])),
    /120 UTF-8 bytes|verifier version/i,
  );
  for (const collectionSources of [
    [{ ...source, api_key: "must-not-be-configured" }],
    [{ ...source, class: "caller_selected" }],
    [{ ...source, collector_id: "" }],
    [{ ...source, verifier_policy_sha256: "f".repeat(64) }],
    [{
      ...source,
      allowed_verifiers: unsortedVerifiers,
      verifier_policy_sha256: digest({ allowed_verifiers: unsortedVerifiers }),
    }],
    [source, { ...source, collector_id: "duplicate-principal" }],
    [secondSource, source],
  ]) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(immutableExperiment({ collection_sources: collectionSources })),
      ])),
      /unrecognized key|class|collector|verifier|duplicate|principal|canonical/i,
    );
  }
});

test("one experiment revision cannot drift across profile declarations", () => {
  assert.throws(
    () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
      experimentProfile(),
      experimentProfile(immutableExperiment({ candidate_allocation_bps: 4500 }), {
        profile_id: "same-revision-drift",
        task_families: ["another-task-family"],
      }),
    ])),
    /experiment revision configuration drift/i,
  );
  assert.throws(
    () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
      experimentProfile(),
      experimentProfile(immutableExperiment(), {
        profile_id: "same-experiment-different-profile",
        task_families: ["another-task-family"],
      }),
    ])),
    /experiment revision configuration drift/i,
  );
});

test("lite recall engine can opt into hybrid explicitly", async () => {
  await withIsolatedEnv(
    {
      RECALL_ENGINE_MODE: "hybrid",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_EDITION, "lite");
      assert.equal(env.RECALL_ENGINE_MODE, "hybrid");
    },
  );
});

test("lite plus prod fails with an explicit posture error", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      APP_ENV: "prod",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Lite runtime does not currently support APP_ENV=prod; use APP_ENV=dev\/ci\./i,
      );
    },
  );
});

test("lite unauthenticated remote bind requires explicit operator opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_LISTEN_HOST: "0.0.0.0",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /AIONIS_LISTEN_HOST exposes an unauthenticated Lite Runtime/i,
      );
    },
  );
});

test("lite unauthenticated remote bind can be intentionally enabled", async () => {
  await withIsolatedEnv(
    {
      AIONIS_LISTEN_HOST: "0.0.0.0",
      AIONIS_ALLOW_UNAUTHENTICATED_REMOTE: "true",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_LISTEN_HOST, "0.0.0.0");
      assert.equal(env.AIONIS_ALLOW_UNAUTHENTICATED_REMOTE, true);
      assert.equal(env.MEMORY_AUTH_MODE, "off");
    },
  );
});

test("lite edition rejects service mode posture", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "service",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Aionis Lite requires AIONIS_MODE=local/i,
      );
    },
  );
});
