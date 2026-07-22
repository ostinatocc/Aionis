import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
} from "../continuation/contract.js";
import {
  authorityBranchBindingSetSha256V1,
} from "../continuation/policy-rotation.js";
import {
  verifyAuthorityBranchManifestV1,
  type AuthorityBranchManifestV1,
} from "../continuation/authority-branch.js";
import {
  verifyHostTaskEnvelopeV1,
} from "../continuation/task-envelope.js";
import {
  buildWorldObservationSnapshotV1,
} from "../continuation/world-snapshot.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import type {
  AuthorityArtifactOperationRefV1,
  AuthorityBranchOperationRefV1,
  AuthorityDecisionOperationResultV1,
  DurableJobCreationOperationRefV1,
  MemoryRevisionOperationRefV1,
  ObservationSnapshotOperationRefV1,
  RecordObservationsOperationResultV1,
  ContinuationRuntimeV1OperationResultV1,
  ContinuationRuntimeV1OperationResultDerivationBinding,
  ContinuationRuntimeV1OperationResultDerivationMode,
} from "./continuation-runtime-v1-operation-result.js";
import {
  deriveCreateContinuationOperationResultV1,
  deriveRecordOutcomeOperationResultV1,
} from "./continuation-runtime-v1-operation-result-evidence.js";
import {
  canonicalOperationResultSetV1,
  operationResultArray,
  operationResultCanonicalJson,
  operationResultExact,
  operationResultFail,
  operationResultInteger,
  operationResultSha256,
  operationResultText,
  type OperationResultRow,
} from "./continuation-runtime-v1-operation-result-support.js";
import {
  deriveWorkerCompletionOperationResultV1,
} from "./continuation-runtime-v1-operation-result-job.js";

export type {
  ContinuationRuntimeV1OperationResultDerivationBinding,
  ContinuationRuntimeV1OperationResultDerivationMode,
} from "./continuation-runtime-v1-operation-result.js";

type MemoryMutation = Readonly<{
  items: readonly CanonicalJson[];
  relations: readonly CanonicalJson[];
  capsules: readonly CanonicalJson[];
}>;

function operationLineage(
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
) {
  return {
    tenant_id: binding.tenantId,
    scope: binding.scope,
    operation_kind: binding.operationKind,
    operation_id: binding.operationId,
    request_sha256: binding.requestSha256,
    actor_kind: binding.actorKind,
    actor_principal_sha256: binding.actorPrincipalSha256,
  } as const;
}

function operationSourceWhere(): string {
  return `tenant_id = ?
    AND source_operation_kind = ?
    AND source_operation_id = ?
    AND source_request_sha256 = ?`;
}

function sourceArgs(
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): readonly unknown[] {
  return [
    binding.tenantId,
    binding.operationKind,
    binding.operationId,
    binding.requestSha256,
  ];
}

function scopedSourceWhere(scopeColumn = "scope"): string {
  return `${operationSourceWhere()} AND ${scopeColumn} = ?`;
}

function scopedSourceArgs(
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): readonly unknown[] {
  return [...sourceArgs(binding), binding.scope];
}

function parseMemoryMutation(value: unknown): MemoryMutation {
  const mutation = operationResultExact(
    operationResultCanonicalJson(value, "memory_mutation"),
    ["capsules", "items", "relations", "schema_version"],
    "memory_mutation",
  );
  if (mutation.schema_version !== "memory_mutation_v1") {
    operationResultFail("memory_mutation_schema_invalid");
  }
  return {
    items: operationResultArray(mutation.items, 4_096, "memory_items") as CanonicalJson[],
    relations: operationResultArray(
      mutation.relations,
      4_096,
      "memory_relations",
    ) as CanonicalJson[],
    capsules: operationResultArray(
      mutation.capsules,
      4_096,
      "memory_capsules",
    ) as CanonicalJson[],
  };
}

function mutationIds(
  values: readonly CanonicalJson[],
  field: string,
  idKey: string,
): readonly string[] {
  const ids = values.map((value, index) => {
    const record = operationResultExact(
      value,
      Object.keys(value as object),
      `${field}_${index}`,
    );
    return operationResultText(record[idKey], `${field}_${index}_${idKey}`);
  });
  const unique = new Set(ids);
  if (unique.size !== ids.length) operationResultFail(`${field}_duplicate_identity`);
  return ids;
}

