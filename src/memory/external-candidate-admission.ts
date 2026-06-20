import { randomUUID } from "node:crypto";
import {
  inferLifecycleCandidateSignals,
  lifecycleCandidateDirectUseUnsafe,
} from "./lifecycle-candidate-inference.js";
import { buildAionisMemoryAdmissionShadowPolicyReportFromRecord } from "./admission-shadow-policy.js";
import {
  parseAionisAgentContext,
  AionisExternalMemoryCandidateSchema,
  parseAionisMemoryAdmissionRecord,
  parseAionisMemoryFirewallSummary,
  parseAionisMemoryUseReceipt,
  type AionisAgentContext,
  type AionisExternalMemoryCandidate,
  type AionisExternalMemoryLifecycleHint,
  type AionisGuidanceAuthority,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryDecisionSurface,
  type AionisMemoryDomain,
  type AionisMemoryFirewallSummary,
  type AionisMemoryUseReceipt,
  type AionisRiskLevel,
} from "./product-output-contract.js";

export type AionisMemoryAdmissionGatewayMode = "standard" | "strict" | "firewall";
export type AionisMemoryAdmissionGatewayContextMode = "standard" | "compact_agent";

export type GovernExternalMemoryCandidatesArgs = {
  tenant_id?: string | null;
  scope?: string | null;
  run_id?: string | null;
  query_text: string;
  candidates: AionisExternalMemoryCandidate[];
  mode?: AionisMemoryAdmissionGatewayMode | null;
  context_mode?: AionisMemoryAdmissionGatewayContextMode | null;
  now?: string | null;
};

export type AionisMemoryAdmissionGatewayResult = {
  contract_version: "aionis_memory_admission_gateway_result_v1";
  tenant_id: string;
  scope: string;
  run_id: string | null;
  mode: AionisMemoryAdmissionGatewayMode;
  agent_context: AionisAgentContext;
  memory_use_receipt: AionisMemoryUseReceipt;
  memory_admission_records: AionisMemoryAdmissionRecord;
  memory_firewall?: AionisMemoryFirewallSummary;
  admission_summary: {
    contract_version: "aionis_external_memory_admission_summary_v1";
    candidate_count: number;
    use_now_count: number;
    inspect_before_use_count: number;
    do_not_use_count: number;
    rehydrate_count: number;
    source_backends: string[];
    runtime_mutation: false;
    agent_prompt_included: false;
    reason: string;
  };
  source_map: {
    routes_used: string[];
    internal_surfaces_used: string[];
    omitted_internal_surfaces: string[];
  };
};

type AdmittedCandidate = {
  candidate: AionisExternalMemoryCandidate;
  action: AionisMemoryDecisionSurface;
  decision_kind: "used" | "downgraded" | "blocked" | "rehydrate" | "not_agent_facing";
  authority: AionisGuidanceAuthority;
  lifecycle_state: AionisMemoryAdmissionRecord["entries"][number]["lifecycle_state"];
  domain: AionisMemoryDomain;
  memory_type: AionisMemoryAdmissionRecord["entries"][number]["memory_type"];
  title: string | null;
  target_files: string[];
  reason_codes: string[];
  prompt_text: string;
};

