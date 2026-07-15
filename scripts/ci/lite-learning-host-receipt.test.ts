import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import {
  hostTaskEnvelopeDigest,
  hostUseReceiptDigest,
  type HostTaskEnvelopeV1,
  type HostUseReceiptV1,
  type HostUseReceiptV1Body,
} from "../../src/memory/learning-episode-ledger.js";
import { runLearningHostReceiptCli } from "../learning-host-receipt.js";

const COLLECTOR_ID = "reviewed-host-adapter";
const COLLECTOR_VERSION = "reviewed-host-adapter-v7";
const VERIFIER = Object.freeze({
  kind: "deterministic_scorer" as const,
  version: "host-outcome-scorer-v3",
  config_sha256: digest("host-outcome-scorer-v3-config"),
});
const VERIFIER_POLICY_SHA256 = digest(stableStringify({ allowed_verifiers: [VERIFIER] }));

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDirectory(t: test.TestContext, name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-host-receipt-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function envelope(index = 1): HostTaskEnvelopeV1 {
  return {
    contract_version: "host_task_envelope_v1",
    host_task_id: `host-task-${index}`,
    collector_id: COLLECTOR_ID,
    collector_version: COLLECTOR_VERSION,
    task_family: "repository_change",
    task_signature: `repository-change-${index}`,
    repository_signature: `repository-${index}`,
    source_task_sha256: digest(`source-task-${index}`),
    source_event_sha256: digest(`source-event-${index}`),
    created_at: `2026-07-14T00:00:0${index}.000Z`,
  };
}

function receipt(
  taskEnvelope: HostTaskEnvelopeV1,
  index = 1,
  overrides: Partial<HostUseReceiptV1Body> = {},
): HostUseReceiptV1 {
  const body: HostUseReceiptV1Body = {
    contract_version: "host_use_receipt_v1",
    receipt_id: `host-receipt-${index}`,
    guide_trace_id: `guide-trace-${index}`,
    episode_id: `lep_${digest(`episode-${index}`)}`,
    operation_id: `feedback-operation-${index}`,
    run_id: `host-run-${index}`,
    host_task_id: taskEnvelope.host_task_id,
    host_task_envelope_sha256: hostTaskEnvelopeDigest(taskEnvelope),
    collector_id: COLLECTOR_ID,
    collector_version: COLLECTOR_VERSION,
    host_trace_sha256: digest(`sanitized-host-trace-${index}`),
    observed_at: `2026-07-14T00:01:0${index}.000Z`,
    items: [{
      memory_id: `memory-${index}`,
      used_surface: "use_now",
      outcome: "positive",
      action_outcome: "accepted_completed",
      verifier_kind: VERIFIER.kind,
      verifier_version: VERIFIER.version,
      verifier_config_sha256: VERIFIER.config_sha256,
      verifier_status: "passed",
      content_evidence_sha256: digest(`content-evidence-${index}`),
      evidence_ref_sha256: digest(`evidence-reference-${index}`),
    }],
    ...overrides,
  };
  return { ...body, receipt_sha256: hostUseReceiptDigest(body) };
}

function manifestCase(index = 1) {
  const taskEnvelope = envelope(index);
  return {
    contract_version: "aionis_host_receipt_conformance_case_v1" as const,
    case_id: `host-receipt-case-${index}`,
    host_task_envelope_v1: taskEnvelope,
    host_task_envelope_sha256: hostTaskEnvelopeDigest(taskEnvelope),
    host_use_receipt_v1: receipt(taskEnvelope, index),
  };
}

function manifestHeader(caseCount: number) {
  return {
    contract_version: "aionis_host_receipt_conformance_manifest_v1" as const,
    host_adapter_id: "reviewed-production-host-adapter",
    host_adapter_version: "production-adapter-v7",
    host_adapter_sha256: digest("reviewed-production-host-adapter-v7-binary"),
    collector_id: COLLECTOR_ID,
    collector_version: COLLECTOR_VERSION,
    verifier_policy_sha256: VERIFIER_POLICY_SHA256,
    allowed_verifiers: [VERIFIER],
    case_count: caseCount,
  };
}

function canonicalJsonl(cases: readonly Record<string, unknown>[]): string {
  return `${[manifestHeader(cases.length), ...cases].map((row) => stableStringify(row)).join("\n")}\n`;
}

function writeManifest(directory: string, cases: readonly Record<string, unknown>[]): string {
  const manifestPath = path.join(directory, "host-receipt-manifest.jsonl");
  fs.writeFileSync(manifestPath, canonicalJsonl(cases), "utf8");
  return manifestPath;
}

function verifyArgs(manifestPath: string, outPath: string): string[] {
  return [
    "verify",
    "--manifest",
    manifestPath,
    "--collector-id",
    COLLECTOR_ID,
    "--collector-version",
    COLLECTOR_VERSION,
    "--verifier-policy-sha256",
    VERIFIER_POLICY_SHA256,
    "--out",
    outPath,
  ];
}

async function invoke(argv: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runLearningHostReceiptCli(argv, {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

function errorCode(stderr: string): string {
  return (JSON.parse(stderr) as { code: string }).code;
}

test("host receipt verifier writes one deterministic canonical 0600 contract-only result", async (t) => {
  const directory = tempDirectory(t, "success");
  const firstCase = manifestCase(1);
  const secondCase = manifestCase(2);
  const manifestPath = writeManifest(directory, [firstCase, secondCase]);
  const firstOut = path.join(directory, "result-1.json");
  const secondOut = path.join(directory, "result-2.json");

  const first = await invoke(verifyArgs(manifestPath, firstOut));
  const second = await invoke(verifyArgs(manifestPath, secondOut));
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(first.stderr, "");
  assert.equal(second.stderr, "");

  const firstJson = fs.readFileSync(firstOut, "utf8");
  const secondJson = fs.readFileSync(secondOut, "utf8");
  assert.equal(firstJson, secondJson);
  assert.equal(first.stdout, `${firstJson}\n`);
  assert.equal(second.stdout, `${secondJson}\n`);
  assert.equal(fs.statSync(firstOut).mode & 0o777, 0o600);
  assert.equal(fs.statSync(secondOut).mode & 0o777, 0o600);

  const result = JSON.parse(firstJson) as Record<string, unknown>;
  assert.equal(stableStringify(result), firstJson);
  assert.equal(result.contract_version, "aionis_host_receipt_conformance_result_v1");
  assert.equal(result.status, "passed");
  assert.equal(result.authority_ceiling, "contract_conformance_only");
  assert.equal(result.eligible_host_identity_verified, false);
  assert.equal(result.collector_id, COLLECTOR_ID);
  assert.equal(result.collector_version, COLLECTOR_VERSION);
  assert.equal(result.verifier_policy_sha256, VERIFIER_POLICY_SHA256);
  assert.equal(result.manifest_sha256, digest(canonicalJsonl([firstCase, secondCase])));
  assert.equal(result.case_count, 2);
  assert.equal(result.receipt_item_count, 2);
  assert.equal(
    result.task_envelope_set_sha256,
    digest(stableStringify([
      firstCase.host_task_envelope_sha256,
      secondCase.host_task_envelope_sha256,
    ].sort())),
  );
  assert.equal(
    result.host_use_receipt_set_sha256,
    digest(stableStringify([
      firstCase.host_use_receipt_v1.receipt_sha256,
      secondCase.host_use_receipt_v1.receipt_sha256,
    ].sort())),
  );
  assert.equal(
    result.verifier_tuple_set_sha256,
    digest(stableStringify([`${VERIFIER.kind}\u0000${VERIFIER.version}\u0000${VERIFIER.config_sha256}`])),
  );
  const { result_sha256: resultSha256, ...resultBody } = result;
  assert.equal(resultSha256, digest(stableStringify(resultBody)));
  assert.equal(Object.keys(result).some((key) => /(?:time|path|random)/iu.test(key)), false);
});

test("verify rejects missing, unknown, duplicate, malformed, and relative flags without output", async (t) => {
  const directory = tempDirectory(t, "arguments");
  const manifestPath = writeManifest(directory, [manifestCase(1)]);
  const outPath = path.join(directory, "result.json");
  const valid = verifyArgs(manifestPath, outPath);
  const cases: Array<{ argv: string[]; code: string }> = [
    {
      argv: valid.slice(0, valid.indexOf("--out")),
      code: "learning_host_receipt_cli_required_flag_missing",
    },
    {
      argv: [...valid, "--extra", "value"],
      code: "learning_host_receipt_cli_unknown_flag",
    },
    {
      argv: [...valid, "--collector-id", COLLECTOR_ID],
      code: "learning_host_receipt_cli_duplicate_flag",
    },
    {
      argv: valid.map((value) => value === manifestPath ? "relative-manifest.jsonl" : value),
      code: "learning_host_receipt_cli_absolute_path_required",
    },
    {
      argv: valid.map((value) => value === VERIFIER_POLICY_SHA256 ? "ABC" : value),
      code: "learning_host_receipt_cli_verifier_policy_invalid",
    },
  ];
  for (const scenario of cases) {
    const result = await invoke(scenario.argv);
    assert.equal(result.exitCode, 1);
    assert.equal(errorCode(result.stderr), scenario.code);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(outPath), false);
  }
});

test("verify binds collector flags and exact canonical verifier policy", async (t) => {
  const directory = tempDirectory(t, "policy");
  const manifestPath = writeManifest(directory, [manifestCase(1)]);
  for (const [name, mutate, expectedCode] of [
    [
      "collector-id",
      (argv: string[]) => argv.map((value) => value === COLLECTOR_ID ? "different-collector" : value),
      "learning_host_receipt_collector_mismatch",
    ],
    [
      "collector-version",
      (argv: string[]) => argv.map((value) => value === COLLECTOR_VERSION ? "different-version" : value),
      "learning_host_receipt_collector_mismatch",
    ],
    [
      "policy",
      (argv: string[]) => argv.map((value) => value === VERIFIER_POLICY_SHA256 ? digest("other-policy") : value),
      "learning_host_receipt_verifier_policy_mismatch",
    ],
  ] as const) {
    const outPath = path.join(directory, `${name}.json`);
    const result = await invoke(mutate(verifyArgs(manifestPath, outPath)));
    assert.equal(result.exitCode, 1);
    assert.equal(errorCode(result.stderr), expectedCode);
    assert.equal(fs.existsSync(outPath), false);
  }

  const writeVerifierBoundaryManifest = (name: string, version: string) => {
    const verifier = { ...VERIFIER, version };
    const policySha256 = digest(stableStringify({ allowed_verifiers: [verifier] }));
    const baseCase = manifestCase(1);
    const { receipt_sha256: _receiptSha256, ...receiptBody } = baseCase.host_use_receipt_v1;
    const nextReceiptBody: HostUseReceiptV1Body = {
      ...receiptBody,
      items: [{ ...receiptBody.items[0]!, verifier_version: version }],
    };
    const nextCase = {
      ...baseCase,
      host_use_receipt_v1: {
        ...nextReceiptBody,
        receipt_sha256: digest(stableStringify(nextReceiptBody)),
      },
    };
    const header = {
      ...manifestHeader(1),
      allowed_verifiers: [verifier],
      verifier_policy_sha256: policySha256,
    };
    const manifestPath = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(
      manifestPath,
      `${stableStringify(header)}\n${stableStringify(nextCase)}\n`,
      "utf8",
    );
    return { manifestPath, policySha256 };
  };
  const boundedVerifier = writeVerifierBoundaryManifest("verifier-version-120-bytes", "界".repeat(40));
  const boundedOut = path.join(directory, "verifier-version-120-bytes.json");
  const boundedResult = await invoke(verifyArgs(boundedVerifier.manifestPath, boundedOut).map((value) =>
    value === VERIFIER_POLICY_SHA256 ? boundedVerifier.policySha256 : value
  ));
  assert.equal(boundedResult.exitCode, 0, boundedResult.stderr);
  assert.equal(fs.existsSync(boundedOut), true);

  const oversizedVerifier = writeVerifierBoundaryManifest("verifier-version-123-bytes", "界".repeat(41));
  const oversizedOut = path.join(directory, "verifier-version-123-bytes.json");
  const oversizedResult = await invoke(verifyArgs(oversizedVerifier.manifestPath, oversizedOut).map((value) =>
    value === VERIFIER_POLICY_SHA256 ? oversizedVerifier.policySha256 : value
  ));
  assert.equal(oversizedResult.exitCode, 1);
  assert.equal(errorCode(oversizedResult.stderr), "learning_host_receipt_manifest_invalid");
  assert.equal(fs.existsSync(oversizedOut), false);

  const reversedVerifiers = [
    {
      kind: "instrumented_agent_trace" as const,
      version: "trace-v1",
      config_sha256: digest("trace-v1-config"),
    },
    VERIFIER,
  ];
  const malformedHeader = {
    ...manifestHeader(1),
    allowed_verifiers: reversedVerifiers,
    verifier_policy_sha256: digest(stableStringify({ allowed_verifiers: reversedVerifiers })),
  };
  const malformedPath = path.join(directory, "unsorted-policy.jsonl");
  fs.writeFileSync(
    malformedPath,
    `${stableStringify(malformedHeader)}\n${stableStringify(manifestCase(1))}\n`,
  );
  const malformedOut = path.join(directory, "unsorted-policy.json");
  const malformed = await invoke([
    ...verifyArgs(malformedPath, malformedOut).slice(0, -4),
    "--verifier-policy-sha256",
    malformedHeader.verifier_policy_sha256,
    "--out",
    malformedOut,
  ]);
  assert.equal(malformed.exitCode, 1);
  assert.equal(errorCode(malformed.stderr), "learning_host_receipt_verifier_policy_invalid");
  assert.equal(fs.existsSync(malformedOut), false);
});

test("verify rejects envelope, receipt, and cross-contract binding tampering without output", async (t) => {
  const directory = tempDirectory(t, "tamper");
  const baseCase = manifestCase(1);
  const tamperedEnvelope = {
    ...baseCase,
    host_task_envelope_sha256: digest("forged-envelope-digest"),
  };
  const tamperedReceipt = {
    ...baseCase,
    host_use_receipt_v1: {
      ...baseCase.host_use_receipt_v1,
      receipt_sha256: digest("forged-receipt-digest"),
    },
  };
  const wrongTaskEnvelope = envelope(1);
  const bindingReceipt = receipt(wrongTaskEnvelope, 1, { host_task_id: "different-host-task" });
  const tamperedBinding = {
    ...baseCase,
    host_use_receipt_v1: bindingReceipt,
  };
  for (const [name, row, expectedCode] of [
    ["envelope", tamperedEnvelope, "learning_host_receipt_envelope_digest_mismatch"],
    ["receipt", tamperedReceipt, "learning_host_receipt_manifest_invalid"],
    ["binding", tamperedBinding, "learning_host_receipt_binding_mismatch"],
  ] as const) {
    const manifestPath = writeManifest(directory, [row]);
    const outPath = path.join(directory, `${name}.json`);
    const result = await invoke(verifyArgs(manifestPath, outPath));
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(errorCode(result.stderr), expectedCode);
    assert.equal(fs.existsSync(outPath), false);
  }
});

test("verify rejects unregistered verifier configs and every required duplicate identity", async (t) => {
  const directory = tempDirectory(t, "identity");
  const first = manifestCase(1);
  const unregisteredEnvelope = envelope(1);
  const originalItem = receipt(unregisteredEnvelope, 1).items[0]!;
  const unregisteredReceipt = receipt(unregisteredEnvelope, 1, {
    items: [{ ...originalItem, verifier_config_sha256: digest("unregistered-verifier-config") }],
  });
  const unregistered = { ...first, host_use_receipt_v1: unregisteredReceipt };
  let manifestPath = writeManifest(directory, [unregistered]);
  let outPath = path.join(directory, "unregistered.json");
  let result = await invoke(verifyArgs(manifestPath, outPath));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_verifier_unregistered");
  assert.equal(fs.existsSync(outPath), false);

  for (const field of ["case_id", "source_event_sha256", "receipt_id", "operation_id"] as const) {
    const second = manifestCase(2);
    let duplicate = second;
    if (field === "case_id") {
      duplicate = { ...second, case_id: first.case_id };
    } else if (field === "source_event_sha256") {
      const duplicateEnvelope = {
        ...second.host_task_envelope_v1,
        source_event_sha256: first.host_task_envelope_v1.source_event_sha256,
      };
      duplicate = {
        ...second,
        host_task_envelope_v1: duplicateEnvelope,
        host_task_envelope_sha256: hostTaskEnvelopeDigest(duplicateEnvelope),
        host_use_receipt_v1: receipt(duplicateEnvelope, 2),
      };
    } else {
      const body = { ...second.host_use_receipt_v1 };
      delete (body as Partial<HostUseReceiptV1>).receipt_sha256;
      if (field === "receipt_id") body.receipt_id = first.host_use_receipt_v1.receipt_id;
      if (field === "operation_id") body.operation_id = first.host_use_receipt_v1.operation_id;
      duplicate = {
        ...second,
        host_use_receipt_v1: {
          ...body,
          receipt_sha256: hostUseReceiptDigest(body as HostUseReceiptV1Body),
        },
      };
    }
    manifestPath = writeManifest(directory, [first, duplicate]);
    outPath = path.join(directory, `duplicate-${field}.json`);
    result = await invoke(verifyArgs(manifestPath, outPath));
    assert.equal(result.exitCode, 1, `${field}: ${result.stderr}`);
    assert.equal(errorCode(result.stderr), "learning_host_receipt_manifest_duplicate_identity");
    assert.equal(fs.existsSync(outPath), false);
  }
});

test("verify rejects secret and raw-content fields without reflecting their values", async (t) => {
  const directory = tempDirectory(t, "secret");
  const marker = "DO_NOT_REFLECT_THIS_SECRET_VALUE";
  const baseCase = manifestCase(1);
  for (const [name, row] of [
    ["raw", { ...baseCase, raw_host_trace: marker }],
    ["secret", { ...baseCase, secret: marker }],
    ["prompt", { ...baseCase, prompt_text: marker }],
    ["credential", { ...baseCase, access_token: marker }],
  ] as const) {
    const manifestPath = writeManifest(directory, [row]);
    const outPath = path.join(directory, `${name}.json`);
    const result = await invoke(verifyArgs(manifestPath, outPath));
    assert.equal(result.exitCode, 1);
    assert.equal(errorCode(result.stderr), "learning_host_receipt_manifest_forbidden_content");
    assert.doesNotMatch(result.stderr, new RegExp(marker));
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(outPath), false);
  }
});

test("verify enforces canonical bounded regular UTF-8 input and disjoint paths", async (t) => {
  const directory = tempDirectory(t, "input-boundary");
  const row = manifestCase(1);
  const outPath = path.join(directory, "result.json");

  const nonCanonicalPath = path.join(directory, "non-canonical.jsonl");
  fs.writeFileSync(
    nonCanonicalPath,
    `${JSON.stringify(manifestHeader(1), null, 2)}\n${stableStringify(row)}\n`,
  );
  let result = await invoke(verifyArgs(nonCanonicalPath, outPath));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_manifest_invalid");
  assert.equal(fs.existsSync(outPath), false);

  const invalidUtf8Path = path.join(directory, "invalid-utf8.jsonl");
  fs.writeFileSync(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]));
  result = await invoke(verifyArgs(invalidUtf8Path, outPath));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_manifest_invalid");
  assert.equal(fs.existsSync(outPath), false);

  const directoryManifest = path.join(directory, "manifest-directory");
  fs.mkdirSync(directoryManifest);
  result = await invoke(verifyArgs(directoryManifest, outPath));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_manifest_invalid");
  assert.equal(fs.existsSync(outPath), false);

  const oversizedPath = path.join(directory, "oversized.jsonl");
  fs.writeFileSync(oversizedPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  result = await invoke(verifyArgs(oversizedPath, outPath));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_manifest_too_large");
  assert.equal(fs.existsSync(outPath), false);

  const manifestPath = writeManifest(directory, [row]);
  const original = fs.readFileSync(manifestPath, "utf8");
  result = await invoke(verifyArgs(manifestPath, manifestPath));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_cli_path_collision");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);

  const hardLinkOut = path.join(directory, "hard-link-output.json");
  fs.linkSync(manifestPath, hardLinkOut);
  result = await invoke(verifyArgs(manifestPath, hardLinkOut));
  assert.equal(result.exitCode, 1);
  assert.equal(errorCode(result.stderr), "learning_host_receipt_cli_path_collision");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
});
