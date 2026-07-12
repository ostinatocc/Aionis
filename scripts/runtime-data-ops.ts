#!/usr/bin/env node

import {
  LITE_PROJECTION_JOB_KINDS,
  type LiteProjectionJobKind,
  type LiteProjectionJobStatus,
} from "../src/store/lite-projection-outbox.js";
import {
  inspectLiteProjectionRepairState,
  repairLiteProjectionState,
} from "../src/store/lite-projection-repair.js";
import {
  backupLiteRuntimeDatabase,
  preflightLiteRuntimeDatabase,
  restoreLiteRuntimeDatabase,
  upgradeLiteRuntimeDatabase,
  verifyLiteRuntimeDatabase,
} from "../src/store/lite-runtime-data-operations.js";

type ParsedArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

const JOB_STATUSES: LiteProjectionJobStatus[] = [
  "pending",
  "running",
  "retry",
  "dead_letter",
  "succeeded",
];

function usage(): string {
  return `Aionis Runtime SQLite data operations

Usage:
  npx tsx scripts/runtime-data-ops.ts preflight --db PATH
  npx tsx scripts/runtime-data-ops.ts upgrade --db PATH
  npx tsx scripts/runtime-data-ops.ts verify --db PATH
  npx tsx scripts/runtime-data-ops.ts backup --db PATH --out BACKUP_PATH
  npx tsx scripts/runtime-data-ops.ts restore --backup BACKUP_PATH --to NEW_DB_PATH
  npx tsx scripts/runtime-data-ops.ts projection-list --db PATH [filters]
  npx tsx scripts/runtime-data-ops.ts projection-repair --db PATH [repair options]

Projection filters:
  --status pending,running,retry,dead_letter,succeeded
  --kind embedding_generate,ann_reconcile
  --scope SCOPE_KEY --node NODE_ID --limit N

Projection repair options:
  --provider-name NAME --provider-dim 1536
  --default-tenant TENANT_ID --max-text-len N
  --legacy-only | --dead-letter-only
  --embedding-only | --ann-only
  --mark-unrecoverable-failed
`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return { command, values, flags };
}

function required(args: ParsedArgs, name: string): string {
  const value = args.values.get(name)?.trim();
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function positiveInteger(args: ParsedArgs, name: string): number | undefined {
  const raw = args.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function csvEnum<T extends string>(
  args: ParsedArgs,
  name: string,
  allowed: readonly T[],
): T[] | undefined {
  const raw = args.values.get(name);
  if (!raw) return undefined;
  const values = Array.from(new Set(raw.split(",").map((value) => value.trim()).filter(Boolean)));
  for (const value of values) {
    if (!allowed.includes(value as T)) {
      throw new Error(`--${name} contains unsupported value: ${value}`);
    }
  }
  return values as T[];
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.flags.has("help")) {
    process.stdout.write(usage());
    return;
  }
  if (args.command === "preflight") {
    const report = preflightLiteRuntimeDatabase(required(args, "db"));
    print(report);
    if (report.schema.classification === "incompatible") process.exitCode = 2;
    return;
  }
  if (args.command === "upgrade") {
    print(await upgradeLiteRuntimeDatabase(required(args, "db")));
    return;
  }
  if (args.command === "verify") {
    const report = await verifyLiteRuntimeDatabase(required(args, "db"));
    print(report);
    if (!report.ok) process.exitCode = 2;
    return;
  }
  if (args.command === "backup") {
    print(await backupLiteRuntimeDatabase({
      sourcePath: required(args, "db"),
      destinationPath: required(args, "out"),
    }));
    return;
  }
  if (args.command === "restore") {
    print(await restoreLiteRuntimeDatabase({
      backupPath: required(args, "backup"),
      destinationPath: required(args, "to"),
    }));
    return;
  }
  if (args.command === "projection-list") {
    print(await inspectLiteProjectionRepairState({
      path: required(args, "db"),
      ...(csvEnum(args, "status", JOB_STATUSES) ? { statuses: csvEnum(args, "status", JOB_STATUSES) } : {}),
      ...(csvEnum(args, "kind", LITE_PROJECTION_JOB_KINDS) ? {
        jobKinds: csvEnum(args, "kind", LITE_PROJECTION_JOB_KINDS) as LiteProjectionJobKind[],
      } : {}),
      ...(args.values.get("scope") ? { scope: args.values.get("scope") } : {}),
      ...(args.values.get("node") ? { nodeId: args.values.get("node") } : {}),
      ...(positiveInteger(args, "limit") ? { limit: positiveInteger(args, "limit") } : {}),
      ...(positiveInteger(args, "max-text-len") ? { maxTextLen: positiveInteger(args, "max-text-len") } : {}),
    }));
    return;
  }
  if (args.command === "projection-repair") {
    if (args.flags.has("legacy-only") && args.flags.has("dead-letter-only")) {
      throw new Error("--legacy-only and --dead-letter-only are mutually exclusive");
    }
    if (args.flags.has("embedding-only") && args.flags.has("ann-only")) {
      throw new Error("--embedding-only and --ann-only are mutually exclusive");
    }
    print(await repairLiteProjectionState({
      path: required(args, "db"),
      ...(args.values.get("provider-name") ? { providerName: args.values.get("provider-name") } : {}),
      ...(positiveInteger(args, "provider-dim") ? { providerDim: positiveInteger(args, "provider-dim") } : {}),
      ...(args.values.get("default-tenant") ? { defaultTenantId: args.values.get("default-tenant") } : {}),
      ...(args.values.get("scope") ? { scope: args.values.get("scope") } : {}),
      ...(args.values.get("node") ? { nodeId: args.values.get("node") } : {}),
      ...(positiveInteger(args, "limit") ? { limit: positiveInteger(args, "limit") } : {}),
      ...(positiveInteger(args, "max-text-len") ? { maxTextLen: positiveInteger(args, "max-text-len") } : {}),
      repairLegacy: !args.flags.has("dead-letter-only"),
      repairDeadLetters: !args.flags.has("legacy-only"),
      repairEmbedding: !args.flags.has("ann-only"),
      repairAnn: !args.flags.has("embedding-only"),
      markUnrecoverableFailed: args.flags.has("mark-unrecoverable-failed"),
    }));
    return;
  }
  throw new Error(`unknown command: ${args.command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    error: "runtime_data_operation_failed",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
