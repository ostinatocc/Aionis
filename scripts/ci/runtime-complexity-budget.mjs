#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CODE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "mjs",
  "cjs",
];
const LARGEST_FILE_LIMIT = 20;

function workspaceSourceFiles() {
  const pathspecs = CODE_EXTENSIONS.map(
    (extension) => `src/**/*.${extension}`,
  );
  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      ...pathspecs,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_GLOB_PATHSPECS: "1",
      },
    },
  );
  if (listed.status !== 0) {
    throw new Error(
      `git source inventory failed: ${
        listed.stderr.trim() || `exit ${listed.status}`
      }`,
    );
  }
  return listed.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length > 0
        && fs.existsSync(path.join(ROOT, value)),
    )
    .sort();
}

function countLines(source) {
  if (source.length === 0) return 0;
  const newlineCount = source.match(/\n/gu)?.length ?? 0;
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
    for (
      const declaration
      of statement.declarationList.declarations
    ) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === variableName
      ) {
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
  const initializer = findVariableInitializer(
    sourceFile,
    "LITE_ROUTE_CAPABILITY_MATRIX",
  );
  if (!initializer) {
    throw new Error(
      "LITE_ROUTE_CAPABILITY_MATRIX initializer not found",
    );
  }
  const matrix = unwrapExpression(initializer);
  if (!ts.isArrayLiteralExpression(matrix)) {
    throw new Error(
      "LITE_ROUTE_CAPABILITY_MATRIX must remain an array literal",
    );
  }
  return matrix.elements.length;
}

function countEnvSchemaFields(sourceFile) {
  const initializer = findVariableInitializer(
    sourceFile,
    "EnvSchema",
  );
  if (!initializer) {
    throw new Error("EnvSchema initializer not found");
  }
  const call = unwrapExpression(initializer);
  if (
    !ts.isCallExpression(call)
    || call.arguments.length === 0
  ) {
    throw new Error("EnvSchema must remain a z.object call");
  }
  const object = unwrapExpression(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(
      "EnvSchema must remain backed by an object literal",
    );
  }
  return object.properties.filter((property) => {
    if (
      !ts.isPropertyAssignment(property)
      && !ts.isShorthandPropertyAssignment(property)
    ) {
      return false;
    }
    const name = property.name;
    const text =
      ts.isIdentifier(name) || ts.isStringLiteral(name)
        ? name.text
        : "";
    return /^[A-Z][A-Z0-9_]*$/u.test(text);
  }).length;
}

function relativeModuleSpecifiers(sourceFile) {
  const out = new Set();
  const add = (moduleSpecifier) => {
    if (
      !moduleSpecifier
      || !ts.isStringLiteralLike(moduleSpecifier)
    ) {
      return;
    }
    if (
      moduleSpecifier.text.startsWith("./")
      || moduleSpecifier.text.startsWith("../")
    ) {
      out.add(moduleSpecifier.text);
    }
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      || ts.isExportDeclaration(statement)
    ) {
      add(statement.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
    ) {
      add(statement.moduleReference.expression);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const dynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire =
        ts.isIdentifier(node.expression)
        && node.expression.text === "require";
      if (dynamicImport || commonJsRequire) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...out].sort();
}

function resolveRelativeImport(
  fromPath,
  moduleSpecifier,
  sourceSet,
) {
  const base = path.posix.normalize(
    path.posix.join(
      path.posix.dirname(fromPath),
      moduleSpecifier,
    ),
  );
  const extension = path.posix.extname(base);
  const candidates = [];
  if (extension === ".js") {
    candidates.push(
      base,
      `${base.slice(0, -3)}.ts`,
      `${base.slice(0, -3)}.tsx`,
    );
  } else if (extension === ".mjs") {
    candidates.push(base, `${base.slice(0, -4)}.mts`);
  } else if (extension === ".cjs") {
    candidates.push(base, `${base.slice(0, -4)}.cts`);
  } else if (
    [".ts", ".tsx", ".mts", ".cts"].includes(extension)
  ) {
    candidates.push(base);
  } else if (!extension) {
    for (const codeExtension of CODE_EXTENSIONS) {
      candidates.push(
        `${base}.${codeExtension}`,
        `${base}/index.${codeExtension}`,
      );
    }
  }
  return (
    candidates.find((candidate) => sourceSet.has(candidate))
    ?? null
  );
}

function buildImportGraph(sourcePaths, parsed) {
  const sourceSet = new Set(sourcePaths);
  const graph = new Map(
    sourcePaths.map((relativePath) => [
      relativePath,
      new Set(),
    ]),
  );
  for (const relativePath of sourcePaths) {
    for (
      const moduleSpecifier
      of relativeModuleSpecifiers(parsed.get(relativePath))
    ) {
      const resolved = resolveRelativeImport(
        relativePath,
        moduleSpecifier,
        sourceSet,
      );
      if (resolved) graph.get(relativePath).add(resolved);
    }
  }
  return graph;
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
        lowLinkByNode.set(
          node,
          Math.min(
            lowLinkByNode.get(node),
            lowLinkByNode.get(neighbor),
          ),
        );
      } else if (onStack.has(neighbor)) {
        lowLinkByNode.set(
          node,
          Math.min(
            lowLinkByNode.get(node),
            indexByNode.get(neighbor),
          ),
        );
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    component.sort();
    if (
      component.length > 1
      || (graph.get(component[0]) ?? new Set()).has(
        component[0],
      )
    ) {
      components.push(component);
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indexByNode.has(node)) visit(node);
  }
  return components.sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")));
}

