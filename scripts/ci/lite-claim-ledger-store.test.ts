import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteClaimLedgerStore } from "../../src/store/lite-claim-ledger-store.ts";
import type { AionisClaimWrite } from "../../src/memory/claim-ledger-contract.ts";

function tmpDbPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aionis-claim-ledger-")), `${name}.sqlite`);
}

function locationClaim(input: {
  clientId: string;
  city: string;
  conflictPolicy?: AionisClaimWrite["conflict_policy"];
  authority?: AionisClaimWrite["authority"];
}): AionisClaimWrite {
  return {
    contract_version: "aionis_claim_write_v1",
    client_id: input.clientId,
    subject_key: "user:self",
    predicate: "current_location",
    value: { city: input.city },
    value_text: input.city,
    slot_key: "user:self.current_location",
    claim_kind: "ordinary_fact",
    conflict_policy: input.conflictPolicy ?? "singleton_latest",
    authority: input.authority ?? "advisory",
    confidence: 0.9,
    evidence_refs: [`conversation://location/${input.city}`],
  };
}

test("singleton latest supersedes the prior live claim in the same slot", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("singleton"));
  const access = store.createClaimLedgerAccess();
  try {
    const oldClaim = await access.writeClaim({
      scope: "claim-ledger:test",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:location:old", city: "Shanghai" }),
      now: "2026-06-16T01:00:00.000Z",
    });
    const currentClaim = await access.writeClaim({
      scope: "claim-ledger:test",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:location:current", city: "Beijing" }),
      now: "2026-06-16T02:00:00.000Z",
    });

    const live = await access.findLiveClaims({
      scope: "claim-ledger:test",
      subjectKey: "user:self",
      slotKey: "user:self.current_location",
      limit: 10,
    });

    assert.deepEqual(live.rows.map((row) => row.claim_id), [currentClaim.claim_id]);
    const old = await access.getClaim({ scope: "claim-ledger:test", claimId: oldClaim.claim_id });
    assert.equal(old?.status, "superseded");
    assert.equal(old?.valid_until, "2026-06-16T02:00:00.000Z");
    assert.equal(old?.superseded_by_claim_id, currentClaim.claim_id);

    const superseded = await access.findSupersededClaims({
      scope: "claim-ledger:test",
      slotKey: "user:self.current_location",
      limit: 10,
    });
    assert.deepEqual(superseded.rows.map((row) => row.claim_id), [oldClaim.claim_id]);
  } finally {
    await store.close();
  }
});

test("multi value claims on the same slot remain active", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("multi"));
  const access = store.createClaimLedgerAccess();
  try {
    const first = await access.writeClaim({
      scope: "claim-ledger:multi",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:multi:one", city: "Shanghai", conflictPolicy: "multi_value" }),
      now: "2026-06-16T01:00:00.000Z",
    });
    const second = await access.writeClaim({
      scope: "claim-ledger:multi",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:multi:two", city: "Beijing", conflictPolicy: "multi_value" }),
      now: "2026-06-16T02:00:00.000Z",
    });

    const live = await access.findLiveClaims({
      scope: "claim-ledger:multi",
      slotKey: "user:self.current_location",
      limit: 10,
    });

    assert.deepEqual(new Set(live.rows.map((row) => row.claim_id)), new Set([first.claim_id, second.claim_id]));
    assert.ok(live.rows.every((row) => row.status === "active"));
  } finally {
    await store.close();
  }
});

test("manual inspect claims remain contested", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("manual"));
  const access = store.createClaimLedgerAccess();
  try {
    const claim = await access.writeClaim({
      scope: "claim-ledger:manual",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:manual", city: "Shanghai", conflictPolicy: "manual_or_inspect" }),
      now: "2026-06-16T01:00:00.000Z",
    });

    assert.equal(claim.status, "contested");
    const live = await access.findLiveClaims({
      scope: "claim-ledger:manual",
      slotKey: "user:self.current_location",
      limit: 10,
    });
    assert.deepEqual(live.rows.map((row) => row.claim_id), [claim.claim_id]);
  } finally {
    await store.close();
  }
});

test("blocked claims are retired and never live", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("blocked"));
  const access = store.createClaimLedgerAccess();
  try {
    const claim = await access.writeClaim({
      scope: "claim-ledger:blocked",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:blocked", city: "Shanghai", authority: "blocked" }),
      now: "2026-06-16T01:00:00.000Z",
    });

    assert.equal(claim.status, "retired");
    const live = await access.findLiveClaims({
      scope: "claim-ledger:blocked",
      slotKey: "user:self.current_location",
      limit: 10,
    });
    assert.equal(live.rows.length, 0);
  } finally {
    await store.close();
  }
});

test("duplicate client id is idempotent", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("idempotent"));
  const access = store.createClaimLedgerAccess();
  try {
    const first = await access.writeClaim({
      scope: "claim-ledger:idempotent",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:idempotent", city: "Shanghai" }),
      now: "2026-06-16T01:00:00.000Z",
    });
    const second = await access.writeClaim({
      scope: "claim-ledger:idempotent",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:idempotent", city: "Beijing" }),
      now: "2026-06-16T02:00:00.000Z",
    });

    assert.equal(second.claim_id, first.claim_id);
    assert.equal(second.value_text, "Shanghai");
    const events = await access.listEvents({ scope: "claim-ledger:idempotent", claimId: first.claim_id, limit: 10 });
    assert.equal(events.rows.length, 1);
  } finally {
    await store.close();
  }
});

test("query by scope never leaks across scopes", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("scope"));
  const access = store.createClaimLedgerAccess();
  try {
    const visible = await access.writeClaim({
      scope: "claim-ledger:scope-a",
      tenantId: "tenant-a",
      claim: locationClaim({ clientId: "claim:scope:a", city: "Shanghai" }),
      now: "2026-06-16T01:00:00.000Z",
    });
    await access.writeClaim({
      scope: "claim-ledger:scope-b",
      tenantId: "tenant-b",
      claim: locationClaim({ clientId: "claim:scope:b", city: "Beijing" }),
      now: "2026-06-16T02:00:00.000Z",
    });

    const live = await access.findLiveClaims({
      scope: "claim-ledger:scope-a",
      subjectKey: "user:self",
      slotKey: "user:self.current_location",
      limit: 10,
    });

    assert.deepEqual(live.rows.map((row) => row.claim_id), [visible.claim_id]);
    assert.equal(await access.getClaim({ scope: "claim-ledger:scope-a", claimId: "missing" }), null);
  } finally {
    await store.close();
  }
});

