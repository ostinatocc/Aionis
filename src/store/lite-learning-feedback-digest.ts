import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";

function authorityRowWithoutDigest(
  row: LiteLearningAuthorityRow,
  digestField: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([field]) => field !== digestField)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function learningFeedbackAttributionItemDigest(row: LiteLearningAuthorityRow): string {
  return sha256Hex(stableStringify(authorityRowWithoutDigest(row, "item_sha256")));
}

export function learningFeedbackAttributionSetDigest(
  rows: readonly LiteLearningAuthorityRow[],
): string {
  const sorted = [...rows].sort((left, right) => {
    const leftKey = `${String(left.subject_kind)}\u0000${String(left.subject_id)}`;
    const rightKey = `${String(right.subject_kind)}\u0000${String(right.subject_id)}`;
    return Buffer.compare(Buffer.from(leftKey, "utf8"), Buffer.from(rightKey, "utf8"));
  });
  return sha256Hex(stableStringify(sorted.map((row) => (
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)))
  ))));
}

export function learningHostUseReceiptItemSetDigest(
  items: readonly Record<string, unknown>[],
): string {
  return sha256Hex(stableStringify(items));
}
