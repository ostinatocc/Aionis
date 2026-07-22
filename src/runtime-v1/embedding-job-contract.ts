import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type CapsuleRefV1,
  type ExecutionCapsuleV1,
  type Sha256,
} from "../continuation/contract.js";
import { assertExecutionCapsuleV1 } from "../continuation/validation.js";

export const CONTINUATION_RUNTIME_V1_EMBEDDING_JOB_MAX_CAPSULES = 64;

export type ContinuationRuntimeV1EmbeddingJobPayloadV1 = Readonly<{
  schema_version: "embedding_job_payload_v1";
  capsule_refs: readonly CapsuleRefV1[];
}>;

export type ContinuationRuntimeV1EmbeddingDocumentV1 = Readonly<{
  schema_version: "embedding_document_v1";
  capsule_ref: CapsuleRefV1;
  source_projection_sha256: Sha256;
  semantic_projection: Readonly<{
    kind: ExecutionCapsuleV1["kind"];
    proposed_influence: ExecutionCapsuleV1["proposed_influence"];
    applicability: ExecutionCapsuleV1["applicability"];
    projection: ExecutionCapsuleV1["projection"];
  }>;
}>;

/** Pure structural view of the rebuildable sidecar's content-addressed ref. */
export type ContinuationRuntimeV1EmbeddingVectorArtifactRefV1 = Readonly<{
  schema_version: "vector_artifact_ref_v1";
  source_projection_sha256: Sha256;
  embedding_document_sha256: Sha256;
  model: string;
  dimensions: number;
  vector_sha256: Sha256;
  artifact_sha256: Sha256;
}>;

export type ContinuationRuntimeV1EmbeddingArtifactMemberRefV1 = Readonly<{
  capsule_ref: CapsuleRefV1;
  embedding_document_sha256: Sha256;
  vector_artifact_ref: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1;
}>;

export type ContinuationRuntimeV1EmbeddingArtifactSetRefV1 = Readonly<{
  schema_version: "embedding_artifact_set_ref_v1";
  artifacts: readonly ContinuationRuntimeV1EmbeddingArtifactMemberRefV1[];
  artifact_set_sha256: Sha256;
}>;

export type ContinuationRuntimeV1AnnJobPayloadV1 = Readonly<{
  schema_version: "ann_job_payload_v1";
  embedding_artifact_set_ref: ContinuationRuntimeV1EmbeddingArtifactSetRefV1;
}>;

export type ContinuationRuntimeV1EmbeddingJobContractErrorCode =
  | "capsule_ref_invalid"
  | "embedding_payload_invalid"
  | "embedding_document_invalid"
  | "vector_artifact_ref_invalid"
  | "embedding_artifact_set_invalid"
  | "ann_payload_invalid";

export class ContinuationRuntimeV1EmbeddingJobContractError extends Error {
  constructor(readonly code: ContinuationRuntimeV1EmbeddingJobContractErrorCode) {
    super(`continuation_runtime_v1_embedding_job_contract_${code}`);
    this.name = "ContinuationRuntimeV1EmbeddingJobContractError";
  }
}

const CAPSULE_REF_KEYS = Object.freeze([
  "capsule_id", "capsule_revision", "capsule_sha256",
] as const);
const EMBEDDING_PAYLOAD_KEYS = Object.freeze([
  "capsule_refs", "schema_version",
] as const);
const DOCUMENT_KEYS = Object.freeze([
  "capsule_ref", "schema_version", "semantic_projection",
  "source_projection_sha256",
] as const);
const SEMANTIC_KEYS = Object.freeze([
  "applicability", "kind", "projection", "proposed_influence",
] as const);
const APPLICABILITY_KEYS = Object.freeze([
  "owner_agent_id", "owner_team_id", "producer_agent_id", "scope",
  "task_family", "task_signature", "tenant_id", "workflow_signature",
  "workspace_signature",
] as const);
const PROJECTION_KEYS = Object.freeze([
  "acceptance_statements", "next_action", "projection_sha256", "summary",
  "target_refs", "workflow_steps",
] as const);
const TARGET_REF_KEYS = Object.freeze(["kind", "ref"] as const);
const VECTOR_REF_KEYS = Object.freeze([
  "artifact_sha256", "dimensions", "embedding_document_sha256", "model",
  "schema_version", "source_projection_sha256", "vector_sha256",
] as const);
const MEMBER_KEYS = Object.freeze([
  "capsule_ref", "embedding_document_sha256", "vector_artifact_ref",
] as const);
const SET_KEYS = Object.freeze([
  "artifact_set_sha256", "artifacts", "schema_version",
] as const);
const ANN_PAYLOAD_KEYS = Object.freeze([
  "embedding_artifact_set_ref", "schema_version",
] as const);
const CAPSULE_KINDS = new Set<string>([
  "current_state", "verified_fact", "procedure", "constraint",
  "counter_evidence", "rehydration_pointer",
]);
const INFLUENCES = new Set<string>(["use", "inspect", "block", "rehydrate"]);
const TARGET_KINDS = new Set<string>([
  "artifact", "service", "capability", "memory", "workflow",
  "external_resource",
]);

