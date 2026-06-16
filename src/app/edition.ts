import type { Env } from "../config.js";

export type LocalStoreRuntimeEdition = "lite" | "server";
type RuntimeEditionLike = { AIONIS_EDITION?: string };

export function isLocalStoreRuntimeEdition(env: RuntimeEditionLike): env is RuntimeEditionLike & { AIONIS_EDITION: LocalStoreRuntimeEdition } {
  return env.AIONIS_EDITION === "lite" || env.AIONIS_EDITION === "server";
}

export function assertLocalStoreRuntimeEdition(env: RuntimeEditionLike | Pick<Env, "AIONIS_EDITION">, surface: string): void {
  if (!isLocalStoreRuntimeEdition(env)) {
    throw new Error(`${surface} only supports AIONIS_EDITION=lite or server`);
  }
}
