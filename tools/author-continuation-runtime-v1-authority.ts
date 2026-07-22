import { readSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalContinuationJson } from
  "../src/continuation/contract.js";
import { assertContinuationRuntimeV1Host } from
  "../src/continuation/host-contract.js";
import {
  AuthorityAuthoringError,
  authorContinuationRuntimeV1AuthorityCommand,
} from "./continuation-runtime-v1-authority-authoring.js";
import {
  AuthorityRootKeyError,
  readAuthorityRootPrivateKeyFromInheritedFd,
} from "./continuation-runtime-v1-authority-key.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

type InputFailureCode =
  | "arguments_forbidden"
  | "request_too_large"
  | "request_encoding_invalid"
  | "request_json_invalid"
  | "request_canonical_value_invalid"
  | "request_must_use_canonical_json";

class AuthorityAuthoringInputError extends Error {
  readonly code: InputFailureCode;

  constructor(code: InputFailureCode) {
    super(`continuation_runtime_v1_authority_authoring_${code}`);
    this.name = "AuthorityAuthoringInputError";
    this.code = code;
  }
}

function inputFail(code: InputFailureCode): never {
  throw new AuthorityAuthoringInputError(code);
}

function readBoundedStdin(): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_REQUEST_BYTES + 1 - total));
      const count = readSync(0, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      total += count;
      if (total > MAX_REQUEST_BYTES) {
        chunk.fill(0);
        inputFail("request_too_large");
      }
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function parseCanonicalAuthorityAuthoringInput(input: Buffer): unknown {
  if (input.byteLength < 2 || input.includes(0)) {
    inputFail("request_encoding_invalid");
  }
  const text = input.toString("utf8");
  if (Buffer.from(text, "utf8").compare(input) !== 0) {
    inputFail("request_encoding_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    inputFail("request_json_invalid");
  }
  let canonical: string;
  try {
    canonical = canonicalContinuationJson(value);
  } catch {
    inputFail("request_canonical_value_invalid");
  }
  if (text !== canonical && text !== `${canonical}\n`) {
    inputFail("request_must_use_canonical_json");
  }
  return value;
}

function safeFailureCode(error: unknown): string {
  if (error instanceof AuthorityAuthoringInputError
    || error instanceof AuthorityAuthoringError
    || error instanceof AuthorityRootKeyError) return error.code;
  return "authoring_failed";
}

/** Root key is read only after the bounded canonical request has been decoded. */
export function runContinuationRuntimeV1AuthorityAuthoring(): void {
  assertContinuationRuntimeV1Host();
  if (process.argv.length !== 2) inputFail("arguments_forbidden");
  const input = readBoundedStdin();
  try {
    const request = parseCanonicalAuthorityAuthoringInput(input);
    const privateKey = readAuthorityRootPrivateKeyFromInheritedFd();
    const command = authorContinuationRuntimeV1AuthorityCommand(request, privateKey);
    process.stdout.write(`${canonicalContinuationJson(command)}\n`);
  } finally {
    input.fill(0);
  }
}

const invokedAsEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsEntrypoint) {
  try {
    runContinuationRuntimeV1AuthorityAuthoring();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `continuation_runtime_v1_authority_authoring_failed:${safeFailureCode(error)}\n`,
    );
  }
}
