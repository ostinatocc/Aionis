import { capabilityContract } from "../capability-contract.js";
import { HttpError } from "../util/http.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import type { WriteResult } from "./write.js";

type ShadowDualWriteOptions = {
  enabled: boolean;
  strict: boolean;
};

export async function applyShadowDualWrite(
  writeAccess: WriteStoreAccess,
  scope: string,
  commitId: string,
  result: WriteResult,
  options: ShadowDualWriteOptions,
): Promise<void> {
  if (!options.enabled) return;

  const shadowMirrorSpec = capabilityContract("shadow_mirror_v2");
  if (!writeAccess.capabilities.shadow_mirror_v2) {
    const msg = "shadow dual-write unsupported by backend capability: shadow_mirror_v2";
    result.shadow_dual_write = {
      enabled: true,
      strict: options.strict,
      mirrored: false,
      capability: "shadow_mirror_v2",
      failure_mode: shadowMirrorSpec.failure_mode,
      degraded_mode: "capability_unsupported",
      fallback_applied: true,
      error: msg,
    };
    if (options.strict) {
      throw new HttpError(500, "shadow_dual_write_strict_failure", msg, {
        capability: "shadow_mirror_v2",
        failure_mode: shadowMirrorSpec.failure_mode,
        degraded_mode: "capability_unsupported",
        fallback_applied: false,
        strict: true,
        mirrored: false,
      });
    }
    return;
  }

  try {
    const copied = await writeAccess.mirrorCommitArtifactsToShadowV2(scope, commitId);
    result.shadow_dual_write = {
      enabled: true,
      strict: options.strict,
      mirrored: true,
      copied,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.shadow_dual_write = {
      enabled: true,
      strict: options.strict,
      mirrored: false,
      capability: "shadow_mirror_v2",
      failure_mode: shadowMirrorSpec.failure_mode,
      degraded_mode: "mirror_failed",
      fallback_applied: true,
      error: msg,
    };
    if (options.strict) {
      throw new HttpError(500, "shadow_dual_write_strict_failure", `shadow dual-write failed: ${msg}`, {
        capability: "shadow_mirror_v2",
        failure_mode: shadowMirrorSpec.failure_mode,
        degraded_mode: "mirror_failed",
        fallback_applied: false,
        strict: true,
        mirrored: false,
        error: msg,
      });
    }
  }
}
