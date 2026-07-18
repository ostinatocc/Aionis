import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  learningExternalEvidenceIngestCliFailureJson,
  runLearningExternalEvidenceIngestCli,
} from "../../packages/aionis-learning-authority/src/operator/learning-external-evidence-ingest.js";
import { LearningExternalEvidenceReceiptWriterError } from
  "../../packages/aionis-learning-authority/src/operator/learning-external-evidence-receipt-writer.js";
import { LiteLearningExternalEvidenceServiceError } from
  "../../packages/aionis-learning-authority/src/store/lite-learning-external-evidence-service.js";

type Invocation = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

function fixtureDirectory(): string {
  const path = mkdtempSync(join(realpathSync.native(tmpdir()), "aionis-learning-evidence-cli-"));
  chmodSync(path, 0o700);
  return realpathSync.native(path);
}

async function invoke(argv: readonly string[]): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runLearningExternalEvidenceIngestCli(argv, {
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  return { exitCode, stdout, stderr };
}

function validArgs(directory: string): string[] {
  return [
    "ingest",
    "--db", join(directory, "runtime.sqlite"),
    "--tenant", "tenant-a",
    "--actor", "operator-a",
    "--operation-id", "operation-a",
    "--kind", "offline_paired_rerun",
    "--public-run-authority", join(directory, "public-run-authority.json"),
    "--run-bundle", join(directory, "run-bundle.aionis"),
    "--series-id", "series-a",
    "--task-family", "family-a",
    "--applicable-experiment-id", "experiment-a",
    "--applicable-revision", "1",
    "--out", join(directory, "receipt.json"),
  ];
}

function replaceFlag(args: readonly string[], flag: string, value: string): string[] {
  const next = [...args];
  const index = next.indexOf(`--${flag}`);
  assert.notEqual(index, -1);
  next[index + 1] = value;
  return next;
}

function parsedFailure(invocation: Invocation): Record<string, unknown> {
  assert.equal(invocation.exitCode, 1);
  assert.equal(invocation.stdout, "");
  assert.ok(invocation.stderr.endsWith("\n"));
  const text = invocation.stderr.slice(0, -1);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(stableStringify(parsed), text);
  assert.equal(parsed.error, "learning_external_evidence_ingest_failed");
  assert.equal(typeof parsed.code, "string");
  assert.equal(typeof parsed.message, "string");
  return parsed;
}

test("learning evidence CLI exposes only help and ingest", async () => {
  for (const argv of [[], ["help"], ["--help"], ["ingest", "--help"]] as const) {
    const result = await invoke(argv);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /scripts\/learning-evidence\.ts ingest/u);
    assert.equal(result.stderr, "");
  }

  const unknown = parsedFailure(await invoke(["publish"]));
  assert.equal(unknown.code, "learning_external_evidence_cli_unknown_command");
  const helpExtra = parsedFailure(await invoke(["help", "extra"]));
  assert.equal(helpExtra.code, "learning_external_evidence_cli_argument_invalid");
});

