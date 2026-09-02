#!/usr/bin/env node
// publisher-checkout.mjs — fail before capture when automation is not running
// from its dedicated main checkout. Data-chain outputs may be dirty because a
// rehearsal or post-publish alert can legitimately leave them for the next run;
// source, documentation, and UI edits never ride into the daily build.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCommittedPublishScope, assertPublishScope } from "./publish-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (${result.status}): ${String(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}

export function assertPublisherCheckout(root = ROOT) {
  const branch = git(root, ["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`publisher checkout must be on main (found ${branch || "detached HEAD"})`);
  git(root, ["rev-parse", "--verify", "origin/main"]);
  const localCommitPaths = assertCommittedPublishScope(root);
  const dirtyPaths = assertPublishScope(root);
  return { branch, dirtyPaths, localCommitPaths };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const state = assertPublisherCheckout();
    console.log(`publisher-checkout: main with ${state.localCommitPaths.length} local commit path(s) and ${state.dirtyPaths.length} declared chain-output change(s)`);
  } catch (error) {
    console.error(`publisher-checkout: ${error.message}`);
    process.exit(1);
  }
}
