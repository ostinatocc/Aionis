import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { buildLiteRouteMatrix } from "../../src/server/lite-runtime-boundary.ts";
import {
  RuntimeBoundaryInventoryResponseSchema,
  runtimeBoundaryInventoryFiles,
  runtimeBoundaryInventorySummary,
} from "../../src/memory/runtime-boundary-inventory.ts";
import { registerRuntimeBoundaryInventoryRoutes } from "../../src/server/http-server.ts";

function buildEnv() {
  return {
    AIONIS_EDITION: "lite",
  } as any;
}

test("runtime boundary inventory route exposes a read-only source-owned surface", async () => {
  const app = Fastify();
  registerRuntimeErrorHandler(app);
  registerRuntimeBoundaryInventoryRoutes({
    app,
    env: buildEnv(),
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/runtime/boundary-inventory",
    });

    assert.equal(response.statusCode, 200);
    const body = RuntimeBoundaryInventoryResponseSchema.parse(JSON.parse(response.body));
    const summary = runtimeBoundaryInventorySummary();

    assert.deepEqual(Object.keys(body), [
      "surface_version",
      "inventory_source",
      "surface_semantics",
      "summary",
      "files",
      "entries",
      "sources",
    ]);
    assert.deepEqual(Object.keys(body.sources), ["authority"]);
    assert.equal(body.surface_version, "runtime_boundary_inventory_response_v1");
    assert.equal(body.inventory_source, "source_boundary_manifests");
    assert.deepEqual(body.surface_semantics, {
      read_only: true,
      persistence_effect: "none",
      authority_effect: "none",
      runtime_decision_effect: "none",
      intended_use: "operator_debug_boundary_audit",
    });
    assert.deepEqual(body.summary, summary);
    assert.deepEqual(body.files, runtimeBoundaryInventoryFiles());
    assert.equal(body.entries.length, summary.total_entries);
    assert.equal(body.sources.authority.length, summary.authority_entries);
    assert.deepEqual(Object.keys(body.sources.authority[0] ?? {}), [
      "source",
      "inventory_id",
      "source_id",
      "file",
      "layer",
      "role",
      "producer_kind",
      "authority_rules",
      "capabilities",
      "required_source_markers",
    ]);
    assert.ok(
      body.sources.authority.some((entry) =>
        entry.authority_rules.includes("candidate_workflow_reuse_is_inspect_or_rehydrate_only"),
      ),
      "route contract must expose read-side authority rules",
    );
    assert.ok(body.files.includes("src/memory/authority-producer-registry.ts"));
  } finally {
    await app.close();
  }
});

test("runtime boundary inventory is advertised as a Lite optional route", () => {
  assert.ok(
    buildLiteRouteMatrix().optional_routes.includes("runtime-boundary-inventory"),
    "route matrix must make the operator/debug inventory surface visible",
  );
});

test("runtime boundary inventory route rejects non-Lite registration", () => {
  const app = Fastify();
  assert.throws(
    () =>
      registerRuntimeBoundaryInventoryRoutes({
        app,
        env: {
          AIONIS_EDITION: "server",
        } as any,
      }),
    /only support AIONIS_EDITION=lite/,
  );
});
