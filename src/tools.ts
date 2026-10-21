// The four tools. Each description says when to use it and what comes back, because the
// model picks a tool from these words alone. Arguments are typed and described for the
// same reason. Read-only tools are marked read-only; create_booking is marked idempotent.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ApiError, type Availability, type HeyDentaApi } from "./api.js";
import type { BookingStore } from "./idempotency.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").describe("Calendar date as YYYY-MM-DD, clinic local time (Asia/Manila).");
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24 hour").describe("Start time as HH:MM in 24 hour clinic local time, e.g. 14:30.");
const DENTIST = z.string().max(80).optional().describe("Dentist id or name from get_clinic_hours. Leave out for any available dentist.");

export function todayManila(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// HeyDenta's availability endpoint labels slots the way the intake form shows them ("9:00 AM",
// "1:30 PM"). Tools hand the model HH:MM 24 hour, the same shape create_booking accepts.
export function labelToHHMM(label: string): string {
  const m = label.trim().toUpperCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return label.trim();
  let h = Number(m[1]);
  const min = m[2] ?? "00";
  if (m[3] === "PM" && h !== 12) h += 12;
  if (m[3] === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

function normalize(a: Availability): Availability {
  return { ...a, free: a.free.map(labelToHHMM), byDentist: a.byDentist.map((d) => ({ ...d, free: d.free.map(labelToHHMM) })) };
}

function text(t: string, structured?: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
}

function apiFailure(err: unknown) {
  if (err instanceof ApiError) return text(`HeyDenta API unavailable after ${err.attempts} attempts (${err.message}). Tell the user to try again in a minute; do not retry immediately.`, undefined, true);
  return text(`Unexpected error: ${err instanceof Error ? err.message : String(err)}. Tell the user to retry in a minute; if it keeps failing, hand off to clinic staff.`, undefined, true);
}

function hoursLine(a: Availability, date: string): string {
  if (a.closed) return `Closed on ${date}${a.holidayReason ? ` (${a.holidayReason})` : a.reason && a.reason !== "open" ? ` (${a.reason})` : ""}.`;
  return `Open on ${date}: ${a.hours || "hours not published"}.`;
}

export function registerTools(server: McpServer, api: HeyDentaApi, store: BookingStore) {
  server.registerTool(
    "get_clinic_hours",
    {
      title: "Clinic hours and dentists",
      description:
        "Use only for opening hours, open or closed on a date (holidays included), or which dentists work that day. " +
        "Returns open or closed, the opening hours and the bookable dentists with their ids. " +
        "Never use it to find free appointment times: any question about what times or slots are available is list_open_slots.",
      inputSchema: z.object({ date: DATE.optional().describe("Date to check as YYYY-MM-DD, clinic local date (Asia/Manila). Defaults to today in Asia/Manila.") }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ date }) => {
      const day = date ?? todayManila();
      try {
        const a = await api.availability(day);
        const dentists = a.dentists.length ? a.dentists.map((d) => `${d.name} (id ${d.id})`).join(", ") : "no named dentists, clinic-wide booking";
        return text(`${hoursLine(a, day)} Dentists: ${dentists}.`, { date: day, closed: a.closed, hours: a.hours, reason: a.reason, dentists: a.dentists });
      } catch (err) { return apiFailure(err); }
    },
  );

  server.registerTool(
    "list_open_slots",
    {
      title: "Free appointment times on a date",
      description:
        "Use when the user asks what times or slots are free or available on a specific date, or wants to book on a date without naming a time. " +
        "Returns the free start times (HH:MM, 24 hour) for that date, overall and per dentist; past times today are already removed. " +
        "An empty list with closed=false means fully booked. Call create_booking with one of these times.",
      inputSchema: z.object({ date: DATE, dentist: DENTIST }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ date, dentist }) => {
      try {
        const a = normalize(await api.availability(date, dentist));
        if (a.closed) return text(hoursLine(a, date), { date, closed: true, free: [] });
        const per = a.byDentist.filter((d) => d.free.length).map((d) => `${d.name}: ${d.free.join(" ")}`).join("; ");
        const line = a.free.length ? `Free on ${date}: ${a.free.join(", ")}.${per ? ` By dentist: ${per}.` : ""}` : `No free slots on ${date} (fully booked). Try another date or find_next_open_slot.`;
        return text(line, { date, closed: false, free: a.free, byDentist: a.byDentist });
      } catch (err) { return apiFailure(err); }
    },
  );

  server.registerTool(
    "find_next_open_slot",
    {
      title: "Next date with a free slot",
      description:
        "Use when the user says 'soonest', 'next available' or gives no date. " +
        "Scans day by day from from_date (default today) for up to `days` days and returns the first date that has free slots, with those slots. " +
        "Returns none_found when every scanned day is closed or full; then ask the user whether to scan more days or start from a later date.",
      inputSchema: z.object({
        from_date: DATE.optional().describe("First date to scan as YYYY-MM-DD, clinic local date (Asia/Manila). Defaults to today in Asia/Manila."),
        days: z.number().int().min(1).max(14).default(7).describe("Integer number of calendar days to scan from from_date, 1 to 14 inclusive."),
        dentist: DENTIST,
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ from_date, days, dentist }) => {
      const start = from_date ?? todayManila();
      try {
        for (let i = 0; i < days; i++) {
          const date = addDays(start, i);
          const a = normalize(await api.availability(date, dentist));
          if (!a.closed && a.free.length) return text(`First free date is ${date}: ${a.free.join(", ")}.`, { date, free: a.free, byDentist: a.byDentist, scanned: i + 1 });
        }
        return text(`No free slot in the ${days} days from ${start}.`, { none_found: true, from: start, days });
      } catch (err) { return apiFailure(err); }
    },
  );

  server.registerTool(
    "create_booking",
    {
      title: "Book an appointment",
      description:
        "Use as soon as the user has given all four: patient name, mobile number, date and a start time. Book directly, no need to call list_open_slots first: the server checks the slot itself. " +
        "If any of the four is missing, do not call this; ask for it (or call list_open_slots when only the time is missing). " +
        "Creates the appointment in the clinic's calendar and returns the event id and the human readable time. " +
        "Send the same idempotency_key when retrying the same request; a repeated key returns the original booking instead of a second one. " +
        "If the slot was taken in the meantime the result is an error with suggested nearby times; offer those, do not guess others.",
      inputSchema: z.object({
        idempotency_key: z.string().min(8).max(80).describe("Unique id for this booking attempt, e.g. a UUID. Reuse it on a retry of the same booking, never for a different one."),
        patient_name: z.string().min(2).max(120).describe("Patient's full name as they gave it."),
        patient_phone: z.string().min(7).max(20).describe("Patient's mobile number as they gave it (PH formats like 09xxxxxxxxx or +639xxxxxxxxx are fine)."),
        date: DATE,
        time: TIME,
        procedure: z.string().max(80).optional().describe("Procedure if known, e.g. Cleaning, Consultation, Extraction."),
        reason: z.string().max(300).optional().describe("The patient's complaint or reason, in their words."),
        dentist: DENTIST,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const prior = store.get(input.idempotency_key);
      if (prior) return text(`Already booked (same idempotency key): event ${prior.event_id}, ${prior.scheduled_at_human}.`, { event_id: prior.event_id, scheduled_at_human: prior.scheduled_at_human, idempotent: true });
      try {
        const r = await api.createBooking(input);
        const b = r.body;
        if (r.status === 200 && b && b.ok) {
          store.set(input.idempotency_key, { event_id: b.event_id, scheduled_at_human: b.scheduled_at_human, stored_at: new Date().toISOString() });
          const pending = b.status === "scheduled" ? " The clinic will confirm it; the patient gets a text." : "";
          return text(`Booked: event ${b.event_id}, ${b.scheduled_at_human}.${pending}`, { event_id: b.event_id, scheduled_at_human: b.scheduled_at_human, idempotent: !!b.idempotent });
        }
        if (b && !b.ok) {
          const suggested = b.suggested_slots?.length ? ` Suggested: ${b.suggested_slots.join("; ")}.` : "";
          return text(`Not booked (${b.error}).${b.message ? ` ${b.message}` : ""}${suggested}`, { error: b.error, suggested_slots: b.suggested_slots ?? [] }, true);
        }
        return text(`Not booked: HeyDenta answered ${r.status} without a result.`, { status: r.status }, true);
      } catch (err) { return apiFailure(err); }
    },
  );
}
