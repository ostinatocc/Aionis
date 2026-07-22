import {
  buildExecutionCapsuleV1,
} from "../continuation/capsule.js";
import {
  assertCanonicalUtcMillis,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type ExecutionCapsuleV1,
} from "../continuation/contract.js";
import { isContinuationRehydrationRefV1 } from "../continuation/rehydration-ref.js";
import type { ContinuationRuntimeV1Database } from "./continuation-runtime-v1-database.js";
import {
  ContinuationRuntimeV1CurrentServingProjectionCapacityError,
  ContinuationRuntimeV1MemoryHeadConflictError,
  type AppendMemoryRevisionV1Args,
  type AppendMemoryRevisionV1Result,
  type ContinuationRuntimeV1MemoryAuthority as Authority,
  type ContinuationRuntimeV1MemoryCanonicalObject as CanonicalObject,
  type ContinuationRuntimeV1MemoryLifecycle as Lifecycle,
  type CurrentServingMemoryProjectionRequestV1,
  type CurrentServingMemoryProjectionV1,
  type MemoryItemMutationV1,
  type MemoryScopeAuditV1,
  type MemoryScopeHeadV1,
} from "./continuation-runtime-v1-memory-contract.js";
import {
  continuationRuntimeV1MemoryCommitId,
  readVerifiedContinuationRuntimeV1MemoryCommit,
  type HistoricalMemoryCapsuleV1,
  type HistoricalMemoryItemV1,
  type VerifiedMemoryCommitV1,
} from "./continuation-runtime-v1-memory-history.js";
import {
  assertMemoryItemMutationSemantics,
  canonicalObject,
  capsuleRefKey,
  capsuleRowKey,
  exactKeys,
  profile,
  sha,
  text,
  time,
  verifyCapsule,
  verifyItem,
  verifyRelation,
  type CapsuleRow,
  type HeadRow,
  type ItemRow,
  type RelationRow,
} from "./continuation-runtime-v1-memory-row-verification.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

const LIFECYCLES = new Set<Lifecycle>(["active", "suppressed", "archived", "quarantined"]);
const AUTHORITIES = new Set<Authority>(["candidate", "verified", "authoritative"]);
const MEMORY_OPERATION_KINDS = new Set<string>([
  "record_observations", "authority_decision", "worker_completion",
]);
const MEMORY_APPEND_CONTEXTS = new WeakSet<object>();
const MEMORY_STORE_DATABASES = new WeakMap<object, ContinuationRuntimeV1Database>();
const MAX_CURRENT_SERVING_CONTINUITY_CAPSULES = 4_096;
const MAX_CURRENT_SERVING_LEARNING_REFS = 510;
const MAX_CURRENT_SERVING_PROJECTED_CAPSULE_ROWS =
  MAX_CURRENT_SERVING_CONTINUITY_CAPSULES
  + MAX_CURRENT_SERVING_LEARNING_REFS;
const CURRENT_ITEM_QUERY_CHUNK = 400;
const EXACT_CAPSULE_QUERY_CHUNK = 250;

export function assertContinuationRuntimeV1MemoryStore(
  value: unknown,
  database: ContinuationRuntimeV1Database,
): asserts value is ReturnType<typeof createContinuationRuntimeV1MemoryStore> {
  if (value === null || typeof value !== "object"
    || MEMORY_STORE_DATABASES.get(value) !== database) {
    throw new Error("continuation_runtime_v1_memory_store_invalid");
  }
}

function sortedUnique<T>(values: readonly T[], key: (value: T) => string, field: string): T[] {
  const out = [...values].sort((a, b) => compareCanonicalUtf8(key(a), key(b)));
  for (let index = 1; index < out.length; index += 1) {
    if (key(out[index - 1]!) === key(out[index]!)) {
      throw new Error(`continuation_runtime_v1_memory_duplicate_${field}`);
    }
  }
  return out;
}

function nextCommitTime(now: string, previous: string | null): string {
  assertCanonicalUtcMillis(now, "memory.commit_time");
  if (previous === null || now > previous) return now;
  const next = Date.parse(previous) + 1;
  if (!Number.isFinite(next)) throw new Error("continuation_runtime_v1_memory_commit_time_overflow");
  return new Date(next).toISOString();
}

function headBody(head: Omit<MemoryScopeHeadV1, "head_sha256">): CanonicalObject {
  return { schema_version: "memory_scope_head_v1", ...head };
}

