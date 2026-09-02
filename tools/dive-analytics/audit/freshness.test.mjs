// freshness.test.mjs — Phoenix calendar-day freshness catches yesterday even
// when a build is only a few hours old.
import assert from "node:assert/strict";
import { checkProductionFreshness, freshnessVerdict, phoenixDay, staleLine } from "../freshness.mjs";

const morning = Date.parse("2026-09-02T15:15:00Z"); // 08:15 Phoenix
assert.equal(phoenixDay(morning), "2026-09-02");

{
  const result = freshnessVerdict("2026-09-02T14:00:00Z", morning);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "fresh");
}

{
  const result = freshnessVerdict("2026-09-02T06:59:00Z", morning); // 23:59 Phoenix the day before
  assert.equal(result.ok, false);
  assert.equal(result.kind, "prior-day");
  assert.ok(result.ageHours < 9, "calendar-day failure is independent of the 26-hour guard");
  assert.match(staleLine(result.generatedAt, morning), /today's publish is missing/);
}

assert.equal(freshnessVerdict("not-a-time", morning).kind, "unreadable");
assert.equal(freshnessVerdict("2026-09-03T00:00:00Z", morning).kind, "future");
assert.equal(freshnessVerdict("2026-09-01T12:00:00Z", morning, { requireToday: false }).kind, "old");

{
  const result = await checkProductionFreshness({
    now: morning,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "unreachable");
  assert.match(result.message, /HTTP 503/);
}

console.log("freshness.test: Phoenix same-day, short-age yesterday, old, future, unreadable, and unreachable checks pass");
