import type { WriteScopeHead } from "./write-access.js";
import stableStringify from "fast-json-stable-stringify";
import {
  APPLIED_AUTHORITY_TABLE_CONTRACTS,
  assertCanonicalV2MutationJson,
  canonicalAuthorityMutationIdentityKey,
  canonicalV2CommitHash,
  materializeAppliedAuthorityRow,
  validNodeEmbeddingProjectionTuple,
} from "./write-commit-authority.js";
import {
  requireSqliteStreamingStatement,
  type SqliteDatabase,
} from "./sqlite.js";
import { stableUuid } from "../util/uuid.js";
import {
  LEARNING_CONTROL_OPERATION_OUTCOME_AUTHORITY_KIND,
  LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_CONTRACT,
  LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_FIELDS,
} from "../memory/learning-episode-ledger.js";
import {
  canonicalAuthorityAdoptionBindingSetSha256,
  canonicalAuthorityAdoptionIdentity,
  canonicalAuthorityAdoptionRowSha256,
  LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES,
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
  LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT,
  LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY,
  LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
  type LiteRuntimeAuthorityAdoptionBinding,
  type LiteRuntimeAuthorityAdoptionKind,
  type LiteRuntimeAuthorityAdoptionManifest,
} from "./lite-runtime-authority-adoption-contract.js";

export const LITE_MEMORY_COMMIT_AUTHORITY_REPORT_CONTRACT =
  "aionis_lite_memory_commit_authority_report_v4" as const;

export type LiteMemoryCommitAuthorityFindingCode =
  | "lite_memory_commit_authority_schema_incomplete"
  | "lite_memory_commit_authority_digest_version_invalid"
  | "lite_memory_commit_authority_legacy_fields_invalid"
  | "lite_memory_commit_authority_legacy_after_v2"
  | "lite_memory_commit_authority_v2_fields_invalid"
  | "lite_memory_commit_authority_v2_diff_invalid"
  | "lite_memory_commit_authority_v2_digest_mismatch"
  | "lite_memory_commit_authority_v2_mutation_scope_mismatch"
  | "lite_memory_commit_authority_v2_revision_discontinuity"
  | "lite_memory_commit_authority_v2_parent_mismatch"
  | "lite_memory_commit_authority_v2_legacy_anchor_mismatch"
  | "lite_memory_commit_authority_v2_hash_mismatch"
  | "lite_memory_commit_authority_v2_id_mismatch"
  | "lite_memory_commit_authority_head_missing"
  | "lite_memory_commit_authority_head_unexpected"
  | "lite_memory_commit_authority_head_target_missing"
  | "lite_memory_commit_authority_head_mismatch"
  | "lite_memory_commit_authority_head_not_terminal"
  | "lite_memory_commit_authority_terminal_table_missing"
  | "lite_memory_commit_authority_terminal_table_shape_invalid"
  | "lite_memory_commit_authority_terminal_row_missing"
  | "lite_memory_commit_authority_terminal_row_mismatch"
  | "lite_memory_commit_authority_terminal_row_unclaimed"
  | "lite_memory_commit_authority_revision_insert_after_prior"
  | "lite_memory_commit_authority_revision_update_before_mismatch"
  | "lite_memory_commit_authority_revision_update_prior_missing"
  | "lite_memory_commit_authority_node_projection_tuple_invalid"
  | "lite_memory_commit_authority_legacy_opaque_baseline_invalid"
  | "lite_memory_commit_authority_adoption_schema_incomplete"
  | "lite_memory_commit_authority_adoption_manifest_invalid"
  | "lite_memory_commit_authority_adoption_binding_invalid"
  | "lite_memory_commit_authority_adoption_binding_unmatched"
  | "lite_memory_commit_authority_learning_control_outcome_contract_invalid"
  | "lite_memory_commit_authority_learning_control_outcome_observation_mismatch"
  | "lite_memory_commit_authority_learning_control_outcome_missing_invalid"
  | "lite_memory_commit_authority_target_missing"
  | "lite_memory_commit_authority_target_scope_mismatch"
  | "lite_memory_commit_authority_target_not_authoritative";

export type LiteMemoryCommitAuthorityFinding = Readonly<{
  code: LiteMemoryCommitAuthorityFindingCode;
  scope: string | null;
  commit_id: string | null;
  revision: number | null;
  cause_code: string | null;
}>;

export type LiteMemoryCommitAuthorityReport = Readonly<{
  contract_version: typeof LITE_MEMORY_COMMIT_AUTHORITY_REPORT_CONTRACT;
  authority_mode: "absent" | "legacy_v1_only" | "v2_forward_authority" | "incomplete";
  ok: boolean;
  commit_count: number;
  legacy_commit_count: number;
  v2_commit_count: number;
  scope_count: number;
  legacy_only_scope_count: number;
  authoritative_scope_count: number;
  head_count: number;
  terminal_claim_count: number;
  terminal_row_count: number;
  terminal_verified_count: number;
  terminal_legacy_opaque_row_count: number;
  terminal_delegated_operation_row_count: number;
  terminal_adopted_row_count: number;
  terminal_unclaimed_row_count: number;
  terminal_projection_tuple_exception_count: number;
  terminal_projection_owned_state_assurance:
    | "not_applicable"
    | "projection_owned_state_shape_validated_not_commit_exact";
  terminal_authority_assurance:
    | "not_applicable"
    | "latest_v2_claims_match_terminal_authoritative_rows"
    | "latest_v2_claims_match_with_legacy_opaque_rows"
    | "latest_v2_claims_match_with_delegated_operation_rows"
    | "latest_v2_claims_match_with_legacy_and_delegated_rows"
    | "latest_v2_claims_match_with_authenticated_adoption"
    | "latest_v2_claims_do_not_match_terminal_authoritative_rows";
  revision_before_check_count: number;
  revision_before_verified_count: number;
  revision_before_projection_transition_count: number;
  revision_before_projection_owned_state_assurance:
    | "not_applicable"
    | "projection_owned_state_shape_validated_not_commit_exact";
  legacy_opaque_baseline_count: number;
  adoption_manifest_count: number;
  adoption_binding_count: number;
  adoption_binding_verified_count: number;
  adoption_baseline_projection_exception_count: number;
  adoption_assurance:
    | "not_applicable"
    | "immutable_v5_authority_field_bindings_authenticated_by_v2_manifest"
    | "invalid";
  revision_before_assurance:
    | "not_applicable"
    | "v2_chain_proved"
    | "legacy_opaque_baseline"
    | "authenticated_adoption_baseline"
    | "invalid";
  finding_count: number;
  findings: readonly LiteMemoryCommitAuthorityFinding[];
}>;

export class LiteMemoryCommitAuthorityError extends Error {
  readonly code: LiteMemoryCommitAuthorityFindingCode;
  readonly finding: LiteMemoryCommitAuthorityFinding;

  constructor(finding: LiteMemoryCommitAuthorityFinding) {
    const location = [finding.scope, finding.commit_id, finding.revision]
      .filter((value) => value !== null)
      .join(":");
    super(`${finding.code}${location ? `:${location}` : ""}`);
    this.name = "LiteMemoryCommitAuthorityError";
    this.code = finding.code;
    this.finding = finding;
  }
}

type CommitRow = {
  id: string;
  scope: string;
  parent_commit_id: string | null;
  input_sha256: string;
  diff_json: string;
  actor: string;
  model_version: string | null;
  prompt_version: string | null;
  commit_hash: string;
  created_at: string;
  digest_version: number;
  revision: number | null;
  mutation_digest: string | null;
  legacy_anchor_commit_id: string | null;
};

type JoinedCommitRow = CommitRow & {
  parent_id: string | null;
  parent_scope: string | null;
  parent_commit_hash: string | null;
  parent_digest_version: number | null;
  parent_revision: number | null;
  parent_legacy_anchor_commit_id: string | null;
};

type HeadRow = {
  scope: string;
  commit_id: string;
  revision: number;
  updated_at: string;
};

type JoinedHeadRow = HeadRow & {
  target_scope: string | null;
  target_digest_version: number | null;
  target_revision: number | null;
};

type LegacyBoundary = {
  id: string;
  commitHash: string;
  createdAt: string;
  revision?: number | null;
  mutationDigest?: string | null;
  legacyAnchorCommitId?: string | null;
};

type ScopeScanState = {
  seenV2: boolean;
  legacyCount: number;
  v2Count: number;
  legacyBoundary: LegacyBoundary | null;
};

type V2Terminal = {
  id: string;
  revision: number;
  commitHash: string;
  legacyAnchorCommitId: string | null;
};

type TerminalMutationClaim = {
  table: string;
  identity: Record<string, unknown>;
  after: Record<string, unknown>;
  scope: string;
  commitId: string;
  revision: number;
};

type V2MutationTransition = TerminalMutationClaim & {
  operation: "insert" | "update";
  before: Record<string, unknown> | null;
};

type RevisionBeforeStats = {
  checkCount: number;
  verifiedCount: number;
  projectionTransitionCount: number;
  adoptionBaselineProjectionExceptionCount: number;
  legacyOpaqueBaselineCount: number;
  invalidCount: number;
};

type PendingMissingObservation = Readonly<{
  key: string;
  scope: string;
  memoryId: string;
  commitId: string;
  revision: number;
}>;

type TerminalTableContract = {
  identityKeys: readonly string[];
  rowKeys: readonly string[];
  projectionOwnedKeys?: readonly string[];
};

type AuthorityAdoptionState = {
  enabled: boolean;
  manifests: Map<string, LiteRuntimeAuthorityAdoptionManifest>;
  bindings: Map<string, LiteRuntimeAuthorityAdoptionBinding>;
  usedBindingKeys: Set<string>;
  invalidCount: number;
};

export type LiteRuntimeAuthorityAdoptionCandidate = Readonly<{
  scope: string;
  authority_table: string;
  identity: Readonly<Record<string, unknown>>;
  row: Readonly<Record<string, unknown>>;
  adoption_kind: LiteRuntimeAuthorityAdoptionKind;
}>;

const NODE_PROJECTION_OWNED_KEYS = [
  "embedding_vector_json",
  "embedding_model",
  "embedding_status",
  "embedding_last_error",
] as const;

const TERMINAL_TABLE_CONTRACTS: Readonly<Record<string, TerminalTableContract>> = {
  ...APPLIED_AUTHORITY_TABLE_CONTRACTS,
  lite_memory_nodes: {
    ...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_nodes,
    projectionOwnedKeys: NODE_PROJECTION_OWNED_KEYS,
  },
  lite_memory_edges: {
    identityKeys: ["scope", "type", "src_id", "dst_id"],
    rowKeys: [
      "id", "scope", "type", "src_id", "dst_id", "weight", "confidence",
      "decay_rate", "metadata_json", "commit_id", "created_at",
    ],
  },
};

// These operation rows are governed by their product/learning receipt
// verifiers rather than by the memory commit that carries their domain result.
// Keeping the registry closed prevents an arbitrary operation_kind from
// disappearing outside both authority systems. The report exposes their count
// so callers cannot mistake delegated receipt proof for commit-exact closure.
const DELEGATED_WRITE_OPERATION_KINDS = new Set([
  "handoff_store_v1",
  "learning_evidence_ingest_v1",
  "learning_experiment_close_v1",
  "learning_experiment_provision_v1",
  "learning_external_preclaim_hold_v1",
  "learning_external_run_claim_v1",
  "learning_external_run_reservation_v1",
  "learning_external_session_termination_v1",
  "learning_external_supervisor_binding_v1",
  "learning_external_ticket_consumption_v1",
  "learning_gate_authority_v1",
  "product_feedback_v1",
  "product_guide_v1",
  "product_measure_receipt_authority_v1",
  "product_measure_v1",
  "product_observe_v1",
  "unused_exposure_learning_control_v1",
]);

