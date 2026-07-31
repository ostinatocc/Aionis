import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import stableStringify from "fast-json-stable-stringify";
import { zodToJsonSchema } from "zod-to-json-schema";

import { EXECUTION_SKILL_CONTRACT_SCHEMAS } from "../src/memory/execution-skill.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.resolve(
  scriptDirectory,
  "../contracts/execution-skill/v1",
);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

async function listFiles(
  root: string,
  relative = "",
): Promise<string[]> {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const child = relative.length === 0
      ? entry.name
      : path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files.sort();
}

function buildExpectedFiles(): Map<string, string> {
  const expected = new Map<string, string>();
  const schemas: Array<{
    contract_name: string;
    content_ref: string;
    path: string;
    sha256: string;
  }> = [];

  for (
    const [contractName, schema]
    of Object.entries(EXECUTION_SKILL_CONTRACT_SCHEMAS).sort(
      ([left], [right]) => left.localeCompare(right, "en"),
    )
  ) {
    const document = {
      $schema: "http://json-schema.org/draft-07/schema#",
      ...zodToJsonSchema(schema, {
        name: contractName,
        target: "jsonSchema7",
        $refStrategy: "root",
      }),
    };
    const bytes = canonicalJson(document);
    const digest = sha256(bytes);
    const relativePath = `sha256/${digest}.json`;
    expected.set(relativePath, bytes);
    schemas.push({
      contract_name: contractName,
      content_ref:
        `urn:aionis:execution-skill-schema:sha256:${digest}`,
      path: relativePath,
      sha256: digest,
    });
  }

  const manifestMaterial = {
    contract_version: "execution_skill_schema_set_v1",
    schema_version: "1",
    schemas,
  };
  const schemaSetSha256 = sha256(canonicalJson(manifestMaterial));
  expected.set("schema-set.json", canonicalJson({
    ...manifestMaterial,
    schema_set_sha256: schemaSetSha256,
  }));
  return expected;
}

async function writeExpectedFiles(expected: Map<string, string>): Promise<void> {
  await rm(outputRoot, { force: true, recursive: true });
  for (const [relativePath, bytes] of expected) {
    const target = path.join(outputRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, "utf8");
  }
}

async function checkExpectedFiles(expected: Map<string, string>): Promise<void> {
  const expectedNames = [...expected.keys()].sort();
  const actualNames = await listFiles(outputRoot);
  if (stableStringify(actualNames) !== stableStringify(expectedNames)) {
    throw new Error(
      `Execution Skill schema file set drifted.\nExpected: ${
        expectedNames.join(", ")
      }\nActual: ${actualNames.join(", ")}`,
    );
  }

  for (const [relativePath, expectedBytes] of expected) {
    const actualBytes = await readFile(
      path.join(outputRoot, relativePath),
      "utf8",
    );
    if (actualBytes !== expectedBytes) {
      throw new Error(
        `Execution Skill schema drifted: ${relativePath}`,
      );
    }
    if (relativePath.startsWith("sha256/")) {
      const expectedDigest = path.basename(relativePath, ".json");
      if (sha256(actualBytes) !== expectedDigest) {
        throw new Error(
          `Content-addressed schema path does not match bytes: ${relativePath}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error(
      "Usage: generate-execution-skill-schema.ts --write|--check",
    );
  }

  const expected = buildExpectedFiles();
  if (mode === "--write") {
    await writeExpectedFiles(expected);
  }
  await checkExpectedFiles(expected);

  const manifest = JSON.parse(
    expected.get("schema-set.json") ?? "{}",
  ) as { schema_set_sha256?: string };
  process.stdout.write(
    `execution-skill schemas: ${expected.size - 1} contracts, schema-set ${
      manifest.schema_set_sha256 ?? "unknown"
    }\n`,
  );
}

await main();
