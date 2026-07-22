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
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type Sha256,
} from "../continuation/contract.js";

const ROOT_MODE = 0o700;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const METADATA_MAX_BYTES = 16_384;
const MAX_DIMENSIONS = 65_536;
const STORE_CONFIG_KEYS = Object.freeze(["rootPath"] as const);
const WRITE_KEYS = Object.freeze([
  "dimensions", "embedding_document_sha256", "model", "schema_version",
  "source_projection_sha256", "vector",
] as const);
const REF_KEYS = Object.freeze([
  "artifact_sha256", "dimensions", "embedding_document_sha256", "model",
  "schema_version", "source_projection_sha256", "vector_sha256",
] as const);
const METADATA_KEYS = Object.freeze([
  "artifact_sha256", "dimensions", "embedding_document_sha256",
  "encoding_format", "model", "schema_version", "source_projection_sha256",
  "vector_byte_length", "vector_sha256",
] as const);
const DISCOVERY_KEYS = Object.freeze([
  "embedding_document_sha256s", "scan_limit",
] as const);
const SHA = /^[0-9a-f]{64}$/u;
const SHARD = /^[0-9a-f]{2}$/u;
const TEMP_ENTRY = /^\.(?:tmp|delete)-[0-9a-f]{64}-[0-9a-f]{24}$/u;

export type ContinuationRuntimeV1VectorArtifactErrorCode =
  | "configuration_invalid"
  | "input_invalid"
  | "path_invalid"
  | "symlink_forbidden"
  | "io_failure"
  | "artifact_conflict"
  | "artifact_tampered"
  | "scan_limit_exceeded";

export class ContinuationRuntimeV1VectorArtifactError extends Error {
  constructor(readonly code: ContinuationRuntimeV1VectorArtifactErrorCode) {
    super(`continuation_runtime_v1_vector_artifact_${code}`);
    this.name = "ContinuationRuntimeV1VectorArtifactError";
  }
}

export type ContinuationRuntimeV1VectorArtifactRef = Readonly<{
  schema_version: "vector_artifact_ref_v1";
  source_projection_sha256: Sha256;
  embedding_document_sha256: Sha256;
  model: string;
  dimensions: number;
  vector_sha256: Sha256;
  artifact_sha256: Sha256;
}>;

export type ContinuationRuntimeV1VectorArtifactWriteInput = Readonly<{
  schema_version: "vector_artifact_write_v1";
  source_projection_sha256: Sha256;
  embedding_document_sha256: Sha256;
  model: string;
  dimensions: number;
  vector: readonly number[];
}>;

export type ContinuationRuntimeV1VectorArtifactReadResult = Readonly<{
  schema_version: "vector_artifact_read_v1";
  ref: ContinuationRuntimeV1VectorArtifactRef;
  encoding_format: "float32_le";
  vector: readonly number[];
}>;

export type ContinuationRuntimeV1VectorArtifactReconcileResult = Readonly<{
  schema_version: "vector_artifact_reconcile_result_v1";
  verified_artifact_count: number;
  removed_temporary_count: number;
}>;

export type ContinuationRuntimeV1VectorArtifactDiscoveryInput = Readonly<{
  embedding_document_sha256s: readonly Sha256[];
  scan_limit: number;
}>;

export type ContinuationRuntimeV1VectorArtifactStore = Readonly<{
  write(
    input: ContinuationRuntimeV1VectorArtifactWriteInput,
  ): Promise<ContinuationRuntimeV1VectorArtifactRef>;
  read(
    ref: ContinuationRuntimeV1VectorArtifactRef,
  ): Promise<ContinuationRuntimeV1VectorArtifactReadResult | null>;
  delete(ref: ContinuationRuntimeV1VectorArtifactRef): Promise<boolean>;
  discoverByEmbeddingDocumentSha256s(
    input: ContinuationRuntimeV1VectorArtifactDiscoveryInput,
  ): Promise<readonly ContinuationRuntimeV1VectorArtifactRef[]>;
  reconcile(): Promise<ContinuationRuntimeV1VectorArtifactReconcileResult>;
}>;

