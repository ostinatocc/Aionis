export type AnnProvider = "off" | "local";

export type AnnVectorRecord = {
  node_id: string;
  scope: string;
  tenant_id?: string | null;
  embedding_model: string;
  embedding_dim: number;
  vector_hash: string;
  tier: string;
  memory_lane: string;
  owner_agent_id?: string | null;
  owner_team_id?: string | null;
  lifecycle_state?: string | null;
  authority_state?: string | null;
  updated_at: string;
};

export type AnnSearchParams = {
  scope: string;
  embeddingModel: string;
  vector: number[];
  limit: number;
  filters?: Record<string, unknown>;
};

export type AnnSearchResult = {
  node_id: string;
  score: number;
};

export interface AionisLocalAnnIndex {
  upsert(record: AnnVectorRecord, vector: number[]): Promise<void>;
  delete(nodeId: string): Promise<void>;
  search(params: AnnSearchParams): Promise<AnnSearchResult[]>;
  rebuild(records: AsyncIterable<{ record: AnnVectorRecord; vector: number[] }>): Promise<void>;
}

export class AnnIndexDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnIndexDimensionError";
  }
}

export class AnnIndexValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnIndexValidationError";
  }
}

export function assertAnnRecord(record: AnnVectorRecord): void {
  if (!record.node_id.trim()) throw new AnnIndexValidationError("ANN record node_id is required");
  if (!record.scope.trim()) throw new AnnIndexValidationError("ANN record scope is required");
  if (!record.embedding_model.trim()) throw new AnnIndexValidationError("ANN record embedding_model is required");
  if (!Number.isInteger(record.embedding_dim) || record.embedding_dim <= 0) {
    throw new AnnIndexDimensionError(`ANN record embedding_dim must be a positive integer; got ${record.embedding_dim}`);
  }
  if (!record.vector_hash.trim()) throw new AnnIndexValidationError("ANN record vector_hash is required");
  if (!record.tier.trim()) throw new AnnIndexValidationError("ANN record tier is required");
  if (!record.memory_lane.trim()) throw new AnnIndexValidationError("ANN record memory_lane is required");
  if (!record.updated_at.trim()) throw new AnnIndexValidationError("ANN record updated_at is required");
}

export function assertAnnVector(record: AnnVectorRecord, vector: readonly number[]): void {
  assertAnnRecord(record);
  if (!Array.isArray(vector)) {
    throw new AnnIndexValidationError("ANN vector must be an array");
  }
  if (vector.length !== record.embedding_dim) {
    throw new AnnIndexDimensionError(
      `ANN vector dimension mismatch for ${record.node_id}: expected=${record.embedding_dim} got=${vector.length}`,
    );
  }
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      throw new AnnIndexValidationError(`ANN vector contains a non-finite value at index ${i}`);
    }
  }
}

export function assertAnnSearchParams(params: AnnSearchParams): void {
  if (!params.scope.trim()) throw new AnnIndexValidationError("ANN search scope is required");
  if (!params.embeddingModel.trim()) throw new AnnIndexValidationError("ANN search embeddingModel is required");
  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new AnnIndexValidationError(`ANN search limit must be a positive integer; got ${params.limit}`);
  }
  if (!Array.isArray(params.vector) || params.vector.length === 0) {
    throw new AnnIndexDimensionError("ANN search vector must be a non-empty array");
  }
  for (let i = 0; i < params.vector.length; i += 1) {
    if (!Number.isFinite(params.vector[i])) {
      throw new AnnIndexValidationError(`ANN search vector contains a non-finite value at index ${i}`);
    }
  }
}
