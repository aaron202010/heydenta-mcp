import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, HeyDentaApi } from "../src/api.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<number | Error>, calls: Call[]) {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify({ ok: r === 200, status: r }), { status: r, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function api(responses: Array<number | Error>, calls: Call[]) {
  return new HeyDentaApi({ baseUrl: "https://example.test", apiKey: "hd_aria_testkey", clinicSlug: "demo", clinicId: 1, fetchImpl: fakeFetch(responses, calls), sleep: async () => {}, maxAttempts: 3 });
}

test("retries on 5xx with backoff and succeeds", async () => {
  const calls: Call[] = [];
  const r = await api([500, 503, 200], calls).createBooking({ idempotency_key: "k-12345678", patient_name: "Test", patient_phone: "09170000000", date: "2026-10-24", time: "10:00" });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3);
});

test("never retries a 4xx", async () => {
  const calls: Call[] = [];
  const r = await api([409, 200], calls).createBooking({ idempotency_key: "k-12345678", patient_name: "Test", patient_phone: "09170000000", date: "2026-10-24", time: "10:00" });
  assert.equal(r.status, 409);
  assert.equal(calls.length, 1);
});

test("retries a network error, then gives up with ApiError after maxAttempts", async () => {
  const calls: Call[] = [];
  await assert.rejects(() => api([new Error("ECONNRESET")], calls).availability("2026-10-24"), (e: unknown) => e instanceof ApiError && e.attempts === 3);
  assert.equal(calls.length, 3);
});

test("bearer goes in the header, never in the url; clinic_id and customer_id come from config and the key", async () => {
  const calls: Call[] = [];
  await api([200], calls).createBooking({ idempotency_key: "k-12345678", patient_name: "Test", patient_phone: "09170000000", date: "2026-10-24", time: "10:00" });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer hd_aria_testkey");
  assert.ok(!calls[0].url.includes("hd_aria"));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.clinic_id, 1);
  assert.equal(body.customer_id, "k-12345678");
  assert.equal(body.preferred_date, "2026-10-24");
});
