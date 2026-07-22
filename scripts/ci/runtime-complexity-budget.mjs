#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODE_EXTENSIONS = Object.freeze(["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"]);
const RESOURCE_EXTENSIONS = Object.freeze(["sql", "json", "md"]);
const SCRIPT_EXTENSIONS = new Set([...CODE_EXTENSIONS, "sh", "json"]);
const ENTRYPOINTS = Object.freeze({
  daemon: "src/runtime-v1/daemon-entry.ts",
  provisioning: "src/runtime-v1/provisioning-entry.ts",
  sdk: "src/runtime-v1/sdk.ts",
  worker: "src/runtime-v1/worker-entry.ts",
});
const ROUTE_INVENTORY_PATH = "src/runtime-v1/http-surface.ts";
const SCHEMA_INVENTORY_PATH = "src/store/continuation-runtime-v1-schema.ts";
const ENVIRONMENT_INVENTORIES = Object.freeze({
  daemon: Object.freeze({
    path: "src/runtime-v1/config.ts",
    variable: "CONTINUATION_RUNTIME_V1_DAEMON_ENV_FIELDS",
    expected_count: 13,
  }),
  provisioning: Object.freeze({
    path: "src/runtime-v1/provisioning-config.ts",
    variable: "CONTINUATION_RUNTIME_V1_PROVISIONING_ENV_FIELDS",
    expected_count: 4,
  }),
  worker: Object.freeze({
    path: "src/runtime-v1/worker-config.ts",
    variable: "CONTINUATION_RUNTIME_V1_WORKER_ENV_FIELDS",
    expected_count: 16,
  }),
});
const EXPECTED_ENVIRONMENT_FIELD_UNION_COUNT = 24;
const DDL_PATH = "src/store/sql/continuation-runtime-v1.sql";
const MANIFEST_PATH = "src/store/sql/continuation-runtime-v1.manifest.json";
const V1_RESOURCE_PATHS = new Set([
  DDL_PATH,
  MANIFEST_PATH,
  "packages/sdk/package.json",
  "packages/sdk/README.md",
]);
const V1_SQLITE_SUPPORT_PATHS = new Set([
  "src/store/sqlite-schema-sql.ts",
  "src/store/sqlite-transaction-runner.ts",
  "src/store/sqlite.ts",
]);
const V1_UTIL_PATHS = new Set([
  "src/util/crypto.ts",
  "src/util/stable-json.ts",
]);
const V1_TOOL_PATHS = new Set([
  "packages/sdk/build.mjs",
  "tools/author-continuation-runtime-v1-authority.ts",
  "tools/build-continuation-runtime-v1-authority.mjs",
  "tools/clean-continuation-runtime-v1-build.mjs",
  "tools/continuation-runtime-v1-authority-authoring.ts",
  "tools/continuation-runtime-v1-authority-key.ts",
  "tools/copy-continuation-runtime-v1-assets.mjs",
  "tools/generate-continuation-runtime-v1-authority-keys.mjs",
  "tools/generate-continuation-runtime-v1-cohort-seed.mjs",
  "tools/generate-continuation-runtime-v1-manifest.ts",
  "tools/stage-continuation-runtime-v1-oci.mjs",
]);
const V1_GATE_PATHS = new Set([
  "scripts/ci/continuation-runtime-v1-container-smoke.mjs",
  "scripts/ci/runtime-complexity-budget.mjs",
  "scripts/ci/runtime-complexity-budget.test.mjs",
]);
const EXPECTED_PUBLIC_ROUTES = 5;
const EXPECTED_PROBE_ROUTES = 2;
const EXPECTED_SCHEMA_TABLES = 17;
const EXPECTED_ROUTE_INVENTORY_SOURCE_FILES = 1;
const REPORT_SCHEMA = "aionis_runtime_v1_complexity_report_v2";
const BUDGET_SCHEMA = "aionis_runtime_v1_complexity_budget_v2";

const METRIC_KEYS = Object.freeze([
  "daemon_entry_source_files",
  "daemon_entry_source_lines",
  "daemon_environment_field_count",
  "worker_entry_source_files",
  "worker_entry_source_lines",
  "worker_environment_field_count",
  "provisioning_entry_source_files",
  "provisioning_entry_source_lines",
  "provisioning_environment_field_count",
  "sdk_entry_source_files",
  "sdk_entry_source_lines",
  "environment_inventory_source_files",
  "environment_field_union_count",
  "v1_production_union_source_files",
  "v1_production_union_source_lines",
  "v1_total_source_files",
  "v1_total_source_lines",
  "v1_nonproduction_source_files",
  "v1_nonproduction_source_lines",
  "v1_test_files",
  "v1_test_lines",
  "v1_gate_files",
  "v1_gate_lines",
  "v1_test_artifact_files",
  "v1_test_artifact_lines",
  "v1_tool_files",
  "v1_tool_lines",
  "v1_resource_files",
  "v1_resource_lines",
  "v1_largest_production_file_lines",
  "v1_largest_source_file_lines",
  "v1_largest_test_file_lines",
  "v1_largest_tool_file_lines",
  "v1_production_runtime_import_cycles",
  "v1_total_runtime_import_cycles",
  "v1_full_type_dependency_scc_count",
  "public_route_count",
  "probe_route_count",
  "route_inventory_source_files",
  "schema_table_count",
]);
export const COMPLEXITY_HARD_THRESHOLD_METRICS = Object.freeze([
  "daemon_entry_source_lines",
  "daemon_environment_field_count",
  "worker_entry_source_lines",
  "worker_environment_field_count",
  "provisioning_entry_source_lines",
  "provisioning_environment_field_count",
  "sdk_entry_source_lines",
  "environment_inventory_source_files",
  "environment_field_union_count",
  "v1_production_union_source_lines",
  "v1_total_source_lines",
  "v1_resource_files",
  "v1_largest_production_file_lines",
  "v1_largest_source_file_lines",
  "v1_production_runtime_import_cycles",
  "v1_total_runtime_import_cycles",
  "v1_full_type_dependency_scc_count",
  "public_route_count",
  "probe_route_count",
  "route_inventory_source_files",
  "schema_table_count",
]);
const HARD_THRESHOLD_METRIC_SET = new Set(COMPLEXITY_HARD_THRESHOLD_METRICS);
export const COMPLEXITY_OBSERVATION_METRICS = Object.freeze(
  METRIC_KEYS.filter((key) => !HARD_THRESHOLD_METRIC_SET.has(key)),
);
const EXACT_THRESHOLD_METRICS = new Set([
  "daemon_environment_field_count",
  "worker_environment_field_count",
  "provisioning_environment_field_count",
  "environment_inventory_source_files",
  "environment_field_union_count",
  "v1_resource_files",
  "public_route_count",
  "probe_route_count",
  "route_inventory_source_files",
  "schema_table_count",
]);

