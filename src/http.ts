// HTTP entry for cloud runtimes (AWS Lambda behind the Lambda Web Adapter, or any container host).
// Streamable HTTP transport, stateless: one McpServer and one transport per request, JSON
// responses (no SSE), so a buffered Lambda invoke can serve it. Config is the same env as
// the stdio entry plus:
//   MCP_AUTH_TOKEN  required bearer the MCP client must send (the function URL itself is public)
//   PORT            listen port, default 8080 (what the Lambda Web Adapter expects)
// GET /healthz answers 200 without auth so the platform can probe it.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { HeyDentaApi, configFromEnv, type ApiConfig } from "./api.js";
import { FileStore, type BookingStore } from "./idempotency.js";
import { registerTools } from "./tools.js";

export type HttpOptions = { cfg: ApiConfig; authToken: string; store: BookingStore };

function bearerOk(req: IncomingMessage, token: string): boolean {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMcpHttpServer(opts: HttpOptions) {
  const api = new HeyDentaApi(opts.cfg);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, clinic: opts.cfg.clinicSlug }));
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    if (!bearerOk(req, opts.authToken)) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const server = new McpServer({ name: "heydenta", version: "0.1.0" });
    registerTools(server, api, opts.store);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      process.stderr.write(`mcp request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "internal" })); }
    } finally {
      res.on("close", () => { void transport.close(); void server.close(); });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const authToken = (process.env.MCP_AUTH_TOKEN || "").trim();
  if (!authToken) { process.stderr.write("MCP_AUTH_TOKEN is not set\n"); process.exit(1); }
  const cfg = configFromEnv();
  const port = Number(process.env.PORT || 8080);
  createMcpHttpServer({ cfg, authToken, store: new FileStore() }).listen(port, () => {
    process.stderr.write(`heydenta-mcp http ready on :${port}, clinic ${cfg.clinicSlug} (${cfg.clinicId}) at ${cfg.baseUrl}\n`);
  });
}
