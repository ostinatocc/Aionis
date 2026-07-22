import assert from "node:assert/strict";
import test from "node:test";

import { continuationRuntimeV1WorkerPrincipal } from
  "../../src/runtime-v1/worker-identity.js";

const DATABASE_ID = "a".repeat(64);

test("worker authority is stable per database and role but separated across roles", () => {
  const roles = ["embedding", "ann", "effect", "retention"] as const;
  const principals = roles.map((worker_role) => continuationRuntimeV1WorkerPrincipal({
    database_instance_id: DATABASE_ID,
    worker_role,
  }));
  assert.equal(new Set(principals.map((value) => value.actor_principal_sha256)).size, 4);
  assert.deepEqual(
    continuationRuntimeV1WorkerPrincipal({
      database_instance_id: DATABASE_ID,
      worker_role: "effect",
    }),
    principals[2],
  );
  assert.ok(principals.every((value) => value.actor_kind === "worker" && Object.isFrozen(value)));
});

test("worker identity rejects open roles, invalid database identity, and ambiguous input", () => {
  assert.throws(() => continuationRuntimeV1WorkerPrincipal({
    database_instance_id: DATABASE_ID,
    worker_role: "eval" as never,
  }), /worker_role_invalid/u);
  assert.throws(() => continuationRuntimeV1WorkerPrincipal({
    database_instance_id: "A".repeat(64),
    worker_role: "effect",
  }), /SHA-256/u);
  assert.throws(() => continuationRuntimeV1WorkerPrincipal({
    database_instance_id: DATABASE_ID,
    worker_role: "effect",
    extra: true,
  } as never), /shape_invalid/u);
});
