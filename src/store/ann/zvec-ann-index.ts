import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AionisLocalAnnIndex,
  type AnnSearchParams,
  type AnnSearchResult,
  type AnnVectorRecord,
  assertAnnSearchParams,
  assertAnnVector,
} from "./ann-index.js";

const ZVEC_PACKAGE = "@zvec/zvec";
const COLLECTION_NAME = "aionis_ann_v1";
const VECTOR_FIELD = "embedding";

type ZvecModule = {
  ZVecCreateAndOpen: (path: string, schema: unknown, options?: unknown) => ZvecCollection;
  ZVecOpen: (path: string, options?: unknown) => ZvecCollection;
  ZVecCollectionSchema: new (params: unknown) => unknown;
  ZVecDataType: Record<string, number>;
  ZVecIndexType: Record<string, number>;
  ZVecMetricType: Record<string, number>;
};

type ZvecStatus = {
  ok: boolean;
  code: string;
  message: string;
};

type ZvecDoc = {
  id: string;
  score: number;
  fields: Record<string, unknown>;
};

type ZvecCollection = {
  upsertSync(doc: unknown): ZvecStatus | ZvecStatus[];
  deleteByFilterSync(filter: string): ZvecStatus;
  querySync(params: unknown): ZvecDoc[];
  closeSync(): void;
};

type OpenCollection = {
  dimension: number;
  collection: ZvecCollection;
};

export type ZvecAnnIndexOptions = {
  path: string;
};

function assertStatus(status: ZvecStatus | ZvecStatus[], operation: string): void {
  const statuses = Array.isArray(status) ? status : [status];
  const failed = statuses.find((item) => !item.ok);
  if (failed) {
    throw new Error(`Zvec ANN ${operation} failed: ${failed.code} ${failed.message}`);
  }
}

function docIdFor(record: AnnVectorRecord): string {
  return createHash("sha256")
    .update(record.scope)
    .update("\0")
    .update(record.embedding_model)
    .update("\0")
    .update(record.node_id)
    .digest("hex");
}

function dimensionDirName(dimension: number): string {
  return `dim-${dimension}`;
}

