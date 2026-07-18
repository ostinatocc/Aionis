import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import type { LearningExperimentCloseApprovalV1 } from
  "../../src/memory/learning-authority-approval.js";
import type { LearningExperimentCloseAuthorizationEnvelopeV1 } from
  "../../src/memory/learning-experiment-closing.js";
import {
  LearningExperimentClosingError,
  createLiteLearningExperimentCloser,
  type LearningExperimentCloseInput,
} from "../../tools/learning-experiments/lite-learning-experiment-closing.js";
import { createLiteLearningEpisodeLedgerAccess } from
  "../../src/store/lite-learning-episode-ledger.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../src/store/lite-runtime-database.js";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.js";
import type { AuthorityReceiptResolvedKeyring } from
  "../../src/util/authority-receipt-keys.js";
import {
  provisionConfirmatoryFixture,
  sha256,
  type ConfirmatoryFixtureRuntime,
  type ConfirmatoryProvisionedFixture,
} from "./support/learning-experiment-confirmatory-fixture.js";

const CLOSE_HMAC_DOMAIN = "aionis.learning-experiment-close-approval.hmac.v1";
const CLOSE_ACTOR = "confirmatory-experiment-closer";
const CLOSE_OPERATION_ID = "confirmatory-close-operation-1";
const CLOSE_KEY_ID = "confirmatory-close-key-v1";
const CLOSE_KEY_SECRET = Buffer.from(
  "confirmatory-close-key-material-that-is-longer-than-thirty-two-bytes",
  "utf8",
);
const CLOSE_ATTESTATION_KEY_ID = "confirmatory-close-attestation-key-v1";
const CLOSE_ATTESTATION_KEY_SECRET = Buffer.from(
  "confirmatory-close-attestation-material-that-is-longer-than-thirty-two-bytes",
  "utf8",
);
const CLOSE_NOW = "2026-07-14T10:00:00.000Z";
const CLOSE_ISSUED_AT = "2026-07-14T09:55:00.000Z";
const CLOSE_EXPIRES_AT = "2026-07-14T10:30:00.000Z";

function tempDatabase(name: string) {
  // Protected close intentionally rejects any writable ancestor. Linux `/tmp`
  // is normally 01777, so production-wrapper fixtures must live beneath the
  // current service user's trusted home chain instead of the generic temp dir.
  const directory = fs.mkdtempSync(path.join(os.homedir(), `.aionis-close-${name}-`));
  return { directory, path: path.join(directory, "runtime.sqlite") };
}

function closeNonce(label: string): string {
  return createHash("sha256")
    .update(`aionis-confirmatory-close:${label}`, "utf8")
    .digest()
    .subarray(0, 18)
    .toString("base64url");
}

function createCloseApproval(
  fixture: ConfirmatoryProvisionedFixture,
  overrides: Partial<LearningExperimentCloseApprovalV1> = {},
): LearningExperimentCloseApprovalV1 {
  return {
    contract_version: "learning_experiment_close_approval_v1",
    authorization_kind: "experiment_close",
    action: "close_experiment",
    runtime_authority_lineage_sha256: fixture.lineage.runtimeAuthorityLineageSha256,
    tenant_id: fixture.attempt.tenantId,
    task_family: fixture.attempt.taskFamily,
    confirmatory_attempt_id: fixture.attempt.confirmatoryAttemptId,
    confirmatory_attempt_sha256: fixture.attempt.confirmatoryAttemptSha256,
    experiment_id: fixture.attempt.experimentId,
    experiment_revision: fixture.attempt.experimentRevision,
    experiment_config_sha256: fixture.revision.experimentConfigSha256,
    namespace_set_sha256: fixture.leaseMembership.namespaceSetSha256,
    close_reason: "operator_stop",
    candidate_policy_implementation_sha256:
      fixture.attempt.candidatePolicyImplementationSha256,
    gate_policy_implementation_sha256:
      fixture.revision.gatePolicyImplementationSha256,
    authority_scope: "learning-experiment-authority-v1",
    authority_operation_kind: "learning_experiment_close_v1",
    authority_operation_id: CLOSE_OPERATION_ID,
    approved_by: "confirmatory-close-approver",
    authorization_key_id: CLOSE_KEY_ID,
    authorization_nonce: closeNonce(CLOSE_OPERATION_ID),
    authorization_issued_at: CLOSE_ISSUED_AT,
    authorization_expires_at: CLOSE_EXPIRES_AT,
    ...overrides,
  };
}

function signCloseApproval(
  approval: LearningExperimentCloseApprovalV1,
  key: Uint8Array = CLOSE_KEY_SECRET,
): LearningExperimentCloseAuthorizationEnvelopeV1 {
  const signingInput = Buffer.concat([
    Buffer.from(CLOSE_HMAC_DOMAIN, "utf8"),
    Buffer.from([0]),
    Buffer.from(stableStringify(approval), "utf8"),
  ]);
  return {
    contract_version: "learning_experiment_close_authorization_envelope_v1",
    approval,
    authorization_mac: createHmac("sha256", key)
      .update(signingInput)
      .digest("base64url"),
  };
}

function createSignedCloseAuthorization(
  fixture: ConfirmatoryProvisionedFixture,
  overrides: Partial<LearningExperimentCloseApprovalV1> = {},
  key: Uint8Array = CLOSE_KEY_SECRET,
): LearningExperimentCloseAuthorizationEnvelopeV1 {
  return signCloseApproval(createCloseApproval(fixture, overrides), key);
}

function closeInput(
  fixture: ConfirmatoryProvisionedFixture,
  authorization: LearningExperimentCloseAuthorizationEnvelopeV1,
  overrides: Partial<LearningExperimentCloseInput> = {},
): LearningExperimentCloseInput {
  return {
    tenantId: fixture.attempt.tenantId,
    actor: CLOSE_ACTOR,
    operationId: authorization.approval.authority_operation_id,
    authorization,
    experimentId: fixture.attempt.experimentId,
    experimentRevision: fixture.attempt.experimentRevision,
    ...overrides,
  };
}

function keyring(
  keys: ReadonlyMap<string, Buffer> = new Map([
    [CLOSE_KEY_ID, CLOSE_KEY_SECRET],
    [CLOSE_ATTESTATION_KEY_ID, CLOSE_ATTESTATION_KEY_SECRET],
  ]),
  options: Partial<AuthorityReceiptResolvedKeyring> = {},
): AuthorityReceiptResolvedKeyring {
  return {
    activeKeyId: CLOSE_ATTESTATION_KEY_ID,
    keys,
    configured: true,
    ephemeral: false,
    source: "keyring",
    ...options,
  };
}

