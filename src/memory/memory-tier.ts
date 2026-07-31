export const MEMORY_TIER_ORDER = ["archive", "cold", "warm", "hot"] as const;

export type MemoryTierName = (typeof MEMORY_TIER_ORDER)[number];

export const MEMORY_TIER_RANK: Record<MemoryTierName, number> = {
  archive: 0,
  cold: 1,
  warm: 2,
  hot: 3,
};

export function isMemoryTierName(value: unknown): value is MemoryTierName {
  return typeof value === "string"
    && (MEMORY_TIER_ORDER as readonly string[]).includes(value);
}

export function normalizeMemoryTier(
  value: unknown,
  defaultValue: MemoryTierName = "archive",
): MemoryTierName {
  return isMemoryTierName(value) ? value : defaultValue;
}

export function nextColderTier(value: unknown): MemoryTierName {
  const tier = normalizeMemoryTier(value);
  return MEMORY_TIER_ORDER[
    Math.max(0, MEMORY_TIER_RANK[tier] - 1)
  ]!;
}
