import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PRODUCT_SURFACES = [
  "src",
  "README.md",
  "docs/FOCUS.md",
  "docs/ARCHITECTURE_BOUNDARY.md",
  "docs/LEARNING_CONTROL_PRINCIPLES.md",
  "docs/REAL_LLM_EVAL.md",
] as const;

const EVAL_RUNNER_SURFACES = [
  "scripts/real-llm-eval/run-real-agent-eval.ts",
  "scripts/real-llm-eval/report-runtime-effect-rollup.ts",
  "scripts/real-llm-eval/rollup-real-agent-eval.ts",
] as const;

const FORBIDDEN_PRODUCT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "host-specific Codex vocabulary", pattern: /\bCodex\b|codex_|codex-plugin|aionis-codex|host:\s*["']codex["']/i },
  { name: "project-specific Axios repair vocabulary", pattern: /AxiosHeaders|axios-set-cookie/i },
  { name: "project-specific picomatch repair vocabulary", pattern: /picomatch|returnObject/i },
  { name: "project-specific p-map repair vocabulary", pattern: /pMapIterable|p-map-iterable/i },
  { name: "project-specific p-locate repair vocabulary", pattern: /p-locate|pLocate/i },
  { name: "project-specific p-limit repair vocabulary", pattern: /p-limit|clearQueue/i },
  { name: "project-specific commander repair vocabulary", pattern: /commander-short|commander\.js/i },
  { name: "project-specific Got repair vocabulary", pattern: /got-upload-progress|Got issue|chunk-data|uploadProgress/i },
  { name: "eval verifier implementation vocabulary", pattern: /github-real-project-contracts|github_project_verifier_logic/i },
  { name: "provider benchmark vocabulary", pattern: /DeepSeek|V4-Pro/i },
  { name: "testing preference product vocabulary", pattern: /mock_or_real_testing_preference/i },
];

function collectFiles(surface: string): string[] {
  const stat = statSync(surface);
  if (stat.isFile()) return [surface];

  const out: string[] = [];
  for (const entry of readdirSync(surface)) {
    if (entry === "node_modules" || entry === ".tmp" || entry === ".git") continue;
    const child = join(surface, entry);
    const childStat = statSync(child);
    if (childStat.isDirectory()) {
      out.push(...collectFiles(child));
    } else if (childStat.isFile() && /\.(?:ts|tsx|js|mjs|md|json)$/.test(child)) {
      out.push(child);
    }
  }
  return out;
}

test("product core stays generic and free of known-project repair vocabulary", () => {
  const violations: string[] = [];
  const files = PRODUCT_SURFACES.flatMap((surface) => collectFiles(surface));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const forbidden of FORBIDDEN_PRODUCT_PATTERNS) {
      if (forbidden.pattern.test(text)) {
        violations.push(`${file}: ${forbidden.name}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("real eval runner stays task-agnostic and does not embed known-project repair hints", () => {
  const violations: string[] = [];
  const forbiddenEvalPatterns = FORBIDDEN_PRODUCT_PATTERNS
    .filter((entry) => entry.name !== "eval verifier implementation vocabulary");

  for (const file of EVAL_RUNNER_SURFACES) {
    const text = readFileSync(file, "utf8");
    for (const forbidden of forbiddenEvalPatterns) {
      if (forbidden.pattern.test(text)) {
        violations.push(`${file}: ${forbidden.name}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
