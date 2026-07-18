import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
} from "../../src/config.ts";
import type { LearningExperimentCloseApprovalV1 } from
  "../../src/memory/learning-authority-approval.ts";
import {
  learningCollectionPrincipalSha256,
} from "../../src/memory/learning-episode-ledger.ts";
import {
  learningExperimentCloseApprovalMac,
  type LearningExperimentCloseAuthorizationEnvelopeV1,
} from "../../src/memory/learning-experiment-closing.ts";
import { buildAionisMemoryPacket } from "../../src/memory/product-output/memory-packet.ts";
import { createProductGuideService } from "../../src/product/guide-service.ts";
import { ProductGuideRequest, type ProductServiceResult } from
  "../../src/product/product-services.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { createLiteLearningEpisodeLedgerAccess } from
  "../../src/store/lite-learning-episode-ledger.ts";
import type { LiteLearningExperimentAuthorityResolution } from
  "../../src/store/lite-learning-episode-ledger.ts";
import {
  createLiteLearningExperimentCloser,
} from "../../tools/learning-experiments/lite-learning-experiment-closing.ts";
import { createLiteLearningExperimentProvisioner } from
  "../../tools/learning-experiments/lite-learning-experiment-provisioning.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import type { AuthorityReceiptResolvedKeyring } from
  "../../src/util/authority-receipt-keys.ts";
import type { AuthPrincipal } from "../../src/util/auth.ts";
import {
  CONFIRMATORY_DEFAULT_TENANT_ID,
  CONFIRMATORY_TASK_FAMILY,
  CONFIRMATORY_TENANT_ID,
  createConfirmatoryPassedRegistry,
  createConfirmatoryProfile,
  createConfirmatoryProvisionInput,
  provisionConfirmatoryFixture,
  sha256,
  type ConfirmatoryProvisionedFixture,
} from "./support/learning-experiment-confirmatory-fixture.ts";

const CLOSE_KEY_ID = "guide-fail-control-close-key-v1";
const CLOSE_KEY = Buffer.from(
  "guide-fail-control-close-key-material-with-at-least-thirty-two-bytes",
  "utf8",
);
const EVIDENCE_AT = "2026-07-14T09:30:00.000Z";
const CLOSE_NOW = "2099-01-01T01:00:00.000Z";
const CLOSE_ISSUED_AT = "2099-01-01T00:55:00.000Z";
const CLOSE_EXPIRES_AT = "2099-01-01T01:30:00.000Z";

const CLOSE_KEYRING: AuthorityReceiptResolvedKeyring = {
  activeKeyId: CLOSE_KEY_ID,
  keys: new Map([[CLOSE_KEY_ID, CLOSE_KEY]]),
  configured: true,
  ephemeral: false,
  source: "keyring",
};

