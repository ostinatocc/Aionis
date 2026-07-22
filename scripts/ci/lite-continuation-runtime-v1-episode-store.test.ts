import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSignedAuthorityArtifactV1 } from "../../src/continuation/authority-artifact.ts";
import type { ContinuationCompilerPolicyV1 } from "../../src/continuation/compiler.ts";
import { buildContinuationCompilerPolicyV1 } from "../../src/continuation/compiler-policy.ts";
import { buildEffectEvidencePolicyV1 } from "../../src/continuation/effect-certificate.ts";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.ts";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.ts";
import { createContinuationRuntimeV1DecisionAssemblyService } from
  "../../src/runtime-v1/decision-assembly.ts";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.ts";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.ts";
import { createContinuationRuntimeV1AuthorityStore } from
  "../../src/store/continuation-runtime-v1-authority-store.ts";
import { openContinuationRuntimeV1Database, type ContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.ts";
import { createContinuationRuntimeV1EffectCertificateReader } from
  "../../src/store/continuation-runtime-v1-effect-certificate-reader.ts";
import { createContinuationRuntimeV1EpisodeStore, type EpisodeAppendResultV1 } from
  "../../src/store/continuation-runtime-v1-episode-store.ts";
import { createContinuationRuntimeV1ExperimentCohortAuthority } from
  "../../src/store/continuation-runtime-v1-experiment-cohort-authority.ts";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.ts";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.ts";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.ts";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
} from
  "../../src/store/continuation-runtime-v1-operation-store.ts";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../../src/store/continuation-runtime-v1-policy-authority.ts";

const KEYS=generateKeyPairSync("ed25519"); const TENANT="tenant-1"; const SCOPE="scope-1";
const HOST="1".repeat(64); const OPERATOR="2".repeat(64); const NOW="2026-07-22T10:00:00.000Z";
const SNAPSHOT_NOW="2026-07-22T09:30:00.000Z";
const SUBJECT=continuationAuthoritySubjectSha256V1({tenant_id:TENANT,scope:SCOPE,task_family:"repair"});
const POLICY:ContinuationCompilerPolicyV1={schema_version:"continuation_compiler_policy_v1",tenant_id:TENANT,
  authority_subject_sha256:SUBJECT,candidate_limit:128,continuity_candidate_limit:64,
  learning_candidate_limit:64,selected_capsule_limit:64,obligation_limit:64,
  max_render_budget:65536,
  hard_coverage_weight:1000000,advisory_coverage_weight:10000,authority_bonus:{candidate:0,verified:64,authoritative:128},
  freshness_bonus:[0,2,4,8],
  freshness_max_age_ms:[3600000,86400000,604800000],trusted_observer_principals:{trusted_host_collector:[HOST],external_verifier:[]}};
let sequence=0;

function fixture(){sequence+=1;const root=mkdtempSync(join(tmpdir(),"aionis-v1-episode-"));
  const path=join(root,"runtime","runtime.sqlite");const clock={value:"2026-07-22T08:00:00.000Z"};
  const database=openContinuationRuntimeV1Database(path,
    {databaseInstanceId:sequence.toString(16).padStart(64,"0"),authorityNow:()=>clock.value});
  clock.value=NOW;
  const operations=createContinuationRuntimeV1OperationStore(database);
  const artifactProvisioner=createContinuationRuntimeV1AuthorityArtifactProvisioner(
    database,KEYS.publicKey,
  );
  const artifacts=createContinuationRuntimeV1AuthorityArtifactReader(database,KEYS.publicKey);
  const policies=createContinuationRuntimeV1PolicyAuthority(database,artifacts);
  const effects=createContinuationRuntimeV1EffectCertificateReader(database,artifacts,policies);
  const authority=createContinuationRuntimeV1AuthorityStore(database,artifacts,policies,effects);
  const observations=createContinuationRuntimeV1ObservationStore(database);
  const memory=createContinuationRuntimeV1MemoryStore(database);
  const cohorts=createContinuationRuntimeV1ExperimentCohortAuthority(
    database,artifacts,policies,
  );
  const assembly=createContinuationRuntimeV1DecisionAssemblyService({database,
    observationStore:observations,memoryStore:memory,artifactStore:artifacts,
    policyAuthority:policies,effectCertificateReader:effects,authorityStore:authority,
    experimentCohortAuthority:cohorts});
  return{root,path,database,operations,artifactProvisioner,artifacts,authority,effects,observations,memory,
    assembly,episode:createContinuationRuntimeV1EpisodeStore(database),clock};}
type F=ReturnType<typeof fixture>;
async function op<T>(f:F,kind:"record_observations"|"create_continuation"|"record_outcome"|"authority_decision",
  id:string,produce:(context:ContinuationRuntimeV1AuthorityWriteContext)=>Promise<T>):Promise<T>{let value:T|null=null;
  await f.operations.execute({tenantId:TENANT,scope:SCOPE,operationKind:kind,operationId:id,
    actorKind:kind==="authority_decision"?"operator":"trusted_host",
    actorPrincipalSha256:kind==="authority_decision"?OPERATOR:HOST,request:{id},produce:async(context)=>{
      try {
        value=await produce(context);return deriveContinuationRuntimeV1OperationResultV1(
          f.database,
          assertContinuationRuntimeV1AuthorityWriteContext(context,f.database),
          "before_receipt_insert",
        );
      } finally { f.clock.value=NOW; }}});return value!;}
