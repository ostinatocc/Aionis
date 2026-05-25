import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createAionisHostBridge,
  createAionisRuntimeClient,
  AionisRuntimeSdkHttpError,
  resolveDelegationLearningProjection,
} from "../../packages/full-sdk/dist/index.js";

export const DEFAULT_BASE_URL = process.env.AIONIS_BASE_URL ?? "http://127.0.0.1:3001";
export const DEFAULT_TENANT_ID = process.env.AIONIS_TENANT_ID ?? "default";
export const DEFAULT_SCOPE = process.env.AIONIS_SCOPE ?? "default";

export function createExampleClient() {
  return createAionisRuntimeClient({
    baseUrl: DEFAULT_BASE_URL,
  });
}

export function createExampleHostBridge() {
  return createAionisHostBridge({
    baseUrl: DEFAULT_BASE_URL,
  });
}

export { resolveDelegationLearningProjection };

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === moduleUrl;
}

export function printHeading(title: string) {
  console.log(`\n# ${title}`);
}

export function printStep(message: string) {
  console.log(`- ${message}`);
}

export function printJson(label: string, value: unknown) {
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(value, null, 2));
}

export function createScope(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

export function createReplayRunId() {
  return randomUUID();
}

export function buildExecutionWritePayload(args: {
  title: string;
  inputText: string;
  taskBrief: string;
  filePath: string;
  scope: string;
  tenantId?: string;
  actor?: string;
}) {
  return {
    tenant_id: args.tenantId ?? DEFAULT_TENANT_ID,
    scope: args.scope,
    actor: args.actor ?? "sdk-example",
    input_text: args.inputText,
    auto_embed: true,
    memory_lane: "private" as const,
    nodes: [
      {
        client_id: `sdk-example-event:${randomUUID()}`,
        type: "event" as const,
        title: args.title,
        text_summary: args.taskBrief,
        slots: {
          summary_kind: "handoff",
          execution_packet_v1: {
            version: 1,
            state_id: `state:${randomUUID()}`,
            current_stage: "patch",
            active_role: "patch",
            task_brief: args.taskBrief,
            target_files: [args.filePath],
            next_action: `Patch ${args.filePath} and rerun validation`,
            hard_constraints: [],
            accepted_facts: [],
            rejected_paths: [],
            pending_validations: ["npm run -s test:lite"],
            unresolved_blockers: [],
            rollback_notes: [],
            review_contract: null,
            resume_anchor: {
              anchor: `resume:${args.filePath}`,
              file_path: args.filePath,
              symbol: null,
              repo_root: process.cwd(),
            },
            artifact_refs: [],
            evidence_refs: [],
          },
        },
      },
    ],
    edges: [],
  };
}

export function buildToolsSelectPayload(args: {
  scope: string;
  runId: string;
  tenantId?: string;
  taskKind?: string;
  goal?: string;
  errorSignature?: string;
  candidates?: string[];
}) {
  return {
    tenant_id: args.tenantId ?? DEFAULT_TENANT_ID,
    scope: args.scope,
    run_id: args.runId,
    context: {
      task_kind: args.taskKind ?? "repair_export",
      goal: args.goal ?? "repair export failure in node tests",
      error: {
        signature: args.errorSignature ?? "node-export-mismatch",
      },
    },
    candidates: args.candidates ?? ["bash", "edit", "test"],
    include_shadow: false,
    rules_limit: 20,
    strict: true,
    reorder_candidates: false,
  };
}

export async function recordPositiveToolFeedback(args: {
  client: ReturnType<typeof createExampleClient>;
  scope: string;
  runId: string;
  taskKind?: string;
  goal?: string;
  errorSignature?: string;
  candidates?: string[];
}) {
  const selection = await args.client.memory.tools.select(
    buildToolsSelectPayload({
      scope: args.scope,
      runId: args.runId,
      taskKind: args.taskKind,
      goal: args.goal,
      errorSignature: args.errorSignature,
      candidates: args.candidates,
    }),
  ) as Record<string, any>;

  const selectedTool = selection?.selection?.selected ?? selection?.decision?.selected_tool ?? "edit";
  const decisionId = selection?.decision?.decision_id;
  if (typeof decisionId !== "string" || decisionId.length === 0) {
    throw new Error("tools.select did not return decision.decision_id");
  }

  const feedback = await args.client.memory.tools.feedback({
    tenant_id: DEFAULT_TENANT_ID,
    scope: args.scope,
    actor: "sdk-example",
    run_id: args.runId,
    decision_id: decisionId,
    outcome: "positive",
    context: {
      task_kind: args.taskKind ?? "repair_export",
      goal: args.goal ?? "repair export failure in node tests",
      error: {
        signature: args.errorSignature ?? "node-export-mismatch",
      },
    },
    candidates: args.candidates ?? ["bash", "edit", "test"],
    selected_tool: selectedTool,
    target: "tool",
    note: `SDK example positive grouped evidence for ${selectedTool}`,
    input_text: args.goal ?? "repair export failure in node tests",
  }) as Record<string, any>;

  return {
    selection,
    feedback,
  };
}

export async function runExample(main: () => Promise<void>) {
  try {
    await main();
  } catch (error) {
    if (error instanceof AionisRuntimeSdkHttpError) {
      console.error(`Aionis runtime SDK request failed with status ${error.status}`);
      console.error(JSON.stringify(error.payload, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  }
}
