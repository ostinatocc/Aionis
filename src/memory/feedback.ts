import { randomUUID } from "node:crypto";
import { sha256Hex } from "../util/crypto.js";
import { badRequest } from "../util/http.js";
import { normalizeText } from "../util/normalize.js";
import { redactPII } from "../util/redaction.js";
import { RuleFeedbackRequest } from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import {
  runAppliedAuthorityMutationV2,
  type AppliedAuthorityMutationCoordinatorStore,
} from "./applied-authority-mutation.js";
import {
  ruleDefAuthorityRow,
  ruleFeedbackAuthorityRow,
} from "./rule-authority-mutation.js";
import { normalizeSelfCommitReferences } from "../store/write-commit-authority.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

type FeedbackOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  liteWriteStore?: AppliedAuthorityMutationCoordinatorStore & Pick<
    LiteWriteStore,
    | "resolveNode"
    | "insertRuleFeedback"
    | "getRuleFeedback"
    | "updateRuleFeedbackAggregates"
    | "getRuleDef"
  > | null;
};

export async function ruleFeedback(
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: FeedbackOptions,
) {
  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) throw new Error("lite_write_store_required");

  const parsed = RuleFeedbackRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const actor = parsed.actor ?? "system";

  const inputText = parsed.input_text ? normalizeText(parsed.input_text, opts.maxTextLen) : undefined;
  const redactedInput = opts.piiRedaction && inputText ? redactPII(inputText).text : inputText;
  const inputSha = parsed.input_sha256 ?? sha256Hex(redactedInput!);

  const noteNorm = parsed.note ? normalizeText(parsed.note, opts.maxTextLen) : undefined;
  const note = opts.piiRedaction && noteNorm ? redactPII(noteNorm).text : noteNorm;

  const feedbackId = randomUUID();
  const authority = await runAppliedAuthorityMutationV2<string>({
    store: liteWriteStore,
    scope,
    inputSha256: inputSha,
    actor,
    plan: async ({ appliedAt }) => {
      const node = await liteWriteStore.resolveNode({
        scope,
        id: parsed.rule_node_id,
        type: "rule",
      });
      if (!node) {
        badRequest("rule_not_found_in_scope", "rule_node_id was not found in this scope", {
          rule_node_id: parsed.rule_node_id,
          scope: tenancy.scope,
          tenant_id: tenancy.tenant_id,
        });
      }
      const collision = await liteWriteStore.getRuleFeedback(scope, feedbackId);
      if (collision) throw new Error("rule_feedback_id_collision");
      const rule = await liteWriteStore.getRuleDef(scope, parsed.rule_node_id);
      if (!rule) {
        badRequest("rule_definition_not_found", "rule_node_id has no authoritative rule definition", {
          rule_node_id: parsed.rule_node_id,
          scope: tenancy.scope,
          tenant_id: tenancy.tenant_id,
        });
      }

      const feedbackIdentity = { scope, id: feedbackId };
      const feedbackAfter = {
        id: feedbackId,
        scope,
        rule_node_id: parsed.rule_node_id,
        run_id: parsed.run_id ?? null,
        outcome: parsed.outcome,
        note: note ?? null,
        source: "rule_feedback" as const,
        decision_id: null,
        commit_id: "$self",
        created_at: appliedAt,
      };
      const ruleIdentity = { scope, rule_node_id: parsed.rule_node_id };
      const ruleBefore = ruleDefAuthorityRow(rule);
      const ruleAfter = {
        ...ruleBefore,
        positive_count: rule.positive_count + (parsed.outcome === "positive" ? 1 : 0),
        negative_count: rule.negative_count + (parsed.outcome === "negative" ? 1 : 0),
        commit_id: "$self",
        updated_at: appliedAt,
      };

      return {
        status: "mutate",
        authorityKind: "rule_feedback",
        mutations: [
          {
            table: "lite_memory_rule_defs",
            identity: ruleIdentity,
            operation: "update",
            before: ruleBefore,
            requested: ruleAfter,
            after: ruleAfter,
          },
          {
            table: "lite_memory_rule_feedback",
            identity: feedbackIdentity,
            operation: "insert",
            before: null,
            requested: feedbackAfter,
            after: feedbackAfter,
          },
        ],
        apply: async ({ commitId }) => {
          await liteWriteStore.insertRuleFeedback({
            id: feedbackId,
            scope,
            ruleNodeId: parsed.rule_node_id,
            runId: parsed.run_id ?? null,
            outcome: parsed.outcome,
            note: note ?? null,
            source: "rule_feedback",
            decisionId: null,
            commitId,
            createdAt: appliedAt,
          });
          await liteWriteStore.updateRuleFeedbackAggregates({
            scope,
            outcome: parsed.outcome,
            ruleNodeIds: [parsed.rule_node_id],
            commitId,
            updatedAt: appliedAt,
          });
          return feedbackId;
        },
        verify: async ({ commitId }) => {
          const actualRule = await liteWriteStore.getRuleDef(scope, parsed.rule_node_id);
          const actualFeedback = await liteWriteStore.getRuleFeedback(scope, feedbackId);
          if (!actualRule || !actualFeedback) return [];
          return [
            {
              table: "lite_memory_rule_defs",
              identity: ruleIdentity,
              after: normalizeSelfCommitReferences(ruleDefAuthorityRow(actualRule), commitId),
            },
            {
              table: "lite_memory_rule_feedback",
              identity: feedbackIdentity,
              after: normalizeSelfCommitReferences(ruleFeedbackAuthorityRow(actualFeedback), commitId),
            },
          ];
        },
      };
    },
  });

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    commit_id: authority.commitId,
    commit_hash: authority.commitHash,
    feedback_id: feedbackId,
  };
}
