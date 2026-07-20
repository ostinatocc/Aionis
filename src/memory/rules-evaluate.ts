import { RulesEvaluateRequest } from "./schemas.js";
import { ruleMatchesContext } from "./rule-engine.js";
import { buildAppliedPolicy, parsePolicyPatch, type PolicyPatch } from "./rule-policy.js";
import { computeEffectiveToolPolicy } from "./tool-policy.js";
import { resolveTenantScope } from "./tenant.js";
import type { LiteRuleCandidateRow, LiteWriteStore } from "../store/lite-write-store.js";
import { memoryNodeVisible } from "../store/memory-visibility.js";
import { buildRulesEvaluationSummary } from "./tools-lifecycle-summary.js";
import {
  buildToolRuleEvaluationSource,
  resolveToolRuleRankControls,
  type ToolRuleEvaluationSource,
} from "./tool-rule-evaluation-provenance.js";

type RuleRow = LiteRuleCandidateRow;

type RuleRankMeta = {
  score: number;
  evidence_score: number;
  priority: number;
  weight: number;
  specificity: number;
  condition_paths: string[];
};

type EvaluateRulesOptions = {
  liteWriteStore?: Pick<LiteWriteStore, "listRuleCandidates"> | null;
};

function isPlainObject(v: any): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function collectConditionPaths(pattern: any, prefix = "", out?: Set<string>): Set<string> {
  const s = out ?? new Set<string>();
  if (pattern === null || pattern === undefined) return s;

  if (Array.isArray(pattern)) {
    if (prefix) s.add(prefix);
    return s;
  }

  if (isPlainObject(pattern)) {
    const keys = Object.keys(pattern);
    if (keys.length === 0) {
      if (prefix) s.add(prefix);
      return s;
    }
    for (const k of keys) {
      const v = pattern[k];
      if (k === "$and" || k === "$or") {
        if (Array.isArray(v)) {
          for (const p of v) collectConditionPaths(p, prefix, s);
        }
        continue;
      }
      if (k === "$not") {
        collectConditionPaths(v, prefix, s);
        continue;
      }
      if (k.startsWith("$")) {
        if (prefix) s.add(prefix);
        continue;
      }
      const next = prefix ? `${prefix}.${k}` : k;
      collectConditionPaths(v, next, s);
    }
    return s;
  }

  if (prefix) s.add(prefix);
  return s;
}

function readRuleRankMeta(row: Pick<RuleRow, "if_json" | "positive_count" | "negative_count" | "rule_slots">): RuleRankMeta {
  const evidence = Number(row.positive_count ?? 0) - Number(row.negative_count ?? 0);
  const slots = row.rule_slots ?? {};
  const { priority, weight } = resolveToolRuleRankControls(slots);

  const conditionPaths = Array.from(collectConditionPaths(row.if_json)).sort();
  const specificity = conditionPaths.length;

  // Winner ranking semantics (deterministic):
  // priority dominates > weighted evidence > condition specificity.
  const score = priority * 1000 + evidence * 100 * weight + specificity;

  return {
    score,
    evidence_score: evidence,
    priority,
    weight,
    specificity,
    condition_paths: conditionPaths,
  };
}

function contextAgentId(ctx: any): string | null {
  const a = typeof ctx?.agent?.id === "string" ? ctx.agent.id.trim() : "";
  if (a) return a;
  const b = typeof ctx?.agent_id === "string" ? ctx.agent_id.trim() : "";
  return b || null;
}

function contextTeamId(ctx: any): string | null {
  const a = typeof ctx?.agent?.team_id === "string" ? ctx.agent.team_id.trim() : "";
  if (a) return a;
  const b = typeof ctx?.team_id === "string" ? ctx.team_id.trim() : "";
  return b || null;
}

function laneEnforcementStatus(
  ctxAgentId: string | null,
  ctxTeamId: string | null,
): { applied: boolean; reason: string } {
  if (!ctxAgentId && !ctxTeamId) {
    return { applied: true, reason: "missing_agent_context_fail_closed" };
  }
  if (ctxAgentId && ctxTeamId) {
    return { applied: true, reason: "enforced_agent_team" };
  }
  if (ctxAgentId) {
    return { applied: true, reason: "enforced_agent_only" };
  }
  return { applied: true, reason: "enforced_team_only" };
}

