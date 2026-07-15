import { randomUUID } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import type { Env } from "../config.js";
import { applyUnusedExposureLearningControlLite } from "../memory/lifecycle-lite.js";
import { parseGuideExposureLedger } from "../product/product-services.js";
import type { LiteLearningEpisodeLedgerAccess } from "../store/lite-learning-episode-ledger.js";
import {
  LiteLearningControlJobValidationError,
  learningControlOperationRequestSha256,
  sanitizeLearningControlErrorCode,
  type LiteLearningControlBacklogSnapshot,
  type LiteLearningControlJobAccess,
  type LiteLearningControlJobClaim,
  type LiteLearningControlJobRow,
} from "../store/lite-learning-control-jobs.js";
import { appendControlJobLearningSafetyStop } from "../store/lite-learning-safety-stop.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";

const LEARNING_CONTROL_OPERATION_KIND = "unused_exposure_learning_control_v1";

type LearningControlWorkerLogger = {
  info?(fields: Record<string, unknown>, message: string): void;
  warn?(fields: Record<string, unknown>, message: string): void;
  error?(fields: Record<string, unknown>, message: string): void;
};

export type UnusedExposureLearningControlDrainResult = {
  claimed: number;
  completed: number;
  no_op: number;
  retried: number;
  terminalization_deferred: number;
  last_terminalization_error_code: string | null;
  dead_lettered: number;
  safety_paused: number;
  stale_claims: number;
};

export type UnusedExposureLearningControlWorkerHealth = {
  running: boolean;
  closed: boolean;
  last_started_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_error_code: string | null;
  last_terminalization_deferred_at: string | null;
  last_terminalization_error_code: string | null;
  last_drain: UnusedExposureLearningControlDrainResult | null;
  backlog: LiteLearningControlBacklogSnapshot | null;
};

export type UnusedExposureLearningControlWorker = {
  drainOnce(): Promise<UnusedExposureLearningControlDrainResult>;
  healthSnapshot(): UnusedExposureLearningControlWorkerHealth;
  shutdown(): Promise<void>;
};

type ProcessOutcome =
  | { kind: "completed"; noOp: boolean }
  | { kind: "retried" }
  | { kind: "terminalization_deferred"; errorCode: string }
  | { kind: "dead_lettered"; safetyPaused: boolean }
  | { kind: "stale_claim" };

class LearningControlWorkerStageError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "LearningControlWorkerStageError";
    this.code = sanitizeLearningControlErrorCode(code);
  }
}

function emptyDrainResult(): UnusedExposureLearningControlDrainResult {
  return {
    claimed: 0,
    completed: 0,
    no_op: 0,
    retried: 0,
    terminalization_deferred: 0,
    last_terminalization_error_code: null,
    dead_lettered: 0,
    safety_paused: 0,
    stale_claims: 0,
  };
}

function mergeOutcome(result: UnusedExposureLearningControlDrainResult, outcome: ProcessOutcome): void {
  result.claimed += 1;
  switch (outcome.kind) {
    case "completed":
      result.completed += 1;
      if (outcome.noOp) result.no_op += 1;
      break;
    case "retried":
      result.retried += 1;
      break;
    case "terminalization_deferred":
      result.terminalization_deferred += 1;
      result.last_terminalization_error_code = outcome.errorCode;
      break;
    case "dead_lettered":
      result.dead_lettered += 1;
      if (outcome.safetyPaused) result.safety_paused += 1;
      break;
    case "stale_claim":
      result.stale_claims += 1;
      break;
  }
}

function controlledErrorCode(error: unknown): string {
  if (error instanceof LiteLearningControlJobValidationError) return error.code;
  if (error instanceof LearningControlWorkerStageError) return error.code;
  if (error instanceof Error && error.name) {
    return sanitizeLearningControlErrorCode(`learning_control_${error.name.toLowerCase()}`);
  }
  return "learning_control_unknown_error";
}

