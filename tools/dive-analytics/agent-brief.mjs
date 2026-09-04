// agent-brief.mjs — the whole show, readable by any agent in one pull (PRD v12).
//
// Pure functions over the data.json object build-data computes (never the
// stores, never the clock, never a locale): buildBrief(data) returns the
// three artifacts served at the repo root — agent.md (for reading),
// agent.json (the same digest for parsing), llms.txt (the index). Every
// number is copied from data; an absent value is a dash with its reason,
// never a zero or an empty list (rule 2). Words that name methodology are
// allowed only under the Definitions heading (rule 6 for agents).
//
// Complete by construction (rule 27): COVERS lists the data.json paths the
// brief consumes — an entry ending in "*" is a bundle consumed whole (every
// field under it reaches the brief or agent.json) — and LEAVES_OUT the paths
// deliberately left to the raw file; censusPaths(data) walks a data object
// with the one path grammar (arrays as [], slug-keyed maps as {slug},
// destination-keyed maps as {dest}, depth ≤ 4) and the validator reports
// drift on any path in neither list. New keys at the top level, on an
// episode, or directly under health / baselines / showTrend therefore cannot
// ship unnoticed; fields inside a consumed bundle are the bundle's business.

export const BRIEF_VERSION = 1;
export const SITE = "https://dive-radio-analytics.vercel.app";
export const CENSUS_DEPTH = 4;
export const HEADINGS = Object.freeze([
  "## 1. How to read this", "## 2. The show at a glance", "## 3. Show health today", "## 4. What to do this week",
  "## 5. Episodes", "## 6. Episode by episode", "## 7. Trajectory", "## 8. Definitions", "## 9. Lineage and freshness", "## 10. Deeper data",
]);
export const BUDGET = Object.freeze({ warnBytes: 80_000, failBytes: 100_000, excerptChars: 160, quotesPerEpisode: 2, chaptersPerEpisode: 10, fullSectionsForLast: 8 });

// --- formatting: deterministic, locale-free -------------------------------------
export const fmtNum = (v, d = 0) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const fixed = Number(v).toFixed(d);
  const [i, f] = fixed.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : "");
};
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${fmtNum(v, d)}%`);
const day = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "—");
const stamp = (sec) => { const s = Math.max(0, Math.round(sec)); const p = (n) => String(n).padStart(2, "0"); return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`; };
const minutes = (sec) => (sec == null ? "—" : `${Math.round(sec / 60)} min`);
const short = (title) => String(title || "").replace(/^Dive Radio:?\s*/i, "");
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
const cut = (s, n) => { const t = esc(s).replace(/https?:\/\/\S+/g, "[link]"); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const cap = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : "");
const themeWords = (list) => (list || []).map((t) => (t && typeof t === "object" ? `${esc(t.theme)}${t.count != null ? ` (${t.count})` : ""}` : esc(t)));
const absent = (reason) => ({ value: null, reason: reason || "not available" });

export const CHECK_WORDS = Object.freeze({
  growth: "Growth", audienceQuality: "Audience quality", reachEfficiency: "Reach", livePull: "Live turnout", participation: "Participation", conversion: "Subscribers", sentiment: "Goodwill",
});
export const MEASURE_WORDS = Object.freeze({
  firstWeek: "first-week slope", sameAge: "YouTube views at the newest episode's age", engagement: "likes and comments at the same age", watching: "share of the video watched",
  exposure: "times the X announces were seen at the same age", announceToPlay: "X announce impressions that became plays", discoveryShare: "YouTube views from search and suggested videos",
  peak: "peak live viewers", average: "average live viewers", liveViewers: "people who watched live", minutesWatched: "minutes watched live, all together",
  chattersPer100: "chatters per hundred at the peak", messagesPerHour: "chat messages an hour", minutesPerViewer: "minutes each live viewer stayed", holdRate: "share of the peak still watching at the end",
  subscribers: "subscribers per thousand views", balance: "share of feedback leaning positive", commentRate: "people commenting per thousand watches",
});
export const DIRECTION_WORDS = Object.freeze({
  firstWeek: "clean first weeks", engagementWeekOne: "first-week likes and comments", watching: "share of the video watched", exposureWeekOne: "first-week X reach",
  announceToPlay: "announce-to-play on X", discoveryShare: "YouTube views from search and suggested videos", liveAverage: "average live viewers", livePeak: "peak live viewers",
  liveViewers: "people who watched live", minutesWatched: "minutes watched live", chattersPer100: "chatters per hundred at the peak", messagesPerHour: "chat messages an hour",
  minutesPerViewer: "minutes each live viewer stayed", holdRate: "share of the peak still watching at the end", subscribers: "subscribers per thousand views",
});
const COMPARED = Object.freeze({ sameAge: "at the same age", mature: "as the earlier episodes stand now", ageFree: "as they stand (no age)" });
const bandWords = (score) => (score == null ? "—" : score >= 55 ? "above usual" : score >= 45 ? "near usual" : "below usual");

