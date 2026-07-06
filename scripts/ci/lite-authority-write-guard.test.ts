import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRuntimeAuthorityGate, type RuntimeAuthorityGateV1 } from "../../src/memory/authority-gate.ts";
import {
  issueRuntimeAuthorityReceiptForNode,
  runtimeAuthorityReceiptKeyringInfo,
} from "../../src/memory/authority-receipt.ts";
import { ExecutionContractV1Schema } from "../../src/memory/execution-contract.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-authority-write-guard-"));
  return path.join(dir, `${name}.sqlite`);
}

const authorityReceiptEnvKeys = [
  "AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID",
  "AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON",
  "AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET",
] as const;

async function withAuthorityReceiptEnv(
  overrides: Partial<Record<typeof authorityReceiptEnvKeys[number], string>>,
  fn: () => Promise<void> | void,
) {
  const previous = new Map<string, string | undefined>();
  for (const key of authorityReceiptEnvKeys) {
    previous.set(key, process.env[key]);
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const next = overrides[key];
      if (next === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = next;
      }
    } else {
      delete process.env[key];
    }
  }
  try {
    await fn();
  } finally {
    for (const key of authorityReceiptEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function authoritativeExecutionContract() {
  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: "authoritative",
    task_family: "authority-write-guard",
    task_signature: "task:authority-write-guard",
    workflow_signature: "workflow:authority-write-guard",
    policy_memory_id: null,
    selected_tool: null,
    file_path: null,
    target_files: [],
    next_action: "Run the authority write guard test.",
    workflow_steps: ["write_fixture", "run_guard"],
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
      source_summary_version: "authority_write_guard_test_v1",
      source_anchor: "authority-write-guard",
      evidence_refs: ["ci:test"],
      notes: ["authority write guard test fixture"],
    },
  });
}

function passingExecutionEvidence() {
  return {
    schema_version: "execution_evidence_v1",
    validation_passed: true,
    validation_boundary: "runtime_orchestrator",
    evidence_refs: ["ci:test:passed"],
  };
}

async function preparedWriteWithSlots(clientId: string, slots: Record<string, unknown>) {
  return prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: `authority write guard fixture ${clientId}`,
      auto_embed: false,
      nodes: [
        {
          client_id: clientId,
          type: "procedure",
          title: `Authority fixture ${clientId}`,
          text_summary: "Authority write guard fixture.",
          slots,
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
}

async function applyPrepared(store: ReturnType<typeof createLiteWriteStore>, prepared: Awaited<ReturnType<typeof preparedWriteWithSlots>>) {
  return store.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      write_access: store,
    }),
  );
}

function sealPreparedAuthorityReceipt(
  prepared: Awaited<ReturnType<typeof preparedWriteWithSlots>>,
  authorityGate: RuntimeAuthorityGateV1,
): void {
  const node = prepared.nodes[0];
  assert.ok(node, "test fixture must prepare one node");
  const receipt = issueRuntimeAuthorityReceiptForNode({
    node,
    slots: node.slots,
    authorityGate,
    issuedAt: "2026-07-06T00:00:00.000Z",
  });
  assert.ok(receipt, "test fixture must produce an authority receipt");
  node.slots.authority_receipt_v1 = receipt;
}

test("memory write rejects authoritative contract trust without a runtime authority receipt", async () => {
  const store = createLiteWriteStore(tmpDbPath("missing-authority-receipt"));
  try {
    const executionContract = authoritativeExecutionContract();
    const prepared = await preparedWriteWithSlots("authority:missing-receipt", {
      execution_contract_v1: executionContract,
      contract_trust: "authoritative",
    });

    await assert.rejects(
      () => applyPrepared(store, prepared),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "authority_receipt_required");
        assert.equal(err.details.contract, "runtime_authority_write_guard_v1");
        assert.equal(err.details.violations[0].reason, "missing_authority_gate_receipt");
        assert.equal(err.details.violations[0].requirement, "authoritative_trust_requires_passing_authority_gate");
        return true;
      },
    );
  } finally {
    await store.close();
  }
});

