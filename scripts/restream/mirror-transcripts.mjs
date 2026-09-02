#!/usr/bin/env node
// mirror-transcripts.mjs — copy missing Dive Radio transcripts from this
// dedicated chain checkout into the owner vault, then refresh the two search
// collections. An existing episode file in the vault always wins.

import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
const DEFAULT_SOURCE = join(ROOT, "transcripts");
const DEFAULT_VAULT = join(homedir(), "Documents", "Obsidian", "Hinterlands", "Dive Media Group", "Dive Radio");
const DEFAULT_REFRESH = join(homedir(), "Dev", "2026", "hinterlands", "scripts", "vault", "qmd-refresh-collections.mjs");
const COLLECTIONS = ["dive-radio-transcripts", "dive-radio-ops"];

export function mirrorTranscripts({
  source = process.env.DIVE_TRANSCRIPT_SOURCE || DEFAULT_SOURCE,
  vault = process.env.DIVE_TRANSCRIPT_VAULT || DEFAULT_VAULT,
  refreshScript = process.env.DIVE_QMD_REFRESH || DEFAULT_REFRESH,
  dryRun = false,
  noQmd = false,
  log = console.log,
} = {}) {
  if (!existsSync(source)) throw new Error(`source folder missing at ${source}`);
  if (!existsSync(vault)) throw new Error(`vault folder missing at ${vault}`);
  const haveEpisode = new Set(readdirSync(vault)
    .filter((file) => /^e\d+-transcript-.*\.txt$/.test(file))
    .map((file) => Number(file.match(/^e(\d+)-/)[1])));
  const copied = [];
  const problems = [];
  for (const file of readdirSync(source).filter((name) => name.endsWith(".txt")).sort()) {
    const head = readFileSync(join(source, file), "utf8").split("\n", 3);
    const episode = head[0].match(/Dive Radio E(\d+)\b/);
    const aired = (head[1] || "").match(/Aired:\s*(\d{4}-\d{2}-\d{2})/);
    if (!episode || !aired) { problems.push(`${file}: header lacks episode number or air date`); continue; }
    const ep = Number(episode[1]);
    if (haveEpisode.has(ep)) continue;
    const target = `e${ep}-transcript-${aired[1]}.txt`;
    if (!dryRun) copyFileSync(join(source, file), join(vault, target));
    haveEpisode.add(ep);
    copied.push(target);
  }
  for (const target of copied) log(`Dive Radio transcript mirror: copied ${target}${dryRun ? " (dry run)" : ""}`);
  if (!dryRun && !noQmd && copied.length) {
    try {
      execFileSync(process.execPath, [refreshScript, ...COLLECTIONS], { stdio: "pipe", timeout: 40 * 60 * 1000 });
      log("Dive Radio transcript mirror: search index refreshed.");
    } catch (error) {
      problems.push(`search index refresh failed (${String(error.message || error).split("\n")[0]})`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return { copied };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = mirrorTranscripts({ dryRun: process.argv.includes("--dry-run"), noQmd: process.argv.includes("--no-qmd") });
    if (!result.copied.length) console.log("Dive Radio transcript mirror: already current.");
  } catch (error) {
    console.error(`Dive Radio transcript mirror: ${error.message}.`);
    process.exit(1);
  }
}
