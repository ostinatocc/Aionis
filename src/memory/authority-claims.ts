export type AuthorityWriteNode = {
  id: string;
  client_id?: string;
  scope?: string;
  type: string;
  slots: Record<string, unknown>;
};

export type AuthorityWriteRequirement =
  | "authoritative_trust_requires_passing_authority_gate"
  | "stable_promotion_requires_passing_authority_gate"
  | "broad_policy_authority_requires_passing_authority_gate";

export type AuthorityClaim = {
  path: string;
  requirement: AuthorityWriteRequirement;
  requestedValue: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function nestedRecords(slots: Record<string, unknown>): Array<{ path: string; record: Record<string, unknown> }> {
  return [
    { path: "slots", record: slots },
    { path: "slots.anchor_v1", record: asRecord(slots.anchor_v1) },
    { path: "slots.execution_native_v1", record: asRecord(slots.execution_native_v1) },
    { path: "slots.execution_contract_v1", record: asRecord(slots.execution_contract_v1) },
    { path: "slots.policy_contract_v1", record: asRecord(slots.policy_contract_v1) },
  ].filter((entry): entry is { path: string; record: Record<string, unknown> } => !!entry.record);
}

function recordContractTrust(record: Record<string, unknown>): string | null {
  return firstString(record.contract_trust);
}

function promotionState(record: Record<string, unknown>): string | null {
  return firstString(
    record.promotion_state,
    asRecord(record.workflow_promotion)?.promotion_state,
    asRecord(record.maintenance)?.promotion_state,
  );
}

function broadPolicyAuthorityEffect(record: Record<string, unknown>): string | null {
  const proposed = firstString(record.proposed_effect);
  return proposed === "active" || proposed === "default" || proposed === "stable" ? proposed : null;
}

function isAuthorityProducingContractSurface(
  node: AuthorityWriteNode,
  slots: Record<string, unknown>,
): boolean {
  const executionNative = asRecord(slots.execution_native_v1);
  const anchor = asRecord(slots.anchor_v1);
  const summaryKind = firstString(slots.summary_kind, executionNative?.summary_kind);
  const executionKind = firstString(executionNative?.execution_kind);
  const anchorKind = firstString(anchor?.anchor_kind);
  if (
    firstString(slots.replay_kind) === "playbook"
    && summaryKind !== "workflow_anchor"
    && executionKind !== "workflow_anchor"
    && anchorKind !== "workflow"
  ) {
    return false;
  }
  if (summaryKind === "workflow_anchor" || summaryKind === "policy_memory") return true;
  if (executionKind === "workflow_anchor") return true;
  if (anchorKind === "workflow") return true;
  return node.type !== "event";
}

export function collectAuthorityClaims(node: AuthorityWriteNode, slots: Record<string, unknown>): AuthorityClaim[] {
  const claims: AuthorityClaim[] = [];
  const authorityProducingContractSurface = isAuthorityProducingContractSurface(node, slots);
  for (const entry of nestedRecords(slots)) {
    if (authorityProducingContractSurface && recordContractTrust(entry.record) === "authoritative") {
      claims.push({
        path: `${entry.path}.contract_trust`,
        requirement: "authoritative_trust_requires_passing_authority_gate",
        requestedValue: "authoritative",
      });
    }
    if (promotionState(entry.record) === "stable") {
      claims.push({
        path: `${entry.path}.promotion_state`,
        requirement: "stable_promotion_requires_passing_authority_gate",
        requestedValue: "stable",
      });
    }
  }
  const policyMutation = asRecord(slots.policy_mutation_v1);
  const broadPolicyEffect = policyMutation ? broadPolicyAuthorityEffect(policyMutation) : null;
  if (broadPolicyEffect) {
    claims.push({
      path: "slots.policy_mutation_v1.proposed_effect",
      requirement: "broad_policy_authority_requires_passing_authority_gate",
      requestedValue: broadPolicyEffect,
    });
  }
  return claims;
}

export function authorityClaimPaths(claims: AuthorityClaim[]): string[] {
  return Array.from(new Set(claims.map((claim) => claim.path))).sort();
}
