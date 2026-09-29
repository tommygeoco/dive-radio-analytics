#!/usr/bin/env node
// ratings-rederive.test.mjs — episode health health21-v3 (AUDIT-2026-09-29 #12).
//
// 1. One chat definition: baselines.liveChatOf leaves LinkedIn's row out and is
//    absent when LinkedIn's count is unknown; show health's rates and episode
//    health's live check both read it.
// 2. A fresh v3 read compares chat without LinkedIn on both sides, counts a
//    peer only with both readings, and says so in the stored note.
// 3. The declared re-derive turns a frozen health21-v2 entry into exactly one
//    v3 entry: the live check rebuilt from the live files, everything else
//    carried byte for byte, weights and score recomputed, the earlier rules
//    and score named. The frozen-bytes guard accepts that and nothing else.
// 4. The Slack alert names each re-read score once, on the day the rules change.
// Numbers are small enough to check on paper; see the comments beside them.
import assert from "node:assert/strict";
import * as B from "../baselines.mjs";
import { scoreEpisode, declaredRederive, rederivePath, REDERIVES, ALGORITHM } from "../ratings.mjs";
import { assertFrozenRatingsUnchanged, ratingEntryBytes, frozenRatingBytes } from "../source-integrity.mjs";
import { alertLines } from "../alerts.mjs";

const DAY = 86400000;
const PHX = 7 * 3600000;
const premiere = (i) => new Date(Date.UTC(2026, 0, 7 + 7 * i, 12) + PHX).toISOString().slice(0, 10);
const ts = (date, ageDays) => new Date(B.premiereMs(date) + ageDays * DAY).toISOString();
const linkedin = (messages) => ({ label: "LinkedIn", peak: null, avg: null, views: null, watchedMin: null, messages, chatters: messages });
const youtube = (messages) => ({ label: "YT Dive Club", peak: 30, avg: 20, views: 100, watchedMin: 1000, messages, chatters: 5 });

// peers A–D simulcast to LinkedIn; the episode under test (E) did not, like E11
const LIVE = [
  { peak: 60, chat: 200, li: 20 }, // compared chat 180
  { peak: 70, chat: 150, li: 10 }, // 140
  { peak: 80, chat: 100, li: 0 },  // 100
  { peak: 90, chat: 120, li: 40 }, // 80
  { peak: 100, chat: 160, li: undefined }, // no LinkedIn row: 160
];
function episode(i, live = LIVE[i]) {
  const date = premiere(i);
  const snapshots = [];
  for (let d = 1; d <= 30; d++) {
    const yt = Math.round(1000 * (1 + i / 10) * (1 - Math.exp(-d / 6)));
    snapshots.push({ ts: ts(date, d), byDest: {
      "yt:joindiveclub": { views: Math.round(yt * 0.6), likes: Math.round(yt * 0.02), comments: Math.round(yt * 0.004) },
      "yt:designertom": { views: Math.round(yt * 0.4), likes: Math.round(yt * 0.015), comments: Math.round(yt * 0.003) },
    } });
  }
  const last = snapshots.at(-1);
  return {
    ep: i + 1, slug: `e${i + 1}`, premiere: date, snapshots,
    links: { "yt:joindiveclub": "https://youtube.com/watch?v=one", "yt:designertom": "https://youtube.com/watch?v=two" },
    latest: { ts: last.ts, byDest: last.byDest, ytTotal: B.ytViewsOf(last) },
    live: live && { peak: live.peak, chatMessages: live.chat, chatters: 20, durationMin: 60,
      byChannel: [youtube(live.chat - (live.li ?? 0)), ...(live.li === undefined ? [] : [linkedin(live.li)])] },
  };
}
const eps = LIVE.map((_, i) => episode(i));
const noAnalytics = { readAnalytics: () => null, readHistory: () => [] };
const noFlags = new Map();

// --- 1. one chat definition ---
{
  assert.equal(B.liveChatOf(eps[0]), 180, "LinkedIn's row is left out");
  assert.equal(B.liveChatOf(eps[4]), 160, "no LinkedIn row: the whole session");
  assert.equal(B.liveChatOf(episode(0, { peak: 60, chat: 200, li: null })), null, "unknown LinkedIn count: absent, never the total");
  assert.equal(B.liveChatOf(episode(0, { peak: 60, chat: null, li: 20 })), null);
  assert.equal(B.liveChatOf({ slug: "none" }), null);
  for (const e of eps) assert.equal(B.liveRatesOf(e).messagesPerHour, B.round1((B.liveChatOf(e) / 60) * 60), "show health reads the same chat");
}

