export const CONTINUATION_RUNTIME_V1_NODE_VERSION_RANGE =
  ">=22.15.0 <23 || >=24.0.0 <25" as const;

export function isContinuationRuntimeV1NodeVersionSupported(
  version: string,
): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 15) || major === 24;
}

/** Rejects unsupported native hosts before any Runtime authority is opened. */
export function assertContinuationRuntimeV1Host(
  platform = process.platform,
  nodeVersion = process.versions.node,
): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("continuation_runtime_v1_host_platform_unsupported");
  }
  if (!isContinuationRuntimeV1NodeVersionSupported(nodeVersion)) {
    throw new Error("continuation_runtime_v1_host_node_version_unsupported");
  }
}
