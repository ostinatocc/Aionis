import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type CapsuleRefV1,
  type Sha256,
} from "../continuation/contract.js";
import {
  parseContinuationRuntimeV1EmbeddingArtifactSetRef,
  parseContinuationRuntimeV1EmbeddingVectorArtifactRef,
  parseContinuationRuntimeV1CapsuleRef,
  type ContinuationRuntimeV1EmbeddingArtifactSetRefV1,
  type ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
} from "./embedding-job-contract.js";

const ROOT_MODE = 0o700;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_MEMBERS = 64;
const MAX_DIMENSIONS = 65_536;
const MAX_METADATA_BYTES = 262_144;
const MAX_VECTOR_BYTES = MAX_MEMBERS * MAX_DIMENSIONS * 4;
const STORE_KEYS = Object.freeze(["rootPath"] as const);
const WRITE_KEYS = Object.freeze([
  "embedding_artifact_set_ref", "schema_version", "vectors",
] as const);
const VECTOR_MEMBER_KEYS = Object.freeze(["vector", "vector_artifact_ref"] as const);
const SEGMENT_REF_KEYS = Object.freeze([
  "artifact_set_sha256", "dimensions", "member_count", "member_set_sha256",
  "model", "schema_version", "segment_ref_sha256", "segment_sha256",
  "vectors_byte_length", "vectors_sha256",
] as const);
const RECEIPT_KEYS = Object.freeze([
  "artifact_set_sha256", "receipt_sha256", "schema_version", "segment_ref",
  "source_job_payload_sha256",
] as const);
const METADATA_KEYS = Object.freeze([
  "artifact_set_sha256", "dimensions", "encoding_format", "member_count",
  "member_set_sha256", "members", "model", "schema_version",
  "segment_sha256", "vectors_byte_length", "vectors_sha256",
] as const);
const METADATA_MEMBER_KEYS = Object.freeze([
  "capsule_ref", "embedding_document_sha256", "vector_artifact_ref",
  "vector_byte_length", "vector_offset_bytes",
] as const);
const DISCOVERY_KEYS = Object.freeze(["capsule_refs", "scan_limit"] as const);
const SHA = /^[0-9a-f]{64}$/u;
const SHARD = /^[0-9a-f]{2}$/u;
const TEMP_ENTRY = /^\.(?:tmp|delete)-[0-9a-f]{64}-[0-9a-f]{24}$/u;

export type ContinuationRuntimeV1AnnIndexSegmentErrorCode =
  | "configuration_invalid"
  | "input_invalid"
  | "path_invalid"
  | "symlink_forbidden"
  | "io_failure"
  | "segment_conflict"
  | "segment_tampered"
  | "scan_limit_exceeded";

export class ContinuationRuntimeV1AnnIndexSegmentError extends Error {
  constructor(readonly code: ContinuationRuntimeV1AnnIndexSegmentErrorCode) {
    super(`continuation_runtime_v1_ann_index_segment_${code}`);
    this.name = "ContinuationRuntimeV1AnnIndexSegmentError";
  }
}

export type ContinuationRuntimeV1AnnIndexVectorInputV1 = Readonly<{
  vector_artifact_ref: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1;
  vector: readonly number[];
}>;

export type ContinuationRuntimeV1AnnIndexSegmentWriteInputV1 = Readonly<{
  schema_version: "ann_index_segment_write_v1";
  embedding_artifact_set_ref: ContinuationRuntimeV1EmbeddingArtifactSetRefV1;
  vectors: readonly ContinuationRuntimeV1AnnIndexVectorInputV1[];
}>;

export type ContinuationRuntimeV1AnnIndexSegmentRefV1 = Readonly<{
  schema_version: "ann_index_segment_ref_v1";
  artifact_set_sha256: Sha256;
  model: string;
  dimensions: number;
  member_count: number;
  member_set_sha256: Sha256;
  vectors_byte_length: number;
  vectors_sha256: Sha256;
  segment_sha256: Sha256;
  segment_ref_sha256: Sha256;
}>;

export type ContinuationRuntimeV1AnnIndexReceiptV1 = Readonly<{
  schema_version: "ann_index_receipt_v1";
  source_job_payload_sha256: Sha256;
  artifact_set_sha256: Sha256;
  segment_ref: ContinuationRuntimeV1AnnIndexSegmentRefV1;
  receipt_sha256: Sha256;
}>;

