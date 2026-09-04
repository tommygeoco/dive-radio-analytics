// baselines.mjs — the ONE definition of "typical" (PRD v9, rule 16).
//
// Every comparison in this repo — show health, episode health, the page's
// pace and watched-vs-typical, the promo-outlier test, the typical watch
// curve — reads its constants, its peer window, its reading rule, and its
// median from here. Pure functions over the episode array that build-data.mjs
// assembles; no fs, no network, no model. build-data.mjs calls these after
// `latest` is built and projects the result as `data.baselines`; ratings.mjs
// and health.mjs import the same functions. The validator proves single-source
// by fixture equality (audit/baselines.test.mjs), not by grep.
//
// Vocabulary (CLAUDE.md glossary):
//   age          days since the episode's premiere (noon Phoenix)
//   reading      the snapshot / history line nearest a requested age, within a
//                tolerance (snapshots ±0.5 d, analytics history ±1.5 d — the
//                wider tolerance absorbs YouTube's 2–3-day reporting jitter)
//   window       the WINDOW_N most recent episodes before the own episode
//   basis        sameAge | mature | ageFree — how own and peer values line up
//   flagged      promo-driven outlier (a unit > OUTLIER_MULTIPLE × the
//                same-age typical of its window); excluded as a peer elsewhere
//
// Nothing here estimates, interpolates, or zero-fills: a reading that does not
// exist is null, a peer set below MIN_PEERS is `{typical: null, reason}`.

export const WINDOW_N = 8;          // D2: typical = the last eight comparable episodes
export const MIN_PEERS = 3;         // rule 13 — per measure
export const SLOPE_N = 5;           // growth: first-week slope over the last five clean weeks
export const QUIET_ZONE_PCT = 5;    // ▲/▼ only outside ±5 %
export const BANDS = Object.freeze({ healthy: 55, steady: 45 });
export const MATURITY_DAYS = Object.freeze({ analytics: 21, xAnnounce: 7 });
export const READ_DAYS = 21;        // episode-health read window (measured flatline point)
export const OUTLIER_MULTIPLE = 2;
export const SNAPSHOT_TOL = 0.5;
export const HISTORY_TOL = 1.5;
// PRD v10 (2026-09-01): direction, carried reads, launch reads, cool-off
export const TREND_N = 5;           // direction: the last five clean episodes, in air order
export const TREND_MIN_WORD = 4;    // a direction WORD needs four episodes; three show the slope only (one episode can be the slope)
export const CARRIED_WEIGHT = 0.5;  // a measure read from an older episode than the newest counts half
export const LAUNCH_AGE = 7;        // launch read: YouTube views at the end of the first week
export const COOL_SPAN_DAYS = 2;    // cool-off: the newest episode's growth over its last two days
// PRD v10 addendum (2026-09-01 evening, rule 23): bands adapt to the show's
// own swing on each check, live turnout and participation read the whole
// live session, reach reads YouTube discovery
export const SWING_MIN_PCT = 10;    // a check's band is never narrower than ±10 % (the fixed bands: 45 / 55)
export const SWING_MAX_PCT = 30;    // and never wider than ±30 %, so a noisy measure can still read fragile or healthy
export const HOLD_MINUTES = 10;     // hold rate: the live audience over the last ten minutes against the peak
export const DISCOVERY_SOURCES = Object.freeze(["YT_SEARCH", "RELATED_VIDEO", "SHORTS", "BROWSE"]); // YouTube found it for the viewer

export const CONSTANTS = Object.freeze({
  WINDOW_N, MIN_PEERS, SLOPE_N, QUIET_ZONE_PCT, BANDS, MATURITY_DAYS, READ_DAYS,
  OUTLIER_MULTIPLE, SNAPSHOT_TOL, HISTORY_TOL, TREND_N, TREND_MIN_WORD, CARRIED_WEIGHT, LAUNCH_AGE, COOL_SPAN_DAYS,
  SWING_MIN_PCT, SWING_MAX_PCT, HOLD_MINUTES, DISCOVERY_SOURCES,
});

export const NOTES = Object.freeze({
  sameAge: "compared at the same age",
  mature: "compared with earlier episodes as they stand now, not at the same age",
  fewPeers: "Fewer than three earlier episodes to compare with.",
  youngAge: (n) => `Only ${n} earlier episode${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} tracked this early; at least three are needed.`,
  noReadingAtAge: "Fewer than three earlier episodes have a reading at this age.",
  readFrom: (title) => `read from ${title}, the latest finished episode`,
  // PRD v10: a flagged unit's own lift is shown but never scored; a measure
  // read from an older episode than the newest is carried at half weight
  promoQualified: "promo-driven lift — shown, not scored",
  carried: (title) => `carried from ${title}, the latest finished episode — counted at half weight`,
  provisional: "an early read — the episode is under a week old",
  noYtReading: "YouTube views are not available yet.",
  noFullDayReading: "The first full-day reading arrives after air day.",
  noLaunchReading: "No reading at the launch age.",
  fewForWord: "Three episodes show the slope; a direction word needs four.",
  readFromPromo: (title) => `read from ${title}, the latest finished episode — the newest episode's own read is promo-driven`,
  // rule 23: the show's usual swing on a measure, worded once for the click layer
  swing: (pct) => `the show’s usual swing on this is about ±${pct}%`,
});
// check states (rule 23): one place, the writer stamps them, the page and the
// verifier copy them
export const STATE_WORDS = Object.freeze({ healthy: "healthy", steady: "steady", fragile: "fragile", waiting: "waiting" });

// direction words (PRD v10): one place, the page and Slack copy them verbatim
export const DIRECTION_WORDS = Object.freeze({ building: "building", holding: "holding", softening: "softening", mixed: "mixed" });
export const LAUNCH_WORDS = Object.freeze({ strong: "strong", typical: "typical", soft: "soft" });
export const COOL_WORDS = Object.freeze({ building: "still building", usual: "cooling as usual", faster: "cooling faster" });

const DAY = 86400000;
const PHX_OFFSET = 7 * 3600000;
export const YT_KEYS = ["yt:joindiveclub", "yt:designertom"];
export const X_KEYS = ["x:ridd_design", "x:designertom"];

export function premiereMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) + PHX_OFFSET;
}

