import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_AUTHORITY_BOUNDARY_REGISTRY } from "../../src/memory/authority-producer-registry.ts";
import {
  RUNTIME_BOUNDARY_INVENTORY,
  RuntimeBoundaryInventoryResponseSchema,
  buildRuntimeBoundaryInventoryResponse,
  runtimeBoundaryInventoryAuthorityFilesByCapability,
  runtimeBoundaryInventoryAuthorityProducerEntries,
  runtimeBoundaryInventoryEntriesByFile,
  runtimeBoundaryInventoryEntriesBySource,
  runtimeBoundaryInventoryFiles,
  runtimeBoundaryInventorySummary,
} from "../../src/memory/runtime-boundary-inventory.ts";
import {
  LITE_ROUTE_CAPABILITY_MATRIX,
  type LiteRouteProductExposure,
} from "../../src/server/lite-runtime-boundary.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HTTP_SURFACE_INVENTORY_PATH = path.join(
  ROOT,
  "docs/architecture/AIONIS_RUNTIME_SURFACE_INVENTORY.md",
);

function sourceIds(source: "authority"): string[] {
  return runtimeBoundaryInventoryEntriesBySource(source)
    .map((entry) => entry.source_id)
    .sort();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

test("runtime boundary inventory aggregates the declared boundary registries without drift", () => {
  assert.equal(
    RUNTIME_BOUNDARY_INVENTORY.length,
    RUNTIME_AUTHORITY_BOUNDARY_REGISTRY.length,
    "inventory must contain every authority boundary declaration",
  );

  assert.deepEqual(
    sourceIds("authority"),
    RUNTIME_AUTHORITY_BOUNDARY_REGISTRY.map((entry) => entry.id).sort(),
    "inventory authority source ids must match authority registry ids",
  );
});

test("runtime boundary inventory entries are unique and point at existing source files", () => {
  const inventoryIds = RUNTIME_BOUNDARY_INVENTORY.map((entry) => entry.inventory_id);
  assert.equal(new Set(inventoryIds).size, inventoryIds.length, "inventory ids must be unique");

  for (const entry of RUNTIME_BOUNDARY_INVENTORY) {
    assert.ok(entry.file.startsWith("src/"), `${entry.inventory_id} must point at a Runtime source file`);
    assert.ok(fs.existsSync(path.join(ROOT, entry.file)), `${entry.inventory_id} must point at an existing file`);
    assert.ok(
      runtimeBoundaryInventoryEntriesByFile(entry.file).length > 0,
      `${entry.file} must be discoverable through file lookup`,
    );
  }
});

test("runtime boundary inventory exposes cross-cutting boundary files and summary counts", () => {
  const summary = runtimeBoundaryInventorySummary();
  assert.equal(summary.total_entries, RUNTIME_BOUNDARY_INVENTORY.length);
  assert.equal(summary.authority_entries, RUNTIME_AUTHORITY_BOUNDARY_REGISTRY.length);
  assert.equal(summary.total_files, runtimeBoundaryInventoryFiles().length);
  assert.ok(summary.authority_producer_entries > 0, "inventory must expose authority producer count");

  const files = runtimeBoundaryInventoryFiles();
  for (const file of [
    "src/memory/authority-effect-broker.ts",
    "src/memory/authority-producer-registry.ts",
    "src/memory/workflow-write-projection.ts",
  ]) {
    assert.ok(files.includes(file), `inventory must include ${file}`);
  }
});

test("runtime boundary inventory keeps authority capabilities visible", () => {
  const workflowProducer = RUNTIME_BOUNDARY_INVENTORY.find(
    (entry) => entry.source === "authority" && entry.source_id === "workflow_write_projection",
  );
  assert.equal(workflowProducer?.source, "authority");
  if (workflowProducer?.source === "authority") {
    assert.equal(workflowProducer.role, "authority_producer");
    assert.equal(workflowProducer.capabilities.may_use_runtime_authority_gate, true);
    assert.equal(workflowProducer.capabilities.may_use_stable_workflow_literal, true);
    assert.ok(workflowProducer.required_source_markers.includes("authorityGate.allows_stable_promotion"));
  }

  const actionRetrieval = RUNTIME_BOUNDARY_INVENTORY.find(
    (entry) => entry.source === "authority" && entry.source_id === "action_retrieval_outcome_gate",
  );
  assert.equal(actionRetrieval?.source, "authority");
  if (actionRetrieval?.source === "authority") {
    assert.equal(actionRetrieval.role, "authority_consumer");
    assert.ok(
      actionRetrieval.authority_rules.includes("candidate_workflow_reuse_is_inspect_or_rehydrate_only"),
      "action retrieval must publish the candidate workflow reuse boundary",
    );
    assert.ok(
      actionRetrieval.authority_rules.includes("candidate_workflow_must_not_emit_stable_workflow_tool_source"),
      "action retrieval must publish the stable tool-source boundary",
    );
  }

  const policyMaterialization = RUNTIME_BOUNDARY_INVENTORY.find(
    (entry) => entry.source === "authority" && entry.source_id === "policy_materialization_surface",
  );
  assert.equal(policyMaterialization?.source, "authority");
  if (policyMaterialization?.source === "authority") {
    assert.equal(policyMaterialization.role, "authority_consumer");
    assert.ok(
      policyMaterialization.authority_rules.includes("trusted_pattern_only_guidance_is_advisory_candidate"),
      "policy materialization must expose the trusted-pattern-only advisory boundary",
    );
    assert.ok(
      policyMaterialization.authority_rules.includes("policy_default_requires_stable_workflow_or_live_authoritative_execution_contract"),
      "policy materialization must expose the default-policy authority boundary",
    );
  }

  const authorityDecisionReporting = RUNTIME_BOUNDARY_INVENTORY.find(
    (entry) => entry.source === "authority" && entry.source_id === "authority_decision_reporting",
  );
  assert.equal(authorityDecisionReporting?.source, "authority");
  if (authorityDecisionReporting?.source === "authority") {
    assert.equal(authorityDecisionReporting.role, "read_side_summary");
    assert.ok(
      authorityDecisionReporting.authority_rules.includes("authority_decision_reporting_must_not_grant_runtime_authority"),
      "authority decision reporting must publish its read-only authority boundary",
    );
    assert.ok(
      authorityDecisionReporting.required_source_markers.includes("runtime_authority_decision_report_v1"),
      "authority decision reporting must publish its report contract marker",
    );
  }

  const executionIntrospection = RUNTIME_BOUNDARY_INVENTORY.find(
    (entry) => entry.source === "authority" && entry.source_id === "execution_introspection",
  );
  assert.equal(executionIntrospection?.source, "authority");
  if (executionIntrospection?.source === "authority") {
    assert.equal(executionIntrospection.role, "authority_consumer");
    assert.ok(
      executionIntrospection.authority_rules.includes("execution_introspection_reports_authority_decisions_read_only"),
      "execution introspection must expose authority decisions as read-only runtime diagnostics",
    );
    assert.ok(
      executionIntrospection.required_source_markers.includes("authority_decision_report"),
      "execution introspection must publish the runtime-facing authority decision report marker",
    );
  }
});

test("runtime boundary inventory exposes selector helpers for CI boundary consumers", () => {
  const authorityEntries = runtimeBoundaryInventoryEntriesBySource("authority");

  assert.deepEqual(
    runtimeBoundaryInventoryAuthorityProducerEntries().map((entry) => entry.source_id).sort(),
    authorityEntries
      .filter((entry) => entry.role === "authority_producer" || entry.role === "advisory_pattern_producer")
      .map((entry) => entry.source_id)
      .sort(),
    "authority producer helper must derive from inventory entries",
  );
  assert.deepEqual(
    runtimeBoundaryInventoryAuthorityFilesByCapability("may_use_runtime_authority_gate"),
    uniqueSorted(
      authorityEntries
        .filter((entry) => entry.capabilities.may_use_runtime_authority_gate)
        .map((entry) => entry.file),
    ),
    "authority capability helper must derive file allowlists from inventory entries",
  );
});

test("runtime boundary inventory response contract rejects passthrough fields", () => {
  const response = RuntimeBoundaryInventoryResponseSchema.parse(buildRuntimeBoundaryInventoryResponse());
  const firstEntry = response.entries[0];
  assert.ok(firstEntry, "inventory response must contain at least one entry");

  assert.throws(
    () =>
      RuntimeBoundaryInventoryResponseSchema.parse({
        ...response,
        debug_blob: true,
      }),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      RuntimeBoundaryInventoryResponseSchema.parse({
        ...response,
        surface_semantics: {
          ...response.surface_semantics,
          debug_mode: "loose",
        },
      }),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      RuntimeBoundaryInventoryResponseSchema.parse({
        ...response,
        entries: [
          {
            ...firstEntry,
            unexpected_field: "not-public-contract",
          },
        ],
      }),
    /Unrecognized key/,
  );
});

const EXPOSURES = new Set<LiteRouteProductExposure>([
  "product_entry",
  "product_support",
  "operator_support",
  "internal_evidence",
  "internal_guidance",
  "internal_control",
]);

const INTERNAL_EXPOSURES = new Set<LiteRouteProductExposure>([
  "internal_evidence",
  "internal_guidance",
  "internal_control",
]);

const DOCUMENTED_NON_INTERNAL_ROUTES = new Set([
  "POST /v1/observe",
  "POST /v1/guide",
  "POST /v1/feedback",
  "POST /v1/rehydrate",
  "POST /v1/forget",
  "POST /v1/measure",
  "POST /v1/handoff/store",
  "POST /v1/handoff/recover",
  "POST /v1/memory/resolve",
  "GET /v1/skills/candidates",
  "POST /v1/skills/candidates",
  "POST /v1/skills/candidates/:id/promote",
  "POST /v1/skills/candidates/:id/reject",
  "POST /v1/skills/candidates/:id/materialize",
  "POST /v1/operator/snapshot",
  "GET /v1/operator/authority-effect-audit",
  "POST /v1/debug/memory-decision-trace",
  "POST /v1/audit/memory-decision-report",
  "GET /v1/runtime/boundary-inventory",
]);

type InventoryRow = {
  method: string;
  path: string;
  exposure: LiteRouteProductExposure;
  runtime: string;
  sdk: string;
  mcp: string;
  aifs: string;
  cli_create: string;
  claude_code: string;
  manifest: string;
  substrate: string;
  docs_eval: string;
  public_http: string;
  replacement_service: string;
  deletion_phase: string;
};

function stripCode(value: string): string {
  return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : value;
}

function readInventoryRows(): InventoryRow[] {
  const markdown = fs.readFileSync(HTTP_SURFACE_INVENTORY_PATH, "utf8");
  return markdown
    .split("\n")
    .filter((line) => /^\| `(GET|POST)` \|/.test(line))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => stripCode(cell.trim()));
      assert.equal(cells.length, 15, `inventory row must have 15 columns: ${line}`);
      const [
        method,
        path,
        exposure,
        runtime,
        sdk,
        mcp,
        aifs,
        cliCreate,
        claudeCode,
        manifest,
        substrate,
        docsEval,
        publicHttp,
        replacementService,
        deletionPhase,
      ] = cells;
      assert.ok(EXPOSURES.has(exposure as LiteRouteProductExposure), `${method} ${path} has invalid exposure`);
      return {
        method,
        path,
        exposure: exposure as LiteRouteProductExposure,
        runtime,
        sdk,
        mcp,
        aifs,
        cli_create: cliCreate,
        claude_code: claudeCode,
        manifest,
        substrate,
        docs_eval: docsEval,
        public_http: publicHttp,
        replacement_service: replacementService,
        deletion_phase: deletionPhase,
      };
    });
}

