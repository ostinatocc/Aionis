import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  LearningExternalEvidenceReceiptWriterError,
  publishLearningExternalEvidenceReceipt,
  type LearningExternalEvidenceReceiptWriterPhase,
} from "../../src/operator/learning-external-evidence-receipt-writer.js";

const CANONICAL_RECEIPT = stableStringify({
  operation_id: "learning-evidence-operation-001",
  status: "committed",
});

function fixtureDirectory(): string {
  const trustedHome = realpathSync.native(homedir());
  const path = mkdtempSync(join(trustedHome, ".aionis-evidence-receipt-"));
  chmodSync(path, 0o700);
  return realpathSync.native(path);
}

function withFixture(run: (directory: string) => void): void {
  const directory = fixtureDirectory();
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertWriterCode(
  action: () => unknown,
  code: LearningExternalEvidenceReceiptWriterError["code"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LearningExternalEvidenceReceiptWriterError);
    assert.equal(error.code, code);
    return true;
  });
}

function tempEntries(directory: string): string[] {
  return readdirSync(directory).filter((entry) => (
    entry.includes(".aionis-learning-evidence-receipt-") && entry.endsWith(".tmp")
  ));
}

function installExtendedAcl(path: string): ReturnType<typeof spawnSync> {
  if (process.platform === "darwin") {
    return spawnSync(
      "/bin/chmod",
      ["+a", "everyone allow write", path],
      { encoding: "utf8", timeout: 5_000 },
    );
  }
  const serviceUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const delegatedUid = serviceUid === 65_534 ? 65_533 : 65_534;
  return spawnSync(
    "/usr/bin/setfacl",
    ["-m", `u:${String(delegatedUid)}:---`, path],
    { encoding: "utf8", timeout: 5_000 },
  );
}

function clearExtendedAcl(path: string): void {
  if (!existsSync(path)) return;
  if (process.platform === "darwin") {
    spawnSync("/bin/chmod", ["-N", path], { timeout: 5_000 });
    return;
  }
  spawnSync("/usr/bin/setfacl", ["-b", path], { timeout: 5_000 });
}

function assertSafeExactReceipt(path: string, expected = CANONICAL_RECEIPT): void {
  const stat = lstatSync(path);
  assert.ok(stat.isFile());
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  assert.equal(stat.uid, process.getuid());
  assert.equal(readFileSync(path, "utf8"), expected);
}

