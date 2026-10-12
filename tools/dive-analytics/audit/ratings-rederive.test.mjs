#!/usr/bin/env node
// ratings-rederive.test.mjs — episode health's live check and its declared
// re-derives: health21-v3 (AUDIT-2026-09-29 #12) and health21-v4
// (AUDIT-2026-10-12-live-break-split).
//
// 1. One chat definition: baselines.liveChatOf leaves LinkedIn's row out and is
//    absent when LinkedIn's count is unknown; show health's rates and episode
//    health's live check both read it.
// 2. A fresh read compares chat without LinkedIn on both sides, counts a peer
//    only with both readings, and says so in the stored note.
// 3. The declared re-derive turns a frozen health21-v2 entry into exactly one
//    v3 entry: the live check rebuilt from the live files, everything else
//    carried byte for byte, weights and score recomputed, the earlier rules
//    and score named. The frozen-bytes guard accepts that and nothing else.
// 4. health21-v4: the live check's peers sit on the episode's own side of the
//    known E5 reporting break, and when the break leaves fewer than three the
//    check is absent and names it. The declared v3 → v4 step rebuilds only the
//    live check; a v2 entry replays v2 → v3 → v4.
// 5. The Slack alert names each re-read score once, on the day the rules change.
// Sections 1–3 air entirely after the break (E5–E9), so chat compares like for
// like there; section 4 straddles it (E1–E8). Numbers are small enough to
// check on paper; see the comments beside them.
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

// peers E5–E8 simulcast to LinkedIn; the episode under test (E9) did not, like E11
const FIRST = 5;
const LIVE = [
  { peak: 60, chat: 200, li: 20 }, // compared chat 180
  { peak: 70, chat: 150, li: 10 }, // 140
  { peak: 80, chat: 100, li: 0 },  // 100
  { peak: 90, chat: 120, li: 40 }, // 80
  { peak: 100, chat: 160, li: undefined }, // no LinkedIn row: 160
];
// the i-th episode of a fixture airs as E<ep>, slug "<prefix><ep>"
function episode(i, live = LIVE[i], { ep = FIRST + i, prefix = "e" } = {}) {
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
    ep, slug: `${prefix}${ep}`, premiere: date, snapshots,
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

// --- 2. a fresh read ---
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
  assert.deepEqual(three.peers.map((p) => p.slug), ["e5", "e6", "e7"]);
  assert.deepEqual(three.typical, { peak: 70, chat: 140 });
  assert.ok(three.excluded.some((x) => x.slug === "e8"));
  const two = scoreEpisode(target, unknownPeer.slice(1), noFlags, noAnalytics).checks.live;
  assert.equal(two.ratio, null, "below three peers: absent");
  assert.equal(two.reason, B.NOTES.fewPeers, "no break in the window: the plain reason");

  // the episode's own LinkedIn count unknown: absent with its reason, weight shared out
  const unknownOwn = scoreEpisode(episode(4, { peak: 100, chat: 160, li: null }), eps.slice(0, 4), noFlags, noAnalytics);
  assert.equal(unknownOwn.checks.live.value, null);
  assert.equal(unknownOwn.checks.live.reason, B.NOTES.liveChatUnknown);
  assert.equal(unknownOwn.checks.live.weight, 0);
  assert.ok(unknownOwn.missingChecks.includes("live"));
  // no live session at all: the check does not exist, as before
  assert.equal(scoreEpisode(episode(4, null), eps.slice(0, 4), noFlags, noAnalytics).checks.live.ageBasis, null);
}

