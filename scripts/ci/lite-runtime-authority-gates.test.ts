import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  authorityConsumptionStateFromValue,
  authorityVisibilityBlocksPromotionReadiness,
  authorityVisibilityFromValue,
  authorityVisibilityPrimaryBlocker,
  authorityVisibilityRequiresInspection,
  buildAuthorityInspectionNextAction,
  demoteContractTrustForAuthorityBlock,
  demoteExecutionContractForAuthorityVisibility,
} from "../../src/memory/authority-consumption.ts";
import {
  runtimeBoundaryInventoryAuthorityEntries,
  runtimeBoundaryInventoryAuthorityFilesByCapability,
  runtimeBoundaryInventoryAuthorityFilesBySourceId,
  runtimeBoundaryInventoryAuthorityProducerEntries,
} from "../../src/memory/runtime-boundary-inventory.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import { buildRuntimeAuthorityDecisionReportFromGates } from "../../src/memory/authority-decision-report.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function read(repoPath: string): string {
  return fs.readFileSync(path.join(ROOT, repoPath), "utf8");
}

function assertContains(text: string, needle: string, message: string): void {
  assert.ok(text.includes(needle), message);
}

function listSourceTsFiles(dir: string): string[] {
  const absoluteDir = path.join(ROOT, dir);
  const out: string[] = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = path.relative(ROOT, absolute);
    if (entry.isDirectory()) {
      out.push(...listSourceTsFiles(relative));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(relative);
  }
  return out.sort();
}

test("authority boundary inventory declares unique Runtime boundary entries", () => {
  const authorityEntries = runtimeBoundaryInventoryAuthorityEntries();
  assert.ok(authorityEntries.length > 0, "authority boundary inventory must not be empty");
  const ids = authorityEntries.map((entry) => entry.source_id);
  assert.equal(new Set(ids).size, ids.length, "authority boundary inventory ids must be unique");

  for (const entry of authorityEntries) {
    assert.ok(entry.file.startsWith("src/"), `${entry.source_id} must point at a Runtime source file`);
    assert.ok(fs.existsSync(path.join(ROOT, entry.file)), `${entry.source_id} must point at an existing source file`);
    if (entry.role === "authority_producer") {
      assert.ok(entry.producer_kind, `${entry.source_id} must declare producer kind`);
      assert.equal(entry.capabilities.may_use_runtime_authority_gate, true, `${entry.source_id} must be gate-backed`);
      assert.ok(entry.required_source_markers.length > 0, `${entry.source_id} must declare source markers`);
    }
    if (entry.role === "advisory_pattern_producer") {
      assert.equal(entry.producer_kind, "advisory_pattern", `${entry.source_id} must stay advisory pattern scoped`);
      assert.equal(entry.capabilities.may_use_runtime_authority_gate, false, `${entry.source_id} must not mint Runtime authority`);
    }
  }
});

test("authority-producing Runtime surfaces use the unified authority gate", () => {
  const producers = runtimeBoundaryInventoryAuthorityProducerEntries()
    .filter((producer) => producer.capabilities.may_use_runtime_authority_gate);
  assert.ok(producers.length > 0, "authority boundary inventory must declare gate-backed producers");

  const broker = runtimeBoundaryInventoryAuthorityEntries().find((entry) => entry.source_id === "authority_effect_broker");
  assert.ok(broker, "authority effect broker must be declared");
  const brokerText = read(broker.file);
  assertContains(brokerText, "buildRuntimeAuthorityGate", "authority effect broker must call the unified authority gate");
  assertContains(brokerText, "issueRuntimeAuthorityReceiptForNode", "authority effect broker must issue authority receipts");
  assertContains(brokerText, "authority_gate_v1", "authority effect broker must understand authority gate slots");
  assertContains(brokerText, "authority_receipt_v1", "authority effect broker must seal authority receipts");

  for (const producer of producers) {
    const text = read(producer.file);
    assertContains(text, "authority-effect-broker.js", `${producer.file} must route authority effects through the broker`);
    assertContains(text, "authority_gate_v1", `${producer.file} must persist authority gate state`);
    for (const token of producer.required_source_markers) {
      assertContains(text, token, `${producer.file} must keep ${producer.source_id} backed by ${token}`);
    }
  }
});