export type ContinuationRuntimeV1AnnIndexSegmentReadResultV1 = Readonly<{
  schema_version: "ann_index_segment_read_v1";
  ref: ContinuationRuntimeV1AnnIndexSegmentRefV1;
}>;

export type ContinuationRuntimeV1AnnIndexSegmentDiscoveryInputV1 = Readonly<{
  capsule_refs: readonly CapsuleRefV1[];
  scan_limit: number;
}>;

export type ContinuationRuntimeV1AnnIndexSegmentStore = Readonly<{
  write(
    input: ContinuationRuntimeV1AnnIndexSegmentWriteInputV1,
  ): Promise<ContinuationRuntimeV1AnnIndexSegmentRefV1>;
  read(
    ref: ContinuationRuntimeV1AnnIndexSegmentRefV1,
  ): Promise<ContinuationRuntimeV1AnnIndexSegmentReadResultV1 | null>;
  delete(ref: ContinuationRuntimeV1AnnIndexSegmentRefV1): Promise<boolean>;
  discoverByCapsuleRefs(
    input: ContinuationRuntimeV1AnnIndexSegmentDiscoveryInputV1,
  ): Promise<readonly ContinuationRuntimeV1AnnIndexSegmentRefV1[]>;
}>;

type ParsedWrite = Readonly<{
  artifactSet: ContinuationRuntimeV1EmbeddingArtifactSetRefV1;
  model: string;
  dimensions: number;
  vectors: readonly (readonly number[])[];
}>;

type SegmentMetadataMember = Readonly<{
  capsule_ref: ContinuationRuntimeV1EmbeddingArtifactSetRefV1["artifacts"][number]["capsule_ref"];
  embedding_document_sha256: Sha256;
  vector_artifact_ref: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1;
  vector_offset_bytes: number;
  vector_byte_length: number;
}>;

type SegmentMetadata = Readonly<{
  schema_version: "ann_index_segment_metadata_v1";
  artifact_set_sha256: Sha256;
  model: string;
  dimensions: number;
  encoding_format: "float32_le";
  member_count: number;
  member_set_sha256: Sha256;
  members: readonly SegmentMetadataMember[];
  vectors_byte_length: number;
  vectors_sha256: Sha256;
  segment_sha256: Sha256;
}>;

function fail(code: ContinuationRuntimeV1AnnIndexSegmentErrorCode): never {
  throw new ContinuationRuntimeV1AnnIndexSegmentError(code);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: ContinuationRuntimeV1AnnIndexSegmentErrorCode,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) fail(code);
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !expected.has(key))) fail(code);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(
  value: unknown,
  minimum: number,
  maximum: number,
  code: ContinuationRuntimeV1AnnIndexSegmentErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) fail(code);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function sha256(
  value: unknown,
  code: ContinuationRuntimeV1AnnIndexSegmentErrorCode,
): Sha256 {
  if (typeof value !== "string") fail(code);
  try { assertSha256(value, "ANN index segment digest"); } catch { fail(code); }
  return value;
}

function positiveInteger(
  value: unknown,
  maximum: number,
  code: ContinuationRuntimeV1AnnIndexSegmentErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > maximum) fail(code);
  return value as number;
}

function nonNegativeInteger(
  value: unknown,
  maximum: number,
  code: ContinuationRuntimeV1AnnIndexSegmentErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > maximum) fail(code);
  return value as number;
}

function denseVector(value: unknown, expected: number): readonly number[] {
  const entries = denseArray(value, expected, expected, "input_invalid");
  return Object.freeze(entries.map((component) => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      fail("input_invalid");
    }
    const quantized = Math.fround(component);
    if (!Number.isFinite(quantized)) fail("input_invalid");
    return quantized;
  }));
}

function vectorBinary(values: readonly number[]): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    bytes.writeFloatLE(values[index]!, index * 4);
  }
  return bytes;
}

function vectorRefSelfDigest(
  ref: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "vector_artifact_metadata_v1",
    source_projection_sha256: ref.source_projection_sha256,
    embedding_document_sha256: ref.embedding_document_sha256,
    model: ref.model,
    dimensions: ref.dimensions,
    encoding_format: "float32_le",
    vector_byte_length: ref.dimensions * 4,
    vector_sha256: ref.vector_sha256,
  });
}

