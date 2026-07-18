import type { AssociativeLinkTriggerPayload } from "../memory/associative-linking-types.js";
import { AssociativeLinkTriggerPayloadSchema } from "../memory/associative-linking-types.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { runAssociativeLinkingJob, type AssociativeLinkingJobResult } from "./associative-linking-lib.js";

export type LiteAssociativeLinkOutboxDrainResult = {
  scanned: number;
  processed: number;
  deleted: number;
  invalid_deleted: number;
  failed: number;
  results: AssociativeLinkingJobResult[];
};

type AssociativeLinkWorkerLogger = {
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
};

function parseAssociativeLinkPayload(payloadJson: string): AssociativeLinkTriggerPayload | null {
  try {
    return AssociativeLinkTriggerPayloadSchema.parse(JSON.parse(payloadJson));
  } catch {
    return null;
  }
}

export async function drainLiteAssociativeLinkOutbox(args: {
  writeStore: Pick<LiteWriteStore,
    | "listOutboxEvents"
    | "deleteOutboxEvent"
    | "upsertAssociationCandidates"
    | "listAssociationCandidatesForSource"
    | "updateAssociationCandidateStatus"
  >;
  recallAccess: Pick<RecallStoreAccess, "listAssociativeNodesByIds" | "listAssociativeCandidatePool">;
  limit: number;
  logger?: AssociativeLinkWorkerLogger;
}): Promise<LiteAssociativeLinkOutboxDrainResult> {
  const rows = await args.writeStore.listOutboxEvents({
    eventType: "associative_link",
    limit: args.limit,
  });
  const out: LiteAssociativeLinkOutboxDrainResult = {
    scanned: rows.length,
    processed: 0,
    deleted: 0,
    invalid_deleted: 0,
    failed: 0,
    results: [],
  };

  for (const row of rows) {
    const payload = parseAssociativeLinkPayload(row.payload_json);
    if (!payload) {
      await args.writeStore.deleteOutboxEvent(row.row_id);
      out.invalid_deleted += 1;
      out.deleted += 1;
      args.logger?.warn?.({
        row_id: row.row_id,
        event_type: row.event_type,
        job_key: row.job_key,
      }, "deleted invalid associative link outbox row");
      continue;
    }

    try {
      const result = await runAssociativeLinkingJob({
        payload,
        recallAccess: args.recallAccess,
        writeAccess: args.writeStore,
      });
      await args.writeStore.deleteOutboxEvent(row.row_id);
      out.processed += 1;
      out.deleted += 1;
      out.results.push(result);
    } catch (err) {
      out.failed += 1;
      args.logger?.error?.({
        row_id: row.row_id,
        event_type: row.event_type,
        job_key: row.job_key,
        error: err instanceof Error ? err.message : String(err),
      }, "associative link outbox drain failed");
    }
  }

  return out;
}

export type LiteAssociativeLinkWorker = {
  drainOnce(): Promise<LiteAssociativeLinkOutboxDrainResult>;
  shutdown(): Promise<void>;
};

function emptyAssociativeLinkOutboxDrainResult(): LiteAssociativeLinkOutboxDrainResult {
  return {
    scanned: 0,
    processed: 0,
    deleted: 0,
    invalid_deleted: 0,
    failed: 0,
    results: [],
  };
}

export function startLiteAssociativeLinkWorker(args: {
  writeStore: LiteWriteStore;
  recallAccess: RecallStoreAccess;
  intervalMs: number;
  batchSize: number;
  logger?: AssociativeLinkWorkerLogger;
}): LiteAssociativeLinkWorker {
  let closed = false;
  let running: Promise<LiteAssociativeLinkOutboxDrainResult> | null = null;
  const drainOnce = async (): Promise<LiteAssociativeLinkOutboxDrainResult> => {
    if (closed) return emptyAssociativeLinkOutboxDrainResult();
    if (running) return await running;
    running = drainLiteAssociativeLinkOutbox({
      writeStore: args.writeStore,
      recallAccess: args.recallAccess,
      limit: args.batchSize,
      logger: args.logger,
    });
    try {
      const result = await running;
      if (result.processed > 0 || result.invalid_deleted > 0 || result.failed > 0) {
        args.logger?.info?.({
          scanned: result.scanned,
          processed: result.processed,
          invalid_deleted: result.invalid_deleted,
          failed: result.failed,
        }, "associative link outbox drain");
      }
      return result;
    } finally {
      running = null;
    }
  };
  const timer = setInterval(() => {
    void drainOnce().catch((err) => {
      args.logger?.error?.({
        error: err instanceof Error ? err.message : String(err),
      }, "associative link outbox drain crashed");
    });
  }, Math.max(250, Math.trunc(args.intervalMs)));
  timer.unref?.();
  void drainOnce().catch((err) => {
    args.logger?.error?.({
      error: err instanceof Error ? err.message : String(err),
    }, "associative link initial outbox drain crashed");
  });
  return {
    drainOnce,
    async shutdown() {
      closed = true;
      clearInterval(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
