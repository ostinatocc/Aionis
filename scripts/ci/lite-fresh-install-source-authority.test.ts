import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertInstalledRuntimeCommit,
  prepareVerifiedRuntimeCloneSource,
} from "../e2e/fresh-install-smoke.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  return String(result.stdout ?? "").trim();
}

test("fresh install stages and verifies an immutable Runtime commit before lifecycle execution", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-fresh-source-authority-"));
  const source = path.join(directory, "source");
  const staging = path.join(directory, "staging");
  const installed = path.join(directory, "installed");
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(staging);
    git(source, ["init"]);
    git(source, ["config", "user.name", "Aionis Test"]);
    git(source, ["config", "user.email", "aionis-test@example.invalid"]);
    fs.writeFileSync(path.join(source, ".gitignore"), ".env\nnode_modules/\ndist/\n");
    fs.writeFileSync(path.join(source, "runtime.txt"), "verified runtime\n");
    git(source, ["add", ".gitignore", "runtime.txt"]);
    git(source, ["commit", "-m", "verified runtime"]);
    git(source, ["tag", "v-test"]);
    const expectedCommit = git(source, ["rev-parse", "HEAD^{commit}"]);

    const staged = prepareVerifiedRuntimeCloneSource({
      tmpRoot: staging,
      sourceDir: source,
      sourceRef: "v-test",
      expectedCommit,
    });
    git(directory, ["clone", "--depth", "1", "--branch", staged.branch, staged.repo, installed]);
    fs.writeFileSync(path.join(installed, ".env"), "EMBEDDING_PROVIDER=none\n");
    assert.equal(assertInstalledRuntimeCommit(installed, expectedCommit), expectedCommit);

    fs.writeFileSync(path.join(installed, "untracked-runtime.ts"), "unverified source\n");
    assert.throws(
      () => assertInstalledRuntimeCommit(installed, expectedCommit),
      /fresh installer changed Runtime source files/,
    );
    fs.rmSync(path.join(installed, "untracked-runtime.ts"));

    fs.writeFileSync(path.join(installed, "runtime.txt"), "tampered runtime\n");
    assert.throws(
      () => assertInstalledRuntimeCommit(installed, expectedCommit),
      /fresh installer changed Runtime source files/,
    );

    fs.writeFileSync(path.join(source, "runtime.txt"), "later runtime\n");
    git(source, ["add", "runtime.txt"]);
    git(source, ["commit", "-m", "later runtime"]);
    const laterCommit = git(source, ["rev-parse", "HEAD^{commit}"]);
    const mismatchStaging = path.join(directory, "mismatch-staging");
    fs.mkdirSync(mismatchStaging);
    assert.throws(
      () => prepareVerifiedRuntimeCloneSource({
        tmpRoot: mismatchStaging,
        sourceDir: source,
        sourceRef: "v-test",
        expectedCommit: laterCommit,
      }),
      /verified Runtime source ref v-test resolves to .* expected/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
