#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAdmissionDatasetRows } from "../../src/memory/admission-dataset-collector.js";

type CliArgs = {
  datasetDir: string | null;
  inputs: string[];
  chunkId: string | null;
  policyId: string | null;
  policyVersion: string | null;
  policyMode: string | null;
  runtimeVersion: string | null;
  evaluate: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    datasetDir: null,
    inputs: [],
    chunkId: null,
    policyId: null,
    policyVersion: null,
    policyMode: null,
    runtimeVersion: null,
    evaluate: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--dataset-dir" || arg === "--out-dir") && next) {
      out.datasetDir = next;
      i += 1;
    } else if (arg === "--input" && next) {
      out.inputs.push(next);
      i += 1;
    } else if (arg === "--chunk-id" && next) {
      out.chunkId = next;
      i += 1;
    } else if (arg === "--policy-id" && next) {
      out.policyId = next;
      i += 1;
    } else if (arg === "--policy-version" && next) {
      out.policyVersion = next;
      i += 1;
    } else if (arg === "--policy-mode" && next) {
      out.policyMode = next;
      i += 1;
    } else if (arg === "--runtime-version" && next) {
      out.runtimeVersion = next;
      i += 1;
    } else if (arg === "--no-evaluate") {
      out.evaluate = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:collect -- --dataset-dir admission-dataset --input chunk.jsonl [--input more.jsonl]",
        "",
        "Appends validated admission dataset rows, writes a manifest, and refreshes reports/latest.",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.datasetDir) throw new Error("Missing --dataset-dir admission-dataset");
  if (args.inputs.length === 0) throw new Error("Missing --input rows.jsonl");
  const result = collectAdmissionDatasetRows({
    dataset_dir: args.datasetDir,
    input_files: args.inputs,
    chunk_id: args.chunkId,
    policy_id: args.policyId,
    policy_version: args.policyVersion,
    policy_mode: args.policyMode,
    runtime_version: args.runtimeVersion,
    evaluate: args.evaluate,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
