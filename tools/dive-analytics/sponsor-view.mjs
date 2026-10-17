// sponsor-view.mjs — the sponsor page's projection (data.sponsor, 2026-10-11).
//
// The sponsor page answers one question for a brand deciding whether to book
// the show: who is in this room, how many, how engaged, and what does a
// partnership look like on air. Pure over the episodes build-data has already
// assembled plus three stores: channel-stats (subscribers and followers),
// contributors (aired call-ins, from the owner's published episode notes) and
// clock-checks (which uploads run on the transcript's clock, so a moment links
// to its exact second), and the YouTube channel of each stored comment (so a
// quote links to its original). Transcripts arrive parsed (transcripts.mjs).
//
// Honesty rules, the same as every surface:
//   • every number is a sum, a count, or a trueMedian (baselines.mjs) of stored
//     values — nothing estimated, nothing interpolated;
//   • views = YouTube views + resolved X broadcast plays; X reach stays apart;
//   • live viewers are never added across shows (one person watches many);
//   • a median needs MIN_PEERS readings, a measure touched by a known
//     reporting break reads only the shows on the newest side of it;
//   • a missing input leaves its field null with a reason, never a zero;
//   • quotes are the stored words (less their addressees — @-mentions that lead
//     the text or follow its last sentence — and trailing links, with
//     typographic quote marks); excerpts are the transcript's words in
//     order, less only what cleanSpeech names; a timestamp links only by clock.mjs;
//   • nothing here says a moment was paid for: a partner moment is what the
//     transcript says (named as a partner, or a chapter about it); the paid
//     formats are shown only through EXAMPLES, which cite the owners' records;
//   • what the page features is the owners' pick (FEATURED_CALLINS,
//     FEATURED_QUOTES), copied from the stored entries, never a ranking made here.

import { trueMedian, windowFor, MIN_PEERS, liveRatesOf, sameSideOfBreaks, breaksFor } from "./baselines.mjs";
import { hasNegativeSignal } from "../../scripts/restream/comments-sentiment.mjs";
import { linkableUpload, momentUrl } from "./clock.mjs";

export const SPONSOR_VERSION = 8;

// Each live figure, by the key a known reporting break's declaration names it
// under (baselines.KNOWN_BREAKS: every live measure built on viewer counts,
// never chat). The middle minute is a count of viewers watching at once, read
// under the average's key; a key no break names compares across.
export const LIVE_KEYS = Object.freeze({
  peak: "peak", average: "average", people: "liveViewers", minutesWatched: "minutesWatched", holdRate: "holdRate",
  chattersPer100: "chattersPer100", messagesPerHour: "messagesPerHour", durationMin: "durationMin", atMiddle: "average",
});

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
export const QUOTE_MIN = 40;
export const QUOTE_MAX = 220;
export const READ_WINDOW_SEC = 15;
export const EXCERPT_MIN = 90;
export const EXCERPT_MAX = 220;
// how far an excerpt may reach around its line: caption fragments are a few
// seconds each, so a sentence can start 25 s before the name and end 30 s after
export const EXCERPT_BEFORE_SEC = 25;
export const EXCERPT_AFTER_SEC = 30;
// a recording is read at the middle once the episode is a week old (a finished
// reading, ARCHITECTURE §2: insights settle at seven days)
export const MIDDLE_MIN_AGE_DAYS = 7;
export const EXAMPLE_WINDOW_SEC = { before: 60, after: 120 };

// One aired example of each package's on-air format, from the owners' own
// records of what a partner received: the August partner recaps
// (Dive Radio/sponsor-recap-*-2026-08.md) and the E10 read's note
// (Dive Radio/e10-notion-ad-read-2026-09-17.md). `near` is the recorded time;
// the example is the first line within EXAMPLE_WINDOW_SEC that names the
// partner, so a record the transcript does not bear out shows nothing. An
// example also carries the segment it aired in (`segment`), when the partner's
// own stored moments hold a segment about it (a chapter whose title names it)
// in the same episode inside the same window: the chapter's time, title, stored
// description and link, as stored — a description of the segment, never a
// quote. With no such segment the field is absent.
export const EXAMPLES = Object.freeze([
  { package: "Mid-roll", format: "A read", label: "Notion on the Dive Radio Skills Library", partner: "Notion", ep: 10, near: 2063, record: "e10-notion-ad-read-2026-09-17.md" },
  { package: "Segment", format: "A named segment", label: "One Up Weekly, brought to you by Lovable", partner: "Lovable", ep: 5, near: 4830, record: "sponsor-recap-lovable-2026-08.md" },
  { package: "Build", format: "A live build", label: "Notion as Code, Notion’s August build", partner: "Notion", ep: 5, near: 2428, record: "sponsor-recap-notion-2026-08.md" },
]);