const TARGET_PATH_PATTERN = /(?:^|[\s"'`])(?:src|app|lib|packages|tests?|scripts|docs|services|routes|components)\//i;

function compactStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return compactStrings(value.map((entry) => typeof entry === "string" ? entry : null)).slice(0, 64);
}

function truncateText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function titleForCandidate(candidate: AionisExternalMemoryCandidate): string | null {
  return textValue(candidate.metadata.title)
    ?? textValue(candidate.metadata.name)
    ?? truncateText(candidate.text, 96);
}

function targetFilesForCandidate(candidate: AionisExternalMemoryCandidate): string[] {
  return compactStrings([
    ...stringArray(candidate.metadata.target_files),
    ...stringArray(candidate.metadata.files),
    ...stringArray(candidate.metadata.paths),
  ]).slice(0, 32);
}

function domainForCandidate(candidate: AionisExternalMemoryCandidate): AionisMemoryDomain {
  const explicit = textValue(candidate.metadata.domain);
  if (explicit === "execution" || explicit === "general") return explicit;
  if (candidate.lifecycle_hint === "procedure") return "execution";
  if (targetFilesForCandidate(candidate).length > 0 || TARGET_PATH_PATTERN.test(candidate.text)) return "execution";
  return "general";
}

function memoryTypeForCandidate(
  candidate: AionisExternalMemoryCandidate,
): AionisMemoryAdmissionRecord["entries"][number]["memory_type"] {
  const explicit = textValue(candidate.metadata.memory_type);
  if (
    explicit === "fact"
    || explicit === "preference"
    || explicit === "project_context"
    || explicit === "procedure"
    || explicit === "event"
    || explicit === "evidence"
    || explicit === "rule"
    || explicit === "execution_memory"
    || explicit === "unknown"
  ) {
    return explicit;
  }
  if (candidate.lifecycle_hint === "procedure") return "procedure";
  if (domainForCandidate(candidate) === "execution") return "execution_memory";
  return "unknown";
}

function lifecycleStateForCandidate(
  candidate: AionisExternalMemoryCandidate,
  action: AionisMemoryDecisionSurface,
): AionisMemoryAdmissionRecord["entries"][number]["lifecycle_state"] {
  if (action === "rehydrate") return "rehydration_candidate";
  switch (candidate.lifecycle_hint) {
    case "current":
    case "procedure":
      return "active";
    case "failed":
    case "contested":
      return "contested";
    case "stale":
      return "demoted";
    case "suppressed":
      return "suppressed";
    case "archived":
      return "archived";
    case "unknown":
      return "unknown";
  }
}

function unsafeLifecycleHint(hint: AionisExternalMemoryLifecycleHint): boolean {
  return hint === "failed" || hint === "stale" || hint === "contested";
}

function actionForCandidate(args: {
  candidate: AionisExternalMemoryCandidate;
  mode: AionisMemoryAdmissionGatewayMode;
  unsafeTextSignal: boolean;
}): AionisMemoryDecisionSurface {
  const { candidate, mode, unsafeTextSignal } = args;
  const requirement = candidate.authority.evidence_requirement;
  const trust = candidate.authority.source_trust;
  const lifecycle = candidate.lifecycle_hint;
  if (requirement === "blocked" || lifecycle === "suppressed" || lifecycle === "archived") return "do_not_use";
  if (requirement === "rehydrate_before_use") return "rehydrate";
  if (unsafeTextSignal || unsafeLifecycleHint(lifecycle)) {
    return mode === "firewall" ? "do_not_use" : "inspect_before_use";
  }
  if (requirement === "inspect_before_use") return "inspect_before_use";
  const trustedEnough = mode === "strict" || mode === "firewall"
    ? trust === "trusted"
    : trust === "trusted" || trust === "known";
  if (trustedEnough && (lifecycle === "current" || lifecycle === "procedure")) return "use_now";
  return "inspect_before_use";
}

function decisionKindForAction(action: AionisMemoryDecisionSurface): AdmittedCandidate["decision_kind"] {
  switch (action) {
    case "use_now": return "used";
    case "inspect_before_use": return "downgraded";
    case "do_not_use": return "blocked";
    case "rehydrate": return "rehydrate";
    case "not_agent_facing": return "not_agent_facing";
  }
}

function authorityForAction(action: AionisMemoryDecisionSurface): AionisGuidanceAuthority {
  switch (action) {
    case "use_now": return "trusted";
    case "inspect_before_use": return "advisory";
    case "rehydrate": return "advisory";
    case "do_not_use": return "blocked";
    case "not_agent_facing": return "none";
  }
}

function promptLineForCandidate(candidate: AionisExternalMemoryCandidate, action: AionisMemoryDecisionSurface): string {
  const title = titleForCandidate(candidate) ?? candidate.external_memory_id;
  const refs = candidate.evidence_refs.length > 0 ? ` refs=${candidate.evidence_refs.slice(0, 3).join(",")}` : "";
  const body = action === "do_not_use"
    ? `${title}; reason=${candidate.lifecycle_hint}/${candidate.authority.evidence_requirement}${refs}`
    : `${title}: ${truncateText(candidate.text, action === "use_now" ? 480 : 360)}${refs}`;
  return `[${candidate.external_memory_id}] ${body}`;
}

function admittedCandidates(args: {
  candidates: AionisExternalMemoryCandidate[];
  mode: AionisMemoryAdmissionGatewayMode;
}): AdmittedCandidate[] {
  const signals = inferLifecycleCandidateSignals({
    entries: args.candidates.map((candidate) => ({
      memory_id: candidate.external_memory_id,
      title: titleForCandidate(candidate),
      summary: candidate.text,
      memory_type: memoryTypeForCandidate(candidate),
      domain: domainForCandidate(candidate),
      lifecycle_state: candidate.lifecycle_hint,
      authority: candidate.authority.source_trust,
      target_files: targetFilesForCandidate(candidate),
    })),
  });
  const unsafeSignalIds = new Set(signals.filter(lifecycleCandidateDirectUseUnsafe).map((signal) => signal.memory_id));
  return args.candidates.map((candidate) => {
    const action = actionForCandidate({
      candidate,
      mode: args.mode,
      unsafeTextSignal: unsafeSignalIds.has(candidate.external_memory_id),
    });
    const targetFiles = targetFilesForCandidate(candidate);
    const reasonCodes = compactStrings([
      "external_candidate_admission",
      `mode:${args.mode}`,
      `source_backend:${candidate.source_backend}`,
      `source_trust:${candidate.authority.source_trust}`,
      `scope:${candidate.authority.scope}`,
      `evidence_requirement:${candidate.authority.evidence_requirement}`,
      `lifecycle_hint:${candidate.lifecycle_hint}`,
      unsafeSignalIds.has(candidate.external_memory_id) ? "lifecycle_candidate_signal:unsafe_direct_use" : null,
      action === "use_now" ? "trusted_current_or_procedure_candidate" : null,
      action === "inspect_before_use" ? "candidate_requires_inspection_before_direct_use" : null,
      action === "do_not_use" ? "candidate_blocked_from_agent_action" : null,
      action === "rehydrate" ? "candidate_requires_rehydration_before_exact_use" : null,
    ]);
    return {
      candidate,
      action,
      decision_kind: decisionKindForAction(action),
      authority: authorityForAction(action),
      lifecycle_state: lifecycleStateForCandidate(candidate, action),
      domain: domainForCandidate(candidate),
      memory_type: memoryTypeForCandidate(candidate),
      title: titleForCandidate(candidate),
      target_files: targetFiles,
      reason_codes: reasonCodes,
      prompt_text: promptLineForCandidate(candidate, action),
    };
  });
}

function postureForExternal(entries: AdmittedCandidate[]): AionisAgentContext["recommended_posture"] {
  if (entries.some((entry) => entry.action === "use_now")) return "reuse_supported_history";
  if (entries.some((entry) => entry.action === "rehydrate")) return "rehydrate_before_use";
  if (entries.some((entry) => entry.action === "inspect_before_use")) return "inspect_before_use";
  if (entries.some((entry) => entry.action === "do_not_use")) return "ignore_history";
  return "ignore_history";
}

function contextAuthorityForExternal(entries: AdmittedCandidate[]): AionisGuidanceAuthority {
  if (entries.some((entry) => entry.action === "inspect_before_use" || entry.action === "rehydrate")) return "advisory";
  if (entries.some((entry) => entry.action === "do_not_use")) return "blocked";
  if (entries.some((entry) => entry.action === "use_now")) return "trusted";
  return "none";
}

function riskLevelForExternal(entries: AdmittedCandidate[]): AionisRiskLevel {
  if (entries.some((entry) => entry.action === "do_not_use" || unsafeLifecycleHint(entry.candidate.lifecycle_hint))) return "high";
  if (entries.some((entry) => entry.action === "inspect_before_use" || entry.action === "rehydrate")) return "medium";
  return "low";
}

function entryUnsafeForDirectUse(entry: AdmittedCandidate): boolean {
  return unsafeLifecycleHint(entry.candidate.lifecycle_hint)
    || entry.candidate.lifecycle_hint === "suppressed"
    || entry.candidate.lifecycle_hint === "archived"
    || entry.candidate.authority.evidence_requirement === "blocked"
    || entry.reason_codes.includes("lifecycle_candidate_signal:unsafe_direct_use");
}

function buildMemoryFirewallSummary(entries: AdmittedCandidate[]): AionisMemoryFirewallSummary {
  const directUse = entries.filter((entry) => entry.action === "use_now");
  const inspect = entries.filter((entry) => entry.action === "inspect_before_use");
  const blocked = entries.filter((entry) => entry.action === "do_not_use");
  const rehydrate = entries.filter((entry) => entry.action === "rehydrate");
  const unsafe = entries.filter(entryUnsafeForDirectUse);
  const unsafeDirectUse = unsafe.filter((entry) => entry.action === "use_now");
  const externallyUntrusted = entries.filter((entry) =>
    entry.candidate.authority.source_trust === "unknown" || entry.candidate.authority.source_trust === "untrusted"
  );
  const externallyUntrustedDirectUse = externallyUntrusted.filter((entry) => entry.action === "use_now");
  const rehydrateRequired = entries.filter((entry) => entry.candidate.authority.evidence_requirement === "rehydrate_before_use");
  const missedRehydrate = rehydrateRequired.filter((entry) => entry.action !== "rehydrate");
  const explicitBlocks = entries.filter((entry) =>
    entry.candidate.lifecycle_hint === "suppressed"
    || entry.candidate.lifecycle_hint === "archived"
    || entry.candidate.authority.evidence_requirement === "blocked"
  );
  const missedExplicitBlocks = explicitBlocks.filter((entry) => entry.action !== "do_not_use");
  const claim = (claimText: string, status: "pass" | "warn" | "fail", evidence: string) => ({
    claim: claimText,
    status,
    evidence,
  });
  return parseAionisMemoryFirewallSummary({
    contract_version: "aionis_memory_firewall_summary_v1",
    intended_use: "memory_firewall_audit",
    mode: "firewall",
    candidate_count: entries.length,
    direct_use_count: directUse.length,
    inspect_count: inspect.length,
    blocked_count: blocked.length,
    rehydrate_count: rehydrate.length,
    unsafe_candidate_count: unsafe.length,
    unsafe_direct_use_count: unsafeDirectUse.length,
    runtime_mutation: false,
    agent_prompt_included: false,
    risk_flags: compactStrings([
      unsafe.length > 0 ? `unsafe_candidate_count:${unsafe.length}` : null,
      unsafeDirectUse.length > 0 ? `unsafe_direct_use_count:${unsafeDirectUse.length}` : null,
      blocked.length > 0 ? `blocked_count:${blocked.length}` : null,
      inspect.length > 0 ? `inspect_count:${inspect.length}` : null,
      rehydrate.length > 0 ? `rehydrate_count:${rehydrate.length}` : null,
      externallyUntrusted.length > 0 ? `untrusted_or_unknown_count:${externallyUntrusted.length}` : null,
    ]),
    claims: [
      claim(
        "Unsafe lifecycle candidates cannot enter direct use.",
        unsafeDirectUse.length === 0 ? "pass" : "fail",
        `${unsafeDirectUse.length}/${unsafe.length} unsafe candidates entered use_now.`,
      ),
      claim(
        "Suppressed, archived, or policy-blocked candidates are blocked.",
        missedExplicitBlocks.length === 0 ? "pass" : "fail",
        `${explicitBlocks.length - missedExplicitBlocks.length}/${explicitBlocks.length} explicit block candidates routed to do_not_use.`,
      ),
      claim(
        "Unknown or untrusted external sources do not direct the Agent.",
        externallyUntrusted.length === 0
          ? "warn"
          : externallyUntrustedDirectUse.length === 0
            ? "pass"
            : "fail",
        `${externallyUntrustedDirectUse.length}/${externallyUntrusted.length} unknown or untrusted candidates entered use_now.`,
      ),
      claim(
        "Rehydrate-required candidates stay pointer-only until expanded.",
        rehydrateRequired.length === 0
          ? "warn"
          : missedRehydrate.length === 0
            ? "pass"
            : "fail",
        `${rehydrate.length}/${rehydrateRequired.length} rehydrate-required candidates routed to rehydrate.`,
      ),
      claim(
        "Firewall admission is read-only.",
        "pass",
        "Runtime mutation is false and external candidates are not written to memory nodes.",
      ),
    ],
    summary: `Memory Firewall routed ${entries.length} external candidates into ${directUse.length} use_now, ${inspect.length} inspect, ${blocked.length} do_not_use, and ${rehydrate.length} rehydrate decisions; unsafe direct-use count is ${unsafeDirectUse.length}.`,
  });
}

function sectionLines(title: string, entries: AdmittedCandidate[]): string[] {
  if (entries.length === 0) return [];
  return [
    `${title}:`,
    ...entries.map((entry) => `- ${entry.prompt_text}`),
  ];
}

function buildPrompt(args: {
  query_text: string;
  entries: AdmittedCandidate[];
  mode: AionisMemoryAdmissionGatewayMode;
  context_mode: AionisMemoryAdmissionGatewayContextMode;
}): string {
  const useNow = args.entries.filter((entry) => entry.action === "use_now");
  const inspect = args.entries.filter((entry) => entry.action === "inspect_before_use");
  const doNotUse = args.entries.filter((entry) => entry.action === "do_not_use");
  const rehydrate = args.entries.filter((entry) => entry.action === "rehydrate");
  const header = [
    "AIONIS_EXTERNAL_MEMORY_ADMISSION v1",
    `mode=${args.mode} context=${args.context_mode}`,
    "contract: external memory is advisory until admitted; follow use_now only, inspect inspect_before_use before action, never act from do_not_use, and rehydrate before exact use when requested.",
    `query: ${truncateText(args.query_text, 320)}`,
  ];
  return [
    ...header,
    ...sectionLines("USE_NOW", useNow),
    ...sectionLines("INSPECT_BEFORE_USE", inspect),
    ...sectionLines("DO_NOT_USE", doNotUse),
    ...sectionLines("REHYDRATE", rehydrate),
  ].join("\n");
}

function routeContractForExternal(entries: AdmittedCandidate[]): AionisAgentContext["route_contract"] {
  const active = entries.filter((entry) => entry.action === "use_now");
  const inspect = entries.filter((entry) => entry.action === "inspect_before_use");
  const blocked = entries.filter((entry) => entry.action === "do_not_use");
  const targetRows = (rows: AdmittedCandidate[], source: "should_continue" | "inspect_first" | "must_not") =>
    rows.flatMap((entry) => entry.target_files.map((target) => ({
      target,
      source_memory_id: entry.candidate.external_memory_id,
      source,
      reason: entry.reason_codes.join(","),
    })));
  const activeTargets = targetRows(active, "should_continue").map((entry) => ({
    ...entry,
    artifact_status: "unknown" as const,
    missing_policy: "restore_or_create_if_task_consistent_or_rehydrate" as const,
  }));
  const referenceOnlyTargets = targetRows(inspect, "inspect_first");
  const blockedDirectionTargets = targetRows(blocked, "must_not");
  return {
    active_targets: activeTargets,
    pending_artifacts: activeTargets.map((entry) => ({
      target: entry.target,
      source_memory_id: entry.source_memory_id,
      source: entry.source,
      reason: entry.reason,
      status: "unknown_until_host_observation" as const,
      when: "if_active_target_is_missing" as const,
      allowed_actions: ["create", "restore", "rehydrate", "report_conflict"] as const,
      preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"] as const,
      terminal_inspect_allowed: false as const,
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate" as const,
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent" as const,
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict" as const,
    })),
    reference_only_targets: referenceOnlyTargets,
    blocked_direction_targets: blockedDirectionTargets,
    evidence_sources: referenceOnlyTargets.map((entry) => ({
      ...entry,
      evidence_use: "reference_only" as const,
      direction_policy: "must_not_be_primary_route" as const,
    })),
    blocked_routes: blockedDirectionTargets.map((entry) => ({
      ...entry,
      direction_policy: "blocked_route" as const,
      evidence_use: "counter_evidence_only" as const,
    })),
    conflict_policy: "do_not_treat_missing_active_target_as_superseded" as const,
    fallback_policy: "do_not_promote_reference_or_blocked_targets" as const,
    action_policy: {
      missing_active_target_preferred_order: ["create", "restore", "rehydrate", "report_conflict"] as const,
      terminal_inspect_allowed: false as const,
      reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation" as const,
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate" as const,
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent" as const,
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict" as const,
    },
  };
}

export function governExternalMemoryCandidates(
  args: GovernExternalMemoryCandidatesArgs,
): AionisMemoryAdmissionGatewayResult {
  const tenantId = args.tenant_id?.trim() || "default";
  const scope = args.scope?.trim() || "default";
  const runId = args.run_id?.trim() || null;
  const mode = args.mode ?? "standard";
  const contextMode = args.context_mode ?? "compact_agent";
  const candidates = args.candidates.map((candidate) => AionisExternalMemoryCandidateSchema.parse(candidate));
  const entries = admittedCandidates({ candidates, mode });
  const useNow = entries.filter((entry) => entry.action === "use_now");
  const inspect = entries.filter((entry) => entry.action === "inspect_before_use");
  const doNotUse = entries.filter((entry) => entry.action === "do_not_use");
  const rehydrate = entries.filter((entry) => entry.action === "rehydrate");
  const promptText = buildPrompt({
    query_text: args.query_text,
    entries,
    mode,
    context_mode: contextMode,
  });
  const promptCharCount = promptText.length;
  const targetFiles = compactStrings(entries.flatMap((entry) => entry.target_files));
  const memoryIds = compactStrings(entries.map((entry) => entry.candidate.external_memory_id));
  const riskLevel = riskLevelForExternal(entries);
  const agentContext = parseAionisAgentContext({
    contract_version: "aionis_agent_context_v1",
    tenant_id: tenantId,
    scope,
    agent_role: "agent",
    agent_context_mode: contextMode,
    prompt_text: promptText,
    summary: `Aionis admitted ${entries.length} external memory candidates from ${compactStrings(entries.map((entry) => entry.candidate.source_backend)).length} backend(s).`,
    history_used: entries.length > 0,
    actionable_history_used: useNow.length > 0,
    recommended_posture: postureForExternal(entries),
    authority: contextAuthorityForExternal(entries),
    target_files: targetFiles,
    use_now: useNow.map((entry) => entry.prompt_text),
    inspect_before_use: inspect.map((entry) => entry.prompt_text),
    do_not_use: doNotUse.map((entry) => entry.prompt_text),
    memory_ids: memoryIds,
    use_now_memory_ids: useNow.map((entry) => entry.candidate.external_memory_id),
    inspect_before_use_memory_ids: inspect.map((entry) => entry.candidate.external_memory_id),
    do_not_use_memory_ids: doNotUse.map((entry) => entry.candidate.external_memory_id),
    command_posture: entries.map((entry) => ({
      posture: entry.action === "use_now"
        ? "should_continue"
        : entry.action === "inspect_before_use"
          ? "inspect_first"
          : entry.action === "do_not_use"
            ? "must_not"
            : "rehydrate_first",
      surface: entry.action,
      memory_id: entry.candidate.external_memory_id,
      instruction: entry.action === "use_now"
        ? "Use this admitted external memory as active context."
        : entry.action === "inspect_before_use"
          ? "Inspect this external memory before letting it direct action."
          : entry.action === "do_not_use"
            ? "Do not use this external memory to direct the Agent."
            : "Rehydrate the source evidence before exact use.",
      reason: entry.reason_codes.join(","),
      target_files: entry.target_files,
    })),
    route_contract: routeContractForExternal(entries),
    prompt_aliases: entries.map((entry) => ({
      alias: entry.title ?? entry.candidate.external_memory_id,
      memory_id: entry.candidate.external_memory_id,
      surface: entry.action === "use_now"
        ? (entry.candidate.lifecycle_hint === "procedure" ? "procedure" : "current")
        : entry.action === "inspect_before_use"
          ? "inspect"
          : entry.action === "do_not_use"
            ? "avoid"
            : "rehydrate",
    })),
    rehydrate_hints: rehydrate.map((entry) => ({
      memory_id: entry.candidate.external_memory_id,
      reason: "External memory requires raw/source evidence before exact use.",
      required: true,
    })),
    risk: {
      negative_transfer_risk: riskLevel,
      blocked_authority_count: doNotUse.length,
      stale_memory_count: entries.filter((entry) => entry.candidate.lifecycle_hint === "stale").length,
      reasons: compactStrings([
        ...entries
          .filter((entry) => entry.action !== "use_now")
          .flatMap((entry) => entry.reason_codes),
      ]).slice(0, 32),
    },
    evidence_refs: {
      memory_ids: memoryIds,
      workflow_ids: [],
      evidence_count: entries.reduce((total, entry) => total + entry.candidate.evidence_refs.length, 0),
    },
  });
  const receipt = parseAionisMemoryUseReceipt({
    contract_version: "aionis_memory_use_receipt_v1",
    intended_use: "memory_use_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: `external-admission:${runId ?? randomUUID()}`,
    history_used: entries.length > 0,
    actionable_history_used: useNow.length > 0,
    prompt_char_count: promptCharCount,
    exposed_memory_ids: memoryIds,
    use_now_memory_ids: useNow.map((entry) => entry.candidate.external_memory_id),
    inspect_before_use_memory_ids: inspect.map((entry) => entry.candidate.external_memory_id),
    do_not_use_memory_ids: doNotUse.map((entry) => entry.candidate.external_memory_id),
    rehydrate_memory_ids: rehydrate.map((entry) => entry.candidate.external_memory_id),
    attributed_memory_ids: [],
    unattributed_recalled_memory_ids: [],
    read_only_signal_memory_ids: entries
      .filter((entry) => entry.action !== "use_now")
      .map((entry) => entry.candidate.external_memory_id),
    decision_summaries: entries.map((entry) => ({
      memory_id: entry.candidate.external_memory_id,
      agent_surface: entry.action,
      decision_kind: entry.decision_kind,
      actionable: entry.action === "use_now",
      reason_codes: entry.reason_codes,
    })),
    risk_flags: compactStrings([
      riskLevel !== "low" ? `negative_transfer_risk:${riskLevel}` : null,
      ...entries.filter((entry) => entry.action !== "use_now").flatMap((entry) => entry.reason_codes),
    ]).slice(0, 64),
    summary: `Aionis routed ${entries.length} external memory candidates into ${useNow.length} use_now, ${inspect.length} inspect_before_use, ${doNotUse.length} do_not_use, and ${rehydrate.length} rehydrate decisions; receipt is read-only and excluded from the Agent prompt.`,
  });
  const baseAdmissionRecord = parseAionisMemoryAdmissionRecord({
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "external_candidate_admission",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: tenantId,
    scope,
    guide_trace_id: receipt.guide_trace_id,
    prompt_char_count: promptCharCount,
    history_used: entries.length > 0,
    actionable_history_used: useNow.length > 0,
    candidate_memory_count: entries.length,
    prompt_included_memory_count: entries.length,
    agent_used_memory_count: 0,
    entries: entries.map((entry) => ({
      memory_id: entry.candidate.external_memory_id,
      title: entry.title,
      memory_origin: "external",
      source_backend: entry.candidate.source_backend,
      domain: entry.domain,
      memory_type: entry.memory_type,
      lifecycle_state: entry.lifecycle_state,
      authority: entry.authority,
      admission_action: entry.action,
      decision_kind: entry.decision_kind,
      actionable: entry.action === "use_now",
      prompt_included: true,
      agent_used: false,
      feedback_outcome: null,
      attribution_strength: null,
      reason_codes: entry.reason_codes,
      evidence_ids: entry.candidate.evidence_refs,
    })),
    summary: `Aionis recorded ${entries.length} external memory admission decisions; record is read-only, backend-agnostic, and excluded from the Agent prompt.`,
  });
  const admissionRecord = parseAionisMemoryAdmissionRecord({
    ...baseAdmissionRecord,
    shadow_policy_report: buildAionisMemoryAdmissionShadowPolicyReportFromRecord(
      baseAdmissionRecord,
      "external_candidate_admission",
    ),
  });
  const memoryFirewall = mode === "firewall" ? buildMemoryFirewallSummary(entries) : undefined;
  return {
    contract_version: "aionis_memory_admission_gateway_result_v1",
    tenant_id: tenantId,
    scope,
    run_id: runId,
    mode,
    agent_context: agentContext,
    memory_use_receipt: receipt,
    memory_admission_records: admissionRecord,
    ...(memoryFirewall ? { memory_firewall: memoryFirewall } : {}),
    admission_summary: {
      contract_version: "aionis_external_memory_admission_summary_v1",
      candidate_count: entries.length,
      use_now_count: useNow.length,
      inspect_before_use_count: inspect.length,
      do_not_use_count: doNotUse.length,
      rehydrate_count: rehydrate.length,
      source_backends: compactStrings(entries.map((entry) => entry.candidate.source_backend)),
      runtime_mutation: false,
      agent_prompt_included: false,
      reason: "External candidates were routed through Aionis admission surfaces without writing Runtime memory.",
    },
    source_map: {
      routes_used: ["/v1/memory/govern"],
      internal_surfaces_used: ["external_candidate_admission", "memory_use_receipt", "memory_admission_record"],
      omitted_internal_surfaces: ["semantic_recall", "memory_write", "raw_external_payload_store"],
    },
  };
}
