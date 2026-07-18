import stableStringify from "fast-json-stable-stringify";

import type {
  LiteRuleDefSyncRow,
  LiteRuleFeedbackRow,
} from "../store/lite-write-store.js";

export type RuleDefAuthorityRow = Pick<
  LiteRuleDefSyncRow,
  | "rule_node_id"
  | "scope"
  | "state"
  | "if_json"
  | "then_json"
  | "exceptions_json"
  | "rule_scope"
  | "target_agent_id"
  | "target_team_id"
  | "positive_count"
  | "negative_count"
  | "commit_id"
  | "created_at"
  | "updated_at"
>;

function canonicalJson<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T;
}

export function ruleDefAuthorityRow(row: RuleDefAuthorityRow): Record<string, unknown> {
  return {
    rule_node_id: row.rule_node_id,
    scope: row.scope,
    state: row.state,
    if_json: canonicalJson(row.if_json),
    then_json: canonicalJson(row.then_json),
    exceptions_json: canonicalJson(row.exceptions_json),
    rule_scope: row.rule_scope,
    target_agent_id: row.target_agent_id,
    target_team_id: row.target_team_id,
    positive_count: row.positive_count,
    negative_count: row.negative_count,
    commit_id: row.commit_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function ruleFeedbackAuthorityRow(row: LiteRuleFeedbackRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    rule_node_id: row.rule_node_id,
    run_id: row.run_id,
    outcome: row.outcome,
    note: row.note,
    source: row.source,
    decision_id: row.decision_id,
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
}

export function ruleDefBusinessState(row: Record<string, unknown>): Record<string, unknown> {
  const { commit_id: _commitId, created_at: _createdAt, updated_at: _updatedAt, ...business } = row;
  return business;
}
