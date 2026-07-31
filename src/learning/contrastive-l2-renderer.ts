import {
  ContrastiveL2HypothesisV1Schema,
  type ContrastiveL2HypothesisV1,
} from "./contrastive-l2-contract.js";

function renderInstruction(
  instruction:
    ContrastiveL2HypothesisV1["abstractions"][number][
      "portable_instruction"
    ],
): string {
  const comparison = instruction.comparator === "lte"
    ? "at most"
    : "at least";
  if (instruction.operation === "bound_mutation_actions") {
    return [
      `Use ${comparison} ${instruction.threshold} production mutation`,
      "action before checking the resulting state with the task's bound",
      "verifier. If another mutation appears necessary, inspect or verify",
      "the current change before expanding it.",
    ].join(" ");
  }
  return [
    `Keep the execution trajectory to ${comparison}`,
    `${instruction.threshold} tool actions. Prefer decisive inspection,`,
    "the smallest evidence-supported change, and early verification over",
    "repeated exploratory commands.",
  ].join(" ");
}

export function renderContrastiveL2ValidationPrompt(
  input: ContrastiveL2HypothesisV1,
): string {
  const hypothesis = ContrastiveL2HypothesisV1Schema.parse(input);
  if (!hypothesis.validation_prompt_eligible) {
    throw new Error("contrastive_l2_not_validation_prompt_eligible");
  }
  return [
    "Unvalidated cross-task procedure candidate",
    `Candidate: ${hypothesis.hypothesis_id}`,
    `Evidence digest: ${hypothesis.hypothesis_sha256}`,
    "",
    "Treat these as validation guardrails, not as facts about the current",
    "task. Ignore a guardrail if direct repository evidence contradicts it.",
    "",
    ...hypothesis.abstractions.map((abstraction, index) =>
      `${index + 1}. ${renderInstruction(
        abstraction.portable_instruction,
      )}`),
    "",
    "Do not assume any source task's files, symbols, diagnosis, or repair.",
    "Solve the current task only from its own repository evidence and finish",
    "only when the task's real verifier supports completion.",
  ].join("\n");
}