function tempDatabase(name: string) {
  const directory = fs.mkdtempSync(path.join(os.homedir(), `.aionis-guide-close-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function guideEnv(defaultScope: string) {
  return {
    AIONIS_EDITION: "lite",
    APP_ENV: "test",
    MEMORY_TENANT_ID: CONFIRMATORY_DEFAULT_TENANT_ID,
    MEMORY_SCOPE: defaultScope,
    LITE_LOCAL_ACTOR_ID: "confirmatory-guide-agent",
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    AIONIS_INSPECT_BEFORE_USE_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: "[]",
    EXECUTION_TREE_DEFAULT_ENABLED: true,
    LITE_INLINE_EMBEDDING_TIMEOUT_MS: 1_000,
  } as any;
}

function confirmatoryPrincipal(publicScope: string): AuthPrincipal {
  return {
    tenant_id: CONFIRMATORY_TENANT_ID,
    agent_id: "confirmatory-guide-agent",
    team_id: null,
    role: "worker",
    default_scope: publicScope,
    allowed_scopes: [publicScope],
    source: "api_key",
  };
}

function confirmatoryProfileForPrincipal(
  principal: AuthPrincipal,
): AionisAdmissionCandidatePolicyProfileRule {
  const base = createConfirmatoryProfile();
  assert.ok(base.experiment);
  const collectionSource = base.experiment.collection_sources[0];
  assert.ok(collectionSource);
  const [profile] = parseAdmissionCandidatePolicyProfileRules(stableStringify([{
    ...base,
    experiment: {
      ...base.experiment,
      collection_sources: [{
        ...collectionSource,
        principal_sha256: learningCollectionPrincipalSha256({
          tenant_id: principal.tenant_id,
          agent_id: principal.agent_id,
          team_id: principal.team_id,
        }),
      }],
    },
  }]));
  assert.ok(profile?.experiment);
  return profile;
}

function diagnosticProfileForPrincipal(
  principal: AuthPrincipal,
): AionisAdmissionCandidatePolicyProfileRule {
  const base = createConfirmatoryProfile();
  assert.ok(base.experiment);
  const collectionSource = base.experiment.collection_sources[0];
  assert.ok(collectionSource);
  const [profile] = parseAdmissionCandidatePolicyProfileRules(stableStringify([{
    ...base,
    profile_id: "guide-integrity-diagnostic-profile",
    experiment: {
      ...base.experiment,
      experiment_id: "guide-integrity-diagnostic-experiment",
      serving_phase: "shadow",
      evidence_intent: "integrity_only",
      assignment_design: "diagnostic_hash_v1",
      required_external_inputs: {},
      collection_sources: [{
        ...collectionSource,
        principal_sha256: learningCollectionPrincipalSha256({
          tenant_id: principal.tenant_id,
          agent_id: principal.agent_id,
          team_id: principal.team_id,
        }),
      }],
    },
  }]));
  assert.ok(profile?.experiment);
  return profile;
}

function openGuideRuntime(args: {
  databasePath: string;
  publicScope: string;
  profile: AionisAdmissionCandidatePolicyProfileRule;
}) {
  const database = createLiteRuntimeDatabase(args.databasePath);
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
    authorityReceiptKeyring: CLOSE_KEYRING,
  });
  const learningEpisodeLedgerAccess = createLiteLearningEpisodeLedgerAccess(database, {
    authorityReceiptKeyring: CLOSE_KEYRING,
  });
  const env = guideEnv(args.publicScope);
  const memoryWrite = createMemoryWriteRouteService({
    env,
    embedder: null,
    liteWriteStore: writeStore,
    executionStateStore: null,
    executionTreeStore: null,
  });
  const guide = createProductGuideService({
    env,
    liteWriteStore: writeStore,
    learningEpisodeLedgerAccess,
    learningExperimentResolverRegistry: createConfirmatoryPassedRegistry(),
    admissionCandidatePolicyProfileRules: [args.profile],
    memoryWrite,
  });
  return {
    database,
    writeStore,
    learningEpisodeLedgerAccess,
    memoryWrite,
    guide,
    async close() {
      try {
        await writeStore.close();
      } finally {
        await database.close();
      }
    },
  };
}

type GuideRuntime = ReturnType<typeof openGuideRuntime>;

type AuthorityProjection = (
  authority: LiteLearningExperimentAuthorityResolution,
  readOrdinal: number,
) => LiteLearningExperimentAuthorityResolution;

/**
 * Test-only terminal-authority seam. The production gate-adjudication writer
 * does not yet expose a compact fixture API, so these regressions preserve the
 * real persisted revision/principal/assignment projection and override only
 * the terminal fields that the eventual writer will project atomically.
 */
function installAuthorityProjection(runtime: GuideRuntime) {
  const original = runtime.learningEpisodeLedgerAccess.resolveGuideExperimentAuthority.bind(
    runtime.learningEpisodeLedgerAccess,
  );
  let projection: AuthorityProjection = (authority) => authority;
  let readCount = 0;
  let last: LiteLearningExperimentAuthorityResolution | null = null;
  runtime.learningEpisodeLedgerAccess.resolveGuideExperimentAuthority = async (args) => {
    const authority = await original(args);
    readCount += 1;
    last = projection(authority, readCount);
    return last;
  };
  return {
    project(next: AuthorityProjection) {
      projection = next;
    },
    readCount() {
      return readCount;
    },
    last() {
      return last;
    },
    restore() {
      runtime.learningEpisodeLedgerAccess.resolveGuideExperimentAuthority = original;
    },
  };
}

function terminalUnboundAuthority(
  authority: LiteLearningExperimentAuthorityResolution,
  action: "demote" | "retire",
): LiteLearningExperimentAuthorityResolution {
  assert.ok(authority.revision);
  return {
    ...authority,
    namespace_lease: null,
    assignment: null,
    experiment_closed: false,
    active_namespace_lease_conflict: false,
    safety_pause_required: false,
    candidate_authority_actions: [action],
  };
}

function pausedAuthority(
  authority: LiteLearningExperimentAuthorityResolution,
): LiteLearningExperimentAuthorityResolution {
  assert.ok(authority.revision);
  return {
    ...authority,
    safety_pause_required: true,
    candidate_authority_actions: ["pause"],
  };
}

function closeNonce(operationId: string): string {
  return createHash("sha256")
    .update(`aionis-guide-fail-control-close:${operationId}`, "utf8")
    .digest()
    .subarray(0, 18)
    .toString("base64url");
}

function closeAuthorization(
  fixture: ConfirmatoryProvisionedFixture,
  operationId: string,
): LearningExperimentCloseAuthorizationEnvelopeV1 {
  const approval: LearningExperimentCloseApprovalV1 = {
    contract_version: "learning_experiment_close_approval_v1",
    authorization_kind: "experiment_close",
    action: "close_experiment",
    runtime_authority_lineage_sha256: fixture.lineage.runtimeAuthorityLineageSha256,
    tenant_id: fixture.attempt.tenantId,
    task_family: fixture.attempt.taskFamily,
    confirmatory_attempt_id: fixture.attempt.confirmatoryAttemptId,
    confirmatory_attempt_sha256: fixture.attempt.confirmatoryAttemptSha256,
    experiment_id: fixture.attempt.experimentId,
    experiment_revision: fixture.attempt.experimentRevision,
    experiment_config_sha256: fixture.revision.experimentConfigSha256,
    namespace_set_sha256: fixture.leaseMembership.namespaceSetSha256,
    close_reason: "operator_stop",
    candidate_policy_implementation_sha256:
      fixture.attempt.candidatePolicyImplementationSha256,
    gate_policy_implementation_sha256: fixture.revision.gatePolicyImplementationSha256,
    authority_scope: "learning-experiment-authority-v1",
    authority_operation_kind: "learning_experiment_close_v1",
    authority_operation_id: operationId,
    approved_by: "guide-fail-control-close-approver",
    authorization_key_id: CLOSE_KEY_ID,
    authorization_nonce: closeNonce(operationId),
    authorization_issued_at: CLOSE_ISSUED_AT,
    authorization_expires_at: CLOSE_EXPIRES_AT,
  };
  return {
    contract_version: "learning_experiment_close_authorization_envelope_v1",
    approval,
    authorization_mac: learningExperimentCloseApprovalMac(approval, CLOSE_KEY),
  };
}

async function closeExperiment(
  runtime: GuideRuntime,
  fixture: ConfirmatoryProvisionedFixture,
  operationId: string,
): Promise<void> {
  const authorization = closeAuthorization(fixture, operationId);
  const result = await createLiteLearningExperimentCloser({
    database: runtime.database,
    writeStore: runtime.writeStore,
    dependencies: {
      now: () => CLOSE_NOW,
      resolveKeyring: () => CLOSE_KEYRING,
    },
  }).close({
    tenantId: fixture.attempt.tenantId,
    actor: "guide-fail-control-closer",
    operationId,
    authorization,
    experimentId: fixture.attempt.experimentId,
    experimentRevision: fixture.attempt.experimentRevision,
  });
  assert.equal(result.replayed, false);
  assert.equal(result.receipt.namespace_lease_count, 768);
}

function guideCounts(runtime: GuideRuntime, storeScope: string) {
  const count = (sql: string, ...bindings: unknown[]) => Number((
    runtime.database.db.prepare(sql).get(...bindings) as { count: number }
  ).count);
  return {
    learningExposures: count(
      "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'exposure_committed'",
    ),
    guideReceipts: count(
      "SELECT COUNT(*) AS count FROM lite_product_guide_receipts",
    ),
    guideOperations: count(
      "SELECT COUNT(*) AS count FROM lite_runtime_write_operations WHERE operation_kind = 'product_guide_v1'",
    ),
    memoryCommits: count(
      "SELECT COUNT(*) AS count FROM lite_memory_commits WHERE scope = ?",
      storeScope,
    ),
    activeLeases: count(
      "SELECT COUNT(*) AS count FROM lite_learning_namespace_leases WHERE status = 'active'",
    ),
    releasedLeases: count(
      "SELECT COUNT(*) AS count FROM lite_learning_namespace_leases WHERE status = 'released'",
    ),
  };
}

function assertBaselineGuideCommitted(
  before: ReturnType<typeof guideCounts>,
  after: ReturnType<typeof guideCounts>,
): void {
  assertGuideCommittedWithoutExposure(before, after);
  assert.equal(after.activeLeases, 0);
  assert.equal(after.releasedLeases, 768);
}

function assertGuideCommittedWithoutExposure(
  before: ReturnType<typeof guideCounts>,
  after: ReturnType<typeof guideCounts>,
): void {
  assert.equal(after.learningExposures, before.learningExposures);
  assert.equal(after.guideReceipts, before.guideReceipts + 1);
  assert.equal(after.guideOperations, before.guideOperations + 1);
  assert.equal(after.memoryCommits, before.memoryCommits + 1);
}

function assertGuideCommittedWithExposure(
  before: ReturnType<typeof guideCounts>,
  after: ReturnType<typeof guideCounts>,
): void {
  assert.equal(after.learningExposures, before.learningExposures + 1);
  assert.equal(after.guideReceipts, before.guideReceipts + 1);
  assert.equal(after.guideOperations, before.guideOperations + 1);
  assert.equal(after.memoryCommits, before.memoryCommits + 1);
}

function assertGuideOperationLinked(
  runtime: GuideRuntime,
  operationId: string,
): void {
  const linkage = runtime.database.db.prepare(
    `SELECT operation.commit_id AS operation_commit_id,
            guide.commit_id AS guide_commit_id
     FROM lite_runtime_write_operations AS operation
     JOIN lite_product_guide_receipts AS guide
       ON guide.tenant_id = operation.tenant_id
      AND guide.scope = operation.scope
      AND guide.commit_id = operation.commit_id
     WHERE operation.operation_kind = 'product_guide_v1'
       AND operation.operation_id = ?`,
  ).get(operationId) as {
    operation_commit_id: string;
    guide_commit_id: string;
  } | undefined;
  assert.ok(linkage);
  assert.equal(linkage.operation_commit_id, linkage.guide_commit_id);
}

function guidePolicy(result: ProductServiceResult): Record<string, unknown> {
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  const body = result.body as Record<string, any>;
  return body.source_map.admission_candidate_policy as Record<string, unknown>;
}

async function prepareScenario(name: string) {
  const temp = tempDatabase(name);
  const seedProfile = createConfirmatoryProfile();
  assert.ok(seedProfile.experiment);
  const seedInput = createConfirmatoryProvisionInput({ profileRule: seedProfile });
  const publicScope = seedInput.memoryNamespaceManifest!.pairs[0]!.members[0]!.public_scope;
  const principal = confirmatoryPrincipal(publicScope);
  const profile = confirmatoryProfileForPrincipal(principal);
  const provisionInput = createConfirmatoryProvisionInput({ profileRule: profile });
  const runtime = openGuideRuntime({ databasePath: temp.path, publicScope, profile });
  try {
    const fixture = await provisionConfirmatoryFixture(runtime, { input: provisionInput });
    const seeded = await runtime.memoryWrite.commit({
      tenant_id: CONFIRMATORY_TENANT_ID,
      scope: publicScope,
      actor: principal.agent_id,
      input_text: "Seed a real prior memory for closed-experiment guide fail-control.",
      auto_embed: false,
      nodes: [{
        client_id: `${name}-prior-memory`,
        type: "concept",
        tier: "warm",
        memory_lane: "shared",
        producer_agent_id: principal.agent_id,
        owner_agent_id: principal.agent_id,
        title: "Prior confirmatory guide memory",
        text_summary: "This real prior memory keeps the guide decision projection complete.",
        confidence: 0.95,
        salience: 0.9,
        slots: { positive_attributed_use_count: 2 },
      }],
      edges: [],
    });
    const seededNode = seeded.out.nodes[0];
    assert.ok(seededNode);
    const memoryPacket = buildAionisMemoryPacket({
      tenant_id: CONFIRMATORY_TENANT_ID,
      scope: publicScope,
      query: { source: "text", intent: "closed experiment fail-control" },
      nodes: [{
        id: seededNode.id,
        type: "concept",
        tier: "warm",
        title: "Prior confirmatory guide memory",
        text_summary: "This real prior memory keeps the guide decision projection complete.",
        slots: { positive_attributed_use_count: 2 },
        confidence: 0.95,
        salience: 0.9,
        created_at: EVIDENCE_AT,
      }],
    });
    const executeGuide = async (label: string) => {
      const envelope = {
        contract_version: "host_task_envelope_v1" as const,
        host_task_id: `${name}-${label}-host-task`,
        collector_id: profile.experiment!.collection_sources[0]!.collector_id,
        collector_version: profile.experiment!.collection_sources[0]!.collector_version,
        task_family: CONFIRMATORY_TASK_FAMILY,
        task_signature: `${name}-${label}-task-signature`,
        repository_signature: "aionis-runtime-focused",
        source_task_sha256: sha256(`${name}-${label}-source-task`),
        source_event_sha256: sha256(`${name}-${label}-source-event`),
        created_at: EVIDENCE_AT,
      };
      const input = ProductGuideRequest.parse({
        operation_id: `${name}-${label}-guide-operation`,
        tenant_id: CONFIRMATORY_TENANT_ID,
        scope: publicScope,
        run_id: `${name}-${label}-run`,
        consumer_agent_id: principal.agent_id,
        query_text: "Return the baseline guide after confirmatory authority closes.",
        context: {
          task_family: envelope.task_family,
          task_signature: envelope.task_signature,
          repository_signature: envelope.repository_signature,
        },
        host_task_envelope_v1: envelope,
      });
      return await runtime.guide.execute(input, {
        principal,
        planningContext: async () => ({
          tenant_id: CONFIRMATORY_TENANT_ID,
          scope: publicScope,
          recall: { aionis_memory_packet: memoryPacket },
        }),
        applyIdentity: (value) => value,
      });
    };

    const initial = await executeGuide("active-authority");
    const initialPolicy = guidePolicy(initial);
    assert.equal(initialPolicy.serving_arm, "control");
    assert.equal(initialPolicy.enrollment_state, "enrolled");
    const initialExposure = runtime.database.db.prepare(
      `SELECT collection_class, assignment_mode, assignment_arm, served_arm,
              namespace_lease_id, promotion_eligible, projection_complete
       FROM lite_learning_episode_events
       WHERE event_kind = 'exposure_committed'`,
    ).get() as Record<string, unknown> | undefined;
    assert.ok(initialExposure);
    assert.deepEqual({
      collection_class: initialExposure.collection_class,
      assignment_mode: initialExposure.assignment_mode,
      served_arm: initialExposure.served_arm,
      has_namespace_lease: typeof initialExposure.namespace_lease_id === "string",
      promotion_eligible: initialExposure.promotion_eligible,
      projection_complete: initialExposure.projection_complete,
    }, {
      collection_class: "eligible_host",
      assignment_mode: "matched_pair_randomized",
      served_arm: "control",
      has_namespace_lease: true,
      promotion_eligible: 0,
      projection_complete: 1,
    });
    assert.ok(initialExposure.assignment_arm === "control"
      || initialExposure.assignment_arm === "candidate");

    const storeScope = String((runtime.database.db.prepare(
      `SELECT scope FROM lite_memory_nodes WHERE id = ?`,
    ).get(seededNode.id) as { scope: string }).scope);
    return { temp, runtime, fixture, executeGuide, storeScope };
  } catch (error) {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
    throw error;
  }
}

test("guide after pre-read closed experiment commits baseline receipts without stale exposure", async () => {
  const scenario = await prepareScenario("preclosed");
  try {
    await closeExperiment(scenario.runtime, scenario.fixture, "preclosed-close-operation");
    const before = guideCounts(scenario.runtime, scenario.storeScope);
    assert.equal(before.learningExposures, 1);

    const result = await scenario.executeGuide("after-close");
    const policy = guidePolicy(result);
    assert.equal(policy.mode, "shadow");
    assert.equal(policy.serving_arm, "control");
    assert.equal(policy.promotion_eligible, false);
    assert.deepEqual(policy.reason_codes, ["experiment_closed"]);

    assertBaselineGuideCommitted(
      before,
      guideCounts(scenario.runtime, scenario.storeScope),
    );
    assertGuideOperationLinked(
      scenario.runtime,
      "preclosed-after-close-guide-operation",
    );
  } finally {
    await scenario.runtime.close();
    fs.rmSync(scenario.temp.directory, { recursive: true, force: true });
  }
});

test("guide closed between authority pre-read and BEGIN commits baseline without stale exposure", async () => {
  const scenario = await prepareScenario("close-before-begin");
  try {
    const before = guideCounts(scenario.runtime, scenario.storeScope);
    assert.equal(before.learningExposures, 1);
    const originalPrepare = scenario.runtime.memoryWrite.prepare.bind(scenario.runtime.memoryWrite);
    let closeCount = 0;
    scenario.runtime.memoryWrite.prepare = async (body, options) => {
      if (closeCount === 0) {
        closeCount += 1;
        await closeExperiment(
          scenario.runtime,
          scenario.fixture,
          "close-before-begin-operation",
        );
      }
      return await originalPrepare(body, options);
    };

    const result = await scenario.executeGuide("raced-close");
    assert.equal(closeCount, 1);
    const policy = guidePolicy(result);
    assert.equal(policy.mode, "shadow");
    assert.equal(policy.serving_arm, "control");
    assert.equal(policy.promotion_eligible, false);
    assert.deepEqual(policy.reason_codes, ["experiment_authority_changed_before_commit"]);

    assertBaselineGuideCommitted(
      before,
      guideCounts(scenario.runtime, scenario.storeScope),
    );
    assertGuideOperationLinked(
      scenario.runtime,
      "close-before-begin-raced-close-guide-operation",
    );
  } finally {
    await scenario.runtime.close();
    fs.rmSync(scenario.temp.directory, { recursive: true, force: true });
  }
});

test("terminal demote and retire projections without a matched-pair lease commit baseline and no exposure", async () => {
  const scenario = await prepareScenario("terminal-preread");
  const authority = installAuthorityProjection(scenario.runtime);
  try {
    for (const action of ["demote", "retire"] as const) {
      authority.project((resolved) => terminalUnboundAuthority(resolved, action));
      const before = guideCounts(scenario.runtime, scenario.storeScope);
      const readsBefore = authority.readCount();
      const result = await scenario.executeGuide(`terminal-${action}`);
      const policy = guidePolicy(result);
      assert.equal(policy.mode, "shadow");
      assert.equal(policy.serving_arm, "control");
      assert.equal(policy.enrollment_state, "not_enrolled");
      assert.equal(policy.promotion_eligible, false);
      assert.deepEqual(policy.reason_codes, [`candidate_implementation_${action}d`]);
      assert.equal(authority.readCount(), readsBefore + 2);
      assert.equal(authority.last()?.namespace_lease, null);
      assert.equal(authority.last()?.assignment, null);

      const after = guideCounts(scenario.runtime, scenario.storeScope);
      assertGuideCommittedWithoutExposure(before, after);
      // The projection seam models the future atomic terminal writer; the
      // persisted fixture intentionally remains active underneath it.
      assert.equal(after.activeLeases, 768);
      assert.equal(after.releasedLeases, 0);
      assertGuideOperationLinked(
        scenario.runtime,
        `terminal-preread-terminal-${action}-guide-operation`,
      );
    }
  } finally {
    authority.restore();
    await scenario.runtime.close();
    fs.rmSync(scenario.temp.directory, { recursive: true, force: true });
  }
});

test("authority becoming terminal and unbound after pre-read but before BEGIN commits baseline and no exposure", async () => {
  const scenario = await prepareScenario("terminal-before-begin");
  const authority = installAuthorityProjection(scenario.runtime);
  const originalPrepare = scenario.runtime.memoryWrite.prepare.bind(scenario.runtime.memoryWrite);
  try {
    let transitionCount = 0;
    scenario.runtime.memoryWrite.prepare = async (body, options) => {
      if (transitionCount === 0) {
        transitionCount += 1;
        assert.equal(authority.readCount(), 1);
        authority.project((resolved) => terminalUnboundAuthority(resolved, "retire"));
      }
      return await originalPrepare(body, options);
    };
    const before = guideCounts(scenario.runtime, scenario.storeScope);
    const result = await scenario.executeGuide("raced-retire");
    const policy = guidePolicy(result);
    assert.equal(transitionCount, 1);
    assert.equal(authority.readCount(), 2);
    assert.equal(authority.last()?.namespace_lease, null);
    assert.equal(authority.last()?.assignment, null);
    assert.equal(policy.mode, "shadow");
    assert.equal(policy.serving_arm, "control");
    assert.equal(policy.promotion_eligible, false);
    assert.deepEqual(policy.reason_codes, ["experiment_authority_changed_before_commit"]);

    const after = guideCounts(scenario.runtime, scenario.storeScope);
    assertGuideCommittedWithoutExposure(before, after);
    assert.equal(after.activeLeases, 768);
    assert.equal(after.releasedLeases, 0);
    assertGuideOperationLinked(
      scenario.runtime,
      "terminal-before-begin-raced-retire-guide-operation",
    );
  } finally {
    scenario.runtime.memoryWrite.prepare = originalPrepare;
    authority.restore();
    await scenario.runtime.close();
    fs.rmSync(scenario.temp.directory, { recursive: true, force: true });
  }
});

test("pause appends bound control exposure but pause plus close and released leases does not append", async () => {
  const scenario = await prepareScenario("pause-binding");
  const authority = installAuthorityProjection(scenario.runtime);
  try {
    authority.project((resolved) => pausedAuthority(resolved));
    const activeBefore = guideCounts(scenario.runtime, scenario.storeScope);
    const activeResult = await scenario.executeGuide("pause-active-lease");
    const activePolicy = guidePolicy(activeResult);
    assert.equal(activePolicy.mode, "shadow");
    assert.equal(activePolicy.serving_arm, "control");
    assert.equal(activePolicy.enrollment_state, "enrolled");
    assert.equal(activePolicy.promotion_eligible, false);
    assert.deepEqual(activePolicy.reason_codes, ["candidate_implementation_paused"]);
    const activeAfter = guideCounts(scenario.runtime, scenario.storeScope);
    assertGuideCommittedWithExposure(activeBefore, activeAfter);
    assert.equal(activeAfter.activeLeases, 768);
    assert.equal(activeAfter.releasedLeases, 0);
    const pausedExposure = scenario.runtime.database.db.prepare(
      `SELECT assignment_mode, served_arm, namespace_lease_id, promotion_eligible
       FROM lite_learning_episode_events
       WHERE event_kind = 'exposure_committed'
       ORDER BY row_id DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    assert.ok(pausedExposure);
    assert.equal(pausedExposure.assignment_mode, "matched_pair_randomized");
    assert.equal(pausedExposure.served_arm, "control");
    assert.equal(typeof pausedExposure.namespace_lease_id, "string");
    assert.equal(pausedExposure.promotion_eligible, 0);

    authority.project((resolved) => resolved);
    await closeExperiment(
      scenario.runtime,
      scenario.fixture,
      "pause-binding-close-operation",
    );
    authority.project((resolved) => pausedAuthority(resolved));
    const closedBefore = guideCounts(scenario.runtime, scenario.storeScope);
    const closedResult = await scenario.executeGuide("pause-after-close");
    const closedPolicy = guidePolicy(closedResult);
    assert.equal(closedPolicy.mode, "shadow");
    assert.equal(closedPolicy.serving_arm, "control");
    assert.equal(closedPolicy.promotion_eligible, false);
    assert.deepEqual(closedPolicy.reason_codes, [
      "candidate_implementation_paused",
      "experiment_closed",
    ]);
    assertBaselineGuideCommitted(
      closedBefore,
      guideCounts(scenario.runtime, scenario.storeScope),
    );
    assertGuideOperationLinked(
      scenario.runtime,
      "pause-binding-pause-after-close-guide-operation",
    );
  } finally {
    authority.restore();
    await scenario.runtime.close();
    fs.rmSync(scenario.temp.directory, { recursive: true, force: true });
  }
});

