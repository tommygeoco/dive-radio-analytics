// transcripts.mjs — the timed view of transcripts/<slug>.txt (PRD v12).
//
// ONE parser: watch-moments.parseTranscript already reads both formats the
// files come in — "HH:MM:SS [Speaker n]" header lines (Restream speaker
// transcripts: E2, E4, E6, E7) and "HH:MM:SS␣␣text" caption lines (YouTube
// auto-captions: E1, E3, E5). This module turns its blocks into segments and
// answers the two questions every consumer (chapters.mjs, agent-brief.mjs,
// the validator) must answer the same way:
//   • does a timestamp exist in the transcript?             hasTimestamp
//   • do these words appear, verbatim, within N seconds after it?
//     quoteFoundAfter — case, whitespace, and punctuation are ignored on
//     both sides; words are never fuzzy-matched
// and one fact the brief must state: which CLOCK the timestamps run on.
// Caption transcripts run on the YouTube upload's clock (a &t= deep link is
// exact); Restream transcripts run on the stream clock, which starts earlier
// than the upload by an amount nobody stored (a deep link is approximate and
// the brief says so).

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseTranscript as parseBlocks } from "./watch-moments.mjs";

export function toSeconds(stamp) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(stamp || "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
export function toStamp(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// { header, format: "speaker" | "captions", clock: "stream" | "upload",
//   segments: [{ stamp, seconds, speaker, text }], sha256, bytes, durationSec, youtubeUrl }
export function parseTranscript(raw) {
  const { text, blocks } = parseBlocks(raw);
  const header = text.split("\n").slice(0, 6).filter((l) => l.trim() && !/^\d{2}:\d{2}:\d{2}/.test(l));
  const source = header.find((l) => /^Source:/i.test(l)) || "";
  const format = /speaker transcript/i.test(source) || blocks.some((b) => b.speaker != null) ? "speaker" : "captions";
  const segments = blocks
    .filter((b) => b.textStart != null && b.textEnd != null)
    .map((b) => ({ stamp: toStamp(b.sec), seconds: b.sec, speaker: b.speaker, text: text.slice(b.textStart, b.textEnd).replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text);
  return {
    header,
    format,
    clock: format === "captions" ? "upload" : "stream",
    youtubeUrl: (header.find((l) => /YouTube: https?:\/\//.test(l)) || "").replace(/.*YouTube: (https?:\/\/\S+).*/, "$1") || null,
    segments,
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: Buffer.byteLength(raw, "utf8"),
    durationSec: segments.length ? segments.at(-1).seconds : 0,
  };
}

export function readTranscript(root, slug) {
  const path = join(root, "transcripts", `${slug}.txt`);
  return existsSync(path) ? parseTranscript(readFileSync(path, "utf8")) : null;
}

export function hasTimestamp(parsed, stamp) {
  return parsed.segments.some((s) => s.stamp === stamp);
}

export function normalize(text) {
  return String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function windowText(parsed, stamp, windowSec) {
  const start = toSeconds(stamp);
  if (start == null) return "";
  return parsed.segments.filter((s) => s.seconds >= start && s.seconds <= start + windowSec).map((s) => s.text).join(" ");
}

export function quoteFoundAfter(parsed, stamp, quote, windowSec = 90) {
  const q = normalize(quote);
  if (!q || q.split(" ").length > 12) return false;
  return normalize(windowText(parsed, stamp, windowSec)).includes(q);
}

export function slice(parsed, fromSec, toSec) {
  return parsed.segments.filter((s) => s.seconds >= fromSec && s.seconds < toSec);
}