test("Lite route matrix declares explicit exposure on every unique route", () => {
  const routeKeys = new Set<string>();

  for (const rawEntry of LITE_ROUTE_CAPABILITY_MATRIX as readonly unknown[]) {
    const entry = rawEntry as Record<string, unknown>;
    const key = `${String(entry.method)} ${String(entry.path)}`;
    assert.equal(routeKeys.has(key), false, `${key} is duplicated`);
    routeKeys.add(key);
    assert.ok(EXPOSURES.has(entry.exposure as LiteRouteProductExposure), `${key} must declare exposure directly`);
  }
});

test("surface inventory covers every matrix route and stays aligned with explicit exposure", () => {
  const rows = readInventoryRows();
  const rowsByKey = new Map(rows.map((row) => [`${row.method} ${row.path}`, row]));

  assert.equal(rows.length, LITE_ROUTE_CAPABILITY_MATRIX.length);
  assert.equal(rowsByKey.size, rows.length, "surface inventory must not duplicate route keys");

  for (const entry of LITE_ROUTE_CAPABILITY_MATRIX) {
    const key = `${entry.method} ${entry.path}`;
    const row = rowsByKey.get(key);
    assert.ok(row, `${key} is missing from the surface inventory`);
    assert.equal(row.exposure, entry.exposure, `${key} exposure differs between code and inventory`);
    assert.notEqual(row.runtime, "none", `${key} must name its Runtime owner`);
  }
});

