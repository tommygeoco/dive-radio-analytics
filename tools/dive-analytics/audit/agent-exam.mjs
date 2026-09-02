// agent-exam.mjs — PRD v12 §6.1: the twelve questions, with the expected
// answers computed from data.json so a fresh-context agent's replies can be
// checked. Prints the questions (for the prompt) and the answers (for the
// grader). Run: node tools/dive-analytics/audit/agent-exam.mjs [--questions|--answers]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const d = JSON.parse(readFileSync(join(ROOT, "data.json"), "utf8"));
const eps = [...d.episodes].sort((a, b) => (a.premiere < b.premiere ? -1 : 1));
const bySlug = Object.fromEntries(eps.map((e) => [e.slug, e]));
const ep = (n) => eps.find((e) => e.ep === n);
const newest = eps.at(-1);
const band = (s) => (s >= 55 ? "above usual" : s >= 45 ? "near usual" : "below usual");
const longestStay = eps.filter((e) => e.live?.minutesPerViewer != null).sort((a, b) => b.live.minutesPerViewer - a.live.minutesPerViewer)[0];
const chapters = JSON.parse(readFileSync(join(ROOT, "data", "restream", "chapters.json"), "utf8")).entries[newest.slug];
const Q = [
  ["Today's show-health score and its band", `${d.health.score} (${band(d.health.score)})`, "health.score"],
  ["Which checks are fragile", d.health.checks.filter((c) => c.state === "fragile").map((c) => c.key).join(", "), "health.checks[].state"],
  ["The first ranked action this week (its id)", d.insights.find((i) => i.rank === 1)?.id, "insights[rank 1].id"],
  ["E7's launch word, and why it is marked promo-driven", `${d.baselines.launch[newest.slug].word}, promo-driven: ${newest.metrics.anomaly}`, "baselines.launch[E7]"],
  ["E5's launch reading and why it has no first week", `${d.baselines.launch[ep(5).slug].value} views (${d.baselines.launch[ep(5).slug].word}); no first week because: ${ep(5).metrics.week1Note}`, "baselines.launch[E5], metrics.week1Note"],
  ["Which episode kept its live viewers longest (minutes per viewer)", `E${longestStay.ep} at ${longestStay.live.minutesPerViewer} minutes`, "episodes[].live.minutesPerViewer"],
  ["The newest episode's third chapter and its timestamp", `${chapters.chapters[2].start} — ${chapters.chapters[2].title}`, "chapters.json"],
  ["The typical of the last three clean first weeks", String(d.baselines.outlook.nextFirstWeek.typical), "baselines.outlook.nextFirstWeek.typical"],
  ["What is absent for E7's episode health and why", newest.health?.reason || (newest.health?.pending ? `pending until ${newest.health.readCompleteOn}` : "?"), "episodes[E7].health"],
  ["Where the raw watch curve lives", "data.json (episodes[].watch.curve)", "leaves-out list"],
  ["The outlook range for the next first week", `${d.baselines.outlook.nextFirstWeek.low}–${d.baselines.outlook.nextFirstWeek.high}`, "baselines.outlook.nextFirstWeek"],
  ["The health read's date and its data-through stamp", `${d.health.date}, data through ${d.health.dataThrough}`, "health.date, health.dataThrough"],
];
const mode = process.argv[2] || "--both";
Q.forEach(([q, a, path], i) => {
  if (mode !== "--answers") console.log(`${i + 1}. ${q}`);
  if (mode !== "--questions") console.log(`   expected: ${a}   [${path}]`);
});
