import type { WriteStoreAccess } from "../store/write-access.js";
import {
  AssociativeLinkTriggerPayloadSchema,
  type AssociativeLinkTriggerOrigin,
} from "./associative-linking-types.js";
import { selectAssociativeLinkSourceNodeIds } from "./write-shared.js";
import { buildAssociativeLinkOutboxInsert } from "../jobs/associative-linking-lib.js";
import type { PreparedWrite, WriteResult } from "./write.js";

type PostCommitWriteOptions = {
  associativeLinkOrigin?: AssociativeLinkTriggerOrigin;
};

export async function enqueuePostCommitWriteArtifacts(
  writeAccess: WriteStoreAccess,
  prepared: PreparedWrite,
  commitId: string,
  result: WriteResult,
  opts: PostCommitWriteOptions,
): Promise<void> {
  const scope = prepared.scope;
  const nodes = prepared.nodes;
  const associativeLinkSourceNodeIds = selectAssociativeLinkSourceNodeIds(nodes);

  if (associativeLinkSourceNodeIds.length > 0) {
    const payload = AssociativeLinkTriggerPayloadSchema.parse({
      origin: opts.associativeLinkOrigin ?? "memory_write",
      scope,
      source_node_ids: associativeLinkSourceNodeIds,
      source_commit_id: commitId,
    });
    try {
      await writeAccess.insertOutboxEvent(buildAssociativeLinkOutboxInsert({ scope, commitId, payload }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const warnings = result.warnings ?? [];
      warnings.push({
        code: "associative_link_enqueue_failed",
        message: "associative linking enqueue degraded; write succeeded without shadow candidate generation",
        details: {
          origin: payload.origin,
          source_node_count: payload.source_node_ids.length,
          error: message,
        },
      });
      result.warnings = warnings;
    }
  }
}