test("memory write rejects forged authority receipts that do not match recomputed gate state", async () => {
  const store = createLiteWriteStore(tmpDbPath("forged-authority-receipt"));
  try {
    const executionContract = authoritativeExecutionContract();
    const executionEvidence = passingExecutionEvidence();
    const authority = buildRuntimeAuthorityGate({
      executionContract,
      requestedTrust: "authoritative",
      slots: {
        execution_contract_v1: executionContract,
        execution_evidence_v1: executionEvidence,
      },
      evidence: executionEvidence,
    });
    const prepared = await preparedWriteWithSlots("authority:forged-receipt", {
      execution_contract_v1: executionContract,
      contract_trust: "authoritative",
      authority_gate_v1: authority.authorityGate,
    });
    sealPreparedAuthorityReceipt(prepared, authority.authorityGate);

    await assert.rejects(
      () => applyPrepared(store, prepared),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "authority_receipt_required");
        assert.equal(err.details.violations[0].reason, "authority_gate_receipt_mismatch");
        assert.equal(err.details.violations[0].computed.allows_authoritative, false);
        return true;
      },
    );
  } finally {
    await store.close();
  }
});

test("memory write rejects authority receipts with tampered provenance details", async () => {
  const store = createLiteWriteStore(tmpDbPath("tampered-authority-receipt"));
  try {
    const executionContract = authoritativeExecutionContract();
    const executionEvidence = passingExecutionEvidence();
    const authority = buildRuntimeAuthorityGate({
      executionContract,
      requestedTrust: "authoritative",
      slots: {
        execution_contract_v1: executionContract,
        execution_evidence_v1: executionEvidence,
      },
      evidence: executionEvidence,
    });
    const prepared = await preparedWriteWithSlots("authority:tampered-receipt", {
      execution_contract_v1: executionContract,
      execution_evidence_v1: executionEvidence,
      execution_evidence_assessment: authority.executionEvidenceAssessment,
      outcome_contract_gate: authority.outcomeContractGate,
      authority_gate_v1: authority.authorityGate,
      contract_trust: "authoritative",
    });
    sealPreparedAuthorityReceipt(prepared, authority.authorityGate);
    prepared.nodes[0]!.slots.authority_gate_v1 = {
      ...authority.authorityGate,
      reasons: ["tampered_runtime_authority_reason"],
    };

    await assert.rejects(
      () => applyPrepared(store, prepared),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "authority_receipt_required");
        assert.equal(err.details.violations[0].reason, "authority_receipt_mismatch");
        assert.equal(err.details.violations[0].computed.allows_authoritative, true);
        return true;
      },
    );
  } finally {
    await store.close();
  }
});

test("memory write accepts authoritative trust with matching passing runtime authority receipt", async () => {
  const store = createLiteWriteStore(tmpDbPath("valid-authority-receipt"));
  try {
    const executionContract = authoritativeExecutionContract();
    const executionEvidence = passingExecutionEvidence();
    const authority = buildRuntimeAuthorityGate({
      executionContract,
      requestedTrust: "authoritative",
      slots: {
        execution_contract_v1: executionContract,
        execution_evidence_v1: executionEvidence,
      },
      evidence: executionEvidence,
    });
    assert.equal(authority.authorityGate.allows_authoritative, true);
    assert.equal(authority.authorityGate.allows_stable_promotion, true);
    const prepared = await preparedWriteWithSlots("authority:valid-receipt", {
      execution_contract_v1: executionContract,
      execution_evidence_v1: executionEvidence,
      execution_evidence_assessment: authority.executionEvidenceAssessment,
      outcome_contract_gate: authority.outcomeContractGate,
      authority_gate_v1: authority.authorityGate,
      contract_trust: "authoritative",
    });
    sealPreparedAuthorityReceipt(prepared, authority.authorityGate);

    const result = await applyPrepared(store, prepared);

    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0]?.client_id, "authority:valid-receipt");
  } finally {
    await store.close();
  }
});

test("memory write verifies rotated authority receipts by receipt key id", async () => {
  const currentKeyId = "authority-test-current";
  const nextKeyId = "authority-test-next";
  const keyring = JSON.stringify({
    [currentKeyId]: "authority-test-current-secret-with-at-least-32-bytes",
    [nextKeyId]: "authority-test-next-secret-with-at-least-32-bytes",
  });

  await withAuthorityReceiptEnv(
    {
      AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: currentKeyId,
      AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: keyring,
    },
    async () => {
      const executionContract = authoritativeExecutionContract();
      const executionEvidence = passingExecutionEvidence();
      const authority = buildRuntimeAuthorityGate({
        executionContract,
        requestedTrust: "authoritative",
        slots: {
          execution_contract_v1: executionContract,
          execution_evidence_v1: executionEvidence,
        },
        evidence: executionEvidence,
      });
      const prepared = await preparedWriteWithSlots("authority:rotated-receipt", {
        execution_contract_v1: executionContract,
        execution_evidence_v1: executionEvidence,
        execution_evidence_assessment: authority.executionEvidenceAssessment,
        outcome_contract_gate: authority.outcomeContractGate,
        authority_gate_v1: authority.authorityGate,
        contract_trust: "authoritative",
      });
      sealPreparedAuthorityReceipt(prepared, authority.authorityGate);
      assert.equal((prepared.nodes[0]!.slots.authority_receipt_v1 as any).key_id, currentKeyId);

      await withAuthorityReceiptEnv(
        {
          AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: nextKeyId,
          AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: keyring,
        },
        async () => {
          const store = createLiteWriteStore(tmpDbPath("rotated-authority-receipt"));
          try {
            const info = runtimeAuthorityReceiptKeyringInfo();
            assert.equal(info.active_key_id, nextKeyId);
            assert.equal(info.key_count, 2);

            const result = await applyPrepared(store, prepared);

            assert.equal(result.nodes.length, 1);
            assert.equal(result.nodes[0]?.client_id, "authority:rotated-receipt");
          } finally {
            await store.close();
          }
        },
      );
    },
  );
});