function assertCurrentMemoryChildren(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  row: OperationResultRow,
  mutation: MemoryMutation,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
): void {
  const revision = operationResultInteger(row.revision, "memory_revision", 1);
  const commitId = operationResultText(row.commit_id, "memory_commit_id");
  const commitSha = operationResultSha256(row.commit_sha256, "memory_commit");
  const itemIds = mutationIds(mutation.items, "memory_item", "memory_id");
  const relationIds = mutationIds(
    mutation.relations,
    "memory_relation",
    "relation_id",
  );
  const capsuleIds = mutationIds(mutation.capsules, "memory_capsule", "capsule_id");

  const currentItems = database.db.prepare(`SELECT memory_id, source_commit_revision
    FROM memory_items WHERE tenant_id = ? AND scope = ?
    AND source_commit_revision = ? AND source_commit_id = ?
    AND source_commit_sha256 = ? ORDER BY memory_id`).all(
      binding.tenantId,
      binding.scope,
      revision,
      commitId,
      commitSha,
    ) as OperationResultRow[];
  const currentItemIds = currentItems.map((item) => operationResultText(
    item.memory_id,
    "persisted_memory_id",
  ));
  if (currentItemIds.some((id) => !itemIds.includes(id))
    || (mode === "before_receipt_insert" && canonicalContinuationJson(currentItemIds)
      !== canonicalContinuationJson([...itemIds].sort()))) {
    operationResultFail("memory_item_census_mismatch");
  }
  for (const memoryId of itemIds) {
    const current = database.db.prepare(`SELECT source_commit_revision
      FROM memory_items WHERE tenant_id = ? AND scope = ? AND memory_id = ?`).get(
        binding.tenantId,
        binding.scope,
        memoryId,
      ) as OperationResultRow | undefined;
    if (!current
      || operationResultInteger(
        current.source_commit_revision,
        "memory_item_source_revision",
        revision,
      ) < revision) {
      operationResultFail("memory_item_projection_missing");
    }
  }

  const currentRelations = database.db.prepare(`SELECT relation_id
    FROM memory_relations WHERE tenant_id = ? AND scope = ?
    AND source_commit_revision = ? AND source_commit_id = ?
    AND source_commit_sha256 = ? ORDER BY relation_id`).all(
      binding.tenantId,
      binding.scope,
      revision,
      commitId,
      commitSha,
    ) as OperationResultRow[];
  const currentRelationIds = currentRelations.map((relation) => operationResultText(
    relation.relation_id,
    "persisted_relation_id",
  ));
  if (currentRelationIds.some((id) => !relationIds.includes(id))
    || (mode === "before_receipt_insert"
      && canonicalContinuationJson(currentRelationIds)
        !== canonicalContinuationJson([...relationIds].sort()))) {
    operationResultFail("memory_relation_census_mismatch");
  }
  for (const relationId of relationIds) {
    const current = database.db.prepare(`SELECT source_commit_revision
      FROM memory_relations WHERE tenant_id = ? AND scope = ? AND relation_id = ?`).get(
        binding.tenantId,
        binding.scope,
        relationId,
      ) as OperationResultRow | undefined;
    if (!current
      || operationResultInteger(
        current.source_commit_revision,
        "memory_relation_source_revision",
        revision,
      ) < revision) {
      operationResultFail("memory_relation_projection_missing");
    }
  }

  const persistedCapsules = database.db.prepare(`SELECT capsule_id, capsule_revision,
      capsule_sha256 FROM capsule_revisions WHERE tenant_id = ? AND scope = ?
      AND source_commit_revision = ? AND source_commit_id = ?
      AND source_commit_sha256 = ? ORDER BY capsule_id`).all(
        binding.tenantId,
        binding.scope,
        revision,
        commitId,
        commitSha,
      ) as OperationResultRow[];
  const expectedCapsules = mutation.capsules.map((value, index) => {
    const record = operationResultExact(
      value,
      Object.keys(value as object),
      `memory_capsule_${index}`,
    );
    return {
      capsule_id: operationResultText(record.capsule_id, "capsule_id"),
      capsule_revision: operationResultInteger(
        record.capsule_revision,
        "capsule_revision",
        1,
      ),
      capsule_sha256: operationResultSha256(
        record.capsule_sha256,
        "capsule_sha256",
      ),
    };
  }).sort((left, right) => left.capsule_id.localeCompare(right.capsule_id));
  const actualCapsules = persistedCapsules.map((capsule) => ({
    capsule_id: operationResultText(capsule.capsule_id, "persisted_capsule_id"),
    capsule_revision: operationResultInteger(
      capsule.capsule_revision,
      "persisted_capsule_revision",
      1,
    ),
    capsule_sha256: operationResultSha256(
      capsule.capsule_sha256,
      "persisted_capsule_sha256",
    ),
  }));
  if (capsuleIds.length !== expectedCapsules.length
    || canonicalContinuationJson(actualCapsules)
      !== canonicalContinuationJson(expectedCapsules)) {
    operationResultFail("memory_capsule_census_mismatch");
  }
}

