#!/usr/bin/env node

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDirectory = resolve(root, "src", "store", "sql");
const outputDirectory = resolve(root, "dist", "store", "sql");
const assets = Object.freeze([
  "continuation-runtime-v1.sql",
  "continuation-runtime-v1.manifest.json",
]);

mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
for (const asset of assets) {
  const source = resolve(sourceDirectory, asset);
  if (!statSync(source).isFile() || basename(source) !== asset) {
    throw new Error("continuation_runtime_v1_build_asset_invalid");
  }
  copyFileSync(source, resolve(outputDirectory, asset));
}