function isDelegatedOperationTerminalRow(actual: Record<string, unknown>): boolean {
  if (typeof actual.operation_kind !== "string"
    || !DELEGATED_WRITE_OPERATION_KINDS.has(actual.operation_kind)
    || typeof actual.tenant_id !== "string" || actual.tenant_id.length === 0
    || typeof actual.scope !== "string" || actual.scope.length === 0
    || typeof actual.operation_id !== "string" || actual.operation_id.length === 0
    || !exactLowerSha256(actual.request_sha256)
    || !canonicalUtcMillis(actual.created_at)
    || !(actual.commit_id === null || typeof actual.commit_id === "string")
    || typeof actual.receipt_json !== "string") return false;
  try {
    return isRecord(JSON.parse(actual.receipt_json) as unknown);
  } catch {
    return false;
  }
}

export type LiteMemoryCommitAuthorityProof = Readonly<{
  scope: string;
  commitId: string;
  commitHash: string;
  revision: number;
  legacyAnchorCommitId: string | null;
  headCommitId: string;
  headRevision: number;
  assurance: "local_v2_link_and_terminal_head";
}>;

export const LITE_MEMORY_COMMIT_AUTHORITY_V2_SCAN_SQL =
  `SELECT c.id, c.scope, c.parent_commit_id, c.input_sha256, c.diff_json,
          c.actor, c.model_version, c.prompt_version, c.commit_hash,
          c.created_at, c.digest_version, c.revision, c.mutation_digest,
          c.legacy_anchor_commit_id,
          p.id AS parent_id, p.scope AS parent_scope,
          p.commit_hash AS parent_commit_hash,
          p.digest_version AS parent_digest_version,
          p.revision AS parent_revision,
          p.legacy_anchor_commit_id AS parent_legacy_anchor_commit_id
   FROM lite_memory_commits AS c
   LEFT JOIN lite_memory_commits AS p ON p.id = c.parent_commit_id
   WHERE c.digest_version = 2
     AND c.revision IS NOT NULL
   ORDER BY c.scope, c.revision` as const;

const V5_COMMIT_COLUMNS = [
  "digest_version",
  "revision",
  "mutation_digest",
  "legacy_anchor_commit_id",
] as const;

function tableExists(db: SqliteDatabase, table: string): boolean {
  return !!db.prepare(
    `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`,
  ).get(table);
}

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name));
}

/** The caller has already checked sqlite_schema for this table. */
function tableColumnsForKnownExistingTable(db: SqliteDatabase, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name));
}

function canonicalUtcMillis(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function finding(args: {
  code: LiteMemoryCommitAuthorityFindingCode;
  scope?: string | null;
  commitId?: string | null;
  revision?: number | null;
  causeCode?: string | null;
}): LiteMemoryCommitAuthorityFinding {
  return {
    code: args.code,
    scope: args.scope ?? null,
    commit_id: args.commitId ?? null,
    revision: args.revision ?? null,
    cause_code: args.causeCode ?? null,
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.split(":", 1)[0]! : String(error);
}

/**
 * Validates the self-authenticating fields of one v2 row. Lineage and head
 * membership are deliberately supplied by the caller so this pure fence can
 * be shared by insertion, a linear scan, and a constant-query local proof.
 */
export function assertLiteMemoryCommitV2SelfIntegrity(args: {
  row: CommitRow;
  parentHash: string;
}): Record<string, unknown> {
  const { row } = args;
  if (row.digest_version !== 2) {
    throw new Error("lite_memory_commit_v2_digest_v2_required");
  }
  if (!validRevision(row.revision)) {
    throw new Error("lite_memory_commit_v2_revision_invalid");
  }
  if (!row.id || !row.scope || row.scope !== row.scope.trim()
    || !row.actor || row.actor !== row.actor.trim()
    || !/^[a-f0-9]{64}$/u.test(row.input_sha256)
    || typeof row.diff_json !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.commit_hash)
    || (row.parent_commit_id !== null && !row.parent_commit_id)
    || (row.model_version !== null && typeof row.model_version !== "string")
    || (row.prompt_version !== null && typeof row.prompt_version !== "string")) {
    throw new Error("lite_memory_commit_v2_fields_invalid");
  }
  if (!canonicalUtcMillis(row.created_at)) {
    throw new Error("lite_memory_commit_v2_created_at_invalid");
  }
  if (typeof row.mutation_digest !== "string") {
    throw new Error("lite_memory_commit_v2_mutation_digest_mismatch");
  }
  const parsed = assertCanonicalV2MutationJson({
    diffJson: row.diff_json,
    mutationDigest: row.mutation_digest,
    createdAt: row.created_at,
    scope: row.scope,
  });
  const expectedHash = canonicalV2CommitHash({
    digestVersion: 2,
    revision: row.revision,
    parentHash: args.parentHash,
    inputSha256: row.input_sha256,
    mutationDigest: row.mutation_digest,
    scope: row.scope,
    actor: row.actor,
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
  });
  if (row.commit_hash !== expectedHash) {
    throw new Error("lite_memory_commit_v2_commit_hash_mismatch");
  }
  if (row.id !== stableUuid(`lite:commit:${expectedHash}`)) {
    throw new Error("lite_memory_commit_v2_commit_id_mismatch");
  }
  return parsed;
}

function mapSelfIntegrityFinding(row: CommitRow, error: unknown): LiteMemoryCommitAuthorityFinding {
  const cause = errorCode(error);
  const code: LiteMemoryCommitAuthorityFindingCode = cause.includes("authority_mutation_scope_mismatch")
    ? "lite_memory_commit_authority_v2_mutation_scope_mismatch"
    : cause.includes("mutation_digest_mismatch")
      ? "lite_memory_commit_authority_v2_digest_mismatch"
      : cause.includes("commit_hash_mismatch")
        ? "lite_memory_commit_authority_v2_hash_mismatch"
        : cause.includes("commit_id_mismatch")
          ? "lite_memory_commit_authority_v2_id_mismatch"
          : cause.includes("diff_") || cause.includes("mutation_")
            ? "lite_memory_commit_authority_v2_diff_invalid"
            : "lite_memory_commit_authority_v2_fields_invalid";
  return finding({
    code,
    scope: row.scope,
    commitId: row.id,
    revision: validRevision(row.revision) ? row.revision : null,
    causeCode: cause,
  });
}

function emptyReport(args: {
  mode: LiteMemoryCommitAuthorityReport["authority_mode"];
  commitCount?: number;
  scopeCount?: number;
  findings?: readonly LiteMemoryCommitAuthorityFinding[];
}): LiteMemoryCommitAuthorityReport {
  const findings = args.findings ?? [];
  return {
    contract_version: LITE_MEMORY_COMMIT_AUTHORITY_REPORT_CONTRACT,
    authority_mode: args.mode,
    ok: findings.length === 0,
    commit_count: args.commitCount ?? 0,
    legacy_commit_count: args.commitCount ?? 0,
    v2_commit_count: 0,
    scope_count: args.scopeCount ?? 0,
    legacy_only_scope_count: args.scopeCount ?? 0,
    authoritative_scope_count: 0,
    head_count: 0,
    terminal_claim_count: 0,
    terminal_row_count: 0,
    terminal_verified_count: 0,
    terminal_legacy_opaque_row_count: 0,
    terminal_delegated_operation_row_count: 0,
    terminal_adopted_row_count: 0,
    terminal_unclaimed_row_count: 0,
    terminal_projection_tuple_exception_count: 0,
    terminal_projection_owned_state_assurance: "not_applicable",
    terminal_authority_assurance: "not_applicable",
    revision_before_check_count: 0,
    revision_before_verified_count: 0,
    revision_before_projection_transition_count: 0,
    revision_before_projection_owned_state_assurance: "not_applicable",
    legacy_opaque_baseline_count: 0,
    adoption_manifest_count: 0,
    adoption_binding_count: 0,
    adoption_binding_verified_count: 0,
    adoption_baseline_projection_exception_count: 0,
    adoption_assurance: "not_applicable",
    revision_before_assurance: "not_applicable",
    finding_count: findings.length,
    findings,
  };
}

function terminalClaimKey(claim: Pick<TerminalMutationClaim, "table" | "identity">): string {
  return canonicalAuthorityMutationIdentityKey(claim);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractV2MutationTransitions(args: {
  parsed: Record<string, unknown>;
  row: CommitRow & { revision: number };
}): V2MutationTransition[] {
  const transitions: V2MutationTransition[] = [];
  const remember = (
    table: string,
    identity: Record<string, unknown>,
    operation: "insert" | "update",
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    fieldAwareAuthoritySelfReferences = false,
  ): void => {
    transitions.push({
      table,
      identity,
      operation,
      before,
      after: fieldAwareAuthoritySelfReferences
        ? materializeAppliedAuthorityRow(table, after, args.row.id)
        : { ...after, commit_id: args.row.id },
      scope: args.row.scope,
      commitId: args.row.id,
      revision: args.row.revision,
    });
  };

  if (args.parsed.contract === "aionis_applied_authority_mutation_v2") {
    for (const value of args.parsed.mutations as unknown[]) {
      if (!isRecord(value) || typeof value.table !== "string"
        || !isRecord(value.identity) || !isRecord(value.after)
        || (value.operation !== "insert" && value.operation !== "update")) continue;
      remember(
        value.table,
        value.identity,
        value.operation,
        isRecord(value.before) ? value.before : null,
        value.after,
        true,
      );
    }
    return transitions;
  }

  for (const value of args.parsed.nodes as unknown[]) {
    if (!isRecord(value) || !isRecord(value.after)) continue;
    remember("lite_memory_nodes", {
      scope: value.after.scope,
      id: value.after.id,
    }, "insert", null, value.after);
  }
  for (const value of args.parsed.edges as unknown[]) {
    if (!isRecord(value) || !isRecord(value.after)) continue;
    remember("lite_memory_edges", {
      scope: value.after.scope,
      type: value.after.type,
      src_id: value.after.src_id,
      dst_id: value.after.dst_id,
    }, value.operation === "update" ? "update" : "insert",
    isRecord(value.before) ? value.before : null, value.after);
  }
  for (const value of args.parsed.rule_defs as unknown[]) {
    if (!isRecord(value) || !isRecord(value.after)) continue;
    remember("lite_memory_rule_defs", {
      scope: value.after.scope,
      rule_node_id: value.after.rule_node_id,
    }, "insert", null, value.after);
  }
  return transitions;
}

function quoteSqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error("lite_memory_commit_authority_sql_identifier_invalid");
  }
  return `"${value}"`;
}

function normalizePersistedValue(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected) || isRecord(expected)) {
    if (typeof actual !== "string") return actual;
    try {
      return JSON.parse(actual) as unknown;
    } catch {
      return actual;
    }
  }
  return actual;
}

function priorAfterMatchesBefore(args: {
  prior: TerminalMutationClaim;
  before: Record<string, unknown>;
}): { ok: boolean; projectionTransition: boolean; mismatchKey: string | null } {
  const contract = TERMINAL_TABLE_CONTRACTS[args.prior.table];
  if (!contract) return { ok: false, projectionTransition: false, mismatchKey: "table" };
  if (args.prior.table === "lite_memory_nodes"
    && (!validNodeEmbeddingProjectionTuple(args.prior.after)
      || !validNodeEmbeddingProjectionTuple(args.before))) {
    return { ok: false, projectionTransition: false, mismatchKey: "embedding_projection_tuple" };
  }
  const projectionOwned = new Set(contract.projectionOwnedKeys ?? []);
  let projectionMismatch = false;
  for (const key of contract.rowKeys) {
    if (stableStringify(args.prior.after[key]) === stableStringify(args.before[key])) continue;
    if (projectionOwned.has(key)) {
      projectionMismatch = true;
      continue;
    }
    return { ok: false, projectionTransition: false, mismatchKey: key };
  }
  if (!projectionMismatch) {
    return { ok: true, projectionTransition: false, mismatchKey: null };
  }
  const validTransition = validNodeEmbeddingProjectionTuple(args.before);
  return {
    ok: validTransition,
    projectionTransition: validTransition,
    mismatchKey: validTransition ? null : "embedding_projection_tuple",
  };
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return stableStringify(Object.keys(value).sort()) === stableStringify([...keys].sort());
}

