import {
  RUNTIME_AUTHORITY_BOUNDARY_REGISTRY,
  type RuntimeAuthorityBoundaryDeclaration,
} from "./authority-producer-registry.js";
import { z } from "zod";

export type RuntimeBoundaryInventorySource = "authority";

export const RuntimeBoundaryInventorySourceSchema = z.enum(["authority"]);
export const RuntimeBoundaryInventoryAuthorityLayerSchema = z.enum([
  "Contract Compiler",
  "Trust Gate",
  "Orchestrator",
  "Learning Loop",
  "Schema Boundary",
]);
export const RuntimeBoundaryInventoryAuthorityRoleSchema = z.enum([
  "registry_manifest",
  "trust_gate_evaluator",
  "authority_producer",
  "authority_consumer",
  "advisory_pattern_producer",
  "read_side_summary",
  "schema_boundary",
]);
export const RuntimeBoundaryInventoryProducerKindSchema = z.enum([
  "stable_workflow",
  "authoritative_policy",
  "advisory_pattern",
]);
export const RuntimeBoundaryInventoryAuthorityCapabilitiesSchema = z.object({
  may_use_runtime_authority_gate: z.boolean(),
  may_use_outcome_contract_gate: z.boolean(),
  may_assess_execution_evidence: z.boolean(),
  may_read_raw_authority_surface: z.boolean(),
  may_use_stable_workflow_literal: z.boolean(),
  may_use_stable_pattern_literal: z.boolean(),
}).strict();
export const RuntimeBoundaryInventoryAuthorityEntrySchema = z.object({
  source: z.literal("authority"),
  inventory_id: z.string().min(1),
  source_id: z.string().min(1),
  file: z.string().min(1),
  layer: RuntimeBoundaryInventoryAuthorityLayerSchema,
  role: RuntimeBoundaryInventoryAuthorityRoleSchema,
  producer_kind: RuntimeBoundaryInventoryProducerKindSchema.nullable(),
  authority_rules: z.array(z.string().min(1)),
  capabilities: RuntimeBoundaryInventoryAuthorityCapabilitiesSchema,
  required_source_markers: z.array(z.string().min(1)),
}).strict();
export const RuntimeBoundaryInventoryEntrySchema = RuntimeBoundaryInventoryAuthorityEntrySchema;
export const RuntimeBoundaryInventorySummarySchema = z.object({
  total_entries: z.number().int().nonnegative(),
  total_files: z.number().int().nonnegative(),
  authority_entries: z.number().int().nonnegative(),
  authority_producer_entries: z.number().int().nonnegative(),
}).strict();
export const RuntimeBoundaryInventoryResponseSchema = z.object({
  surface_version: z.literal("runtime_boundary_inventory_response_v1"),
  inventory_source: z.literal("source_boundary_manifests"),
  surface_semantics: z.object({
    read_only: z.literal(true),
    persistence_effect: z.literal("none"),
    authority_effect: z.literal("none"),
    runtime_decision_effect: z.literal("none"),
    intended_use: z.literal("operator_debug_boundary_audit"),
  }).strict(),
  summary: RuntimeBoundaryInventorySummarySchema,
  files: z.array(z.string().min(1)),
  entries: z.array(RuntimeBoundaryInventoryEntrySchema),
  sources: z.object({
    authority: z.array(RuntimeBoundaryInventoryAuthorityEntrySchema),
  }).strict(),
}).strict();

export type RuntimeBoundaryInventoryEntry = z.infer<typeof RuntimeBoundaryInventoryEntrySchema>;

export type RuntimeAuthorityBoundaryInventoryEntry = RuntimeBoundaryInventoryEntry;
export type RuntimeAuthorityInventoryCapability = keyof RuntimeAuthorityBoundaryInventoryEntry["capabilities"];

export type RuntimeBoundaryInventoryResponse = z.infer<typeof RuntimeBoundaryInventoryResponseSchema>;

function authorityInventoryEntry(entry: RuntimeAuthorityBoundaryDeclaration): RuntimeBoundaryInventoryEntry {
  return {
    source: "authority",
    inventory_id: `authority:${entry.id}`,
    source_id: entry.id,
    file: entry.file,
    layer: entry.layer,
    role: entry.role,
    producer_kind: entry.producerKind ?? null,
    authority_rules: [...(entry.authorityRules ?? [])],
    capabilities: {
      may_use_runtime_authority_gate: entry.mayUseRuntimeAuthorityGate === true,
      may_use_outcome_contract_gate: entry.mayUseOutcomeContractGate === true,
      may_assess_execution_evidence: entry.mayAssessExecutionEvidence === true,
      may_read_raw_authority_surface: entry.mayReadRawAuthoritySurface === true,
      may_use_stable_workflow_literal: entry.mayUseStableWorkflowLiteral === true,
      may_use_stable_pattern_literal: entry.mayUseStablePatternLiteral === true,
    },
    required_source_markers: [...(entry.requiredSourceMarkers ?? [])],
  };
}