function scopeRuleMatchesContext(row: Pick<RuleRow, "rule_scope" | "target_agent_id" | "target_team_id">, ctx: any): boolean {
  const scope = row.rule_scope ?? "global";
  if (scope === "global") return true;
  const agentId = contextAgentId(ctx);
  const teamId = contextTeamId(ctx);
  if (scope === "agent") {
    if (!row.target_agent_id) return false;
    return !!agentId && agentId === row.target_agent_id;
  }
  if (scope === "team") {
    if (!row.target_team_id) return false;
    return !!teamId && teamId === row.target_team_id;
  }
  return false;
}

function laneRuleMatchesContext(
  row: Pick<RuleRow, "rule_memory_lane" | "rule_owner_agent_id" | "rule_owner_team_id">,
  ctxAgentId: string | null,
  ctxTeamId: string | null,
  enforceLane: boolean,
): { visible: boolean; unowned_private_detected: boolean } {
  if (!enforceLane) return { visible: true, unowned_private_detected: false };

  const ownerAgent = row.rule_owner_agent_id;
  const ownerTeam = row.rule_owner_team_id;
  if (memoryNodeVisible({
    memory_lane: row.rule_memory_lane,
    owner_agent_id: ownerAgent,
    owner_team_id: ownerTeam,
  }, ctxAgentId, ctxTeamId)) {
    return { visible: true, unowned_private_detected: false };
  }

  // Ownerless private rows are non-visible under strict lane enforcement.
  if (!ownerAgent && !ownerTeam) {
    return { visible: false, unowned_private_detected: true };
  }

  return { visible: false, unowned_private_detected: false };
}

function buildConflictExplain(
  conflicts: Array<{ path: string; winner_rule_node_id: string }>,
  sources: Array<{ rule_node_id: string; touched_paths: string[] }>,
  rankByRule: Map<string, RuleRankMeta>,
) {
  const out: Array<{
    path: string;
    winner: {
      rule_node_id: string;
      score: number | null;
      priority: number | null;
      weight: number | null;
      evidence_score: number | null;
      specificity: number | null;
    };
    losers: Array<{ rule_node_id: string; score: number | null }>;
    reason: string;
  }> = [];

  for (const c of conflicts) {
    const contributors = sources
      .filter((s) => Array.isArray(s.touched_paths) && s.touched_paths.includes(c.path))
      .map((s) => s.rule_node_id);
    const winnerRank = rankByRule.get(c.winner_rule_node_id);
    const losers = contributors
      .filter((id) => id !== c.winner_rule_node_id)
      .map((id) => ({ rule_node_id: id, score: rankByRule.get(id)?.score ?? null }))
      .sort((a, b) => Number(b.score ?? -Infinity) - Number(a.score ?? -Infinity))
      .slice(0, 5);

    out.push({
      path: c.path,
      winner: {
        rule_node_id: c.winner_rule_node_id,
        score: winnerRank?.score ?? null,
        priority: winnerRank?.priority ?? null,
        weight: winnerRank?.weight ?? null,
        evidence_score: winnerRank?.evidence_score ?? null,
        specificity: winnerRank?.specificity ?? null,
      },
      losers,
      reason: "higher rank wins (priority > evidence*weight > condition_specificity)",
    });
    if (out.length >= 50) break;
  }

  return out;
}

async function loadRuleRows(
  scope: string,
  limit: number,
  liteWriteStore: Pick<LiteWriteStore, "listRuleCandidates"> | null | undefined,
): Promise<RuleRow[]> {
  if (liteWriteStore) {
    return liteWriteStore.listRuleCandidates({
      scope,
      limit,
      states: ["shadow", "active"],
    });
  }
  throw new Error("rules evaluation requires liteWriteStore");
}

type MatchedRule = {
  row: RuleRow;
  rank: RuleRankMeta;
  thenPatch: PolicyPatch;
  provenanceSource: ToolRuleEvaluationSource | null;
};

type RuleMatches = {
  active: MatchedRule[];
  shadow: MatchedRule[];
  ctxAgentId: string | null;
  ctxTeamId: string | null;
  laneStatus: { applied: boolean; reason: string };
  skippedInvalidThen: number;
  invalidThenSample: Array<{ rule_node_id: string; state: string; commit_id: string }>;
  filteredByScope: number;
  filteredByLane: number;
  filteredByCondition: number;
  unownedPrivateDetected: number;
};

