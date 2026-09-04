// run-chain-policy.test.mjs — executable retry outcomes for a required source
// step. YouTube's typed waiting result remains waiting even when it follows a
// hard-error retry; two hard errors remain fatal.

import assert from "node:assert/strict";
import { runStepWithPolicy } from "../run-chain.mjs";
import { YOUTUBE_WATCH_PENDING_EXIT } from "../youtube-readiness.mjs";

const step = { step: "yt-analytics", required: true };

async function runCodes(codes) {
  let calls = 0;
  let waits = 0;
  const result = await runStepWithPolicy({
    step,
    cmd: ["node", "fake.mjs"],
    retryOnce: new Set(["yt-analytics"]),
    retryPauseMs: 1,
    execute: async () => ({ code: codes[calls++], lastErr: "source error" }),
    wait: async () => { waits++; },
  });
  return { ...result, calls, waits };
}

assert.deepEqual(await runCodes([YOUTUBE_WATCH_PENDING_EXIT]), {
  code: YOUTUBE_WATCH_PENDING_EXIT,
  lastErr: "source error",
  attempts: 1,
  youtubeWatchPending: true,
  calls: 1,
  waits: 0,
});
assert.deepEqual(await runCodes([1, YOUTUBE_WATCH_PENDING_EXIT]), {
  code: YOUTUBE_WATCH_PENDING_EXIT,
  lastErr: "source error",
  attempts: 2,
  youtubeWatchPending: true,
  calls: 2,
  waits: 1,
});
assert.deepEqual(await runCodes([1, 0]), {
  code: 0,
  lastErr: "source error",
  attempts: 2,
  youtubeWatchPending: false,
  calls: 2,
  waits: 1,
});
assert.deepEqual(await runCodes([1, 1]), {
  code: 1,
  lastErr: "source error",
  attempts: 2,
  youtubeWatchPending: false,
  calls: 2,
  waits: 1,
});

console.log("run-chain-policy.test: waiting, hard-to-waiting, recovered, and twice-failed source paths pass");
