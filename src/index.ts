#!/usr/bin/env node
// HeyDenta MCP server, stdio transport. Config comes from the environment:
//   HEYDENTA_API_KEY     the clinic's hd_aria_ key (required)
//   HEYDENTA_CLINIC_ID   numeric clinic id (required)
//   HEYDENTA_CLINIC_SLUG the clinic's public slug used by the intake form (required)
//   HEYDENTA_BASE_URL    default https://app.heydenta.com
//   HEYDENTA_MCP_STATE   path of the local idempotency file, default ~/.heydenta-mcp/bookings.json
// stdout is the protocol channel; anything human goes to stderr.

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { HeyDentaApi, configFromEnv } from "./api.js";
import { FileStore } from "./idempotency.js";
import { registerTools } from "./tools.js";

async function main() {
  const cfg = configFromEnv();
  const api = new HeyDentaApi(cfg);
  const server = new McpServer({ name: "heydenta", version: "0.1.0" });
  registerTools(server, api, new FileStore());
  await server.connect(new StdioServerTransport());
  process.stderr.write(`heydenta-mcp ready: clinic ${cfg.clinicSlug} (${cfg.clinicId}) at ${cfg.baseUrl}\n`);
}

main().catch((err) => {
  process.stderr.write(`heydenta-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
