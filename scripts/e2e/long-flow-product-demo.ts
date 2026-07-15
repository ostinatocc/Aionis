#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileExecutionAgentContext,
  createAionisClient,
} from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
  repoRoot,
  requireEmbeddingConfig,
  startRuntime,
  stopRuntime,
  type EmbeddingConfig,
  type RuntimeHandle,
} from "./runtime-agent-loop.ts";
import { agentContext, textArray } from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

type RuntimeSession = {
  baseUrl: string;
  mode: "external" | "spawned" | "spawned_no_embedding";
  embedding: EmbeddingConfig | null;
  handle: RuntimeHandle | {
    child: ChildProcessWithoutNullStreams;
    tmpDir: string;
    logs: string[];
  } | null;
};

type SimulatedAgentDecision = {
  next_action: "continue_active_route" | "repeat_failed_route" | "report_insufficient_context";
  plan_adherence: boolean;
  wrong_route_reuse: boolean;
  needs_rehydrate: boolean;
  rationale: string;
};

const TEAM_ID = "long-flow-demo-team";
const TASK_FAMILY = "long_flow_product_demo";
const WORKFLOW_SIGNATURE = "planner-worker-verifier-reviewer-continuation";
const ACTIVE_TARGET = "src/checkout/priceRules.ts";
const FOLLOWUP_TARGET = "tests/checkout/priceRules.test.ts";
const FAILED_TARGET = "src/checkout/legacyDiscounts.ts";
const REFERENCE_TARGET = "src/checkout/fullBundleEnvironment.ts";
const PLAN_MARKER = "LONG_FLOW_DEMO_PLAN";
const PASSED_MARKER = "LONG_FLOW_DEMO_ACCEPTED_ROUTE";
const FAILED_MARKER = "LONG_FLOW_DEMO_FAILED_ROUTE";
const FOLLOWUP_MARKER = "LONG_FLOW_DEMO_FOLLOWUP_REQUIREMENT";

function apiKey(): string | null {
  return process.env.AIONIS_LONG_FLOW_DEMO_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function embeddingConfigOrNull(): EmbeddingConfig | null {
  try {
    return requireEmbeddingConfig();
  } catch {
    return null;
  }
}

async function startNoEmbeddingRuntime(): Promise<RuntimeSession> {
  const port = await findFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-long-flow-demo-"));
  const logs: string[] = [];
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      AIONIS_LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_BYPASS_LOOPBACK: "true",
      LITE_LOCAL_ACTOR_ID: "local-user",
      LITE_WRITE_SQLITE_PATH: path.join(tmpDir, "write.sqlite"),
      LITE_REPLAY_SQLITE_PATH: path.join(tmpDir, "replay.sqlite"),
      EMBEDDING_PROVIDER: "none",
      SANDBOX_ENABLED: "false",
      SANDBOX_ADMIN_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });
  child.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, mode: "spawned_no_embedding", embedding: null, handle: { child, tmpDir, logs } };
    } catch {
      // wait for startup
    }
    await sleep(250);
  }
  closeRuntime({ baseUrl, mode: "spawned_no_embedding", embedding: null, handle: { child, tmpDir, logs } });
  throw new Error(`Aionis Runtime did not become healthy.\n${logs.join("").slice(-4_000)}`);
}

async function openDemoRuntime(): Promise<RuntimeSession> {
  const externalBaseUrl = (
    process.env.AIONIS_LONG_FLOW_DEMO_BASE_URL
    || process.env.AIONIS_PRODUCT_E2E_BASE_URL
    || process.env.AIONIS_BASE_URL
    || process.env.AIONIS_URL
    || ""
  ).trim();
  if (externalBaseUrl) {
    return { baseUrl: externalBaseUrl.replace(/\/+$/, ""), mode: "external", embedding: null, handle: null };
  }

  const embedding = embeddingConfigOrNull();
  if (embedding) {
    const handle = await startRuntime(embedding);
    return { baseUrl: handle.baseUrl, mode: "spawned", embedding, handle };
  }
  return startNoEmbeddingRuntime();
}

