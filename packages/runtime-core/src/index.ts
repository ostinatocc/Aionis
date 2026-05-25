export type RuntimeCoreSurfaceKind = "shared_core" | "local_runtime_shell";

export type RuntimeCoreBoundaryEntry = {
  id: string;
  kind: RuntimeCoreSurfaceKind;
  rationale: string;
};

export const RUNTIME_CORE_BOUNDARY: readonly RuntimeCoreBoundaryEntry[] = [
  {
    id: "memory-kernel",
    kind: "shared_core",
    rationale: "Memory write, recall, context assembly, replay, handoff, and pack contracts must remain shared.",
  },
  {
    id: "execution-continuity-kernel",
    kind: "shared_core",
    rationale: "Replay capture, playbook simulation, handoff recovery, and runtime packets define the continuity contract.",
  },
  {
    id: "learning-control-kernel",
    kind: "shared_core",
    rationale: "Promotion, suppression, forgetting, and review gates define how the runtime learns without uncontrolled accumulation.",
  },
  {
    id: "local-runtime-shell",
    kind: "local_runtime_shell",
    rationale: "Local runtime startup, shell docs, and local release packaging should stay with the Aionis Core local runtime shell.",
  },
] as const;

export const RUNTIME_CORE_SHARED_SURFACES = RUNTIME_CORE_BOUNDARY
  .filter((entry) => entry.kind === "shared_core")
  .map((entry) => entry.id);

export const RUNTIME_CORE_LOCAL_RUNTIME_SHELL_SURFACES = RUNTIME_CORE_BOUNDARY
  .filter((entry) => entry.kind === "local_runtime_shell")
  .map((entry) => entry.id);

export function runtimeCoreBoundarySummary() {
  return {
    shared_core: [...RUNTIME_CORE_SHARED_SURFACES],
    local_runtime_shell: [...RUNTIME_CORE_LOCAL_RUNTIME_SHELL_SURFACES],
  };
}
