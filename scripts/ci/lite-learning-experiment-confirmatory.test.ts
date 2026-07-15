import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import stableStringify from "fast-json-stable-stringify";

import {
  LearningExperimentExternalInputSetV1Schema,
  LearningMemoryNamespaceManifestV1Schema,
} from
  "../../src/memory/learning-experiment-provisioning.js";
import {
  LearningExperimentProvisioningError,
  createLiteLearningExperimentProvisioner,
} from "../../src/store/lite-learning-experiment-provisioning.js";
import { createLiteLearningEpisodeLedgerAccess } from
  "../../src/store/lite-learning-episode-ledger.js";
import { LiteTenantScopeAuthorityError } from
  "../../src/store/lite-tenant-scope-authority.js";
import {
  CONFIRMATORY_DEFAULT_TENANT_ID,
  CONFIRMATORY_EXPERIMENT_ID,
  CONFIRMATORY_EXPERIMENT_REVISION,
  CONFIRMATORY_NOW,
  CONFIRMATORY_RAW_COVARIATE_MARKER,
  CONFIRMATORY_RAW_SCOPE_MARKER,
  createConfirmatoryPassedRegistry,
  createConfirmatoryExternalInputSet,
  createConfirmatoryNamespaceManifest,
  createConfirmatoryProvisionInput,
  ensureConfirmatoryTenantScopeAnchor,
  openConfirmatoryFixtureRuntime,
  seedConfirmatoryPriorScopes,
  sha256,
  type ConfirmatoryFixtureRuntime,
} from "./support/learning-experiment-confirmatory-fixture.js";

const CHILD_PATH = fileURLToPath(new URL(
  "./support/learning-experiment-confirmatory-child.ts",
  import.meta.url,
));

function tempDatabase(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-confirmatory-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function count(runtime: ConfirmatoryFixtureRuntime, table: string): number {
  const row = runtime.database.db.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get() as { count: number };
  return Number(row.count);
}

function createProvisioner(
  runtime: ConfirmatoryFixtureRuntime,
  randomBytes: (size: number) => Uint8Array,
  defaultTenantId = CONFIRMATORY_DEFAULT_TENANT_ID,
) {
  return createLiteLearningExperimentProvisioner({
    database: runtime.database,
    writeStore: runtime.writeStore,
    dependencies: {
      registry: createConfirmatoryPassedRegistry(),
      defaultTenantId,
      now: () => CONFIRMATORY_NOW,
      randomBytes,
    },
  });
}

function createConfirmatoryProvisionInputForTenant(tenantId: string) {
  const namespaceManifest = createConfirmatoryNamespaceManifest();
  const memoryNamespaceManifest = LearningMemoryNamespaceManifestV1Schema.parse({
    ...namespaceManifest,
    tenant_id: tenantId,
    pairs: namespaceManifest.pairs.map((pair) => ({
      ...pair,
      members: pair.members.map((member) => ({ ...member, tenant_id: tenantId })),
    })),
  });
  const externalInputSet = LearningExperimentExternalInputSetV1Schema.parse({
    ...createConfirmatoryExternalInputSet(),
    tenant_id: tenantId,
  });
  return createConfirmatoryProvisionInput({
    tenantId,
    memoryNamespaceManifest,
    externalInputSet,
  });
}

function assertConfirmatoryAuthorityCounts(runtime: ConfirmatoryFixtureRuntime): void {
  assert.equal(count(runtime, "lite_memory_commits"), 768);
  assert.equal(count(runtime, "lite_learning_policy_versions"), 3);
  assert.equal(count(runtime, "lite_learning_collection_principal_bindings"), 1);
  assert.equal(count(runtime, "lite_learning_experiment_revisions"), 1);
  assert.equal(count(runtime, "lite_learning_confirmatory_attempts"), 1);
  assert.equal(count(runtime, "lite_learning_randomization_pairs"), 384);
  assert.equal(count(runtime, "lite_learning_namespace_leases"), 768);
  assert.equal(count(runtime, "lite_runtime_write_operations"), 1);
}

function assertConfirmatoryAuthorityRolledBack(runtime: ConfirmatoryFixtureRuntime): void {
  assert.equal(count(runtime, "lite_memory_commits"), 768);
  for (const table of [
    "lite_learning_policy_versions",
    "lite_learning_collection_principal_bindings",
    "lite_learning_experiment_revisions",
    "lite_learning_confirmatory_attempts",
    "lite_learning_randomization_pairs",
    "lite_learning_namespace_leases",
    "lite_runtime_write_operations",
  ]) {
    assert.equal(count(runtime, table), 0, `${table} must roll back atomically`);
  }
}

function forbiddenManifestKeys(value: unknown): string[] {
  const forbidden = new Set([
    "assigned_arm",
    "confirmatory_assignment_bits",
    "diagnostic_assignment_seed",
    "public_scope",
    "store_scope",
  ]);
  const found: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (forbidden.has(key)) found.push(key);
      pending.push(child);
    }
  }
  return found.sort();
}

