import assert from "node:assert/strict";
import test from "node:test";
import { commercialDay, dashboardWindows, startOfCommercialDay, usersPerDay } from "../admin-dashboard";

test("dashboard groups real user creation dates by Brazilian commercial day in a 30-day window", () => {
  const now = new Date("2026-09-28T15:00:00.000Z"); // 12:00 em Brasília
  const series = usersPerDay([
    new Date("2026-09-28T01:00:00.000Z"), // 27/09 22:00 BRT
    new Date("2026-09-28T12:00:00.000Z"), // 28/09 09:00 BRT
    new Date("2026-09-27T12:00:00.000Z"),
    new Date("2020-01-01T00:00:00.000Z"), // fora da janela
  ], now);
  assert.equal(series.length, 30);
  assert.deepEqual(series.at(-1), { date: "2026-09-28", count: 1 });
  assert.deepEqual(series.at(-2), { date: "2026-09-27", count: 2 });
  assert.equal(series.reduce((sum, day) => sum + day.count, 0), 3);
});

test("'hoje' começa à meia-noite de Brasília, não à meia-noite UTC", () => {
  const now = new Date("2026-09-29T01:30:00.000Z"); // 28/09 22:30 BRT
  assert.equal(commercialDay(now), "2026-09-28");
  assert.equal(startOfCommercialDay(now).toISOString(), "2026-09-28T03:00:00.000Z");
  const w = dashboardWindows(now);
  assert.equal(w.sevenDaysAgo.toISOString(), "2026-09-22T01:30:00.000Z");
  assert.equal(w.thirtyDaysAgo.toISOString(), "2026-08-30T01:30:00.000Z");
  assert.equal(w.inSevenDays.toISOString(), "2026-10-06T01:30:00.000Z");
});
