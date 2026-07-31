import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  createRuntimeEpisodeVerifierInvocationAuthorityChannel,
} from "../../../src/execution/runtime-episode-verifier-launch-authority.js";
import {
  createRuntimeEpisodeVerifierRegistry,
} from "../../../src/execution/runtime-episode-verifier-registry.js";
import {
  createLiteExecutionStateStoreFromDatabase,
} from "../../../src/execution/state-store.js";
import {
  createExecutionEpisodeService,
} from "../../../src/product/execution-episode-service.js";
import {
  createLiteEvidenceArtifactStore,
} from "../../../src/store/lite-evidence-artifact-store.js";
import {
  createLiteExecutionEpisodeStore,
} from "../../../src/store/lite-execution-episode-store.js";
import {
  createLiteRuntimeDatabase,
} from "../../../src/store/lite-runtime-database.js";
import {
  createLiteWriteStoreFromDatabase,
} from "../../../src/store/lite-write-store.js";

const TENANT_ID = "tenant-sigkill-verifier";
const STORE_SCOPE =
  "tenant:tenant-sigkill-verifier:project:real-recovery";
const PUBLIC_SCOPE = "project:real-recovery";
const VERIFIER_ID = "real-sigkill-verifier";
const EXPECTED_ANSWER = "verified after real execution\n";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function output(value: unknown): void {
  process.stdout.write(`${stableStringify(value)}\n`);
}

