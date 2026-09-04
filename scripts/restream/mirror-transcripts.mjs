#!/usr/bin/env node
// mirror-transcripts.mjs — copy missing Dive Radio transcripts from this
// dedicated chain checkout into the owner vault, then refresh the two search
// collections. An existing episode file in the vault always wins.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { ISOLATED_PUBLISHER_ROOT, TRANSCRIPT_REFRESH_STATE_PATH } from "../../tools/dive-analytics/runtime-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const DEFAULT_SOURCE = join(ISOLATED_PUBLISHER_ROOT, "transcripts");
const DEFAULT_VAULT = join(homedir(), "Documents", "Obsidian", "Hinterlands", "Dive Media Group", "Dive Radio");
const DEFAULT_REFRESH = join(homedir(), "Dev", "2026", "hinterlands", "scripts", "vault", "qmd-refresh-collections.mjs");
const COLLECTIONS = ["dive-radio-transcripts", "dive-radio-ops"];

function saveRefreshState(path, files) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (previous && (previous.version !== 1 || !Array.isArray(previous.files))) throw new Error(`search refresh state is unreadable at ${path}`);
  const state = {
    version: 1,
    neededSince: previous?.neededSince || new Date().toISOString(),
    files: [...new Set([...(previous?.files || []), ...files])],
  };
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function pendingRefresh(path) {
  if (!existsSync(path)) return false;
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.version !== 1 || !Array.isArray(state.files)) throw new Error(`search refresh state is unreadable at ${path}`);
  return true;
}

export function mirrorTranscripts({
  source = process.env.DIVE_TRANSCRIPT_SOURCE || DEFAULT_SOURCE,
  vault = process.env.DIVE_TRANSCRIPT_VAULT || DEFAULT_VAULT,
  refreshScript = process.env.DIVE_QMD_REFRESH || DEFAULT_REFRESH,
  refreshState = TRANSCRIPT_REFRESH_STATE_PATH,
  refresh = (script, collections) => execFileSync(process.execPath, [script, ...collections], { stdio: "pipe", timeout: 40 * 60 * 1000 }),
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
  const planned = [];
  const problems = [];
  for (const file of readdirSync(source).filter((name) => name.endsWith(".txt")).sort()) {
    const head = readFileSync(join(source, file), "utf8").split("\n", 3);
    const episode = head[0].match(/Dive Radio E(\d+)\b/);
    const aired = (head[1] || "").match(/Aired:\s*(\d{4}-\d{2}-\d{2})/);
    if (!episode || !aired) { problems.push(`${file}: header lacks episode number or air date`); continue; }
    const ep = Number(episode[1]);
    if (haveEpisode.has(ep)) continue;
    const target = `e${ep}-transcript-${aired[1]}.txt`;
    haveEpisode.add(ep);
    planned.push({ source: join(source, file), target, destination: join(vault, target) });
  }
  if (problems.length) throw new Error(problems.join("; "));
  if (!dryRun && planned.length) saveRefreshState(refreshState, planned.map((item) => item.target));
  for (const item of planned) {
    if (!dryRun) copyFileSync(item.source, item.destination);
    copied.push(item.target);
  }
  for (const target of copied) log(`Dive Radio transcript mirror: copied ${target}${dryRun ? " (dry run)" : ""}`);
  const needsRefresh = !dryRun && pendingRefresh(refreshState);
  if (!dryRun && !noQmd && needsRefresh) {
    try {
      refresh(refreshScript, COLLECTIONS);
      unlinkSync(refreshState);
      log("Dive Radio transcript mirror: search index refreshed.");
    } catch (error) {
      problems.push(`search index refresh failed (${String(error.message || error).split("\n")[0]})`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return { copied, refreshPending: noQmd && needsRefresh };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = mirrorTranscripts({ dryRun: process.argv.includes("--dry-run"), noQmd: process.argv.includes("--no-qmd") });
    if (!result.copied.length && !process.argv.includes("--quiet-current")) console.log("Dive Radio transcript mirror: already current.");
  } catch (error) {
    console.error(`Dive Radio transcript mirror: ${error.message}.`);
    process.exit(1);
  }
}
