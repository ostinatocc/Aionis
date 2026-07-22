import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  ContinuationRuntimeV1VectorArtifactError,
  createContinuationRuntimeV1VectorArtifactStore,
  type ContinuationRuntimeV1VectorArtifactRef,
  type ContinuationRuntimeV1VectorArtifactStore,
  type ContinuationRuntimeV1VectorArtifactWriteInput,
} from "../../src/runtime-v1/vector-artifact-store.js";

const MODEL = "embedding-model-v1";
const SOURCE_TEXT = "source text must never enter the sidecar";
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_TEXT).digest("hex");
const DOCUMENT_SHA256 = createHash("sha256")
  .update("canonical embedding document")
  .digest("hex");

async function fixture<T>(
  operation: (args: Readonly<{
    parent: string;
    root: string;
    store: ContinuationRuntimeV1VectorArtifactStore;
  }>) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "aionis-vector-artifacts-"));
  const root = join(parent, "sidecar");
  try {
    return await operation({
      parent,
      root,
      store: createContinuationRuntimeV1VectorArtifactStore({ rootPath: root }),
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function writeInput(
  vector: readonly number[] = [1 / 3, -2.25, 7.125],
  model = MODEL,
): ContinuationRuntimeV1VectorArtifactWriteInput {
  return {
    schema_version: "vector_artifact_write_v1",
    source_projection_sha256: SOURCE_SHA256,
    embedding_document_sha256: DOCUMENT_SHA256,
    model,
    dimensions: vector.length,
    vector,
  };
}

function artifactPaths(root: string, ref: ContinuationRuntimeV1VectorArtifactRef) {
  const objects = join(root, "objects");
  const shard = join(objects, ref.artifact_sha256.slice(0, 2));
  const artifact = join(shard, ref.artifact_sha256);
  return {
    objects,
    shard,
    artifact,
    metadata: join(artifact, "metadata.json"),
    vector: join(artifact, "vector.f32"),
  };
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("operation unexpectedly succeeded");
}

function assertArtifactError(
  error: Error,
  code: ContinuationRuntimeV1VectorArtifactError["code"],
): void {
  assert.ok(error instanceof ContinuationRuntimeV1VectorArtifactError);
  assert.equal(error.code, code);
  assert.equal(error.message, `continuation_runtime_v1_vector_artifact_${code}`);
  assert.equal("cause" in error, false);
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

test("vector sidecar persists only canonical digest metadata and float32 bytes with private modes", async () => {
  await fixture(async ({ root, store }) => {
    const source = writeInput();
    const ref = await store.write(source);
    const paths = artifactPaths(root, ref);
    assert.deepEqual((await readdir(paths.artifact)).sort(), [
      "metadata.json", "vector.f32",
    ]);
    for (const directory of [root, paths.objects, paths.shard, paths.artifact]) {
      assert.equal(await mode(directory), 0o700, directory);
    }
    for (const file of [paths.metadata, paths.vector]) {
      assert.equal(await mode(file), 0o600, file);
    }

    const metadataRaw = await readFile(paths.metadata, "utf8");
    const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), [
      "artifact_sha256",
      "dimensions",
      "embedding_document_sha256",
      "encoding_format",
      "model",
      "schema_version",
      "source_projection_sha256",
      "vector_byte_length",
      "vector_sha256",
    ]);
    assert.equal(metadata.schema_version, "vector_artifact_metadata_v1");
    assert.equal(metadata.source_projection_sha256, SOURCE_SHA256);
    assert.equal(metadata.embedding_document_sha256, DOCUMENT_SHA256);
    assert.equal(metadata.encoding_format, "float32_le");
    assert.equal(metadata.vector_byte_length, source.dimensions * 4);
    assert.equal(metadataRaw.includes(SOURCE_TEXT), false);
    assert.equal(metadataRaw.includes("api_key"), false);
    assert.equal((await readFile(paths.vector)).byteLength, source.dimensions * 4);

    const result = await store.read(ref);
    assert.ok(result);
    assert.deepEqual(result, {
      schema_version: "vector_artifact_read_v1",
      ref,
      encoding_format: "float32_le",
      vector: source.vector.map(Math.fround),
    });
    assert.ok(Object.isFrozen(ref));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.vector));
  });
});

test("vector sidecar is replay-safe and converges concurrent identical writes to one artifact", async () => {
  await fixture(async ({ root, store }) => {
    const writes = await Promise.all(
      Array.from({ length: 24 }, () => store.write(writeInput())),
    );
    for (const ref of writes) assert.deepEqual(ref, writes[0]);
    assert.deepEqual(await store.write(writeInput()), writes[0]);
    const paths = artifactPaths(root, writes[0]!);
    assert.deepEqual(await readdir(paths.shard), [writes[0]!.artifact_sha256]);
    assert.deepEqual((await readdir(paths.artifact)).sort(), [
      "metadata.json", "vector.f32",
    ]);
  });
});