function parseDimensionDirName(value: string): number | null {
  const match = /^dim-(\d+)$/.exec(value);
  if (!match) return null;
  const dimension = Number(match[1]);
  return Number.isInteger(dimension) && dimension > 0 ? dimension : null;
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function filterExpression(params: AnnSearchParams): string {
  const clauses = [
    `scope = ${stringLiteral(params.scope)}`,
    `embedding_model = ${stringLiteral(params.embeddingModel)}`,
  ];
  for (const [key, value] of Object.entries(params.filters ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (Array.isArray(value)) {
      const values = value
        .filter((item): item is string | number | boolean => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .map((item) => typeof item === "string" ? stringLiteral(item) : String(item));
      if (values.length > 0) clauses.push(`${key} in (${values.join(", ")})`);
      continue;
    }
    if (typeof value === "string") clauses.push(`${key} = ${stringLiteral(value)}`);
    else if (typeof value === "number" || typeof value === "boolean") clauses.push(`${key} = ${String(value)}`);
  }
  return clauses.join(" AND ");
}

function normalizeScore(rawScore: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  return Math.max(-1, Math.min(1, 1 - rawScore));
}

async function loadZvecModule(): Promise<ZvecModule> {
  try {
    return await import(ZVEC_PACKAGE) as ZvecModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `RECALL_ANN_PROVIDER=zvec requires optional dependency ${ZVEC_PACKAGE}. Install it with npm install ${ZVEC_PACKAGE}@0.5.0. Cause: ${message}`,
    );
  }
}

function createSchema(zvec: ZvecModule, dimension: number): unknown {
  return new zvec.ZVecCollectionSchema({
    name: COLLECTION_NAME,
    vectors: {
      name: VECTOR_FIELD,
      dataType: zvec.ZVecDataType.VECTOR_FP32,
      dimension,
      indexParams: {
        indexType: zvec.ZVecIndexType.FLAT,
        metricType: zvec.ZVecMetricType.COSINE,
      },
    },
    fields: [
      { name: "node_id", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "scope", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "embedding_model", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "tier", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "memory_lane", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "owner_agent_id", dataType: zvec.ZVecDataType.STRING, nullable: true, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "owner_team_id", dataType: zvec.ZVecDataType.STRING, nullable: true, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "lifecycle_state", dataType: zvec.ZVecDataType.STRING, nullable: true, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "authority_state", dataType: zvec.ZVecDataType.STRING, nullable: true, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "updated_at", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
    ],
  });
}

function recordToDoc(record: AnnVectorRecord, vector: number[]) {
  const fields: Record<string, string> = {
    node_id: record.node_id,
    scope: record.scope,
    embedding_model: record.embedding_model,
    tier: record.tier,
    memory_lane: record.memory_lane,
    updated_at: record.updated_at,
  };
  if (record.owner_agent_id) fields.owner_agent_id = record.owner_agent_id;
  if (record.owner_team_id) fields.owner_team_id = record.owner_team_id;
  if (record.lifecycle_state) fields.lifecycle_state = record.lifecycle_state;
  if (record.authority_state) fields.authority_state = record.authority_state;
  return {
    id: docIdFor(record),
    vectors: { [VECTOR_FIELD]: vector },
    fields,
  };
}

export class ZvecAnnIndex implements AionisLocalAnnIndex {
  private zvecPromise: Promise<ZvecModule> | null = null;
  private readonly collections = new Map<number, OpenCollection>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ZvecAnnIndexOptions) {
    if (!options.path.trim()) throw new Error("Zvec ANN path is required");
    mkdirSync(options.path, { recursive: true });
  }

  private async zvec(): Promise<ZvecModule> {
    this.zvecPromise ??= loadZvecModule();
    return this.zvecPromise;
  }

  private async collectionForDimension(dimension: number): Promise<ZvecCollection> {
    const existing = this.collections.get(dimension);
    if (existing) return existing.collection;
    const zvec = await this.zvec();
    const collectionPath = join(this.options.path, dimensionDirName(dimension));
    const collection = existsSync(collectionPath)
      ? zvec.ZVecOpen(collectionPath)
      : zvec.ZVecCreateAndOpen(collectionPath, createSchema(zvec, dimension));
    this.collections.set(dimension, { dimension, collection });
    return collection;
  }

  private async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.operationQueue.catch(() => undefined);
    let release!: () => void;
    this.operationQueue = previous.then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async upsert(record: AnnVectorRecord, vector: number[]): Promise<void> {
    await this.runExclusive(async () => {
      assertAnnVector(record, vector);
      const collection = await this.collectionForDimension(record.embedding_dim);
      assertStatus(collection.upsertSync(recordToDoc(record, vector)), "upsert");
    });
  }

  async delete(nodeId: string): Promise<void> {
    await this.runExclusive(async () => {
      const normalized = nodeId.trim();
      if (!normalized) return;
      for (const dimension of this.knownDimensions()) {
        const collection = await this.collectionForDimension(dimension);
        assertStatus(collection.deleteByFilterSync(`node_id = ${stringLiteral(normalized)}`), "delete");
      }
    });
  }

  async search(params: AnnSearchParams): Promise<AnnSearchResult[]> {
    return await this.runExclusive(async () => {
      assertAnnSearchParams(params);
      const collection = await this.collectionForDimension(params.vector.length);
      const rows = collection.querySync({
        fieldName: VECTOR_FIELD,
        vector: params.vector,
        topk: params.limit,
        filter: filterExpression(params),
        includeVector: false,
        outputFields: ["node_id"],
      });
      return rows
        .map((row) => ({
          node_id: typeof row.fields.node_id === "string" ? row.fields.node_id : row.id,
          score: normalizeScore(row.score),
        }))
        .sort((a, b) => b.score - a.score || a.node_id.localeCompare(b.node_id))
        .slice(0, params.limit);
    });
  }

  async rebuild(records: AsyncIterable<{ record: AnnVectorRecord; vector: number[] }>): Promise<void> {
    const buffered: Array<{ record: AnnVectorRecord; vector: number[] }> = [];
    for await (const item of records) {
      assertAnnVector(item.record, item.vector);
      buffered.push({
        record: { ...item.record },
        vector: [...item.vector],
      });
    }

    await this.runExclusive(async () => {
      const tmpPath = `${this.options.path}.rebuild-${process.pid}-${Date.now()}`;
      rmSync(tmpPath, { recursive: true, force: true });
      const next = new ZvecAnnIndex({ path: tmpPath });
      try {
        for (const item of buffered) {
          await next.upsert(item.record, item.vector);
        }
        await next.close();
        this.closeOpenCollections();
        rmSync(this.options.path, { recursive: true, force: true });
        renameSync(tmpPath, this.options.path);
        mkdirSync(this.options.path, { recursive: true });
      } catch (err) {
        await next.close().catch(() => undefined);
        rmSync(tmpPath, { recursive: true, force: true });
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.runExclusive(() => {
      this.closeOpenCollections();
    });
  }

  private closeOpenCollections(): void {
    for (const { collection } of this.collections.values()) {
      collection.closeSync();
    }
    this.collections.clear();
  }

  private knownDimensions(): number[] {
    const dimensions = new Set<number>(this.collections.keys());
    if (existsSync(this.options.path)) {
      for (const entry of readdirSync(this.options.path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dimension = parseDimensionDirName(entry.name);
        if (dimension) dimensions.add(dimension);
      }
    }
    return Array.from(dimensions).sort((a, b) => a - b);
  }
}

export function createZvecAnnIndex(options: ZvecAnnIndexOptions): AionisLocalAnnIndex {
  return new ZvecAnnIndex(options);
}