function closeRuntime(session: RuntimeSession): void {
  if (!session.handle) return;
  if (session.mode === "spawned" && "baseUrl" in session.handle) {
    stopRuntime(session.handle);
    return;
  }
  if (session.handle.child.exitCode === null) session.handle.child.kill("SIGTERM");
}

function firstNodeId(observeBody: unknown, label: string): string {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes.map((entry) => asRecord(entry)) : [];
  const id = nodes[0]?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} did not return a memory node id`);
  return id;
}

function optionalNodeId(observeBody: unknown): string | null {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = Array.isArray(write?.nodes) ? write.nodes.map((entry) => asRecord(entry)) : [];
  const id = nodes[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function rawTranscriptFixture(runId: string): string {
  const noisyRows = Array.from({ length: 72 }, (_, index) => {
    const branch = index % 3 === 0 ? FAILED_TARGET : index % 3 === 1 ? REFERENCE_TARGET : ACTIVE_TARGET;
    return [
      `trace-${index + 1} run=${runId}`,
      `file=${branch}`,
      index % 3 === 0
        ? `${FAILED_MARKER}: this broad route changed legacy discount code and failed verifier replay.`
        : index % 3 === 1
          ? `reference only: historical bundle environment can be read for comparison but must not become the route.`
          : `${PASSED_MARKER}: scoped pricing rule route remained the accepted continuation.`,
      "tool output included logs, retries, test names, implementation notes, and handoff comments.",
    ].join(" ");
  });
  return noisyRows.join("\n");
}

function simulateAgentDecision(args: {
  compiledPrompt: string;
  useNowText: string;
  doNotUseText: string;
  inspectText: string;
  activeTargets: string[];
  pendingTargets: string[];
  rehydrateMemoryIds: string[];
}): SimulatedAgentDecision {
  const actionable = [args.compiledPrompt, args.useNowText, args.activeTargets.join("\n"), args.pendingTargets.join("\n")].join("\n");
  const followsActiveRoute = actionable.includes(ACTIVE_TARGET)
    && (actionable.includes(FOLLOWUP_TARGET) || args.compiledPrompt.includes("pending work"));
  const wrongDirectRoute = args.activeTargets.includes(FAILED_TARGET)
    || args.useNowText.includes(FAILED_TARGET);
  const needsRehydrate = args.rehydrateMemoryIds.length > 0 || args.compiledPrompt.includes("REHYDRATE_REQUESTS");

  if (followsActiveRoute && !wrongDirectRoute) {
    return {
      next_action: "continue_active_route",
      plan_adherence: true,
      wrong_route_reuse: false,
      needs_rehydrate: needsRehydrate,
      rationale: "The next Agent received the active route, follow-up requirement, and blocked/inspect-only history separately.",
    };
  }
  if (wrongDirectRoute) {
    return {
      next_action: "repeat_failed_route",
      plan_adherence: false,
      wrong_route_reuse: true,
      needs_rehydrate: false,
      rationale: "The next Agent could not separate failed route evidence from direct-use context.",
    };
  }
  return {
    next_action: "report_insufficient_context",
    plan_adherence: false,
    wrong_route_reuse: false,
    needs_rehydrate: needsRehydrate,
    rationale: "The next Agent did not receive enough executable route state.",
  };
}

async function main() {
  const runId = `long-flow-${randomUUID().slice(0, 8)}`;
  const scope = `long-flow-product-demo:${runId}`;
  const taskSignature = `checkout-price-rules:${runId}`;
  const runtimeApiKey = apiKey();
  const session = await openDemoRuntime();

  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: runtimeApiKey ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const beforeGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: "worker-new-session",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:fresh`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: `${PLAN_MARKER}: continue checkout pricing work from prior sessions if any exists.`,
      context_mode: "compact_agent",
      include_packets: true,
      limit: 8,
    });
    const beforeContext = agentContext(beforeGuide.agent_context, "long-flow before guide");
    assertCondition(beforeContext.actionable_history_used === false, "fresh long-flow scope should not start with actionable history");

    const plannerObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "planner-strong",
      team_id: TEAM_ID,
      role: "planner",
      run_id: `run:${runId}:planner`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: `${PLAN_MARKER} checkout pricing route plan`,
      summary: `${PLAN_MARKER}: keep the active route in ${ACTIVE_TARGET}; use ${REFERENCE_TARGET} as reference only; verifier owns discount regression checks.`,
      outcome: "succeeded",
      target_files: [ACTIVE_TARGET, FOLLOWUP_TARGET],
      workflow_steps: [
        "Planner pins active pricing rule target",
        "Worker implements scoped pricing calculation",
        "Verifier rejects legacy-discount broad rewrite",
        "Reviewer confirms follow-up requirement",
      ],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: [
        "coupon and bundle discounts are applied once",
        "tax calculation remains unchanged",
        "new pricing edge case has a regression test",
      ],
      continuation_hint: `Continue ${ACTIVE_TARGET}; add tests in ${FOLLOWUP_TARGET}; do not promote ${REFERENCE_TARGET} or ${FAILED_TARGET} to active route.`,
      confidence: 0.92,
      evidence_ref: `evidence://long-flow/${runId}/planner-plan`,
      slots: {
        long_flow_demo: true,
        route_contract: {
          active_targets: [ACTIVE_TARGET, FOLLOWUP_TARGET],
          reference_only_targets: [REFERENCE_TARGET],
          blocked_direction_targets: [FAILED_TARGET],
        },
      },
    });
    const plannerMemoryId = firstNodeId(plannerObserve, "planner route");

    const failedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "worker-first-session",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:worker-failed`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: "checkout-legacy-discount-failed-branch",
      title: `${FAILED_MARKER} legacy discount route rejected`,
      summary: `${FAILED_MARKER}: broad patch in ${FAILED_TARGET} double-applied bundle discounts and failed verifier replay.`,
      outcome: "failed",
      target_files: [FAILED_TARGET],
      workflow_steps: ["inspect legacy discounts", "patch broad branch", "run checkout regression", "verifier rejected"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["legacy route rejected by checkout regression"],
      continuation_hint: `Do not continue ${FAILED_TARGET}; resume the scoped route in ${ACTIVE_TARGET}.`,
      confidence: 0.35,
      raw_ref: `trace://long-flow/${runId}/failed-legacy-route/raw`,
      evidence_ref: `evidence://long-flow/${runId}/failed-legacy-route`,
      verification: {
        verifier_agent_id: "verifier",
        passed: false,
        reason: `${FAILED_MARKER}: legacy route double-applied bundle discounts.`,
      },
      slots: {
        execution_result_summary: {
          status: "failed",
          summary: `${FAILED_MARKER}: failed route is counter-evidence, not reusable procedure.`,
          evidence_refs: [`evidence://long-flow/${runId}/failed-legacy-route`],
        },
      },
    });
    const failedMemoryId = firstNodeId(failedObserve, "failed route");

    const passedObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "worker-first-session",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:worker-passed`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: "checkout-scoped-pricing-passed-branch",
      title: `${PASSED_MARKER} scoped pricing route accepted`,
      summary: `${PASSED_MARKER}: scoped patch in ${ACTIVE_TARGET} fixed discount order without touching legacy discount route.`,
      outcome: "succeeded",
      target_files: [ACTIVE_TARGET],
      workflow_steps: ["read planner route", "patch price rules", "run unit checks", "verifier accepted"],
      tool_set: ["read", "edit", "test"],
      acceptance_checks: ["coupon and bundle discounts are applied once", "tax calculation remains unchanged"],
      continuation_hint: `Continue ${ACTIVE_TARGET}; keep ${FAILED_TARGET} blocked as failed-route evidence.`,
      confidence: 0.95,
      raw_ref: `trace://long-flow/${runId}/passed-scoped-route/raw`,
      evidence_ref: `evidence://long-flow/${runId}/passed-scoped-route`,
      verification: {
        verifier_agent_id: "verifier",
        passed: true,
        reason: `${PASSED_MARKER}: scoped route passed checkout regression.`,
      },
      slots: {
        execution_result_summary: {
          status: "passed",
          summary: `${PASSED_MARKER}: active route passed and should be reused for continuation.`,
          evidence_refs: [`evidence://long-flow/${runId}/passed-scoped-route`],
        },
      },
    });
    const passedMemoryId = firstNodeId(passedObserve, "passed route");

    const followupObserve = await aionis.execution.observeStep<Record<string, unknown>>({
      agent_id: "reviewer-second-session",
      team_id: TEAM_ID,
      role: "reviewer",
      run_id: `run:${runId}:reviewer-followup`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: `${FOLLOWUP_MARKER} add regression coverage before final handoff`,
      summary: `${FOLLOWUP_MARKER}: reviewer accepted ${ACTIVE_TARGET} route but required a targeted regression test in ${FOLLOWUP_TARGET}.`,
      outcome: "succeeded",
      target_files: [ACTIVE_TARGET, FOLLOWUP_TARGET],
      workflow_steps: ["review accepted route", "request targeted regression", "prepare next-session handoff"],
      tool_set: ["read", "test"],
      acceptance_checks: ["add regression test before final merge"],
      continuation_hint: `Next Agent should extend ${FOLLOWUP_TARGET} while preserving ${ACTIVE_TARGET}.`,
      confidence: 0.9,
      evidence_ref: `evidence://long-flow/${runId}/reviewer-followup`,
      slots: {
        execution_result_summary: {
          status: "passed",
          summary: `${FOLLOWUP_MARKER}: route remains active; add regression test next.`,
        },
      },
    });
    const followupMemoryId = firstNodeId(followupObserve, "follow-up route");

    const handoffObserve = await aionis.execution.handoff<Record<string, unknown>>({
      agent_id: "verifier",
      team_id: TEAM_ID,
      role: "verifier",
      run_id: `run:${runId}:handoff`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: "Long-flow execution handoff",
      summary: `Continue ${PASSED_MARKER} with ${FOLLOWUP_MARKER}; keep ${FAILED_MARKER} as blocked evidence.`,
      outcome: "succeeded",
      target_files: [ACTIVE_TARGET, FOLLOWUP_TARGET],
      handoff_kind: "task_handoff",
      anchor: `long-flow:${runId}:handoff`,
      handoff_text: "New session should recover active route, reviewer follow-up, failed branch, and reference-only target separation.",
      next_action: `Patch ${FOLLOWUP_TARGET} for the accepted ${ACTIVE_TARGET} route; do not extend ${FAILED_TARGET}.`,
      must_change: [FOLLOWUP_TARGET],
      must_keep: [ACTIVE_TARGET],
      must_remove: [FAILED_TARGET],
      acceptance_checks: [
        "new regression test covers bundle-plus-coupon edge case",
        "no change to legacy discount route",
      ],
      continuation_hint: `Continue ${PASSED_MARKER}; satisfy ${FOLLOWUP_MARKER}; avoid ${FAILED_MARKER}.`,
      evidence_ref: `evidence://long-flow/${runId}/handoff`,
      execution_packet_v1: {
        version: 1,
        state_id: `long-flow:${runId}:handoff-state`,
        current_stage: "patch",
        active_role: "patch",
        task_brief: "Continue checkout pricing route and add reviewer-requested regression coverage.",
        target_files: [ACTIVE_TARGET, FOLLOWUP_TARGET],
        next_action: `Patch ${FOLLOWUP_TARGET} for the accepted ${ACTIVE_TARGET} route; do not extend ${FAILED_TARGET}.`,
        hard_constraints: [
          `Do not extend ${FAILED_TARGET}.`,
          `Treat ${REFERENCE_TARGET} as reference-only evidence.`,
        ],
        accepted_facts: [
          `${PASSED_MARKER}: ${ACTIVE_TARGET} is the accepted route.`,
          `${FOLLOWUP_MARKER}: add targeted regression coverage in ${FOLLOWUP_TARGET}.`,
        ],
        rejected_paths: [FAILED_TARGET],
        pending_validations: ["run checkout price-rules regression tests"],
        unresolved_blockers: [],
        rollback_notes: [],
        review_contract: null,
        resume_anchor: {
          anchor: `long-flow:${runId}:resume`,
          file_path: ACTIVE_TARGET,
          symbol: null,
          repo_root: repoRoot,
        },
        artifact_refs: [],
        evidence_refs: [`evidence://long-flow/${runId}/handoff`],
        active_route: [ACTIVE_TARGET, FOLLOWUP_TARGET],
        failed_routes: [FAILED_TARGET],
        reference_only: [REFERENCE_TARGET],
        rehydrate_refs: [`trace://long-flow/${runId}/passed-scoped-route/raw`],
      },
    });
    const handoffMemoryId = optionalNodeId(handoffObserve);

    const afterGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: "worker-new-session",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:next-worker`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      query_text: `${FOLLOWUP_MARKER}: continue the accepted checkout pricing route and add the missing regression test.`,
      context: {
        requested_targets: [ACTIVE_TARGET, FOLLOWUP_TARGET],
        blocked_targets: [FAILED_TARGET],
        reference_only_targets: [REFERENCE_TARGET],
      },
      context_mode: "compact_agent",
      include_packets: true,
      context_char_budget: 9_000,
      limit: 12,
    });
    const afterContext = agentContext(afterGuide.agent_context, "long-flow after guide");
    assertCondition(afterContext.actionable_history_used === true, "long-flow guide did not expose actionable history");

    const compiled = compileExecutionAgentContext({
      guide: afterGuide,
      task: {
        run_id: runId,
        task_signature: taskSignature,
        query_text: `${FOLLOWUP_MARKER}: continue active route and add regression test.`,
      },
      repo_state: {
        existing_files: [ACTIVE_TARGET, REFERENCE_TARGET],
        missing_files: [FOLLOWUP_TARGET],
      },
      budget_profile: "compact",
      max_prompt_chars: 7_500,
      additional_instructions: [
        "Preserve active route state across sessions.",
        "Treat failed legacy route as counter-evidence even when its file still exists.",
        "If the follow-up test file is missing, create it as pending work instead of returning to legacy code.",
      ],
    });

    const useNowText = textArray(afterContext.use_now).join("\n");
    const doNotUseText = textArray(afterContext.do_not_use).join("\n");
    const inspectText = textArray(afterContext.inspect_before_use).join("\n");
    const promptText = compiled.agent_prompt;
    const activeTargetVisible = promptText.includes(ACTIVE_TARGET)
      || useNowText.includes(ACTIVE_TARGET)
      || compiled.active_targets.includes(ACTIVE_TARGET);
    const followupVisible = promptText.includes(FOLLOWUP_TARGET)
      || useNowText.includes(FOLLOWUP_TARGET)
      || compiled.active_targets.includes(FOLLOWUP_TARGET)
      || compiled.missing_active_targets.includes(FOLLOWUP_TARGET);
    const failedDirectUse = compiled.active_targets.includes(FAILED_TARGET)
      || useNowText.includes(FAILED_TARGET)
      || compiled.use_now_memory_ids.includes(failedMemoryId);

    assertCondition(activeTargetVisible, "long-flow context did not preserve active route target");
    assertCondition(followupVisible, "long-flow context did not preserve follow-up target");
    assertCondition(!failedDirectUse, "long-flow context direct-used failed route");
    const followupIsActiveTarget = compiled.active_targets.includes(FOLLOWUP_TARGET);
    const followupTreatedAsPending = compiled.missing_active_targets.includes(FOLLOWUP_TARGET)
      || promptText.includes("pending work")
      || promptText.includes(FOLLOWUP_TARGET);
    if (followupIsActiveTarget) {
      assertCondition(
        compiled.missing_active_targets.includes(FOLLOWUP_TARGET),
        "compiled context had follow-up as active target but did not mark it as missing/pending",
      );
      assertCondition(
        compiled.execution_warnings.some((entry) => entry.code === "missing_active_target"),
        "compiled context had missing active target but did not warn about it",
      );
    }
    assertCondition(followupTreatedAsPending, "compiled context did not preserve follow-up as pending executable work");
    assertCondition(compiled.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1", "long-flow compiled context missing Memory Use Receipt");
    assertCondition(compiled.memory_admission_record.contract_version === "aionis_memory_admission_record_v1", "long-flow compiled context missing admission record");

    const rawTranscript = rawTranscriptFixture(runId);
    const decision = simulateAgentDecision({
      compiledPrompt: promptText,
      useNowText,
      doNotUseText,
      inspectText,
      activeTargets: compiled.active_targets,
      pendingTargets: compiled.missing_active_targets,
      rehydrateMemoryIds: compiled.rehydrate_requests.map((entry) => entry.memory_id),
    });
    assertCondition(
      decision.next_action === "continue_active_route",
      `simulated next Agent did not continue active route: ${JSON.stringify({
        decision,
        active_targets: compiled.active_targets,
        missing_active_targets: compiled.missing_active_targets,
        prompt_has_active_target: promptText.includes(ACTIVE_TARGET),
        prompt_has_followup_target: promptText.includes(FOLLOWUP_TARGET),
        prompt_has_pending_work: promptText.includes("pending work"),
        use_now_has_active_target: useNowText.includes(ACTIVE_TARGET),
        use_now_has_followup_target: useNowText.includes(FOLLOWUP_TARGET),
      })}`,
    );
    assertCondition(decision.wrong_route_reuse === false, "simulated next Agent reused failed route");

    const attributionIds = [
      passedMemoryId,
      followupMemoryId,
      ...(handoffMemoryId ? [handoffMemoryId] : []),
      plannerMemoryId,
    ].filter((id) => compiled.use_now_memory_ids.includes(id));
    const usedMemoryIds = attributionIds;
    assertCondition(
      usedMemoryIds.length > 0,
      "simulated Agent trace did not dereference a recognized long-flow memory",
    );

    const feedback = await aionis.execution.feedbackFromOutcome<Record<string, unknown>>({
      agent_id: "worker-new-session",
      team_id: TEAM_ID,
      role: "worker",
      run_id: `run:${runId}:feedback`,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      title: "Worker continued governed long-flow route",
      summary: "The next-session worker followed active route state, created the pending regression target, and avoided the failed legacy route.",
      outcome: "succeeded",
      guide: afterGuide,
      used_memory_ids: usedMemoryIds,
      feedback_outcome: "positive",
      used_surface: "use_now",
      verifier_status: "passed",
      tool_status: "succeeded",
      runtime_signal_refs: [`evidence://long-flow/${runId}/next-worker-success`],
      feedback_reason: "Aionis context preserved active route, follow-up requirement, and failed-route separation across sessions.",
    });
    assertCondition(feedback !== null, "long-flow feedback was not submitted");

    const measure = await aionis.execution.measureRun<Record<string, unknown>>({
      run_id: runId,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `memory:${plannerMemoryId}`,
        `memory:${failedMemoryId}`,
        `memory:${passedMemoryId}`,
        `memory:${followupMemoryId}`,
        ...(handoffMemoryId ? [`memory:${handoffMemoryId}`] : []),
        `feedback:${runId}`,
      ],
    });
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "long-flow measure did not return result v1");
    assertCondition(historyImpact?.changed_future_behavior === true, "long-flow measure did not report changed future behavior");

    const snapshot = await aionis.execution.snapshotRun<Record<string, unknown>>({
      run_id: runId,
      task_signature: taskSignature,
      task_family: TASK_FAMILY,
      workflow_signature: WORKFLOW_SIGNATURE,
      guide: afterGuide,
      measure_result: measure,
      include_markdown: true,
    });
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    assertCondition(operatorSnapshot?.runtime_mutation === false, "long-flow operator snapshot mutated Runtime state");

    const flightRecorder = await aionis.flightRecorder<Record<string, unknown>>({
      run_id: runId,
      decision_time: "2026-06-24T00:00:00.000Z",
      agent_context: compiled,
      memory_decision_trace: measure.memory_decision_trace,
      memory_use_receipt: asRecord(measure.memory_decision_trace)?.memory_use_receipt ?? compiled.memory_use_receipt,
      memory_admission_record: asRecord(measure.memory_decision_trace)?.admission_record ?? compiled.memory_admission_record,
      operator_snapshot: operatorSnapshot,
      feedback_result: feedback,
    });
    const flightReport = asRecord(flightRecorder.agent_flight_recorder);
    const flightAgentView = asRecord(flightReport?.agent_view);
    assertCondition(flightReport?.contract_version === "aionis_agent_flight_recorder_report_v1", "long-flow flight recorder missing report");
    assertCondition(flightReport?.agent_prompt_included === false, "long-flow flight recorder included prompt payload");
    assertCondition(flightAgentView?.prompt_text_included === false, "long-flow flight recorder included prompt text");
    assertCondition(flightReport?.runtime_mutation === false, "long-flow flight recorder mutated Runtime state");
    assertCondition(!JSON.stringify(flightReport).includes(promptText), "long-flow flight recorder leaked prompt text");

    const result = {
      contract_version: "aionis_long_flow_product_demo_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? (session.mode === "spawned_no_embedding" ? "none" : "external_runtime"),
      },
      scenario: {
        name: "Long-flow cross-session coding Agent continuation",
        phases: [
          "fresh session guide",
          "planner route",
          "failed worker branch",
          "accepted worker branch",
          "reviewer follow-up requirement",
          "verifier handoff",
          "new-session guide",
          "feedback attribution",
          "measure",
          "operator snapshot",
          "flight recorder",
        ],
      },
      memory_ids: {
        planner: plannerMemoryId,
        failed_route: failedMemoryId,
        passed_route: passedMemoryId,
        followup: followupMemoryId,
        handoff: handoffMemoryId,
      },
      context_compression: {
        raw_transcript_chars: rawTranscript.length,
        compiled_prompt_chars: compiled.prompt_char_count,
        reduction_ratio: Number((1 - compiled.prompt_char_count / rawTranscript.length).toFixed(4)),
      },
      governed_context: {
        before_actionable_history_used: beforeContext.actionable_history_used,
        after_actionable_history_used: afterContext.actionable_history_used,
        active_targets: compiled.active_targets,
        missing_active_targets: compiled.missing_active_targets,
        blocked_direction_targets: compiled.blocked_direction_targets,
        reference_only_targets: compiled.reference_only_targets,
        use_now_memory_ids: compiled.use_now_memory_ids,
        inspect_before_use_memory_ids: compiled.inspect_before_use_memory_ids,
        do_not_use_memory_ids: compiled.do_not_use_memory_ids,
        failed_route_direct_use: failedDirectUse,
        memory_use_receipt_present: compiled.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
        memory_admission_record_present: compiled.memory_admission_record.contract_version === "aionis_memory_admission_record_v1",
        followup_target_treated_as_pending_work: followupTreatedAsPending,
        warnings: compiled.execution_warnings,
      },
      simulated_next_agent: decision,
      measurement: {
        changed_future_behavior: historyImpact?.changed_future_behavior ?? false,
        impact_direction: historyImpact?.impact_direction ?? null,
      },
      flight_recorder: {
        contract_version: flightReport.contract_version,
        prompt_payload_excluded: flightReport.agent_prompt_included === false && flightAgentView?.prompt_text_included === false,
        runtime_mutation: flightReport.runtime_mutation,
      },
      checks: {
        cross_session_history_started_empty: beforeContext.actionable_history_used === false,
        cross_session_history_available_after_observe: afterContext.actionable_history_used === true,
        active_route_preserved: activeTargetVisible,
        followup_requirement_preserved: followupVisible,
        followup_target_treated_as_pending_work: followupTreatedAsPending,
        failed_route_not_direct_use: !failedDirectUse,
        next_agent_continues_active_route: decision.next_action === "continue_active_route",
        feedback_attributed: feedback !== null,
        measure_changed_future_behavior: historyImpact?.changed_future_behavior === true,
        flight_recorder_replayable: flightReport.contract_version === "aionis_agent_flight_recorder_report_v1",
        prompt_payload_excluded_from_audit: flightReport.agent_prompt_included === false && flightAgentView?.prompt_text_included === false,
      },
      boundary:
        "This is a reproducible Runtime product demo, not an external benchmark. It verifies Aionis-owned continuity, context compression, memory admission, feedback attribution, and audit surfaces.",
    };

    const outputPath = path.join(repoRoot, "docs/examples/long-flow-product-demo-result.json");
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
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