function canonicalUtf8Strings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function exactLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function adoptionBindingKey(table: string, identitySha256: string): string {
  return `${table}\0${identitySha256}`;
}

function loadAuthorityAdoptionState(args: {
  db: SqliteDatabase;
  addFinding(value: LiteMemoryCommitAuthorityFinding): void;
}): AuthorityAdoptionState {
  const hasManifestTable = tableExists(args.db, LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE);
  const hasBindingTable = tableExists(args.db, LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE);
  const schemaVersion = tableExists(args.db, "lite_runtime_schema_metadata")
    ? Number((args.db.prepare(
      `SELECT version FROM lite_runtime_schema_metadata
       WHERE component = 'write_projection'`,
    ).get() as { version?: unknown } | undefined)?.version ?? 0)
    : 0;
  const state: AuthorityAdoptionState = {
    enabled: hasManifestTable && hasBindingTable,
    manifests: new Map(),
    bindings: new Map(),
    usedBindingKeys: new Set(),
    invalidCount: 0,
  };
  const fail = (
    code: Extract<LiteMemoryCommitAuthorityFindingCode,
      | "lite_memory_commit_authority_adoption_schema_incomplete"
      | "lite_memory_commit_authority_adoption_manifest_invalid"
      | "lite_memory_commit_authority_adoption_binding_invalid">,
    scope: string | null,
    causeCode: string,
  ): void => {
    state.invalidCount += 1;
    args.addFinding(finding({ code, scope, causeCode }));
  };
  if (hasManifestTable !== hasBindingTable) {
    fail("lite_memory_commit_authority_adoption_schema_incomplete", null, "table_pair");
    return state;
  }
  if ((schemaVersion >= 6 && !state.enabled)
    || (schemaVersion < 6 && (hasManifestTable || hasBindingTable))) {
    fail(
      "lite_memory_commit_authority_adoption_schema_incomplete",
      null,
      schemaVersion >= 6 ? "v6_tables_missing" : "objects_before_v6",
    );
    return state;
  }
  if (!state.enabled) return state;

  const manifestColumns = tableColumnsForKnownExistingTable(
    args.db,
    LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
  );
  const bindingColumns = tableColumnsForKnownExistingTable(
    args.db,
    LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
  );
  const requiredManifestColumns = [
    "scope", "manifest_id", "source_schema_version", "target_schema_version",
    "canonicalization_contract", "binding_count", "binding_set_sha256",
    "commit_id", "created_at",
  ];
  const requiredBindingColumns = [
    "scope", "manifest_id", "authority_table", "identity_json",
    "identity_sha256", "row_sha256", "adoption_kind", "created_at",
  ];
  if (manifestColumns.size !== requiredManifestColumns.length
    || requiredManifestColumns.some((column) => !manifestColumns.has(column))
    || bindingColumns.size !== requiredBindingColumns.length
    || requiredBindingColumns.some((column) => !bindingColumns.has(column))) {
    fail("lite_memory_commit_authority_adoption_schema_incomplete", null, "table_shape");
    return state;
  }

  const manifests = args.db.prepare(
    `SELECT scope, manifest_id, source_schema_version, target_schema_version,
            canonicalization_contract, binding_count, binding_set_sha256,
            commit_id, created_at
     FROM lite_runtime_authority_adoption_manifests
     ORDER BY scope`,
  ).all() as LiteRuntimeAuthorityAdoptionManifest[];
  for (const manifest of manifests) {
    const valid = typeof manifest.scope === "string" && manifest.scope.trim() === manifest.scope
      && manifest.scope.length > 0
      && typeof manifest.manifest_id === "string" && manifest.manifest_id.length > 0
      && manifest.source_schema_version === 5
      && manifest.target_schema_version === 6
      && manifest.canonicalization_contract
        === LITE_RUNTIME_AUTHORITY_ADOPTION_CANONICALIZATION_CONTRACT
      && Number.isSafeInteger(manifest.binding_count) && manifest.binding_count >= 1
      && exactLowerSha256(manifest.binding_set_sha256)
      && typeof manifest.commit_id === "string" && manifest.commit_id.length > 0
      && canonicalUtcMillis(manifest.created_at);
    if (!valid || state.manifests.has(manifest.scope)) {
      fail(
        "lite_memory_commit_authority_adoption_manifest_invalid",
        typeof manifest.scope === "string" ? manifest.scope : null,
        "row_shape",
      );
      continue;
    }
    state.manifests.set(manifest.scope, manifest);
  }

  const grouped = new Map<string, LiteRuntimeAuthorityAdoptionBinding[]>();
  const bindings = args.db.prepare(
    `SELECT scope, manifest_id, authority_table, identity_json,
            identity_sha256, row_sha256, adoption_kind, created_at
     FROM lite_runtime_authority_adoption_bindings
     ORDER BY scope, authority_table, identity_sha256`,
  ).all() as LiteRuntimeAuthorityAdoptionBinding[];
  const adoptableTables = new Set<string>(LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES);
  for (const binding of bindings) {
    const manifest = state.manifests.get(binding.scope);
    let identity: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(binding.identity_json) as unknown;
      if (isRecord(parsed) && stableStringify(parsed) === binding.identity_json) identity = parsed;
    } catch {
      // Classified by the shared invalid binding finding below.
    }
    const contract = TERMINAL_TABLE_CONTRACTS[binding.authority_table];
    const canonicalIdentity = identity ? canonicalAuthorityAdoptionIdentity(identity) : null;
    const valid = !!manifest
      && manifest.manifest_id === binding.manifest_id
      && binding.created_at === manifest.created_at
      && canonicalUtcMillis(binding.created_at)
      && adoptableTables.has(binding.authority_table)
      && !!contract
      && identity !== null
      && exactRecordKeys(identity, contract.identityKeys)
      && identity.scope === binding.scope
      && canonicalIdentity?.identity_sha256 === binding.identity_sha256
      && exactLowerSha256(binding.identity_sha256)
      && exactLowerSha256(binding.row_sha256)
      && (binding.adoption_kind === LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY
        || (binding.adoption_kind === LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION
          && binding.authority_table === "lite_runtime_write_operations"
          && typeof identity?.operation_kind === "string"
          && DELEGATED_WRITE_OPERATION_KINDS.has(identity.operation_kind)));
    if (!valid) {
      fail(
        "lite_memory_commit_authority_adoption_binding_invalid",
        typeof binding.scope === "string" ? binding.scope : null,
        typeof binding.authority_table === "string" ? binding.authority_table : "row_shape",
      );
      continue;
    }
    const key = adoptionBindingKey(binding.authority_table, binding.identity_sha256);
    if (state.bindings.has(key)) {
      fail("lite_memory_commit_authority_adoption_binding_invalid", binding.scope, "duplicate");
      continue;
    }
    state.bindings.set(key, binding);
    const group = grouped.get(binding.scope) ?? [];
    group.push(binding);
    grouped.set(binding.scope, group);
  }
  for (const [scope, manifest] of state.manifests) {
    const group = grouped.get(scope) ?? [];
    if (group.length !== manifest.binding_count
      || canonicalAuthorityAdoptionBindingSetSha256(group) !== manifest.binding_set_sha256) {
      fail("lite_memory_commit_authority_adoption_manifest_invalid", scope, "binding_set");
    }
  }
  return state;
}

function consumeAuthorityAdoptionBinding(args: {
  adoption: AuthorityAdoptionState;
  table: string;
  identity: Record<string, unknown>;
  row: Record<string, unknown>;
  expectedKind?: LiteRuntimeAuthorityAdoptionKind;
}): boolean {
  if (!args.adoption.enabled) return false;
  const canonicalIdentity = canonicalAuthorityAdoptionIdentity(args.identity);
  const key = adoptionBindingKey(args.table, canonicalIdentity.identity_sha256);
  const binding = args.adoption.bindings.get(key);
  if (!binding
    || binding.identity_json !== canonicalIdentity.identity_json
    || binding.scope !== args.identity.scope
    || (args.expectedKind !== undefined && binding.adoption_kind !== args.expectedKind)
    || binding.row_sha256 !== canonicalAuthorityAdoptionRowSha256(args.table, args.row)) {
    return false;
  }
  args.adoption.usedBindingKeys.add(key);
  return true;
}

function validateLearningControlOutcomeObservations(args: {
  parsed: Record<string, unknown>;
  row: JoinedCommitRow & { revision: number };
  priorClaims: Map<string, TerminalMutationClaim>;
  terminalClaims: Map<string, TerminalMutationClaim>;
  trustedLegacyCommitIds: ReadonlySet<string>;
  legacyBoundary: LegacyBoundary | null;
  adoption: AuthorityAdoptionState;
  pendingMissing: PendingMissingObservation[];
  stats: RevisionBeforeStats;
  addFinding(value: LiteMemoryCommitAuthorityFinding): void;
}): void {
  if (args.parsed.contract !== "aionis_applied_authority_mutation_v2"
    || args.parsed.authority_kind !== LEARNING_CONTROL_OPERATION_OUTCOME_AUTHORITY_KIND) return;
  const failContract = (causeCode: string): void => {
    args.stats.invalidCount += 1;
    args.addFinding(finding({
      code: "lite_memory_commit_authority_learning_control_outcome_contract_invalid",
      scope: args.row.scope,
      commitId: args.row.id,
      revision: args.row.revision,
      causeCode,
    }));
  };
  if (!Array.isArray(args.parsed.mutations) || args.parsed.mutations.length !== 1) {
    failContract("mutation_count");
    return;
  }
  const mutation = args.parsed.mutations[0];
  if (!isRecord(mutation)
    || mutation.table !== "lite_runtime_write_operations"
    || mutation.operation !== "insert"
    || mutation.before !== null
    || !isRecord(mutation.requested)) {
    failContract("mutation_shape");
    return;
  }
  const evidence = mutation.requested;
  if (!exactRecordKeys(evidence, LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_FIELDS)
    || evidence.contract_version !== LEARNING_CONTROL_OPERATION_OUTCOME_EVIDENCE_CONTRACT
    || evidence.scope !== args.row.scope
    || evidence.domain_result_commit_id !== args.row.parent_commit_id
    || evidence.domain_result_revision !== args.row.revision - 1
    || !Array.isArray(evidence.requested_node_ids)
    || evidence.requested_node_ids.some((value) => typeof value !== "string" || value.length === 0)
    || !Array.isArray(evidence.observations)) {
    failContract("evidence_shape");
    return;
  }
  const requested = evidence.requested_node_ids as string[];
  if (stableStringify(requested) !== stableStringify(canonicalUtf8Strings(requested))
    || evidence.observations.length !== requested.length) {
    failContract("observation_partition");
    return;
  }
  const nodeContract = TERMINAL_TABLE_CONTRACTS.lite_memory_nodes;
  for (const [index, memoryId] of requested.entries()) {
    args.stats.checkCount += 1;
    const value = evidence.observations[index];
    if (!isRecord(value)
      || !exactRecordKeys(value, ["memory_id", "state"])
      || value.memory_id !== memoryId) {
      failContract(`observation_shape:${memoryId}`);
      return;
    }
    const identity = { scope: args.row.scope, id: memoryId };
    const key = terminalClaimKey({ table: "lite_memory_nodes", identity });
    const prior = args.priorClaims.get(key) ?? null;
    if (value.state === null) {
      if (prior) {
        args.stats.invalidCount += 1;
        args.addFinding(finding({
          code: "lite_memory_commit_authority_learning_control_outcome_missing_invalid",
          scope: args.row.scope,
          commitId: args.row.id,
          revision: args.row.revision,
          causeCode: memoryId,
        }));
      } else {
        args.pendingMissing.push({
          key,
          scope: args.row.scope,
          memoryId,
          commitId: args.row.id,
          revision: args.row.revision,
        });
      }
      continue;
    }
    if (!isRecord(value.state)
      || !exactRecordKeys(value.state, nodeContract.rowKeys)
      || value.state.scope !== args.row.scope
      || value.state.id !== memoryId
      || typeof value.state.commit_id !== "string"
      || value.state.commit_id.length === 0
      || value.state.commit_id === "$self"
      || typeof value.state.created_at !== "string"
      || value.state.created_at > args.row.created_at
      || !validNodeEmbeddingProjectionTuple(value.state)) {
      args.stats.invalidCount += 1;
      args.addFinding(finding({
        code: "lite_memory_commit_authority_learning_control_outcome_observation_mismatch",
        scope: args.row.scope,
        commitId: args.row.id,
        revision: args.row.revision,
        causeCode: memoryId,
      }));
      continue;
    }
    if (prior) {
      const matched = priorAfterMatchesBefore({ prior, before: value.state });
      if (matched.ok) {
        args.stats.verifiedCount += 1;
        if (matched.projectionTransition) args.stats.projectionTransitionCount += 1;
      } else {
        args.stats.invalidCount += 1;
        args.addFinding(finding({
          code: "lite_memory_commit_authority_learning_control_outcome_observation_mismatch",
          scope: args.row.scope,
          commitId: args.row.id,
          revision: args.row.revision,
          causeCode: `${memoryId}:${matched.mismatchKey ?? "unknown"}`,
        }));
      }
      continue;
    }
    const legacyOrigin = args.trustedLegacyCommitIds.has(
      `${args.row.scope}\0${String(value.state.commit_id)}`,
    ) && args.legacyBoundary !== null
      && args.row.legacy_anchor_commit_id === args.legacyBoundary.id;
    const legacyState = legacyOrigin && (!args.adoption.enabled
      || consumeAuthorityAdoptionBinding({
        adoption: args.adoption,
        table: "lite_memory_nodes",
        identity,
        row: value.state,
        expectedKind: LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY,
      }));
    if (!legacyState) {
      args.stats.invalidCount += 1;
      args.addFinding(finding({
        code: "lite_memory_commit_authority_learning_control_outcome_observation_mismatch",
        scope: args.row.scope,
        commitId: args.row.id,
        revision: args.row.revision,
        causeCode: `${memoryId}:unproved_baseline`,
      }));
      continue;
    }
    const baseline: TerminalMutationClaim = {
      table: "lite_memory_nodes",
      identity,
      after: value.state,
      scope: args.row.scope,
      commitId: args.row.id,
      revision: args.row.revision,
    };
    args.priorClaims.set(key, baseline);
    args.terminalClaims.set(key, baseline);
    args.stats.verifiedCount += 1;
    args.stats.legacyOpaqueBaselineCount += 1;
    if (args.adoption.enabled) {
      args.stats.adoptionBaselineProjectionExceptionCount += 1;
    }
  }
}

