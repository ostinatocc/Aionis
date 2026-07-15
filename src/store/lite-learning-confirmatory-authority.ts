import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import {
  LEARNING_STORE_SCOPE_MAX_UTF8_BYTES,
  type ExposureCommittedV1,
  type LearningLedgerItem,
} from "../memory/learning-episode-ledger.js";
import type { SqliteDatabase } from "./sqlite.js";

export type LiteLearningSqlValue = string | number | bigint | Uint8Array | null;
export type LiteLearningAuthorityRow = Readonly<Record<string, LiteLearningSqlValue>>;

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

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(row: LiteLearningAuthorityRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function requiredInteger(row: LiteLearningAuthorityRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Missing integer ${field}`);
  return value;
}

function canonicalAuthorityRowWithoutDigest(
  row: LiteLearningAuthorityRow,
  digestField: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function learningCollectionPrincipalBindingDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify({
    tenant_id: row.tenant_id,
    collection_principal_sha256: row.collection_principal_sha256,
    collection_class: row.collection_class,
    collector_id: row.collector_id,
    collector_version: row.collector_version,
    verifier_policy_sha256: row.verifier_policy_sha256,
  }));
}

export function learningRandomizationPairRecordDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "pair_record_sha256")));
}

export function learningRandomizationPairIdentityDigest(row: LiteLearningAuthorityRow): string {
  const memberMemoryNamespaceSha256s = [
    requiredString(row, "member_0_memory_namespace_sha256"),
    requiredString(row, "member_1_memory_namespace_sha256"),
  ].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (memberMemoryNamespaceSha256s[0] === memberMemoryNamespaceSha256s[1]) {
    throw new Error("randomization pair identity requires two distinct memory namespaces");
  }
  return sha256Text(stableStringify({
    contract_version: "aionis_learning_randomization_pair_identity_v1",
    tenant_id: requiredString(row, "tenant_id"),
    member_memory_namespace_sha256s: memberMemoryNamespaceSha256s,
    matching_covariate_sha256: requiredString(row, "matching_covariate_sha256"),
  }));
}

export function learningRandomizationPairManifestDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  const manifest = [...rows]
    .sort((left, right) => requiredInteger(left, "pair_ordinal") - requiredInteger(right, "pair_ordinal"))
    .map((row) => ({
      pair_ordinal: requiredInteger(row, "pair_ordinal"),
      randomization_pair_sha256: requiredString(row, "randomization_pair_sha256"),
      pair_record_sha256: requiredString(row, "pair_record_sha256"),
    }));
  return sha256Text(stableStringify(manifest));
}

export function learningActivationScheduleDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  const waves = new Map<number, {
    activation_wave_index: number;
    activation_starts_at: string;
    index_window_ends_at: string;
    wave_analysis_at: string;
    pair_count: number;
  }>();
  for (const row of rows) {
    const wave = requiredInteger(row, "activation_wave_index");
    const value = {
      activation_wave_index: wave,
      activation_starts_at: requiredString(row, "activation_starts_at"),
      index_window_ends_at: requiredString(row, "index_window_ends_at"),
      wave_analysis_at: requiredString(row, "wave_analysis_at"),
      pair_count: 1,
    };
    const existing = waves.get(wave);
    if (existing) {
      if (existing.activation_starts_at !== value.activation_starts_at
        || existing.index_window_ends_at !== value.index_window_ends_at
        || existing.wave_analysis_at !== value.wave_analysis_at) {
        throw new Error(`activation wave ${wave} has inconsistent schedule rows`);
      }
      existing.pair_count += 1;
    } else {
      waves.set(wave, value);
    }
  }
  return sha256Text(stableStringify([...waves.values()].sort(
    (left, right) => left.activation_wave_index - right.activation_wave_index,
  )));
}

export function learningConfirmatoryAttemptDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "attempt_sha256")));
}

export function learningExternalRunReservationDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "reservation_sha256")));
}

export function learningExternalTicketConsumptionDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(stableStringify(canonicalAuthorityRowWithoutDigest(row, "consumption_sha256")));
}

export function learningEvidenceArtifactReportDigest(row: LiteLearningAuthorityRow): string {
  return sha256Text(requiredString(row, "report_json"));
}

export function assertExposureActiveNamespaceLeaseIsolation(
  db: SqliteDatabase,
  row: LiteLearningAuthorityRow,
  payload: ExposureCommittedV1,
  items: readonly LearningLedgerItem[],
): void {
  const touchedNamespaces = new Map<string, Set<string>>();
  const addTouchedScope = (scope: string, source: string): void => {
    const memoryNamespaceSha256 = sha256Text(scope);
    const sources = touchedNamespaces.get(memoryNamespaceSha256) ?? new Set<string>();
    sources.add(source);
    touchedNamespaces.set(memoryNamespaceSha256, sources);
  };
  if (payload.memory_namespace_sha256 !== null) {
    const sources = touchedNamespaces.get(payload.memory_namespace_sha256) ?? new Set<string>();
    sources.add("direct_namespace");
    touchedNamespaces.set(payload.memory_namespace_sha256, sources);
  }
  if (typeof row.source_commit_id === "string" && row.source_commit_id.length > 0) {
    const sourceCommit = db.prepare(
      "SELECT scope FROM lite_memory_commits WHERE id = ? LIMIT 1",
    ).get(row.source_commit_id) as { scope: string } | undefined;
    if (sourceCommit) addTouchedScope(sourceCommit.scope, "source_commit_scope");
  }
  const memoryNodeScope = db.prepare(
    "SELECT scope FROM lite_memory_nodes WHERE id = ? LIMIT 1",
  );
  for (const item of items) {
    const node = memoryNodeScope.get(item.memory_id) as { scope: string } | undefined;
    if (node) addTouchedScope(node.scope, "exposure_item_node_scope");
  }

  const activeLeases = [...touchedNamespaces.keys()].map((memoryNamespaceSha256) => db.prepare(
    `SELECT * FROM lite_learning_namespace_leases
     WHERE tenant_id = ? AND memory_namespace_sha256 = ? AND status = 'active'`,
  ).get(row.tenant_id, memoryNamespaceSha256) as LiteLearningAuthorityRow | undefined)
    .filter((lease): lease is LiteLearningAuthorityRow => lease !== undefined);
  if (activeLeases.length === 0) return;

  const activeLease = activeLeases.length === 1 ? activeLeases[0]! : null;
  const pair = activeLease === null
    ? undefined
    : db.prepare(
      `SELECT * FROM lite_learning_randomization_pairs
       WHERE tenant_id = ? AND confirmatory_attempt_id = ?
         AND randomization_pair_sha256 = ?`,
    ).get(
      activeLease.tenant_id,
      activeLease.confirmatory_attempt_id,
      activeLease.randomization_pair_sha256,
    ) as LiteLearningAuthorityRow | undefined;
  const attempt = activeLease === null
    ? undefined
    : db.prepare(
      `SELECT confirmatory_attempt_id
       FROM lite_learning_confirmatory_attempts
       WHERE tenant_id = ? AND experiment_id = ? AND experiment_revision = ?`,
    ).get(
      activeLease.tenant_id,
      activeLease.experiment_id,
      activeLease.experiment_revision,
    ) as { confirmatory_attempt_id: string } | undefined;
  const principal = payload.collection_principal_sha256 === null
    ? undefined
    : db.prepare(
      `SELECT collection_class
       FROM lite_learning_collection_principal_bindings
       WHERE tenant_id = ? AND collection_principal_sha256 = ?`,
    ).get(row.tenant_id, payload.collection_principal_sha256) as {
      collection_class: string;
    } | undefined;
  const memberOrdinal = activeLease === null ? -1 : Number(activeLease.pair_member_ordinal);
  const pairMemberNamespace = pair === undefined || (memberOrdinal !== 0 && memberOrdinal !== 1)
    ? null
    : pair[memberOrdinal === 0
      ? "member_0_memory_namespace_sha256"
      : "member_1_memory_namespace_sha256"];
  const exactConfirmatoryChain = activeLease !== null
    && pair !== undefined
    && attempt !== undefined
    && principal?.collection_class === "eligible_host"
    && payload.operation_protection === "protected"
    && payload.collection_class === "eligible_host"
    && payload.evidence_intent === "confirmatory"
    && payload.assignment_algorithm === "matched_pair_csprng_bit_v1"
    && payload.memory_namespace_sha256 === activeLease.memory_namespace_sha256
    && touchedNamespaces.has(requiredString(activeLease, "memory_namespace_sha256"))
    && activeLeases.every((lease) => lease.memory_namespace_sha256 === payload.memory_namespace_sha256)
    && row.enrollment_state === "enrolled"
    && row.serving_phase === "active_control"
    && row.assignment_mode === "matched_pair_randomized"
    && row.experiment_id === activeLease.experiment_id
    && row.experiment_revision === activeLease.experiment_revision
    && payload.namespace_lease_id === activeLease.namespace_lease_id
    && payload.namespace_lease_generation === activeLease.lease_generation
    && payload.namespace_set_sha256 === activeLease.namespace_set_sha256
    && payload.randomization_pair_sha256 === activeLease.randomization_pair_sha256
    && payload.matching_covariate_sha256 === pair.matching_covariate_sha256
    && payload.pair_member_ordinal === activeLease.pair_member_ordinal
    && pairMemberNamespace === activeLease.memory_namespace_sha256
    && payload.assignment_arm === activeLease.assigned_arm
    && payload.activation_wave_index === activeLease.activation_wave_index
    && payload.activation_starts_at === activeLease.activation_starts_at
    && payload.index_window_ends_at === activeLease.index_window_ends_at
    && payload.wave_analysis_at === activeLease.wave_analysis_at
    && attempt.confirmatory_attempt_id === activeLease.confirmatory_attempt_id
    && String(activeLease.acquired_at) <= requiredString(row, "recorded_at");
  const activationWindowActive = activeLease !== null
    && requiredString(row, "recorded_at") >= requiredString(activeLease, "activation_starts_at")
    && requiredString(row, "recorded_at") <= requiredString(activeLease, "index_window_ends_at");
  const formalConfirmatoryExposure = activationWindowActive
    && payload.served_arm === payload.assignment_arm
    && Number(row.promotion_eligible) === 1;
  const explicitFailControl = payload.served_arm === "control"
    && Number(row.promotion_eligible) === 0;
  if (!exactConfirmatoryChain || (!formalConfirmatoryExposure && !explicitFailControl)) {
    const sources = [...new Set(activeLeases.flatMap((lease) => [
      ...(touchedNamespaces.get(requiredString(lease, "memory_namespace_sha256")) ?? []),
    ]))].sort();
    throw new Error(`learning_active_namespace_lease_isolation_violation:${sources.join("+")}`);
  }
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

export function scanConfirmatoryPreTreatmentLineage(
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
