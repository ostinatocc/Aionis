#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LARGEST_FILE_LIMIT = 20;
const CODE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"];
const RESOURCE_EXTENSIONS = ["sql", "json"];
const SCRIPT_ARTIFACT_EXTENSIONS = [...CODE_EXTENSIONS, "sh", "json"];
const WORKFLOW_ARTIFACT_EXTENSIONS = ["yml", "yaml"];
const ACTION_ARTIFACT_EXTENSIONS = [...SCRIPT_ARTIFACT_EXTENSIONS, ...WORKFLOW_ARTIFACT_EXTENSIONS];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function pathspecs(root, extensions) {
  return extensions.map((extension) => `${root}/**/*.${extension}`);
}

function workspaceFiles(...pathspecList) {
  if (pathspecList.length === 0) throw new Error("workspace inventory requires a pathspec");
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...pathspecList],
    {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_GLOB_PATHSPECS: "1" },
    },
  );
  if (listed.status !== 0) {
    throw new Error(`git source inventory failed: ${listed.stderr.trim() || `exit ${listed.status}`}`);
  }
  return listed.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && fs.existsSync(path.join(ROOT, value)))
    .sort();
}

function workspaceSourceFiles() {
  return workspaceFiles(...pathspecs("src", CODE_EXTENSIONS));
}

function countLines(source) {
  if (source.length === 0) return 0;
  const newlineCount = source.match(/\n/g)?.length ?? 0;
  return newlineCount + (source.endsWith("\n") ? 0 : 1);
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

function findVariableInitializer(sourceFile, variableName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function countRouteMatrixEntries(sourceFile) {
  const initializer = findVariableInitializer(sourceFile, "LITE_ROUTE_CAPABILITY_MATRIX");
  if (!initializer) throw new Error("LITE_ROUTE_CAPABILITY_MATRIX initializer not found");
  const matrix = unwrapExpression(initializer);
  if (!ts.isArrayLiteralExpression(matrix)) {
    throw new Error("LITE_ROUTE_CAPABILITY_MATRIX must remain an array literal");
  }
  return matrix.elements.length;
}

function countEnvSchemaFields(sourceFile) {
  const initializer = findVariableInitializer(sourceFile, "EnvSchema");
  if (!initializer) throw new Error("EnvSchema initializer not found");
  const call = unwrapExpression(initializer);
  if (!ts.isCallExpression(call) || call.arguments.length === 0) {
    throw new Error("EnvSchema must remain a z.object call");
  }
  const object = unwrapExpression(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error("EnvSchema must remain backed by an object literal");
  }
  return object.properties.filter((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = property.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
    return /^[A-Z][A-Z0-9_]*$/.test(text);
  }).length;
}

function relativeModuleSpecifiers(sourceFile) {
  const out = new Set();
  const addModuleSpecifier = (moduleSpecifier) => {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
    if (moduleSpecifier.text.startsWith("./") || moduleSpecifier.text.startsWith("../")) {
      out.add(moduleSpecifier.text);
    }
  };
  for (const statement of sourceFile.statements) {
    let moduleSpecifier = null;
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      moduleSpecifier = statement.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
    ) {
      moduleSpecifier = statement.moduleReference.expression;
    }
    addModuleSpecifier(moduleSpecifier);
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || commonJsRequire) addModuleSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...out].sort();
}

export function relativeModuleSpecifiersFromText(relativePath, source) {
  return relativeModuleSpecifiers(parseSource(relativePath, source));
}