function matchRuleRows(
  rows: RuleRow[],
  context: any,
  includeShadow: boolean,
  collectProvenance = false,
): RuleMatches {
  const ctxAgentId = contextAgentId(context);
  const ctxTeamId = contextTeamId(context);
  const laneStatus = laneEnforcementStatus(ctxAgentId, ctxTeamId);
  const active: MatchedRule[] = [];
  const shadow: MatchedRule[] = [];
  const invalidThenSample: RuleMatches["invalidThenSample"] = [];
  let skippedInvalidThen = 0;
  let filteredByScope = 0;
  let filteredByLane = 0;
  let filteredByCondition = 0;
  let unownedPrivateDetected = 0;

  for (const row of rows) {
    if (!scopeRuleMatchesContext(row, context)) {
      filteredByScope += 1;
      continue;
    }
    const laneDecision = laneRuleMatchesContext(
      row,
      ctxAgentId,
      ctxTeamId,
      laneStatus.applied,
    );
    if (laneDecision.unowned_private_detected) unownedPrivateDetected += 1;
    if (!laneDecision.visible) {
      filteredByLane += 1;
      continue;
    }
    if (!ruleMatchesContext(row.if_json, row.exceptions_json, context)) {
      filteredByCondition += 1;
      continue;
    }

    let thenPatch: PolicyPatch;
    try {
      thenPatch = parsePolicyPatch(row.then_json);
    } catch {
      skippedInvalidThen += 1;
      if (invalidThenSample.length < 5) {
        invalidThenSample.push({
          rule_node_id: row.rule_node_id,
          state: row.state,
          commit_id: row.rule_commit_id,
        });
      }
      continue;
    }

    const matched = {
      row,
      rank: readRuleRankMeta(row),
      thenPatch,
      provenanceSource: collectProvenance ? buildToolRuleEvaluationSource(row) : null,
    };
    if (row.state === "active") active.push(matched);
    else if (row.state === "shadow" && includeShadow) shadow.push(matched);
  }

  return {
    active,
    shadow,
    ctxAgentId,
    ctxTeamId,
    laneStatus,
    skippedInvalidThen,
    invalidThenSample,
    filteredByScope,
    filteredByLane,
    filteredByCondition,
    unownedPrivateDetected,
  };
}

function matchedRuleDto({ row, rank, thenPatch }: MatchedRule) {
  return {
    rule_node_id: row.rule_node_id,
    state: row.state,
    rule_scope: row.rule_scope,
    target_agent_id: row.target_agent_id,
    target_team_id: row.target_team_id,
    summary: row.rule_summary,
    if_json: row.if_json,
    then_json: thenPatch,
    exceptions_json: row.exceptions_json,
    stats: { positive: row.positive_count, negative: row.negative_count },
    rank: {
      score: rank.score,
      evidence_score: rank.evidence_score,
      priority: rank.priority,
      weight: rank.weight,
      specificity: rank.specificity,
    },
    match_detail: {
      condition_paths: rank.condition_paths,
      condition_path_count: rank.condition_paths.length,
    },
    commit_id: row.rule_commit_id,
  };
}

function compileRuleState(rules: MatchedRule[], state: "active" | "shadow") {
  const applied = buildAppliedPolicy(rules
    .slice()
    .sort((a, b) => a.rank.score - b.rank.score
      || String(a.row.rule_node_id).localeCompare(String(b.row.rule_node_id)))
    .map((rule) => ({
      rule_node_id: rule.row.rule_node_id,
      state,
      commit_id: rule.row.rule_commit_id,
      then_patch: rule.thenPatch,
    })));
  const tool = computeEffectiveToolPolicy(rules.map(({ row, rank, thenPatch }) => ({
    rule_node_id: row.rule_node_id,
    score: rank.score,
    evidence_score: rank.evidence_score,
    priority: rank.priority,
    weight: rank.weight,
    specificity: rank.specificity,
    tool: thenPatch.tool ?? null,
  })));
  (applied.policy as any).tool = tool.tool;

  const rankByRule = new Map(rules.map(({ row, rank }) => [row.rule_node_id, rank]));
  const sources = applied.sources.map((source) => {
    const rank = rankByRule.get(source.rule_node_id);
    return {
      ...source,
      rank: rank ? {
        score: rank.score,
        evidence_score: rank.evidence_score,
        priority: rank.priority,
        weight: rank.weight,
        specificity: rank.specificity,
      } : null,
    };
  });
  return {
    policy: applied.policy,
    sources,
    conflicts: applied.conflicts,
    conflictExplain: buildConflictExplain(applied.conflicts, sources, rankByRule),
    toolExplain: tool.explain,
  };
}

