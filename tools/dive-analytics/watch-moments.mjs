// watch-moments.mjs — v6 W16: deterministic transcript × retention moments.
//
// Pure functions only: no fs, no network, no model. build-data.mjs feeds in an
// episode's blended drop-off curve, the per-channel analytics totals, and the
// raw transcript text; out come the curve's shape facts and up to five
// annotated moments (where the audience left or jumped in, with the verbatim
// transcript excerpt from that stretch of the show). Everything lands inside
// episode.watch, so rebuild-currency (validate check 7) covers it end to end
// and no new store file exists.
//
// Calibration (2026-08-23, five real curves E1–E5): the mid-video noise floor
// for a 2-step change is 0.5–1.0 points typical, 1.6–2.1 at the 90th
// percentile — so the moment floor is frozen at 2.0 points (the PRD's first
// guess of 1.5 sat inside the noise band). Holds scan from 0.15 because every
// curve's 0.05–0.11 stretch is the post-cliff rebound (+11 to +16 points),
// which the shape facts (recoveryPeak/recoveryAt) already tell.
//
// Timing honesty: video duration is derived per channel from
// averageViewDuration / (averageViewPercentage / 100) and blended
// view-weighted; when two channel estimates disagree by more than 5%, the
// moment is marked approximate and the excerpt window widens. Transcript
// timestamps come from the live recording, so calibration is windows, not
// instants, by design.

export const MOMENT_POINTS_MIN = 2.0; // frozen 2026-08-23 (calibrated; was 1.5 in the v6 plan)
export const DROP_SCAN_FROM = 0.05;   // the open cliff (< 5%) is its own known story
export const HOLD_SCAN_FROM = 0.15;   // the 5–11% rebound is the shape facts' story
export const MOMENT_SPACING = 0.05;   // no two moments (either kind) within 5% of each other
export const MAX_DROPS = 3;
export const MAX_HOLDS = 2;
export const EXCERPT_MAX = 320;
export const EXCERPT_WINDOW_SEC = 45;
export const EXCERPT_WINDOW_APPROX_SEC = 90;
export const DURATION_DISAGREE = 0.05;

const r1 = (x) => Math.round(x * 10) / 10;

// Per-channel duration estimates from the analytics totals; view-weighted
// blend. Live durationMin is the live session, not the VOD — never used here.
export function deriveDuration(channelTotals) {
  const ests = [];
  for (const t of channelTotals || []) {
    if (!t) continue;
    const { views, averageViewDuration: dur, averageViewPercentage: pct } = t;
    if (!Number.isFinite(views) || views <= 0 || !Number.isFinite(dur) || !Number.isFinite(pct) || pct <= 0) continue;
    ests.push({ views, durationSec: dur / (pct / 100) });
  }
  if (!ests.length) return null;
  const blend = ests.reduce((a, e) => a + e.durationSec * e.views, 0) / ests.reduce((a, e) => a + e.views, 0);
  const durs = ests.map((e) => e.durationSec);
  const approx = ests.length > 1 && (Math.max(...durs) - Math.min(...durs)) / Math.max(...durs) > DURATION_DISAGREE;
  return { durationSec: Math.round(blend), approx };
}

// Shape facts for one blended curve ({at, watching} ascending). All ×100, 1dp.
export function computeShape(curve) {
  if (!Array.isArray(curve) || curve.length < 10) return null;
  const w = (p) => p.watching * 100;
  const openStart = w(curve[0]);
  const early = curve.filter((p) => p.at <= 0.05);
  if (!early.length) return null;
  let floorIdx = 0;
  curve.forEach((p, i) => { if (p.at <= 0.05 && w(p) < w(curve[floorIdx])) floorIdx = i; });
  let recoveryPeak = null;
  let recoveryAt = null;
  for (let i = floorIdx + 1; i < curve.length && curve[i].at <= 0.15; i++) {
    if (recoveryPeak == null || w(curve[i]) > recoveryPeak) { recoveryPeak = w(curve[i]); recoveryAt = curve[i].at; }
  }
  const mid = curve.filter((p) => p.at >= 0.25 && p.at <= 0.75);
  const midHold = mid.length ? mid.reduce((a, p) => a + w(p), 0) / mid.length : null;
  const end = [...curve].sort((a, b) => Math.abs(a.at - 0.95) - Math.abs(b.at - 0.95))[0];
  return {
    openStart: r1(openStart),
    openFloor: r1(w(curve[floorIdx])),
    recoveryPeak: recoveryPeak == null ? null : r1(recoveryPeak),
    recoveryAt: recoveryPeak == null ? null : recoveryAt,
    midHold: midHold == null ? null : r1(midHold),
    endHold: r1(w(end)),
  };
}

// Transcript parser. Two real formats exist in transcripts/:
//   Restream speaker transcript \u2014 "HH:MM:SS [Speaker N]" header line, then
//     that block's text line(s) until a blank line or the next header;
//   YouTube auto-captions \u2014 "HH:MM:SS\u2423\u2423text" on one line, ">>" marking a
//     speaker change, no speaker labels (speaker stays null).
// Offsets index the normalized text so an excerpt is always a verbatim slice
// of the file.
export function parseTranscript(raw) {
  const text = String(raw).replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blocks = [];
  const speakerHeader = /^(\d{2}):(\d{2}):(\d{2}) \[([^\]]+)\]$/;
  const captionLine = /^(\d{2}):(\d{2}):(\d{2})\s{2,}(?=\S)/;
  const secOf = (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  let offset = 0;
  let current = null;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const h = line.match(speakerHeader);
    if (h) {
      current = { sec: secOf(h), speaker: h[4], textStart: null, textEnd: null };
      continue;
    }
    const c = line.match(captionLine);
    if (c) {
      blocks.push({ sec: secOf(c), speaker: null, textStart: start + c[0].length, textEnd: start + line.length });
      current = null;
      continue;
    }
    if (!line.trim()) { current = null; continue; }
    if (!current) continue; // file header lines before the first timestamp
    if (current.textStart == null) { current.textStart = start; blocks.push(current); }
    current.textEnd = start + line.length;
  }
  return { text, blocks };
}

