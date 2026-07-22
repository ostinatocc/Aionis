import type { ExecutionCapsuleDraftV1 } from "../continuation/capsule.js";
import {
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationSha256,
  type CanonicalJson,
  type CapsuleRefV1,
  type ExecutionCapsuleV1,
} from "../continuation/contract.js";
import {
  isContinuationRehydrationRefV1,
  type ContinuationRehydrationRefV1,
} from "../continuation/rehydration-ref.js";
import type { ContinuationServingMemoryProjectionV1 } from
  "./continuation-runtime-v1-memory-history.js";
import type { ContinuationRuntimeV1OperationLineageV1 } from
  "./continuation-runtime-v1-operation-store.js";

export type ContinuationRuntimeV1MemoryCanonicalObject =
  Readonly<{ [key: string]: CanonicalJson }>;
export type ContinuationRuntimeV1MemoryLifecycle =
  "active" | "suppressed" | "archived" | "quarantined";
export type ContinuationRuntimeV1MemoryAuthority =
  "candidate" | "verified" | "authoritative";

export type MemoryItemMutationV1 = Readonly<{
  memory_id: string;
  memory_kind: string;
  lifecycle: ContinuationRuntimeV1MemoryLifecycle;
  authority: ContinuationRuntimeV1MemoryAuthority;
  hydrated: boolean;
  projection: ContinuationRuntimeV1MemoryCanonicalObject;
  rehydration_ref: ContinuationRehydrationRefV1 | null;
  expires_at: string | null;
}>;

export type ArchivedMemoryProjectionV1 = Readonly<{
  schema_version: "archived_memory_projection_v1";
  memory_id: string;
  source_projection_sha256: string;
  rehydration_ref_sha256: string;
}>;

function archivedMemoryText(value: unknown, max: number, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`continuation_runtime_v1_memory_${field}_invalid`);
  }
  assertUnicodeScalarString(value, `memory.${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > max) {
    throw new Error(`continuation_runtime_v1_memory_${field}_invalid`);
  }
}

/**
 * Logical controlled forgetting: this tombstone replaces the current
 * materialization. Immutable commits, capsule revisions, and past exposures
 * remain available to authorized audit readers; this is not secure erasure.
 */
export function buildArchivedMemoryProjectionV1(args: Readonly<{
  memory_id: string;
  source_projection_sha256: string;
  rehydration_ref: ContinuationRehydrationRefV1;
}>): ArchivedMemoryProjectionV1 {
  archivedMemoryText(args.memory_id, 256, "archived_memory_id");
  if (!/^[0-9a-f]{64}$/u.test(args.source_projection_sha256)) {
    throw new Error("continuation_runtime_v1_memory_archive_source_digest_invalid");
  }
  if (!isContinuationRehydrationRefV1(args.rehydration_ref)) {
    throw new Error("continuation_runtime_v1_memory_archive_rehydration_ref_invalid");
  }
  return canonicalContinuationClone({
    schema_version: "archived_memory_projection_v1" as const,
    memory_id: args.memory_id,
    source_projection_sha256: args.source_projection_sha256,
    rehydration_ref_sha256: canonicalContinuationSha256(args.rehydration_ref),
  });
}

export type MemoryRelationMutationV1 = Readonly<{
  relation_id: string;
  relation_kind: string;
  lifecycle: ContinuationRuntimeV1MemoryLifecycle;
  source_memory_id: string;
  target_memory_id: string;
  projection: ContinuationRuntimeV1MemoryCanonicalObject;
}>;

export type CapsuleMutationV1 = Readonly<{
  memory_id: string;
  draft: Omit<ExecutionCapsuleDraftV1, "created_at">;
}>;

export type AppendMemoryRevisionV1Args = Readonly<{
  expected_head_revision: number | null;
  items: readonly MemoryItemMutationV1[];
  relations: readonly MemoryRelationMutationV1[];
  capsules: readonly CapsuleMutationV1[];
}>;

export type MemoryCommitRefV1 = Readonly<{
  revision: number;
  commit_id: string;
  commit_sha256: string;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
}>;

export type MemoryScopeHeadV1 = Readonly<{
  tenant_id: string;
  scope: string;
  head_revision: number;
  head_commit_id: string;
  head_commit_sha256: string;
  head_sha256: string;
  source_operation: ContinuationRuntimeV1OperationLineageV1;
  updated_at: string;
}>;

export type AppendMemoryRevisionV1Result = Readonly<{
  commit: MemoryCommitRefV1 & Readonly<{ created_at: string; mutation_sha256: string }>;
  head: MemoryScopeHeadV1;
  capsules: readonly ExecutionCapsuleV1[];
}>;

export type MemoryScopeAuditV1 = Readonly<{
  head: MemoryScopeHeadV1 | null;
  verified_commit_count: number;
}>;

export type CurrentServingMemoryProjectionRequestV1 = Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
  memory_scope_head_revision: number;
  memory_scope_head_sha256: string;
  evaluated_at: string;
  learning_capsule_refs: readonly CapsuleRefV1[];
}>;

export type CurrentServingMemoryProjectionV1 =
  ContinuationServingMemoryProjectionV1 & Readonly<{
    schema_version: "current_serving_memory_projection_v1";
    evaluated_at: string;
    learning_capsule_refs: readonly CapsuleRefV1[];
    projection_sha256: string;
  }>;

export class ContinuationRuntimeV1MemoryHeadConflictError extends Error {
  constructor(readonly expected: number | null, readonly actual: number | null) {
    super("continuation_runtime_v1_memory_head_conflict");
    this.name = "ContinuationRuntimeV1MemoryHeadConflictError";
  }
}

export class ContinuationRuntimeV1CurrentServingProjectionCapacityError
  extends Error {
  constructor(
    readonly minimumContinuityCandidateCount: number,
    readonly continuityCandidateLimit: number,
  ) {
    super("continuation_runtime_v1_current_serving_projection_capacity_exceeded");
    this.name = "ContinuationRuntimeV1CurrentServingProjectionCapacityError";
  }
}
