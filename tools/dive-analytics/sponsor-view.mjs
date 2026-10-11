// sponsor-view.mjs — the sponsor page's projection (data.sponsor, 2026-10-11).
//
// The sponsor page answers one question for a brand deciding whether to book
// the show: who is in this room, how many, how engaged, and what does a
// partnership look like on air. Pure over the episodes build-data has already
// assembled plus three stores: channel-stats (subscribers and followers),
// contributors (aired call-ins, from the owner's published episode notes) and
// clock-checks (which uploads run on the transcript's clock, so a moment links
// to its exact second). Transcripts arrive parsed (transcripts.mjs).
//
// Honesty rules, the same as every surface:
//   • every number is a sum, a count, or a trueMedian (baselines.mjs) of stored
//     values — nothing estimated, nothing interpolated;
//   • views = YouTube views + resolved X broadcast plays; X reach stays apart;
//   • live viewers are never added across shows (one person watches many);
//   • a median needs MIN_PEERS readings, a measure touched by a known
//     reporting break reads only the shows on the newest side of it;
//   • a missing input leaves its field null with a reason, never a zero;
//   • quotes and excerpts are verbatim (a quote loses only its leading
//     @-mentions and trailing links); a timestamp links only by clock.mjs.

import { trueMedian, windowFor, MIN_PEERS, liveRatesOf, comparableAcrossBreaks } from "./baselines.mjs";
import { hasNegativeSignal } from "../../scripts/restream/comments-sentiment.mjs";
import { linkableUpload, momentUrl } from "./clock.mjs";

export const SPONSOR_VERSION = 1;

// The show's partners this season (sponsor pipeline, 2026-08-15). A partner's
// on-air moments are found by name; nothing is credited to a partner the
// transcript does not name.
export const PARTNERS = Object.freeze(["Notion", "Mobbin", "Lovable", "Paper"]);

// Brands counted when they come up on air: tools and companies, named as said.
// The platforms the show streams and chats on (YouTube, X, LinkedIn, Discord,
// Slack) are where it lives, not what it discusses, so they are not counted.
// Case-sensitive whole words: "Paper" the tool, not "paper"; "Linear", not "linear".
export const BRANDS = Object.freeze([
  "Figma", "Claude", "Notion", "Lovable", "Vercel", "Cursor", "Mobbin", "OpenAI", "Framer", "Google", "Apple",
  "Rive", "GitHub", "Perplexity", "Grok", "Paper", "Anthropic", "Adobe", "Shopify", "Raycast", "ChatGPT", "Loom",
  "Arc", "Airbnb", "Stripe", "Spline", "Unicorn Studio", "Duolingo", "Microsoft", "Webflow", "Ramp", "Higgsfield",
  "Linear", "Dia", "MagicPath", "Tailwind", "Granola", "Miro", "Runway", "Midjourney", "Netflix", "Mercury", "Attio",
  "Gemini", "Replit", "Canva", "Krea", "Kling", "ElevenLabs", "Wispr", "Superwhisper", "tldraw", "Relume",
  "Dribbble", "Behance", "Substack", "Beehiiv", "Pinterest", "Codex", "Sora", "Lottie", "Jitter", "Midjourney",
].filter((name, i, all) => all.indexOf(name) === i));
export const BRAND_MIN_MENTIONS = 3;
export const BRAND_TOP = 20;
export const QUOTES_TOP = 24;
export const QUOTE_MIN = 20;
export const QUOTE_MAX = 220;
export const READ_WINDOW_SEC = 15;
export const EXCERPT_MIN = 90;
export const EXCERPT_MAX = 220;

