export type AionisJsonObject = Record<string, unknown>;

export type AionisGuideMode = "standard" | "full_power";

export type AionisClientOptions = {
  baseUrl: string;
  apiKey?: string;
  tenant_id?: string;
  scope?: string;
  headers?: Record<string, string>;
  default_guide_mode?: AionisGuideMode | null;
  fetchImpl?: typeof fetch;
};

export type AionisRequestOptions = {
  tenant_id?: string;
  scope?: string;
  headers?: Record<string, string>;
};

export type AionisGuideRequestOptions = AionisRequestOptions & {
  guide_mode?: AionisGuideMode | null;
};

export class AionisClientError extends Error {
  readonly status: number;
  readonly path: string;
  readonly response: unknown;

  constructor(status: number, path: string, response: unknown) {
    super(`Aionis request failed: ${status} ${path}`);
    this.name = "AionisClientError";
    this.status = status;
    this.path = path;
    this.response = response;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("AionisClient requires a non-empty baseUrl");
  return trimmed.replace(/\/+$/, "");
}

function scopedBody(
  body: AionisJsonObject,
  defaults: { tenant_id?: string; scope?: string },
  options?: AionisRequestOptions,
): AionisJsonObject {
  return {
    ...(defaults.tenant_id && body.tenant_id === undefined ? { tenant_id: defaults.tenant_id } : {}),
    ...(defaults.scope && body.scope === undefined ? { scope: defaults.scope } : {}),
    ...body,
    ...(options?.tenant_id ? { tenant_id: options.tenant_id } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class AionisClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly tenantId: string | null;
  private readonly scope: string | null;
  private readonly headers: Record<string, string>;
  private readonly defaultGuideMode: AionisGuideMode | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AionisClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || null;
    this.tenantId = options.tenant_id?.trim() || null;
    this.scope = options.scope?.trim() || null;
    this.headers = { ...(options.headers ?? {}) };
    this.defaultGuideMode = options.default_guide_mode === undefined ? "full_power" : options.default_guide_mode;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async observe<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/observe", body, options);
  }

  async guide<T = unknown>(body: AionisJsonObject, options?: AionisGuideRequestOptions): Promise<T> {
    return this.post<T>("/v1/guide", this.guideBody(body, options), options);
  }

  async forget<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/forget", body, options);
  }

  async measure<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/measure", body, options);
  }

  async health<T = unknown>(): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {
      method: "GET",
      headers: this.requestHeaders(),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) throw new AionisClientError(response.status, "/health", payload);
    return payload as T;
  }

  private async post<T>(path: string, body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.requestHeaders(options),
      body: JSON.stringify(scopedBody(body, {
        tenant_id: this.tenantId ?? undefined,
        scope: this.scope ?? undefined,
      }, options)),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) throw new AionisClientError(response.status, path, payload);
    return payload as T;
  }

  private guideBody(body: AionisJsonObject, options?: AionisGuideRequestOptions): AionisJsonObject {
    if (body.mode !== undefined || body.context_mode !== undefined) return body;
    const guideMode = options?.guide_mode === undefined ? this.defaultGuideMode : options.guide_mode;
    if (!guideMode) return body;
    return {
      mode: guideMode,
      ...body,
    };
  }

  private requestHeaders(options?: AionisRequestOptions): Record<string, string> {
    return {
      "content-type": "application/json",
      ...this.headers,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(options?.headers ?? {}),
    };
  }
}

export function createAionisClient(options: AionisClientOptions): AionisClient {
  return new AionisClient(options);
}
