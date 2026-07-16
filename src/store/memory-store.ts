import type { AionisClaimWrite } from "../memory/claim-ledger-contract.js";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.js";
import type {
  AionisEffectReport,
  AionisTraceDerivedSkillCandidate,
} from "../memory/product-output-contract.js";
import { sha256Hex } from "../util/crypto.js";

export type LiteRuntimeStoreSession = {
  sandboxStoreAccess: unknown;
};

export interface LiteRuntimeStore {
  readonly backend: "lite_sqlite";
  withClient<T>(fn: (session: LiteRuntimeStoreSession) => Promise<T>): Promise<T>;
  withTx<T>(fn: (session: LiteRuntimeStoreSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const CLAIM_LEDGER_ACCESS_CAPABILITY_VERSION = 1;

export type ClaimLedgerStatus = "active" | "contested" | "superseded" | "retired" | "redacted";

export type ClaimLedgerRow = {
  claim_id: string;
  scope: string;
  tenant_id: string;
  client_id: string | null;
  subject_key: string;
  predicate: string;
  slot_key: string | null;
  value_json: string;
  value_text: string | null;
  claim_kind: string;
  conflict_policy: string;
  authority: string;
  confidence: number;
  status: ClaimLedgerStatus;
  valid_from: string;
  valid_until: string | null;
  source_memory_id: string | null;
  evidence_refs_json: string;
  supersedes_claim_ids_json: string;
  superseded_by_claim_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type ClaimLedgerEventRow = {
  event_id: string;
  scope: string;
  tenant_id: string;
  claim_id: string;
  event_type: string;
  reason_code: string;
  details_json: string;
  created_at: string;
};

export type ClaimLedgerAccess = {
  transactionRunner(): SqliteTransactionRunner;
  writeClaim(args: { scope: string; tenantId: string; claim: AionisClaimWrite; now?: string }): Promise<ClaimLedgerRow>;
  findLiveClaims(args: {
    scope: string;
    tenantId?: string;
    subjectKey?: string;
    slotKey?: string;
    limit: number;
  }): Promise<{ rows: ClaimLedgerRow[] }>;
  findSupersededClaims(args: { scope: string; tenantId?: string; slotKey: string; limit: number }): Promise<{ rows: ClaimLedgerRow[] }>;
  getClaim(args: { scope: string; tenantId?: string; claimId: string }): Promise<ClaimLedgerRow | null>;
  listEvents(args: { scope: string; tenantId?: string; claimId?: string; limit: number }): Promise<{ rows: ClaimLedgerEventRow[] }>;
  close(): Promise<void>;
};

export const SKILL_CANDIDATE_REVIEW_ACCESS_CAPABILITY_VERSION = 3;

export type SkillCandidateReviewStatus = "pending_review" | "promoted" | "rejected";

export type ProductMeasurementRecord = {
  measurement_id: string;
  tenant_id: string;
  scope: string;
  source: "manual_observations" | "product_trace";
  measurement_digest: string;
  baseline_episode_id: string | null;
  after_episode_id: string | null;
  record_sha256: string | null;
  effect_report: AionisEffectReport;
  eligible_for_skill_export: boolean;
  evidence_status: "sufficient" | "insufficient";
  runtime_evidence_ids: string[];
  eligibility_reasons: string[];
  created_by: string;
  created_at: string;
};

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

export function stableJsonDigest(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalJsonValue(value)));
}

export function productMeasurementDigest(args: Pick<
  ProductMeasurementRecord,
  | "effect_report"
  | "eligible_for_skill_export"
  | "evidence_status"
  | "runtime_evidence_ids"
  | "eligibility_reasons"
>): string {
  return stableJsonDigest({
    effect_report: args.effect_report,
    eligible_for_skill_export: args.eligible_for_skill_export,
    evidence_status: args.evidence_status,
    runtime_evidence_ids: args.runtime_evidence_ids,
    eligibility_reasons: args.eligibility_reasons,
  });
}

export function productMeasurementRecordDigest(args: Pick<
  ProductMeasurementRecord,
  | "measurement_id"
  | "tenant_id"
  | "scope"
  | "source"
  | "baseline_episode_id"
  | "after_episode_id"
  | "measurement_digest"
  | "created_by"
  | "created_at"
>): string {
  return stableJsonDigest({
    measurement_id: args.measurement_id,
    tenant_id: args.tenant_id,
    scope: args.scope,
    source: args.source,
    baseline_episode_id: args.baseline_episode_id,
    after_episode_id: args.after_episode_id,
    measurement_digest: args.measurement_digest,
    created_by: args.created_by,
    created_at: args.created_at,
  });
}

export type TraceDerivedSkillTrainingCandidate = {
  candidate_type: "trace_derived_skill";
  source_ids: string[];
  label: "positive" | "negative" | "neutral" | "blocked" | "insufficient_evidence";
  export_ready: boolean;
  reason: string;
  trace_derived_skill: AionisTraceDerivedSkillCandidate;
};

export type SkillCandidateReviewRow = {
  candidate_id: string;
  tenant_id: string;
  scope: string;
  review_status: SkillCandidateReviewStatus;
  skill_name: string;
  label: TraceDerivedSkillTrainingCandidate["label"];
  export_ready: boolean;
  promotion_status: TraceDerivedSkillTrainingCandidate["trace_derived_skill"]["promotion_status"];
  reason: string;
  source_ids: string[];
  source_trace_ids: string[];
  source_signal_ids: string[];
  applies_when: string[];
  does_not_apply_when: string[];
  procedure_steps: string[];
  target_files: string[];
  acceptance_checks: string[];
  failure_counterexamples: string[];
  evidence_refs: string[];
  candidate: TraceDerivedSkillTrainingCandidate;
  measurement_id: string | null;
  measurement_digest: string | null;
  candidate_digest: string;
  eligible_for_promotion: boolean;
  row_version: number;
  reviewer_id: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
};

export type SkillCandidateReviewAccess = {
  transactionRunner(): SqliteTransactionRunner;
  recordMeasurement(args: {
    record: ProductMeasurementRecord;
  }): Promise<ProductMeasurementRecord>;
  getMeasurement(args: {
    tenantId: string;
    scope: string;
    measurementId: string;
  }): Promise<ProductMeasurementRecord | null>;
  getMeasurementByOperationId(args: {
    tenantId: string;
    scope: string;
    operationId: string;
  }): Promise<Readonly<{
    measurement: ProductMeasurementRecord;
    requestSha256: string;
  }> | null>;
  enqueueTraceDerivedSkillCandidates(args: {
    tenantId: string;
    scope: string;
    candidates: TraceDerivedSkillTrainingCandidate[];
    measurementId: string;
    measurementDigest: string;
    eligibleForPromotion: boolean;
    now?: string;
  }): Promise<{ rows: SkillCandidateReviewRow[]; inserted: number; updated: number }>;
  listTraceDerivedSkillCandidates(args: {
    tenantId: string;
    scope: string;
    reviewStatus?: SkillCandidateReviewStatus | "all";
    limit: number;
  }): Promise<{ rows: SkillCandidateReviewRow[] }>;
  getTraceDerivedSkillCandidate(args: {
    tenantId: string;
    scope: string;
    candidateId: string;
  }): Promise<SkillCandidateReviewRow | null>;
  reviewTraceDerivedSkillCandidate(args: {
    tenantId: string;
    scope: string;
    candidateId: string;
    reviewStatus: "promoted" | "rejected";
    reviewerId: string;
    reason: string;
    expectedVersion: number;
    now?: string;
  }): Promise<SkillCandidateReviewRow | null>;
  close(): Promise<void>;
};
