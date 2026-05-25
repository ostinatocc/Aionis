import type { PreparedWrite, WriteResult } from "./write.js";

export type EmbeddedWriteMirrorRuntime = {
  applyWrite: (prepared: PreparedWrite, out: WriteResult) => Promise<void>;
};

export async function mirrorPreparedWriteToEmbeddedRuntime(args: {
  embeddedRuntime?: EmbeddedWriteMirrorRuntime | null;
  prepared: PreparedWrite;
  out: WriteResult;
}): Promise<void> {
  if (!args.embeddedRuntime) return;
  await args.embeddedRuntime.applyWrite(args.prepared, args.out);
}
