import { resolve } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  LearningExternalEvidenceArtifactKindSchema,
  LearningExternalEvidenceIngestRequestV1Schema,
  type LearningExternalEvidenceArtifactKind,
} from "../memory/learning-external-evidence.js";
import {
  closePreparedLiteLearningExternalEvidenceArchive,
  assertPreparedLiteLearningExternalEvidenceArchivePinned,
  inspectPreparedLiteLearningExternalEvidenceArchive,
  prepareLiteLearningExternalEvidenceArchive,
  type PreparedLiteLearningExternalEvidenceArchive,
} from "./lite-learning-external-evidence-archive-reader.js";
import {
  createLiteLearningEpisodeLedgerAccess,
  type LiteLearningAuthorityRow,
} from "../../../../src/store/lite-learning-episode-ledger.js";
import {
  createLiteLearningExternalEvidenceIngestionAccess,
  type LiteLearningExternalEvidenceIngestionPhase,
  type LiteLearningExternalEvidenceIngestOperationReceiptV1,
} from "./lite-learning-external-evidence-ingestion.js";
import {
  type LiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../../../src/store/lite-runtime-database.js";
import {
  inspectLiteRuntimeSchema,
  LITE_RUNTIME_WRITE_SCHEMA_VERSION,
} from "../../../../src/store/lite-runtime-schema.js";
import {
  assertLiteRuntimeProtectedAuthorityDatabasePinned,
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  inspectLiteRuntimeProtectedAuthorityDatabase,
  openLiteRuntimeProtectedAuthorityDatabase,
  pinLiteRuntimeProtectedAuthorityDatabase,
  runLiteRuntimeProtectedAuthorityTransaction,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "./lite-runtime-protected-authority-database.js";

const BEGIN_BUSY_RETRY = Object.freeze({ maxAttempts: 6, delayMs: 25 });

export type LiteLearningExternalEvidenceServiceInput = Readonly<{
  databasePath: string;
  archivePath: string;
  publicRunAuthorityPath: string;
  tenantId: string;
  actorId: string;
  operationId: string;
  artifactKind: LearningExternalEvidenceArtifactKind;
  evidenceSeriesId: string;
  taskFamily: string;
  applicableExperimentId: string;
  applicableExperimentRevision: number;
}>;

export type LiteLearningExternalEvidenceServiceResult = Readonly<{
  artifact: LiteLearningAuthorityRow;
  receipt: LiteLearningExternalEvidenceIngestOperationReceiptV1;
  receiptJson: string;
  replayed: boolean;
}>;

/** @internal Process-crash/concurrency testing only. Formal operator paths omit it. */
export type LiteLearningExternalEvidenceServiceTestHooks = Readonly<{
  databasePhase?: LiteRuntimeDatabaseFaultInjector;
  ingestionPhase?: (phase: LiteLearningExternalEvidenceIngestionPhase) => void;
  busyTimeoutMs?: number;
  now?: () => Date;
}>;

export type LiteLearningExternalEvidenceServiceErrorCode =
  | "learning_external_evidence_service_argument_mismatch"
  | "learning_external_evidence_service_current_database_required"
  | "learning_external_evidence_service_failed_after_commit";

export class LiteLearningExternalEvidenceServiceError extends Error {
  readonly code: LiteLearningExternalEvidenceServiceErrorCode;
  readonly committed: boolean;

  constructor(
    code: LiteLearningExternalEvidenceServiceErrorCode,
    message: string,
    options: Readonly<{ committed?: boolean; cause?: unknown }> = {},
  ) {
    super(message);
    this.name = "LiteLearningExternalEvidenceServiceError";
    this.code = code;
    this.committed = options.committed === true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function serviceError(
  code: LiteLearningExternalEvidenceServiceErrorCode,
  message: string,
): never {
  throw new LiteLearningExternalEvidenceServiceError(code, message);
}

function assertOperatorBindings(
  input: LiteLearningExternalEvidenceServiceInput,
  prepared: PreparedLiteLearningExternalEvidenceArchive,
): void {
  const { archiveValidation } = inspectPreparedLiteLearningExternalEvidenceArchive(prepared);
  const payload = archiveValidation.publicRunAuthority.payload;
  const report = archiveValidation.contracts.report;
  const bindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [input.tenantId, payload.tenant_id, "tenant"],
    [input.artifactKind, payload.artifact_kind, "kind.public_authority"],
    [input.artifactKind, report.artifact_kind, "kind.report"],
    [input.artifactKind,
      archiveValidation.contracts.runBundle.artifact_kind, "kind.run_bundle"],
    [input.evidenceSeriesId, report.evidence_series_id, "series_id"],
    [input.taskFamily, report.task_family, "task_family"],
    [input.applicableExperimentId,
      report.applicable_experiment_id, "applicable_experiment_id"],
    [input.applicableExperimentRevision,
      report.applicable_experiment_revision, "applicable_experiment_revision"],
  ];
  for (const [actual, expected, field] of bindings) {
    if (actual !== expected) {
      serviceError(
        "learning_external_evidence_service_argument_mismatch",
        `formal ingest argument does not match verified archive authority: ${field}`,
      );
    }
  }
}

function assertCurrentRuntimeDatabase(database: LiteRuntimeDatabase): void {
  const schema = inspectLiteRuntimeSchema(database.db);
  if (schema.classification !== "current"
    || schema.detected_version !== LITE_RUNTIME_WRITE_SCHEMA_VERSION) {
    serviceError(
      "learning_external_evidence_service_current_database_required",
      "formal evidence ingest requires an already-current Runtime database and never migrates",
    );
  }
}

function samePathIdentity(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  if (normalizedLeft === normalizedRight) return true;
  return (process.platform === "darwin" || process.platform === "win32")
    && normalizedLeft.toLocaleLowerCase("en-US")
      === normalizedRight.toLocaleLowerCase("en-US");
}

function assertDatabaseEvidencePathsDisjoint(args: Readonly<{
  databaseRealpath: string;
  archivePath: string;
  publicRunAuthorityPath: string;
}>): void {
  const databasePaths = [
    args.databaseRealpath,
    `${args.databaseRealpath}-wal`,
    `${args.databaseRealpath}-shm`,
    `${args.databaseRealpath}-journal`,
  ];
  for (const evidencePath of [args.archivePath, args.publicRunAuthorityPath]) {
    if (databasePaths.some((databasePath) => samePathIdentity(
      databasePath,
      evidencePath,
    ))) {
      serviceError(
        "learning_external_evidence_service_argument_mismatch",
        "Runtime database and evidence input paths must be disjoint",
      );
    }
  }
}

function assertTestBusyTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new Error("external evidence service test busy timeout must be 1..5000 ms");
  }
}

function cleanupResources(args: Readonly<{
  database: LiteRuntimeDatabase | null;
  databasePin: LiteRuntimeProtectedAuthorityDatabasePin | null;
  prepared: PreparedLiteLearningExternalEvidenceArchive | null;
}>): Promise<void> {
  return (async () => {
    const failures: unknown[] = [];
    if (args.database !== null) {
      try {
        await args.database.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (args.databasePin !== null) {
      try {
        closeLiteRuntimeProtectedAuthorityDatabasePin(args.databasePin);
      } catch (error) {
        failures.push(error);
      }
    }
    if (args.prepared !== null) {
      try {
        closePreparedLiteLearningExternalEvidenceArchive(args.prepared);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "external evidence service resource cleanup failed");
    }
  })();
}

/**
 * The only production composition path from tracked archive bytes to the
 * protected Runtime evidence/operation pair. Archive and Git validation happen
 * before SQLite is opened; all live authority decisions happen after
 * BEGIN IMMEDIATE.
 */
export async function ingestLiteLearningExternalEvidence(
  input: LiteLearningExternalEvidenceServiceInput,
  /** @internal */ testHooks: LiteLearningExternalEvidenceServiceTestHooks = {},
): Promise<LiteLearningExternalEvidenceServiceResult> {
  LearningExternalEvidenceArtifactKindSchema.parse(input.artifactKind);
  let prepared: PreparedLiteLearningExternalEvidenceArchive | null = null;
  let databasePin: LiteRuntimeProtectedAuthorityDatabasePin | null = null;
  let database: LiteRuntimeDatabase | null = null;
  let result: LiteLearningExternalEvidenceServiceResult | null = null;
  let transactionCommitted = false;
  let primaryFailure: unknown;
  try {
    prepared = prepareLiteLearningExternalEvidenceArchive({
      archivePath: input.archivePath,
      publicRunAuthorityPath: input.publicRunAuthorityPath,
    });
    assertOperatorBindings(input, prepared);
    const { archiveValidation, tracking } =
      inspectPreparedLiteLearningExternalEvidenceArchive(prepared);
    const request = LearningExternalEvidenceIngestRequestV1Schema.parse({
      contract_version: "aionis_learning_external_evidence_ingest_request_v1",
      tenant_id: input.tenantId,
      actor_id: input.actorId,
      operation_id: input.operationId,
      artifact_kind: input.artifactKind,
      evidence_series_id: input.evidenceSeriesId,
      task_family: input.taskFamily,
      applicable_experiment_id: input.applicableExperimentId,
      applicable_experiment_revision: input.applicableExperimentRevision,
      lifecycle_authority_projection_sha256:
        archiveValidation.contracts.digests.lifecycle_authority_projection_sha256,
      public_run_authority_sha256: tracking.public_run_authority_sha256,
      run_bundle_manifest_sha256: tracking.run_bundle_manifest_sha256,
      run_bundle_archive_sha256: tracking.raw_archive_sha256,
      bundle_commit_id: tracking.bundle_commit_id,
    });

    databasePin = pinLiteRuntimeProtectedAuthorityDatabase(input.databasePath);
    assertPreparedLiteLearningExternalEvidenceArchivePinned(prepared, {
      verifyHead: true,
    });
    assertLiteRuntimeProtectedAuthorityDatabasePinned(databasePin);
    const databasePath = inspectLiteRuntimeProtectedAuthorityDatabase(
      databasePin,
    ).database_realpath;
    assertDatabaseEvidencePathsDisjoint({
      databaseRealpath: databasePath,
      archivePath: input.archivePath,
      publicRunAuthorityPath: input.publicRunAuthorityPath,
    });
    database = openLiteRuntimeProtectedAuthorityDatabase(databasePin, {
      faultInjector: testHooks.databasePhase,
    });
    if (testHooks.busyTimeoutMs !== undefined) {
      assertTestBusyTimeout(testHooks.busyTimeoutMs);
      database.db.exec(`PRAGMA busy_timeout = ${testHooks.busyTimeoutMs}`);
    }

    const transactionResult = await runLiteRuntimeProtectedAuthorityTransaction(
      databasePin,
      database,
      async (protectedTransactionCapability) => {
        assertLiteRuntimeProtectedAuthorityDatabasePinned(databasePin!);
        assertPreparedLiteLearningExternalEvidenceArchivePinned(prepared!, {
          verifyHead: false,
        });
        assertCurrentRuntimeDatabase(database!);
        // This integrity scan must be created under the acquired writer lock so
        // its multi-statement reads cannot straddle another process's commit.
        createLiteLearningEpisodeLedgerAccess(database!);
        // Creating the general ledger access performs the full under-lock
        // integrity scan, but intentionally exposes no external-evidence ingest
        // method. Only this protected service receives transaction authority.
        const externalEvidenceIngestion =
          createLiteLearningExternalEvidenceIngestionAccess({
            database: database!,
            faultInjector: testHooks.ingestionPhase,
          });
        const recordedAt = (testHooks.now?.() ?? new Date()).toISOString();
        const ingested = await externalEvidenceIngestion.ingestExternalEvidence({
          request,
          preparedArchive: prepared!,
          protectedTransactionCapability,
          recordedAt,
        });
        assertPreparedLiteLearningExternalEvidenceArchivePinned(prepared!, {
          verifyHead: false,
        });
        assertLiteRuntimeProtectedAuthorityDatabasePinned(databasePin!);
        return ingested;
      },
      { beginBusyRetry: BEGIN_BUSY_RETRY },
    );
    // The protected transaction runner resolves only after COMMIT (and its
    // after_commit fault boundary). From this point onward every error must
    // remain retry-safe and never look like an uncommitted failure.
    transactionCommitted = true;
    const receiptJson = stableStringify(transactionResult.receipt);
    result = {
      ...transactionResult,
      receiptJson,
    };
  } catch (error) {
    primaryFailure = error;
  }

  try {
    await cleanupResources({ database, databasePin, prepared });
  } catch (cleanupError) {
    primaryFailure = primaryFailure === undefined
      ? cleanupError
      : new AggregateError(
        [primaryFailure, cleanupError],
        "external evidence ingest and resource cleanup both failed",
      );
  }
  if (primaryFailure !== undefined) {
    if (transactionCommitted) {
      throw new LiteLearningExternalEvidenceServiceError(
        "learning_external_evidence_service_failed_after_commit",
        "external evidence committed but service finalization failed; retry with the same operation ID",
        { committed: true, cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (result === null) throw new Error("external evidence service completed without a result");
  return result;
}
