import type { AionisClientOptions, AionisGuideMode } from "@aionis/sdk";

export type AionisMcpConfig = {
  baseUrl: string;
  apiKey?: string;
  tenant_id?: string;
  scope?: string;
  default_guide_mode?: AionisGuideMode | null;
};

export const DEFAULT_AIONIS_BASE_URL = "http://127.0.0.1:3001";

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseGuideMode(value: string): AionisGuideMode | null {
  if (value === "full_power" || value === "standard") return value;
  if (value === "none" || value === "off") return null;
  throw new Error(`Unsupported guide mode "${value}". Use full_power, standard, or none.`);
}

export function aionisMcpUsage(): string {
  return `Usage:
  npx @aionis/mcp [options]

Options:
  --base-url <url>          Aionis Runtime URL. Defaults to AIONIS_BASE_URL or ${DEFAULT_AIONIS_BASE_URL}
  --api-key <key>           Runtime bearer token. Prefer AIONIS_API_KEY for shell history safety.
  --tenant <id>             Default tenant id. Defaults to AIONIS_TENANT_ID.
  --scope <scope>           Default memory scope. Defaults to AIONIS_SCOPE.
  --mode <name>             full_power, standard, or none. Defaults to AIONIS_GUIDE_MODE or full_power.
  -h, --help                Show help.

Examples:
  npx @aionis/mcp --base-url http://127.0.0.1:3001 --tenant local --scope my-project
  AIONIS_BASE_URL=http://127.0.0.1:3001 AIONIS_SCOPE=my-project npx @aionis/mcp
`;
}

export function parseAionisMcpConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): AionisMcpConfig {
  let baseUrl = env.AIONIS_BASE_URL?.trim() || env.AIONIS_PRODUCT_E2E_BASE_URL?.trim() || DEFAULT_AIONIS_BASE_URL;
  let apiKey = env.AIONIS_API_KEY?.trim() || undefined;
  let tenantId = env.AIONIS_TENANT_ID?.trim() || env.AIONIS_TENANT?.trim() || undefined;
  let scope = env.AIONIS_SCOPE?.trim() || undefined;
  let defaultGuideMode = parseGuideMode(env.AIONIS_GUIDE_MODE?.trim() || "full_power");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(aionisMcpUsage());
      process.exit(0);
    }
    if (arg === "--base-url") {
      baseUrl = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--api-key") {
      apiKey = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--tenant") {
      tenantId = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--scope") {
      scope = readFlagValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      defaultGuideMode = parseGuideMode(readFlagValue(argv, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown option "${arg}"`);
  }

  return {
    baseUrl,
    apiKey,
    tenant_id: tenantId,
    scope,
    default_guide_mode: defaultGuideMode,
  };
}

export function clientOptionsFromMcpConfig(config: AionisMcpConfig): AionisClientOptions {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenant_id: config.tenant_id,
    scope: config.scope,
    default_guide_mode: config.default_guide_mode,
  };
}