type VectorMetadata = Readonly<{
  schema_version: "vector_artifact_metadata_v1";
  source_projection_sha256: Sha256;
  embedding_document_sha256: Sha256;
  model: string;
  dimensions: number;
  encoding_format: "float32_le";
  vector_byte_length: number;
  vector_sha256: Sha256;
  artifact_sha256: Sha256;
}>;

function fail(code: ContinuationRuntimeV1VectorArtifactErrorCode): never {
  throw new ContinuationRuntimeV1VectorArtifactError(code);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: ContinuationRuntimeV1VectorArtifactErrorCode,
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

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") fail("input_invalid");
  try { assertUnicodeScalarString(value, "vector artifact text"); } catch {
    fail("input_invalid");
  }
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) fail("input_invalid");
  return value;
}

function sha256(value: unknown): Sha256 {
  if (typeof value !== "string") fail("input_invalid");
  try { assertSha256(value, "vector artifact digest"); } catch { fail("input_invalid"); }
  return value;
}

function dimensions(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > MAX_DIMENSIONS) fail("input_invalid");
  return value as number;
}

function denseVector(value: unknown, expectedDimensions: number): readonly number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== expectedDimensions) fail("input_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) fail("input_invalid");
  const vector: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const component = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (!descriptor?.enumerable || typeof component !== "number"
      || !Number.isFinite(component)) fail("input_invalid");
    vector.push(component);
  }
  return vector;
}

function parseWrite(value: ContinuationRuntimeV1VectorArtifactWriteInput) {
  const record = exactRecord(value, WRITE_KEYS, "input_invalid");
  if (record.schema_version !== "vector_artifact_write_v1") fail("input_invalid");
  const count = dimensions(record.dimensions);
  return {
    sourceProjectionSha256: sha256(record.source_projection_sha256),
    embeddingDocumentSha256: sha256(record.embedding_document_sha256),
    model: text(record.model, 256),
    dimensions: count,
    vector: denseVector(record.vector, count),
  };
}

function parseRef(value: ContinuationRuntimeV1VectorArtifactRef) {
  const record = exactRecord(value, REF_KEYS, "input_invalid");
  if (record.schema_version !== "vector_artifact_ref_v1") fail("input_invalid");
  return canonicalContinuationClone({
    schema_version: "vector_artifact_ref_v1" as const,
    source_projection_sha256: sha256(record.source_projection_sha256),
    embedding_document_sha256: sha256(record.embedding_document_sha256),
    model: text(record.model, 256),
    dimensions: dimensions(record.dimensions),
    vector_sha256: sha256(record.vector_sha256),
    artifact_sha256: sha256(record.artifact_sha256),
  });
}

function parseDiscovery(value: ContinuationRuntimeV1VectorArtifactDiscoveryInput) {
  const record = exactRecord(value, DISCOVERY_KEYS, "input_invalid");
  if (!Array.isArray(record.embedding_document_sha256s)
    || Object.getPrototypeOf(record.embedding_document_sha256s) !== Array.prototype
    || record.embedding_document_sha256s.length < 1
    || record.embedding_document_sha256s.length > 32_768
    || Reflect.ownKeys(record.embedding_document_sha256s).length
      !== record.embedding_document_sha256s.length + 1) fail("input_invalid");
  const digests: Sha256[] = [];
  for (let index = 0; index < record.embedding_document_sha256s.length;
    index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      record.embedding_document_sha256s,
      String(index),
    );
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("input_invalid");
    }
    digests.push(sha256(descriptor.value));
  }
  digests.sort(compareCanonicalUtf8);
  if (new Set(digests).size !== digests.length
    || !Number.isSafeInteger(record.scan_limit)
    || Number(record.scan_limit) < 1 || Number(record.scan_limit) > 32_768) {
    fail("input_invalid");
  }
  return Object.freeze({ digests, scanLimit: Number(record.scan_limit) });
}