function fail(message) {
  throw new Error(`continuation_runtime_v1_complexity_${message}`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function pathspecs(root, extensions) {
  return extensions.map((extension) => `${root}/**/*.${extension}`);
}

function workspaceFiles(...pathspecList) {
  if (pathspecList.length === 0) fail("inventory_pathspec_missing");
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...pathspecList],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_GLOB_PATHSPECS: "1" },
    },
  );
  if (result.status !== 0) {
    fail(`git_inventory_failed:${result.stderr.trim() || `exit_${result.status}`}`);
  }
  return [...new Set(result.stdout.split(/\r?\n/u)
    .map((value) => toPosix(value.trim()))
    .filter((value) => value.length > 0 && fs.existsSync(path.join(ROOT, value))))]
    .sort();
}

function countLines(source) {
  if (source.length === 0) return 0;
  return (source.match(/\n/gu)?.length ?? 0) + (source.endsWith("\n") ? 0 : 1);
}

function fileEntries(paths) {
  return paths.map((relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath));
    return Object.freeze({
      path: relativePath,
      lines: countLines(source.toString("utf8")),
      sha256: createHash("sha256").update(source).digest("hex"),
    });
  });
}

function sumLines(entries) {
  return entries.reduce((total, entry) => total + entry.lines, 0);
}

function largestLines(entries) {
  return entries.reduce((maximum, entry) => Math.max(maximum, entry.lines), 0);
}

function largestFiles(entries, maximum = 12) {
  return [...entries]
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))
    .slice(0, maximum)
    .map(({ path: relativePath, lines }) => Object.freeze({ path: relativePath, lines }));
}

function digestEntries(entries) {
  return createHash("sha256").update(canonicalJson(entries.map((entry) => ({
    path: entry.path,
    lines: entry.lines,
    sha256: entry.sha256,
  })))).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("canonical_number_invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") fail("canonical_value_invalid");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function parseSource(relativePath, source) {
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.getScriptKindFromFileName(relativePath),
  );
}

function exactVariableInitializer(sourceFile, variableName) {
  const matches = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName) {
        matches.push(declaration.initializer ?? null);
      }
    }
  }
  if (matches.length !== 1 || matches[0] === null) {
    fail(`source_anchor_invalid:${sourceFile.fileName}:${variableName}`);
  }
  return matches[0];
}

function unwrapExpression(expression) {
  let current = expression;
  while (true) {
    if (ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isParenthesizedExpression(current)
      || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current) && current.arguments.length === 1
      && ts.isPropertyAccessExpression(current.expression)
      && ts.isIdentifier(current.expression.expression)
      && current.expression.expression.text === "Object"
      && current.expression.name.text === "freeze") {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

function frozenArray(sourceFile, variableName) {
  const value = unwrapExpression(exactVariableInitializer(sourceFile, variableName));
  if (!ts.isArrayLiteralExpression(value)) {
    fail(`source_anchor_not_array:${sourceFile.fileName}:${variableName}`);
  }
  return value;
}

function objectLiteral(value) {
  const unwrapped = unwrapExpression(value);
  return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : null;
}

function literalObjectProperties(value) {
  const object = objectLiteral(value);
  if (!object) return null;
  const result = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) return null;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text : null;
    const initializer = unwrapExpression(property.initializer);
    if (name === null || !ts.isStringLiteralLike(initializer)) return null;
    result.set(name, initializer.text);
  }
  return result;
}

function routeArray(sourceFile, variableName, kind) {
  const routes = frozenArray(sourceFile, variableName).elements.map((element) => {
    const properties = literalObjectProperties(element);
    if (!properties) fail(`route_entry_invalid:${variableName}`);
    const method = properties.get("method");
    const routePath = properties.get("path");
    const routeId = properties.get("route_id");
    if (!method || !routePath || !routeId) fail(`route_entry_invalid:${variableName}`);
    if (kind === "public" ? !routePath.startsWith("/v1/") : routePath.startsWith("/v1/")) {
      fail(`route_namespace_invalid:${variableName}`);
    }
    return Object.freeze({ method, path: routePath, route_id: routeId });
  });
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  if (new Set(keys).size !== keys.length
    || new Set(routes.map((route) => route.route_id)).size !== routes.length) {
    fail(`route_inventory_duplicate:${variableName}`);
  }
  return routes;
}

