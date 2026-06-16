#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const PROVIDERS = new Set(["local", "usearch", "sqlite-vec", "lancedb"]);

function parseArgs(argv) {
  const out = {
    provider: "local",
    vectors: 10_000,
    dim: 1536,
    queries: 20,
    k: 10,
    seed: 42,
    persistDir: "",
    output: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--provider") {
      out.provider = String(next ?? "");
      i += 1;
    } else if (arg === "--vectors") {
      out.vectors = Number(next);
      i += 1;
    } else if (arg === "--dim") {
      out.dim = Number(next);
      i += 1;
    } else if (arg === "--queries") {
      out.queries = Number(next);
      i += 1;
    } else if (arg === "--k") {
      out.k = Number(next);
      i += 1;
    } else if (arg === "--seed") {
      out.seed = Number(next);
      i += 1;
    } else if (arg === "--persist-dir") {
      out.persistDir = path.resolve(String(next ?? ""));
      i += 1;
    } else if (arg === "--output") {
      out.output = path.resolve(String(next ?? ""));
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!PROVIDERS.has(out.provider)) {
    throw new Error(`--provider must be one of: ${Array.from(PROVIDERS).join("|")}`);
  }
  for (const key of ["vectors", "dim", "queries", "k"]) {
    if (!Number.isInteger(out[key]) || out[key] <= 0) {
      throw new Error(`--${key} must be a positive integer`);
    }
  }
  if (!Number.isFinite(out.seed)) throw new Error("--seed must be a finite number");
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/research/ann-backend-probe.mjs --provider local --vectors 10000 --dim 1536 --queries 20 --k 10

Providers:
  local       JS exact baseline, no dependencies
  usearch     Requires npm package: usearch
  sqlite-vec  Requires npm package: sqlite-vec and node:sqlite extension loading
  lancedb     Requires npm package: @lancedb/lancedb
`);
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return ((state >>> 0) / 0x100000000) * 2 - 1;
  };
}

function makeVectors(count, dim, seed) {
  const rand = lcg(seed);
  const vectors = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const vector = new Float32Array(dim);
    let norm = 0;
    for (let j = 0; j < dim; j += 1) {
      const value = rand();
      vector[j] = value;
      norm += value * value;
    }
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
    for (let j = 0; j < dim; j += 1) vector[j] *= scale;
    vectors[i] = vector;
  }
  return vectors;
}

function queriesFromVectors(vectors, queryCount) {
  const out = [];
  const stride = Math.max(1, Math.floor(vectors.length / queryCount));
  for (let i = 0; i < queryCount; i += 1) {
    out.push(vectors[(i * stride) % vectors.length]);
  }
  return out;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function topKExact(vectors, query, k) {
  const scored = [];
  for (let i = 0; i < vectors.length; i += 1) {
    scored.push({ id: i, score: dot(vectors[i], query) });
  }
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  return scored.slice(0, k);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

function summarizeTimings(values) {
  return {
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    max_ms: percentile(values, 100),
  };
}

async function runLocalProbe({ vectors, queries, k }) {
  const addStarted = performance.now();
  const stored = vectors.map((vector, id) => ({ id, vector }));
  const buildMs = performance.now() - addStarted;
  const timings = [];
  let checksum = 0;
  for (const query of queries) {
    const started = performance.now();
    const results = topKExact(stored.map((item) => item.vector), query, k);
    timings.push(performance.now() - started);
    checksum += results[0]?.id ?? 0;
  }
  return {
    provider_status: "ok",
    build_ms: Number(buildMs.toFixed(3)),
    search: summarizeTimings(timings),
    checksum,
    notes: ["local provider is an exact JS baseline; it is not an ANN backend"],
  };
}

function missingPackageResult(packageName, installCommand, cause) {
  return {
    provider_status: "missing_dependency",
    package: packageName,
    install: installCommand,
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

function unsupportedResult(provider, message, exportsSeen) {
  return {
    provider_status: "unsupported_api",
    provider,
    error: message,
    exports_seen: exportsSeen,
  };
}

function normalizeUsearchMatches(matches) {
  if (!matches) return [];
  if (Array.isArray(matches)) {
    return matches.map((item) => ({
      id: Number(item.key ?? item.id ?? item[0]),
      score: Number(item.score ?? (item.distance === undefined ? item[1] : -item.distance)),
    }));
  }
  if (Array.isArray(matches.keys)) {
    return matches.keys.map((key, idx) => ({
      id: Number(key),
      score: Number(matches.scores?.[idx] ?? (matches.distances?.[idx] === undefined ? 0 : -matches.distances[idx])),
    }));
  }
  if (typeof matches.toArray === "function") return normalizeUsearchMatches(matches.toArray());
  return [];
}

async function runUsearchProbe({ vectors, queries, k, dim, persistDir }) {
  let mod;
  try {
    mod = await import("usearch");
  } catch (err) {
    return missingPackageResult("usearch", "npm install --no-save usearch", err);
  }
  const Index = mod.Index ?? mod.default?.Index ?? mod.default;
  if (typeof Index !== "function") {
    return unsupportedResult("usearch", "could not find Index export", Object.keys(mod));
  }
  const index = new Index({ ndim: dim, metric: "cos", dtype: "f32" });
  if (typeof index.add !== "function" || typeof index.search !== "function") {
    return unsupportedResult("usearch", "Index does not expose add/search functions", Object.keys(index));
  }
  const buildStarted = performance.now();
  for (let i = 0; i < vectors.length; i += 1) {
    index.add(i, vectors[i]);
  }
  const buildMs = performance.now() - buildStarted;
  let persistMs = null;
  if (persistDir && typeof index.save === "function") {
    fs.mkdirSync(persistDir, { recursive: true });
    const saveStarted = performance.now();
    index.save(path.join(persistDir, "probe.usearch"));
    persistMs = performance.now() - saveStarted;
  }
  const timings = [];
  let checksum = 0;
  for (const query of queries) {
    const started = performance.now();
    const matches = normalizeUsearchMatches(index.search(query, k));
    timings.push(performance.now() - started);
    checksum += matches[0]?.id ?? 0;
  }
  return {
    provider_status: "ok",
    build_ms: Number(buildMs.toFixed(3)),
    persist_ms: persistMs === null ? null : Number(persistMs.toFixed(3)),
    search: summarizeTimings(timings),
    checksum,
  };
}

async function loadSqliteVec(db, mod) {
  const candidates = [
    mod.load,
    mod.default?.load,
    mod.loadablePath,
    mod.default?.loadablePath,
    mod.getLoadablePath,
    mod.default?.getLoadablePath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      const value = candidate.length >= 1 ? candidate(db) : candidate();
      if (typeof value === "string") {
        db.enableLoadExtension?.(true);
        db.loadExtension(value);
        return;
      }
      return;
    }
    if (typeof candidate === "string") {
      db.enableLoadExtension?.(true);
      db.loadExtension(candidate);
      return;
    }
  }
  throw new Error("sqlite-vec package did not expose a recognized load helper");
}

async function runSqliteVecProbe({ vectors, queries, k, dim }) {
  let sqliteVec;
  try {
    sqliteVec = await import("sqlite-vec");
  } catch (err) {
    return missingPackageResult("sqlite-vec", "npm install --no-save sqlite-vec", err);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    await loadSqliteVec(db, sqliteVec);
    db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[${dim}])`);
    const insert = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
    const buildStarted = performance.now();
    for (let i = 0; i < vectors.length; i += 1) {
      insert.run(i + 1, JSON.stringify(Array.from(vectors[i])));
    }
    const buildMs = performance.now() - buildStarted;
    const search = db.prepare("SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = ? ORDER BY distance LIMIT ?");
    const timings = [];
    let checksum = 0;
    for (const query of queries) {
      const started = performance.now();
      const rows = search.all(JSON.stringify(Array.from(query)), k, k);
      timings.push(performance.now() - started);
      checksum += Number(rows[0]?.rowid ?? 0) - 1;
    }
    return {
      provider_status: "ok",
      build_ms: Number(buildMs.toFixed(3)),
      search: summarizeTimings(timings),
      checksum,
    };
  } finally {
    db.close();
  }
}

