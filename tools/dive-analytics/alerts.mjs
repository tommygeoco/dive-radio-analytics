#!/usr/bin/env node
// alerts.mjs — material-change detector for the Dive Radio dashboard.
// (PRD v2 W4, 2026-08-22.) Push over pull: nobody should open a dashboard to
// find out something changed. This runs at the end of the daily chain, diffs
// today's published data.json against the last run's remembered state, and
// queues ONE plain-language line per material event. A separate trigger-gated
// cron (dive-alerts) delivers the queue to Slack and stays silent when it is
// empty.
//
// Deterministic detection: no model calls. State lives next to the data it
// describes; the delivery queue lives outside Git so a lock can never block a
// publish:
//   state:  data/restream/alerts-state.json    (last-seen values)
//   queue:  ~/Library/Application Support/Dive Radio Analytics/alerts-pending.json
//
// Modes:
//   node tools/dive-analytics/alerts.mjs          # detect + queue (chain step)
//   node tools/dive-analytics/alerts.mjs --emit   # print queue without clearing
//   node tools/dive-analytics/alerts.mjs --deliver --channel slack
//       --account default --target user:ID        # clear only after provider receipt
// First run bootstraps state and queues nothing — history is not news.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_LABELS } from "./health.mjs";
import { MIN_PEERS } from "./baselines.mjs";
import { acknowledgeQueueLines, acquireLock, appendQueueLines, QUEUE_PATH, readQueue } from "./alert-queue.mjs";
import { DAILY_STATE_PATH } from "./runtime-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA_PATH = join(ROOT, "data.json");
const STATE_PATH = join(ROOT, "data", "restream", "alerts-state.json");
const CLASSIFIED_PATH = join(ROOT, "data", "restream", "comments-classified.json");
const NEG_SPIKE = 3; // new negative comments in one day that count as a spike

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")); // corrupt file = loud crash, never silent reset
}
function saveAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}
const short = (t) => t.replace(/^Dive Radio:\s*/i, "");

export function snapshotState(data) {
  const eps = data.episodes;
  const newest = eps[eps.length - 1];
  const complaints = {}, w1v = {};
  let staleCount = 0;
  for (const e of eps) {
    complaints[e.slug] = e.comments?.complaintCount ?? 0;
    if (e.latest?.totalViewsInfo?.stale) staleCount++;
  }
  for (const v of data.showTrend?.week1VelocityByEpisode || []) w1v[v.slug] = v.value;
  const classified = loadJson(CLASSIFIED_PATH, { classified: {} });
  const reviewCount = Object.values(classified.classified || {}).filter((x) => x.state === "review").length;
  return {
    episodeCount: eps.length,
    newestSlug: newest?.slug ?? null,
    paceRank: data.showTrend?.paceRank ?? null,
    complaints, reviewCount, w1v, staleCount,
    // W27: which checks fed the served health read, and under which rules —
    // so a change in either is push-worthy news, not a dashboard surprise
    healthDate: data.health?.date ?? null,
    healthFormula: data.health?.formulaVersion ?? null,
    // PRD v10: the overall direction word and the outlook range the served
    // read carries — a change in either is push-worthy news
    healthDirection: data.baselines?.direction?.overall ?? null,
    // which episodes the promo-outlier test flags today — a flip changes
    // every typical and every clean series at once
    promoFlagged: Object.entries(data.baselines?.anomaly || {}).filter(([, a]) => a?.flagged).map(([slug]) => slug).sort(),
    healthCheckSet: data.health?.checks
      ? data.health.checks.filter((c) => c.score != null).map((c) => c.key)
      : null,
  };
}

