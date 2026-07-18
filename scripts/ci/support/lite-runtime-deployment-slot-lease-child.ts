import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import stableStringify from "fast-json-stable-stringify";

import {
  acquireLiteRuntimeDeploymentSlotExclusiveLease,
  commitLiteRuntimeDeploymentSlotBindingCompletion,
  inspectLiteRuntimeDeploymentSlotCheckpointGeneration,
  prepareLiteRuntimeDeploymentSlotBindingCompletion,
  releaseLiteRuntimeDeploymentSlotExclusiveLease,
  reserveLiteRuntimeDeploymentSlotCheckpointGeneration,
} from "../../../src/store/lite-runtime-deployment-slot-authority.js";

type ChildMode =
  | "commit_and_hold"
  | "hold_carrier_transaction"
  | "hold_lease"
  | "hold_state_transaction"
  | "reserve_and_hold";

function requiredArg(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function send(message: Readonly<Record<string, unknown>>): void {
  if (typeof process.send !== "function") throw new Error("ipc_channel_required");
  process.send(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForParentRelease(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("message", (message: unknown) => {
      if (message
        && typeof message === "object"
        && "type" in message
        && message.type === "release") {
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  const authorityStatePath = requiredArg(2, "authority_state_path");
  const deploymentSlot = requiredArg(3, "deployment_slot");
  const mode = requiredArg(4, "mode") as ChildMode;
  const operationId = process.argv[5];
  if (mode !== "hold_lease"
    && mode !== "hold_carrier_transaction"
    && mode !== "hold_state_transaction"
    && mode !== "reserve_and_hold"
    && mode !== "commit_and_hold") {
    throw new Error("invalid_child_mode");
  }

  if (mode === "hold_carrier_transaction") {
    const carrierPath = `${authorityStatePath}.lease`;
    const database = new DatabaseSync(carrierPath);
    try {
      const journalMode = database.prepare("PRAGMA journal_mode").get() as
        { journal_mode?: unknown } | undefined;
      if (journalMode?.journal_mode !== "wal") {
        throw new Error("carrier_transaction_requires_wal");
      }
      database.exec(`
        PRAGMA synchronous = EXTRA;
        PRAGMA fullfsync = ON;
        PRAGMA checkpoint_fullfsync = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA busy_timeout = 0;
        PRAGMA cache_size = 1;
        PRAGMA cache_spill = ON;
        BEGIN IMMEDIATE;
      `);
      const identity = database.prepare(
        `SELECT state_database_device, state_database_inode, registration_sha256
         FROM lite_runtime_deployment_slot_lease_identity
         WHERE singleton = 1`,
      ).get() as Readonly<{
        state_database_device?: unknown;
        state_database_inode?: unknown;
        registration_sha256?: unknown;
      }> | undefined;
      const latest = database.prepare(
        `SELECT witness_epoch, witness_sha256
         FROM lite_runtime_deployment_slot_state_witnesses
         ORDER BY length(witness_epoch) DESC, witness_epoch DESC
         LIMIT 1`,
      ).get() as Readonly<{
        witness_epoch?: unknown;
        witness_sha256?: unknown;
      }> | undefined;
      if (typeof identity?.state_database_device !== "string"
        || typeof identity.state_database_inode !== "string"
        || typeof identity.registration_sha256 !== "string"
        || latest?.witness_epoch !== "1"
        || typeof latest.witness_sha256 !== "string") {
        throw new Error("carrier_transaction_requires_initial_witness");
      }
      const insertWitness = database.prepare(
        `INSERT INTO lite_runtime_deployment_slot_state_witnesses
           (witness_epoch, previous_witness_sha256, state_database_device,
            state_database_inode, registration_sha256, last_lease_epoch,
            last_checkpoint_generation, last_reservation_id,
            current_binding_receipt_sha256, state_semantic_sha256,
            witnessed_at, witness_sha256)
         VALUES (?, ?, ?, ?, ?, '0', '0', NULL, NULL, ?, ?, ?)`,
      );
      let previousWitnessSha256 = latest.witness_sha256;
      for (let epoch = 2; epoch <= 513; epoch += 1) {
        const projection = {
          witness_epoch: String(epoch),
          previous_witness_sha256: previousWitnessSha256,
          state_database_device: identity.state_database_device,
          state_database_inode: identity.state_database_inode,
          registration_sha256: identity.registration_sha256,
          last_lease_epoch: "0",
          last_checkpoint_generation: "0",
          last_reservation_id: null,
          current_binding_receipt_sha256: null,
          state_semantic_sha256: sha256(`carrier-phantom-semantic:${epoch}`),
          witnessed_at: "2026-07-17T08:00:00.000Z",
        };
        const witnessSha256 = sha256(stableStringify(projection));
        insertWitness.run(
          projection.witness_epoch,
          projection.previous_witness_sha256,
          projection.state_database_device,
          projection.state_database_inode,
          projection.registration_sha256,
          projection.state_semantic_sha256,
          projection.witnessed_at,
          witnessSha256,
        );
        previousWitnessSha256 = witnessSha256;
      }
      const walByteLength = statSync(`${carrierPath}-wal`).size;
      send({ type: "carrier_transaction_held", walByteLength });
      await waitForParentRelease();
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
    return;
  }

  if (mode === "hold_state_transaction") {
    const database = new DatabaseSync(authorityStatePath);
    try {
      const journalMode = database.prepare("PRAGMA journal_mode").get() as
        { journal_mode?: unknown } | undefined;
      if (journalMode?.journal_mode !== "wal") {
        throw new Error("state_transaction_requires_wal");
      }
      database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = EXTRA;
        PRAGMA fullfsync = ON;
        PRAGMA checkpoint_fullfsync = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA busy_timeout = 0;
        PRAGMA cache_size = 1;
        PRAGMA cache_spill = ON;
        BEGIN IMMEDIATE;
      `);
      const insertLeaseEpoch = database.prepare(
        `INSERT INTO lite_runtime_deployment_slot_lease_epochs
           (lease_epoch, lease_holder_token_sha256, acquired_at)
         VALUES (?, ?, ?)`,
      );
      for (let epoch = 1; epoch <= 512; epoch += 1) {
        insertLeaseEpoch.run(
          String(epoch),
          epoch.toString(16).padStart(64, "0"),
          "2026-07-17T04:15:00.000Z",
        );
      }
      const walByteLength = statSync(`${authorityStatePath}-wal`).size;
      send({ type: "state_transaction_held", walByteLength });
      await waitForParentRelease();
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
    return;
  }

  const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
    authorityStatePath,
    deploymentSlot,
    now: new Date("2026-07-17T08:00:00.000Z"),
  });
  send({ type: "lease_held" });

  if (mode === "reserve_and_hold" || mode === "commit_and_hold") {
    if (!operationId) throw new Error("missing_operation_id");
    const operationRequestSha256 = requiredArg(6, "operation_request_sha256");
    const reservation = await reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
      lease,
      operationId,
      operationRequestSha256,
      now: new Date("2026-07-17T08:00:00.000Z"),
    });
    if (reservation.kind !== "reserved") {
      throw new Error("child_expected_fresh_generation_reservation");
    }
    const inspection = inspectLiteRuntimeDeploymentSlotCheckpointGeneration(
      reservation.reservation,
    );
    send({
      type: "generation_reserved",
      operationId: inspection.operation_id,
      checkpointGeneration: inspection.checkpoint_generation,
    });
    if (mode === "commit_and_hold") {
      const configPath = requiredArg(7, "completion_config_path");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Readonly<{
        envelope: unknown;
        externalExecutionPolicy: unknown;
        registeredExternalExecutionPolicySha256: string;
      }>;
      const preparedCompletion =
        await prepareLiteRuntimeDeploymentSlotBindingCompletion({
          lease,
          reservation: reservation.reservation,
          envelope: config.envelope,
          externalExecutionPolicy: config.externalExecutionPolicy,
          registeredExternalExecutionPolicySha256:
            config.registeredExternalExecutionPolicySha256,
        });
      const completion = await commitLiteRuntimeDeploymentSlotBindingCompletion({
        lease,
        reservation: reservation.reservation,
        preparedCompletion,
        now: new Date("2026-07-17T08:00:00.000Z"),
      });
      send({
        type: "completion_committed",
        checkpointGeneration: completion.checkpoint_generation,
        receiptSha256: completion.database_binding_receipt_sha256,
        receiptJson: completion.database_binding_receipt_json,
      });
    }
  }

  await waitForParentRelease();
  await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease, {
    now: new Date("2026-07-17T08:00:00.000Z"),
  });
  send({ type: "released" });
}

void main().catch((error: unknown) => {
  const record = error && typeof error === "object"
    ? error as Readonly<{ code?: unknown; message?: unknown }>
    : null;
  try {
    send({
      type: "error",
      code: typeof record?.code === "string" ? record.code : null,
      message: typeof record?.message === "string" ? record.message : String(error),
    });
  } finally {
    process.exitCode = 1;
  }
});