test("declared authority capabilities are backed by source evidence tokens", () => {
  const capabilityEvidence: Array<{
    capability: keyof ReturnType<typeof runtimeBoundaryInventoryAuthorityEntries>[number]["capabilities"];
    tokens: string[];
  }> = [
    {
      capability: "may_use_runtime_authority_gate",
      tokens: ["buildRuntimeAuthorityGate", "buildRuntimeAuthorityEffect", "sealRuntimeAuthorityEffectReceipt", "authority_gate_v1", "allows_authoritative", "allows_stable_promotion"],
    },
    {
      capability: "may_use_outcome_contract_gate",
      tokens: ["buildOutcomeContractGate", "outcomeContractGate", "outcome_contract_gate_v1"],
    },
    {
      capability: "may_assess_execution_evidence",
      tokens: ["assessExecutionEvidence", "executionEvidenceAssessment", "execution_evidence_assessment"],
    },
    {
      capability: "may_read_raw_authority_surface",
      tokens: [
        "authority_gate_v1",
        "execution_evidence_assessment",
        "stable_promotion_blocked",
        "authority_visibility",
        "authorityConsumptionStateFromValue",
      ],
    },
    {
      capability: "may_use_stable_workflow_literal",
      tokens: [
        "promotion_state: \"stable\"",
        "promotion_state_override === \"stable\"",
        "promotion_state === \"stable\"",
        "\"stable_workflow\"",
      ],
    },
    {
      capability: "may_use_stable_pattern_literal",
      tokens: ["pattern_state: \"stable\"", "targetPatternState = \"stable\"", "target_level !== \"L3\"", "\"stable_pattern\""],
    },
  ];

  for (const entry of runtimeBoundaryInventoryAuthorityEntries()) {
    const text = read(entry.file);
    for (const evidence of capabilityEvidence) {
      if (entry.capabilities[evidence.capability] !== true) continue;
      assert.ok(
        evidence.tokens.some((token) => text.includes(token)),
        `${entry.source_id} declares ${evidence.capability} but ${entry.file} has none of: ${evidence.tokens.join(", ")}`,
      );
    }
  }
});

test("read-side authority consumers publish non-authoritative reuse boundaries", () => {
  const actionRetrieval = runtimeBoundaryInventoryAuthorityEntries().find(
    (entry) => entry.source_id === "action_retrieval_outcome_gate",
  );
  assert.ok(actionRetrieval, "action retrieval authority consumer must be declared");
  assert.equal(actionRetrieval.role, "authority_consumer");
  assert.equal(actionRetrieval.producer_kind, null);
  assertContains(read(actionRetrieval.file), "buildCandidateWorkflowInspectionNextAction", "candidate workflows must stay inspect-first");
  assertContains(
    read(actionRetrieval.file),
    "workflowSupportsForRetrieval = path.source_kind === \"recommended_workflow\"",
    "candidate workflow paths must not emit stable workflow tool source",
  );
  assert.ok(actionRetrieval.authority_rules.includes("candidate_workflow_reuse_is_inspect_or_rehydrate_only"));

  const policyMaterialization = runtimeBoundaryInventoryAuthorityEntries().find(
    (entry) => entry.source_id === "policy_materialization_surface",
  );
  assert.ok(policyMaterialization, "policy materialization authority consumer must be declared");
  assert.equal(policyMaterialization.role, "authority_consumer");
  assert.equal(policyMaterialization.producer_kind, null);
  assertContains(
    read(policyMaterialization.file),
    "authoritativeExecutionContractSupports",
    "live authoritative execution contracts must be the non-workflow authority path",
  );
  assertContains(
    read(policyMaterialization.file),
    "args.path.anchor_id && args.path.source_kind === \"recommended_workflow\"",
    "candidate workflow paths must not emit workflow reuse hints",
  );
  assert.ok(policyMaterialization.authority_rules.includes("trusted_pattern_only_guidance_is_advisory_candidate"));
});