function openCloseRuntime(
  databasePath: string,
  authorityReceiptKeyring: AuthorityReceiptResolvedKeyring = keyring(),
  faultInjector?: LiteRuntimeDatabaseFaultInjector,
): ConfirmatoryFixtureRuntime {
  const database = createLiteRuntimeDatabase(databasePath, { faultInjector });
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
    authorityReceiptKeyring,
  });
  return {
    database,
    writeStore,
    async close() {
      try {
        await writeStore.close();
      } finally {
        await database.close();
      }
    },
  };
}

function closeLedger(
  runtime: ConfirmatoryFixtureRuntime,
  authorityReceiptKeyring: AuthorityReceiptResolvedKeyring = keyring(),
) {
  return createLiteLearningEpisodeLedgerAccess(runtime.database, { authorityReceiptKeyring });
}

function count(runtime: ConfirmatoryFixtureRuntime, table: string, where = "1 = 1"): number {
  const row = runtime.database.db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
  ).get() as { count: number };
  return Number(row.count);
}

function assertNoCloseMutation(runtime: ConfirmatoryFixtureRuntime): void {
  assert.equal(count(runtime, "lite_learning_experiment_closures"), 0);
  assert.equal(count(
    runtime,
    "lite_learning_authorization_nonces",
    "authorization_kind = 'experiment_close'",
  ), 0);
  assert.equal(count(
    runtime,
    "lite_runtime_write_operations",
    "operation_kind = 'learning_experiment_close_v1'",
  ), 0);
  assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'active'"), 768);
  assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'released'"), 0);
}

function closingCode(expectedCode: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LearningExperimentClosingError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function closingFilesystemDiagnostic(
  expectedObject: "database" | "sidecar" | "direct_parent" | "ancestor",
  expectedEntryKind: "default" | "duplicate_base" | "effective_comment" | "flags"
    | "incomplete_base" | "mask" | "mode_mismatch" | "named_group" | "named_user"
    | "unparseable" | "verifier_failure",
  forbiddenMessageFragments: readonly string[] = [],
) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LearningExperimentClosingError);
    assert.equal(error.code, "learning_experiment_close_database_filesystem_untrusted");
    assert.equal(
      error.message.endsWith(
        `[object=${expectedObject} entry_kind=${expectedEntryKind}]`,
      ),
      true,
      `unexpected protected-close ACL diagnostic: ${error.message}`,
    );
    for (const fragment of forbiddenMessageFragments) {
      assert.equal(error.message.includes(fragment), false);
    }
    return true;
  };
}

function delegatedLinuxUid(): number {
  const serviceUid = typeof process.getuid === "function" ? process.getuid() : -1;
  return serviceUid === 65_534 ? 65_533 : 65_534;
}

function delegatingLinuxDefaultAcl(uid: number): string {
  return `d:u::rwx,d:u:${String(uid)}:r-x,d:g::---,d:m::r-x,d:o::---`;
}

function baseLinuxDefaultAcl(): string {
  return "d:u::rwx,d:g::---,d:o::---";
}

function closer(
  runtime: ConfirmatoryFixtureRuntime,
  options: Readonly<{
    now?: () => string;
    resolveKeyring?: () => AuthorityReceiptResolvedKeyring;
  }> = {},
) {
  return createLiteLearningExperimentCloser({
    database: runtime.database,
    writeStore: runtime.writeStore,
    dependencies: {
      now: options.now ?? (() => CLOSE_NOW),
      resolveKeyring: options.resolveKeyring ?? (() => keyring()),
    },
  });
}

function openFaultableRuntime(
  databasePath: string,
  faultInjector: LiteRuntimeDatabaseFaultInjector,
): ConfirmatoryFixtureRuntime {
  return openCloseRuntime(databasePath, keyring(), faultInjector);
}