// Structured lines (PRD v9 1x): every line carries its sample and direction
// so the validator can check small-n rules on data, not on prose.
export function alertLines(prev, cur, data) {
  const out = [];
  const push = (text, meta = {}) => out.push({ text, sample: meta.sample ?? null, direction: meta.direction ?? null });
  const eps = data.episodes;
  const byslug = (s) => eps.find((e) => e.slug === s);

  // 1. new episode registered
  if (cur.episodeCount > prev.episodeCount) {
    const fresh = eps.slice(prev.episodeCount);
    for (const e of fresh) push(`New episode registered automatically: E${e.ep} — ${short(e.title)} (premiered ${e.premiere}).`);
  }

  // 2. same-age pace rank change for the newest episode (same episode only —
  // a new episode resets the comparison and is covered by alert 1)
  // (PRD v9 F31: only when the peer set is the same size — a rank that moves
  // because more episodes started spanning the age is not a change)
  if (prev.paceRank && cur.paceRank && prev.newestSlug === cur.newestSlug &&
      cur.paceRank.rank != null && prev.paceRank.rank != null && cur.paceRank.rank !== prev.paceRank.rank &&
      cur.paceRank.of === prev.paceRank.of) {
    const e = byslug(cur.newestSlug);
    const dir = cur.paceRank.rank < prev.paceRank.rank ? "up" : "down";
    push(`E${e?.ep} (${short(e?.title ?? cur.newestSlug)}) moved ${dir} to #${cur.paceRank.rank} of ${cur.paceRank.of} on same-age YouTube pace (was #${prev.paceRank.rank}).`, { sample: cur.paceRank.of - 1, direction: dir });
  }

  // 2b. the served show-health read is behind the data (PRD v9 rule 15):
  // one line a day from two days behind; withheld after seven
  if (data.health && Number.isFinite(data.health.ageDays) && data.health.ageDays >= 2) {
    push(data.health.withheld
      ? `Show health is withheld: the last saved read is ${data.health.ageDays} days old (saved ${data.health.date}). Data still publishes; run tools/dive-analytics/health.mjs.`
      : `Show health read is ${data.health.ageDays} days behind the data (saved ${data.health.date}).`);
  }

  // 2c. the served health read rests on a different check set than the last
  // run's (a scoring rule shipped, or a check gained/lost the history it
  // needs) — push it, never leave the owners to deduce it from a "Not in yet"
  // row (W27, 2026-08-24 incident: two checks left, the score held still,
  // and the morning digest was silent). An EMPTY saved set means the read was
  // withheld, not that zero checks scored — recovery from a withheld stretch
  // must not read as every check "joining", so both sides must be non-empty
  // (a real change across a withhold still reaches the reader through the
  // entry-to-entry checkSetChange on the page and in Slack).
  if (prev.healthCheckSet?.length && cur.healthCheckSet?.length && prev.healthDate !== cur.healthDate &&
      JSON.stringify(prev.healthCheckSet) !== JSON.stringify(cur.healthCheckSet)) {
    const words = (keys) => keys.map((k) => CHECK_LABELS[k] ?? k).map((w, i, all) =>
      (i === 0 ? "" : i === all.length - 1 ? " and " : ", ") + w).join("");
    const left = prev.healthCheckSet.filter((k) => !cur.healthCheckSet.includes(k));
    const joined = cur.healthCheckSet.filter((k) => !prev.healthCheckSet.includes(k));
    const parts = [];
    if (left.length) parts.push(`${words(left)} left`);
    if (joined.length) parts.push(`${words(joined)} joined`);
    push(`Show health now rests on a different set of checks (${parts.join("; ")}) — the diagnosis card says why each is in or out. The score no longer compares one-to-one with the last read's.`);
  }

  // 2d. the scoring rules themselves changed — saved reads keep their old
  // rules and the trend restarts under the new ones; the owners hear it from
  // Slack, not from a puzzling dashboard
  if (prev.healthFormula && cur.healthFormula && prev.healthFormula !== cur.healthFormula) {
    push(`Show health scoring rules changed (${prev.healthFormula} → ${cur.healthFormula}). Saved reads keep the rules they were written under; the score trend restarts under the new rules.`);
  }
  // 2e. PRD v10: the direction word turned, or the expected first-week range
  // moved — each read from the saved entry, never recomputed here
  if (prev.healthDirection && cur.healthDirection && prev.healthDirection !== cur.healthDirection) {
    push(`Show health direction turned from ${prev.healthDirection} to ${cur.healthDirection} over the last few clean episodes — the Where it's heading rows say which checks moved.`);
  }
  // 2f. the promo-outlier test flagged or cleared an episode: every typical
  // and every clean series changed with it, so the read is not comparable
  // with yesterday's
  if (prev.promoFlagged && cur.promoFlagged && JSON.stringify(prev.promoFlagged) !== JSON.stringify(cur.promoFlagged)) {
    const name = (slug) => { const e = byslug(slug); return e ? `E${e.ep} (${short(e.title)})` : slug; };
    const flagged = cur.promoFlagged.filter((s) => !prev.promoFlagged.includes(s)).map(name);
    const cleared = prev.promoFlagged.filter((s) => !cur.promoFlagged.includes(s)).map(name);
    push(`Promo-outlier flags changed${flagged.length ? ` — now flagged: ${flagged.join(", ")}` : ""}${cleared.length ? ` — no longer flagged: ${cleared.join(", ")}` : ""}. Every typical and every clean series moved with it; today's health read is not one-to-one with yesterday's.`);
  }

  // 3. new people raising concerns
  for (const [slug, n] of Object.entries(cur.complaints)) {
    const before = prev.complaints?.[slug] ?? n;
    if (n - before >= NEG_SPIKE) {
      const e = byslug(slug);
      push(`E${e?.ep} (${short(e?.title ?? slug)}) had ${n - before} more people raise concerns since yesterday — worth a read (dashboard → episode → audience feedback).`);
    }
  }

  // 3b. classifier disagreements need human review and never reach the page.
  if (cur.reviewCount > (prev.reviewCount ?? 0)) {
    const added = cur.reviewCount - (prev.reviewCount ?? 0);
    push(`${added} audience comment${added === 1 ? " needs" : "s need"} label review — held off the dashboard until a person resolves it.`);
  }

  // 4. a first week just completed (week-1 number newly available)
  for (const [slug, v] of Object.entries(cur.w1v)) {
    if (v != null && (prev.w1v?.[slug] ?? null) == null && slug in (prev.w1v ?? {})) {
      const e = byslug(slug);
      const clean = Object.values(cur.w1v).filter((x) => x != null).sort((a, b) => b - a);
      const rank = clean.indexOf(v) + 1;
      // a rank among fewer than three clean weeks is not a standing (F31)
      // direction needs MIN_PEERS or more *peers* (clean weeks besides this one) — rule 13 / small-n gate
      if (clean.length >= 3) push(`E${e?.ep} (${short(e?.title ?? slug)}) finished its first week: ${v.toLocaleString("en-US")} YouTube views — #${rank} of ${clean.length} clean first weeks.`, { sample: clean.length - 1, direction: clean.length - 1 >= MIN_PEERS ? (rank === 1 ? "up" : rank === clean.length ? "down" : null) : null });
      else push(`E${e?.ep} (${short(e?.title ?? slug)}) finished its first week: ${v.toLocaleString("en-US")} YouTube views.`);
    }
  }

  // 5. plays went stale (a broadcast stopped answering; high-water shown)
  if (cur.staleCount > (prev.staleCount ?? 0)) {
    push(`X plays went stale for ${cur.staleCount - prev.staleCount} episode(s) — dashboard is showing the last confirmed number, marked with →date.`);
  }

  return out;
}