// The owners' featured picks (SPONSOR-2026-10-11.md D19–D21, D24, 2026-10-16/17):
// people a design- or developer-tool buyer would know by name whose own
// call-in aired, and the audience's words a buyer would believe. Picking is a
// data-layer decision, so the page shows these lists as stored and filters
// nothing; the owners change a pick by editing a list here. A name is a
// call-in's exact `who` as the published episode notes give it; a featured
// name is that name's first aired submission — a video the person sent, since
// the page says they "called in" — so a nomination of someone else or a
// portfolio reviewed on air never features. A quote is a stored quote's id
// (feedback.quotes), copied unchanged. A pick the stores do not hold is
// dropped, never invented; so is a quote from someone on the show (onShow),
// because a featured quote is the audience's voice. Each list keeps its order,
// holds a pick once, and stops at its cap; validator 1s re-derives both.
export const FEATURED_CALLINS_MAX = 6;
export const FEATURED_CALLINS = Object.freeze(["Soleio", "Pietro Schirano", "Jared Erondu", "Josh Puckett"]);
export const FEATURED_QUOTES_MAX = 3;
export const FEATURED_QUOTES = Object.freeze(["x:2100654534661943377"]);
export const FEATURED_KIND = "submission";
// The call-ins that show the audience building with tools at work, the
// partners' own among them (D21, D22, 2026-10-17): up to three exact names, each
// that person's first aired submission with its stored words (`about`),
// verbatim. The same own-video rule as FEATURED_CALLINS; a name already
// featured above is not repeated here, and a submission the notes give no
// words for is dropped, since its words are what this list shows.
export const FEATURED_TOOL_CALLINS_MAX = 3;
export const FEATURED_TOOL_CALLINS = Object.freeze(["Davey Heuser", "Kolbe Yang", "Bruno Reis"]);

// a call-in's own words, as the notes give them (D23: the hook a featured name
// carries); a submission with none carries none
const hasWords = (c) => typeof c.about === "string" && c.about.trim().length > 0;

export function featuredCallIns(list, names = FEATURED_CALLINS) {
  const out = [];
  for (const who of names) {
    if (out.length >= FEATURED_CALLINS_MAX) break;
    if (out.some((c) => c.who === who)) continue;
    const c = (list || []).find((x) => x.who === who && x.kind === FEATURED_KIND);
    if (c) out.push({ who: c.who, ep: c.ep, slug: c.slug, kind: c.kind, ...(hasWords(c) ? { about: c.about } : {}) });
  }
  return out;
}

export function toolCallIns(list, names = FEATURED_TOOL_CALLINS, featured = featuredCallIns(list)) {
  const out = [];
  for (const who of names) {
    if (out.length >= FEATURED_TOOL_CALLINS_MAX) break;
    if (out.some((c) => c.who === who) || featured.some((c) => c.who === who)) continue;
    const c = (list || []).find((x) => x.who === who && x.kind === FEATURED_KIND);
    if (c && hasWords(c)) out.push({ who: c.who, ep: c.ep, slug: c.slug, kind: c.kind, about: c.about });
  }
  return out;
}

// The episodes on the desktop cover row (D23, 2026-10-17): up to six (two of
// the page's twelve columns each), by slug, in the owners' order, chosen for
// titles that show building and tools at work (one portfolio episode at most). Each is the stored episode's number,
// slug and title; a slug no stored episode has is dropped. The phone rail still
// shows every episode, newest first, from data.episodes.
export const FEATURED_COVERS_MAX = 6;
export const FEATURED_COVERS = Object.freeze([
  "2026-10-01-dive-radio-anyone-can-animate-now-and-ho", // E12 Anyone Can Animate Now (and How)
  "2026-09-24-dive-radio-just-in-time-interfaces", // E11 Just-in-Time Interfaces
  "2026-08-13-dive-radio-goodbye-blank-canvas-live-cal", // E5 Goodbye, Blank Canvas (Notion's live build)
  "2026-08-28-dive-radio-steal-these-ai-design-pattern", // E7 Steal These AI Design Patterns
  "2026-09-02-dive-radio-how-to-engineer-a-brand-unive", // E8 How to Engineer a Brand Universe
  "2026-07-30-dive-radio-mixed-media-workflows-game-de", // E3 Mixed Media Workflows, Game Design
]);

export function featuredCovers(episodes, slugs = FEATURED_COVERS) {
  const out = [];
  for (const slug of slugs) {
    if (out.length >= FEATURED_COVERS_MAX) break;
    if (out.some((c) => c.slug === slug)) continue;
    const e = (episodes || []).find((x) => x.slug === slug);
    if (e) out.push({ ep: e.ep, slug: e.slug, title: e.title });
  }
  return out;
}

