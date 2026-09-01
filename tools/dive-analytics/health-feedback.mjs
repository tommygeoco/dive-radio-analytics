#!/usr/bin/env node
// health-feedback.mjs — the owners' side of the verification loop (PRD v10 W33).
//
// One line per note, appended to data/restream/health-feedback.jsonl:
//   {"date":"2026-09-01","feel":"better","note":"biggest launch yet","at":"…"}
// health-verify.mjs compares each note with what the saved read said that day
// (its direction word, or its score move) and reports agreement over time —
// the honest test of "it's flagging red but we feel good about things".
//
// Run:  node tools/dive-analytics/health-feedback.mjs better|same|worse ["a few words"] [--date YYYY-MM-DD]

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PATH = join(ROOT, "data", "restream", "health-feedback.jsonl");
const FEELS = ["better", "same", "worse"];

const args = process.argv.slice(2);
const feel = args[0];
if (!FEELS.includes(feel)) {
  console.error("usage: node tools/dive-analytics/health-feedback.mjs better|same|worse [\"a few words\"] [--date YYYY-MM-DD]");
  process.exit(1);
}
const dateFlag = args.indexOf("--date");
const date = dateFlag >= 0 ? args[dateFlag + 1] : new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) { console.error("--date must be YYYY-MM-DD"); process.exit(1); }
const note = args.filter((a, i) => i > 0 && a !== "--date" && !(dateFlag >= 0 && i === dateFlag + 1)).join(" ").slice(0, 140);
mkdirSync(dirname(PATH), { recursive: true });
appendFileSync(PATH, JSON.stringify({ date, feel, note, at: new Date().toISOString() }) + "\n");
console.log(`health-feedback: ${date} ${feel}${note ? ` — ${note}` : ""} (appended to ${PATH.replace(ROOT + "/", "")})`);
