import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import { LEARNING_STORE_SCOPE_MAX_UTF8_BYTES } from
  "../../../../src/memory/learning-episode-ledger.js";
import {
  liteLearningFixedExperimentAuthorityCanonicalContract,
} from "../../../../src/store/lite-learning-episode-ledger.js";
import {
  learningCollectionPrincipalBindingDigest,
  type LiteLearningAuthorityRow,
} from "../../../../src/store/lite-learning-confirmatory-authority.js";
import type { LiteRuntimeDatabase } from
  "../../../../src/store/lite-runtime-database.js";
import type { SqliteDatabase } from "../../../../src/store/sqlite.js";
import type { AuthorityReceiptResolvedKeyring } from
  "../../../../src/util/authority-receipt-keys.js";
import {
  assertLiteRuntimeProtectedAuthorityTransactionCapability,
  type LiteRuntimeProtectedAuthorityTransactionCapability,
} from "./lite-runtime-protected-authority-database.js";

const {
  assertCanonicalJsonDigest,
  assertExactRowShape,
  assertExperimentRevisionOpenForFreshWrite,
  assertLiteLearningEpisodeLedgerIntegrity,
  parseFrozenHostVerifierPolicy,
  requiredInteger,
  requiredString,
  validateAuthorityFactReferences,
  validateConfirmatoryAttempt,
  validateExperimentRevision,
  validateGateEvidenceEvaluation,
  validateNamespaceLeaseSet,
  validatePolicyVersion,
  validateRandomizationManifest,
} = liteLearningFixedExperimentAuthorityCanonicalContract;

export type LiteLearningConfirmatoryPreTreatmentLineageMember = Readonly<{
  storeScopeKey: string;
  memoryNamespaceSha256: string;
  assignmentUnitSha256: string;
}>;

export type LiteLearningConfirmatoryPreTreatmentLineageMemberSnapshot = Readonly<{
  memory_namespace_sha256: string;
  assignment_unit_sha256: string;
  prior_memory_node_count: number;
  prior_memory_node_head_sha256: string;
  prior_memory_commit_count: number;
  prior_memory_commit_head_sha256: string;
  prior_snapshot_sha256: string;
}>;

export type LiteLearningConfirmatoryPreTreatmentLineageSnapshot = Readonly<{
  contract_version: "aionis_learning_confirmatory_pre_treatment_lineage_v1";
  tenant_id: string;
  experiment_id: string;
  experiment_revision: number;
  member_count: 768;
  namespace_set_sha256: string;
  assignment_unit_set_sha256: string;
  prior_memory_node_count: number;
  prior_memory_node_head_sha256: string;
  prior_memory_commit_count: number;
  prior_memory_commit_head_sha256: string;
  member_snapshot_set_sha256: string;
  members: readonly LiteLearningConfirmatoryPreTreatmentLineageMemberSnapshot[];
  snapshot_sha256: string;
}>;

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return Buffer.from(left).equals(Buffer.from(right));
  }
  if (typeof left === "bigint" || typeof right === "bigint") {
    try {
      return BigInt(left as bigint | number | string) === BigInt(right as bigint | number | string);
    } catch {
      return false;
    }
  }
  return left === right;
}

