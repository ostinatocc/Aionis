import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authorityArtifactPublicKeySha256,
  buildSignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import type { Sha256 } from "../../src/continuation/contract.js";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import { executeContinuationRuntimeV1Provisioning } from
  "../../src/runtime-v1/provisioning-composition.js";

const TENANT = "tenant-provisioning";
const SCOPE = "scope-provisioning";
const TASK_FAMILY = "coding";
const OPERATOR = "1".repeat(64) as Sha256;
const HOST = "2".repeat(64) as Sha256;
const VERIFIER = "3".repeat(64) as Sha256;
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: TASK_FAMILY,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-provisioning-composition-"));
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPath = join(root, "authority-root.public.pem");
  writeFileSync(
    publicKeyPath,
    keys.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o600 },
  );
  const trustRootSha256 = authorityArtifactPublicKeySha256(keys.publicKey);
  const compilerPayload = buildContinuationCompilerPolicyV1({
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    candidate_limit: 128,
    continuity_candidate_limit: 64,
    learning_candidate_limit: 64,
    selected_capsule_limit: 64,
    obligation_limit: 64,
    max_render_budget: 65_536,
    hard_coverage_weight: 1_000_000,
    advisory_coverage_weight: 10_000,
    authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
    freshness_bonus: [0, 2, 4, 8],
    freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
    trusted_observer_principals: {
      trusted_host_collector: [HOST],
      external_verifier: [VERIFIER],
    },
  });
  const evidencePayload = buildEffectEvidencePolicyV1({
    schema_version: "effect_evidence_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    trusted_effect_verifier_principals: [VERIFIER],
    max_eligible_decisions: 256,
    max_treatment_delta_count: 32,
    min_evidence_window_ms: 60_000,
    max_evidence_window_ms: 86_400_000,
    min_control_exposures: 10,
    min_candidate_exposures: 10,
    max_missingness_bps: 0,
    harm_noninferiority_margin_bps: 0,
    utility_min_lift_bps: 1,
    confidence_bps: 9_000,
    effect_verifier_contract_sha256: EFFECT_VERIFIER_CONTRACT_SHA256_V1,
    statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  });
  const common = {
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    valid_from: "2026-07-21T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-20T00:00:00.000Z",
  } as const;
  const compiler = buildSignedAuthorityArtifactV1({
    ...common,
    artifact_id: "compiler-main",
    artifact_revision: 1,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    payload: compilerPayload,
  }, keys.privateKey);
  const evidence = buildSignedAuthorityArtifactV1({
    ...common,
    artifact_id: "evidence-main",
    artifact_revision: 1,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    payload: evidencePayload,
  }, keys.privateKey);
  const environment = {
    AIONIS_DATA_PATH: join(root, "authority", "runtime.sqlite"),
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: publicKeyPath,
    AIONIS_TRUST_ROOT_SHA256: trustRootSha256,
  };
  const command = {
    schema_version: "offline_provisioning_command_v1",
    kind: "policy_bundle_install",
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: TASK_FAMILY,
    operation_id: "install-policy-bundle-1",
    actor_kind: "operator",
    actor_principal_sha256: OPERATOR,
    authority_subject_sha256: SUBJECT,
    policy_bundle: {
      schema_version: "authority_policy_provisioning_bundle_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      compiler_policy: compiler,
      evidence_policy: evidence,
    },
  } as const;
  return { root, environment, command };
}

test("one-shot provisioning composition installs and replays one root-signed policy bundle", async () => {
  const current = fixture();
  try {
    const created = await executeContinuationRuntimeV1Provisioning(
      current.environment,
      current.command,
      null,
    );
    assert.equal(created.operation.status, "created");
    assert.equal(created.operation.receipt.result.schema_version,
      "authority_decision_result_v1");
    assert.equal(created.operation.receipt.result.decision_kind,
      "policy_bundle_install");
    assert.equal(created.publicConfig.assignmentSeedFdConfigured, false);
    assert.equal("dataPath" in created.publicConfig, false);
    assert.equal("trustRootPublicKeyPath" in created.publicConfig, false);

    const replayed = await executeContinuationRuntimeV1Provisioning(
      current.environment,
      current.command,
      null,
    );
    assert.equal(replayed.operation.status, "replayed");
    assert.equal(replayed.operation.receipt_sha256, created.operation.receipt_sha256);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("provisioning composition keeps cohort seed outside command JSON and rejects channel confusion", async () => {
  const current = fixture();
  try {
    await assert.rejects(
      executeContinuationRuntimeV1Provisioning(
        current.environment,
        { ...current.command, assignment_seed: Array(32).fill(7) },
        null,
      ),
      /assignment_seed_in_command_forbidden/u,
    );
    await assert.rejects(
      executeContinuationRuntimeV1Provisioning(
        { ...current.environment, AIONIS_PROVISIONING_SEED_FD: "3" },
        current.command,
        null,
      ),
      /assignment_seed_channel_mismatch/u,
    );
    await assert.rejects(
      executeContinuationRuntimeV1Provisioning(
        current.environment,
        current.command,
        Buffer.alloc(32, 7),
      ),
      /assignment_seed_channel_mismatch/u,
    );
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});