function retryDelayMs(claim: LiteLearningControlJobClaim): number {
  const exponent = Math.max(0, Math.min(6, claim.attempt_count - 1));
  const base = Math.min(60_000, 1_000 * (2 ** exponent));
  const jitterSeed = Number.parseInt(
    sha256Hex(`${claim.job_id}:${claim.attempt_count}`).slice(0, 8),
    16,
  );
  return base + (jitterSeed % Math.max(1, Math.floor(base / 4)));
}

function parseSourceGuideLedger(args: {
  ledgerJson: string;
  ledgerSha256: string;
  tenantId: string;
  scope: string;
  guideTraceId: string;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
}): ReturnType<typeof parseGuideExposureLedger> {
  if (sha256Hex(args.ledgerJson) !== args.ledgerSha256) {
    throw new LiteLearningControlJobValidationError("learning_control_guide_receipt_digest_mismatch");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(args.ledgerJson);
  } catch {
    throw new LiteLearningControlJobValidationError("learning_control_guide_receipt_invalid");
  }
  if (stableStringify(decoded) !== args.ledgerJson) {
    throw new LiteLearningControlJobValidationError("learning_control_guide_receipt_noncanonical");
  }
  const ledger = parseGuideExposureLedger(decoded);
  if (!ledger
    || ledger.tenant_id !== args.tenantId
    || ledger.scope !== args.scope
    || ledger.guide_trace_id !== args.guideTraceId
    || ledger.consumer_agent_id !== args.consumerAgentId
    || ledger.consumer_team_id !== args.consumerTeamId) {
    throw new LiteLearningControlJobValidationError("learning_control_guide_receipt_binding_mismatch");
  }
  return ledger;
}

function workerReceipt(args: {
  job: LiteLearningControlJobRow;
  status: "completed" | "dead_letter";
  completedAt: string;
  resultCommitId: string | null;
  changedMemoryIds: readonly string[];
  skippedPositiveMemoryIds: readonly string[];
  missingNodeIds: readonly string[];
  lastErrorCode: string | null;
}) {
  return {
    contract_version: "unused_exposure_learning_control_operation_receipt_v1",
    status: args.status,
    tenant_id: args.job.tenant_id,
    scope: args.job.scope,
    job_id: args.job.job_id,
    operation_kind: LEARNING_CONTROL_OPERATION_KIND,
    operation_id: args.job.operation_id,
    source_episode_id: args.job.source_episode_id,
    source_feedback_event_id: args.job.source_feedback_event_id,
    source_commit_id: args.job.source_commit_id,
    payload_sha256: args.job.payload_sha256,
    attempt_count: args.job.attempt_count,
    result_commit_id: args.resultCommitId,
    changed_memory_ids: [...args.changedMemoryIds],
    skipped_positive_attribution_memory_ids: [...args.skippedPositiveMemoryIds],
    missing_node_ids: [...args.missingNodeIds],
    last_error_code: args.lastErrorCode,
    completed_at: args.completedAt,
  } as const;
}

async function insertWorkerOperationReceipt(args: {
  writeStore: LiteWriteStore;
  job: LiteLearningControlJobRow;
  receipt: ReturnType<typeof workerReceipt>;
  commitId: string;
}): Promise<void> {
  const requestSha256 = learningControlOperationRequestSha256(args.job);
  const receiptJson = stableStringify(args.receipt);
  const existing = await args.writeStore.getWriteOperation({
    tenantId: args.job.tenant_id,
    scope: args.job.scope,
    operationKind: LEARNING_CONTROL_OPERATION_KIND,
    operationId: args.job.operation_id,
  });
  if (existing) {
    if (existing.request_sha256 !== requestSha256
      || existing.receipt_json !== receiptJson
      || existing.commit_id !== args.commitId) {
      throw new Error("learning control worker operation replay conflict");
    }
    return;
  }
  await args.writeStore.insertWriteOperation({
    tenantId: args.job.tenant_id,
    scope: args.job.scope,
    operationKind: LEARNING_CONTROL_OPERATION_KIND,
    operationId: args.job.operation_id,
    requestSha256,
    receiptJson,
    commitId: args.commitId,
  });
}

