import test from "node:test";
import assert from "node:assert/strict";
import { AionisClaimWriteSchema } from "../../src/memory/claim-ledger-contract.ts";

test("claim ledger accepts a singleton latest fact claim", () => {
  const parsed = AionisClaimWriteSchema.parse({
    contract_version: "aionis_claim_write_v1",
    client_id: "claim:user-location:1",
    subject_key: "user:self",
    predicate: "current_location",
    value: { city: "Shanghai" },
    slot_key: "user:self.current_location",
    claim_kind: "ordinary_fact",
    conflict_policy: "singleton_latest",
    authority: "advisory",
    confidence: 0.91,
    evidence_refs: ["conversation://2026-06-16/location"],
  });

  assert.equal(parsed.slot_key, "user:self.current_location");
  assert.equal(parsed.claim_kind, "ordinary_fact");
});

test("claim ledger applies safe defaults", () => {
  const parsed = AionisClaimWriteSchema.parse({
    contract_version: "aionis_claim_write_v1",
    subject_key: "project:checkout",
    predicate: "owner",
    value: "checkout-team",
  });

  assert.equal(parsed.conflict_policy, "manual_or_inspect");
  assert.equal(parsed.authority, "advisory");
  assert.equal(parsed.confidence, 0.5);
  assert.deepEqual(parsed.evidence_refs, []);
});

test("claim ledger rejects empty subject and predicate", () => {
  assert.throws(() =>
    AionisClaimWriteSchema.parse({
      contract_version: "aionis_claim_write_v1",
      subject_key: "",
      predicate: "current_location",
      value: { city: "Shanghai" },
    })
  );
  assert.throws(() =>
    AionisClaimWriteSchema.parse({
      contract_version: "aionis_claim_write_v1",
      subject_key: "user:self",
      predicate: "",
      value: { city: "Shanghai" },
    })
  );
});

test("claim ledger rejects invalid confidence", () => {
  assert.throws(() =>
    AionisClaimWriteSchema.parse({
      contract_version: "aionis_claim_write_v1",
      subject_key: "user:self",
      predicate: "current_location",
      value: { city: "Shanghai" },
      confidence: 1.01,
    })
  );
});

test("singleton latest claims require slot key", () => {
  assert.throws(() =>
    AionisClaimWriteSchema.parse({
      contract_version: "aionis_claim_write_v1",
      subject_key: "user:self",
      predicate: "current_location",
      value: { city: "Shanghai" },
      conflict_policy: "singleton_latest",
    }),
    /slot_key/,
  );
});

test("claim ledger bounds evidence refs", () => {
  assert.throws(() =>
    AionisClaimWriteSchema.parse({
      contract_version: "aionis_claim_write_v1",
      subject_key: "user:self",
      predicate: "current_location",
      value: { city: "Shanghai" },
      evidence_refs: Array.from({ length: 33 }, (_, index) => `evidence://${index}`),
    })
  );
});

test("trusted claims require evidence refs", () => {
  assert.throws(() =>
    AionisClaimWriteSchema.parse({
      contract_version: "aionis_claim_write_v1",
      subject_key: "user:self",
      predicate: "current_location",
      value: { city: "Shanghai" },
      authority: "trusted",
    }),
    /evidence_refs/,
  );
});

