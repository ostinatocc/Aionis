const DEFAULT_STABLE_JSON_MAX_DEPTH = 64;

export function stableJson(value: unknown, maxDepth = DEFAULT_STABLE_JSON_MAX_DEPTH): string {
  return stableJsonAtDepth(value, maxDepth, 0);
}

function stableJsonAtDepth(value: unknown, maxDepth: number, depth: number): string {
  if (depth > maxDepth) {
    throw new Error(`stable JSON input exceeds max depth ${maxDepth}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonAtDepth(item, maxDepth, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJsonAtDepth(record[key], maxDepth, depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