function routeInventorySourceFiles(parsedV1Sources) {
  const result = new Set();
  for (const [relativePath, sourceFile] of parsedV1Sources) {
    const visit = (node) => {
      if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2) {
        const entries = node.elements.map(literalObjectProperties);
        if (entries.every((entry) => entry !== null
          && entry.has("method") && entry.has("path") && entry.has("route_id"))) {
          result.add(relativePath);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...result].sort();
}

function stringArray(sourceFile, variableName) {
  return frozenArray(sourceFile, variableName).elements.map((element) => {
    const value = unwrapExpression(element);
    if (!ts.isStringLiteralLike(value)) fail(`string_inventory_invalid:${variableName}`);
    return value.text;
  });
}

function environmentInventoryReport(parsedSources) {
  const counts = {};
  const fieldsByProcess = {};
  const sourcePaths = [];
  for (const [processName, inventory] of Object.entries(ENVIRONMENT_INVENTORIES)) {
    const sourceFile = parsedSources.get(inventory.path);
    if (!sourceFile) fail(`environment_inventory_missing:${inventory.path}`);
    const fields = stringArray(sourceFile, inventory.variable);
    if (fields.length !== inventory.expected_count
      || new Set(fields).size !== fields.length) {
      fail(`environment_inventory_invalid:${processName}`);
    }
    counts[processName] = fields.length;
    fieldsByProcess[processName] = fields;
    sourcePaths.push(inventory.path);
  }
  sourcePaths.sort();
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    fail("environment_inventory_source_duplicate");
  }
  const union = new Set(Object.values(fieldsByProcess).flat());
  if (union.size !== EXPECTED_ENVIRONMENT_FIELD_UNION_COUNT) {
    fail(`environment_inventory_union_invalid:actual=${union.size}`);
  }
  return Object.freeze({
    counts: Object.freeze(counts),
    source_paths: Object.freeze(sourcePaths),
    union_count: union.size,
    union_fields: Object.freeze([...union].sort()),
  });
}

function moduleDependencySpecifiers(sourceFile) {
  const fullTypeDependencies = new Set();
  const runtimeImports = new Set();
  const add = (value, runtime) => {
    if (value && ts.isStringLiteralLike(value)
      && (value.text.startsWith("./") || value.text.startsWith("../"))) {
      fullTypeDependencies.add(value.text);
      if (runtime) runtimeImports.add(value.text);
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importClause = statement.importClause;
      let runtime = importClause === undefined || !importClause.isTypeOnly;
      if (runtime && importClause?.name === undefined
        && importClause?.namedBindings !== undefined
        && ts.isNamedImports(importClause.namedBindings)) {
        runtime = importClause.namedBindings.elements.some((element) => !element.isTypeOnly);
      }
      add(statement.moduleSpecifier, runtime);
    } else if (ts.isExportDeclaration(statement)) {
      let runtime = !statement.isTypeOnly;
      if (runtime && statement.exportClause !== undefined
        && ts.isNamedExports(statement.exportClause)) {
        runtime = statement.exportClause.elements.some((element) => !element.isTypeOnly);
      }
      add(statement.moduleSpecifier, runtime);
    } else if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)) {
      add(statement.moduleReference.expression, !statement.isTypeOnly);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        add(node.arguments[0], true);
      }
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze({
    full_type_dependencies: [...fullTypeDependencies].sort(),
    runtime_imports: [...runtimeImports].sort(),
  });
}

export function relativeModuleSpecifiersFromText(relativePath, source) {
  return moduleDependencySpecifiers(parseSource(relativePath, source)).full_type_dependencies;
}

export function runtimeModuleSpecifiersFromText(relativePath, source) {
  return moduleDependencySpecifiers(parseSource(relativePath, source)).runtime_imports;
}

