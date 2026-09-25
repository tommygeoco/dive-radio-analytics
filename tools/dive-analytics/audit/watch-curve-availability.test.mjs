#!/usr/bin/env node
// Watch totals can arrive before either channel's retention curve. Exercise
// the real attachment and agent projection against disposable source stores.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachWatch } from "../build-data.mjs";
import { buildBrief } from "../agent-brief.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const data = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
// The Markdown brief keeps a bounded recent window. Choose a complete watch
// fixture that is actually in that window, so the Markdown assertion keeps
// testing a displayed episode as the catalog grows.
const included = new Set(buildBrief(data).digest.markdown.includedSlugs);
const episode = [...data.episodes].reverse().find((e) => included.has(e.slug)
  && e.watch?.curve?.length === 100
  && e.watch.moments?.some((m) => m.kind === "drop" && m.summary)
  && e.watch.moments?.some((m) => m.kind === "hold" && m.summary));
assert.ok(episode, "the brief needs a recent episode with a complete watch curve and grounded moments");
const source = JSON.parse(readFileSync(join(root, "data/restream/yt-analytics", `${episode.slug}.json`), "utf8"));
const now = Date.parse(source.updatedAt) + 1;
const dir = mkdtempSync(join(tmpdir(), "dive-watch-curve-"));
const message = "Audience curve and topic moments aren't available from YouTube yet.";

function project(store) {
  writeFileSync(join(dir, `${episode.slug}.json`), JSON.stringify(store));
  const e = structuredClone(episode);
  delete e.watch;
  delete e.watchReport;
  attachWatch([e], now, { watchDir: dir });
  return e;
}
function brief(e) {
  return buildBrief({ ...data, episodes: data.episodes.map(original => original.slug === e.slug ? e : original) });
}

try {
  const ready = project(source);
  assert.equal(ready.watch.curve.length, 100);
  assert.equal(ready.watch.curveUnavailableReason, null);
  assert.ok(ready.watch.moments.some(m => m.kind === "drop" && m.summary));
  assert.ok(ready.watch.moments.some(m => m.kind === "hold" && m.summary));
  const totals = e => [e.watch.avgPercent, e.watch.avgDurationSec, e.watch.minutesWatched, e.watch.byChannel];
  for (const mode of ["empty", "one-channel", "no-common-points"]) {
    const store = structuredClone(source);
    const channels = Object.values(store.channels);
    if (mode === "empty") channels.forEach(c => { c.retention = []; });
    if (mode === "one-channel") channels[0].retention = [];
    if (mode === "no-common-points") {
      channels[0].retention = channels[0].retention.filter((_, i) => i % 2 === 0);
      channels[1].retention = channels[1].retention.filter((_, i) => i % 2 === 1);
    }
    const waiting = project(store);
    assert.deepEqual(totals(waiting), totals(ready), `${mode}: valid totals stay visible`);
    assert.equal(waiting.watchReport.state, "ready", "totals readiness does not imply a curve exists");
    assert.equal(waiting.watch.curve, null);
    assert.equal(waiting.watch.moments, undefined, `${mode}: no invented topic markers`);
    assert.equal(waiting.watch.curveUnavailableReason, message);
    const b = brief(waiting);
    assert.equal(b.digest.episodes.find(e => e.slug === waiting.slug).watching.curveUnavailableReason, message);
    assert.ok(b.md.includes(message), "agents receive the same explanation as the dashboard");
  }
  // A later successful capture needs only the ordinary build to restore the
  // curve, matching topic notes, and both kinds of markers.
  const arrived = project(source);
  assert.deepEqual(arrived.watch, ready.watch);
  assert.equal(brief(arrived).digest.episodes.find(e => e.slug === arrived.slug).watching.curveUnavailableReason, null);
  console.log("watch-curve-availability: totals survive missing/partial curves; complete curves restore grounded drop/jump-in moments and clear the explanation");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
