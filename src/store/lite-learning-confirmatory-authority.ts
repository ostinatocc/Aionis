import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import {
  type ExposureCommittedV1,
  type LearningLedgerItem,
} from "../memory/learning-episode-ledger.js";
import type { SqliteDatabase } from "./sqlite.js";

export type LiteLearningSqlValue = string | number | bigint | Uint8Array | null;
export type LiteLearningAuthorityRow = Readonly<Record<string, LiteLearningSqlValue>>;

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