function resolveRelativeImport(fromPath, moduleSpecifier, artifactSet) {
  const base = path.posix.normalize(path.posix.join(
    path.posix.dirname(fromPath),
    moduleSpecifier,
  ));
  const extension = path.posix.extname(base);
  const candidates = [];
  if (extension === ".js") {
    candidates.push(base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  } else if (extension === ".mjs") {
    candidates.push(base, `${base.slice(0, -4)}.mts`, `${base.slice(0, -4)}.mjs`);
  } else if (extension === ".cjs") {
    candidates.push(base, `${base.slice(0, -4)}.cts`, `${base.slice(0, -4)}.cjs`);
  } else if ([...CODE_EXTENSIONS, ...RESOURCE_EXTENSIONS].map((item) => `.${item}`)
    .includes(extension)) {
    candidates.push(base);
  } else if (extension.length === 0) {
    for (const codeExtension of CODE_EXTENSIONS) {
      candidates.push(`${base}.${codeExtension}`, `${base}/index.${codeExtension}`);
    }
  }
  return candidates.find((candidate) => artifactSet.has(candidate)) ?? null;
}

export function classifyV1SourcePath(relativePath) {
  if (relativePath.startsWith("src/continuation/")) return "v1_source";
  if (relativePath.startsWith("src/runtime-v1/")) return "v1_source";
  if (/^src\/store\/continuation-runtime-v1-[^/]+\.ts$/u.test(relativePath)) {
    return "v1_source";
  }
  if (V1_SQLITE_SUPPORT_PATHS.has(relativePath) || V1_UTIL_PATHS.has(relativePath)) {
    return "v1_source";
  }
  return "legacy_source";
}

export function classifyScriptPath(relativePath) {
  if (V1_GATE_PATHS.has(relativePath)) return "v1_gate";
  if (/^scripts\/ci\/lite-continuation-[^/]+\.test\.ts$/u.test(relativePath)) {
    return "v1_test";
  }
  if (/^scripts\/ci\/support\/continuation-runtime-v1-[^/]+\.ts$/u.test(relativePath)) {
    return "v1_test_support";
  }
  const extension = path.posix.extname(relativePath).slice(1);
  return SCRIPT_EXTENSIONS.has(extension) ? "legacy_script" : "unclassified_script";
}

export function classifyToolPath(relativePath) {
  if (V1_TOOL_PATHS.has(relativePath)) return "v1_tool";
  const extension = path.posix.extname(relativePath).slice(1);
  return SCRIPT_EXTENSIONS.has(extension) ? "legacy_tool" : "unclassified_tool";
}

export function classifyResourcePath(relativePath) {
  return V1_RESOURCE_PATHS.has(relativePath) ? "v1_resource" : "legacy_resource";
}

const DAEMON_FORBIDDEN_CAPABILITY_EXACT_PATHS = new Set([
  "src/runtime-v1/effect-signer.ts",
  "src/runtime-v1/embedding-provider.ts",
  "src/store/continuation-runtime-v1-authority-artifact-provisioner.ts",
  "src/store/continuation-runtime-v1-durable-job-store.ts",
  "src/store/continuation-runtime-v1-effect-certificate-writer.ts",
]);

export function isDaemonForbiddenCapabilityPath(relativePath) {
  if (DAEMON_FORBIDDEN_CAPABILITY_EXACT_PATHS.has(relativePath)) return true;
  if (!relativePath.startsWith("src/runtime-v1/")) return false;
  const basename = path.posix.basename(relativePath);
  return basename.includes("worker") || basename.startsWith("provisioning");
}

function buildV1ImportGraphs(v1Paths, parsedSources, allArtifacts) {
  const v1Set = new Set(v1Paths);
  const fullTypeDependencyGraph = new Map(
    v1Paths.map((relativePath) => [relativePath, new Set()]),
  );
  const runtimeImportGraph = new Map(
    v1Paths.map((relativePath) => [relativePath, new Set()]),
  );
  for (const relativePath of v1Paths) {
    const sourceFile = parsedSources.get(relativePath);
    const dependencies = moduleDependencySpecifiers(sourceFile);
    const resolvedBySpecifier = new Map();
    for (const specifier of dependencies.full_type_dependencies) {
      const resolved = resolveRelativeImport(relativePath, specifier, allArtifacts);
      if (resolved === null) fail(`relative_import_unresolved:${relativePath}:${specifier}`);
      if (V1_RESOURCE_PATHS.has(resolved)) continue;
      if (!v1Set.has(resolved)) {
        fail(`v1_source_imports_forbidden_legacy:${relativePath}:${resolved}`);
      }
      resolvedBySpecifier.set(specifier, resolved);
      fullTypeDependencyGraph.get(relativePath).add(resolved);
    }
    for (const specifier of dependencies.runtime_imports) {
      const resolved = resolvedBySpecifier.get(specifier);
      if (resolved !== undefined) runtimeImportGraph.get(relativePath).add(resolved);
    }
  }
  return Object.freeze({ fullTypeDependencyGraph, runtimeImportGraph });
}

function validateV1ScriptImports(paths, parsedSources, allArtifacts) {
  for (const relativePath of paths) {
    const sourceFile = parsedSources.get(relativePath);
    if (!sourceFile) continue;
    for (const specifier of moduleDependencySpecifiers(sourceFile).full_type_dependencies) {
      const resolved = resolveRelativeImport(relativePath, specifier, allArtifacts);
      if (resolved === null) fail(`relative_import_unresolved:${relativePath}:${specifier}`);
      const allowed = V1_RESOURCE_PATHS.has(resolved)
        || classifyV1SourcePath(resolved) === "v1_source"
        || classifyScriptPath(resolved) === "v1_test"
        || classifyScriptPath(resolved) === "v1_test_support"
        || classifyScriptPath(resolved) === "v1_gate"
        || classifyToolPath(resolved) === "v1_tool";
      if (!allowed) fail(`v1_script_imports_forbidden_legacy:${relativePath}:${resolved}`);
    }
  }
}

function reachableModules(graph, entryPath) {
  if (!graph.has(entryPath)) fail(`entry_missing:${entryPath}`);
  const visited = new Set();
  const pending = [entryPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const dependency of graph.get(current) ?? []) pending.push(dependency);
  }
  return [...visited].sort();
}

function inducedGraph(graph, paths) {
  const selected = new Set(paths);
  return new Map([...selected].sort().map((relativePath) => [
    relativePath,
    new Set([...(graph.get(relativePath) ?? [])].filter((item) => selected.has(item))),
  ]));
}