function parseWrite(value: ContinuationRuntimeV1AnnIndexSegmentWriteInputV1): ParsedWrite {
  try {
    const record = exactRecord(value, WRITE_KEYS, "input_invalid");
    if (record.schema_version !== "ann_index_segment_write_v1") fail("input_invalid");
    const artifactSet = parseContinuationRuntimeV1EmbeddingArtifactSetRef(
      record.embedding_artifact_set_ref,
    );
    const vectorEntries = denseArray(
      record.vectors,
      artifactSet.artifacts.length,
      artifactSet.artifacts.length,
      "input_invalid",
    );
    let model: string | null = null;
    let dimensions: number | null = null;
    const vectors = vectorEntries.map((entry, index) => {
      const vectorRecord = exactRecord(entry, VECTOR_MEMBER_KEYS, "input_invalid");
      const ref = parseContinuationRuntimeV1EmbeddingVectorArtifactRef(
        vectorRecord.vector_artifact_ref,
      );
      const expected = artifactSet.artifacts[index]!.vector_artifact_ref;
      if (canonicalContinuationJson(ref) !== canonicalContinuationJson(expected)
        || ref.embedding_document_sha256
          !== artifactSet.artifacts[index]!.embedding_document_sha256
        || vectorRefSelfDigest(ref) !== ref.artifact_sha256) fail("input_invalid");
      if (model === null) {
        model = ref.model;
        dimensions = ref.dimensions;
      } else if (model !== ref.model || dimensions !== ref.dimensions) {
        fail("input_invalid");
      }
      const vector = denseVector(vectorRecord.vector, ref.dimensions);
      const binary = vectorBinary(vector);
      try {
        if (createHash("sha256").update(binary).digest("hex") !== ref.vector_sha256) {
          fail("input_invalid");
        }
      } finally { binary.fill(0); }
      return vector;
    });
    if (model === null || dimensions === null) fail("input_invalid");
    return Object.freeze({
      artifactSet,
      model,
      dimensions,
      vectors: Object.freeze(vectors),
    });
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1AnnIndexSegmentError) throw error;
    fail("input_invalid");
  }
}

function memberSetSha256(
  artifactSet: ContinuationRuntimeV1EmbeddingArtifactSetRefV1,
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "ann_index_member_set_v1",
    artifacts: artifactSet.artifacts,
  });
}

function metadataBody(metadata: Omit<SegmentMetadata, "segment_sha256">) {
  return {
    schema_version: metadata.schema_version,
    artifact_set_sha256: metadata.artifact_set_sha256,
    model: metadata.model,
    dimensions: metadata.dimensions,
    encoding_format: metadata.encoding_format,
    member_count: metadata.member_count,
    member_set_sha256: metadata.member_set_sha256,
    members: metadata.members,
    vectors_byte_length: metadata.vectors_byte_length,
    vectors_sha256: metadata.vectors_sha256,
  };
}

function segmentRefBody(
  ref: Omit<ContinuationRuntimeV1AnnIndexSegmentRefV1, "segment_ref_sha256">,
) {
  return {
    schema_version: ref.schema_version,
    artifact_set_sha256: ref.artifact_set_sha256,
    model: ref.model,
    dimensions: ref.dimensions,
    member_count: ref.member_count,
    member_set_sha256: ref.member_set_sha256,
    vectors_byte_length: ref.vectors_byte_length,
    vectors_sha256: ref.vectors_sha256,
    segment_sha256: ref.segment_sha256,
  };
}

function receiptBody(
  receipt: Omit<ContinuationRuntimeV1AnnIndexReceiptV1, "receipt_sha256">,
) {
  return {
    schema_version: receipt.schema_version,
    source_job_payload_sha256: receipt.source_job_payload_sha256,
    artifact_set_sha256: receipt.artifact_set_sha256,
    segment_ref: receipt.segment_ref,
  };
}

