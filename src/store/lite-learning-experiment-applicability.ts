import stableStringify from "fast-json-stable-stringify";

import {
  LearningExperimentApplicabilityManifestV1Schema,
  LearningExperimentApplicabilityProfileProjectionV1Schema,
  LearningExperimentProvisionReceiptV1Schema,
  assertLearningExperimentApplicabilityManifestSafe,
  learningExperimentApplicabilityManifestDigest,
  parseStoredLearningCollectionSourcePolicyV1,
  type LearningExperimentApplicabilityManifestV1,
  type LearningExperimentConfirmatoryApplicabilityCohortV1,
  type LearningExperimentProvisionReceiptV1,
} from "../memory/learning-experiment-provisioning.js";
import { sha256Hex } from "../util/crypto.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";
import type { SqliteDatabase } from "./sqlite.js";

function canonicalJsonObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "string") throw new Error(`${field} must be canonical JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || stableStringify(parsed) !== raw) {
    throw new Error(`${field} must be a canonical JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredRowString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing persisted ${field}`);
  return value;
}

function requiredRowInteger(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`missing persisted ${field}`);
  return value;
}

export function buildConfirmatoryApplicabilityCohort(args: {
  attempt: LiteLearningAuthorityRow;
  pairs: readonly LiteLearningAuthorityRow[];
  leases: readonly LiteLearningAuthorityRow[];
}): LearningExperimentConfirmatoryApplicabilityCohortV1 {
  const leaseByPairMember = new Map(args.leases.map((lease) => [
    `${String(lease.randomization_pair_sha256)}\u0000${String(lease.pair_member_ordinal)}`,
    lease,
  ]));
  const pairs = args.pairs.map((pair) => ({
    pair_ordinal: requiredRowInteger(pair, "pair_ordinal"),
    randomization_pair_sha256: requiredRowString(pair, "randomization_pair_sha256"),
    pair_record_sha256: requiredRowString(pair, "pair_record_sha256"),
    matching_covariate_sha256: requiredRowString(pair, "matching_covariate_sha256"),
    activation_wave_index: requiredRowInteger(pair, "activation_wave_index") as 1 | 2 | 3,
    activation_starts_at: requiredRowString(pair, "activation_starts_at"),
    index_window_ends_at: requiredRowString(pair, "index_window_ends_at"),
    wave_analysis_at: requiredRowString(pair, "wave_analysis_at"),
    members: ([0, 1] as const).map((pairMemberOrdinal) => {
      const lease = leaseByPairMember.get(
        `${String(pair.randomization_pair_sha256)}\u0000${String(pairMemberOrdinal)}`,
      );
      if (!lease) throw new Error("learning_experiment_applicability_lease_missing");
      return {
        pair_member_ordinal: pairMemberOrdinal,
        memory_namespace_sha256: requiredRowString(lease, "memory_namespace_sha256"),
        namespace_lease_id_sha256: sha256Hex(requiredRowString(lease, "namespace_lease_id")),
        namespace_lease_generation: requiredRowInteger(lease, "lease_generation"),
      };
    }) as [
      {
        pair_member_ordinal: 0;
        memory_namespace_sha256: string;
        namespace_lease_id_sha256: string;
        namespace_lease_generation: number;
      },
      {
        pair_member_ordinal: 1;
        memory_namespace_sha256: string;
        namespace_lease_id_sha256: string;
        namespace_lease_generation: number;
      },
    ],
  }));
  return {
    contract_version: "aionis_learning_confirmatory_applicability_cohort_v1",
    confirmatory_attempt_id: requiredRowString(args.attempt, "confirmatory_attempt_id"),
    confirmatory_attempt_sha256: requiredRowString(args.attempt, "attempt_sha256"),
    eligible_memory_namespace_set_sha256: requiredRowString(
      args.attempt,
      "eligible_memory_namespace_set_sha256",
    ),
    eligible_memory_namespace_count: 768,
    randomization_pair_manifest_sha256: requiredRowString(
      args.attempt,
      "randomization_pair_manifest_sha256",
    ),
    randomization_pair_count: 384,
    activation_schedule_sha256: requiredRowString(args.attempt, "activation_schedule_sha256"),
    namespace_lease_membership_sha256: sha256Hex(stableStringify({
      contract_version: "aionis_learning_namespace_lease_membership_v1",
      members: pairs.flatMap((pair) => pair.members.map((member) => ({
        pair_ordinal: pair.pair_ordinal,
        randomization_pair_sha256: pair.randomization_pair_sha256,
        pair_member_ordinal: member.pair_member_ordinal,
        memory_namespace_sha256: member.memory_namespace_sha256,
        namespace_lease_id_sha256: member.namespace_lease_id_sha256,
        namespace_lease_generation: member.namespace_lease_generation,
        activation_wave_index: pair.activation_wave_index,
      }))),
    })),
    namespace_lease_count: 768,
    pairs,
  };
}

export function buildApplicabilityManifestFromDatabase(args: {
  db: SqliteDatabase;
  tenantId: string;
  experimentId: string;
  experimentRevision: number;
}): LearningExperimentApplicabilityManifestV1 {
  const revision = args.db.prepare(
    `SELECT * FROM lite_learning_experiment_revisions
     WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
  ).get(args.tenantId, args.experimentId, args.experimentRevision) as
    Record<string, unknown> | undefined;
  if (!revision) throw new Error("learning_experiment_provision_receipt_revision_missing");
  const config = canonicalJsonObject(revision.config_json, "persisted experiment config");
  const sourcePolicy = parseStoredLearningCollectionSourcePolicyV1(
    canonicalJsonObject(
      revision.collection_source_policy_json,
      "persisted collection source policy",
    ),
    config,
  );
  if (sha256Hex(stableStringify(sourcePolicy)) !== revision.collection_source_policy_sha256) {
    throw new Error("persisted collection source policy digest mismatch");
  }
  const profile = LearningExperimentApplicabilityProfileProjectionV1Schema.parse(
    config.applicability_profile_projection,
  );
  if (profile.profile_id !== revision.profile_id) {
    throw new Error("persisted applicability profile does not match the experiment revision");
  }
  const declarationSha256 = config.experiment_declaration_sha256;
  if (typeof declarationSha256 !== "string") {
    throw new Error("persisted experiment config lacks declaration digest");
  }
  const rawSources = sourcePolicy.collection_sources;
  if (!Array.isArray(rawSources)) throw new Error("persisted collection source policy is invalid");
  const collectionSources = rawSources.map((rawSource) => {
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
      throw new Error("persisted collection source entry is invalid");
    }
    const source = rawSource as Record<string, unknown>;
    const principalSha256 = requiredRowString(source, "principal_sha256");
    const binding = args.db.prepare(
      `SELECT * FROM lite_learning_collection_principal_bindings
       WHERE tenant_id = ? AND collection_principal_sha256 = ?`,
    ).get(args.tenantId, principalSha256) as Record<string, unknown> | undefined;
    if (!binding
      || binding.collection_class !== source.class
      || binding.collector_id !== source.collector_id
      || binding.collector_version !== source.collector_version
      || binding.verifier_policy_sha256 !== source.verifier_policy_sha256) {
      throw new Error("persisted collection principal binding drift");
    }
    return {
      collection_principal_sha256: principalSha256,
      collection_class: binding.collection_class,
      collector_id: binding.collector_id,
      collector_version: binding.collector_version,
      verifier_policy_sha256: binding.verifier_policy_sha256,
      binding_sha256: binding.binding_sha256,
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(String(left.collection_principal_sha256), "utf8"),
    Buffer.from(String(right.collection_principal_sha256), "utf8"),
  ));
  const identity = args.db.prepare(
    "SELECT database_instance_id FROM lite_runtime_authority_identity WHERE singleton = 1",
  ).get() as { database_instance_id: string } | undefined;
  if (!identity) throw new Error("learning experiment Runtime authority identity is missing");
  const common = {
    contract_version: "aionis_learning_experiment_applicability_manifest_v1",
    tenant_id: args.tenantId,
    provision_operation_id_sha256: requiredRowString(
      config,
      "provision_operation_id_sha256",
    ),
    provision_request_sha256: requiredRowString(config, "provision_request_sha256"),
    provisioning_actor_sha256: requiredRowString(config, "provisioning_actor_sha256"),
    runtime_authority_lineage_sha256: sha256Hex(identity.database_instance_id),
    experiment_id: args.experimentId,
    experiment_revision: args.experimentRevision,
    profile_rule_sha256: requiredRowString(revision, "profile_rule_sha256"),
    experiment_declaration_sha256: declarationSha256,
    experiment_config_sha256: requiredRowString(revision, "config_sha256"),
    serving_phase: revision.serving_phase,
    evidence_intent: revision.evidence_intent,
    assignment_design: revision.assignment_design,
    task_family: requiredRowString(config, "task_family"),
    profile,
    policy_bindings: {
      candidate_policy_config_sha256: requiredRowString(revision, "candidate_policy_config_sha256"),
      candidate_policy_implementation_sha256: requiredRowString(
        revision,
        "candidate_policy_implementation_sha256",
      ),
      gate_policy_config_sha256: requiredRowString(revision, "gate_policy_config_sha256"),
      gate_prospective_calibration_sha256: requiredRowString(
        revision,
        "gate_prospective_calibration_sha256",
      ),
      collection_source_policy_sha256: requiredRowString(revision, "collection_source_policy_sha256"),
      required_evidence_series_sha256: requiredRowString(revision, "required_evidence_series_sha256"),
      required_external_inputs_sha256: requiredRowString(revision, "required_external_inputs_sha256"),
      external_execution_policy_sha256: requiredRowString(revision, "external_execution_policy_sha256"),
    },
    diagnostic_assignment_seed_sha256: requiredRowString(
      revision,
      "diagnostic_assignment_seed_sha256",
    ),
    collection_sources: collectionSources,
    provisioned_at: requiredRowString(revision, "created_at"),
  } as const;
  let manifest: LearningExperimentApplicabilityManifestV1;
  if (revision.evidence_intent === "integrity_only") {
    manifest = LearningExperimentApplicabilityManifestV1Schema.parse({
      ...common,
      cohort: null,
    });
  } else if (revision.evidence_intent === "confirmatory") {
    const attempt = args.db.prepare(
      `SELECT * FROM lite_learning_confirmatory_attempts
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(args.tenantId, args.experimentId, args.experimentRevision) as
      LiteLearningAuthorityRow | undefined;
    if (!attempt) throw new Error("learning_experiment_confirmatory_attempt_missing");
    const pairs = args.db.prepare(
      `SELECT * FROM lite_learning_randomization_pairs
       WHERE tenant_id = ? AND confirmatory_attempt_id = ?
       ORDER BY pair_ordinal`,
    ).all(args.tenantId, attempt.confirmatory_attempt_id) as LiteLearningAuthorityRow[];
    const leases = args.db.prepare(
      `SELECT * FROM lite_learning_namespace_leases
       WHERE tenant_id = ? AND confirmatory_attempt_id = ?
       ORDER BY randomization_pair_sha256, pair_member_ordinal`,
    ).all(args.tenantId, attempt.confirmatory_attempt_id) as LiteLearningAuthorityRow[];
    const cohort = buildConfirmatoryApplicabilityCohort({ attempt, pairs, leases });
    manifest = LearningExperimentApplicabilityManifestV1Schema.parse({
      ...common,
      memory_namespace_manifest_sha256: requiredRowString(
        config,
        "memory_namespace_manifest_sha256",
      ),
      external_input_set_sha256: requiredRowString(config, "external_input_set_sha256"),
      tenant_scope_encoding_sha256: requiredRowString(config, "tenant_scope_encoding_sha256"),
      confirmatory_assignment_bits_sha256: requiredRowString(
        revision,
        "confirmatory_assignment_bits_sha256",
      ),
      cohort,
    });
  } else {
    throw new Error("learning_experiment_evidence_intent_invalid");
  }
  assertLearningExperimentApplicabilityManifestSafe(manifest);
  return manifest;
}

export function resolveProtectedApplicabilityAuthorityFromDatabase(args: {
  db: SqliteDatabase;
  tenantId: string;
  experimentId: string;
  experimentRevision: number;
}): Readonly<{
  manifest: LearningExperimentApplicabilityManifestV1;
  manifestSha256: string;
  provisionReceipt: LearningExperimentProvisionReceiptV1;
}> {
  const manifest = buildApplicabilityManifestFromDatabase(args);
  const operations = args.db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id
     FROM lite_runtime_write_operations
     WHERE tenant_id = ?
       AND scope = 'learning-experiment-authority-v1'
       AND operation_kind = 'learning_experiment_provision_v1'`,
  ).all(args.tenantId) as Array<Record<string, unknown>>;
  const candidates = operations.filter((operation) => (
    typeof operation.operation_id === "string"
    && sha256Hex(operation.operation_id) === manifest.provision_operation_id_sha256
  ));
  if (candidates.length !== 1) {
    throw new Error("learning experiment protected provisioning authority is missing or ambiguous");
  }
  const operation = candidates[0]!;
  if (typeof operation.receipt_json !== "string") {
    throw new Error("learning experiment protected provisioning receipt is missing");
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(operation.receipt_json);
  } catch {
    throw new Error("learning experiment protected provisioning receipt is invalid JSON");
  }
  const provisionReceipt = LearningExperimentProvisionReceiptV1Schema.parse(rawReceipt);
  if (stableStringify(provisionReceipt) !== operation.receipt_json) {
    throw new Error("learning experiment protected provisioning receipt is not canonical");
  }
  const manifestSha256 = learningExperimentApplicabilityManifestDigest(manifest);
  if (operation.tenant_id !== args.tenantId
    || operation.scope !== "learning-experiment-authority-v1"
    || operation.operation_kind !== "learning_experiment_provision_v1"
    || operation.operation_id !== provisionReceipt.operation_id
    || operation.request_sha256 !== provisionReceipt.request_sha256
    || operation.commit_id !== null
    || provisionReceipt.tenant_id !== args.tenantId
    || provisionReceipt.authority_scope !== "learning-experiment-authority-v1"
    || provisionReceipt.operation_kind !== "learning_experiment_provision_v1"
    || provisionReceipt.experiment.experiment_id !== args.experimentId
    || provisionReceipt.experiment.experiment_revision !== args.experimentRevision
    || provisionReceipt.experiment.experiment_config_sha256 !== manifest.experiment_config_sha256
    || stableStringify(provisionReceipt.applicability_manifest) !== stableStringify(manifest)
    || provisionReceipt.applicability_manifest_sha256 !== manifestSha256) {
    throw new Error("learning experiment protected provisioning authority mismatch");
  }
  return { manifest, manifestSha256, provisionReceipt };
}