function stronglyConnectedImportCycles(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  const visit = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const neighbor of [...(graph.get(node) ?? [])].sort()) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(neighbor)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    component.sort();
    if (component.length > 1 || (graph.get(component[0]) ?? new Set()).has(component[0])) {
      cycles.push(component);
    }
  };
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node);
  return cycles.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function closureReport(entryPath, paths, entriesByPath) {
  const entries = paths.map((relativePath) => entriesByPath.get(relativePath));
  return Object.freeze({
    entry_path: entryPath,
    source_files: entries.length,
    source_lines: sumLines(entries),
    source_sha256: digestEntries(entries),
  });
}

function legacyPresenceReport(groups) {
  const allPaths = [...new Set(Object.values(groups).flat())].sort();
  return Object.freeze({
    source_files: groups.source.length,
    source_lines: sumLines(fileEntries(groups.source)),
    script_files: groups.scripts.length,
    script_lines: sumLines(fileEntries(groups.scripts)),
    tool_files: groups.tools.length,
    tool_lines: sumLines(fileEntries(groups.tools)),
    resource_files: groups.resources.length,
    resource_lines: sumLines(fileEntries(groups.resources)),
    total_files: allPaths.length,
    inventory_sha256: createHash("sha256").update(canonicalJson(allPaths)).digest("hex"),
  });
}

function assertStrictNoLegacy(groups) {
  const paths = [...new Set(Object.values(groups).flat())].sort();
  if (paths.length === 0) return;
  const preview = paths.slice(0, 20).join(",");
  const suffix = paths.length > 20 ? `,+${paths.length - 20}_more` : "";
  fail(`strict_no_legacy_failed:${preview}${suffix}`);
}

