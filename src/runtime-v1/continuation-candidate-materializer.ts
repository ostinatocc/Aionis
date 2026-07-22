import {
  assertCanonicalUtcMillis,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type ContinuationContractV1,
} from "../continuation/contract.js";
import type { ContinuationCompilerCandidateV1 } from
  "../continuation/candidate-retrieval.js";
import type {
  AuthorityBranchManifestV1,
  AuthorityBranchRevisionRefV1,
} from "../continuation/authority-branch.js";
import type { ContinuationServingMemoryProjectionV1 } from
  "../store/continuation-runtime-v1-memory-history.js";

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_candidate_materializer_${code}`);
}

export function continuationRuntimeV1BranchRefFromManifest(
  manifest: AuthorityBranchManifestV1,
): AuthorityBranchRevisionRefV1 {
  return canonicalContinuationClone({
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  });
}

function contractBranchRef(
  value: AuthorityBranchRevisionRefV1,
): ContinuationContractV1["authority"]["served_learning_branch"] {
  return canonicalContinuationClone({
    branch_id: value.branch_id,
    branch_revision: value.branch_revision,
    manifest_sha256: value.manifest_sha256,
  });
}

/**
 * Materializes both governed-learning and verified-continuity lanes against one
 * verified memory fence. Production uses a bounded current projection; audit
 * and counterfactual readers adapt an immutable historical projection to the
 * same honest serving shape so the candidate bytes cannot drift.
 */
export function materializeContinuationCandidatesV1(args: Readonly<{
  scope: string;
  served_manifest: AuthorityBranchManifestV1;
  memory_projection: ContinuationServingMemoryProjectionV1;
  evaluated_at: string;
}>): readonly ContinuationCompilerCandidateV1[] {
  assertCanonicalUtcMillis(args.evaluated_at, "candidate materializer evaluated_at");
  if (args.memory_projection.scope !== args.scope) {
    fail("memory_projection_scope_mismatch");
  }
  const servedRef = contractBranchRef(
    continuationRuntimeV1BranchRefFromManifest(args.served_manifest),
  );
  const memoryHeadRevision = args.memory_projection.head.head_revision;
  const memoryHeadSha256 = args.memory_projection.head.head_sha256;
  const itemById = new Map(args.memory_projection.items.map(
    (item) => [item.memory_id, item] as const,
  ));
  const capsuleByRef = new Map(args.memory_projection.capsules.map((entry) => [
    canonicalContinuationJson({
      capsule_id: entry.capsule.capsule_id,
      capsule_revision: entry.capsule.capsule_revision,
      capsule_sha256: entry.capsule.capsule_sha256,
    }),
    entry,
  ] as const));
  const candidates: ContinuationCompilerCandidateV1[] = [];
  const seenCapsuleIds = new Set<string>();
  const lifecycleFact = (
    item: ContinuationServingMemoryProjectionV1["items"][number],
  ) => {
    const body = {
      memory_id: item.memory_id,
      lifecycle_source_commit_id: item.source_commit_id,
      memory_projection_sha256: item.projection_sha256,
      lifecycle: item.lifecycle,
      memory_scope_head_revision: memoryHeadRevision,
      memory_scope_head_sha256: memoryHeadSha256,
    } as const;
    return canonicalContinuationClone({
      ...body,
      row_sha256: canonicalContinuationSha256(body),
    });
  };

  for (const binding of args.served_manifest.capsule_bindings) {
    if (binding.capsule_scope !== args.scope) fail("capsule_binding_scope_mismatch");
    const capsuleEntry = capsuleByRef.get(canonicalContinuationJson(binding.capsule));
    const capsule = capsuleEntry?.capsule;
    if (!capsule || (capsule.kind !== "procedure"
      && capsule.kind !== "counter_evidence")) fail("bound_learning_capsule_missing");
    const item = itemById.get(capsule.source.memory_id);
    if (!item) fail("learning_capsule_memory_missing");
    if (seenCapsuleIds.has(capsule.capsule_id)) {
      fail("learning_capsule_identity_conflict");
    }
    if (item.lifecycle !== "active"
      || (item.expires_at !== null
        && item.expires_at <= args.evaluated_at)) {
      continue;
    }
    if (!item.hydrated
      || item.memory_kind !== capsule.kind
      || item.projection_sha256 !== capsule.source.source_projection_sha256) {
      fail("learning_capsule_active_memory_state_invalid");
    }
    seenCapsuleIds.add(capsule.capsule_id);
    const branchBindingBody = {
      branch_ref: servedRef,
      capsule: binding.capsule,
      disposition: binding.disposition,
      admission_authority: binding.admission_authority,
    } as const;
    candidates.push(canonicalContinuationClone({
      capsule,
      provenance: {
        lane: "governed_learning" as const,
        branch_binding: {
          ...branchBindingBody,
          binding_sha256: canonicalContinuationSha256(branchBindingBody),
        },
      },
      lifecycle_fact: lifecycleFact(item),
    }));
  }

  for (const record of args.memory_projection.continuity_records) {
    const capsule = record.capsule.capsule;
    const item = record.item;
    if (item.expires_at !== null && item.expires_at <= args.evaluated_at) {
      continue;
    }
    if (seenCapsuleIds.has(capsule.capsule_id)
      || (item.authority !== "verified" && item.authority !== "authoritative")) {
      fail("continuity_capsule_identity_or_authority_conflict");
    }
    seenCapsuleIds.add(capsule.capsule_id);
    const capsuleRef = {
      capsule_id: capsule.capsule_id,
      capsule_revision: capsule.capsule_revision,
      capsule_sha256: capsule.capsule_sha256,
    } as const;
    const continuityBindingBody = {
      capsule: capsuleRef,
      disposition: capsule.proposed_influence === "block"
        ? "prohibit" as const
        : "include" as const,
      admission_authority: item.authority,
      memory_id: item.memory_id,
      capsule_source_commit_id: capsule.source.source_commit_id,
      memory_scope_head_revision: memoryHeadRevision,
      memory_scope_head_sha256: memoryHeadSha256,
    } as const;
    candidates.push(canonicalContinuationClone({
      capsule,
      provenance: {
        lane: "verified_continuity" as const,
        continuity_binding: {
          ...continuityBindingBody,
          binding_sha256: canonicalContinuationSha256(continuityBindingBody),
        },
      },
      lifecycle_fact: lifecycleFact(item),
    }));
  }
  return canonicalContinuationClone(candidates);
}
