import {
  AnnIndexDimensionError,
  type AionisLocalAnnIndex,
  type AnnSearchParams,
  type AnnSearchResult,
  type AnnVectorRecord,
  assertAnnSearchParams,
  assertAnnVector,
} from "./ann-index.js";

type StoredVector = {
  record: AnnVectorRecord;
  vector: number[];
  norm: number;
};

function keyFor(record: AnnVectorRecord): string {
  return `${record.scope}\u0000${record.embedding_model}\u0000${record.node_id}`;
}

function l2Norm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function cosineSimilarity(left: readonly number[], leftNorm: number, right: readonly number[], rightNorm: number): number {
  if (left.length !== right.length) {
    throw new AnnIndexDimensionError(`ANN search vector dimension mismatch: expected=${left.length} got=${right.length}`);
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < left.length; i += 1) dot += left[i] * right[i];
  return Math.max(-1, Math.min(1, dot / (leftNorm * rightNorm)));
}

function recordValue(record: AnnVectorRecord, key: string): unknown {
  return (record as unknown as Record<string, unknown>)[key];
}

function filterMatches(record: AnnVectorRecord, filters: Record<string, unknown> | undefined): boolean {
  if (!filters) return true;
  for (const [key, expected] of Object.entries(filters)) {
    const actual = recordValue(record, key);
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

function toStored(record: AnnVectorRecord, vector: number[]): StoredVector {
  assertAnnVector(record, vector);
  return {
    record: { ...record },
    vector: [...vector],
    norm: l2Norm(vector),
  };
}

export class LocalAnnIndex implements AionisLocalAnnIndex {
  private readonly records = new Map<string, StoredVector>();

  async upsert(record: AnnVectorRecord, vector: number[]): Promise<void> {
    this.records.set(keyFor(record), toStored(record, vector));
  }

  async delete(nodeId: string): Promise<void> {
    const normalized = nodeId.trim();
    if (!normalized) return;
    for (const [key, stored] of this.records.entries()) {
      if (stored.record.node_id === normalized) this.records.delete(key);
    }
  }

  async search(params: AnnSearchParams): Promise<AnnSearchResult[]> {
    assertAnnSearchParams(params);
    const queryNorm = l2Norm(params.vector);
    const matches: AnnSearchResult[] = [];
    for (const stored of this.records.values()) {
      if (stored.record.scope !== params.scope) continue;
      if (stored.record.embedding_model !== params.embeddingModel) continue;
      if (stored.record.embedding_dim !== params.vector.length) {
        throw new AnnIndexDimensionError(
          `ANN search vector dimension mismatch for model ${params.embeddingModel}: expected=${stored.record.embedding_dim} got=${params.vector.length}`,
        );
      }
      if (!filterMatches(stored.record, params.filters)) continue;
      matches.push({
        node_id: stored.record.node_id,
        score: cosineSimilarity(stored.vector, stored.norm, params.vector, queryNorm),
      });
    }
    return matches
      .sort((a, b) => b.score - a.score || a.node_id.localeCompare(b.node_id))
      .slice(0, params.limit);
  }

  async rebuild(records: AsyncIterable<{ record: AnnVectorRecord; vector: number[] }>): Promise<void> {
    const next = new Map<string, StoredVector>();
    for await (const item of records) {
      next.set(keyFor(item.record), toStored(item.record, item.vector));
    }
    this.records.clear();
    for (const [key, value] of next.entries()) this.records.set(key, value);
  }
}

export function createLocalAnnIndex(): AionisLocalAnnIndex {
  return new LocalAnnIndex();
}