test("learning evidence CLI rejects unknown, duplicate, missing, empty, and malformed flags", async () => {
  const directory = fixtureDirectory();
  try {
    const unknownArgs = [...validArgs(directory), "--extra", "value"];
    assert.equal(
      parsedFailure(await invoke(unknownArgs)).code,
      "learning_external_evidence_cli_unknown_flag",
    );

    const duplicateArgs = [...validArgs(directory), "--tenant", "tenant-b"];
    assert.equal(
      parsedFailure(await invoke(duplicateArgs)).code,
      "learning_external_evidence_cli_duplicate_flag",
    );
    assert.equal(
      parsedFailure(await invoke(["ingest"])).code,
      "learning_external_evidence_cli_required_flag_missing",
    );
    assert.equal(
      parsedFailure(await invoke(["ingest", "--db", ""])).code,
      "learning_external_evidence_cli_flag_value_required",
    );
    assert.equal(
      parsedFailure(await invoke(["ingest", "--db=/tmp/runtime.sqlite"])).code,
      "learning_external_evidence_cli_argument_invalid",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("learning evidence CLI requires canonical absolute paths and strict kind/revision", async () => {
  const directory = fixtureDirectory();
  try {
    assert.equal(
      parsedFailure(await invoke(replaceFlag(validArgs(directory), "out", "receipt.json"))).code,
      "learning_external_evidence_cli_absolute_path_required",
    );
    assert.equal(
      parsedFailure(await invoke(replaceFlag(
        validArgs(directory),
        "run-bundle",
        `${directory}/nested/../run-bundle.aionis`,
      ))).code,
      "learning_external_evidence_cli_absolute_path_required",
    );
    assert.equal(
      parsedFailure(await invoke(replaceFlag(validArgs(directory), "kind", "unknown"))).code,
      "learning_external_evidence_cli_kind_invalid",
    );
    for (const revision of ["0", "01", "1.0", "9007199254740992"]) {
      assert.equal(
        parsedFailure(await invoke(replaceFlag(
          validArgs(directory),
          "applicable-revision",
          revision,
        ))).code,
        "learning_external_evidence_cli_revision_invalid",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("learning evidence CLI collision matrix covers SQLite rollback sidecar aliases", async () => {
  const directory = fixtureDirectory();
  try {
    const args = validArgs(directory);
    const database = args[args.indexOf("--db") + 1]!;
    for (const [flag, sidecar] of [
      ["run-bundle", "-wal"],
      ["public-run-authority", "-shm"],
      ["out", "-journal"],
    ] as const) {
      const failure = parsedFailure(await invoke(replaceFlag(args, flag, `${database}${sidecar}`)));
      assert.equal(failure.code, "learning_external_evidence_cli_path_collision");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("learning evidence CLI derives SQLite sidecars from a symlinked database target", async () => {
  const directory = fixtureDirectory();
  try {
    const database = join(directory, "runtime.sqlite");
    const databaseAlias = join(directory, "runtime-alias.sqlite");
    writeFileSync(database, "existing database placeholder", { mode: 0o600 });
    symlinkSync(database, databaseAlias);

    let args = replaceFlag(validArgs(directory), "db", databaseAlias);
    args = replaceFlag(args, "out", `${database}-journal`);
    assert.equal(
      parsedFailure(await invoke(args)).code,
      "learning_external_evidence_cli_path_collision",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("learning evidence CLI detects realpath, inode, and case-folded aliases using real files", async () => {
  const directory = fixtureDirectory();
  try {
    const archive = join(directory, "archive.bin");
    const archiveAlias = join(directory, "archive-alias.bin");
    writeFileSync(archive, "archive", { mode: 0o600 });
    symlinkSync(archive, archiveAlias);
    let args = replaceFlag(validArgs(directory), "run-bundle", archive);
    args = replaceFlag(args, "public-run-authority", archiveAlias);
    assert.equal(
      parsedFailure(await invoke(args)).code,
      "learning_external_evidence_cli_path_collision",
    );

    const hardLink = join(directory, "archive-hard-link.bin");
    linkSync(archive, hardLink);
    args = replaceFlag(validArgs(directory), "run-bundle", archive);
    args = replaceFlag(args, "public-run-authority", hardLink);
    assert.equal(
      parsedFailure(await invoke(args)).code,
      "learning_external_evidence_cli_path_collision",
    );

    args = replaceFlag(validArgs(directory), "run-bundle", join(directory, "Bundle.AIONIS"));
    args = replaceFlag(args, "public-run-authority", join(directory, "bundle.aionis"));
    assert.equal(
      parsedFailure(await invoke(args)).code,
      "learning_external_evidence_cli_path_collision",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-commit receipt failures use the retry-safe canonical envelope", () => {
  const failureJson = learningExternalEvidenceIngestCliFailureJson(
    new LearningExternalEvidenceReceiptWriterError(
      "learning_external_evidence_receipt_conflict",
      "receipt bytes conflict",
    ),
    true,
  );
  const parsed = JSON.parse(failureJson) as Record<string, unknown>;
  assert.equal(stableStringify(parsed), failureJson);
  assert.deepEqual(parsed, {
    error: "learning_external_evidence_ingest_failed",
    code: "learning_external_evidence_receipt_output_failed_after_commit",
    message: "evidence was committed but durable receipt output failed: receipt bytes conflict",
    committed: true,
    retry: "same_operation_id",
  });

  const serviceFailure = new LiteLearningExternalEvidenceServiceError(
    "learning_external_evidence_service_failed_after_commit",
    "cleanup failed after commit",
    { committed: true },
  );
  const serviceFailureJson = learningExternalEvidenceIngestCliFailureJson(
    serviceFailure,
    serviceFailure.committed,
  );
  assert.deepEqual(JSON.parse(serviceFailureJson), {
    error: "learning_external_evidence_ingest_failed",
    code: "learning_external_evidence_receipt_output_failed_after_commit",
    message: "evidence was committed but durable receipt output failed: cleanup failed after commit",
    committed: true,
    retry: "same_operation_id",
  });
});
