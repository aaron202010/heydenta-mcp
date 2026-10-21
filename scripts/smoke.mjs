// Live smoke for a real clinic: PATIENT_NAME and PATIENT_PHONE from env plus the usual HEYDENTA_* vars. Books one real slot.
// Live smoke against the demo clinic through the built server. PATIENT_PHONE and PATIENT_NAME come from env.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
const c = new Client({ name: "smoke", version: "0.0.1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], env: process.env, stderr: "pipe" }));
const txt = (r) => r.content.map((x) => x.text).join(" ");
const tomorrow = new Date(Date.now() + 86400e3).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const hours = await c.callTool({ name: "get_clinic_hours", arguments: { date: tomorrow } });
console.log("hours:", txt(hours));
const slots = await c.callTool({ name: "list_open_slots", arguments: { date: tomorrow } });
console.log("slots:", txt(slots).slice(0, 200));
const next = await c.callTool({ name: "find_next_open_slot", arguments: { from_date: tomorrow, days: 5 } });
const pick = next.structuredContent;
console.log("next:", pick.date, (pick.free || []).slice(0, 3));
const key = `smoke-${randomUUID()}`;
const args = { idempotency_key: key, patient_name: process.env.PATIENT_NAME, patient_phone: process.env.PATIENT_PHONE, date: pick.date, time: pick.free[pick.free.length - 1], procedure: "Consultation", reason: "mcp server smoke test 2026-10-21" };
const b1 = await c.callTool({ name: "create_booking", arguments: args });
console.log("book:", b1.isError ? "ERROR" : "ok", txt(b1), JSON.stringify(b1.structuredContent));
const b2 = await c.callTool({ name: "create_booking", arguments: args });
console.log("again:", txt(b2), JSON.stringify(b2.structuredContent));
console.log("EVENT_ID=" + (b1.structuredContent?.event_id ?? ""));
await c.close();