export function collectRuntimeComplexity(options = {}) {
  const mode = options.mode ?? "v1_inventory";
  if (mode !== "v1_inventory" && mode !== "strict_no_legacy") {
    fail(`mode_invalid:${mode}`);
  }
  const srcCodePaths = workspaceFiles(...pathspecs("src", CODE_EXTENSIONS));
  const packageCodePaths = workspaceFiles(...pathspecs("packages", CODE_EXTENSIONS));
  const packageSourcePaths = packageCodePaths.filter((item) => !V1_TOOL_PATHS.has(item));
  const sourcePaths = [...srcCodePaths, ...packageSourcePaths].sort();
  const srcResourcePaths = workspaceFiles(...pathspecs("src", RESOURCE_EXTENSIONS));
  const packageResourcePaths = workspaceFiles(...pathspecs("packages", RESOURCE_EXTENSIONS));
  const resourcePaths = [...srcResourcePaths, ...packageResourcePaths].sort();
  const scriptPaths = workspaceFiles("scripts/**");
  const toolPaths = workspaceFiles("tools/**", "packages/sdk/build.mjs");
  const scriptClassifications = new Map(scriptPaths.map((item) => [item, classifyScriptPath(item)]));
  const toolClassifications = new Map(toolPaths.map((item) => [item, classifyToolPath(item)]));
  const unclassified = [
    ...[...scriptClassifications].filter(([, kind]) => kind === "unclassified_script")
      .map(([item]) => item),
    ...[...toolClassifications].filter(([, kind]) => kind === "unclassified_tool")
      .map(([item]) => item),
  ].sort();
  if (unclassified.length > 0) fail(`unclassified_script:${unclassified.join(",")}`);

  const v1SourcePaths = srcCodePaths.filter(
    (relativePath) => classifyV1SourcePath(relativePath) === "v1_source",
  );
  const legacySourcePaths = sourcePaths.filter(
    (relativePath) => !v1SourcePaths.includes(relativePath),
  );
  const v1ResourcePaths = resourcePaths.filter(
    (item) => classifyResourcePath(item) === "v1_resource",
  );
  const legacyResourcePaths = resourcePaths.filter(
    (item) => classifyResourcePath(item) === "legacy_resource",
  );
  if (v1ResourcePaths.length !== V1_RESOURCE_PATHS.size
    || [...V1_RESOURCE_PATHS].some((item) => !v1ResourcePaths.includes(item))) {
    fail("v1_resource_inventory_incomplete");
  }
  const v1TestPaths = [...scriptClassifications]
    .filter(([, kind]) => kind === "v1_test" || kind === "v1_test_support")
    .map(([item]) => item).sort();
  const v1GatePaths = [...scriptClassifications]
    .filter(([, kind]) => kind === "v1_gate")
    .map(([item]) => item).sort();
  const legacyScriptPaths = [...scriptClassifications]
    .filter(([, kind]) => kind === "legacy_script")
    .map(([item]) => item).sort();
  const v1ToolPaths = [...toolClassifications]
    .filter(([, kind]) => kind === "v1_tool")
    .map(([item]) => item).sort();
  const legacyToolPaths = [...toolClassifications]
    .filter(([, kind]) => kind === "legacy_tool")
    .map(([item]) => item).sort();
  if (v1GatePaths.length !== V1_GATE_PATHS.size
    || v1ToolPaths.length !== V1_TOOL_PATHS.size) fail("v1_script_inventory_incomplete");

  const parsePaths = [...new Set([
    ...v1SourcePaths,
    ...v1TestPaths,
    ...v1GatePaths,
    ...v1ToolPaths,
  ].filter((item) => CODE_EXTENSIONS.includes(path.extname(item).slice(1))))].sort();
  const parsedSources = new Map(parsePaths.map((relativePath) => [
    relativePath,
    parseSource(relativePath, fs.readFileSync(path.join(ROOT, relativePath), "utf8")),
  ]));
  const allArtifacts = new Set([
    ...sourcePaths,
    ...resourcePaths,
    ...scriptPaths,
    ...toolPaths,
  ]);
  const { fullTypeDependencyGraph, runtimeImportGraph } = buildV1ImportGraphs(
    v1SourcePaths,
    parsedSources,
    allArtifacts,
  );
  validateV1ScriptImports(
    [...v1TestPaths, ...v1GatePaths, ...v1ToolPaths],
    parsedSources,
    allArtifacts,
  );
  const sourceEntries = fileEntries(v1SourcePaths);
  const entriesByPath = new Map(sourceEntries.map((entry) => [entry.path, entry]));
  const closurePaths = Object.fromEntries(Object.entries(ENTRYPOINTS).map(([name, entryPath]) => [
    name,
    reachableModules(runtimeImportGraph, entryPath),
  ]));
  const daemonForbiddenCapabilityPaths = closurePaths.daemon
    .filter(isDaemonForbiddenCapabilityPath);
  if (daemonForbiddenCapabilityPaths.length > 0) {
    fail(`daemon_forbidden_capability:${daemonForbiddenCapabilityPaths.join(",")}`);
  }
  const environmentInventory = environmentInventoryReport(parsedSources);
  const productionUnionPaths = [...new Set(Object.values(closurePaths).flat())].sort();
  const productionUnionEntries = productionUnionPaths.map((item) => entriesByPath.get(item));
  const nonproductionPaths = v1SourcePaths.filter((item) => !productionUnionPaths.includes(item));
  const nonproductionEntries = nonproductionPaths.map((item) => entriesByPath.get(item));
  const totalRuntimeCycles = stronglyConnectedImportCycles(runtimeImportGraph);
  const productionRuntimeCycles = stronglyConnectedImportCycles(
    inducedGraph(runtimeImportGraph, productionUnionPaths),
  );
  const fullTypeDependencySccs = stronglyConnectedImportCycles(fullTypeDependencyGraph);
  if (totalRuntimeCycles.length > 0 || productionRuntimeCycles.length > 0) {
    fail(`runtime_import_cycle_detected:${canonicalJson(totalRuntimeCycles)}`);
  }

  const routeSource = parsedSources.get(ROUTE_INVENTORY_PATH);
  if (!routeSource) fail("route_inventory_missing");
  const publicRoutes = routeArray(
    routeSource,
    "CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES",
    "public",
  );
  const probeRoutes = routeArray(
    routeSource,
    "CONTINUATION_RUNTIME_V1_PROBE_ROUTES",
    "probe",
  );
  const allRouteKeys = [...publicRoutes, ...probeRoutes]
    .map((route) => `${route.method} ${route.path}`);
  if (new Set(allRouteKeys).size !== allRouteKeys.length) fail("route_inventory_duplicate");
  const routeInventoryFiles = routeInventorySourceFiles(
    new Map(v1SourcePaths.map((item) => [item, parsedSources.get(item)])),
  );
  if (publicRoutes.length !== EXPECTED_PUBLIC_ROUTES
    || probeRoutes.length !== EXPECTED_PROBE_ROUTES
    || routeInventoryFiles.length !== EXPECTED_ROUTE_INVENTORY_SOURCE_FILES
    || routeInventoryFiles[0] !== ROUTE_INVENTORY_PATH) {
    fail("public_surface_invariant_failed");
  }

  const schemaSource = parsedSources.get(SCHEMA_INVENTORY_PATH);
  if (!schemaSource) fail("schema_inventory_missing");
  const sourceTables = stringArray(schemaSource, "CONTINUATION_RUNTIME_V1_TABLES");
  const ddl = fs.readFileSync(path.join(ROOT, DDL_PATH), "utf8");
  const ddlTables = [...ddl.matchAll(/^\s*CREATE TABLE\s+([a-z_][a-z0-9_]*)\s*\(/gimu)]
    .map((match) => match[1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_PATH), "utf8"));
  const manifestTables = Array.isArray(manifest.tables) ? manifest.tables : [];
  const canonicalTables = [...sourceTables].sort();
  for (const inventory of [sourceTables, ddlTables, manifestTables]) {
    if (inventory.length !== EXPECTED_SCHEMA_TABLES
      || new Set(inventory).size !== inventory.length
      || canonicalJson([...inventory].sort()) !== canonicalJson(canonicalTables)) {
      fail("schema_table_inventory_mismatch");
    }
  }

  const testEntries = fileEntries(v1TestPaths);
  const gateEntries = fileEntries(v1GatePaths);
  const testArtifactEntries = [...testEntries, ...gateEntries]
    .sort((left, right) => left.path.localeCompare(right.path));
  const toolEntries = fileEntries(v1ToolPaths);
  const resourceEntries = fileEntries(v1ResourcePaths);
  const legacyGroups = Object.freeze({
    source: legacySourcePaths,
    scripts: legacyScriptPaths,
    tools: legacyToolPaths,
    resources: legacyResourcePaths,
  });
  const report = Object.freeze({
    schema_version: REPORT_SCHEMA,
    mode,
    entry_closures: Object.freeze(Object.fromEntries(
      Object.entries(ENTRYPOINTS).map(([name, entryPath]) => [
        name,
        closureReport(entryPath, closurePaths[name], entriesByPath),
      ]),
    )),
    daemon_environment_field_count: environmentInventory.counts.daemon,
    worker_environment_field_count: environmentInventory.counts.worker,
    provisioning_environment_field_count: environmentInventory.counts.provisioning,
    environment_inventory_source_files: environmentInventory.source_paths.length,
    environment_inventory_source_paths: environmentInventory.source_paths,
    environment_field_union_count: environmentInventory.union_count,
    environment_field_union: environmentInventory.union_fields,
    daemon_forbidden_capability_paths: Object.freeze(daemonForbiddenCapabilityPaths),
    v1_production_union_source_files: productionUnionEntries.length,
    v1_production_union_source_lines: sumLines(productionUnionEntries),
    v1_production_union_source_sha256: digestEntries(productionUnionEntries),
    v1_total_source_files: sourceEntries.length,
    v1_total_source_lines: sumLines(sourceEntries),
    v1_total_source_sha256: digestEntries(sourceEntries),
    v1_nonproduction_source_files: nonproductionEntries.length,
    v1_nonproduction_source_lines: sumLines(nonproductionEntries),
    v1_test_files: testEntries.length,
    v1_test_lines: sumLines(testEntries),
    v1_test_sha256: digestEntries(testEntries),
    v1_gate_files: gateEntries.length,
    v1_gate_lines: sumLines(gateEntries),
    v1_test_artifact_files: testArtifactEntries.length,
    v1_test_artifact_lines: sumLines(testArtifactEntries),
    v1_tool_files: toolEntries.length,
    v1_tool_lines: sumLines(toolEntries),
    v1_tool_sha256: digestEntries(toolEntries),
    v1_resource_files: resourceEntries.length,
    v1_resource_lines: sumLines(resourceEntries),
    v1_resource_sha256: digestEntries(resourceEntries),
    v1_largest_production_file_lines: largestLines(productionUnionEntries),
    v1_largest_source_file_lines: largestLines(sourceEntries),
    v1_largest_test_file_lines: largestLines(testEntries),
    v1_largest_tool_file_lines: largestLines(toolEntries),
    largest_production_files: largestFiles(productionUnionEntries),
    largest_v1_source_files: largestFiles(sourceEntries),
    largest_v1_test_files: largestFiles(testEntries),
    v1_production_runtime_import_cycles: productionRuntimeCycles,
    v1_total_runtime_import_cycles: totalRuntimeCycles,
    v1_full_type_dependency_sccs: fullTypeDependencySccs,
    public_route_count: publicRoutes.length,
    probe_route_count: probeRoutes.length,
    route_inventory_source_files: routeInventoryFiles.length,
    route_inventory_source_paths: routeInventoryFiles,
    schema_table_count: sourceTables.length,
    legacy_presence: legacyPresenceReport(legacyGroups),
  });
  if (mode === "strict_no_legacy") assertStrictNoLegacy(legacyGroups);
  return report;
}