// --- coverage --------------------------------------------------------------------
export const COVERS = Object.freeze([
  // bundles consumed whole (trailing *)
  "episodes[].announces[]*", "episodes[].links.{dest}*", "episodes[].latest.byDest.{dest}*", "episodes[].latest.xPlaysInfo*", "episodes[].latest.totalViewsInfo*",
  "episodes[].metrics*", "episodes[].live.byChannel[]*", "episodes[].comments.featured[]*", "episodes[].comments.enjoyThemes[]*", "episodes[].comments.complaintThemes[]*",
  "episodes[].health*", "episodes[].watch.traffic[]*", "episodes[].watch.shape*", "episodes[].watch.moments[]*", "episodes[].watch.byChannel[]*", "episodes[].watch.channels[]*", "episodes[].chapters.list[]*",
  "insights[]*", "insightsStale[]*", "showTrend.week1VelocityByEpisode[]*", "showTrend.paceRank*", "commentSummary.enjoyThemes[]*", "commentSummary.complaintThemes[]*",
  "health.checks[]*", "health.asOf*", "health.direction*", "health.outlook*", "health.pros[]*", "health.cons[]*", "health.drivers[]*", "health.checkSetChange*", "health.facts[]*", "health.trend*",
  "baselines.constants*", "baselines.pace.{slug}*", "baselines.launch.{slug}*", "baselines.newestVsPrevious*", "baselines.direction.votes[]*", "baselines.direction.measures[]*", "baselines.outlook.nextFirstWeek*", "baselines.outlook.coolOff*", "baselines.anomaly.{slug}*", "baselines.knownBreaks[]*",
  "generatedAt", "dests", "dests[]", "dests[].key", "dests[].label", "dests[].platform",
  "episodes", "episodes[]", "episodes[].slug", "episodes[].title", "episodes[].premiere", "episodes[].show", "episodes[].active", "episodes[].partialHistory", "episodes[].historyReady", "episodes[].historyReason", "episodes[].ep", "episodes[].ageDays", "episodes[].transcript", "episodes[].subsPer1k", "episodes[].discoveryShare",
  "episodes[].announces", "episodes[].announces[]", "episodes[].announces[].account", "episodes[].announces[].role", "episodes[].announces[].ts", "episodes[].announces[].url",
  "episodes[].links", "episodes[].links.{dest}",
  "episodes[].latest", "episodes[].latest.ts", "episodes[].latest.ytTotal", "episodes[].latest.youtubeAsOf", "episodes[].latest.youtubeStale", "episodes[].latest.xImpressions", "episodes[].latest.xPlays", "episodes[].latest.xPlaysInfo", "episodes[].latest.totalViews", "episodes[].latest.totalViewsInfo", "episodes[].latest.byDest", "episodes[].latest.byDest.{dest}",
  "episodes[].metrics", "episodes[].metrics.week1Velocity", "episodes[].metrics.week1Note", "episodes[].metrics.flatlineWeek", "episodes[].metrics.engagementPer1k", "episodes[].metrics.anomaly",
  "episodes[].live", "episodes[].live.peak", "episodes[].live.avg", "episodes[].live.liveViews", "episodes[].live.watchedMin", "episodes[].live.chatMessages", "episodes[].live.chatters", "episodes[].live.durationMin", "episodes[].live.minutesPerViewer", "episodes[].live.holdRate", "episodes[].live.byChannel", "episodes[].live.byChannel[]",
  "episodes[].comments", "episodes[].comments.captured", "episodes[].comments.feedbackCount", "episodes[].comments.uniqueCommenters", "episodes[].comments.enjoyCount", "episodes[].comments.complaintCount", "episodes[].comments.commentersPer1k", "episodes[].comments.commentersPer1kNote", "episodes[].comments.enjoyThemes", "episodes[].comments.complaintThemes", "episodes[].comments.featured", "episodes[].comments.featured[]", "episodes[].comments.xCoverage",
  "episodes[].health", "episodes[].health.score", "episodes[].health.pending", "episodes[].health.readCompleteOn", "episodes[].health.reason", "episodes[].health.checks", "episodes[].health.missingChecks", "episodes[].health.algorithm", "episodes[].health.window", "episodes[].health.windowIds", "episodes[].health.excluded", "episodes[].health.reproducible", "episodes[].health.rederivedFrom", "episodes[].health.weightUsed", "episodes[].health.readAge", "episodes[].health.readAgeDays", "episodes[].health.stillReading",
  "episodes[].watch", "episodes[].watch.avgPercent", "episodes[].watch.avgDurationSec", "episodes[].watch.minutesWatched", "episodes[].watch.traffic", "episodes[].watch.traffic[]", "episodes[].watch.shape", "episodes[].watch.moments", "episodes[].watch.moments[]", "episodes[].watch.byChannel", "episodes[].watch.byChannel[]", "episodes[].watch.channels", "episodes[].watch.updatedAt",
  "episodes[].chapters", "episodes[].chapters.status", "episodes[].chapters.clock", "episodes[].chapters.format", "episodes[].chapters.writtenAt", "episodes[].chapters.list", "episodes[].chapters.list[]", "episodes[].chapters.reason",
  "insights", "insights[]", "insights[].id", "insights[].text", "insights[].recommendation", "insights[].category", "insights[].rank", "insights[].serves", "insights[].caveat",
  "insightsStale",
  "showTrend", "showTrend.week1VelocityByEpisode", "showTrend.week1VelocityByEpisode[]", "showTrend.paceRank",
  "commentSummary", "commentSummary.captured", "commentSummary.feedbackCount", "commentSummary.uniqueCommenters", "commentSummary.enjoyCount", "commentSummary.complaintCount", "commentSummary.commentersPer1k", "commentSummary.commentersPer1kNote", "commentSummary.enjoyThemes", "commentSummary.complaintThemes",
  "health", "health.date", "health.ageDays", "health.withheld", "health.formulaVersion", "health.dataThrough", "health.score", "health.readState", "health.headline", "health.checks", "health.checks[]", "health.asOf", "health.pros", "health.pros[]", "health.cons", "health.cons[]", "health.drivers", "health.checkSetChange", "health.trend", "health.facts", "health.facts[]",
  "baselines", "baselines.constants", "baselines.pace", "baselines.pace.{slug}", "baselines.launch", "baselines.launch.{slug}", "baselines.newestVsPrevious", "baselines.direction", "baselines.direction.overall", "baselines.direction.votes", "baselines.direction.measures", "baselines.direction.measures[]", "baselines.outlook", "baselines.outlook.nextFirstWeek", "baselines.outlook.coolOff", "baselines.anomaly", "baselines.anomaly.{slug}", "baselines.knownBreaks", "baselines.knownBreaks[]",
  "chaptersUpdatedAt",
]);
export const LEAVES_OUT = Object.freeze([
  { path: "episodes[].snapshots", reason: "the raw daily series by destination — summarised as totals, first week, launch, and pace; the full series is in data.json" },
  { path: "episodes[].weekly", reason: "weekly roll-ups of the same series — in data.json" },
  { path: "episodes[].live.series", reason: "the per-minute live audience — summarised as peak, average, minutes per viewer, and hold rate" },
  { path: "episodes[].watch.curve", reason: "the hundred-point watch curve — summarised by its shape and the moments" },
  { path: "episodes[].comments.list", reason: "every classified comment — counts, themes, and featured quotes stand in; the list is in data.json" },
  { path: "episodes[].watch.moments[].excerpt", reason: "cut to a short excerpt in the brief; the full verbatim excerpt is in data.json" },
  { path: "episodes[].chapters.list[].quote", reason: "the grounding quote behind each chapter — the timestamp and title are what an agent needs; the quote is in agent.json" },
  { path: "baselines.watchPct", reason: "the typical share watched — printed inside the health measures" },
  { path: "baselines.watchPctBySlug", reason: "per-episode share watched — printed in the episode table" },
  { path: "baselines.typicalCurve", reason: "the typical watch curve, a chart aid" },
  { path: "showTrend.cumulativeAllEpisodes", reason: "the Slack report's running total, which carries X reach and is not a views figure" },
]);

// the one path grammar: arrays as [], slug-keyed maps as {slug}, destination-keyed maps as {dest}
export function censusPaths(data, depth = CENSUS_DEPTH) {
  const out = new Set();
  const isSlug = (k) => /^\d{4}-\d{2}-\d{2}-/.test(k);
  const isDest = (k) => /^(yt|x):/.test(k);
  const walk = (value, path, level) => {
    if (level > depth || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      out.add(`${path}[]`);
      const keys = new Set();
      for (const item of value) if (item && typeof item === "object" && !Array.isArray(item)) for (const k of Object.keys(item)) keys.add(k);
      for (const k of [...keys].sort()) { const p = `${path}[].${k}`; out.add(p); walk(value.map((it) => it?.[k]).find((v) => v != null && typeof v === "object"), p, level + 1); }
      return;
    }
    const keys = Object.keys(value);
    const dyn = keys.length && keys.every(isSlug) ? "{slug}" : keys.length && keys.every(isDest) ? "{dest}" : null;
    if (dyn) { const p = `${path}.${dyn}`; out.add(p); walk(value[keys[0]], p, level + 1); return; }
    for (const k of keys.sort()) { const p = path ? `${path}.${k}` : k; out.add(p); walk(value[k], p, level + 1); }
  };
  walk(data, "", 0);
  return [...out].filter(Boolean).sort();
}
const under = (p, root) => p === root || p.startsWith(`${root}.`) || p.startsWith(`${root}[]`);
export function uncovered(data) {
  const exact = new Set(COVERS.filter((c) => !c.endsWith("*")));
  const bundles = COVERS.filter((c) => c.endsWith("*")).map((c) => c.slice(0, -1));
  const left = LEAVES_OUT.map((x) => x.path);
  return censusPaths(data).filter((p) => !exact.has(p) && !bundles.some((b) => under(p, b)) && !left.some((l) => under(p, l)));
}