const CHANNELS = Object.freeze([
  { key: "yt:designertom", label: "DesignerTom", platform: "YouTube", unit: "subscribers", field: "subscribers" },
  { key: "yt:joindiveclub", label: "Dive Club", platform: "YouTube", unit: "subscribers", field: "subscribers" },
  { key: "x:ridd_design", label: "@ridd_design", platform: "X", unit: "followers", field: "followers" },
  { key: "x:designertom", label: "@designertom", platform: "X", unit: "followers", field: "followers" },
]);
const SPONSOR_PHRASE = /\b(?:brought to you by|presented by|sponsor(?:s|ed|ing)?|partners?)\b/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const brandPattern = (name) => new RegExp(`(?<![\\w@#])${escapeRe(name).replace(/ /g, "\\s+")}(?![\\w])`, "g");
const negatedFor = (name) => new RegExp(`\\bnot (?:a |our )?(?:sponsor(?:ed)?|partner)(?: by)?[^.]{0,20}\\b${escapeRe(name)}\\b`, "i");
const round1 = (x) => Math.round(x * 10) / 10;
const sum = (rows, f) => rows.reduce((total, row) => total + f(row), 0);
const finite = (v) => Number.isFinite(v);

// a quote as shown: the stored text without its leading @-mentions (an X
// reply's addressees) or trailing links (an attached image); never reworded
export function quoteText(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:@\w+[\s,:]*)+/, "").trim();
  t = t.replace(/(?:\s+https?:\/\/\S+)+$/, "").trim();
  return t;
}

// A verbatim excerpt around segment i: caption transcripts come in short
// fragments, so neighbours join until the excerpt reads as a sentence; a long
// speaker segment is cut to a window of whole words around the match.
export function excerptAt(segments, i, pattern) {
  let from = i;
  let to = i;
  const textOf = () => segments.slice(from, to + 1).map((s) => s.text).join(" ");
  // a fragment that starts mid-sentence takes the words just before it
  if (/^[a-z]/.test(segments[i].text) && i > 0 && segments[i].seconds - segments[i - 1].seconds <= 8) from--;
  while (textOf().length < EXCERPT_MIN) {
    if (to + 1 < segments.length && segments[to + 1].seconds - segments[i].seconds <= 20) to++;
    else if (from > 0 && segments[i].seconds - segments[from - 1].seconds <= 8) from--;
    else break;
  }
  let text = textOf();
  if (text.length > EXCERPT_MAX) {
    const words = text.split(" ");
    const hit = Math.max(0, words.findIndex((w) => new RegExp(pattern.source).test(w)));
    let a = Math.max(0, hit - 12);
    let b = Math.min(words.length, hit + 20);
    while (words.slice(a, b).join(" ").length > EXCERPT_MAX && b - hit > 6) b--;
    while (words.slice(a, b).join(" ").length > EXCERPT_MAX && hit - a > 4) a++;
    text = `${a > 0 ? "…" : ""}${words.slice(a, b).join(" ")}${b < words.length ? "…" : ""}`;
  }
  return { at: segments[from].stamp, seconds: segments[from].seconds, text };
}

function medianOf(values) {
  const clean = values.filter(finite);
  if (clean.length < MIN_PEERS) return null;
  return round1(trueMedian(clean));
}

// Show totals follow the brief's rule (agent-brief buildDigest): a total is
// shown only when every episode has its reading, so one missing reading never
// passes for a smaller show.
function viewsBlock(episodes) {
  const youtubeComplete = episodes.length > 0 && episodes.every((e) => finite(e.latest?.ytTotal) && e.latest.ytTotal >= 0);
  const viewsComplete = youtubeComplete && episodes.every((e) => finite(e.latest?.totalViews));
  const every = (f) => (episodes.length && episodes.every((e) => finite(f(e))) ? sum(episodes, f) : null);
  const total = viewsComplete ? sum(episodes, (e) => e.latest.totalViews) : null;
  return {
    total,
    youtube: youtubeComplete ? sum(episodes, (e) => e.latest.ytTotal) : null,
    xPlays: every((e) => e.latest?.xPlays),
    episodes: episodes.length,
    perEpisode: total != null ? Math.round(total / episodes.length) : null,
    reason: total != null ? null : "Views are not available for every episode yet.",
    xReach: every((e) => e.latest?.xImpressions),
  };
}