function applyRevisionBeforeTransition(args: {
  transition: V2MutationTransition;
  priorClaims: Map<string, TerminalMutationClaim>;
  terminalClaims: Map<string, TerminalMutationClaim>;
  trustedLegacyCommitIds: ReadonlySet<string>;
  legacyBoundary: LegacyBoundary | null;
  legacyAnchorCommitId: string | null;
  adoption: AuthorityAdoptionState;
  stats: RevisionBeforeStats;
  addFinding(value: LiteMemoryCommitAuthorityFinding): void;
}): void {
  const key = terminalClaimKey(args.transition);
  const prior = args.priorClaims.get(key) ?? null;
  const invalidNodeProjectionTuple = args.transition.table === "lite_memory_nodes"
    && (!validNodeEmbeddingProjectionTuple(args.transition.after)
      || (args.transition.before !== null
        && !validNodeEmbeddingProjectionTuple(args.transition.before)));
  if (invalidNodeProjectionTuple) {
    args.stats.invalidCount += 1;
    args.addFinding(finding({
      code: "lite_memory_commit_authority_node_projection_tuple_invalid",
      scope: args.transition.scope,
      commitId: args.transition.commitId,
      revision: args.transition.revision,
      causeCode: "lite_memory_nodes:embedding_projection_tuple",
    }));
  }
  if (args.transition.operation === "insert") {
    if (prior) {
      args.stats.invalidCount += 1;
      args.addFinding(finding({
        code: "lite_memory_commit_authority_revision_insert_after_prior",
        scope: args.transition.scope,
        commitId: args.transition.commitId,
        revision: args.transition.revision,
        causeCode: args.transition.table,
      }));
    }
  } else {
    args.stats.checkCount += 1;
    if (invalidNodeProjectionTuple) {
      // The tuple finding above is the complete classification for this
      // transition. Keep its claim below so later history remains observable,
      // but do not mislabel the same malformed row as a missing prior.
    } else if (prior && args.transition.before) {
      const matched = priorAfterMatchesBefore({ prior, before: args.transition.before });
      if (matched.ok) {
        args.stats.verifiedCount += 1;
        if (matched.projectionTransition) args.stats.projectionTransitionCount += 1;
      } else {
        args.stats.invalidCount += 1;
        args.addFinding(finding({
          code: "lite_memory_commit_authority_revision_update_before_mismatch",
          scope: args.transition.scope,
          commitId: args.transition.commitId,
          revision: args.transition.revision,
          causeCode: `${args.transition.table}:${matched.mismatchKey ?? "unknown"}`,
        }));
      }
    } else if (args.transition.before && args.legacyBoundary) {
      const beforeCommitId = args.transition.before.commit_id;
      const sameScopeLegacy = typeof beforeCommitId === "string"
        && args.trustedLegacyCommitIds.has(`${args.transition.scope}\0${beforeCommitId}`);
      if (sameScopeLegacy
        && args.legacyAnchorCommitId === args.legacyBoundary.id
        && args.transition.before.scope === args.transition.scope
        && (!args.adoption.enabled || consumeAuthorityAdoptionBinding({
          adoption: args.adoption,
          table: args.transition.table,
          identity: args.transition.identity,
          row: args.transition.before,
          expectedKind: LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY,
        }))) {
        args.stats.legacyOpaqueBaselineCount += 1;
        if (args.adoption.enabled && args.transition.table === "lite_memory_nodes") {
          args.stats.adoptionBaselineProjectionExceptionCount += 1;
        }
      } else {
        args.stats.invalidCount += 1;
        args.addFinding(finding({
          code: "lite_memory_commit_authority_legacy_opaque_baseline_invalid",
          scope: args.transition.scope,
          commitId: args.transition.commitId,
          revision: args.transition.revision,
          causeCode: args.transition.table,
        }));
      }
    } else {
      args.stats.invalidCount += 1;
      args.addFinding(finding({
        code: "lite_memory_commit_authority_revision_update_prior_missing",
        scope: args.transition.scope,
        commitId: args.transition.commitId,
        revision: args.transition.revision,
        causeCode: args.transition.table,
      }));
    }
  }
  args.priorClaims.set(key, args.transition);
  args.terminalClaims.set(key, args.transition);
}

function verifyTerminalClaimRow(args: {
  claim: TerminalMutationClaim;
  actual: Record<string, unknown>;
  contract: TerminalTableContract;
  addFinding(value: LiteMemoryCommitAuthorityFinding): void;
}): { verified: boolean; projectionException: boolean } {
  if (args.claim.table === "lite_memory_nodes"
    && (!validNodeEmbeddingProjectionTuple(args.claim.after)
      || !validNodeEmbeddingProjectionTuple(args.actual))) {
    args.addFinding(finding({
      code: "lite_memory_commit_authority_terminal_row_mismatch",
      scope: args.claim.scope,
      commitId: args.claim.commitId,
      revision: args.claim.revision,
      causeCode: "lite_memory_nodes:embedding_projection_tuple",
    }));
    return { verified: false, projectionException: false };
  }
  const projectionOwned = new Set(args.contract.projectionOwnedKeys ?? []);
  let mismatch = false;
  let mismatchKey: string | null = null;
  let projectionTupleMismatch = false;
  for (const key of args.contract.rowKeys) {
    const expected = args.claim.after[key];
    const persisted = normalizePersistedValue(args.actual[key], expected);
    if (stableStringify(persisted) === stableStringify(expected)) continue;
    if (projectionOwned.has(key)) {
      projectionTupleMismatch = true;
      continue;
    }
    mismatch = true;
    mismatchKey = key;
    break;
  }
  if (!mismatch && projectionTupleMismatch) {
    if (validNodeEmbeddingProjectionTuple(args.actual)) {
      return { verified: true, projectionException: true };
    }
    mismatch = true;
    mismatchKey = "embedding_projection_tuple";
  }
  if (mismatch) {
    args.addFinding(finding({
      code: "lite_memory_commit_authority_terminal_row_mismatch",
      scope: args.claim.scope,
      commitId: args.claim.commitId,
      revision: args.claim.revision,
      causeCode: `${args.claim.table}:${mismatchKey ?? "unknown"}`,
    }));
    return { verified: false, projectionException: false };
  }
  return { verified: true, projectionException: false };
}

function isLegacyOpaqueTerminalRow(args: {
  table: string;
  actual: Record<string, unknown>;
  trustedLegacyCommitIds: ReadonlySet<string>;
  legacyBoundaryByScope: ReadonlyMap<string, LegacyBoundary>;
}): boolean {
  const scope = args.actual.scope;
  const commitId = args.actual.commit_id;
  if (typeof scope !== "string" || scope.length === 0) return false;
  if (typeof commitId === "string"
    && args.trustedLegacyCommitIds.has(`${scope}\0${commitId}`)) {
    return true;
  }
  // These two pre-v5 tables permitted a null commit reference. Preserve those
  // rows only as an explicitly opaque migration boundary in a scope that
  // actually has legacy history; never call them commit-proved.
  return commitId === null
    && (args.table === "lite_memory_execution_decisions"
      || args.table === "lite_memory_rule_feedback")
    && args.legacyBoundaryByScope.has(scope);
}