// --- the digest -------------------------------------------------------------------
function episodeDigest(e, data) {
  const launch = data.baselines?.launch?.[e.slug] || null;
  const pace = data.baselines?.pace?.[e.slug] || null;
  const flag = data.baselines?.anomaly?.[e.slug] || null;
  const yt = Object.entries(e.links || {}).filter(([k]) => k.startsWith("yt:"));
  const x = Object.entries(e.links || {}).filter(([k]) => k.startsWith("x:"));
  const uploadUrl = e.chapters?.clock === "upload" ? (yt.find(([k]) => e.chapters?.uploadKey && k === e.chapters.uploadKey)?.[1] || yt[0]?.[1] || null) : null;
  const chapters = e.chapters?.list?.length
    ? { status: e.chapters.status, clock: e.chapters.clock, writtenAt: e.chapters.writtenAt, list: e.chapters.list.slice(0, BUDGET.chaptersPerEpisode).map((c) => ({ start: c.start, seconds: c.seconds, title: c.title, gist: c.gist, quote: c.quote, link: uploadUrl ? `${uploadUrl}&t=${c.seconds}s` : null })) }
    : absent(e.chapters?.reason || (e.transcript ? "chapters not written yet" : "no transcript"));
  const health = e.health && e.health.score != null
    ? { score: e.health.score, readOn: e.health.readCompleteOn ?? null, checks: e.health.checks ? Object.fromEntries(Object.entries(e.health.checks).map(([k, c]) => [k, { score: c.score ?? null, reason: c.reason ?? null }])) : null }
    : absent(e.health?.reason || (e.health?.pending ? `read completes on ${day(e.health.readCompleteOn)} (day twenty-one)` : "no read"));
  const w = e.watch || {};
  const l = e.live || {};
  const c = e.comments || {};
  const moments = (w.moments || []).map((m) => ({ kind: m.kind, at: m.at, minutesIn: Math.round((m.estSec || 0) / 60), points: m.points, approx: !!m.approx, summary: m.summary || null, excerpt: cut(m.excerpt || "", BUDGET.excerptChars) }));
  const plays = e.latest?.xPlaysInfo || {};
  const totalInfo = e.latest?.totalViewsInfo || {};
  const youtubeMissing = !(Number.isFinite(e.latest?.ytTotal) && e.latest.ytTotal > 0);
  const youtubeStale = !youtubeMissing && e.latest?.youtubeStale === true;
  const viewsReason = youtubeMissing
    ? (totalInfo.reason || "YouTube views are not available yet.")
    : (youtubeStale || totalInfo.incomplete ? (totalInfo.reason || "Some viewing data is not available yet.") : null);
  return {
    ep: e.ep, slug: e.slug, title: short(e.title), premiere: e.premiere, ageDays: e.ageDays, trackedLate: e.partialHistory == null ? null : e.partialHistory === true, history: { ready: e.historyReady === true, reason: e.historyReason || null }, dashboard: `${SITE}/#${e.slug}`,
    links: { youtube: Object.fromEntries(yt), xReplays: Object.fromEntries(x), announces: (e.announces || []).map((a) => ({ account: a.account, at: a.ts, url: a.url || null })), transcript: e.transcript ? `${SITE}/transcripts/${e.slug}.txt` : null },
    views: { youtube: youtubeMissing ? null : e.latest.ytTotal, youtubeAsOf: e.latest?.youtubeAsOf ?? null, youtubeStale, youtubeMarker: youtubeMissing ? "missing" : youtubeStale ? "old" : null, xPlays: e.latest?.xPlays ?? null, xPlaysMarker: plays.partial ? "partial" : plays.stale ? "stale" : null, total: youtubeMissing ? null : (e.latest?.totalViews ?? null), incomplete: youtubeMissing || youtubeStale || totalInfo.incomplete === true, reason: viewsReason, xReach: e.latest?.xImpressions ?? null, asOf: e.latest?.ts ?? null, byDest: e.latest?.byDest || {} },
    firstWeek: e.metrics?.week1Velocity != null ? { value: e.metrics.week1Velocity } : absent(e.metrics?.week1Note || "no clean first week"),
    launch: launch?.word ? { word: launch.word, label: `${launch.promoDriven ? "promo-driven" : launch.word}${launch.provisional ? " (so far)" : ""}`, promoDriven: !!launch.promoDriven, provisional: !!launch.provisional, late: !!launch.late, value: launch.value, typical: launch.typical, pct: launch.pct, peers: launch.n } : absent(launch?.reason || "no reading at the launch age"),
    pace: pace?.rank != null ? { rank: pace.rank, of: pace.of, pct: pace.pct, value: pace.value, typical: pace.typical, ageDays: pace.ageDays } : absent(pace?.reason || "pace needs three other episodes at this age"),
    promo: flag?.flagged ? { provisional: !!flag.provisional, note: e.metrics?.anomaly || "promo-driven outlier" } : null,
    engagementPer1k: e.metrics?.engagementPer1k ?? null, subsPer1k: e.subsPer1k ?? null, discoveryShare: e.discoveryShare ?? null,
    watching: w.avgPercent != null ? { sharePercent: w.avgPercent, avgDurationSec: w.avgDurationSec ?? null, minutesWatched: w.minutesWatched ?? null, traffic: (w.traffic || []).slice(0, 4).map((t) => ({ source: t.source, share: t.share })), shape: w.shape || null, updatedAt: w.updatedAt || null } : absent("no YouTube analytics report yet"),
    live: l.peak != null ? { peak: l.peak, average: l.avg, uniqueViewers: l.liveViews ?? null, minutesWatched: l.watchedMin ?? null, minutesPerViewer: l.minutesPerViewer ?? null, holdRate: l.holdRate ?? null, chatMessages: l.chatMessages, chatters: l.chatters, durationMin: l.durationMin } : absent("no live session record"),
    feedback: c.captured != null ? { captured: c.captured, directional: c.feedbackCount ?? null, people: c.uniqueCommenters ?? null, enjoyed: c.enjoyCount ?? null, concerns: c.complaintCount ?? null, xReplies: c.xCoverage || null, enjoyThemes: c.enjoyThemes || [], concernThemes: c.complaintThemes || [], featured: (c.featured || []).slice(0, BUDGET.quotesPerEpisode).map((q) => ({ source: q.source, author: q.author, text: cut(q.text, 200) })) } : absent("no comments captured"),
    chapters, moments, health,
  };
}

function healthDigest(data) {
  const h = data.health;
  if (!h) return absent("no health read saved yet");
  if (h.withheld) return { withheld: true, date: h.date, ageDays: h.ageDays, reason: "the saved read is more than a week behind the data — the score is withheld" };
  return {
    date: h.date, dataThrough: h.dataThrough, ageDays: h.ageDays, readState: h.readState, formulaVersion: h.formulaVersion,
    score: h.score, band: bandWords(h.score), headline: h.headline, drivers: h.drivers || [],
    readsOn: h.asOf ? { episode: short((data.episodes || []).find((e) => e.slug === h.asOf.newest)?.title) || h.asOf.newestTitle || h.asOf.newest, ageDays: h.asOf.ageDays, provisional: !!h.asOf.provisional, carried: h.asOf.carried || [], promoQualified: h.asOf.qualified || [] } : null,
    checks: (h.checks || []).map((c) => ({
      key: c.key, name: CHECK_WORDS[c.key] || c.key, state: c.state, score: c.score, bands: c.bands || null, swing: c.swing ?? null, carried: !!c.carried, reason: c.reason || null,
      measures: (c.measures || []).map((m) => {
        const absolute = m.value != null && m.typical == null && m.ageBasis === "ageFree";
        const people = absolute ? (h.facts || []).find((f) => f.id === "recent-feedback-people")?.display : null;
        return { key: m.key, name: MEASURE_WORDS[m.key] || m.key, value: m.value, typical: m.typical, comparedHow: m.ageBasis ? COMPARED[m.ageBasis] : null, sample: m.sample ?? null, qualified: !!m.qualified, carried: !!m.carried, carriedNote: m.carriedNote || null, swing: m.swing ?? null, reason: m.value == null ? (m.reason || null) : null, absoluteScale: absolute, absoluteNote: absolute ? `on an absolute scale — no typical until enough earlier episodes carry the same feedback sources${people ? `; from ${people} people` : ""}` : null };
      }),
    })),
    helping: (h.pros || []).map((b) => ({ text: b.text, factId: b.factId })), needsWork: (h.cons || []).map((b) => ({ text: b.text, factId: b.factId })),
    facts: (h.facts || []).map((f) => ({ id: f.id, display: f.display, text: f.text })),
    checkSetChange: h.checkSetChange || null,
    // the lens AS OF THE READ (the entry's own copy) — today's lens is in the trajectory
    direction: h.direction ? { overall: h.direction.overall || null, measures: (h.direction.measures || []).map((t) => ({ key: t.key, name: DIRECTION_WORDS[t.key] || t.key, word: t.direction || null, pctPerEpisode: t.pctPerEpisode ?? null, readings: t.n ?? null, reason: t.direction ? null : (t.reason || null) })) } : null,
    outlook: h.outlook ? { nextFirstWeek: h.outlook.nextFirstWeek?.low != null ? { low: h.outlook.nextFirstWeek.low, high: h.outlook.nextFirstWeek.high, typical: h.outlook.nextFirstWeek.typical, cleanWeeks: h.outlook.nextFirstWeek.n, direction: h.outlook.nextFirstWeek.direction || null, reason: h.outlook.nextFirstWeek.reason || null } : absent(h.outlook.nextFirstWeek?.reason || "fewer than three clean first weeks"), coolOff: h.outlook.coolOff ? { ageDays: h.outlook.coolOff.ageDays, word: h.outlook.coolOff.word || null, reason: h.outlook.coolOff.reason || null } : null } : null,
  };
}