async function seed(f:F){
    const compiler=buildSignedAuthorityArtifactV1({tenant_id:TENANT,artifact_id:"compiler_policy",artifact_revision:1,
      artifact_kind:"compiler_policy",artifact_schema:"continuation_compiler_policy_v1",
      authority_subject_sha256:SUBJECT,payload:buildContinuationCompilerPolicyV1(POLICY),
      valid_from:"2026-07-22T00:00:00.000Z",expires_at:null,created_at:"2026-07-22T00:00:00.000Z"},KEYS.privateKey);
    const evidence=buildSignedAuthorityArtifactV1({tenant_id:TENANT,artifact_id:"evidence_policy",artifact_revision:1,
      artifact_kind:"evidence_policy",artifact_schema:"effect_evidence_policy_v1",
      authority_subject_sha256:SUBJECT,payload:buildEffectEvidencePolicyV1({
      schema_version:"effect_evidence_policy_v1",tenant_id:TENANT,authority_subject_sha256:SUBJECT,
      trusted_effect_verifier_principals:[HOST],max_eligible_decisions:256,min_evidence_window_ms:1,
      max_treatment_delta_count:64,max_evidence_window_ms:86400000,
      min_control_exposures:1,min_candidate_exposures:1,max_missingness_bps:1000,
      harm_noninferiority_margin_bps:0,utility_min_lift_bps:0,confidence_bps:9500,
      effect_verifier_contract_sha256:EFFECT_VERIFIER_CONTRACT_SHA256_V1,
      statistical_contract_sha256:EFFECT_STATISTICAL_CONTRACT_SHA256_V1}),
      valid_from:"2026-07-22T00:00:00.000Z",expires_at:null,created_at:"2026-07-22T00:00:00.000Z"},KEYS.privateKey);
    await op(f,"authority_decision","install-policy-bundle",(context)=>f.artifactProvisioner.putBundle(context,{
      schema_version:"authority_policy_provisioning_bundle_v1",tenant_id:TENANT,
      authority_subject_sha256:SUBJECT,compiler_policy:compiler,evidence_policy:evidence}));
  return op(f,"record_observations","genesis",async(context)=>{
    f.clock.value=SNAPSHOT_NOW;
    const snapshot=await f.observations.put(context,{host_task_envelope:{host_task_id:"task-genesis",
      episode_id:"episode-genesis",run_id:"run-genesis",consumer_agent_id:"agent",consumer_team_id:null,
      task_family:"repair",task_signature:"sig",workflow_signature:null,workspace_signature:"workspace",
      source_task_sha256:"3".repeat(64),source_event_sha256:"4".repeat(64),
      issued_at:"2026-07-22T09:00:00.000Z",expires_at:"2026-07-22T11:00:00.000Z"},
      collector_observations:[],signed_observations:[]});
    const memory=await f.memory.appendMemoryRevision(context,{expected_head_revision:null,
      items:[],relations:[],capsules:[]});
    f.clock.value=NOW;
    const genesis=await f.authority.ensureGenesis(context);
    return{snapshot,memory,genesis};
  });}
async function recordSnapshot(f:F,decision:string,run="run-1",episode="episode-1"){
  return op(f,"record_observations",`snapshot-${decision}`,(context)=>{
    f.clock.value=SNAPSHOT_NOW;
    return f.observations.put(context,{
    host_task_envelope:{host_task_id:`task-${decision}`,episode_id:episode,run_id:run,
      consumer_agent_id:"agent",consumer_team_id:null,task_family:"repair",task_signature:"sig",
      workflow_signature:null,workspace_signature:"workspace",source_task_sha256:"3".repeat(64),
      source_event_sha256:"4".repeat(64),issued_at:"2026-07-22T09:00:00.000Z",
      expires_at:"2026-07-22T11:00:00.000Z"},collector_observations:[],signed_observations:[]});});}
async function expose(f:F,decision="decision-1",run="run-1",episode="episode-1"){
  const persisted=await recordSnapshot(f,decision,run,episode);
  return op(f,"create_continuation",decision,async(context)=>{
    const capability=await f.assembly.assemble(context,{world_snapshot_ref:{
      world_snapshot_id:persisted.snapshot.world_snapshot_id,
      world_snapshot_sha256:persisted.snapshot.world_snapshot_sha256},obligations:[],
      render_budget:65536});
    return f.episode.appendExposure(context,capability);
  });}
