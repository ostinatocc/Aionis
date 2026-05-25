import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import {
  AssociativeLinkTriggerPayloadSchema,
  DeferredAssociativeLinkFollowupSchema,
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
  let enqueuedEmbedNodes = false;
  const associativeLinkSourceNodeIds = selectAssociativeLinkSourceNodeIds(nodes);
  const deferredAssociativeLinkSourceIds = new Set<string>();

  if (prepared.auto_embed_effective) {
    const embedPlanned = nodes
      .filter((node) => !node.embedding && !!node.embed_text)
      .map((node) => ({ id: node.id, text: node.embed_text as string }));

    let embedNodes = embedPlanned;
    if (!prepared.force_reembed && embedNodes.length > 0) {
      const ids = embedNodes.map((node) => node.id);
      const ready = await writeAccess.readyEmbeddingNodeIds(scope, ids);
      if (ready.size > 0) embedNodes = embedNodes.filter((node) => !ready.has(node.id));
    }

    if (embedNodes.length > 0) {
      const embedNodeIdSet = new Set(embedNodes.map((node) => node.id));
      for (const sourceNodeId of associativeLinkSourceNodeIds) {
        if (embedNodeIdSet.has(sourceNodeId)) deferredAssociativeLinkSourceIds.add(sourceNodeId);
      }
      const deferredAssociativeLink =
        deferredAssociativeLinkSourceIds.size > 0
          ? DeferredAssociativeLinkFollowupSchema.parse({
              origin: opts.associativeLinkOrigin ?? "memory_write",
              source_node_ids: Array.from(deferredAssociativeLinkSourceIds),
              source_commit_id: commitId,
            })
          : null;
      const payload = {
        nodes: embedNodes,
        ...(prepared.force_reembed ? { force_reembed: true } : {}),
        ...(deferredAssociativeLink ? { after_associative_link: deferredAssociativeLink } : {}),
      };
      const payloadSha = sha256Hex(stableStringify(payload));
      const jobKey = sha256Hex(stableStringify({ v: 1, scope, commit_id: commitId, event_type: "embed_nodes", payloadSha }));
      await writeAccess.insertOutboxEvent({
        scope,
        commitId,
        eventType: "embed_nodes",
        jobKey,
        payloadSha256: payloadSha,
        payloadJson: JSON.stringify(payload),
      });
      enqueuedEmbedNodes = true;
      result.embedding_backfill = { enqueued: true, pending_nodes: embedNodes.length };
    }
  }

  const immediateAssociativeLinkSourceNodeIds = associativeLinkSourceNodeIds.filter(
    (id) => !deferredAssociativeLinkSourceIds.has(id),
  );
  if (immediateAssociativeLinkSourceNodeIds.length > 0) {
    const payload = AssociativeLinkTriggerPayloadSchema.parse({
      origin: opts.associativeLinkOrigin ?? "memory_write",
      scope,
      source_node_ids: immediateAssociativeLinkSourceNodeIds,
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

  const trigger = (prepared as PreparedWrite & { trigger_topic_cluster?: boolean }).trigger_topic_cluster === true;
  const asyncMode = (prepared as PreparedWrite & { topic_cluster_async?: boolean }).topic_cluster_async === true;

  if (!trigger || !asyncMode) return;

  const eventIds = nodes.filter((node) => node.type === "event").map((node) => node.id);
  const embeddableEventIds = new Set(
    nodes.filter((node) => node.type === "event" && prepared.auto_embed_effective && !!node.embed_text).map((node) => node.id),
  );

  const readyInDb = new Set<string>();
  if (eventIds.length > 0) {
    const ready = await writeAccess.readyEmbeddingNodeIds(scope, eventIds);
    for (const id of ready) readyInDb.add(id);
  }

  const mustWaitForReembed = (id: string) => prepared.force_reembed && embeddableEventIds.has(id);

  const waitForEmbed: string[] = [];
  const runNow: string[] = [];
  for (const id of eventIds) {
    if (mustWaitForReembed(id)) {
      waitForEmbed.push(id);
      continue;
    }
    if (readyInDb.has(id)) {
      runNow.push(id);
      continue;
    }
    if (embeddableEventIds.has(id)) waitForEmbed.push(id);
  }

  if (waitForEmbed.length > 0 && enqueuedEmbedNodes) {
    await writeAccess.appendAfterTopicClusterEventIds(scope, commitId, JSON.stringify(waitForEmbed));
    result.topic_cluster = { enqueued: true };
  }

  if (runNow.length > 0) {
    const payload = { event_ids: runNow };
    const payloadSha = sha256Hex(stableStringify(payload));
    const jobKey = sha256Hex(stableStringify({ v: 1, scope, commit_id: commitId, event_type: "topic_cluster", payloadSha }));
    await writeAccess.insertOutboxEvent({
      scope,
      commitId,
      eventType: "topic_cluster",
      jobKey,
      payloadSha256: payloadSha,
      payloadJson: JSON.stringify(payload),
    });
    result.topic_cluster = { enqueued: true };
  }
}
