export type AionisJsonObject = Record<string, unknown>;

export type AionisGuideMode = "standard" | "full_power";
export type AionisFeedbackOutcome = "positive" | "negative" | "neutral";
export type AionisFeedbackUsedSurface = "use_now" | "inspect_before_use" | "do_not_use" | "explicit_host_assertion";
export type AionisFeedbackStatus = "passed" | "failed" | "not_run" | "unknown";
export type AionisRehydrateMode = "summary_only" | "partial" | "full" | "differential";
export type AionisForgetTarget = "pattern" | "archive" | "payload" | "memory";
export type AionisMemoryLane = "private" | "shared";
export type AionisRememberKind = "fact" | "preference" | "project_context" | "procedure" | "event" | "evidence";
export type AionisRememberLifecycleState = "active" | "candidate" | "contested" | "suppressed" | "demoted" | "archived";
export type AionisRememberTier = "hot" | "warm" | "cold" | "archive";

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

export type AionisRememberRequest = AionisJsonObject & {
  text: string;
  kind?: AionisRememberKind;
  title?: string;
  client_id?: string;
  memory_lane?: AionisMemoryLane;
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  lifecycle_state?: AionisRememberLifecycleState;
  tier?: AionisRememberTier;
  confidence?: number;
  salience?: number;
  importance?: number;
  auto_embed?: boolean;
  raw_ref?: string;
  evidence_ref?: string;
  target_files?: string[];
  slots?: AionisJsonObject;
};

export type AionisFeedbackRequest = AionisJsonObject & {
  reason: string;
  run_id: string;
  outcome: AionisFeedbackOutcome;
  used_surface: AionisFeedbackUsedSurface;
  actor?: string;
  guide_trace_id?: string;
  used_memory_ids?: string[];
  memory_ids?: string[];
  node_ids?: string[];
  verifier_status?: AionisFeedbackStatus;
  tool_status?: AionisFeedbackStatus;
  runtime_signal_refs?: string[];
  target?: "memory";
};

export type AionisRehydrateRequest = AionisJsonObject & {
  reason: string;
  memory_ids?: string[];
  node_ids?: string[];
  client_ids?: string[];
  anchor_id?: string;
  anchor_uri?: string;
  target_tier?: "warm" | "hot";
  mode?: AionisRehydrateMode;
  include_linked_decisions?: boolean;
  target?: Extract<AionisForgetTarget, "archive" | "payload" | "memory">;
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

function stripUndefined(value: AionisJsonObject): AionisJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rememberNodeType(kind: AionisRememberKind): string {
  switch (kind) {
    case "preference": return "self_model";
    case "project_context": return "topic";
    case "procedure": return "procedure";
    case "event": return "event";
    case "evidence": return "evidence";
    case "fact": return "concept";
  }
}

function rememberTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}

function rememberBody(body: AionisRememberRequest): AionisJsonObject {
  const text = body.text.trim();
  if (!text) throw new Error("AionisClient.remember requires non-empty text");
  const kind = body.kind ?? "fact";
  const lifecycleState = body.lifecycle_state ?? "active";
  const slots = stripUndefined({
    ...(body.slots ?? {}),
    memory_kind: "general_memory",
    lifecycle_state: lifecycleState,
    compression_layer: body.slots?.compression_layer ?? "L2",
  });
  return stripUndefined({
    auto_embed: body.auto_embed ?? true,
    input_text: text,
    memory_kind: "general_memory",
    memory_lane: body.memory_lane,
    producer_agent_id: body.producer_agent_id,
    owner_agent_id: body.owner_agent_id,
    owner_team_id: body.owner_team_id,
    memory: stripUndefined({
      client_id: body.client_id,
      type: rememberNodeType(kind),
      memory_kind: "general_memory",
      title: body.title ?? rememberTitle(text),
      text_summary: text,
      confidence: body.confidence,
      salience: body.salience,
      importance: body.importance,
      tier: body.tier,
      raw_ref: body.raw_ref,
      evidence_ref: body.evidence_ref,
      target_files: body.target_files,
      slots,
    }),
  });
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

  async remember<T = unknown>(body: AionisRememberRequest, options?: AionisRequestOptions): Promise<T> {
    return this.observe<T>(rememberBody(body), options);
  }

  async guide<T = unknown>(body: AionisJsonObject, options?: AionisGuideRequestOptions): Promise<T> {
    return this.post<T>("/v1/guide", this.guideBody(body, options), options);
  }

  async forget<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/forget", body, options);
  }

  async feedback<T = unknown>(body: AionisFeedbackRequest, options?: AionisRequestOptions): Promise<T> {
    return this.forget<T>({
      ...body,
      operation: "activate",
      target: body.target ?? "memory",
    }, options);
  }

  async rehydrate<T = unknown>(body: AionisRehydrateRequest, options?: AionisRequestOptions): Promise<T> {
    return this.forget<T>({
      ...body,
      operation: "rehydrate",
    }, options);
  }

  async measure<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/measure", body, options);
  }

  async operatorSnapshot<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T> {
    return this.post<T>("/v1/operator/snapshot", body, options);
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

export function agentContextFromGuide<T = AionisJsonObject>(guide: unknown): T {
  const context = asRecord(guide)?.agent_context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("Aionis guide response is missing agent_context");
  }
  return context as T;
}

export function agentPromptFromGuide(guide: unknown): string {
  const promptText = asRecord(agentContextFromGuide(guide))?.prompt_text;
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("Aionis guide response is missing agent_context.prompt_text");
  }
  return promptText;
}
