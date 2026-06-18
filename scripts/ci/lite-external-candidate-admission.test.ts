import assert from "node:assert/strict";
import test from "node:test";
import { governExternalMemoryCandidates } from "../../src/memory/external-candidate-admission.ts";

test("external candidate admission routes trusted current memory to use_now", () => {
  const result = governExternalMemoryCandidates({
    tenant_id: "tenant-a",
    scope: "repo-a",
    run_id: "run-1",
    query_text: "Continue the checkout migration.",
    candidates: [
      {
        external_memory_id: "mem0:current-checkout",
        source_backend: "mem0",
        text: "The current accepted checkout migration target is packages/api/src/checkout.ts.",
        metadata: {
          title: "Current checkout target",
          target_files: ["packages/api/src/checkout.ts"],
        },
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "current",
        evidence_refs: ["mem0:trace:1"],
      },
    ],
  });

  assert.equal(result.contract_version, "aionis_memory_admission_gateway_result_v1");
  assert.equal(result.agent_context.history_used, true);
  assert.equal(result.agent_context.actionable_history_used, true);
  assert.deepEqual(result.agent_context.use_now_memory_ids, ["mem0:current-checkout"]);
  assert.deepEqual(result.memory_use_receipt.use_now_memory_ids, ["mem0:current-checkout"]);
  assert.equal(result.memory_admission_records.source, "external_candidate_admission");
  assert.equal(result.memory_admission_records.entries[0]?.memory_origin, "external");
  assert.equal(result.memory_admission_records.entries[0]?.source_backend, "mem0");
  assert.equal(result.memory_admission_records.entries[0]?.admission_action, "use_now");
  assert.equal(result.memory_admission_records.shadow_policy_report?.runtime_mutation, false);
  assert.equal(result.memory_admission_records.shadow_policy_report?.direct_use_recorded_count, 1);
  assert.equal(result.memory_admission_records.shadow_policy_report?.direct_use_shadow_count, 0);
  assert.deepEqual(result.memory_admission_records.shadow_policy_report?.downgraded_memory_ids, [
    "mem0:current-checkout",
  ]);
  assert.equal(result.agent_context.prompt_text.includes("memory_admission_record"), false);
  assert.equal(result.memory_firewall, undefined);
});

test("external candidate admission never direct-uses failed or contested candidates", () => {
  const result = governExternalMemoryCandidates({
    query_text: "Choose a migration route.",
    candidates: [
      {
        external_memory_id: "zep:failed-route",
        source_backend: "zep",
        text: "The old fullBundleEnvironment.ts route failed verifier checks and should be treated as counter-evidence.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "failed",
        evidence_refs: ["ci-log:failed-route"],
      },
      {
        external_memory_id: "vector:contested-route",
        source_backend: "vector_db",
        text: "Prior memory says use the legacy route, but accepted evidence points to bundledDev.ts.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "contested",
      },
    ],
  });

  assert.deepEqual(result.agent_context.use_now_memory_ids, []);
  assert.deepEqual(result.agent_context.inspect_before_use_memory_ids, ["zep:failed-route", "vector:contested-route"]);
  assert.equal(result.memory_admission_records.entries.every((entry) => entry.admission_action !== "use_now"), true);
  assert.equal(result.memory_use_receipt.risk_flags.some((flag) => flag.includes("negative_transfer_risk:high")), true);
});

