import stableStringify from "fast-json-stable-stringify";

import {
  HostTaskEnvelopeV1Schema,
  type HostTaskEnvelopeV1,
} from "./host-task-contract.js";
import { sha256Hex } from "../util/crypto.js";

export const EXECUTION_TASK_CLUSTER_POLICY_VERSION =
  "host_task_identity_v1" as const;

export type ExecutionTaskClusterV1 = Readonly<{
  contract_version: "execution_task_cluster_v1";
  task_cluster_id: string;
  task_cluster_policy_version:
    typeof EXECUTION_TASK_CLUSTER_POLICY_VERSION;
  cluster_input_sha256: string;
}>;

/**
 * Phase 1 uses a conservative exact identity cluster. Runtime owns the
 * canonicalization and digest; Host labels are bounded input evidence, not a
 * caller-selected cluster ID. Broader learned clustering is a later,
 * separately versioned policy.
 */
export function deriveExecutionTaskClusterV1(
  input: HostTaskEnvelopeV1,
): ExecutionTaskClusterV1 {
  const task = HostTaskEnvelopeV1Schema.parse(input);
  const material = {
    contract_version: "execution_task_cluster_input_v1",
    policy_version: EXECUTION_TASK_CLUSTER_POLICY_VERSION,
    task_family: task.task_family,
    task_signature: task.task_signature,
    repository_signature: task.repository_signature,
  };
  const clusterInputSha256 = sha256Hex(stableStringify(material));
  return Object.freeze({
    contract_version: "execution_task_cluster_v1",
    task_cluster_id: `etc_${clusterInputSha256}`,
    task_cluster_policy_version: EXECUTION_TASK_CLUSTER_POLICY_VERSION,
    cluster_input_sha256: clusterInputSha256,
  });
}
