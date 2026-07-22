import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTINUATION_RUNTIME_V1_MANIFEST_PATH,
  captureContinuationRuntimeV1SchemaManifest,
  loadContinuationRuntimeV1Ddl,
  parseContinuationRuntimeV1SchemaManifest,
  serializeContinuationRuntimeV1SchemaManifest,
  type ContinuationRuntimeV1SchemaManifest,
} from "../src/store/continuation-runtime-v1-schema.js";
import { createSqliteDatabase } from "../src/store/sqlite.js";
import { stableJson } from "../src/util/stable-json.js";

function assertDatabaseIntegrity(manifestDatabase: ReturnType<typeof createSqliteDatabase>): void {
  const integrity = manifestDatabase.prepare("PRAGMA integrity_check").all() as Array<
    Record<string, unknown>
  >;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
    throw new Error("continuation_runtime_v1_schema_generation_integrity_failed");
  }
  if (manifestDatabase.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("continuation_runtime_v1_schema_generation_foreign_key_check_failed");
  }
}

/** Executes the sole DDL source in real node:sqlite and captures its logical shape. */
export function generateContinuationRuntimeV1SchemaManifest(): ContinuationRuntimeV1SchemaManifest {
  const database = createSqliteDatabase(":memory:");
  try {
    database.exec(loadContinuationRuntimeV1Ddl());
    assertDatabaseIntegrity(database);
    return parseContinuationRuntimeV1SchemaManifest(
      captureContinuationRuntimeV1SchemaManifest(database),
    );
  } finally {
    database.close();
  }
}

export function checkContinuationRuntimeV1SchemaManifest(
  manifestPath = CONTINUATION_RUNTIME_V1_MANIFEST_PATH,
): ContinuationRuntimeV1SchemaManifest {
  const raw = readFileSync(manifestPath, "utf8");
  const checkedIn = parseContinuationRuntimeV1SchemaManifest(JSON.parse(raw) as unknown);
  const canonicalCheckedIn = serializeContinuationRuntimeV1SchemaManifest(checkedIn);
  if (raw !== canonicalCheckedIn) {
    throw new Error("continuation_runtime_v1_schema_manifest_not_canonical");
  }
  const generated = generateContinuationRuntimeV1SchemaManifest();
  if (stableJson(checkedIn) !== stableJson(generated)) {
    throw new Error(
      `continuation_runtime_v1_schema_manifest_stale:expected=${generated.schema_sha256}:actual=${checkedIn.schema_sha256}`,
    );
  }
  return checkedIn;
}

export function writeContinuationRuntimeV1SchemaManifest(
  manifestPath = CONTINUATION_RUNTIME_V1_MANIFEST_PATH,
): ContinuationRuntimeV1SchemaManifest {
  const generated = generateContinuationRuntimeV1SchemaManifest();
  writeFileSync(manifestPath, serializeContinuationRuntimeV1SchemaManifest(generated), "utf8");
  return generated;
}

export function runContinuationRuntimeV1SchemaManifestTool(argv: readonly string[]): void {
  if (argv.length !== 1 || (argv[0] !== "--check" && argv[0] !== "--write")) {
    throw new Error(
      "usage: npx tsx tools/generate-continuation-runtime-v1-manifest.ts --check|--write",
    );
  }
  const mode = argv[0];
  const manifest = mode === "--check"
    ? checkContinuationRuntimeV1SchemaManifest()
    : writeContinuationRuntimeV1SchemaManifest();
  process.stdout.write(
    `${mode === "--check" ? "checked" : "wrote"} continuation Runtime V1 schema manifest ${manifest.schema_sha256}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runContinuationRuntimeV1SchemaManifestTool(process.argv.slice(2));
}