// --- 2. a fresh v3 read ---
{
  const target = eps[4];
  const live = scoreEpisode(target, eps.slice(0, 4), noFlags, noAnalytics).checks.live;
  assert.deepEqual(live.value, { peak: 100, chat: 160 });
  assert.deepEqual(live.typical, { peak: 75, chat: 120 }, "typical chat 120 = middle of 180, 140, 100, 80 — not 135 with LinkedIn");
  assert.equal(live.ratio, 1.333); // (100/75 + 160/120) / 2
  assert.equal(live.score, 67);
  assert.equal(live.note, B.NOTES.liveChat);
  assert.deepEqual(live.peers.map((p) => p.value.chat), [180, 140, 100, 80]);

  // a peer with an unknown LinkedIn count is not a peer at all (peak included)
  const unknownPeer = [eps[0], eps[1], eps[2], episode(3, { peak: 90, chat: 120, li: null })];
  const three = scoreEpisode(target, unknownPeer, noFlags, noAnalytics).checks.live;
  assert.deepEqual(three.peers.map((p) => p.slug), ["e1", "e2", "e3"]);
  assert.deepEqual(three.typical, { peak: 70, chat: 140 });
  assert.ok(three.excluded.some((x) => x.slug === "e4"));
  const two = scoreEpisode(target, unknownPeer.slice(1), noFlags, noAnalytics).checks.live;
  assert.equal(two.ratio, null, "below three peers: absent");
  assert.equal(two.reason, B.NOTES.fewPeers);

  // the episode's own LinkedIn count unknown: absent with its reason, weight shared out
  const unknownOwn = scoreEpisode(episode(4, { peak: 100, chat: 160, li: null }), eps.slice(0, 4), noFlags, noAnalytics);
  assert.equal(unknownOwn.checks.live.value, null);
  assert.equal(unknownOwn.checks.live.reason, B.NOTES.liveChatUnknown);
  assert.equal(unknownOwn.checks.live.weight, 0);
  assert.ok(unknownOwn.missingChecks.includes("live"));
  // no live session at all: the check does not exist, as before
  assert.equal(scoreEpisode(episode(4, null), eps.slice(0, 4), noFlags, noAnalytics).checks.live.ageBasis, null);
}