function memoryRevisionRef(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
): MemoryRevisionOperationRefV1 | null {
  const rows = database.db.prepare(`SELECT * FROM memory_commits WHERE
    ${scopedSourceWhere()}`).all(...scopedSourceArgs(binding)) as OperationResultRow[];
  if (rows.length > 1) operationResultFail("memory_commit_cardinality");
  const row = rows[0];
  if (!row) return null;
  const revision = operationResultInteger(row.revision, "memory_revision", 1);
  const commitId = operationResultText(row.commit_id, "memory_commit_id");
  const commitSha = operationResultSha256(row.commit_sha256, "memory_commit");
  const mutationSha = operationResultSha256(row.mutation_sha256, "memory_mutation");
  const mutation = parseMemoryMutation(row.mutation_json);
  if (canonicalContinuationSha256({
    schema_version: "memory_mutation_v1",
    items: mutation.items,
    relations: mutation.relations,
    capsules: mutation.capsules,
  }) !== mutationSha
    || row.request_sha256 !== binding.requestSha256
    || row.actor_kind !== binding.actorKind
    || row.actor_principal_sha256 !== binding.actorPrincipalSha256) {
    operationResultFail("memory_commit_projection_mismatch");
  }
  const commitBody = {
    schema_version: "memory_commit_v1",
    tenant_id: binding.tenantId,
    scope: binding.scope,
    revision,
    commit_id: commitId,
    parent_revision: row.parent_revision,
    parent_commit_id: row.parent_commit_id,
    parent_commit_sha256: row.parent_commit_sha256,
    request_sha256: binding.requestSha256,
    source_operation: operationLineage(binding),
    mutation_sha256: mutationSha,
    created_at: row.created_at,
  };
  if (canonicalContinuationSha256(commitBody) !== commitSha) {
    operationResultFail("memory_commit_digest_mismatch");
  }
  assertCurrentMemoryChildren(database, binding, row, mutation, mode);
  const headBody = {
    schema_version: "memory_scope_head_v1",
    tenant_id: binding.tenantId,
    scope: binding.scope,
    head_revision: revision,
    head_commit_id: commitId,
    head_commit_sha256: commitSha,
    source_operation: operationLineage(binding),
    updated_at: row.created_at,
  };
  const headSha = canonicalContinuationSha256(headBody);
  const head = database.db.prepare(`SELECT head_revision, head_commit_id,
      head_commit_sha256, head_sha256, source_operation_kind,
      source_operation_id, source_request_sha256 FROM memory_scope_heads
      WHERE tenant_id = ? AND scope = ?`).get(
        binding.tenantId,
        binding.scope,
      ) as OperationResultRow | undefined;
  if (!head
    || operationResultInteger(head.head_revision, "memory_head_revision", 1) < revision
    || (head.head_revision === revision
      && (head.head_commit_id !== commitId
        || head.head_commit_sha256 !== commitSha
        || head.head_sha256 !== headSha
        || head.source_operation_kind !== binding.operationKind
        || head.source_operation_id !== binding.operationId
        || head.source_request_sha256 !== binding.requestSha256))) {
    operationResultFail("memory_head_projection_mismatch");
  }
  if (mode === "before_receipt_insert" && head.head_revision !== revision) {
    operationResultFail("memory_head_not_current_at_receipt");
  }
  return canonicalContinuationClone({
    revision,
    commit_id: commitId,
    commit_sha256: commitSha,
    mutation_sha256: mutationSha,
    head_sha256: headSha,
    item_count: mutation.items.length,
    item_set_sha256: canonicalContinuationSha256(mutation.items),
    relation_count: mutation.relations.length,
    relation_set_sha256: canonicalContinuationSha256(mutation.relations),
    capsule_count: mutation.capsules.length,
    capsule_set_sha256: canonicalContinuationSha256(mutation.capsules),
  });
}

