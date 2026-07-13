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

test("duplicate client id is idempotent only for identical claim content", async () => {
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
      claim: locationClaim({ clientId: "claim:idempotent", city: "Shanghai" }),
      now: "2026-06-16T02:00:00.000Z",
    });

    assert.equal(second.claim_id, first.claim_id);
    assert.equal(second.value_text, "Shanghai");
    await assert.rejects(
      access.writeClaim({
        scope: "claim-ledger:idempotent",
        tenantId: "public",
        claim: locationClaim({ clientId: "claim:idempotent", city: "Beijing" }),
        now: "2026-06-16T03:00:00.000Z",
      }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal((error as { code?: string }).code, "claim_client_id_conflict");
        return true;
      },
    );
    await assert.rejects(
      access.writeClaim({
        scope: "claim-ledger:idempotent",
        tenantId: "public",
        claim: {
          ...locationClaim({ clientId: "claim:idempotent", city: "Shanghai" }),
          valid_from: "2026-06-17T00:00:00.000Z",
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "claim_client_id_conflict");
        return true;
      },
    );
    const events = await access.listEvents({ scope: "claim-ledger:idempotent", claimId: first.claim_id, limit: 10 });
    assert.equal(events.rows.length, 1);
  } finally {
    await store.close();
  }
});

test("same scope claim ledger rows stay isolated by tenant", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("tenant-isolation"));
  const access = store.createClaimLedgerAccess();
  try {
    const tenantA = await access.writeClaim({
      scope: "claim-ledger:shared-scope",
      tenantId: "tenant-a",
      claim: locationClaim({ clientId: "claim:shared-client", city: "Shanghai" }),
      now: "2026-06-16T01:00:00.000Z",
    });
    const tenantB = await access.writeClaim({
      scope: "claim-ledger:shared-scope",
      tenantId: "tenant-b",
      claim: locationClaim({ clientId: "claim:shared-client", city: "Beijing" }),
      now: "2026-06-16T02:00:00.000Z",
    });

    assert.notEqual(tenantA.claim_id, tenantB.claim_id);
    assert.equal(tenantA.status, "active");
    assert.equal(tenantB.status, "active");

    const liveA = await access.findLiveClaims({
      tenantId: "tenant-a",
      scope: "claim-ledger:shared-scope",
      slotKey: "user:self.current_location",
      limit: 10,
    });
    const liveB = await access.findLiveClaims({
      tenantId: "tenant-b",
      scope: "claim-ledger:shared-scope",
      slotKey: "user:self.current_location",
      limit: 10,
    });

    assert.deepEqual(liveA.rows.map((row) => row.claim_id), [tenantA.claim_id]);
    assert.deepEqual(liveB.rows.map((row) => row.claim_id), [tenantB.claim_id]);
    assert.equal(
      await access.getClaim({
        tenantId: "tenant-a",
        scope: "claim-ledger:shared-scope",
        claimId: tenantB.claim_id,
      }),
      null,
    );
  } finally {
    await store.close();
  }
});

test("concurrent singleton writes across access objects serialize into one live claim", async () => {
  const store = createLiteClaimLedgerStore(tmpDbPath("concurrent"));
  const firstAccess = store.createClaimLedgerAccess();
  const secondAccess = store.createClaimLedgerAccess();
  try {
    const seed = await firstAccess.writeClaim({
      scope: "claim-ledger:concurrent",
      tenantId: "public",
      claim: locationClaim({ clientId: "claim:concurrent:seed", city: "Shanghai" }),
      now: "2026-06-16T01:00:00.000Z",
    });

    const [first, second] = await Promise.all([
      firstAccess.writeClaim({
        scope: "claim-ledger:concurrent",
        tenantId: "public",
        claim: locationClaim({ clientId: "claim:concurrent:first", city: "Beijing" }),
        now: "2026-06-16T02:00:00.000Z",
      }),
      secondAccess.writeClaim({
        scope: "claim-ledger:concurrent",
        tenantId: "public",
        claim: locationClaim({ clientId: "claim:concurrent:second", city: "Shenzhen" }),
        now: "2026-06-16T03:00:00.000Z",
      }),
    ]);

    const live = await firstAccess.findLiveClaims({
      scope: "claim-ledger:concurrent",
      subjectKey: "user:self",
      slotKey: "user:self.current_location",
      limit: 10,
    });
    assert.equal(live.rows.length, 1);
    const liveClaimId = live.rows[0]?.claim_id;
    assert.ok(liveClaimId);
    assert.ok([first.claim_id, second.claim_id].includes(liveClaimId));

    const superseded = await firstAccess.findSupersededClaims({
      scope: "claim-ledger:concurrent",
      slotKey: "user:self.current_location",
      limit: 10,
    });
    const nonLiveConcurrentClaimId = first.claim_id === liveClaimId ? second.claim_id : first.claim_id;
    assert.equal(superseded.rows.length, 2);
    assert.deepEqual(
      new Set(superseded.rows.map((row) => row.claim_id)),
      new Set([seed.claim_id, nonLiveConcurrentClaimId]),
    );
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