export function createContinuationRuntimeV1MemoryStore(
  database: ContinuationRuntimeV1Database,
  options: Readonly<{ now?: () => string }> = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const readCommitSync = (
    tenantId: string,
    scope: string,
    revision: number,
    pending: ContinuationRuntimeV1OperationLineageV1 | null = null,
  ): VerifiedMemoryCommitV1 | null => readVerifiedContinuationRuntimeV1MemoryCommit(
    database,
    tenantId,
    scope,
    revision,
    pending,
  );
  const assertCommitRef = (
    tenantId: string,
    scope: string,
    revision: number,
    id: string,
    digest: string,
    pending: ContinuationRuntimeV1OperationLineageV1 | null = null,
  ): void => {
    const commit = readCommitSync(tenantId, scope, revision, pending);
    if (!commit || commit.commit_id !== id || commit.commit_sha256 !== digest) {
      throw new Error("continuation_runtime_v1_memory_corrupt:source_commit_ref");
    }
  };
  const readParentSync = (
    tenantId: string,
    scope: string,
    child: VerifiedMemoryCommitV1,
  ): VerifiedMemoryCommitV1 | null => {
    if (child.parent_revision === null) return null;
    const parent = readCommitSync(tenantId, scope, child.parent_revision);
    if (!parent || parent.commit_id !== child.parent_commit_id
      || parent.commit_sha256 !== child.parent_commit_sha256
      || parent.revision + 1 !== child.revision || parent.created_at >= child.created_at) {
      throw new Error("continuation_runtime_v1_memory_corrupt:commit_chain");
    }
    return parent;
  };
  const readHeadSync = (
    tenantId: string,
    scope: string,
    pending: ContinuationRuntimeV1OperationLineageV1 | null = null,
  ): MemoryScopeHeadV1 | null => {
    const row = database.db.prepare(
      `SELECT memory_head.tenant_id, memory_head.scope, memory_head.head_revision,
              memory_head.head_commit_id, memory_head.head_commit_sha256,
              memory_head.head_sha256, memory_head.source_operation_kind,
              memory_head.source_operation_id, memory_head.source_request_sha256,
              memory_head.updated_at
         FROM memory_scope_heads AS memory_head
        WHERE memory_head.tenant_id = ? AND memory_head.scope = ?`,
    ).get(tenantId, scope) as HeadRow | undefined;
    if (!row) return null;
    if (row.tenant_id !== tenantId || row.scope !== scope
      || !Number.isSafeInteger(row.head_revision) || (row.head_revision as number) < 1) {
      throw new Error("continuation_runtime_v1_memory_corrupt:head_identity");
    }
    text(row.head_commit_id, 256, "persisted_head_commit_id");
    sha(row.head_commit_sha256, "persisted_head_commit_sha256");
    sha(row.head_sha256, "persisted_head_sha256");
    if (typeof row.updated_at !== "string") {
      throw new Error("continuation_runtime_v1_memory_corrupt:head_updated_at_type");
    }
    time(row.updated_at, "persisted_head_updated_at");
    const commit = readCommitSync(tenantId, scope, row.head_revision as number, pending);
    if (!commit || commit.commit_id !== row.head_commit_id
      || commit.commit_sha256 !== row.head_commit_sha256
      || commit.created_at !== row.updated_at
      || commit.source_operation.operation_kind !== row.source_operation_kind
      || commit.source_operation.operation_id !== row.source_operation_id
      || commit.source_operation.request_sha256 !== row.source_request_sha256) {
      throw new Error("continuation_runtime_v1_memory_corrupt:head_commit_ref");
    }
    const sourceOperation = commit.source_operation;
    readParentSync(tenantId, scope, commit);
    const head: MemoryScopeHeadV1 = {
      tenant_id: tenantId,
      scope,
      head_revision: row.head_revision as number,
      head_commit_id: row.head_commit_id,
      head_commit_sha256: row.head_commit_sha256,
      head_sha256: row.head_sha256,
      source_operation: sourceOperation,
      updated_at: row.updated_at,
    };
    const { head_sha256: _, ...without } = head;
    if (canonicalContinuationSha256(headBody(without)) !== head.head_sha256) {
      throw new Error("continuation_runtime_v1_memory_corrupt:head_digest");
    }
    return head;
  };
  const auditScopeSync = (tenantId: string, scope: string): MemoryScopeAuditV1 => {
    const head = readHeadSync(tenantId, scope);
    if (head === null) return { head: null, verified_commit_count: 0 };
    let child = readCommitSync(tenantId, scope, head.head_revision);
    if (!child) throw new Error("continuation_runtime_v1_memory_corrupt:head_commit_missing");
    let verifiedCommitCount = 1;
    while (child.parent_revision !== null) {
      const parent = readParentSync(tenantId, scope, child);
      if (!parent) throw new Error("continuation_runtime_v1_memory_corrupt:commit_chain");
      child = parent;
      verifiedCommitCount += 1;
    }
    if (child.revision !== 1 || verifiedCommitCount !== head.head_revision) {
      throw new Error("continuation_runtime_v1_memory_corrupt:commit_chain_cardinality");
    }
    return { head, verified_commit_count: verifiedCommitCount };
  };

  const store = Object.freeze({
    async appendMemoryRevision(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      args: AppendMemoryRevisionV1Args,
    ): Promise<AppendMemoryRevisionV1Result> {
      exactKeys(args, ["expected_head_revision", "items", "relations", "capsules"], "append_args");
      const transactionIdentity = database.transaction.currentTransactionIdentity();
      if (transactionIdentity === null) {
        throw new Error("continuation_runtime_v1_memory_operation_transaction_required");
      }
      const operation = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        database,
      );
      if (operation.transactionIdentity !== transactionIdentity) {
        throw new Error("continuation_runtime_v1_memory_operation_context_mismatch");
      }
      if (!MEMORY_OPERATION_KINDS.has(operation.operationKind)) {
        throw new Error("continuation_runtime_v1_memory_operation_kind_forbidden");
      }
      const sourceOperation = continuationRuntimeV1OperationLineage(operation);
      if (MEMORY_APPEND_CONTEXTS.has(context)) {
        throw new Error("continuation_runtime_v1_memory_operation_context_already_used");
      }
      MEMORY_APPEND_CONTEXTS.add(context);
      const tenantId = operation.tenantId;
      const scope = operation.scope;
      text(tenantId, 256, "tenant_id");
      text(scope, 256, "scope");
      text(operation.operationId, 256, "operation_id");
      sha(operation.requestSha256, "operation_request_sha256");
      if (args.expected_head_revision !== null
        && (!Number.isSafeInteger(args.expected_head_revision) || args.expected_head_revision < 1)) {
        throw new Error("continuation_runtime_v1_memory_expected_head_invalid");
      }
      if (!Array.isArray(args.items) || !Array.isArray(args.relations) || !Array.isArray(args.capsules)) {
        throw new Error("continuation_runtime_v1_memory_mutation_arrays_required");
      }
      const mutationCount = args.items.length + args.relations.length + args.capsules.length;
      if (mutationCount === 0 && (
        args.expected_head_revision !== null
        || operation.operationKind !== "record_observations"
        || operation.actorKind !== "trusted_host"
      )) {
        throw new Error("continuation_runtime_v1_memory_empty_mutation");
      }
      {
        // The previous commit was authenticated when it became head. Verify the
        // current head and its direct parent here to keep append O(1);
        // auditScope is the explicit full immutable-chain verification path.
        const parent = readHeadSync(tenantId, scope);
        const actualRevision = parent?.head_revision ?? null;
        if (actualRevision !== args.expected_head_revision) {
          throw new ContinuationRuntimeV1MemoryHeadConflictError(args.expected_head_revision, actualRevision);
        }
        const revision = (actualRevision ?? 0) + 1;
        const createdAt = nextCommitTime(now(), parent?.updated_at ?? null);
        const commitId = continuationRuntimeV1MemoryCommitId({
          sourceOperation,
          revision,
          parentCommitSha256: parent?.head_commit_sha256 ?? null,
        });
        const items = sortedUnique(args.items, (item) => item.memory_id, "memory_id");
        const relations = sortedUnique(args.relations, (item) => item.relation_id, "relation_id");
        const capsuleInputs = sortedUnique(args.capsules, (item) => item.draft.capsule_id, "capsule_id");

        const preparedItems = new Map<string, { mutation: MemoryItemMutationV1; projectionJson: string; projectionSha: string; createdAt: string }>();
        for (const item of items) {
          exactKeys(item, ["memory_id", "memory_kind", "lifecycle", "authority", "hydrated",
            "projection", "rehydration_ref", "expires_at"], "item_mutation");
          text(item.memory_id, 256, "memory_id"); text(item.memory_kind, 128, "memory_kind");
          if (!LIFECYCLES.has(item.lifecycle) || !AUTHORITIES.has(item.authority)) {
            throw new Error("continuation_runtime_v1_memory_item_state_invalid");
          }
          if (item.rehydration_ref !== null
            && !isContinuationRehydrationRefV1(item.rehydration_ref)) {
            throw new Error("continuation_runtime_v1_memory_rehydration_ref_invalid");
          }
          time(item.expires_at, "item_expires_at");
          const existing = database.db.prepare(
            `SELECT memory_id, memory_kind, lifecycle, authority, hydrated, projection_sha256,
                    projection_json, rehydration_ref, source_commit_revision, source_commit_id,
                    source_commit_sha256, row_sha256, expires_at, created_at, updated_at
               FROM memory_items WHERE tenant_id = ? AND scope = ? AND memory_id = ?`,
          ).get(tenantId, scope, item.memory_id) as ItemRow | undefined;
          if (existing) {
            verifyItem(tenantId, scope, existing);
            assertCommitRef(tenantId, scope, existing.source_commit_revision,
              existing.source_commit_id, existing.source_commit_sha256);
          }
          assertMemoryItemMutationSemantics({
            item,
            existing,
            source_operation: sourceOperation,
          });
          const projectionJson = canonicalObject(item.projection, 262_144, "item_projection");
          preparedItems.set(item.memory_id, {
            mutation: item, projectionJson, projectionSha: canonicalContinuationSha256(item.projection),
            createdAt: existing?.created_at ?? createdAt,
          });
        }

        const currentItem = (memoryId: string): { projectionSha: string } => {
          const planned = preparedItems.get(memoryId);
          if (planned) return planned;
          const row = database.db.prepare(
            `SELECT memory_id, memory_kind, lifecycle, authority, hydrated, projection_sha256,
                    projection_json, rehydration_ref, source_commit_revision, source_commit_id,
                    source_commit_sha256, row_sha256, expires_at, created_at, updated_at
               FROM memory_items WHERE tenant_id = ? AND scope = ? AND memory_id = ?`,
          ).get(tenantId, scope, memoryId) as ItemRow | undefined;
          if (!row) throw new Error(`continuation_runtime_v1_memory_target_missing:${memoryId}`);
          verifyItem(tenantId, scope, row);
          assertCommitRef(tenantId, scope, row.source_commit_revision,
            row.source_commit_id, row.source_commit_sha256);
          return { projectionSha: row.projection_sha256 };
        };

        for (const relation of relations) {
          exactKeys(relation, ["relation_id", "relation_kind", "lifecycle", "source_memory_id",
            "target_memory_id", "projection"], "relation_mutation");
          text(relation.relation_id, 256, "relation_id"); text(relation.relation_kind, 128, "relation_kind");
          text(relation.source_memory_id, 256, "source_memory_id");
          text(relation.target_memory_id, 256, "target_memory_id");
          if (!LIFECYCLES.has(relation.lifecycle) || relation.source_memory_id === relation.target_memory_id) {
            throw new Error("continuation_runtime_v1_memory_relation_invalid");
          }
          currentItem(relation.source_memory_id); currentItem(relation.target_memory_id);
          canonicalObject(relation.projection, 65_536, "relation_projection");
        }

        const capsules: ExecutionCapsuleV1[] = [];
        for (const input of capsuleInputs) {
          exactKeys(input, ["memory_id", "draft"], "capsule_mutation");
          if (Object.hasOwn(input.draft as object, "created_at")) {
            throw new Error("continuation_runtime_v1_memory_capsule_created_at_forbidden");
          }
          exactKeys(input.draft, ["capsule_id", "kind", "proposed_influence", "applicability",
            "projection", "coverage_claims", "precondition_specs", "evidence_refs",
            "verifier_refs", "conflicts_with", "supersedes", "expires_at"], "capsule_draft");
          const source = currentItem(input.memory_id);
          const previous = database.db.prepare(
            `SELECT * FROM capsule_revisions WHERE tenant_id = ? AND scope = ? AND capsule_id = ?
               ORDER BY capsule_revision DESC LIMIT 1`,
          ).get(tenantId, scope, input.draft.capsule_id) as CapsuleRow | undefined;
          const previousCapsule = previous ? verifyCapsule(previous) : null;
          if (previous) {
            assertCommitRef(tenantId, scope, previous.source_commit_revision,
              previous.source_commit_id, previous.source_commit_sha256);
          }
          if (previous && previous.memory_id !== input.memory_id) {
            throw new Error("continuation_runtime_v1_memory_capsule_source_changed");
          }
          const capsule = buildExecutionCapsuleV1({
            tenant_id: tenantId, scope,
            capsule_revision: (previous?.capsule_revision ?? 0) + 1,
            parent_capsule_sha256: previous?.capsule_sha256 ?? null,
            source: { memory_id: input.memory_id, source_commit_id: commitId,
              source_projection_sha256: source.projectionSha },
            draft: { ...input.draft, created_at: createdAt },
          });
          if (previousCapsule && profile(previousCapsule) !== profile(capsule)) {
            throw new Error("continuation_runtime_v1_memory_capsule_profile_changed");
          }
          for (const ref of [...capsule.conflicts_with, ...capsule.supersedes]) {
            const targetRow = database.db.prepare(
              `SELECT * FROM capsule_revisions WHERE tenant_id = ? AND scope = ?
                   AND capsule_id = ? AND capsule_revision = ? AND capsule_sha256 = ?`,
            ).get(tenantId, scope, ref.capsule_id, ref.capsule_revision, ref.capsule_sha256) as CapsuleRow | undefined;
            if (!targetRow) throw new Error(`continuation_runtime_v1_memory_capsule_ref_missing:${ref.capsule_id}`);
            if (profile(verifyCapsule(targetRow)) !== profile(capsule)) {
              throw new Error("continuation_runtime_v1_memory_capsule_ref_profile_mismatch");
            }
          }
          capsules.push(capsule);
        }

        const mutation = {
          schema_version: "memory_mutation_v1", items, relations, capsules,
        } as const;
        const mutationJson = canonicalObject(mutation, 1_048_576, "mutation");
        const mutationSha = canonicalContinuationSha256(mutation);
        const requestSha = sourceOperation.request_sha256;
        const commitBody = {
          schema_version: "memory_commit_v1", tenant_id: tenantId, scope,
          revision, commit_id: commitId, parent_revision: parent?.head_revision ?? null,
          parent_commit_id: parent?.head_commit_id ?? null,
          parent_commit_sha256: parent?.head_commit_sha256 ?? null, request_sha256: requestSha,
          source_operation: sourceOperation,
          mutation_sha256: mutationSha, created_at: createdAt,
        } as const;
        const commitSha = canonicalContinuationSha256(commitBody);
        database.db.prepare(`INSERT INTO memory_commits(
          tenant_id, scope, revision, commit_id, commit_sha256, parent_revision,
          parent_commit_id, parent_commit_sha256, request_sha256,
          source_operation_kind, source_operation_id, source_request_sha256,
          mutation_sha256, mutation_json, actor_kind, actor_principal_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          tenantId, scope, revision, commitId, commitSha,
          parent?.head_revision ?? null, parent?.head_commit_id ?? null,
          parent?.head_commit_sha256 ?? null, requestSha,
          sourceOperation.operation_kind, sourceOperation.operation_id,
          sourceOperation.request_sha256, mutationSha, mutationJson,
          sourceOperation.actor_kind, sourceOperation.actor_principal_sha256, createdAt,
        );

        for (const prepared of preparedItems.values()) {
          const item = prepared.mutation;
          const rowBody: CanonicalObject = {
            tenant_id: tenantId, scope, memory_id: item.memory_id,
            memory_kind: item.memory_kind, lifecycle: item.lifecycle, authority: item.authority,
            hydrated: item.hydrated, projection_sha256: prepared.projectionSha,
            rehydration_ref: item.rehydration_ref, source_commit_revision: revision,
            source_commit_id: commitId, source_commit_sha256: commitSha,
            expires_at: item.expires_at, created_at: prepared.createdAt, updated_at: createdAt,
          };
          const rowSha = canonicalContinuationSha256(rowBody);
          database.db.prepare(`INSERT INTO memory_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, scope, memory_id) DO UPDATE SET
              memory_kind=excluded.memory_kind, lifecycle=excluded.lifecycle,
              authority=excluded.authority, hydrated=excluded.hydrated,
              projection_sha256=excluded.projection_sha256, projection_json=excluded.projection_json,
              rehydration_ref=excluded.rehydration_ref,
              source_commit_revision=excluded.source_commit_revision,
              source_commit_id=excluded.source_commit_id, source_commit_sha256=excluded.source_commit_sha256,
              row_sha256=excluded.row_sha256, expires_at=excluded.expires_at,
              updated_at=excluded.updated_at`).run(
            tenantId, scope, item.memory_id, item.memory_kind, item.lifecycle,
            item.authority, item.hydrated ? 1 : 0, prepared.projectionSha, prepared.projectionJson,
            item.rehydration_ref, revision, commitId, commitSha, rowSha, item.expires_at,
            prepared.createdAt, createdAt,
          );
        }

        for (const relation of relations) {
          const existing = database.db.prepare(
            `SELECT relation_id, relation_kind, lifecycle, source_memory_id, target_memory_id,
                    projection_sha256, projection_json, source_commit_revision, source_commit_id,
                    source_commit_sha256, row_sha256, created_at, updated_at
               FROM memory_relations WHERE tenant_id=? AND scope=? AND relation_id=?`,
          ).get(tenantId, scope, relation.relation_id) as RelationRow | undefined;
          if (existing) {
            verifyRelation(tenantId, scope, existing);
            assertCommitRef(tenantId, scope, existing.source_commit_revision,
              existing.source_commit_id, existing.source_commit_sha256);
          }
          const projectionJson = canonicalContinuationJson(relation.projection);
          const projectionSha = canonicalContinuationSha256(relation.projection);
          const relationCreatedAt = existing?.created_at ?? createdAt;
          const rowBody: CanonicalObject = {
            tenant_id: tenantId, scope, relation_id: relation.relation_id,
            relation_kind: relation.relation_kind, lifecycle: relation.lifecycle,
            source_memory_id: relation.source_memory_id, target_memory_id: relation.target_memory_id,
            projection_sha256: projectionSha, source_commit_revision: revision,
            source_commit_id: commitId, source_commit_sha256: commitSha,
            created_at: relationCreatedAt, updated_at: createdAt,
          };
          database.db.prepare(`INSERT INTO memory_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, scope, relation_id) DO UPDATE SET
              relation_kind=excluded.relation_kind, lifecycle=excluded.lifecycle,
              source_memory_id=excluded.source_memory_id, target_memory_id=excluded.target_memory_id,
              projection_sha256=excluded.projection_sha256, projection_json=excluded.projection_json,
              source_commit_revision=excluded.source_commit_revision,
              source_commit_id=excluded.source_commit_id, source_commit_sha256=excluded.source_commit_sha256,
              row_sha256=excluded.row_sha256, updated_at=excluded.updated_at`).run(
            tenantId, scope, relation.relation_id, relation.relation_kind,
            relation.lifecycle, relation.source_memory_id, relation.target_memory_id,
            projectionSha, projectionJson, revision, commitId, commitSha,
            canonicalContinuationSha256(rowBody), relationCreatedAt, createdAt,
          );
        }

        for (const capsule of capsules) {
          database.db.prepare(`INSERT INTO capsule_revisions(
            tenant_id, scope, capsule_id, capsule_revision, capsule_sha256,
            parent_capsule_revision, parent_capsule_sha256, memory_id,
            source_commit_revision, source_commit_id, source_commit_sha256,
            source_projection_sha256, capsule_kind, proposed_influence,
            task_family, task_signature, workflow_signature, workspace_signature,
            producer_agent_id, owner_agent_id, owner_team_id, projection_sha256,
            projection_json, precondition_count, preconditions_json,
            coverage_claim_count, coverage_claims_json, conflict_count,
            conflicts_json, supersedes_count, supersedes_json, capsule_json,
            expires_at, created_at
          ) VALUES (
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
          )`).run(
            tenantId, scope, capsule.capsule_id, capsule.capsule_revision,
            capsule.capsule_sha256, capsule.capsule_revision === 1 ? null : capsule.capsule_revision - 1,
            capsule.parent_capsule_sha256, capsule.source.memory_id, revision, commitId,
            commitSha, capsule.source.source_projection_sha256, capsule.kind,
            capsule.proposed_influence, capsule.applicability.task_family,
            capsule.applicability.task_signature, capsule.applicability.workflow_signature,
            capsule.applicability.workspace_signature, capsule.applicability.producer_agent_id,
            capsule.applicability.owner_agent_id, capsule.applicability.owner_team_id,
            capsule.projection.projection_sha256, canonicalContinuationJson(capsule.projection),
            capsule.precondition_specs.length, canonicalContinuationJson(capsule.precondition_specs),
            capsule.coverage_claims.length, canonicalContinuationJson(capsule.coverage_claims),
            capsule.conflicts_with.length, canonicalContinuationJson(capsule.conflicts_with),
            capsule.supersedes.length, canonicalContinuationJson(capsule.supersedes),
            canonicalContinuationJson(capsule), capsule.expires_at, capsule.created_at,
          );
        }

        const withoutHeadSha = {
          tenant_id: tenantId, scope, head_revision: revision,
          head_commit_id: commitId, head_commit_sha256: commitSha,
          source_operation: sourceOperation, updated_at: createdAt,
        };
        const head: MemoryScopeHeadV1 = {
          ...withoutHeadSha, head_sha256: canonicalContinuationSha256(headBody(withoutHeadSha)),
        };
        if (parent) {
          const changed = database.db.prepare(`UPDATE memory_scope_heads SET
            head_revision=?, head_commit_id=?, head_commit_sha256=?, head_sha256=?,
            source_operation_kind=?, source_operation_id=?, source_request_sha256=?, updated_at=?
            WHERE tenant_id=? AND scope=? AND head_revision=? AND head_sha256=?`).run(
            revision, commitId, commitSha, head.head_sha256,
            sourceOperation.operation_kind, sourceOperation.operation_id,
            sourceOperation.request_sha256, createdAt,
            tenantId, scope, parent.head_revision, parent.head_sha256,
          ) as { changes?: number | bigint };
          if (Number(changed.changes ?? 0) !== 1) {
            throw new ContinuationRuntimeV1MemoryHeadConflictError(args.expected_head_revision, null);
          }
        } else {
          database.db.prepare(`INSERT INTO memory_scope_heads(
            tenant_id, scope, head_revision, head_commit_id, head_commit_sha256,
            head_sha256, source_operation_kind, source_operation_id,
            source_request_sha256, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            tenantId, scope, revision, commitId, commitSha, head.head_sha256,
            sourceOperation.operation_kind, sourceOperation.operation_id,
            sourceOperation.request_sha256, createdAt,
          );
        }
        const persistedHead = readHeadSync(tenantId, scope, sourceOperation);
        if (!persistedHead || persistedHead.head_sha256 !== head.head_sha256) {
          throw new Error("continuation_runtime_v1_memory_postwrite_head_mismatch");
        }
        for (const memoryId of preparedItems.keys()) {
          const row = database.db.prepare(`SELECT memory_id, memory_kind, lifecycle, authority,
            hydrated, projection_sha256, projection_json, rehydration_ref,
            source_commit_revision, source_commit_id, source_commit_sha256, row_sha256,
            expires_at, created_at, updated_at FROM memory_items
            WHERE tenant_id=? AND scope=? AND memory_id=?`).get(
            tenantId, scope, memoryId,
          ) as ItemRow | undefined;
          if (!row) throw new Error("continuation_runtime_v1_memory_postwrite_item_missing");
          verifyItem(tenantId, scope, row);
          assertCommitRef(tenantId, scope, row.source_commit_revision,
            row.source_commit_id, row.source_commit_sha256, sourceOperation);
        }
        for (const relation of relations) {
          const row = database.db.prepare(`SELECT relation_id, relation_kind, lifecycle,
            source_memory_id, target_memory_id, projection_sha256, projection_json,
            source_commit_revision, source_commit_id, source_commit_sha256, row_sha256,
            created_at, updated_at FROM memory_relations
            WHERE tenant_id=? AND scope=? AND relation_id=?`).get(
            tenantId, scope, relation.relation_id,
          ) as RelationRow | undefined;
          if (!row) throw new Error("continuation_runtime_v1_memory_postwrite_relation_missing");
          verifyRelation(tenantId, scope, row);
          assertCommitRef(tenantId, scope, row.source_commit_revision,
            row.source_commit_id, row.source_commit_sha256, sourceOperation);
        }
        for (const capsule of capsules) {
          const row = database.db.prepare(`SELECT * FROM capsule_revisions
            WHERE tenant_id=? AND scope=? AND capsule_id=? AND capsule_revision=?`).get(
            tenantId, scope, capsule.capsule_id, capsule.capsule_revision,
          ) as CapsuleRow | undefined;
          if (!row || verifyCapsule(row).capsule_sha256 !== capsule.capsule_sha256) {
            throw new Error("continuation_runtime_v1_memory_postwrite_capsule_mismatch");
          }
          assertCommitRef(tenantId, scope, row.source_commit_revision,
            row.source_commit_id, row.source_commit_sha256, sourceOperation);
        }
        return canonicalContinuationClone({
          commit: { revision, commit_id: commitId, commit_sha256: commitSha,
            source_operation: sourceOperation, created_at: createdAt,
            mutation_sha256: mutationSha },
          head,
          capsules,
        });
      }
    },

    async readHead(tenantId: string, scope: string): Promise<MemoryScopeHeadV1 | null> {
      text(tenantId, 256, "tenant_id"); text(scope, 256, "scope");
      return database.read(() => {
        const head = readHeadSync(tenantId, scope);
        return head === null ? null : canonicalContinuationClone(head);
      });
    },

    async readCurrentServingProjection(
      args: CurrentServingMemoryProjectionRequestV1,
    ): Promise<CurrentServingMemoryProjectionV1> {
      exactKeys(args, [
        "tenant_id", "scope", "task_family", "memory_scope_head_revision",
        "memory_scope_head_sha256", "evaluated_at", "learning_capsule_refs",
      ], "current_serving_projection_args");
      text(args.tenant_id, 256, "tenant_id");
      text(args.scope, 256, "scope");
      text(args.task_family, 256, "task_family");
      if (!Number.isSafeInteger(args.memory_scope_head_revision)
        || args.memory_scope_head_revision < 1) {
        throw new Error(
          "continuation_runtime_v1_memory_current_serving_head_revision_invalid",
        );
      }
      sha(args.memory_scope_head_sha256, "current_serving_head_sha256");
      assertCanonicalUtcMillis(
        args.evaluated_at,
        "memory.current_serving_evaluated_at",
      );
      if (!Array.isArray(args.learning_capsule_refs)
        || args.learning_capsule_refs.length > MAX_CURRENT_SERVING_LEARNING_REFS) {
        throw new Error(
          "continuation_runtime_v1_memory_current_serving_learning_refs_invalid",
        );
      }
      const learningRefs = sortedUnique(
        args.learning_capsule_refs.map((value, index) => {
          exactKeys(
            value,
            ["capsule_id", "capsule_revision", "capsule_sha256"],
            `current_serving_learning_ref_${index}`,
          );
          text(value.capsule_id, 256, "current_serving_capsule_id");
          if (!Number.isSafeInteger(value.capsule_revision)
            || value.capsule_revision < 1) {
            throw new Error(
              "continuation_runtime_v1_memory_current_serving_capsule_revision_invalid",
            );
          }
          sha(value.capsule_sha256, "current_serving_capsule_sha256");
          return canonicalContinuationClone(value);
        }),
        capsuleRefKey,
        "current_serving_learning_capsule_ref",
      );

      return database.read(() => {
        const currentHead = readHeadSync(args.tenant_id, args.scope);
        if (!currentHead
          || currentHead.head_revision !== args.memory_scope_head_revision
          || currentHead.head_sha256 !== args.memory_scope_head_sha256) {
          throw new Error(
            "continuation_runtime_v1_memory_current_serving_head_fence_mismatch",
          );
        }
        const projectionHead = canonicalContinuationClone({
          head_revision: currentHead.head_revision,
          head_commit_id: currentHead.head_commit_id,
          head_commit_sha256: currentHead.head_commit_sha256,
          head_sha256: currentHead.head_sha256,
          source_operation: currentHead.source_operation,
          updated_at: currentHead.updated_at,
        });

        const continuityRows = database.db.prepare(`SELECT capsule.*
          FROM capsule_revisions AS capsule
          JOIN (
            SELECT capsule_id, MAX(capsule_revision) AS capsule_revision
            FROM capsule_revisions
            WHERE tenant_id = ? AND scope = ? AND task_family = ?
            GROUP BY capsule_id
          ) AS latest
            ON latest.capsule_id = capsule.capsule_id
           AND latest.capsule_revision = capsule.capsule_revision
          JOIN memory_items AS item
            ON item.tenant_id = capsule.tenant_id
           AND item.scope = capsule.scope
           AND item.memory_id = capsule.memory_id
          WHERE capsule.tenant_id = ? AND capsule.scope = ?
            AND capsule.task_family = ?
            AND capsule.capsule_kind IN (
              'current_state', 'verified_fact', 'constraint'
            )
            AND item.lifecycle = 'active'
            AND item.authority IN ('verified', 'authoritative')
            AND item.hydrated = 1
            AND item.memory_kind = capsule.capsule_kind
            AND item.projection_sha256 = capsule.source_projection_sha256
            AND (item.expires_at IS NULL OR item.expires_at > ?)
          ORDER BY capsule.capsule_id, capsule.capsule_revision
          LIMIT ?`).all(
          args.tenant_id,
          args.scope,
          args.task_family,
          args.tenant_id,
          args.scope,
          args.task_family,
          args.evaluated_at,
          MAX_CURRENT_SERVING_CONTINUITY_CAPSULES + 1,
        ) as CapsuleRow[];
        if (continuityRows.length > MAX_CURRENT_SERVING_CONTINUITY_CAPSULES) {
          throw new ContinuationRuntimeV1CurrentServingProjectionCapacityError(
            continuityRows.length,
            MAX_CURRENT_SERVING_CONTINUITY_CAPSULES,
          );
        }

        const exactLearningRows: CapsuleRow[] = [];
        for (let offset = 0; offset < learningRefs.length;
          offset += EXACT_CAPSULE_QUERY_CHUNK) {
          const chunk = learningRefs.slice(
            offset,
            offset + EXACT_CAPSULE_QUERY_CHUNK,
          );
          const predicates = chunk.map(() =>
            "(capsule_id = ? AND capsule_revision = ? AND capsule_sha256 = ?)",
          ).join(" OR ");
          const values = chunk.flatMap((ref) => [
            ref.capsule_id,
            ref.capsule_revision,
            ref.capsule_sha256,
          ]);
          exactLearningRows.push(...database.db.prepare(`SELECT *
            FROM capsule_revisions
            WHERE tenant_id = ? AND scope = ? AND task_family = ?
              AND (${predicates})
            ORDER BY capsule_id, capsule_revision`).all(
            args.tenant_id,
            args.scope,
            args.task_family,
            ...values,
          ) as CapsuleRow[]);
        }
        const exactByRef = new Map(
          exactLearningRows.map((row) => [capsuleRowKey(row), row] as const),
        );
        if (learningRefs.some((ref) => !exactByRef.has(capsuleRefKey(ref)))) {
          throw new Error(
            "continuation_runtime_v1_memory_current_serving_learning_capsule_missing",
          );
        }

        const rowsByRef = new Map<string, CapsuleRow>();
        for (const row of [...continuityRows, ...exactLearningRows]) {
          rowsByRef.set(capsuleRowKey(row), row);
        }
        if (rowsByRef.size > MAX_CURRENT_SERVING_PROJECTED_CAPSULE_ROWS) {
          throw new Error(
            "continuation_runtime_v1_memory_current_serving_capsule_limit_exceeded",
          );
        }
        const verifiedCommitRefs = new Set<string>();
        const assertCurrentCommitRef = (
          revision: number,
          id: string,
          digest: string,
        ): void => {
          if (revision > currentHead.head_revision) {
            throw new Error(
              "continuation_runtime_v1_memory_corrupt:current_projection_future_commit",
            );
          }
          const key = `${revision}\0${id}\0${digest}`;
          if (verifiedCommitRefs.has(key)) return;
          assertCommitRef(args.tenant_id, args.scope, revision, id, digest);
          verifiedCommitRefs.add(key);
        };

        const capsules: HistoricalMemoryCapsuleV1[] = [...rowsByRef.values()]
          .map((row) => {
            const capsule = verifyCapsule(row);
            assertCurrentCommitRef(
              row.source_commit_revision,
              row.source_commit_id,
              row.source_commit_sha256,
            );
            return canonicalContinuationClone({
              capsule,
              source_commit_revision: row.source_commit_revision,
              source_commit_id: row.source_commit_id,
              source_commit_sha256: row.source_commit_sha256,
            });
          })
          .sort((left, right) => compareCanonicalUtf8(
            `${left.capsule.capsule_id}\0${left.capsule.capsule_revision
              .toString().padStart(16, "0")}`,
            `${right.capsule.capsule_id}\0${right.capsule.capsule_revision
              .toString().padStart(16, "0")}`,
          ));
        const memoryIds = [...new Set(capsules.map(
          (entry) => entry.capsule.source.memory_id,
        ))].sort(compareCanonicalUtf8);
        const itemRows: ItemRow[] = [];
        for (let offset = 0; offset < memoryIds.length;
          offset += CURRENT_ITEM_QUERY_CHUNK) {
          const chunk = memoryIds.slice(offset, offset + CURRENT_ITEM_QUERY_CHUNK);
          itemRows.push(...database.db.prepare(`SELECT memory_id, memory_kind,
            lifecycle, authority, hydrated, projection_sha256, projection_json,
            rehydration_ref, source_commit_revision, source_commit_id,
            source_commit_sha256, row_sha256, expires_at, created_at, updated_at
            FROM memory_items
            WHERE tenant_id = ? AND scope = ?
              AND memory_id IN (${chunk.map(() => "?").join(",")})
            ORDER BY memory_id`).all(
            args.tenant_id,
            args.scope,
            ...chunk,
          ) as ItemRow[]);
        }
        if (itemRows.length !== memoryIds.length) {
          throw new Error(
            "continuation_runtime_v1_memory_current_serving_item_missing",
          );
        }
        const items: HistoricalMemoryItemV1[] = itemRows.map((row) => {
          const projection = verifyItem(args.tenant_id, args.scope, row);
          assertCurrentCommitRef(
            row.source_commit_revision,
            row.source_commit_id,
            row.source_commit_sha256,
          );
          return canonicalContinuationClone({
            memory_id: row.memory_id,
            memory_kind: row.memory_kind,
            lifecycle: row.lifecycle,
            authority: row.authority,
            hydrated: row.hydrated === 1,
            projection_sha256: row.projection_sha256,
            projection,
            rehydration_ref: row.rehydration_ref,
            source_commit_revision: row.source_commit_revision,
            source_commit_id: row.source_commit_id,
            source_commit_sha256: row.source_commit_sha256,
            row_sha256: row.row_sha256,
            expires_at: row.expires_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
          });
        }).sort((left, right) => compareCanonicalUtf8(
          left.memory_id,
          right.memory_id,
        ));
        const itemById = new Map(items.map((item) => [item.memory_id, item]));
        const continuityKeys = new Set(continuityRows.map(capsuleRowKey));
        const continuityRecords = capsules.flatMap((entry) => {
          if (!continuityKeys.has(capsuleRefKey({
            capsule_id: entry.capsule.capsule_id,
            capsule_revision: entry.capsule.capsule_revision,
            capsule_sha256: entry.capsule.capsule_sha256,
          }))) return [];
          const item = itemById.get(entry.capsule.source.memory_id);
          if (!item
            || item.lifecycle !== "active"
            || (item.authority !== "verified"
              && item.authority !== "authoritative")
            || !item.hydrated
            || item.memory_kind !== entry.capsule.kind
            || item.projection_sha256
              !== entry.capsule.source.source_projection_sha256) return [];
          return [{ item, capsule: entry }];
        });
        const body = {
          schema_version: "current_serving_memory_projection_v1" as const,
          tenant_id: args.tenant_id,
          scope: args.scope,
          task_family: args.task_family,
          head: projectionHead,
          evaluated_at: args.evaluated_at,
          learning_capsule_refs: learningRefs,
          items,
          capsules,
          continuity_records: continuityRecords,
        };
        return canonicalContinuationClone({
          ...body,
          projection_sha256: canonicalContinuationSha256(body),
        });
      });
    },

    async auditScope(tenantId: string, scope: string): Promise<MemoryScopeAuditV1> {
      text(tenantId, 256, "tenant_id"); text(scope, 256, "scope");
      return database.read(() => canonicalContinuationClone(auditScopeSync(tenantId, scope)));
    },

    async readMemoryItem(tenantId: string, scope: string, memoryId: string) {
      text(tenantId, 256, "tenant_id"); text(scope, 256, "scope"); text(memoryId, 256, "memory_id");
      return database.read(() => {
        const row = database.db.prepare(`SELECT memory_id, memory_kind, lifecycle, authority, hydrated,
          projection_sha256, projection_json, rehydration_ref, source_commit_revision,
          source_commit_id, source_commit_sha256, row_sha256, expires_at, created_at, updated_at
          FROM memory_items WHERE tenant_id=? AND scope=? AND memory_id=?`).get(
          tenantId, scope, memoryId,
        ) as ItemRow | undefined;
        if (!row) return null;
        const projection = verifyItem(tenantId, scope, row);
        assertCommitRef(tenantId, scope, row.source_commit_revision, row.source_commit_id, row.source_commit_sha256);
        return canonicalContinuationClone({ ...row, hydrated: row.hydrated === 1, projection });
      });
    },

    async readRelation(tenantId: string, scope: string, relationId: string) {
      text(tenantId, 256, "tenant_id"); text(scope, 256, "scope"); text(relationId, 256, "relation_id");
      return database.read(() => {
        const row = database.db.prepare(`SELECT relation_id, relation_kind, lifecycle,
          source_memory_id, target_memory_id, projection_sha256, projection_json,
          source_commit_revision, source_commit_id, source_commit_sha256, row_sha256,
          created_at, updated_at FROM memory_relations
          WHERE tenant_id=? AND scope=? AND relation_id=?`).get(
          tenantId, scope, relationId,
        ) as RelationRow | undefined;
        if (!row) return null;
        const projection = verifyRelation(tenantId, scope, row);
        assertCommitRef(tenantId, scope, row.source_commit_revision, row.source_commit_id, row.source_commit_sha256);
        for (const memoryId of [row.source_memory_id, row.target_memory_id]) {
          const item = database.db.prepare(`SELECT memory_id, memory_kind, lifecycle, authority,
            hydrated, projection_sha256, projection_json, rehydration_ref,
            source_commit_revision, source_commit_id, source_commit_sha256, row_sha256,
            expires_at, created_at, updated_at FROM memory_items
            WHERE tenant_id=? AND scope=? AND memory_id=?`).get(
            tenantId, scope, memoryId,
          ) as ItemRow | undefined;
          if (!item) throw new Error("continuation_runtime_v1_memory_corrupt:relation_target");
          verifyItem(tenantId, scope, item);
        }
        return canonicalContinuationClone({ ...row, projection });
      });
    },

    async readCapsule(tenantId: string, scope: string, capsuleId: string, revision: number) {
      text(tenantId, 256, "tenant_id"); text(scope, 256, "scope"); text(capsuleId, 256, "capsule_id");
      return database.read(() => {
        const row = database.db.prepare(`SELECT * FROM capsule_revisions
          WHERE tenant_id=? AND scope=? AND capsule_id=? AND capsule_revision=?`).get(
          tenantId, scope, capsuleId, revision,
        ) as CapsuleRow | undefined;
        if (!row) return null;
        const capsule = verifyCapsule(row);
        assertCommitRef(tenantId, scope, row.source_commit_revision, row.source_commit_id, row.source_commit_sha256);
        const item = database.db.prepare(`SELECT memory_id, memory_kind, lifecycle, authority,
          hydrated, projection_sha256, projection_json, rehydration_ref,
          source_commit_revision, source_commit_id, source_commit_sha256, row_sha256,
          expires_at, created_at, updated_at FROM memory_items
          WHERE tenant_id=? AND scope=? AND memory_id=?`).get(
          tenantId, scope, row.memory_id,
        ) as ItemRow | undefined;
        if (!item) {
          throw new Error("continuation_runtime_v1_memory_corrupt:capsule_source");
        }
        verifyItem(tenantId, scope, item);
        for (const ref of [...capsule.conflicts_with, ...capsule.supersedes]) {
          const target = database.db.prepare(`SELECT * FROM capsule_revisions
            WHERE tenant_id=? AND scope=? AND capsule_id=? AND capsule_revision=?
              AND capsule_sha256=?`).get(
            tenantId, scope, ref.capsule_id, ref.capsule_revision, ref.capsule_sha256,
          ) as CapsuleRow | undefined;
          if (!target || profile(verifyCapsule(target)) !== profile(capsule)) {
            throw new Error("continuation_runtime_v1_memory_corrupt:capsule_ref");
          }
          assertCommitRef(tenantId, scope, target.source_commit_revision,
            target.source_commit_id, target.source_commit_sha256);
        }
        return canonicalContinuationClone(capsule);
      });
    },
  });
  MEMORY_STORE_DATABASES.set(store, database);
  return store;
}
