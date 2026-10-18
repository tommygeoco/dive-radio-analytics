// OpenClaw script payload for the 08:00 Dive Radio transcript mirror.
// This file is installed verbatim with `openclaw cron edit --script -` so the
// tested source and the scheduled source cannot drift. OpenClaw supplies exec.
// It runs on ~/.local/bin/node (the official nodejs.org build), never Homebrew's
// node, which a brew run broke on 2026-10-18 (audit/AUDIT-2026-10-18-homebrew-node.md).

const result = await exec({
  command: "cd '/Users/bones/Library/Application Support/Dive Radio Analytics/publisher-main' && /Users/bones/.local/bin/node scripts/restream/mirror-transcripts.mjs --quiet-current 2>&1",
});
const output = String(result?.aggregated ?? result?.stdout ?? result?.output ?? "").trim();
const exitCode = Number.isInteger(result?.exitCode)
  ? result.exitCode
  : Number.isInteger(result?.code)
    ? result.code
    : null;
if (exitCode !== 0 || result?.error || result?.timedOut || result?.signal) {
  throw new Error(output || `Dive Radio transcript mirror failed with exit ${exitCode ?? "unknown"}.`);
}
return output ? { notify: output } : {};
