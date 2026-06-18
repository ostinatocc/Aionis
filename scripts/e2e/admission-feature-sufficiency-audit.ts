#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditAdmissionFeatureSufficiencyJsonl,
  formatAdmissionFeatureSufficiencyAuditMarkdown,
} from "../../src/memory/admission-feature-sufficiency-audit.js";

type CliArgs = {
  input: string | null;
  outDir: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { input: null, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      out.input = next;
      i += 1;
    } else if (arg === "--out-dir" && next) {
      out.outDir = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: npm run -s admission:feature-audit -- --input rows.jsonl [--out-dir reports/admission]",
        "",
        "Audits whether current label-safe admission features can separate positive and negative direct-use rows.",
        "",
      ].join("\n"));
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("Missing --input rows.jsonl");
  const inputPath = path.resolve(args.input);
  const report = auditAdmissionFeatureSufficiencyJsonl(fs.readFileSync(inputPath, "utf8"));
  const markdown = formatAdmissionFeatureSufficiencyAuditMarkdown(report);
  if (args.outDir) {
    const outDir = path.resolve(args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const summaryPath = path.join(outDir, "feature_sufficiency_audit.json");
    const markdownPath = path.join(outDir, "feature_sufficiency_audit.md");
    fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdown);
    process.stdout.write(`${JSON.stringify({
      contract_version: "aionis_admission_feature_sufficiency_audit_cli_result_v1",
      input: inputPath,
      out_dir: outDir,
      feature_sufficiency_audit_path: summaryPath,
      feature_sufficiency_audit_markdown_path: markdownPath,
      has_positive_negative_collision: report.findings.has_positive_negative_collision,
      summary: report.summary,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(markdown);
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