function fail(code: ContinuationRuntimeV1EmbeddingJobContractErrorCode): never {
  throw new ContinuationRuntimeV1EmbeddingJobContractError(code);
}

function wrap<T>(
  code: ContinuationRuntimeV1EmbeddingJobContractErrorCode,
  operation: () => T,
): T {
  try { return operation(); } catch (error) {
    if (error instanceof ContinuationRuntimeV1EmbeddingJobContractError
      && error.code === code) throw error;
    fail(code);
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) throw new Error("record_invalid");
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new Error("record_invalid");
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("record_invalid");
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) {
    throw new Error("array_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) throw new Error("array_invalid");
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("array_invalid");
    }
    out.push(descriptor.value);
  }
  return out;
}

function text(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error("text_invalid");
  assertUnicodeScalarString(value, "embedding job contract text");
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error("text_invalid");
  }
  return value;
}

function nullableText(value: unknown, maximumBytes: number): string | null {
  return value === null ? null : text(value, maximumBytes);
}

function sha256(value: unknown): Sha256 {
  if (typeof value !== "string") throw new Error("sha256_invalid");
  assertSha256(value, "embedding job contract digest");
  return value;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > maximum) throw new Error("integer_invalid");
  return value as number;
}

function refKey(value: CapsuleRefV1): string {
  return canonicalContinuationJson(value);
}

export function parseContinuationRuntimeV1CapsuleRef(
  value: unknown,
): CapsuleRefV1 {
  return wrap("capsule_ref_invalid", () => {
    const record = exactRecord(value, CAPSULE_REF_KEYS);
    return canonicalContinuationClone({
      capsule_id: text(record.capsule_id, 256),
      capsule_revision: positiveInteger(record.capsule_revision),
      capsule_sha256: sha256(record.capsule_sha256),
    });
  });
}

export function continuationRuntimeV1CapsuleRef(
  capsule: ExecutionCapsuleV1,
): CapsuleRefV1 {
  return parseContinuationRuntimeV1CapsuleRef({
    capsule_id: capsule.capsule_id,
    capsule_revision: capsule.capsule_revision,
    capsule_sha256: capsule.capsule_sha256,
  });
}

function canonicalRefs(values: readonly unknown[]): readonly CapsuleRefV1[] {
  const refs = values.map(parseContinuationRuntimeV1CapsuleRef);
  for (let index = 1; index < refs.length; index += 1) {
    if (compareCanonicalUtf8(refKey(refs[index - 1]!), refKey(refs[index]!)) >= 0) {
      throw new Error("refs_not_canonical_unique");
    }
  }
  return Object.freeze(refs);
}

export function parseContinuationRuntimeV1EmbeddingJobPayload(
  value: unknown,
): ContinuationRuntimeV1EmbeddingJobPayloadV1 {
  return wrap("embedding_payload_invalid", () => {
    const record = exactRecord(value, EMBEDDING_PAYLOAD_KEYS);
    if (record.schema_version !== "embedding_job_payload_v1") {
      throw new Error("schema_invalid");
    }
    return canonicalContinuationClone({
      schema_version: "embedding_job_payload_v1" as const,
      capsule_refs: canonicalRefs(denseArray(
        record.capsule_refs,
        1,
        CONTINUATION_RUNTIME_V1_EMBEDDING_JOB_MAX_CAPSULES,
      )),
    });
  });
}

export function buildContinuationRuntimeV1EmbeddingJobPayload(
  values: readonly CapsuleRefV1[],
): ContinuationRuntimeV1EmbeddingJobPayloadV1 {
  return wrap("embedding_payload_invalid", () => {
    const sorted = values.map(parseContinuationRuntimeV1CapsuleRef).sort(
      (left, right) => compareCanonicalUtf8(refKey(left), refKey(right)),
    );
    return parseContinuationRuntimeV1EmbeddingJobPayload({
      schema_version: "embedding_job_payload_v1",
      capsule_refs: sorted,
    });
  });
}

function targetRef(value: unknown) {
  const record = exactRecord(value, TARGET_REF_KEYS);
  if (!TARGET_KINDS.has(record.kind as string)) throw new Error("target_kind_invalid");
  return { kind: record.kind as ExecutionCapsuleV1["projection"]["target_refs"][number]["kind"],
    ref: text(record.ref, 1_024) };
}