export function ageDaysOf(ts, premiere) {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  return (t - premiereMs(premiere)) / DAY;
}

export function phoenixDateOf(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(t) ? new Date(t - PHX_OFFSET).toISOString().slice(0, 10) : null;
}

// Historical analysis starts with the first snapshot on the Phoenix date
// after the show airs. Air-date counters remain valid current facts, but they
// are never "day one" and cannot enter comparisons, health, or ratings.
export function historicalSnapshotsOf(episode) {
  if (!episode?.premiere) return [];
  return (episode.snapshots || []).filter((snap) => phoenixDateOf(snap?.ts) > episode.premiere);
}

export const round1 = (x) => Math.round(x * 10) / 10;
export const round3 = (x) => Math.round(x * 1000) / 1000;

export function trueMedian(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export function scoreOf(own, typical) {
  if (!Number.isFinite(own) || !Number.isFinite(typical) || typical <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, (50 * own) / typical)));
}

// --- reading rule ---------------------------------------------------------

// The reading whose age is nearest `ageDays` within ±tol; ties → the earlier.
export function readingAt(series, ageDays, tol, ageOf) {
  let best = null;
  let bestDist = Infinity;
  for (const item of series || []) {
    const a = ageOf(item);
    if (!Number.isFinite(a)) continue;
    const dist = Math.abs(a - ageDays);
    if (dist > tol + 1e-9) continue;
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && a < ageOf(best))) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

export function snapshotAt(episode, ageDays) {
  return readingAt(historicalSnapshotsOf(episode), ageDays, SNAPSHOT_TOL, (s) => ageDaysOf(s.ts, episode.premiere));
}

export function historyAt(lines, ageDays) {
  return readingAt(lines, ageDays, HISTORY_TOL, (l) => l.ageDays);
}

export function currentAge(episode) {
  const last = historicalSnapshotsOf(episode).at(-1);
  return last ? ageDaysOf(last.ts, episode.premiere) : null;
}

// --- per-snapshot values ---------------------------------------------------

// YouTube sometimes returns an all-zero public-stat row before it has published
// a real view count. That row is not the episode's first reading: it must not
// set an age, enter a peer window, or lower a typical. A zero companion channel
// is still valid once either channel has a positive count.
export const hasYtReading = (snap) => YT_KEYS.some((k) => Number.isFinite(snap?.byDest?.[k]?.views) && snap.byDest[k].views > 0);
export const ytViewsOf = (snap) => hasYtReading(snap)
  ? YT_KEYS.reduce((a, k) => a + (Number.isFinite(snap?.byDest?.[k]?.views) ? snap.byDest[k].views : 0), 0)
  : null;
export const ytEngagementOf = (snap) => hasYtReading(snap)
  ? YT_KEYS.reduce((a, k) => a + (Number.isFinite(snap?.byDest?.[k]?.likes) ? snap.byDest[k].likes : 0) + (Number.isFinite(snap?.byDest?.[k]?.comments) ? snap.byDest[k].comments : 0), 0)
  : null;
export const xImpressionsOf = (snap) => X_KEYS.reduce((a, k) => a + (snap?.byDest?.[k]?.views || 0), 0);

// Current cards may use a real post-premiere count on air day. Historical
// selectors add the stricter next-Phoenix-date gate above.
export function currentYtSnapshotsOf(episode) {
  if (!episode?.premiere) return [];
  return (episode.snapshots || []).filter((snap) => {
    if (!hasYtReading(snap)) return false;
    const age = ageDaysOf(snap.ts, episode.premiere);
    return Number.isFinite(age) && age >= 0;
  });
}

export function latestCurrentYtSnapshot(episode) {
  return currentYtSnapshotsOf(episode).at(-1) || null;
}

export function ytSnapshotsOf(episode) {
  const historical = new Set(historicalSnapshotsOf(episode));
  return currentYtSnapshotsOf(episode).filter((snap) => historical.has(snap));
}

export function ytSnapshotAt(episode, ageDays) {
  return readingAt(ytSnapshotsOf(episode), ageDays, SNAPSHOT_TOL, (s) => ageDaysOf(s.ts, episode.premiere));
}

export function firstYtSnapshot(episode) {
  return ytSnapshotsOf(episode)[0] || null;
}

export function latestYtSnapshot(episode) {
  return ytSnapshotsOf(episode).at(-1) || null;
}

export function ytCurrentAge(episode) {
  const last = latestYtSnapshot(episode);
  return last ? ageDaysOf(last.ts, episode.premiere) : null;
}

export const hasYtHistoryReading = (line, premiere = null) => Number.isFinite(line?.ageDays) && line.ageDays >= 0
  && (!premiere || (typeof line?.date === "string" && line.date > premiere))
  && YT_KEYS.some((k) => Number.isFinite(line?.channels?.[k]?.views) && line.channels[k].views > 0);

export function ytHistoryAt(lines, ageDays, premiere = null) {
  return readingAt((lines || []).filter((line) => hasYtHistoryReading(line, premiere)), ageDays, HISTORY_TOL, (l) => l.ageDays);
}

// X plays at a snapshot, only when every X destination that should carry
// plays does (partial sums are never a value). `expected` = number of X keys
// the episode's latest block says are in scope (latest.xPlaysInfo.total).
export function xPlaysOf(snap, expected) {
  const keys = X_KEYS.filter((k) => snap?.byDest?.[k]?.plays != null);
  if (!expected || keys.length < expected) return null;
  return keys.reduce((a, k) => a + snap.byDest[k].plays, 0);
}

export function engagementPer1kOf(snap) {
  const v = ytViewsOf(snap);
  return v > 0 ? round1((ytEngagementOf(snap) / v) * 1000) : null;
}

// --- window and peers ------------------------------------------------------

// The WINDOW_N most recent episodes before `own` (premiere order). With
// {side: "either"} the WINDOW_N nearest by premiere distance on both sides
// (the outlier test, which is descriptive, may look forward; frozen scores
// never do).
export function windowFor(own, episodes, { side = "before", n = WINDOW_N } = {}) {
  const sorted = [...episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : a.premiere > b.premiere ? 1 : 0));
  const idx = sorted.findIndex((e) => e.slug === own.slug);
  if (idx < 0) return [];
  if (side === "before") return sorted.slice(Math.max(0, idx - n), idx);
  const others = sorted.map((e, i) => ({ e, dist: Math.abs(i - idx), i })).filter((o) => o.i !== idx);
  others.sort((a, b) => a.dist - b.dist || a.i - b.i);
  return others.slice(0, n).map((o) => o.e).sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
}