test("authority decision reporting explains read-side downgrades without granting authority", () => {
  const report = buildRuntimeAuthorityDecisionReportFromGates({
    subject: "candidate_reuse",
    outcomeContractGate: {
      gate_version: "outcome_contract_gate_v1",
      status: "insufficient",
      allows_authoritative: false,
      requested_trust: "authoritative",
      effective_trust: "advisory",
      reasons: ["missing_service_detach_then_probe"],
      requires_service_lifecycle_outcome: true,
      decisive_fields: {
        acceptance_check_count: 1,
        success_invariant_count: 1,
        meaningful_success_invariant_count: 1,
        must_hold_after_exit_count: 1,
        external_visibility_requirement_count: 1,
        service_lifecycle_constraint_count: 1,
        durable_service_lifecycle_constraint_count: 0,
        service_must_survive_agent_exit_count: 0,
        service_revalidate_from_fresh_shell_count: 0,
        service_detach_then_probe_count: 0,
        service_health_check_count: 1,
      },
    },
    executionEvidenceAssessment: {
      schema_version: "execution_evidence_assessment_v1",
      status: "succeeded",
      allows_authoritative: true,
      allows_stable_promotion: true,
      requested_trust: "authoritative",
      effective_trust: "authoritative",
      reasons: [],
      decisive_fields: {
        validation_passed: true,
        after_exit_revalidated: true,
        fresh_shell_probe_passed: true,
        validation_boundary: "external_verifier",
        false_confidence_detected: false,
        failure_reason_present: false,
        requires_after_exit_revalidation: true,
        requires_fresh_shell_probe: true,
        requires_external_validation_boundary: true,
      },
    },
    stablePromotionAllowed: false,
    falseConfidenceDetected: false,
    candidateWorkflowVisible: true,
    trustedPatternOnlyVisible: true,
    policyDefaultAttempted: true,
  });

  assert.equal(report.report_version, "runtime_authority_decision_report_v1");
  assert.equal(report.summary.decisions_by_surface.candidate_workflow_reuse.inspect_or_rehydrate_only, 1);
  assert.equal(report.summary.decisions_by_surface.trusted_pattern_policy_materialization.advisory_only, 1);
  assert.equal(report.summary.decisions_by_surface.policy_default_materialization.blocked, 1);
  assert.equal(report.summary.unblocked_false_confidence_count, 0);
  assert.ok(report.read_side_rules.some((entry) => entry.source_id === "authority_decision_reporting"));
  assert.ok(report.decisions.some((entry) =>
    entry.surface === "candidate_workflow_reuse"
    && entry.rule_refs.includes("candidate_workflow_reuse_is_inspect_or_rehydrate_only")
  ));
  assert.ok(report.decisions.some((entry) =>
    entry.surface === "trusted_pattern_policy_materialization"
    && entry.disposition === "advisory_only"
    && entry.rule_refs.includes("trusted_pattern_only_guidance_is_advisory_candidate")
  ));
});

test("stable and authoritative producer literals stay in declared producer classes", () => {
  const sourceFiles = [...listSourceTsFiles("src/app"), ...listSourceTsFiles("src/memory"), ...listSourceTsFiles("src/routes")];
  const stableWorkflowLiteralFiles = sourceFiles
    .filter((file) => read(file).includes("promotion_state: \"stable\""))
    .sort();
  assert.deepEqual(
    stableWorkflowLiteralFiles,
    runtimeBoundaryInventoryAuthorityFilesByCapability("may_use_stable_workflow_literal"),
    "Stable workflow promotion literals must stay limited to declared producers and read-side orchestration summaries.",
  );

  const stablePatternLiteralFiles = sourceFiles
    .filter((file) => read(file).includes("pattern_state: \"stable\""))
    .sort();
  assert.deepEqual(
    stablePatternLiteralFiles,
    runtimeBoundaryInventoryAuthorityFilesByCapability("may_use_stable_pattern_literal"),
    "Stable pattern literals must stay limited to pattern anchoring and read-side orchestration summaries.",
  );
});

