import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  memoryAdmissionDatasetJsonlFromRows,
  type AionisMemoryAdmissionDatasetRow,
} from "../sdk.js";
import {
  evaluateAdmissionDatasetJsonl,
  formatAdmissionDatasetEvaluationMarkdown,
  parseAdmissionDatasetJsonl,
  type AionisAdmissionDatasetEvaluatorOptions,
  type AionisAdmissionDatasetEvaluationReport,
} from "./admission-dataset-evaluator.js";

export type AionisAdmissionDatasetCollectorInput = {
  path: string;
  row_count: number;
  jsonl_line_count: number;
  sha256: string;
};

export type AionisAdmissionDatasetCollectorResult = {
  contract_version: "aionis_admission_dataset_collector_result_v1";
  dataset_dir: string;
  chunk_id: string;
  rows_path: string;
  manifest_path: string;
  summary_path: string | null;
  leaderboard_path: string | null;
  appended_row_count: number;
  previous_row_count: number;
  total_row_count: number;
  input_files: AionisAdmissionDatasetCollectorInput[];
  evaluation: AionisAdmissionDatasetEvaluationReport | null;
  checks: {
    append_only: boolean;
    row_count_matches_jsonl: boolean;
    prompt_payload_excluded: boolean;
    raw_slots_excluded: boolean;
    embeddings_excluded: boolean;
  };
};

export type CollectAdmissionDatasetArgs = AionisAdmissionDatasetEvaluatorOptions & {
  dataset_dir: string;
  input_files: string[];
  chunk_id?: string | null;
  now?: string | null;
  evaluate?: boolean;
};

type ParsedInputFile = AionisAdmissionDatasetCollectorInput & {
  rows: AionisMemoryAdmissionDatasetRow[];
};

const FORBIDDEN_DATASET_KEYS = new Set([
  "prompt_text",
  "agent_prompt",
  "raw_memory_rows",
  "raw_slots",
  "slots",
  "embedding",
  "embeddings",
  "embedding_vector",
  "embedding_vector_json",
]);

function compactString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function timestampId(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineCount(jsonl: string): number {
  return jsonl.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function assertNoForbiddenKeys(value: unknown, source: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoForbiddenKeys(entry, source));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DATASET_KEYS.has(key)) {
      throw new Error(`Admission dataset row from ${source} contains forbidden key ${key}`);
    }
    assertNoForbiddenKeys(child, source);
  }
}