function directionDigest(data) {
  const d = data.baselines?.direction;
  if (!d) return absent("no direction lens yet");
  return { overall: d.overall || null, votes: d.votes || [], measures: (d.measures || []).map((t) => ({ key: t.key, name: DIRECTION_WORDS[t.key] || t.key, word: t.direction || null, pctPerEpisode: t.pctPerEpisode ?? null, readings: t.n ?? (t.points || []).length, comparedHow: t.ageBasis ? COMPARED[t.ageBasis] : null, reason: t.direction ? null : (t.reason || null) })) };
}
function outlookDigest(data) {
  const o = data.baselines?.outlook;
  if (!o) return absent("no outlook yet");
  const n = o.nextFirstWeek || {};
  return { nextFirstWeek: n.low != null ? { low: n.low, high: n.high, typical: n.typical, cleanWeeks: n.n, direction: n.direction || null, reason: n.reason || null } : absent(n.reason || "fewer than three clean first weeks"), coolOff: o.coolOff ? { ageDays: o.coolOff.ageDays, word: o.coolOff.word || null, reason: o.coolOff.reason || null } : null };
}

export function buildDigest(data) {
  const eps = [...(data.episodes || [])].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
  const latestSnapshot = eps.map((e) => e.latest?.ts).filter(Boolean).sort().at(-1) || null;
  const sumAvailable = (f) => {
    const values = eps.map(f).filter(Number.isFinite);
    return values.length ? values.reduce((a, value) => a + value, 0) : null;
  };
  const youtubeComplete = eps.length > 0 && eps.every((e) => Number.isFinite(e.latest?.ytTotal) && e.latest.ytTotal > 0);
  const youtubeTotal = youtubeComplete ? eps.reduce((a, e) => a + e.latest.ytTotal, 0) : null;
  const viewsComplete = youtubeComplete && eps.every((e) => Number.isFinite(e.latest?.totalViews));
  const viewsTotal = viewsComplete ? eps.reduce((a, e) => a + e.latest.totalViews, 0) : null;
  const youtubeMarkers = eps.flatMap((e) => {
    if (!(Number.isFinite(e.latest?.ytTotal) && e.latest.ytTotal > 0)) return [`E${e.ep} missing`];
    if (e.latest?.youtubeStale) return [`E${e.ep} old${e.latest.youtubeAsOf ? ` (${day(e.latest.youtubeAsOf)})` : ""}`];
    return [];
  });
  const totalsReason = !youtubeComplete
    ? "YouTube views are not available for every episode yet."
    : youtubeMarkers.length
      ? "Some YouTube views are from an older reading."
      : null;
  const markers = eps.filter((e) => e.latest?.xPlaysInfo?.partial || e.latest?.xPlaysInfo?.stale).map((e) => `E${e.ep}`);
  const cs = data.commentSummary || {};
  return {
    version: BRIEF_VERSION,
    generatedAt: data.generatedAt,
    clocks: { data: data.generatedAt, dataThrough: latestSnapshot, healthRead: data.health?.date || null, healthDataThrough: data.health?.dataThrough || null, chaptersWritten: data.chaptersUpdatedAt || null },
    site: SITE,
    show: {
      name: "Dive Radio", episodes: eps.length, first: eps[0] ? { ep: eps[0].ep, premiere: eps[0].premiere } : null, latest: eps.at(-1) ? { ep: eps.at(-1).ep, premiere: eps.at(-1).premiere, title: short(eps.at(-1).title) } : null,
      channels: (data.dests || []).map((d) => ({ key: d.key, label: d.label, platform: d.platform })),
      totals: { views: viewsTotal, youtube: youtubeTotal, xPlays: sumAvailable((e) => e.latest?.xPlays), xReach: sumAvailable((e) => e.latest?.xImpressions), incomplete: !viewsComplete || youtubeMarkers.length > 0, reason: totalsReason, youtubeMarkers, xPlaysMarkers: markers },
      feedback: cs.captured != null ? { captured: cs.captured, directional: cs.feedbackCount, people: cs.uniqueCommenters, enjoyed: cs.enjoyCount, concerns: cs.complaintCount, enjoyThemes: cs.enjoyThemes || [], concernThemes: cs.complaintThemes || [] } : absent("no comments captured"),
    },
    health: healthDigest(data),
    direction: directionDigest(data),
    outlook: outlookDigest(data),
    recommendations: (data.insights || []).filter((i) => i.rank != null).sort((a, b) => a.rank - b.rank).map((i) => ({ rank: i.rank, id: i.id, category: i.category, serves: i.serves || null, finding: i.text, action: i.recommendation, caveat: i.caveat || null })),
    episodes: eps.map((e) => episodeDigest(e, data)),
    trajectory: {
      firstWeeks: (data.showTrend?.week1VelocityByEpisode || []).map((w) => ({ slug: w.slug, title: short(w.title), premiere: w.premiere, value: w.value ?? null, note: w.note || null })),
      newestPace: (() => { const n = eps.at(-1); const p = n && data.baselines?.pace?.[n.slug]; return p?.rank != null ? { ep: n.ep, rank: p.rank, of: p.of, pct: p.pct, ageDays: p.ageDays } : absent(p?.reason || "pace needs three other episodes at this age"); })(),
      newestVsPrevious: data.baselines?.newestVsPrevious || null,
    },
    knownBreaks: data.baselines?.knownBreaks || [],
    definitions: DEFINITIONS,
    lineage: lineageDigest(data),
    covers: COVERS, leavesOut: LEAVES_OUT,
  };
}