function semanticProjection(value: unknown) {
  const semantic = exactRecord(value, SEMANTIC_KEYS);
  if (!CAPSULE_KINDS.has(semantic.kind as string)
    || !INFLUENCES.has(semantic.proposed_influence as string)) {
    throw new Error("semantic_enum_invalid");
  }
  const applicability = exactRecord(semantic.applicability, APPLICABILITY_KEYS);
  const checkedApplicability: ExecutionCapsuleV1["applicability"] = {
    tenant_id: text(applicability.tenant_id, 256),
    scope: text(applicability.scope, 256),
    task_family: text(applicability.task_family, 256),
    task_signature: nullableText(applicability.task_signature, 256),
    workflow_signature: nullableText(applicability.workflow_signature, 256),
    workspace_signature: nullableText(applicability.workspace_signature, 256),
    producer_agent_id: nullableText(applicability.producer_agent_id, 256),
    owner_agent_id: nullableText(applicability.owner_agent_id, 256),
    owner_team_id: nullableText(applicability.owner_team_id, 256),
  };
  const projection = exactRecord(semantic.projection, PROJECTION_KEYS);
  const targets = denseArray(projection.target_refs, 0, 16).map(targetRef);
  const targetKeys = targets.map((item) => canonicalContinuationJson(item));
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error("targets_duplicate");
  const steps = denseArray(projection.workflow_steps, 0, 32)
    .map((entry) => text(entry, 512));
  const acceptance = denseArray(projection.acceptance_statements, 0, 32)
    .map((entry) => text(entry, 1_024));
  const checkedProjection: ExecutionCapsuleV1["projection"] = {
    summary: text(projection.summary, 2_048),
    next_action: nullableText(projection.next_action, 1_024),
    target_refs: targets,
    workflow_steps: steps,
    acceptance_statements: acceptance,
    projection_sha256: sha256(projection.projection_sha256),
  };
  const { projection_sha256: projectionSha256, ...projectionBody } = checkedProjection;
  if (canonicalContinuationSha256(projectionBody) !== projectionSha256) {
    throw new Error("projection_digest_invalid");
  }
  return {
    kind: semantic.kind as ExecutionCapsuleV1["kind"],
    proposed_influence: semantic.proposed_influence as
      ExecutionCapsuleV1["proposed_influence"],
    applicability: checkedApplicability,
    projection: checkedProjection,
  };
}

export function parseContinuationRuntimeV1EmbeddingDocument(
  value: unknown,
): ContinuationRuntimeV1EmbeddingDocumentV1 {
  return wrap("embedding_document_invalid", () => {
    const record = exactRecord(value, DOCUMENT_KEYS);
    if (record.schema_version !== "embedding_document_v1") {
      throw new Error("schema_invalid");
    }
    return canonicalContinuationClone({
      schema_version: "embedding_document_v1" as const,
      capsule_ref: parseContinuationRuntimeV1CapsuleRef(record.capsule_ref),
      source_projection_sha256: sha256(record.source_projection_sha256),
      semantic_projection: semanticProjection(record.semantic_projection),
    });
  });
}

export function buildContinuationRuntimeV1EmbeddingDocument(
  capsule: ExecutionCapsuleV1,
): ContinuationRuntimeV1EmbeddingDocumentV1 {
  return wrap("embedding_document_invalid", () => {
    assertExecutionCapsuleV1(capsule);
    const { capsule_sha256: capsuleSha256, ...body } = capsule;
    if (canonicalContinuationSha256(body) !== capsuleSha256) {
      throw new Error("capsule_digest_invalid");
    }
    return parseContinuationRuntimeV1EmbeddingDocument({
      schema_version: "embedding_document_v1",
      capsule_ref: continuationRuntimeV1CapsuleRef(capsule),
      source_projection_sha256: capsule.source.source_projection_sha256,
      semantic_projection: {
        kind: capsule.kind,
        proposed_influence: capsule.proposed_influence,
        applicability: capsule.applicability,
        projection: capsule.projection,
      },
    });
  });
}

export function continuationRuntimeV1EmbeddingDocumentSha256(
  document: ContinuationRuntimeV1EmbeddingDocumentV1,
): Sha256 {
  return canonicalContinuationSha256(
    parseContinuationRuntimeV1EmbeddingDocument(document),
  );
}

