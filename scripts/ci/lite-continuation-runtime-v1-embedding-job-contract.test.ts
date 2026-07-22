import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildExecutionCapsuleV1 } from "../../src/continuation/capsule.js";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CapsuleRefV1,
  type Sha256,
} from "../../src/continuation/contract.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import { buildWorkerCompletionCommandV1 } from
  "../../src/runtime-v1/command.js";
import {
  CONTINUATION_RUNTIME_V1_EMBEDDING_JOB_MAX_CAPSULES,
  buildContinuationRuntimeV1AnnJobPayload,
  buildContinuationRuntimeV1EmbeddingArtifactSetRef,
  buildContinuationRuntimeV1EmbeddingDocument,
  buildContinuationRuntimeV1EmbeddingJobPayload,
  continuationRuntimeV1CapsuleRef,
  continuationRuntimeV1EmbeddingDocumentSha256,
  parseContinuationRuntimeV1AnnJobPayload,
  parseContinuationRuntimeV1EmbeddingArtifactSetRef,
  parseContinuationRuntimeV1EmbeddingDocument,
  parseContinuationRuntimeV1EmbeddingJobPayload,
  type ContinuationRuntimeV1EmbeddingArtifactMemberRefV1,
} from "../../src/runtime-v1/embedding-job-contract.js";

const SHA_A = "a".repeat(64) as Sha256;
const SHA_B = "b".repeat(64) as Sha256;
const SHA_C = "c".repeat(64) as Sha256;

function capsule() {
  return buildExecutionCapsuleV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    capsule_revision: 1,
    parent_capsule_sha256: null,
    source: {
      memory_id: "memory-a",
      source_commit_id: "commit-a",
      source_projection_sha256: SHA_A,
    },
    draft: {
      capsule_id: "capsule-a",
      created_at: "2026-07-22T00:00:00.000Z",
      kind: "procedure",
      proposed_influence: "inspect",
      applicability: {
        task_family: "repair",
        task_signature: "task-a",
        workflow_signature: null,
        workspace_signature: "workspace-a",
        producer_agent_id: "producer-a",
        owner_agent_id: null,
        owner_team_id: "team-a",
      },
      projection: {
        summary: "Inspect the immutable authority state.",
        next_action: "Verify the recorded authority state.",
        target_refs: [{ kind: "memory", ref: "memory-a" }],
        workflow_steps: ["Read the state.", "Verify its digest."],
        acceptance_statements: ["The state digest matches."],
      },
      coverage_claims: [{
        obligation_kind: "required_state",
        target_refs: [{ kind: "memory", ref: "memory-a" }],
        evidence_requirement: "runtime_state",
        required_probe_ids: [],
      }],
      precondition_specs: [],
      evidence_refs: [],
      verifier_refs: [],
      conflicts_with: [],
      supersedes: [],
      expires_at: "2026-07-23T00:00:00.000Z",
    },
  });
}

function ref(index: number): CapsuleRefV1 {
  return {
    capsule_id: `capsule-${String(index).padStart(2, "0")}`,
    capsule_revision: 1,
    capsule_sha256: index.toString(16).padStart(64, "0") as Sha256,
  };
}

function member(
  capsuleRef: CapsuleRefV1,
  documentSha256: Sha256,
  index: number,
): ContinuationRuntimeV1EmbeddingArtifactMemberRefV1 {
  return {
    capsule_ref: capsuleRef,
    embedding_document_sha256: documentSha256,
    vector_artifact_ref: {
      schema_version: "vector_artifact_ref_v1",
      source_projection_sha256: SHA_A,
      embedding_document_sha256: documentSha256,
      model: "embedding-model-v1",
      dimensions: 1_536,
      vector_sha256: (index + 100).toString(16).padStart(64, "0") as Sha256,
      artifact_sha256: (index + 200).toString(16).padStart(64, "0") as Sha256,
    },
  };
}

function thrown(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("operation unexpectedly succeeded");
}

test("pure embedding payload contract sorts immutable refs and rejects every non-canonical surface", () => {
  const refs = Array.from(
    { length: CONTINUATION_RUNTIME_V1_EMBEDDING_JOB_MAX_CAPSULES },
    (_, index) => ref(index + 1),
  );
  const payload = buildContinuationRuntimeV1EmbeddingJobPayload([...refs].reverse());
  assert.deepEqual(payload.capsule_refs, refs);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.capsule_refs), true);
  assert.deepEqual(parseContinuationRuntimeV1EmbeddingJobPayload(payload), payload);

  for (const invalid of [
    { ...payload, capsule_refs: [...payload.capsule_refs].reverse() },
    { ...payload, capsule_refs: [payload.capsule_refs[0], payload.capsule_refs[0]] },
    { ...payload, capsule_refs: [...payload.capsule_refs, ref(65)] },
    { ...payload, capsule_refs: [] },
    { ...payload, injected_source: "must-not-be-accepted" },
  ]) {
    const error = thrown(() => parseContinuationRuntimeV1EmbeddingJobPayload(invalid));
    assert.equal(error.message,
      "continuation_runtime_v1_embedding_job_contract_embedding_payload_invalid");
  }
});

