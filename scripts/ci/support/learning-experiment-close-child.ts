import { readFileSync } from "node:fs";

import {
  LearningExperimentCloseAuthorizationEnvelopeV1Schema,
} from "../../../src/memory/learning-experiment-closing.js";
import {
  LearningExperimentClosingError,
  closeLiteLearningExperiment,
} from "../../../tools/learning-experiments/lite-learning-experiment-closing.js";
import { sha256Hex } from "../../../src/util/crypto.js";

type ParentCommand = Readonly<{ type: "go" }>;

const databasePath = process.argv[2];
const approvalPath = process.argv[3];
const actor = process.argv[4];
const childIndexRaw = process.argv[5];
if (!databasePath || !approvalPath || !actor || !childIndexRaw || !process.send) {
  throw new Error(
    "experiment-close child requires DB path, approval path, actor, child index, and IPC",
  );
}
const childIndex = Number(childIndexRaw);
if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex > 255) {
  throw new Error("experiment-close child index must be one byte");
}

const authorization = LearningExperimentCloseAuthorizationEnvelopeV1Schema.parse(
  JSON.parse(readFileSync(approvalPath, "utf8")) as unknown,
);
const approval = authorization.approval;

process.send({ type: "ready", childIndex });

try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("experiment-close child start barrier timed out")),
      20_000,
    );
    process.once("message", (message: ParentCommand) => {
      clearTimeout(timeout);
      if (!message || message.type !== "go") {
        reject(new Error("experiment-close child received an invalid start command"));
        return;
      }
      resolve();
    });
  });
  const result = await closeLiteLearningExperiment({
    path: databasePath,
    tenantId: approval.tenant_id,
    actor,
    operationId: approval.authority_operation_id,
    authorization,
    experimentId: approval.experiment_id,
    experimentRevision: approval.experiment_revision,
  });
  process.send({
    type: "result",
    ok: true,
    childIndex,
    operationId: approval.authority_operation_id,
    replayed: result.replayed,
    receiptSha256: sha256Hex(result.receiptJson),
    experimentCloseId: result.receipt.experiment_close_id,
  });
} catch (error) {
  process.send({
    type: "result",
    ok: false,
    childIndex,
    operationId: approval.authority_operation_id,
    code: error instanceof LearningExperimentClosingError ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  });
}

process.disconnect();
