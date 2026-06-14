#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAionisClient } from "../../src/sdk.ts";
import { asRecord, assertCondition } from "./runtime-agent-loop.ts";
import { closeRuntime, openRuntime } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const CURRENT_ID = "mem0:current-route";
const FAILED_ID = "zep:failed-route";
const STALE_ID = "vector:stale-note";
const CONTESTED_ID = "markdown:contested-note";
const REHYDRATE_ID = "archive:raw-evidence";
const UNKNOWN_ID = "logs:unknown-note";

function apiKey(): string | null {
  return process.env.AIONIS_MEMORY_FIREWALL_QUICKSTART_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function assertAgentPromptBoundary(value: unknown): void {
  const promptText = String(asRecord(value)?.prompt_text ?? "");
  for (const forbidden of [
    "memory_admission_records",
    "memory_use_receipt",
    "raw_external_payload_store",
    "DEPRECATED_SEARCH_EDIT",
    "OLD_CHECKOUT_IMPL",
  ]) {
    assertCondition(!promptText.includes(forbidden), `Memory Firewall prompt leaked ${forbidden}`);
  }
}

async function main() {
  const runId = `memory-firewall-${randomUUID().slice(0, 8)}`;
  const scope = `memory-firewall:${runId}`;
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const governed = await aionis.governMemory<Record<string, unknown>>({
      run_id: runId,
      query_text: "Continue the checkout migration using current external memory, but do not reuse failed or stale routes.",
      mode: "firewall",
      context_mode: "compact_agent",
      include_records: true,
      candidates: [
        {
          external_memory_id: CURRENT_ID,
          source_backend: "mem0",
          text: "Current accepted target is packages/api/src/checkout.ts.",
          metadata: {
            title: "Current checkout migration target",
            target_files: ["packages/api/src/checkout.ts"],
          },
          authority: {
            source_trust: "trusted",
            scope: "project",
            evidence_requirement: "none",
          },
          lifecycle_hint: "current",
          evidence_refs: [`evidence://memory-firewall/${runId}/current`],
        },
        {
          external_memory_id: FAILED_ID,
          source_backend: "zep",
          text: "DEPRECATED_SEARCH_EDIT changed broad files and failed verifier checks.",
          metadata: {
            title: "Rejected broad edit route",
            target_files: ["packages/api/src/search.ts"],
          },
          authority: {
            source_trust: "trusted",
            scope: "project",
            evidence_requirement: "none",
          },
          lifecycle_hint: "failed",
          evidence_refs: [`evidence://memory-firewall/${runId}/failed`],
        },
        {
          external_memory_id: STALE_ID,
          source_backend: "pinecone",
          text: "OLD_CHECKOUT_IMPL says the migration target is src/legacy/checkout.ts.",
          metadata: {
            title: "Older checkout target",
            target_files: ["src/legacy/checkout.ts"],
          },
          authority: {
            source_trust: "known",
            scope: "project",
            evidence_requirement: "none",
          },
          lifecycle_hint: "stale",
        },
        {
          external_memory_id: CONTESTED_ID,
          source_backend: "markdown",
          text: "A teammate disputed whether the broad adapter rewrite is still valid.",
          metadata: {
            title: "Contested broad rewrite note",
          },
          authority: {
            source_trust: "known",
            scope: "team",
            evidence_requirement: "inspect_before_use",
          },
          lifecycle_hint: "contested",
        },
        {
          external_memory_id: REHYDRATE_ID,
          source_backend: "archive",
          text: "Raw trace exists for the exact checkout verifier output.",
          metadata: {
            title: "Archived verifier trace pointer",
          },
          authority: {
            source_trust: "trusted",
            scope: "project",
            evidence_requirement: "rehydrate_before_use",
          },
          lifecycle_hint: "current",
          evidence_refs: [`aionis://archives/${runId}/verifier-trace`],
        },
        {
          external_memory_id: UNKNOWN_ID,
          source_backend: "logs",
          text: "Unreviewed log note mentions a possible checkout helper.",
          metadata: {
            title: "Unreviewed helper note",
          },
          authority: {
            source_trust: "unknown",
            scope: "unknown",
            evidence_requirement: "inspect_before_use",
          },
          lifecycle_hint: "unknown",
        },
      ],
    });

    const agentContext = asRecord(governed.agent_context);
    const firewall = asRecord(governed.memory_firewall);
    const admissionRecord = asRecord(governed.memory_admission_records);
    const admissionSummary = asRecord(governed.admission_summary);
    const sourceMap = asRecord(governed.source_map);
    const useNowIds = textArray(agentContext?.use_now_memory_ids);
    const inspectIds = textArray(agentContext?.inspect_before_use_memory_ids);
    const doNotUseIds = textArray(agentContext?.do_not_use_memory_ids);
    const rehydrateHintIds = Array.isArray(agentContext?.rehydrate_hints)
      ? agentContext.rehydrate_hints
        .map((entry) => asRecord(entry)?.memory_id)
        .filter((entry): entry is string => typeof entry === "string")
      : [];

    assertCondition(governed.contract_version === "aionis_memory_admission_gateway_result_v1", "Memory Firewall quickstart missing gateway result contract");
    assertCondition(agentContext?.contract_version === "aionis_agent_context_v1", "Memory Firewall quickstart missing agent context");
    assertCondition(firewall?.contract_version === "aionis_memory_firewall_summary_v1", "Memory Firewall summary missing contract");
    assertCondition(admissionRecord?.contract_version === "aionis_memory_admission_record_v1", "Memory Firewall admission record missing contract");
    assertCondition(useNowIds.includes(CURRENT_ID), "Current trusted external memory did not enter use_now");
    assertCondition(doNotUseIds.includes(FAILED_ID), "Failed external memory was not blocked");
    assertCondition(doNotUseIds.includes(STALE_ID), "Stale external memory was not blocked");
    assertCondition(doNotUseIds.includes(CONTESTED_ID), "Contested external memory was not blocked in firewall mode");
    assertCondition(rehydrateHintIds.includes(REHYDRATE_ID), "Rehydrate-required memory did not stay pointer-only");
    assertCondition(inspectIds.includes(UNKNOWN_ID), "Unknown external memory did not stay inspect_before_use");
    assertCondition(firewall.unsafe_direct_use_count === 0, "Memory Firewall allowed unsafe direct use");
    assertCondition(firewall.runtime_mutation === false, "Memory Firewall mutated Runtime state");
    assertCondition(firewall.agent_prompt_included === false, "Memory Firewall summary entered Agent prompt");
    assertCondition(textArray(sourceMap?.omitted_internal_surfaces).includes("memory_write"), "Memory Firewall source map did not omit memory write");
    assertAgentPromptBoundary(agentContext);

    const result = {
      contract_version: "aionis_memory_firewall_quickstart_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      integration_path: {
        sdk_client: "createAionisClient",
        product_loop: "external candidates -> governMemory(mode=firewall) -> agent_context + audit records",
        route: "POST /v1/memory/govern",
      },
      external_memory_governance: {
        candidate_count: admissionSummary.candidate_count,
        use_now_memory_ids: useNowIds,
        inspect_before_use_memory_ids: inspectIds,
        do_not_use_memory_ids: doNotUseIds,
        rehydrate_memory_ids: rehydrateHintIds,
      },
      memory_firewall: {
        contract_version: firewall.contract_version,
        direct_use_count: firewall.direct_use_count,
        inspect_count: firewall.inspect_count,
        blocked_count: firewall.blocked_count,
        rehydrate_count: firewall.rehydrate_count,
        unsafe_direct_use_count: firewall.unsafe_direct_use_count,
        runtime_mutation: firewall.runtime_mutation,
        agent_prompt_included: firewall.agent_prompt_included,
      },
      operator_audit: {
        memory_use_receipt_visible: asRecord(governed.memory_use_receipt)?.contract_version === "aionis_memory_use_receipt_v1",
        memory_admission_record_visible: admissionRecord.contract_version === "aionis_memory_admission_record_v1",
        memory_write_omitted: textArray(sourceMap?.omitted_internal_surfaces).includes("memory_write"),
      },
      checks: {
        current_memory_direct_use: useNowIds.includes(CURRENT_ID),
        failed_memory_blocked: doNotUseIds.includes(FAILED_ID),
        stale_memory_blocked: doNotUseIds.includes(STALE_ID),
        contested_memory_blocked: doNotUseIds.includes(CONTESTED_ID),
        unknown_memory_inspect_first: inspectIds.includes(UNKNOWN_ID),
        rehydrate_memory_pointer_only: rehydrateHintIds.includes(REHYDRATE_ID),
        unsafe_direct_use_zero: firewall.unsafe_direct_use_count === 0,
        no_runtime_mutation: firewall.runtime_mutation === false,
        prompt_boundary_preserved: true,
      },
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