test("tenant-scope anchor is immutable and exact-replays on a fresh Runtime database", async () => {
  const temp = tempDatabase("tenant-anchor-fresh");
  try {
    const runtime = openConfirmatoryFixtureRuntime(temp.path);
    try {
      const fresh = await ensureConfirmatoryTenantScopeAnchor(runtime);
      const replay = await ensureConfirmatoryTenantScopeAnchor(runtime);
      assert.equal(fresh.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.anchor, fresh.anchor);
      assert.equal(fresh.anchor.defaultTenantId, CONFIRMATORY_DEFAULT_TENANT_ID);
      assert.equal(count(runtime, "lite_learning_policy_versions"), 1);
      assert.throws(
        () => runtime.database.db.prepare(
          `UPDATE lite_learning_policy_versions SET tenant_id = 'changed-default'
           WHERE policy_id = 'aionis.runtime.tenant_scope_encoding_anchor'`,
        ).run(),
        /update_forbidden/u,
      );
      assert.throws(
        () => runtime.database.db.prepare(
          `DELETE FROM lite_learning_policy_versions
           WHERE policy_id = 'aionis.runtime.tenant_scope_encoding_anchor'`,
        ).run(),
        /delete_forbidden/u,
      );
      await createLiteLearningEpisodeLedgerAccess(runtime.database).verifyIntegrity();
      await assert.rejects(
        runtime.database.transaction.run(async () => {
          runtime.database.db.prepare(
            `INSERT INTO lite_learning_policy_versions
               (tenant_id, policy_kind, policy_id, policy_version,
                policy_config_sha256, policy_config_json,
                implementation_contract_sha256,
                prospective_calibration_sha256, prospective_calibration_json,
                created_at)
             SELECT 'duplicate-default', policy_kind, policy_id, policy_version,
                    policy_config_sha256, policy_config_json,
                    implementation_contract_sha256,
                    prospective_calibration_sha256, prospective_calibration_json,
                    created_at
             FROM lite_learning_policy_versions
             WHERE policy_id = 'aionis.runtime.tenant_scope_encoding_anchor'
               AND policy_version = 'v1'`,
          ).run();
          createLiteLearningEpisodeLedgerAccess(runtime.database);
        }),
        (error: unknown) => {
          assert.ok(error instanceof LiteTenantScopeAuthorityError);
          assert.equal(error.code, "lite_tenant_scope_anchor_corrupt");
          return true;
        },
      );
      assert.equal(count(runtime, "lite_learning_policy_versions"), 1);
      await createLiteLearningEpisodeLedgerAccess(runtime.database).verifyIntegrity();
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("legacy unprefixed memory without an anchor cannot be auto-claimed", async () => {
  const temp = tempDatabase("tenant-anchor-legacy");
  const tenantId = "tenant-anchor-legacy";
  const input = createConfirmatoryProvisionInputForTenant(tenantId);
  const entropySizes: number[] = [];
  try {
    const runtime = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await seedConfirmatoryPriorScopes(runtime, input.memoryNamespaceManifest, tenantId);
      await assert.rejects(
        createProvisioner(runtime, (size) => {
          entropySizes.push(size);
          return new Uint8Array(size);
        }, tenantId).provision(input),
        (error: unknown) => {
          assert.ok(error instanceof LearningExperimentProvisioningError);
          assert.equal(
            error.code,
            "learning_experiment_tenant_scope_anchor_missing_for_existing_unprefixed_memory",
          );
          return true;
        },
      );
      assert.deepEqual(entropySizes, []);
      assert.equal(count(runtime, "lite_memory_commits"), 768);
      assert.equal(count(runtime, "lite_learning_policy_versions"), 0);
      assert.equal(count(runtime, "lite_learning_experiment_revisions"), 0);
      assert.equal(count(runtime, "lite_learning_confirmatory_attempts"), 0);
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("changing the default tenant cannot alias an anchored unprefixed memory cohort", async () => {
  const temp = tempDatabase("tenant-anchor-alias");
  const originalDefaultTenantId = "tenant-anchor-a";
  const changedDefaultTenantId = "tenant-anchor-b";
  const originalInput = createConfirmatoryProvisionInputForTenant(originalDefaultTenantId);
  const changedInput = createConfirmatoryProvisionInputForTenant(changedDefaultTenantId);
  const entropySizes: number[] = [];
  try {
    const runtime = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await ensureConfirmatoryTenantScopeAnchor(runtime, originalDefaultTenantId);
      await seedConfirmatoryPriorScopes(
        runtime,
        originalInput.memoryNamespaceManifest,
        originalDefaultTenantId,
      );
      const unprefixed = runtime.database.db.prepare(
        `SELECT COUNT(*) AS count FROM lite_memory_commits
         WHERE substr(scope, 1, 7) <> 'tenant:'`,
      ).get() as { count: number };
      assert.equal(Number(unprefixed.count), 768);
      await assert.rejects(
        createProvisioner(runtime, (size) => {
          entropySizes.push(size);
          return new Uint8Array(size);
        }, changedDefaultTenantId).provision(changedInput),
        (error: unknown) => {
          assert.ok(error instanceof LearningExperimentProvisioningError);
          assert.equal(error.code, "learning_experiment_tenant_scope_anchor_mismatch");
          return true;
        },
      );
      assert.deepEqual(entropySizes, []);
      assert.equal(count(runtime, "lite_learning_policy_versions"), 1);
      assert.equal(count(runtime, "lite_learning_experiment_revisions"), 0);
      assert.equal(count(runtime, "lite_learning_confirmatory_attempts"), 0);
      assert.equal(count(runtime, "lite_learning_namespace_leases"), 0);
      await createLiteLearningEpisodeLedgerAccess(runtime.database).verifyIntegrity();
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("programmatic confirmatory provision rejects tenant-prefixed scope overflow before authority or entropy", async () => {
  const temp = tempDatabase("scope-encoding-overflow");
  const rawManifest = createConfirmatoryNamespaceManifest();
  rawManifest.pairs[383]!.members[0]!.public_scope = `${"z".repeat(230)}0`;
  rawManifest.pairs[383]!.members[1]!.public_scope = `${"z".repeat(230)}1`;
  const memoryNamespaceManifest = LearningMemoryNamespaceManifestV1Schema.parse(rawManifest);
  const entropySizes: number[] = [];
  try {
    const runtime = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await assert.rejects(
        createProvisioner(runtime, (size) => {
          entropySizes.push(size);
          return new Uint8Array(size);
        }).provision(createConfirmatoryProvisionInput({ memoryNamespaceManifest })),
        (error: unknown) => {
          assert.ok(error instanceof LearningExperimentProvisioningError);
          assert.equal(error.code, "learning_experiment_namespace_scope_encoding_invalid");
          return true;
        },
      );
      assert.deepEqual(entropySizes, []);
      for (const table of [
        "lite_learning_policy_versions",
        "lite_learning_collection_principal_bindings",
        "lite_learning_experiment_revisions",
        "lite_learning_confirmatory_attempts",
        "lite_learning_randomization_pairs",
        "lite_learning_namespace_leases",
        "lite_runtime_write_operations",
      ]) {
        assert.equal(count(runtime, table), 0, `${table} must remain empty`);
      }
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("synthetic registered confirmatory provision persists the full MSB-first authority and safe DB manifest", async () => {
  const temp = tempDatabase("success-msb");
  const diagnosticSeed = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
  const assignmentBits = new Uint8Array(48).fill(0xab);
  assignmentBits[0] = 0x80;
  assignmentBits[1] = 0x01;
  assignmentBits[47] = 0x80;
  const entropySizes: number[] = [];
  let manifestJson = "";
  let receiptJson = "";
  try {
    const runtime = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await seedConfirmatoryPriorScopes(runtime);
      const provisioner = createProvisioner(runtime, (size) => {
        entropySizes.push(size);
        if (size === 32) return diagnosticSeed;
        if (size === 48) return assignmentBits;
        throw new Error(`unexpected entropy request: ${String(size)}`);
      });
      const result = await provisioner.provision(createConfirmatoryProvisionInput());
      assert.equal(result.replayed, false);
      assert.deepEqual(entropySizes, [32, 48]);
      assertConfirmatoryAuthorityCounts(runtime);

      const revision = runtime.database.db.prepare(
        `SELECT diagnostic_assignment_seed, confirmatory_assignment_bits,
                confirmatory_assignment_bit_count, confirmatory_assignment_bits_sha256,
                config_json
         FROM lite_learning_experiment_revisions`,
      ).get() as {
        diagnostic_assignment_seed: Uint8Array;
        confirmatory_assignment_bits: Uint8Array;
        confirmatory_assignment_bit_count: number;
        confirmatory_assignment_bits_sha256: string;
        config_json: string;
      };
      assert.deepEqual(Buffer.from(revision.diagnostic_assignment_seed), Buffer.from(diagnosticSeed));
      assert.deepEqual(Buffer.from(revision.confirmatory_assignment_bits), Buffer.from(assignmentBits));
      assert.equal(revision.confirmatory_assignment_bit_count, 384);
      assert.equal(revision.confirmatory_assignment_bits_sha256, sha256(assignmentBits));

      const pairWaves = runtime.database.db.prepare(
        `SELECT activation_wave_index, COUNT(*) AS count
         FROM lite_learning_randomization_pairs
         GROUP BY activation_wave_index ORDER BY activation_wave_index`,
      ).all() as Array<{ activation_wave_index: number; count: number }>;
      assert.deepEqual(pairWaves.map((row) => ({ ...row })), [
        { activation_wave_index: 1, count: 96 },
        { activation_wave_index: 2, count: 96 },
        { activation_wave_index: 3, count: 192 },
      ]);
      const leaseWaves = runtime.database.db.prepare(
        `SELECT activation_wave_index, COUNT(*) AS count
         FROM lite_learning_namespace_leases
         GROUP BY activation_wave_index ORDER BY activation_wave_index`,
      ).all() as Array<{ activation_wave_index: number; count: number }>;
      assert.deepEqual(leaseWaves.map((row) => ({ ...row })), [
        { activation_wave_index: 1, count: 192 },
        { activation_wave_index: 2, count: 192 },
        { activation_wave_index: 3, count: 384 },
      ]);

      const assignments = runtime.database.db.prepare(
        `SELECT pair.pair_ordinal,
                SUM(CASE WHEN lease.assigned_arm = 'candidate' THEN 1 ELSE 0 END) AS candidate_count,
                SUM(CASE WHEN lease.assigned_arm = 'control' THEN 1 ELSE 0 END) AS control_count,
                MAX(CASE WHEN lease.assigned_arm = 'candidate'
                         THEN lease.pair_member_ordinal ELSE NULL END) AS candidate_member
         FROM lite_learning_randomization_pairs AS pair
         JOIN lite_learning_namespace_leases AS lease
           ON lease.tenant_id = pair.tenant_id
          AND lease.confirmatory_attempt_id = pair.confirmatory_attempt_id
          AND lease.randomization_pair_sha256 = pair.randomization_pair_sha256
         GROUP BY pair.pair_ordinal ORDER BY pair.pair_ordinal`,
      ).all() as Array<{
        pair_ordinal: number;
        candidate_count: number;
        control_count: number;
        candidate_member: number;
      }>;
      assert.equal(assignments.length, 384);
      assert.equal(assignments.every((row) => row.candidate_count === 1 && row.control_count === 1), true);
      const expectedGolden = new Map([
        [0, 1],
        [7, 0],
        [8, 0],
        [15, 1],
        [376, 1],
        [383, 0],
      ]);
      for (const [ordinal, expectedMember] of expectedGolden) {
        assert.equal(assignments[ordinal]?.candidate_member, expectedMember, `MSB ordinal ${String(ordinal)}`);
      }

      const config = JSON.parse(revision.config_json) as Record<string, unknown>;
      const snapshotSha256 = config.pre_treatment_lineage_snapshot_sha256;
      assert.match(String(snapshotSha256), /^[0-9a-f]{64}$/u);
      const matchingRows = runtime.database.db.prepare(
        `SELECT matching_covariate_json FROM lite_learning_randomization_pairs`,
      ).all() as Array<{ matching_covariate_json: string }>;
      let priorCommitCount = 0;
      for (const row of matchingRows) {
        const matching = JSON.parse(row.matching_covariate_json) as {
          pre_treatment_lineage_snapshot_sha256: string;
          members: Array<{
            prior_memory_node_count: number;
            prior_memory_commit_count: number;
          }>;
        };
        assert.equal(matching.pre_treatment_lineage_snapshot_sha256, snapshotSha256);
        assert.equal(matching.members.every((member) => member.prior_memory_node_count === 0), true);
        priorCommitCount += matching.members.reduce(
          (total, member) => total + member.prior_memory_commit_count,
          0,
        );
      }
      assert.equal(priorCommitCount, 768);

      if (result.applicabilityManifest.evidence_intent !== "confirmatory") {
        throw new Error("expected confirmatory applicability manifest");
      }
      assert.equal(result.applicabilityManifest.cohort.pairs.length, 384);
      assert.equal(
        result.applicabilityManifest.cohort.pairs.flatMap((pair) => pair.members).length,
        768,
      );
      assert.deepEqual(forbiddenManifestKeys(result.applicabilityManifest), []);
      manifestJson = result.applicabilityManifestJson;
      receiptJson = result.receiptJson;
      for (const secret of [
        CONFIRMATORY_RAW_SCOPE_MARKER,
        CONFIRMATORY_RAW_COVARIATE_MARKER,
        Buffer.from(diagnosticSeed).toString("hex"),
        Buffer.from(diagnosticSeed).toString("base64"),
        Buffer.from(assignmentBits).toString("hex"),
        Buffer.from(assignmentBits).toString("base64"),
      ]) {
        assert.equal(manifestJson.includes(secret), false, `manifest leaked ${secret.slice(0, 24)}`);
      }
      assert.doesNotMatch(manifestJson, /"assigned_arm"|"confirmatory_assignment_bits"|"diagnostic_assignment_seed"/u);
      await createLiteLearningEpisodeLedgerAccess(runtime.database).verifyIntegrity();
    } finally {
      await runtime.close();
    }

    const reopened = openConfirmatoryFixtureRuntime(temp.path);
    try {
      const regenerated = await createLiteLearningExperimentProvisioner({
        database: reopened.database,
        writeStore: reopened.writeStore,
      }).regenerateApplicabilityManifest({
        tenantId: createConfirmatoryProvisionInput().tenantId,
        experimentId: CONFIRMATORY_EXPERIMENT_ID,
        experimentRevision: CONFIRMATORY_EXPERIMENT_REVISION,
      });
      assert.equal(stableStringify(regenerated), manifestJson);
      const operation = reopened.database.db.prepare(
        "SELECT receipt_json FROM lite_runtime_write_operations",
      ).get() as { receipt_json: string };
      assert.equal(operation.receipt_json, receiptJson);
      await createLiteLearningEpisodeLedgerAccess(reopened.database).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("an all-zero 48-byte vector is accepted once without balance rejection or redraw", async () => {
  const temp = tempDatabase("zero-vector");
  const entropySizes: number[] = [];
  try {
    const runtime = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await seedConfirmatoryPriorScopes(runtime);
      const result = await createProvisioner(runtime, (size) => {
        entropySizes.push(size);
        if (size === 32) return new Uint8Array(32).fill(0x5a);
        if (size === 48) return new Uint8Array(48);
        throw new Error(`unexpected entropy request: ${String(size)}`);
      }).provision(createConfirmatoryProvisionInput());
      assert.equal(result.replayed, false);
      assert.deepEqual(entropySizes, [32, 48]);
      const candidateMemberCounts = runtime.database.db.prepare(
        `SELECT pair_member_ordinal, COUNT(*) AS count
         FROM lite_learning_namespace_leases
         WHERE assigned_arm = 'candidate'
         GROUP BY pair_member_ordinal ORDER BY pair_member_ordinal`,
      ).all() as Array<{ pair_member_ordinal: number; count: number }>;
      assert.deepEqual(
        candidateMemberCounts.map((row) => ({ ...row })),
        [{ pair_member_ordinal: 0, count: 384 }],
      );
      if (result.receipt.experiment.evidence_intent !== "confirmatory") {
        throw new Error("expected confirmatory receipt");
      }
      assert.equal(result.receipt.cohort.assignment.randomness_rejection_or_redraw_allowed, false);
      assert.equal(result.receipt.cohort.assignment.confirmatory_assignment_random_bytes, 48);
      assertConfirmatoryAuthorityCounts(runtime);
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("31-byte, 47-byte, and throwing entropy sources roll every confirmatory authority row back", async (t) => {
  const scenarios = [
    {
      name: "diagnostic-31",
      expected: /diagnostic_csprng_must_return_32_bytes/u,
      randomBytes(size: number) {
        return size === 32 ? new Uint8Array(31) : new Uint8Array(size);
      },
      calls: [32],
    },
    {
      name: "confirmatory-47",
      expected: /confirmatory_csprng_must_return_48_bytes/u,
      randomBytes(size: number) {
        return size === 32 ? new Uint8Array(32).fill(1) : new Uint8Array(47);
      },
      calls: [32, 48],
    },
    {
      name: "confirmatory-throw",
      expected: /injected-confirmatory-entropy-failure/u,
      randomBytes(size: number) {
        if (size === 32) return new Uint8Array(32).fill(2);
        throw new Error("injected-confirmatory-entropy-failure");
      },
      calls: [32, 48],
    },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const temp = tempDatabase(`rollback-${scenario.name}`);
      const entropySizes: number[] = [];
      try {
        const runtime = openConfirmatoryFixtureRuntime(temp.path);
        try {
          await seedConfirmatoryPriorScopes(runtime);
          const provisioner = createProvisioner(runtime, (size) => {
            entropySizes.push(size);
            return scenario.randomBytes(size);
          });
          await assert.rejects(
            provisioner.provision(createConfirmatoryProvisionInput()),
            scenario.expected,
          );
          assert.deepEqual(entropySizes, scenario.calls);
          assertConfirmatoryAuthorityRolledBack(runtime);
          await createLiteLearningEpisodeLedgerAccess(runtime.database).verifyIntegrity();
        } finally {
          await runtime.close();
        }
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("restart exact replay consumes no entropy while a changed namespace input conflicts", async () => {
  const temp = tempDatabase("restart-replay");
  let receiptJson = "";
  try {
    const first = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await seedConfirmatoryPriorScopes(first);
      const entropySizes: number[] = [];
      const provisioned = await createProvisioner(first, (size) => {
        entropySizes.push(size);
        if (size === 32) return new Uint8Array(32).fill(0x61);
        if (size === 48) return new Uint8Array(48).fill(0x17);
        throw new Error(`unexpected entropy request: ${String(size)}`);
      }).provision(createConfirmatoryProvisionInput());
      assert.deepEqual(entropySizes, [32, 48]);
      receiptJson = provisioned.receiptJson;
    } finally {
      await first.close();
    }

    const reopened = openConfirmatoryFixtureRuntime(temp.path);
    try {
      let replayEntropyCalls = 0;
      const provisioner = createProvisioner(reopened, () => {
        replayEntropyCalls += 1;
        throw new Error("exact replay must not consume entropy");
      });
      const replayed = await provisioner.provision(createConfirmatoryProvisionInput());
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.receiptJson, receiptJson);
      assert.equal(replayEntropyCalls, 0);

      const changedRaw = JSON.parse(stableStringify(
        createConfirmatoryProvisionInput().memoryNamespaceManifest,
      )) as Record<string, unknown>;
      const pairs = changedRaw.pairs as Array<Record<string, unknown>>;
      const matching = pairs[0]!.matching_covariates as Record<string, unknown>;
      matching.region = "changed-pre-treatment-region";
      const changedManifest = LearningMemoryNamespaceManifestV1Schema.parse(changedRaw);
      await assert.rejects(
        provisioner.provision(createConfirmatoryProvisionInput({
          memoryNamespaceManifest: changedManifest,
        })),
        (error: unknown) => {
          assert.ok(error instanceof LearningExperimentProvisioningError);
          assert.equal(error.code, "learning_experiment_operation_id_conflict");
          return true;
        },
      );
      assert.equal(replayEntropyCalls, 0);

      let changedDefaultEntropyCalls = 0;
      await assert.rejects(
        createProvisioner(reopened, (size) => {
          changedDefaultEntropyCalls += 1;
          return new Uint8Array(size);
        }, "changed-default-tenant").provision(createConfirmatoryProvisionInput()),
        (error: unknown) => {
          assert.ok(error instanceof LearningExperimentProvisioningError);
          assert.equal(error.code, "learning_experiment_tenant_scope_anchor_mismatch");
          return true;
        },
      );
      assert.equal(changedDefaultEntropyCalls, 0);
      assertConfirmatoryAuthorityCounts(reopened);
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

type RaceChildSuccess = Readonly<{
  type: "result";
  ok: true;
  childIndex: number;
  replayed: boolean;
  receiptSha256: string;
  entropySizes: number[];
}>;

type RaceChildFailure = Readonly<{
  type: "result";
  ok: false;
  childIndex: number;
  code: string | null;
  message: string;
  entropySizes: number[];
}>;

type RaceChildResult = RaceChildSuccess | RaceChildFailure;

function startRaceChild(databasePath: string, childIndex: number): Readonly<{
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<RaceChildResult>;
  exited: Promise<number | null>;
  stderr(): string;
}> {
  const child = fork(CHILD_PATH, [databasePath, String(childIndex)], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let readySettled = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: RaceChildResult) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<RaceChildResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "ready" && record.childIndex === childIndex && !readySettled) {
      readySettled = true;
      resolveReady();
      return;
    }
    if (record.type === "result" && !resultSettled) {
      resultSettled = true;
      resolveResult(message as RaceChildResult);
    }
  });
  child.on("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(`race child ${String(childIndex)} exited before ready: ${stderr}`));
      }
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(new Error(`race child ${String(childIndex)} exited before result: ${stderr}`));
      }
      resolve(code);
    });
  });
  return { child, ready, result, exited, stderr: () => stderr };
}

test("two real child processes serialize one confirmatory fresh write and one exact replay", {
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("process-race");
  let left: ReturnType<typeof startRaceChild> | null = null;
  let right: ReturnType<typeof startRaceChild> | null = null;
  try {
    const setup = openConfirmatoryFixtureRuntime(temp.path);
    try {
      await seedConfirmatoryPriorScopes(setup);
    } finally {
      await setup.close();
    }

    left = startRaceChild(temp.path, 0);
    right = startRaceChild(temp.path, 1);
    await Promise.all([left.ready, right.ready]);
    left.child.send({ type: "go" });
    right.child.send({ type: "go" });
    const results = await Promise.all([left.result, right.result]);
    const exitCodes = await Promise.all([left.exited, right.exited]);
    assert.deepEqual(exitCodes, [0, 0], `child stderr: ${left.stderr()} ${right.stderr()}`);
    for (const result of results) {
      assert.equal(result.ok, true, result.ok ? undefined : result.message);
    }
    const successes = results as RaceChildSuccess[];
    assert.deepEqual(successes.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(successes[0]!.receiptSha256, successes[1]!.receiptSha256);
    assert.deepEqual(
      successes.map((result) => result.entropySizes.join(",")).sort(),
      ["", "32,48"],
    );

    const fresh = successes.find((result) => !result.replayed);
    assert.ok(fresh);
    const reopened = openConfirmatoryFixtureRuntime(temp.path);
    try {
      assertConfirmatoryAuthorityCounts(reopened);
      const revision = reopened.database.db.prepare(
        "SELECT diagnostic_assignment_seed FROM lite_learning_experiment_revisions",
      ).get() as { diagnostic_assignment_seed: Uint8Array };
      assert.equal(revision.diagnostic_assignment_seed[0], 0x31 + fresh.childIndex);
      await createLiteLearningEpisodeLedgerAccess(reopened.database).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    if (left && left.child.exitCode === null) left.child.kill();
    if (right && right.child.exitCode === null) right.child.kill();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