export const DEFINITIONS = Object.freeze([
  ["typical", "the median of the usable peers among the eight episodes before the one being read: promo outliers out, peers without a reading on the needed basis out, three or nothing."],
  ["same age", "a value taken from the daily snapshot at the same days-since-premiere as the episode under test — the only honest way to compare a young episode with older ones."],
  ["as the earlier episodes stand now", "a comparison made with the earlier episodes' current (matured, at least twenty-one days) values because no same-age history exists yet; the note says so."],
  ["clean", "not a promo outlier, not tracked late, with the needed snapshot coverage."],
  ["promo outlier", "an episode whose YouTube views, X plays, or X reach exceed twice the same-age typical of the nearby episodes; provisional before day twenty-one, settled after. Its own lift is shown but scores nothing (qualified); it is left out of every typical."],
  ["carried", "a show-health measure read from an older, finished episode because the newest is too young; it counts at half weight and names the episode it read."],
  ["swing and bands", "a measure's swing is the median absolute deviation of its peers from their typical, as a share of the typical; a check's bands are half its measures' median swing either side of fifty, never narrower than five points nor wider than fifteen; the state word (healthy / steady / fragile) follows the bands."],
  ["launch word", "an episode's first-week standing in one word — strong, typical, or soft — from YouTube views at day seven (or the earliest reading, or the current age while under a week, marked provisional) against the other episodes at that age, promo outliers out, three or nothing."],
  ["first week vs launch reading", "a first week needs a clean seven-day record and feeds the growth slope; a launch reading is the same-age standing available from the first day and can exist where a first week cannot (an episode tracked late)."],
  ["episode health", "a frozen zero-to-hundred read written once the episode is twenty-one days old, comparing it with the episodes that aired before it; fifty is typical; two episodes' scores are not on one baseline."],
  ["show health", "a daily read of the newest episode at its age against the show's usual levels — seven checks, each a mean of its measures at fifty times own over typical; the words are model-written over these facts and cite them."],
  ["direction", "each durable measure's change per episode (Theil–Sen slope) over the last five clean episodes; a word needs four; building above plus five percent, softening below minus five; the overall word is single only when every check agrees, otherwise mixed."],
  ["outlook", "where the last three clean first weeks landed (lowest, highest, typical) with their direction — a description of what happened, never a bound on what will; the cool-off is the newest episode's growth over its last two days."],
  ["hold rate", "the live audience over the last ten minutes of the session as a share of the peak."],
  ["discovery share", "the share of an episode's YouTube views that YouTube itself brought — search, suggested videos, Shorts, browse."],
  ["total views", "YouTube views plus resolved X broadcast plays; native tweet and teaser-video plays are excluded. X reach (impressions on the announce posts) is exposure and is never added in."],
]);

function lineageDigest(data) {
  const eps = data.episodes || [];
  const latestSnapshot = eps.map((e) => e.latest?.ts).filter(Boolean).sort().at(-1) || null;
  const analytics = eps.map((e) => e.watch?.updatedAt).filter(Boolean).sort().at(-1) || null;
  return {
    stores: [
      { store: "daily snapshots (YouTube Data API, X)", stamp: latestSnapshot, note: "append-only time series per destination; the source of views, likes, comments, X reach and plays" },
      { store: "YouTube analytics (owner OAuth)", stamp: analytics, note: "share watched, average duration, minutes watched, traffic sources, subscribers gained; a daily history line per episode since 2026-08-23" },
      { store: "Restream live events", stamp: eps.map((e) => e.live ? e.premiere : null).filter(Boolean).sort().at(-1), note: "peak, average, unique viewers, minutes watched, chat; frozen at first ingest" },
      { store: "audience comments + classifier", stamp: data.commentSummary?.captured != null ? data.generatedAt : null, note: "YouTube comments and X replies, model-labelled; noise, neutral text, and pending items stay off" },
      { store: "show-health read", stamp: data.health?.date || null, note: `${data.health?.formulaVersion || "—"}; model prose over deterministic checks; deterministic fallback when the model fails` },
      { store: "recommendations", stamp: data.generatedAt, note: "five ranked actions, model-written over the day's fact sheet and health read; every number grounded" },
      { store: "chapters", stamp: data.chaptersUpdatedAt || null, note: "model-written per transcript, every timestamp and quote grounded in the transcript" },
    ],
    cadence: "one chain run at 07:00 America/Phoenix (pull, capture, score, write, validate, publish); a freshness check at 08:15 and noon",
    site: SITE,
  };
}

