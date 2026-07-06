import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildRuntimeAuthorityEffect,
  sealRuntimeAuthorityEffectReceipt,
} from "../../src/memory/authority-effect-broker.ts";
import { ExecutionContractV1Schema } from "../../src/memory/execution-contract.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-authority-effect-broker-"));
  return path.join(dir, `${name}.sqlite`);
}

function authoritativeContract() {
  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: "authoritative",
    task_family: "authority-effect-broker",
    task_signature: "task:authority-effect-broker",
    workflow_signature: "workflow:authority-effect-broker",
    policy_memory_id: null,
    selected_tool: null,
    file_path: null,
    target_files: [],
    next_action: "Exercise the authority effect broker.",
    workflow_steps: ["build_gate", "seal_receipt", "write_memory"],
    pattern_hints: [],
    service_lifecycle_constraints: [],
    outcome: {
      acceptance_checks: ["npm test"],
      success_invariants: ["all_acceptance_checks_pass"],
      dependency_requirements: [],
      environment_assumptions: [],
      must_hold_after_exit: [],
      external_visibility_requirements: [],
    },
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "authority_effect_broker_test_v1",
      source_anchor: "authority-effect-broker",
      evidence_refs: ["ci:test"],
      notes: ["authority effect broker test fixture"],
    },
  });
}

function passingEvidence() {
  return {
    schema_version: "execution_evidence_v1",
    validation_passed: true,
    validation_boundary: "runtime_orchestrator",
    evidence_refs: ["ci:test:passed"],
  };
}

async function prepareStableWorkflowWrite() {
  const executionContract = authoritativeContract();
  const executionEvidence = passingEvidence();
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: "authority effect broker stable workflow fixture",
      auto_embed: false,
      nodes: [
        {
          client_id: "authority-effect-broker:stable-workflow",
          type: "procedure",
          title: "Authority effect broker stable workflow",
          text_summary: "Stable workflow broker fixture.",
          slots: {
            summary_kind: "workflow_anchor",
            contract_trust: "authoritative",
            execution_contract_v1: executionContract,
            execution_evidence_v1: executionEvidence,
            workflow_promotion: {
              promotion_state: "stable",
              promotion_origin: "authority_effect_broker_test",
            },
          },
        },
      ],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );
  const node = prepared.nodes[0];
  assert.ok(node, "test fixture must prepare one node");
  const effect = buildRuntimeAuthorityEffect({
    effectKind: "stable_workflow_projection",
    executionContract,
    requestedTrust: "authoritative",
    slots: node.slots,
    evidence: executionEvidence,
  });
  assert.equal(effect.authorityGate.allows_authoritative, true);
  assert.equal(effect.authorityGate.allows_stable_promotion, true);
  Object.assign(node.slots, effect.slotsPatch);
  const seal = sealRuntimeAuthorityEffectReceipt({
    effectKind: "stable_workflow_projection",
    node,
    slots: node.slots,
    authorityGate: effect.authorityGate,
    issuedAt: "2026-07-06T00:00:00.000Z",
    mutate: true,
    requireAuthorityClaims: true,
  });
  assert.equal(seal.claim_paths.includes("slots.contract_trust"), true);
  assert.equal(seal.audit?.effect_kind, "stable_workflow_projection");
  assert.equal(seal.audit?.receipt.key_id, (node.slots.authority_receipt_v1 as any).key_id);
  assert.equal(seal.audit?.receipt.gate_sha256, (node.slots.authority_receipt_v1 as any).gate_sha256);
  assert.ok(node.slots.authority_receipt_v1, "broker must attach authority receipt");
  assert.ok(node.slots.authority_effect_audit_v1, "broker must attach authority effect audit");
  return prepared;
}

test("authority effect broker seals a stable workflow write that passes the runtime write guard", async () => {
  const store = createLiteWriteStore(tmpDbPath("stable-workflow"));
  try {
    const prepared = await prepareStableWorkflowWrite();
    const result = await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        write_access: store,
      }),
    );

    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0]?.client_id, "authority-effect-broker:stable-workflow");
  } finally {
    await store.close();
  }
});

test("authority effect broker fails closed when a required authority effect has no claims", () => {
  const effect = buildRuntimeAuthorityEffect({
    effectKind: "workflow_candidate_projection",
    executionContract: authoritativeContract(),
    requestedTrust: "advisory",
    slots: {},
    evidence: passingEvidence(),
  });

  assert.throws(
    () => sealRuntimeAuthorityEffectReceipt({
      effectKind: "stable_workflow_projection",
      node: {
        id: "node-without-authority-claims",
        client_id: "node-without-authority-claims",
        scope: "default",
        type: "event",
        slots: {
          authority_gate_v1: effect.authorityGate,
        },
      },
      requireAuthorityClaims: true,
    }),
    /did not declare authority-bearing claim paths/,
  );
});