// --- 3. the declared v2 → v3 re-derive and the frozen-bytes guard ---
const absent = () => ({ value: null, typical: null, ratio: null, score: null, weight: 0, sample: 0, peers: [], reason: B.NOTES.fewPeers, ageBasis: null, note: null, excluded: [] });
const livePeer = (i) => ({ slug: `e${FIRST + i}`, value: { peak: LIVE[i].peak, chat: LIVE[i].chat }, atDay: null, source: "live-event", readDate: null });
// E9 as health21-v2 froze it: chat WITH LinkedIn on the peers' side.
// live: 100/75 → 1.333, 160/135 → 1.185, both → 1.259, score 63
// watch 40 × 0.7 + live 63 × 0.3 = 46.9 → 47
const V2_ENTRY = {
  ep: 9, slug: "e9", premiere: premiere(4), algorithm: "health21-v2",
  windowIds: ["e5", "e6", "e7", "e8", "e9"], excluded: [], readDays: 21, atDay: 21, frozenAtDay: 21.3,
  readCompleteOn: "2026-02-25", score: 47,
  checks: {
    watch: { value: 800, typical: 1000, ratio: 0.8, score: 40, sample: 4, peers: [0, 1, 2, 3].map((i) => ({ slug: `e${FIRST + i}`, value: 1000, atDay: 21, source: "snapshot", readDate: "2026-01-28" })), reason: null, atDay: 21, ageBasis: "sameAge", note: B.NOTES.sameAge, excluded: [], weight: 0.7 },
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
const v3 = rederive.entry(structuredClone(V2_ENTRY), "health21-v3");
const STAMPS = { rederivedFrom: "health21-v2", rederivedAt: "2026-09-30T14:00:00.000Z" };
const V3_TEXT = storeText("health21-v3", [v3], STAMPS);
{
  assert.equal(ALGORITHM, "health21-v4");
  assert.deepEqual(rederivePath("health21-v2", "health21-v3"), ["health21-v2", "health21-v3"]);
  assert.deepEqual(rederivePath("health21-v2", "health21-v4"), ["health21-v2", "health21-v3", "health21-v4"]);
  assert.throws(() => rederivePath("health21-v1", "health21-v3"), /no declared re-derive/, "v1 → v2 was never declared; history is not rewritten");
  assert.equal(REDERIVES["health21-v3"].from, "health21-v2");
  assert.equal(REDERIVES["health21-v4"].from, "health21-v3");

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
  assert.equal(frozenRatingBytes(V3_TEXT).get("e9"), ratingEntryBytes(v3), "entry bytes are exactly what ratings.mjs writes");

  // the guard: exactly the declared re-derive passes
  assert.equal(assertFrozenRatingsUnchanged(V2_TEXT, V3_TEXT, { rederive }), 1);
  // … and within v3 every frozen byte is locked again
  assert.equal(assertFrozenRatingsUnchanged(V3_TEXT, V3_TEXT, { rederive }), 1);
  assert.throws(() => assertFrozenRatingsUnchanged(V3_TEXT, V3_TEXT.replace('"score": 48', '"score": 49'), { rederive }), /frozen rating bytes changed/);

  const edit = (fn) => { const e = structuredClone(v3); fn(e); return e; };
  const refused = {
    "no declared re-derive given": [V3_TEXT, {}],
    "rederivedFrom names the wrong rules": [storeText("health21-v3", [v3], { ...STAMPS, rederivedFrom: "health21-v1" }), { rederive }],
    "no rederivedAt": [storeText("health21-v3", [v3], { rederivedFrom: "health21-v2" }), { rederive }],
    "a carried check edited": [storeText("health21-v3", [edit((e) => { e.checks.watch.score = 41; })], STAMPS), { rederive }],
    "the earlier score misreported": [storeText("health21-v3", [edit((e) => { e.rederivedFrom.score = 50; })], STAMPS), { rederive }],
    "a from-scratch recompute (new freeze time)": [storeText("health21-v3", [edit((e) => { e.frozenAt = e.computedAt = "2026-09-30T14:00:00.000Z"; })], STAMPS), { rederive }],
    "the entry unfrozen": [storeText("health21-v3", [edit((e) => { delete e.frozenAt; })], STAMPS), { rederive }],
    "the entry dropped": [storeText("health21-v3", [], STAMPS), { rederive }],
    "an undeclared algorithm": [storeText("health21-v9", [edit((e) => { e.algorithm = "health21-v9"; })], { ...STAMPS, rederivedFrom: "health21-v3" }), { rederive }],
  };
  for (const [why, [text, options]] of Object.entries(refused)) assert.throws(() => assertFrozenRatingsUnchanged(V2_TEXT, text, options), /frozen rating/, why);

  // a live file that no longer matches what the entry froze with stops the re-derive
  const moved = declaredRederive([...eps.slice(0, 4), episode(4, { peak: 100, chat: 161, li: undefined })]);
  assert.throws(() => moved.entry(structuredClone(V2_ENTRY), "health21-v3"), /values differ from the live-event file/);
  const movedPeer = declaredRederive([episode(0, { peak: 61, chat: 200, li: 20 }), ...eps.slice(1)]);
  assert.throws(() => movedPeer.entry(structuredClone(V2_ENTRY), "health21-v3"), /peer e5 differs/);

  // the outlier verdicts the entry froze with decide peers, with their reasons —
  // never today's flags
  const flaggedEntry = { ...structuredClone(V2_ENTRY), excluded: [{ slug: "e7", why: "known newsletter promotion" }] };
  flaggedEntry.checks.live.peers = flaggedEntry.checks.live.peers.filter((p) => p.slug !== "e7");
  const kept = rederive.entry(flaggedEntry, "health21-v3").checks.live;
  assert.deepEqual(kept.peers.map((p) => p.slug), ["e5", "e6", "e8"]);
  assert.deepEqual(kept.excluded, [{ slug: "e7", why: "known newsletter promotion" }]);
  assert.deepEqual(kept.typical, { peak: 70, chat: 140 });

  // an entry that froze with no live session keeps that: no new input rides in
  const noLive = { ...structuredClone(V2_ENTRY), checks: { ...structuredClone(V2_ENTRY.checks), live: absent() } };
  assert.equal(JSON.stringify(rederive.entry(noLive, "health21-v3").checks.live), JSON.stringify(absent()));

  // E5–E8 are all on E9's side of the break, so v4 moves nothing but the stamps
  const v4 = rederive.entry(structuredClone(V2_ENTRY), ALGORITHM);
  assert.equal(JSON.stringify(v4.checks), JSON.stringify(v3.checks), "one side of the break: the v3 live check stands");
  assert.equal(v4.score, 48);
  assert.deepEqual(v4.rederivedFrom, { algorithm: "health21-v3", score: 48 }, "a chain of steps names the immediately earlier rules");
}

// --- 4. health21-v4: one side of the known break ---
// Restream counted YouTube's live viewers alone before E5, so E1–E4's peaks
// are lower than they would have been with X: against all seven earlier
// episodes E8's live check reads 63, against the three on its side 50.
const SIDE = [
  { peak: 40, chat: 100 }, { peak: 50, chat: 120 }, { peak: 60, chat: 140 }, { peak: 50, chat: 90 }, // E1–E4: YouTube's viewers only
  { peak: 80, chat: 100 }, { peak: 90, chat: 120 }, { peak: 100, chat: 132 }, { peak: 90, chat: 120 }, // E5–E8: X's viewers counted too
].map((live) => ({ ...live, li: undefined }));
const side = SIDE.map((live, i) => episode(i, live, { ep: i + 1, prefix: "s" }));
{
  const brk = B.KNOWN_BREAKS.find((b) => b.measures.includes("peak"));
  assert.equal(brk?.fromEp, 5, "the fixture straddles the real break");
  assert.ok(B.KNOWN_BREAKS.every((b) => !b.measures.includes("messagesPerHour")), "chat is reported on both sides: never split");
  assert.equal(B.sameSideOfBreaks("peak", side[7], side[4]), true);
  assert.equal(B.sameSideOfBreaks("peak", side[7], side[3]), false);
  assert.equal(B.sameSideOfBreaks("peak", side[3], side[0]), true, "before the break, the earlier episodes are its side");
  assert.equal(B.sameSideOfBreaks("messagesPerHour", side[7], side[0]), true, "a measure no break touches compares across");

  // E8: peers E5–E7 only — peak 90 / 90, chat 120 / 120, score 50
  const e8 = scoreEpisode(side[7], side.slice(0, 7), noFlags, noAnalytics).checks.live;
  assert.deepEqual(e8.peers.map((p) => p.slug), ["s5", "s6", "s7"]);
  assert.deepEqual(e8.typical, { peak: 90, chat: 120 });
  assert.equal(e8.ratio, 1);
  assert.equal(e8.score, 50);
  // E7: only E5 and E6 on its side — absent, and the break is the reason
  const e7 = scoreEpisode(side[6], side.slice(0, 6), noFlags, noAnalytics).checks.live;
  assert.equal(e7.ratio, null);
  assert.equal(e7.sample, 2);
  assert.equal(e7.reason, B.NOTE_BREAK("peak"));
  // two peers in a window that never crosses the break keep the plain reason
  assert.equal(scoreEpisode(side[6], side.slice(4, 6), noFlags, noAnalytics).checks.live.reason, B.NOTES.fewPeers);
  // E4: before the break its side is E1–E3 — peak 50 / 50, chat 90 / 120, score 44
  const e4 = scoreEpisode(side[3], side.slice(0, 3), noFlags, noAnalytics).checks.live;
  assert.deepEqual(e4.peers.map((p) => p.slug), ["s1", "s2", "s3"]);
  assert.equal(e4.ratio, 0.875);
  assert.equal(e4.score, 44);
}

const sidePeer = (i) => ({ slug: `s${i + 1}`, value: { peak: SIDE[i].peak, chat: SIDE[i].chat }, atDay: null, source: "live-event", readDate: null });
const sideCheck = (n, value, typical, score, weight) => ({ value, typical, ratio: B.round3(value / typical), score, sample: n,
  peers: [...Array(n).keys()].map((i) => ({ slug: `s${i + 1}`, value: typical, atDay: 21, source: "snapshot", readDate: "2026-02-04" })),
  reason: null, atDay: 21, ageBasis: "sameAge", note: B.NOTES.sameAge, excluded: [], weight });
const frozenSide = (i, extra) => ({
  ep: i + 1, slug: `s${i + 1}`, premiere: premiere(i), algorithm: "health21-v3",
  windowIds: [...Array(i + 1).keys()].map((k) => `s${k + 1}`), excluded: [], readDays: 21, atDay: 21, frozenAtDay: 21.2,
  readCompleteOn: "2026-03-01", ...extra,
});
// E8 as health21-v3 froze it (re-derived from v2 before): live peers E1–E7
// live: peaks → 60, chat → 120; 90/60 → 1.5, 120/120 → 1, both 1.25, score 63
// watch 40 × 0.7 + live 63 × 0.3 = 46.9 → 47
const V3_E8 = frozenSide(7, {
  score: 47,
  checks: {
    watch: sideCheck(7, 800, 1000, 40, 0.7), engagement: absent(), retention: absent(),
    live: { value: { peak: 90, chat: 120 }, typical: { peak: 60, chat: 120 }, ratio: 1.25, score: 63, sample: 7, peers: [0, 1, 2, 3, 4, 5, 6].map(sidePeer), reason: null, ageBasis: "ageFree", note: B.NOTES.liveChat, excluded: [], weight: 0.3 },
    conversion: absent(), sentiment: absent(),
  },
  missingChecks: ["engagement", "retention", "conversion", "sentiment"], reason: null, reproducible: true,
  computedAt: "2026-03-01T14:00:00.000Z", frozenAt: "2026-03-01T14:00:00.000Z",
  rederivedFrom: { algorithm: "health21-v2", score: 47 },
});
// E7 as v3 froze it: live peers E1–E6 — peaks → 55, chat → 110; 100/55 → 1.818,
// 132/110 → 1.2, both 1.509, score 75; watch 40, engagement 60, live 75 at
// 0.5385 / 0.2308 / 0.2308 → 52.7 → 53
const V3_E7 = frozenSide(6, {
  score: 53,
  checks: {
    watch: sideCheck(6, 800, 1000, 40, 0.5385), engagement: sideCheck(6, 12, 10, 60, 0.2308), retention: absent(),
    live: { value: { peak: 100, chat: 132 }, typical: { peak: 55, chat: 110 }, ratio: 1.509, score: 75, sample: 6, peers: [0, 1, 2, 3, 4, 5].map(sidePeer), reason: null, ageBasis: "ageFree", note: B.NOTES.liveChat, excluded: [], weight: 0.2308 },
    conversion: absent(), sentiment: absent(),
  },
  missingChecks: ["retention", "conversion", "sentiment"], reason: null, reproducible: true,
  computedAt: "2026-02-22T14:00:00.000Z", frozenAt: "2026-02-22T14:00:00.000Z",
});
// E4 as v3 froze it: before the break its peers were already its side
// live: 50/50 → 1, 90/120 → 0.75, both 0.875, score 44; watch 40 × 0.7 + 44 × 0.3 = 41.2 → 41
const V3_E4 = frozenSide(3, {
  score: 41,
  checks: {
    watch: sideCheck(3, 800, 1000, 40, 0.7), engagement: absent(), retention: absent(),
    live: { value: { peak: 50, chat: 90 }, typical: { peak: 50, chat: 120 }, ratio: 0.875, score: 44, sample: 3, peers: [0, 1, 2].map(sidePeer), reason: null, ageBasis: "ageFree", note: B.NOTES.liveChat, excluded: [], weight: 0.3 },
    conversion: absent(), sentiment: absent(),
  },
  missingChecks: ["engagement", "retention", "conversion", "sentiment"], reason: null, reproducible: true,
  computedAt: "2026-02-01T14:00:00.000Z", frozenAt: "2026-02-01T14:00:00.000Z",
});
const sideRederive = declaredRederive(side);
const v4e4 = sideRederive.entry(structuredClone(V3_E4), ALGORITHM);
const v4e7 = sideRederive.entry(structuredClone(V3_E7), ALGORITHM);
const v4e8 = sideRederive.entry(structuredClone(V3_E8), ALGORITHM);
const V3_SIDE_TEXT = storeText("health21-v3", [V3_E4, V3_E7, V3_E8], STAMPS);
const V4_STAMPS = { rederivedFrom: "health21-v3", rederivedAt: "2026-10-12T15:00:00.000Z" };
const V4_SIDE_TEXT = storeText(ALGORITHM, [v4e4, v4e7, v4e8], V4_STAMPS);
{
  // E8: the live check rebuilt from its own side; 40 × 0.7 + 50 × 0.3 = 43
  assert.deepEqual(v4e8.checks.live, { value: { peak: 90, chat: 120 }, typical: { peak: 90, chat: 120 }, ratio: 1, score: 50, sample: 3,
    peers: [4, 5, 6].map(sidePeer), reason: null, ageBasis: "ageFree", note: B.NOTES.liveChat, excluded: [], weight: 0.3 });
  assert.equal(v4e8.score, 43);
  assert.deepEqual(v4e8.rederivedFrom, { algorithm: "health21-v3", score: 47 }, "the earlier stamp is replaced in place");
  assert.deepEqual(Object.keys(v4e8), Object.keys(V3_E8), "key order kept");
  // E7: two on its side — the live check leaves and its weight goes to the
  // other checks: 40 × 0.7 + 60 × 0.3 = 46
  assert.deepEqual(v4e7.checks.live, { value: { peak: 100, chat: 132 }, typical: null, ratio: null, score: null, sample: 2, peers: [],
    reason: B.NOTE_BREAK("peak"), ageBasis: "ageFree", note: B.NOTES.liveChat, excluded: [], weight: 0 });
  assert.equal(v4e7.checks.watch.weight, 0.7);
  assert.equal(v4e7.checks.engagement.weight, 0.3);
  assert.equal(v4e7.score, 46);
  assert.deepEqual(v4e7.missingChecks, ["retention", "live", "conversion", "sentiment"]);
  assert.deepEqual(v4e7.rederivedFrom, { algorithm: "health21-v3", score: 53 });
  for (const c of ["watch", "engagement"]) {
    const { weight: _a, ...was } = V3_E7.checks[c], { weight: _b, ...now } = v4e7.checks[c];
    assert.equal(JSON.stringify(now), JSON.stringify(was), `${c} carried byte for byte apart from its weight`);
  }
  // E4: before the break nothing in its checks moves, only the stamps
  assert.equal(JSON.stringify(v4e4.checks), JSON.stringify(V3_E4.checks));
  assert.equal(v4e4.score, 41);
  assert.deepEqual(v4e4.rederivedFrom, { algorithm: "health21-v3", score: 41 });
  assert.equal(V3_E7.checks.live.weight, 0.2308, "the frozen input is not mutated");

  // the guard accepts exactly the declared v3 → v4 step …
  assert.equal(assertFrozenRatingsUnchanged(V3_SIDE_TEXT, V4_SIDE_TEXT, { rederive: sideRederive }), 3);
  assert.equal(assertFrozenRatingsUnchanged(V4_SIDE_TEXT, V4_SIDE_TEXT, { rederive: sideRederive }), 3);
  // … and nothing else
  const relabelled = { ...structuredClone(V3_E7), algorithm: ALGORITHM, rederivedFrom: { algorithm: "health21-v3", score: 53 } };
  const editV4 = (entry, fn) => { const e = structuredClone(entry); fn(e); return e; };
  const refusedV4 = {
    "the cross-break live check kept under v4": storeText(ALGORITHM, [v4e4, relabelled, v4e8], V4_STAMPS),
    "rederivedFrom skips v3": storeText(ALGORITHM, [v4e4, v4e7, v4e8], { ...V4_STAMPS, rederivedFrom: "health21-v2" }),
    "a carried check re-weighted by hand": storeText(ALGORITHM, [v4e4, editV4(v4e7, (e) => { e.checks.engagement.weight = 0.35; }), v4e8], V4_STAMPS),
    "a rebuilt live check edited": storeText(ALGORITHM, [v4e4, v4e7, editV4(v4e8, (e) => { e.checks.live.score = 51; })], V4_STAMPS),
    "the earlier score dropped": storeText(ALGORITHM, [v4e4, v4e7, editV4(v4e8, (e) => { delete e.rederivedFrom; })], V4_STAMPS),
  };
  for (const [why, text] of Object.entries(refusedV4)) assert.throws(() => assertFrozenRatingsUnchanged(V3_SIDE_TEXT, text, { rederive: sideRederive }), /frozen rating/, why);
  // v3 stored the peak and the compared chat; a live file that moved since stops the step
  const movedSide = declaredRederive(side.map((e, i) => (i === 4 ? episode(4, { peak: 81, chat: 100, li: undefined }, { ep: 5, prefix: "s" }) : e)));
  assert.throws(() => movedSide.entry(structuredClone(V3_E8), ALGORITHM), /peer s5 differs/);

  // a store still at v2 replays both declared steps (FROZEN_BASELINE is v2)
  const V2_E8 = { ...structuredClone(V3_E8), algorithm: "health21-v2" };
  delete V2_E8.rederivedFrom;
  const viaV3 = sideRederive.entry(structuredClone(V2_E8), "health21-v3");
  assert.equal(viaV3.score, 47, "v3 still compares across the break");
  const chained = sideRederive.entry(structuredClone(V2_E8), ALGORITHM);
  assert.equal(JSON.stringify(chained), JSON.stringify(sideRederive.entry(viaV3, ALGORITHM)));
  assert.equal(chained.score, 43);
  assert.deepEqual(chained.rederivedFrom, { algorithm: "health21-v3", score: 47 });
}

// --- 5. the Slack line, once ---
{
  const health = (ep, score, was) => ({ ep, slug: `e${ep}`, health: { algorithm: ALGORITHM, score, rederivedFrom: { algorithm: "health21-v3", score: was } } });
  const data = { episodes: [health(4, null, null), health(5, 37, 36), health(6, 37, 38), { ep: 7, slug: "e7", health: { pending: true } }] };
  const state = (rules) => ({ episodeCount: 4, complaints: {}, w1v: {}, staleCount: 0, reviewCount: 0, ...(rules === undefined ? {} : { episodeHealthRules: rules }) });
  const line = (prev) => alertLines(prev, state(ALGORITHM), data).map((l) => l.text).find((t) => t.startsWith("Episode health scoring rules changed"));
  assert.equal(line(state(undefined)), "Episode health scoring rules changed (health21-v3 → health21-v4). Each finished score was re-read from its saved inputs: E5 36 → 37, E6 38 → 37.", "a state saved before the field existed still hears the change");
  assert.ok(line(state("health21-v3")));
  assert.equal(line(state(ALGORITHM)), undefined, "said once");
}

console.log("ratings-rederive.test: one chat definition, live peers on one side of the known break, declared v2 → v3 → v4 re-derives, frozen-bytes guard, Slack line");