export function parseContinuationRuntimeV1AnnIndexSegmentRef(
  value: unknown,
): ContinuationRuntimeV1AnnIndexSegmentRefV1 {
  try {
    const record = exactRecord(value, SEGMENT_REF_KEYS, "input_invalid");
    if (record.schema_version !== "ann_index_segment_ref_v1") fail("input_invalid");
    if (typeof record.model !== "string" || record.model.length === 0
      || record.model !== record.model.trim()
      || Buffer.byteLength(record.model, "utf8") > 256
      || /[\u0000-\u001f\u007f]/u.test(record.model)) fail("input_invalid");
    const withoutDigest = canonicalContinuationClone({
      schema_version: "ann_index_segment_ref_v1" as const,
      artifact_set_sha256: sha256(record.artifact_set_sha256, "input_invalid"),
      model: record.model,
      dimensions: positiveInteger(record.dimensions, MAX_DIMENSIONS, "input_invalid"),
      member_count: positiveInteger(record.member_count, MAX_MEMBERS, "input_invalid"),
      member_set_sha256: sha256(record.member_set_sha256, "input_invalid"),
      vectors_byte_length: positiveInteger(
        record.vectors_byte_length,
        MAX_VECTOR_BYTES,
        "input_invalid",
      ),
      vectors_sha256: sha256(record.vectors_sha256, "input_invalid"),
      segment_sha256: sha256(record.segment_sha256, "input_invalid"),
    });
    if (withoutDigest.vectors_byte_length
        !== withoutDigest.dimensions * withoutDigest.member_count * 4) {
      fail("input_invalid");
    }
    const segmentRefSha256 = sha256(record.segment_ref_sha256, "input_invalid");
    if (canonicalContinuationSha256(segmentRefBody(withoutDigest))
      !== segmentRefSha256) fail("input_invalid");
    return canonicalContinuationClone({
      ...withoutDigest,
      segment_ref_sha256: segmentRefSha256,
    });
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1AnnIndexSegmentError) throw error;
    fail("input_invalid");
  }
}

export function buildContinuationRuntimeV1AnnIndexReceipt(
  sourceJobPayloadSha256: Sha256,
  value: ContinuationRuntimeV1AnnIndexSegmentRefV1,
): ContinuationRuntimeV1AnnIndexReceiptV1 {
  const segmentRef = parseContinuationRuntimeV1AnnIndexSegmentRef(value);
  const body = canonicalContinuationClone({
    schema_version: "ann_index_receipt_v1" as const,
    source_job_payload_sha256: sha256(sourceJobPayloadSha256, "input_invalid"),
    artifact_set_sha256: segmentRef.artifact_set_sha256,
    segment_ref: segmentRef,
  });
  return parseContinuationRuntimeV1AnnIndexReceipt({
    ...body,
    receipt_sha256: canonicalContinuationSha256(receiptBody(body)),
  });
}

export function parseContinuationRuntimeV1AnnIndexReceipt(
  value: unknown,
): ContinuationRuntimeV1AnnIndexReceiptV1 {
  try {
    const record = exactRecord(value, RECEIPT_KEYS, "input_invalid");
    if (record.schema_version !== "ann_index_receipt_v1") fail("input_invalid");
    const segmentRef = parseContinuationRuntimeV1AnnIndexSegmentRef(record.segment_ref);
    const body = canonicalContinuationClone({
      schema_version: "ann_index_receipt_v1" as const,
      source_job_payload_sha256: sha256(
        record.source_job_payload_sha256,
        "input_invalid",
      ),
      artifact_set_sha256: sha256(record.artifact_set_sha256, "input_invalid"),
      segment_ref: segmentRef,
    });
    if (body.artifact_set_sha256 !== segmentRef.artifact_set_sha256) {
      fail("input_invalid");
    }
    const receiptSha256 = sha256(record.receipt_sha256, "input_invalid");
    if (canonicalContinuationSha256(receiptBody(body)) !== receiptSha256) {
      fail("input_invalid");
    }
    return canonicalContinuationClone({ ...body, receipt_sha256: receiptSha256 });
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1AnnIndexSegmentError) throw error;
    fail("input_invalid");
  }
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

async function pathKind(path: string): Promise<"missing" | "directory" | "file" | "symlink"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    return "file";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

async function secureDirectory(path: string, create: boolean): Promise<void> {
  let kind = await pathKind(path);
  if (kind === "missing" && create) {
    try { await mkdir(path, { mode: DIRECTORY_MODE }); } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    kind = await pathKind(path);
  }
  if (kind === "symlink") fail("symlink_forbidden");
  if (kind !== "directory") fail("path_invalid");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) fail("path_invalid");
    await handle.chmod(DIRECTORY_MODE);
    if (((await handle.stat()).mode & 0o777) !== DIRECTORY_MODE) fail("io_failure");
    await handle.sync();
  } finally { await handle.close(); }
}

