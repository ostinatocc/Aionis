import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertVerifierExecutionPackUnchanged,
  materializeVerifierExecutionPack,
  VerifierExecutionPackError,
} from "../../src/execution/verifier-execution-pack.js";
import {
  captureVerifierProgramIdentity,
} from "../../src/execution/verifier-program-identity.js";

function makeTreeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    makeTreeRemovable(join(path, name));
  }
}

function temporaryDirectory(t: test.TestContext, label: string): string {
  const base = join(process.cwd(), ".tmp");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(
    join(base, `aionis-verifier-pack-${label}-`),
  );
  t.after(() => {
    makeTreeRemovable(directory);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function write(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
}

test("private execution pack pins real verifier inputs and restores subject attachments", {
  skip: process.platform === "win32",
}, (t) => {
  const root = temporaryDirectory(t, "real");
  const liveProgram = join(root, "live", "program");
  const liveDependency = join(root, "live", "dependency");
  const liveOracle = join(root, "live", "oracle");
  const subject = join(root, "subject");
  const packs = join(root, "packs");
  mkdirSync(liveProgram, { recursive: true, mode: 0o700 });
  mkdirSync(liveDependency, { recursive: true, mode: 0o700 });
  mkdirSync(liveOracle, { recursive: true, mode: 0o700 });
  mkdirSync(subject, { recursive: true, mode: 0o700 });
  mkdirSync(packs, { recursive: true, mode: 0o700 });

  const verifierPath = join(liveProgram, "verifier.mjs");
  const helperPath = join(liveProgram, "helper.mjs");
  const helperLinkPath = join(liveProgram, "helper-link.mjs");
  const dependencyPath = join(liveDependency, "package-data.txt");
  const dependencyLinkPath = join(liveDependency, "package-current.txt");
  const oraclePath = join(liveOracle, "expected.txt");
  write(
    verifierPath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { marker } from './helper-link.mjs';",
      "const [dependencyPath, scratchPath] = process.argv.slice(2);",
      "const dependency = readFileSync(dependencyPath, 'utf8').trim();",
      "const attached = readFileSync(new URL('node_modules/package-current.txt', `file://${process.cwd()}/`), 'utf8').trim();",
      "const oracle = readFileSync(process.env.ORACLE_PATH, 'utf8').trim();",
      "writeFileSync(`${scratchPath}/result.json`, JSON.stringify({ marker, dependency, attached, oracle }));",
      "process.stdout.write(JSON.stringify({ marker, dependency, attached, oracle, script: import.meta.url }));",
    ].join("\n"),
    0o700,
  );
  write(helperPath, "export const marker = 'program-v1';\n", 0o600);
  symlinkSync("helper.mjs", helperLinkPath);
  write(dependencyPath, "dependency-v1\n");
  symlinkSync("package-data.txt", dependencyLinkPath);
  write(oraclePath, "oracle-v1\n");

  const runnerConfig = {
    executable: process.execPath,
    argv: [
      verifierPath,
      dependencyLinkPath,
    ],
    cwd: liveProgram,
    environment: {
      ORACLE_PATH: oraclePath,
    },
  } as const;
  const identity = captureVerifierProgramIdentity({
    runnerConfig,
    verifierMaterialPaths: [liveProgram],
    immutableInputPaths: [liveDependency, liveOracle],
  });
  const dependencyRootIdentity =
    identity.manifest.immutable_input_roots.find((rootIdentity) =>
      rootIdentity.declared_path === liveDependency)!;
  const oracleRootIdentity =
    identity.manifest.immutable_input_roots.find((rootIdentity) =>
      rootIdentity.declared_path === liveOracle)!;
  assert.ok(dependencyRootIdentity);
  assert.ok(oracleRootIdentity);
  const pack = materializeVerifierExecutionPack({
    invocation_id: "invocation-real-1",
    program_identity: identity,
    runner_config: runnerConfig,
    readonly_inputs: [
      {
        contract_version: "verifier_execution_pack_readonly_input_v1",
        input_id: "dependency-tree",
        input_type: "dependency",
        source_root_resolved_path: dependencyRootIdentity.resolved_path,
        subject_path: "node_modules",
      },
      {
        contract_version: "verifier_execution_pack_readonly_input_v1",
        input_id: "expected-oracle",
        input_type: "oracle",
        source_root_resolved_path: oracleRootIdentity.resolved_path,
      },
    ],
    scratch_overlays: [{
      contract_version: "verifier_execution_pack_scratch_overlay_v1",
      overlay_id: "verifier-output",
      subject_path: "runtime/.aionis-scratch",
    }],
    subject_root: subject,
    base_directory: packs,
  });
  t.after(() => pack.cleanup());

  assert.equal(existsSync(join(subject, "node_modules")), true);
  assert.equal(lstatSync(join(subject, "node_modules")).isSymbolicLink(), true);
  assert.equal(
    existsSync(join(subject, "runtime", ".aionis-scratch")),
    true,
  );
  assert.equal(
    lstatSync(
      join(subject, "runtime", ".aionis-scratch"),
    ).isSymbolicLink(),
    true,
  );
  assert.equal(
    pack.executable_path,
    realpathSync(process.execPath),
    "the host runtime is content-pinned but not relocated",
  );
  assert.equal(
    pack.runner_resolution.path_bindings.some((binding) =>
      binding.location.kind === "argv"
      && binding.source_kind === "program_material"),
    true,
  );
  assert.equal(
    pack.runner_resolution.path_bindings.some((binding) =>
      binding.location.kind === "argv"
      && binding.source_kind === "dependency"),
    true,
  );
  assert.equal(
    pack.runner_resolution.path_bindings.some((binding) =>
      binding.location.kind === "environment"
      && binding.source_kind === "oracle"),
    true,
  );
  assert.equal(
    pack.runner_resolution.argv.some((value) => value.includes(root)),
    true,
    "packed paths remain invocation-local beneath the test root",
  );
  assert.equal(
    pack.runner_resolution.argv.some((value) => value.startsWith(liveProgram)),
    false,
  );
  assert.equal(
    Object.values(pack.runner_resolution.environment)
      .some((value) => value.startsWith(liveOracle)),
    false,
  );

  const packedProgramRoot = pack.copied_roots.find((copied) =>
    copied.source_kind === "program_material")!;
  const packedDependencyRoot = pack.copied_roots.find((copied) =>
    copied.source_kind === "dependency")!;
  assert.ok(packedProgramRoot);
  assert.ok(packedDependencyRoot);
  const packedHelperLink = join(
    packedProgramRoot.packed_root_path,
    "helper-link.mjs",
  );
  const packedDependencyLink = join(
    packedDependencyRoot.packed_root_path,
    "package-current.txt",
  );
  assert.equal(lstatSync(packedHelperLink).isSymbolicLink(), true);
  assert.equal(lstatSync(packedDependencyLink).isSymbolicLink(), true);
  assert.equal(readlinkSync(packedHelperLink).includes(liveProgram), false);
  assert.equal(
    readlinkSync(packedDependencyLink).includes(liveDependency),
    false,
  );

  write(helperPath, "export const marker = 'program-live-v2';\n", 0o600);
  write(dependencyPath, "dependency-live-v2\n");
  write(oraclePath, "oracle-live-v2\n");

  const scratchPath = pack.scratch_overlays[0]!.scratch_path;
  const attachedScratchPath =
    pack.scratch_overlays[0]!.attached_subject_path!;
  assert.ok(attachedScratchPath);
  const child = spawnSync(
    pack.runner_resolution.executable,
    [...pack.runner_resolution.argv, attachedScratchPath],
    {
      cwd: pack.runner_resolution.cwd,
      env: {
        ...pack.runner_resolution.environment,
      },
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout) as Record<string, string>;
  assert.deepEqual(
    {
      marker: output.marker,
      dependency: output.dependency,
      attached: output.attached,
      oracle: output.oracle,
    },
    {
      marker: "program-v1",
      dependency: "dependency-v1",
      attached: "dependency-v1",
      oracle: "oracle-v1",
    },
  );
  assert.equal(output.script.startsWith("file://"), true);
  assert.equal(output.script.includes(pack.pack_root), true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(scratchPath, "result.json"), "utf8")),
    {
      marker: "program-v1",
      dependency: "dependency-v1",
      attached: "dependency-v1",
      oracle: "oracle-v1",
    },
  );
  assertVerifierExecutionPackUnchanged(pack);

  const undeclaredPackPath = join(pack.pack_root, "undeclared-sidecar");
  write(undeclaredPackPath, "not declared\n");
  assert.throws(
    () => assertVerifierExecutionPackUnchanged(pack),
    (error: unknown) =>
      error instanceof VerifierExecutionPackError
      && error.code === "verifier_execution_pack_namespace_modified",
  );
  unlinkSync(undeclaredPackPath);

  const packedDependencyFile = join(
    packedDependencyRoot.packed_root_path,
    "package-data.txt",
  );
  assert.equal(lstatSync(packedDependencyFile).mode & 0o222, 0);
  chmodSync(packedDependencyFile, 0o600);
  write(packedDependencyFile, "pack-tamper\n");
  assert.throws(
    () => assertVerifierExecutionPackUnchanged(pack),
    (error: unknown) =>
      error instanceof VerifierExecutionPackError
      && error.code === "verifier_execution_pack_modified",
  );

  pack.detach();
  assert.equal(existsSync(join(subject, "node_modules")), false);
  assert.equal(existsSync(join(subject, "runtime")), false);
  assert.deepEqual(readFileSync(helperPath, "utf8"), "export const marker = 'program-live-v2';\n");
});

test("execution pack refuses to overwrite an existing subject entry", (t) => {
  const root = temporaryDirectory(t, "collision");
  const material = join(root, "program");
  const dependency = join(root, "dependency");
  const subject = join(root, "subject");
  mkdirSync(material, { recursive: true, mode: 0o700 });
  mkdirSync(dependency, { recursive: true, mode: 0o700 });
  mkdirSync(subject, { recursive: true, mode: 0o700 });
  write(join(material, "verify.mjs"), "process.exit(0);\n", 0o700);
  write(join(dependency, "value.txt"), "value\n");
  symlinkSync("owner-missing-target", join(subject, "node_modules"));

  const runnerConfig = {
    executable: process.execPath,
    argv: [join(material, "verify.mjs")],
    cwd: material,
  } as const;
  const identity = captureVerifierProgramIdentity({
    runnerConfig,
    verifierMaterialPaths: [material],
    immutableInputPaths: [dependency],
  });
  const dependencyRootIdentity =
    identity.manifest.immutable_input_roots[0]!;
  assert.throws(
    () => materializeVerifierExecutionPack({
      invocation_id: "invocation-collision-1",
      program_identity: identity,
      runner_config: runnerConfig,
      readonly_inputs: [{
        contract_version: "verifier_execution_pack_readonly_input_v1",
        input_id: "dependency-tree",
        input_type: "dependency",
        source_root_resolved_path: dependencyRootIdentity.resolved_path,
        subject_path: "node_modules",
      }],
      subject_root: subject,
      base_directory: root,
    }),
    (error: unknown) =>
      error instanceof VerifierExecutionPackError
      && error.code
        === "verifier_execution_pack_subject_attachment_would_overwrite",
  );
  assert.equal(lstatSync(join(subject, "node_modules")).isSymbolicLink(), true);
  assert.equal(
    readlinkSync(join(subject, "node_modules")),
    "owner-missing-target",
  );
  assert.deepEqual(
    readdirNames(root).filter((name) => name.startsWith("aionis-verifier-pack-")),
    [],
  );
});

test("execution pack cleans copied roots that preserve non-writable directory modes", (t) => {
  const root = temporaryDirectory(t, "readonly-cleanup");
  const material = join(root, "program");
  const subject = join(root, "subject");
  const packs = join(root, "packs");
  mkdirSync(material, { mode: 0o700 });
  mkdirSync(subject, { mode: 0o700 });
  mkdirSync(packs, { mode: 0o700 });
  const verifierPath = join(material, "verify.mjs");
  write(verifierPath, "process.exit(0);\n", 0o400);
  chmodSync(material, 0o555);

  const runnerConfig = {
    executable: process.execPath,
    argv: [verifierPath],
    cwd: material,
  } as const;
  const identity = captureVerifierProgramIdentity({
    runnerConfig,
    verifierMaterialPaths: [material],
  });
  const pack = materializeVerifierExecutionPack({
    invocation_id: "invocation-readonly-cleanup-1",
    program_identity: identity,
    runner_config: runnerConfig,
    readonly_inputs: [],
    subject_root: subject,
    base_directory: packs,
  });
  const packRoot = pack.pack_root;
  assert.equal(
    lstatSync(pack.copied_roots[0]!.packed_root_path).mode & 0o222,
    0,
  );
  pack.cleanup();
  assert.equal(existsSync(packRoot), false);
  chmodSync(material, 0o700);
});

function readdirNames(path: string): string[] {
  return existsSync(path)
    ? readdirSync(path)
    : [];
}
