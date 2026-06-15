#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAionisClient,
  mem0SearchResultsToAionisCandidates,
  type AionisExternalMemoryCandidate,
  type AionisMem0SearchResultsInput,
} from "../../src/sdk.ts";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type Scenario = {
  id: string;
  backend_mix: string[];
  query_text: string;
  candidates: AionisExternalMemoryCandidate[];
  mem0_results?: AionisMem0SearchResultsInput;
};

type ArmScenarioResult = {
  scenario_id: string;
  direct_use_memory_ids: string[];
  unsafe_direct_use_ids: string[];
  safe_route_ids: string[];
  current_route_recalled: boolean;
  primary_route_chosen: boolean;
  audit_visible: boolean;
  context_chars: number;
};

const unsafeLifecycleHints = new Set(["failed", "stale", "contested", "suppressed", "archived", "unknown"]);

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function rehydrateMemoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry)?.memory_id)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function candidateTitle(candidate: AionisExternalMemoryCandidate): string {
  const title = asRecord(candidate.metadata)?.title;
  return typeof title === "string" && title.length > 0 ? title : candidate.external_memory_id;
}

function candidateTargetFiles(candidate: AionisExternalMemoryCandidate): string[] {
  const raw = asRecord(candidate.metadata)?.target_files;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

function unsafeForDirectUse(candidate: AionisExternalMemoryCandidate): boolean {
  if (unsafeLifecycleHints.has(candidate.lifecycle_hint ?? "unknown")) return true;
  const authority = candidate.authority;
  if (!authority) return true;
  if (authority.source_trust === "unknown" || authority.source_trust === "untrusted") return true;
  if (authority.evidence_requirement === "blocked" || authority.evidence_requirement === "rehydrate_before_use") {
    return true;
  }
  return false;
}

function safeRouteCandidate(candidate: AionisExternalMemoryCandidate): boolean {
  if (unsafeForDirectUse(candidate)) return false;
  return candidate.lifecycle_hint === "current" || candidate.lifecycle_hint === "procedure";
}

function rawContext(candidates: AionisExternalMemoryCandidate[]): string {
  return candidates
    .map((candidate, index) => {
      const targets = candidateTargetFiles(candidate);
      return [
        `RAW_MEMORY ${index + 1}`,
        `id=${candidate.external_memory_id}`,
        `backend=${candidate.source_backend}`,
        `title=${candidateTitle(candidate)}`,
        `targets=${targets.length > 0 ? targets.join(",") : "none"}`,
        candidate.text,
      ].join("\n");
    })
    .join("\n\n");
}

function rawScenarioResult(scenario: Scenario): ArmScenarioResult {
  const directUseIds = scenario.candidates.map((candidate) => candidate.external_memory_id);
  const unsafeIds = scenario.candidates
    .filter(unsafeForDirectUse)
    .map((candidate) => candidate.external_memory_id);
  const safeRouteIds = scenario.candidates
    .filter(safeRouteCandidate)
    .map((candidate) => candidate.external_memory_id);
  const primary = scenario.candidates[0];
  return {
    scenario_id: scenario.id,
    direct_use_memory_ids: directUseIds,
    unsafe_direct_use_ids: unsafeIds,
    safe_route_ids: safeRouteIds,
    current_route_recalled: safeRouteIds.every((id) => directUseIds.includes(id)),
    primary_route_chosen: !!primary && safeRouteCandidate(primary),
    audit_visible: false,
    context_chars: rawContext(scenario.candidates).length,
  };
}

function aionisScenarioResult(scenario: Scenario, governed: Record<string, unknown>): ArmScenarioResult {
  const agentContext = asRecord(governed.agent_context);
  const firewall = asRecord(governed.memory_firewall);
  const receipt = asRecord(governed.memory_use_receipt);
  const admissionRecord = asRecord(governed.memory_admission_records);
  const directUseIds = textArray(agentContext?.use_now_memory_ids);
  const rehydrateIds = rehydrateMemoryIds(agentContext?.rehydrate_hints);
  const safeRouteIds = scenario.candidates
    .filter(safeRouteCandidate)
    .map((candidate) => candidate.external_memory_id);
  const unsafeIds = scenario.candidates
    .filter((candidate) => unsafeForDirectUse(candidate))
    .map((candidate) => candidate.external_memory_id)
    .filter((id) => directUseIds.includes(id));
  const promptText = String(agentContext?.prompt_text ?? "");

  assertCondition(governed.contract_version === "aionis_memory_admission_gateway_result_v1", `${scenario.id} missing admission gateway contract`);
  assertCondition(agentContext?.contract_version === "aionis_agent_context_v1", `${scenario.id} missing agent context`);
  assertCondition(firewall?.contract_version === "aionis_memory_firewall_summary_v1", `${scenario.id} missing firewall summary`);
  assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", `${scenario.id} missing memory use receipt`);
  assertCondition(admissionRecord?.contract_version === "aionis_memory_admission_record_v1", `${scenario.id} missing admission record`);
  assertCondition(firewall.runtime_mutation === false, `${scenario.id} firewall mutated Runtime state`);
  assertCondition(firewall.agent_prompt_included === false, `${scenario.id} firewall summary entered prompt`);
  assertCondition(!promptText.includes("memory_admission_records"), `${scenario.id} prompt leaked admission records`);
  assertCondition(!promptText.includes("memory_use_receipt"), `${scenario.id} prompt leaked memory use receipt`);

  for (const candidate of scenario.candidates) {
    if (candidate.authority?.evidence_requirement === "rehydrate_before_use") {
      assertCondition(rehydrateIds.includes(candidate.external_memory_id), `${scenario.id} did not keep rehydrate candidate pointer-only`);
    }
  }

  return {
    scenario_id: scenario.id,
    direct_use_memory_ids: directUseIds,
    unsafe_direct_use_ids: unsafeIds,
    safe_route_ids: safeRouteIds,
    current_route_recalled: safeRouteIds.every((id) => directUseIds.includes(id)),
    primary_route_chosen: safeRouteIds.some((id) => directUseIds.includes(id)),
    audit_visible: true,
    context_chars: promptText.length,
  };
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarizeArm(rows: ArmScenarioResult[]) {
  return {
    scenario_count: rows.length,
    wrong_direct_use_rate: pct(rows.filter((row) => row.unsafe_direct_use_ids.length > 0).length, rows.length),
    unsafe_direct_use_count: rows.reduce((sum, row) => sum + row.unsafe_direct_use_ids.length, 0),
    primary_route_chosen_rate: pct(rows.filter((row) => row.primary_route_chosen).length, rows.length),
    current_route_recall_rate: pct(rows.filter((row) => row.current_route_recalled).length, rows.length),
    audit_coverage_rate: pct(rows.filter((row) => row.audit_visible).length, rows.length),
    mean_context_chars: mean(rows.map((row) => row.context_chars)),
  };
}

function candidate(input: {
  id: string;
  backend: string;
  text: string;
  title: string;
  lifecycle: AionisExternalMemoryCandidate["lifecycle_hint"];
  trust?: "trusted" | "known" | "untrusted" | "unknown";
  evidenceRequirement?: "none" | "inspect_before_use" | "rehydrate_before_use" | "blocked";
  targetFiles?: string[];
  evidenceRefs?: string[];
}): AionisExternalMemoryCandidate {
  return {
    external_memory_id: input.id,
    source_backend: input.backend,
    text: input.text,
    metadata: {
      title: input.title,
      ...(input.targetFiles ? { target_files: input.targetFiles } : {}),
    },
    authority: {
      source_trust: input.trust ?? "trusted",
      scope: "project",
      evidence_requirement: input.evidenceRequirement ?? "none",
    },
    lifecycle_hint: input.lifecycle,
    evidence_refs: input.evidenceRefs ?? [],
  };
}

function scenarios(runId: string): Scenario[] {
  const mem0FailedAboveCurrent = {
    results: [
      {
        id: "failed-broad-rewrite",
        memory: "FAILED_ROUTE broad checkout rewrite touched search and payments files, then failed verifier replay.",
        score: 0.97,
        metadata: {
          external_memory_id: "mem0:failed-broad-rewrite",
          title: "Rejected broad rewrite",
          target_files_json: "[\"packages/api/src/search.ts\",\"packages/api/src/payments.ts\"]",
          lifecycle_hint: "failed",
          authority_source_trust: "trusted",
          authority_scope: "project",
          authority_evidence_requirement: "none",
          evidence_refs_json: `["mem0://${runId}/failed-broad-rewrite"]`,
        },
      },
      {
        id: "current-checkout-route",
        memory: "CURRENT_ROUTE accepted target is packages/api/src/checkout.ts with verifier replay passing.",
        score: 0.91,
        metadata: {
          external_memory_id: "mem0:current-checkout-route",
          title: "Accepted checkout route",
          target_files_json: "[\"packages/api/src/checkout.ts\"]",
          lifecycle_hint: "current",
          authority_source_trust: "trusted",
          authority_scope: "project",
          authority_evidence_requirement: "none",
          evidence_refs_json: `["mem0://${runId}/current-checkout-route"]`,
        },
      },
    ],
  };
  const mem0Candidates = mem0SearchResultsToAionisCandidates(mem0FailedAboveCurrent);

  return [
    {
      id: "mem0_failed_ranked_above_current",
      backend_mix: ["mem0"],
      query_text: "Continue checkout migration without repeating the failed broad rewrite.",
      mem0_results: mem0FailedAboveCurrent,
      candidates: mem0Candidates,
    },
    {
      id: "zep_stale_premise_with_current",
      backend_mix: ["zep"],
      query_text: "Continue checkout migration from the active accepted target.",
      candidates: [
        candidate({
          id: "zep:stale-legacy-target",
          backend: "zep",
          title: "Older legacy checkout target",
          text: "STALE_ROUTE says checkout migration target is src/legacy/checkout.ts.",
          lifecycle: "stale",
          trust: "known",
          targetFiles: ["src/legacy/checkout.ts"],
        }),
        candidate({
          id: "zep:current-checkout-target",
          backend: "zep",
          title: "Current checkout target",
          text: "CURRENT_ROUTE accepted target is packages/api/src/checkout.ts.",
          lifecycle: "current",
          targetFiles: ["packages/api/src/checkout.ts"],
        }),
      ],
    },
    {
      id: "vector_contested_with_procedure",
      backend_mix: ["vector_db"],
      query_text: "Reuse the validated checkout procedure, but avoid disputed broad rewrites.",
      candidates: [
        candidate({
          id: "vector:contested-broad-adapter",
          backend: "vector_db",
          title: "Disputed broad adapter rewrite",
          text: "CONTESTED_ROUTE teammate disputed the broad adapter rewrite after new evidence.",
          lifecycle: "contested",
          trust: "known",
          evidenceRequirement: "inspect_before_use",
          targetFiles: ["packages/api/src/adapters"],
        }),
        candidate({
          id: "vector:procedure-checkout-verify",
          backend: "vector_db",
          title: "Validated checkout verifier procedure",
          text: "PROCEDURE_ROUTE patch packages/api/src/checkout.ts, then rerun checkout verifier replay.",
          lifecycle: "procedure",
          targetFiles: ["packages/api/src/checkout.ts"],
        }),
      ],
    },
    {
      id: "mixed_rehydrate_and_unknown",
      backend_mix: ["mem0", "archive", "logs"],
      query_text: "Continue the accepted checkout route and request raw verifier evidence only if needed.",
      candidates: [
        candidate({
          id: "logs:unknown-helper-note",
          backend: "logs",
          title: "Unreviewed helper note",
          text: "UNKNOWN_ROUTE unreviewed log note mentions maybe editing checkout helper.",
          lifecycle: "unknown",
          trust: "unknown",
          evidenceRequirement: "inspect_before_use",
        }),
        candidate({
          id: "archive:checkout-raw-verifier",
          backend: "archive",
          title: "Archived raw verifier trace",
          text: "RAW_EVIDENCE pointer exists for exact checkout verifier output.",
          lifecycle: "current",
          evidenceRequirement: "rehydrate_before_use",
          evidenceRefs: [`aionis://archive/${runId}/checkout-verifier`],
        }),
        candidate({
          id: "mem0:current-checkout-route-2",
          backend: "mem0",
          title: "Current checkout route",
          text: "CURRENT_ROUTE accepted target remains packages/api/src/checkout.ts.",
          lifecycle: "current",
          targetFiles: ["packages/api/src/checkout.ts"],
        }),
      ],
    },
    {
      id: "current_only_control",
      backend_mix: ["mem0"],
      query_text: "Continue the already accepted checkout migration.",
      candidates: [
        candidate({
          id: "mem0:current-only",
          backend: "mem0",
          title: "Current-only control",
          text: "CURRENT_ROUTE accepted target is packages/api/src/checkout.ts.",
          lifecycle: "current",
          targetFiles: ["packages/api/src/checkout.ts"],
        }),
      ],
    },
    {
      id: "procedure_only_control",
      backend_mix: ["vector_db"],
      query_text: "Reuse the validated verifier procedure for checkout migration.",
      candidates: [
        candidate({
          id: "vector:procedure-only",
          backend: "vector_db",
          title: "Procedure-only control",
          text: "PROCEDURE_ROUTE patch target file, run focused verifier, then record feedback attribution.",
          lifecycle: "procedure",
          targetFiles: ["packages/api/src/checkout.ts"],
        }),
      ],
    },
  ];
}

async function governScenario(args: {
  aionis: ReturnType<typeof createAionisClient>;
  scenario: Scenario;
  runId: string;
}): Promise<Record<string, unknown>> {
  const base = {
    run_id: `${args.runId}:${args.scenario.id}`,
    query_text: args.scenario.query_text,
    mode: "firewall" as const,
    context_mode: "compact_agent" as const,
    include_records: true,
  };
  if (args.scenario.mem0_results) {
    return args.aionis.governMem0SearchResults<Record<string, unknown>>({
      ...base,
      mem0_results: args.scenario.mem0_results,
    });
  }
  return args.aionis.governMemory<Record<string, unknown>>({
    ...base,
    candidates: args.scenario.candidates,
  });
}

function apiKey(): string | null {
  return process.env.AIONIS_MEMORY_FIREWALL_AB_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

async function main() {
  const runId = `memory-firewall-ab-${randomUUID().slice(0, 8)}`;
  const scope = `memory-firewall-ab:${runId}`;
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const scenarioRows = scenarios(runId);
    const rawRows = scenarioRows.map(rawScenarioResult);
    const aionisRows: ArmScenarioResult[] = [];
    for (const scenario of scenarioRows) {
      const governed = await governScenario({ aionis, scenario, runId });
      aionisRows.push(aionisScenarioResult(scenario, governed));
    }

    const rawSummary = summarizeArm(rawRows);
    const aionisSummary = summarizeArm(aionisRows);
    assertCondition(rawSummary.unsafe_direct_use_count > 0, "Raw retrieval arm did not expose unsafe memory");
    assertCondition(aionisSummary.unsafe_direct_use_count === 0, "Aionis Firewall arm exposed unsafe direct-use memory");
    assertCondition(aionisSummary.current_route_recall_rate === 100, "Aionis Firewall did not preserve current/procedure recall");
    assertCondition(aionisSummary.audit_coverage_rate === 100, "Aionis Firewall did not produce full audit coverage");

    const result = {
      contract_version: "aionis_memory_firewall_ab_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_claim:
        "Use your existing memory backend for retrieval; use Aionis Memory Firewall to adjudicate whether retrieved memory can act now.",
      methodology: {
        scenario_count: scenarioRows.length,
        backends: Array.from(new Set(scenarioRows.flatMap((scenario) => scenario.backend_mix))).sort(),
        raw_arm: "All retrieved candidates are direct Agent context.",
        aionis_arm: "The same retrieved candidates pass through governMemory(mode=firewall) before prompt use.",
        runtime_api: "POST /v1/memory/govern",
      },
      arm_comparison: {
        raw_retrieval: rawSummary,
        aionis_memory_firewall: aionisSummary,
        delta: {
          wrong_direct_use_rate_points:
            Number((rawSummary.wrong_direct_use_rate - aionisSummary.wrong_direct_use_rate).toFixed(1)),
          audit_coverage_rate_points:
            Number((aionisSummary.audit_coverage_rate - rawSummary.audit_coverage_rate).toFixed(1)),
        },
      },
      scenario_results: scenarioRows.map((scenario, index) => ({
        scenario_id: scenario.id,
        backend_mix: scenario.backend_mix,
        raw: rawRows[index],
        aionis: aionisRows[index],
      })),
      checks: {
        raw_arm_leaks_unsafe_memory: rawSummary.unsafe_direct_use_count > 0,
        aionis_blocks_unsafe_direct_use: aionisSummary.unsafe_direct_use_count === 0,
        aionis_preserves_current_and_procedure_recall: aionisSummary.current_route_recall_rate === 100,
        aionis_adds_audit_coverage: aionisSummary.audit_coverage_rate === 100,
      },
      boundary:
        "This demo measures admission after retrieval. It does not claim better backend retrieval or final external task success.",
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    closeRuntime(session);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