test("memory write rejects rotated authority receipts after the old key is removed", async () => {
  const oldKeyId = "authority-test-old";
  const nextKeyId = "authority-test-next";
  await withAuthorityReceiptEnv(
    {
      AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: oldKeyId,
      AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: JSON.stringify({
        [oldKeyId]: "authority-test-old-secret-with-at-least-32-bytes",
      }),
    },
    async () => {
      const executionContract = authoritativeExecutionContract();
      const executionEvidence = passingExecutionEvidence();
      const authority = buildRuntimeAuthorityGate({
        executionContract,
        requestedTrust: "authoritative",
        slots: {
          execution_contract_v1: executionContract,
          execution_evidence_v1: executionEvidence,
        },
        evidence: executionEvidence,
      });
      const prepared = await preparedWriteWithSlots("authority:removed-key-receipt", {
        execution_contract_v1: executionContract,
        execution_evidence_v1: executionEvidence,
        execution_evidence_assessment: authority.executionEvidenceAssessment,
        outcome_contract_gate: authority.outcomeContractGate,
        authority_gate_v1: authority.authorityGate,
        contract_trust: "authoritative",
      });
      sealPreparedAuthorityReceipt(prepared, authority.authorityGate);

      await withAuthorityReceiptEnv(
        {
          AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: nextKeyId,
          AIONIS_AUTHORITY_RECEIPT_HMAC_KEYS_JSON: JSON.stringify({
            [nextKeyId]: "authority-test-next-secret-with-at-least-32-bytes",
          }),
        },
        async () => {
          const store = createLiteWriteStore(tmpDbPath("removed-key-authority-receipt"));
          try {
            await assert.rejects(
              () => applyPrepared(store, prepared),
              (err: any) => {
                assert.equal(err.statusCode, 400);
                assert.equal(err.code, "authority_receipt_required");
                assert.equal(err.details.violations[0].reason, "unknown_authority_receipt_key");
                return true;
              },
            );
          } finally {
            await store.close();
          }
        },
      );
    },
  );
});

test("memory write rejects stable promotion claims without a stable-promotion authority receipt", async () => {
  const store = createLiteWriteStore(tmpDbPath("stable-promotion-missing-receipt"));
  try {
    const prepared = await preparedWriteWithSlots("authority:stable-missing-receipt", {
      summary_kind: "workflow_anchor",
      workflow_promotion: {
        promotion_state: "stable",
        promotion_origin: "manual_write",
      },
    });

    await assert.rejects(
      () => applyPrepared(store, prepared),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "authority_receipt_required");
        assert.equal(err.details.violations[0].requirement, "stable_promotion_requires_passing_authority_gate");
        assert.equal(err.details.violations[0].reason, "missing_authority_gate_receipt");
        return true;
      },
    );
  } finally {
    await store.close();
  }
});

test("memory write still accepts advisory workflow anchors without stable promotion claims", async () => {
  const store = createLiteWriteStore(tmpDbPath("advisory-workflow-anchor"));
  try {
    const prepared = await preparedWriteWithSlots("authority:advisory-workflow-anchor", {
      summary_kind: "workflow_anchor",
      execution_native_v1: {
        schema_version: "execution_native_v1",
        execution_kind: "workflow_anchor",
        summary_kind: "workflow_anchor",
        compression_layer: "L2",
        contract_trust: "advisory",
        task_signature: "task:advisory",
        workflow_signature: "workflow:advisory",
        anchor_kind: "workflow",
        anchor_level: "L2",
      },
    });

    const result = await applyPrepared(store, prepared);

    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0]?.client_id, "authority:advisory-workflow-anchor");
  } finally {
    await store.close();
  }
});
