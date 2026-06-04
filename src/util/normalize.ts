export function normalizeText(input: string, maxLen: number): string {
  // Normalize whitespace and clamp to the requested length.
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, Math.max(0, maxLen - 1)) + "…";
}