function watchBlock(episodes) {
  const counted = episodes.filter((e) => finite(e.watch?.minutesWatched));
  if (!counted.length) return { hours: null, reason: "YouTube watch time has not arrived yet." };
  const minutes = sum(counted, (e) => e.watch.minutesWatched);
  return {
    hours: Math.round(minutes / 60),
    minutes,
    episodes: counted.length,
    missing: episodes.filter((e) => !counted.includes(e)).map((e) => e.ep),
  };
}

// A typical show is the codebase's one "typical" (baselines.windowFor): the
// middle value of the eight shows before the newest, three or nothing. A live
// night is age-free and carries no promo unit, so no show leaves the window
// for a promotion; a measure a known reporting break touches reads only the
// shows on the newest side of the break.
function liveBlock(episodes) {
  const lived = episodes.filter((e) => finite(e.live?.peak) && e.live.peak > 0);
  if (!lived.length) return { shows: 0, reason: "No live session has been read yet." };
  const newest = lived[lived.length - 1];
  const window = windowFor(newest, lived, { side: "before" });
  const comparable = (key) => window.filter((e) => comparableAcrossBreaks(key, e) || !comparableAcrossBreaks(key, newest));
  const best = (rows, f) => rows.reduce((top, e) => (finite(f(e)) && (!top || f(e) > top.value) ? { value: f(e), ep: e.ep } : top), null);
  const timed = lived.filter((e) => finite(e.live.watchedMin));
  return {
    shows: lived.length,
    minutes: sum(timed, (e) => e.live.watchedMin),
    hours: Math.round(sum(timed, (e) => e.live.watchedMin) / 60),
    chat: sum(lived.filter((e) => finite(e.live.chatMessages)), (e) => e.live.chatMessages),
    typical: window.length ? {
      shows: window.length,
      fromEp: window[0].ep,
      toEp: window[window.length - 1].ep,
      peak: medianOf(window.map((e) => e.live.peak)),
      average: medianOf(window.map((e) => e.live.avg)),
      people: medianOf(comparable("liveViewers").map((e) => e.live.liveViews)),
      minutesWatched: medianOf(window.map((e) => e.live.watchedMin)),
      holdRate: medianOf(window.map((e) => e.live.holdRate)),
      chattersPer100: medianOf(window.map((e) => liveRatesOf(e)?.chattersPer100)),
      messagesPerHour: medianOf(window.map((e) => liveRatesOf(e)?.messagesPerHour)),
      durationMin: medianOf(window.map((e) => e.live.durationMin)),
    } : null,
    best: {
      peak: best(lived, (e) => e.live.peak),
      people: best(lived.filter((e) => comparableAcrossBreaks("liveViewers", e) || !comparableAcrossBreaks("liveViewers", newest)), (e) => e.live.liveViews),
    },
  };
}

function audienceBlock(channelStats) {
  const current = channelStats?.current || {};
  const channels = CHANNELS.map((c) => {
    const row = current[c.key];
    const count = row && row.reading?.state === "ready" && Number.isSafeInteger(row[c.field]) ? row[c.field] : null;
    return { key: c.key, label: c.label, platform: c.platform, unit: c.unit, count, date: count != null ? row.date : null };
  });
  const known = channels.filter((c) => c.count != null);
  const complete = known.length === channels.length;
  return {
    total: complete ? sum(known, (c) => c.count) : null,
    date: complete ? known.map((c) => c.date).sort()[0] : null,
    reason: complete ? null : "A channel's count did not arrive in the latest reading.",
    channels,
  };
}

