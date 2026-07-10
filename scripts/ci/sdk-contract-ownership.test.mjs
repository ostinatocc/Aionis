import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_REPO = process.env.AIONIS_SDK_REPO
  ? path.resolve(process.env.AIONIS_SDK_REPO)
  : path.resolve(ROOT, "..", "..", "aionis-sdk");
const RUNTIME_SDK = path.join(ROOT, "src", "sdk.ts");
const DISTRIBUTED_SDK = path.join(SDK_REPO, "src", "index.ts");
const SDK_SYNC = path.join(ROOT, "scripts", "sdk-source.mjs");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function runtimeOwnedRegions(source) {
  const regions = new Map();
  const matcher = /^\/\/ <aionis-runtime-owned:([a-z0-9-]+)>\r?$/gm;
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const name = match[1];
    const bodyStart = source.indexOf("\n", match.index) + 1;
    const endMarker = `// </aionis-runtime-owned:${name}>`;
    const bodyEnd = source.indexOf(endMarker, bodyStart);
    assert.notEqual(bodyEnd, -1, `Runtime-owned region must close: ${name}`);
    assert.equal(regions.has(name), false, `Runtime-owned region must be unique: ${name}`);
    regions.set(name, source.slice(bodyStart, bodyEnd));
    matcher.lastIndex = bodyEnd + endMarker.length;
  }
  return regions;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function declarationName(node) {
  if (!node?.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function exportedClientSurface(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const surface = [];
  for (const statement of parsed.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      surface.push(`function:${statement.name.text}`);
      continue;
    }
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const className = statement.name.text;
    surface.push(`class:${className}`);
    for (const member of statement.members) {
      if (ts.isConstructorDeclaration(member)) continue;
      if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
      const name = declarationName(member);
      if (name) surface.push(`class-member:${className}.${name}`);
    }
  }
  return surface.sort();
}

function trackedRuntimeSources() {
  const listed = spawnSync("git", ["ls-files", "src/**/*.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_GLOB_PATHSPECS: "1" },
  });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}

function relativeModuleSpecifiers(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

test("Runtime owns named SDK contract regions instead of the whole client file", () => {
  assert.equal(fs.existsSync(DISTRIBUTED_SDK), true, `missing standalone SDK: ${DISTRIBUTED_SDK}`);
  const runtimeSource = read(RUNTIME_SDK);
  const distributedSource = read(DISTRIBUTED_SDK);
  assert.notEqual(runtimeSource, distributedSource, "SDK client behavior must not remain a whole-file Runtime mirror");

  const runtimeRegions = runtimeOwnedRegions(runtimeSource);
  const distributedRegions = runtimeOwnedRegions(distributedSource);
  assert.deepEqual([...runtimeRegions.keys()].sort(), ["public-contracts"]);
  assert.deepEqual([...distributedRegions.keys()].sort(), [...runtimeRegions.keys()].sort());
  for (const [name, body] of runtimeRegions) assert.equal(distributedRegions.get(name), body, `${name} must be generated from Runtime`);
});

test("AgentContext schema and SDK prompt format have one Runtime authority", () => {
  const schemaDeclarations = trackedRuntimeSources().filter((relativePath) =>
    read(path.join(ROOT, relativePath)).includes("export const AionisAgentContextSchema ="));
  assert.deepEqual(schemaDeclarations, ["src/memory/product-output-contract.ts"]);

  const runtimeSource = read(RUNTIME_SDK);
  const distributedSource = read(DISTRIBUTED_SDK);
  const contractRegion = runtimeOwnedRegions(runtimeSource).get("public-contracts") ?? "";
  assert.match(contractRegion, /export type AionisCompiledExecutionAgentContext =/);
  assert.match(contractRegion, /export const AIONIS_EXECUTION_AGENT_CONTEXT_PROMPT_CONTRACT =/);
  assert.equal((runtimeSource.match(/AIONIS_EXECUTION_AGENT_CONTEXT v1/g) ?? []).length, 1);
  assert.equal((distributedSource.match(/AIONIS_EXECUTION_AGENT_CONTEXT v1/g) ?? []).length, 1);
  assert.match(runtimeSource, /const promptContract = AIONIS_EXECUTION_AGENT_CONTEXT_PROMPT_CONTRACT/);
  assert.match(distributedSource, /const promptContract = AIONIS_EXECUTION_AGENT_CONTEXT_PROMPT_CONTRACT/);
});

test("standalone SDK keeps the Runtime public client surface", () => {
  assert.deepEqual(
    exportedClientSurface(read(DISTRIBUTED_SDK), DISTRIBUTED_SDK),
    exportedClientSurface(read(RUNTIME_SDK), RUNTIME_SDK),
  );
});

test("SDK generated regions are clean after sync", () => {
  const before = read(DISTRIBUTED_SDK);
  const synced = spawnSync(process.execPath, [SDK_SYNC, "sync", "--sdk-repo", SDK_REPO], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(read(DISTRIBUTED_SDK), before, "clean sync must not rewrite handwritten SDK client behavior");
  const checked = spawnSync(process.execPath, [SDK_SYNC, "check", "--sdk-repo", SDK_REPO], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test("Runtime Core has no reverse dependency on the published SDK package", () => {
  const violations = [];
  for (const relativePath of trackedRuntimeSources()) {
    for (const specifier of relativeModuleSpecifiers(read(path.join(ROOT, relativePath)), relativePath)) {
      if (specifier === "@aionis/sdk" || specifier.includes("aionis-sdk")) {
        violations.push(`${relativePath}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);

  const sdkSyncSource = read(path.join(SDK_REPO, "scripts", "runtime-source.mjs"));
  assert.match(sdkSyncSource, /scripts", "sdk-source\.mjs"/);
  assert.equal(sdkSyncSource.includes("writeFileSync"), false, "SDK repo must delegate instead of owning sync semantics");
});