test("receipt writer durably publishes fresh canonical bytes with no temp residue", () => {
  withFixture((directory) => {
    const destination = join(directory, "receipt.json");
    const result = publishLearningExternalEvidenceReceipt({
      destination,
      receiptJson: CANONICAL_RECEIPT,
    });

    assert.deepEqual(result, {
      status: "published",
      destination,
      byte_length: Buffer.byteLength(CANONICAL_RECEIPT),
      receipt_sha256: "86beb64abc1c1364d28e287862658edd0454b0f938151e7026e34f2c8a5f6e40",
    });
    assertSafeExactReceipt(destination);
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer treats only a safe byte-identical destination as exact replay", () => {
  withFixture((directory) => {
    const destination = join(directory, "receipt.json");
    publishLearningExternalEvidenceReceipt({ destination, receiptJson: CANONICAL_RECEIPT });
    const inode = lstatSync(destination).ino;

    const replay = publishLearningExternalEvidenceReceipt({
      destination,
      receiptJson: CANONICAL_RECEIPT,
    });
    assert.equal(replay.status, "exact_replay");
    assert.equal(lstatSync(destination).ino, inode);
    assertSafeExactReceipt(destination);
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer recovers exact replay after SIGKILL leaves destination and temp hard-linked", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
  timeout: 30_000,
}, () => {
  withFixture((directory) => {
    const destination = join(directory, "sigkill-receipt.json");
    const writerModuleUrl = pathToFileURL(join(
      process.cwd(),
      "src/operator/learning-external-evidence-receipt-writer.ts",
    )).href;
    const childSource = `
      import { publishLearningExternalEvidenceReceipt } from ${JSON.stringify(writerModuleUrl)};
      publishLearningExternalEvidenceReceipt(
        {
          destination: ${JSON.stringify(destination)},
          receiptJson: ${JSON.stringify(CANONICAL_RECEIPT)},
        },
        {
          phaseHook(phase) {
            if (phase === "after_publish") process.kill(process.pid, "SIGKILL");
          },
        },
      );
      process.exitCode = 97;
    `;
    const crashed = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childSource],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(crashed.error, undefined, crashed.error?.message);
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);

    const orphanNames = tempEntries(directory);
    assert.equal(orphanNames.length, 1);
    const orphan = join(directory, orphanNames[0]!);
    const destinationBefore = lstatSync(destination);
    const orphanBefore = lstatSync(orphan);
    assert.equal(destinationBefore.nlink, 2);
    assert.equal(orphanBefore.nlink, 2);
    assert.equal(destinationBefore.dev, orphanBefore.dev);
    assert.equal(destinationBefore.ino, orphanBefore.ino);
    assert.equal(readFileSync(destination, "utf8"), CANONICAL_RECEIPT);

    const replay = publishLearningExternalEvidenceReceipt({
      destination,
      receiptJson: CANONICAL_RECEIPT,
    });
    assert.equal(replay.status, "exact_replay");
    assertSafeExactReceipt(destination);
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer never overwrites a different safe destination", () => {
  withFixture((directory) => {
    const destination = join(directory, "receipt.json");
    const original = stableStringify({ operation_id: "other", status: "committed" });
    writeFileSync(destination, original, { flag: "wx", mode: 0o600 });
    chmodSync(destination, 0o600);
    const inode = lstatSync(destination).ino;

    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({
        destination,
        receiptJson: CANONICAL_RECEIPT,
      }),
      "learning_external_evidence_receipt_conflict",
    );
    assert.equal(lstatSync(destination).ino, inode);
    assert.equal(readFileSync(destination, "utf8"), original);
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer rejects different-length and large sparse destinations without reading their body", () => {
  withFixture((directory) => {
    const shortDestination = join(directory, "short.json");
    writeFileSync(shortDestination, "{}", { flag: "wx", mode: 0o600 });
    chmodSync(shortDestination, 0o600);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({
        destination: shortDestination,
        receiptJson: CANONICAL_RECEIPT,
      }),
      "learning_external_evidence_receipt_conflict",
    );
    assert.equal(readFileSync(shortDestination, "utf8"), "{}");

    const sparseDestination = join(directory, "large-sparse.json");
    writeFileSync(sparseDestination, "x", { flag: "wx", mode: 0o600 });
    truncateSync(sparseDestination, 512 * 1024 * 1024);
    chmodSync(sparseDestination, 0o600);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({
        destination: sparseDestination,
        receiptJson: CANONICAL_RECEIPT,
      }),
      "learning_external_evidence_receipt_conflict",
    );
    assert.equal(lstatSync(sparseDestination).size, 512 * 1024 * 1024);
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer rejects symlink, hardlink, and non-0600 destinations even when bytes match", () => {
  withFixture((directory) => {
    const target = join(directory, "target.json");
    writeFileSync(target, CANONICAL_RECEIPT, { flag: "wx", mode: 0o600 });
    chmodSync(target, 0o600);

    const symlink = join(directory, "symlink.json");
    symlinkSync(target, symlink);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({ destination: symlink, receiptJson: CANONICAL_RECEIPT }),
      "learning_external_evidence_receipt_destination_unsafe",
    );

    const hardlink = join(directory, "hardlink.json");
    linkSync(target, hardlink);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({ destination: hardlink, receiptJson: CANONICAL_RECEIPT }),
      "learning_external_evidence_receipt_destination_unsafe",
    );

    const permissive = join(directory, "permissive.json");
    writeFileSync(permissive, CANONICAL_RECEIPT, { flag: "wx", mode: 0o640 });
    chmodSync(permissive, 0o640);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({ destination: permissive, receiptJson: CANONICAL_RECEIPT }),
      "learning_external_evidence_receipt_destination_unsafe",
    );
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer requires an existing canonical trusted parent and canonical JSON", () => {
  withFixture((directory) => {
    const missing = join(directory, "missing", "receipt.json");
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({ destination: missing, receiptJson: CANONICAL_RECEIPT }),
      "learning_external_evidence_receipt_parent_untrusted",
    );
    assert.equal(existsSync(join(directory, "missing")), false);

    const realParent = join(directory, "real-parent");
    const linkedParent = join(directory, "linked-parent");
    // A newly created parent is made explicitly trustworthy before testing the symlink path.
    const nested = mkdtempSync(`${realParent}-`);
    chmodSync(nested, 0o700);
    symlinkSync(nested, linkedParent);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({
        destination: join(linkedParent, "receipt.json"),
        receiptJson: CANONICAL_RECEIPT,
      }),
      "learning_external_evidence_receipt_parent_untrusted",
    );

    const writableParent = mkdtempSync(join(directory, "writable-parent-"));
    chmodSync(writableParent, 0o770);
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({
        destination: join(writableParent, "receipt.json"),
        receiptJson: CANONICAL_RECEIPT,
      }),
      "learning_external_evidence_receipt_parent_untrusted",
    );

    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt({
        destination: join(directory, "noncanonical.json"),
        receiptJson: "{\"status\":\"committed\",\"operation_id\":\"learning-evidence-operation-001\"}",
      }),
      "learning_external_evidence_receipt_json_noncanonical",
    );
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer rejects delegated ACLs on parent, destination, and temp", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
  timeout: 30_000,
}, (t) => {
  withFixture((directory) => {
    const probe = join(directory, "acl-probe");
    writeFileSync(probe, "probe", { flag: "wx", mode: 0o600 });
    const preflight = installExtendedAcl(probe);
    if (preflight.error || preflight.status !== 0) {
      clearExtendedAcl(probe);
      t.skip(`ACL setup unavailable: ${preflight.error?.message ?? preflight.stderr}`);
      return;
    }
    clearExtendedAcl(probe);
    rmSync(probe, { force: true });

    const parentDestination = join(directory, "parent-acl.json");
    const parentAcl = installExtendedAcl(directory);
    assert.equal(parentAcl.status, 0, parentAcl.stderr);
    try {
      assertWriterCode(
        () => publishLearningExternalEvidenceReceipt({
          destination: parentDestination,
          receiptJson: CANONICAL_RECEIPT,
        }),
        "learning_external_evidence_receipt_parent_untrusted",
      );
    } finally {
      clearExtendedAcl(directory);
    }

    const destination = join(directory, "destination-acl.json");
    publishLearningExternalEvidenceReceipt({ destination, receiptJson: CANONICAL_RECEIPT });
    const destinationAcl = installExtendedAcl(destination);
    assert.equal(destinationAcl.status, 0, destinationAcl.stderr);
    assert.equal(lstatSync(destination).mode & 0o777, 0o600);
    try {
      assertWriterCode(
        () => publishLearningExternalEvidenceReceipt({
          destination,
          receiptJson: CANONICAL_RECEIPT,
        }),
        "learning_external_evidence_receipt_destination_unsafe",
      );
    } finally {
      clearExtendedAcl(destination);
    }
    assert.equal(
      publishLearningExternalEvidenceReceipt({ destination, receiptJson: CANONICAL_RECEIPT }).status,
      "exact_replay",
    );

    const tempDestination = join(directory, "temp-acl.json");
    assertWriterCode(
      () => publishLearningExternalEvidenceReceipt(
        { destination: tempDestination, receiptJson: CANONICAL_RECEIPT },
        {
          phaseHook(phase) {
            if (phase !== "temp_hardened") return;
            const entries = tempEntries(directory);
            assert.equal(entries.length, 1);
            const tempPath = join(directory, entries[0]!);
            const tempAcl = installExtendedAcl(tempPath);
            assert.equal(tempAcl.status, 0, tempAcl.stderr);
            assert.equal(lstatSync(tempPath).mode & 0o777, 0o600);
          },
        },
      ),
      "learning_external_evidence_receipt_destination_unsafe",
    );
    assert.equal(existsSync(tempDestination), false);
    assert.deepEqual(tempEntries(directory), []);
  });
});

test("receipt writer cleans its temp and remains safely replayable after every injected phase failure", () => {
  const phases: readonly LearningExternalEvidenceReceiptWriterPhase[] = [
    "temp_opened",
    "temp_hardened",
    "temp_written",
    "temp_fsynced",
    "before_publish",
    "after_publish",
    "publish_directory_fsynced",
    "temp_unlinked",
    "cleanup_directory_fsynced",
  ];
  const publishedPhases = new Set<LearningExternalEvidenceReceiptWriterPhase>([
    "after_publish",
    "publish_directory_fsynced",
    "temp_unlinked",
    "cleanup_directory_fsynced",
  ]);

  for (const phase of phases) {
    withFixture((directory) => {
      const destination = join(directory, `${phase}.json`);
      const injected = new Error(`injected:${phase}`);
      assert.throws(
        () => publishLearningExternalEvidenceReceipt(
          { destination, receiptJson: CANONICAL_RECEIPT },
          {
            phaseHook(actual) {
              if (actual === phase) throw injected;
            },
          },
        ),
        (error: unknown) => error === injected,
      );
      assert.deepEqual(tempEntries(directory), [], phase);

      if (publishedPhases.has(phase)) {
        assertSafeExactReceipt(destination);
      } else {
        assert.equal(existsSync(destination), false, phase);
      }

      const replay = publishLearningExternalEvidenceReceipt({
        destination,
        receiptJson: CANONICAL_RECEIPT,
      });
      assert.equal(replay.status, publishedPhases.has(phase) ? "exact_replay" : "published", phase);
      assertSafeExactReceipt(destination);
      assert.deepEqual(tempEntries(directory), [], phase);
    });
  }
});