async function verifyImmutableDirectory(path: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === "symlink") fail("symlink_forbidden");
  if (kind !== "directory") fail("segment_tampered");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE) {
      fail("segment_tampered");
    }
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeSecureFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE) {
      fail("io_failure");
    }
  } finally { await handle.close(); }
}

async function readSecureFile(
  path: string,
  maximumBytes: number,
  exactBytes: number | null,
): Promise<Buffer> {
  const kind = await pathKind(path);
  if (kind === "missing") fail("segment_tampered");
  if (kind === "symlink") fail("symlink_forbidden");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error) === "ELOOP") fail("symlink_forbidden");
    if (errorCode(error) === "ENOENT") fail("segment_tampered");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE
      || stat.size > maximumBytes || (exactBytes !== null && stat.size !== exactBytes)) {
      fail("segment_tampered");
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function removeWithoutFollowing(path: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === "missing") return;
  if (kind === "file" || kind === "symlink") {
    await unlink(path);
    return;
  }
  for (const entry of await readdir(path)) {
    await removeWithoutFollowing(join(path, entry));
  }
  await rmdir(path);
}

function parseMetadata(raw: Buffer): SegmentMetadata {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")) as unknown; } catch {
    fail("segment_tampered");
  }
  const record = exactRecord(value, METADATA_KEYS, "segment_tampered");
  if (canonicalContinuationJson(value) !== raw.toString("utf8")
    || record.schema_version !== "ann_index_segment_metadata_v1"
    || record.encoding_format !== "float32_le") fail("segment_tampered");
  try {
    const memberCount = positiveInteger(record.member_count, MAX_MEMBERS, "segment_tampered");
    const dimensions = positiveInteger(record.dimensions, MAX_DIMENSIONS, "segment_tampered");
    const members = denseArray(
      record.members,
      memberCount,
      memberCount,
      "segment_tampered",
    ).map((member, index) => {
      const parsed = exactRecord(member, METADATA_MEMBER_KEYS, "segment_tampered");
      const ref = parseContinuationRuntimeV1EmbeddingVectorArtifactRef(
        parsed.vector_artifact_ref,
      );
      const documentSha = sha256(parsed.embedding_document_sha256, "segment_tampered");
      const byteLength = positiveInteger(
        parsed.vector_byte_length,
        MAX_DIMENSIONS * 4,
        "segment_tampered",
      );
      const offset = nonNegativeInteger(
        parsed.vector_offset_bytes,
        MAX_VECTOR_BYTES,
        "segment_tampered",
      );
      if (ref.embedding_document_sha256 !== documentSha
        || ref.dimensions !== dimensions || ref.model !== record.model
        || vectorRefSelfDigest(ref) !== ref.artifact_sha256
        || byteLength !== dimensions * 4 || offset !== index * byteLength) {
        fail("segment_tampered");
      }
      return canonicalContinuationClone({
        capsule_ref: parsed.capsule_ref,
        embedding_document_sha256: documentSha,
        vector_artifact_ref: ref,
        vector_offset_bytes: offset,
        vector_byte_length: byteLength,
      }) as SegmentMetadataMember;
    });
    const artifactSet = parseContinuationRuntimeV1EmbeddingArtifactSetRef({
      schema_version: "embedding_artifact_set_ref_v1",
      artifacts: members.map((member) => ({
        capsule_ref: member.capsule_ref,
        embedding_document_sha256: member.embedding_document_sha256,
        vector_artifact_ref: member.vector_artifact_ref,
      })),
      artifact_set_sha256: record.artifact_set_sha256,
    });
    const vectorsByteLength = positiveInteger(
      record.vectors_byte_length,
      MAX_VECTOR_BYTES,
      "segment_tampered",
    );
    if (vectorsByteLength !== dimensions * memberCount * 4) fail("segment_tampered");
    const withoutDigest = canonicalContinuationClone({
      schema_version: "ann_index_segment_metadata_v1" as const,
      artifact_set_sha256: artifactSet.artifact_set_sha256,
      model: record.model as string,
      dimensions,
      encoding_format: "float32_le" as const,
      member_count: memberCount,
      member_set_sha256: sha256(record.member_set_sha256, "segment_tampered"),
      members,
      vectors_byte_length: vectorsByteLength,
      vectors_sha256: sha256(record.vectors_sha256, "segment_tampered"),
    });
    if (withoutDigest.member_set_sha256 !== memberSetSha256(artifactSet)) {
      fail("segment_tampered");
    }
    const segmentSha256 = sha256(record.segment_sha256, "segment_tampered");
    if (canonicalContinuationSha256(metadataBody(withoutDigest)) !== segmentSha256) {
      fail("segment_tampered");
    }
    return canonicalContinuationClone({ ...withoutDigest, segment_sha256: segmentSha256 });
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1AnnIndexSegmentError) throw error;
    fail("segment_tampered");
  }
}