async function completeClaim(args: {
  access: LiteLearningControlJobAccess;
  ledger: LiteLearningEpisodeLedgerAccess;
  writeStore: LiteWriteStore;
  env: Pick<Env, "MEMORY_SCOPE" | "MEMORY_TENANT_ID" | "LITE_LOCAL_ACTOR_ID" | "MAX_TEXT_LEN" | "PII_REDACTION">;
  claim: LiteLearningControlJobClaim;
  now: Date;
}): Promise<ProcessOutcome> {
  return await args.writeStore.withTx(async () => {
    const facts = await args.access.loadUnusedExposureLearningControlFactsInTx({
      claim: args.claim,
      now: args.now,
    });
    if (!facts) return { kind: "stale_claim" } as const;
    const sourceLedger = parseSourceGuideLedger({
      ledgerJson: facts.source_guide_ledger_json,
      ledgerSha256: facts.source_guide_ledger_sha256,
      tenantId: facts.job.tenant_id,
      scope: facts.job.scope,
      guideTraceId: facts.source_guide_trace_id,
      consumerAgentId: facts.source_consumer_agent_id,
      consumerTeamId: facts.source_consumer_team_id,
    });
    if (!sourceLedger) {
      throw new LiteLearningControlJobValidationError("learning_control_guide_receipt_invalid");
    }
    const requestSha256 = learningControlOperationRequestSha256(facts.job);
    const persistence = await applyUnusedExposureLearningControlLite(
      args.writeStore,
      {
        tenant_id: facts.job.tenant_id,
        scope: facts.job.scope,
        actor: facts.source_consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID,
        consumer_team_id: facts.source_consumer_team_id,
        run_id: facts.feedback.run_id,
        guide_trace_id: facts.source_guide_trace_id,
        reason: "Repeated exposure without positive host attribution crossed the durable inspect-before-use gate.",
        input_sha256: requestSha256,
        recorded_at: args.now.toISOString(),
        job_id: facts.job.job_id,
        source_episode_id: facts.job.source_episode_id,
        source_feedback_event_id: facts.job.source_feedback_event_id,
        evidence_cutoff_event_row_id: facts.feedback_event_row_id,
        memory_stats: [...facts.memory_stats],
      },
      args.env.MEMORY_SCOPE,
      args.env.MEMORY_TENANT_ID,
      {
        maxTextLen: args.env.MAX_TEXT_LEN,
        piiRedaction: args.env.PII_REDACTION,
        defaultActor: args.env.LITE_LOCAL_ACTOR_ID,
      },
    );
    if (typeof persistence.commit_id !== "string" || persistence.commit_id.length === 0) {
      throw new Error("learning control persistence did not create its audit commit");
    }
    const completedAt = args.now.toISOString();
    const receipt = workerReceipt({
      job: facts.job,
      status: "completed",
      completedAt,
      resultCommitId: persistence.commit_id,
      changedMemoryIds: persistence.changed_memory_ids,
      skippedPositiveMemoryIds: persistence.skipped_positive_attribution_memory_ids,
      missingNodeIds: persistence.missing_node_ids,
      lastErrorCode: null,
    });
    await insertWorkerOperationReceipt({
      writeStore: args.writeStore,
      job: facts.job,
      receipt,
      commitId: persistence.commit_id,
    });
    const completed = await args.access.completeLearningControlJobInTx({
      claim: args.claim,
      resultCommitId: persistence.commit_id,
      completedAt,
    });
    if (!completed) throw new Error("learning control completion lost its lease fence");
    return {
      kind: "completed",
      noOp: persistence.changed_count === 0,
    } as const;
  });
}

