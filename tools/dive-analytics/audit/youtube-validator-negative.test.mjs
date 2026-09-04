#!/usr/bin/env node
// The validator's private fixture mode changes a parsed in-memory copy of one
// complete store. Canonical source files and frozen ratings are never touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [join(HERE, "validate.mjs"), "--fixture-invalid-youtube-cohort"], {
  cwd: join(HERE, "..", "..", ".."),
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
  timeout: 120_000,
});

assert.equal(result.status, 1, "a mixed-time watch store must make the full validator fail");
assert.match(
  result.stdout,
  /^FAIL  watching: .* saved channels are not one complete same-pull current-video reading$/m,
  "the validator must name the rejected cohort",
);

console.log("youtube-validator-negative.test: in-memory mixed-time store is rejected without changing canonical data");