test("vector sidecar fails closed on binary, metadata, missing-file, and ref tampering", async () => {
  await fixture(async ({ root, store }) => {
    const ref = await store.write(writeInput());
    const paths = artifactPaths(root, ref);
    const binary = await readFile(paths.vector);
    binary[0] = binary[0]! ^ 0xff;
    await writeFile(paths.vector, binary, { mode: 0o600 });
    assertArtifactError(await rejectedError(store.read(ref)), "artifact_tampered");
    assertArtifactError(await rejectedError(store.write(writeInput())), "artifact_tampered");
  });

  await fixture(async ({ root, store }) => {
    const ref = await store.write(writeInput());
    const paths = artifactPaths(root, ref);
    const metadata = await readFile(paths.metadata, "utf8");
    await writeFile(paths.metadata, metadata.replace(MODEL, "changed-model"), {
      mode: 0o600,
    });
    assertArtifactError(await rejectedError(store.read(ref)), "artifact_tampered");
  });

  await fixture(async ({ root, store }) => {
    const ref = await store.write(writeInput());
    const paths = artifactPaths(root, ref);
    await unlink(paths.vector);
    assertArtifactError(await rejectedError(store.read(ref)), "artifact_tampered");
  });

  await fixture(async ({ store }) => {
    const ref = await store.write(writeInput());
    const conflicting = { ...ref, model: "different-model" };
    assertArtifactError(
      await rejectedError(store.read(conflicting)),
      "artifact_tampered",
    );
  });
});

test("vector sidecar rejects symlink roots and artifact-file symlinks without following them", async () => {
  const parent = await mkdtemp(join(tmpdir(), "aionis-vector-symlink-root-"));
  try {
    const realRoot = join(parent, "real-root");
    const linkedRoot = join(parent, "linked-root");
    await mkdir(realRoot, { mode: 0o700 });
    await symlink(realRoot, linkedRoot, "dir");
    const store = createContinuationRuntimeV1VectorArtifactStore({ rootPath: linkedRoot });
    assertArtifactError(await rejectedError(store.write(writeInput())), "symlink_forbidden");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  await fixture(async ({ parent, root, store }) => {
    const ref = await store.write(writeInput());
    const paths = artifactPaths(root, ref);
    const outside = join(parent, "outside.f32");
    await writeFile(outside, Buffer.alloc(ref.dimensions * 4), { mode: 0o600 });
    await chmod(outside, 0o600);
    await unlink(paths.vector);
    await symlink(outside, paths.vector, "file");
    assertArtifactError(await rejectedError(store.read(ref)), "symlink_forbidden");
    assert.equal((await stat(outside)).isFile(), true);
  });
});

test("vector sidecar rejects traversal-shaped references and keeps model text out of paths", async () => {
  await fixture(async ({ parent, root, store }) => {
    assert.throws(
      () => createContinuationRuntimeV1VectorArtifactStore({
        rootPath: `${parent}/nested/../sidecar`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContinuationRuntimeV1VectorArtifactError);
        return error.code === "configuration_invalid";
      },
    );
    const malformed = {
      schema_version: "vector_artifact_ref_v1",
      source_projection_sha256: SOURCE_SHA256,
      embedding_document_sha256: DOCUMENT_SHA256,
      model: MODEL,
      dimensions: 3,
      vector_sha256: "0".repeat(64),
      artifact_sha256: "../outside",
    } as unknown as ContinuationRuntimeV1VectorArtifactRef;
    assertArtifactError(await rejectedError(store.read(malformed)), "input_invalid");

    const traversalModel = "../../model-name-is-data-only";
    const ref = await store.write(writeInput([1, 2, 3], traversalModel));
    assert.equal(ref.model, traversalModel);
    assert.equal(artifactPaths(root, ref).artifact.startsWith(`${root}/objects/`), true);
    assert.ok(await store.read(ref));
  });
});

test("vector sidecar reconcile removes crash residue without following links and verifies every artifact", async () => {
  await fixture(async ({ parent, root, store }) => {
    const ref = await store.write(writeInput());
    const paths = artifactPaths(root, ref);
    const outside = join(parent, "outside-must-survive");
    await writeFile(outside, "outside", { mode: 0o600 });
    for (const kind of ["tmp", "delete"] as const) {
      const canonicalResidue = join(
        paths.shard,
        `.${kind}-${ref.artifact_sha256}-${(kind === "tmp" ? "a" : "b").repeat(24)}`,
      );
      await mkdir(canonicalResidue, { mode: 0o700 });
      await symlink(outside, join(canonicalResidue, "outside-link"), "file");
    }
    const result = await store.reconcile();
    assert.deepEqual(result, {
      schema_version: "vector_artifact_reconcile_result_v1",
      verified_artifact_count: 1,
      removed_temporary_count: 2,
    });
    assert.deepEqual(await readdir(paths.shard), [ref.artifact_sha256]);
    assert.equal(await readFile(outside, "utf8"), "outside");
  });
});

test("vector sidecar delete verifies before removal and is replay-idempotent", async () => {
  await fixture(async ({ store }) => {
    const ref = await store.write(writeInput());
    assert.equal(await store.delete(ref), true);
    assert.equal(await store.read(ref), null);
    assert.equal(await store.delete(ref), false);
  });
});
