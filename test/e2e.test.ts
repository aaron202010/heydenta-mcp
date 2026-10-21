// End to end over stdio: a real client spawns the real server against a local fake HeyDenta.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

let http: Server;
let port = 0;
let bookings = 0;
let lastAuth = "";
// Labels as the real endpoint sends them ("10:00 AM"); the tools must hand the model HH:MM.
const availability = { taken: [], closed: false, range: [540, 1020], hours: "9:00 AM to 5:00 PM", free: ["10:00 AM", "10:30 AM", "1:00 PM"], reason: "open", holidayReason: null, dentists: [{ id: "d1", name: "Dr. Cruz" }], dentist: null, byDentist: [{ id: "d1", name: "Dr. Cruz", free: ["10:00 AM", "10:30 AM", "1:00 PM"] }] };

before(async () => {
  http = createServer((req, res) => {
    lastAuth = req.headers.authorization || "";
    if (req.method === "GET" && req.url?.startsWith("/api/intake/availability")) {
      const u = new URL(req.url, "http://x");
      const closed = u.searchParams.get("date") === "2026-10-25";
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(closed ? { ...availability, closed: true, free: [], reason: "closed" } : availability));
    }
    if (req.method === "POST" && req.url === "/api/aria-tool/create-booking") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bookings++;
        const body = JSON.parse(raw);
        res.setHeader("Content-Type", "application/json");
        if (body.preferred_time === "11:00") { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: "SLOT_TAKEN", suggested_slots: ["Oct 24, 2026, 10:00 AM"] })); }
        res.end(JSON.stringify({ ok: true, event_id: 100 + bookings, scheduled_at_human: "Oct 24, 2026, 10:00 AM", status: "scheduled" }));
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  port = (http.address() as { port: number }).port;
});
after(() => http.close());

async function client() {
  const c = new Client({ name: "test", version: "0.0.1" });
  const t = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    env: { ...process.env, HEYDENTA_API_KEY: "hd_aria_e2e", HEYDENTA_CLINIC_ID: "1", HEYDENTA_CLINIC_SLUG: "demo", HEYDENTA_BASE_URL: `http://127.0.0.1:${port}`, HEYDENTA_MCP_STATE: join(mkdtempSync(join(tmpdir(), "hdmcp-")), "bookings.json") },
    stderr: "pipe",
  });
  await c.connect(t);
  return c;
}

test("tools/list shows the four tools with descriptions", async () => {
  const c = await client();
  try {
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["create_booking", "find_next_open_slot", "get_clinic_hours", "list_open_slots"]);
    for (const t of tools) assert.ok((t.description || "").length > 60, `${t.name} needs a real description`);
  } finally { await c.close(); }
});

test("hours, slots, next slot and booking round trip; same idempotency key posts once", async () => {
  const c = await client();
  try {
    const hours = await c.callTool({ name: "get_clinic_hours", arguments: { date: "2026-10-24" } });
    assert.match(String((hours.content as Array<{ text: string }>)[0].text), /Open on 2026-10-24/);
    const slots = await c.callTool({ name: "list_open_slots", arguments: { date: "2026-10-24" } });
    assert.deepEqual((slots.structuredContent as { free: string[] }).free, ["10:00", "10:30", "13:00"]);
    const next = await c.callTool({ name: "find_next_open_slot", arguments: { from_date: "2026-10-25", days: 3 } });
    assert.equal((next.structuredContent as { date: string }).date, "2026-10-26");
    const args = { idempotency_key: "e2e-0001-key", patient_name: "Test Patient", patient_phone: "09170000000", date: "2026-10-24", time: "10:00" };
    const first = await c.callTool({ name: "create_booking", arguments: args });
    assert.equal(first.isError, undefined);
    assert.equal((first.structuredContent as { event_id: number }).event_id, 101);
    const again = await c.callTool({ name: "create_booking", arguments: args });
    assert.equal((again.structuredContent as { event_id: number; idempotent: boolean }).event_id, 101);
    assert.equal((again.structuredContent as { idempotent: boolean }).idempotent, true);
    assert.equal(bookings, 1, "the second call with the same key must not reach the api");
    assert.equal(lastAuth, "Bearer hd_aria_e2e");
    const taken = await c.callTool({ name: "create_booking", arguments: { ...args, idempotency_key: "e2e-0002-key", time: "11:00" } });
    assert.equal(taken.isError, true);
    assert.match(String((taken.content as Array<{ text: string }>)[0].text), /SLOT_TAKEN.*Suggested/);
    const bad = await c.callTool({ name: "create_booking", arguments: { ...args, idempotency_key: "e2e-0003-key", time: "9am" } });
    assert.equal(bad.isError, true, "a bad time must fail validation before any api call");
    assert.equal(bookings, 2);
  } finally { await c.close(); }
});