function reachableModules(graph, entryPaths) {
  const visited = new Set();
  const pending = [...entryPaths];
  for (const entryPath of entryPaths) {
    if (!graph.has(entryPath)) {
      throw new Error(
        `product entry is missing from source inventory: ${entryPath}`,
      );
    }
  }
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
  const parsed = new Map();
  const fileLines = [];
  let sourceLines = 0;

  for (const relativePath of sourcePaths) {
    const source = fs.readFileSync(
      path.join(ROOT, relativePath),
      "utf8",
    );
    const lines = countLines(source);
    parsed.set(
      relativePath,
      parseSource(relativePath, source),
    );
    fileLines.push({ path: relativePath, lines });
    sourceLines += lines;
  }

  const graph = buildImportGraph(sourcePaths, parsed);
  const productModules = reachableModules(graph, [
    "src/runtime-entry.ts",
    "src/sdk.ts",
  ]);
  const productSourceLines = fileLines
    .filter((entry) => productModules.has(entry.path))
    .reduce((total, entry) => total + entry.lines, 0);
  const boundary = parsed.get(
    "src/server/lite-runtime-boundary.ts",
  );
  const config = parsed.get("src/config.ts");
  if (!boundary || !config) {
    throw new Error(
      "Runtime complexity anchors are missing from source inventory",
    );
  }

  return {
    source_files: sourcePaths.length,
    source_lines: sourceLines,
    product_source_files: productModules.size,
    product_source_lines: productSourceLines,
    non_product_source_files:
      sourcePaths.length - productModules.size,
    non_product_source_lines:
      sourceLines - productSourceLines,
    route_matrix_entries:
      countRouteMatrixEntries(boundary),
    env_schema_fields: countEnvSchemaFields(config),
    import_cycles: stronglyConnectedImportCycles(graph),
    largest_product_files: fileLines
      .filter((entry) => productModules.has(entry.path))
      .sort(
        (left, right) =>
          right.lines - left.lines
          || left.path.localeCompare(right.path),
      )
      .slice(0, LARGEST_FILE_LIMIT),
    largest_non_product_files: fileLines
      .filter((entry) => !productModules.has(entry.path))
      .sort(
        (left, right) =>
          right.lines - left.lines
          || left.path.localeCompare(right.path),
      )
      .slice(0, LARGEST_FILE_LIMIT),
    non_product_paths: sourcePaths.filter(
      (relativePath) => !productModules.has(relativePath),
    ),
  };
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative integer`,
    );
  }
  return value;
}

function checkBudget(report, budgetPath) {
  const absoluteBudgetPath = path.isAbsolute(budgetPath)
    ? budgetPath
    : path.join(ROOT, budgetPath);
  const budget = JSON.parse(
    fs.readFileSync(absoluteBudgetPath, "utf8"),
  );
  const thresholds = budget?.thresholds;
  if (
    !thresholds
    || typeof thresholds !== "object"
    || Array.isArray(thresholds)
  ) {
    throw new Error(
      "complexity budget must contain a thresholds object",
    );
  }
  const checks = [
    "source_files",
    "source_lines",
    "product_source_files",
    "product_source_lines",
    "non_product_source_files",
    "non_product_source_lines",
    "route_matrix_entries",
    "env_schema_fields",
  ].map((metric) => [
    metric,
    report[metric],
    nonNegativeInteger(
      thresholds[metric],
      `thresholds.${metric}`,
    ),
  ]);
  checks.push([
    "import_cycles",
    report.import_cycles.length,
    nonNegativeInteger(
      thresholds.import_cycles,
      "thresholds.import_cycles",
    ),
  ]);
  checks.push([
    "largest_file_lines",
    Math.max(
      report.largest_product_files[0]?.lines ?? 0,
      report.largest_non_product_files[0]?.lines ?? 0,
    ),
    nonNegativeInteger(
      thresholds.largest_file_lines,
      "thresholds.largest_file_lines",
    ),
  ]);
  return checks
    .filter(([, actual, allowed]) => actual > allowed)
    .map(([metric, actual, allowed]) => ({
      metric,
      actual,
      allowed,
    }));
}

function parseArgs(args) {
  const options = {
    check: null,
    writeReport: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--check" && arg !== "--write-report") {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a path`);
    }
    if (arg === "--check") options.check = value;
    else options.writeReport = value;
    index += 1;
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = collectRuntimeComplexity();
    const serialized = `${JSON.stringify(
      report,
      null,
      2,
    )}\n`;
    if (options.writeReport) {
      const reportPath = path.isAbsolute(options.writeReport)
        ? options.writeReport
        : path.join(ROOT, options.writeReport);
      fs.mkdirSync(path.dirname(reportPath), {
        recursive: true,
      });
      fs.writeFileSync(reportPath, serialized);
    }
    process.stdout.write(serialized);
    if (options.check) {
      const failures = checkBudget(report, options.check);
      if (failures.length > 0) {
        process.stderr.write(
          "Runtime complexity budget exceeded:\n",
        );
        for (const failure of failures) {
          process.stderr.write(
            `- ${failure.metric}: ${
              failure.actual
            } > ${failure.allowed}\n`,
          );
        }
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1]
  && path.resolve(process.argv[1])
    === fileURLToPath(import.meta.url)
) {
  main();
}
