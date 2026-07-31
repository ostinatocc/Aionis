import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  assertVerifierSubjectUnchanged,
  materializeVerifierSubjectFromSnapshot,
  VerifierSubjectMaterializationError,
  verifierSubjectFileBytes,
} from "../../src/execution/verifier-subject-materialization.js";
import {
  captureExactWorkspaceState,
} from "../../src/execution/workspace-state-capture.js";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
} as const;

function temporaryDirectory(t: test.TestContext, label: string): string {
  const directory = mkdtempSync(
    join(tmpdir(), `aionis-verifier-subject-${label}-`),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function git(directory: string, args: readonly string[]): void {
  const result = spawnSync(
    "git",
    ["--literal-pathspecs", "-C", directory, ...args],
    {
      encoding: "utf8",
      env: GIT_ENV,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

function commit(directory: string): void {
  git(directory, ["add", "--all"]);
  git(directory, [
    "-c",
    "user.name=Aionis Verifier Subject",
    "-c",
    "user.email=verifier-subject@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "subject",
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("CAS snapshot rebuild excludes undeclared ignored state and includes declared deliverables", (t) => {
  const workspace = temporaryDirectory(t, "ignored");
  git(workspace, ["init", "--quiet", "--template="]);
  write(join(workspace, ".gitignore"), "answer.ignored\ndist/\n");
  write(join(workspace, "source.txt"), "source-v1\n");
  commit(workspace);
  write(join(workspace, "answer.ignored"), "live-secret-answer\n");
  write(join(workspace, "dist", "result.json"), "{\"ok\":true}\n");

  const ordinary = captureExactWorkspaceState({ workspace_root: workspace });
  const ordinarySubject = materializeVerifierSubjectFromSnapshot({
    snapshotArtifactBytes: ordinary.artifact.bytes,
    sourceContentDigest: ordinary.content_digest,
    sourceEnvironmentDigest: ordinary.environment_digest,
  });
  t.after(() => ordinarySubject.cleanup());
  assert.equal(
    existsSync(join(ordinarySubject.subject_root, "answer.ignored")),
    false,
  );
  assert.equal(
    existsSync(join(ordinarySubject.subject_root, "dist", "result.json")),
    false,
  );
  assert.equal(
    verifierSubjectFileBytes(ordinarySubject, "source.txt").toString("utf8"),
    "source-v1\n",
  );

  const explicit = captureExactWorkspaceState({
    workspace_root: workspace,
    subject_state_spec: {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: ["answer.ignored", "dist"],
    },
  });
  const explicitSubject = materializeVerifierSubjectFromSnapshot({
    snapshotArtifactBytes: explicit.artifact.bytes,
    sourceContentDigest: explicit.content_digest,
    sourceEnvironmentDigest: explicit.environment_digest,
  });
  t.after(() => explicitSubject.cleanup());
  assert.equal(
    verifierSubjectFileBytes(
      explicitSubject,
      "answer.ignored",
    ).toString("utf8"),
    "live-secret-answer\n",
  );
  assert.equal(
    verifierSubjectFileBytes(
      explicitSubject,
      "dist/result.json",
    ).toString("utf8"),
    "{\"ok\":true}\n",
  );

  rmSync(workspace, { recursive: true, force: true });
  assert.equal(
    verifierSubjectFileBytes(explicitSubject, "source.txt").toString("utf8"),
    "source-v1\n",
  );
  assertVerifierSubjectUnchanged(explicitSubject);
});

test("subject mutation is rejected while verifier scratch output is permitted", (t) => {
  const workspace = temporaryDirectory(t, "mutation");
  write(join(workspace, "answer.txt"), "wrong\n");
  const capture = captureExactWorkspaceState({ workspace_root: workspace });
  const subject = materializeVerifierSubjectFromSnapshot({
    snapshotArtifactBytes: capture.artifact.bytes,
    sourceContentDigest: capture.content_digest,
    sourceEnvironmentDigest: capture.environment_digest,
  });
  t.after(() => subject.cleanup());

  write(join(subject.scratch_root, "test-cache", "result.txt"), "cache\n");
  assertVerifierSubjectUnchanged(subject);

  write(join(subject.subject_root, "answer.txt"), "right\n");
  assert.throws(
    () => assertVerifierSubjectUnchanged(subject),
    (error: unknown) =>
      error instanceof VerifierSubjectMaterializationError
      && error.code === "verifier_subject_modified_during_verification",
  );
  assert.equal(readFileSync(join(workspace, "answer.txt"), "utf8"), "wrong\n");
});

test("materialization rejects path, mode, byte, and escaping-symlink tampering", {
  skip: process.platform === "win32",
}, (t) => {
  const parent = temporaryDirectory(t, "tamper");
  const workspace = join(parent, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  write(join(workspace, "source.txt"), "source\n");
  symlinkSync("../outside.txt", join(workspace, "escape-link"));
  const capture = captureExactWorkspaceState({ workspace_root: workspace });

  assert.throws(
    () => materializeVerifierSubjectFromSnapshot({
      snapshotArtifactBytes: capture.artifact.bytes,
      sourceContentDigest: capture.content_digest,
      sourceEnvironmentDigest: capture.environment_digest,
    }),
    (error: unknown) =>
      error instanceof VerifierSubjectMaterializationError
      && error.code === "verifier_subject_snapshot_symlink_escape",
  );

  const manifest = JSON.parse(
    capture.artifact.bytes.toString("utf8"),
  ) as Record<string, unknown>;
  const entries = manifest.entries as Array<Record<string, unknown>>;
  const file = entries.find((entry) => entry.path === "source.txt");
  assert.ok(file);
  const working = file.working_tree as Record<string, unknown>;
  working.mode_octal = "4777";
  const tamperedBytes = Buffer.from(stableStringify(manifest), "utf8");
  assert.throws(
    () => materializeVerifierSubjectFromSnapshot({
      snapshotArtifactBytes: tamperedBytes,
      sourceContentDigest: sha256(tamperedBytes),
      sourceEnvironmentDigest: capture.environment_digest,
    }),
    (error: unknown) =>
      error instanceof VerifierSubjectMaterializationError
      && error.code === "verifier_subject_snapshot_mode_invalid",
  );

  assert.throws(
    () => materializeVerifierSubjectFromSnapshot({
      snapshotArtifactBytes: capture.artifact.bytes,
      sourceContentDigest: "0".repeat(64),
      sourceEnvironmentDigest: capture.environment_digest,
    }),
    (error: unknown) =>
      error instanceof VerifierSubjectMaterializationError
      && error.code === "verifier_subject_snapshot_digest_mismatch",
  );
});