function verifyTerminalClaims(args: {
  db: SqliteDatabase;
  claims: ReadonlyMap<string, TerminalMutationClaim>;
  trustedLegacyCommitIds: ReadonlySet<string>;
  legacyBoundaryByScope: ReadonlyMap<string, LegacyBoundary>;
  adoption: AuthorityAdoptionState;
  needsCurrentNodeKeys: boolean;
  nodeAbsenceRepresentative: PendingMissingObservation | null;
  addFinding(value: LiteMemoryCommitAuthorityFinding): void;
}): {
  rowCount: number;
  verifiedCount: number;
  projectionExceptionCount: number;
  legacyOpaqueRowCount: number;
  delegatedOperationRowCount: number;
  adoptedRowCount: number;
  unclaimedRowCount: number;
  currentNodeKeys: ReadonlySet<string>;
  nodeAbsenceProofAvailable: boolean;
} {
  let rowCount = 0;
  let verifiedCount = 0;
  let projectionExceptionCount = 0;
  let legacyOpaqueRowCount = 0;
  let delegatedOperationRowCount = 0;
  let adoptedRowCount = 0;
  let unclaimedRowCount = 0;
  const claimsByTable = new Map<string, Map<string, TerminalMutationClaim>>();
  for (const [key, claim] of args.claims) {
    const group = claimsByTable.get(claim.table) ?? new Map<string, TerminalMutationClaim>();
    group.set(key, claim);
    claimsByTable.set(claim.table, group);
  }
  const terminalTableState = new Map<string, "valid" | "invalid">();
  const seenClaimKeys = new Set<string>();
  const currentNodeKeys = new Set<string>();
  let nodeAbsenceProofAvailable = false;

  // The database-side half is a fixed full-surface pass: every present
  // authoritative table is streamed once, including tables without claims.
  // This proves both directions (claim -> row and row -> authority class)
  // without per-claim point lookups or temp sorting.
  for (const [table, contract] of Object.entries(TERMINAL_TABLE_CONTRACTS)) {
    const claims = claimsByTable.get(table);
    const representative = claims?.values().next().value as TerminalMutationClaim | undefined;
    const absenceRepresentative = representative ?? (table === "lite_memory_nodes"
      ? args.nodeAbsenceRepresentative
      : null);
    if (!tableExists(args.db, table)) {
      if (!claims && (table !== "lite_memory_nodes" || !args.needsCurrentNodeKeys)) continue;
      terminalTableState.set(table, "invalid");
      if (absenceRepresentative) {
        args.addFinding(finding({
          code: "lite_memory_commit_authority_terminal_table_missing",
          scope: absenceRepresentative.scope,
          commitId: absenceRepresentative.commitId,
          revision: absenceRepresentative.revision,
          causeCode: table,
        }));
      }
      continue;
    }
    const columns = tableColumnsForKnownExistingTable(args.db, table);
    if (columns.size !== contract.rowKeys.length
      || contract.rowKeys.some((key) => !columns.has(key))) {
      terminalTableState.set(table, "invalid");
      args.addFinding(finding({
        code: "lite_memory_commit_authority_terminal_table_shape_invalid",
        scope: absenceRepresentative?.scope ?? null,
        commitId: absenceRepresentative?.commitId ?? null,
        revision: absenceRepresentative?.revision ?? null,
        causeCode: table,
      }));
      continue;
    }
    terminalTableState.set(table, "valid");
    const select = contract.rowKeys.map(quoteSqlIdentifier).join(", ");
    const rowScan = requireSqliteStreamingStatement(args.db.prepare(
      `SELECT ${select} FROM ${quoteSqlIdentifier(table)}`,
    ), `lite_memory_commit_authority_terminal_${table}_scan`);
    for (const actual of rowScan.iterate<Record<string, unknown>>()) {
      rowCount += 1;
      const identity = Object.fromEntries(contract.identityKeys.map((key) => [key, actual[key]]));
      const claimKey = terminalClaimKey({ table, identity });
      if (table === "lite_memory_nodes") currentNodeKeys.add(claimKey);
      const claim = claims?.get(claimKey);
      if (!claim) {
        const legacyEligible = isLegacyOpaqueTerminalRow({
          table,
          actual,
          trustedLegacyCommitIds: args.trustedLegacyCommitIds,
          legacyBoundaryByScope: args.legacyBoundaryByScope,
        });
        const delegatedEligible = table === "lite_runtime_write_operations"
          && isDelegatedOperationTerminalRow(actual);
        const projectionTupleEligible = table !== "lite_memory_nodes"
          || validNodeEmbeddingProjectionTuple(actual);
        if (args.adoption.enabled) {
          const expectedKind = legacyEligible
            ? LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY
            : delegatedEligible
              ? LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION
              : null;
          if (expectedKind !== null && projectionTupleEligible
            && consumeAuthorityAdoptionBinding({
            adoption: args.adoption,
            table,
            identity,
            row: actual,
            expectedKind,
          })) {
            adoptedRowCount += 1;
            if (table === "lite_memory_nodes") projectionExceptionCount += 1;
            continue;
          }
        } else if (legacyEligible) {
          legacyOpaqueRowCount += 1;
          continue;
        }
        if (!args.adoption.enabled && delegatedEligible) {
          delegatedOperationRowCount += 1;
          continue;
        }
        unclaimedRowCount += 1;
        args.addFinding(finding({
          code: "lite_memory_commit_authority_terminal_row_unclaimed",
          scope: typeof actual.scope === "string" ? actual.scope : null,
          commitId: typeof actual.commit_id === "string" ? actual.commit_id : null,
          causeCode: table,
        }));
        continue;
      }
      seenClaimKeys.add(claimKey);
      const verified = verifyTerminalClaimRow({
        claim,
        actual,
        contract,
        addFinding: args.addFinding,
      });
      if (verified.verified) verifiedCount += 1;
      if (verified.projectionException) projectionExceptionCount += 1;
    }
    if (table === "lite_memory_nodes" && args.needsCurrentNodeKeys) {
      nodeAbsenceProofAvailable = true;
    }
  }

  // Canonical v2 parsing normally rejects these before they become claims, but
  // retain the old fail-closed diagnostic if a future parser reaches this
  // verifier with an unregistered table.
  for (const claim of args.claims.values()) {
    if (Object.prototype.hasOwnProperty.call(TERMINAL_TABLE_CONTRACTS, claim.table)) continue;
    args.addFinding(finding({
      code: "lite_memory_commit_authority_terminal_table_shape_invalid",
      scope: claim.scope,
      commitId: claim.commitId,
      revision: claim.revision,
      causeCode: claim.table,
    }));
  }

  // Preserve one terminal-row-missing finding for every independently claimed
  // row, in commit/claim insertion order. Invalid tables already produced the
  // legacy single table-level finding and deliberately do not add row misses.
  for (const [key, claim] of args.claims) {
    if (terminalTableState.get(claim.table) !== "valid" || seenClaimKeys.has(key)) continue;
    args.addFinding(finding({
      code: "lite_memory_commit_authority_terminal_row_missing",
      scope: claim.scope,
      commitId: claim.commitId,
      revision: claim.revision,
      causeCode: claim.table,
    }));
  }
  return {
    rowCount,
    verifiedCount,
    projectionExceptionCount,
    legacyOpaqueRowCount,
    delegatedOperationRowCount,
    adoptedRowCount,
    unclaimedRowCount,
    currentNodeKeys,
    nodeAbsenceProofAvailable,
  };
}

/**
 * Captures the exact v5 rows that were accepted only by the historical
 * legacy/delegated exceptions. The caller must run this under the owned
 * BEGIN IMMEDIATE v5->v6 migration before creating any adoption object.
 */