function encodeVector(values: readonly number[]): Buffer {
  const binary = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    const quantized = Math.fround(values[index]!);
    if (!Number.isFinite(quantized)) fail("input_invalid");
    binary.writeFloatLE(quantized, index * 4);
  }
  return binary;
}

function metadataFor(args: Readonly<{
  sourceProjectionSha256: Sha256;
  embeddingDocumentSha256: Sha256;
  model: string;
  dimensions: number;
  binary: Buffer;
}>): Readonly<{ metadata: VectorMetadata; ref: ContinuationRuntimeV1VectorArtifactRef }> {
  const vectorSha256 = createHash("sha256").update(args.binary).digest("hex");
  const body = {
    schema_version: "vector_artifact_metadata_v1" as const,
    source_projection_sha256: args.sourceProjectionSha256,
    embedding_document_sha256: args.embeddingDocumentSha256,
    model: args.model,
    dimensions: args.dimensions,
    encoding_format: "float32_le" as const,
    vector_byte_length: args.binary.byteLength,
    vector_sha256: vectorSha256,
  };
  const artifactSha256 = canonicalContinuationSha256(body);
  return {
    metadata: canonicalContinuationClone({
      ...body,
      artifact_sha256: artifactSha256,
    }),
    ref: canonicalContinuationClone({
      schema_version: "vector_artifact_ref_v1" as const,
      source_projection_sha256: args.sourceProjectionSha256,
      embedding_document_sha256: args.embeddingDocumentSha256,
      model: args.model,
      dimensions: args.dimensions,
      vector_sha256: vectorSha256,
      artifact_sha256: artifactSha256,
    }),
  };
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

async function secureDirectory(path: string, mode: number, create: boolean): Promise<void> {
  let kind = await pathKind(path);
  if (kind === "missing" && create) {
    try { await mkdir(path, { mode }); } catch (error) {
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
    await handle.chmod(mode);
    const after = await handle.stat();
    if ((after.mode & 0o777) !== mode) fail("io_failure");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  } finally {
    await handle.close();
  }
}

async function readSecureFile(
  path: string,
  maximumBytes: number,
  exactBytes: number | null,
): Promise<Buffer> {
  const kind = await pathKind(path);
  if (kind === "symlink") fail("symlink_forbidden");
  if (kind === "missing") fail("artifact_tampered");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error) === "ELOOP") fail("symlink_forbidden");
    if (errorCode(error) === "ENOENT") fail("artifact_tampered");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== FILE_MODE
      || stat.size > maximumBytes || (exactBytes !== null && stat.size !== exactBytes)) {
      fail("artifact_tampered");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function removeWithoutFollowing(path: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === "missing") return;
  if (kind === "file" || kind === "symlink") {
    await unlink(path);
    return;
  }
  const entries = await readdir(path);
  for (const entry of entries) await removeWithoutFollowing(join(path, entry));
  await rmdir(path);
}

function metadataBody(metadata: VectorMetadata) {
  return {
    schema_version: metadata.schema_version,
    source_projection_sha256: metadata.source_projection_sha256,
    embedding_document_sha256: metadata.embedding_document_sha256,
    model: metadata.model,
    dimensions: metadata.dimensions,
    encoding_format: metadata.encoding_format,
    vector_byte_length: metadata.vector_byte_length,
    vector_sha256: metadata.vector_sha256,
  };
}

