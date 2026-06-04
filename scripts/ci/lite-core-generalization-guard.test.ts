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
] as const;

const FORBIDDEN_PRODUCT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "declared project-specific repair vocabulary", pattern: /project_specific_repair|task_specific_fix|verifier_answer_string/i },
  { name: "eval verifier implementation vocabulary", pattern: /github-real-project-contracts|github_project_verifier_logic/i },
  { name: "provider benchmark vocabulary", pattern: /DeepSeek|V4-Pro/i },
  { name: "testing-mode product vocabulary", pattern: /non_live_testing_preference/i },
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
