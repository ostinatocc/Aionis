import type { Env } from "../config.js";
import type { EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LiteReplayStore } from "../store/lite-replay-store.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { ReplayStoreAccess } from "../store/replay-access.js";
import {
  buildLiteLearningControlRuntimeProviders,
  type LiteLearningControlRuntimeProviderBuilderOptions,
} from "./learning-control-runtime-providers.js";
import { buildReplayLearningProjectionDefaults } from "../memory/replay-learning.js";
import { createSandboxSession, enqueueSandboxRun, getSandboxRun } from "../memory/sandbox.js";
import type { SandboxStore } from "../store/sandbox-access.js";

type SandboxExecutorLike = {
  enqueue: (runId: string) => void;
  executeSync: (runId: string) => Promise<void>;
};

type ReplyWithHeader = {
  header: (name: string, value: unknown) => unknown;
};

function createSandboxRunExecutor(args: {
  env: Env;
  sandboxStore: SandboxStore;
  sandboxExecutor: SandboxExecutorLike;
  source: string;
}) {
  const { env, sandboxStore, sandboxExecutor, source } = args;
  return async (input: {
    tenant_id: string;
    scope: string;
    project_id?: string | null;
    argv: string[];
    timeout_ms: number;
    mode?: "sync" | "async";
    metadata?: Record<string, unknown>;
  }) => {
    if (!env.SANDBOX_ENABLED) {
      return {
        ok: false,
        status: "failed",
        stdout: "",
        stderr: "",
        exit_code: null,
        error: "sandbox_disabled",
        run_id: null,
      };
    }
    const sandboxMode = input.mode === "async" ? "async" : "sync";
    const sessionOut = await sandboxStore.withTx((access) =>
      createSandboxSession(
        access,
        {
          tenant_id: input.tenant_id,
          scope: input.scope,
          actor: source,
          profile: "restricted",
          ttl_seconds: 900,
          metadata: {
            source,
            ...(input.metadata ?? {}),
          },
        },
        {
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
        },
      ),
    );
    const queued = await sandboxStore.withTx((access) =>
      enqueueSandboxRun(
        access,
        {
          tenant_id: input.tenant_id,
          scope: input.scope,
          project_id: input.project_id ?? undefined,
          actor: source,
          session_id: sessionOut.session.session_id,
          mode: sandboxMode,
          timeout_ms: input.timeout_ms,
          action: {
            kind: "command",
            argv: input.argv,
          },
          metadata: {
            source,
            ...(input.metadata ?? {}),
          },
        },
        {
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          defaultTimeoutMs: env.SANDBOX_EXECUTOR_TIMEOUT_MS,
        },
      ),
    );
    if (sandboxMode === "async") {
      sandboxExecutor.enqueue(queued.run.run_id);
      return {
        ok: false,
        status: queued.run.status ?? "queued",
        stdout: "",
        stderr: "",
        exit_code: null,
        error: null,
        run_id: queued.run.run_id,
      };
    }

    await sandboxExecutor.executeSync(queued.run.run_id);
    const final = await sandboxStore.withClient((access) =>
      getSandboxRun(
        access,
        {
          tenant_id: input.tenant_id,
          scope: input.scope,
          run_id: queued.run.run_id,
        },
        {
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
        },
      ),
    );
    return {
      ok: final.run.status === "succeeded",
      status: final.run.status,
      stdout: final.run.output?.stdout ?? "",
      stderr: final.run.output?.stderr ?? "",
      exit_code: Number.isFinite(final.run.exit_code ?? NaN) ? Number(final.run.exit_code) : null,
      error: final.run.error ? String(final.run.error) : null,
      run_id: final.run.run_id,
    };
  };
}