export function featuredQuotes(quotes, ids = FEATURED_QUOTES) {
  const out = [];
  for (const id of ids) {
    if (out.length >= FEATURED_QUOTES_MAX) break;
    if (out.some((q) => q.id === id)) continue;
    const q = (quotes || []).find((x) => x.id === id);
    if (q && !q.onShow) out.push({ ...q });
  }
  return out;
}

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

// Typographic quote marks: the page sets every quote and excerpt inside “ ”,
// so an apostrophe is ’ and a quotation inside it takes ‘ ’.
export function typographic(text) {
  return String(text || "")
    .replace(/(^|[\s(\[—–-])"(?=\S)/g, "$1‘").replace(/"/g, "’")
    .replace(/(^|[\s(\[—–-])'(?=\w)/g, "$1‘").replace(/'/g, "’")
    .replace(/“/g, "‘").replace(/”/g, "’");
}

// a quote as shown: the stored text without its addressees — the @-mentions
// that lead it (an X reply's) or that follow its last sentence's closing mark
// ("…this community!@designertom @ridd_design") — or trailing links (an
// attached image), with typographic quote marks; never reworded. A mention
// inside a sentence ("thanks to @ridd_design") is the sentence's own word and stays.
function quotePlain(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:@\w+[\s,:]*)+/, "").trim();
  t = t.replace(/(?:\s+https?:\/\/\S+)+$/, "").trim();
  t = t.replace(/([.!?…])\s*(?:@\w+[\s,]*)+$/, "$1").trim();
  return t;
}
export function quoteText(text) {
  return typographic(quotePlain(text));
}

// Speech as it reads: the transcript's words less what is not speech —
// Restream's speaker marks (">>"), caption tags ("[Music]") — and less the
// fillers um / uh / erm and a word or a pair of words said twice in a row
// ("let's let's", "is a is a"). The
// words left are the transcript's, in its order; validator 1s grounds every
// excerpt through this one function.
export function cleanSpeech(text) {
  return String(text || "")
    .replace(/>>/g, " ")
    .replace(/\[[^\]]{1,24}\]/g, " ")
    .replace(/(^|[\s,.;:!?])(?:u+h+|u+m+|uhm|erm)\b[,.]?(?=\s|$)/gi, "$1")
    .replace(/\b([A-Za-z]+(?:'[a-z]+)?)(?:\s+\1\b)+/gi, "$1")
    .replace(/\b([A-Za-z]+(?:'[a-z]+)?\s+[A-Za-z]+(?:'[a-z]+)?)(?:\s+\1\b)+/gi, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/(^|[.!?]\s+)[,;:]\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const TERMINAL = /[.!?]["”’)]*$/;
// a sentence that turns to the next topic ("On that note, …", "Anyway, …") ends what came before it
const TOPIC_TURN = /^\s*(?:>>\s*)?(?:on that note|anyway|anyways|alright|all right|moving on|speaking of)\b/i;
const capitalize = (s) => s.replace(/^([“‘"']?)([a-z])/, (m, q, c) => q + c.toUpperCase());

// A verbatim excerpt around segment i, cut at whole sentences: the sentence
// that names the brand, then the sentences after it (and before it) while the
// excerpt stays under EXCERPT_MAX, until it reaches EXCERPT_MIN; a sentence
// that turns to the next topic is never taken in. One speaker only — a caption
// ">>" or a new speaker ends the reach. A sentence too long to
// show is cut to whole words around the name. "…" marks every cut: an excerpt
// that does not start a sentence opens with it, one that does not end one closes
// with it. `complete` says the excerpt is whole sentences.
export function excerptAt(segments, i, pattern) {
  const seg = segments[i];
  const sameTurn = (k) => (seg.speaker == null ? true : segments[k].speaker === seg.speaker);
  let lo = i;
  let hi = i;
  while (lo > 0 && seg.seconds - segments[lo - 1].seconds <= EXCERPT_BEFORE_SEC && sameTurn(lo - 1) && !/^\s*>>/.test(segments[lo].text)) lo--;
  while (hi + 1 < segments.length && segments[hi + 1].seconds - seg.seconds <= EXCERPT_AFTER_SEC && sameTurn(hi + 1) && !/^\s*>>/.test(segments[hi + 1].text)) hi++;
  const parts = [];
  let text = "";
  for (let k = lo; k <= hi; k++) {
    if (k > lo) text += " ";
    parts.push({ k, start: text.length });
    text += segments[k].text;
  }
  // sentence starts: the window's start, after . ! ?, and at a caption ">>"
  const starts = new Set([0]);
  for (const m of text.matchAll(/[.!?]+["”’)]*\s+/g)) starts.add(m.index + m[0].length);
  for (const p of parts) if (/^\s*>>/.test(segments[p.k].text)) starts.add(p.start);
  const bounds = [...starts].filter((s) => s < text.length).sort((a, b) => a - b);
  const spans = bounds.map((s, n) => [s, n + 1 < bounds.length ? bounds[n + 1] : text.length]);
  const own = new RegExp(pattern.source);
  const hitInSeg = own.exec(seg.text);
  const hitAt = parts[i - lo].start + (hitInSeg ? hitInSeg.index : 0);
  const j = Math.max(0, spans.findIndex(([s, e]) => hitAt >= s && hitAt < e));
  const shown = (a, b) => cleanSpeech(text.slice(spans[a][0], spans[b][1]));
  let a = j;
  let b = j;
  const opener = (n) => text.slice(spans[n][0], spans[n][1]);
  while (shown(a, b).length < EXCERPT_MIN) {
    if (b + 1 < spans.length && !TOPIC_TURN.test(opener(b + 1)) && shown(a, b + 1).length <= EXCERPT_MAX) b++;
    else if (a > 0 && !TOPIC_TURN.test(opener(a)) && shown(a - 1, b).length <= EXCERPT_MAX) a--;
    else break;
  }
  // the window's first sentence starts a sentence only when the line before it ended one
  const opensSentence = (n) => n > 0 || lo === 0 || /^\s*>>/.test(segments[lo].text) || TERMINAL.test(segments[lo - 1].text.trim()) || !sameTurn(lo - 1);
  let from = spans[a][0];
  let body = shown(a, b);
  let opens = opensSentence(a);
  let closes = TERMINAL.test(text.slice(spans[a][0], spans[b][1]).trim());
  if (body.length > EXCERPT_MAX) {
    // one sentence too long to show: whole words around the name
    const raw = text.slice(spans[j][0], spans[j][1]);
    const words = [...raw.matchAll(/\S+/g)].map((m) => ({ word: m[0], at: spans[j][0] + m.index }));
    const hit = Math.max(0, words.findLastIndex((v) => v.at <= hitAt));
    let x = Math.max(0, hit - 12);
    let y = Math.min(words.length, hit + 20);
    const cut = () => cleanSpeech(words.slice(x, y).map((v) => v.word).join(" "));
    while (cut().length > EXCERPT_MAX && y - hit > 6) y--;
    while (cut().length > EXCERPT_MAX && hit - x > 4) x++;
    from = words[x].at;
    body = cut();
    opens = x === 0 && opensSentence(j);
    closes = y === words.length && TERMINAL.test(raw.trim());
  }
  const part = parts.filter((p) => p.start <= from).pop();
  const start = segments[part.k];
  if (opens) body = capitalize(body);
  const shownText = typographic(`${opens ? "" : "…"}${body.replace(/[,;:]$/, "")}${closes ? "" : "…"}`);
  return { at: start.stamp, seconds: start.seconds, text: shownText, complete: opens && closes };
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

// The live audience in one minute of the stream: the per-minute series counts
// everyone watching on YouTube and X at once (LinkedIn reports no viewers). A moment reads it only when its
// transcript runs on the stream's own clock (Restream speaker transcripts); a
// caption transcript runs on an upload's clock, so it has no live minute.
export function liveAt(e, t, seconds) {
  if (t?.clock !== "stream" || !Array.isArray(e.live?.series) || !finite(seconds)) return null;
  const p = e.live.series.find((x) => x.m === Math.floor(seconds / 60));
  return p && finite(p.v) ? p.v : null;
}

// the middle of a show: its middle minute live, and the share of its YouTube
// views still watching at the middle of the recording (the audience curve's
// 50% point, a finished reading only)
export function liveAtMiddle(e) {
  const d = e.live?.durationMin;
  if (!finite(d) || !Array.isArray(e.live?.series)) return null;
  const p = e.live.series.find((x) => x.m === Math.floor(d / 2));
  return p && finite(p.v) ? p.v : null;
}
export function recordingAtMiddle(e) {
  if (!((e.ageDays ?? 0) >= MIDDLE_MIN_AGE_DAYS)) return null;
  const p = (e.watch?.curve || []).find((x) => Math.abs(x.at - 0.5) < 1e-9);
  return p && finite(p.watching) ? round1(p.watching * 100) : null;
}

// A typical show is the codebase's one "typical" (baselines.windowFor): the
// middle value of the eight shows before the newest, three or nothing. A live
// night is age-free and carries no promo unit, so no show leaves the window
// for a promotion; a measure a known reporting break touches reads only the
// shows on the newest's side of the break (baselines.sameSideOfBreaks), and so
// does its record, which then names the show it runs from.
function liveBlock(episodes) {
  const lived = episodes.filter((e) => finite(e.live?.peak) && e.live.peak > 0);
  if (!lived.length) return { shows: 0, reason: "No live session has been read yet." };
  const newest = lived[lived.length - 1];
  const window = windowFor(newest, lived, { side: "before" });
  const side = (field) => (e) => sameSideOfBreaks(LIVE_KEYS[field], newest, e);
  const comparable = (field) => window.filter(side(field));
  const best = (rows, f) => rows.reduce((top, e) => (finite(f(e)) && (!top || f(e) > top.value) ? { value: f(e), ep: e.ep } : top), null);
  const record = (field, f) => {
    const rows = lived.filter(side(field));
    const top = best(rows, f);
    const from = breaksFor(LIVE_KEYS[field]).filter((b) => newest.ep >= b.fromEp).map((b) => b.fromEp);
    return top && { ...top, since: rows.length < lived.length && from.length ? Math.max(...from) : null };
  };
  const timed = lived.filter((e) => finite(e.live.watchedMin));
  const L = newest.live;
  // the newest show as its curve says it: the stored peak, the first minute the
  // series reaches it (none when the series never does), the stored length
  const series = (Array.isArray(L.series) ? L.series : []).map((p) => ({ m: p.m, v: finite(p.v) ? p.v : null }));
  const peakPoint = series.find((p) => p.v === L.peak);
  // where the shows went out, as their sessions record it: how many also went to LinkedIn (its live viewers are
  // not reported, so it is in no live count), and the first show whose X channels report live viewing (the known
  // reporting break) when earlier shows sit in the totals, which are YouTube's alone before it
  const xBreak = breaksFor("liveViewers")[0];
  return {
    shows: lived.length,
    linkedInShows: lived.filter((e) => (e.live.byChannel || []).some((row) => row.label === "LinkedIn")).length,
    xFromEp: xBreak && lived.some((e) => e.ep < xBreak.fromEp) ? xBreak.fromEp : null,
    minutes: sum(timed, (e) => e.live.watchedMin),
    hours: Math.round(sum(timed, (e) => e.live.watchedMin) / 60),
    chat: sum(lived.filter((e) => finite(e.live.chatMessages)), (e) => e.live.chatMessages),
    typical: window.length ? {
      shows: window.length,
      fromEp: window[0].ep,
      toEp: window[window.length - 1].ep,
      peak: medianOf(comparable("peak").map((e) => e.live.peak)),
      average: medianOf(comparable("average").map((e) => e.live.avg)),
      people: medianOf(comparable("people").map((e) => e.live.liveViews)),
      minutesWatched: medianOf(comparable("minutesWatched").map((e) => e.live.watchedMin)),
      holdRate: medianOf(comparable("holdRate").map((e) => e.live.holdRate)),
      chattersPer100: medianOf(comparable("chattersPer100").map((e) => liveRatesOf(e)?.chattersPer100)),
      messagesPerHour: medianOf(comparable("messagesPerHour").map((e) => liveRatesOf(e)?.messagesPerHour)),
      durationMin: medianOf(comparable("durationMin").map((e) => e.live.durationMin)),
      atMiddle: medianOf(comparable("atMiddle").map(liveAtMiddle)),
      // the recording's audience curve is YouTube's own, untouched by the live break
      recordingAtMiddle: medianOf(window.map(recordingAtMiddle)),
    } : null,
    latest: {
      ep: newest.ep,
      slug: newest.slug,
      title: newest.title,
      premiere: newest.premiere,
      peak: L.peak,
      peakMinute: peakPoint ? peakPoint.m : null,
      durationMin: finite(L.durationMin) ? L.durationMin : null,
      holdRate: finite(L.holdRate) ? L.holdRate : null,
      chatMessages: finite(L.chatMessages) ? L.chatMessages : null,
      series,
    },
    best: {
      peak: record("peak", (e) => e.live.peak),
      people: record("people", (e) => e.live.liveViews),
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

// Someone who called in (a video, a nomination, or a portfolio reviewed on
// air): a quote's author whose handle carries a call-in's
// name as one run of letters — the full name in either order ("@gennydee" is
// Genny Dee, "JaredTredly.Design" is Jared Tredly, "@tasedan" is Dan Tase), or
// the first name and the first four letters of a longer surname
// ("@CharlesPattson" is Charles Patterson). A guest's quote passing as the
// audience's is the worse mistake, so the match leans wide; a name of one word,
// or a key under seven letters, never matches.
const letters = (s) => String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");
export function callerIndex(list) {
  const out = [];
  for (const c of list || []) {
    const parts = String(c.who || "").trim().split(/\s+/).filter(Boolean).map(letters).filter(Boolean);
    if (parts.length < 2) continue;
    const first = parts[0];
    const last = parts[parts.length - 1];
    const keys = [parts.join(""), [...parts].reverse().join(""), last.length >= 5 ? first + last.slice(0, 4) : ""]
      .filter((k, i, all) => k.length >= 7 && all.indexOf(k) === i);
    if (keys.length) out.push({ ep: c.ep, who: c.who, keys });
  }
  return out;
}
// The designers a portfolio's "reviewed by" names ("Maheen Sohail and Rob Hope" is two), each once, in the order
// they first appear, with the episode they reviewed on. They were on the show, so their quotes rank with the guests'.
export function reviewersOf(list) {
  const out = [];
  for (const c of list || []) {
    if (c.kind !== "portfolio") continue;
    for (const who of String(c.reviewedBy || "").split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean)) {
      if (!out.some((r) => r.ep === c.ep && r.who === who)) out.push({ ep: c.ep, who });
    }
  }
  return out;
}
export function calledIn(author, index) {
  const handle = letters(String(author || "").replace(/^@/, ""));
  return index.find((c) => c.keys.some((k) => handle.includes(k))) || null;
}

// a quote's original: an X post by its id; a YouTube comment on the upload it
// was left on (the comment store names the channel), highlighted by its id
export function quoteUrl(row, episode, commentChannels) {
  if (row.source === "x") return row.url || null;
  if (row.source !== "yt" || !/^yt:[\w-]+$/.test(row.id || "")) return null;
  const video = episode?.links?.[commentChannels?.[row.id]];
  return video ? `${video}&lc=${row.id.slice(3)}` : null;
}

// someone who says in the comment itself that they were on the show
export const ON_SHOW = /\b(?:for (?:including|featuring|having) me|my (?:little )?cameo|a little cameo)\b/i;

// Quotes: named, positive, public comments (X, YouTube) — no questions, no
// links, no negative signal — one per person, the most-liked first. People who
// were on the show (a call-in by name, a designer who reviewed a portfolio on
// air, or by their own words) rank after everyone else and say so (onShow,
// calledIn for a call-in), so the first quotes a sponsor reads are from the
// audience, not from the show's own guests.
function feedbackBlock(episodes, callIns, commentChannels) {
  const bySlug = new Map(episodes.map((e) => [e.slug, e]));
  const rows = episodes.flatMap((e) => (e.audience?.list || []).map((r) => ({ ...r, ep: e.ep, slug: e.slug })));
  const callers = callerIndex(callIns?.list);
  const guests = callerIndex(reviewersOf(callIns?.list));
  const seen = new Set();
  const candidates = rows
    .filter((r) => (r.source === "x" || r.source === "yt") && r.sentiment === "positive" && r.author)
    .map((r) => { const plain = quotePlain(r.text); const caller = calledIn(r.author, callers); return { ...r, plain, caller, onShow: !!caller || !!calledIn(r.author, guests) || ON_SHOW.test(plain) }; })
    .filter((r) => r.plain.length >= QUOTE_MIN && r.plain.length <= QUOTE_MAX && !r.plain.includes("?") && !/https?:\/\//.test(r.plain) && !hasNegativeSignal(r.plain))
    .sort((a, b) => (a.onShow ? 1 : 0) - (b.onShow ? 1 : 0) || (b.likes ?? 0) - (a.likes ?? 0) || b.plain.length - a.plain.length || String(b.at).localeCompare(String(a.at)) || a.id.localeCompare(b.id));
  const quotes = [];
  for (const r of candidates) {
    const who = r.author.toLowerCase().replace(/^@/, "");
    if (seen.has(who)) continue;
    seen.add(who);
    quotes.push({
      id: r.id, ep: r.ep, slug: r.slug, author: r.author, platform: r.platform, text: typographic(r.plain),
      url: quoteUrl(r, bySlug.get(r.slug), commentChannels), likes: r.likes ?? null, onShow: r.onShow, calledIn: r.caller ? r.caller.ep : null,
    });
    if (quotes.length >= QUOTES_TOP) break;
  }
  return {
    messages: rows.length,
    positive: rows.filter((r) => r.sentiment === "positive").length,
    episodes: episodes.filter((e) => e.audience).length,
    quotes,
    featured: featuredQuotes(quotes),
  };
}

// The companies whose teams the call-ins were about: a call-in's words name
// the company as where the work happens — "at Vercel", "Vercel's creative
// team", "what Shopify looks for", "how Linear hires". A product named as a tool
// ("built in Lovable", "a Figma frame") is not a team, and nothing here says
// where a caller works.
export function teamsNamed(list) {
  const named = [];
  for (const c of list || []) {
    const words = c.about || "";
    for (const name of BRANDS) {
      const b = escapeRe(name);
      const re = new RegExp(`\\bat ${b}\\b|\\b${b}['’]s\\b[^,.;]{0,40}\\bteams?\\b|\\bwhat ${b} looks for\\b|\\bhow ${b} hires\\b`);
      if (re.test(words) && !named.includes(name)) named.push(name);
    }
  }
  return named;
}

function callInsBlock(episodes, contributors) {
  if (!contributors?.episodes) return { total: null, reason: "The call-in list has not been imported.", featured: [], tools: [] };
  const bySlug = new Map(episodes.map((e) => [e.slug, e]));
  const rows = Object.entries(contributors.episodes)
    .filter(([slug]) => bySlug.has(slug))
    .sort(([a], [b]) => bySlug.get(a).ep - bySlug.get(b).ep);
  if (!rows.length) return { total: null, reason: "No aired episode has an imported call-in list.", featured: [], tools: [] };
  const list = rows.flatMap(([slug, entry]) => entry.callIns.map((c) => ({ ep: bySlug.get(slug).ep, slug, ...c })));
  return {
    total: list.length,
    nominations: list.filter((c) => c.kind === "nomination").length,
    portfolios: list.filter((c) => c.kind === "portfolio").length,
    people: new Set(list.map((c) => c.who.toLowerCase())).size,
    episodes: rows.length,
    fromEp: bySlug.get(rows[0][0]).ep,
    toEp: bySlug.get(rows[rows.length - 1][0]).ep,
    byEpisode: rows.map(([slug, entry]) => ({ ep: bySlug.get(slug).ep, slug, count: entry.callIns.length })),
    // each episode's portfolios reviewed on air, as one fact: how many, and the designers who reviewed them
    reviews: rows.filter(([, entry]) => entry.callIns.some((c) => c.kind === "portfolio")).map(([slug, entry]) => {
      const ep = bySlug.get(slug).ep;
      const shown = entry.callIns.filter((c) => c.kind === "portfolio").map((c) => ({ ...c, ep }));
      return { ep, slug, portfolios: shown.length, reviewers: reviewersOf(shown).map((r) => r.who) };
    }),
    teamsNamed: teamsNamed(list),
    featured: featuredCallIns(list),
    tools: toolCallIns(list),
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
      const lines = [];
      t.segments.forEach((s, i) => {
        const hits = s.text.match(re);
        if (!hits) return;
        count += hits.length;
        lines.push(i);
      });
      if (count) index.get(name).push({ e, count, lines });
    }
  }
  return index;
}

function momentOf(e, t, upload, i, pattern) {
  const x = excerptAt(t.segments, i, pattern);
  return { ep: e.ep, slug: e.slug, at: x.at, seconds: x.seconds, text: x.text, url: momentUrl(upload, x.seconds), complete: x.complete };
}
const stored = ({ complete, ...m }) => m;

// a brand's moment in an episode: its first mention that reads as whole
// sentences, else its first mention
function bestMoment(e, t, upload, lines, pattern) {
  let first = null;
  for (const i of lines) {
    const m = momentOf(e, t, upload, i, pattern);
    if (m.complete) return stored(m);
    first ??= m;
  }
  return stored(first);
}

function brandsBlock(episodes, transcripts, uploads) {
  const read = episodes.filter((e) => transcripts[e.slug]);
  if (!read.length) return { list: [], episodes: 0, reason: "No transcript is available yet." };
  const index = mentionIndex(read, transcripts, BRANDS);
  const list = [...index.entries()]
    .map(([name, rows]) => ({ name, rows, mentions: sum(rows, (r) => r.count) }))
    .filter((b) => b.mentions >= BRAND_MIN_MENTIONS)
    .sort((a, b) => b.mentions - a.mentions || b.rows.length - a.rows.length || a.name.localeCompare(b.name))
    .slice(0, BRAND_TOP)
    .map(({ name, rows, mentions }) => ({
      name,
      partner: PARTNERS.includes(name),
      mentions,
      episodes: rows.length,
      moments: rows.map((r) => bestMoment(r.e, transcripts[r.e.slug], uploads[r.e.slug], r.lines, brandPattern(name))),
    }));
  return { episodes: read.length, tracked: BRANDS.length, list };
}

// A partner on air, as the transcript has it: each time the hosts name it as a
// partner (a sponsor phrase within READ_WINDOW_SEC, never "not sponsored by"),
// and each chapter that names it — "segment" when the chapter's title names it
// (a segment about it), "inSegment" when only its summary does (named in a
// segment). Nothing here says a moment was paid for.
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
        for (const p of picked) {
          const m = stored(momentOf(e, t, upload, p.i, re));
          moments.push({ kind: "named", ...m, liveAt: liveAt(e, t, m.seconds) });
        }
      }
      for (const c of e.chapters?.list || []) {
        if (!new RegExp(re.source).test(`${c.title} ${c.gist}`)) continue;
        moments.push({ kind: new RegExp(re.source).test(c.title) ? "segment" : "inSegment", ep: e.ep, slug: e.slug, at: c.start, seconds: c.seconds, title: c.title, text: c.gist, url: t ? momentUrl(upload, c.seconds) : null, liveAt: liveAt(e, t, c.seconds) });
      }
    }
    // a naming inside the first minute of a chapter that names the same partner is that chapter
    const chapter = (m) => m.kind === "segment" || m.kind === "inSegment";
    const kept = moments.filter((m) => chapter(m) || !moments.some((s) => chapter(s) && s.slug === m.slug && m.seconds >= s.seconds && m.seconds - s.seconds < 60));
    kept.sort((a, b) => a.ep - b.ep || a.seconds - b.seconds);
    const index = mentionIndex(episodes.filter((e) => transcripts[e.slug]), transcripts, [name]).get(name);
    return {
      name,
      mentions: sum(index, (r) => r.count),
      episodes: index.length,
      named: kept.filter((m) => m.kind === "named").length,
      segments: kept.filter(chapter).length,
      about: kept.filter((m) => m.kind === "segment").length,
      moments: kept,
    };
  });
}

// the segment an example aired in: the partner's own first stored segment
// moment (a chapter whose title names it) in the example's episode, inside the
// example's window
export function exampleSegment(x, partners) {
  const inWindow = (m) => m.seconds >= x.near - EXAMPLE_WINDOW_SEC.before && m.seconds <= x.near + EXAMPLE_WINDOW_SEC.after;
  const m = ((partners || []).find((p) => p.name === x.partner)?.moments || []).find((s) => s.kind === "segment" && s.ep === x.ep && inWindow(s));
  return m ? { at: m.at, seconds: m.seconds, title: m.title, text: m.text, url: m.url } : null;
}

// each package's example, found in its transcript near the recorded time, with
// the segment it aired in when the partner's moments hold one
function examplesBlock(episodes, transcripts, uploads, partners) {
  return EXAMPLES.map((x) => {
    const e = episodes.find((r) => r.ep === x.ep);
    const t = e ? transcripts[e.slug] : null;
    const base = { package: x.package, format: x.format, label: x.label, partner: x.partner, ep: x.ep, slug: e?.slug ?? null };
    const segment = exampleSegment(x, partners);
    const withSegment = (row) => (segment ? { ...row, segment } : row);
    if (!t) return withSegment({ ...base, moment: null, reason: "The episode’s transcript is not available." });
    const re = brandPattern(x.partner);
    const i = t.segments.findIndex((s) => s.seconds >= x.near - EXAMPLE_WINDOW_SEC.before && s.seconds <= x.near + EXAMPLE_WINDOW_SEC.after && new RegExp(re.source).test(s.text));
    if (i < 0) return withSegment({ ...base, moment: null, reason: `The transcript does not name ${x.partner} near the recorded time.` });
    const m = stored(momentOf(e, t, uploads[e.slug], i, re));
    return withSegment({ ...base, moment: { at: m.at, seconds: m.seconds, text: m.text, url: m.url, liveAt: liveAt(e, t, m.seconds) }, reason: null });
  });
}

export function sponsorView({ episodes, channelStats = null, contributors = null, clockChecks = null, commentChannels = null, transcripts = {}, generatedAt }) {
  const dive = [...(episodes || [])].filter((e) => e.show === "dive-radio").sort((a, b) => a.ep - b.ep);
  const uploads = Object.fromEntries(dive.map((e) => [e.slug, linkableUpload(e, transcripts[e.slug], clockChecks)]));
  const latest = dive[dive.length - 1] || null;
  const callIns = callInsBlock(dive, contributors);
  const partners = partnersBlock(dive, transcripts, uploads);
  return {
    version: SPONSOR_VERSION,
    asOf: generatedAt ? new Date(Date.parse(generatedAt) - 7 * 3600000).toISOString().slice(0, 10) : null,
    episodes: dive.length,
    firstPremiere: dive[0]?.premiere ?? null,
    latest: latest ? { ep: latest.ep, slug: latest.slug, title: latest.title, premiere: latest.premiere } : null,
    covers: featuredCovers(dive),
    views: viewsBlock(dive),
    watch: watchBlock(dive),
    live: liveBlock(dive),
    audience: audienceBlock(channelStats),
    feedback: feedbackBlock(dive, callIns, commentChannels),
    callIns,
    brands: brandsBlock(dive, transcripts, uploads),
    partners,
    examples: examplesBlock(dive, transcripts, uploads, partners),
    links: {
      exact: Object.values(uploads).filter(Boolean).length,
      episodes: dive.filter((e) => transcripts[e.slug]).length,
    },
  };
}
