import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Env } from "../../src/config.ts";
import {
  buildRuntimeAuthorityEffect,
  sealRuntimeAuthorityEffectReceipt,
} from "../../src/memory/authority-effect-broker.ts";
import { ExecutionContractV1Schema } from "../../src/memory/execution-contract.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { registerOperatorSnapshotRoutes } from "../../src/routes/operator-snapshot.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-authority-effect-audit-route-"));
  return path.join(dir, `${name}.sqlite`);
}

function authoritativeContract() {
  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: "authoritative",
    task_family: "authority-effect-audit-route",
    task_signature: "task:authority-effect-audit-route",
    workflow_signature: "workflow:authority-effect-audit-route",
    policy_memory_id: null,
    selected_tool: null,
    file_path: null,
    target_files: [],
    next_action: "Exercise the authority effect audit route.",
    workflow_steps: ["seal_authority_effect", "read_operator_audit"],
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
      source_summary_version: "authority_effect_audit_route_test_v1",
      source_anchor: "authority-effect-audit-route",
      evidence_refs: ["ci:test"],
      notes: ["authority effect audit route test fixture"],
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

async function writeBrokerSealedAuthorityMemory(store: ReturnType<typeof createLiteWriteStore>) {
  const executionContract = authoritativeContract();
  const executionEvidence = passingEvidence();
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: "authority effect audit route fixture",
      auto_embed: false,
      nodes: [
        {
          client_id: "authority-effect-audit-route:stable-workflow",
          type: "procedure",
          title: "Authority effect audit route stable workflow",
          text_summary: "Stable workflow audit route fixture.",
          slots: {
            summary_kind: "workflow_anchor",
            contract_trust: "authoritative",
            execution_contract_v1: executionContract,
            execution_evidence_v1: executionEvidence,
            workflow_promotion: {
              promotion_state: "stable",
              promotion_origin: "authority_effect_audit_route_test",
            },
            secret_probe: "must not leak",
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
  Object.assign(node.slots, effect.slotsPatch);
  sealRuntimeAuthorityEffectReceipt({
    effectKind: "stable_workflow_projection",
    node,
    slots: node.slots,
    authorityGate: effect.authorityGate,
    issuedAt: "2026-07-06T00:00:00.000Z",
    mutate: true,
    requireAuthorityClaims: true,
  });
  return store.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      write_access: store,
    }),
  );
}

test("operator authority effect audit route exposes broker receipt metadata without raw slots", async () => {
  const store = createLiteWriteStore(tmpDbPath("authority-effect-audit"));
  const app = Fastify();
  registerRuntimeErrorHandler(app);
  registerOperatorSnapshotRoutes({
    app,
    env: {
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
    } as Env,
    liteWriteStore: store,
    requireMemoryPrincipal: async () => null,
    withIdentityFromRequest: (_req, body) => body,
    enforceRateLimit: async () => undefined,
    enforceTenantQuota: async () => undefined,
    tenantFromBody: () => "default",
    acquireInflightSlot: async () => ({ release: () => undefined }),
  });

  try {
    const writeResult = await writeBrokerSealedAuthorityMemory(store);
    const response = await app.inject({
      method: "GET",
      url: "/v1/operator/authority-effect-audit?scope=default&effect_kind=stable_workflow_projection",
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.contract_version, "aionis_authority_effect_audit_result_v1");
    assert.equal(body.surface_semantics.read_only, true);
    assert.equal(body.surface_semantics.authority_effect, "none");
    assert.equal(body.summary.returned_count, 1);
    assert.equal(body.summary.authoritative_allowed_count, 1);
    assert.equal(body.summary.stable_promotion_allowed_count, 1);
    assert.equal(body.entries[0].memory_id, writeResult.nodes[0]?.id);
    assert.equal(body.entries[0].effect_kind, "stable_workflow_projection");
    assert.equal(body.entries[0].receipt.key_id.length > 0, true);
    assert.equal(body.entries[0].receipt.gate_sha256.length, 64);
    assert.deepEqual(body.entries[0].claim_paths.sort(), [
      "slots.contract_trust",
      "slots.execution_contract_v1.contract_trust",
      "slots.promotion_state",
    ].sort());
    assert.equal("slots" in body.entries[0], false);
    assert.equal("signature" in body.entries[0].receipt, false);
    assert.doesNotMatch(response.body, /secret_probe/);
    assert.doesNotMatch(response.body, /must not leak/);
  } finally {
    await app.close();
    await store.close();
  }
});