test("integrity-only diagnostic profile still appends its normal control exposure", async () => {
  const scenario = await prepareScenario("diagnostic-guard");
  try {
    const publicScope = "guide-integrity-diagnostic-scope";
    const principal = confirmatoryPrincipal(publicScope);
    const profile = diagnosticProfileForPrincipal(principal);
    assert.ok(profile.experiment);
    const provisioned = await createLiteLearningExperimentProvisioner({
      database: scenario.runtime.database,
      writeStore: scenario.runtime.writeStore,
      ledger: scenario.runtime.learningEpisodeLedgerAccess,
      dependencies: {
        registry: createConfirmatoryPassedRegistry(),
        now: () => EVIDENCE_AT,
        randomBytes: (size) => Uint8Array.from(
          { length: size },
          (_, index) => (0x71 + index) & 0xff,
        ),
      },
    }).provision({
      tenantId: CONFIRMATORY_TENANT_ID,
      actor: "guide-integrity-diagnostic-provisioner",
      operationId: "guide-integrity-diagnostic-provision-operation",
      profileRule: profile,
      taskFamily: CONFIRMATORY_TASK_FAMILY,
      experimentId: profile.experiment.experiment_id,
      experimentRevision: profile.experiment.revision,
    });
    assert.equal(provisioned.replayed, false);
    assert.equal(provisioned.applicabilityManifest.evidence_intent, "integrity_only");

    const seeded = await scenario.runtime.memoryWrite.commit({
      tenant_id: CONFIRMATORY_TENANT_ID,
      scope: publicScope,
      actor: principal.agent_id,
      input_text: "Seed a real prior memory for the diagnostic guide guard.",
      auto_embed: false,
      nodes: [{
        client_id: "diagnostic-guard-prior-memory",
        type: "concept",
        tier: "warm",
        memory_lane: "shared",
        producer_agent_id: principal.agent_id,
        owner_agent_id: principal.agent_id,
        title: "Prior diagnostic guide memory",
        text_summary: "This real prior keeps the diagnostic guide projection complete.",
        confidence: 0.95,
        salience: 0.9,
        slots: { positive_attributed_use_count: 2 },
      }],
      edges: [],
    });
    const seededNode = seeded.out.nodes[0];
    assert.ok(seededNode);
    const storeScope = String((scenario.runtime.database.db.prepare(
      "SELECT scope FROM lite_memory_nodes WHERE id = ?",
    ).get(seededNode.id) as { scope: string }).scope);
    const memoryPacket = buildAionisMemoryPacket({
      tenant_id: CONFIRMATORY_TENANT_ID,
      scope: publicScope,
      query: { source: "text", intent: "diagnostic exposure guard" },
      nodes: [{
        id: seededNode.id,
        type: "concept",
        tier: "warm",
        title: "Prior diagnostic guide memory",
        text_summary: "This real prior keeps the diagnostic guide projection complete.",
        slots: { positive_attributed_use_count: 2 },
        confidence: 0.95,
        salience: 0.9,
        created_at: EVIDENCE_AT,
      }],
    });
    const diagnosticGuide = createProductGuideService({
      env: guideEnv(publicScope),
      liteWriteStore: scenario.runtime.writeStore,
      learningEpisodeLedgerAccess: scenario.runtime.learningEpisodeLedgerAccess,
      learningExperimentResolverRegistry: createConfirmatoryPassedRegistry(),
      admissionCandidatePolicyProfileRules: [profile],
      memoryWrite: scenario.runtime.memoryWrite,
    });
    const envelope = {
      contract_version: "host_task_envelope_v1" as const,
      host_task_id: "diagnostic-guard-host-task",
      collector_id: profile.experiment.collection_sources[0]!.collector_id,
      collector_version: profile.experiment.collection_sources[0]!.collector_version,
      task_family: CONFIRMATORY_TASK_FAMILY,
      task_signature: "diagnostic-guard-task-signature",
      repository_signature: "aionis-runtime-focused",
      source_task_sha256: sha256("diagnostic-guard-source-task"),
      source_event_sha256: sha256("diagnostic-guard-source-event"),
      created_at: EVIDENCE_AT,
    };
    const input = ProductGuideRequest.parse({
      operation_id: "diagnostic-guard-guide-operation",
      tenant_id: CONFIRMATORY_TENANT_ID,
      scope: publicScope,
      run_id: "diagnostic-guard-run",
      consumer_agent_id: principal.agent_id,
      query_text: "Return the normal integrity-only diagnostic control guide.",
      context: {
        task_family: envelope.task_family,
        task_signature: envelope.task_signature,
        repository_signature: envelope.repository_signature,
      },
      host_task_envelope_v1: envelope,
    });
    const before = guideCounts(scenario.runtime, storeScope);
    const result = await diagnosticGuide.execute(input, {
      principal,
      planningContext: async () => ({
        tenant_id: CONFIRMATORY_TENANT_ID,
        scope: publicScope,
        recall: { aionis_memory_packet: memoryPacket },
      }),
      applyIdentity: (value) => value,
    });
    const policy = guidePolicy(result);
    assert.equal(policy.mode, "shadow");
    assert.equal(policy.serving_arm, "control");
    assert.equal(policy.enrollment_state, "diagnostic");
    assert.equal(policy.promotion_eligible, false);
    assert.deepEqual(policy.reason_codes, ["diagnostic_assignment", "control_arm_served"]);
    assertGuideCommittedWithExposure(
      before,
      guideCounts(scenario.runtime, storeScope),
    );
    const exposure = scenario.runtime.database.db.prepare(
      `SELECT evidence_intent, assignment_mode, served_arm,
              namespace_lease_id, promotion_eligible
       FROM lite_learning_episode_events
       WHERE event_kind = 'exposure_committed'
       ORDER BY row_id DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    assert.ok(exposure);
    assert.equal(exposure.evidence_intent, "integrity_only");
    assert.equal(exposure.assignment_mode, "diagnostic_randomized");
    assert.equal(exposure.served_arm, "control");
    assert.equal(exposure.namespace_lease_id, null);
    assert.equal(exposure.promotion_eligible, 0);
    assertGuideOperationLinked(scenario.runtime, "diagnostic-guard-guide-operation");
  } finally {
    await scenario.runtime.close();
    fs.rmSync(scenario.temp.directory, { recursive: true, force: true });
  }
});