export function collectLiteRuntimeAuthorityAdoptionCandidatesV5(
  db: SqliteDatabase,
): readonly LiteRuntimeAuthorityAdoptionCandidate[] {
  if (tableExists(db, LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE)
    || tableExists(db, LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE)) {
    throw new Error("lite_runtime_authority_adoption_source_objects_present");
  }
  const sourceReport = inspectLiteMemoryCommitAuthority(db, { maxFindings: 100 });
  if (!sourceReport.ok) {
    throw new LiteMemoryCommitAuthorityError(
      sourceReport.findings[0] ?? finding({
        code: "lite_memory_commit_authority_target_not_authoritative",
      }),
    );
  }

  const trustedLegacyCommitIds = new Set<string>();
  const legacyBoundaryByScope = new Map<string, LegacyBoundary>();
  const legacyRows = db.prepare(
    `SELECT id, scope, commit_hash, created_at
     FROM lite_memory_commits
     WHERE digest_version = 1
     ORDER BY rowid`,
  ).all() as Array<{
    id: string;
    scope: string;
    commit_hash: string;
    created_at: string;
  }>;
  for (const row of legacyRows) {
    trustedLegacyCommitIds.add(`${row.scope}\0${row.id}`);
    legacyBoundaryByScope.set(row.scope, {
      id: row.id,
      commitHash: row.commit_hash,
      createdAt: row.created_at,
    });
  }

  const candidates = new Map<string, LiteRuntimeAuthorityAdoptionCandidate>();
  const addCandidate = (candidate: LiteRuntimeAuthorityAdoptionCandidate): void => {
    const contract = TERMINAL_TABLE_CONTRACTS[candidate.authority_table];
    if (!contract || !LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES.includes(
      candidate.authority_table as typeof LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES[number],
    ) || !exactRecordKeys(candidate.identity as Record<string, unknown>, contract.identityKeys)
      || !exactRecordKeys(candidate.row as Record<string, unknown>, contract.rowKeys)
      || candidate.identity.scope !== candidate.scope
      || (candidate.authority_table === "lite_memory_nodes"
        && !validNodeEmbeddingProjectionTuple(candidate.row as Record<string, unknown>))) {
      throw new Error("lite_runtime_authority_adoption_candidate_invalid");
    }
    const identity = canonicalAuthorityAdoptionIdentity(candidate.identity);
    const key = adoptionBindingKey(candidate.authority_table, identity.identity_sha256);
    const existing = candidates.get(key);
    if (existing) {
      if (existing.adoption_kind !== candidate.adoption_kind
        || canonicalAuthorityAdoptionRowSha256(existing.authority_table, existing.row)
          !== canonicalAuthorityAdoptionRowSha256(candidate.authority_table, candidate.row)) {
        throw new Error("lite_runtime_authority_adoption_candidate_conflict");
      }
      return;
    }
    candidates.set(key, candidate);
  };

  const priorClaimKeys = new Set<string>();
  const terminalClaimKeys = new Set<string>();
  const v2Scan = requireSqliteStreamingStatement(
    db.prepare(LITE_MEMORY_COMMIT_AUTHORITY_V2_SCAN_SQL),
    "lite_runtime_authority_adoption_v2_scan",
  );
  for (const row of v2Scan.iterate<JoinedCommitRow>()) {
    const parsed = assertLiteMemoryCommitV2SelfIntegrity({
      row,
      parentHash: row.parent_commit_id === null ? "" : row.parent_commit_hash ?? "",
    });
    if (parsed.contract === "aionis_applied_authority_mutation_v2"
      && parsed.authority_kind === LEARNING_CONTROL_OPERATION_OUTCOME_AUTHORITY_KIND
      && Array.isArray(parsed.mutations)) {
      const mutation = parsed.mutations[0];
      if (isRecord(mutation) && isRecord(mutation.requested)
        && Array.isArray(mutation.requested.observations)) {
        for (const observation of mutation.requested.observations) {
          if (!isRecord(observation) || !isRecord(observation.state)
            || typeof observation.memory_id !== "string") continue;
          const identity = { scope: row.scope, id: observation.memory_id };
          const key = terminalClaimKey({ table: "lite_memory_nodes", identity });
          if (priorClaimKeys.has(key)) continue;
          const stateCommitId = observation.state.commit_id;
          if (typeof stateCommitId === "string"
            && trustedLegacyCommitIds.has(`${row.scope}\0${stateCommitId}`)) {
            addCandidate({
              scope: row.scope,
              authority_table: "lite_memory_nodes",
              identity,
              row: observation.state,
              adoption_kind: LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY,
            });
            priorClaimKeys.add(key);
            terminalClaimKeys.add(key);
          }
        }
      }
    }
    if (!validRevision(row.revision)) continue;
    for (const transition of extractV2MutationTransitions({
      parsed,
      row: row as JoinedCommitRow & { revision: number },
    })) {
      const key = terminalClaimKey(transition);
      if (transition.operation === "update" && !priorClaimKeys.has(key)
        && transition.before && typeof transition.before.commit_id === "string"
        && trustedLegacyCommitIds.has(
          `${transition.scope}\0${transition.before.commit_id}`,
        )) {
        addCandidate({
          scope: transition.scope,
          authority_table: transition.table,
          identity: transition.identity,
          row: transition.before,
          adoption_kind: LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY,
        });
      }
      priorClaimKeys.add(key);
      terminalClaimKeys.add(key);
    }
  }

  for (const table of LITE_RUNTIME_AUTHORITY_ADOPTABLE_TABLES) {
    if (!tableExists(db, table)) continue;
    const contract = TERMINAL_TABLE_CONTRACTS[table];
    const select = contract.rowKeys.map(quoteSqlIdentifier).join(", ");
    const rowScan = requireSqliteStreamingStatement(db.prepare(
      `SELECT ${select} FROM ${quoteSqlIdentifier(table)}`,
    ), `lite_runtime_authority_adoption_terminal_${table}`);
    for (const actual of rowScan.iterate<Record<string, unknown>>()) {
      const identity = Object.fromEntries(contract.identityKeys.map((key) => [key, actual[key]]));
      const key = terminalClaimKey({ table, identity });
      if (terminalClaimKeys.has(key)) continue;
      if (table === "lite_memory_nodes" && !validNodeEmbeddingProjectionTuple(actual)) {
        throw new Error("lite_runtime_authority_adoption_node_projection_tuple_invalid");
      }
      if (isLegacyOpaqueTerminalRow({
        table,
        actual,
        trustedLegacyCommitIds,
        legacyBoundaryByScope,
      })) {
        addCandidate({
          scope: String(actual.scope),
          authority_table: table,
          identity,
          row: actual,
          adoption_kind: LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_LEGACY,
        });
        continue;
      }
      if (table === "lite_runtime_write_operations"
        && isDelegatedOperationTerminalRow(actual)) {
        addCandidate({
          scope: String(actual.scope),
          authority_table: table,
          identity,
          row: actual,
          adoption_kind: LITE_RUNTIME_AUTHORITY_ADOPTION_KIND_OPERATION,
        });
        continue;
      }
      throw new Error(`lite_runtime_authority_adoption_unclassified_row:${table}`);
    }
  }

  return [...candidates.values()].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.scope}\0${left.authority_table}\0${stableStringify(left.identity)}`, "utf8"),
    Buffer.from(`${right.scope}\0${right.authority_table}\0${stableStringify(right.identity)}`, "utf8"),
  ));
}

/**
 * Performs ordered rowid-commit, v2-commit, head, and fixed-table terminal-row
 * streaming passes. No commit performs a parent lookup, no outcome performs a
 * history lookup, and no terminal claim performs a point lookup: runtime is
 * O(commits + mutations + heads + rows in the fixed authoritative table set +
 * observations).
 * Memory is O(unique claimed authoritative row payload). The caller owns the
 * read snapshot or shared write transaction.
 */
export function inspectLiteMemoryCommitAuthority(
  db: SqliteDatabase,
  options: { maxFindings?: number } = {},
): LiteMemoryCommitAuthorityReport {
  if (!tableExists(db, "lite_memory_commits")) {
    const adoptionObjectsPresent = tableExists(
      db,
      LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
    ) || tableExists(db, LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE);
    const metadataVersion = tableExists(db, "lite_runtime_schema_metadata")
      ? Number((db.prepare(
        `SELECT version FROM lite_runtime_schema_metadata
         WHERE component = 'write_projection'`,
      ).get() as { version?: unknown } | undefined)?.version ?? 0)
      : 0;
    return metadataVersion >= 6 || adoptionObjectsPresent
      ? emptyReport({
          mode: "incomplete",
          findings: [finding({
            code: "lite_memory_commit_authority_schema_incomplete",
            causeCode: "commit_table_missing_with_v6_authority",
          })],
        })
      : emptyReport({ mode: "absent" });
  }

  const commitColumns = tableColumns(db, "lite_memory_commits");
  const presentV5Columns = V5_COMMIT_COLUMNS.filter((column) => commitColumns.has(column));
  const hasHeadTable = tableExists(db, "lite_memory_scope_heads");
  if (presentV5Columns.length === 0 && !hasHeadTable) {
    const counts = db.prepare(
      `SELECT COUNT(*) AS commit_count, COUNT(DISTINCT scope) AS scope_count
       FROM lite_memory_commits`,
    ).get() as { commit_count: number; scope_count: number };
    return emptyReport({
      mode: "legacy_v1_only",
      commitCount: Number(counts.commit_count),
      scopeCount: Number(counts.scope_count),
    });
  }
  if (presentV5Columns.length !== V5_COMMIT_COLUMNS.length || !hasHeadTable) {
    return emptyReport({
      mode: "incomplete",
      findings: [finding({ code: "lite_memory_commit_authority_schema_incomplete" })],
    });
  }

  const maxFindings = Math.max(1, Math.min(1_000, options.maxFindings ?? 100));
  const storedFindings: LiteMemoryCommitAuthorityFinding[] = [];
  let findingCount = 0;
  const addFinding = (value: LiteMemoryCommitAuthorityFinding): void => {
    findingCount += 1;
    if (storedFindings.length < maxFindings) storedFindings.push(value);
  };
  const adoption = loadAuthorityAdoptionState({ db, addFinding });

  const scopes = new Map<string, ScopeScanState>();
  const trustedLegacyCommitIds = new Set<string>();
  let commitCount = 0;
  let legacyCommitCount = 0;
  let v2CommitCount = 0;
  const rowidScan = requireSqliteStreamingStatement(db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            model_version, prompt_version, commit_hash, created_at,
            digest_version, revision, mutation_digest, legacy_anchor_commit_id
     FROM lite_memory_commits
     ORDER BY rowid`,
  ), "lite_memory_commit_authority_rowid_scan");
  for (const row of rowidScan.iterate<CommitRow>()) {
    commitCount += 1;
    const state = scopes.get(row.scope) ?? {
      seenV2: false,
      legacyCount: 0,
      v2Count: 0,
      legacyBoundary: null,
    };
    scopes.set(row.scope, state);
    if (row.digest_version === 1) {
      legacyCommitCount += 1;
      state.legacyCount += 1;
      if (row.revision !== null || row.mutation_digest !== null
        || row.legacy_anchor_commit_id !== null) {
        addFinding(finding({
          code: "lite_memory_commit_authority_legacy_fields_invalid",
          scope: row.scope,
          commitId: row.id,
        }));
      }
      if (state.seenV2) {
        addFinding(finding({
          code: "lite_memory_commit_authority_legacy_after_v2",
          scope: row.scope,
          commitId: row.id,
        }));
      } else {
        trustedLegacyCommitIds.add(`${row.scope}\0${row.id}`);
        state.legacyBoundary = {
          id: row.id,
          commitHash: row.commit_hash,
          createdAt: row.created_at,
        };
      }
    } else if (row.digest_version === 2) {
      v2CommitCount += 1;
      state.v2Count += 1;
      state.seenV2 = true;
      if (!validRevision(row.revision)) {
        addFinding(finding({
          code: "lite_memory_commit_authority_v2_revision_discontinuity",
          scope: row.scope,
          commitId: row.id,
        }));
      }
    } else {
      addFinding(finding({
        code: "lite_memory_commit_authority_digest_version_invalid",
        scope: row.scope,
        commitId: row.id,
      }));
    }
  }

  const terminals = new Map<string, V2Terminal>();
  const terminalClaims = new Map<string, TerminalMutationClaim>();
  const priorClaims = new Map<string, TerminalMutationClaim>();
  const firstNodeTransitions = new Map<string, V2MutationTransition>();
  const pendingMissingObservations: PendingMissingObservation[] = [];
  const revisionBeforeStats: RevisionBeforeStats = {
    checkCount: 0,
    verifiedCount: 0,
    projectionTransitionCount: 0,
    adoptionBaselineProjectionExceptionCount: 0,
    legacyOpaqueBaselineCount: 0,
    invalidCount: 0,
  };
  let previousScope: string | null = null;
  let previous: JoinedCommitRow | null = null;
  const v2Scan = requireSqliteStreamingStatement(
    db.prepare(LITE_MEMORY_COMMIT_AUTHORITY_V2_SCAN_SQL),
    "lite_memory_commit_authority_v2_scan",
  );
  for (const row of v2Scan.iterate<JoinedCommitRow>()) {
    if (row.scope !== previousScope) {
      previousScope = row.scope;
      previous = null;
    }
    const boundary = scopes.get(row.scope)?.legacyBoundary ?? null;
    const expectedRevision = previous === null ? 1 : Number(previous.revision) + 1;
    const expectedParentId = previous === null ? boundary?.id ?? null : previous.id;
    const expectedLegacyAnchorId = previous === null
      ? boundary?.id ?? null
      : previous.legacy_anchor_commit_id;
    if (!validRevision(row.revision) || row.revision !== expectedRevision) {
      addFinding(finding({
        code: "lite_memory_commit_authority_v2_revision_discontinuity",
        scope: row.scope,
        commitId: row.id,
        revision: validRevision(row.revision) ? row.revision : null,
      }));
    }
    if (row.parent_commit_id !== expectedParentId
      || (row.parent_commit_id !== null && row.parent_id !== row.parent_commit_id)
      || (row.parent_id !== null && row.parent_scope !== row.scope)) {
      addFinding(finding({
        code: "lite_memory_commit_authority_v2_parent_mismatch",
        scope: row.scope,
        commitId: row.id,
        revision: validRevision(row.revision) ? row.revision : null,
      }));
    }
    if (row.legacy_anchor_commit_id !== expectedLegacyAnchorId) {
      addFinding(finding({
        code: "lite_memory_commit_authority_v2_legacy_anchor_mismatch",
        scope: row.scope,
        commitId: row.id,
        revision: validRevision(row.revision) ? row.revision : null,
      }));
    }
    try {
      const parsed = assertLiteMemoryCommitV2SelfIntegrity({
        row,
        parentHash: row.parent_commit_id === null ? "" : row.parent_commit_hash ?? "",
      });
      if (validRevision(row.revision)) {
        validateLearningControlOutcomeObservations({
          parsed,
          row: row as JoinedCommitRow & { revision: number },
          priorClaims,
          terminalClaims,
          trustedLegacyCommitIds,
          legacyBoundary: boundary,
          adoption,
          pendingMissing: pendingMissingObservations,
          stats: revisionBeforeStats,
          addFinding,
        });
        const transitions = extractV2MutationTransitions({
          parsed,
          row: row as JoinedCommitRow & { revision: number },
        });
        for (const transition of transitions) {
          if (transition.table === "lite_memory_nodes") {
            const key = terminalClaimKey(transition);
            if (!firstNodeTransitions.has(key)) firstNodeTransitions.set(key, transition);
          }
          applyRevisionBeforeTransition({
            transition,
            priorClaims,
            terminalClaims,
            trustedLegacyCommitIds,
            legacyBoundary: boundary,
            legacyAnchorCommitId: row.legacy_anchor_commit_id,
            adoption,
            stats: revisionBeforeStats,
            addFinding,
          });
        }
      }
    } catch (error) {
      addFinding(mapSelfIntegrityFinding(row, error));
    }
    if (validRevision(row.revision)) {
      terminals.set(row.scope, {
        id: row.id,
        revision: row.revision,
        commitHash: row.commit_hash,
        legacyAnchorCommitId: row.legacy_anchor_commit_id,
      });
    }
    previous = row;
  }

  const headedScopes = new Set<string>();
  let headCount = 0;
  const headScan = requireSqliteStreamingStatement(db.prepare(
    `SELECT h.scope, h.commit_id, h.revision, h.updated_at,
            c.scope AS target_scope,
            c.digest_version AS target_digest_version,
            c.revision AS target_revision
     FROM lite_memory_scope_heads AS h
     LEFT JOIN lite_memory_commits AS c ON c.id = h.commit_id
     ORDER BY h.scope`,
  ), "lite_memory_commit_authority_head_scan");
  for (const head of headScan.iterate<JoinedHeadRow>()) {
    headCount += 1;
    headedScopes.add(head.scope);
    const terminal = terminals.get(head.scope);
    if (!terminal) {
      addFinding(finding({
        code: "lite_memory_commit_authority_head_unexpected",
        scope: head.scope,
        commitId: head.commit_id,
        revision: validRevision(head.revision) ? head.revision : null,
      }));
      continue;
    }
    if (head.target_scope === null) {
      addFinding(finding({
        code: "lite_memory_commit_authority_head_target_missing",
        scope: head.scope,
        commitId: head.commit_id,
        revision: validRevision(head.revision) ? head.revision : null,
      }));
    } else if (head.target_scope !== head.scope || head.target_digest_version !== 2
      || head.target_revision !== head.revision) {
      addFinding(finding({
        code: "lite_memory_commit_authority_head_mismatch",
        scope: head.scope,
        commitId: head.commit_id,
        revision: validRevision(head.revision) ? head.revision : null,
      }));
    }
    if (head.commit_id !== terminal.id || head.revision !== terminal.revision
      || !canonicalUtcMillis(head.updated_at)) {
      addFinding(finding({
        code: "lite_memory_commit_authority_head_not_terminal",
        scope: head.scope,
        commitId: head.commit_id,
        revision: validRevision(head.revision) ? head.revision : null,
      }));
    }
  }
  for (const [scope, terminal] of terminals) {
    if (!headedScopes.has(scope)) {
      addFinding(finding({
        code: "lite_memory_commit_authority_head_missing",
        scope,
        commitId: terminal.id,
        revision: terminal.revision,
      }));
    }
  }

  const findingsBeforeTerminalVerification = findingCount;
  const legacyBoundaryByScope = new Map(
    [...scopes.entries()]
      .flatMap(([scope, state]) => state.legacyBoundary ? [[scope, state.legacyBoundary] as const] : []),
  );
  const terminalVerification = verifyTerminalClaims({
    db,
    claims: terminalClaims,
    trustedLegacyCommitIds,
    legacyBoundaryByScope,
    adoption,
    needsCurrentNodeKeys: pendingMissingObservations.length > 0,
    nodeAbsenceRepresentative: pendingMissingObservations[0] ?? null,
    addFinding,
  });
  for (const observation of pendingMissingObservations) {
    const firstTransition = firstNodeTransitions.get(observation.key) ?? null;
    const laterInsert = firstTransition !== null
      && firstTransition.revision > observation.revision
      && firstTransition.operation === "insert";
    const absentAtTerminalWithoutAnyTransition = terminalVerification.nodeAbsenceProofAvailable
      && firstTransition === null
      && !terminalVerification.currentNodeKeys.has(observation.key);
    if (laterInsert || absentAtTerminalWithoutAnyTransition) {
      revisionBeforeStats.verifiedCount += 1;
      continue;
    }
    revisionBeforeStats.invalidCount += 1;
    addFinding(finding({
      code: "lite_memory_commit_authority_learning_control_outcome_missing_invalid",
      scope: observation.scope,
      commitId: observation.commitId,
      revision: observation.revision,
      causeCode: observation.memoryId,
    }));
  }
  if (adoption.enabled) {
    for (const [key, binding] of adoption.bindings) {
      if (adoption.usedBindingKeys.has(key)) continue;
      adoption.invalidCount += 1;
      addFinding(finding({
        code: "lite_memory_commit_authority_adoption_binding_unmatched",
        scope: binding.scope,
        commitId: null,
        causeCode: binding.authority_table,
      }));
    }
  }
  const terminalClaimsOk = findingCount === findingsBeforeTerminalVerification
    && terminalVerification.verifiedCount === terminalClaims.size;

  const authoritativeScopeCount = [...scopes.values()].filter((state) => state.v2Count > 0).length;
  const legacyOnlyScopeCount = [...scopes.values()].filter(
    (state) => state.legacyCount > 0 && state.v2Count === 0,
  ).length;
  return {
    contract_version: LITE_MEMORY_COMMIT_AUTHORITY_REPORT_CONTRACT,
    authority_mode: "v2_forward_authority",
    ok: findingCount === 0 && terminalVerification.verifiedCount === terminalClaims.size,
    commit_count: commitCount,
    legacy_commit_count: legacyCommitCount,
    v2_commit_count: v2CommitCount,
    scope_count: scopes.size,
    legacy_only_scope_count: legacyOnlyScopeCount,
    authoritative_scope_count: authoritativeScopeCount,
    head_count: headCount,
    terminal_claim_count: terminalClaims.size,
    terminal_row_count: terminalVerification.rowCount,
    terminal_verified_count: terminalVerification.verifiedCount,
    terminal_legacy_opaque_row_count: terminalVerification.legacyOpaqueRowCount,
    terminal_delegated_operation_row_count:
      terminalVerification.delegatedOperationRowCount,
    terminal_adopted_row_count: terminalVerification.adoptedRowCount,
    terminal_unclaimed_row_count: terminalVerification.unclaimedRowCount,
    terminal_projection_tuple_exception_count: terminalVerification.projectionExceptionCount,
    terminal_projection_owned_state_assurance:
      terminalVerification.projectionExceptionCount > 0
        ? "projection_owned_state_shape_validated_not_commit_exact"
        : "not_applicable",
    terminal_authority_assurance: terminalVerification.rowCount === 0
      && terminalClaims.size === 0
      ? "not_applicable"
      : !terminalClaimsOk
        ? "latest_v2_claims_do_not_match_terminal_authoritative_rows"
        : terminalVerification.adoptedRowCount > 0
          ? "latest_v2_claims_match_with_authenticated_adoption"
        : terminalVerification.legacyOpaqueRowCount > 0
          ? terminalVerification.delegatedOperationRowCount > 0
            ? "latest_v2_claims_match_with_legacy_and_delegated_rows"
            : "latest_v2_claims_match_with_legacy_opaque_rows"
          : terminalVerification.delegatedOperationRowCount > 0
            ? "latest_v2_claims_match_with_delegated_operation_rows"
            : "latest_v2_claims_match_terminal_authoritative_rows",
    revision_before_check_count: revisionBeforeStats.checkCount,
    revision_before_verified_count: revisionBeforeStats.verifiedCount,
    revision_before_projection_transition_count:
      revisionBeforeStats.projectionTransitionCount,
    revision_before_projection_owned_state_assurance:
      revisionBeforeStats.projectionTransitionCount > 0
        || revisionBeforeStats.adoptionBaselineProjectionExceptionCount > 0
        ? "projection_owned_state_shape_validated_not_commit_exact"
        : "not_applicable",
    legacy_opaque_baseline_count: revisionBeforeStats.legacyOpaqueBaselineCount,
    adoption_manifest_count: adoption.manifests.size,
    adoption_binding_count: adoption.bindings.size,
    adoption_binding_verified_count: adoption.usedBindingKeys.size,
    adoption_baseline_projection_exception_count:
      revisionBeforeStats.adoptionBaselineProjectionExceptionCount,
    adoption_assurance: !adoption.enabled || adoption.bindings.size === 0
      ? "not_applicable"
      : adoption.invalidCount > 0
        ? "invalid"
        : "immutable_v5_authority_field_bindings_authenticated_by_v2_manifest",
    revision_before_assurance: revisionBeforeStats.invalidCount > 0
      ? "invalid"
      : revisionBeforeStats.legacyOpaqueBaselineCount > 0
        ? adoption.enabled
          ? "authenticated_adoption_baseline"
          : "legacy_opaque_baseline"
        : revisionBeforeStats.checkCount > 0
          ? "v2_chain_proved"
          : "not_applicable",
    finding_count: findingCount,
    findings: storedFindings,
  };
}