async function outcome(f:F,decision:string,id="outcome"){
  const exposure=(await f.episode.readDecision(TENANT,SCOPE,decision))[0]!;
  return op(f,"record_outcome",id,(context)=>f.episode.appendOutcomeBundle(context,{decision_id:decision,
    use_receipt:{schema_version:"host_capsule_use_receipt_v1",decision_id:decision,use_id:`use-${decision}`,
      observed_at:"2026-07-22T10:00:00.000Z",render_result_sha256:exposure.render_result_sha256,
      capsule_uses:[],evidence_sha256:"a".repeat(64)},outcome_receipt:{
      schema_version:"host_outcome_receipt_v1",decision_id:decision,observed_at:"2026-07-22T10:00:00.000Z",
      outcome:"succeeded",outcome_code:"completed",evidence_sha256:"9".repeat(64),summary:"done"}}));}

test("episode store appends exposure and atomic outcome bundle and survives reopen",async()=>{const f=fixture();let db:ContinuationRuntimeV1Database|null=f.database;
  try{await seed(f);const exposure=await expose(f);assert.equal(exposure.event_refs[0]?.event_sequence,1);
    const completed=await outcome(f,"decision-1");assert.deepEqual(completed.event_refs.map((ref)=>ref.event_sequence),[2,3]);
    const read=await f.episode.readEpisode(TENANT,SCOPE,"episode-1");assert.equal(read?.events.length,3);assert.ok(Object.isFrozen(read));
    await db.close();db=openContinuationRuntimeV1Database(f.path);const reopened=createContinuationRuntimeV1EpisodeStore(db);
    assert.equal((await reopened.readDecision(TENANT,SCOPE,"decision-1")).length,3);
  }finally{if(db)await db.close();rmSync(f.root,{recursive:true,force:true});}});

test("two decisions share one episode with a single contiguous chain",async()=>{const f=fixture();try{await seed(f);
  await expose(f,"decision-1","run-a");await expose(f,"decision-2","run-a");
  await outcome(f,"decision-1","outcome-1");await outcome(f,"decision-2","outcome-2");
  const episode=await f.episode.readEpisode(TENANT,SCOPE,"episode-1");assert.deepEqual(episode?.events.map((e)=>e.event_sequence),[1,2,3,4,5,6]);
  assert.equal((await f.episode.readRun(TENANT,SCOPE,"run-a")).length,6);
}finally{await f.database.close();rmSync(f.root,{recursive:true,force:true});}});

test("duplicate operations replay without duplicating episode events",async()=>{const f=fixture();try{await seed(f);
  const first=await expose(f,"same");const replay=await f.operations.execute({tenantId:TENANT,scope:SCOPE,
    operationKind:"create_continuation",operationId:"same",actorKind:"trusted_host",actorPrincipalSha256:HOST,
    request:{id:"same"},produce:async()=>{throw new Error("must_not_run");}});assert.equal(replay.status,"replayed");
  assert.deepEqual(replay.receipt.result,{...first,schema_version:"create_continuation_result_v1"});
  assert.equal((await f.episode.readEpisode(TENANT,SCOPE,"episode-1"))?.events.length,1);
}finally{await f.database.close();rmSync(f.root,{recursive:true,force:true});}});

test("outcome rejects missing or mismatched complete use surfaces and rolls back",async()=>{const f=fixture();try{await seed(f);await expose(f);
  const exposure=(await f.episode.readDecision(TENANT,SCOPE,"decision-1"))[0]!;
  await assert.rejects(op(f,"record_outcome","bad",(context)=>f.episode.appendOutcomeBundle(context,{decision_id:"decision-1",
    use_receipt:{schema_version:"host_capsule_use_receipt_v1",decision_id:"different",use_id:"bad-use",
      observed_at:"2026-07-22T10:00:00.000Z",render_result_sha256:exposure.render_result_sha256,
      capsule_uses:[],evidence_sha256:"a".repeat(64)},
    outcome_receipt:{schema_version:"host_outcome_receipt_v1",decision_id:"decision-1",observed_at:"2026-07-22T10:00:00.000Z",
      outcome:"failed",outcome_code:"failed",evidence_sha256:"9".repeat(64),summary:null}})),/outcome_receipt_binding/u);
  assert.equal((await f.episode.readEpisode(TENANT,SCOPE,"episode-1"))?.events.length,1);
}finally{await f.database.close();rmSync(f.root,{recursive:true,force:true});}});

test("reads fail closed on event payload, cause, and operation receipt tamper",async()=>{for(const column of ["payload_json","cause_event_sha256","receipt_json"]){
  const f=fixture();try{await seed(f);await expose(f);await outcome(f,"decision-1");
    f.database.db.exec("PRAGMA foreign_keys=OFF");if(column==="receipt_json")f.database.db.exec(`DROP TRIGGER operations_no_update; UPDATE operations SET receipt_json='{}' WHERE operation_kind='record_outcome'`);
    else {f.database.db.exec("DROP TRIGGER episode_events_no_update");if(column==="payload_json")f.database.db.exec(`UPDATE episode_events SET payload_json='{}' WHERE event_sequence=1`);
      if(column==="cause_event_sha256")f.database.db.exec(`UPDATE episode_events SET cause_event_sha256='${"a".repeat(64)}' WHERE event_sequence=3`);
      }
    await assert.rejects(f.episode.readEpisode(TENANT,SCOPE,"episode-1"));
  }finally{await f.database.close();rmSync(f.root,{recursive:true,force:true});}}});
