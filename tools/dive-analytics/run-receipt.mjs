// Durable receipts bind the scheduler's result to the exact validated release.
// These records are operational evidence, never a substitute for source data.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { PUBLIC_ARTIFACTS } from "./public-artifacts.mjs";
import { phoenixDay } from "./freshness.mjs";
import { PUBLISH_PROOF_PATH } from "./runtime-paths.mjs";

export function saveReceipt(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = null;
    renameSync(tmp, path);
  } finally {
    if (fd != null) closeSync(fd);
    try { unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

const present = (value) => typeof value === "number" && Number.isFinite(value);
export const SOURCE_PENDING_STATUS = "waiting:sources";
export function lastProductionProof(path = PUBLISH_PROOF_PATH) {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.version !== 1 || saved.proof?.ok !== true || !/^[a-f0-9]{40}$/.test(saved.sha || "") || !Number.isFinite(Date.parse(saved.generatedAt))) return null;
    return { sha: saved.sha, generatedAt: saved.generatedAt, checkedAt: saved.proof.checkedAt };
  } catch { return null; }
}
export function pendingSourceStates(sources) {
  return sources.flatMap((episode) => Object.entries(episode)
    .filter(([, reading]) => reading && typeof reading === "object" && ["pending", "failed", "missing", "stale"].includes(reading.state))
    .map(([source, reading]) => ({ episode: episode.episode, slug: episode.slug, source, ...reading })));
}
export function publicSourceStates(data, now = Date.now()) {
  const day = phoenixDay(now);
  return (data.episodes || []).map((episode) => {
    if (episode.sourceStates) return { slug: episode.slug, episode: episode.ep, premiere: episode.premiere, ...structuredClone(episode.sourceStates) };
    const future = episode.premiere > day;
    const valueState = (value, stale = false) => future ? "future" : present(value) ? stale ? "stale" : "ready" : "missing";
    const watchState = future ? "future" : episode.watchReport?.state === "pending" ? "pending"
      : present(episode.watch?.avgPercent) ? "ready" : episode.premiere === day ? "idle" : "missing";
    return {
      slug: episode.slug, episode: episode.ep, premiere: episode.premiere,
      youtube: { state: valueState(episode.latest?.ytTotal, episode.latest?.youtubeStale), checkedAt: episode.latest?.youtubeAsOf || episode.latest?.ts || null },
      x: { state: valueState(episode.latest?.xPlays, episode.latest?.xPlaysInfo?.stale || episode.latest?.xPlaysInfo?.partial), checkedAt: episode.latest?.xPlaysInfo?.asOf || episode.latest?.ts || null },
      watch: { state: watchState, checkedAt: episode.watchReport?.checkedAt || null, reason: episode.watchReport?.reason || (watchState === "missing" ? "No complete owner watch report" : null) },
      live: { state: valueState(episode.live?.peak), reason: episode.live ? null : "No complete matched live event" },
      transcript: { state: future ? "future" : episode.transcript === true ? "ready" : "missing" },
      promotion: { state: future ? "future" : episode.promotion ? "ready" : "missing", checkedAt: episode.promotion?.updatedAt || null, reason: episode.promotion ? null : "No verified exact-link newsletter result" },
      comments: { state: future ? "future" : episode.comments ? "ready" : "missing", xCoverage: episode.comments?.xCoverage || null },
    };
  });
}

export function readPublishEvidence(root, {
  path = PUBLISH_PROOF_PATH, now = Date.now(), startedAt = null,
  git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 }),
} = {}) {
  const proof = JSON.parse(readFileSync(path, "utf8"));
  const data = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
  const stamp = Date.parse(proof?.proof?.checkedAt);
  const generated = Date.parse(proof?.generatedAt);
  const sha = git(["rev-parse", "HEAD"]);
  if (sha.status !== 0 || !/^[a-f0-9]{40}$/.test(sha.stdout?.trim())) throw new Error("release commit could not be read");
  if (proof?.version !== 1 || proof.sha !== sha.stdout.trim() || proof.generatedAt !== data.generatedAt
    || proof.site !== "https://dive-radio-analytics.vercel.app" || !/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/i.test(proof.deployment?.url || "")
    || proof.proof?.ok !== true || !Number.isFinite(stamp) || !Number.isFinite(generated)
    || stamp < generated || stamp > now || generated > now || phoenixDay(generated) !== phoenixDay(now)
    || (startedAt != null && (stamp < Date.parse(startedAt) || generated < Date.parse(startedAt)))) {
    throw new Error("production receipt does not identify this current release and run");
  }
  const transcripts = (data.episodes || []).filter((episode) => episode.transcript === true).map((episode) => {
    if (typeof episode.slug !== "string" || !/^[a-z0-9-]+$/.test(episode.slug)) throw new Error("invalid transcript identifier in production receipt");
    return `transcripts/${episode.slug}.txt`;
  });
  const expected = [...PUBLIC_ARTIFACTS, ...transcripts].sort();
  const records = proof.proof.artifacts;
  if (!Array.isArray(records) || records.length !== expected.length || proof.proof.checked !== expected.length
    || JSON.stringify(records.map((record) => record.file).sort()) !== JSON.stringify(expected)) {
    throw new Error("production receipt omits or duplicates public artifacts");
  }
  for (const record of records) {
    const bytes = readFileSync(join(root, record.file));
    if (record.bytes !== bytes.length || record.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error(`production receipt no longer matches ${record.file}`);
    }
  }
  return { ...proof, sourceStates: publicSourceStates(data, now) };
}

export function receiptForAttempt(evidence, { day, number, mode, startedAt, endedAt, status }) {
  return {
    version: 1, day, attempt: number, mode, startedAt, endedAt,
    sourceStates: evidence?.sourceStates || [], sha: evidence?.sha || null,
    generatedAt: evidence?.generatedAt || null, deployment: evidence?.deployment || null,
    productionProof: evidence?.proof || null, finalState: status,
  };
}
