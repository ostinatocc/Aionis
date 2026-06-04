import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { buildRuntimeSignalLedgerFromSlots } from "../../src/memory/runtime-signal-ledger.ts";
import { scanRuntimeSignalTrendSummaryLite } from "../../src/memory/runtime-signal-trends.ts";
import {
  RuntimeSignalLedgerV1Schema,
  RuntimeSignalTrendSummaryV1Schema,
  type RuntimeSignalLedgerV1,
} from "../../src/memory/schemas.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-runtime-signal-ledger-"));
  return path.join(dir, `${name}.sqlite`);
}

function signalKinds(ledger: RuntimeSignalLedgerV1): string[] {
  return ledger.entries.map((entry) => entry.signal_kind).sort();
}

test("runtime signal ledger compiles verifier, recovery, provider, context, and maintenance signals", () => {
  const ledger = buildRuntimeSignalLedgerFromSlots({
    slots: {
      execution_result_summary: {
        status: "failed",
        validation_passed: false,
        validation_boundary: "external_verifier",
        failure_reason: "external verifier failed",
        retry_count: 2,
        recovery_cost: 4,
        provider_failure: true,
        error_kind: "provider_transport_timeout",
        evidence_refs: ["verifier:run-1"],
      },
      context_cost_signals_v1: {
        summary_version: "context_cost_signals_v1",
        context_est_tokens: 32000,
        context_token_budget: 12000,
        within_token_budget: false,
      },
      runtime_maintenance_effect_summary_v1: {
        effect_summary_version: "runtime_maintenance_effect_summary_v1",
        workflow_promotions: 1,
        policy_retirements: 0,
        memory_demotions: 2,
        memory_archives: 1,
      },
    },
  });

  assert.ok(ledger);
  const parsed = RuntimeSignalLedgerV1Schema.parse(ledger);
  assert.deepEqual(signalKinds(parsed), [
    "maintenance_effect",
    "provider_protocol_failure",
    "recovery_cost",
    "retry_count",
    "token_context_pressure",
    "verifier_result",
  ]);
  assert.equal(parsed.source_code_change_allowed, false);
  assert.equal(parsed.quarantine_signal_count, 1);
  assert.ok(parsed.negative_signal_count >= 4);
  assert.equal(parsed.entries.find((entry) => entry.signal_kind === "verifier_result")?.authority_effect, "counter_evidence");
  assert.equal(parsed.entries.find((entry) => entry.signal_kind === "provider_protocol_failure")?.authority_effect, "quarantine");
  assert.equal(parsed.entries.find((entry) => entry.signal_kind === "maintenance_effect")?.numeric_value, 4);
});

test("memory write persists runtime signal ledger on execution-native nodes", async () => {
  const dbPath = tmpDbPath("persist");
  const store = createLiteWriteStore(dbPath);
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "Runtime observed a failed verifier result with retry and provider failure signals.",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            client_id: "runtime-signal-ledger-node",
            type: "event",
            title: "Runtime signal observation",
            text_summary: "Verifier failed after retries and provider transport failure.",
            slots: {
              summary_kind: "runtime_signal_observation",
              compression_layer: "L0",
              execution_result_summary: {
                status: "failed",
                validation_passed: false,
                validation_boundary: "runtime_orchestrator",
                failure_reason: "provider transport failure interrupted verifier",
                retry_count: 3,
                recovery_cost: 5,
                protocol_failure: true,
                evidence_refs: ["run:signal-ledger"],
              },
              tool_selection_outcome_v1: {
                status: "failed",
                decision_id: "decision:tool-select",
              },
            },
          },
        ],
        edges: [],
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

    const preparedLedger = RuntimeSignalLedgerV1Schema.parse(prepared.nodes[0]?.slots.runtime_signal_ledger_v1);
    assert.ok(preparedLedger.entries.some((entry) => entry.signal_kind === "verifier_result"));
    assert.ok(preparedLedger.entries.some((entry) => entry.signal_kind === "provider_protocol_failure"));
    assert.ok(preparedLedger.entries.some((entry) => entry.signal_kind === "tool_selection_outcome"));

    await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const { rows } = await store.findNodes({
      scope: "default",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    const stored = rows.find((row) => row.client_id === "runtime-signal-ledger-node");
    const storedLedger = RuntimeSignalLedgerV1Schema.parse(stored?.slots.runtime_signal_ledger_v1);
    assert.equal(storedLedger.source_code_change_allowed, false);
    assert.equal(storedLedger.quarantine_signal_count, 1);
    assert.ok(storedLedger.entries.some((entry) => entry.signal_kind === "retry_count" && entry.numeric_value === 3));
    assert.ok(storedLedger.entries.some((entry) => entry.signal_kind === "recovery_cost" && entry.numeric_value === 5));
  } finally {
    await store.close();
  }
});