function feedbackBlock(episodes) {
  const rows = episodes.flatMap((e) => (e.audience?.list || []).map((r) => ({ ...r, ep: e.ep, slug: e.slug })));
  const seen = new Set();
  const candidates = rows
    .filter((r) => (r.source === "x" || r.source === "yt") && r.sentiment === "positive" && r.author)
    .map((r) => ({ ...r, shown: quoteText(r.text) }))
    .filter((r) => r.shown.length >= QUOTE_MIN && r.shown.length <= QUOTE_MAX && !r.shown.includes("?") && !/https?:\/\//.test(r.shown) && !hasNegativeSignal(r.shown))
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0) || b.shown.length - a.shown.length || String(b.at).localeCompare(String(a.at)) || a.id.localeCompare(b.id));
  const quotes = [];
  for (const r of candidates) {
    const who = r.author.toLowerCase().replace(/^@/, "");
    if (seen.has(who)) continue;
    seen.add(who);
    quotes.push({ id: r.id, ep: r.ep, slug: r.slug, author: r.author, platform: r.platform, text: r.shown, url: r.url || null, likes: r.likes ?? null });
    if (quotes.length >= QUOTES_TOP) break;
  }
  return {
    messages: rows.length,
    positive: rows.filter((r) => r.sentiment === "positive").length,
    episodes: episodes.filter((e) => e.audience).length,
    quotes,
  };
}

function callInsBlock(episodes, contributors) {
  if (!contributors?.episodes) return { total: null, reason: "The call-in list has not been imported." };
  const bySlug = new Map(episodes.map((e) => [e.slug, e]));
  const rows = Object.entries(contributors.episodes)
    .filter(([slug]) => bySlug.has(slug))
    .sort(([a], [b]) => bySlug.get(a).ep - bySlug.get(b).ep);
  if (!rows.length) return { total: null, reason: "No aired episode has an imported call-in list." };
  const list = rows.flatMap(([slug, entry]) => entry.callIns.map((c) => ({ ep: bySlug.get(slug).ep, slug, ...c })));
  return {
    total: list.length,
    nominations: list.filter((c) => c.kind === "nomination").length,
    episodes: rows.length,
    fromEp: bySlug.get(rows[0][0]).ep,
    toEp: bySlug.get(rows[rows.length - 1][0]).ep,
    byEpisode: rows.map(([slug, entry]) => ({ ep: bySlug.get(slug).ep, slug, count: entry.callIns.length })),
    list,
    updatedAt: contributors.updatedAt || null,
  };
}

// every whole-word, case-sensitive mention of each brand, per episode
function mentionIndex(episodes, transcripts, names) {
  const index = new Map(names.map((name) => [name, []]));
  for (const e of episodes) {
    const t = transcripts[e.slug];
    if (!t) continue;
    for (const name of names) {
      const re = brandPattern(name);
      let count = 0;
      let first = null;
      t.segments.forEach((s, i) => {
        const hits = s.text.match(re);
        if (!hits) return;
        count += hits.length;
        if (first == null) first = i;
      });
      if (count) index.get(name).push({ e, count, first });
    }
  }
  return index;
}

function momentOf(e, t, upload, i, pattern) {
  const x = excerptAt(t.segments, i, pattern);
  return { ep: e.ep, slug: e.slug, at: x.at, seconds: x.seconds, text: x.text, url: momentUrl(upload, x.seconds) };
}

function brandsBlock(episodes, transcripts, uploads) {
  const read = episodes.filter((e) => transcripts[e.slug]);
  if (!read.length) return { list: [], episodes: 0, reason: "No transcript is available yet." };
  const index = mentionIndex(read, transcripts, BRANDS);
  const list = [...index.entries()]
    .map(([name, rows]) => ({
      name,
      partner: PARTNERS.includes(name),
      mentions: sum(rows, (r) => r.count),
      episodes: rows.length,
      moments: rows.map((r) => momentOf(r.e, transcripts[r.e.slug], uploads[r.e.slug], r.first, brandPattern(name))),
    }))
    .filter((b) => b.mentions >= BRAND_MIN_MENTIONS)
    .sort((a, b) => b.mentions - a.mentions || b.episodes - a.episodes || a.name.localeCompare(b.name))
    .slice(0, BRAND_TOP);
  return { episodes: read.length, tracked: BRANDS.length, list };
}