function observationSnapshotRef(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): ObservationSnapshotOperationRefV1 {
  const rows = database.db.prepare(`SELECT * FROM observation_snapshots WHERE
    ${scopedSourceWhere()}`).all(...scopedSourceArgs(binding)) as OperationResultRow[];
  if (rows.length !== 1) operationResultFail("observation_snapshot_cardinality");
  const row = rows[0]!;
  const envelopeValue = operationResultCanonicalJson(
    row.host_task_envelope_json,
    "host_task_envelope",
  );
  const envelope = verifyHostTaskEnvelopeV1(envelopeValue);
  const observations = operationResultCanonicalJson(
    row.observations_json,
    "observations",
  );
  if (!Array.isArray(observations)
    || observations.length !== operationResultInteger(
      row.observation_count,
      "observation_count",
      0,
      2_048,
    )) {
    operationResultFail("observation_count_mismatch");
  }
  const snapshot = buildWorldObservationSnapshotV1({
    tenant_id: binding.tenantId,
    scope: binding.scope,
    authority_subject_sha256: envelope.authority_subject_sha256,
    world_snapshot_id: operationResultText(
      row.world_snapshot_id,
      "world_snapshot_id",
    ),
    host_task_envelope: envelope,
    collection_principal_sha256: operationResultSha256(
      row.collection_principal_sha256,
      "collection_principal",
    ),
    observations: observations as never,
    created_at: operationResultText(row.created_at, "snapshot_created_at"),
  });
  if (snapshot.world_snapshot_sha256 !== row.world_snapshot_sha256
    || snapshot.host_task_envelope.host_task_envelope_sha256
      !== row.host_task_envelope_sha256
    || snapshot.observed_from !== row.observed_from
    || snapshot.observed_through !== row.observed_through
    || snapshot.expires_at !== row.expires_at
    || snapshot.world_snapshot_id !== binding.operationId
    || row.collection_principal_sha256 !== binding.actorPrincipalSha256) {
    operationResultFail("observation_snapshot_projection_mismatch");
  }
  return canonicalContinuationClone({
    world_snapshot_id: snapshot.world_snapshot_id,
    world_snapshot_sha256: snapshot.world_snapshot_sha256,
    host_task_envelope_sha256:
      snapshot.host_task_envelope.host_task_envelope_sha256,
  });
}

function authorityArtifactRefs(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): readonly AuthorityArtifactOperationRefV1[] {
  const rows = database.db.prepare(`SELECT * FROM authority_artifacts WHERE
    ${scopedSourceWhere("source_operation_scope")}
    ORDER BY artifact_kind, artifact_id, artifact_revision`).all(
      ...scopedSourceArgs(binding),
    ) as OperationResultRow[];
  return rows.map((row) => {
    const payload = operationResultCanonicalJson(row.payload_json, "artifact_payload");
    if (canonicalContinuationSha256(payload) !== row.payload_sha256) {
      operationResultFail("authority_artifact_payload_digest_mismatch");
    }
    const kind = row.artifact_kind;
    if (kind !== "compiler_policy" && kind !== "evidence_policy"
      && kind !== "experiment_cohort" && kind !== "policy_rotation") {
      operationResultFail("authority_artifact_kind_invalid");
    }
    return canonicalContinuationClone({
      artifact_id: operationResultText(row.artifact_id, "artifact_id"),
      artifact_revision: operationResultInteger(
        row.artifact_revision,
        "artifact_revision",
        1,
      ),
      artifact_kind: kind,
      authority_subject_sha256: row.authority_subject_sha256 === null
        ? null
        : operationResultSha256(
          row.authority_subject_sha256,
          "artifact_authority_subject",
        ),
      artifact_sha256: operationResultSha256(row.artifact_sha256, "artifact"),
      payload_sha256: operationResultSha256(row.payload_sha256, "artifact_payload"),
    });
  });
}

