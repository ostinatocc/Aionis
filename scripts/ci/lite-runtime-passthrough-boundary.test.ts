import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PASSTHROUGH_SCHEMA_REGISTRY } from "../../src/memory/passthrough-schema-registry.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCHEMAS_FILE = path.join(ROOT, "src/memory/schemas.ts");

function passthroughCountsByNearestSchema(): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = fs.readFileSync(SCHEMAS_FILE, "utf8").split("\n");
  let currentSchema: string | null = null;
  for (const line of lines) {
    const schemaMatch = /^(?:export\s+)?const\s+(\w+)\s*=/.exec(line);
    if (schemaMatch) {
      currentSchema = schemaMatch[1];
    }
    if (line.includes(".passthrough(")) {
      assert.ok(currentSchema, `passthrough line must be owned by a nearby schema: ${line.trim()}`);
      counts.set(currentSchema, (counts.get(currentSchema) ?? 0) + 1);
    }
  }
  return counts;
}

test("runtime passthrough schema registry covers every open schema surface", () => {
  const sourceCounts = passthroughCountsByNearestSchema();
  const registryBySchema = new Map(RUNTIME_PASSTHROUGH_SCHEMA_REGISTRY.map((entry) => [entry.schema_name, entry]));

  assert.equal(
    registryBySchema.size,
    RUNTIME_PASSTHROUGH_SCHEMA_REGISTRY.length,
    "passthrough registry schema names must be unique",
  );

  for (const entry of RUNTIME_PASSTHROUGH_SCHEMA_REGISTRY) {
    assert.ok(entry.reason.trim().length > 0, `${entry.schema_name} must explain why its disposition is allowed`);
    if (entry.disposition === "must_be_strict") {
      assert.equal(
        sourceCounts.get(entry.schema_name) ?? 0,
        0,
        `${entry.schema_name} is a public contract and must not use passthrough`,
      );
      assert.equal(entry.passthrough_count, 0);
      assert.equal(entry.category, "public_contract_should_be_strict");
    } else {
      assert.equal(
        sourceCounts.get(entry.schema_name) ?? 0,
        entry.passthrough_count,
        `${entry.schema_name} passthrough registry entry is stale; update its disposition or count`,
      );
      assert.ok(
        entry.passthrough_count > 0,
        `${entry.schema_name} should be marked must_be_strict once it no longer uses passthrough`,
      );
    }
  }

  const unregistered = [...sourceCounts.keys()]
    .filter((schemaName) => !registryBySchema.has(schemaName))
    .sort();
  assert.deepEqual(
    unregistered,
    [],
    [
      "Every .passthrough() in src/memory/schemas.ts must be explicitly classified.",
      "Classify it as extension_payload_allowed, debug_operator_payload_allowed, or persisted_memory_payload_allowed.",
      "Stable public contracts should be marked public_contract_should_be_strict and made strict instead.",
    ].join("\n"),
  );

  for (const [schemaName, count] of [...sourceCounts.entries()].sort()) {
    const entry = registryBySchema.get(schemaName);
    assert.ok(entry, `${schemaName} must be registered`);
    assert.equal(entry.disposition, "passthrough_allowed", `${schemaName} still uses passthrough and cannot be marked strict`);
    assert.equal(
      entry.passthrough_count,
      count,
      `${schemaName} passthrough count changed; reclassify the new open surface before merging`,
    );
    assert.notEqual(
      entry.category,
      "public_contract_should_be_strict",
      `${schemaName} is still passthrough and cannot be classified as a strict public contract`,
    );
  }
});