async function runLanceDbProbe({ vectors, queries, k, persistDir }) {
  let lancedb;
  try {
    lancedb = await import("@lancedb/lancedb");
  } catch (err) {
    return missingPackageResult("@lancedb/lancedb", "npm install --no-save @lancedb/lancedb", err);
  }
  const connect = lancedb.connect ?? lancedb.default?.connect;
  if (typeof connect !== "function") {
    return unsupportedResult("lancedb", "could not find connect export", Object.keys(lancedb));
  }
  const dir = persistDir || fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lancedb-probe-"));
  fs.mkdirSync(dir, { recursive: true });
  const db = await connect(dir);
  const rows = vectors.map((vector, id) => ({
    id,
    vector: Array.from(vector),
    scope: "probe",
    tier: id % 2 === 0 ? "hot" : "warm",
  }));
  const buildStarted = performance.now();
  const table = await db.createTable(`ann_probe_${Date.now()}`, rows, { mode: "overwrite" });
  const buildMs = performance.now() - buildStarted;
  const timings = [];
  let checksum = 0;
  for (const query of queries) {
    const started = performance.now();
    const result = await table.vectorSearch(Array.from(query)).limit(k).toArray();
    timings.push(performance.now() - started);
    checksum += Number(result[0]?.id ?? 0);
  }
  return {
    provider_status: "ok",
    build_ms: Number(buildMs.toFixed(3)),
    search: summarizeTimings(timings),
    checksum,
    persist_dir: dir,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vectors = makeVectors(args.vectors, args.dim, args.seed);
  const queries = queriesFromVectors(vectors, args.queries);
  const started = performance.now();
  let provider;
  if (args.provider === "local") provider = await runLocalProbe({ vectors, queries, k: args.k });
  else if (args.provider === "usearch") provider = await runUsearchProbe({ ...args, vectors, queries });
  else if (args.provider === "sqlite-vec") provider = await runSqliteVecProbe({ ...args, vectors, queries });
  else if (args.provider === "lancedb") provider = await runLanceDbProbe({ ...args, vectors, queries });
  else throw new Error(`unsupported provider: ${args.provider}`);
  const result = {
    contract_version: "aionis_ann_backend_probe_v1",
    generated_at: new Date().toISOString(),
    provider: args.provider,
    vectors: args.vectors,
    dim: args.dim,
    queries: args.queries,
    k: args.k,
    seed: args.seed,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
    provider_result: provider,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, json);
  }
  process.stdout.write(json);
  if (provider.provider_status && provider.provider_status !== "ok") {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
