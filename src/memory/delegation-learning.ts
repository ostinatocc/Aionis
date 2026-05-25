import { aggregateDelegationRecordsLite } from "./delegation-records-find.js";
import type { DelegationRecordsLearningRecommendation } from "./schemas.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function expandTaskFamilyCandidates(values: unknown[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) continue;
    const expanded = trimmed.startsWith("task:")
      ? [trimmed]
      : [`task:${trimmed}`, trimmed];
    for (const candidate of expanded) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

function firstPositiveInt(values: unknown[], fallback: number, max: number) {
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const normalized = Math.trunc(value);
    if (normalized <= 0) continue;
    return Math.min(normalized, max);
  }
  return fallback;
}

export type DelegationLearningSliceLite = {
  task_family: string | null;
  matched_records: number;
  truncated: boolean;
  route_role_counts: Record<string, number>;
  record_outcome_counts: Record<string, number>;
  recommendation_count: number;
  learning_recommendations: DelegationRecordsLearningRecommendation[];
};

export async function buildDelegationLearningSliceLite(args: {
  liteWriteStore: LiteWriteStore;
  body: unknown;
  tenantId: string;
  scope: string;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId?: string | null;
  taskFamilies?: unknown[];
  limitCandidates?: unknown[];
}): Promise<DelegationLearningSliceLite> {
  const requestBody = asRecord(args.body);
  const taskFamilies = expandTaskFamilyCandidates(args.taskFamilies ?? []);
  if (taskFamilies.length === 0) {
    return {
      task_family: null,
      matched_records: 0,
      truncated: false,
      route_role_counts: {},
      record_outcome_counts: {},
      recommendation_count: 0,
      learning_recommendations: [],
    };
  }
  const selectedTaskFamily = taskFamilies[0] ?? null;
  let matchedTaskFamily = selectedTaskFamily;
  let aggregate = await aggregateDelegationRecordsLite(
    args.liteWriteStore,
    {
      tenant_id: args.tenantId,
      scope: args.scope,
      task_family: selectedTaskFamily,
      consumer_agent_id: firstString(requestBody.consumer_agent_id, args.defaultActorId ?? null) ?? undefined,
      consumer_team_id: firstString(requestBody.consumer_team_id) ?? undefined,
      limit: firstPositiveInt(args.limitCandidates ?? [], 20, 100),
    },
    args.defaultScope,
    args.defaultTenantId,
  );
  for (const candidate of taskFamilies.slice(1)) {
    if (aggregate.summary.matched_records > 0) break;
    const candidateAggregate = await aggregateDelegationRecordsLite(
      args.liteWriteStore,
      {
        tenant_id: args.tenantId,
        scope: args.scope,
        task_family: candidate,
        consumer_agent_id: firstString(requestBody.consumer_agent_id, args.defaultActorId ?? null) ?? undefined,
        consumer_team_id: firstString(requestBody.consumer_team_id) ?? undefined,
        limit: firstPositiveInt(args.limitCandidates ?? [], 20, 100),
      },
      args.defaultScope,
      args.defaultTenantId,
    );
    if (candidateAggregate.summary.matched_records > 0) {
      matchedTaskFamily = candidate;
      aggregate = candidateAggregate;
      break;
    }
  }

  return {
    task_family: matchedTaskFamily,
    matched_records: aggregate.summary.matched_records,
    truncated: aggregate.summary.truncated,
    route_role_counts: aggregate.summary.route_role_counts,
    record_outcome_counts: aggregate.summary.record_outcome_counts,
    recommendation_count: aggregate.summary.learning_recommendations.length,
    learning_recommendations: aggregate.summary.learning_recommendations,
  };
}