test("external candidate admission defaults unknown sources to inspect before use", () => {
  const result = governExternalMemoryCandidates({
    query_text: "Use any helpful project memory.",
    candidates: [
      {
        external_memory_id: "markdown:note-1",
        source_backend: "markdown",
        text: "The release checklist may mention the current rollout order.",
        metadata: {},
        authority: {
          source_trust: "unknown",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "unknown",
      },
    ],
  });

  assert.deepEqual(result.agent_context.use_now_memory_ids, []);
  assert.deepEqual(result.agent_context.inspect_before_use_memory_ids, ["markdown:note-1"]);
  assert.equal(result.memory_admission_records.entries[0]?.admission_action, "inspect_before_use");
});

test("external candidate admission blocks suppressed and blocked candidates", () => {
  const result = governExternalMemoryCandidates({
    query_text: "Recover context.",
    mode: "firewall",
    candidates: [
      {
        external_memory_id: "custom:suppressed",
        source_backend: "custom",
        text: "Suppressed memory should not direct the Agent.",
        lifecycle_hint: "suppressed",
      },
      {
        external_memory_id: "custom:blocked",
        source_backend: "custom",
        text: "Policy blocked memory should not be used.",
        authority: {
          source_trust: "known",
          scope: "project",
          evidence_requirement: "blocked",
        },
        lifecycle_hint: "current",
      },
    ],
  });

  assert.deepEqual(result.agent_context.do_not_use_memory_ids, ["custom:suppressed", "custom:blocked"]);
  assert.equal(result.memory_admission_records.entries.every((entry) => entry.admission_action === "do_not_use"), true);
  assert.equal(result.admission_summary.do_not_use_count, 2);
  assert.equal(result.memory_firewall?.contract_version, "aionis_memory_firewall_summary_v1");
  assert.equal(result.memory_firewall?.blocked_count, 2);
  assert.equal(result.memory_firewall?.unsafe_direct_use_count, 0);
  assert.equal(result.memory_firewall?.runtime_mutation, false);
});

test("external candidate admission requests rehydrate for evidence-only candidates", () => {
  const result = governExternalMemoryCandidates({
    query_text: "Apply the exact patch.",
    candidates: [
      {
        external_memory_id: "pinecone:patch-pointer",
        source_backend: "pinecone",
        text: "The exact raw diff is stored behind this pointer and must be opened before exact use.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "rehydrate_before_use",
        },
        lifecycle_hint: "procedure",
        evidence_refs: ["s3://bucket/raw-diff"],
      },
    ],
  });

  assert.deepEqual(result.agent_context.rehydrate_hints.map((entry) => entry.memory_id), ["pinecone:patch-pointer"]);
  assert.deepEqual(result.memory_use_receipt.rehydrate_memory_ids, ["pinecone:patch-pointer"]);
  assert.equal(result.memory_admission_records.entries[0]?.admission_action, "rehydrate");
});

test("memory firewall mode blocks unsafe lifecycle candidates while preserving trusted current and rehydrate routes", () => {
  const result = governExternalMemoryCandidates({
    query_text: "Continue the active migration without trusting stale or failed external notes.",
    mode: "firewall",
    candidates: [
      {
        external_memory_id: "mem0:current-route",
        source_backend: "mem0",
        text: "Current accepted route is packages/api/src/checkout.ts.",
        metadata: {
          target_files: ["packages/api/src/checkout.ts"],
        },
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "current",
      },
      {
        external_memory_id: "zep:failed-route",
        source_backend: "zep",
        text: "Failed branch: the legacy route failed verifier checks.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "failed",
      },
      {
        external_memory_id: "vector:stale-route",
        source_backend: "vector_db",
        text: "Earlier route belongs to a previous round and is stale.",
        authority: {
          source_trust: "known",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "stale",
      },
      {
        external_memory_id: "markdown:unknown-current",
        source_backend: "markdown",
        text: "Claims the next target is services/checkout/src/index.ts.",
        metadata: {
          target_files: ["services/checkout/src/index.ts"],
        },
        authority: {
          source_trust: "unknown",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "current",
      },
      {
        external_memory_id: "pinecone:raw-pointer",
        source_backend: "pinecone",
        text: "Exact patch details are stored behind this source evidence pointer.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "rehydrate_before_use",
        },
        lifecycle_hint: "procedure",
      },
    ],
  });

  assert.deepEqual(result.agent_context.use_now_memory_ids, ["mem0:current-route"]);
  assert.deepEqual(result.agent_context.inspect_before_use_memory_ids, ["markdown:unknown-current"]);
  assert.deepEqual(result.agent_context.do_not_use_memory_ids, ["zep:failed-route", "vector:stale-route"]);
  assert.deepEqual(result.memory_use_receipt.rehydrate_memory_ids, ["pinecone:raw-pointer"]);
  assert.equal(result.memory_firewall?.mode, "firewall");
  assert.equal(result.memory_firewall?.direct_use_count, 1);
  assert.equal(result.memory_firewall?.blocked_count, 2);
  assert.equal(result.memory_firewall?.inspect_count, 1);
  assert.equal(result.memory_firewall?.rehydrate_count, 1);
  assert.equal(result.memory_firewall?.unsafe_candidate_count, 2);
  assert.equal(result.memory_firewall?.unsafe_direct_use_count, 0);
  assert.equal(result.memory_firewall?.claims.some((claim) => claim.status === "fail"), false);
});