function branchBindingSet(
  database: ContinuationRuntimeV1Database,
  manifest: AuthorityBranchManifestV1,
): void {
  const rows = database.db.prepare(`SELECT capsule_scope, capsule_id,
      capsule_revision, capsule_sha256, disposition, admission_authority,
      binding_sha256, created_at FROM branch_capsule_bindings
      WHERE tenant_id = ? AND authority_subject_sha256 = ? AND branch_id = ?
        AND branch_revision = ? AND branch_manifest_sha256 = ?
      ORDER BY capsule_scope, capsule_id, capsule_revision`).all(
        manifest.tenant_id,
        manifest.authority_subject_sha256,
        manifest.branch_id,
        manifest.branch_revision,
        manifest.manifest_sha256,
      ) as OperationResultRow[];
  const projected = rows.map((row) => ({
    capsule_scope: operationResultText(
      row.capsule_scope,
      "branch_binding_capsule_scope",
    ),
    capsule: {
      capsule_id: operationResultText(
        row.capsule_id,
        "branch_binding_capsule_id",
      ),
      capsule_revision: operationResultInteger(
        row.capsule_revision,
        "branch_binding_capsule_revision",
        1,
      ),
      capsule_sha256: operationResultSha256(
        row.capsule_sha256,
        "branch_binding_capsule_sha256",
      ),
    },
    disposition: row.disposition,
    admission_authority: row.admission_authority,
  }));
  if (canonicalContinuationJson(projected)
    !== canonicalContinuationJson(manifest.capsule_bindings)) {
    operationResultFail("authority_branch_binding_census_mismatch");
  }
  const branch = {
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  };
  for (let index = 0; index < rows.length; index += 1) {
    const expected = canonicalContinuationSha256({
      schema_version: "authority_branch_capsule_binding_v1",
      tenant_id: manifest.tenant_id,
      authority_subject_sha256: manifest.authority_subject_sha256,
      branch,
      binding: manifest.capsule_bindings[index],
      created_at: manifest.created_at,
    });
    if (rows[index]!.binding_sha256 !== expected
      || rows[index]!.created_at !== manifest.created_at) {
      operationResultFail("authority_branch_binding_projection_mismatch");
    }
  }
}

function authorityBranchSource(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  row: OperationResultRow,
) {
  const scope = operationResultText(row.source_operation_scope, "branch_scope");
  const kind = row.source_operation_kind;
  if (scope !== binding.scope
    || (kind !== "record_observations" && kind !== "authority_decision")) {
    operationResultFail("authority_branch_lineage_invalid");
  }
  const operationId = operationResultText(row.source_operation_id, "branch_operation_id");
  const requestSha256 = operationResultSha256(row.source_request_sha256, "branch_request");
  const current = kind === binding.operationKind
    && operationId === binding.operationId
    && requestSha256 === binding.requestSha256;
  const persisted = current ? null : database.db.prepare(`SELECT actor_kind,
      actor_principal_sha256 FROM operations WHERE tenant_id = ? AND scope = ?
      AND operation_kind = ? AND operation_id = ? AND request_sha256 = ?`).get(
        binding.tenantId, scope, kind, operationId, requestSha256,
      ) as OperationResultRow | undefined;
  const actorKind = current ? binding.actorKind : persisted?.actor_kind;
  const expectedActor = kind === "record_observations" ? "trusted_host" : "operator";
  if (actorKind !== expectedActor) operationResultFail("authority_branch_lineage_invalid");
  return {
    tenant_id: binding.tenantId,
    scope,
    operation_kind: kind,
    operation_id: operationId,
    request_sha256: requestSha256,
    actor_kind: expectedActor,
    actor_principal_sha256: operationResultSha256(current
      ? binding.actorPrincipalSha256 : persisted?.actor_principal_sha256,
    "branch_actor_principal"),
  } as const;
}