async function main(): Promise<void> {
  const mode = requiredEnvironment("AIONIS_SIGKILL_CHILD_MODE");
  const databasePath = requiredEnvironment("AIONIS_SIGKILL_DATABASE_PATH");
  const subjectRoot = requiredEnvironment("AIONIS_SIGKILL_SUBJECT_ROOT");
  const verifierPath = requiredEnvironment("AIONIS_SIGKILL_VERIFIER_PATH");
  const probePort = requiredEnvironment("AIONIS_SIGKILL_PROBE_PORT");
  const authorityChannel =
    createRuntimeEpisodeVerifierInvocationAuthorityChannel();
  const database = createLiteRuntimeDatabase(databasePath);
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
  });
  const artifactStore = createLiteEvidenceArtifactStore(database);
  const episodeStore = createLiteExecutionEpisodeStore(database, {
    verifierInvocationAuthorityIssuer: authorityChannel.issuer,
    verifierInvocationAuthorityVerifier: authorityChannel.verifier,
  });
  const stateStore = createLiteExecutionStateStoreFromDatabase(
    database.db,
    {
      path: database.path,
      readDatabase: database.readDb,
      transaction: database.transaction,
    },
  );
  const verifierRegistry = createRuntimeEpisodeVerifierRegistry([{
    verifier_id: VERIFIER_ID,
    verifier_kind: "independent_executable",
    verifier_version: "real-sigkill-verifier-v1",
    verifier_issuer_id: "aionis-runtime-sigkill-test",
    reward_role: "primary",
    verifier_material_paths: [verifierPath],
    runner_config: {
      executable: process.execPath,
      argv: [verifierPath],
      cwd: dirname(verifierPath),
      environment: {
        AIONIS_SIGKILL_PROBE_PORT: probePort,
        AIONIS_EXPECTED_ANSWER_SHA256: sha256(EXPECTED_ANSWER),
      },
      timeout_ms: 30_000,
      terminate_grace_ms: 100,
      max_stdout_bytes: 4_096,
      max_stderr_bytes: 4_096,
    },
  }], authorityChannel.verifier);
  const service = createExecutionEpisodeService({
    artifactStore,
    episodeStore,
    stateStore,
    verifierRegistry,
    runtimeInstanceId: `sigkill-runtime-${mode}-${process.pid}`,
  });

  try {
    if (mode === "run") {
      const sourceTaskBytes = Buffer.from(
        "Write the exact expected answer to answer.txt and verify it.",
        "utf8",
      );
      const started = await service.begin({
        tenantId: TENANT_ID,
        publicScope: PUBLIC_SCOPE,
        storeScope: STORE_SCOPE,
        operationId: "sigkill-begin",
        taskEnvelope: {
          contract_version: "host_task_envelope_v1",
          host_task_id: "sigkill-real-task",
          collector_id: "sigkill-real-process-harness",
          collector_version: "v1",
          task_family: "real-workspace-answer-edit",
          task_signature: "write-exact-answer-before-real-verifier",
          repository_signature: "filesystem-subject-v1",
          source_task_sha256: sha256(sourceTaskBytes),
          source_event_sha256: sha256("sigkill-source-event"),
          created_at: new Date().toISOString(),
        },
        sourceTaskBytes,
        runId: "sigkill-real-run",
        modelId: "real-host-process",
        modelConfig: {
          provider: "real-process-harness",
          model: "real-host-process",
          temperature: 0,
        },
        budget: {
          max_steps: 8,
          max_tokens: 8_000,
          max_cost_micros: 100_000,
          deadline_ms: 60_000,
        },
        workspaceRoot: subjectRoot,
        subjectStateSpec: {
          contract_version: "workspace_subject_state_spec_v2",
          additional_state_roots: [],
        },
        requiredVerifierId: VERIFIER_ID,
      });
      writeFileSync(
        `${subjectRoot}/answer.txt`,
        EXPECTED_ANSWER,
        "utf8",
      );
      const action = await service.recordAction({
        tenantId: TENANT_ID,
        storeScope: STORE_SCOPE,
        episodeId: started.episode.episode_id,
        operationId: "sigkill-action",
        workspaceRoot: subjectRoot,
        expectedCurrentStateSnapshotId:
          started.initial_state_snapshot.snapshot_id,
        actionKind: "file_write",
        toolName: "node_fs_write_file",
        requestBytes: Buffer.from(stableStringify({
          path: "answer.txt",
          expected_sha256: sha256(EXPECTED_ANSWER),
        })),
        resultBytes: Buffer.from(stableStringify({
          byte_length: Buffer.byteLength(EXPECTED_ANSWER),
          actual_sha256: sha256(readFileSync(
            `${subjectRoot}/answer.txt`,
          )),
        })),
      });
      output({
        contract_version: "sigkill_runtime_child_started_v1",
        runtime_pid: process.pid,
        episode_id: started.episode.episode_id,
      });
      await service.runVerifier({
        tenantId: TENANT_ID,
        storeScope: STORE_SCOPE,
        episodeId: started.episode.episode_id,
        operationId: "sigkill-verifier",
        workspaceRoot: subjectRoot,
        expectedCurrentStateSnapshotId:
          action.current_state_snapshot.snapshot_id,
      });
      throw new Error("sigkill_verifier_unexpectedly_returned");
    }

    if (mode === "recover") {
      const recovery =
        await service.recoverInterruptedVerifierLaunches();
      const episodeRow = database.db.prepare(
        `SELECT episode_id
         FROM lite_execution_episodes
         WHERE tenant_id = ? AND scope = ?`,
      ).get(TENANT_ID, STORE_SCOPE) as { episode_id: string } | undefined;
      if (!episodeRow) throw new Error("sigkill_episode_missing");
      const resumed = await service.resume({
        tenantId: TENANT_ID,
        storeScope: STORE_SCOPE,
        episodeId: episodeRow.episode_id,
        workspaceRoot: subjectRoot,
      });
      const verifierEvent = resumed.replay.events.find(
        (event) => event.payload.event_kind === "verifier_recorded",
      );
      if (
        !verifierEvent
        || verifierEvent.payload.event_kind !== "verifier_recorded"
      ) {
        throw new Error("sigkill_recovered_verifier_event_missing");
      }
      const closed = await service.close({
        tenantId: TENANT_ID,
        storeScope: STORE_SCOPE,
        episodeId: episodeRow.episode_id,
        operationId: "sigkill-close",
        workspaceRoot: subjectRoot,
        expectedCurrentStateSnapshotId:
          resumed.current_state_snapshot.snapshot_id,
        termination: "cancelled",
        verifierReceiptId:
          verifierEvent.payload.outcome.verifier_receipt_id,
        outcomeDetails: [
          "Runtime was SIGKILLed after real verifier spawn",
          "recovered launch is an arm-caused ITT failure",
        ],
      });
      const replay = await episodeStore.replayEpisode({
        tenantId: TENANT_ID,
        scope: STORE_SCOPE,
        episodeId: episodeRow.episode_id,
      });
      output({
        contract_version: "sigkill_runtime_recovery_result_v1",
        runtime_pid: process.pid,
        recovery,
        close_replayed: closed.replayed,
        verifier_status: verifierEvent.payload.outcome.status,
        verifier_receipt_id:
          verifierEvent.payload.outcome.verifier_receipt_id,
        verified_success: replay.reward?.verified_success ?? null,
        outcome_class: replay.reward?.outcome_class ?? null,
        reward_authority: replay.reward?.reward_authority ?? null,
      });
      return;
    }

    throw new Error(`unsupported_sigkill_child_mode:${mode}`);
  } finally {
    try {
      await writeStore.close();
    } finally {
      await database.close();
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
