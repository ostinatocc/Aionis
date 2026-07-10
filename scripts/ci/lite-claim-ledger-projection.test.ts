import test from "node:test";
import assert from "node:assert/strict";
import { buildClaimLedgerProjection } from "../../src/memory/product-output/operator-projections.ts";
import { AionisClaimLedgerProjectionSchema } from "../../src/memory/product-output-contract.ts";
import type { ClaimLedgerRow, ClaimLedgerStatus } from "../../src/store/claim-ledger-access.ts";

function claimRow(input: {
  claimId: string;
  valueText?: string | null;
  authority?: ClaimLedgerRow["authority"];
  status?: ClaimLedgerStatus;
  conflictPolicy?: ClaimLedgerRow["conflict_policy"];
  evidenceRefs?: string[];
  supersededBy?: string | null;
}): ClaimLedgerRow {
  return {
    claim_id: input.claimId,
    scope: "claim-ledger:projection",
    tenant_id: "tenant-a",
    client_id: input.claimId,
    subject_key: "user:self",
    predicate: "current_location",
    slot_key: "user:self.current_location",
    value_json: JSON.stringify({ secret_raw_value: "do-not-project-raw-json", city: "Shanghai" }),
    value_text: input.valueText === undefined ? "User current location is Shanghai." : input.valueText,
    claim_kind: "ordinary_fact",
    conflict_policy: input.conflictPolicy ?? "singleton_latest",
    authority: input.authority ?? "advisory",
    confidence: 0.9,
    status: input.status ?? "active",
    valid_from: "2026-06-17T01:00:00.000Z",
    valid_until: input.status === "superseded" ? "2026-06-17T02:00:00.000Z" : null,
    source_memory_id: "mem_source",
    evidence_refs_json: JSON.stringify(input.evidenceRefs ?? ["observe://claim"]),
    supersedes_claim_ids_json: "[]",
    superseded_by_claim_id: input.supersededBy ?? null,
    metadata_json: "{}",
    created_at: "2026-06-17T01:00:00.000Z",
    updated_at: "2026-06-17T01:00:00.000Z",
  };
}

test("claim ledger projection routes live advisory and trusted singleton claims to use_now", () => {
  const projection = buildClaimLedgerProjection({
    liveClaims: [
      claimRow({ claimId: "claim_advisory", authority: "advisory" }),
      claimRow({ claimId: "claim_trusted", authority: "trusted", valueText: "User timezone is Asia/Shanghai." }),
    ],
    supersededClaims: [],
    queryText: "Where is the user currently based?",
    limit: 10,
  });

  AionisClaimLedgerProjectionSchema.parse(projection);
  assert.equal(projection.contract_version, "aionis_claim_ledger_projection_v1");
  assert.deepEqual(projection.use_now.map((item) => item.claim_id), ["claim_advisory", "claim_trusted"]);
  assert.ok(projection.use_now.every((item) => item.surface === "use_now"));
  assert.ok(projection.use_now.every((item) => item.reason_code === "claim_ledger_live_singleton"));
  assert.equal(projection.live_claim_count, 2);
  assert.equal(projection.agent_prompt_included, false);
  assert.equal(projection.runtime_mutation, false);
});

test("claim ledger projection sends contested claims to inspect_before_use", () => {
  const projection = buildClaimLedgerProjection({
    liveClaims: [
      claimRow({
        claimId: "claim_contested",
        status: "contested",
        conflictPolicy: "manual_or_inspect",
        valueText: "User location may be Shanghai, but evidence is incomplete.",
      }),
    ],
    supersededClaims: [],
    limit: 10,
  });

  assert.deepEqual(projection.inspect_before_use.map((item) => item.claim_id), ["claim_contested"]);
  assert.equal(projection.inspect_before_use[0].surface, "inspect_before_use");
  assert.equal(projection.inspect_before_use[0].reason_code, "claim_ledger_contested_manual_inspect");
  assert.equal(projection.contested_claim_count, 1);
});

test("claim ledger projection sends superseded and blocked claims to do_not_use", () => {
  const projection = buildClaimLedgerProjection({
    liveClaims: [
      claimRow({
        claimId: "claim_blocked",
        authority: "blocked",
        status: "retired",
        valueText: "Old unsafe address value.",
      }),
    ],
    supersededClaims: [
      claimRow({
        claimId: "claim_old",
        status: "superseded",
        valueText: "User current location is Beijing.",
        supersededBy: "claim_new",
      }),
    ],
    limit: 10,
  });

  assert.deepEqual(projection.do_not_use.map((item) => item.claim_id), ["claim_blocked", "claim_old"]);
  assert.equal(projection.do_not_use[0].reason_code, "claim_ledger_blocked");
  assert.equal(projection.do_not_use[1].reason_code, "claim_ledger_superseded");
  assert.equal(projection.blocked_superseded_count, 1);
});

test("claim ledger projection keeps evidence-only claims audit-only", () => {
  const projection = buildClaimLedgerProjection({
    liveClaims: [
      claimRow({
        claimId: "claim_evidence",
        authority: "evidence_only",
        valueText: "External profile says user location is Shanghai.",
        evidenceRefs: ["external://profile/location"],
      }),
    ],
    supersededClaims: [],
    limit: 10,
  });

  assert.deepEqual(projection.audit_only.map((item) => item.claim_id), ["claim_evidence"]);
  assert.equal(projection.audit_only[0].surface, "audit_only");
  assert.equal(projection.audit_only[0].reason_code, "claim_ledger_evidence_only");
  assert.deepEqual(projection.audit_only[0].evidence_refs, ["external://profile/location"]);
});

test("claim ledger projection never exposes raw value_json", () => {
  const projection = buildClaimLedgerProjection({
    liveClaims: [
      claimRow({
        claimId: "claim_without_text",
        valueText: null,
      }),
    ],
    supersededClaims: [],
    limit: 10,
  });

  assert.equal(projection.use_now[0].value_text, "user:self current_location");
  assert.ok(!JSON.stringify(projection).includes("do-not-project-raw-json"));
});
