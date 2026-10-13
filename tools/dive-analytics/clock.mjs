// clock.mjs — does a transcript run on a YouTube upload's clock? (2026-10-11)
//
// Restream transcripts were read as "the live recording's clock, a few minutes
// off the upload" because nobody had measured the gap. clock-check.mjs now
// measures it: the upload's own auto-captions carry word-level times, and a
// six-word phrase that occurs exactly once in both the transcript and the
// captions pins one moment on both clocks. The median difference over every
// such phrase is the offset; the spread between the 10th and 90th percentile
// says whether one offset holds for the whole episode. Pure: no I/O.
//
// One rule decides every timestamp link (the sponsor page today; the same
// helper is the one place to widen it): a link is exact when the transcript
// is the upload's own captions, or when a stored check found at least
// CLOCK_MIN_ANCHORS phrases with a spread of CLOCK_MAX_SPREAD seconds or less.
// Otherwise a timestamp is shown without a link.

export const CLOCK_PHRASE_WORDS = 6;
export const CLOCK_MIN_ANCHORS = 100;
export const CLOCK_MAX_SPREAD = 2;
// the show's home channel first, then the second simulcast upload
export const UPLOAD_ORDER = Object.freeze(["yt:joindiveclub", "yt:designertom"]);

const norm = (word) => String(word).toLowerCase().replace(/[^a-z0-9']/g, "");
const round1 = (x) => Math.round(x * 10) / 10;

// YouTube json3 captions → [{ word, sec }]
export function captionWords(json3) {
  const words = [];
  for (const event of json3?.events || []) {
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
    for (const seg of event.segs) {
      const at = (event.tStartMs + (Number.isFinite(seg.tOffsetMs) ? seg.tOffsetMs : 0)) / 1000;
      for (const raw of String(seg.utf8 || "").split(/\s+/)) {
        const word = norm(raw);
        if (word) words.push({ word, sec: at });
      }
    }
  }
  return words;
}

// segments: [{ seconds, text }] (transcripts.mjs parseTranscript) and caption
// words → { anchors, offsetSec, spreadSec } or null when nothing matched
export function clockOffset(segments, words, n = CLOCK_PHRASE_WORDS) {
  const captionAt = new Map();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).map((w) => w.word).join(" ");
    captionAt.set(key, captionAt.has(key) ? null : words[i].sec);
  }
  const transcriptAt = new Map();
  for (const segment of segments || []) {
    const head = String(segment.text || "").split(/\s+/).map(norm).filter(Boolean);
    if (head.length < n || !Number.isFinite(segment.seconds)) continue;
    const key = head.slice(0, n).join(" ");
    transcriptAt.set(key, transcriptAt.has(key) ? null : segment.seconds);
  }
  const diffs = [];
  for (const [key, sec] of transcriptAt) {
    if (sec == null) continue;
    const at = captionAt.get(key);
    if (at != null) diffs.push(at - sec);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  const pick = (q) => diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * q))];
  return { anchors: diffs.length, offsetSec: round1(pick(0.5)), spreadSec: round1(pick(0.9) - pick(0.1)) };
}

export function clockHolds(check) {
  return check?.state === "ready" && Number.isFinite(check.offsetSec) && check.anchors >= CLOCK_MIN_ANCHORS && check.spreadSec <= CLOCK_MAX_SPREAD;
}

// The upload a timestamp may link into: { key, url, offsetSec } or null.
// episode: { slug, links }; transcript: { clock, youtubeUrl, sha256 };
// checks: the clock-checks store (or null).
export function linkableUpload(episode, transcript, checks) {
  if (!episode || !transcript) return null;
  const entry = checks?.entries?.[episode.slug];
  for (const key of UPLOAD_ORDER) {
    const url = episode.links?.[key];
    const check = entry?.uploads?.[key];
    if (!url || !check || check.transcriptSha256 !== transcript.sha256 || !clockHolds(check)) continue;
    if (new URL(url).searchParams.get("v") !== check.videoId) continue;
    return { key, url, offsetSec: check.offsetSec };
  }
  // a caption transcript is that upload's own clock (the long-standing rule)
  if (transcript.clock === "upload" && transcript.youtubeUrl) {
    const key = UPLOAD_ORDER.find((k) => episode.links?.[k] && new URL(episode.links[k]).searchParams.get("v") === new URL(transcript.youtubeUrl).searchParams.get("v"));
    if (key) return { key, url: episode.links[key], offsetSec: 0 };
  }
  return null;
}

// a deep link to `seconds` on the transcript's clock, or null
export function momentUrl(upload, seconds) {
  if (!upload || !Number.isFinite(seconds)) return null;
  const at = Math.max(0, Math.round(seconds + upload.offsetSec));
  return `${upload.url}&t=${at}s`;
}
