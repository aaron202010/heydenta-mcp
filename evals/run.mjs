#!/usr/bin/env node
// Tool-choice eval: does a model, given only this server's tool schemas, pick the right tool
// with the right arguments for 20 receptionist requests? Nothing is executed: the server is
// spawned only to read its tools/list, and the model's tool call is compared to the golden set.
//
//   OPENROUTER_API_KEY=... node evals/run.mjs [--model openai/gpt-5.4-mini] [--baseline]
//
// Prints one line per case and the pass rate. With a stored evals/baseline.json, a lower
// pass rate exits 1 (regression). --baseline writes the current rate as the new baseline.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "openai/gpt-5.4-mini";
const writeBaseline = args.includes("--baseline");
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error("OPENROUTER_API_KEY is not set"); process.exit(2); }

const golden = JSON.parse(readFileSync(`${here}golden.json`, "utf8"));

// 1. Read the tool schemas from the real server (no HeyDenta call is made).
const client = new Client({ name: "eval", version: "0.0.1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [`${here}../dist/index.js`],
  env: { ...process.env, HEYDENTA_API_KEY: "hd_aria_eval_only", HEYDENTA_CLINIC_ID: "1", HEYDENTA_CLINIC_SLUG: "eval", HEYDENTA_BASE_URL: "http://127.0.0.1:9" },
  stderr: "pipe",
}));
const { tools } = await client.listTools();
await client.close();
const oaTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

const system = `You are the front desk assistant of a dental clinic in the Philippines. Today is ${golden.weekday} ${golden.today}, timezone Asia/Manila. ` +
  `Use the tools to answer. Call at most one tool. If a booking request lacks the patient's name, mobile number, date or time, do not call create_booking: ` +
  `ask for the missing detail, or if only the time is missing and a date is given, look up the free slots for that date. Greetings and price questions need no tool.`;

async function ask(request) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://heydenta.com", "X-Title": "heydenta-mcp eval" },
    body: JSON.stringify({ model, temperature: 0, tools: oaTools, tool_choice: "auto", messages: [{ role: "system", content: system }, { role: "user", content: request }] }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const call = msg.tool_calls?.[0];
  if (!call) return { tool: null, args: {}, text: (msg.content || "").slice(0, 80) };
  let parsed = {};
  try { parsed = JSON.parse(call.function.arguments || "{}"); } catch { parsed = { _unparseable: call.function.arguments }; }
  return { tool: call.function.name, args: parsed, text: "" };
}

function judge(expect, got) {
  if (expect.tool !== got.tool) return `tool ${got.tool ?? "none"} (wanted ${expect.tool ?? "none"})`;
  for (const [k, v] of Object.entries(expect.args || {})) {
    if (got.args[k] !== v) return `${k}=${JSON.stringify(got.args[k])} (wanted ${JSON.stringify(v)})`;
  }
  return null;
}

// 2. Run the cases, four at a time.
const results = [];
const queue = [...golden.cases];
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    try {
      const got = await ask(c.request);
      results.push({ id: c.id, pass: judge(c.expect, got) === null, why: judge(c.expect, got), got });
    } catch (err) {
      results.push({ id: c.id, pass: false, why: `error: ${err.message}`, got: null });
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
results.sort((a, b) => golden.cases.findIndex((c) => c.id === a.id) - golden.cases.findIndex((c) => c.id === b.id));

for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(20)} ${r.why ?? ""}`);
const passed = results.filter((r) => r.pass).length;
const rate = passed / results.length;
console.log(`\n${passed}/${results.length} pass (${Math.round(rate * 100)}%) on ${model}`);
writeFileSync(`${here}last-run.json`, JSON.stringify({ model, at: new Date().toISOString(), passed, total: results.length, results }, null, 1));

const baselinePath = `${here}baseline.json`;
if (writeBaseline) {
  writeFileSync(baselinePath, JSON.stringify({ model, passed, total: results.length, at: new Date().toISOString() }, null, 1));
  console.log(`baseline written: ${passed}/${results.length}`);
} else if (existsSync(baselinePath)) {
  const b = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (passed < b.passed) { console.log(`REGRESSION: ${passed} < baseline ${b.passed} (${b.model}, ${b.at})`); process.exit(1); }
  console.log(`no regression against baseline ${b.passed}/${b.total}`);
}