test("signed close atomically seals the attempt, releases all 768 leases, and survives restart", async () => {
  const temp = tempDatabase("success-restart");
  let fixture: ConfirmatoryProvisionedFixture;
  let memberNamespaceSha256 = "";
  try {
    const runtime = openCloseRuntime(temp.path);
    try {
      fixture = await provisionConfirmatoryFixture(runtime);
      memberNamespaceSha256 = String((runtime.database.db.prepare(
        `SELECT memory_namespace_sha256 FROM lite_learning_namespace_leases
         WHERE tenant_id = ? AND confirmatory_attempt_id = ?
         ORDER BY namespace_lease_id LIMIT 1`,
      ).get(
        fixture.attempt.tenantId,
        fixture.attempt.confirmatoryAttemptId,
      ) as { memory_namespace_sha256: string }).memory_namespace_sha256);
      const authorization = createSignedCloseAuthorization(fixture);
      const result = await closer(runtime).close(closeInput(fixture, authorization));
      assert.equal(result.replayed, false);
      assert.equal(stableStringify(result.receipt), result.receiptJson);
      assert.equal(
        result.receipt.namespace_lease_membership_sha256,
        fixture.leaseMembership.namespaceLeaseMembershipSha256,
      );
      assert.equal(result.receipt.namespace_lease_count, 768);
      assert.equal(result.receipt.closed_at, CLOSE_NOW);
      assert.equal(result.receipt.released_at, CLOSE_NOW);
      assert.equal(result.receipt.receipt_attestation_key_id, CLOSE_ATTESTATION_KEY_ID);
      assert.match(result.receipt.receipt_attestation_mac, /^[A-Za-z0-9_-]{43}$/u);

      assert.equal(count(runtime, "lite_learning_experiment_closures"), 1);
      assert.equal(count(
        runtime,
        "lite_learning_authorization_nonces",
        "authorization_kind = 'experiment_close'",
      ), 1);
      assert.equal(count(
        runtime,
        "lite_runtime_write_operations",
        "operation_kind = 'learning_experiment_close_v1'",
      ), 1);
      assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'active'"), 0);
      assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'released'"), 768);

      const releaseRows = runtime.database.db.prepare(
        `SELECT release_operation_id, release_ref_kind, release_ref_id, released_at,
                COUNT(*) AS count
         FROM lite_learning_namespace_leases
         GROUP BY release_operation_id, release_ref_kind, release_ref_id, released_at`,
      ).all() as Array<Record<string, unknown>>;
      assert.deepEqual(releaseRows.map((row) => ({ ...row })), [{
        release_operation_id: CLOSE_OPERATION_ID,
        release_ref_kind: "experiment_close",
        release_ref_id: result.receipt.experiment_close_id,
        released_at: CLOSE_NOW,
        count: 768,
      }]);
      const nonce = runtime.database.db.prepare(
        `SELECT authorization_kind, authority_ref_id, authorization_sha256
         FROM lite_learning_authorization_nonces`,
      ).get() as Record<string, unknown>;
      assert.equal(nonce.authorization_kind, "experiment_close");
      assert.equal(nonce.authority_ref_id, result.receipt.experiment_close_id);
      assert.equal(nonce.authorization_sha256, result.receipt.authorization_sha256);
      const operation = runtime.database.db.prepare(
        `SELECT request_sha256, receipt_json, commit_id
         FROM lite_runtime_write_operations
         WHERE operation_kind = 'learning_experiment_close_v1'`,
      ).get() as Record<string, unknown>;
      assert.equal(operation.request_sha256, result.receipt.request_sha256);
      assert.equal(operation.receipt_json, result.receiptJson);
      assert.equal(operation.commit_id, null);
      await closeLedger(runtime).verifyIntegrity();
    } finally {
      await runtime.close();
    }

    const reopened = openCloseRuntime(temp.path);
    try {
      const ledger = closeLedger(reopened);
      await ledger.verifyIntegrity();
      const resolution = await ledger.resolveGuideExperimentAuthority({
        tenantId: fixture.attempt.tenantId,
        experimentId: fixture.attempt.experimentId,
        experimentRevision: fixture.attempt.experimentRevision,
        taskFamily: fixture.attempt.taskFamily,
        collectionPrincipalSha256: null,
        memoryNamespaceSha256: memberNamespaceSha256,
        assignmentUnitSha256: sha256("confirmatory-close-resolver-assignment-unit"),
      });
      assert.equal(resolution.experiment_closed, true);
      assert.equal(resolution.namespace_lease, null);
      assert.equal(count(reopened, "lite_learning_namespace_leases", "status = 'released'"), 768);
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("a retained non-active authority key may verify a fresh signed close", async () => {
  const temp = tempDatabase("retained-key");
  const retainedKeyId = "confirmatory-close-retained-v1";
  const retainedSecret = Buffer.from(
    "retained-confirmatory-close-key-material-with-at-least-thirty-two-bytes",
    "utf8",
  );
  const activeKeyId = "confirmatory-close-current-v2";
  const activeSecret = Buffer.from(
    "current-confirmatory-close-key-material-with-at-least-thirty-two-bytes",
    "utf8",
  );
  const retainedAuthorityKeyring = keyring(new Map([
    [retainedKeyId, retainedSecret],
    [activeKeyId, activeSecret],
  ]), { activeKeyId });
  try {
    const runtime = openCloseRuntime(temp.path, retainedAuthorityKeyring);
    try {
      const fixture = await provisionConfirmatoryFixture(runtime);
      const authorization = createSignedCloseAuthorization(fixture, {
        authorization_key_id: retainedKeyId,
        authorization_nonce: closeNonce("retained-key"),
      }, retainedSecret);
      const result = await closer(runtime, {
        resolveKeyring: () => retainedAuthorityKeyring,
      }).close(closeInput(fixture, authorization));
      assert.equal(result.replayed, false);
      assert.equal(result.receipt.authorization_key_id, retainedKeyId);
      assert.equal(result.receipt.receipt_attestation_key_id, activeKeyId);
      assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'released'"), 768);
    } finally {
      await runtime.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("bad close authorization, key posture, expiry, tampering, and flag mismatch mutate nothing", async (t) => {
  const scenarios = [
    ["bad-key", "learning_experiment_close_authorization_invalid"],
    ["unknown-key", "learning_experiment_close_authorization_key_unknown"],
    ["short-key", "learning_experiment_close_authorization_key_weak"],
    ["ephemeral-key", "learning_experiment_close_keyring_required"],
    ["expired", "learning_experiment_close_authorization_time_invalid"],
    ["tampered", "learning_experiment_close_authorization_invalid"],
    ["flag-mismatch", "learning_experiment_close_approval_binding_mismatch"],
  ] as const;

  for (const [name, expectedCode] of scenarios) {
    await t.test(name, async () => {
      const temp = tempDatabase(`reject-${name}`);
      try {
        const runtime = openCloseRuntime(temp.path);
        try {
          const fixture = await provisionConfirmatoryFixture(runtime);
          let authorization = createSignedCloseAuthorization(fixture);
          let resolvedKeyring = keyring();
          let closeNow = CLOSE_NOW;
          let inputOverrides: Partial<LearningExperimentCloseInput> = {};

          if (name === "bad-key") {
            resolvedKeyring = keyring(new Map([
              [CLOSE_KEY_ID, Buffer.alloc(48, 0x7e)],
              [CLOSE_ATTESTATION_KEY_ID, CLOSE_ATTESTATION_KEY_SECRET],
            ]));
          } else if (name === "unknown-key") {
            resolvedKeyring = keyring(
              new Map([[CLOSE_ATTESTATION_KEY_ID, CLOSE_ATTESTATION_KEY_SECRET]]),
            );
          } else if (name === "short-key") {
            resolvedKeyring = keyring(new Map([
              [CLOSE_KEY_ID, Buffer.alloc(31, 0x42)],
              [CLOSE_ATTESTATION_KEY_ID, CLOSE_ATTESTATION_KEY_SECRET],
            ]));
          } else if (name === "ephemeral-key") {
            resolvedKeyring = keyring(new Map([
              [CLOSE_KEY_ID, CLOSE_KEY_SECRET],
              [CLOSE_ATTESTATION_KEY_ID, CLOSE_ATTESTATION_KEY_SECRET],
            ]), {
              configured: false,
              ephemeral: true,
              source: "ephemeral",
            });
          } else if (name === "expired") {
            authorization = createSignedCloseAuthorization(fixture, {
              authorization_issued_at: "2026-07-14T08:00:00.000Z",
              authorization_expires_at: "2026-07-14T08:30:00.000Z",
            });
            closeNow = CLOSE_NOW;
          } else if (name === "tampered") {
            authorization = {
              ...authorization,
              approval: {
                ...authorization.approval,
                close_reason: "safety_abort",
              },
            };
          } else if (name === "flag-mismatch") {
            inputOverrides = { operationId: "confirmatory-close-flag-mismatch" };
          }

          await assert.rejects(
            closer(runtime, {
              now: () => closeNow,
              resolveKeyring: () => resolvedKeyring,
            }).close(closeInput(fixture, authorization, inputOverrides)),
            closingCode(expectedCode),
          );
          assertNoCloseMutation(runtime);
          await closeLedger(runtime).verifyIntegrity();
        } finally {
          await runtime.close();
        }
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

test("exact restart retry replays identical bytes after expiry and key removal; changed actor conflicts", async () => {
  const temp = tempDatabase("replay-expired-key-removed");
  let fixture: ConfirmatoryProvisionedFixture;
  let authorization: LearningExperimentCloseAuthorizationEnvelopeV1;
  let receiptJson = "";
  try {
    const runtime = openCloseRuntime(temp.path);
    try {
      fixture = await provisionConfirmatoryFixture(runtime);
      authorization = createSignedCloseAuthorization(fixture);
      const fresh = await closer(runtime).close(closeInput(fixture, authorization));
      assert.equal(fresh.replayed, false);
      receiptJson = fresh.receiptJson;
    } finally {
      await runtime.close();
    }

    const replayAuthorityKeyring = keyring(
      new Map([[CLOSE_ATTESTATION_KEY_ID, CLOSE_ATTESTATION_KEY_SECRET]]),
    );
    assert.equal(replayAuthorityKeyring.keys.has(CLOSE_KEY_ID), false);
    const reopened = openCloseRuntime(temp.path, replayAuthorityKeyring);
    try {
      const replayCloser = closer(reopened, {
        now: () => "2026-07-14T11:00:00.000Z",
        resolveKeyring: () => replayAuthorityKeyring,
      });
      const replay = await replayCloser.close(closeInput(fixture, authorization));
      assert.equal(replay.replayed, true);
      assert.equal(replay.receiptJson, receiptJson);
      assert.equal(stableStringify(replay.receipt), receiptJson);
      await assert.rejects(
        replayCloser.close(closeInput(fixture, authorization, { actor: "changed-close-actor" })),
        closingCode("learning_experiment_close_operation_conflict"),
      );
      assert.equal(count(reopened, "lite_learning_experiment_closures"), 1);
      assert.equal(count(reopened, "lite_learning_authorization_nonces"), 1);
      assert.equal(count(reopened, "lite_learning_namespace_leases", "status = 'released'"), 768);
      await closeLedger(reopened, replayAuthorityKeyring).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("before_commit fault rolls nonce, closure, receipt, and every lease release back together", async () => {
  const temp = tempDatabase("before-commit-rollback");
  let failBeforeCommit = false;
  const runtime = openFaultableRuntime(temp.path, (phase) => {
    if (failBeforeCommit && phase === "before_commit") {
      throw new Error("injected-close-before-commit");
    }
  });
  try {
    const fixture = await provisionConfirmatoryFixture(runtime);
    const authorization = createSignedCloseAuthorization(fixture);
    failBeforeCommit = true;
    await assert.rejects(
      closer(runtime).close(closeInput(fixture, authorization)),
      /injected-close-before-commit/u,
    );
    failBeforeCommit = false;
    assertNoCloseMutation(runtime);
    await closeLedger(runtime).verifyIntegrity();

    const recovered = await closer(runtime).close(closeInput(fixture, authorization));
    assert.equal(recovered.replayed, false);
    assert.equal(count(runtime, "lite_learning_experiment_closures"), 1);
    assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'released'"), 768);
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

async function assertRestartIntegrityFailure(databasePath: string, pattern: RegExp): Promise<void> {
  const database = createLiteRuntimeDatabase(databasePath);
  try {
    assert.throws(
      () => createLiteWriteStoreFromDatabase(database, {
        annProjectionEnabled: false,
        authorityReceiptKeyring: keyring(),
      }),
      pattern,
    );
  } finally {
    await database.close();
  }
}

test("receipt and released-lease tampering are rejected by restart integrity", async (t) => {
  for (const tamper of ["receipt", "lease"] as const) {
    await t.test(tamper, async () => {
      const temp = tempDatabase(`tamper-${tamper}`);
      try {
        const runtime = openCloseRuntime(temp.path);
        try {
          const fixture = await provisionConfirmatoryFixture(runtime);
          const authorization = createSignedCloseAuthorization(fixture, {
            authority_operation_id: `confirmatory-close-tamper-${tamper}`,
            authorization_nonce: closeNonce(`tamper-${tamper}`),
          });
          await closer(runtime).close(closeInput(fixture, authorization));
        } finally {
          await runtime.close();
        }

        const corrupting = createLiteRuntimeDatabase(temp.path);
        try {
          if (tamper === "receipt") {
            const row = corrupting.db.prepare(
              `SELECT receipt_json FROM lite_runtime_write_operations
               WHERE operation_kind = 'learning_experiment_close_v1'`,
            ).get() as { receipt_json: string };
            const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
            receipt.namespace_lease_membership_sha256 = "f".repeat(64);
            corrupting.db.prepare(
              `UPDATE lite_runtime_write_operations SET receipt_json = ?
               WHERE operation_kind = 'learning_experiment_close_v1'`,
            ).run(stableStringify(receipt));
          } else {
            const trigger = corrupting.db.prepare(
              `SELECT sql FROM sqlite_master
               WHERE type = 'trigger' AND name = 'trg_lite_learning_namespace_lease_update'`,
            ).get() as { sql: string };
            corrupting.db.exec("DROP TRIGGER trg_lite_learning_namespace_lease_update");
            corrupting.db.prepare(
              `UPDATE lite_learning_namespace_leases
               SET released_at = '2026-07-14T10:00:01.000Z'
               WHERE status = 'released'`,
            ).run();
            corrupting.db.exec(trigger.sql);
          }
        } finally {
          await corrupting.close();
        }

        await assertRestartIntegrityFailure(
          temp.path,
          tamper === "receipt"
            ? /experiment_close_receipt_attestation_mac/u
            : /experiment_close_lease_release_binding/u,
        );
      } finally {
        fs.rmSync(temp.directory, { recursive: true, force: true });
      }
    });
  }
});

const CLOSE_PROCESS_CHILD_PATH = path.resolve(
  "scripts/ci/support/learning-experiment-close-child.ts",
);
const LEARNING_EXPERIMENT_CLI_PATH = path.resolve("scripts/learning-experiment.ts");

type CloseProcessSuccess = Readonly<{
  type: "result";
  ok: true;
  childIndex: number;
  operationId: string;
  replayed: boolean;
  receiptSha256: string;
  experimentCloseId: string;
}>;

type CloseProcessFailure = Readonly<{
  type: "result";
  ok: false;
  childIndex: number;
  operationId: string;
  code: string | null;
  message: string;
}>;

type CloseProcessResult = CloseProcessSuccess | CloseProcessFailure;

function closeProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: CLOSE_ATTESTATION_KEY_ID,
    AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: stableStringify({
      [CLOSE_KEY_ID]: CLOSE_KEY_SECRET.toString("utf8"),
      [CLOSE_ATTESTATION_KEY_ID]: CLOSE_ATTESTATION_KEY_SECRET.toString("utf8"),
    }),
    NODE_NO_WARNINGS: "1",
  };
  delete env.AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET;
  return env;
}

function installCloseProcessEnvironment(): () => void {
  const keys = [
    "AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID",
    "AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON",
    "AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET",
  ] as const;
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  const env = closeProcessEnvironment();
  for (const key of keys) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of keys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function liveCloseAuthorizationTimes(): Readonly<{
  issuedAt: string;
  expiresAt: string;
}> {
  const now = Date.now();
  return {
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
  };
}

function writePrivateCloseAuthorization(
  directory: string,
  name: string,
  authorization: LearningExperimentCloseAuthorizationEnvelopeV1,
): string {
  const approvalPath = path.join(directory, `${name}.json`);
  fs.writeFileSync(approvalPath, stableStringify(authorization), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    fs.chmodSync(approvalPath, 0o600);
    assert.equal(fs.statSync(approvalPath).mode & 0o777, 0o600);
  }
  return approvalPath;
}

async function startCloseProcess(args: Readonly<{
  databasePath: string;
  approvalPath: string;
  actor: string;
  childIndex: number;
}>): Promise<Readonly<{
  child: import("node:child_process").ChildProcess;
  ready: Promise<void>;
  result: Promise<CloseProcessResult>;
  exited: Promise<number | null>;
  stderr(): string;
}>> {
  const { fork } = await import("node:child_process");
  const child = fork(CLOSE_PROCESS_CHILD_PATH, [
    args.databasePath,
    args.approvalPath,
    args.actor,
    String(args.childIndex),
  ], {
    cwd: process.cwd(),
    env: closeProcessEnvironment(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let readySettled = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: CloseProcessResult) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<CloseProcessResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "ready"
      && record.childIndex === args.childIndex
      && !readySettled) {
      readySettled = true;
      resolveReady();
      return;
    }
    if (record.type === "result" && !resultSettled) {
      resultSettled = true;
      resolveResult(message as CloseProcessResult);
    }
  });
  child.on("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(
          `close process ${String(args.childIndex)} exited before ready: ${stderr}`,
        ));
      }
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(new Error(
          `close process ${String(args.childIndex)} exited before result: ${stderr}`,
        ));
      }
      resolve(code);
    });
  });
  return { child, ready, result, exited, stderr: () => stderr };
}

function assertSingleCloseMutation(
  runtime: ConfirmatoryFixtureRuntime,
  operationId: string,
  experimentCloseId: string,
): void {
  assert.equal(count(runtime, "lite_learning_experiment_closures"), 1);
  assert.equal(count(
    runtime,
    "lite_learning_authorization_nonces",
    "authorization_kind = 'experiment_close'",
  ), 1);
  assert.equal(count(
    runtime,
    "lite_runtime_write_operations",
    "operation_kind = 'learning_experiment_close_v1'",
  ), 1);
  assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'active'"), 0);
  assert.equal(count(runtime, "lite_learning_namespace_leases", "status = 'released'"), 768);
  const closure = runtime.database.db.prepare(
    `SELECT experiment_close_id, authority_operation_id
     FROM lite_learning_experiment_closures`,
  ).get() as { experiment_close_id: string; authority_operation_id: string };
  assert.deepEqual({ ...closure }, {
    experiment_close_id: experimentCloseId,
    authority_operation_id: operationId,
  });
  const releases = runtime.database.db.prepare(
    `SELECT release_operation_id, release_ref_kind, release_ref_id, COUNT(*) AS count
     FROM lite_learning_namespace_leases
     GROUP BY release_operation_id, release_ref_kind, release_ref_id`,
  ).all() as Array<Record<string, unknown>>;
  assert.deepEqual(releases.map((row) => ({ ...row })), [{
    release_operation_id: operationId,
    release_ref_kind: "experiment_close",
    release_ref_id: experimentCloseId,
    count: 768,
  }]);
}

test("two real close processes serialize one fresh mutation and one byte-identical replay", {
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("same-operation-process-race");
  let left: Awaited<ReturnType<typeof startCloseProcess>> | null = null;
  let right: Awaited<ReturnType<typeof startCloseProcess>> | null = null;
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-same-operation-process-race";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const approvalPath = writePrivateCloseAuthorization(
      temp.directory,
      "same-operation-approval",
      authorization,
    );
    [left, right] = await Promise.all([0, 1].map(async (childIndex) => await startCloseProcess({
      databasePath: temp.path,
      approvalPath,
      actor: CLOSE_ACTOR,
      childIndex,
    })));
    await Promise.all([left.ready, right.ready]);
    left.child.send({ type: "go" });
    right.child.send({ type: "go" });
    const results = await Promise.all([left.result, right.result]);
    const exitCodes = await Promise.all([left.exited, right.exited]);
    assert.deepEqual(exitCodes, [0, 0], `child stderr: ${left.stderr()} ${right.stderr()}`);
    for (const result of results) {
      assert.equal(result.ok, true, result.ok ? undefined : result.message);
    }
    const successes = results as CloseProcessSuccess[];
    assert.deepEqual(successes.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(successes[0]!.receiptSha256, successes[1]!.receiptSha256);
    assert.equal(successes[0]!.experimentCloseId, successes[1]!.experimentCloseId);

    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const reopened = openCloseRuntime(temp.path);
      try {
        assertSingleCloseMutation(reopened, operationId, successes[0]!.experimentCloseId);
        await closeLedger(reopened).verifyIntegrity();
      } finally {
        await reopened.close();
      }
    } finally {
      restoreEnvironment();
    }
  } finally {
    if (left && left.child.exitCode === null) left.child.kill();
    if (right && right.child.exitCode === null) right.child.kill();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("different signed close operations racing for one attempt admit exactly one winner", {
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("different-operation-process-race");
  let left: Awaited<ReturnType<typeof startCloseProcess>> | null = null;
  let right: Awaited<ReturnType<typeof startCloseProcess>> | null = null;
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const times = liveCloseAuthorizationTimes();
    const operations = [
      "confirmatory-close-competing-operation-a",
      "confirmatory-close-competing-operation-b",
    ] as const;
    const approvalPaths = operations.map((operationId, index) => {
      const authorization = createSignedCloseAuthorization(fixture, {
        authority_operation_id: operationId,
        authorization_nonce: closeNonce(operationId),
        authorization_issued_at: times.issuedAt,
        authorization_expires_at: times.expiresAt,
      });
      return writePrivateCloseAuthorization(
        temp.directory,
        `competing-operation-${String(index)}`,
        authorization,
      );
    });
    [left, right] = await Promise.all(approvalPaths.map(
      async (approvalPath, childIndex) => await startCloseProcess({
        databasePath: temp.path,
        approvalPath,
        actor: CLOSE_ACTOR,
        childIndex,
      }),
    ));
    await Promise.all([left.ready, right.ready]);
    left.child.send({ type: "go" });
    right.child.send({ type: "go" });
    const results = await Promise.all([left.result, right.result]);
    const exitCodes = await Promise.all([left.exited, right.exited]);
    assert.deepEqual(exitCodes, [0, 0], `child stderr: ${left.stderr()} ${right.stderr()}`);
    const successes = results.filter((result): result is CloseProcessSuccess => result.ok);
    const failures = results.filter((result): result is CloseProcessFailure => !result.ok);
    assert.equal(successes.length, 1, stableStringify(results));
    assert.equal(failures.length, 1, stableStringify(results));
    assert.equal(successes[0]!.replayed, false);
    assert.equal(failures[0]!.code, "learning_experiment_close_authority_conflict");
    assert.notEqual(successes[0]!.operationId, failures[0]!.operationId);

    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const reopened = openCloseRuntime(temp.path);
      try {
        assertSingleCloseMutation(
          reopened,
          successes[0]!.operationId,
          successes[0]!.experimentCloseId,
        );
        await closeLedger(reopened).verifyIntegrity();
      } finally {
        await reopened.close();
      }
    } finally {
      restoreEnvironment();
    }
  } finally {
    if (left && left.child.exitCode === null) left.child.kill();
    if (right && right.child.exitCode === null) right.child.kill();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("close CLI uses a real environment keyring and a private 0600 approval file", {
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("cli-real-keyring");
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-cli-real-keyring";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const approvalPath = writePrivateCloseAuthorization(
      temp.directory,
      "cli-close-approval",
      authorization,
    );
    const args = [
      "--import",
      "tsx",
      LEARNING_EXPERIMENT_CLI_PATH,
      "close",
      "--db",
      temp.path,
      "--tenant",
      fixture.attempt.tenantId,
      "--actor",
      CLOSE_ACTOR,
      "--operation-id",
      operationId,
      "--approval",
      approvalPath,
      "--experiment-id",
      fixture.attempt.experimentId,
      "--revision",
      String(fixture.attempt.experimentRevision),
    ];
    const { spawnSync } = await import("node:child_process");
    if (process.platform !== "win32") {
      fs.chmodSync(approvalPath, 0o644);
      const looseApproval = spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        env: closeProcessEnvironment(),
        timeout: 60_000,
      });
      assert.equal(looseApproval.error, undefined);
      assert.equal(looseApproval.status, 1);
      assert.equal(looseApproval.stdout, "");
      const rejection = JSON.parse(looseApproval.stderr.trim()) as Record<string, unknown>;
      assert.equal(rejection.code, "learning_experiment_cli_close_approval_invalid");
      const unchanged = openCloseRuntime(temp.path);
      try {
        assertNoCloseMutation(unchanged);
      } finally {
        await unchanged.close();
      }
      fs.chmodSync(approvalPath, 0o600);
    }
    const first = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: closeProcessEnvironment(),
      timeout: 60_000,
    });
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.signal, null);
    assert.equal(first.stderr, "");
    const receiptJson = first.stdout.trim();
    const receipt = JSON.parse(receiptJson) as Record<string, unknown>;
    assert.equal(stableStringify(receipt), receiptJson);
    assert.equal(receipt.operation_id, operationId);
    assert.equal(receipt.status, "closed");
    assert.equal(receipt.namespace_lease_count, 768);
    assert.equal(receipt.receipt_attestation_key_id, CLOSE_ATTESTATION_KEY_ID);

    const replay = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: closeProcessEnvironment(),
      timeout: 60_000,
    });
    assert.equal(replay.error, undefined);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(replay.stderr, "");
    assert.equal(replay.stdout.trim(), receiptJson);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(approvalPath).mode & 0o777, 0o600);
    }

    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const reopened = openCloseRuntime(temp.path);
      try {
        assertSingleCloseMutation(
          reopened,
          operationId,
          String(receipt.experiment_close_id),
        );
        await closeLedger(reopened).verifyIntegrity();
      } finally {
        await reopened.close();
      }
    } finally {
      restoreEnvironment();
    }
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("cross-database signed approval rejection preserves target bytes and creates no sidecars", {
  timeout: 60_000,
}, async () => {
  const source = tempDatabase("cross-database-source");
  const target = tempDatabase("cross-database-target");
  try {
    const sourceSetup = openCloseRuntime(source.path);
    let sourceFixture: ConfirmatoryProvisionedFixture;
    try {
      sourceFixture = await provisionConfirmatoryFixture(sourceSetup);
    } finally {
      await sourceSetup.close();
    }
    const targetSetup = openCloseRuntime(target.path);
    try {
      await provisionConfirmatoryFixture(targetSetup);
    } finally {
      await targetSetup.close();
    }

    for (const suffix of ["-wal", "-shm"] as const) {
      assert.equal(fs.existsSync(`${target.path}${suffix}`), false);
    }
    const targetBytesBefore = fs.readFileSync(target.path);
    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-cross-database-rejected";
    const authorization = createSignedCloseAuthorization(sourceFixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });

    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      await assert.rejects(
        closeLiteLearningExperiment({
          path: target.path,
          ...closeInput(sourceFixture, authorization),
        }),
        closingCode("learning_experiment_close_authority_drift"),
      );
    } finally {
      restoreEnvironment();
    }

    assert.deepEqual(fs.readFileSync(target.path), targetBytesBefore);
    for (const suffix of ["-wal", "-shm"] as const) {
      assert.equal(fs.existsSync(`${target.path}${suffix}`), false);
    }
    const reopened = openCloseRuntime(target.path);
    try {
      assertNoCloseMutation(reopened);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(source.directory, { recursive: true, force: true });
    fs.rmSync(target.directory, { recursive: true, force: true });
  }
});

test("writable ancestor directory fails protected close without any close mutation", {
  skip: process.platform === "win32",
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("writable-ancestor");
  const writableAncestor = path.join(temp.directory, "replaceable-ancestor");
  const directParent = path.join(writableAncestor, "runtime-owner-only");
  const databasePath = path.join(directParent, "runtime.sqlite");
  fs.mkdirSync(directParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(writableAncestor, 0o700);
  fs.chmodSync(directParent, 0o700);
  try {
    const setup = openCloseRuntime(databasePath);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const databaseBytesBefore = fs.readFileSync(databasePath);
    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-writable-ancestor-rejected";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });

    fs.chmodSync(writableAncestor, 0o777);
    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      await assert.rejects(
        closeLiteLearningExperiment({
          path: databasePath,
          ...closeInput(fixture, authorization),
        }),
        closingCode("learning_experiment_close_database_filesystem_untrusted"),
      );
    } finally {
      restoreEnvironment();
      fs.chmodSync(writableAncestor, 0o700);
    }

    assert.deepEqual(fs.readFileSync(databasePath), databaseBytesBefore);
    const reopened = openCloseRuntime(databasePath);
    try {
      assertNoCloseMutation(reopened);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    if (fs.existsSync(writableAncestor)) fs.chmodSync(writableAncestor, 0o700);
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("world-writable SQLite sidecar fails protected close without touching the database", {
  skip: process.platform === "win32",
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("world-writable-sidecar");
  const walPath = `${temp.path}-wal`;
  const sharedMemoryPath = `${temp.path}-shm`;
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const databaseBytesBefore = fs.readFileSync(temp.path);
    const walBytes = Buffer.from("untrusted-wal-sidecar", "utf8");
    const sharedMemoryBytes = Buffer.from("untrusted-shm-sidecar", "utf8");
    fs.writeFileSync(walPath, walBytes, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(sharedMemoryPath, sharedMemoryBytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(walPath, 0o666);

    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-world-writable-sidecar-rejected";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      await assert.rejects(
        closeLiteLearningExperiment({
          path: temp.path,
          ...closeInput(fixture, authorization),
        }),
        closingCode("learning_experiment_close_database_filesystem_untrusted"),
      );
    } finally {
      restoreEnvironment();
    }

    assert.deepEqual(fs.readFileSync(temp.path), databaseBytesBefore);
    assert.deepEqual(fs.readFileSync(walPath), walBytes);
    assert.deepEqual(fs.readFileSync(sharedMemoryPath), sharedMemoryBytes);
    fs.rmSync(walPath, { force: true });
    fs.rmSync(sharedMemoryPath, { force: true });
    const reopened = openCloseRuntime(temp.path);
    try {
      assertNoCloseMutation(reopened);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(walPath, { force: true });
    fs.rmSync(sharedMemoryPath, { force: true });
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("macOS write ACL fails protected close without any close mutation", {
  skip: process.platform !== "darwin",
  timeout: 60_000,
}, async (t) => {
  const temp = tempDatabase("database-write-acl");
  const { spawnSync } = await import("node:child_process");
  let aclInstalled = false;
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const databaseBytesBefore = fs.readFileSync(temp.path);
    const addAcl = spawnSync(
      "/bin/chmod",
      ["+a", "everyone allow write", temp.path],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (addAcl.error || addAcl.status !== 0) {
      t.skip(`macOS ACL setup unavailable: ${addAcl.error?.message ?? addAcl.stderr}`);
      return;
    }
    aclInstalled = true;

    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-database-acl-rejected";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      await assert.rejects(
        closeLiteLearningExperiment({
          path: temp.path,
          ...closeInput(fixture, authorization),
        }),
        closingCode("learning_experiment_close_database_filesystem_untrusted"),
      );
    } finally {
      restoreEnvironment();
    }

    assert.deepEqual(fs.readFileSync(temp.path), databaseBytesBefore);
    const removeAcl = spawnSync("/bin/chmod", ["-N", temp.path], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(removeAcl.error, undefined);
    assert.equal(removeAcl.status, 0, removeAcl.stderr);
    aclInstalled = false;
    const reopened = openCloseRuntime(temp.path);
    try {
      assertNoCloseMutation(reopened);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    if (aclInstalled && fs.existsSync(temp.path)) {
      spawnSync("/bin/chmod", ["-N", temp.path], { timeout: 5_000 });
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("Linux default ACL on a non-direct ancestor does not block protected close", {
  skip: process.platform !== "linux",
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("ancestor-default-acl");
  const aclAncestor = path.join(temp.directory, "acl-ancestor");
  const directParent = path.join(aclAncestor, "runtime-owner-only");
  const databasePath = path.join(directParent, "runtime.sqlite");
  const { spawnSync } = await import("node:child_process");
  let accessAclInstalled = false;
  let defaultAclInstalled = false;
  fs.mkdirSync(directParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(aclAncestor, 0o700);
  fs.chmodSync(directParent, 0o700);
  try {
    const setup = openCloseRuntime(databasePath);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const databaseBytesBefore = fs.readFileSync(databasePath);
    const delegatedUid = delegatedLinuxUid();
    const addAccessAcl = spawnSync(
      "/usr/bin/setfacl",
      ["-m", `u:${String(delegatedUid)}:---`, aclAncestor],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(
      addAccessAcl.error,
      undefined,
      "Linux protected-close tests require the acl package",
    );
    assert.equal(addAccessAcl.status, 0, addAccessAcl.stderr);
    accessAclInstalled = true;
    const rejectedTimes = liveCloseAuthorizationTimes();
    const rejectedOperationId = "confirmatory-close-ancestor-access-acl-rejected";
    const rejectedAuthorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: rejectedOperationId,
      authorization_nonce: closeNonce(rejectedOperationId),
      authorization_issued_at: rejectedTimes.issuedAt,
      authorization_expires_at: rejectedTimes.expiresAt,
    });
    const restoreRejectedEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      await assert.rejects(
        closeLiteLearningExperiment({
          path: databasePath,
          ...closeInput(fixture, rejectedAuthorization),
        }),
        closingFilesystemDiagnostic("ancestor", "named_user", [
          aclAncestor,
          String(delegatedUid),
          "---",
        ]),
      );
    } finally {
      restoreRejectedEnvironment();
    }
    assert.deepEqual(fs.readFileSync(databasePath), databaseBytesBefore);
    const removeAccessAcl = spawnSync("/usr/bin/setfacl", ["-b", aclAncestor], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(removeAccessAcl.error, undefined);
    assert.equal(removeAccessAcl.status, 0, removeAccessAcl.stderr);
    accessAclInstalled = false;
    const rejectedReopened = openCloseRuntime(databasePath);
    try {
      assertNoCloseMutation(rejectedReopened);
      await closeLedger(rejectedReopened).verifyIntegrity();
    } finally {
      await rejectedReopened.close();
    }

    const addAcl = spawnSync(
      "/usr/bin/setfacl",
      ["-m", delegatingLinuxDefaultAcl(delegatedUid), aclAncestor],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(addAcl.error, undefined, "Linux protected-close tests require the acl package");
    assert.equal(addAcl.status, 0, addAcl.stderr);
    defaultAclInstalled = true;
    assert.equal(fs.statSync(aclAncestor).mode & 0o022, 0);

    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-ancestor-default-acl-accepted";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      const result = await closeLiteLearningExperiment({
        path: databasePath,
        ...closeInput(fixture, authorization),
      });
      assert.equal(result.replayed, false);
      assert.equal(result.receipt.status, "closed");
    } finally {
      restoreEnvironment();
    }

    const reopened = openCloseRuntime(databasePath);
    try {
      assert.equal(count(reopened, "lite_learning_experiment_closures"), 1);
      assert.equal(count(reopened, "lite_learning_namespace_leases", "status = 'released'"), 768);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    if (accessAclInstalled && fs.existsSync(aclAncestor)) {
      spawnSync("/usr/bin/setfacl", ["-b", aclAncestor], { timeout: 5_000 });
    }
    if (defaultAclInstalled && fs.existsSync(aclAncestor)) {
      spawnSync("/usr/bin/setfacl", ["-k", aclAncestor], { timeout: 5_000 });
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("Linux base and extended default ACLs on the database parent remain rejected", {
  skip: process.platform !== "linux",
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("direct-parent-default-acl");
  const { spawnSync } = await import("node:child_process");
  let defaultAclInstalled = false;
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const databaseBytesBefore = fs.readFileSync(temp.path);
    const delegatedUid = delegatedLinuxUid();
    for (const [label, acl] of [
      ["base", baseLinuxDefaultAcl()],
      ["extended", delegatingLinuxDefaultAcl(delegatedUid)],
    ] as const) {
      const addAcl = spawnSync(
        "/usr/bin/setfacl",
        ["-m", acl, temp.directory],
        { encoding: "utf8", timeout: 5_000 },
      );
      assert.equal(
        addAcl.error,
        undefined,
        "Linux protected-close tests require the acl package",
      );
      assert.equal(addAcl.status, 0, addAcl.stderr);
      defaultAclInstalled = true;
      assert.equal(fs.statSync(temp.directory).mode & 0o022, 0);

      const times = liveCloseAuthorizationTimes();
      const operationId = `confirmatory-close-direct-parent-${label}-default-rejected`;
      const authorization = createSignedCloseAuthorization(fixture, {
        authority_operation_id: operationId,
        authorization_nonce: closeNonce(operationId),
        authorization_issued_at: times.issuedAt,
        authorization_expires_at: times.expiresAt,
      });
      const restoreEnvironment = installCloseProcessEnvironment();
      try {
        const { closeLiteLearningExperiment } = await import(
          "../../tools/learning-experiments/lite-learning-experiment-closing.js"
        );
        await assert.rejects(
          closeLiteLearningExperiment({
            path: temp.path,
            ...closeInput(fixture, authorization),
          }),
          closingFilesystemDiagnostic("direct_parent", "default", [
            temp.directory,
            String(delegatedUid),
            "r-x",
          ]),
        );
      } finally {
        restoreEnvironment();
      }

      assert.deepEqual(fs.readFileSync(temp.path), databaseBytesBefore);
      const removeAcl = spawnSync("/usr/bin/setfacl", ["-k", temp.directory], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(removeAcl.error, undefined);
      assert.equal(removeAcl.status, 0, removeAcl.stderr);
      defaultAclInstalled = false;
    }

    const reopened = openCloseRuntime(temp.path);
    try {
      assertNoCloseMutation(reopened);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    if (defaultAclInstalled && fs.existsSync(temp.directory)) {
      spawnSync("/usr/bin/setfacl", ["-k", temp.directory], { timeout: 5_000 });
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("Linux extended ACL fails protected close even when mode has no write bit", {
  skip: process.platform !== "linux",
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("database-linux-acl");
  const { spawnSync } = await import("node:child_process");
  let aclInstalled = false;
  try {
    const setup = openCloseRuntime(temp.path);
    let fixture: ConfirmatoryProvisionedFixture;
    try {
      fixture = await provisionConfirmatoryFixture(setup);
    } finally {
      await setup.close();
    }
    const databaseBytesBefore = fs.readFileSync(temp.path);
    const delegatedUid = delegatedLinuxUid();
    const addAcl = spawnSync(
      "/usr/bin/setfacl",
      ["-m", `u:${String(delegatedUid)}:r--`, temp.path],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(addAcl.error, undefined, "Linux protected-close tests require the acl package");
    assert.equal(addAcl.status, 0, addAcl.stderr);
    aclInstalled = true;
    assert.equal(fs.statSync(temp.path).mode & 0o022, 0);

    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-database-linux-acl-rejected";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      await assert.rejects(
        closeLiteLearningExperiment({
          path: temp.path,
          ...closeInput(fixture, authorization),
        }),
        closingFilesystemDiagnostic("database", "named_user", [
          temp.path,
          String(delegatedUid),
          "r--",
        ]),
      );
    } finally {
      restoreEnvironment();
    }

    assert.deepEqual(fs.readFileSync(temp.path), databaseBytesBefore);
    const removeAcl = spawnSync("/usr/bin/setfacl", ["-b", temp.path], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(removeAcl.error, undefined);
    assert.equal(removeAcl.status, 0, removeAcl.stderr);
    aclInstalled = false;
    const reopened = openCloseRuntime(temp.path);
    try {
      assertNoCloseMutation(reopened);
      await closeLedger(reopened).verifyIntegrity();
    } finally {
      await reopened.close();
    }
  } finally {
    if (aclInstalled && fs.existsSync(temp.path)) {
      spawnSync("/usr/bin/setfacl", ["-b", temp.path], { timeout: 5_000 });
    }
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("protected close and exact replay read a live Runtime WAL without checkpointing first", {
  timeout: 60_000,
}, async () => {
  const temp = tempDatabase("live-wal-fresh-replay");
  const runtime = openCloseRuntime(temp.path);
  try {
    const fixture = await provisionConfirmatoryFixture(runtime);
    const walPath = `${temp.path}-wal`;
    const sharedMemoryPath = `${temp.path}-shm`;
    assert.equal(fs.existsSync(walPath), true);
    assert.equal(fs.existsSync(sharedMemoryPath), true);
    assert.ok(fs.statSync(walPath).size > 0);
    assert.ok(fs.statSync(sharedMemoryPath).size > 0);

    const times = liveCloseAuthorizationTimes();
    const operationId = "confirmatory-close-live-wal-fresh-replay";
    const authorization = createSignedCloseAuthorization(fixture, {
      authority_operation_id: operationId,
      authorization_nonce: closeNonce(operationId),
      authorization_issued_at: times.issuedAt,
      authorization_expires_at: times.expiresAt,
    });
    const restoreEnvironment = installCloseProcessEnvironment();
    try {
      const { closeLiteLearningExperiment } = await import(
        "../../tools/learning-experiments/lite-learning-experiment-closing.js"
      );
      const input = {
        path: temp.path,
        ...closeInput(fixture, authorization),
      };
      const fresh = await closeLiteLearningExperiment(input);
      const replayKeyringJson = stableStringify({
        [CLOSE_ATTESTATION_KEY_ID]: CLOSE_ATTESTATION_KEY_SECRET.toString("utf8"),
      });
      process.env.AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON = replayKeyringJson;
      const replay = await closeLiteLearningExperiment(input);
      assert.equal(fresh.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.receiptJson, fresh.receiptJson);
      assert.equal(Object.hasOwn(JSON.parse(replayKeyringJson), CLOSE_KEY_ID), false);
      assertSingleCloseMutation(runtime, operationId, fresh.receipt.experiment_close_id);
      await closeLedger(runtime).verifyIntegrity();
    } finally {
      restoreEnvironment();
    }
  } finally {
    await runtime.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
