// baselines.mjs — the ONE definition of "typical" (PRD v7, rule 16).
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

export const CONSTANTS = Object.freeze({
  WINDOW_N, MIN_PEERS, SLOPE_N, QUIET_ZONE_PCT, BANDS, MATURITY_DAYS, READ_DAYS,
  OUTLIER_MULTIPLE, SNAPSHOT_TOL, HISTORY_TOL,
});

export const NOTES = Object.freeze({
  sameAge: "compared at the same age",
  mature: "compared with earlier episodes as they stand now, not at the same age",
  fewPeers: "Fewer than three earlier episodes to compare with.",
  youngAge: (n) => `Only ${n} earlier episode${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} tracked this early; at least three are needed.`,
  noReadingAtAge: "Fewer than three earlier episodes have a reading at this age.",
  readFrom: (title) => `read from ${title}, the latest finished episode`,
});

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
  return readingAt(episode.snapshots, ageDays, SNAPSHOT_TOL, (s) => ageDaysOf(s.ts, episode.premiere));
}

export function historyAt(lines, ageDays) {
  return readingAt(lines, ageDays, HISTORY_TOL, (l) => l.ageDays);
}

export function currentAge(episode) {
  const last = episode.snapshots?.[episode.snapshots.length - 1];
  return last ? ageDaysOf(last.ts, episode.premiere) : null;
}

// --- per-snapshot values ---------------------------------------------------

export const ytViewsOf = (snap) => YT_KEYS.reduce((a, k) => a + (snap?.byDest?.[k]?.views || 0), 0);
export const ytEngagementOf = (snap) => YT_KEYS.reduce((a, k) => a + (snap?.byDest?.[k]?.likes || 0) + (snap?.byDest?.[k]?.comments || 0), 0);
export const xImpressionsOf = (snap) => X_KEYS.reduce((a, k) => a + (snap?.byDest?.[k]?.views || 0), 0);

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

// Filter a window down to usable peers. `valueOf(peer)` returns the peer's
// value under the measure's basis or null; `coverageOf` (optional) returns a
// coverage key that must match `ownCoverage`. Returns the peers with values,
// the excluded list with reasons, and the typical (null below MIN_PEERS).
export function peersFor({ own, window, flags, valueOf, coverageOf = null, ownCoverage = null, minPeers = MIN_PEERS }) {
  const peers = [];
  const excluded = [];
  for (const p of window) {
    if (p.slug === own.slug) continue;
    if (flags?.get?.(p.slug)?.flagged) { excluded.push({ slug: p.slug, why: "promo outlier" }); continue; }
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
  { key: "ytViews", label: "YT views", at: (e, snap) => ytViewsOf(snap), latest: (e) => e.latest?.ytTotal },
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
    let provisional = false;
    for (const unit of UNITS) {
      const tryTier = (tier, ownValue, peerValueOf) => {
        if (!Number.isFinite(ownValue)) return null;
        const usable = window.filter((p) => !(flags.get(p.slug)?.flagged));
        const peers = usable.map((p) => ({ slug: p.slug, value: peerValueOf(p) })).filter((p) => Number.isFinite(p.value));
        if (peers.length < minPeers) return null;
        const typical = trueMedian(peers.map((p) => p.value));
        if (!(typical > 0)) return null;
        return { tier, value: ownValue, typical: round1(typical), n: peers.length, window: peers.map((p) => p.slug), flag: ownValue > OUTLIER_MULTIPLE * typical };
      };
      const age = currentAge(e);
      let result = null;
      if (Number.isFinite(age) && age >= READ_DAYS) {
        const ownSnap = snapshotAt(e, READ_DAYS);
        result = ownSnap ? tryTier(1, unit.at(e, ownSnap), (p) => { const s = snapshotAt(p, READ_DAYS); return s ? unit.at(p, s) : null; }) : null;
      }
      if (!result && Number.isFinite(age)) {
        const ownSnap = snapshotAt(e, age);
        result = ownSnap ? tryTier(2, unit.at(e, ownSnap), (p) => { const s = snapshotAt(p, age); return s ? unit.at(p, s) : null; }) : null;
      }
      if (!result) result = tryTier(3, unit.latest(e), (p) => unit.latest(p));
      units[unit.key] = result || { tier: null, value: null, typical: null, n: 0, window: [], flag: false };
      if (result?.flag) {
        hits.push(`${fmt(result.value)} ${unit.label} vs a typical ${fmt(result.typical)}`);
        if (result.tier !== 1) provisional = true;
      }
    }
    const flagged = hits.length > 0;
    flags.set(e.slug, {
      flagged,
      provisional: flagged && provisional,
      units,
      text: flagged ? `more than double what a typical episode gets (${hits.join("; ")}) — treat as promo-driven outlier, not topic signal` : null,
    });
  }
  return flags;
}

// --- same-age pace ---------------------------------------------------------

// One episode's YouTube views at its current age against the other episodes
// at that same age (outliers excluded). Descriptive standing, so peers may be
// later episodes; it is never used to freeze anything.
export function paceFor(own, episodes, flags, { minPeers = MIN_PEERS } = {}) {
  const age = currentAge(own);
  if (!Number.isFinite(age)) return null;
  const ownSnap = snapshotAt(own, age);
  const ownValue = ownSnap ? ytViewsOf(ownSnap) : null;
  const window = windowFor(own, episodes, { side: "either" });
  const { peers, excluded, n, typical } = peersFor({
    own, window, flags,
    valueOf: (p) => { const s = snapshotAt(p, age); return s ? ytViewsOf(s) : null; },
    minPeers,
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
    .filter((e) => e.slug !== exclude && !(flags?.get?.(e.slug)?.flagged) && (currentAge(e) ?? 0) >= MATURITY_DAYS.analytics && Array.isArray(e.watch?.curve) && e.watch.curve.length)
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

export function computeBaselines(episodes, { flags = anomalyFlags(episodes) } = {}) {
  const anomaly = {};
  for (const [slug, f] of flags) anomaly[slug] = { flagged: f.flagged, provisional: f.provisional, units: f.units };
  const mature = episodes.filter((e) => (currentAge(e) ?? 0) >= MATURITY_DAYS.analytics);
  const watchPct = (() => {
    const vals = mature.filter((e) => !flags.get(e.slug)?.flagged && Number.isFinite(e.watch?.avgPercent));
    const typical = vals.length >= MIN_PEERS ? trueMedian(vals.map((e) => e.watch.avgPercent)) : null;
    return { typical: Number.isFinite(typical) ? round1(typical) : null, n: vals.length, window: vals.map((e) => e.slug), ageBasis: "mature" };
  })();
  return {
    constants: CONSTANTS,
    anomaly,
    watchPct,
    typicalCurve: typicalCurve(episodes, flags),
    pace: Object.fromEntries(episodes.map((e) => [e.slug, paceFor(e, episodes, flags)])),
  };
}
