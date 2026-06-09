import { AionisClientError } from "../../src/sdk.ts";

const SECRET_FIELD_RE = /(?:api[_-]?key|authorization|bearer|cookie|password|secret|token)/i;
const SECRET_TEXT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /sk-api-[A-Za-z0-9._~+/=-]+/g,
  /sk-[A-Za-z0-9._~+/=-]+/g,
];

function redactText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce((out, pattern) => out.replace(pattern, "[REDACTED]"), value);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MaxDepth]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_FIELD_RE.test(key) ? "[REDACTED]" : sanitize(entry, depth + 1);
  }
  return out;
}

function clientErrorLike(value: unknown): value is {
  name?: string;
  message?: string;
  status: number;
  path: string;
  response: unknown;
} {
  return value instanceof AionisClientError
    || (
      !!value
      && typeof value === "object"
      && typeof (value as { status?: unknown }).status === "number"
      && typeof (value as { path?: unknown }).path === "string"
      && "response" in value
    );
}

export function formatE2eError(err: unknown): string {
  if (clientErrorLike(err)) {
    return JSON.stringify({
      name: err.name ?? "AionisClientError",
      message: err.message ?? "Aionis request failed",
      status: err.status,
      path: err.path,
      response: sanitize(err.response),
    }, null, 2);
  }
  if (err instanceof Error) {
    return JSON.stringify({
      name: err.name,
      message: redactText(err.message),
      stack: err.stack ? redactText(err.stack) : undefined,
    }, null, 2);
  }
  return JSON.stringify(sanitize(err), null, 2);
}
