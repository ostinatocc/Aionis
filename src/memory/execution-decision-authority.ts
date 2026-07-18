import stableStringify from "fast-json-stable-stringify";

import type {
  LiteExecutionDecisionRow,
  LiteWriteStore,
} from "../store/lite-write-store.js";
import {
  materializeAppliedAuthorityRow,
  normalizeAppliedAuthorityRow,
  type CanonicalAuthorityMutationVerificationV2,
  type CanonicalAuthorityTableMutationV2,
} from "../store/write-commit-authority.js";
import { sha256Hex } from "../util/crypto.js";
import {
  runAppliedAuthorityMutationV2,
} from "./applied-authority-mutation.js";
import { SELF_COMMIT_REFERENCE } from "./write-serialization.js";

export type InitialExecutionDecisionWrite = Omit<
  Parameters<LiteWriteStore["insertExecutionDecision"]>[0],
  "createdAt"
> & Readonly<{
  createdAt: string;
}>;

export type ExecutionDecisionAuthorityCommitReceipt = Readonly<{
  commit_id: string;
  commit_hash: string;
  digest_version: 2;
  revision: number;
}>;

export type PersistedExecutionDecisionAuthority = Readonly<{
  row: LiteExecutionDecisionRow;
  authority_commit: ExecutionDecisionAuthorityCommitReceipt;
}>;

function canonicalJson<T>(value: T, label: string): T {
  const encoded = stableStringify(value);
  if (typeof encoded !== "string") {
    throw new Error(`execution_decision_${label}_not_json_serializable`);
  }
  return JSON.parse(encoded) as T;
}

export function executionDecisionAuthorityRow(
  row: LiteExecutionDecisionRow,
): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    decision_kind: row.decision_kind,
    run_id: row.run_id,
    selected_tool: row.selected_tool,
    candidates_json: canonicalJson(row.candidates_json, "candidates"),
    context_sha256: row.context_sha256,
    policy_sha256: row.policy_sha256,
    source_rule_ids_json: canonicalJson(row.source_rule_ids, "source_rule_ids"),
    metadata_json: canonicalJson(row.metadata_json, "metadata"),
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
}

function requestedExecutionDecisionRow(
  decision: InitialExecutionDecisionWrite,
): Record<string, unknown> {
  return {
    id: decision.id,
    scope: decision.scope,
    decision_kind: decision.decisionKind,
    run_id: decision.runId,
    selected_tool: decision.selectedTool,
    candidates_json: canonicalJson(decision.candidatesJson, "candidates"),
    context_sha256: decision.contextSha256,
    policy_sha256: decision.policySha256,
    source_rule_ids_json: canonicalJson(decision.sourceRuleIds, "source_rule_ids"),
    metadata_json: canonicalJson(decision.metadataJson, "metadata"),
    commit_id: SELF_COMMIT_REFERENCE,
    created_at: decision.createdAt,
  };
}

/**
 * Binds the commit input hash to the complete requested initial receipt while
 * deliberately excluding the self-referential authority commit id.
 */
export function executionDecisionAuthorityInputSha256(
  decision: InitialExecutionDecisionWrite,
): string {
  return sha256Hex(stableStringify({
    contract: "aionis_execution_decision_initial_receipt_v1",
    decision: {
      ...requestedExecutionDecisionRow(decision),
      commit_id: null,
    },
  }));
}

function assertInitialDecision(decision: InitialExecutionDecisionWrite, actor: string): void {
  if (decision.commitId !== null) {
    throw new Error("execution_decision_initial_commit_id_must_be_null");
  }
  if (!decision.id.trim()) throw new Error("execution_decision_id_required");
  if (!decision.scope.trim()) throw new Error("execution_decision_scope_required");
  if (!actor.trim()) throw new Error("execution_decision_actor_required");
  const createdAt = new Date(decision.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decision.createdAt) {
    throw new Error("execution_decision_created_at_invalid");
  }
}

/**
 * Persists one initial execution-decision receipt as its own v2 authority
 * revision. A reused id is always a collision, never an upsert or a no-op.
 */
export async function persistInitialExecutionDecisionAuthority(args: {
  store: LiteWriteStore;
  decision: InitialExecutionDecisionWrite;
  actor: string;
  expectedHeadRevision?: number;
  expectedHeadCommitId?: string | null;
}): Promise<PersistedExecutionDecisionAuthority> {
  assertInitialDecision(args.decision, args.actor);
  const after = requestedExecutionDecisionRow(args.decision);
  const mutation: CanonicalAuthorityTableMutationV2 = {
    table: "lite_memory_execution_decisions",
    identity: { scope: args.decision.scope, id: args.decision.id },
    operation: "insert",
    before: null,
    requested: {
      contract: "aionis_execution_decision_initial_receipt_v1",
      decision_id: args.decision.id,
    },
    after,
  };

  const applied = await runAppliedAuthorityMutationV2({
    store: args.store,
    scope: args.decision.scope,
    inputSha256: executionDecisionAuthorityInputSha256(args.decision),
    actor: args.actor,
    ...(args.expectedHeadRevision !== undefined
      ? { expectedHeadRevision: args.expectedHeadRevision }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId")
      ? { expectedHeadCommitId: args.expectedHeadCommitId ?? null }
      : {}),
    async plan() {
      const collision = await args.store.getExecutionDecision({
        scope: args.decision.scope,
        id: args.decision.id,
      });
      if (collision) {
        throw new Error(`execution_decision_initial_id_collision:${args.decision.id}`);
      }
      return {
        status: "mutate" as const,
        authorityKind: "execution_decision_initial_receipt",
        mutations: [mutation],
        async apply({ commitId }) {
          const materialized = materializeAppliedAuthorityRow(
            "lite_memory_execution_decisions",
            after,
            commitId,
          );
          await args.store.insertExecutionDecision({
            id: String(materialized.id),
            scope: String(materialized.scope),
            decisionKind: "tools_select",
            runId: typeof materialized.run_id === "string" ? materialized.run_id : null,
            selectedTool: typeof materialized.selected_tool === "string"
              ? materialized.selected_tool
              : null,
            candidatesJson: materialized.candidates_json as unknown[],
            contextSha256: String(materialized.context_sha256),
            policySha256: String(materialized.policy_sha256),
            sourceRuleIds: materialized.source_rule_ids_json as string[],
            metadataJson: materialized.metadata_json as Record<string, unknown>,
            commitId,
            createdAt: String(materialized.created_at),
          });
          const row = await args.store.getExecutionDecision({
            scope: args.decision.scope,
            id: args.decision.id,
          });
          if (!row) throw new Error("execution_decision_initial_read_after_missing");
          return row;
        },
        async verify({ commitId }) {
          const row = await args.store.getExecutionDecision({
            scope: args.decision.scope,
            id: args.decision.id,
          });
          if (!row) throw new Error("execution_decision_initial_verify_missing");
          const verification: CanonicalAuthorityMutationVerificationV2 = {
            table: "lite_memory_execution_decisions",
            identity: { scope: args.decision.scope, id: args.decision.id },
            after: normalizeAppliedAuthorityRow(
              "lite_memory_execution_decisions",
              executionDecisionAuthorityRow(row),
              commitId,
            ),
          };
          return [verification];
        },
      };
    },
  });
  if (applied.status !== "applied") {
    throw new Error("execution_decision_initial_authority_not_applied");
  }
  return {
    row: applied.value,
    authority_commit: {
      commit_id: applied.commitId,
      commit_hash: applied.commitHash,
      digest_version: 2,
      revision: applied.revision,
    },
  };
}