function projectAuthorityBranch(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
  row: OperationResultRow,
) {
  const manifest = verifyAuthorityBranchManifestV1(
    operationResultCanonicalJson(row.manifest_json, "authority_manifest"),
  );
  if (manifest.tenant_id !== binding.tenantId
    || manifest.authority_subject_sha256 !== row.authority_subject_sha256
    || manifest.branch_id !== row.branch_id
    || manifest.branch_revision !== row.branch_revision
    || manifest.manifest_sha256 !== row.manifest_sha256
    || manifest.branch_kind !== row.branch_kind
    || manifest.state !== row.state
    || manifest.created_at !== row.created_at) {
    operationResultFail("authority_branch_projection_mismatch");
  }
  branchBindingSet(database, manifest);
  let authorityHeadRef = null;
  if (manifest.branch_kind === "authoritative") {
    const source = authorityBranchSource(database, binding, row);
    const headSha256 = canonicalContinuationSha256({
      schema_version: "authority_head_v1",
      tenant_id: binding.tenantId,
      authority_subject_sha256: manifest.authority_subject_sha256,
      head_revision: manifest.branch_revision,
      target: {
        branch_id: manifest.branch_id,
        branch_revision: manifest.branch_revision,
        manifest_sha256: manifest.manifest_sha256,
        branch_kind: "authoritative",
        state: "authoritative",
      },
      source_operation: source,
      updated_at: manifest.created_at,
    });
    const head = database.db.prepare(`SELECT * FROM authority_heads
      WHERE tenant_id = ? AND authority_subject_sha256 = ?`).get(
        binding.tenantId, manifest.authority_subject_sha256,
      ) as OperationResultRow | undefined;
    const headRevision = head
      ? operationResultInteger(head.head_revision, "authority_head_revision", 1)
      : 0;
    const exactHead = head?.branch_id === manifest.branch_id
      && head.branch_revision === manifest.branch_revision
      && head.manifest_sha256 === manifest.manifest_sha256
      && head.branch_kind === "authoritative"
      && head.branch_state === "authoritative"
      && head.head_sha256 === headSha256
      && head.source_operation_scope === source.scope
      && head.source_operation_kind === source.operation_kind
      && head.source_operation_id === source.operation_id
      && head.source_request_sha256 === source.request_sha256
      && head.updated_at === manifest.created_at;
    if (!head || headRevision < manifest.branch_revision
      || (headRevision === manifest.branch_revision && !exactHead)) {
      operationResultFail("authority_head_projection_mismatch");
    }
    if (mode === "before_receipt_insert"
      && headRevision !== manifest.branch_revision) {
      operationResultFail("authority_head_not_current_at_receipt");
    }
    authorityHeadRef = { head_revision: manifest.branch_revision, head_sha256: headSha256 };
  }
  return {
    manifest,
    ref: canonicalContinuationClone({
      authority_subject_sha256: manifest.authority_subject_sha256,
      branch_id: manifest.branch_id,
      branch_revision: manifest.branch_revision,
      branch_kind: manifest.branch_kind,
      branch_state: manifest.state,
      manifest_sha256: manifest.manifest_sha256,
      binding_count: manifest.capsule_bindings.length,
      binding_set_sha256: authorityBranchBindingSetSha256V1(manifest.capsule_bindings),
      authority_head_ref: authorityHeadRef,
    }),
  };
}

function sameBranchRef(manifest: AuthorityBranchManifestV1,
  ref: NonNullable<AuthorityBranchManifestV1["base_authoritative_ref"]>): boolean {
  return manifest.branch_id === ref.branch_id
    && manifest.branch_revision === ref.branch_revision
    && manifest.manifest_sha256 === ref.manifest_sha256
    && manifest.branch_kind === ref.branch_kind
    && manifest.state === ref.state;
}

function authorityBranchRefs(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
): readonly AuthorityBranchOperationRefV1[] {
  const rows = database.db.prepare(`SELECT * FROM branch_revisions WHERE
    ${scopedSourceWhere("source_operation_scope")}
    ORDER BY authority_subject_sha256, branch_id, branch_revision`).all(
      ...scopedSourceArgs(binding),
    ) as OperationResultRow[];
  const projected = rows.map((row) => projectAuthorityBranch(database, binding, mode, row));
  if (binding.operationKind === "record_observations") {
    const candidate = projected.find(({ manifest }) =>
      manifest.branch_kind === "candidate");
    const authoritative = projected.find(({ manifest }) =>
      manifest.branch_kind === "authoritative");
    if (candidate) {
      const base = candidate.manifest.base_authoritative_ref;
      if (!base) operationResultFail("record_observations_candidate_base_missing");
      if (authoritative && !sameBranchRef(authoritative.manifest, base)) {
        operationResultFail("record_observations_candidate_base_not_genesis_head");
      }
      if (!authoritative) {
        const row = database.db.prepare(`SELECT * FROM branch_revisions
          WHERE tenant_id = ? AND authority_subject_sha256 = ? AND branch_id = ?
            AND branch_revision = ? AND manifest_sha256 = ?`).get(
              binding.tenantId, candidate.manifest.authority_subject_sha256,
              base.branch_id, base.branch_revision, base.manifest_sha256,
            ) as OperationResultRow | undefined;
        if (!row) operationResultFail("record_observations_candidate_base_missing");
        const control = projectAuthorityBranch(database, binding, mode, row);
        if (!sameBranchRef(control.manifest, base)) {
          operationResultFail("record_observations_candidate_base_invalid");
        }
        projected.push(control);
      }
    }
  }
  return projected.map(({ ref }) => ref);
}

