#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_STREAM_CONFIRMATIONS,
  NO_STREAM_CONFIRM_SPAN_MS,
  NO_STREAM_MIN_AGE_MS,
  analyticsDisposition,
  asEventList,
  eventNeedsAnalytics,
  hasMessageAnalytics,
  hasViewerAnalytics,
  loadState,
  saveState,
  runRestreamIngest,
  updateLog,
} from "../../../scripts/restream/ingest-restream.mjs";

const NOW = Date.parse("2026-09-04T14:00:00.000Z");
const COMPLETE_VIEWERS = {
  total: {
    mean: 68,
    max: 98,
    viewsTotal: 872,
    watchedTime: 7820,
    viewersPerMinute: [{ timestamp: NOW - 60_000, viewers: 68 }],
  },
  byChannel: {
    11: {
      mean: 68,
      max: 98,
      viewsTotal: 872,
      watchedTime: 7820,
      viewersPerMinute: [{ timestamp: NOW - 60_000, viewers: 68 }],
    },
  },
};
const COMPLETE_MESSAGES = {
  total: {
    messagesTotal: 137,
    chattersTotal: 37,
    messagesPerMinute: [{ timestamp: NOW - 60_000, messages: 2 }],
  },
  byChannel: {
    11: {
      messagesTotal: 137,
      chattersTotal: 37,
      messagesPerMinute: [{ timestamp: NOW - 60_000, messages: 2 }],
    },
  },
};
const STREAMED_EVENT = {
  id: "streamed-event",
  status: "finished",
  startedAt: (NOW - 3 * 60 * 60 * 1000) / 1000,
  finishedAt: (NOW - 60 * 60 * 1000) / 1000,
  destinations: [{ channelId: 11 }],
};
const NEVER_STARTED_EVENT = {
  id: "never-started-event",
  status: "finished",
  startedAt: null,
  finishedAt: (NOW - NO_STREAM_MIN_AGE_MS - 60_000) / 1000,
};