async function terminalizeClaim(args: {
  access: LiteLearningControlJobAccess;
  ledger: LiteLearningEpisodeLedgerAccess;
  writeStore: LiteWriteStore;
  claim: LiteLearningControlJobClaim;
  errorCode: string;
  now: Date;
}): Promise<ProcessOutcome> {
  return await args.writeStore.withTx(async () => {
    const safetySource = await args.access.loadLearningControlSafetySourceInTx({
      claim: args.claim,
      now: args.now,
    });
    if (!safetySource) return { kind: "stale_claim" } as const;
    const source = await args.ledger.resolveFeedbackSource({
      tenantId: safetySource.job.tenant_id,
      scope: safetySource.job.scope,
      guideTraceId: safetySource.source_guide_trace_id,
    });
    if (!source) {
      throw new LiteLearningControlJobValidationError("learning_control_dead_letter_source_missing");
    }
    const enrolled = safetySource.source_exposure_enrollment_state === "enrolled";
    if (enrolled && !source.safetyAuthority) {
      throw new LiteLearningControlJobValidationError("learning_control_dead_letter_authority_missing");
    }
    const completedAt = args.now.toISOString();
    const errorCode = sanitizeLearningControlErrorCode(args.errorCode);
    const receipt = workerReceipt({
      job: safetySource.job,
      status: "dead_letter",
      completedAt,
      resultCommitId: null,
      changedMemoryIds: [],
      skippedPositiveMemoryIds: [],
      missingNodeIds: [],
      lastErrorCode: errorCode,
    });
    try {
      await insertWorkerOperationReceipt({
        writeStore: args.writeStore,
        job: safetySource.job,
        receipt,
        commitId: safetySource.job.source_commit_id,
      });
    } catch (error) {
      throw new LearningControlWorkerStageError(
        "learning_control_terminalization_worker_receipt_failed",
        error,
      );
    }
    let safetyPaused = false;
    if (enrolled) {
      let stop: Awaited<ReturnType<typeof appendControlJobLearningSafetyStop>>;
      try {
        stop = await appendControlJobLearningSafetyStop({
          ledger: args.ledger,
          liteWriteStore: args.writeStore,
          source,
          job: safetySource.job,
          feedbackEventRowId: safetySource.feedback_event_row_id,
          lastErrorCode: errorCode,
          recordedAt: completedAt,
        });
      } catch (error) {
        throw new LearningControlWorkerStageError(
          "learning_control_terminalization_safety_pause_failed",
          error,
        );
      }
      if (!stop) {
        throw new LearningControlWorkerStageError(
          "learning_control_terminalization_safety_pause_missing",
        );
      }
      safetyPaused = true;
    }
    const deadLettered = await args.access.deadLetterLearningControlJobInTx({
      claim: args.claim,
      errorCode,
      completedAt,
    });
    if (!deadLettered) {
      throw new LearningControlWorkerStageError(
        "learning_control_terminalization_lease_fence_lost",
      );
    }
    return { kind: "dead_lettered", safetyPaused } as const;
  });
}

async function deferExhaustedClaim(args: {
  access: LiteLearningControlJobAccess;
  claim: LiteLearningControlJobClaim;
  jobErrorCode: string;
  terminalizationErrorCode: string;
  now: () => Date;
}): Promise<ProcessOutcome> {
  const now = args.now();
  const deferred = await args.access.deferLearningControlJobTerminalization({
    claim: args.claim,
    errorCode: args.jobErrorCode,
    now,
    retryAt: new Date(now.getTime() + retryDelayMs(args.claim)),
  });
  return deferred === "deferred"
    ? { kind: "terminalization_deferred", errorCode: args.terminalizationErrorCode }
    : { kind: "stale_claim" };
}