test("workflow stable producers bind stable writes to runtime authority gates", () => {
  const workflowWriteProjection = read("src/memory/workflow-write-projection.ts");
  for (const token of [
    "learningControlPreview?.runtime_apply.promotion_state_override === \"stable\"",
    "contractTrust === \"authoritative\"",
    "authorityGate.allows_authoritative",
    "authorityGate.allows_stable_promotion",
    "authorityGate: stableAuthorityGate",
    "outcomeContractGate: stableOutcomeContractGate",
    "executionEvidenceAssessment: stableExecutionEvidenceAssessment",
    "authority_gate_v1: stableAuthorityGate",
  ]) {
    assertContains(workflowWriteProjection, token, `workflow-write-projection stable writes must stay gate-backed by ${token}`);
  }

  const replayLearningArtifacts = read("src/memory/replay-learning-artifacts.ts");
  for (const token of [
    "args.shouldPromoteStableWorkflow",
    "authorityGate.allows_authoritative",
    "authorityGate.allows_stable_promotion",
    "authorityGate: stableAuthorityGate",
    "outcomeContractGate: stableOutcomeContractGate",
    "executionEvidenceAssessment: stableExecutionEvidenceAssessment",
    "authority_gate_v1: stableAuthorityGate",
  ]) {
    assertContains(replayLearningArtifacts, token, `replay-learning stable writes must stay gate-backed by ${token}`);
  }

  const replayStableAnchorHelpers = read("src/memory/replay-stable-anchor-helpers.ts");
  for (const token of [
    "authorityGatedReplayWorkflowContract",
    "const allowsStableWorkflow =",
    "authority.authorityGate.allows_authoritative",
    "authority.authorityGate.allows_stable_promotion",
    "execution_evidence_assessment: executionEvidenceAssessment",
    "authority_gate_v1: authorityGate",
  ]) {
    assertContains(replayStableAnchorHelpers, token, `replay stable anchors must stay gate-backed by ${token}`);
  }
});

test("stable tool pattern producers remain advisory and learning_control-scoped", () => {
  const toolsPatternAnchor = read("src/memory/tools-pattern-anchor.ts");
  assert.equal(toolsPatternAnchor.includes("\"authoritative\""), false, "tools pattern anchors must never mint authoritative trust");
  assertContains(toolsPatternAnchor, "return \"advisory\";", "stable trusted tool patterns may only become advisory guidance");
  assertContains(toolsPatternAnchor, "return \"observational\";", "non-stable tool patterns must stay observational");
  assertContains(toolsPatternAnchor, "promotion_gate_satisfied: promotionGateSatisfied", "pattern stability must keep distinct-run promotion evidence");
  assertContains(toolsPatternAnchor, "revalidation_floor_satisfied: revalidationFloorSatisfied", "pattern stability must keep post-contest revalidation evidence");
  assertContains(toolsPatternAnchor, "args.learningControlPatternStateOverride !== \"stable\"", "form-pattern learning_control must be required for runtime-applied stable override");
  assertContains(toolsPatternAnchor, "semantic_review_override_reason: \"high_confidence_form_pattern_review\"", "learning_control stable override must preserve semantic review provenance");
});

