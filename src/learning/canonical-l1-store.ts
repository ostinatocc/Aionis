import type {
  LiteExecutionEpisodeMemoryCompilationCandidate,
  LiteExecutionEpisodeStore,
} from "../store/lite-execution-episode-store.js";
import type {
  LiteFindNodeRow,
  LiteWriteOperationRow,
  LiteWriteStore,
} from "../store/lite-write-store.js";
import type { CanonicalL1EpisodeV1 } from "./canonical-l1-contract.js";
import { buildCanonicalL1EpisodeV1 } from "./canonical-l1-dataset.js";

const DATASET_PAGE_SIZE = 1_000;
const DATASET_MAX_FEEDBACK_OPERATIONS = 100_000;

async function listFeedbackOperations(args: {
  writeStore: LiteWriteStore;
  tenantId: string;
  scope: string;
  closedAt: string;
}): Promise<LiteWriteOperationRow[]> {
  const rows: LiteWriteOperationRow[] = [];
  for (
    let offset = 0;
    offset < DATASET_MAX_FEEDBACK_OPERATIONS;
    offset += DATASET_PAGE_SIZE
  ) {
    const page = await args.writeStore.listWriteOperations({
      tenantId: args.tenantId,
      scope: args.scope,
      operationKind: "product_feedback_v1",
      createdAtLte: args.closedAt,
      limit: DATASET_PAGE_SIZE,
      offset,
    });
    rows.push(...page);
    if (page.length < DATASET_PAGE_SIZE) break;
  }
  return rows;
}

async function loadDeliveredMemoryNodes(args: {
  writeStore: LiteWriteStore;
  scope: string;
  memoryIds: readonly string[];
}): Promise<LiteFindNodeRow[]> {
  const rows = await Promise.all(args.memoryIds.map(async (id) => {
    const found = await args.writeStore.findNodes({
      scope: args.scope,
      id,
      operatorView: true,
      limit: 1,
      offset: 0,
    });
    return found.rows[0] ?? null;
  }));
  return rows.filter((row): row is LiteFindNodeRow => row !== null);
}

export async function deriveCanonicalL1EpisodeFromStores(args: {
  episodeStore: LiteExecutionEpisodeStore;
  writeStore: LiteWriteStore;
  tenantId: string;
  storeScope: string;
  episodeId: string;
}): Promise<CanonicalL1EpisodeV1> {
  const replay = await args.episodeStore.replayEpisode({
    tenantId: args.tenantId,
    scope: args.storeScope,
    episodeId: args.episodeId,
  });
  const closeEvent = replay.events.at(-1);
  if (
    !closeEvent
    || closeEvent.payload.event_kind !== "episode_closed"
  ) {
    throw new Error("canonical_l1_episode_not_closed");
  }
  const guideReceipts = await args.writeStore.listProductGuideReceipts({
    tenantId: replay.episode.tenant_id,
    scope: replay.episode.public_scope,
    runId: replay.episode.run_id,
    limit: Math.max(1, Math.min(1_000, replay.events.length)),
  });
  const feedbackOperations = await listFeedbackOperations({
    writeStore: args.writeStore,
    tenantId: replay.episode.tenant_id,
    scope: replay.episode.public_scope,
    closedAt: closeEvent.payload.closed_at,
  });
  const memoryIds = [...new Set(replay.events.flatMap((event) =>
    event.payload.event_kind === "decision_committed"
      ? event.payload.decision.selected_candidate_ids
      : []))];
  const memoryNodes = await loadDeliveredMemoryNodes({
    writeStore: args.writeStore,
    scope: replay.episode.public_scope,
    memoryIds,
  });
  return buildCanonicalL1EpisodeV1({
    replay,
    guideReceipts,
    feedbackOperations,
    memoryNodes,
  });
}

export type CanonicalL1DatasetPage = Readonly<{
  source: readonly LiteExecutionEpisodeMemoryCompilationCandidate[];
  rows: readonly CanonicalL1EpisodeV1[];
}>;

export async function deriveCanonicalL1DatasetPage(args: {
  episodeStore: LiteExecutionEpisodeStore;
  writeStore: LiteWriteStore;
  limit: number;
  offset?: number;
}): Promise<CanonicalL1DatasetPage> {
  const source = await args.episodeStore.listMemoryCompilationCandidates({
    limit: args.limit,
    offset: args.offset,
  });
  const rows = await Promise.all(source.map((candidate) =>
    deriveCanonicalL1EpisodeFromStores({
      episodeStore: args.episodeStore,
      writeStore: args.writeStore,
      tenantId: candidate.tenant_id,
      storeScope: candidate.store_scope,
      episodeId: candidate.episode_id,
    })));
  return { source, rows };
}
