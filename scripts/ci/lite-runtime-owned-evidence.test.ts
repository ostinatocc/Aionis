import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  materializeRuntimeOwnedEvidenceInCurrentTransaction,
} from "../../src/execution/runtime-owned-evidence.js";
import { createLiteEvidenceArtifactStore } from "../../src/store/lite-evidence-artifact-store.js";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.js";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.js";

const TENANT = "tenant-runtime-evidence";
const SCOPE = "tenant:tenant-runtime-evidence:project:real";
const EPISODE = "episode-runtime-evidence";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(length: number): Buffer {
  const value = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 31 + 17) % 251;
  }
  return value;
}

test("Runtime-owned evidence materializes exact inline and chunked bytes with deterministic replay", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aionis-runtime-evidence-"));
  const database = createLiteRuntimeDatabase(join(directory, "runtime.sqlite"));
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
  });
  const store = createLiteEvidenceArtifactStore(database);
  t.after(async () => {
    await writeStore.close();
    await database.close();
  });

  const inline = bytes(4_096);
  const chunked = bytes(2_300_001);
  const materialize = async (
    operationId: string,
    value: Buffer,
    kind: "manifest" | "state_snapshot",
  ) => await database.transaction.run(async () =>
    await materializeRuntimeOwnedEvidenceInCurrentTransaction(store, {
      tenantId: TENANT,
      scope: SCOPE,
      episodeId: EPISODE,
      operationId,
      kind,
      bytes: value,
      mediaType: "application/octet-stream",
      encoding: "binary",
      redactionPolicy: "runtime-private-v1",
      retentionPolicy: "episode-replay-v1",
    })
  );

  const inlineRef = await materialize("inline-real", inline, "manifest");
  const chunkedRef = await materialize(
    "chunked-real",
    chunked,
    "state_snapshot",
  );
  assert.equal(inlineRef.sha256, sha256(inline));
  assert.equal(chunkedRef.sha256, sha256(chunked));
  assert.equal(chunkedRef.byte_length, chunked.byteLength);
  assert.deepEqual(
    await store.readArtifactBytes({
      tenantId: TENANT,
      scope: SCOPE,
      episodeId: EPISODE,
      artifactId: inlineRef.artifact_id,
    }),
    inline,
  );
  assert.deepEqual(
    await store.readArtifactBytes({
      tenantId: TENANT,
      scope: SCOPE,
      episodeId: EPISODE,
      artifactId: chunkedRef.artifact_id,
    }),
    chunked,
  );

  const replay = await materialize(
    "chunked-real",
    chunked,
    "state_snapshot",
  );
  assert.deepEqual(replay, chunkedRef);
  await assert.rejects(
    materialize(
      "chunked-real",
      Buffer.concat([chunked.subarray(0, -1), Buffer.from([9])]),
      "state_snapshot",
    ),
    /conflict/u,
  );
});