export function detect(prev, cur, data) {
  return alertLines(prev, cur, data).map((line) => line.text);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function deliveryId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["messageId", "message_id", "ts"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const found = deliveryId(child);
    if (found) return found;
  }
  return null;
}

function parseCommandJson(text) {
  const source = String(text || "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("OpenClaw returned no JSON receipt");
  return JSON.parse(source.slice(start, end + 1));
}

export function alertBatches(lines, maxChars = 12_000) {
  const batches = [];
  let current = [];
  for (const line of lines) {
    const candidate = `Dive Radio — what changed:\n${[...current, line].map((item) => `• ${item}`).join("\n")}`;
    if (current.length && candidate.length > maxChars) { batches.push(current); current = [line]; }
    else current.push(line);
  }
  if (current.length) batches.push(current);
  return batches;
}

export function deliverPending({
  queuePath = QUEUE_PATH,
  channel = "slack",
  account = "default",
  target,
  send = (args) => spawnSync("openclaw", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }),
  chainGuard = () => acquireLock(`${DAILY_STATE_PATH}.run.lock`, { label: "daily publishing chain", maxAgeMs: 2 * 60 * 60 * 1000 }),
  log = console.log,
} = {}) {
  if (!target) throw new Error("alert delivery target is required");
  let releaseChain;
  try {
    releaseChain = chainGuard();
  } catch (error) {
    if (!/already in use/.test(error.message)) throw error;
    log("dive-alerts: publishing checks are active — delivery will retry on its next run.");
    return { sent: 0, receipts: [], deferred: true };
  }
  let release = null;
  try {
    release = acquireLock(`${queuePath}.delivery.lock`, { label: "alert delivery", maxAgeMs: 5 * 60 * 1000 });
    const pending = readQueue(queuePath);
    if (!pending.length) { log("dive-alerts: queue empty — nothing to send."); return { sent: 0, receipts: [] }; }
    const receipts = [];
    let sent = 0;
    for (const batch of alertBatches(pending)) {
      const message = `Dive Radio — what changed:\n${batch.map((line) => `• ${line}`).join("\n")}`;
      const result = send(["message", "send", "--channel", channel, "--account", account, "--target", target, "--message", message, "--json"]);
      const status = Number.isInteger(result.status) ? result.status : 1;
      if (status !== 0) throw new Error(`Slack send failed (exit ${status}) — ${String(result.stderr || result.stdout || "no details").trim().split("\n").at(-1)}`);
      const receipt = deliveryId(parseCommandJson(result.stdout));
      if (!receipt) throw new Error("Slack send returned no message receipt");
      acknowledgeQueueLines(batch, queuePath);
      receipts.push(receipt);
      sent += batch.length;
    }
    log(`dive-alerts: Slack confirmed ${sent} line${sent === 1 ? "" : "s"} (${receipts.join(", ")}).`);
    return { sent, receipts };
  } finally {
    release?.();
    releaseChain();
  }
}