function resolveRelativeImport(fromPath, moduleSpecifier, sourceSet) {
  const fromDir = path.posix.dirname(fromPath);
  const base = path.posix.normalize(path.posix.join(fromDir, moduleSpecifier));
  const extension = path.posix.extname(base);
  const candidates = [];
  if (extension === ".js") candidates.push(base, `${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  else if (extension === ".mjs") candidates.push(base, `${base.slice(0, -4)}.mts`);
  else if (extension === ".cjs") candidates.push(base, `${base.slice(0, -4)}.cts`);
  else if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) candidates.push(base);
  else if (!extension) {
    for (const codeExtension of CODE_EXTENSIONS) {
      candidates.push(`${base}.${codeExtension}`, `${base}/index.${codeExtension}`);
    }
  }
  return candidates.find((candidate) => sourceSet.has(candidate)) ?? null;
}

function buildImportGraph(sourcePaths, parsed) {
  const sourceSet = new Set(sourcePaths);
  const graph = new Map(sourcePaths.map((relativePath) => [relativePath, new Set()]));
  for (const relativePath of sourcePaths) {
    for (const moduleSpecifier of relativeModuleSpecifiers(parsed.get(relativePath))) {
      const resolved = resolveRelativeImport(relativePath, moduleSpecifier, sourceSet);
      if (resolved) graph.get(relativePath).add(resolved);
    }
  }
  return graph;
}

function inventoryLines(paths) {
  return paths.map((relativePath) => ({
    path: relativePath,
    lines: countLines(fs.readFileSync(path.join(ROOT, relativePath), "utf8")),
  }));
}

function sumInventoryLines(entries) {
  return entries.reduce((total, entry) => total + entry.lines, 0);
}

function largestInventoryLines(entries) {
  return entries.reduce((largest, entry) => Math.max(largest, entry.lines), 0);
}

export function findUnclassifiedArtifactPaths(allPaths, coveredPaths) {
  const covered = new Set(coveredPaths);
  return [...allPaths].filter((relativePath) => !covered.has(relativePath)).sort();
}

function assertClosedArtifactInventory(root, coveredPaths) {
  const uncovered = findUnclassifiedArtifactPaths(workspaceFiles(`${root}/**`), coveredPaths);
  if (uncovered.length > 0) {
    throw new Error(
      `unsupported complexity artifact under ${root}: ${uncovered.join(", ")}`,
    );
  }
}

function stronglyConnectedImportCycles(graph) {
  let nextIndex = 0;
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const visit = (node) => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of [...(graph.get(node) ?? [])].sort()) {
      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), lowLinkByNode.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), indexByNode.get(neighbor)));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    component.sort();
    if (component.length > 1 || (graph.get(component[0]) ?? new Set()).has(component[0])) {
      components.push(component);
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indexByNode.has(node)) visit(node);
  }
  return components.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function reachableModules(graph, entryPath) {
  if (!graph.has(entryPath)) throw new Error(`Runtime entry is missing from source inventory: ${entryPath}`);
  const visited = new Set();
  const pending = [entryPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const dependency of graph.get(current) ?? []) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return visited;
}

export function collectRuntimeComplexity() {
  const sourcePaths = workspaceSourceFiles();
  const toolPaths = workspaceFiles(...pathspecs("tools", CODE_EXTENSIONS));
  const runtimeResourcePaths = workspaceFiles(...pathspecs("src", RESOURCE_EXTENSIONS));
  const authorityPackagePaths = workspaceFiles(...pathspecs(
    "packages/aionis-learning-authority/src",
    CODE_EXTENSIONS,
  ));
  const authorityPackageResourcePaths = workspaceFiles(...pathspecs(
    "packages/aionis-learning-authority/src",
    RESOURCE_EXTENSIONS,
  ));
  const scriptArtifactPaths = workspaceFiles(...pathspecs("scripts", SCRIPT_ARTIFACT_EXTENSIONS));
  const ciArtifactPaths = scriptArtifactPaths.filter((relativePath) => relativePath.startsWith("scripts/ci/"));
  const workflowArtifactPaths = [
    ...workspaceFiles(...pathspecs(".github/workflows", WORKFLOW_ARTIFACT_EXTENSIONS)),
    ...workspaceFiles(...pathspecs(".github/actions", ACTION_ARTIFACT_EXTENSIONS)),
  ].sort();
  const e2eSourcePaths = scriptArtifactPaths.filter((relativePath) => relativePath.startsWith("scripts/e2e/"));
  const operationalScriptPaths = scriptArtifactPaths.filter((relativePath) => (
    !relativePath.startsWith("scripts/ci/") && !relativePath.startsWith("scripts/e2e/")
  ));
  assertClosedArtifactInventory("src", [...sourcePaths, ...runtimeResourcePaths]);
  assertClosedArtifactInventory("tools", toolPaths);
  assertClosedArtifactInventory("packages", [
    "packages/aionis-learning-authority/package.json",
    "packages/aionis-learning-authority/README.md",
    ...authorityPackagePaths,
    ...authorityPackageResourcePaths,
  ]);
  assertClosedArtifactInventory("scripts", scriptArtifactPaths);
  assertClosedArtifactInventory(
    ".github/workflows",
    workflowArtifactPaths.filter((relativePath) => relativePath.startsWith(".github/workflows/")),
  );
  assertClosedArtifactInventory(
    ".github/actions",
    workflowArtifactPaths.filter((relativePath) => relativePath.startsWith(".github/actions/")),
  );
  const sources = new Map();
  const parsed = new Map();
  const fileLines = [];
  let sourceLines = 0;

  for (const relativePath of sourcePaths) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    const lines = countLines(source);
    sources.set(relativePath, source);
    parsed.set(relativePath, parseSource(relativePath, source));
    fileLines.push({ path: relativePath, lines });
    sourceLines += lines;
  }

  const graph = buildImportGraph(sourcePaths, parsed);
  const authorityPackageParsed = new Map();
  for (const relativePath of authorityPackagePaths) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    authorityPackageParsed.set(relativePath, parseSource(relativePath, source));
  }
  const authorityPackageGraph = buildImportGraph(authorityPackagePaths, authorityPackageParsed);

  const boundaryPath = "src/server/lite-runtime-boundary.ts";
  const configPath = "src/config.ts";
  const runtimeEntryPath = "src/runtime-entry.ts";
  if (!parsed.has(boundaryPath) || !parsed.has(configPath)) {
    throw new Error("Runtime complexity anchors are missing from tracked source inventory");
  }

  const runtimeEntryModules = reachableModules(graph, runtimeEntryPath);
  const runtimeEntryLines = fileLines
    .filter((entry) => runtimeEntryModules.has(entry.path))
    .reduce((total, entry) => total + entry.lines, 0);
  const nonEntryLines = sourceLines - runtimeEntryLines;
  const toolFileLines = inventoryLines(toolPaths);
  const runtimeResourceFileLines = inventoryLines(runtimeResourcePaths);
  const authorityPackageFileLines = inventoryLines(authorityPackagePaths);
  const authorityPackageResourceFileLines = inventoryLines(authorityPackageResourcePaths);
  const ciArtifactFileLines = inventoryLines(ciArtifactPaths);
  const workflowArtifactFileLines = inventoryLines(workflowArtifactPaths);
  const e2eSourceFileLines = inventoryLines(e2eSourcePaths);
  const operationalScriptFileLines = inventoryLines(operationalScriptPaths);
  const runtimeResourceLines = sumInventoryLines(runtimeResourceFileLines);
  const authorityPackageLines = sumInventoryLines(authorityPackageFileLines);
  const authorityPackageResourceLines = sumInventoryLines(authorityPackageResourceFileLines);

  return {
    source_files: sourcePaths.length,
    source_lines: sourceLines,
    runtime_entry_source_files: runtimeEntryModules.size,
    runtime_entry_source_lines: runtimeEntryLines,
    non_entry_source_files: sourcePaths.length - runtimeEntryModules.size,
    non_entry_source_lines: nonEntryLines,
    tool_source_files: toolPaths.length,
    tool_source_lines: sumInventoryLines(toolFileLines),
    runtime_resource_files: runtimeResourcePaths.length,
    runtime_resource_lines: runtimeResourceLines,
    focused_runtime_artifact_lines: sourceLines + runtimeResourceLines,
    authority_package_source_files: authorityPackagePaths.length,
    authority_package_source_lines: authorityPackageLines,
    authority_package_resource_files: authorityPackageResourcePaths.length,
    authority_package_resource_lines: authorityPackageResourceLines,
    authority_package_artifact_lines: authorityPackageLines + authorityPackageResourceLines,
    authority_package_import_cycles: stronglyConnectedImportCycles(authorityPackageGraph),
    authority_package_largest_file_lines: largestInventoryLines(authorityPackageFileLines),
    ci_artifact_files: ciArtifactPaths.length,
    ci_artifact_lines: sumInventoryLines(ciArtifactFileLines),
    ci_largest_file_lines: largestInventoryLines(ciArtifactFileLines),
    workflow_artifact_files: workflowArtifactPaths.length,
    workflow_artifact_lines: sumInventoryLines(workflowArtifactFileLines),
    workflow_largest_file_lines: largestInventoryLines(workflowArtifactFileLines),
    e2e_source_files: e2eSourcePaths.length,
    e2e_source_lines: sumInventoryLines(e2eSourceFileLines),
    e2e_largest_file_lines: largestInventoryLines(e2eSourceFileLines),
    operational_script_files: operationalScriptPaths.length,
    operational_script_lines: sumInventoryLines(operationalScriptFileLines),
    operational_script_largest_file_lines: largestInventoryLines(operationalScriptFileLines),
    route_matrix_entries: countRouteMatrixEntries(parsed.get(boundaryPath)),
    env_schema_fields: countEnvSchemaFields(parsed.get(configPath)),
    import_cycles: stronglyConnectedImportCycles(graph),
    largest_files: fileLines
      .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))
      .slice(0, LARGEST_FILE_LIMIT),
  };
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function checkBudget(report, budgetPath) {
  const absoluteBudgetPath = path.isAbsolute(budgetPath) ? budgetPath : path.join(ROOT, budgetPath);
  const budget = JSON.parse(fs.readFileSync(absoluteBudgetPath, "utf8"));
  const thresholds = budget?.thresholds;
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
    throw new Error("complexity budget must contain a thresholds object");
  }
  const checks = [
    ["source_files", report.source_files, positiveInteger(thresholds.source_files, "thresholds.source_files")],
    ["source_lines", report.source_lines, positiveInteger(thresholds.source_lines, "thresholds.source_lines")],
    ["runtime_entry_source_files", report.runtime_entry_source_files, positiveInteger(thresholds.runtime_entry_source_files, "thresholds.runtime_entry_source_files")],
    ["runtime_entry_source_lines", report.runtime_entry_source_lines, positiveInteger(thresholds.runtime_entry_source_lines, "thresholds.runtime_entry_source_lines")],
    ["non_entry_source_files", report.non_entry_source_files, positiveInteger(thresholds.non_entry_source_files, "thresholds.non_entry_source_files")],
    ["non_entry_source_lines", report.non_entry_source_lines, positiveInteger(thresholds.non_entry_source_lines, "thresholds.non_entry_source_lines")],
    ["tool_source_files", report.tool_source_files, positiveInteger(thresholds.tool_source_files, "thresholds.tool_source_files")],
    ["tool_source_lines", report.tool_source_lines, positiveInteger(thresholds.tool_source_lines, "thresholds.tool_source_lines")],
    ["runtime_resource_files", report.runtime_resource_files, positiveInteger(thresholds.runtime_resource_files, "thresholds.runtime_resource_files")],
    ["runtime_resource_lines", report.runtime_resource_lines, positiveInteger(thresholds.runtime_resource_lines, "thresholds.runtime_resource_lines")],
    ["focused_runtime_artifact_lines", report.focused_runtime_artifact_lines, positiveInteger(thresholds.focused_runtime_artifact_lines, "thresholds.focused_runtime_artifact_lines")],
    ["authority_package_source_files", report.authority_package_source_files, positiveInteger(thresholds.authority_package_source_files, "thresholds.authority_package_source_files")],
    ["authority_package_source_lines", report.authority_package_source_lines, positiveInteger(thresholds.authority_package_source_lines, "thresholds.authority_package_source_lines")],
    ["authority_package_resource_files", report.authority_package_resource_files, positiveInteger(thresholds.authority_package_resource_files, "thresholds.authority_package_resource_files")],
    ["authority_package_resource_lines", report.authority_package_resource_lines, positiveInteger(thresholds.authority_package_resource_lines, "thresholds.authority_package_resource_lines")],
    ["authority_package_artifact_lines", report.authority_package_artifact_lines, positiveInteger(thresholds.authority_package_artifact_lines, "thresholds.authority_package_artifact_lines")],
    ["authority_package_import_cycles", report.authority_package_import_cycles.length, positiveInteger(thresholds.authority_package_import_cycles, "thresholds.authority_package_import_cycles")],
    ["authority_package_largest_file_lines", report.authority_package_largest_file_lines, positiveInteger(thresholds.authority_package_largest_file_lines, "thresholds.authority_package_largest_file_lines")],
    ["ci_artifact_files", report.ci_artifact_files, positiveInteger(thresholds.ci_artifact_files, "thresholds.ci_artifact_files")],
    ["ci_artifact_lines", report.ci_artifact_lines, positiveInteger(thresholds.ci_artifact_lines, "thresholds.ci_artifact_lines")],
    ["ci_largest_file_lines", report.ci_largest_file_lines, positiveInteger(thresholds.ci_largest_file_lines, "thresholds.ci_largest_file_lines")],
    ["workflow_artifact_files", report.workflow_artifact_files, positiveInteger(thresholds.workflow_artifact_files, "thresholds.workflow_artifact_files")],
    ["workflow_artifact_lines", report.workflow_artifact_lines, positiveInteger(thresholds.workflow_artifact_lines, "thresholds.workflow_artifact_lines")],
    ["workflow_largest_file_lines", report.workflow_largest_file_lines, positiveInteger(thresholds.workflow_largest_file_lines, "thresholds.workflow_largest_file_lines")],
    ["e2e_source_files", report.e2e_source_files, positiveInteger(thresholds.e2e_source_files, "thresholds.e2e_source_files")],
    ["e2e_source_lines", report.e2e_source_lines, positiveInteger(thresholds.e2e_source_lines, "thresholds.e2e_source_lines")],
    ["e2e_largest_file_lines", report.e2e_largest_file_lines, positiveInteger(thresholds.e2e_largest_file_lines, "thresholds.e2e_largest_file_lines")],
    ["operational_script_files", report.operational_script_files, positiveInteger(thresholds.operational_script_files, "thresholds.operational_script_files")],
    ["operational_script_lines", report.operational_script_lines, positiveInteger(thresholds.operational_script_lines, "thresholds.operational_script_lines")],
    ["operational_script_largest_file_lines", report.operational_script_largest_file_lines, positiveInteger(thresholds.operational_script_largest_file_lines, "thresholds.operational_script_largest_file_lines")],
    ["route_matrix_entries", report.route_matrix_entries, positiveInteger(thresholds.route_matrix_entries, "thresholds.route_matrix_entries")],
    ["env_schema_fields", report.env_schema_fields, positiveInteger(thresholds.env_schema_fields, "thresholds.env_schema_fields")],
    ["import_cycles", report.import_cycles.length, positiveInteger(thresholds.import_cycles, "thresholds.import_cycles")],
    ["largest_file_lines", report.largest_files[0]?.lines ?? 0, positiveInteger(thresholds.largest_file_lines, "thresholds.largest_file_lines")],
  ];
  return checks
    .filter(([, actual, allowed]) => actual > allowed)
    .map(([metric, actual, allowed]) => ({ metric, actual, allowed }));
}

function parseArgs(args) {
  const options = { check: null, writeReport: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check" || arg === "--write-report") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--check") options.check = value;
      else options.writeReport = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = collectRuntimeComplexity();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.writeReport) {
      const reportPath = path.isAbsolute(options.writeReport)
        ? options.writeReport
        : path.join(ROOT, options.writeReport);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, serialized);
    }
    process.stdout.write(serialized);
    if (options.check) {
      const failures = checkBudget(report, options.check);
      if (failures.length > 0) {
        process.stderr.write("Runtime complexity budget exceeded:\n");
        for (const failure of failures) {
          process.stderr.write(`- ${failure.metric}: ${failure.actual} > ${failure.allowed}\n`);
        }
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