function partnersBlock(episodes, transcripts, uploads) {
  return PARTNERS.map((name) => {
    const re = brandPattern(name);
    const negated = negatedFor(name);
    const moments = [];
    for (const e of episodes) {
      const t = transcripts[e.slug];
      const upload = uploads[e.slug];
      if (t) {
        const picked = [];
        t.segments.forEach((s, i) => {
          if (!new RegExp(re.source).test(s.text)) return;
          // the sponsor phrase may sit a sentence or two away ("Lovable … They're also one of our show sponsors")
          const near = t.segments.filter((x) => Math.abs(x.seconds - s.seconds) <= READ_WINDOW_SEC).map((x) => x.text).join(" ");
          if (!SPONSOR_PHRASE.test(near) || negated.test(near)) return;
          // one moment a minute: the line that says the sponsor phrase itself, else the first line that qualified
          const own = SPONSOR_PHRASE.test(s.text);
          const clash = picked.findIndex((p) => Math.abs(p.seconds - s.seconds) < 60);
          if (clash < 0) picked.push({ i, seconds: s.seconds, own });
          else if (own && !picked[clash].own) picked[clash] = { i, seconds: s.seconds, own };
        });
        for (const p of picked) moments.push({ kind: "read", ...momentOf(e, t, upload, p.i, re) });
      }
      for (const c of e.chapters?.list || []) {
        if (!new RegExp(re.source).test(`${c.title} ${c.gist}`)) continue;
        moments.push({ kind: "segment", ep: e.ep, slug: e.slug, at: c.start, seconds: c.seconds, title: c.title, text: c.gist, url: t ? momentUrl(upload, c.seconds) : null });
      }
    }
    // a read inside the first minute of a chapter about the same partner is that chapter
    const kept = moments.filter((m) => m.kind === "segment" || !moments.some((s) => s.kind === "segment" && s.slug === m.slug && m.seconds >= s.seconds && m.seconds - s.seconds < 60));
    kept.sort((a, b) => a.ep - b.ep || a.seconds - b.seconds);
    const index = mentionIndex(episodes.filter((e) => transcripts[e.slug]), transcripts, [name]).get(name);
    return { name, mentions: sum(index, (r) => r.count), episodes: index.length, moments: kept };
  });
}

export function sponsorView({ episodes, channelStats = null, contributors = null, clockChecks = null, transcripts = {}, generatedAt }) {
  const dive = [...(episodes || [])].filter((e) => e.show === "dive-radio").sort((a, b) => a.ep - b.ep);
  const uploads = Object.fromEntries(dive.map((e) => [e.slug, linkableUpload(e, transcripts[e.slug], clockChecks)]));
  const latest = dive[dive.length - 1] || null;
  return {
    version: SPONSOR_VERSION,
    asOf: generatedAt ? new Date(Date.parse(generatedAt) - 7 * 3600000).toISOString().slice(0, 10) : null,
    episodes: dive.length,
    firstPremiere: dive[0]?.premiere ?? null,
    latest: latest ? { ep: latest.ep, slug: latest.slug, title: latest.title, premiere: latest.premiere } : null,
    views: viewsBlock(dive),
    watch: watchBlock(dive),
    live: liveBlock(dive),
    audience: audienceBlock(channelStats),
    feedback: feedbackBlock(dive),
    callIns: callInsBlock(dive, contributors),
    brands: brandsBlock(dive, transcripts, uploads),
    partners: partnersBlock(dive, transcripts, uploads),
    links: {
      exact: Object.values(uploads).filter(Boolean).length,
      episodes: dive.filter((e) => transcripts[e.slug]).length,
    },
  };
}