function validateNoForbiddenPayload(jsonl: string, source: string): void {
  jsonl.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid admission dataset JSONL at ${source}:${index + 1}: ${(err as Error).message}`);
    }
    assertNoForbiddenKeys(parsed, `${source}:${index + 1}`);
  });
}

function normalizeDatasetRow(row: AionisMemoryAdmissionDatasetRow): AionisMemoryAdmissionDatasetRow {
  return {
    contract_version: row.contract_version,
    intended_use: row.intended_use,
    source: row.source,
    agent_prompt_included: row.agent_prompt_included,
    runtime_mutation: row.runtime_mutation,
    policy_id: row.policy_id,
    policy_version: row.policy_version,
    policy_mode: row.policy_mode,
    runtime_version: row.runtime_version,
    tenant_id: row.tenant_id,
    scope: row.scope,
    guide_trace_id: row.guide_trace_id,
    run_id: row.run_id,
    task_id: row.task_id,
    task_signature: row.task_signature,
    row_index: row.row_index,
    memory_id: row.memory_id,
    title: row.title,
    memory_origin: row.memory_origin,
    source_backend: row.source_backend,
    domain: row.domain,
    memory_type: row.memory_type,
    lifecycle_state: row.lifecycle_state,
    authority: row.authority,
    admission_action: row.admission_action,
    decision_kind: row.decision_kind,
    actionable: row.actionable,
    prompt_included: row.prompt_included,
    agent_used: row.agent_used,
    feedback_outcome: row.feedback_outcome,
    attribution_strength: row.attribution_strength,
    outcome_label: row.outcome_label,
    reason_codes: [...row.reason_codes],
    evidence_ids: [...row.evidence_ids],
    prompt_char_count: row.prompt_char_count,
    history_used: row.history_used,
    actionable_history_used: row.actionable_history_used,
  };
}

function parseInputFile(file: string, options: AionisAdmissionDatasetEvaluatorOptions): ParsedInputFile {
  const resolved = path.resolve(file);
  const jsonl = fs.readFileSync(resolved, "utf8");
  validateNoForbiddenPayload(jsonl, resolved);
  const rows = parseAdmissionDatasetJsonl(jsonl, options).map(normalizeDatasetRow);
  const jsonlLines = lineCount(jsonl);
  if (rows.length !== jsonlLines) {
    throw new Error(`Admission dataset ${resolved} row count mismatch: parsed=${rows.length} jsonl_lines=${jsonlLines}`);
  }
  return {
    path: resolved,
    row_count: rows.length,
    jsonl_line_count: jsonlLines,
    sha256: sha256(jsonl),
    rows,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function collectAdmissionDatasetRows(args: CollectAdmissionDatasetArgs): AionisAdmissionDatasetCollectorResult {
  if (args.input_files.length === 0) {
    throw new Error("Admission dataset collector requires at least one input file");
  }
  const datasetDir = path.resolve(args.dataset_dir);
  const rowsPath = path.join(datasetDir, "rows.jsonl");
  const manifestsDir = path.join(datasetDir, "manifests");
  const reportsDir = path.join(datasetDir, "reports", "latest");
  const collectedAt = compactString(args.now) ?? new Date().toISOString();
  const chunkId = compactString(args.chunk_id) ?? `admission-${timestampId(collectedAt)}-${randomUUID().slice(0, 8)}`;
  const policyOptions: AionisAdmissionDatasetEvaluatorOptions = {
    policy_id: args.policy_id,
    policy_version: args.policy_version,
    policy_mode: args.policy_mode,
    runtime_version: args.runtime_version,
  };
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.mkdirSync(manifestsDir, { recursive: true });
  const previousRowsJsonl = fs.existsSync(rowsPath) ? fs.readFileSync(rowsPath, "utf8") : "";
  validateNoForbiddenPayload(previousRowsJsonl, rowsPath);
  const previousRowCount = lineCount(previousRowsJsonl);
  const inputFiles = args.input_files.map((file) => parseInputFile(file, policyOptions));
  const appendedRows = inputFiles.flatMap((file) => file.rows);
  const appendedJsonl = memoryAdmissionDatasetJsonlFromRows(appendedRows);
  const appendedLineCount = lineCount(appendedJsonl);
  if (appendedLineCount !== appendedRows.length) {
    throw new Error(`Admission dataset append mismatch: rows=${appendedRows.length} jsonl_lines=${appendedLineCount}`);
  }
  if (appendedRows.length > 0) {
    const prefix = previousRowsJsonl.trim().length > 0 ? "\n" : "";
    fs.appendFileSync(rowsPath, `${prefix}${appendedJsonl.trimEnd()}\n`);
  }
  const finalJsonl = fs.readFileSync(rowsPath, "utf8");
  validateNoForbiddenPayload(finalJsonl, rowsPath);
  const totalRowCount = lineCount(finalJsonl);
  const evaluation = args.evaluate === false ? null : evaluateAdmissionDatasetJsonl(finalJsonl, policyOptions);
  let summaryPath: string | null = null;
  let leaderboardPath: string | null = null;
  if (evaluation) {
    fs.mkdirSync(reportsDir, { recursive: true });
    summaryPath = path.join(reportsDir, "summary.json");
    leaderboardPath = path.join(reportsDir, "leaderboard.md");
    writeJson(summaryPath, evaluation);
    fs.writeFileSync(leaderboardPath, formatAdmissionDatasetEvaluationMarkdown(evaluation));
  }
  const manifestPath = path.join(manifestsDir, `${chunkId}.json`);
  const manifest = {
    contract_version: "aionis_admission_dataset_collect_manifest_v1",
    source: "admission_dataset_jsonl",
    append_mode: "jsonl_append",
    runtime_mutation: false,
    agent_prompt_included: false,
    dataset_dir: datasetDir,
    rows_path: rowsPath,
    chunk_id: chunkId,
    collected_at: collectedAt,
    row_offset_start: previousRowCount,
    row_offset_end: totalRowCount,
    appended_row_count: appendedRows.length,
    previous_row_count: previousRowCount,
    total_row_count: totalRowCount,
    input_files: inputFiles.map(({ rows: _rows, ...file }) => file),
    policy: {
      policy_id: evaluation?.policy.policy_id ?? appendedRows[0]?.policy_id ?? null,
      policy_version: evaluation?.policy.policy_version ?? appendedRows[0]?.policy_version ?? null,
      policy_mode: evaluation?.policy.policy_mode ?? appendedRows[0]?.policy_mode ?? null,
      runtime_version: evaluation?.policy.runtime_version ?? appendedRows[0]?.runtime_version ?? null,
    },
    reports: {
      summary_path: summaryPath,
      leaderboard_path: leaderboardPath,
    },
  };
  writeJson(manifestPath, manifest);
  return {
    contract_version: "aionis_admission_dataset_collector_result_v1",
    dataset_dir: datasetDir,
    chunk_id: chunkId,
    rows_path: rowsPath,
    manifest_path: manifestPath,
    summary_path: summaryPath,
    leaderboard_path: leaderboardPath,
    appended_row_count: appendedRows.length,
    previous_row_count: previousRowCount,
    total_row_count: totalRowCount,
    input_files: inputFiles.map(({ rows: _rows, ...file }) => file),
    evaluation,
    checks: {
      append_only: totalRowCount === previousRowCount + appendedRows.length,
      row_count_matches_jsonl: totalRowCount === lineCount(finalJsonl),
      prompt_payload_excluded: !finalJsonl.includes("\"prompt_text\"") && !finalJsonl.includes("\"agent_prompt\""),
      raw_slots_excluded: !finalJsonl.includes("\"slots\"") && !finalJsonl.includes("raw_slots"),
      embeddings_excluded: !finalJsonl.includes("embedding_vector") && !finalJsonl.includes("\"embeddings\""),
    },
  };
}