/**
 * Startup/backup fail-closed fence. Callers must hold a stable SQLite read
 * snapshot (or the migration write transaction) for the whole inspection.
 */
export function assertLiteMemoryCommitAuthorityIntegrity(
  db: SqliteDatabase,
): LiteMemoryCommitAuthorityReport {
  const report = inspectLiteMemoryCommitAuthority(db, { maxFindings: 100 });
  if (!report.ok) {
    throw new LiteMemoryCommitAuthorityError(
      report.findings[0] ?? finding({
        code: "lite_memory_commit_authority_target_not_authoritative",
      }),
    );
  }
  return report;
}

function commitById(db: SqliteDatabase, commitId: string): JoinedCommitRow | null {
  return (db.prepare(
    `SELECT c.id, c.scope, c.parent_commit_id, c.input_sha256, c.diff_json,
            c.actor, c.model_version, c.prompt_version, c.commit_hash,
            c.created_at, c.digest_version, c.revision, c.mutation_digest,
            c.legacy_anchor_commit_id,
            p.id AS parent_id, p.scope AS parent_scope,
            p.commit_hash AS parent_commit_hash,
            p.digest_version AS parent_digest_version,
            p.revision AS parent_revision,
            p.legacy_anchor_commit_id AS parent_legacy_anchor_commit_id
     FROM lite_memory_commits AS c
     LEFT JOIN lite_memory_commits AS p ON p.id = c.parent_commit_id
     WHERE c.id = ?
     LIMIT 1`,
  ).get(commitId) as JoinedCommitRow | undefined) ?? null;
}

function legacyBoundary(db: SqliteDatabase, scope: string): LegacyBoundary | null {
  return (db.prepare(
    `SELECT id, commit_hash AS commitHash, created_at AS createdAt, revision,
            mutation_digest AS mutationDigest,
            legacy_anchor_commit_id AS legacyAnchorCommitId
     FROM lite_memory_commits
     WHERE scope = ? AND digest_version = 1
     ORDER BY rowid DESC
     LIMIT 1`,
  ).get(scope) as LegacyBoundary | undefined) ?? null;
}

function assertLegacyBoundaryFields(scope: string, boundary: LegacyBoundary | null): void {
  if (boundary && (boundary.revision !== null || boundary.mutationDigest !== null
    || boundary.legacyAnchorCommitId !== null)) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_legacy_fields_invalid",
      scope,
      commitId: boundary.id,
    }));
  }
}

function terminalV2(db: SqliteDatabase, scope: string): V2Terminal | null {
  const row = db.prepare(
    `SELECT id, revision, commit_hash, legacy_anchor_commit_id
     FROM lite_memory_commits
     WHERE scope = ? AND digest_version = 2
     ORDER BY revision DESC
     LIMIT 1`,
  ).get(scope) as {
    id: string;
    revision: number;
    commit_hash: string;
    legacy_anchor_commit_id: string | null;
  } | undefined;
  return row ? {
    id: row.id,
    revision: row.revision,
    commitHash: row.commit_hash,
    legacyAnchorCommitId: row.legacy_anchor_commit_id,
  } : null;
}

function scopeHeadRow(db: SqliteDatabase, scope: string): HeadRow | null {
  return (db.prepare(
    `SELECT scope, commit_id, revision, updated_at
     FROM lite_memory_scope_heads WHERE scope = ? LIMIT 1`,
  ).get(scope) as HeadRow | undefined) ?? null;
}

function assertLocalV2RowAuthority(args: {
  db: SqliteDatabase;
  row: JoinedCommitRow;
  expectedInputSha256?: string;
}): JoinedCommitRow & { revision: number } {
  const { row } = args;
  if (row.digest_version !== 2 || !validRevision(row.revision)
    || (args.expectedInputSha256 !== undefined
      && row.input_sha256 !== args.expectedInputSha256)) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_target_not_authoritative",
      scope: row.scope,
      commitId: row.id,
      revision: validRevision(row.revision) ? row.revision : null,
    }));
  }
  const boundary = row.revision === 1 ? legacyBoundary(args.db, row.scope) : null;
  assertLegacyBoundaryFields(row.scope, boundary);
  const expectedParentId = row.revision === 1 ? boundary?.id ?? null : row.parent_id;
  const expectedAnchor = row.revision === 1
    ? boundary?.id ?? null
    : row.parent_legacy_anchor_commit_id;
  const parentValid = row.revision === 1
    ? row.parent_commit_id === expectedParentId
    : row.parent_id === row.parent_commit_id
      && row.parent_scope === row.scope
      && row.parent_digest_version === 2
      && row.parent_revision === row.revision - 1;
  if (!parentValid) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_v2_parent_mismatch",
      scope: row.scope,
      commitId: row.id,
      revision: row.revision,
    }));
  }
  if (row.legacy_anchor_commit_id !== expectedAnchor) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_v2_legacy_anchor_mismatch",
      scope: row.scope,
      commitId: row.id,
      revision: row.revision,
    }));
  }
  try {
    assertLiteMemoryCommitV2SelfIntegrity({
      row,
      parentHash: row.parent_commit_id === null ? "" : row.parent_commit_hash ?? "",
    });
  } catch (error) {
    throw new LiteMemoryCommitAuthorityError(mapSelfIntegrityFinding(row, error));
  }
  return row as JoinedCommitRow & { revision: number };
}

/**
 * Final publication fence for one pending v2 commit. It point-verifies every
 * claimed after-row before CAS may expose the commit as the scope head. This
 * makes raw commit insertion insufficient to publish unapplied authority.
 */