// Which promo flag contaminates which family of measures (PRD v10, rule 12
// as amended): a lift on YouTube views spoils every view-based comparison,
// a lift on X reach or plays every reach-based one; the live room carries
// no flagged unit, so a live night is never excluded for a promo elsewhere.
// `units` undefined = the episode-level rule (any flag), kept only for the
// frozen episode-health algorithm.
export const UNIT_FAMILIES = Object.freeze({
  views: ["ytViews"],
  reach: ["xImpressions", "xPlays"],
  live: [],
});
export function flaggedOn(flags, slug, units) {
  const f = flags?.get?.(slug);
  if (!f) return false;
  if (units === undefined) return f.flagged === true;
  return units.some((u) => f.units?.[u]?.flag === true);
}
export function flagReason(flags, slug, units) {
  const f = flags?.get?.(slug);
  if (!f) return "promo outlier";
  const keys = units === undefined ? Object.keys(f.units || {}) : units;
  return keys.some((key) => f.units?.[key]?.flag === true && f.units?.[key]?.source === "newsletter")
    ? "known newsletter promotion"
    : "promo outlier";
}

// Filter a window down to usable peers. `valueOf(peer)` returns the peer's
// value under the measure's basis or null; `coverageOf` (optional) returns a
// coverage key that must match `ownCoverage`; `units` (optional) names the
// promo units that exclude a peer (see UNIT_FAMILIES). Returns the peers with
// values, the excluded list with reasons, and the typical (null below MIN_PEERS).
export function peersFor({ own, window, flags, valueOf, coverageOf = null, ownCoverage = null, minPeers = MIN_PEERS, units = undefined }) {
  const peers = [];
  const excluded = [];
  for (const p of window) {
    if (p.slug === own.slug) continue;
    if (flaggedOn(flags, p.slug, units)) { excluded.push({ slug: p.slug, why: flagReason(flags, p.slug, units) }); continue; }
    if (coverageOf && coverageOf(p) !== ownCoverage) { excluded.push({ slug: p.slug, why: "different comment coverage" }); continue; }
    const v = valueOf(p);
    if (!Number.isFinite(v)) { excluded.push({ slug: p.slug, why: "no reading at this age" }); continue; }
    peers.push({ slug: p.slug, value: v });
  }
  const typical = peers.length >= minPeers ? trueMedian(peers.map((p) => p.value)) : null;
  return {
    peers,
    excluded,
    n: peers.length,
    typical: Number.isFinite(typical) ? round1(typical) : null,
    reason: peers.length >= minPeers ? null : NOTES.fewPeers,
  };
}

// --- promo-outlier test (three tiers, evaluated once per build, premiere order) ---
//
// tier 1  settled:     own reading at READ_DAYS vs peers' readings at READ_DAYS
// tier 2  provisional: own current age vs peers' readings at that age
// tier 3  provisional: own latest value vs peers' latest values (the pre-v7
//                      lifetime test, window-limited) — used only when neither
//                      same-age tier has MIN_PEERS peers, so a known outlier
//                      never silently un-flags while history is thin
// A flagged episode is excluded as a peer for every other typical in the build.
const UNITS = [
  { key: "ytViews", label: "YT views", at: (e, snap) => ytViewsOf(snap), latest: (e) => ytViewsOf(latestYtSnapshot(e)), snapshot: ytSnapshotAt },
  { key: "xPlays", label: "X plays", at: (e, snap) => xPlaysOf(snap, e.latest?.xPlaysInfo?.total), latest: (e) => (e.latest?.xPlaysInfo?.partial === false && e.latest?.xPlaysInfo?.stale === false ? e.latest.xPlays : null) },
  { key: "xImpressions", label: "X reach", at: (e, snap) => xImpressionsOf(snap), latest: (e) => e.latest?.xImpressions },
];

const fmt = (n) => Math.round(n).toLocaleString("en-US");

export function anomalyFlags(episodes, { minPeers = MIN_PEERS } = {}) {
  const sorted = [...episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  const flags = new Map();
  for (const e of sorted) {
    const window = windowFor(e, sorted, { side: "either" });
    const units = {};
    const hits = [];
    const knownHits = [];
    let provisional = false;
    for (const unit of UNITS) {
      if (e.promotion?.status === "found" && e.promotion?.matchedUnits?.includes(unit.key) && historicalSnapshotsOf(e).length > 0) {
        units[unit.key] = {
          tier: "known-promotion",
          value: unit.latest(e),
          typical: null,
          n: 0,
          window: [],
          flag: true,
          source: "newsletter",
        };
        knownHits.push(`${e.promotion.source || "UX Tools"} email linked the ${unit.key === "ytViews" ? "YouTube upload" : "X broadcast"}`);
        continue;
      }
      const tryTier = (tier, ownValue, peerValueOf) => {
        if (!Number.isFinite(ownValue)) return null;
        const usable = window.filter((p) => !flaggedOn(flags, p.slug, [unit.key]));
        const peers = usable.map((p) => ({ slug: p.slug, value: peerValueOf(p) })).filter((p) => Number.isFinite(p.value));
        if (peers.length < minPeers) return null;
        const typical = trueMedian(peers.map((p) => p.value));
        if (!(typical > 0)) return null;
        return { tier, value: ownValue, typical: round1(typical), n: peers.length, window: peers.map((p) => p.slug), flag: ownValue > OUTLIER_MULTIPLE * typical };
      };
      const age = currentAge(e);
      let result = null;
      if (Number.isFinite(age) && age >= READ_DAYS) {
        const at = unit.snapshot || snapshotAt;
        const ownSnap = at(e, READ_DAYS);
        result = ownSnap ? tryTier(1, unit.at(e, ownSnap), (p) => { const s = at(p, READ_DAYS); return s ? unit.at(p, s) : null; }) : null;
      }
      if (!result && Number.isFinite(age)) {
        const at = unit.snapshot || snapshotAt;
        const ownAge = unit.key === "ytViews" ? ytCurrentAge(e) : age;
        const ownSnap = Number.isFinite(ownAge) ? at(e, ownAge) : null;
        result = ownSnap ? tryTier(2, unit.at(e, ownSnap), (p) => { const s = at(p, ownAge); return s ? unit.at(p, s) : null; }) : null;
      }
      if (!result && Number.isFinite(age)) result = tryTier(3, unit.latest(e), (p) => unit.latest(p));
      units[unit.key] = result || { tier: null, value: null, typical: null, n: 0, window: [], flag: false };
      if (result?.flag) {
        hits.push(`${fmt(result.value)} ${unit.label} vs a typical ${fmt(result.typical)}`);
        if (result.tier !== 1) provisional = true;
      }
    }
    const flagged = hits.length > 0;
    const knownPromotion = knownHits.length > 0;
    const anyFlagged = flagged || knownPromotion;
    flags.set(e.slug, {
      flagged: anyFlagged,
      provisional: flagged && provisional,
      knownPromotion,
      units,
      text: anyFlagged ? `${[...knownHits, ...(hits.length ? [`more than double what a typical episode gets (${hits.join("; ")})`] : [])].join("; ")} — treat the affected viewing numbers as a promo-driven outlier, not topic signal` : null,
    });
  }
  return flags;
}

// --- direction (PRD v10) ---------------------------------------------------
//
// The median of the pairwise slopes of ln(value) over episode number — the
// Theil–Sen estimate — as percent change per episode. Gap-aware (episode
// numbers are the x axis, so E3–E5 missing means a five-episode span, not a
// two-step one) and robust to one odd episode. MIN_PEERS points or nothing.
export function theilSenPctPerEpisode(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.ep)).sort((a, b) => a.ep - b.ep);
  if (pts.length < MIN_PEERS) return null;
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (pts[j].ep === pts[i].ep) continue;
      slopes.push((Math.log(pts[j].value) - Math.log(pts[i].value)) / (pts[j].ep - pts[i].ep));
    }
  }
  const slope = trueMedian(slopes);
  return Number.isFinite(slope) ? round1((Math.exp(slope) - 1) * 100) : null;
}