export function complexityMetricValues(report) {
  const entries = report.entry_closures;
  const values = {
    daemon_entry_source_files: entries.daemon.source_files,
    daemon_entry_source_lines: entries.daemon.source_lines,
    daemon_environment_field_count: report.daemon_environment_field_count,
    worker_entry_source_files: entries.worker.source_files,
    worker_entry_source_lines: entries.worker.source_lines,
    worker_environment_field_count: report.worker_environment_field_count,
    provisioning_entry_source_files: entries.provisioning.source_files,
    provisioning_entry_source_lines: entries.provisioning.source_lines,
    provisioning_environment_field_count: report.provisioning_environment_field_count,
    sdk_entry_source_files: entries.sdk.source_files,
    sdk_entry_source_lines: entries.sdk.source_lines,
    environment_inventory_source_files: report.environment_inventory_source_files,
    environment_field_union_count: report.environment_field_union_count,
    v1_production_union_source_files: report.v1_production_union_source_files,
    v1_production_union_source_lines: report.v1_production_union_source_lines,
    v1_total_source_files: report.v1_total_source_files,
    v1_total_source_lines: report.v1_total_source_lines,
    v1_nonproduction_source_files: report.v1_nonproduction_source_files,
    v1_nonproduction_source_lines: report.v1_nonproduction_source_lines,
    v1_test_files: report.v1_test_files,
    v1_test_lines: report.v1_test_lines,
    v1_gate_files: report.v1_gate_files,
    v1_gate_lines: report.v1_gate_lines,
    v1_test_artifact_files: report.v1_test_artifact_files,
    v1_test_artifact_lines: report.v1_test_artifact_lines,
    v1_tool_files: report.v1_tool_files,
    v1_tool_lines: report.v1_tool_lines,
    v1_resource_files: report.v1_resource_files,
    v1_resource_lines: report.v1_resource_lines,
    v1_largest_production_file_lines: report.v1_largest_production_file_lines,
    v1_largest_source_file_lines: report.v1_largest_source_file_lines,
    v1_largest_test_file_lines: report.v1_largest_test_file_lines,
    v1_largest_tool_file_lines: report.v1_largest_tool_file_lines,
    v1_production_runtime_import_cycles: report.v1_production_runtime_import_cycles.length,
    v1_total_runtime_import_cycles: report.v1_total_runtime_import_cycles.length,
    v1_full_type_dependency_scc_count: report.v1_full_type_dependency_sccs.length,
    public_route_count: report.public_route_count,
    probe_route_count: report.probe_route_count,
    route_inventory_source_files: report.route_inventory_source_files,
    schema_table_count: report.schema_table_count,
  };
  if (canonicalJson(Object.keys(values).sort()) !== canonicalJson([...METRIC_KEYS].sort())) {
    fail("internal_metric_shape_invalid");
  }
  return Object.freeze(values);
}