test("authority-consuming Runtime boundaries use the shared authority consumption helper", () => {
  const actionRetrieval = read("src/memory/action-retrieval.ts");
  assertContains(actionRetrieval, "authority-consumption.js", "action retrieval must consume the shared authority helper");
  assertContains(actionRetrieval, "authorityConsumptionStateFromValue", "action retrieval must derive authority consumption state through the helper");
  assertContains(actionRetrieval, "demoteExecutionContractForAuthorityVisibility", "action retrieval must demote blocked execution contracts through the helper");
  assert.equal(actionRetrieval.includes("authorityVisibilityFromValue"), false, "action retrieval must not bypass authority consumption state");

  const contextOrchestrator = read("src/memory/context-orchestrator.ts");
  assertContains(contextOrchestrator, "authority-consumption.js", "context orchestration must consume the shared authority helper");
  assertContains(contextOrchestrator, "authority_requires_inspection", "planner packet text must expose inspect-first authority state");

  const planningSummaryAssembly = read("src/app/planning-summary-assembly.ts");
  assertContains(planningSummaryAssembly, "authorityConsumptionStateFromValue", "planning summary assembly must derive authority state through the helper");
  assert.equal(planningSummaryAssembly.includes("experiencePath?.authority_blocked"), false, "planning summary assembly must not trust stale authority booleans directly");

  const reviewerPacks = read("src/memory/reviewer-packs.ts");
  assertContains(reviewerPacks, "authority-consumption.js", "reviewer packs must consume the shared authority helper");
  assertContains(reviewerPacks, "authorityConsumptionAllowsActionReuse", "reviewer packs must filter blocked action reuse through the helper");

  const planningSummarySurfaces = read("src/app/planning-summary-surfaces.ts");
  assertContains(planningSummarySurfaces, "authorityConsumptionStateFromValue", "planning summary surfaces must block failed promotion readiness through the helper");
  assertContains(planningSummarySurfaces, "blocks_promotion_readiness", "planning summary surfaces must respect promotion-readiness authority blocks");

  const recallActionPacket = read("src/memory/recall-action-packet.ts");
  assertContains(recallActionPacket, "authorityConsumptionStateFromValue", "recall action packet must derive promotion readiness through the helper");
  assertContains(recallActionPacket, "blocks_promotion_readiness", "recall action packet must block failed promotion readiness");

  const executionIntrospection = read("src/memory/execution-introspection.ts");
  assertContains(executionIntrospection, "authorityConsumptionStateFromValue", "execution introspection must derive promotion readiness through the helper");
  assertContains(executionIntrospection, "blocks_promotion_readiness", "execution introspection must block failed promotion readiness");
});

test("authority raw field and visibility parser access stays behind declared boundaries", () => {
  const sourceFiles = [...listSourceTsFiles("src/app"), ...listSourceTsFiles("src/memory")];
  const visibilityParserSymbols = [
    "authorityVisibilityFromValue",
    "authorityVisibilityRequiresInspection",
    "authorityVisibilityPrimaryBlocker",
  ];
  const parserAllowlist = new Set(runtimeBoundaryInventoryAuthorityFilesBySourceId("authority_consumption"));
  for (const file of sourceFiles) {
    if (parserAllowlist.has(file)) continue;
    const text = read(file);
    const matched = visibilityParserSymbols.filter((symbol) => text.includes(symbol));
    assert.deepEqual(matched, [], `${file} must consume authority through authorityConsumptionStateFromValue`);
  }

  const rawAuthorityFieldTokens = [
    "authority_gate_v1",
    "execution_evidence_assessment",
    "stable_promotion_blocked",
  ];
  const rawFieldBoundaryAllowlist = new Set(
    runtimeBoundaryInventoryAuthorityFilesByCapability("may_read_raw_authority_surface"),
  );
  for (const file of sourceFiles) {
    if (rawFieldBoundaryAllowlist.has(file)) continue;
    const text = read(file);
    const matched = rawAuthorityFieldTokens.filter((token) => text.includes(token));
    assert.deepEqual(matched, [], `${file} must not read raw authority gate/evidence fields directly`);
  }

  for (const file of [
    "src/memory/action-retrieval.ts",
    "src/memory/context-orchestrator.ts",
    "src/memory/reviewer-packs.ts",
    "src/app/planning-summary-assembly.ts",
    "src/app/planning-summary-surfaces.ts",
    "src/memory/recall-action-packet.ts",
    "src/memory/execution-introspection.ts",
  ]) {
    assertContains(read(file), "authorityConsumptionStateFromValue", `${file} must consume normalized authority state`);
  }
});