export function parseContinuationRuntimeV1EmbeddingVectorArtifactRef(
  value: unknown,
): ContinuationRuntimeV1EmbeddingVectorArtifactRefV1 {
  return wrap("vector_artifact_ref_invalid", () => {
    const record = exactRecord(value, VECTOR_REF_KEYS);
    if (record.schema_version !== "vector_artifact_ref_v1") {
      throw new Error("schema_invalid");
    }
    return canonicalContinuationClone({
      schema_version: "vector_artifact_ref_v1" as const,
      source_projection_sha256: sha256(record.source_projection_sha256),
      embedding_document_sha256: sha256(record.embedding_document_sha256),
      model: text(record.model, 256),
      dimensions: positiveInteger(record.dimensions, 65_536),
      vector_sha256: sha256(record.vector_sha256),
      artifact_sha256: sha256(record.artifact_sha256),
    });
  });
}

function artifactMember(value: unknown): ContinuationRuntimeV1EmbeddingArtifactMemberRefV1 {
  const record = exactRecord(value, MEMBER_KEYS);
  const documentSha256 = sha256(record.embedding_document_sha256);
  const vectorRef = parseContinuationRuntimeV1EmbeddingVectorArtifactRef(
    record.vector_artifact_ref,
  );
  if (vectorRef.embedding_document_sha256 !== documentSha256) {
    throw new Error("document_vector_binding_invalid");
  }
  return canonicalContinuationClone({
    capsule_ref: parseContinuationRuntimeV1CapsuleRef(record.capsule_ref),
    embedding_document_sha256: documentSha256,
    vector_artifact_ref: vectorRef,
  });
}

export function parseContinuationRuntimeV1EmbeddingArtifactSetRef(
  value: unknown,
): ContinuationRuntimeV1EmbeddingArtifactSetRefV1 {
  return wrap("embedding_artifact_set_invalid", () => {
    const record = exactRecord(value, SET_KEYS);
    if (record.schema_version !== "embedding_artifact_set_ref_v1") {
      throw new Error("schema_invalid");
    }
    const artifacts = denseArray(
      record.artifacts,
      1,
      CONTINUATION_RUNTIME_V1_EMBEDDING_JOB_MAX_CAPSULES,
    ).map(artifactMember);
    for (let index = 1; index < artifacts.length; index += 1) {
      if (compareCanonicalUtf8(
        refKey(artifacts[index - 1]!.capsule_ref),
        refKey(artifacts[index]!.capsule_ref),
      ) >= 0) throw new Error("artifacts_not_canonical_unique");
    }
    const body = canonicalContinuationClone({
      schema_version: "embedding_artifact_set_ref_v1" as const,
      artifacts,
    });
    const artifactSetSha256 = sha256(record.artifact_set_sha256);
    if (canonicalContinuationSha256(body) !== artifactSetSha256) {
      throw new Error("set_digest_invalid");
    }
    return canonicalContinuationClone({
      ...body,
      artifact_set_sha256: artifactSetSha256,
    });
  });
}

export function buildContinuationRuntimeV1EmbeddingArtifactSetRef(
  values: readonly ContinuationRuntimeV1EmbeddingArtifactMemberRefV1[],
): ContinuationRuntimeV1EmbeddingArtifactSetRefV1 {
  return wrap("embedding_artifact_set_invalid", () => {
    const artifacts = values.map(artifactMember).sort((left, right) =>
      compareCanonicalUtf8(refKey(left.capsule_ref), refKey(right.capsule_ref)));
    const body = canonicalContinuationClone({
      schema_version: "embedding_artifact_set_ref_v1" as const,
      artifacts,
    });
    return parseContinuationRuntimeV1EmbeddingArtifactSetRef({
      ...body,
      artifact_set_sha256: canonicalContinuationSha256(body),
    });
  });
}

export function parseContinuationRuntimeV1AnnJobPayload(
  value: unknown,
): ContinuationRuntimeV1AnnJobPayloadV1 {
  return wrap("ann_payload_invalid", () => {
    const record = exactRecord(value, ANN_PAYLOAD_KEYS);
    if (record.schema_version !== "ann_job_payload_v1") {
      throw new Error("schema_invalid");
    }
    return canonicalContinuationClone({
      schema_version: "ann_job_payload_v1" as const,
      embedding_artifact_set_ref:
        parseContinuationRuntimeV1EmbeddingArtifactSetRef(
          record.embedding_artifact_set_ref,
        ),
    });
  });
}

export function buildContinuationRuntimeV1AnnJobPayload(
  artifactSetRef: ContinuationRuntimeV1EmbeddingArtifactSetRefV1,
): ContinuationRuntimeV1AnnJobPayloadV1 {
  return parseContinuationRuntimeV1AnnJobPayload({
    schema_version: "ann_job_payload_v1",
    embedding_artifact_set_ref: artifactSetRef,
  });
}
