import type { AionisClaimWrite } from "../memory/claim-ledger-contract.js";

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
