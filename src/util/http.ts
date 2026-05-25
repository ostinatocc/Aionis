export class HttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export type ErrorResponseEnvelope = {
  status: number;
  error: string;
  message: string;
  details?: unknown;
  issues?: Array<{ path: string; message: string }>;
};

export function createErrorResponse(args: {
  status: number;
  error: string;
  message: string;
  details?: unknown;
  issues?: Array<{ path: string; message: string }>;
}): ErrorResponseEnvelope {
  return {
    status: args.status,
    error: args.error,
    message: args.message,
    details: args.details ?? undefined,
    issues: args.issues ?? undefined,
  };
}

export function buildLiteUnsupportedDetails(args: {
  route: string;
  surface: string;
  routeGroup?: string;
  reason?: string;
  unsupported?: string[];
}): Record<string, unknown> {
  return {
    contract: "lite_error_v1",
    edition: "lite",
    supported_in_lite: false,
    route: args.route,
    surface: args.surface,
    route_group: args.routeGroup ?? null,
    reason: args.reason ?? null,
    unsupported: args.unsupported ?? [],
  };
}

export function badRequest(code: string, message: string, details?: unknown): never {
  throw new HttpError(400, code, message, details);
}