// Verbatim excerpt around estSec: grow a contiguous block run outward from the
// nearest block, keeping the raw slice (interior timestamp lines included)
// within EXCERPT_MAX. Renderers strip the interior header lines for display;
// the stored string stays a verbatim substring of the transcript file.
export function excerptAround({ text, blocks }, estSec, windowSec) {
  const win = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.sec >= estSec - windowSec && b.sec <= estSec + windowSec);
  if (!win.length) return null;
  const dist = (b) => Math.abs(b.sec - estSec);
  let nearest = win[0];
  for (const c of win) if (dist(c.b) < dist(nearest.b)) nearest = c;
  const lo0 = win[0].i;
  const hi0 = win[win.length - 1].i;
  let lo = nearest.i;
  let hi = nearest.i;
  const sliceLen = (a, b) => blocks[b].textEnd - blocks[a].textStart;
  if (sliceLen(lo, hi) > EXCERPT_MAX) {
    // a single long block: cut at the last space inside the cap (still verbatim)
    let cut = text.slice(blocks[lo].textStart, blocks[lo].textStart + EXCERPT_MAX);
    const sp = cut.lastIndexOf(" ");
    if (sp > 0) cut = cut.slice(0, sp);
    return { excerpt: cut, speaker: blocks[lo].speaker };
  }
  for (;;) {
    const grow = [];
    if (lo - 1 >= lo0 && sliceLen(lo - 1, hi) <= EXCERPT_MAX) grow.push(lo - 1);
    if (hi + 1 <= hi0 && sliceLen(lo, hi + 1) <= EXCERPT_MAX) grow.push(hi + 1);
    if (!grow.length) break;
    const pick = grow.sort((a, b) => dist(blocks[a]) - dist(blocks[b]))[0];
    if (pick < lo) lo = pick; else hi = pick;
  }
  return { excerpt: text.slice(blocks[lo].textStart, blocks[hi].textEnd), speaker: blocks[lo].speaker };
}

// Moments: 2-step changes on the aligned grid, reported at the window's
// midpoint grid position. Top 3 drops (audience leaving), then top 2 holds
// (rewind / skip-to bumps), each at least MOMENT_POINTS_MIN, globally spaced,
// and only when the transcript has words inside the excerpt window.
export function extractMoments(curve, { durationSec, approx, transcript }) {
  if (!Array.isArray(curve) || curve.length < 5 || !Number.isFinite(durationSec) || durationSec <= 0) return [];
  const candidates = [];
  for (let i = 2; i < curve.length; i++) {
    const at = curve[i - 1].at; // midpoint of the 2-step window
    const d = (curve[i].watching - curve[i - 2].watching) * 100;
    if (Math.abs(d) < MOMENT_POINTS_MIN) continue;
    if (d < 0 && at >= DROP_SCAN_FROM) candidates.push({ kind: "drop", at, points: r1(-d) });
    if (d > 0 && at >= HOLD_SCAN_FROM) candidates.push({ kind: "hold", at, points: r1(d) });
  }
  const byStrength = (a, b) => b.points - a.points || a.at - b.at;
  const picked = [];
  const windowSec = approx ? EXCERPT_WINDOW_APPROX_SEC : EXCERPT_WINDOW_SEC;
  const tryPick = (pool, max) => {
    for (const c of pool.sort(byStrength)) {
      if (picked.filter((m) => m.kind === c.kind).length >= max) break;
      if (picked.some((m) => Math.abs(m.at - c.at) < MOMENT_SPACING)) continue;
      const estSec = Math.round(c.at * durationSec);
      const ex = excerptAround(transcript, estSec, windowSec);
      if (!ex) continue; // no words there — no moment (absence stays silent)
      picked.push({ kind: c.kind, at: c.at, points: c.points, estSec, approx, excerpt: ex.excerpt, speaker: ex.speaker });
    }
  };
  tryPick(candidates.filter((c) => c.kind === "drop"), MAX_DROPS);
  tryPick(candidates.filter((c) => c.kind === "hold"), MAX_HOLDS);
  return picked.sort((a, b) => a.at - b.at);
}

// Spoken words from a stored excerpt, for prose surfaces (the Slack report):
// interior timestamp/header lines stripped, ">>" speaker marks dropped,
// whitespace collapsed, trimmed on a word boundary. The stored excerpt stays
// the verbatim file slice; this is presentation only.
export function excerptWords(excerpt, max = 160) {
  let q = String(excerpt).replace(/^\d{2}:\d{2}:\d{2}(?: \[[^\]]*\])?\s*/gm, "").replace(/\s*>>\s*/g, " ").replace(/\s+/g, " ").trim();
  if (q.length > max) {
    const cut = q.slice(0, max - 1);
    q = cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max * 0.6))).trimEnd() + "…";
  }
  return q;
}

// Convenience for build-data: everything or nothing for one episode.
export function watchMoments({ curve, channelTotals, transcriptText }) {
  if (!Array.isArray(curve) || !curve.length || !transcriptText) return null;
  const duration = deriveDuration(channelTotals);
  if (!duration) return null;
  const shape = computeShape(curve);
  if (!shape) return null;
  const transcript = parseTranscript(transcriptText);
  const moments = extractMoments(curve, { durationSec: duration.durationSec, approx: duration.approx, transcript });
  return { shape, moments, durationSec: duration.durationSec };
}