test("only audited product and operator routes remain non-internal HTTP", () => {
  const rows = readInventoryRows();

  for (const row of rows) {
    const key = `${row.method} ${row.path}`;
    if (INTERNAL_EXPOSURES.has(row.exposure)) {
      assert.notEqual(row.public_http, "required", `${key} is internal and cannot be required public HTTP`);
      continue;
    }
    assert.ok(DOCUMENTED_NON_INTERNAL_ROUTES.has(key), `${key} is not an audited non-internal route`);
    assert.equal(row.public_http, "required", `${key} must state that its public HTTP contract is required`);
    assert.match(row.docs_eval, /^docs:(public|operator)/, `${key} must cite public or operator documentation`);
  }

  for (const key of DOCUMENTED_NON_INTERNAL_ROUTES) {
    const entry = LITE_ROUTE_CAPABILITY_MATRIX.find((candidate) => `${candidate.method} ${candidate.path}` === key);
    assert.ok(entry, `${key} is documented but absent from the route matrix`);
    assert.equal(INTERNAL_EXPOSURES.has(entry.exposure), false, `${key} must not be classified as internal`);
  }
});

test("internal HTTP routes name typed replacements and a deletion phase", () => {
  const rows = readInventoryRows();

  for (const row of rows.filter((candidate) => INTERNAL_EXPOSURES.has(candidate.exposure))) {
    const key = `${row.method} ${row.path}`;
    assert.notEqual(row.replacement_service, "none", `${key} must name a typed replacement service`);
    assert.match(row.deletion_phase, /^Task 11/, `${key} must be owned by the internal HTTP deletion phase`);
    assert.match(row.public_http, /^(remove|temporary)$/, `${key} has invalid internal HTTP disposition`);
  }
});
