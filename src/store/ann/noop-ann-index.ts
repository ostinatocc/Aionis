import {
  type AionisLocalAnnIndex,
  type AnnSearchParams,
  type AnnSearchResult,
  type AnnVectorRecord,
  assertAnnSearchParams,
  assertAnnVector,
} from "./ann-index.js";

export class NoopAnnIndex implements AionisLocalAnnIndex {
  async upsert(record: AnnVectorRecord, vector: number[]): Promise<void> {
    assertAnnVector(record, vector);
  }

  async delete(_nodeId: string): Promise<void> {
    // No persisted sidecar state.
  }

  async search(params: AnnSearchParams): Promise<AnnSearchResult[]> {
    assertAnnSearchParams(params);
    return [];
  }

  async rebuild(records: AsyncIterable<{ record: AnnVectorRecord; vector: number[] }>): Promise<void> {
    for await (const item of records) {
      assertAnnVector(item.record, item.vector);
    }
  }
}

export function createNoopAnnIndex(): AionisLocalAnnIndex {
  return new NoopAnnIndex();
}
