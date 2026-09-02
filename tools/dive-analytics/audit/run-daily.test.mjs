// run-daily.test.mjs — whole-chain runs stop after the scheduled run and one
// recovery, then reset on the next Phoenix day.
import assert from "node:assert/strict";
import { finishAttempt, MAX_DAILY_ATTEMPTS, nextAttempt } from "../run-daily.mjs";

const base = { version: 1, timezone: "America/Phoenix", days: {} };
const dayOneMorning = Date.parse("2026-09-02T14:00:00Z");

const first = nextAttempt(base, dayOneMorning, { mode: "primary", id: "one", origin: "abc" });
assert.equal(first.allowed, true);
assert.equal(first.number, 1);
const firstDone = finishAttempt(first.state, first.day, first.id, "failed:1", dayOneMorning + 1000);
assert.equal(firstDone.days["2026-09-02"][0].status, "failed:1");

const second = nextAttempt(firstDone, dayOneMorning + 2000, { mode: "recovery", id: "two", origin: "abc" });
assert.equal(second.allowed, true);
assert.equal(second.number, MAX_DAILY_ATTEMPTS);
const secondDone = finishAttempt(second.state, second.day, second.id, "passed", dayOneMorning + 3000);

const third = nextAttempt(secondDone, dayOneMorning + 4000, { mode: "recovery", id: "three", origin: "abc" });
assert.equal(third.allowed, false);
assert.equal(third.state.days["2026-09-02"].length, 2, "a refused third run is not recorded as work");

const nextDay = nextAttempt(secondDone, Date.parse("2026-09-03T14:00:00Z"), { mode: "primary", id: "next" });
assert.equal(nextDay.allowed, true);
assert.equal(nextDay.number, 1);

console.log("run-daily.test: primary plus one recovery, refused third run, saved outcomes, and next-day reset pass");