test("pattern surfaces cannot masquerade as authoritative Runtime contracts", () => {
  const toolsPatternAnchor = read("src/memory/tools-pattern-anchor.ts");
  assert.equal(toolsPatternAnchor.includes("\"authoritative\""), false, "tools pattern anchors must not grant authoritative trust");
  assertContains(toolsPatternAnchor, "\"advisory\"", "stable trusted tool patterns may become advisory guidance");
  assertContains(toolsPatternAnchor, "\"observational\"", "non-stable tool patterns must remain observational guidance");

  const formPatternLearningControl = read("src/memory/learning-control-form-pattern.ts");
  assert.equal(formPatternLearningControl.includes("contract_trust"), false, "form pattern learning control must not mutate contract trust");
  assert.equal(formPatternLearningControl.includes("\"authoritative\""), false, "form pattern learning control must not grant authoritative trust");
  assertContains(formPatternLearningControl, "target_kind !== \"pattern\"", "form pattern learning control must remain pattern-scoped");
  assertContains(formPatternLearningControl, "target_level !== \"L3\"", "form pattern learning control must remain L3-scoped");
});


test("authority consumption helper demotes blocked authority to inspect-first guidance", () => {
  const visibility = authorityVisibilityFromValue({
    authority_visibility: {
      surface_version: "runtime_authority_visibility_v1",
      node_id: "wf_blocked",
      node_kind: "workflow",
      title: "Blocked workflow",
      requested_trust: "authoritative",
      effective_trust: "advisory",
      status: "insufficient",
      allows_authoritative: false,
      allows_stable_promotion: false,
      authority_blocked: true,
      stable_promotion_blocked: true,
      primary_blocker: "execution_evidence:after_exit_revalidation_failed",
      authority_reasons: ["execution_evidence:after_exit_revalidation_failed"],
      outcome_contract_reasons: [],
      execution_evidence_reasons: ["after_exit_revalidation_failed"],
      execution_evidence_status: "failed",
      false_confidence_detected: true,
    },
  });

  assert.equal(authorityVisibilityRequiresInspection(visibility), true);
  assert.equal(authorityVisibilityPrimaryBlocker(visibility), "execution_evidence:after_exit_revalidation_failed");
  assert.equal(demoteContractTrustForAuthorityBlock("authoritative", true), "advisory");
  assert.equal(demoteContractTrustForAuthorityBlock("observational", true), "observational");
  assert.equal(
    buildAuthorityInspectionNextAction({
      selectedTool: "edit",
      filePath: "src/routes/export.ts",
      blocker: authorityVisibilityPrimaryBlocker(visibility),
    }),
    "Inspect src/routes/export.ts and revalidate current context before reusing edit; authority blocked by execution_evidence:after_exit_revalidation_failed.",
  );

  const contract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "task:workflow_validation_recovery",
    workflow_signature: "execution_workflow:workflow-validation-recovery",
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    acceptance_checks: ["npm test -- export"],
    success_invariants: ["export route returns valid serialized payload"],
    provenance: {
      source_kind: "workflow_projection",
      source_summary_version: "lite-runtime-authority-gates-test",
      source_anchor: "wf_blocked",
      evidence_refs: ["wf_blocked"],
      notes: ["blocked workflow test"],
    },
  });
  const demoted = demoteExecutionContractForAuthorityVisibility({
    contract,
    visibility,
    selectedTool: "edit",
    filePath: "src/routes/export.ts",
    reuseTarget: "the learned workflow",
  });

  assert.equal(demoted.contract_trust, "advisory");
  assert.match(demoted.next_action ?? "", /Inspect src\/routes\/export\.ts/);
  assert.ok(demoted.provenance.notes.includes("authority_visibility_requires_inspection:execution_evidence:after_exit_revalidation_failed"));
});

