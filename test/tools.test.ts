import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, labelToHHMM } from "../src/tools.js";

test("slot labels become HH:MM 24 hour", () => {
  assert.equal(labelToHHMM("9:00 AM"), "09:00");
  assert.equal(labelToHHMM("12:30 PM"), "12:30");
  assert.equal(labelToHHMM("12:00 AM"), "00:00");
  assert.equal(labelToHHMM("1:30 PM"), "13:30");
  assert.equal(labelToHHMM("14:00"), "14:00");
  assert.equal(labelToHHMM("odd label"), "odd label");
});

test("addDays crosses a month end", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-10-22", 0), "2026-10-22");
});
