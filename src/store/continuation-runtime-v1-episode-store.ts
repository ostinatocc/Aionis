import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
  type ContinuationContractV1,
  type Sha256,
} from "../continuation/contract.js";
import { verifyClosedContinuationExposureProjectionV1 } from
  "../continuation/contract-verifier.js";
import {
  buildEpisodeCapsuleFactSetV1,
  buildEpisodeCapsuleFactV1,
  buildEpisodeEventV1,
  episodeEventRefV1,
  verifyEpisodeCapsuleFactSetV1,
  verifyEpisodeCapsuleFactV1,
  verifyEpisodeEventBundleV1,
  verifyEpisodeEventV1,
  type EpisodeCapsuleFactInputV1,
  type EpisodeCapsuleFactSetV1,
  type EpisodeCapsuleFactV1,
  type EpisodeEventRefV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import {
  verifyHostUseReceiptV1,
  verifyOutcomeReceiptV1,
  type HostUseReceiptV1,
  type OutcomeReceiptV1,
} from "../continuation/outcome.js";
import {
  consumeVerifiedCompiledContinuationCapabilityV1,
  type VerifiedCompiledContinuationCapabilityV1,
} from "../runtime-v1/decision-assembly.js";
import type { ContinuationRuntimeV1Database } from "./continuation-runtime-v1-database.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "./continuation-runtime-v1-operation-result-derivation.js";
import { assertContinuationRuntimeV1OperationResultDeclaration } from
  "./continuation-runtime-v1-operation-result-support.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  constrainContinuationRuntimeV1OperationCompletion,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

export type { HostCapsuleUseV1, HostUseReceiptV1, OutcomeReceiptV1 } from
  "../continuation/outcome.js";
export type EpisodeAppendResultV1 = Readonly<{
  schema_version: "episode_append_result_v1";
  episode_id: string;
  decision_id: string;
  event_refs: readonly EpisodeEventRefV1[];
}>;
export type PersistedEpisodeV1 = Readonly<{
  tenant_id: string;
  scope: string;
  episode_id: string;
  events: readonly EpisodeEventV1[];
  capsule_fact_sets: readonly EpisodeCapsuleFactSetV1[];
}>;
export type AppendEpisodeOutcomeV1 = Readonly<{
  decision_id: string;
  use_receipt: HostUseReceiptV1;
  outcome_receipt: OutcomeReceiptV1;
}>;
export type ContinuationRuntimeV1EpisodeStore = Readonly<{
  appendExposure(context: ContinuationRuntimeV1AuthorityWriteContext,
    capability: VerifiedCompiledContinuationCapabilityV1): Promise<EpisodeAppendResultV1>;
  appendOutcomeBundle(context: ContinuationRuntimeV1AuthorityWriteContext,
    input: AppendEpisodeOutcomeV1): Promise<EpisodeAppendResultV1>;
  readEpisode(tenantId: string, scope: string, episodeId: string): Promise<PersistedEpisodeV1 | null>;
  readDecision(tenantId: string, scope: string, decisionId: string): Promise<readonly EpisodeEventV1[]>;
  readRun(tenantId: string, scope: string, runId: string): Promise<readonly EpisodeEventV1[]>;
}>;
export type ContinuationRuntimeV1EpisodeStoreOptions = Readonly<{ now?: () => string }>;

type Row = Readonly<Record<string, unknown>>;
const MUTATION_CONTEXTS = new WeakSet<object>();

function fail(code: string): never { throw new Error(`continuation_runtime_v1_episode_${code}`); }
function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, field);
  if (!value || value !== value.trim() || Buffer.byteLength(value, "utf8") > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${field}_invalid`);
  return value;
}
function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, field); return value;
}
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field}_invalid`);
  return value as number;
}
function time(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, field); return value;
}
function jsonObject(value: unknown, field: string): Readonly<Record<string, CanonicalJson>> {
  if (typeof value !== "string") fail(`corrupt:${field}`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail(`corrupt:${field}`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== value) fail(`corrupt:${field}`);
  return parsed as Readonly<Record<string, CanonicalJson>>;
}

function source(lineage: ContinuationRuntimeV1OperationLineageV1) {
  return { operation_kind: lineage.operation_kind as "create_continuation" | "record_outcome",
    operation_id: lineage.operation_id, request_sha256: lineage.request_sha256 };
}
function eventId(lineage: ContinuationRuntimeV1OperationLineageV1, episodeId: string,
  sequence: number, kind: string): string {
  return `evt-${sequence}-${canonicalContinuationSha256({ lineage, episode_id: episodeId,
    event_sequence: sequence, event_kind: kind }).slice(0, 32)}`;
}
function head(database: ContinuationRuntimeV1Database, tenant: string, scope: string,
  episode: string): EpisodeEventV1 | null {
  const row = database.db.prepare(`SELECT * FROM episode_events WHERE tenant_id=? AND scope=?
    AND episode_id=? ORDER BY event_sequence DESC LIMIT 1`).get(tenant, scope, episode) as Row | undefined;
  return row ? eventFromRow(database, row) : null;
}
function eventFromRow(database: ContinuationRuntimeV1Database, row: Row): EpisodeEventV1 {
  const previous = row.previous_event_sequence === null ? null : {
    event_sequence: integer(row.previous_event_sequence, "corrupt:previous_sequence"),
    event_id: text(lookupPrevious(database, row)?.event_id, "corrupt:previous_id"),
    event_kind: lookupPrevious(database, row)?.event_kind as EpisodeEventRefV1["event_kind"],
    event_sha256: sha(row.previous_event_sha256, "corrupt:previous_sha") };
  const cause = row.cause_event_sequence === null ? null : {
    event_sequence: integer(row.cause_event_sequence, "corrupt:cause_sequence"),
    event_id: text(row.cause_event_id, "corrupt:cause_id"),
    event_kind: row.cause_event_kind as EpisodeEventRefV1["event_kind"],
    event_sha256: sha(row.cause_event_sha256, "corrupt:cause_sha") };
  const event = verifyEpisodeEventV1({ schema_version: "episode_event_v1",
    tenant_id: text(row.tenant_id, "corrupt:tenant_id"), scope: text(row.scope, "corrupt:scope"),
    episode_id: text(row.episode_id, "corrupt:episode_id"),
    event_sequence: integer(row.event_sequence, "corrupt:event_sequence"),
    event_id: text(row.event_id, "corrupt:event_id"), event_kind: row.event_kind,
    source_operation: { operation_kind: row.source_operation_kind,
      operation_id: text(row.source_operation_id, "corrupt:operation_id"),
      request_sha256: sha(row.source_request_sha256, "corrupt:request_sha") },
    previous_event_ref: previous, cause_event_ref: cause,
    context: { context_kind: "decision", decision_id: text(row.decision_id, "corrupt:decision_id"),
      run_id: text(row.run_id, "corrupt:run_id"),
      host_task_envelope_sha256: sha(row.host_task_envelope_sha256, "corrupt:task_sha"),
      contract_sha256: sha(row.contract_sha256, "corrupt:contract_sha"),
      coverage_certificate_sha256: sha(row.coverage_certificate_sha256, "corrupt:coverage_sha"),
      render_result_sha256: sha(row.render_result_sha256, "corrupt:render_sha"),
      authority_subject_sha256: sha(row.authority_subject_sha256, "corrupt:subject_sha"),
      branch_manifest_sha256: sha(row.branch_manifest_sha256, "corrupt:manifest_sha") },
    render_result_sha256: sha(row.render_result_sha256, "corrupt:render_sha"),
    effect_certificate_sha256: row.effect_certificate_sha256,
    effect_member_sequence: row.effect_member_sequence,
    capsule_fact_count: row.capsule_fact_count,
    capsule_fact_set_sha256: row.capsule_fact_set_sha256,
    payload: jsonObject(row.payload_json, "payload_json"),
    created_at: time(row.created_at, "corrupt:created_at"),
    payload_sha256: sha(row.payload_sha256, "corrupt:payload_sha"),
    event_sha256: sha(row.event_sha256, "corrupt:event_sha") });
  if (event.event_kind === "contract_exposed") {
    const payload = event.payload as Extract<EpisodeEventV1["payload"], {
      payload_kind: "contract_exposed_v1";
    }>;
    const exposure = verifyClosedContinuationExposureProjectionV1({
      contract: payload.continuation_contract,
      renderResult: payload.render_result,
    });
    const authority = exposure.contract.authority;
    const cohort = authority.experiment_cohort_ref;
    const receipt = authority.serving_assignment_receipt;
    if (row.serving_mode !== authority.serving_mode
      || (authority.serving_mode === "authoritative_unassigned"
        ? cohort !== null || receipt !== null
          || row.experiment_cohort_artifact_sha256 !== null
          || row.experiment_cohort_payload_sha256 !== null
          || row.serving_assignment_receipt_sha256 !== null
        : cohort === null || receipt === null
          || row.experiment_cohort_artifact_sha256 !== cohort.artifact_sha256
          || row.experiment_cohort_payload_sha256 !== cohort.payload_sha256
          || row.serving_assignment_receipt_sha256
            !== receipt.serving_assignment_receipt_sha256)) {
      fail("corrupt:serving_projection");
    }
  } else if (row.serving_mode !== null
    || row.experiment_cohort_artifact_sha256 !== null
    || row.experiment_cohort_payload_sha256 !== null
    || row.serving_assignment_receipt_sha256 !== null) {
    fail("corrupt:serving_projection");
  }
  return event;
}
function lookupPrevious(database: ContinuationRuntimeV1Database, row: Row): Row | undefined {
  return database.db.prepare(`SELECT event_id,event_kind FROM episode_events WHERE tenant_id=? AND scope=?
    AND episode_id=? AND event_sequence=? AND event_sha256=?`).get(row.tenant_id, row.scope,
      row.episode_id, row.previous_event_sequence, row.previous_event_sha256) as Row | undefined;
}

function cohortSettlementWindow(
  database: ContinuationRuntimeV1Database,
  exposureRow: Row,
): Readonly<{ outcome_deadline: string; settlement_cutoff_at: string }> | null {
  if (exposureRow.serving_mode === "authoritative_unassigned") return null;
  if (exposureRow.serving_mode !== "assigned_control"
    && exposureRow.serving_mode !== "assigned_candidate") {
    fail("corrupt:exposure_serving_mode");
  }
  const row = database.db.prepare(`SELECT
      json_extract(payload_json, '$.outcome_deadline') AS outcome_deadline,
      json_extract(payload_json, '$.settlement_cutoff_at') AS settlement_cutoff_at
    FROM authority_artifacts
    WHERE tenant_id=? AND artifact_kind='experiment_cohort'
      AND artifact_sha256=? AND payload_sha256=?`).get(
        exposureRow.tenant_id,
        exposureRow.experiment_cohort_artifact_sha256,
        exposureRow.experiment_cohort_payload_sha256,
      ) as Row | undefined;
  if (!row) fail("corrupt:experiment_cohort_missing");
  return {
    outcome_deadline: time(row.outcome_deadline, "corrupt:outcome_deadline"),
    settlement_cutoff_at: time(
      row.settlement_cutoff_at,
      "corrupt:settlement_cutoff_at",
    ),
  };
}

function insertEvent(
  database: ContinuationRuntimeV1Database,
  event: EpisodeEventV1,
  serving: Readonly<{
    mode: ContinuationContractV1["authority"]["serving_mode"];
    artifact_sha256: Sha256 | null;
    payload_sha256: Sha256 | null;
    receipt_sha256: Sha256 | null;
  }> | null = null,
): void {
  const previous = event.previous_event_ref; const cause = event.cause_event_ref;
  database.db.prepare(`INSERT INTO episode_events(tenant_id,scope,episode_id,event_sequence,event_id,
    event_kind,source_operation_kind,source_operation_id,source_request_sha256,
    previous_event_sequence,previous_event_sha256,cause_event_sequence,cause_event_id,cause_event_kind,
    cause_event_sha256,effect_member_sequence,capsule_fact_count,capsule_fact_set_sha256,decision_id,run_id,
    host_task_envelope_sha256,contract_sha256,coverage_certificate_sha256,render_result_sha256,
    authority_subject_sha256,branch_manifest_sha256,serving_mode,
    experiment_cohort_artifact_sha256,experiment_cohort_payload_sha256,
    serving_assignment_receipt_sha256,effect_certificate_sha256,
    payload_sha256,payload_json,event_sha256,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.tenant_id,event.scope,event.episode_id,event.event_sequence,event.event_id,event.event_kind,
      event.source_operation.operation_kind,event.source_operation.operation_id,event.source_operation.request_sha256,
      previous?.event_sequence ?? null,previous?.event_sha256 ?? null,cause?.event_sequence ?? null,
      cause?.event_id ?? null,cause?.event_kind ?? null,cause?.event_sha256 ?? null,event.effect_member_sequence,
      event.capsule_fact_count,event.capsule_fact_set_sha256,event.context.decision_id,event.context.run_id,
      event.context.host_task_envelope_sha256,event.context.contract_sha256,
      event.context.coverage_certificate_sha256,event.render_result_sha256,
      event.context.authority_subject_sha256,event.context.branch_manifest_sha256,
      serving?.mode ?? null,serving?.artifact_sha256 ?? null,
      serving?.payload_sha256 ?? null,serving?.receipt_sha256 ?? null,
      event.effect_certificate_sha256,
      event.payload_sha256,canonicalContinuationJson(event.payload),
      event.event_sha256,event.created_at);
}
function insertFacts(database: ContinuationRuntimeV1Database, event: EpisodeEventV1,
  set: EpisodeCapsuleFactSetV1): void {
  for (const fact of set.facts) {
    const record = buildEpisodeCapsuleFactV1({ tenant_id: event.tenant_id, scope: event.scope,
      episode_id: event.episode_id, event_ref: episodeEventRefV1(event) as never, fact });
    database.db.prepare(`INSERT INTO episode_capsule_facts(tenant_id,scope,episode_id,event_sequence,
      event_id,event_kind,event_sha256,fact_sequence,capsule_scope,capsule_id,capsule_revision,
      capsule_sha256,surface,use_state,fact_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.tenant_id,record.scope,record.episode_id,record.event_ref.event_sequence,
        record.event_ref.event_id,record.event_ref.event_kind,record.event_ref.event_sha256,
        fact.fact_sequence,fact.capsule_scope,fact.capsule_id,fact.capsule_revision,fact.capsule_sha256,
        fact.surface,fact.use_state,record.fact_sha256);
  }
}
function decisionContext(contract: ContinuationContractV1, renderSha: Sha256) {
  return { context_kind: "decision" as const, decision_id: contract.identity.decision_id,
    run_id: contract.identity.run_id, host_task_envelope_sha256: contract.identity.host_task_envelope_sha256,
    contract_sha256: contract.contract_sha256,
    coverage_certificate_sha256: contract.coverage_certificate.certificate_sha256,
    render_result_sha256: renderSha, authority_subject_sha256: contract.authority.authority_subject_sha256,
    branch_manifest_sha256: contract.authority.served_learning_branch.manifest_sha256 };
}
function assertExposureAuthority(database:ContinuationRuntimeV1Database,contract:ContinuationContractV1,
  facts:EpisodeCapsuleFactSetV1):void{
  const branch=database.db.prepare(`SELECT branch_id,branch_revision FROM branch_revisions
    WHERE tenant_id=? AND authority_subject_sha256=? AND manifest_sha256=?`).get(contract.identity.tenant_id,
      contract.authority.authority_subject_sha256,
      contract.authority.served_learning_branch.manifest_sha256) as Row|undefined;
  if(!branch||branch.branch_id!==contract.authority.served_learning_branch.branch_id
    ||branch.branch_revision!==contract.authority.served_learning_branch.branch_revision){
    fail("served_learning_branch_missing");
  }
  for(const fact of facts.facts){
    const capsule=database.db.prepare(`SELECT capsule_kind FROM capsule_revisions
      WHERE tenant_id=? AND scope=? AND capsule_id=? AND capsule_revision=?
        AND capsule_sha256=? AND source_commit_revision<=?`).get(
          contract.identity.tenant_id,fact.capsule_scope,fact.capsule_id,
          fact.capsule_revision,fact.capsule_sha256,
          contract.authority.memory_scope_head_revision) as Row|undefined;
    if(!capsule)fail("selected_capsule_missing_at_memory_head");
    if((capsule.capsule_kind==="procedure"||capsule.capsule_kind==="counter_evidence")
      && !database.db.prepare(`SELECT 1 AS present FROM branch_capsule_bindings
        WHERE tenant_id=? AND branch_id=? AND branch_revision=? AND capsule_scope=?
          AND capsule_id=? AND capsule_revision=? AND capsule_sha256=?`).get(
            contract.identity.tenant_id,
            contract.authority.served_learning_branch.branch_id,
            contract.authority.served_learning_branch.branch_revision,
            fact.capsule_scope,fact.capsule_id,fact.capsule_revision,fact.capsule_sha256)){
      fail("selected_learning_capsule_not_bound_to_served_branch");
    }
  }
}
function result(episode: string, decision: string, events: readonly EpisodeEventV1[]): EpisodeAppendResultV1 {
  return canonicalContinuationClone({ schema_version: "episode_append_result_v1" as const,
    episode_id: episode, decision_id: decision, event_refs: events.map(episodeEventRefV1) });
}

export function createContinuationRuntimeV1EpisodeStore(database: ContinuationRuntimeV1Database,
  options: ContinuationRuntimeV1EpisodeStoreOptions = {}): ContinuationRuntimeV1EpisodeStore {
  const now = options.now ?? (() => new Date().toISOString());
  async function mutate<T>(context: ContinuationRuntimeV1AuthorityWriteContext,
    kind: "create_continuation" | "record_outcome", fn: (lineage: ContinuationRuntimeV1OperationLineageV1) => T): Promise<T> {
    const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
    if (binding.operationKind !== kind || binding.actorKind !== "trusted_host") fail("write_context_forbidden");
    if (MUTATION_CONTEXTS.has(context as object)) fail("write_context_already_consumed");
    MUTATION_CONTEXTS.add(context as object);
    return fn(continuationRuntimeV1OperationLineage(binding));
  }
  return {
    appendExposure(context, capability) { return mutate(context, "create_continuation", (lineage) => {
      const verified = consumeVerifiedCompiledContinuationCapabilityV1(
        capability,
        database,
        context,
      );
      const contract = verified.continuation_contract;
      const render = verified.render_result;
      if (contract.identity.tenant_id !== lineage.tenant_id || contract.identity.scope !== lineage.scope) {
        fail("exposure_operation_scope_mismatch");
      }
      const facts = buildEpisodeCapsuleFactSetV1("contract_exposed", contract.selected_capsules.map(
        (selection): EpisodeCapsuleFactInputV1 => ({ capsule_scope: contract.identity.scope,
          capsule_id: selection.capsule.capsule_id, capsule_revision: selection.capsule.capsule_revision,
          capsule_sha256: selection.capsule.capsule_sha256, surface: selection.surface, use_state: null })));
      assertExposureAuthority(database,contract,facts);
      const previous = head(database,lineage.tenant_id,lineage.scope,contract.identity.episode_id);
      const sequence = (previous?.event_sequence ?? 0) + 1; const created = time(now(), "created_at");
      const event = buildEpisodeEventV1({ tenant_id: lineage.tenant_id, scope: lineage.scope,
        episode_id: contract.identity.episode_id, event_sequence: sequence,
        event_id: eventId(lineage,contract.identity.episode_id,sequence,"contract_exposed"),
        event_kind: "contract_exposed", source_operation: source(lineage),
        previous_event_ref: previous ? episodeEventRefV1(previous) : null, cause_event_ref: null,
        context: decisionContext(contract,render.render_result_sha256),
        render_result_sha256: render.render_result_sha256,effect_certificate_sha256:null,
        effect_member_sequence:null,capsule_fact_count:facts.capsule_fact_count,
        capsule_fact_set_sha256:facts.capsule_fact_set_sha256,
        payload:{payload_kind:"contract_exposed_v1",continuation_contract:contract as never,
          render_result:render as never},created_at:created });
      const cohortRef = contract.authority.experiment_cohort_ref;
      const assignmentReceipt = contract.authority.serving_assignment_receipt;
      if ((cohortRef === null) !== (assignmentReceipt === null)) {
        fail("serving_projection_invalid");
      }
      insertEvent(database,event,{
        mode: contract.authority.serving_mode,
        artifact_sha256: cohortRef?.artifact_sha256 ?? null,
        payload_sha256: cohortRef?.payload_sha256 ?? null,
        receipt_sha256: assignmentReceipt?.serving_assignment_receipt_sha256 ?? null,
      });
      insertFacts(database,event,facts);
      return result(event.episode_id,event.context.decision_id,[event]);
    }); },
    appendOutcomeBundle(context, input) { return mutate(context,"record_outcome",(lineage) => {
      const decision = text(input.decision_id,"decision_id");
      const exposureRow = database.db.prepare(`SELECT * FROM episode_events WHERE tenant_id=? AND scope=?
        AND decision_id=? AND event_kind='contract_exposed'`).get(lineage.tenant_id,lineage.scope,decision) as Row|undefined;
      if (!exposureRow) fail("exposure_not_found");
      const exposure=eventFromRow(database,exposureRow);
      const settlementWindow=cohortSettlementWindow(database,exposureRow);
      if (settlementWindow) {
        constrainContinuationRuntimeV1OperationCompletion(
          context,
          database,
          settlementWindow.settlement_cutoff_at,
        );
      }
      const use=verifyHostUseReceiptV1(input.use_receipt);
      const outcome=verifyOutcomeReceiptV1(input.outcome_receipt);
      if (use.decision_id!==decision || outcome.decision_id!==decision
        || use.render_result_sha256!==exposure.render_result_sha256
        || Date.parse(use.observed_at)<Date.parse(exposure.created_at)
        || Date.parse(outcome.observed_at)<Date.parse(use.observed_at)) fail("outcome_receipt_binding");
      if (settlementWindow
        && outcome.observed_at > settlementWindow.outcome_deadline) {
        fail("outcome_deadline_exceeded");
      }
      const exposureFacts=readFactSet(database,exposure);
      const uses=buildEpisodeCapsuleFactSetV1("capsule_use_observed",use.capsule_uses);
      if (uses.capsule_fact_count!==exposureFacts.capsule_fact_count
        || uses.facts.some((fact,index)=>{const prior=exposureFacts.facts[index]; return !prior
          || fact.capsule_scope!==prior.capsule_scope || fact.capsule_id!==prior.capsule_id
          || fact.capsule_revision!==prior.capsule_revision || fact.capsule_sha256!==prior.capsule_sha256
          || fact.surface!==prior.surface;})) fail("use_receipt_surface_mismatch");
      const current=head(database,lineage.tenant_id,lineage.scope,exposure.episode_id);
      const created=time(now(),"created_at"); if (Date.parse(created)<Date.parse(outcome.observed_at)) fail("receipt_from_future");
      if (settlementWindow && created > settlementWindow.settlement_cutoff_at) {
        fail("settlement_cutoff_exceeded");
      }
      const useSeq=(current?.event_sequence??0)+1;
      const useEvent=buildEpisodeEventV1({tenant_id:lineage.tenant_id,scope:lineage.scope,
        episode_id:exposure.episode_id,event_sequence:useSeq,
        event_id:eventId(lineage,exposure.episode_id,useSeq,"capsule_use_observed"),
        event_kind:"capsule_use_observed",source_operation:source(lineage),
        previous_event_ref:current?episodeEventRefV1(current):null,cause_event_ref:episodeEventRefV1(exposure),
        context:exposure.context,render_result_sha256:exposure.render_result_sha256,
        effect_certificate_sha256:null,effect_member_sequence:null,capsule_fact_count:uses.capsule_fact_count,
        capsule_fact_set_sha256:uses.capsule_fact_set_sha256,
        payload:{payload_kind:"capsule_use_observed_v1",use_receipt:use as never},created_at:created});
      insertEvent(database,useEvent); insertFacts(database,useEvent,uses);
      const outcomeSeq=useSeq+1;
      const outcomeEvent=buildEpisodeEventV1({tenant_id:lineage.tenant_id,scope:lineage.scope,
        episode_id:exposure.episode_id,event_sequence:outcomeSeq,
        event_id:eventId(lineage,exposure.episode_id,outcomeSeq,"outcome_observed"),
        event_kind:"outcome_observed",source_operation:source(lineage),previous_event_ref:episodeEventRefV1(useEvent),
        cause_event_ref:episodeEventRefV1(useEvent),context:exposure.context,
        render_result_sha256:exposure.render_result_sha256,effect_certificate_sha256:null,
        effect_member_sequence:null,capsule_fact_count:null,capsule_fact_set_sha256:null,
        payload:{payload_kind:"outcome_observed_v1",outcome_receipt:outcome as never},created_at:created});
      insertEvent(database,outcomeEvent); return result(exposure.episode_id,decision,[useEvent,outcomeEvent]);
    }); },
    readEpisode(tenant,scope,episode) { text(tenant,"tenant_id");text(scope,"scope");text(episode,"episode_id");
      return database.read(()=>readEpisodeSync(database,tenant,scope,episode)); },
    async readDecision(tenant,scope,decision) { text(decision,"decision_id");
      const rows=await database.read(()=>database.db.prepare(`SELECT DISTINCT episode_id FROM episode_events
        WHERE tenant_id=? AND scope=? AND decision_id=?`).all(tenant,scope,decision) as Row[]);
      if(rows.length===0)return Object.freeze([]); if(rows.length!==1)fail("corrupt:decision_episode_ambiguity");
      const episode=await this.readEpisode(tenant,scope,text(rows[0]!.episode_id,"episode_id"));
      return canonicalContinuationClone(episode!.events.filter((event)=>event.context.decision_id===decision)); },
    async readRun(tenant,scope,runId) { text(runId,"run_id");
      const rows=await database.read(()=>database.db.prepare(`SELECT DISTINCT episode_id FROM episode_events
        WHERE tenant_id=? AND scope=? AND run_id=? ORDER BY episode_id`).all(tenant,scope,runId) as Row[]);
      const events:EpisodeEventV1[]=[]; for(const row of rows){const episode=await this.readEpisode(tenant,scope,
        text(row.episode_id,"episode_id")); events.push(...episode!.events.filter((event)=>event.context.run_id===runId));}
      return canonicalContinuationClone(events); }
  };
}

function readFactSet(database: ContinuationRuntimeV1Database,event:EpisodeEventV1):EpisodeCapsuleFactSetV1{
  const rows=database.db.prepare(`SELECT * FROM episode_capsule_facts WHERE tenant_id=? AND scope=?
    AND episode_id=? AND event_sequence=? ORDER BY fact_sequence`).all(event.tenant_id,event.scope,
      event.episode_id,event.event_sequence) as Row[];
  const records:EpisodeCapsuleFactV1[]=rows.map((row)=>verifyEpisodeCapsuleFactV1({
    schema_version:"episode_capsule_fact_v1",tenant_id:row.tenant_id,scope:row.scope,episode_id:row.episode_id,
    event_ref:episodeEventRefV1(event),fact:{fact_sequence:row.fact_sequence,capsule_scope:row.capsule_scope,
      capsule_id:row.capsule_id,capsule_revision:row.capsule_revision,capsule_sha256:row.capsule_sha256,
      surface:row.surface,use_state:row.use_state},fact_sha256:row.fact_sha256}));
  return verifyEpisodeCapsuleFactSetV1({schema_version:"episode_capsule_fact_set_v1",
    event_kind:event.event_kind,facts:records.map((record)=>record.fact),capsule_fact_count:event.capsule_fact_count,
    capsule_fact_set_sha256:event.capsule_fact_set_sha256});
}
function readEpisodeSync(database:ContinuationRuntimeV1Database,tenant:string,scope:string,episodeId:string):PersistedEpisodeV1|null{
  const rows=database.db.prepare(`SELECT * FROM episode_events WHERE tenant_id=? AND scope=? AND episode_id=?
    ORDER BY event_sequence`).all(tenant,scope,episodeId) as Row[]; if(rows.length===0)return null;
  const events=verifyEpisodeEventBundleV1(rows.map((row)=>eventFromRow(database,row)));
  const sets:EpisodeCapsuleFactSetV1[]=[];
  for(const event of events){if(event.event_kind==="contract_exposed"||event.event_kind==="capsule_use_observed")sets.push(readFactSet(database,event));
    if(event.event_kind==="contract_exposed"){const payload=event.payload as Extract<typeof event.payload,{payload_kind:"contract_exposed_v1"}>;
      const verified=verifyClosedContinuationExposureProjectionV1({
        contract:payload.continuation_contract,
        renderResult:payload.render_result,
      });
      if(verified.contract.contract_sha256!==event.context.contract_sha256
        ||verified.renderResult.render_result_sha256!==event.render_result_sha256)fail("corrupt:exposure_payload_binding");
      const set=sets[sets.length-1]!;const expected=buildEpisodeCapsuleFactSetV1("contract_exposed",
        verified.contract.selected_capsules.map((selection)=>({capsule_scope:verified.contract.identity.scope,
          capsule_id:selection.capsule.capsule_id,capsule_revision:selection.capsule.capsule_revision,
          capsule_sha256:selection.capsule.capsule_sha256,surface:selection.surface,use_state:null})));
      if(canonicalContinuationJson(set)!==canonicalContinuationJson(expected))fail("corrupt:exposure_fact_set");
      assertExposureAuthority(database,verified.contract,set);}}
  for(const event of events)verifyOperationReceipt(database,event);
  return canonicalContinuationClone({tenant_id:tenant,scope,episode_id:episodeId,events,capsule_fact_sets:sets});
}
function verifyOperationReceipt(database:ContinuationRuntimeV1Database,event:EpisodeEventV1):void{
  const row=database.db.prepare(`SELECT actor_kind,actor_principal_sha256,receipt_json,receipt_sha256 FROM operations
    WHERE tenant_id=? AND scope=? AND operation_kind=? AND operation_id=? AND request_sha256=?`).get(
      event.tenant_id,event.scope,event.source_operation.operation_kind,event.source_operation.operation_id,
      event.source_operation.request_sha256) as Row|undefined;
  if(!row||row.actor_kind!=="trusted_host")fail("corrupt:source_operation");
  const receipt=jsonObject(row.receipt_json,"receipt_json");
  if(canonicalContinuationSha256(receipt)!==row.receipt_sha256)fail("corrupt:receipt_digest");
  if(receipt.schema_version!=="continuation_runtime_operation_receipt_v1"
    ||receipt.tenant_id!==event.tenant_id||receipt.scope!==event.scope
    ||receipt.operation_kind!==event.source_operation.operation_kind
    ||receipt.operation_id!==event.source_operation.operation_id
    ||receipt.request_sha256!==event.source_operation.request_sha256
    ||receipt.actor_kind!=="trusted_host"||receipt.actor_principal_sha256!==row.actor_principal_sha256){
    fail("corrupt:receipt_lineage");}
  let derived;
  try {
    derived=deriveContinuationRuntimeV1OperationResultV1(database,{
      tenantId:event.tenant_id,scope:event.scope,
      operationKind:event.source_operation.operation_kind,
      operationId:event.source_operation.operation_id,
      requestSha256:event.source_operation.request_sha256,
      actorKind:"trusted_host",
      actorPrincipalSha256:sha(row.actor_principal_sha256,"corrupt:actor_principal_sha256"),
    },"replay",receipt.result);
    assertContinuationRuntimeV1OperationResultDeclaration(receipt.result,derived);
  } catch { fail("corrupt:receipt_result_mismatch"); }
}
