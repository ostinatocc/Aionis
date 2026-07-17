#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runLearningExternalEvidenceIngestCli } from "../src/operator/learning-external-evidence-ingest.js";

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href;
}

if (isMainModule()) {
  void runLearningExternalEvidenceIngestCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
