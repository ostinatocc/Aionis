import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";

import {
  isLearningExposurePromotionEligible,
  type EventWithoutDigest,
  type ExposureCommittedV1,
  type LearningAction,
  type LearningLedgerItem,
} from "../memory/learning-episode-ledger.js";
import { AionisAgentContextSchema } from "../memory/product-output-contract.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";
import type { SqliteDatabase } from "./sqlite.js";

type PromotionEligibleGuideReceiptRoot = Readonly<{
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  run_id: string | null;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  query_sha256: string;
  context_sha256: string;
  ledger_sha256: string;
  ledger_json: string;
  commit_id: string;
}>;

type PromotionEligibleGuideCommitRoot = Readonly<{
  id: string;
  scope: string;
  input_sha256: string;
}>;

type PromotionEligibleGuideNodeRoot = Readonly<{
  id: string;
  scope: string;
  client_id: string | null;
  type: string;
  slots_json: string;
  memory_lane: string;
  producer_agent_id: string | null;
  commit_id: string;
}>;

type PromotionEligibleGuideOperationRoot = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string | null;
}>;

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rootMismatch(reason: string): never {
  throw new Error(`learning_promotion_eligible_guide_root_mismatch:${reason}`);
}

function rootRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    rootMismatch(`${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function canonicalRootJson(raw: string, field: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rootMismatch(`${field}_invalid`);
  }
  if (stableStringify(parsed) !== raw) rootMismatch(`${field}_noncanonical`);
  return parsed;
}

function rootStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    rootMismatch(`${field}_invalid`);
  }
  return value as string[];
}

function canonicalReasons(values: readonly string[]): string[] {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function canonicalMemoryIds(values: readonly string[]): string[] {
  if (new Set(values).size !== values.length) rootMismatch("guide_surface_duplicate_memory");
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function assertGuideServedSurfaceBinding(
  ledger: Record<string, unknown>,
  payload: ExposureCommittedV1,
  items: readonly LearningLedgerItem[],
): void {
  const servedActionByMemoryId = new Map<string, LearningAction>();
  const addSurface = (field: string, action: LearningAction): void => {
    for (const memoryId of rootStringArray(ledger[field], `guide_ledger_${field}`)) {
      if (servedActionByMemoryId.has(memoryId)) rootMismatch("guide_surface_overlap");
      servedActionByMemoryId.set(memoryId, action);
    }
  };
  addSurface("use_now_memory_ids", "use_now");
  addSurface("inspect_before_use_memory_ids", "inspect_before_use");
  addSurface("do_not_use_memory_ids", "do_not_use");
  addSurface("rehydrate_memory_ids", "rehydrate");

  const ledgerMemoryIds = canonicalMemoryIds(
    rootStringArray(ledger.memory_ids, "guide_ledger_memory_ids"),
  );
  const servedMemoryIds = canonicalMemoryIds([...servedActionByMemoryId.keys()]);
  const relevantMemoryIds = canonicalMemoryIds(payload.relevant_memory_ids);
  const itemMemoryIds = canonicalMemoryIds(items.map((item) => item.memory_id));
  if (ledgerMemoryIds.some((memoryId) => !servedActionByMemoryId.has(memoryId))) {
    rootMismatch("guide_memory_membership");
  }
  if (stableStringify(servedMemoryIds) !== stableStringify(relevantMemoryIds)
    || stableStringify(servedMemoryIds) !== stableStringify(itemMemoryIds)) {
    rootMismatch("guide_served_surface_membership");
  }
  for (const item of items) {
    if (servedActionByMemoryId.get(item.memory_id) !== item.served_action) {
      rootMismatch("guide_served_surface_action");
    }
  }
}

export function assertPromotionEligibleGuideExposureRoots(
  db: SqliteDatabase,
  event: EventWithoutDigest,
  row: LiteLearningAuthorityRow,
  payload: ExposureCommittedV1,
  items: readonly LearningLedgerItem[],
): void {
  if (!isLearningExposurePromotionEligible(payload)) return;
  if (event.source_kind !== "guide_receipt"
    || event.source_id !== payload.guide_trace_id
    || event.source_sha256 !== payload.guide_receipt_sha256
    || event.source_commit_id !== payload.guide_commit_id
    || event.operation_id === null) {
    rootMismatch("event_identity");
  }

  const guideReceipt = db.prepare(
    `SELECT tenant_id, scope, guide_trace_id, run_id, consumer_agent_id, consumer_team_id,
            query_sha256, context_sha256, ledger_sha256, ledger_json, commit_id
     FROM lite_product_guide_receipts
     WHERE tenant_id = ? AND scope = ? AND guide_trace_id = ?`,
  ).get(
    event.tenant_id,
    event.scope,
    payload.guide_trace_id,
  ) as PromotionEligibleGuideReceiptRoot | undefined;
  if (!guideReceipt
    || guideReceipt.ledger_sha256 !== payload.guide_receipt_sha256
    || guideReceipt.commit_id !== payload.guide_commit_id
    || guideReceipt.run_id !== event.run_id) {
    rootMismatch("guide_receipt_binding");
  }
  if (sha256Text(guideReceipt.ledger_json) !== guideReceipt.ledger_sha256) {
    rootMismatch("guide_receipt_digest");
  }
  const ledger = rootRecord(canonicalRootJson(guideReceipt.ledger_json, "guide_ledger"), "guide_ledger");
  if (ledger.contract_version !== "aionis_guide_exposure_v1"
    || ledger.guide_trace_id !== payload.guide_trace_id
    || ledger.tenant_id !== event.tenant_id
    || ledger.scope !== event.scope
    || (ledger.run_id ?? null) !== event.run_id
    || (ledger.consumer_agent_id ?? null) !== guideReceipt.consumer_agent_id
    || (ledger.consumer_team_id ?? null) !== guideReceipt.consumer_team_id
    || ledger.query_sha256 !== guideReceipt.query_sha256
    || ledger.context_sha256 !== guideReceipt.context_sha256) {
    rootMismatch("guide_ledger_identity");
  }
  assertGuideServedSurfaceBinding(ledger, payload, items);

  const commit = db.prepare(
    `SELECT id, scope, input_sha256 FROM lite_memory_commits WHERE id = ?`,
  ).get(payload.guide_commit_id) as PromotionEligibleGuideCommitRoot | undefined;
  if (!commit || commit.input_sha256 !== payload.guide_receipt_sha256) {
    rootMismatch("memory_commit_binding");
  }
  if (sha256Text(commit.scope) !== payload.memory_namespace_sha256) {
    rootMismatch("memory_commit_namespace_binding");
  }
  const nodes = db.prepare(
    `SELECT id, scope, client_id, type, slots_json, memory_lane, producer_agent_id, commit_id
     FROM lite_memory_nodes
     WHERE commit_id = ? AND client_id = ?`,
  ).all(
    payload.guide_commit_id,
    payload.guide_trace_id,
  ) as PromotionEligibleGuideNodeRoot[];
  if (nodes.length !== 1) rootMismatch("guide_source_node_cardinality");
  const node = nodes[0]!;
  if (node.scope !== commit.scope
    || node.commit_id !== commit.id
    || node.type !== "evidence"
    || node.memory_lane !== "shared"
    || node.producer_agent_id !== "aionis-runtime") {
    rootMismatch("guide_source_node_binding");
  }
  let slots: Record<string, unknown>;
  try {
    slots = rootRecord(JSON.parse(node.slots_json), "guide_source_node_slots");
  } catch {
    return rootMismatch("guide_source_node_slots_invalid");
  }
  if (slots.not_agent_facing !== true
    || stableStringify(slots.guide_exposure_v1) !== stableStringify(ledger)) {
    rootMismatch("guide_source_node_ledger_binding");
  }

  const operation = db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256, receipt_json, commit_id
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = 'product_guide_v1' AND operation_id = ?`,
  ).get(
    event.tenant_id,
    event.scope,
    event.operation_id,
  ) as PromotionEligibleGuideOperationRoot | undefined;
  if (!operation
    || operation.request_sha256 !== payload.request_sha256
    || operation.commit_id !== payload.guide_commit_id) {
    rootMismatch("protected_operation_binding");
  }
  const receipt = rootRecord(
    canonicalRootJson(operation.receipt_json, "product_guide_operation_receipt"),
    "protected_operation_receipt",
  );
  const body = rootRecord(receipt.body, "protected_operation_body");
  const sourceMap = rootRecord(body.source_map, "protected_operation_source_map");
  const policy = rootRecord(sourceMap.admission_candidate_policy, "protected_operation_policy");
  const policyReasons = rootStringArray(policy.reason_codes, "protected_operation_policy_reasons");
  if (receipt.ok !== true
    || receipt.statusCode !== 200
    || body.contract_version !== "aionis_guide_result_v1"
    || body.operation_id !== event.operation_id
    || body.tenant_id !== event.tenant_id
    || body.scope !== event.scope
    || body.guide_trace_id !== payload.guide_trace_id
    || policy.serving_authority !== "experiment"
    || policy.serving_arm !== payload.served_arm
    || policy.enrollment_state !== "enrolled"
    || policy.promotion_eligible !== true
    || policy.collection_class !== "eligible_host"
    || policy.profile_id !== row.profile_id
    || policy.experiment_id !== row.experiment_id
    || policy.experiment_revision !== row.experiment_revision
    || policy.experiment_config_sha256 !== payload.experiment_config_sha256
    || stableStringify(canonicalReasons(policyReasons))
      !== stableStringify(canonicalReasons(payload.assignment_reason_codes))) {
    rootMismatch("protected_operation_receipt_identity");
  }
  const parsedAgentContext = AionisAgentContextSchema.safeParse(body.agent_context);
  if (!parsedAgentContext.success
    || stableStringify(parsedAgentContext.data) !== stableStringify(body.agent_context)) {
    rootMismatch("protected_operation_agent_context_schema");
  }
  const agentContext = parsedAgentContext.data;
  const rehydrateHints = agentContext.rehydrate_hints.map((entry) => entry.memory_id);
  if (agentContext.tenant_id !== event.tenant_id
    || agentContext.scope !== event.scope
    || stableStringify(agentContext.memory_ids) !== stableStringify(ledger.memory_ids)
    || stableStringify(agentContext.use_now_memory_ids) !== stableStringify(ledger.use_now_memory_ids)
    || stableStringify(agentContext.inspect_before_use_memory_ids)
      !== stableStringify(ledger.inspect_before_use_memory_ids)
    || stableStringify(agentContext.do_not_use_memory_ids) !== stableStringify(ledger.do_not_use_memory_ids)
    || stableStringify(rehydrateHints) !== stableStringify(ledger.rehydrate_memory_ids)
    || agentContext.prompt_text.length !== ledger.prompt_char_count
    || agentContext.history_used !== ledger.history_used
    || agentContext.actionable_history_used !== ledger.actionable_history_used
    || agentContext.recommended_posture !== ledger.recommended_posture
    || agentContext.authority !== ledger.authority) {
    rootMismatch("protected_operation_agent_context_binding");
  }
}
