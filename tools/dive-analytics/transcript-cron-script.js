// OpenClaw script payload for the 08:00 Dive Radio transcript mirror.
// This file is installed verbatim with `openclaw cron edit --script -` so the
// tested source and the scheduled source cannot drift. OpenClaw supplies exec.

const result = await exec({
  command: "cd '/Users/bones/Documents/Codex/2026-08-22/you-are-working-on-the-dive/work/dive-radio-analytics-publisher' && /opt/homebrew/bin/node scripts/restream/mirror-transcripts.mjs --quiet-current 2>&1",
});
const output = String(result?.aggregated ?? result?.stdout ?? result?.output ?? "").trim();
const exitCode = Number.isInteger(result?.exitCode)
  ? result.exitCode
  : Number.isInteger(result?.code)
    ? result.code
    : null;
if (exitCode !== 0) {
  throw new Error(output || `Dive Radio transcript mirror failed with exit ${exitCode ?? "unknown"}.`);
}
return output ? { notify: output } : {};