test("authority consumption keeps candidate readiness separate from action reuse authority", () => {
  const incompletePromotionVisibility = authorityVisibilityFromValue({
    authority_visibility: {
      surface_version: "runtime_authority_visibility_v1",
      node_id: "wf_candidate",
      node_kind: "workflow",
      title: "Candidate workflow",
      requested_trust: "advisory",
      effective_trust: "advisory",
      status: "insufficient",
      allows_authoritative: false,
      allows_stable_promotion: false,
      authority_blocked: false,
      stable_promotion_blocked: true,
      primary_blocker: "execution_evidence:missing_validation",
      authority_reasons: ["execution_evidence:missing_validation"],
      outcome_contract_reasons: [],
      execution_evidence_reasons: ["missing_validation"],
      execution_evidence_status: "incomplete",
      false_confidence_detected: false,
    },
  });

  assert.equal(authorityVisibilityRequiresInspection(incompletePromotionVisibility), true);
  assert.equal(authorityVisibilityBlocksPromotionReadiness(incompletePromotionVisibility), false);
  const incompleteState = authorityConsumptionStateFromValue({ authority_visibility: incompletePromotionVisibility });
  assert.equal(incompleteState.requires_inspection, true);
  assert.equal(incompleteState.blocks_promotion_readiness, false);
  assert.equal(incompleteState.primary_blocker, "execution_evidence:missing_validation");

  const authorityBlockedVisibility = authorityVisibilityFromValue({
    authority_visibility: {
      surface_version: "runtime_authority_visibility_v1",
      node_id: "wf_authority_blocked",
      node_kind: "workflow",
      title: "Authority blocked workflow",
      requested_trust: "authoritative",
      effective_trust: "advisory",
      status: "insufficient",
      allows_authoritative: false,
      allows_stable_promotion: false,
      authority_blocked: true,
      stable_promotion_blocked: true,
      primary_blocker: "execution_evidence:missing_validation",
      authority_reasons: ["execution_evidence:missing_validation"],
      outcome_contract_reasons: [],
      execution_evidence_reasons: ["missing_validation"],
      execution_evidence_status: "incomplete",
      false_confidence_detected: false,
    },
  });

  assert.equal(authorityVisibilityRequiresInspection(authorityBlockedVisibility), true);
  assert.equal(authorityVisibilityBlocksPromotionReadiness(authorityBlockedVisibility), false);

  const failedVisibility = authorityVisibilityFromValue({
    authority_visibility: {
      surface_version: "runtime_authority_visibility_v1",
      node_id: "wf_failed",
      node_kind: "workflow",
      title: "Failed workflow",
      requested_trust: "advisory",
      effective_trust: "advisory",
      status: "insufficient",
      allows_authoritative: false,
      allows_stable_promotion: false,
      authority_blocked: false,
      stable_promotion_blocked: true,
      primary_blocker: "execution_evidence:after_exit_revalidation_failed",
      authority_reasons: ["execution_evidence:after_exit_revalidation_failed"],
      outcome_contract_reasons: [],
      execution_evidence_reasons: ["after_exit_revalidation_failed"],
      execution_evidence_status: "failed",
      false_confidence_detected: true,
    },
  });

  assert.equal(authorityVisibilityRequiresInspection(failedVisibility), true);
  assert.equal(authorityVisibilityBlocksPromotionReadiness(failedVisibility), true);
  const staleAuthorityState = authorityConsumptionStateFromValue({
    authority_blocked: true,
    authority_primary_blocker: "stale:blocker",
  });
  assert.equal(staleAuthorityState.requires_inspection, true);
  assert.equal(staleAuthorityState.primary_blocker, "stale:blocker");
});