// --- the markdown ------------------------------------------------------------------
export function renderMarkdown(digest) {
  const L = [];
  const p = (s = "") => L.push(s);
  const abs = (v) => (v && typeof v === "object" && "value" in v && v.value === null);
  const c = digest.clocks;
  p(`# Dive Radio — agent brief`);
  p();
  p(`Built ${c.data} · data through ${day(c.dataThrough)} · health read ${c.healthRead || "none"}${c.healthDataThrough ? ` (data through ${day(c.healthDataThrough)})` : ""} · chapters written ${c.chaptersWritten ? day(c.chaptersWritten) : "none yet"} · brief v${digest.version}`);
  p();
  p(HEADINGS[0]);
  p();
  p(`This is the complete read of the Dive Radio live show as of its last data refresh: performance by platform, comparisons made like for like, today's show-health read, the five actions for the week, every episode with its chapters, moments, and audience words, the trajectory, and the definitions behind each number. It is written by the same deterministic build that renders ${SITE}, from the same stores, and it is rebuilt on every refresh. Where a number is missing, a dash and its reason stand in its place.`);
  p();
  p(`Three clocks: the data build (${c.data}); the show-health read (${c.healthRead || "none"}, over data through ${c.healthDataThrough ? day(c.healthDataThrough) : "—"} — section 3's numbers are as of that read and can sit a day behind section 5's); the chapters (${c.chaptersWritten ? day(c.chaptersWritten) : "none yet"}).`);
  p();
  p(`Rules every number here follows:`);
  p(`- Total views = YouTube views + resolved X broadcast plays. Native tweet and teaser-video plays are excluded. X reach is exposure and is never added in.`);
  p(`- An absent value is a dash with its reason; it is never zero and never estimated.`);
  p(`- Every comparison names how it was made: at the same age, or as the earlier episodes stand now.`);
  p(`- A promo-driven lift is shown and marked; it scores nothing and is left out of every typical.`);
  p(`- Model-written words (the health headline and drivers, the recommendations, the chapters, the moment notes) are labelled and cite the facts they rest on; everything else is arithmetic over the stores.`);
  p(`- Fewer than three comparable readings means no claim, not a caveated one.`);
  p();
  p(`Not here: the raw daily series, the per-minute live audience, the hundred-point watch curves, and every individual comment — section 10 says where they are.`);
  p();
  // 2
  const s = digest.show;
  p(HEADINGS[1]);
  p();
  p(`- Episodes: ${s.episodes} (E${s.first?.ep} on ${s.first?.premiere} → E${s.latest?.ep} on ${s.latest?.premiere}, "${esc(s.latest?.title)}"), a weekly live show with call-ins.`);
  p(`- Channels: ${s.channels.map((ch) => `${ch.label} (${ch.key})`).join("; ")}.`);
  p(`- Views so far: ${fmtNum(s.totals.views)} total = ${fmtNum(s.totals.youtube)} YouTube${s.totals.youtubeMarkers.length ? ` (${s.totals.youtubeMarkers.join(", ")})` : ""} + ${fmtNum(s.totals.xPlays)} X plays${s.totals.xPlaysMarkers.length ? ` (X plays ${s.totals.xPlaysMarkers.join(", ")} carry a partial or stale marker)` : ""}.${s.totals.reason ? ` ${esc(s.totals.reason)}` : ""} X reach so far: ${fmtNum(s.totals.xReach)} (exposure, kept apart).`);
  p(abs(s.feedback) ? `- Audience feedback: — (${s.feedback.reason}).` : `- Audience feedback captured: ${fmtNum(s.feedback.captured)} comments, ${fmtNum(s.feedback.directional)} with a clear lean from ${fmtNum(s.feedback.people)} people (${fmtNum(s.feedback.enjoyed)} enjoyed, ${fmtNum(s.feedback.concerns)} raised a concern).${s.feedback.enjoyThemes.length ? ` Enjoyed: ${themeWords(s.feedback.enjoyThemes).join(", ")}.` : ""}${s.feedback.concernThemes.length ? ` Concerns: ${themeWords(s.feedback.concernThemes).join(", ")}.` : ""}`);
  p(`- Dashboard: ${SITE}`);
  p();
  // 3
  const h = digest.health;
  p(HEADINGS[2]);
  p();
  if (abs(h)) p(`— (${h.reason})`);
  else if (h.withheld) p(`Withheld: ${h.reason} (saved ${h.date}, ${h.ageDays} days ago).`);
  else {
    p(`Read saved ${h.date} over data through ${day(h.dataThrough)} (${h.ageDays === 0 ? "today" : `${h.ageDays} day(s) behind the data`}); state: ${h.readState}${h.readsOn?.provisional ? " — the newest episode is under a week old" : ""}. Formula ${h.formulaVersion}.`);
    p();
    p(`**Score ${h.score} of 100 — ${h.band}** (fifty is the show's usual level). Direction over the last clean episodes, as of the read: **${h.direction?.overall || digest.direction.overall || "—"}**.`);
    p();
    p(`Every number in this section is as the read saw it (data through ${day(h.dataThrough)}); the episode tables in sections 5 and 6 are as of this build and can be newer.`);
    p();
    p(`Headline (model-written): ${esc(h.headline)}`);
    if (h.readsOn) p(`Reads ${esc(h.readsOn.episode)}, ${fmtNum(h.readsOn.ageDays, 1)} days in${h.readsOn.carried.length ? `; ${h.readsOn.carried.map((k) => CHECK_WORDS[k] || k).join(", ")} carried from the latest finished episode at half weight` : ""}${h.readsOn.promoQualified.length ? `; shown but not scored (promo-driven): ${h.readsOn.promoQualified.map((q) => MEASURE_WORDS[q.split(".")[1]] || q).join(", ")}` : ""}.`);
    p();
    p(`| Check | State | Score | Bands (fragile under / healthy from) | Usual swing |`);
    p(`|---|---|---|---|---|`);
    for (const ch of h.checks) p(`| ${ch.name}${ch.carried ? " (carried)" : ""} | ${ch.state} | ${ch.score ?? "—"} | ${ch.bands ? `${ch.bands.steady} / ${ch.bands.healthy}` : "—"} | ${ch.swing != null ? `±${ch.swing}%` : "—"} |`);
    p();
    for (const ch of h.checks) {
      p(`- **${ch.name}** — ${ch.state}${ch.score == null && ch.reason ? ` (${esc(ch.reason)})` : ""}`);
      for (const m of ch.measures) {
        if (m.value == null) { p(`  - ${m.name}: — (${esc(m.reason || "no reading")})`); continue; }
        const bits = [`${fmtNum(m.value, Number.isInteger(m.value) ? 0 : 1)}${m.typical != null ? ` vs typical ${fmtNum(m.typical, Number.isInteger(m.typical) ? 0 : 1)}` : ""}`];
        if (m.comparedHow) bits.push(m.comparedHow);
        if (m.sample) bits.push(`${m.sample} peers`);
        if (m.swing != null) bits.push(`usual swing ±${m.swing}%`);
        if (m.absoluteNote) bits.push(m.absoluteNote);
        if (m.qualified) bits.push("promo-driven lift — shown, not scored");
        if (m.carriedNote) bits.push(m.carriedNote);
        const brk = (digest.knownBreaks || []).find((b) => b.measures.includes(m.key));
        if (brk) bits.push(`known reporting break: ${brk.note}`);
        p(`  - ${m.name}: ${bits.join("; ")}`);
      }
    }
    p();
    p(`Helping:`); for (const b of h.helping) p(`- ${esc(b.text)} [${b.factId}]`);
    p(`Needs work:`); for (const b of h.needsWork) p(`- ${esc(b.text)} [${b.factId}]`);
    p();
    if (h.drivers.length) { p(`Reasoning (model-written):`); for (const d of h.drivers) p(`- ${esc(d)}`); p(); }
    if (h.checkSetChange) p(`Check set changed since the previous read: joined ${(h.checkSetChange.joined || []).map((k) => CHECK_WORDS[k] || k).join(", ") || "none"}; left ${(h.checkSetChange.left || []).map((k) => CHECK_WORDS[k] || k).join(", ") || "none"} (previous score ${h.checkSetChange.previousScore ?? "—"}).`), p();
    if (h.facts.length) {
      p(`Facts behind the read (cite by id):`);
      p(`| id | value | fact |`); p(`|---|---|---|`);
      for (const f of h.facts) p(`| ${f.id} | ${esc(f.display)} | ${esc(f.text)} |`);
      p();
    }
    const d = h.direction;
    if (d) {
      p(`Direction of each durable measure as of the read (last five clean episodes; a word needs four; the facts above carry the same slopes):`);
      p(`| Measure | Word | Change each episode | Readings |`); p(`|---|---|---|---|`);
      for (const t of d.measures) p(`| ${t.name} | ${t.word || (t.reason ? `— (${esc(t.reason)})` : "—")} | ${t.pctPerEpisode == null ? "—" : `${t.pctPerEpisode >= 0 ? "+" : ""}${fmtNum(t.pctPerEpisode, 1)}%`} | ${t.readings ?? "—"} |`);
      p();
    }
    const o = h.outlook;
    if (o) {
      const n = o.nextFirstWeek;
      p(abs(n) ? `Outlook as of the read: — (${n.reason}).` : `Outlook as of the read: the last three clean first weeks ran ${fmtNum(n.low)}–${fmtNum(n.high)} YouTube views (typical ${fmtNum(n.typical)}); where the next lands if it follows them, never a bound. First-week direction: ${n.direction || `too few for a word${n.reason ? ` (${esc(n.reason)})` : ""}`}.${o.coolOff ? ` Cool-off of the newest episode at ${fmtNum(o.coolOff.ageDays, 1)} days: ${o.coolOff.word || `— (${esc(o.coolOff.reason || "no reading")})`}.` : ""}`);
      p();
    }
  }
  if ((digest.knownBreaks || []).length) { p(`Known reporting breaks:`); for (const b of digest.knownBreaks) p(`- From E${b.fromEp} (${b.from}): ${esc(b.note)} — touches ${b.measures.map((k) => MEASURE_WORDS[k] || DIRECTION_WORDS[k] || k).join(", ")}.`); p(); }
  // 4
  p(HEADINGS[3]);
  p();
  if (!digest.recommendations.length) p(`— (no ranked recommendations saved yet)`);
  for (const r of digest.recommendations) { p(`${r.rank}. [${r.category}${r.serves ? ` · helps ${(CHECK_WORDS[r.serves] || r.serves).toLowerCase()}` : ""}] ${esc(r.finding)}`); p(`   → ${esc(r.action)}${r.caveat ? ` (${esc(r.caveat)})` : ""}`); }
  p();
  // 5
  p(HEADINGS[4]);
  p();
  p(`Views as of ${day(c.dataThrough)}; first week, launch, and pace at the same age; episode health is the frozen day-twenty-one read.`);
  p();
  p(`| Ep | Date | Title | YouTube | X plays | X reach | Total | First week | Launch | Pace | Ep. health | Live peak / avg / people / min | Min per viewer | Hold | Watched | Subs/1k | Discovery | Feedback + / − | Promo |`);
  p(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const e of digest.episodes) {
    const fw = abs(e.firstWeek) ? "—¹" : fmtNum(e.firstWeek.value);
    const la = abs(e.launch) ? "—" : `${e.launch.promoDriven ? "promo-driven" : e.launch.word}${e.launch.provisional ? " (so far)" : ""}`;
    const pa = abs(e.pace) ? "—" : `#${e.pace.rank} of ${e.pace.of} (${e.pace.pct >= 0 ? "+" : ""}${e.pace.pct}%)`;
    const eh = abs(e.health) ? "—²" : String(e.health.score);
    const lv = abs(e.live) ? "—" : `${fmtNum(e.live.peak)} / ${fmtNum(e.live.average)} / ${fmtNum(e.live.uniqueViewers)} / ${fmtNum(e.live.minutesWatched)}`;
    const fb = abs(e.feedback) ? "—" : `${fmtNum(e.feedback.enjoyed)} / ${fmtNum(e.feedback.concerns)}`;
    p(`| E${e.ep} | ${e.premiere} | ${esc(e.title)} | ${fmtNum(e.views.youtube)} | ${fmtNum(e.views.xPlays)}${e.views.xPlaysMarker ? ` (${e.views.xPlaysMarker})` : ""} | ${fmtNum(e.views.xReach)} | ${fmtNum(e.views.total)} | ${fw} | ${la} | ${pa} | ${eh} | ${lv} | ${abs(e.live) ? "—" : fmtNum(e.live.minutesPerViewer, 1)} | ${abs(e.live) || e.live.holdRate == null ? "—" : pct(e.live.holdRate, 0)} | ${abs(e.watching) ? "—" : pct(e.watching.sharePercent)} | ${e.subsPer1k == null ? "—" : fmtNum(e.subsPer1k, 1)} | ${e.discoveryShare == null ? "—" : pct(e.discoveryShare)} | ${fb} | ${e.promo ? (e.promo.provisional ? "yes (provisional)" : "yes") : "no"} |`);
  }
  p();
  p(`¹ no clean first week — each episode's own reason is in section 6. ² no finished read yet — the reason is in section 6.`);
  p();
  // 6
  p(HEADINGS[5]);
  p();
  const fullFrom = Math.max(0, digest.episodes.length - BUDGET.fullSectionsForLast);
  digest.episodes.forEach((e, i) => {
    p(`### E${e.ep} — ${esc(e.title)} (${e.premiere})`);
    p();
    const yt = Object.entries(e.links.youtube).map(([k, u]) => `YouTube ${k.replace("yt:", "")} ${u}`);
    const xr = Object.entries(e.links.xReplays).map(([k, u]) => `X replay ${k.replace("x:", "@")} ${u}`);
    const an = e.links.announces.filter((a) => a.url).map((a) => `announce @${a.account} ${a.url}`);
    p(`Links: ${[...yt, ...xr, ...an].join(" · ")}${e.links.transcript ? ` · transcript ${e.links.transcript}` : " · no transcript"} · dashboard ${e.dashboard}`);
    if (i < fullFrom) { p(`(older episode — table row and links only; the full section is in agent.json)`); p(); return; }
    const standing = [];
    standing.push(abs(e.launch) ? `launch — (${e.launch.reason})` : `launch ${e.launch.promoDriven ? "promo-driven" : e.launch.word}${e.launch.provisional ? " so far" : ""}: ${fmtNum(e.launch.value)} YouTube views against a typical ${fmtNum(e.launch.typical)} at that age (${e.launch.pct >= 0 ? "+" : ""}${e.launch.pct}%, ${e.launch.peers} peers)`);
    standing.push(abs(e.pace) ? `pace — (${e.pace.reason})` : `pace #${e.pace.rank} of ${e.pace.of} at ${fmtNum(e.pace.ageDays, 1)} days (${e.pace.pct >= 0 ? "+" : ""}${e.pace.pct}% against the typical ${fmtNum(e.pace.typical)})`);
    standing.push(abs(e.firstWeek) ? `first week — (${esc(e.firstWeek.reason)})` : `first week ${fmtNum(e.firstWeek.value)} YouTube views`);
    if (e.promo) standing.push(`promo outlier${e.promo.provisional ? " (provisional until day twenty-one)" : ""}: ${esc(e.promo.note)}`);
    if (e.trackedLate) standing.push("tracked late: first snapshot more than five days after premiere, so its first week is undefined");
    p(`Standing: ${standing.join("; ")}.`);
    p(`Views: ${fmtNum(e.views.youtube)} YouTube${e.views.youtubeMarker === "old" ? ` (old reading${e.views.youtubeAsOf ? ` from ${day(e.views.youtubeAsOf)}` : ""})` : e.views.youtubeMarker === "missing" ? " (missing)" : ""} + ${fmtNum(e.views.xPlays)} X plays${e.views.xPlaysMarker ? ` (${e.views.xPlaysMarker})` : ""} = ${fmtNum(e.views.total)}${e.views.reason ? ` (${esc(e.views.reason)})` : ""}; X reach ${fmtNum(e.views.xReach)}; likes and comments per thousand YouTube views ${e.engagementPer1k == null ? "—" : fmtNum(e.engagementPer1k, 1)}.`);
    p(abs(e.watching) ? `Watching: — (${e.watching.reason}).` : `Watching (YouTube analytics, ${day(e.watching.updatedAt)}): ${pct(e.watching.sharePercent)} of the video watched on average, ${e.watching.avgDurationSec == null ? "—" : minutes(e.watching.avgDurationSec)} per view, ${fmtNum(e.watching.minutesWatched)} minutes watched in all; views came from ${e.watching.traffic.map((t) => `${t.source} ${pct(t.share)}`).join(", ")}; subscribers per thousand views ${e.subsPer1k == null ? "—" : fmtNum(e.subsPer1k, 1)}; discovery share ${e.discoveryShare == null ? "—" : pct(e.discoveryShare)}.`);
    p(abs(e.live) ? `Live session: — (${e.live.reason}).` : `Live session: peak ${fmtNum(e.live.peak)}, average ${fmtNum(e.live.average)}, ${fmtNum(e.live.uniqueViewers)} people watched live for ${fmtNum(e.live.minutesWatched)} minutes in all (${e.live.minutesPerViewer == null ? "—" : fmtNum(e.live.minutesPerViewer, 1)} minutes each; ${e.live.holdRate == null ? "hold rate —" : `${pct(e.live.holdRate, 0)} of the peak still watching at the end`}); ${fmtNum(e.live.chatMessages)} chat messages from ${fmtNum(e.live.chatters)} people over ${fmtNum(e.live.durationMin)} minutes.${(digest.knownBreaks || []).some((b) => e.ep >= b.fromEp) ? " Note the live-reporting break in section 3." : ""}`);
    if (abs(e.chapters)) p(`Chapters: — (${e.chapters.reason}).`);
    else {
      p(`Chapters (model-written from the transcript, ${e.chapters.status}; timestamps on ${e.chapters.clock === "upload" ? "the YouTube upload's clock — links jump to the moment" : "the live recording's clock — a few minutes off the upload, so no links"}):`);
      for (const ch of e.chapters.list) p(`- ${ch.start} — ${esc(ch.title)}: ${esc(ch.gist)}${ch.link ? ` (${ch.link})` : ""}`);
    }
    if (e.moments.length) {
      p(`Watch moments (from the YouTube retention curve; positions approximate):`);
      for (const m of e.moments) p(`- ${m.kind === "drop" ? "Drop" : "Hold"} about ${m.minutesIn} min in (${Math.round(m.at * 100)}% of the way): ${m.kind === "drop" ? `${fmtNum(m.points, 1)} of every hundred viewers left` : `${fmtNum(m.points, 1)} of every hundred extra were watching`}${m.summary ? ` — ${esc(m.summary)}` : ""}${m.excerpt ? ` — "${m.excerpt}"` : ""}`);
    }
    if (abs(e.feedback)) p(`Feedback: — (${e.feedback.reason}).`);
    else {
      p(`Feedback: ${fmtNum(e.feedback.captured)} comments captured, ${fmtNum(e.feedback.directional)} with a clear lean from ${fmtNum(e.feedback.people)} people (${fmtNum(e.feedback.enjoyed)} enjoyed, ${fmtNum(e.feedback.concerns)} concerns)${e.feedback.xReplies === "covered" ? "; X replies included" : "; X replies not covered"}.${e.feedback.enjoyThemes.length ? ` Enjoyed: ${themeWords(e.feedback.enjoyThemes).join(", ")}.` : ""}${e.feedback.concernThemes.length ? ` Concerns: ${themeWords(e.feedback.concernThemes).join(", ")}.` : ""}`);
      for (const q of e.feedback.featured) p(`- "${q.text}" — ${esc(q.author)} on ${q.source === "x" ? "X" : "YouTube"}`);
    }
    p(abs(e.health) ? `Episode health: — (${esc(e.health.reason)}).` : `Episode health: ${e.health.score} of 100, read on ${day(e.health.readOn)}${e.health.checks ? ` — ${Object.entries(e.health.checks).map(([k, v]) => `${k} ${v.score ?? `— (${esc(v.reason || "no reading")})`}`).join("; ")}` : ""}.`);
    p();
  });
  // 7
  const t = digest.trajectory;
  p(HEADINGS[6]);
  p();
  p(`First weeks in air order (YouTube views at day seven; a launch reading stands in where a clean first week does not exist):`);
  p(`| Ep | Date | First week | Launch reading |`); p(`|---|---|---|---|`);
  for (const w of t.firstWeeks) { const e = digest.episodes.find((x) => x.slug === w.slug); const la = e && !abs(e.launch) ? `${fmtNum(e.launch.value)} (${e.launch.promoDriven ? "promo-driven" : e.launch.word}${e.launch.provisional ? ", so far" : ""})` : "—"; p(`| E${e?.ep ?? "?"} | ${w.premiere} | ${w.value == null ? `— (${esc(w.note || "no clean first week")})` : fmtNum(w.value)} | ${la} |`); }
  p();
  p(abs(t.newestPace) ? `Newest episode's pace: — (${t.newestPace.reason}).` : `Newest episode's pace: E${t.newestPace.ep} is #${t.newestPace.rank} of ${t.newestPace.of} at ${fmtNum(t.newestPace.ageDays, 1)} days (${t.newestPace.pct >= 0 ? "+" : ""}${t.newestPace.pct}% against the typical), promo-driven lifts shown as such above.`);
  if (t.newestVsPrevious) p(`Newest against the previous episode at the same age (${fmtNum(t.newestVsPrevious.ageDays, 1)} days): X reach ${t.newestVsPrevious.reach?.pct == null ? "—" : `${t.newestVsPrevious.reach.pct >= 0 ? "+" : ""}${t.newestVsPrevious.reach.pct}%`}, share watched ${t.newestVsPrevious.watched?.pct == null ? "—" : `${t.newestVsPrevious.watched.pct >= 0 ? "+" : ""}${t.newestVsPrevious.watched.pct}%`}, live ${t.newestVsPrevious.live?.pct == null ? "—" : `${t.newestVsPrevious.live.pct >= 0 ? "+" : ""}${t.newestVsPrevious.live.pct}%`}.`);
  const d7 = digest.direction;
  if (!abs(d7)) {
    p();
    p(`Direction as of this build (the read in section 3 may be a day behind): overall **${d7.overall || "—"}**.`);
    p(`| Measure | Word | Change each episode | Readings | Compared how |`); p(`|---|---|---|---|---|`);
    for (const t of d7.measures) p(`| ${t.name} | ${t.word || (t.reason ? `— (${esc(t.reason)})` : "—")} | ${t.pctPerEpisode == null ? "—" : `${t.pctPerEpisode >= 0 ? "+" : ""}${fmtNum(t.pctPerEpisode, 1)}%`} | ${t.readings} | ${t.comparedHow || "—"} |`);
  }
  const o7 = digest.outlook;
  if (!abs(o7)) {
    const n = o7.nextFirstWeek;
    p(abs(n) ? `Outlook as of this build: — (${n.reason}).` : `Outlook as of this build: ${fmtNum(n.low)}–${fmtNum(n.high)} YouTube views (typical ${fmtNum(n.typical)}), first-week direction ${n.direction || "too few for a word"}${o7.coolOff ? `; cool-off of the newest episode at ${fmtNum(o7.coolOff.ageDays, 1)} days: ${o7.coolOff.word || `— (${esc(o7.coolOff.reason || "no reading")})`}` : ""}.`);
  }
  p();
  // 8
  p(HEADINGS[7]);
  p();
  for (const [term, def] of digest.definitions) p(`- **${term}** — ${def}`);
  p();
  // 9
  p(HEADINGS[8]);
  p();
  p(`| Store | Freshest stamp | What it feeds |`); p(`|---|---|---|`);
  for (const st of digest.lineage.stores) p(`| ${st.store} | ${st.stamp ? day(st.stamp) : "—"} | ${esc(st.note)} |`);
  p();
  p(`Cadence: ${digest.lineage.cadence}. The build is deterministic and reproducible byte for byte from the stores; the validator refuses to publish when any surface disagrees with its store.`);
  p();
  // 10
  p(HEADINGS[9]);
  p();
  p(`- ${SITE}/agent.json — this brief as data (the same digest, with the grounding quote behind each chapter)`);
  p(`- ${SITE}/data.json — the raw data the dashboard renders: daily series per destination, per-minute live audience, watch curves, every classified comment`);
  p(`- ${SITE}/llms.txt — the index of everything here`);
  p(`- ${SITE}/agent-skill.md — a drop-in skill for Claude Code and OpenClaw`);
  for (const e of digest.episodes) if (e.links.transcript) p(`- ${e.links.transcript} — E${e.ep} transcript (${e.chapters && !abs(e.chapters) ? `${e.chapters.clock === "upload" ? "YouTube caption" : "live speaker"} format` : "text"})`);
  p(`- ${SITE} — the dashboard; "About this data" at the bottom carries the methodology in the owners' words`);
  p();
  p(`Left out of this brief on purpose (in data.json instead):`);
  for (const x of digest.leavesOut) p(`- ${x.path} — ${x.reason}`);
  p();
  return L.join("\n");
}