function agentVisibilitySummary(matches: RuleMatches, scanned: number) {
  return {
    agent: { id: matches.ctxAgentId, team_id: matches.ctxTeamId },
    rule_scope: {
      scanned,
      filtered_by_scope: matches.filteredByScope,
      filtered_by_lane: matches.filteredByLane,
      filtered_by_condition: matches.filteredByCondition,
      skipped_invalid_then: matches.skippedInvalidThen,
      matched_active: matches.active.length,
      matched_shadow: matches.shadow.length,
    },
    lane: {
      applied: matches.laneStatus.applied,
      reason: matches.laneStatus.reason,
      unowned_private_visible: 0,
      unowned_private_detected: matches.unownedPrivateDetected,
    },
  };
}

function appliedSurface(
  active: ReturnType<typeof compileRuleState>,
  shadow: ReturnType<typeof compileRuleState>,
  includeShadow: boolean,
) {
  return {
    policy: active.policy,
    sources: active.sources,
    conflicts: active.conflicts,
    conflict_explain: active.conflictExplain,
    tool_explain: active.toolExplain,
    ...(includeShadow ? {
      shadow_policy: shadow.policy,
      shadow_sources: shadow.sources,
      shadow_conflicts: shadow.conflicts,
      shadow_conflict_explain: shadow.conflictExplain,
      shadow_tool_explain: shadow.toolExplain,
    } : {}),
  };
}

export async function evaluateRules(
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: EvaluateRulesOptions = {},
) {
  const parsed = RulesEvaluateRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const rows = await loadRuleRows(tenancy.scope_key, parsed.limit, opts.liteWriteStore);
  const matches = matchRuleRows(rows, parsed.context, parsed.include_shadow);
  const active = matches.active.map(matchedRuleDto);
  const shadow = matches.shadow.map(matchedRuleDto);
  const score = (entry: ReturnType<typeof matchedRuleDto>) => Number(entry.rank.score ?? 0);
  active.sort((a, b) => score(b) - score(a)
    || String(a.rule_node_id).localeCompare(String(b.rule_node_id)));
  shadow.sort((a, b) => score(b) - score(a)
    || String(a.rule_node_id).localeCompare(String(b.rule_node_id)));
  const compiledActive = compileRuleState(matches.active, "active");
  const compiledShadow = compileRuleState(matches.shadow, "shadow");

  const response = {
    scope: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    considered: rows.length,
    matched: active.length + shadow.length,
    skipped_invalid_then: matches.skippedInvalidThen,
    invalid_then_sample: matches.invalidThenSample,
    active,
    shadow,
    agent_visibility_summary: agentVisibilitySummary(matches, rows.length),
    applied: appliedSurface(compiledActive, compiledShadow, parsed.include_shadow),
  };
  return { ...response, evaluation_summary: buildRulesEvaluationSummary(response) };
}

// Applied-only variant for tool selector / planner injection: avoids returning full match DTOs.
export async function evaluateRulesAppliedOnly(
  params: { scope: string; tenant_id?: string; context: any; include_shadow: boolean; limit: number; default_tenant_id?: string },
  opts: EvaluateRulesOptions = {},
) {
  const tenancy = resolveTenantScope(
    { scope: params.scope, tenant_id: params.tenant_id },
    { defaultScope: params.scope, defaultTenantId: params.default_tenant_id ?? "default" },
  );
  const rows = await loadRuleRows(tenancy.scope_key, params.limit, opts.liteWriteStore);
  const matches = matchRuleRows(rows, params.context, params.include_shadow, true);
  const compiledActive = compileRuleState(matches.active, "active");
  const compiledShadow = compileRuleState(matches.shadow, "shadow");

  return {
    scope: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    considered: rows.length,
    matched: matches.active.length + matches.shadow.length,
    skipped_invalid_then: matches.skippedInvalidThen,
    invalid_then_sample: matches.invalidThenSample,
    agent_visibility_summary: agentVisibilitySummary(matches, rows.length),
    applied: appliedSurface(compiledActive, compiledShadow, params.include_shadow),
    rule_evaluation_sources: {
      active_sources: matches.active.map((rule) => rule.provenanceSource!),
      shadow_sources: matches.shadow.map((rule) => rule.provenanceSource!),
    },
  };
}