function parseMetadata(raw: Buffer): VectorMetadata {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")) as unknown; } catch {
    fail("artifact_tampered");
  }
  const record = exactRecord(parsed, METADATA_KEYS, "artifact_tampered");
  if (canonicalContinuationJson(parsed) !== raw.toString("utf8")
    || record.schema_version !== "vector_artifact_metadata_v1"
    || record.encoding_format !== "float32_le") fail("artifact_tampered");
  const metadata = canonicalContinuationClone({
    schema_version: "vector_artifact_metadata_v1" as const,
    source_projection_sha256: (() => {
      try { return sha256(record.source_projection_sha256); } catch { fail("artifact_tampered"); }
    })(),
    embedding_document_sha256: (() => {
      try { return sha256(record.embedding_document_sha256); } catch {
        fail("artifact_tampered");
      }
    })(),
    model: (() => {
      try { return text(record.model, 256); } catch { fail("artifact_tampered"); }
    })(),
    dimensions: (() => {
      try { return dimensions(record.dimensions); } catch { fail("artifact_tampered"); }
    })(),
    encoding_format: "float32_le" as const,
    vector_byte_length: Number.isSafeInteger(record.vector_byte_length)
      ? record.vector_byte_length as number : fail("artifact_tampered"),
    vector_sha256: (() => {
      try { return sha256(record.vector_sha256); } catch { fail("artifact_tampered"); }
    })(),
    artifact_sha256: (() => {
      try { return sha256(record.artifact_sha256); } catch { fail("artifact_tampered"); }
    })(),
  });
  if (metadata.vector_byte_length !== metadata.dimensions * 4
    || canonicalContinuationSha256(metadataBody(metadata))
      !== metadata.artifact_sha256) fail("artifact_tampered");
  return metadata;
}

function refFromMetadata(metadata: VectorMetadata): ContinuationRuntimeV1VectorArtifactRef {
  return canonicalContinuationClone({
    schema_version: "vector_artifact_ref_v1" as const,
    source_projection_sha256: metadata.source_projection_sha256,
    embedding_document_sha256: metadata.embedding_document_sha256,
    model: metadata.model,
    dimensions: metadata.dimensions,
    vector_sha256: metadata.vector_sha256,
    artifact_sha256: metadata.artifact_sha256,
  });
}

function refsEqual(
  left: ContinuationRuntimeV1VectorArtifactRef,
  right: ContinuationRuntimeV1VectorArtifactRef,
): boolean {
  return canonicalContinuationJson(left) === canonicalContinuationJson(right);
}

function decodeVector(binary: Buffer, dimensionsCount: number): readonly number[] {
  const vector: number[] = [];
  for (let index = 0; index < dimensionsCount; index += 1) {
    const component = binary.readFloatLE(index * 4);
    if (!Number.isFinite(component)) fail("artifact_tampered");
    vector.push(component);
  }
  return Object.freeze(vector);
}

function parseRoot(value: unknown): string {
  const record = exactRecord(value, STORE_CONFIG_KEYS, "configuration_invalid");
  if (typeof record.rootPath !== "string" || !isAbsolute(record.rootPath)
    || record.rootPath.includes("\u0000") || resolve(record.rootPath) !== record.rootPath) {
    fail("configuration_invalid");
  }
  return record.rootPath;
}

/**
 * Independent rebuildable vector sidecar. It has no authority-database handle
 * and stores only canonical metadata plus float32 bytes—never source text or
 * provider credentials.
 */