function assertRecordObservationBranchSet(
  branches: readonly AuthorityBranchOperationRefV1[],
): void {
  const authoritative = branches.filter(
    ({ branch_kind }) => branch_kind === "authoritative",
  );
  const candidates = branches.filter(({ branch_kind }) => branch_kind === "candidate");
  if (branches.length > 2 || authoritative.length > 1
    || candidates.length > 1
    || authoritative.length + candidates.length !== branches.length
    || (authoritative.length === 1
      && (authoritative[0]!.branch_state !== "authoritative"
        || authoritative[0]!.authority_head_ref?.head_revision
          !== authoritative[0]!.branch_revision))
    || candidates.some((candidate) => candidate.branch_state !== "draft"
      || candidate.branch_revision !== 1
      || candidate.authority_head_ref !== null
      || authoritative.length !== 1
      || candidate.authority_subject_sha256
        !== authoritative[0]!.authority_subject_sha256)) {
    operationResultFail("record_observations_branch_combination");
  }
}

function assertAuthorityDecisionBranchSet(
  branches: readonly AuthorityBranchOperationRefV1[],
): void {
  if (branches.length < 1 || branches.length > 2) {
    operationResultFail("authority_decision_branch_cardinality");
  }
  if (branches.length === 1) return;
  const authoritative = branches.filter(
    (branch) => branch.branch_kind === "authoritative",
  );
  const candidates = branches.filter((branch) => branch.branch_kind === "candidate");
  if (authoritative.length !== 1 || candidates.length !== 1
    || authoritative[0]!.branch_state !== "authoritative"
    || authoritative[0]!.authority_head_ref?.head_revision
      !== authoritative[0]!.branch_revision
    || candidates[0]!.branch_state !== "merged"
    || candidates[0]!.authority_head_ref !== null
    || candidates[0]!.authority_subject_sha256
      !== authoritative[0]!.authority_subject_sha256) {
    operationResultFail("authority_decision_branch_combination");
  }
}

function durableJobCreationRefs(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
): readonly DurableJobCreationOperationRefV1[] {
  const rows = database.db.prepare(`SELECT * FROM durable_jobs WHERE
    ${scopedSourceWhere()} ORDER BY job_id`).all(
      ...scopedSourceArgs(binding),
    ) as OperationResultRow[];
  return rows.map((row) => {
    const jobKind = row.job_kind;
    if (jobKind !== "embedding" && jobKind !== "ann"
      && jobKind !== "effect" && jobKind !== "retention") {
      operationResultFail("durable_job_kind_invalid");
    }
    const payload = operationResultCanonicalJson(row.payload_json, "job_payload");
    if (canonicalContinuationSha256(payload) !== row.payload_sha256) {
      operationResultFail("durable_job_payload_digest_mismatch");
    }
    const definition = {
      schema_version: "durable_job_definition_v1",
      tenant_id: binding.tenantId,
      scope: binding.scope,
      task_family: row.task_family,
      authority_subject_sha256: row.authority_subject_sha256,
      job_id: row.job_id,
      job_kind: jobKind,
      dedupe_key: row.dedupe_key,
      source_operation: {
        operation_kind: binding.operationKind,
        operation_id: binding.operationId,
        request_sha256: binding.requestSha256,
      },
      priority: row.priority,
      max_attempts: row.max_attempts,
      payload_sha256: row.payload_sha256,
      payload,
      initial_available_at: row.initial_available_at,
      created_at: row.created_at,
    };
    return canonicalContinuationClone({
      task_family: operationResultText(row.task_family, "job_task_family"),
      authority_subject_sha256: operationResultSha256(
        row.authority_subject_sha256,
        "job_authority_subject",
      ),
      job_id: operationResultText(row.job_id, "job_id"),
      job_kind: jobKind,
      payload_sha256: operationResultSha256(row.payload_sha256, "job_payload"),
      definition_sha256: canonicalContinuationSha256(definition),
    });
  });
}

function recordObservationsResult(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
): RecordObservationsOperationResultV1 {
  const branches = authorityBranchRefs(database, binding, mode);
  assertRecordObservationBranchSet(branches);
  return canonicalContinuationClone({
    schema_version: "record_observations_result_v1" as const,
    observation_snapshot_ref: observationSnapshotRef(database, binding),
    memory_revision_ref: memoryRevisionRef(database, binding, mode),
    authority_branch_set: canonicalOperationResultSetV1(branches),
    durable_job_set: canonicalOperationResultSetV1(
      durableJobCreationRefs(database, binding),
    ),
  });
}

