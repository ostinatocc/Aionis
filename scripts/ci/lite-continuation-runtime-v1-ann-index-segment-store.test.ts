import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
} from "../../src/continuation/contract.js";
import {
  buildContinuationRuntimeV1AnnIndexReceipt,
  ContinuationRuntimeV1AnnIndexSegmentError,
  createContinuationRuntimeV1AnnIndexSegmentStore,
  parseContinuationRuntimeV1AnnIndexReceipt,
  type ContinuationRuntimeV1AnnIndexSegmentRefV1,
  type ContinuationRuntimeV1AnnIndexSegmentStore,
  type ContinuationRuntimeV1AnnIndexSegmentWriteInputV1,
} from "../../src/runtime-v1/ann-index-segment-store.js";
import {
  buildContinuationRuntimeV1EmbeddingArtifactSetRef,
  type ContinuationRuntimeV1EmbeddingArtifactMemberRefV1,
  type ContinuationRuntimeV1EmbeddingVectorArtifactRefV1,
} from "../../src/runtime-v1/embedding-job-contract.js";

const MODEL = "embedding-model-v1";
const SOURCE_SECRET = "raw-source-text-must-never-enter-index";
const PROVIDER_SECRET = "provider-credential-must-never-enter-index";

type Fixture = Readonly<{
  parent: string;
  root: string;
  store: ContinuationRuntimeV1AnnIndexSegmentStore;
}>;

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "aionis-ann-index-segment-"));
  const root = join(parent, "index-segments-v1");
  return {
    parent,
    root,
    store: createContinuationRuntimeV1AnnIndexSegmentStore({ rootPath: root }),
  };
}

function vectorBinary(values: readonly number[]): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(Math.fround(value), index * 4));
  return bytes;
}

function vectorRef(
  index: number,
  vector: readonly number[],
  model = MODEL,
): Readonly<{
  documentSha256: string;
  ref: ContinuationRuntimeV1EmbeddingVectorArtifactRefV1;
}> {
  const documentSha256 = createHash("sha256")
    .update(`embedding-document-${index}`)
    .digest("hex");
  const binary = vectorBinary(vector);
  const vectorSha256 = createHash("sha256").update(binary).digest("hex");
  const body = {
    schema_version: "vector_artifact_metadata_v1" as const,
    source_projection_sha256: createHash("sha256")
      .update(`source-projection-${index}`)
      .digest("hex"),
    embedding_document_sha256: documentSha256,
    model,
    dimensions: vector.length,
    encoding_format: "float32_le" as const,
    vector_byte_length: binary.byteLength,
    vector_sha256: vectorSha256,
  };
  return {
    documentSha256,
    ref: {
      schema_version: "vector_artifact_ref_v1",
      source_projection_sha256: body.source_projection_sha256,
      embedding_document_sha256: documentSha256,
      model,
      dimensions: vector.length,
      vector_sha256: vectorSha256,
      artifact_sha256: canonicalContinuationSha256(body),
    },
  };
}

function writeInput(
  entries: readonly Readonly<{
    vector: readonly number[];
    model?: string;
  }>[] = [
    { vector: [1 / 3, -2.25, 7.125] },
    { vector: [4.5, 5.25, -6.75] },
  ],
): ContinuationRuntimeV1AnnIndexSegmentWriteInputV1 {
  const built = entries.map((entry, index) => ({
    ...vectorRef(index, entry.vector, entry.model),
    vector: entry.vector,
  }));
  const members: ContinuationRuntimeV1EmbeddingArtifactMemberRefV1[] = built.map(
    (entry, index) => ({
      capsule_ref: {
        capsule_id: `capsule-${String(index).padStart(2, "0")}`,
        capsule_revision: 1,
        capsule_sha256: createHash("sha256").update(`capsule-${index}`).digest("hex"),
      },
      embedding_document_sha256: entry.documentSha256,
      vector_artifact_ref: entry.ref,
    }),
  );
  return {
    schema_version: "ann_index_segment_write_v1",
    embedding_artifact_set_ref:
      buildContinuationRuntimeV1EmbeddingArtifactSetRef(members),
    vectors: built.map((entry) => ({
      vector_artifact_ref: entry.ref,
      vector: entry.vector,
    })),
  };
}

