import { randomUUID } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { badRequest } from "../util/http.js";
import { normalizeText } from "../util/normalize.js";
import { redactPII } from "../util/redaction.js";
import { RuleFeedbackRequest } from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

type FeedbackOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  liteWriteStore?: Pick<
    LiteWriteStore,
    "resolveNode" | "latestCommit" | "insertCommit" | "insertRuleFeedback" | "updateRuleFeedbackAggregates" | "getRuleDef"
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

  const parent = await liteWriteStore.latestCommit(scope);
  const parentHash = parent?.commit_hash ?? "";
  const parentId = parent?.id ?? null;

  const feedbackId = randomUUID();
  const diff = {
    feedback: [{ id: feedbackId, rule_node_id: parsed.rule_node_id, outcome: parsed.outcome, run_id: parsed.run_id ?? null }],
  };
  const diffSha = sha256Hex(stableStringify(diff));
  const commitHash = sha256Hex(
    stableStringify({
      parentHash,
      inputSha,
      diffSha,
      scope,
      actor,
      kind: "rule_feedback",
    }),
  );
  const commit_id = await liteWriteStore.insertCommit({
    scope,
    parentCommitId: parentId,
    inputSha256: inputSha,
    diffJson: JSON.stringify(diff),
    actor,
    modelVersion: null,
    promptVersion: null,
    commitHash,
  });

  await liteWriteStore.insertRuleFeedback({
    id: feedbackId,
    scope,
    ruleNodeId: parsed.rule_node_id,
    runId: parsed.run_id ?? null,
    outcome: parsed.outcome,
    note: note ?? null,
    source: "rule_feedback",
    decisionId: null,
    commitId: commit_id,
  });


  await liteWriteStore.updateRuleFeedbackAggregates({
    scope,
    outcome: parsed.outcome,
    ruleNodeIds: [parsed.rule_node_id],
  });

  return { tenant_id: tenancy.tenant_id, scope: tenancy.scope, commit_id, commit_hash: commitHash, feedback_id: feedbackId };
}
