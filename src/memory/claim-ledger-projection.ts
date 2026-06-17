import {
  AionisClaimLedgerProjectionSchema,
  type AionisClaimLedgerProjection,
  type AionisClaimLedgerProjectionItem,
  type AionisClaimLedgerProjectionSurface,
} from "./product-output-contract.js";
import type { ClaimLedgerRow } from "../store/claim-ledger-access.js";

const DEFAULT_PROJECTION_LIMIT = 12;
const MAX_PROJECTION_LIMIT = 64;
const VALUE_TEXT_MAX_CHARS = 500;

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_PROJECTION_LIMIT, Math.trunc(value))
    : DEFAULT_PROJECTION_LIMIT;
}

function compactText(value: string, maxChars = VALUE_TEXT_MAX_CHARS): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function claimValueText(row: ClaimLedgerRow): string {
  const text = typeof row.value_text === "string" ? compactText(row.value_text) : "";
  if (text) return text;
  return compactText(`${row.subject_key} ${row.predicate}`);
}

function parseStringListJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, 32);
  } catch {
    return [];
  }
}

function projectionSurface(row: ClaimLedgerRow): {
  surface: AionisClaimLedgerProjectionSurface;
  reasonCode: string;
} {
  if (row.authority === "evidence_only") {
    return { surface: "audit_only", reasonCode: "claim_ledger_evidence_only" };
  }
  if (row.authority === "blocked") {
    return { surface: "do_not_use", reasonCode: "claim_ledger_blocked" };
  }
  if (row.status === "superseded") {
    return { surface: "do_not_use", reasonCode: "claim_ledger_superseded" };
  }
  if (row.status === "contested") {
    return { surface: "inspect_before_use", reasonCode: "claim_ledger_contested_manual_inspect" };
  }
  if (row.status === "retired" || row.status === "redacted") {
    return { surface: "do_not_use", reasonCode: `claim_ledger_${row.status}` };
  }
  if (row.status === "active" && (row.authority === "advisory" || row.authority === "trusted")) {
    return {
      surface: "use_now",
      reasonCode: row.conflict_policy === "singleton_latest"
        ? "claim_ledger_live_singleton"
        : "claim_ledger_live_claim",
    };
  }
  return { surface: "inspect_before_use", reasonCode: "claim_ledger_unhandled_state" };
}

function projectionItem(row: ClaimLedgerRow): AionisClaimLedgerProjectionItem {
  const surface = projectionSurface(row);
  return {
    claim_id: row.claim_id,
    slot_key: row.slot_key,
    subject_key: row.subject_key,
    predicate: row.predicate,
    surface: surface.surface,
    reason_code: surface.reasonCode,
    value_text: claimValueText(row),
    authority: row.authority as AionisClaimLedgerProjectionItem["authority"],
    status: row.status,
    confidence: row.confidence,
    evidence_refs: parseStringListJson(row.evidence_refs_json),
    source_memory_id: row.source_memory_id,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    superseded_by_claim_id: row.superseded_by_claim_id,
  };
}

function pushBounded(
  projection: Pick<AionisClaimLedgerProjection, "use_now" | "inspect_before_use" | "do_not_use" | "audit_only">,
  item: AionisClaimLedgerProjectionItem,
  limit: number,
): void {
  const bucket = projection[item.surface];
  if (bucket.length < limit) bucket.push(item);
}

export function buildClaimLedgerProjection(args: {
  liveClaims: ClaimLedgerRow[];
  supersededClaims: ClaimLedgerRow[];
  queryText?: string | null;
  limit: number;
}): AionisClaimLedgerProjection {
  const limit = normalizeLimit(args.limit);
  const projection = {
    contract_version: "aionis_claim_ledger_projection_v1" as const,
    use_now: [] as AionisClaimLedgerProjectionItem[],
    inspect_before_use: [] as AionisClaimLedgerProjectionItem[],
    do_not_use: [] as AionisClaimLedgerProjectionItem[],
    audit_only: [] as AionisClaimLedgerProjectionItem[],
    blocked_superseded_count: args.supersededClaims.length,
    live_claim_count: args.liveClaims.length,
    contested_claim_count: args.liveClaims.filter((row) => row.status === "contested").length,
    agent_prompt_included: false as const,
    runtime_mutation: false as const,
  };

  for (const row of args.liveClaims) {
    pushBounded(projection, projectionItem(row), limit);
  }
  for (const row of args.supersededClaims) {
    pushBounded(projection, projectionItem(row), limit);
  }

  return AionisClaimLedgerProjectionSchema.parse(projection);
}
