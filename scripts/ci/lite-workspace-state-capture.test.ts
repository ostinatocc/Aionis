import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { StateSnapshotV1Schema } from "../../src/memory/execution-episode.js";
import {
  captureExactWorkspaceState,
  WorkspaceStateCaptureError,
  type WorkspaceStateCaptureManifestV1,
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
  const directory = mkdtempSync(join(tmpdir(), `aionis-state-${label}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(path: string, bytes: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

function git(directory: string, args: readonly string[]): string {
  const result = spawnSync(
    "git",
    ["--literal-pathspecs", "-C", directory, ...args],
    {
      encoding: "utf8",
      env: GIT_ENV,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitAll(directory: string): void {
  git(directory, ["add", "--all"]);
  git(directory, [
    "-c",
    "user.name=Aionis State Capture",
    "-c",
    "user.email=state-capture@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "initial real workspace",
  ]);
}

function entry(
  manifest: WorkspaceStateCaptureManifestV1,
  path: string,
) {
  const found = manifest.entries.find((candidate) => candidate.path === path);
  assert.ok(found, `expected captured entry ${path}`);
  return found;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("real Git workspace capture binds HEAD, index, working bytes, deletion, mode, untracked files, and symlinks", (t) => {
  const directory = temporaryDirectory(t, "git-layers");
  git(directory, ["init", "--quiet", "--template="]);
  write(
    join(directory, ".gitignore"),
    "ignored.log\ndist/\nnode_modules/\n",
  );
  write(join(directory, "tracked.txt"), "tracked-at-head\n");
  write(join(directory, "staged.txt"), "staged-at-head\n");
  write(join(directory, "deleted.txt"), "deleted-at-head\n");
  write(join(directory, "mode.sh"), "#!/bin/sh\nexit 0\n", 0o600);
  if (process.platform !== "win32") {
    symlinkSync("tracked.txt", join(directory, "tracked-link"));
  }
  commitAll(directory);

  write(join(directory, "tracked.txt"), "tracked-working-change\n");
  write(join(directory, "staged.txt"), "staged-index-version\n");
  git(directory, ["add", "staged.txt"]);
  write(join(directory, "staged.txt"), "staged-working-version\n");
  rmSync(join(directory, "deleted.txt"));
  write(join(directory, "untracked.txt"), "real-untracked-evidence\n");
  chmodSync(join(directory, "mode.sh"), 0o755);
  write(join(directory, "ignored.log"), "ignored-first\n");
  write(join(directory, "dist", "bundle.js"), "build-noise-first\n");
  write(
    join(directory, "node_modules", "dependency", "index.js"),
    "dependency-noise-first\n",
  );

  const first = captureExactWorkspaceState({ workspace_root: directory });
  const repeated = captureExactWorkspaceState({ workspace_root: directory });

  assert.equal(first.workspace_kind, "git");
  assert.equal(first.repository_root, first.workspace_root);
  assert.equal(first.manifest.repository?.object_format, "sha1");
  assert.match(first.manifest.repository?.head_commit ?? "", /^[0-9a-f]{40}$/u);
  assert.match(first.manifest.repository?.head_tree ?? "", /^[0-9a-f]{40}$/u);
  assert.equal(first.content_digest, repeated.content_digest);
  assert.equal(first.environment_digest, repeated.environment_digest);
  assert.deepEqual(first.artifact.bytes, repeated.artifact.bytes);
  assert.equal(first.content_digest, sha256(first.artifact.bytes));
  assert.equal(first.artifact.declared_sha256, first.content_digest);
  assert.equal(
    first.artifact.declared_byte_length,
    first.artifact.bytes.byteLength,
  );
  assert.deepEqual(JSON.parse(first.artifact.bytes.toString("utf8")), first.manifest);
  const stateSnapshot = StateSnapshotV1Schema.parse({
    contract_version: "state_snapshot_v1",
    snapshot_id: "snapshot-real-workspace",
    algorithm_id: first.algorithm_id,
    algorithm_version: first.algorithm_version,
    state_kind: first.state_kind,
    environment_digest: first.environment_digest,
    content_digest: first.content_digest,
    artifact_ref: {
      contract_version: "evidence_artifact_ref_v1",
      artifact_id: "artifact-real-workspace",
      kind: first.artifact.kind,
      sha256: first.artifact.declared_sha256,
      storage_ref: "sqlite-cas://artifact-real-workspace",
      byte_length: first.artifact.declared_byte_length,
      media_type: first.artifact.media_type,
      encoding: first.artifact.encoding,
      redaction_policy: "workspace-source-v1",
      retention_policy: "episode-replay-v1",
    },
    captured_at: "2026-07-27T00:00:00.000Z",
  });
  assert.equal(
    stateSnapshot.content_digest,
    stateSnapshot.artifact_ref.sha256,
  );

  const paths = first.manifest.entries.map((candidate) => candidate.path);
  assert.deepEqual(
    paths,
    [...paths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))),
  );
  assert.equal(paths.includes("ignored.log"), false);
  assert.equal(paths.some((path) => path.startsWith("dist/")), false);
  assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);

  const tracked = entry(first.manifest, "tracked.txt");
  assert.ok(tracked.git_head);
  assert.equal(tracked.git_index.length, 1);
  assert.equal(tracked.git_index[0]?.object_id, tracked.git_head.object_id);
  assert.equal(tracked.working_tree.kind, "regular_file");
  if (tracked.working_tree.kind === "regular_file") {
    assert.notEqual(tracked.working_tree.git_blob_oid, tracked.git_head.object_id);
    assert.equal(
      Buffer.from(tracked.working_tree.content_base64, "base64").toString("utf8"),
      "tracked-working-change\n",
    );
  }

  const staged = entry(first.manifest, "staged.txt");
  assert.ok(staged.git_head);
  assert.equal(staged.git_index.length, 1);
  assert.notEqual(staged.git_index[0]?.object_id, staged.git_head.object_id);
  assert.equal(staged.working_tree.kind, "regular_file");
  if (staged.working_tree.kind === "regular_file") {
    assert.notEqual(
      staged.working_tree.git_blob_oid,
      staged.git_index[0]?.object_id,
    );
    assert.equal(
      Buffer.from(staged.working_tree.content_base64, "base64").toString("utf8"),
      "staged-working-version\n",
    );
  }

  const deleted = entry(first.manifest, "deleted.txt");
  assert.ok(deleted.git_head);
  assert.equal(deleted.git_index.length, 1);
  assert.deepEqual(deleted.working_tree, { kind: "absent" });

  const untracked = entry(first.manifest, "untracked.txt");
  assert.equal(untracked.git_head, null);
  assert.deepEqual(untracked.git_index, []);
  assert.equal(untracked.working_tree.kind, "regular_file");

  const executable = entry(first.manifest, "mode.sh");
  assert.equal(executable.git_index[0]?.mode, "100644");
  assert.equal(executable.working_tree.kind, "regular_file");
  if (executable.working_tree.kind === "regular_file") {
    assert.equal(executable.working_tree.mode_octal, "0755");
  }

  if (process.platform !== "win32") {
    const link = entry(first.manifest, "tracked-link");
    assert.equal(link.working_tree.kind, "symbolic_link");
    if (link.working_tree.kind === "symbolic_link") {
      assert.equal(
        Buffer.from(link.working_tree.target_base64, "base64").toString("utf8"),
        "tracked.txt",
      );
      assert.notEqual(
        link.working_tree.sha256,
        tracked.working_tree.kind === "regular_file"
          ? tracked.working_tree.sha256
          : "",
      );
    }
  }
});

test("Git ignored build/dependency noise is excluded, while real included state changes the digest", (t) => {
  const directory = temporaryDirectory(t, "git-ignore");
  git(directory, ["init", "--quiet", "--template="]);
  write(join(directory, ".gitignore"), "dist/\nnode_modules/\n*.ignored\n");
  write(join(directory, "source.ts"), "export const value = 1;\n");
  commitAll(directory);
  write(join(directory, "dist", "bundle.js"), "first build\n");
  write(join(directory, "node_modules", "pkg", "index.js"), "first dependency\n");
  write(join(directory, "cache.ignored"), "first ignored\n");

  const baseline = captureExactWorkspaceState({ workspace_root: directory });
  write(join(directory, "dist", "bundle.js"), "second build\n");
  write(join(directory, "node_modules", "pkg", "index.js"), "second dependency\n");
  write(join(directory, "cache.ignored"), "second ignored\n");
  const ignoredNoiseChanged = captureExactWorkspaceState({
    workspace_root: directory,
  });
  assert.equal(ignoredNoiseChanged.content_digest, baseline.content_digest);

  write(join(directory, "source.ts"), "export const value = 2;\n");
  const sourceChanged = captureExactWorkspaceState({ workspace_root: directory });
  assert.notEqual(sourceChanged.content_digest, baseline.content_digest);

  if (process.platform !== "win32") {
    chmodSync(join(directory, "source.ts"), 0o700);
    const modeChanged = captureExactWorkspaceState({ workspace_root: directory });
    assert.notEqual(modeChanged.content_digest, sourceChanged.content_digest);
  }
});

test("versioned subject state explicitly binds ignored deliverables and empty directories", (t) => {
  const directory = temporaryDirectory(t, "subject-state");
  git(directory, ["init", "--quiet", "--template="]);
  write(
    join(directory, ".gitignore"),
    "dist/\nempty-output/\nanswer.ignored\n",
  );
  write(join(directory, "source.ts"), "export const source = true;\n");
  commitAll(directory);
  write(join(directory, "dist", "answer.json"), "{\"answer\":1}\n");
  write(join(directory, "answer.ignored"), "first\n");

  const ordinary = captureExactWorkspaceState({ workspace_root: directory });
  const spec = {
    contract_version: "workspace_subject_state_spec_v2" as const,
    additional_state_roots: [
      "answer.ignored",
      "dist",
      "empty-output",
    ],
  };
  const explicit = captureExactWorkspaceState({
    workspace_root: directory,
    subject_state_spec: spec,
  });
  assert.notEqual(explicit.content_digest, ordinary.content_digest);
  assert.deepEqual(
    explicit.manifest.capture_policy.subject_state_spec,
    spec,
  );
  assert.equal(
    entry(explicit.manifest, "dist").working_tree.kind,
    "directory",
  );
  assert.equal(
    entry(explicit.manifest, "dist/answer.json").working_tree.kind,
    "regular_file",
  );
  assert.equal(
    entry(explicit.manifest, "answer.ignored").working_tree.kind,
    "regular_file",
  );
  assert.equal(
    entry(explicit.manifest, "empty-output").working_tree.kind,
    "absent",
  );

  write(join(directory, "dist", "answer.json"), "{\"answer\":2}\n");
  const ignoredDeliverableChanged = captureExactWorkspaceState({
    workspace_root: directory,
    subject_state_spec: spec,
  });
  assert.notEqual(
    ignoredDeliverableChanged.content_digest,
    explicit.content_digest,
  );

  mkdirSync(join(directory, "empty-output"), { mode: 0o700 });
  const emptyDirectoryCreated = captureExactWorkspaceState({
    workspace_root: directory,
    subject_state_spec: spec,
  });
  assert.notEqual(
    emptyDirectoryCreated.content_digest,
    ignoredDeliverableChanged.content_digest,
  );
  assert.equal(
    entry(emptyDirectoryCreated.manifest, "empty-output").working_tree.kind,
    "directory",
  );

  assert.throws(
    () => captureExactWorkspaceState({
      workspace_root: directory,
      subject_state_spec: {
        contract_version: "workspace_subject_state_spec_v2",
        additional_state_roots: ["../outside"],
      },
    }),
    (error: unknown) =>
      error instanceof WorkspaceStateCaptureError
      && error.code === "workspace_state_capture_invalid_relative_path",
  );
});

test("Git subject state binds ancestor directory presence and mode", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = temporaryDirectory(t, "git-directory-mode");
  git(directory, ["init", "--quiet", "--template="]);
  write(join(directory, "nested", "source.ts"), "export const value = 1;\n");
  commitAll(directory);
  chmodSync(join(directory, "nested"), 0o700);
  const privateDirectory = captureExactWorkspaceState({
    workspace_root: directory,
  });
  const nestedPrivate = entry(privateDirectory.manifest, "nested");
  assert.equal(nestedPrivate.working_tree.kind, "directory");
  if (nestedPrivate.working_tree.kind === "directory") {
    assert.equal(nestedPrivate.working_tree.mode_octal, "0700");
  }

  chmodSync(join(directory, "nested"), 0o755);
  const publicDirectory = captureExactWorkspaceState({
    workspace_root: directory,
  });
  assert.notEqual(
    publicDirectory.content_digest,
    privateDirectory.content_digest,
  );
  const nestedPublic = entry(publicDirectory.manifest, "nested");
  assert.equal(nestedPublic.working_tree.kind, "directory");
  if (nestedPublic.working_tree.kind === "directory") {
    assert.equal(nestedPublic.working_tree.mode_octal, "0755");
  }
});

test("Git tracked descendants cannot escape the workspace through a symlinked ancestor", {
  skip: process.platform === "win32",
}, (t) => {
  const parent = temporaryDirectory(t, "git-symlink-ancestor");
  const directory = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  git(directory, ["init", "--quiet", "--template="]);
  write(join(directory, "nested", "tracked.txt"), "inside-at-head\n");
  commitAll(directory);
  write(join(outside, "tracked.txt"), "must-not-be-captured\n");
  rmSync(join(directory, "nested"), { recursive: true });
  symlinkSync(outside, join(directory, "nested"), "dir");

  assert.throws(
    () => captureExactWorkspaceState({ workspace_root: directory }),
    (error: unknown) =>
      error instanceof WorkspaceStateCaptureError
      && error.code === "workspace_state_capture_symlink_ancestor_rejected",
  );
});

test("non-Git fallback is deterministic, includes unignored build content, and never follows a symlink", (t) => {
  const parent = temporaryDirectory(t, "filesystem");
  const workspace = join(parent, "workspace");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  write(join(workspace, "z-last.txt"), "last\n");
  write(join(workspace, "a-first.bin"), Buffer.from([0, 1, 2, 255]));
  write(join(workspace, "build", "generated.js"), "generated-one\n");
  write(join(workspace, ".git", "control-noise"), "not workspace content\n");
  write(join(parent, "outside.txt"), "outside-one\n");
  if (process.platform !== "win32") {
    symlinkSync("../outside.txt", join(workspace, "outside-link"));
  }

  const first = captureExactWorkspaceState({ workspace_root: workspace });
  const repeated = captureExactWorkspaceState({ workspace_root: workspace });
  assert.equal(first.workspace_kind, "filesystem");
  assert.equal(first.repository_root, null);
  assert.equal(first.content_digest, repeated.content_digest);
  assert.deepEqual(first.artifact.bytes, repeated.artifact.bytes);
  assert.equal(
    first.manifest.capture_policy.non_git_ignore_policy,
    "include_all_except_root_git_control_entry_v1",
  );
  assert.equal(
    first.manifest.entries.some((candidate) =>
      candidate.path.startsWith(".git/")),
    false,
  );

  if (process.platform !== "win32") {
    const link = entry(first.manifest, "outside-link");
    assert.equal(link.working_tree.kind, "symbolic_link");
    write(join(parent, "outside.txt"), "outside-two\n");
    const outsideTargetChanged = captureExactWorkspaceState({
      workspace_root: workspace,
    });
    assert.equal(outsideTargetChanged.content_digest, first.content_digest);
  }

  write(join(workspace, "build", "generated.js"), "generated-two\n");
  const includedBuildChanged = captureExactWorkspaceState({
    workspace_root: workspace,
  });
  assert.notEqual(includedBuildChanged.content_digest, first.content_digest);
});

test("resource limits reject oversized real files and excessive real entries", (t) => {
  const oversized = temporaryDirectory(t, "oversized");
  write(join(oversized, "large.bin"), Buffer.alloc(64, 0x61));
  assert.throws(
    () => captureExactWorkspaceState({
      workspace_root: oversized,
      limits: {
        max_file_bytes: 16,
        max_total_content_bytes: 32,
      },
    }),
    (error: unknown) =>
      error instanceof WorkspaceStateCaptureError
      && error.code === "workspace_state_capture_file_limit_exceeded",
  );

  const entries = temporaryDirectory(t, "entries");
  write(join(entries, "one.txt"), "one");
  write(join(entries, "two.txt"), "two");
  assert.throws(
    () => captureExactWorkspaceState({
      workspace_root: entries,
      limits: { max_entries: 1 },
    }),
    (error: unknown) =>
      error instanceof WorkspaceStateCaptureError
      && error.code === "workspace_state_capture_entry_limit_exceeded",
  );

  if (process.platform !== "win32") {
    const special = temporaryDirectory(t, "special");
    const fifoPath = join(special, "events.fifo");
    const created = spawnSync("mkfifo", [fifoPath], {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ifError(created.error);
    assert.equal(created.status, 0, created.stderr);
    assert.throws(
      () => captureExactWorkspaceState({ workspace_root: special }),
      (error: unknown) =>
        error instanceof WorkspaceStateCaptureError
        && error.code === "workspace_state_capture_special_file_rejected",
    );
  }
});