function refFromMetadata(metadata: SegmentMetadata): ContinuationRuntimeV1AnnIndexSegmentRefV1 {
  const body = canonicalContinuationClone({
    schema_version: "ann_index_segment_ref_v1" as const,
    artifact_set_sha256: metadata.artifact_set_sha256,
    model: metadata.model,
    dimensions: metadata.dimensions,
    member_count: metadata.member_count,
    member_set_sha256: metadata.member_set_sha256,
    vectors_byte_length: metadata.vectors_byte_length,
    vectors_sha256: metadata.vectors_sha256,
    segment_sha256: metadata.segment_sha256,
  });
  return canonicalContinuationClone({
    ...body,
    segment_ref_sha256: canonicalContinuationSha256(segmentRefBody(body)),
  });
}

function parseRoot(value: unknown): string {
  const record = exactRecord(value, STORE_KEYS, "configuration_invalid");
  if (typeof record.rootPath !== "string" || !isAbsolute(record.rootPath)
    || record.rootPath.includes("\u0000") || resolve(record.rootPath) !== record.rootPath) {
    fail("configuration_invalid");
  }
  return record.rootPath;
}

function parseDiscovery(
  value: ContinuationRuntimeV1AnnIndexSegmentDiscoveryInputV1,
) {
  const record = exactRecord(value, DISCOVERY_KEYS, "input_invalid");
  if (!Array.isArray(record.capsule_refs)
    || Object.getPrototypeOf(record.capsule_refs) !== Array.prototype
    || record.capsule_refs.length < 1 || record.capsule_refs.length > 32_768
    || Reflect.ownKeys(record.capsule_refs).length
      !== record.capsule_refs.length + 1
    || !Number.isSafeInteger(record.scan_limit)
    || Number(record.scan_limit) < 1 || Number(record.scan_limit) > 32_768) {
    fail("input_invalid");
  }
  const refs: CapsuleRefV1[] = [];
  for (let index = 0; index < record.capsule_refs.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      record.capsule_refs,
      String(index),
    );
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("input_invalid");
    }
    try { refs.push(parseContinuationRuntimeV1CapsuleRef(descriptor.value)); } catch {
      fail("input_invalid");
    }
  }
  refs.sort((left, right) => compareCanonicalUtf8(
    canonicalContinuationJson(left),
    canonicalContinuationJson(right),
  ));
  if (new Set(refs.map((ref) => canonicalContinuationJson(ref))).size
    !== refs.length) {
    fail("input_invalid");
  }
  return Object.freeze({ refs, scanLimit: Number(record.scan_limit) });
}

/**
 * Rebuildable immutable ANN segment sidecar. It deliberately exposes no search
 * operation: writing and verifying a segment is not serving integration.
 */
