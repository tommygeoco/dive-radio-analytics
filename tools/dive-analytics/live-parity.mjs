#!/usr/bin/env node
// live-parity.mjs — exact-byte production proof for the dashboard and agent
// surfaces that carry the published read.
// A matching generatedAt is not proof: stale or split artifacts can carry the
// same stamp. This helper compares the full local and live bytes instead.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_ARTIFACTS } from "./public-artifacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const SITE = "https://dive-radio-analytics.vercel.app";
export const PARITY_ARTIFACTS = PUBLIC_ARTIFACTS;

const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
const sha256 = (value) => createHash("sha256").update(bytes(value)).digest("hex");

export function compareArtifactMaps(local, live, artifacts = PARITY_ARTIFACTS) {
  const mismatches = [];
  for (const file of artifacts) {
    if (!(file in local)) { mismatches.push({ file, reason: "local artifact missing" }); continue; }
    if (!(file in live)) { mismatches.push({ file, reason: "live artifact missing" }); continue; }
    const expected = bytes(local[file]);
    const observed = bytes(live[file]);
    if (!expected.equals(observed)) mismatches.push({
      file,
      reason: "bytes differ",
      localBytes: expected.length,
      liveBytes: observed.length,
      localSha256: sha256(expected),
      liveSha256: sha256(observed),
    });
  }
  return { ok: mismatches.length === 0, checked: artifacts.length, mismatches };
}

export async function checkLiveParity({ root = ROOT, site = SITE, cacheBust = String(Date.now()), fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const local = {};
  const live = {};
  const fetchErrors = [];
  await Promise.all(PARITY_ARTIFACTS.map(async (file) => {
    local[file] = await readFile(join(root, file));
    try {
      const response = await fetchImpl(`${site}/${file}?cb=${encodeURIComponent(cacheBust)}`, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      live[file] = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      fetchErrors.push({ file, reason: String(error.message || error) });
    }
  }));
  const failedFiles = new Set(fetchErrors.map((item) => item.file));
  const result = compareArtifactMaps(local, live);
  const mismatches = [...fetchErrors, ...result.mismatches.filter((item) => !failedFiles.has(item.file))];
  return { ...result, mismatches, ok: mismatches.length === 0 };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = await checkLiveParity({ root: arg("--root", ROOT), site: arg("--site", SITE), cacheBust: arg("--cache-bust", String(Date.now())) });
    if (result.ok) {
      console.log(`live-parity: ${result.checked} artifacts match production byte-for-byte`);
      process.exit(0);
    }
    for (const mismatch of result.mismatches) {
      const hashes = mismatch.localSha256 ? ` (local ${mismatch.localSha256}, live ${mismatch.liveSha256})` : "";
      console.error(`live-parity: ${mismatch.file}: ${mismatch.reason}${hashes}`);
    }
    process.exit(1);
  } catch (error) {
    console.error(`live-parity: ${error.message}`);
    process.exit(1);
  }
}