async function processClaim(args: {
  access: LiteLearningControlJobAccess;
  ledger: LiteLearningEpisodeLedgerAccess;
  writeStore: LiteWriteStore;
  env: Pick<Env, "MEMORY_SCOPE" | "MEMORY_TENANT_ID" | "LITE_LOCAL_ACTOR_ID" | "MAX_TEXT_LEN" | "PII_REDACTION">;
  claim: LiteLearningControlJobClaim;
  now: () => Date;
}): Promise<ProcessOutcome> {
  if (args.claim.claim_mode === "terminalize_exhausted") {
    const errorCode = args.claim.last_error_code ?? "learning_control_retry_exhausted";
    try {
      return await terminalizeClaim({
        access: args.access,
        ledger: args.ledger,
        writeStore: args.writeStore,
        claim: args.claim,
        errorCode,
        now: args.now(),
      });
    } catch (terminalizationError) {
      return await deferExhaustedClaim({
        access: args.access,
        claim: args.claim,
        jobErrorCode: errorCode,
        terminalizationErrorCode: controlledErrorCode(terminalizationError),
        now: args.now,
      });
    }
  }
  try {
    return await completeClaim({
      access: args.access,
      ledger: args.ledger,
      writeStore: args.writeStore,
      env: args.env,
      claim: args.claim,
      now: args.now(),
    });
  } catch (error) {
    const errorCode = controlledErrorCode(error);
    const terminal = error instanceof LiteLearningControlJobValidationError
      || args.claim.attempt_count >= 8;
    if (terminal) {
      try {
        return await terminalizeClaim({
          access: args.access,
          ledger: args.ledger,
          writeStore: args.writeStore,
          claim: args.claim,
          errorCode,
          now: args.now(),
        });
      } catch (terminalizationError) {
        if (args.claim.attempt_count >= 8) {
          return await deferExhaustedClaim({
            access: args.access,
            claim: args.claim,
            jobErrorCode: errorCode,
            terminalizationErrorCode: controlledErrorCode(terminalizationError),
            now: args.now,
          });
        }
      }
    }
    const now = args.now();
    const retried = await args.access.retryLearningControlJob({
      claim: args.claim,
      errorCode,
      now,
      retryAt: new Date(now.getTime() + retryDelayMs(args.claim)),
    });
    if (retried === "retried") return { kind: "retried" };
    if (retried === "stale_claim") return { kind: "stale_claim" };
    return await deferExhaustedClaim({
      access: args.access,
      claim: args.claim,
      jobErrorCode: errorCode,
      terminalizationErrorCode: "learning_control_terminalization_deferred",
      now: args.now,
    });
  }
}

export async function drainUnusedExposureLearningControlJobs(args: {
  access: LiteLearningControlJobAccess;
  ledger: LiteLearningEpisodeLedgerAccess;
  writeStore: LiteWriteStore;
  env: Pick<Env, "MEMORY_SCOPE" | "MEMORY_TENANT_ID" | "LITE_LOCAL_ACTOR_ID" | "MAX_TEXT_LEN" | "PII_REDACTION">;
  limit: number;
  leaseOwner?: string;
  leaseMs?: number;
  now?: () => Date;
  shouldContinue?: () => boolean;
  logger?: LearningControlWorkerLogger;
}): Promise<UnusedExposureLearningControlDrainResult> {
  if (args.access.transactionRunner() !== args.writeStore.transactionRunner()
    || args.ledger.transactionRunner() !== args.writeStore.transactionRunner()) {
    throw new Error("learning control worker stores must share one Runtime transaction runner");
  }
  const result = emptyDrainResult();
  const limit = Math.max(1, Math.min(200, Math.trunc(args.limit)));
  const leaseOwner = args.leaseOwner?.trim() || `learning-control:${process.pid}:${randomUUID()}`;
  const leaseMs = Math.max(1_000, Math.trunc(args.leaseMs ?? 60_000));
  const now = args.now ?? (() => new Date());
  for (let index = 0; index < limit; index += 1) {
    if (args.shouldContinue && !args.shouldContinue()) break;
    const claims = await args.access.claimLearningControlJobs({
      leaseOwner,
      leaseMs,
      limit: 1,
      now: now(),
    });
    const claim = claims[0];
    if (!claim) break;
    const outcome = await processClaim({
      access: args.access,
      ledger: args.ledger,
      writeStore: args.writeStore,
      env: args.env,
      claim,
      now,
    });
    mergeOutcome(result, outcome);
  }
  if (result.retried > 0 || result.terminalization_deferred > 0 || result.dead_lettered > 0) {
    args.logger?.warn?.({ ...result }, "durable unused-exposure learning-control drain deferred jobs");
  }
  return result;
}