// the quiet zone is the one gate between a direction word and "holding"
export function directionOf(pctPerEpisode) {
  if (!Number.isFinite(pctPerEpisode)) return null;
  if (pctPerEpisode > QUIET_ZONE_PCT) return DIRECTION_WORDS.building;
  if (pctPerEpisode < -QUIET_ZONE_PCT) return DIRECTION_WORDS.softening;
  return DIRECTION_WORDS.holding;
}

// One measure's direction over the last TREND_N episodes (air order) that
// carry a value. `valueOf(episode)` returns the like-for-like value or null —
// the caller decides which episodes qualify (a flagged episode never does).
// Every series carries ONE basis (rule 11) and its fixed note (rule 17): a
// day-7 or air-night reading is sameAge/ageFree; a lifetime-to-date value
// read past its maturity age is mature — "as they stand now". A direction
// WORD needs TREND_MIN_WORD points; with three, one episode can be the slope,
// so the slope is shown and the word withheld.
export function trendFor(key, episodes, valueOf, { n = TREND_N, basis = "ageFree", check = null, minWord = TREND_MIN_WORD } = {}) {
  const sorted = [...episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : a.premiere > b.premiere ? 1 : 0));
  const all = sorted.map((e, i) => ({ slug: e.slug, ep: Number.isFinite(e.ep) ? e.ep : i + 1, value: valueOf(e) }))
    .filter((p) => Number.isFinite(p.value) && p.value > 0);
  const points = all.slice(-n).map((p) => ({ slug: p.slug, ep: p.ep, value: round1(p.value) }));
  const pctPerEpisode = theilSenPctPerEpisode(points);
  const enough = points.length >= minWord;
  return {
    key,
    check,
    n: points.length,
    pctPerEpisode,
    direction: enough ? directionOf(pctPerEpisode) : null,
    ageBasis: pctPerEpisode == null ? null : basis,
    note: pctPerEpisode == null ? null : (NOTES[basis] ?? null),
    points,
    reason: pctPerEpisode == null ? NOTES.fewPeers : (enough ? null : NOTES.fewForWord),
  };
}

// One vote per check (a check's series agree by majority; a series without a
// word does not vote). The overall word is a single word only when one side
// carries every vote; "mixed" whenever both sides carry one; "holding" when
// every vote is holding; null with no votes at all. Correlated series (two
// chat measures, two turnout measures) therefore never outvote a check.
export function checkVotes(trends) {
  const byCheck = new Map();
  for (const t of trends || []) {
    if (!t?.direction) continue;
    const check = t.check || t.key;
    if (!byCheck.has(check)) byCheck.set(check, []);
    byCheck.get(check).push(t.direction);
  }
  return [...byCheck.entries()].map(([check, words]) => {
    const up = words.filter((w) => w === DIRECTION_WORDS.building).length;
    const down = words.filter((w) => w === DIRECTION_WORDS.softening).length;
    const direction = up > down ? DIRECTION_WORDS.building : down > up ? DIRECTION_WORDS.softening : (up > 0 ? DIRECTION_WORDS.mixed : DIRECTION_WORDS.holding);
    return { check, direction, measures: words.length };
  });
}
export function overallDirection(trends) {
  const votes = checkVotes(trends).map((v) => v.direction);
  if (!votes.length) return null;
  const up = votes.filter((w) => w === DIRECTION_WORDS.building).length;
  const down = votes.filter((w) => w === DIRECTION_WORDS.softening).length;
  const mixed = votes.filter((w) => w === DIRECTION_WORDS.mixed).length;
  if (up > 0 && down === 0 && mixed === 0) return DIRECTION_WORDS.building;
  if (down > 0 && up === 0 && mixed === 0) return DIRECTION_WORDS.softening;
  if (up === 0 && down === 0 && mixed === 0) return DIRECTION_WORDS.holding;
  return DIRECTION_WORDS.mixed;
}

// subscribers gained per thousand analytics views, both channels required
// (the ONE definition; ratings.mjs and health.mjs read it)
export function subsPer1kOf(channels) {
  let subs = 0, views = 0;
  for (const key of YT_KEYS) {
    const t = channels?.[key]?.totals ?? channels?.[key];
    if (!t || !Number.isFinite(t.subscribersGained) || !Number.isFinite(t.views)) return null;
    subs += t.subscribersGained; views += t.views;
  }
  return views > 0 ? (subs / views) * 1000 : null;
}