const base = mkdtempSync(join(tmpdir(), "dive-restream-ingest."));
try {
  const missing = join(base, "missing", "state.json");
  assert.throws(
    () => loadState(missing),
    /state is missing.*refusing to treat missing history as empty/,
    "missing state must stop ingest instead of recreating empty history"
  );

  const corrupt = join(base, "corrupt.json");
  const corruptBytes = "{not-json\n";
  writeFileSync(corrupt, corruptBytes);
  assert.throws(() => loadState(corrupt), /state is unreadable/);
  assert.equal(readFileSync(corrupt, "utf8"), corruptBytes, "a failed read never rewrites corrupt state");

  const wrongShape = join(base, "wrong-shape.json");
  writeFileSync(wrongShape, JSON.stringify({ events: [] }));
  assert.throws(() => loadState(wrongShape), /no readable events map/);

  const unknownStatus = join(base, "unknown-status.json");
  writeFileSync(unknownStatus, JSON.stringify({ events: { event: { status: "skipped" } } }));
  assert.throws(() => loadState(unknownStatus), /invalid entry for event/);

  const incompleteStateEntry = join(base, "incomplete-state-entry.json");
  writeFileSync(incompleteStateEntry, JSON.stringify({ events: { event: { status: "ingested" } } }));
  assert.throws(
    () => loadState(incompleteStateEntry),
    /invalid entry for event/,
    "an ingested marker without its saved time is corrupt rather than authoritative"
  );

  const roundTrip = join(base, "nested", "state.json");
  const validState = {
    events: {
      event: {
        status: "no-analytics",
        attempts: 1,
        firstCheckedAt: new Date(NOW).toISOString(),
        checkedAt: new Date(NOW).toISOString(),
      },
    },
  };
  saveState(validState, roundTrip);
  assert.equal(existsSync(roundTrip), true);
  assert.deepEqual(loadState(roundTrip), validState);
  assert.equal(
    readFileSync(roundTrip, "utf8"),
    `${JSON.stringify(validState, null, 2)}\n`,
    "state writes remain deterministic"
  );

  assert.deepEqual(asEventList([{ id: "array" }]), [{ id: "array" }]);
  assert.deepEqual(asEventList({ items: [{ id: "items" }] }), [{ id: "items" }]);
  assert.deepEqual(asEventList({ events: [{ id: "events" }] }), [{ id: "events" }]);
  assert.throws(() => asEventList(null), /no event list/);
  assert.throws(() => asEventList({}), /no event list/);

  assert.equal(eventNeedsAnalytics(undefined), true);
  assert.equal(eventNeedsAnalytics({ status: "no-analytics" }), true);
  assert.equal(eventNeedsAnalytics({ status: "ingested" }), false);
  assert.equal(eventNeedsAnalytics({ status: "no-stream" }), false);
  assert.throws(() => eventNeedsAnalytics({ status: "skipped" }), /state is invalid/);

  assert.equal(hasViewerAnalytics(COMPLETE_VIEWERS), true);
  assert.equal(hasMessageAnalytics(COMPLETE_MESSAGES), true);
  assert.equal(hasViewerAnalytics({ ...COMPLETE_VIEWERS, total: { ...COMPLETE_VIEWERS.total, max: null } }), false);
  assert.equal(hasViewerAnalytics({ ...COMPLETE_VIEWERS, total: { ...COMPLETE_VIEWERS.total, watchedTime: undefined } }), false);
  assert.equal(hasViewerAnalytics(COMPLETE_VIEWERS, [11, 12]), false);
  assert.equal(hasMessageAnalytics({ ...COMPLETE_MESSAGES, total: { ...COMPLETE_MESSAGES.total, messagesPerMinute: null } }), false);

  const complete = analyticsDisposition(
    STREAMED_EVENT,
    COMPLETE_VIEWERS,
    COMPLETE_MESSAGES,
    undefined,
    NOW
  );
  assert.equal(complete.action, "ingest");
  assert.equal(complete.state.status, "ingested");

  for (const [viewers, messages, expectedMissing] of [
    [null, COMPLETE_MESSAGES, ["viewer analytics"]],
    [COMPLETE_VIEWERS, null, ["chat analytics"]],
    [{}, COMPLETE_MESSAGES, ["viewer analytics"]],
  ]) {
    const incomplete = analyticsDisposition(STREAMED_EVENT, viewers, messages, undefined, NOW);
    assert.equal(incomplete.action, "retry");
    assert.equal(incomplete.blocking, true, "a streamed event with incomplete facts must stop publishing");
    assert.equal(incomplete.state.status, "no-analytics");
    assert.deepEqual(incomplete.state.missing, expectedMissing);
    assert.equal(eventNeedsAnalytics(incomplete.state), true, "no-analytics remains retryable");
  }

  const firstNoStreamCheck = analyticsDisposition(
    NEVER_STARTED_EVENT,
    null,
    null,
    undefined,
    NOW
  );
  assert.equal(firstNoStreamCheck.action, "retry");
  assert.equal(firstNoStreamCheck.blocking, false);
  assert.equal(firstNoStreamCheck.state.status, "no-analytics");
  assert.equal(firstNoStreamCheck.state.attempts, 1);

  const tooSoon = analyticsDisposition(
    NEVER_STARTED_EVENT,
    null,
    null,
    {
      status: "no-analytics",
      attempts: NO_STREAM_CONFIRMATIONS - 1,
      firstCheckedAt: new Date(NOW - NO_STREAM_CONFIRM_SPAN_MS + 1).toISOString(),
    },
    NOW
  );
  assert.equal(tooSoon.action, "retry", "check count alone cannot confirm a terminal no-stream event");

  const tooYoung = analyticsDisposition(
    { ...NEVER_STARTED_EVENT, finishedAt: (NOW - NO_STREAM_MIN_AGE_MS + 1) / 1000 },
    null,
    null,
    {
      status: "no-analytics",
      attempts: NO_STREAM_CONFIRMATIONS - 1,
      firstCheckedAt: new Date(NOW - NO_STREAM_CONFIRM_SPAN_MS).toISOString(),
    },
    NOW
  );
  assert.equal(tooYoung.action, "retry", "an event must be old enough before it is closed as never started");

  const confirmedNoStream = analyticsDisposition(
    NEVER_STARTED_EVENT,
    null,
    null,
    {
      status: "no-analytics",
      attempts: NO_STREAM_CONFIRMATIONS - 1,
      firstCheckedAt: new Date(NOW - NO_STREAM_CONFIRM_SPAN_MS).toISOString(),
    },
    NOW
  );
  assert.equal(confirmedNoStream.action, "no-stream");
  assert.equal(confirmedNoStream.state.status, "no-stream");
  assert.equal(confirmedNoStream.state.attempts, NO_STREAM_CONFIRMATIONS);
  assert.equal(eventNeedsAnalytics(confirmedNoStream.state), false);

  const startedNeverCloses = analyticsDisposition(
    { ...STREAMED_EVENT, finishedAt: NEVER_STARTED_EVENT.finishedAt },
    null,
    null,
    {
      status: "no-analytics",
      attempts: NO_STREAM_CONFIRMATIONS + 20,
      firstCheckedAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    NOW
  );
  assert.equal(startedNeverCloses.action, "retry");
  assert.equal(startedNeverCloses.blocking, true);
  assert.equal(startedNeverCloses.state.status, "no-analytics");

  const root = join(base, "integration");
  const dir = join(root, "data", "restream");
  mkdirSync(dir, { recursive: true });
  saveState({ events: {} }, join(dir, "state.json"));
  writeFileSync(join(dir, "postlive-registry.json"), JSON.stringify({ shows: [{ slug: "dive-radio-fixture", date: "2026-09-03", targets: [{ kind: "youtube", videoId: "video" }] }] }));
  const event = { ...STREAMED_EVENT, destinations: [{ channelId: 11, externalUrl: "https://youtube.com/watch?v=video" }] };
  const logPath = join(root, "log.md");
  writeFileSync(logPath, "_Last ingest: old_\n<!-- LOG:BEGIN -->\n<!-- DETAIL:BEGIN -->\n");
  const fetchFor = (pending) => async (url) => ({ ok: true, json: async () => url.includes("history?") ? [event] : url.endsWith("viewers") ? (pending ? {} : COMPLETE_VIEWERS) : COMPLETE_MESSAGES });
  const waiting = await runRestreamIngest({ root, logPath, now: NOW, token: "fixture", fetchImpl: fetchFor(true), log() {} });
  assert.equal(waiting.pending, 1);
  assert.equal(existsSync(join(dir, "events", `${event.id}.json`)), false);
  assert.equal(loadState(join(dir, "state.json")).events[event.id].reading.state, "pending");
  const ready = await runRestreamIngest({ root, logPath, now: NOW + 1000, token: "fixture", fetchImpl: fetchFor(false), log() {} });
  assert.equal(ready.ingested, 1);
  const archived = readFileSync(join(dir, "events", `${event.id}.json`), "utf8");
  const again = await runRestreamIngest({ root, logPath, now: NOW + 2000, token: "fixture", fetchImpl: fetchFor(false), log() {} });
  assert.equal(again.ingested, 0);
  assert.equal(readFileSync(join(dir, "events", `${event.id}.json`), "utf8"), archived);
  // Simulate interruption after the archive/log but before the state commit.
  saveState({ events: {} }, join(dir, "state.json"));
  await runRestreamIngest({ root, logPath, now: NOW + 3000, token: "fixture", fetchImpl: async (url) => {
    assert.ok(url.includes("history?"), "recovery must reuse its complete archive");
    return { ok: true, json: async () => [event] };
  }, log() {} });
  assert.equal((readFileSync(logPath, "utf8").match(/- Event ID:/g) || []).length, 1);
  assert.equal(readFileSync(join(dir, "events", `${event.id}.json`), "utf8"), archived);
  assert.equal(hasViewerAnalytics({ ...COMPLETE_VIEWERS, total: { ...COMPLETE_VIEWERS.total, mean: -1 } }), false);
  await assert.rejects(runRestreamIngest({ root, logPath, now: NOW, token: null, log() {} }), /credential/);
} finally {
  rmSync(base, { force: true, recursive: true });
}

console.log(
  "ingest-restream.test: missing or corrupt state fails, incomplete streamed analytics retries, and confirmed no-stream closure passes"
);