function validateBudget(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("budget_invalid");
  }
  const expectedKeys = [
    "baseline",
    "baseline_metrics_sha256",
    "intent",
    "observations",
    "ratchet_policy",
    "schema_version",
    "strict_activation",
    "thresholds",
  ].sort();
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys)
    || value.schema_version !== BUDGET_SCHEMA
    || typeof value.intent !== "string" || value.intent.length === 0
    || value.intent !== value.intent.trim()
    || typeof value.ratchet_policy !== "string"
    || value.ratchet_policy.length === 0 || value.ratchet_policy !== value.ratchet_policy.trim()
    || typeof value.strict_activation !== "string" || value.strict_activation.length === 0
    || value.strict_activation !== value.strict_activation.trim()
    || value.baseline === null || typeof value.baseline !== "object"
    || Array.isArray(value.baseline)
    || value.observations === null || typeof value.observations !== "object"
    || Array.isArray(value.observations)
    || value.thresholds === null || typeof value.thresholds !== "object"
    || Array.isArray(value.thresholds)) fail("budget_shape_invalid");
  const baselineKeys = ["captured_on", "inventory_mode", "source_revision"].sort();
  if (canonicalJson(Object.keys(value.baseline).sort()) !== canonicalJson(baselineKeys)
    || typeof value.baseline.captured_on !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/u.test(value.baseline.captured_on)
    || value.baseline.inventory_mode !== "v1_inventory"
    || typeof value.baseline.source_revision !== "string"
    || value.baseline.source_revision.length === 0
    || value.baseline.source_revision !== value.baseline.source_revision.trim()) {
    fail("budget_baseline_invalid");
  }
  if (canonicalJson(Object.keys(value.observations).sort())
      !== canonicalJson([...COMPLEXITY_OBSERVATION_METRICS].sort())
    || canonicalJson(Object.keys(value.thresholds).sort())
      !== canonicalJson([...COMPLEXITY_HARD_THRESHOLD_METRICS].sort())) {
    fail("budget_metric_partition_invalid");
  }
  for (const key of COMPLEXITY_OBSERVATION_METRICS) {
    if (!Number.isSafeInteger(value.observations[key]) || value.observations[key] < 0) {
      fail(`budget_observation_invalid:${key}`);
    }
  }
  for (const key of COMPLEXITY_HARD_THRESHOLD_METRICS) {
    if (!Number.isSafeInteger(value.thresholds[key]) || value.thresholds[key] < 0) {
      fail(`budget_threshold_invalid:${key}`);
    }
  }
  for (const key of [
    "v1_production_runtime_import_cycles",
    "v1_total_runtime_import_cycles",
    "v1_full_type_dependency_scc_count",
  ]) {
    if (value.thresholds[key] !== 0) fail(`budget_zero_invariant_invalid:${key}`);
  }
  for (const key of [
    "v1_largest_production_file_lines",
    "v1_largest_source_file_lines",
  ]) {
    if (value.thresholds[key] > 1_200) fail(`budget_largest_file_invalid:${key}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(value.baseline_metrics_sha256)
    || createHash("sha256").update(canonicalJson({
      observations: value.observations,
      thresholds: value.thresholds,
    })).digest("hex")
      !== value.baseline_metrics_sha256) fail("budget_baseline_digest_invalid");
  for (const token of ["only decrease", "explicit architecture review", "reset"]) {
    if (!value.ratchet_policy.toLowerCase().includes(token)) {
      fail(`budget_ratchet_policy_missing:${token.replaceAll(" ", "_")}`);
    }
  }
  return value;
}

function checkBudget(report, budget) {
  const actual = complexityMetricValues(report);
  const violations = [];
  for (const key of COMPLEXITY_HARD_THRESHOLD_METRICS) {
    const expected = budget.thresholds[key];
    if (EXACT_THRESHOLD_METRICS.has(key) ? actual[key] !== expected : actual[key] > expected) {
      violations.push(`${key}:actual=${actual[key]}:${EXACT_THRESHOLD_METRICS.has(key) ? "required" : "ceiling"}=${expected}`);
    }
  }
  if (violations.length > 0) fail(`budget_exceeded:${violations.join(",")}`);
}

function parseArguments(argv) {
  let mode = "v1_inventory";
  let checkPath = null;
  let writePath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict-no-legacy") {
      mode = "strict_no_legacy";
    } else if (argument === "--mode") {
      mode = argv[++index];
    } else if (argument === "--check") {
      checkPath = argv[++index];
    } else if (argument === "--write") {
      writePath = argv[++index];
    } else {
      fail(`argument_unknown:${argument}`);
    }
  }
  if ((checkPath !== null && typeof checkPath !== "string")
    || (writePath !== null && typeof writePath !== "string")) fail("argument_value_missing");
  return { mode, checkPath, writePath };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = collectRuntimeComplexity({ mode: args.mode });
  if (args.checkPath !== null) {
    const budget = validateBudget(JSON.parse(fs.readFileSync(path.resolve(ROOT, args.checkPath), "utf8")));
    checkBudget(report, budget);
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.writePath !== null) fs.writeFileSync(path.resolve(ROOT, args.writePath), output);
  process.stdout.write(output);
}

const invokedAsEntrypoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
