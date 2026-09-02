#!/usr/bin/env node
// publish-scope.mjs — fail closed unless every dirty path is a declared chain output.
//
// The chain definition is the allowlist. Matching and Git reads are NUL-safe
// for the repository's valid UTF-8 paths; staging passes exact filenames after
// `--`, never a broad pathspec.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const CHAIN_PATH = join(HERE, "chain.json");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: null });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (${result.status}): ${String(result.stderr || "").trim()}`);
  return result.stdout || Buffer.alloc(0);
}

function nulPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function allowlistSpecs(chain = JSON.parse(readFileSync(CHAIN_PATH, "utf8"))) {
  const specs = [...new Set((chain.steps || []).flatMap((step) => step.writes || []))].sort();
  for (const spec of specs) {
    const stars = (spec.match(/\*/g) || []).length;
    if (stars > 1 || spec.includes("**")) throw new Error(`unsupported publish allowlist pattern: ${spec}`);
    if (spec.startsWith("/") || spec.split("/").includes("..")) throw new Error(`unsafe publish allowlist pattern: ${spec}`);
  }
  return specs;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function pathMatchesSpec(path, spec) {
  if (!spec.includes("*")) return path === spec;
  const slash = spec.lastIndexOf("/");
  const directory = slash < 0 ? "" : spec.slice(0, slash);
  const basename = slash < 0 ? spec : spec.slice(slash + 1);
  const pathSlash = path.lastIndexOf("/");
  const pathDirectory = pathSlash < 0 ? "" : path.slice(0, pathSlash);
  const pathBasename = pathSlash < 0 ? path : path.slice(pathSlash + 1);
  if (pathDirectory !== directory || !pathBasename) return false;
  const pattern = `^${basename.split("*").map(escapeRegex).join("[^/]+")}$`;
  return new RegExp(pattern).test(pathBasename);
}

export function classifyPaths(paths, specs) {
  return paths.map((path) => ({ path, matches: specs.filter((spec) => pathMatchesSpec(path, spec)) }));
}

export function dirtyPaths(root = ROOT) {
  const tracked = nulPaths(git(root, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"]));
  const untracked = nulPaths(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

export function changedPaths(root = ROOT, range = "origin/main...HEAD") {
  return nulPaths(git(root, ["diff", "--name-only", "-z", "--no-renames", range, "--"]));
}

function assertPaths(paths, specs, description) {
  const classified = classifyPaths(paths, specs);
  const outside = classified.filter((entry) => entry.matches.length !== 1);
  if (outside.length) {
    const detail = outside.map((entry) => `${entry.path} (${entry.matches.length ? `matches ${entry.matches.join(", ")}` : "not a declared chain output"})`).join("; ");
    throw new Error(`refusing publish with out-of-scope ${description}(s): ${detail}`);
  }
  return classified.map((entry) => entry.path);
}

export function assertPublishScope(root = ROOT, specs = allowlistSpecs()) {
  return assertPaths(dirtyPaths(root), specs, "dirty path");
}

export function assertCommittedPublishScope(root = ROOT, specs = allowlistSpecs()) {
  return assertPaths(changedPaths(root), specs, "local commit path");
}

export function stagePublishScope(root = ROOT, specs = allowlistSpecs()) {
  const paths = assertPublishScope(root, specs);
  if (paths.length) git(root, ["add", "--all", "--", ...paths]);
  const cached = nulPaths(git(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"]));
  const outside = classifyPaths(cached, specs).filter((entry) => entry.matches.length !== 1);
  if (outside.length) throw new Error(`staged path escaped the publish allowlist: ${outside.map((entry) => entry.path).join(", ")}`);
  return paths;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const command = process.argv[2] || "check";
    const paths = command === "stage" ? stagePublishScope() : command === "check" ? assertPublishScope() : (() => { throw new Error(`unknown command: ${command}`); })();
    console.log(`publish-scope: ${command} passed for ${paths.length} declared chain-output path(s)`);
  } catch (error) {
    console.error(`publish-scope: ${error.message}`);
    process.exit(1);
  }
}
