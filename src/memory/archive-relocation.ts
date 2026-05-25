// Implementation moved to the focused ForgettingKernel; it uses resolveNodeAnchorPayloadRefs
// through node-execution-surface instead of reading anchor slots directly.
export {
  resolveArchiveRelocationPlan,
  type ArchiveRelocationPlan,
  type ArchiveRelocationState,
  type ArchiveRelocationTarget,
} from "../kernel/forgetting-kernel.js";