test("embedding document is the sole canonical semantic input and its digest binds the sidecar ref", () => {
  const current = capsule();
  const document = buildContinuationRuntimeV1EmbeddingDocument(current);
  assert.deepEqual(document.capsule_ref, continuationRuntimeV1CapsuleRef(current));
  assert.deepEqual(parseContinuationRuntimeV1EmbeddingDocument(document), document);
  const documentSha256 = continuationRuntimeV1EmbeddingDocumentSha256(document);
  assert.equal(documentSha256, canonicalContinuationSha256(document));

  const set = buildContinuationRuntimeV1EmbeddingArtifactSetRef([
    member(document.capsule_ref, documentSha256, 1),
  ]);
  assert.equal(
    set.artifacts[0]!.vector_artifact_ref.embedding_document_sha256,
    documentSha256,
  );
  assert.deepEqual(parseContinuationRuntimeV1EmbeddingArtifactSetRef(set), set);
  const ann = buildContinuationRuntimeV1AnnJobPayload(set);
  assert.deepEqual(parseContinuationRuntimeV1AnnJobPayload(ann), ann);

  const tampered = structuredClone(set) as {
    schema_version: "embedding_artifact_set_ref_v1";
    artifacts: Array<{
      capsule_ref: CapsuleRefV1;
      embedding_document_sha256: Sha256;
      vector_artifact_ref: {
        schema_version: "vector_artifact_ref_v1";
        source_projection_sha256: Sha256;
        embedding_document_sha256: Sha256;
        model: string;
        dimensions: number;
        vector_sha256: Sha256;
        artifact_sha256: Sha256;
      };
    }>;
    artifact_set_sha256: Sha256;
  };
  tampered.artifacts[0]!.vector_artifact_ref.embedding_document_sha256 = SHA_B;
  tampered.artifact_set_sha256 = canonicalContinuationSha256({
    schema_version: tampered.schema_version,
    artifacts: tampered.artifacts,
  });
  assert.throws(
    () => parseContinuationRuntimeV1EmbeddingArtifactSetRef(tampered),
    /embedding_artifact_set_invalid/u,
  );
});

test("the exact 64-member artifact set fits the worker command without a second hidden limit", () => {
  const refs = Array.from(
    { length: CONTINUATION_RUNTIME_V1_EMBEDDING_JOB_MAX_CAPSULES },
    (_, index) => ref(index + 1),
  );
  const members = refs.map((value, index) => member(
    value,
    (index + 300).toString(16).padStart(64, "0") as Sha256,
    index,
  ));
  const artifactSet = buildContinuationRuntimeV1EmbeddingArtifactSetRef(members);
  assert.equal(artifactSet.artifacts.length, 64);
  assert.ok(Buffer.byteLength(canonicalContinuationJson(artifactSet), "utf8") > 4_096);

  const command = buildWorkerCompletionCommandV1("complete-embedding-64", {
    schema_version: "worker_completion_body_v1",
    completion: {
      status: "succeeded",
      output: { kind: "embedding", artifact_ref: artifactSet },
    },
  }, {
    tenant_id: "tenant-a",
    scope: "scope-a",
    actor_kind: "worker",
    actor_principal_sha256: SHA_A,
    task_family: "repair",
    authority_subject_sha256: continuationAuthoritySubjectSha256V1({
      tenant_id: "tenant-a",
      scope: "scope-a",
      task_family: "repair",
    }),
    job_id: "embedding-job-a",
    job_kind: "embedding",
    job_payload_sha256: SHA_B,
    attempt_count: 1,
    lease_token_sha256: SHA_C,
  });
  assert.equal(command.body.completion.status, "succeeded");
});

test("the pure contract has no provider, sidecar, worker-service, or store dependency", () => {
  const source = readFileSync(new URL(
    "../../src/runtime-v1/embedding-job-contract.ts",
    import.meta.url,
  ), "utf8");
  for (const forbidden of [
    "embedding-provider",
    "vector-artifact-store",
    "worker-service",
    "../store/",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