// --- 3. the declared re-derive and the frozen-bytes guard ---
const absent = () => ({ value: null, typical: null, ratio: null, score: null, weight: 0, sample: 0, peers: [], reason: B.NOTES.fewPeers, ageBasis: null, note: null, excluded: [] });
const livePeer = (i) => ({ slug: `e${i + 1}`, value: { peak: LIVE[i].peak, chat: LIVE[i].chat }, atDay: null, source: "live-event", readDate: null });
// E5 as health21-v2 froze it: chat WITH LinkedIn on the peers' side.
// live: 100/75 → 1.333, 160/135 → 1.185, both → 1.259, score 63
// watch 40 × 0.7 + live 63 × 0.3 = 46.9 → 47
const V2_ENTRY = {
  ep: 5, slug: "e5", premiere: premiere(4), algorithm: "health21-v2",
  windowIds: ["e1", "e2", "e3", "e4", "e5"], excluded: [], readDays: 21, atDay: 21, frozenAtDay: 21.3,
  readCompleteOn: "2026-02-25", score: 47,
  checks: {
    watch: { value: 800, typical: 1000, ratio: 0.8, score: 40, sample: 4, peers: [0, 1, 2, 3].map((i) => ({ slug: `e${i + 1}`, value: 1000, atDay: 21, source: "snapshot", readDate: "2026-01-28" })), reason: null, atDay: 21, ageBasis: "sameAge", note: B.NOTES.sameAge, excluded: [], weight: 0.7 },
    engagement: absent(), retention: absent(),
    live: { value: { peak: 100, chat: 160 }, typical: { peak: 75, chat: 135 }, ratio: 1.259, score: 63, sample: 4, peers: [0, 1, 2, 3].map(livePeer), reason: null, ageBasis: "ageFree", note: null, excluded: [], weight: 0.3 },
    conversion: absent(), sentiment: absent(),
  },
  missingChecks: ["engagement", "retention", "conversion", "sentiment"], reason: null, reproducible: true,
  computedAt: "2026-02-26T14:00:00.000Z", frozenAt: "2026-02-26T14:00:00.000Z",
};
const storeText = (algorithm, scores, extra = {}) => JSON.stringify({ version: 4, algorithm, readDays: 21, windowN: 8, minPeers: 3, updatedAt: "2026-09-30T14:00:00.000Z", scores, ...extra }, null, 2) + "\n";
const V2_TEXT = storeText("health21-v2", [V2_ENTRY], { rederivedFrom: "health21-v1", rederivedAt: "2026-01-01T00:00:00.000Z" });
const rederive = declaredRederive(eps);
const v3 = rederive.entry(structuredClone(V2_ENTRY), ALGORITHM);
const STAMPS = { rederivedFrom: "health21-v2", rederivedAt: "2026-09-30T14:00:00.000Z" };
const V3_TEXT = storeText(ALGORITHM, [v3], STAMPS);
{
  assert.equal(ALGORITHM, "health21-v3");
  assert.deepEqual(rederivePath("health21-v2", "health21-v3"), ["health21-v2", "health21-v3"]);
  assert.throws(() => rederivePath("health21-v1", "health21-v3"), /no declared re-derive/, "v1 → v2 was never declared; history is not rewritten");
  assert.equal(REDERIVES["health21-v3"].from, "health21-v2");

  // live rebuilt without LinkedIn: 100/75 → 1.333, 160/120 → 1.333, score 67;
  // watch 40 × 0.7 + live 67 × 0.3 = 48.1 → 48
  assert.equal(v3.algorithm, "health21-v3");
  assert.deepEqual(v3.checks.live, { value: { peak: 100, chat: 160 }, typical: { peak: 75, chat: 120 }, ratio: 1.333, score: 67, sample: 4,
    peers: [0, 1, 2, 3].map((i) => ({ ...livePeer(i), value: { peak: LIVE[i].peak, chat: LIVE[i].chat - LIVE[i].li } })),
    reason: null, ageBasis: "ageFree", note: B.NOTES.liveChat, excluded: [], weight: 0.3 });
  assert.equal(v3.score, 48);
  assert.deepEqual(v3.rederivedFrom, { algorithm: "health21-v2", score: 47 });
  for (const c of ["watch", "engagement", "retention", "conversion", "sentiment"]) assert.equal(JSON.stringify(v3.checks[c]), JSON.stringify(V2_ENTRY.checks[c]), `${c} carried byte for byte`);
  for (const k of ["ep", "slug", "premiere", "windowIds", "excluded", "atDay", "frozenAtDay", "readCompleteOn", "computedAt", "frozenAt"]) assert.equal(JSON.stringify(v3[k]), JSON.stringify(V2_ENTRY[k]), `${k} kept`);
  assert.deepEqual(Object.keys(v3), [...Object.keys(V2_ENTRY), "rederivedFrom"], "key order kept, the stamp appended");
  assert.equal(V2_ENTRY.checks.live.weight, 0.3, "the frozen input is not mutated");
  assert.equal(frozenRatingBytes(V3_TEXT).get("e5"), ratingEntryBytes(v3), "entry bytes are exactly what ratings.mjs writes");

  // the guard: exactly the declared re-derive passes
  assert.equal(assertFrozenRatingsUnchanged(V2_TEXT, V3_TEXT, { rederive }), 1);
  // … and within v3 every frozen byte is locked again
  assert.equal(assertFrozenRatingsUnchanged(V3_TEXT, V3_TEXT, { rederive }), 1);
  assert.throws(() => assertFrozenRatingsUnchanged(V3_TEXT, V3_TEXT.replace('"score": 48', '"score": 49'), { rederive }), /frozen rating bytes changed/);

  const edit = (fn) => { const e = structuredClone(v3); fn(e); return e; };
  const refused = {
    "no declared re-derive given": [V3_TEXT, {}],
    "rederivedFrom names the wrong rules": [storeText(ALGORITHM, [v3], { ...STAMPS, rederivedFrom: "health21-v1" }), { rederive }],
    "no rederivedAt": [storeText(ALGORITHM, [v3], { rederivedFrom: "health21-v2" }), { rederive }],
    "a carried check edited": [storeText(ALGORITHM, [edit((e) => { e.checks.watch.score = 41; })], STAMPS), { rederive }],
    "the earlier score misreported": [storeText(ALGORITHM, [edit((e) => { e.rederivedFrom.score = 50; })], STAMPS), { rederive }],
    "a from-scratch recompute (new freeze time)": [storeText(ALGORITHM, [edit((e) => { e.frozenAt = e.computedAt = "2026-09-30T14:00:00.000Z"; })], STAMPS), { rederive }],
    "the entry unfrozen": [storeText(ALGORITHM, [edit((e) => { delete e.frozenAt; })], STAMPS), { rederive }],
    "the entry dropped": [storeText(ALGORITHM, [], STAMPS), { rederive }],
    "an undeclared algorithm": [storeText("health21-v9", [edit((e) => { e.algorithm = "health21-v9"; })], { ...STAMPS, rederivedFrom: "health21-v3" }), { rederive }],
  };
  for (const [why, [text, options]] of Object.entries(refused)) assert.throws(() => assertFrozenRatingsUnchanged(V2_TEXT, text, options), /frozen rating/, why);

  // a live file that no longer matches what the entry froze with stops the re-derive
  const moved = declaredRederive([...eps.slice(0, 4), episode(4, { peak: 100, chat: 161, li: undefined })]);
  assert.throws(() => moved.entry(structuredClone(V2_ENTRY), ALGORITHM), /values differ from the live-event file/);
  const movedPeer = declaredRederive([episode(0, { peak: 61, chat: 200, li: 20 }), ...eps.slice(1)]);
  assert.throws(() => movedPeer.entry(structuredClone(V2_ENTRY), ALGORITHM), /peer e1 differs/);

  // the outlier verdicts the entry froze with decide peers, with their reasons —
  // never today's flags
  const flaggedEntry = { ...structuredClone(V2_ENTRY), excluded: [{ slug: "e3", why: "known newsletter promotion" }] };
  flaggedEntry.checks.live.peers = flaggedEntry.checks.live.peers.filter((p) => p.slug !== "e3");
  const kept = rederive.entry(flaggedEntry, ALGORITHM).checks.live;
  assert.deepEqual(kept.peers.map((p) => p.slug), ["e1", "e2", "e4"]);
  assert.deepEqual(kept.excluded, [{ slug: "e3", why: "known newsletter promotion" }]);
  assert.deepEqual(kept.typical, { peak: 70, chat: 140 });

  // an entry that froze with no live session keeps that: no new input rides in
  const noLive = { ...structuredClone(V2_ENTRY), checks: { ...structuredClone(V2_ENTRY.checks), live: absent() } };
  assert.equal(JSON.stringify(rederive.entry(noLive, ALGORITHM).checks.live), JSON.stringify(absent()));
}

// --- 4. the Slack line, once ---
{
  const health = (ep, score, was) => ({ ep, slug: `e${ep}`, health: { algorithm: ALGORITHM, score, rederivedFrom: { algorithm: "health21-v2", score: was } } });
  const data = { episodes: [health(4, null, null), health(5, 48, 47), health(6, 38, 38), { ep: 7, slug: "e7", health: { pending: true } }] };
  const state = (rules) => ({ episodeCount: 4, complaints: {}, w1v: {}, staleCount: 0, reviewCount: 0, ...(rules === undefined ? {} : { episodeHealthRules: rules }) });
  const line = (prev) => alertLines(prev, state(ALGORITHM), data).map((l) => l.text).find((t) => t.startsWith("Episode health scoring rules changed"));
  assert.equal(line(state(undefined)), "Episode health scoring rules changed (health21-v2 → health21-v3). Each finished score was re-read from its saved inputs: E5 47 → 48, E6 38 → 38.", "a state saved before the field existed still hears the change");
  assert.ok(line(state("health21-v2")));
  assert.equal(line(state(ALGORITHM)), undefined, "said once");
}

console.log("ratings-rederive.test: one chat definition, v3 live check, declared v2 → v3 re-derive, frozen-bytes guard, Slack line");
