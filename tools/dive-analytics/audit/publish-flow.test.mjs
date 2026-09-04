// publish-flow.test.mjs — deploy and live proof stop after two tries and never
// turn a failed Vercel command or mismatched production into success.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployWithParity, MAX_ATTEMPTS } from "../publish-flow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

assert.equal(MAX_ATTEMPTS, 2);

{
  let deploys = 0;
  let proofs = 0;
  const result = await deployWithParity({
    waitMs: 0,
    log: () => {},
    deploy: async () => { deploys++; return { ok: false, message: "Vercel failed" }; },
    parity: async () => { proofs++; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(deploys, 2);
  assert.equal(proofs, 0, "a failed deploy is never treated as ready for proof");
}

{
  let deploys = 0;
  let proofs = 0;
  const result = await deployWithParity({
    waitMs: 0,
    log: () => {},
    deploy: async () => { deploys++; return { ok: true }; },
    parity: async () => { proofs++; return proofs === 2 ? { ok: true, checked: 8 } : { ok: false, message: "old bytes" }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempt, 2);
  assert.equal(deploys, 2);
  assert.equal(proofs, 2);
}

{
  let deploys = 0;
  const result = await deployWithParity({
    waitMs: 0,
    log: () => {},
    deploy: async () => { deploys++; return { ok: true }; },
    parity: async () => ({ ok: false, message: "wrong bytes" }),
  });
  assert.equal(result.ok, false);
  assert.equal(deploys, 2);
  assert.match(result.message, /wrong bytes/);
}

{
  const flow = readFileSync(join(HERE, "..", "publish-flow.mjs"), "utf8");
  const wrapper = readFileSync(join(ROOT, "scripts", "restream", "postlive-publish.sh"), "utf8");
  assert.match(flow, /assertPublisherCheckout\(root\)/);
  assert.match(flow, /stagePublishScope\(root\)/);
  assert.match(flow, /\["push", "--quiet", "origin", "HEAD:main"\]/);
  assert.doesNotMatch(flow, /git add -A|git add --all/);
  assert.match(flow, /validate\.mjs"/);
  assert.match(wrapper, /set -eu/);
  assert.doesNotMatch(wrapper, /vercel[^\n]*\|/);
}

console.log("publish-flow.test: two-try bound, failed deploy handling, exact proof, main-only push, scoped staging, and strict final validation pass");