// --- the DIRECTION lens (PRD v10 rule 20) — computed here, once, by build-data;
// health.mjs copies the served block into its entry ---
//
// An episode flagged on a unit is out of every series in that unit's family
// (UNIT_FAMILIES) — the same rule the NOW lens applies to its typicals — so
// the two lenses never disagree about who counts, and a promo spike on X
// never silences a live night. Accessors default to the fields build-data
// attaches.
export const TREND_MEASURES = Object.freeze([
  { key: "firstWeek", check: "growth", basis: "ageFree", family: "views" },
  { key: "engagementWeekOne", check: "audienceQuality", basis: "sameAge", family: "views" },
  { key: "watching", check: "audienceQuality", basis: "mature", family: "views" },
  { key: "exposureWeekOne", check: "reachEfficiency", basis: "sameAge", family: "reach" },
  { key: "announceToPlay", check: "reachEfficiency", basis: "mature", family: "reach" },
  { key: "discoveryShare", check: "reachEfficiency", basis: "mature", family: "views" },
  { key: "liveAverage", check: "livePull", basis: "ageFree", family: "live" },
  { key: "livePeak", check: "livePull", basis: "ageFree", family: "live" },
  { key: "liveViewers", check: "livePull", basis: "ageFree", family: "live" },
  { key: "minutesWatched", check: "livePull", basis: "ageFree", family: "live" },
  { key: "chattersPer100", check: "participation", basis: "ageFree", family: "live" },
  { key: "messagesPerHour", check: "participation", basis: "ageFree", family: "live" },
  { key: "minutesPerViewer", check: "participation", basis: "ageFree", family: "live" },
  { key: "holdRate", check: "participation", basis: "ageFree", family: "live" },
  { key: "subscribers", check: "conversion", basis: "mature", family: "views" },
]);
export function computeDirection(episodes, flags, {
  weekValueOf = (e) => (Number.isFinite(e.metrics?.week1Velocity) ? e.metrics.week1Velocity : null),
  watchOf = (e) => (Number.isFinite(e.watch?.avgPercent) ? e.watch.avgPercent : null),
  subsOf = (e) => (Number.isFinite(e.subsPer1k) ? e.subsPer1k : null),
  discoveryOf = (e) => (Number.isFinite(e.discoveryShare) ? e.discoveryShare : null),
} = {}) {
  const cleanFor = (family) => (e) => !flaggedOn(flags, e.slug, UNIT_FAMILIES[family]);
  const views = cleanFor("views"), reach = cleanFor("reach"), live = cleanFor("live");
  const dayValue = (e, A, pick, at = snapshotAt) => { const s = at(e, A); return s ? pick(s) : null; };
  const finished = (e) => (currentAge(e) ?? 0) >= MATURITY_DAYS.xAnnounce && Number.isFinite(e.latest?.xPlays)
    && e.latest?.xPlaysInfo?.partial === false && e.latest?.xPlaysInfo?.stale === false && e.latest?.xImpressions > 0;
  const mature = (e) => (currentAge(e) ?? 0) >= MATURITY_DAYS.analytics;
  const valueOf = {
    firstWeek: (e) => (views(e) ? weekValueOf(e) : null),
    engagementWeekOne: (e) => (views(e) && !e.partialHistory ? dayValue(e, MATURITY_DAYS.xAnnounce, ytEngagementOf, ytSnapshotAt) : null),
    watching: (e) => (views(e) && mature(e) ? watchOf(e) : null),
    exposureWeekOne: (e) => (reach(e) && !e.partialHistory ? dayValue(e, MATURITY_DAYS.xAnnounce, xImpressionsOf) : null),
    announceToPlay: (e) => (reach(e) && finished(e) ? (e.latest.xPlays / e.latest.xImpressions) * 100 : null),
    discoveryShare: (e) => (views(e) && mature(e) ? discoveryOf(e) : null),
    liveAverage: (e) => (live(e) && Number.isFinite(e.live?.avg) ? e.live.avg : null),
    livePeak: (e) => (live(e) && Number.isFinite(e.live?.peak) ? e.live.peak : null),
    liveViewers: (e) => (live(e) && comparableAcrossBreaks("liveViewers", e) && Number.isFinite(e.live?.liveViews) && e.live.liveViews > 0 ? e.live.liveViews : null),
    minutesWatched: (e) => (live(e) && Number.isFinite(e.live?.watchedMin) && e.live.watchedMin > 0 ? e.live.watchedMin : null),
    chattersPer100: (e) => (live(e) ? liveRatesOf(e)?.chattersPer100 ?? null : null),
    messagesPerHour: (e) => (live(e) ? liveRatesOf(e)?.messagesPerHour ?? null : null),
    minutesPerViewer: (e) => (live(e) && comparableAcrossBreaks("minutesPerViewer", e) ? liveDepthOf(e)?.minutesPerViewer ?? null : null),
    holdRate: (e) => (live(e) ? liveDepthOf(e)?.holdRate ?? null : null),
    subscribers: (e) => (views(e) && mature(e) ? subsOf(e) : null),
  };
  const measures = TREND_MEASURES.map((m) => trendFor(m.key, episodes, valueOf[m.key], { basis: m.basis, check: m.check }));
  return { measures, votes: checkVotes(measures), overall: overallDirection(measures) };
}