function locations(root: string, ref: ContinuationRuntimeV1AnnIndexSegmentRefV1) {
  const segments = join(root, "segments");
  const shard = join(segments, ref.segment_sha256.slice(0, 2));
  const segment = join(shard, ref.segment_sha256);
  return {
    segments,
    shard,
    segment,
    metadata: join(segment, "metadata.json"),
    vectors: join(segment, "vectors.f32"),
  };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function rejected(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("operation unexpectedly succeeded");
}

function assertSegmentError(
  error: Error,
  code: ContinuationRuntimeV1AnnIndexSegmentError["code"],
): void {
  assert.ok(error instanceof ContinuationRuntimeV1AnnIndexSegmentError);
  assert.equal(error.code, code);
  assert.equal(error.message, `continuation_runtime_v1_ann_index_segment_${code}`);
  assert.equal("cause" in error, false);
}

test("ANN segment is deterministic, private, content-addressed, and text-free", async () => {
  const current = await fixture();
  try {
    const input = writeInput();
    const ref = await current.store.write(input);
    const paths = locations(current.root, ref);
    assert.deepEqual((await readdir(paths.segment)).sort(), [
      "metadata.json", "vectors.f32",
    ]);
    for (const directory of [
      current.root, paths.segments, paths.shard, paths.segment,
    ]) assert.equal(await mode(directory), 0o700);
    for (const file of [paths.metadata, paths.vectors]) {
      assert.equal(await mode(file), 0o600);
    }
    const metadata = await readFile(paths.metadata, "utf8");
    assert.equal(metadata, canonicalContinuationJson(JSON.parse(metadata)));
    assert.equal(metadata.includes(SOURCE_SECRET), false);
    assert.equal(metadata.includes(PROVIDER_SECRET), false);
    assert.equal(metadata.includes("api_key"), false);
    const vectorBytes = await readFile(paths.vectors);
    assert.equal(vectorBytes.byteLength, 2 * 3 * 4);
    const completeSegment = Buffer.concat([Buffer.from(metadata), vectorBytes]);
    assert.equal(completeSegment.includes(Buffer.from(SOURCE_SECRET)), false);
    assert.equal(completeSegment.includes(Buffer.from(PROVIDER_SECRET)), false);
    assert.deepEqual(await current.store.read(ref), {
      schema_version: "ann_index_segment_read_v1",
      ref,
    });

    const receipt = buildContinuationRuntimeV1AnnIndexReceipt(
      createHash("sha256").update("exact-job-payload").digest("hex"),
      ref,
    );
    assert.deepEqual(parseContinuationRuntimeV1AnnIndexReceipt(receipt), receipt);
    assert.ok(Buffer.byteLength(canonicalContinuationJson(receipt), "utf8") < 4_096);
    assert.ok(Object.isFrozen(ref));
    assert.ok(Object.isFrozen(receipt));
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

test("ANN segment converges replay and concurrent identical writes", async () => {
  const current = await fixture();
  try {
    const input = writeInput();
    const refs = await Promise.all(
      Array.from({ length: 24 }, () => current.store.write(input)),
    );
    refs.forEach((ref) => assert.deepEqual(ref, refs[0]));
    assert.deepEqual(await current.store.write(input), refs[0]);
    const paths = locations(current.root, refs[0]!);
    assert.deepEqual(await readdir(paths.shard), [refs[0]!.segment_sha256]);
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }
});

test("ANN segment fails closed on binary, metadata, missing-file, and ref tampering", async () => {
  const current = await fixture();
  try {
    const input = writeInput();
    const ref = await current.store.write(input);
    const paths = locations(current.root, ref);
    const binary = await readFile(paths.vectors);
    binary[0] = binary[0]! ^ 0xff;
    await writeFile(paths.vectors, binary, { mode: 0o600 });
    assertSegmentError(await rejected(current.store.read(ref)), "segment_tampered");
    assertSegmentError(await rejected(current.store.write(input)), "segment_tampered");
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }

  const metadataCase = await fixture();
  try {
    const ref = await metadataCase.store.write(writeInput());
    const paths = locations(metadataCase.root, ref);
    const raw = await readFile(paths.metadata, "utf8");
    await writeFile(paths.metadata, raw.replace(MODEL, "changed-model"), { mode: 0o600 });
    assertSegmentError(
      await rejected(metadataCase.store.read(ref)),
      "segment_tampered",
    );
  } finally {
    await rm(metadataCase.parent, { recursive: true, force: true });
  }

  const missingCase = await fixture();
  try {
    const ref = await missingCase.store.write(writeInput());
    await unlink(locations(missingCase.root, ref).vectors);
    assertSegmentError(
      await rejected(missingCase.store.read(ref)),
      "segment_tampered",
    );
  } finally {
    await rm(missingCase.parent, { recursive: true, force: true });
  }

  const refCase = await fixture();
  try {
    const ref = await refCase.store.write(writeInput());
    assertSegmentError(
      await rejected(refCase.store.read({ ...ref, member_count: 3 })),
      "input_invalid",
    );
  } finally {
    await rm(refCase.parent, { recursive: true, force: true });
  }
});

test("ANN segment rejects symlinks, mixed vector families, and payload drift", async () => {
  const symlinkRoot = await mkdtemp(join(tmpdir(), "aionis-ann-index-symlink-"));
  try {
    const real = join(symlinkRoot, "real");
    const linked = join(symlinkRoot, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked, "dir");
    const store = createContinuationRuntimeV1AnnIndexSegmentStore({ rootPath: linked });
    assertSegmentError(await rejected(store.write(writeInput())), "symlink_forbidden");
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true });
  }

  const fileSymlink = await fixture();
  try {
    const ref = await fileSymlink.store.write(writeInput());
    const paths = locations(fileSymlink.root, ref);
    const outside = join(fileSymlink.parent, "outside.f32");
    await writeFile(outside, Buffer.alloc(ref.vectors_byte_length), { mode: 0o600 });
    await unlink(paths.vectors);
    await symlink(outside, paths.vectors, "file");
    assertSegmentError(
      await rejected(fileSymlink.store.read(ref)),
      "symlink_forbidden",
    );
  } finally {
    await rm(fileSymlink.parent, { recursive: true, force: true });
  }

  const invalid = await fixture();
  try {
    assertSegmentError(
      await rejected(invalid.store.write(writeInput([
        { vector: [1, 2, 3], model: MODEL },
        { vector: [4, 5, 6], model: "other-model" },
      ]))),
      "input_invalid",
    );
    const input = writeInput();
    const drifted = {
      ...input,
      vectors: input.vectors.map((entry, index) => index === 0
        ? { ...entry, vector: [9, 9, 9] }
        : entry),
    };
    assertSegmentError(
      await rejected(invalid.store.write(drifted)),
      "input_invalid",
    );
  } finally {
    await rm(invalid.parent, { recursive: true, force: true });
  }
});

test("ANN segment treats insecure or non-canonical files as tampering", async () => {
  const current = await fixture();
  try {
    const ref = await current.store.write(writeInput());
    const paths = locations(current.root, ref);
    await chmod(paths.metadata, 0o644);
    assertSegmentError(await rejected(current.store.read(ref)), "segment_tampered");
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }

  const directoryMode = await fixture();
  try {
    const ref = await directoryMode.store.write(writeInput());
    await chmod(locations(directoryMode.root, ref).segment, 0o755);
    assertSegmentError(
      await rejected(directoryMode.store.read(ref)),
      "segment_tampered",
    );
  } finally {
    await rm(directoryMode.parent, { recursive: true, force: true });
  }

  const swappedRoot = await fixture();
  try {
    const ref = await swappedRoot.store.write(writeInput());
    const realRoot = join(swappedRoot.parent, "moved-index-root");
    await rename(swappedRoot.root, realRoot);
    await symlink(realRoot, swappedRoot.root, "dir");
    assertSegmentError(
      await rejected(swappedRoot.store.read(ref)),
      "symlink_forbidden",
    );
  } finally {
    await rm(swappedRoot.parent, { recursive: true, force: true });
  }
});

test("ANN segment deletion is verified, atomic, symlink-safe, and idempotent", async () => {
  const current = await fixture();
  let knownRef: ContinuationRuntimeV1AnnIndexSegmentRefV1;
  try {
    const ref = await current.store.write(writeInput());
    knownRef = ref;
    const paths = locations(current.root, ref);
    assert.equal(await current.store.delete(ref), true);
    assert.equal(await current.store.read(ref), null);
    assert.equal(await current.store.delete(ref), false);
    assert.deepEqual(await readdir(paths.shard), []);
  } finally {
    await rm(current.parent, { recursive: true, force: true });
  }

  const whollyMissing = await fixture();
  try {
    const nestedRoot = join(whollyMissing.parent, "missing-parent", "index-v1");
    const emptyStore = createContinuationRuntimeV1AnnIndexSegmentStore({
      rootPath: nestedRoot,
    });
    assert.equal(await emptyStore.delete(knownRef!), false);
    assert.equal(await mode(join(whollyMissing.parent, "missing-parent")), 0o700);
    assert.equal(await mode(nestedRoot), 0o700);
  } finally {
    await rm(whollyMissing.parent, { recursive: true, force: true });
  }

  const tampered = await fixture();
  try {
    const ref = await tampered.store.write(writeInput());
    const paths = locations(tampered.root, ref);
    const bytes = await readFile(paths.vectors);
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(paths.vectors, bytes, { mode: 0o600 });
    assertSegmentError(
      await rejected(tampered.store.delete(ref)),
      "segment_tampered",
    );
    assert.equal((await stat(paths.segment)).isDirectory(), true);
  } finally {
    await rm(tampered.parent, { recursive: true, force: true });
  }

  const linked = await fixture();
  try {
    const ref = await linked.store.write(writeInput());
    const paths = locations(linked.root, ref);
    const outside = join(linked.parent, "outside.f32");
    await writeFile(outside, Buffer.alloc(ref.vectors_byte_length), { mode: 0o600 });
    await unlink(paths.vectors);
    await symlink(outside, paths.vectors, "file");
    assertSegmentError(
      await rejected(linked.store.delete(ref)),
      "symlink_forbidden",
    );
    assert.equal((await stat(paths.segment)).isDirectory(), true);
  } finally {
    await rm(linked.parent, { recursive: true, force: true });
  }
});
