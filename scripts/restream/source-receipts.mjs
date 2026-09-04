// Durable evidence that the daily source pulls actually reached every
// configured account. A fresh timestamp by itself is not a successful pull:
// readers must also require the latest run's status to be "ok".

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SOURCE_RECEIPT_PATH = join(ROOT, "data", "restream", "source-receipts.json");
export const YOUTUBE_ACCOUNTS = ["joindiveclub", "designertom"];
export const X_ACCOUNTS = ["ridd_design", "designertom"];

function emptyStore() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    lastSuccessfulDiscoveryAt: null,
    lastSuccessfulSnapshotAt: null,
    discoveries: [],
    snapshots: [],
  };
}

export function readSourceReceipts(path = SOURCE_RECEIPT_PATH) {
  if (!existsSync(path)) return emptyStore();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.schemaVersion !== 1) {
    throw new Error(`unsupported source receipt schema in ${path}`);
  }
  if (!Array.isArray(parsed.discoveries) || !Array.isArray(parsed.snapshots)) {
    throw new Error(`invalid source receipt arrays in ${path}`);
  }
  return parsed;
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Keep the original write error.
    }
    throw err;
  }
}

export function sourceStatus(sources) {
  const rows = Object.values(sources || {});
  return rows.length > 0 && rows.every((source) => source?.attempted === true && source?.success === true)
    ? "ok"
    : "partial";
}

export function sourceAccountSummary(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  return {
    attempted: rows.length > 0 && rows.every((row) => row?.attempted === true),
    success: rows.length > 0 && rows.every((row) => row?.success === true),
    accounts: rows,
  };
}

// Append-only by design. A failed run advances updatedAt but never advances a
// last-success timestamp, so failure cannot masquerade as source freshness.
export function appendSourceReceipt(kind, run, { path = SOURCE_RECEIPT_PATH } = {}) {
  if (kind !== "discovery" && kind !== "snapshot") {
    throw new Error(`unknown source receipt kind: ${kind}`);
  }
  const store = readSourceReceipts(path);
  const finishedAt = run.finishedAt || new Date().toISOString();
  const status = run.status || sourceStatus(run.sources);
  const entry = { ...run, finishedAt, status };
  if (kind === "discovery") {
    store.discoveries.push(entry);
    if (status === "ok") store.lastSuccessfulDiscoveryAt = finishedAt;
  } else {
    // `ts` is the chain freshness key and is the time the snapshot attempt
    // completed, whether it succeeded or not. Validation also checks status.
    store.snapshots.push({ ts: finishedAt, ...entry });
    if (status === "ok") store.lastSuccessfulSnapshotAt = finishedAt;
  }
  store.updatedAt = finishedAt;
  atomicWrite(path, store);
  return entry;
}

export function accountCoverageErrors(source, expectedAccounts) {
  const errors = [];
  if (!source || source.attempted !== true) return ["source was not attempted"];
  const rows = source.accounts || [];
  const byAccount = new Map(rows.map((row) => [row.account, row]));
  if (byAccount.size !== rows.length) errors.push("duplicate account receipt");
  for (const account of expectedAccounts) {
    const row = byAccount.get(account);
    if (!row) errors.push(`${account}: no receipt`);
    else if (row.attempted !== true) errors.push(`${account}: not attempted`);
    else if (row.success !== true) errors.push(`${account}: ${row.error || "failed"}`);
  }
  for (const account of byAccount.keys()) {
    if (!expectedAccounts.includes(account)) errors.push(`${account}: unexpected account`);
  }
  if (source.success !== true) errors.push("source did not succeed");
  return errors;
}