if (isMain) {
  const emitMode = process.argv.includes("--emit");
  const deliverMode = process.argv.includes("--deliver");
  if (emitMode && deliverMode) {
    console.error("dive-alerts: choose --emit or --deliver, not both");
    process.exit(1);
  } else if (emitMode) {
    try {
      const queue = readQueue(QUEUE_PATH);
      if (!queue.length) console.log("dive-alerts: queue empty — nothing to say.");
      else {
        console.log("Dive Radio — what changed:");
        for (const line of queue) console.log(`• ${line}`);
      }
    } catch (error) {
      console.error(`dive-alerts: ${error.message}`);
      process.exit(1);
    }
  } else if (deliverMode) {
    try {
      deliverPending({ channel: arg("--channel", "slack"), account: arg("--account", "default"), target: arg("--target") });
    } catch (error) {
      console.error(`dive-alerts: ${error.message}; pending lines were kept.`);
      process.exit(1);
    }
  } else {
    const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    const cur = snapshotState(data);
    const prev = loadJson(STATE_PATH, null);
    if (!prev) {
      saveAtomic(STATE_PATH, cur);
      console.log("alerts: state bootstrapped — no alerts on first run.");
    } else {
      const found = detect(prev, cur, data);
      if (found.length) {
        appendQueueLines(found, QUEUE_PATH);
      }
      saveAtomic(STATE_PATH, cur);
      console.log(`alerts: ${found.length} material change(s)${found.length ? " queued" : ""}.`);
    }
  }
}