export function renderLlms(digest) {
  const L = [];
  L.push(`# Dive Radio analytics`);
  L.push(``);
  L.push(`> The complete performance read of the Dive Radio live show — views by platform, like-for-like comparisons, show and episode health, the direction of every measure, five ranked actions, every episode's chapters with timestamps, the audience's words, and the definitions behind each number. Rebuilt on every data refresh (${digest.generatedAt}).`);
  L.push(``);
  L.push(`## Read first`);
  L.push(`- [Agent brief](${SITE}/agent.md): everything, for reading — start with its first section`);
  L.push(`- [Agent digest](${SITE}/agent.json): the same content as data`);
  L.push(`- [Skill](${SITE}/agent-skill.md): a drop-in skill file for Claude Code and OpenClaw`);
  L.push(``);
  L.push(`## Raw data`);
  L.push(`- [data.json](${SITE}/data.json): every number the dashboard renders, including the daily series and watch curves`);
  L.push(``);
  L.push(`## Transcripts`);
  for (const e of digest.episodes) if (e.links.transcript) L.push(`- [E${e.ep} — ${e.title}](${e.links.transcript})`);
  L.push(``);
  L.push(`## The dashboard`);
  L.push(`- [Dive Radio dashboard](${SITE}): the human view; "About this data" holds the methodology`);
  L.push(``);
  return L.join("\n");
}

export function buildBrief(data) {
  const digest = buildDigest(data);
  return { md: renderMarkdown(digest), json: JSON.stringify(digest, null, 1) + "\n", llms: renderLlms(digest), digest };
}