// --- the OUTLOOK (PRD v10 rule 21): where the last three clean first weeks
// landed, with the first-week direction, and the newest episode's cool-off.
// A description of what happened, never a bound on what will.
export function computeOutlook(episodes, flags, direction) {
  const fw = (direction?.measures || []).find((m) => m.key === "firstWeek");
  const recent = (fw?.points || []).slice(-3);
  const nextFirstWeek = recent.length >= MIN_PEERS ? {
    low: Math.min(...recent.map((p) => p.value)),
    high: Math.max(...recent.map((p) => p.value)),
    typical: trueMedian(recent.map((p) => p.value)),
    n: recent.length,
    window: recent.map((p) => p.slug),
    pctPerEpisode: fw.pctPerEpisode ?? null,
    direction: fw.direction ?? null,
    reason: fw.direction ? null : (fw.reason ?? null),
  } : { low: null, high: null, typical: null, n: recent.length, window: recent.map((p) => p.slug), pctPerEpisode: null, direction: null, reason: `Only ${recent.length} clean first weeks exist; at least three are required.` };
  const sorted = [...episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  const newest = sorted.at(-1) || null;
  return { nextFirstWeek, coolOff: newest ? coolOffFor(newest, sorted, flags) : null };
}

// --- live rates (PRD v10) ---------------------------------------------------
//
// Participation normalized so a 95-minute show and a 124-minute show compare:
// chatters per 100 peak viewers, and chat messages per hour.
// --- rule 23: bands that follow the show's own swing -------------------------
//
// swingOf: the median absolute deviation of the peers from their typical, as a
// whole-percent share of the typical — how much this measure normally moves
// from episode to episode. bandsFor: half that swing in score points (a score
// is 50 × own / typical), never narrower than the fixed bands (±5 points =
// ±10 %) and never wider than ±15 points (±30 %). stateOf: the check's word.
export function swingOf(values, typical) {
  if (!Number.isFinite(typical) || typical <= 0 || !Array.isArray(values)) return null;
  const dev = values.filter(Number.isFinite).map((v) => Math.abs(v - typical));
  if (dev.length < MIN_PEERS) return null;
  return Math.round((trueMedian(dev) / typical) * 100);
}
export function bandsFor(swing) {
  const pct = Math.min(SWING_MAX_PCT, Math.max(SWING_MIN_PCT, Number.isFinite(swing) ? swing : SWING_MIN_PCT));
  return { healthy: 50 + pct / 2, steady: 50 - pct / 2 };
}
export function stateOf(score, bands = BANDS) {
  if (!Number.isFinite(score)) return STATE_WORDS.waiting;
  if (score >= bands.healthy) return STATE_WORDS.healthy;
  if (score >= bands.steady) return STATE_WORDS.steady;
  return STATE_WORDS.fragile;
}

// --- live depth (rule 23): how long each live viewer stayed, and how much of
// the peak was still watching over the last HOLD_MINUTES minutes ---
export function liveDepthOf(episode) {
  const l = episode?.live;
  if (!l || !Number.isFinite(l.peak) || l.peak <= 0) return null;
  const minutesPerViewer = Number.isFinite(l.watchedMin) && l.watchedMin > 0 && Number.isFinite(l.liveViews) && l.liveViews > 0
    ? round1(l.watchedMin / l.liveViews) : null;
  const series = Array.isArray(l.series) ? l.series.filter((p) => Number.isFinite(p?.v)) : [];
  const tail = series.slice(-HOLD_MINUTES);
  const holdRate = tail.length >= HOLD_MINUTES ? round1((tail.reduce((sum, p) => sum + p.v, 0) / tail.length) / l.peak * 100) : null;
  return { minutesPerViewer, holdRate };
}

// --- discovery share (rule 23): the share of an episode's YouTube views that
// YouTube itself brought — search, suggested videos, Shorts, browse — blended
// across channels by views. Null when a channel record carries no traffic
// sources (the daily history lines do not), so the measure reads mature.
export function discoveryShareOf(channels) {
  const channelRows = Object.values(channels || {});
  if (!channelRows.length) return null;
  let discovered = 0, views = 0;
  for (const ch of channelRows) {
    const t = ch?.totals ?? ch;
    const traffic = ch?.trafficSources;
    if (!t || !Number.isFinite(t.views) || t.views <= 0 || !Array.isArray(traffic)
      || !traffic.some((source) => Number.isFinite(source?.views) && source.views > 0)) return null;
    views += t.views;
    discovered += traffic.filter((s) => DISCOVERY_SOURCES.includes(s.insightTrafficSourceType)).reduce((sum, s) => sum + (Number.isFinite(s.views) ? s.views : 0), 0);
  }
  return views > 0 ? round1((discovered / views) * 100) : null;
}

export function liveRatesOf(episode) {
  const l = episode?.live;
  if (!l || !Number.isFinite(l.peak) || l.peak <= 0) return null;
  return {
    chattersPer100: Number.isFinite(l.chatters) ? round1((l.chatters / l.peak) * 100) : null,
    messagesPerHour: Number.isFinite(l.chatMessages) && Number.isFinite(l.durationMin) && l.durationMin > 0
      ? round1((l.chatMessages / l.durationMin) * 60) : null,
  };
}

// --- launch read (PRD v10) --------------------------------------------------
//
// One word per episode, from the first day it has a reading: YouTube views
// at LAUNCH_AGE (day 7) — or at the earliest real reading when tracking
// started later (capped at READ_DAYS), or at the current age when the episode
// is under a week old (provisional) — against the other episodes' readings at
// that same age, either side in air order, promo outliers out, MIN_PEERS or
// nothing. Descriptive standing, never frozen; the 21-day episode-health read
// stays the permanent "beat its own bar" score. A flagged YouTube unit makes
// the read promoDriven: the word is kept, the qualifier rides with it.
export function launchReadFor(own, episodes, flags, { minPeers = MIN_PEERS } = {}) {
  const age = ytCurrentAge(own);
  const first = firstYtSnapshot(own);
  if (!Number.isFinite(age) || !first) return null;
  const firstAge = ageDaysOf(first.ts, own.premiere);
  let readAge = LAUNCH_AGE;
  let provisional = false;
  if (age < LAUNCH_AGE) { readAge = age; provisional = true; }
  else if (firstAge > LAUNCH_AGE + SNAPSHOT_TOL) readAge = Math.min(firstAge, READ_DAYS);
  else if (!ytSnapshotAt(own, LAUNCH_AGE)) {
    // a missed day-7 snapshot: read at the first reading after the first
    // week rather than leaving the episode wordless forever
    const later = ytSnapshotsOf(own).map((s) => ageDaysOf(s.ts, own.premiere)).find((a) => a > LAUNCH_AGE + SNAPSHOT_TOL);
    if (Number.isFinite(later)) readAge = Math.min(later, READ_DAYS);
  }
  const late = readAge > LAUNCH_AGE + SNAPSHOT_TOL;
  const ownSnap = ytSnapshotAt(own, readAge);
  const value = ownSnap ? ytViewsOf(ownSnap) : null;
  const window = windowFor(own, episodes, { side: "either" });
  const ps = peersFor({ own, window, flags, valueOf: (p) => { const s = ytSnapshotAt(p, readAge); return s ? ytViewsOf(s) : null; }, minPeers, units: UNIT_FAMILIES.views });
  const score = scoreOf(value, ps.typical);
  const word = score == null ? null : score >= BANDS.healthy ? LAUNCH_WORDS.strong : score >= BANDS.steady ? LAUNCH_WORDS.typical : LAUNCH_WORDS.soft;
  return {
    ageDays: round1(readAge),
    value,
    typical: ps.typical,
    n: ps.n,
    pct: value != null && ps.typical > 0 ? Math.round(((value - ps.typical) / ps.typical) * 100) : null,
    word,
    promoDriven: flags?.get?.(own.slug)?.units?.ytViews?.flag === true,
    provisional,
    late,
    peers: ps.peers.map((p) => p.slug),
    excluded: ps.excluded,
    reason: word ? null : (value == null ? NOTES.noLaunchReading : ps.reason),
  };
}

// --- cool-off (PRD v10) -----------------------------------------------------
//
// The newest episode's growth over its last COOL_SPAN_DAYS days (views at age
// A over views at A − span) against the other episodes' growth over the same
// two days at the same age. "still building" above the typical by the quiet
// zone, "cooling faster" below it, "cooling as usual" between. Absent until
// MIN_PEERS peers carry readings at both ages — daily tracking only began
// with E6, so expect this from E8/E9 on.
export function coolOffFor(own, episodes, flags, { span = COOL_SPAN_DAYS, minPeers = MIN_PEERS } = {}) {
  const age = ytCurrentAge(own);
  if (!Number.isFinite(age) || age - span < SNAPSHOT_TOL) return null;
  // a promo tail is not a cool-off read: the lift is shown, never judged
  const promoDriven = flags?.get?.(own.slug)?.units?.ytViews?.flag === true;
  const ratioAt = (e) => {
    const a = ytSnapshotAt(e, age);
    const b = ytSnapshotAt(e, age - span);
    const va = a ? ytViewsOf(a) : null;
    const vb = b ? ytViewsOf(b) : null;
    return Number.isFinite(va) && Number.isFinite(vb) && vb > 0 ? va / vb : null;
  };
  const value = ratioAt(own);
  const window = windowFor(own, episodes, { side: "either" });
  const peers = [];
  const excluded = [];
  for (const p of window) {
    if (flaggedOn(flags, p.slug, UNIT_FAMILIES.views)) { excluded.push({ slug: p.slug, why: flagReason(flags, p.slug, UNIT_FAMILIES.views) }); continue; }
    const v = ratioAt(p);
    if (!Number.isFinite(v)) { excluded.push({ slug: p.slug, why: "no reading at this age" }); continue; }
    peers.push({ slug: p.slug, value: round3(v) });
  }
  const typical = peers.length >= minPeers ? trueMedian(peers.map((p) => p.value)) : null;
  let word = null;
  if (!promoDriven && Number.isFinite(value) && Number.isFinite(typical) && typical > 0) {
    const rel = (value / typical - 1) * 100;
    word = rel > QUIET_ZONE_PCT ? COOL_WORDS.building : rel < -QUIET_ZONE_PCT ? COOL_WORDS.faster : COOL_WORDS.usual;
  }
  return {
    ageDays: round1(age),
    span,
    value: Number.isFinite(value) ? round3(value) : null,
    typical: Number.isFinite(typical) ? round3(typical) : null,
    n: peers.length,
    word,
    promoDriven,
    peers: peers.map((p) => p.slug),
    excluded,
    reason: word ? null : (promoDriven ? NOTES.promoQualified : value == null ? "No reading two days apart at this age." : NOTES.fewPeers),
  };
}

// --- same-age pace ---------------------------------------------------------

// One episode's YouTube views at its current age against the other episodes
// at that same age (outliers excluded). Descriptive standing, so peers may be
// later episodes; it is never used to freeze anything.
export function paceFor(own, episodes, flags, { minPeers = MIN_PEERS } = {}) {
  const age = ytCurrentAge(own);
  if (!Number.isFinite(age)) return null;
  const ownSnap = ytSnapshotAt(own, age);
  const ownValue = ownSnap ? ytViewsOf(ownSnap) : null;
  const window = windowFor(own, episodes, { side: "either" });
  const { peers, excluded, n, typical } = peersFor({
    own, window, flags,
    valueOf: (p) => { const s = ytSnapshotAt(p, age); return s ? ytViewsOf(s) : null; },
    minPeers,
    units: UNIT_FAMILIES.views,
  });
  if (!Number.isFinite(ownValue) || typical == null) {
    return { ageDays: round1(age), value: ownValue, typical: null, n, rank: null, of: null, pct: null, peers: peers.map((p) => p.slug), excluded, reason: NOTES.youngAge(n) };
  }
  const rank = peers.filter((p) => p.value > ownValue).length + 1;
  return {
    ageDays: round1(age),
    value: ownValue,
    typical,
    n,
    rank,
    of: n + 1,
    pct: typical > 0 ? Math.round(((ownValue - typical) / typical) * 100) : null,
    peers: peers.map((p) => p.slug),
    excluded,
    reason: null,
  };
}

// --- typical watch curve ---------------------------------------------------

// Per-point true median over the drop-off curves of mature, non-outlier
// episodes; drawn only with MIN_PEERS curves. Points exist only where every
// contributing curve has that grid position (no interpolation).
export function typicalCurve(episodes, flags, { exclude = null, minPeers = MIN_PEERS } = {}) {
  const curves = episodes
    .filter((e) => e.slug !== exclude && !flaggedOn(flags, e.slug, UNIT_FAMILIES.views) && (currentAge(e) ?? 0) >= MATURITY_DAYS.analytics && Array.isArray(e.watch?.curve) && e.watch.curve.length)
    .map((e) => ({ slug: e.slug, curve: e.watch.curve }));
  if (curves.length < minPeers) return { points: null, n: curves.length, window: curves.map((c) => c.slug) };
  const byAt = new Map();
  for (const c of curves) for (const p of c.curve) {
    if (!byAt.has(p.at)) byAt.set(p.at, []);
    byAt.get(p.at).push(p.watching);
  }
  const points = [...byAt.entries()]
    .filter(([, vals]) => vals.length === curves.length)
    .sort((a, b) => a[0] - b[0])
    .map(([at, vals]) => ({ at, watching: Math.round(trueMedian(vals) * 100) / 100 }));
  return { points, n: curves.length, window: curves.map((c) => c.slug) };
}

// --- the projection build-data writes as data.baselines --------------------

export function computeBaselines(episodes, { flags = anomalyFlags(episodes), history = null } = {}) {
  const anomaly = {};
  for (const [slug, f] of flags) anomaly[slug] = { flagged: f.flagged, provisional: f.provisional, units: f.units };
  const mature = episodes.filter((e) => (currentAge(e) ?? 0) >= MATURITY_DAYS.analytics);
  const watchPct = (() => {
    const vals = mature.filter((e) => !flaggedOn(flags, e.slug, UNIT_FAMILIES.views) && Number.isFinite(e.watch?.avgPercent));
    const typical = vals.length >= MIN_PEERS ? trueMedian(vals.map((e) => e.watch.avgPercent)) : null;
    return { typical: Number.isFinite(typical) ? round1(typical) : null, n: vals.length, window: vals.map((e) => e.slug), ageBasis: "mature" };
  })();
  // per-episode watched typical for the table's ▲/▼: the other mature,
  // unflagged episodes (the row itself never in its own typical)
  const watchPctBySlug = Object.fromEntries(episodes.map((e) => {
    const others = mature.filter((o) => o.slug !== e.slug && !flaggedOn(flags, o.slug, UNIT_FAMILIES.views) && Number.isFinite(o.watch?.avgPercent));
    const typical = others.length >= MIN_PEERS ? trueMedian(others.map((o) => o.watch.avgPercent)) : null;
    return [e.slug, { typical: Number.isFinite(typical) ? round1(typical) : null, n: others.length, window: others.map((o) => o.slug), ageBasis: "mature" }];
  }));
  return {
    constants: CONSTANTS,
    anomaly,
    watchPct,
    watchPctBySlug,
    typicalCurve: typicalCurve(episodes, flags),
    pace: Object.fromEntries(episodes.map((e) => [e.slug, paceFor(e, episodes, flags)])),
    // PRD v10: one launch word per episode, from its first reading on
    launch: Object.fromEntries(episodes.map((e) => [e.slug, launchReadFor(e, episodes, flags)])),
    newestVsPrevious: newestVsPrevious(episodes, flags, { history }),
    // PRD v10: the direction and outlook lenses — deterministic, served every
    // build, copied into the day's health entry (never gated on the model)
    direction: computeDirection(episodes, flags),
    outlook: computeOutlook(episodes, flags, computeDirection(episodes, flags)),
  };
}

// The growth-trend card's verdict for the alternate measures: the newest
// episode against the one before it, like for like — reach from snapshots at
// the same age, share watched from analytics history lines at the same age,
// live turnout age-free. Absent with a reason when no same-age reading exists.
export const TOO_YOUNG = "Too young to compare with the episode before it at the same age.";
export function newestVsPrevious(episodes, flags, { history = null } = {}) {
  const sorted = [...episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  const newest = sorted.at(-1);
  const previous = sorted.at(-2);
  if (!newest || !previous) return null;
  const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? Math.round(((a - b) / b) * 100) : null);
  const A = currentAge(newest);
  const out = { newest: newest.slug, previous: previous.slug, ageDays: Number.isFinite(A) ? round1(A) : null };
  const ns = Number.isFinite(A) ? snapshotAt(newest, A) : null;
  const ps = Number.isFinite(A) ? snapshotAt(previous, A) : null;
  out.reach = ns && ps ? { pct: pct(xImpressionsOf(ns), xImpressionsOf(ps)), ageBasis: "sameAge" } : { pct: null, reason: TOO_YOUNG };
  const nl = history ? ytHistoryAt(history(newest.slug), A, newest.premiere) : null;
  const pl = history ? ytHistoryAt(history(previous.slug), A, previous.premiere) : null;
  const blend = (line) => {
    let num = 0, den = 0;
    for (const t of Object.values(line?.channels || {})) { if (Number.isFinite(t.views) && t.views > 0 && Number.isFinite(t.averageViewPercentage)) { num += t.averageViewPercentage * t.views; den += t.views; } }
    return den > 0 ? num / den : null;
  };
  out.watched = nl && pl ? { pct: pct(blend(nl), blend(pl)), ageBasis: "sameAge" } : { pct: null, reason: TOO_YOUNG };
  out.live = Number.isFinite(newest.live?.peak) && Number.isFinite(previous.live?.peak)
    ? { pct: pct(newest.live.peak, previous.live.peak), ageBasis: "ageFree" }
    : { pct: null, reason: "No live session to compare." };
  return out;
}

// --- known reporting breaks (PRD v12 §3.1) — versioned, one place ----------
// Where a platform changed what it reports, the numbers on either side are
// not like for like. The brief prints the note on every affected row; the
// validator checks it is there.
export const KNOWN_BREAKS = Object.freeze([
  {
    id: "restream-live-per-channel-2026-08-13",
    from: "2026-08-13-dive-radio-goodbye-blank-canvas-live-cal",
    fromEp: 5,
    measures: ["liveViewers", "minutesPerViewer"],
    note: "Restream's per-channel live reporting changed from E5: the X destinations began reporting live viewers, and the unique-viewer totals before and after are not like for like (E1–E4 counted YouTube only).",
  },
]);
// A break splits the episodes into two populations for the measures it
// touches: only episodes on the newest side are comparable with the newest
// episode (health peers, direction points). Nothing is estimated across it.
export function breaksFor(measureKey) { return KNOWN_BREAKS.filter((b) => b.measures.includes(measureKey)); }
export function comparableAcrossBreaks(measureKey, episode) { return breaksFor(measureKey).every((b) => (episode?.ep ?? 0) >= b.fromEp); }
export const NOTE_BREAK = (measureKey) => { const b = breaksFor(measureKey)[0]; return b ? `Fewer than three episodes since the live-reporting change (from E${b.fromEp}) to compare with.` : null; };