function cloneInventoryEntry(entry: RuntimeBoundaryInventoryEntry): RuntimeBoundaryInventoryEntry {
  return {
    ...entry,
    authority_rules: [...entry.authority_rules],
    capabilities: { ...entry.capabilities },
    required_source_markers: [...entry.required_source_markers],
  };
}

function uniqueSortedFiles(entries: readonly RuntimeBoundaryInventoryEntry[]): string[] {
  return Array.from(new Set(entries.map((entry) => entry.file))).sort();
}

export const RUNTIME_BOUNDARY_INVENTORY: readonly RuntimeBoundaryInventoryEntry[] = [
  ...RUNTIME_AUTHORITY_BOUNDARY_REGISTRY.map(authorityInventoryEntry),
];

export function runtimeBoundaryInventoryEntries(): RuntimeBoundaryInventoryEntry[] {
  return RUNTIME_BOUNDARY_INVENTORY.map(cloneInventoryEntry);
}

export function runtimeBoundaryInventoryEntriesBySource(source: "authority"): RuntimeAuthorityBoundaryInventoryEntry[];
export function runtimeBoundaryInventoryEntriesBySource(
  source: RuntimeBoundaryInventorySource,
): RuntimeBoundaryInventoryEntry[] {
  return RUNTIME_BOUNDARY_INVENTORY
    .filter((entry) => entry.source === source)
    .map(cloneInventoryEntry);
}

export function runtimeBoundaryInventoryFiles(): string[] {
  return uniqueSortedFiles(RUNTIME_BOUNDARY_INVENTORY);
}

export function runtimeBoundaryInventoryEntriesByFile(file: string): RuntimeBoundaryInventoryEntry[] {
  return RUNTIME_BOUNDARY_INVENTORY
    .filter((entry) => entry.file === file)
    .map(cloneInventoryEntry);
}

export function runtimeBoundaryInventoryAuthorityEntries(): RuntimeAuthorityBoundaryInventoryEntry[] {
  return runtimeBoundaryInventoryEntriesBySource("authority");
}

export function runtimeBoundaryInventoryAuthorityProducerEntries(): RuntimeAuthorityBoundaryInventoryEntry[] {
  return runtimeBoundaryInventoryAuthorityEntries()
    .filter((entry) => entry.role === "authority_producer" || entry.role === "advisory_pattern_producer");
}

export function runtimeBoundaryInventoryAuthorityFilesByCapability(
  capability: RuntimeAuthorityInventoryCapability,
): string[] {
  return uniqueSortedFiles(
    runtimeBoundaryInventoryAuthorityEntries()
      .filter((entry) => entry.capabilities[capability] === true),
  );
}

export function runtimeBoundaryInventoryAuthorityFilesBySourceId(...sourceIds: string[]): string[] {
  const allowedIds = new Set(sourceIds);
  return uniqueSortedFiles(
    runtimeBoundaryInventoryAuthorityEntries()
      .filter((entry) => allowedIds.has(entry.source_id)),
  );
}

export function runtimeBoundaryInventorySummary(): {
  total_entries: number;
  total_files: number;
  authority_entries: number;
  authority_producer_entries: number;
} {
  const authorityEntries = runtimeBoundaryInventoryEntriesBySource("authority");
  return {
    total_entries: RUNTIME_BOUNDARY_INVENTORY.length,
    total_files: runtimeBoundaryInventoryFiles().length,
    authority_entries: authorityEntries.length,
    authority_producer_entries: authorityEntries.filter((entry) =>
      entry.source === "authority"
      && (entry.role === "authority_producer" || entry.role === "advisory_pattern_producer")
    ).length,
  };
}

export function buildRuntimeBoundaryInventoryResponse(): RuntimeBoundaryInventoryResponse {
  const authorityEntries = runtimeBoundaryInventoryEntriesBySource("authority");
  return RuntimeBoundaryInventoryResponseSchema.parse({
    surface_version: "runtime_boundary_inventory_response_v1",
    inventory_source: "source_boundary_manifests",
    surface_semantics: {
      read_only: true,
      persistence_effect: "none",
      authority_effect: "none",
      runtime_decision_effect: "none",
      intended_use: "operator_debug_boundary_audit",
    },
    summary: runtimeBoundaryInventorySummary(),
    files: runtimeBoundaryInventoryFiles(),
    entries: authorityEntries,
    sources: {
      authority: authorityEntries,
    },
  });
}