export function startUnusedExposureLearningControlWorker(args: {
  access: LiteLearningControlJobAccess;
  ledger: LiteLearningEpisodeLedgerAccess;
  writeStore: LiteWriteStore;
  env: Pick<Env, "MEMORY_SCOPE" | "MEMORY_TENANT_ID" | "LITE_LOCAL_ACTOR_ID" | "MAX_TEXT_LEN" | "PII_REDACTION">;
  intervalMs: number;
  batchSize: number;
  leaseMs?: number;
  now?: () => Date;
  logger?: LearningControlWorkerLogger;
}): UnusedExposureLearningControlWorker {
  let closed = false;
  let running: Promise<UnusedExposureLearningControlDrainResult> | null = null;
  let lastStartedAt: string | null = null;
  let lastSucceededAt: string | null = null;
  let lastFailedAt: string | null = null;
  let lastErrorCode: string | null = null;
  let lastTerminalizationDeferredAt: string | null = null;
  let lastTerminalizationErrorCode: string | null = null;
  let lastDrain: UnusedExposureLearningControlDrainResult | null = null;
  let backlog: LiteLearningControlBacklogSnapshot | null = null;
  const leaseOwner = `learning-control-worker:${process.pid}:${randomUUID()}`;
  const now = args.now ?? (() => new Date());

  const drainOnce = async (): Promise<UnusedExposureLearningControlDrainResult> => {
    if (closed) return emptyDrainResult();
    if (running) return await running;
    const operation = (async () => {
      lastStartedAt = now().toISOString();
      try {
        const result = await drainUnusedExposureLearningControlJobs({
          access: args.access,
          ledger: args.ledger,
          writeStore: args.writeStore,
          env: args.env,
          limit: args.batchSize,
          leaseOwner,
          now,
          shouldContinue: () => !closed,
          ...(args.leaseMs ? { leaseMs: args.leaseMs } : {}),
          logger: args.logger,
        });
        lastDrain = result;
        backlog = await args.access.learningControlBacklogSnapshot(now());
        lastSucceededAt = now().toISOString();
        lastErrorCode = null;
        if (result.terminalization_deferred > 0) {
          lastTerminalizationDeferredAt = lastSucceededAt;
          lastTerminalizationErrorCode = result.last_terminalization_error_code;
        }
        return result;
      } catch (error) {
        lastFailedAt = now().toISOString();
        lastErrorCode = controlledErrorCode(error);
        throw error;
      }
    })();
    let tracked!: Promise<UnusedExposureLearningControlDrainResult>;
    tracked = operation.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return await tracked;
  };

  const runLogged = (): void => {
    void drainOnce().then((result) => {
      if (result.claimed > 0) {
        args.logger?.info?.({ ...result }, "durable unused-exposure learning-control drain");
      }
    }).catch((error) => {
      args.logger?.error?.(
        { error_code: controlledErrorCode(error) },
        "durable unused-exposure learning-control drain crashed",
      );
    });
  };
  const timer = setInterval(runLogged, Math.max(250, Math.trunc(args.intervalMs)));
  timer.unref?.();
  runLogged();

  return {
    drainOnce,
    healthSnapshot() {
      return {
        running: running !== null,
        closed,
        last_started_at: lastStartedAt,
        last_succeeded_at: lastSucceededAt,
        last_failed_at: lastFailedAt,
        last_error_code: lastErrorCode,
        last_terminalization_deferred_at: lastTerminalizationDeferredAt,
        last_terminalization_error_code: lastTerminalizationErrorCode,
        last_drain: lastDrain,
        backlog,
      };
    },
    async shutdown() {
      closed = true;
      clearInterval(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