export function createContinuationRuntimeV1AnnIndexSegmentStore(
  config: Readonly<{ rootPath: string }>,
): ContinuationRuntimeV1AnnIndexSegmentStore {
  const root = parseRoot(config);
  const segments = join(root, "segments");
  let ready: Promise<void> | null = null;
  const ensureReady = async (): Promise<void> => {
    if (ready === null) {
      ready = (async () => {
        if (await pathKind(root) === "missing") {
          const parent = resolve(root, "..");
          const parentKind = await pathKind(parent);
          if (parentKind === "symlink") fail("symlink_forbidden");
          if (parentKind === "missing") {
            const grandparent = resolve(parent, "..");
            const grandparentKind = await pathKind(grandparent);
            if (grandparentKind === "symlink") fail("symlink_forbidden");
            if (grandparentKind !== "directory") fail("path_invalid");
            try { await mkdir(parent, { mode: DIRECTORY_MODE }); } catch (error) {
              if (errorCode(error) !== "EEXIST") throw error;
            }
            await syncDirectory(grandparent);
          } else if (parentKind !== "directory") fail("path_invalid");
          await secureDirectory(parent, false);
          try { await mkdir(root, { mode: ROOT_MODE }); } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
          }
          await syncDirectory(parent);
        }
        await secureDirectory(root, false);
        await secureDirectory(segments, true);
        await syncDirectory(root);
      })().catch((error: unknown) => {
        ready = null;
        if (error instanceof ContinuationRuntimeV1AnnIndexSegmentError) throw error;
        fail(errorCode(error) === "ELOOP" ? "symlink_forbidden" : "io_failure");
      });
    }
    await ready;
  };
  const locations = (digest: Sha256) => {
    const shard = join(segments, digest.slice(0, 2));
    return { shard, segment: join(shard, digest) };
  };
  const readAtDetailed = async (
    path: string,
    expected: ContinuationRuntimeV1AnnIndexSegmentRefV1 | null,
  ) => {
    const kind = await pathKind(path);
    if (kind === "missing") return null;
    if (kind === "symlink") fail("symlink_forbidden");
    if (kind !== "directory") fail("segment_tampered");
    await verifyImmutableDirectory(path);
    const entries = (await readdir(path)).sort();
    if (entries.length !== 2 || entries[0] !== "metadata.json"
      || entries[1] !== "vectors.f32") fail("segment_tampered");
    const metadata = parseMetadata(await readSecureFile(
      join(path, "metadata.json"),
      MAX_METADATA_BYTES,
      null,
    ));
    const ref = refFromMetadata(metadata);
    if (basename(path) !== ref.segment_sha256
      || (expected !== null
        && canonicalContinuationJson(ref) !== canonicalContinuationJson(expected))) {
      fail("segment_tampered");
    }
    const binary = await readSecureFile(
      join(path, "vectors.f32"),
      metadata.vectors_byte_length,
      metadata.vectors_byte_length,
    );
    try {
      if (createHash("sha256").update(binary).digest("hex")
        !== metadata.vectors_sha256) fail("segment_tampered");
    } finally { binary.fill(0); }
    return Object.freeze({
      result: Object.freeze({
        schema_version: "ann_index_segment_read_v1" as const,
        ref,
      }),
      metadata,
    });
  };
  const readAt = async (
    path: string,
    expected: ContinuationRuntimeV1AnnIndexSegmentRefV1 | null,
  ): Promise<ContinuationRuntimeV1AnnIndexSegmentReadResultV1 | null> => {
    return (await readAtDetailed(path, expected))?.result ?? null;
  };
  const publicCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (error instanceof ContinuationRuntimeV1AnnIndexSegmentError) throw error;
      fail(errorCode(error) === "ELOOP" ? "symlink_forbidden" : "io_failure");
    }
  };

  return Object.freeze({
    async write(value: ContinuationRuntimeV1AnnIndexSegmentWriteInputV1) {
      return await publicCall(async () => {
        const input = parseWrite(value);
        const vectorByteLength = input.dimensions * 4;
        const binary = Buffer.allocUnsafe(vectorByteLength * input.vectors.length);
        try {
          input.vectors.forEach((vector, memberIndex) => {
            vector.forEach((component, componentIndex) => {
              binary.writeFloatLE(
                component,
                memberIndex * vectorByteLength + componentIndex * 4,
              );
            });
          });
          const members = input.artifactSet.artifacts.map((member, index) =>
            canonicalContinuationClone({
              ...member,
              vector_offset_bytes: index * vectorByteLength,
              vector_byte_length: vectorByteLength,
            }));
          const withoutDigest = canonicalContinuationClone({
            schema_version: "ann_index_segment_metadata_v1" as const,
            artifact_set_sha256: input.artifactSet.artifact_set_sha256,
            model: input.model,
            dimensions: input.dimensions,
            encoding_format: "float32_le" as const,
            member_count: input.vectors.length,
            member_set_sha256: memberSetSha256(input.artifactSet),
            members,
            vectors_byte_length: binary.byteLength,
            vectors_sha256: createHash("sha256").update(binary).digest("hex"),
          });
          const metadata = canonicalContinuationClone({
            ...withoutDigest,
            segment_sha256: canonicalContinuationSha256(metadataBody(withoutDigest)),
          });
          const ref = refFromMetadata(metadata);
          await ensureReady();
          await secureDirectory(root, false);
          await secureDirectory(segments, false);
          const target = locations(ref.segment_sha256);
          await secureDirectory(target.shard, true);
          await syncDirectory(segments);
          const existing = await readAt(target.segment, ref);
          if (existing) return ref;
          const temporary = join(
            target.shard,
            `.tmp-${ref.segment_sha256}-${randomBytes(12).toString("hex")}`,
          );
          await mkdir(temporary, { mode: DIRECTORY_MODE });
          try {
            await secureDirectory(temporary, false);
            await writeSecureFile(join(temporary, "vectors.f32"), binary);
            await writeSecureFile(
              join(temporary, "metadata.json"),
              Buffer.from(canonicalContinuationJson(metadata), "utf8"),
            );
            await syncDirectory(temporary);
            try {
              await rename(temporary, target.segment);
              await syncDirectory(target.shard);
            } catch (error) {
              const code = errorCode(error);
              if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
              await removeWithoutFollowing(temporary);
              if (!await readAt(target.segment, ref)) fail("segment_conflict");
            }
          } catch (error) {
            try { await removeWithoutFollowing(temporary); } catch { /* stable error */ }
            throw error;
          }
          if (!await readAt(target.segment, ref)) fail("segment_conflict");
          return ref;
        } finally { binary.fill(0); }
      });
    },

    async read(value: ContinuationRuntimeV1AnnIndexSegmentRefV1) {
      return await publicCall(async () => {
        const ref = parseContinuationRuntimeV1AnnIndexSegmentRef(value);
        await ensureReady();
        await secureDirectory(root, false);
        await secureDirectory(segments, false);
        return await readAt(locations(ref.segment_sha256).segment, ref);
      });
    },

    async discoverByCapsuleRefs(value) {
      return await publicCall(async () => {
        const input = parseDiscovery(value);
        const wanted = new Set(
          input.refs.map((ref) => canonicalContinuationJson(ref)),
        );
        await ensureReady();
        await secureDirectory(root, false);
        await secureDirectory(segments, false);
        let scanned = 0;
        const matches: ContinuationRuntimeV1AnnIndexSegmentRefV1[] = [];
        for (const shardName of (await readdir(segments)).sort()) {
          if (!SHARD.test(shardName)) fail("segment_tampered");
          const shardPath = join(segments, shardName);
          const shardKind = await pathKind(shardPath);
          if (shardKind === "symlink") fail("symlink_forbidden");
          if (shardKind !== "directory") fail("segment_tampered");
          await verifyImmutableDirectory(shardPath);
          for (const entry of (await readdir(shardPath)).sort()) {
            if (TEMP_ENTRY.test(entry)) {
              if (await pathKind(join(shardPath, entry)) === "symlink") {
                fail("symlink_forbidden");
              }
              continue;
            }
            if (!SHA.test(entry) || entry.slice(0, 2) !== shardName) {
              fail("segment_tampered");
            }
            scanned += 1;
            if (scanned > input.scanLimit) fail("scan_limit_exceeded");
            const verified = await readAtDetailed(join(shardPath, entry), null);
            if (!verified || verified.result.ref.segment_sha256 !== entry) {
              fail("segment_tampered");
            }
            if (verified.metadata.members.some((member) =>
              wanted.has(canonicalContinuationJson(member.capsule_ref)))) {
              matches.push(verified.result.ref);
            }
          }
        }
        return Object.freeze(matches.sort((left, right) => compareCanonicalUtf8(
          canonicalContinuationJson(left),
          canonicalContinuationJson(right),
        )));
      });
    },

    async delete(value: ContinuationRuntimeV1AnnIndexSegmentRefV1) {
      return await publicCall(async () => {
        const ref = parseContinuationRuntimeV1AnnIndexSegmentRef(value);
        await ensureReady();
        await secureDirectory(root, false);
        await secureDirectory(segments, false);
        const target = locations(ref.segment_sha256);
        const existing = await readAt(target.segment, ref);
        if (!existing) return false;
        const tombstone = join(
          target.shard,
          `.delete-${ref.segment_sha256}-${randomBytes(12).toString("hex")}`,
        );
        try {
          await rename(target.segment, tombstone);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return false;
          throw error;
        }
        await syncDirectory(target.shard);
        await removeWithoutFollowing(tombstone);
        await syncDirectory(target.shard);
        return true;
      });
    },
  });
}