export function createContinuationRuntimeV1VectorArtifactStore(
  config: Readonly<{ rootPath: string }>,
): ContinuationRuntimeV1VectorArtifactStore {
  const root = parseRoot(config);
  const objects = join(root, "objects");
  let ready: Promise<void> | null = null;
  const ensureReady = async (): Promise<void> => {
    if (ready === null) {
      ready = (async () => {
        const rootKind = await pathKind(root);
        if (rootKind === "missing") {
          const parent = resolve(root, "..");
          if (await pathKind(parent) !== "directory") fail("path_invalid");
          await mkdir(root, { mode: ROOT_MODE });
          await syncDirectory(parent);
        }
        await secureDirectory(root, ROOT_MODE, false);
        await secureDirectory(objects, DIRECTORY_MODE, true);
        await syncDirectory(root);
      })().catch((error: unknown) => {
        ready = null;
        if (error instanceof ContinuationRuntimeV1VectorArtifactError) throw error;
        fail(errorCode(error) === "ELOOP" ? "symlink_forbidden" : "io_failure");
      });
    }
    await ready;
  };
  const locations = (artifactSha256: Sha256) => {
    const shard = join(objects, artifactSha256.slice(0, 2));
    const artifact = join(shard, artifactSha256);
    return { shard, artifact };
  };
  const readAt = async (
    artifactPath: string,
    expected: ContinuationRuntimeV1VectorArtifactRef | null,
  ): Promise<ContinuationRuntimeV1VectorArtifactReadResult | null> => {
    const kind = await pathKind(artifactPath);
    if (kind === "missing") return null;
    if (kind === "symlink") fail("symlink_forbidden");
    if (kind !== "directory") fail("artifact_tampered");
    const directory = await open(
      artifactPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await directory.stat();
      if (!stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE) {
        fail("artifact_tampered");
      }
    } finally { await directory.close(); }
    const entries = (await readdir(artifactPath)).sort();
    if (entries.length !== 2 || entries[0] !== "metadata.json"
      || entries[1] !== "vector.f32") fail("artifact_tampered");
    const metadataRaw = await readSecureFile(
      join(artifactPath, "metadata.json"),
      METADATA_MAX_BYTES,
      null,
    );
    const metadata = parseMetadata(metadataRaw);
    const ref = refFromMetadata(metadata);
    if ((expected !== null && !refsEqual(ref, expected))
      || basename(artifactPath) !== ref.artifact_sha256) {
      fail("artifact_tampered");
    }
    const binary = await readSecureFile(
      join(artifactPath, "vector.f32"),
      metadata.vector_byte_length,
      metadata.vector_byte_length,
    );
    if (createHash("sha256").update(binary).digest("hex")
      !== metadata.vector_sha256) fail("artifact_tampered");
    return Object.freeze({
      schema_version: "vector_artifact_read_v1" as const,
      ref,
      encoding_format: "float32_le" as const,
      vector: decodeVector(binary, metadata.dimensions),
    });
  };
  const publicCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) {
      if (error instanceof ContinuationRuntimeV1VectorArtifactError) throw error;
      const code = errorCode(error);
      if (code === "ELOOP") fail("symlink_forbidden");
      fail("io_failure");
    }
  };

  return Object.freeze({
    async write(value: ContinuationRuntimeV1VectorArtifactWriteInput) {
      return await publicCall(async () => {
        const input = parseWrite(value);
        const binary = encodeVector(input.vector);
        const { metadata, ref } = metadataFor({
          sourceProjectionSha256: input.sourceProjectionSha256,
          embeddingDocumentSha256: input.embeddingDocumentSha256,
          model: input.model,
          dimensions: input.dimensions,
          binary,
        });
        await ensureReady();
        const target = locations(ref.artifact_sha256);
        await secureDirectory(target.shard, DIRECTORY_MODE, true);
        await syncDirectory(objects);
        const existing = await readAt(target.artifact, ref);
        if (existing) return ref;
        const temporary = join(
          target.shard,
          `.tmp-${ref.artifact_sha256}-${randomBytes(12).toString("hex")}`,
        );
        await mkdir(temporary, { mode: DIRECTORY_MODE });
        try {
          await secureDirectory(temporary, DIRECTORY_MODE, false);
          await writeSecureFile(join(temporary, "vector.f32"), binary);
          await writeSecureFile(
            join(temporary, "metadata.json"),
            Buffer.from(canonicalContinuationJson(metadata), "utf8"),
          );
          await syncDirectory(temporary);
          try {
            await rename(temporary, target.artifact);
            await syncDirectory(target.shard);
          } catch (error) {
            const code = errorCode(error);
            if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
            await removeWithoutFollowing(temporary);
            const raced = await readAt(target.artifact, ref);
            if (!raced) fail("artifact_conflict");
          }
        } catch (error) {
          try { await removeWithoutFollowing(temporary); } catch { /* preserve stable error */ }
          throw error;
        }
        const verified = await readAt(target.artifact, ref);
        if (!verified) fail("artifact_conflict");
        return ref;
      });
    },

    async read(value: ContinuationRuntimeV1VectorArtifactRef) {
      return await publicCall(async () => {
        const ref = parseRef(value);
        await ensureReady();
        return await readAt(locations(ref.artifact_sha256).artifact, ref);
      });
    },

    async delete(value: ContinuationRuntimeV1VectorArtifactRef) {
      return await publicCall(async () => {
        const ref = parseRef(value);
        await ensureReady();
        const target = locations(ref.artifact_sha256);
        const existing = await readAt(target.artifact, ref);
        if (!existing) return false;
        const tombstone = join(
          target.shard,
          `.delete-${ref.artifact_sha256}-${randomBytes(12).toString("hex")}`,
        );
        try {
          await rename(target.artifact, tombstone);
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

    async discoverByEmbeddingDocumentSha256s(value) {
      return await publicCall(async () => {
        const input = parseDiscovery(value);
        const wanted = new Set(input.digests);
        await ensureReady();
        let scanned = 0;
        const matches: ContinuationRuntimeV1VectorArtifactRef[] = [];
        for (const shardName of (await readdir(objects)).sort()) {
          if (!SHARD.test(shardName)) fail("artifact_tampered");
          const shardPath = join(objects, shardName);
          if (await pathKind(shardPath) === "symlink") fail("symlink_forbidden");
          await secureDirectory(shardPath, DIRECTORY_MODE, false);
          for (const entry of (await readdir(shardPath)).sort()) {
            if (TEMP_ENTRY.test(entry)) {
              if (await pathKind(join(shardPath, entry)) === "symlink") {
                fail("symlink_forbidden");
              }
              // A writer/deleter may own this strict, unaddressable residue.
              // It is never a discoverable artifact and reconcile can remove
              // it after the concurrent operation or crash has settled.
              continue;
            }
            if (!SHA.test(entry) || entry.slice(0, 2) !== shardName) {
              fail("artifact_tampered");
            }
            scanned += 1;
            if (scanned > input.scanLimit) fail("scan_limit_exceeded");
            const artifact = await readAt(join(shardPath, entry), null);
            if (!artifact || artifact.ref.artifact_sha256 !== entry) {
              fail("artifact_tampered");
            }
            if (wanted.has(artifact.ref.embedding_document_sha256)) {
              matches.push(artifact.ref);
            }
          }
        }
        return Object.freeze(matches.sort((left, right) => compareCanonicalUtf8(
          canonicalContinuationJson(left),
          canonicalContinuationJson(right),
        )));
      });
    },

    async reconcile() {
      return await publicCall(async () => {
        await ensureReady();
        let verified = 0;
        let removed = 0;
        const shardEntries = await readdir(objects);
        for (const shardName of shardEntries) {
          if (!SHARD.test(shardName)) fail("artifact_tampered");
          const shardPath = join(objects, shardName);
          if (await pathKind(shardPath) === "symlink") fail("symlink_forbidden");
          await secureDirectory(shardPath, DIRECTORY_MODE, false);
          for (const entry of await readdir(shardPath)) {
            const entryPath = join(shardPath, entry);
            if (TEMP_ENTRY.test(entry)) {
              await removeWithoutFollowing(entryPath);
              removed += 1;
              continue;
            }
            if (!SHA.test(entry) || entry.slice(0, 2) !== shardName) {
              fail("artifact_tampered");
            }
            const artifact = await readAt(entryPath, null);
            if (!artifact || artifact.ref.artifact_sha256 !== entry) {
              fail("artifact_tampered");
            }
            verified += 1;
          }
          await syncDirectory(shardPath);
        }
        return Object.freeze({
          schema_version: "vector_artifact_reconcile_result_v1" as const,
          verified_artifact_count: verified,
          removed_temporary_count: removed,
        });
      });
    },
  });
}