export function createReplayRuntimeOptionBuilders(args: {
  env: Env;
  sandboxStore: SandboxStore;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  liteWriteStore?: LiteWriteStore | null;
  liteReplayAccess?: ReplayStoreAccess | null;
  liteReplayStore?: LiteReplayStore | null;
  sandboxAllowedCommands: Set<string>;
  sandboxExecutor: SandboxExecutorLike;
  enforceSandboxTenantBudget: (
    reply: ReplyWithHeader,
    tenantId: string,
    scope: string,
    projectId: string | null,
  ) => Promise<void>;
  learningControlRuntimeProviderBuilderOptions?: LiteLearningControlRuntimeProviderBuilderOptions;
}) {
  const {
    env,
    sandboxStore,
    embedder,
    embeddingSurfacePolicy,
    liteWriteStore,
    liteReplayAccess,
    liteReplayStore,
    sandboxAllowedCommands,
    sandboxExecutor,
    enforceSandboxTenantBudget,
  } = args;
  const writeEmbedder = embeddingSurfacePolicy?.providerFor("write_auto_embed", embedder) ?? embedder;
  const replayLearningProjectionDefaultDelivery =
    env.AIONIS_EDITION === "lite" ? "sync_inline" : env.REPLAY_LEARNING_PROJECTION_DELIVERY;
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(
    env,
    args.learningControlRuntimeProviderBuilderOptions,
  );

  function buildReplayRepairReviewOptions(options: { allowSandboxExecution?: boolean } = {}) {
    const allowSandboxExecution = options.allowSandboxExecution !== false;
    const localExecutorMode = env.SANDBOX_ENABLED && env.SANDBOX_EXECUTOR_MODE === "local_process"
      ? "local_process" as const
      : "disabled" as const;
    return {
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
      maxTextLen: env.MAX_TEXT_LEN,
      piiRedaction: env.PII_REDACTION,
      allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      embedder: writeEmbedder,
      writeAccess: liteWriteStore ?? undefined,
      replayAccess: liteReplayAccess,
      replayMirror: liteReplayStore,
      localExecutor: {
        enabled: allowSandboxExecution && env.SANDBOX_ENABLED && env.SANDBOX_EXECUTOR_MODE === "local_process",
        mode: localExecutorMode,
        allowedCommands: sandboxAllowedCommands,
        workdir: env.SANDBOX_EXECUTOR_WORKDIR,
        timeoutMs: env.SANDBOX_EXECUTOR_TIMEOUT_MS,
        stdioMaxBytes: env.SANDBOX_STDIO_MAX_BYTES,
      },
      shadowValidationPolicy: {
        executeTimeoutMs: env.REPLAY_SHADOW_VALIDATE_EXECUTE_TIMEOUT_MS,
        executeStopOnFailure: env.REPLAY_SHADOW_VALIDATE_EXECUTE_STOP_ON_FAILURE,
        sandboxTimeoutMs: env.REPLAY_SHADOW_VALIDATE_SANDBOX_TIMEOUT_MS,
        sandboxStopOnFailure: env.REPLAY_SHADOW_VALIDATE_SANDBOX_STOP_ON_FAILURE,
      },
      learningProjectionDefaults: buildReplayLearningProjectionDefaults({
        enabled: env.REPLAY_LEARNING_PROJECTION_ENABLED,
        mode: env.REPLAY_LEARNING_PROJECTION_MODE,
        delivery: replayLearningProjectionDefaultDelivery,
        targetRuleState: env.REPLAY_LEARNING_TARGET_RULE_STATE,
        minTotalSteps: env.REPLAY_LEARNING_MIN_TOTAL_STEPS,
        minSuccessRatio: env.REPLAY_LEARNING_MIN_SUCCESS_RATIO,
        maxMatcherBytes: env.REPLAY_LEARNING_MAX_MATCHER_BYTES,
        maxToolPrefer: env.REPLAY_LEARNING_MAX_TOOL_PREFER,
        episodeTtlDays: env.EPISODE_GC_TTL_DAYS,
      }),
      learningControlReviewProviders: learningControlProviders.replayRepairReview,
      sandboxValidationExecutor: allowSandboxExecution
        ? createSandboxRunExecutor({
            env,
            sandboxStore,
            sandboxExecutor,
            source: "replay_shadow_validation",
          })
        : undefined,
    };
  }

  function buildReplayPlaybookRunOptions(
    reply: ReplyWithHeader,
    source: string,
    options: { allowSandboxExecution?: boolean } = {},
  ) {
    const allowSandboxExecution = options.allowSandboxExecution !== false;
    const localExecutorMode = env.SANDBOX_ENABLED && env.SANDBOX_EXECUTOR_MODE === "local_process"
      ? "local_process" as const
      : "disabled" as const;
    return {
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
      replayAccess: liteReplayAccess,
      writeOptions: {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
        embedder: writeEmbedder,
        writeAccess: liteWriteStore ?? undefined,
        replayAccess: liteReplayAccess,
        replayMirror: liteReplayStore,
      },
      localExecutor: {
        enabled: allowSandboxExecution && env.SANDBOX_ENABLED && env.SANDBOX_EXECUTOR_MODE === "local_process",
        mode: localExecutorMode,
        allowedCommands: sandboxAllowedCommands,
        workdir: env.SANDBOX_EXECUTOR_WORKDIR,
        timeoutMs: env.SANDBOX_EXECUTOR_TIMEOUT_MS,
        stdioMaxBytes: env.SANDBOX_STDIO_MAX_BYTES,
      },
      guidedRepair: {
        strategy: env.REPLAY_GUIDED_REPAIR_STRATEGY,
        maxErrorChars: env.REPLAY_GUIDED_REPAIR_MAX_ERROR_CHARS,
      },
      sandboxBudgetGuard: async (input: { tenant_id: string; scope: string; project_id: string | null }) => {
        await enforceSandboxTenantBudget(reply, input.tenant_id, input.scope, input.project_id);
      },
      sandboxExecutor: allowSandboxExecution
        ? createSandboxRunExecutor({
            env,
            sandboxStore,
            sandboxExecutor,
            source,
          })
        : undefined,
    };
  }

  return {
    buildReplayRepairReviewOptions,
    buildReplayPlaybookRunOptions,
  };
}