test("runtime signal trends aggregate persisted ledgers across sqlite memory rows", async () => {
  const dbPath = tmpDbPath("trends");
  const store = createLiteWriteStore(dbPath);
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "Runtime observed several real execution consequence signals across runs.",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            client_id: "runtime-signal-trend-success",
            type: "event",
            title: "Successful workflow reuse signal",
            text_summary: "External verification passed and workflow reuse succeeded.",
            slots: {
              summary_kind: "runtime_signal_observation",
              compression_layer: "L0",
              execution_result_summary: {
                status: "succeeded",
                validation_passed: true,
                validation_boundary: "external_verifier",
                evidence_refs: ["run:success"],
              },
              workflow_reuse_outcome_v1: {
                status: "succeeded",
                decision_id: "workflow:reuse-success",
              },
            },
          },
          {
            client_id: "runtime-signal-trend-failure",
            type: "event",
            title: "Provider failure signal",
            text_summary: "Verifier failed after retries because provider transport failed.",
            slots: {
              summary_kind: "runtime_signal_observation",
              compression_layer: "L0",
              execution_result_summary: {
                status: "failed",
                validation_passed: false,
                validation_boundary: "runtime_orchestrator",
                failure_reason: "provider transport failure interrupted verifier",
                retry_count: 2,
                recovery_cost: 4,
                provider_failure: true,
                evidence_refs: ["run:provider-failure"],
              },
            },
          },
          {
            client_id: "runtime-signal-trend-pressure",
            type: "event",
            title: "Context pressure signal",
            text_summary: "The action packet exceeded its context budget and required broader discovery.",
            slots: {
              summary_kind: "runtime_signal_observation",
              compression_layer: "L0",
              runtime_signals_v1: {
                repeated_discovery_count: 1,
              },
              context_cost_signals_v1: {
                summary_version: "context_cost_signals_v1",
                context_est_tokens: 24000,
                context_token_budget: 12000,
                within_token_budget: false,
              },
            },
          },
        ],
        edges: [],
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

    await store.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: store,
      }),
    );

    const summary = RuntimeSignalTrendSummaryV1Schema.parse(
      await scanRuntimeSignalTrendSummaryLite(store, {
        scope: "default",
        actor: "local-user",
        limit: 10,
      }),
    );

    assert.equal(summary.source_code_change_allowed, false);
    assert.equal(summary.scanned_node_count, 3);
    assert.equal(summary.included_ledger_count, 3);
    assert.equal(summary.quarantine_signal_count, 1);
    assert.equal(summary.recommended_runtime_posture, "quarantine");
    assert.ok(summary.dominant_negative_signals.includes("provider_protocol_failure"));
    assert.ok(summary.dominant_positive_signals.includes("workflow_reuse_outcome"));
    assert.equal(summary.signal_counts.find((count) => count.signal_kind === "retry_count")?.negative, 1);
    assert.equal(summary.numeric_trends.find((trend) => trend.signal_kind === "recovery_cost")?.max, 4);
    assert.ok(summary.findings.some((finding) => finding.includes("Quarantine evidence")));
  } finally {
    await store.close();
  }
});
