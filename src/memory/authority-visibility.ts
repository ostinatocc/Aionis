import type { RuntimeAuthorityGateV1 } from "./authority-gate.js";

type AuthorityStatus = "sufficient" | "insufficient" | "unknown";

export type RuntimeAuthorityVisibilityV1 = {
  surface_version: "runtime_authority_visibility_v1";
  node_id: string | null;
  node_kind: string | null;
  title: string | null;
  requested_trust: string | null;
  effective_trust: string | null;
  status: AuthorityStatus;
  allows_authoritative: boolean;
  allows_stable_promotion: boolean;
  authority_blocked: boolean;
  stable_promotion_blocked: boolean;
  primary_blocker: string | null;
  authority_reasons: string[];
  outcome_contract_reasons: string[];
  execution_evidence_reasons: string[];
  execution_evidence_status: string | null;
  false_confidence_detected: boolean;
};

export type RuntimeAuthorityVisibilitySummaryV1 = {
  summary_version: "runtime_authority_visibility_summary_v1";
  surface_count: number;
  sufficient_count: number;
  insufficient_count: number;
  authoritative_allowed_count: number;
  authoritative_blocked_count: number;
  stable_promotion_allowed_count: number;
  stable_promotion_blocked_count: number;
  execution_evidence_failed_count: number;
  execution_evidence_incomplete_count: number;
  false_confidence_count: number;
  reason_counts: Record<string, number>;
  top_blockers: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function authorityGateRecord(value: unknown): RuntimeAuthorityGateV1 | null {
  const record = asRecord(value);
  return record?.gate_version === "runtime_authority_gate_v1" ? record as RuntimeAuthorityGateV1 : null;
}

function evidenceAssessmentRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return record?.schema_version === "execution_evidence_assessment_v1" ? record : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function stringList(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeStatus(...values: unknown[]): AuthorityStatus {
  const status = firstString(...values);
  return status === "sufficient" || status === "insufficient" ? status : "unknown";
}

function visibilityFromRecord(args: {
  record: Record<string, unknown>;
  nodeId?: string | null;
  nodeKind?: string | null;
  title?: string | null;
}): RuntimeAuthorityVisibilityV1 | null {
  const existing = asRecord(args.record.authority_visibility);
  if (existing?.surface_version === "runtime_authority_visibility_v1") {
    return {
      surface_version: "runtime_authority_visibility_v1",
      node_id: firstString(existing.node_id, args.nodeId),
      node_kind: firstString(existing.node_kind, args.nodeKind),
      title: firstString(existing.title, args.title),
      requested_trust: firstString(existing.requested_trust),
      effective_trust: firstString(existing.effective_trust),
      status: normalizeStatus(existing.status),
      allows_authoritative: firstBoolean(existing.allows_authoritative) === true,
      allows_stable_promotion: firstBoolean(existing.allows_stable_promotion) === true,
      authority_blocked: firstBoolean(existing.authority_blocked) === true,
      stable_promotion_blocked: firstBoolean(existing.stable_promotion_blocked) === true,
      primary_blocker: firstString(existing.primary_blocker),
      authority_reasons: stringList(existing.authority_reasons),
      outcome_contract_reasons: stringList(existing.outcome_contract_reasons),
      execution_evidence_reasons: stringList(existing.execution_evidence_reasons),
      execution_evidence_status: firstString(existing.execution_evidence_status),
      false_confidence_detected: firstBoolean(existing.false_confidence_detected) === true,
    };
  }

  const authorityGate = authorityGateRecord(args.record.authority_gate_v1);
  const outcomeGate = firstRecord(authorityGate?.outcome_contract_gate, args.record.outcome_contract_gate);
  const evidenceAssessment = evidenceAssessmentRecord(firstRecord(
    authorityGate?.execution_evidence_assessment,
    args.record.execution_evidence_assessment,
  ));
  if (!authorityGate && !evidenceAssessment) return null;

  const authorityReasons = stringList(authorityGate?.reasons);
  const outcomeReasons = stringList(outcomeGate?.reasons);
  const evidenceReasons = stringList(evidenceAssessment?.reasons);
  const requestedTrust = firstString(
    authorityGate?.requested_trust,
    outcomeGate?.requested_trust,
    evidenceAssessment?.requested_trust,
    args.record.contract_trust,
  );
  const effectiveTrust = firstString(
    authorityGate?.effective_trust,
    evidenceAssessment?.effective_trust,
    requestedTrust,
  );
  const allowsAuthoritative = firstBoolean(authorityGate?.allows_authoritative, outcomeGate?.allows_authoritative) === true;
  const allowsStablePromotion = firstBoolean(
    authorityGate?.allows_stable_promotion,
    evidenceAssessment?.allows_stable_promotion,
  ) === true;
  const status = normalizeStatus(authorityGate?.status, outcomeGate?.status);
  const authorityBlocked = requestedTrust === "authoritative" && !allowsAuthoritative;
  const stablePromotionBlocked = !allowsStablePromotion;
  const primaryBlocker =
    authorityReasons[0]
    ?? (outcomeReasons[0] ? `outcome_contract:${outcomeReasons[0]}` : null)
    ?? (evidenceReasons[0] ? `execution_evidence:${evidenceReasons[0]}` : null);
  const decisiveFields = asRecord(evidenceAssessment?.decisive_fields);

  return {
    surface_version: "runtime_authority_visibility_v1",
    node_id: args.nodeId ?? null,
    node_kind: args.nodeKind ?? null,
    title: args.title ?? null,
    requested_trust: requestedTrust,
    effective_trust: effectiveTrust,
    status,
    allows_authoritative: allowsAuthoritative,
    allows_stable_promotion: allowsStablePromotion,
    authority_blocked: authorityBlocked,
    stable_promotion_blocked: stablePromotionBlocked,
    primary_blocker: primaryBlocker,
    authority_reasons: authorityReasons,
    outcome_contract_reasons: outcomeReasons,
    execution_evidence_reasons: evidenceReasons,
    execution_evidence_status: firstString(evidenceAssessment?.status),
    false_confidence_detected: firstBoolean(decisiveFields?.false_confidence_detected) === true,
  };
}

export function buildRuntimeAuthorityVisibilityFromSlots(args: {
  nodeId?: string | null;
  nodeKind?: string | null;
  title?: string | null;
  slots: Record<string, unknown> | null | undefined;
}): RuntimeAuthorityVisibilityV1 | null {
  const slots = asRecord(args.slots) ?? {};
  return visibilityFromRecord({
    record: slots,
    nodeId: args.nodeId ?? null,
    nodeKind: args.nodeKind ?? null,
    title: args.title ?? null,
  });
}

export function runtimeAuthorityVisibilityFromEntry(entry: unknown): RuntimeAuthorityVisibilityV1 | null {
  const record = asRecord(entry);
  if (!record) return null;
  return visibilityFromRecord({
    record,
    nodeId: firstString(record.anchor_id, record.node_id),
    nodeKind: firstString(record.kind, record.summary_kind, record.type),
    title: firstString(record.title, record.summary),
  });
}

export function summarizeRuntimeAuthorityVisibility(
  entries: Array<RuntimeAuthorityVisibilityV1 | null | undefined>,
): RuntimeAuthorityVisibilitySummaryV1 {
  const surfaces = entries.filter((entry): entry is RuntimeAuthorityVisibilityV1 => !!entry);
  const reasonCounts: Record<string, number> = {};
  for (const surface of surfaces) {
    const reasons = surface.authority_reasons.length > 0
      ? surface.authority_reasons
      : [
          ...surface.outcome_contract_reasons.map((reason) => `outcome_contract:${reason}`),
          ...surface.execution_evidence_reasons.map((reason) => `execution_evidence:${reason}`),
        ];
    for (const reason of reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  const topBlockers = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason]) => reason)
    .slice(0, 8);
  return {
    summary_version: "runtime_authority_visibility_summary_v1",
    surface_count: surfaces.length,
    sufficient_count: surfaces.filter((entry) => entry.status === "sufficient").length,
    insufficient_count: surfaces.filter((entry) => entry.status === "insufficient").length,
    authoritative_allowed_count: surfaces.filter((entry) => entry.allows_authoritative).length,
    authoritative_blocked_count: surfaces.filter((entry) => entry.authority_blocked).length,
    stable_promotion_allowed_count: surfaces.filter((entry) => entry.allows_stable_promotion).length,
    stable_promotion_blocked_count: surfaces.filter((entry) => entry.stable_promotion_blocked).length,
    execution_evidence_failed_count: surfaces.filter((entry) => entry.execution_evidence_status === "failed").length,
    execution_evidence_incomplete_count: surfaces.filter((entry) => entry.execution_evidence_status === "incomplete").length,
    false_confidence_count: surfaces.filter((entry) => entry.false_confidence_detected).length,
    reason_counts: reasonCounts,
    top_blockers: topBlockers,
  };
}
