#!/usr/bin/env node
// contributors-import.mjs — the community call-ins that aired on each episode,
// read from the owner's published episode notes (vault: Dive Media Group/Dive
// Radio/e<N>-episode-notes-*.md, the #episode-notes drafts) into
// data/restream/contributors.json. Owner-supplied, like the LinkedIn imports:
// the notes are checked against the transcript and the replay before they are
// published, and this step only carries what they say.
//
// What counts as a call-in: every "🎥 **SUBMISSION** · [label](link)" line
// above the notes' "Didn't make the show" part and their accuracy audit — a
// video the community sent in that aired. A Designer of the Week nomination is
// one too ("X's nomination of Y"). The label is kept verbatim, split once at
// ": " into who sent it and what they shared. Since 2026-10-16 a portfolio the
// community sent in and the show reviewed on air is one too: a
// "🌐 Site · [X's portfolio, reviewed by Y](link)" line, kept as who sent it
// and who reviewed it. A portfolio the notes only list (shown on screen, or
// not reached) carries no "reviewed by" and is not a call-in. Links are never
// stored.
//
// Identity: the note's `episode:` number and `air_date:` must name the same
// aired episode in the registry (its position among Dive Radio shows by date);
// a mismatch stops the import instead of guessing. Absence: an episode with no
// notes, or notes that list no sent-in video, has no entry — never a zero.
// Deterministic; no network, no model.
//
// Usage:
//   node scripts/restream/contributors-import.mjs [--notes <dir>] [--dry-run]
//   (default notes dir: $DIVE_TRANSCRIPT_VAULT, else the transcripts-pull vault path)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonFile, withSourceLock } from "../../tools/dive-analytics/source-io.mjs";
import { DEFAULT_VAULT } from "./transcripts-pull.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STORE_PATH = join(ROOT, "data", "restream", "contributors.json");
export const NOTES_FILE = /^e(\d+)-episode-notes-(\d{4}-\d{2}-\d{2})\.md$/;
const SUBMISSION = /^🎥 \*\*SUBMISSION\*\* · \[(.+?)\]\((https?:\/\/[^)\s]+)\)\s*$/;
const PORTFOLIO = /^🌐 (?:\*\*)?Site(?:\*\*)? · \[(.+?)['’]s? portfolio, reviewed by (.+?)\]\((https?:\/\/[^)\s]+)\)\s*$/;
const NOMINATION = /^(.+?)['’]s nomination of (.+)$/;
const STOP = /^(?:\*\*Didn['’]t make the show|## Accuracy audit)/i;

// one call-in from a SUBMISSION label, verbatim
export function parseCallIn(label) {
  const text = String(label).trim();
  const nomination = NOMINATION.exec(text);
  if (nomination) return { kind: "nomination", who: nomination[1].trim(), nominee: nomination[2].trim() };
  const cut = text.indexOf(": ");
  return cut > 0
    ? { kind: "submission", who: text.slice(0, cut).trim(), about: text.slice(cut + 2).trim() }
    : { kind: "submission", who: text, about: null };
}

// { episode, airDate, callIns[] } from one notes file's text
export function parseEpisodeNotes(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] || "";
  const episode = Number(/^episode:\s*(\d+)\s*$/m.exec(front)?.[1]);
  const airDate = /^air_date:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(front)?.[1] || null;
  const callIns = [];
  for (const line of src.slice(front ? src.indexOf("\n---", 3) + 4 : 0).split("\n")) {
    if (STOP.test(line)) break;
    const m = SUBMISSION.exec(line);
    if (m) callIns.push(parseCallIn(m[1]));
    const p = PORTFOLIO.exec(line);
    if (p) callIns.push({ kind: "portfolio", who: p[1].trim(), reviewedBy: p[2].trim() });
  }
  return { episode: Number.isInteger(episode) && episode > 0 ? episode : null, airDate, callIns };
}

// the aired Dive Radio shows in air order, numbered as build-data numbers them
export function airedEpisodes(registry, today) {
  return (registry.shows || [])
    .filter((show) => (/dive.?radio/i.test(show.title || "") || /dive-radio/.test(show.slug)) && show.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((show, index) => ({ ep: index + 1, slug: show.slug, airDate: show.date }));
}

// notes: [{ name, text }] → the store's episodes map (pure)
export function contributorEpisodes({ registry, notes, today }) {
  const aired = airedEpisodes(registry, today);
  const episodes = {};
  for (const note of [...notes].sort((a, b) => a.name.localeCompare(b.name))) {
    const named = NOTES_FILE.exec(note.name);
    if (!named) continue;
    const parsed = parseEpisodeNotes(note.text);
    if (parsed.episode == null || !parsed.airDate) throw new Error(`${note.name}: the notes do not state their episode and air date`);
    if (parsed.episode !== Number(named[1])) throw new Error(`${note.name}: the file says E${named[1]} but the notes say E${parsed.episode}`);
    const show = aired.find((row) => row.ep === parsed.episode);
    if (!show) throw new Error(`${note.name}: E${parsed.episode} is not an aired episode in the registry`);
    if (show.airDate !== parsed.airDate) throw new Error(`${note.name}: E${parsed.episode} aired ${show.airDate} in the registry, not ${parsed.airDate}`);
    if (episodes[show.slug]) throw new Error(`${note.name}: a second notes file for E${parsed.episode}`);
    if (!parsed.callIns.length) continue;
    episodes[show.slug] = {
      ep: show.ep,
      airDate: show.airDate,
      notes: note.name,
      notesSha256: createHash("sha256").update(note.text).digest("hex"),
      callIns: parsed.callIns,
    };
  }
  return Object.fromEntries(Object.entries(episodes).sort(([, a], [, b]) => a.ep - b.ep));
}

export function importContributors({ root = ROOT, notesDir, now = Date.now(), dryRun = false, logger = console } = {}) {
  const dir = resolve(notesDir || process.env.DIVE_TRANSCRIPT_VAULT || DEFAULT_VAULT);
  if (!existsSync(dir)) throw new Error(`episode notes folder not found: ${dir}`);
  const registry = JSON.parse(readFileSync(join(root, "data", "restream", "postlive-registry.json"), "utf8"));
  const notes = readdirSync(dir).filter((name) => NOTES_FILE.test(name)).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  const today = new Date(new Date(now).getTime() - 7 * 3600000).toISOString().slice(0, 10); // Phoenix date
  const episodes = contributorEpisodes({ registry, notes, today });
  const path = join(root, "data", "restream", "contributors.json");
  return withSourceLock(path, () => {
    const previous = readJsonFile(path, { fallback: null });
    const changed = JSON.stringify(previous?.episodes || null) !== JSON.stringify(episodes);
    const store = {
      schemaVersion: 2,
      source: "Dive Radio episode notes (owner vault, the published #episode-notes drafts): every SUBMISSION line, and every portfolio “reviewed by” a named reviewer, above “Didn't make the show”",
      updatedAt: changed || !previous?.updatedAt ? new Date(now).toISOString() : previous.updatedAt,
      episodes,
    };
    const total = Object.values(episodes).reduce((sum, e) => sum + e.callIns.length, 0);
    logger.log(`contributors: ${total} aired call-ins across ${Object.keys(episodes).length} episodes${changed ? "" : " (unchanged)"}${dryRun ? " — dry run, nothing written" : ""}`);
    if (!dryRun && changed) atomicWriteJson(path, store);
    return store;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--notes");
  try {
    importContributors({ notesDir: at >= 0 ? args[at + 1] : undefined, dryRun: args.includes("--dry-run") });
  } catch (error) {
    process.stderr.write(`contributors: ${error.message}\n`);
    process.exit(1);
  }
}
