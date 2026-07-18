import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { RuleStateUpdateRequest } from "./schemas.js";
import { badRequest } from "../util/http.js";
import { parsePolicyPatch } from "./rule-policy.js";
import { resolveTenantScope } from "./tenant.js";
import {
  runAppliedAuthorityMutationV2,
  type AppliedAuthorityMutationCoordinatorStore,
} from "./applied-authority-mutation.js";
import {
  ruleDefAuthorityRow,
  ruleDefBusinessState,
  type RuleDefAuthorityRow,
} from "./rule-authority-mutation.js";
import { normalizeSelfCommitReferences } from "../store/write-commit-authority.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

function isPlainObject(v: any): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

type UpdateRuleStateOptions = {
  liteWriteStore?: AppliedAuthorityMutationCoordinatorStore & Pick<
    LiteWriteStore,
    "resolveNode" | "getRuleDef" | "upsertRuleState"
  > | null;
};

function deriveRuleDefFromSlots(slots: Record<string, unknown> | null | undefined) {
  const raw = slots ?? {};
  const if_json = isPlainObject(raw.if) ? raw.if : {};
  const then_json = isPlainObject(raw.then) ? raw.then : {};
  const exceptions_json = Array.isArray(raw.exceptions) ? raw.exceptions : [];
  const scopeRaw = typeof raw.rule_scope === "string" ? String(raw.rule_scope).trim().toLowerCase() : "";
  const rule_scope: "global" | "team" | "agent" = scopeRaw === "team" || scopeRaw === "agent" ? scopeRaw : "global";
  const target_agent_id =
    typeof raw.target_agent_id === "string" && String(raw.target_agent_id).trim().length > 0
      ? String(raw.target_agent_id).trim()
      : null;
  const target_team_id =
    typeof raw.target_team_id === "string" && String(raw.target_team_id).trim().length > 0
      ? String(raw.target_team_id).trim()
      : null;
  return {
    if_json,
    then_json,
    exceptions_json,
    rule_scope,
    target_agent_id,
    target_team_id,
  };
}

export async function updateRuleState(
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: UpdateRuleStateOptions = {},
) {
  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) throw new Error("lite_write_store_required");

  const parsed = RuleStateUpdateRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const actor = parsed.actor ?? "system";
  const inputSha = parsed.input_sha256 ?? sha256Hex(parsed.input_text!);

  const authority = await runAppliedAuthorityMutationV2<void>({
    store: liteWriteStore,
    scope,
    inputSha256: inputSha,
    actor,
    plan: async ({ appliedAt }) => {
      const node = await liteWriteStore.resolveNode({
        scope,
        id: parsed.rule_node_id,
        type: "rule",
        consumerAgentId: parsed.actor ?? "system",
        consumerTeamId: null,
      });
      if (!node) {
        badRequest("rule_not_found_in_scope", "rule_node_id was not found in this scope", {
          rule_node_id: parsed.rule_node_id,
          scope: tenancy.scope,
          tenant_id: tenancy.tenant_id,
        });
      }
      const existing = await liteWriteStore.getRuleDef(scope, parsed.rule_node_id);
      let if_json = existing?.if_json ?? null;
      let then_json = existing?.then_json ?? null;
      let exceptions_json = existing?.exceptions_json ?? null;
      let rule_scope = existing?.rule_scope ?? "global";
      let target_agent_id = existing?.target_agent_id ?? null;
      let target_team_id = existing?.target_team_id ?? null;

      if (!existing) {
        const derived = deriveRuleDefFromSlots(node.slots);
        if_json = derived.if_json;
        then_json = derived.then_json;
        exceptions_json = derived.exceptions_json;
        rule_scope = derived.rule_scope;
        target_agent_id = derived.target_agent_id;
        target_team_id = derived.target_team_id;
      }

      if (parsed.state === "shadow" || parsed.state === "active") {
        if (node.memory_lane === "private" && !node.owner_agent_id && !node.owner_team_id) {
          badRequest("invalid_private_rule_owner", "private rule requires owner_agent_id or owner_team_id", {
            rule_node_id: parsed.rule_node_id,
            memory_lane: node.memory_lane,
          });
        }
        if (!isPlainObject(if_json)) {
          badRequest("invalid_rule_if_json", "rule if_json must be an object");
        }
        if (!Array.isArray(exceptions_json)) {
          badRequest("invalid_rule_exceptions_json", "rule exceptions_json must be an array");
        }
        try {
          parsePolicyPatch(then_json);
        } catch (e: any) {
          badRequest("invalid_rule_then_json", "rule then_json does not match the allowed policy schema", {
            message: String(e?.message ?? e),
          });
        }
        if (rule_scope === "agent" && !target_agent_id) {
          badRequest("invalid_rule_scope_target", "agent-scoped rule requires target_agent_id");
        }
        if (rule_scope === "team" && !target_team_id) {
          badRequest("invalid_rule_scope_target", "team-scoped rule requires target_team_id");
        }
      }

      const desired: RuleDefAuthorityRow = {
        scope,
        rule_node_id: parsed.rule_node_id,
        state: parsed.state,
        if_json: isPlainObject(if_json) ? if_json : {},
        then_json: isPlainObject(then_json) ? then_json : {},
        exceptions_json: Array.isArray(exceptions_json) ? exceptions_json : [],
        rule_scope,
        target_agent_id,
        target_team_id,
        positive_count: existing?.positive_count ?? 0,
        negative_count: existing?.negative_count ?? 0,
        commit_id: "$self",
        created_at: existing?.created_at ?? appliedAt,
        updated_at: appliedAt,
      };
      const before = existing ? ruleDefAuthorityRow(existing) : null;
      const after = ruleDefAuthorityRow(desired);
      if (before && stableStringify(ruleDefBusinessState(before))
        === stableStringify(ruleDefBusinessState(after))) {
        return { status: "no_op", value: undefined };
      }

      const identity = { scope, rule_node_id: parsed.rule_node_id };
      return {
        status: "mutate",
        authorityKind: "rule_state_change",
        mutations: [{
          table: "lite_memory_rule_defs",
          identity,
          operation: existing ? "update" : "insert",
          before,
          requested: after,
          after,
        }],
        apply: async ({ commitId }) => {
          await liteWriteStore.upsertRuleState({
            scope,
            ruleNodeId: parsed.rule_node_id,
            state: parsed.state,
            ifJson: desired.if_json,
            thenJson: desired.then_json,
            exceptionsJson: desired.exceptions_json,
            ruleScope: desired.rule_scope,
            targetAgentId: desired.target_agent_id,
            targetTeamId: desired.target_team_id,
            positiveCount: desired.positive_count,
            negativeCount: desired.negative_count,
            commitId,
            createdAt: desired.created_at,
            updatedAt: desired.updated_at,
          });
        },
        verify: async ({ commitId }) => {
          const actual = await liteWriteStore.getRuleDef(scope, parsed.rule_node_id);
          return actual ? [{
            table: "lite_memory_rule_defs",
            identity,
            after: normalizeSelfCommitReferences(ruleDefAuthorityRow(actual), commitId),
          }] : [];
        },
      };
    },
  });

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    commit_id: authority.commitId,
    commit_hash: authority.commitHash,
  };
}