export function assertLiteMemoryPendingCommitAppliedAuthority(args: {
  db: SqliteDatabase;
  scope: string;
  commitId: string;
}): void {
  const row = commitById(args.db, args.commitId);
  if (!row || row.scope !== args.scope) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: row
        ? "lite_memory_commit_authority_target_scope_mismatch"
        : "lite_memory_commit_authority_target_missing",
      scope: args.scope,
      commitId: args.commitId,
    }));
  }
  const proved = assertLocalV2RowAuthority({ db: args.db, row });
  const parsed = assertLiteMemoryCommitV2SelfIntegrity({
    row: proved,
    parentHash: proved.parent_commit_id === null ? "" : proved.parent_commit_hash ?? "",
  });
  const transitions = extractV2MutationTransitions({ parsed, row: proved });
  if (transitions.length === 0) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_v2_diff_invalid",
      scope: args.scope,
      commitId: args.commitId,
      revision: proved.revision,
      causeCode: "pending_mutations_missing",
    }));
  }
  for (const transition of transitions) {
    const contract = TERMINAL_TABLE_CONTRACTS[transition.table];
    if (!contract) {
      throw new LiteMemoryCommitAuthorityError(finding({
        code: "lite_memory_commit_authority_terminal_table_shape_invalid",
        scope: args.scope,
        commitId: args.commitId,
        revision: proved.revision,
        causeCode: transition.table,
      }));
    }
    const where = contract.identityKeys
      .map((key) => `${quoteSqlIdentifier(key)} = ?`)
      .join(" AND ");
    const actual = args.db.prepare(
      `SELECT ${contract.rowKeys.map(quoteSqlIdentifier).join(", ")}
       FROM ${quoteSqlIdentifier(transition.table)}
       WHERE ${where}
       LIMIT 1`,
    ).get(...contract.identityKeys.map((key) => transition.identity[key])) as
      Record<string, unknown> | undefined;
    if (!actual) {
      throw new LiteMemoryCommitAuthorityError(finding({
        code: "lite_memory_commit_authority_terminal_row_missing",
        scope: args.scope,
        commitId: args.commitId,
        revision: proved.revision,
        causeCode: transition.table,
      }));
    }
    let mismatch: LiteMemoryCommitAuthorityFinding | null = null;
    const verified = verifyTerminalClaimRow({
      claim: transition,
      actual,
      contract,
      addFinding: (value) => {
        mismatch ??= value;
      },
    });
    if (!verified.verified || verified.projectionException) {
      throw new LiteMemoryCommitAuthorityError(mismatch ?? finding({
        code: "lite_memory_commit_authority_terminal_row_mismatch",
        scope: args.scope,
        commitId: args.commitId,
        revision: proved.revision,
        causeCode: `${transition.table}:pending_projection_changed`,
      }));
    }
  }
}

export function assertLiteMemoryPendingCommitClaimsAuthorityRow(args: {
  db: SqliteDatabase;
  scope: string;
  commitId: string;
  table: string;
  identity: Record<string, unknown>;
  persistedRow: Record<string, unknown>;
}): void {
  const row = commitById(args.db, args.commitId);
  if (!row || row.scope !== args.scope) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: row
        ? "lite_memory_commit_authority_target_scope_mismatch"
        : "lite_memory_commit_authority_target_missing",
      scope: args.scope,
      commitId: args.commitId,
    }));
  }
  const proved = assertLocalV2RowAuthority({ db: args.db, row });
  const parsed = assertLiteMemoryCommitV2SelfIntegrity({
    row: proved,
    parentHash: proved.parent_commit_id === null ? "" : proved.parent_commit_hash ?? "",
  });
  const expectedKey = terminalClaimKey({ table: args.table, identity: args.identity });
  const transition = extractV2MutationTransitions({ parsed, row: proved })
    .find((candidate) => terminalClaimKey(candidate) === expectedKey);
  const contract = TERMINAL_TABLE_CONTRACTS[args.table];
  if (!transition || !contract) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_target_not_authoritative",
      scope: args.scope,
      commitId: args.commitId,
      revision: proved.revision,
      causeCode: args.table,
    }));
  }
  let mismatch: LiteMemoryCommitAuthorityFinding | null = null;
  const verified = verifyTerminalClaimRow({
    claim: transition,
    actual: args.persistedRow,
    contract,
    addFinding: (value) => {
      mismatch ??= value;
    },
  });
  if (!verified.verified || verified.projectionException) {
    throw new LiteMemoryCommitAuthorityError(mismatch ?? finding({
      code: "lite_memory_commit_authority_terminal_row_mismatch",
      scope: args.scope,
      commitId: args.commitId,
      revision: proved.revision,
      causeCode: args.table,
    }));
  }
}

function assertPendingSuccessor(args: {
  db: SqliteDatabase;
  scope: string;
  commitId: string;
  currentCommitId: string | null;
  currentRevision: number;
  currentLegacyAnchorCommitId: string | null;
}): void {
  const pending = commitById(args.db, args.commitId);
  if (!pending || pending.scope !== args.scope) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: pending
        ? "lite_memory_commit_authority_target_scope_mismatch"
        : "lite_memory_commit_authority_target_missing",
      scope: args.scope,
      commitId: args.commitId,
    }));
  }
  const proved = assertLocalV2RowAuthority({ db: args.db, row: pending });
  if (proved.revision !== args.currentRevision + 1
    || proved.parent_commit_id !== args.currentCommitId
    || proved.legacy_anchor_commit_id !== args.currentLegacyAnchorCommitId) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_v2_revision_discontinuity",
      scope: args.scope,
      commitId: args.commitId,
      revision: proved.revision,
    }));
  }
}

/** Constant-query local proof for a v2 root; it never recursively walks history. */
export function assertLiteMemoryCommitRootAuthority(args: {
  db: SqliteDatabase;
  scope: string;
  commitId: string;
  expectedInputSha256?: string;
}): LiteMemoryCommitAuthorityProof {
  const row = commitById(args.db, args.commitId);
  if (!row) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_target_missing",
      scope: args.scope,
      commitId: args.commitId,
    }));
  }
  if (row.scope !== args.scope) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_target_scope_mismatch",
      scope: args.scope,
      commitId: args.commitId,
    }));
  }
  const proved = assertLocalV2RowAuthority({
    db: args.db,
    row,
    expectedInputSha256: args.expectedInputSha256,
  });

  const head = scopeHeadRow(args.db, row.scope);
  if (!head) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_head_missing",
      scope: row.scope,
      commitId: row.id,
      revision: row.revision,
    }));
  }
  const terminal = terminalV2(args.db, row.scope);
  if (!terminal || head.commit_id !== terminal.id || head.revision !== terminal.revision
    || !canonicalUtcMillis(head.updated_at)) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_head_not_terminal",
      scope: row.scope,
      commitId: head.commit_id,
      revision: validRevision(head.revision) ? head.revision : null,
    }));
  }
  if (proved.revision > head.revision) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_target_not_authoritative",
      scope: row.scope,
      commitId: row.id,
      revision: proved.revision,
    }));
  }
  return {
    scope: row.scope,
    commitId: row.id,
    commitHash: row.commit_hash,
    revision: proved.revision,
    legacyAnchorCommitId: row.legacy_anchor_commit_id,
    headCommitId: head.commit_id,
    headRevision: head.revision,
    assurance: "local_v2_link_and_terminal_head",
  };
}

/**
 * Reads a scope head and proves the returned local authority root. v1-only
 * histories remain an explicitly unauthenticated rowid boundary at revision 0.
 */
export function assertLiteMemoryScopeHeadAuthority(
  db: SqliteDatabase,
  scope: string,
  options: { pendingSuccessorCommitId?: string } = {},
): WriteScopeHead | null {
  const columns = tableColumns(db, "lite_memory_commits");
  const presentV5ColumnCount = V5_COMMIT_COLUMNS.filter((column) => columns.has(column)).length;
  const hasHeadTable = tableExists(db, "lite_memory_scope_heads");
  const hasV5 = presentV5ColumnCount === V5_COMMIT_COLUMNS.length && hasHeadTable;
  const isLegacyV1Schema = presentV5ColumnCount === 0 && !hasHeadTable;
  if (isLegacyV1Schema) {
    const legacy = db.prepare(
      `SELECT scope, id, commit_hash, created_at
       FROM lite_memory_commits WHERE scope = ? ORDER BY rowid DESC LIMIT 1`,
    ).get(scope) as {
      scope: string;
      id: string;
      commit_hash: string;
      created_at: string;
    } | undefined;
    return legacy ? {
      scope: legacy.scope,
      commitId: legacy.id,
      commitHash: legacy.commit_hash,
      revision: 0,
      digestVersion: 1,
      legacyAnchorCommitId: legacy.id,
      persisted: false,
      updatedAt: legacy.created_at,
    } : null;
  }
  if (!hasV5) {
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_schema_incomplete",
      scope,
    }));
  }

  const persisted = scopeHeadRow(db, scope);
  if (persisted) {
    const row = commitById(db, persisted.commit_id);
    if (!row) {
      throw new LiteMemoryCommitAuthorityError(finding({
        code: "lite_memory_commit_authority_head_target_missing",
        scope,
        commitId: persisted.commit_id,
        revision: validRevision(persisted.revision) ? persisted.revision : null,
      }));
    }
    if (row.scope !== scope) {
      throw new LiteMemoryCommitAuthorityError(finding({
        code: "lite_memory_commit_authority_head_mismatch",
        scope,
        commitId: persisted.commit_id,
        revision: validRevision(persisted.revision) ? persisted.revision : null,
      }));
    }
    const proof = assertLocalV2RowAuthority({ db, row });
    if (proof.revision !== persisted.revision || !canonicalUtcMillis(persisted.updated_at)) {
      throw new LiteMemoryCommitAuthorityError(finding({
        code: "lite_memory_commit_authority_head_mismatch",
        scope,
        commitId: persisted.commit_id,
        revision: validRevision(persisted.revision) ? persisted.revision : null,
      }));
    }
    const terminal = terminalV2(db, scope);
    if (!terminal) {
      throw new LiteMemoryCommitAuthorityError(finding({
        code: "lite_memory_commit_authority_head_unexpected",
        scope,
        commitId: persisted.commit_id,
        revision: persisted.revision,
      }));
    }
    if (terminal.id !== persisted.commit_id || terminal.revision !== persisted.revision) {
      if (!options.pendingSuccessorCommitId
        || terminal.id !== options.pendingSuccessorCommitId) {
        throw new LiteMemoryCommitAuthorityError(finding({
          code: "lite_memory_commit_authority_head_not_terminal",
          scope,
          commitId: persisted.commit_id,
          revision: persisted.revision,
        }));
      }
      assertPendingSuccessor({
        db,
        scope,
        commitId: options.pendingSuccessorCommitId,
        currentCommitId: persisted.commit_id,
        currentRevision: persisted.revision,
        currentLegacyAnchorCommitId: proof.legacy_anchor_commit_id,
      });
    }
    return {
      scope,
      commitId: proof.id,
      commitHash: proof.commit_hash,
      revision: proof.revision,
      digestVersion: 2,
      legacyAnchorCommitId: proof.legacy_anchor_commit_id,
      persisted: true,
      updatedAt: persisted.updated_at,
    };
  }

  const legacy = legacyBoundary(db, scope);
  assertLegacyBoundaryFields(scope, legacy);
  const terminal = terminalV2(db, scope);
  if (terminal) {
    if (options.pendingSuccessorCommitId === terminal.id) {
      assertPendingSuccessor({
        db,
        scope,
        commitId: terminal.id,
        currentCommitId: legacy?.id ?? null,
        currentRevision: 0,
        currentLegacyAnchorCommitId: legacy?.id ?? null,
      });
      return legacy ? {
        scope,
        commitId: legacy.id,
        commitHash: legacy.commitHash,
        revision: 0,
        digestVersion: 1,
        legacyAnchorCommitId: legacy.id,
        persisted: false,
        updatedAt: legacy.createdAt,
      } : null;
    }
    throw new LiteMemoryCommitAuthorityError(finding({
      code: "lite_memory_commit_authority_head_missing",
      scope,
      commitId: terminal.id,
      revision: terminal.revision,
    }));
  }
  return legacy ? {
    scope,
    commitId: legacy.id,
    commitHash: legacy.commitHash,
    revision: 0,
    digestVersion: 1,
    legacyAnchorCommitId: legacy.id,
    persisted: false,
    updatedAt: legacy.createdAt,
  } : null;
}