function authorityDecisionResult(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
): AuthorityDecisionOperationResultV1 {
  const artifacts = authorityArtifactRefs(database, binding);
  const branches = authorityBranchRefs(database, binding, mode);
  const memory = memoryRevisionRef(database, binding, mode);
  const jobs = durableJobCreationRefs(database, binding);
  if (artifacts.length === 1
    && artifacts[0]!.artifact_kind === "experiment_cohort") {
    if (branches.length !== 0 || memory !== null || jobs.length !== 1
      || jobs[0]!.job_kind !== "effect") {
      operationResultFail("experiment_cohort_install_effect_job_cardinality");
    }
    return canonicalContinuationClone({
      schema_version: "authority_decision_result_v1" as const,
      decision_kind: "experiment_cohort_install" as const,
      experiment_cohort_ref: {
        artifact_sha256: artifacts[0]!.artifact_sha256,
        payload_sha256: artifacts[0]!.payload_sha256,
      },
      effect_job_ref: {
        ...jobs[0]!,
        job_kind: "effect" as const,
      },
    });
  }
  if (artifacts.length === 0 && branches.length === 0 && memory !== null
    && jobs.length === 1 && jobs[0]!.job_kind === "retention") {
    return canonicalContinuationClone({
      schema_version: "authority_decision_result_v1" as const,
      decision_kind: "lifecycle_archive" as const,
      memory_revision_ref: memory,
      retention_job_ref: {
        ...jobs[0]!,
        job_kind: "retention" as const,
      },
    });
  }
  const mutationClassCount = Number(artifacts.length > 0)
    + Number(branches.length > 0)
    + Number(memory !== null)
    + Number(jobs.length > 0);
  if (mutationClassCount !== 1) {
    operationResultFail("authority_decision_mutation_class_cardinality");
  }
  if (artifacts.length > 0) {
    if (artifacts.length === 2
      && artifacts[0]!.artifact_kind === "compiler_policy"
      && artifacts[1]!.artifact_kind === "evidence_policy"
      && artifacts[0]!.authority_subject_sha256
        === artifacts[1]!.authority_subject_sha256) {
      return canonicalContinuationClone({
        schema_version: "authority_decision_result_v1" as const,
        decision_kind: "policy_bundle_install" as const,
        compiler_policy_ref: {
          artifact_sha256: artifacts[0]!.artifact_sha256,
          payload_sha256: artifacts[0]!.payload_sha256,
        },
        evidence_policy_ref: {
          artifact_sha256: artifacts[1]!.artifact_sha256,
          payload_sha256: artifacts[1]!.payload_sha256,
        },
      });
    }
    if (artifacts.length === 1
      && artifacts[0]!.artifact_kind === "policy_rotation") {
      return canonicalContinuationClone({
        schema_version: "authority_decision_result_v1" as const,
        decision_kind: "policy_rotation_install" as const,
        policy_rotation_artifact_ref: {
          artifact_sha256: artifacts[0]!.artifact_sha256,
          payload_sha256: artifacts[0]!.payload_sha256,
        },
      });
    }
    operationResultFail("authority_artifact_bundle_invalid");
  }
  if (branches.length > 0) {
    assertAuthorityDecisionBranchSet(branches);
    return canonicalContinuationClone({
      schema_version: "authority_decision_result_v1" as const,
      decision_kind: "branch_update" as const,
      branch_revision_set: canonicalOperationResultSetV1(branches),
    });
  }
  if (memory) {
    return canonicalContinuationClone({
      schema_version: "authority_decision_result_v1" as const,
      decision_kind: "memory_update" as const,
      memory_revision_ref: memory,
    });
  }
  return canonicalContinuationClone({
    schema_version: "authority_decision_result_v1" as const,
    decision_kind: "lifecycle_schedule" as const,
    durable_job_set: canonicalOperationResultSetV1(jobs),
  });
}

export function deriveContinuationRuntimeV1OperationResultV1(
  database: ContinuationRuntimeV1Database,
  binding: ContinuationRuntimeV1OperationResultDerivationBinding,
  mode: ContinuationRuntimeV1OperationResultDerivationMode,
  persistedResultHint?: unknown,
): ContinuationRuntimeV1OperationResultV1 {
  if (binding.operationKind === "record_observations") {
    return recordObservationsResult(database, binding, mode);
  }
  if (binding.operationKind === "create_continuation") {
    return deriveCreateContinuationOperationResultV1(database, binding);
  }
  if (binding.operationKind === "record_outcome") {
    return deriveRecordOutcomeOperationResultV1(database, binding);
  }
  if (binding.operationKind === "authority_decision") {
    return authorityDecisionResult(database, binding, mode);
  }
  return deriveWorkerCompletionOperationResultV1(
    database,
    binding,
    mode,
    persistedResultHint,
    { memoryRevisionRef, durableJobCreationRefs },
  );
}
