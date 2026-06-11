#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAionisMcpConfig } from "./config.js";
import { createAionisMcpServer } from "./server.js";
import { createAionisMcpClient } from "./tools.js";

export { aionisMcpUsage, clientOptionsFromMcpConfig, parseAionisMcpConfig } from "./config.js";
export { createAionisMcpServer } from "./server.js";
export { AIONIS_MCP_TOOL_NAMES, createAionisMcpClient, handleAionisMcpTool } from "./tools.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const config = parseAionisMcpConfig(argv);
  const client = createAionisMcpClient(config);
  const server = createAionisMcpServer(client);
  await server.connect(new StdioServerTransport());
}

export function isCliEntrypoint(argvEntry: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argvEntry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(argvEntry) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argvEntry) === path.resolve(modulePath);
  }
}

if (isCliEntrypoint(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`Aionis MCP failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