function selectExactRow(
  db: SqliteDatabase,
  table: string,
  replayKeys: readonly string[],
  values: LiteLearningAuthorityRow,
): Record<string, unknown> | null {
  for (const key of replayKeys) {
    if (!(key in values)) throw new Error(`Missing replay key ${table}.${key}`);
  }
  const where = replayKeys.map((key) => `${key} IS ?`).join(" AND ");
  return (db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`)
    .get(...replayKeys.map((key) => values[key])) as Record<string, unknown> | undefined) ?? null;
}

function assertExactReplay(
  table: string,
  existing: Readonly<Record<string, unknown>>,
  values: LiteLearningAuthorityRow,
): void {
  for (const [column, expected] of Object.entries(values)) {
    if (!valuesEqual(existing[column], expected)) {
      throw new Error(`learning_authority_replay_conflict:${table}.${column}`);
    }
  }
}

function insertExactImmutableRow(
  db: SqliteDatabase,
  table: string,
  values: LiteLearningAuthorityRow,
  replayKeys: readonly string[],
): { row: Record<string, unknown>; replayed: boolean } {
  const columns = assertExactRowShape(table, values);
  const existing = selectExactRow(db, table, replayKeys, values);
  if (existing) {
    assertExactReplay(table, existing, values);
    return { row: existing, replayed: true };
  }
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => values[column]));
  const inserted = selectExactRow(db, table, replayKeys, values);
  if (!inserted) throw new Error(`learning_authority_insert_missing:${table}`);
  return { row: inserted, replayed: false };
}

let savepointSequence = 0;

function withSavepoint<T>(db: SqliteDatabase, operation: string, fn: () => T): T {
  savepointSequence += 1;
  const savepoint = `learning_fixed_${operation}_${savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CONFIRMATORY_PRE_TREATMENT_ROWS_PER_NAMESPACE_LIMIT = 4096;

function canonicalPreTreatmentLineageHead(
  projectionKind: string,
  rows: readonly Readonly<Record<string, unknown>>[],
): string {
  let head = sha256Text(stableStringify({
    contract_version: "aionis_learning_confirmatory_pre_treatment_head_v1",
    projection_kind: projectionKind,
    genesis: true,
  }));
  for (const row of rows) {
    head = sha256Text(stableStringify({
      contract_version: "aionis_learning_confirmatory_pre_treatment_head_v1",
      projection_kind: projectionKind,
      previous_head_sha256: head,
      row_sha256: sha256Text(stableStringify(row)),
    }));
  }
  return head;
}

function validateConfirmatoryPreTreatmentLineageMember(
  tenantId: string,
  member: LiteLearningConfirmatoryPreTreatmentLineageMember,
): void {
  if (member.storeScopeKey.length === 0
    || member.storeScopeKey !== member.storeScopeKey.trim()
    || Buffer.byteLength(member.storeScopeKey, "utf8") > LEARNING_STORE_SCOPE_MAX_UTF8_BYTES
    || member.storeScopeKey.includes("\u0000")) {
    throw new Error("confirmatory pre-treatment store scope must be exact and bounded");
  }
  if (member.storeScopeKey.startsWith("tenant:")) {
    const expectedPrefix = `tenant:${tenantId}::scope:`;
    const publicScope = member.storeScopeKey.startsWith(expectedPrefix)
      ? member.storeScopeKey.slice(expectedPrefix.length)
      : "";
    if (publicScope.length === 0 || publicScope.startsWith("tenant:")) {
      throw new Error("confirmatory pre-treatment store scope tenant binding mismatch");
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(member.memoryNamespaceSha256)
    || member.memoryNamespaceSha256 !== sha256Text(member.storeScopeKey)) {
    throw new Error("confirmatory pre-treatment memory namespace mapping mismatch");
  }
  const expectedAssignmentUnitSha256 = sha256Text(stableStringify({
    tenant_id: tenantId,
    memory_namespace_sha256: member.memoryNamespaceSha256,
  }));
  if (!/^[0-9a-f]{64}$/u.test(member.assignmentUnitSha256)
    || member.assignmentUnitSha256 !== expectedAssignmentUnitSha256) {
    throw new Error("confirmatory pre-treatment assignment-unit mapping mismatch");
  }
}

function scanConfirmatoryPreTreatmentLineage(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
    members: readonly LiteLearningConfirmatoryPreTreatmentLineageMember[];
  },
): LiteLearningConfirmatoryPreTreatmentLineageSnapshot {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(args.tenantId)) {
    throw new Error("confirmatory pre-treatment tenant ID is invalid");
  }
  if (args.experimentId.length === 0
    || args.experimentId !== args.experimentId.trim()
    || Buffer.byteLength(args.experimentId, "utf8") > 256
    || args.experimentId.includes("\u0000")) {
    throw new Error("confirmatory pre-treatment experiment ID must be exact and bounded");
  }
  if (!Number.isInteger(args.experimentRevision) || args.experimentRevision < 1) {
    throw new Error("confirmatory pre-treatment experiment revision must be positive");
  }
  if (args.members.length !== 768) {
    throw new Error("confirmatory pre-treatment lineage scan requires exactly 768 members");
  }

  const storeScopeKeys = new Set<string>();
  const memoryNamespaceSha256s = new Set<string>();
  const assignmentUnitSha256s = new Set<string>();
  for (const member of args.members) {
    validateConfirmatoryPreTreatmentLineageMember(args.tenantId, member);
    if (storeScopeKeys.has(member.storeScopeKey)
      || memoryNamespaceSha256s.has(member.memoryNamespaceSha256)
      || assignmentUnitSha256s.has(member.assignmentUnitSha256)) {
      throw new Error("confirmatory pre-treatment lineage members must be unique");
    }
    storeScopeKeys.add(member.storeScopeKey);
    memoryNamespaceSha256s.add(member.memoryNamespaceSha256);
    assignmentUnitSha256s.add(member.assignmentUnitSha256);
  }
  const members = [...args.members].sort((left, right) => Buffer.compare(
    Buffer.from(left.memoryNamespaceSha256, "utf8"),
    Buffer.from(right.memoryNamespaceSha256, "utf8"),
  ));

  const directExposure = db.prepare(
    `SELECT row_id
     FROM lite_learning_episode_events
     WHERE tenant_id = ? AND event_kind = 'exposure_committed'
       AND (memory_namespace_sha256 = ? OR assignment_unit_sha256 = ?)
     ORDER BY row_id LIMIT 1`,
  );
  const activeNamespaceLease = db.prepare(
    `SELECT namespace_lease_id
     FROM lite_learning_namespace_leases
     WHERE tenant_id = ? AND memory_namespace_sha256 = ? AND status = 'active'
     LIMIT 1`,
  );
  const sourceCommitExposure = db.prepare(
    `SELECT event.row_id
     FROM lite_learning_episode_events AS event
     JOIN lite_memory_commits AS commit_row ON commit_row.id = event.source_commit_id
     WHERE event.tenant_id = ? AND event.event_kind = 'exposure_committed'
       AND commit_row.scope = ?
     ORDER BY event.row_id LIMIT 1`,
  );
  const itemNodeExposure = db.prepare(
    `SELECT event.row_id
     FROM lite_learning_episode_events AS event
     JOIN lite_learning_exposure_items AS item
       ON item.tenant_id = event.tenant_id
      AND item.scope = event.scope
      AND item.event_id = event.event_id
     JOIN lite_memory_nodes AS node ON node.id = item.memory_id
     WHERE event.tenant_id = ? AND event.event_kind = 'exposure_committed'
       AND node.scope = ?
     ORDER BY event.row_id LIMIT 1`,
  );
  const legacyGuideReceipt = db.prepare(
    `SELECT receipt.guide_trace_id
     FROM lite_product_guide_receipts AS receipt
     JOIN lite_memory_commits AS commit_row ON commit_row.id = receipt.commit_id
     WHERE receipt.tenant_id = ? AND commit_row.scope = ?
     ORDER BY receipt.created_at, receipt.guide_trace_id LIMIT 1`,
  );
  const legacyGuideNode = db.prepare(
    `SELECT id
     FROM lite_memory_nodes
     WHERE scope = ? AND json_valid(slots_json)
       AND json_type(slots_json, '$.guide_exposure_v1') IS NOT NULL
     ORDER BY created_at, id LIMIT 1`,
  );
  const priorNodes = db.prepare(
    `SELECT id, client_id, type, tier, title, text_summary, slots_json,
            raw_ref, evidence_ref, memory_lane, producer_agent_id,
            owner_agent_id, owner_team_id, salience, importance, confidence,
            redaction_version, commit_id, created_at
     FROM lite_memory_nodes
     WHERE scope = ?
     ORDER BY created_at, id
     LIMIT ${CONFIRMATORY_PRE_TREATMENT_ROWS_PER_NAMESPACE_LIMIT + 1}`,
  );
  const priorCommits = db.prepare(
    `SELECT id, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at
     FROM lite_memory_commits
     WHERE scope = ?
     ORDER BY created_at, id
     LIMIT ${CONFIRMATORY_PRE_TREATMENT_ROWS_PER_NAMESPACE_LIMIT + 1}`,
  );

  for (const member of members) {
    const conflictKind = activeNamespaceLease.get(
      args.tenantId,
      member.memoryNamespaceSha256,
    ) !== undefined
      ? "active_namespace_lease"
      : directExposure.get(
        args.tenantId,
        member.memoryNamespaceSha256,
        member.assignmentUnitSha256,
      ) !== undefined
        ? "direct_exposure"
        : sourceCommitExposure.get(args.tenantId, member.storeScopeKey) !== undefined
          ? "exposure_source_commit"
          : itemNodeExposure.get(args.tenantId, member.storeScopeKey) !== undefined
            ? "exposure_item_node"
            : legacyGuideReceipt.get(args.tenantId, member.storeScopeKey) !== undefined
              ? "legacy_guide_receipt_commit"
              : legacyGuideNode.get(member.storeScopeKey) !== undefined
                ? "legacy_guide_node"
                : null;
    if (conflictKind !== null) {
      throw new Error(
        `learning_confirmatory_pre_treatment_lineage_conflict:${conflictKind}:${member.memoryNamespaceSha256}`,
      );
    }
  }

  const memberSnapshots: LiteLearningConfirmatoryPreTreatmentLineageMemberSnapshot[] = [];
  for (const member of members) {
    const nodeRows = priorNodes.all(member.storeScopeKey) as Array<Record<string, unknown>>;
    const commitRows = priorCommits.all(member.storeScopeKey) as Array<Record<string, unknown>>;
    if (nodeRows.length === 0 && commitRows.length === 0) {
      throw new Error(
        `learning_confirmatory_pre_treatment_lineage_conflict:unknown_existing_scope:${member.memoryNamespaceSha256}`,
      );
    }
    if (nodeRows.length > CONFIRMATORY_PRE_TREATMENT_ROWS_PER_NAMESPACE_LIMIT
      || commitRows.length > CONFIRMATORY_PRE_TREATMENT_ROWS_PER_NAMESPACE_LIMIT) {
      throw new Error(
        `learning_confirmatory_pre_treatment_snapshot_bound_exceeded:${member.memoryNamespaceSha256}`,
      );
    }
    const priorMemoryNodeHeadSha256 = canonicalPreTreatmentLineageHead("memory_node", nodeRows);
    const priorMemoryCommitHeadSha256 = canonicalPreTreatmentLineageHead("memory_commit", commitRows);
    const snapshotBase = {
      memory_namespace_sha256: member.memoryNamespaceSha256,
      assignment_unit_sha256: member.assignmentUnitSha256,
      prior_memory_node_count: nodeRows.length,
      prior_memory_node_head_sha256: priorMemoryNodeHeadSha256,
      prior_memory_commit_count: commitRows.length,
      prior_memory_commit_head_sha256: priorMemoryCommitHeadSha256,
    };
    memberSnapshots.push({
      ...snapshotBase,
      prior_snapshot_sha256: sha256Text(stableStringify(snapshotBase)),
    });
  }

  const priorMemoryNodeCount = memberSnapshots.reduce(
    (total, member) => total + member.prior_memory_node_count,
    0,
  );
  const priorMemoryCommitCount = memberSnapshots.reduce(
    (total, member) => total + member.prior_memory_commit_count,
    0,
  );
  const priorMemoryNodeHeadSha256 = canonicalPreTreatmentLineageHead(
    "namespace_memory_node_head",
    memberSnapshots.map((member) => ({
      memory_namespace_sha256: member.memory_namespace_sha256,
      prior_memory_node_count: member.prior_memory_node_count,
      prior_memory_node_head_sha256: member.prior_memory_node_head_sha256,
    })),
  );
  const priorMemoryCommitHeadSha256 = canonicalPreTreatmentLineageHead(
    "namespace_memory_commit_head",
    memberSnapshots.map((member) => ({
      memory_namespace_sha256: member.memory_namespace_sha256,
      prior_memory_commit_count: member.prior_memory_commit_count,
      prior_memory_commit_head_sha256: member.prior_memory_commit_head_sha256,
    })),
  );
  const memberSnapshotSetSha256 = sha256Text(stableStringify(memberSnapshots.map((member) => ({
    memory_namespace_sha256: member.memory_namespace_sha256,
    prior_snapshot_sha256: member.prior_snapshot_sha256,
  }))));
  const snapshotBase = {
    contract_version: "aionis_learning_confirmatory_pre_treatment_lineage_v1" as const,
    tenant_id: args.tenantId,
    experiment_id: args.experimentId,
    experiment_revision: args.experimentRevision,
    member_count: 768 as const,
    namespace_set_sha256: sha256Text(stableStringify(
      memberSnapshots.map((member) => member.memory_namespace_sha256),
    )),
    assignment_unit_set_sha256: sha256Text(stableStringify(
      memberSnapshots.map((member) => member.assignment_unit_sha256).sort(),
    )),
    prior_memory_node_count: priorMemoryNodeCount,
    prior_memory_node_head_sha256: priorMemoryNodeHeadSha256,
    prior_memory_commit_count: priorMemoryCommitCount,
    prior_memory_commit_head_sha256: priorMemoryCommitHeadSha256,
    member_snapshot_set_sha256: memberSnapshotSetSha256,
    members: memberSnapshots,
  };
  return {
    ...snapshotBase,
    snapshot_sha256: sha256Text(stableStringify(snapshotBase)),
  };
}

export type LiteLearningExperimentAuthorityFactTable =
  | "lite_learning_experiment_closures"
  | "lite_learning_authorization_nonces"
  | "lite_learning_evidence_artifacts"
  | "lite_learning_gate_look_reservations"
  | "lite_learning_gate_decisions"
  | "lite_learning_gate_artifact_memberships";

export type LiteLearningFixedExperimentAuthorityAccess = Readonly<{
  scanConfirmatoryPreTreatmentLineage(args: {
    tenantId: string;
    experimentId: string;
    experimentRevision: number;
    members: readonly LiteLearningConfirmatoryPreTreatmentLineageMember[];
  }): Promise<LiteLearningConfirmatoryPreTreatmentLineageSnapshot>;
  insertPolicyVersion(row: LiteLearningAuthorityRow): Promise<{
    row: Record<string, unknown>;
    replayed: boolean;
  }>;
  insertCollectionPrincipalBinding(row: LiteLearningAuthorityRow): Promise<{
    row: Record<string, unknown>;
    replayed: boolean;
  }>;
  insertExperimentRevision(row: LiteLearningAuthorityRow): Promise<{
    row: Record<string, unknown>;
    replayed: boolean;
  }>;
  provisionConfirmatorySet(args: {
    revision: LiteLearningAuthorityRow;
    attempt: LiteLearningAuthorityRow;
    pairs: readonly LiteLearningAuthorityRow[];
    leases: readonly LiteLearningAuthorityRow[];
  }): Promise<{ replayed: boolean }>;
  reserveGateLook(args: {
    artifact: LiteLearningAuthorityRow;
    reservation: LiteLearningAuthorityRow;
  }): Promise<{
    artifact: Record<string, unknown>;
    reservation: Record<string, unknown>;
    replayed: boolean;
  }>;
  insertGateEvidenceEvaluation(args: {
    decision: LiteLearningAuthorityRow;
    memberships: readonly LiteLearningAuthorityRow[];
  }): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
  insertExperimentAuthorityFact(
    table: LiteLearningExperimentAuthorityFactTable,
    row: LiteLearningAuthorityRow,
  ): Promise<{ row: Record<string, unknown>; replayed: boolean }>;
}>;

/**
 * Private operator-side authority for fixed experiment provisioning and gate
 * mutations. The focused Runtime never imports or composes this access.
 */
export function createLiteLearningFixedExperimentAuthorityAccess(args: {
  database: LiteRuntimeDatabase;
  capability: LiteRuntimeProtectedAuthorityTransactionCapability;
  authorityReceiptKeyring?: AuthorityReceiptResolvedKeyring;
}): LiteLearningFixedExperimentAuthorityAccess {
  const { db } = args.database;
  const assertMutationAuthority = (): void => {
    assertLiteRuntimeProtectedAuthorityTransactionCapability(
      args.capability,
      args.database,
    );
  };
  const assertLedgerIntegrity = (): void => {
    assertLiteLearningEpisodeLedgerIntegrity(
      db,
      new Date().toISOString(),
      { authorityReceiptKeyring: args.authorityReceiptKeyring },
    );
  };
  assertMutationAuthority();

  return {
    async scanConfirmatoryPreTreatmentLineage(input) {
      assertMutationAuthority();
      return scanConfirmatoryPreTreatmentLineage(db, input);
    },

    async insertPolicyVersion(row) {
      assertMutationAuthority();
      validatePolicyVersion(row);
      return insertExactImmutableRow(db, "lite_learning_policy_versions", row, [
        "tenant_id", "policy_kind", "policy_id", "policy_version",
      ]);
    },

    async insertCollectionPrincipalBinding(row) {
      assertMutationAuthority();
      assertCanonicalJsonDigest(row, "verifier_policy_json", "verifier_policy_sha256");
      parseFrozenHostVerifierPolicy(requiredString(row, "verifier_policy_json"));
      if (row.binding_sha256 !== learningCollectionPrincipalBindingDigest(row)) {
        throw new Error("collection principal binding digest mismatch");
      }
      return insertExactImmutableRow(db, "lite_learning_collection_principal_bindings", row, [
        "tenant_id", "collection_principal_sha256",
      ]);
    },

    async insertExperimentRevision(row) {
      assertMutationAuthority();
      const existingRevision = selectExactRow(db, "lite_learning_experiment_revisions", [
        "tenant_id", "experiment_id", "experiment_revision",
      ], row);
      validateExperimentRevision(db, row, existingRevision === null ? "fresh_write" : "stored_replay");
      if (row.evidence_intent === "confirmatory") {
        throw new Error("confirmatory revisions must use atomic provisionConfirmatorySet");
      }
      return insertExactImmutableRow(db, "lite_learning_experiment_revisions", row, [
        "tenant_id", "experiment_id", "experiment_revision",
      ]);
    },

    async provisionConfirmatorySet(input) {
      assertMutationAuthority();
      const existingRevision = selectExactRow(db, "lite_learning_experiment_revisions", [
        "tenant_id", "experiment_id", "experiment_revision",
      ], input.revision);
      validateExperimentRevision(
        db,
        input.revision,
        existingRevision === null ? "fresh_write" : "stored_replay",
      );
      if (input.revision.evidence_intent !== "confirmatory") {
        throw new Error("atomic confirmatory provisioning requires evidence_intent=confirmatory");
      }
      const manifest = validateRandomizationManifest(input.pairs, input.attempt);
      for (const owner of [input.revision, input.attempt]) {
        if (owner.randomization_pair_manifest_sha256 !== manifest.pairManifestSha256) {
          throw new Error("confirmatory pair-manifest digest mismatch");
        }
        if (owner.activation_schedule_sha256 !== manifest.activationScheduleSha256) {
          throw new Error("confirmatory activation-schedule digest mismatch");
        }
      }
      return withSavepoint(db, "provision_confirmatory_set", () => {
        const revisionResult = insertExactImmutableRow(
          db,
          "lite_learning_experiment_revisions",
          input.revision,
          ["tenant_id", "experiment_id", "experiment_revision"],
        );
        const existingAttempt = selectExactRow(db, "lite_learning_confirmatory_attempts", [
          "tenant_id", "confirmatory_attempt_id",
        ], input.attempt);
        if (existingAttempt) {
          assertExactReplay("lite_learning_confirmatory_attempts", existingAttempt, input.attempt);
        }
        validateConfirmatoryAttempt(db, input.attempt, { exactReplay: existingAttempt !== null });
        const attemptResult = insertExactImmutableRow(
          db,
          "lite_learning_confirmatory_attempts",
          input.attempt,
          ["tenant_id", "confirmatory_attempt_id"],
        );
        validateNamespaceLeaseSet(db, input.revision, input.attempt, input.pairs, input.leases);
        for (const pair of input.pairs) {
          if (pair.tenant_id !== input.attempt.tenant_id
            || pair.confirmatory_attempt_id !== input.attempt.confirmatory_attempt_id) {
            throw new Error("randomization pair attempt identity mismatch");
          }
          insertExactImmutableRow(db, "lite_learning_randomization_pairs", pair, [
            "tenant_id", "confirmatory_attempt_id", "randomization_pair_sha256",
          ]);
        }
        for (const lease of input.leases) {
          insertExactImmutableRow(db, "lite_learning_namespace_leases", lease, [
            "tenant_id", "namespace_lease_id",
          ]);
        }
        assertLedgerIntegrity();
        return {
          replayed: existingRevision !== null && revisionResult.replayed && attemptResult.replayed,
        };
      });
    },

    async reserveGateLook(input) {
      assertMutationAuthority();
      assertExactRowShape("lite_learning_evidence_artifacts", input.artifact);
      assertExactRowShape("lite_learning_gate_look_reservations", input.reservation);
      if (input.artifact.artifact_kind !== "runtime_integrity_gate") {
        throw new Error("reserveGateLook accepts a Runtime-integrity artifact only");
      }
      const existingArtifact = selectExactRow(db, "lite_learning_evidence_artifacts", [
        "tenant_id", "artifact_id",
      ], input.artifact);
      const existingReservation = selectExactRow(db, "lite_learning_gate_look_reservations", [
        "tenant_id", "reservation_id",
      ], input.reservation);
      if (Boolean(existingArtifact) !== Boolean(existingReservation)) {
        throw new Error("gate look artifact/reservation atomic prefix is incomplete");
      }
      if (existingArtifact && existingReservation) {
        assertExactReplay("lite_learning_evidence_artifacts", existingArtifact, input.artifact);
        assertExactReplay(
          "lite_learning_gate_look_reservations",
          existingReservation,
          input.reservation,
        );
        validateAuthorityFactReferences(db, "lite_learning_evidence_artifacts", input.artifact);
        validateAuthorityFactReferences(
          db,
          "lite_learning_gate_look_reservations",
          input.reservation,
        );
        return {
          artifact: existingArtifact,
          reservation: existingReservation,
          replayed: true,
        };
      }
      assertExperimentRevisionOpenForFreshWrite(db, {
        tenantId: requiredString(input.reservation, "tenant_id"),
        experimentId: requiredString(input.reservation, "experiment_id"),
        experimentRevision: requiredInteger(input.reservation, "experiment_revision"),
        operation: "gate_look_reservation",
      });
      const liveReplay = assertLiteLearningEpisodeLedgerIntegrity(
        db,
        new Date().toISOString(),
        { authorityReceiptKeyring: args.authorityReceiptKeyring },
      );
      if (liveReplay.control_job_dead_letter_count > 0) {
        throw new Error("learning control dead letters block a new gate look reservation");
      }
      const savepoint = "lite_learning_reserve_gate_look";
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        validateAuthorityFactReferences(db, "lite_learning_evidence_artifacts", input.artifact);
        const artifact = insertExactImmutableRow(
          db,
          "lite_learning_evidence_artifacts",
          input.artifact,
          ["tenant_id", "artifact_id"],
        );
        validateAuthorityFactReferences(
          db,
          "lite_learning_gate_look_reservations",
          input.reservation,
        );
        const reservation = insertExactImmutableRow(
          db,
          "lite_learning_gate_look_reservations",
          input.reservation,
          ["tenant_id", "reservation_id"],
        );
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return {
          artifact: artifact.row,
          reservation: reservation.row,
          replayed: false,
        };
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    },

    async insertGateEvidenceEvaluation(input) {
      assertMutationAuthority();
      const existingDecision = selectExactRow(db, "lite_learning_gate_decisions", [
        "tenant_id", "decision_id",
      ], input.decision);
      if (existingDecision) {
        assertExactReplay("lite_learning_gate_decisions", existingDecision, input.decision);
        const existingMemberships = db.prepare(
          `SELECT * FROM lite_learning_gate_artifact_memberships
           WHERE tenant_id = ? AND decision_id = ?
           ORDER BY artifact_role, role_ordinal, artifact_id`,
        ).all(input.decision.tenant_id, input.decision.decision_id) as Array<
          Record<string, unknown>
        >;
        const expected = [...input.memberships].sort((left, right) => {
          const leftKey = `${String(left.artifact_role)}\u0000${String(left.role_ordinal).padStart(12, "0")}\u0000${String(left.artifact_id)}`;
          const rightKey = `${String(right.artifact_role)}\u0000${String(right.role_ordinal).padStart(12, "0")}\u0000${String(right.artifact_id)}`;
          return Buffer.compare(Buffer.from(leftKey, "utf8"), Buffer.from(rightKey, "utf8"));
        });
        if (existingMemberships.length !== expected.length) {
          throw new Error("gate evidence evaluation replay membership count conflict");
        }
        for (const [index, membership] of expected.entries()) {
          assertExactReplay(
            "lite_learning_gate_artifact_memberships",
            existingMemberships[index]!,
            membership,
          );
        }
        validateGateEvidenceEvaluation(db, input.decision, input.memberships);
        return { row: existingDecision, replayed: true };
      }
      assertExperimentRevisionOpenForFreshWrite(db, {
        tenantId: requiredString(input.decision, "tenant_id"),
        experimentId: requiredString(input.decision, "experiment_id"),
        experimentRevision: requiredInteger(input.decision, "experiment_revision"),
        operation: "gate_evidence_evaluation",
      });
      validateGateEvidenceEvaluation(db, input.decision, input.memberships);
      return withSavepoint(db, "insert_gate_evidence_evaluation", () => {
        const inserted = insertExactImmutableRow(
          db,
          "lite_learning_gate_decisions",
          input.decision,
          ["tenant_id", "decision_id"],
        );
        for (const membership of input.memberships) {
          insertExactImmutableRow(db, "lite_learning_gate_artifact_memberships", membership, [
            "tenant_id", "decision_id", "artifact_id",
          ]);
        }
        return inserted;
      });
    },

    async insertExperimentAuthorityFact(table, row) {
      assertMutationAuthority();
      if (table === "lite_learning_experiment_closures") {
        throw new Error("experiment closures require the protected Task 3.0C close workflow");
      }
      if (table === "lite_learning_authorization_nonces") {
        throw new Error("learning authorization nonces require a protected signed-authority workflow");
      }
      if (table === "lite_learning_evidence_artifacts") {
        throw new Error(row.artifact_kind === "runtime_integrity_gate"
          ? "Runtime-integrity artifacts and look reservations require atomic reserveGateLook"
          : "external evidence artifacts require the protected Task 8 ingestion verifier");
      }
      if (table === "lite_learning_gate_look_reservations") {
        throw new Error("Runtime-integrity artifacts and look reservations require atomic reserveGateLook");
      }
      if (table === "lite_learning_gate_artifact_memberships"
        || row.decision_kind === "evidence_evaluation") {
        throw new Error(
          "gate evidence evaluations and memberships require atomic insertGateEvidenceEvaluation",
        );
      }
      if (row.decision_kind === "safety_stop") {
        throw new Error("automatic safety-stop decisions require the Runtime safety-stop workflow");
      }
      if (row.decision_kind !== "authority_adjudication") {
        throw new Error("unsupported experiment authority fact");
      }
      validateAuthorityFactReferences(db, table, row);
      return insertExactImmutableRow(db, table, row, ["tenant_id", "decision_id"]);
    },
  };
}
