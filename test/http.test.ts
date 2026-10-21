// The HTTP entry: bearer gate, health probe, and a real streamable HTTP client round trip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHttpServer } from "../src/http.js";
import { MemoryStore } from "../src/idempotency.js";

let fake: Server; let fakePort = 0;
let mcp: Server; let mcpPort = 0;

before(async () => {
  fake = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ taken: [], closed: false, range: [540, 1020], hours: "9:00 AM - 5:00 PM", free: ["9:00 AM"], reason: "open", holidayReason: null, dentists: [], dentist: null, byDentist: [] }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  fakePort = (fake.address() as { port: number }).port;
  mcp = createMcpHttpServer({ cfg: { baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: "hd_aria_http_test", clinicSlug: "demo", clinicId: 1 }, authToken: "secret-token", store: new MemoryStore() });
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", () => r()));
  mcpPort = (mcp.address() as { port: number }).port;
});
after(() => { mcp.close(); fake.close(); });

test("healthz is open, /mcp needs the bearer", async () => {
  const h = await fetch(`http://127.0.0.1:${mcpPort}/healthz`);
  assert.equal(h.status, 200);
  const no = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(no.status, 401);
  const wrong = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nope" }, body: "{}" });
  assert.equal(wrong.status, 401);
});

test("a streamable http client lists tools and calls one through the bearer", async () => {
  const c = new Client({ name: "http-test", version: "0.0.1" });
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { Authorization: "Bearer secret-token" } } });
  await c.connect(t);
  try {
    const { tools } = await c.listTools();
    assert.equal(tools.length, 4);
    const r = await c.callTool({ name: "list_open_slots", arguments: { date: "2026-10-24" } });
    assert.deepEqual((r.structuredContent as { free: string[] }).free, ["09:00"]);
  } finally { await c.close(); }
});
