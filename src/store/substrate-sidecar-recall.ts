const SUBSTRATE_PACKAGE_NAME = "@aionis/substrate";

export type SubstrateSidecarCandidate = {
  id: string;
  score: number;
  reason: string;
  matchedFields?: string[];
};

export type SubstrateSidecarCandidateProvider = {
  searchCandidates(params: {
    scope: string;
    queryText: string;
    limit: number;
    candidateLimit: number;
    consumerAgentId: string | null;
    consumerTeamId: string | null;
  }): Promise<SubstrateSidecarCandidate[]>;
  close?(): Promise<void>;
};

type SubstrateStore = {
  searchNodes(input: Record<string, unknown>): Promise<Array<{
    node?: { id?: unknown };
    score?: unknown;
    reasons?: Array<{ code?: unknown; detail?: unknown }>;
  }>>;
  close(): Promise<void>;
};

type SubstrateModule = {
  openSqliteAionisSubstrate(options: { path: string; rebuildCandidateIndexOnOpen?: boolean }): Promise<SubstrateStore>;
};

export function buildSubstrateSidecarSearchInput(params: {
  scope: string;
  queryText: string;
  limit: number;
  candidateLimit: number;
  consumerAgentId: string | null;
  consumerTeamId: string | null;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    scope: params.scope,
    query: params.queryText,
    limit: params.limit,
    candidateLimit: params.candidateLimit,
  };
  if (params.consumerAgentId !== null) input.agentId = params.consumerAgentId;
  if (params.consumerTeamId !== null) input.teamId = params.consumerTeamId;
  return input;
}

function normalizeProviderScore(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (raw <= 1) return raw;
  return raw / (raw + 1);
}

function matchedFieldsFromReasons(reasons: Array<{ code?: unknown; detail?: unknown }> | undefined): string[] {
  const out = new Set<string>();
  for (const reason of reasons ?? []) {
    const code = typeof reason.code === "string" ? reason.code.trim() : "";
    if (code) out.add(code);
  }
  return Array.from(out).slice(0, 12);
}

function firstReason(reasons: Array<{ code?: unknown; detail?: unknown }> | undefined): string {
  const reason = reasons?.find((entry) => typeof entry.code === "string" && entry.code.trim().length > 0);
  return typeof reason?.code === "string" ? reason.code.trim() : "substrate_sidecar_search";
}

async function loadSubstrateModule(): Promise<SubstrateModule> {
  try {
    return await import(SUBSTRATE_PACKAGE_NAME) as SubstrateModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `RECALL_SUBSTRATE_SIDECAR_ENABLED=true requires optional dependency ${SUBSTRATE_PACKAGE_NAME}. `
      + `Install it in the Runtime directory with: npm install --save-dev ${SUBSTRATE_PACKAGE_NAME}@latest. `
      + `Cause: ${message}`,
    );
  }
}

export function createSubstrateSidecarCandidateProvider(options: {
  path: string;
}): SubstrateSidecarCandidateProvider {
  const path = options.path.trim();
  if (!path) throw new Error("RECALL_SUBSTRATE_PATH is required when RECALL_SUBSTRATE_SIDECAR_ENABLED=true");
  let storePromise: Promise<SubstrateStore> | null = null;

  async function store(): Promise<SubstrateStore> {
    storePromise ??= loadSubstrateModule().then((mod) =>
      mod.openSqliteAionisSubstrate({ path, rebuildCandidateIndexOnOpen: false }),
    );
    return await storePromise;
  }

  return {
    async searchCandidates(params) {
      const query = params.queryText.trim();
      if (!query || params.limit <= 0 || params.candidateLimit <= 0) return [];
      const input = buildSubstrateSidecarSearchInput({
        scope: params.scope,
        queryText: query,
        limit: params.limit,
        candidateLimit: params.candidateLimit,
        consumerAgentId: params.consumerAgentId,
        consumerTeamId: params.consumerTeamId,
      });
      const results = await (await store()).searchNodes(input);
      const out: SubstrateSidecarCandidate[] = [];
      const seen = new Set<string>();
      for (const result of results) {
        const id = typeof result.node?.id === "string" ? result.node.id.trim() : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          score: normalizeProviderScore(result.score),
          reason: firstReason(result.reasons),
          matchedFields: matchedFieldsFromReasons(result.reasons),
        });
      }
      return out;
    },
    async close() {
      if (!storePromise) return;
      const opened = await storePromise;
      storePromise = null;
      await opened.close();
    },
  };
}
