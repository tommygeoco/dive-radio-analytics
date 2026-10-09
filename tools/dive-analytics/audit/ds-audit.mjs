#!/usr/bin/env node
// ds-audit.mjs — static conformance check against the Smart Sharps design system.
//
// VENDORED from ~/.claude/skills/smart-sharps-design-system/scripts/ds-audit.mjs
// (2026-10-06; re-vendored at design system 3.1.1 on 2026-10-08) so the validator can
// lock the pages' design-system conformance on any machine. Change the skill's copy
// first, then copy it here byte-for-byte below this note.
//
//   node ds-audit.mjs <file.html|file.css> [more files…] [--json] [--quiet]
//
// Reads every <style> block, every style="…" attribute, and (for .html/.js) the
// script text, then reports anything that does not come from the system:
//
//   color      a raw hex / rgb() / hsl() color outside the token block (:root {…}
//              that DEFINES custom properties). Charts must read tokens with
//              getComputedStyle, not hard-code them.
//   font-size  a size that is not a --text-* token or one of the scale steps
//              (11 12 13 14 15 17 20 26 34 40 px, or their rem values).
//   spacing    padding / margin / gap / inset / top / right / bottom / left /
//              row-gap / column-gap px values that are not on the 4 px grid.
//              1 px and 2 px are allowed only for hairline nudges (outline-offset,
//              a 2 px focus inset) and a 1 px gap for hairline grids — anything
//              else off-grid is a finding.
//   radius     border-radius not in {0, 4, 8, 12, 16, 20, 24, 28 px, 999px, 50%}
//              and not a var(--radius-*) token.
//   font       a font-family that is not var(--font-sans) / var(--font-num) / var(--font-mono) /
//              inherit (system stacks belong only in the token block).
//   weight     font-weight outside {400, 500, 600, 700}.
//   case       text-transform: uppercase (the system is sentence case; the LIVE
//              pill is the one sanctioned exception — mark it with ds-allow).
//   decoration a gradient anywhere but a mask-image scroll fade or the skeleton
//              shimmer, or a backdrop-filter that is not a plain blur (sticky chrome
//              only: the top bar and tab bar) — the system is flat surfaces and hairlines.
//
// A line may opt out of ONE rule with a trailing comment naming it and why:
//   /* ds-allow color: YouTube's own logo red inside its mark */
// Opt-outs are counted and listed so a reviewer can judge every one.
//
// Exit code: 0 when there are no findings, 1 otherwise.
//
// As a module: `import { auditSource } from "./ds-audit.mjs"` →
// auditSource(text, "page.html") returns { findings, allowed }.

import { readFileSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const TYPE_PX = new Set([11, 12, 13, 14, 15, 17, 20, 26, 34, 40]);
const TYPE_REM = new Set([0.6875, 0.75, 0.8125, 0.875, 0.9375, 1.0625, 1.25, 1.625, 2.125, 2.5]);
const RADII = new Set([0, 4, 8, 12, 16, 20, 24, 28, 999, 9999]);
const WEIGHTS = new Set(["400", "500", "600", "700", "normal", "bold", "inherit"]);
const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|padding-(top|right|bottom|left|inline|block)(-start|-end)?|margin-(top|right|bottom|left|inline|block)(-start|-end)?|inset-(inline|block)(-start|-end)?|scroll-padding|scroll-margin)$/;

let findings = [];
let allowed = [];

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function allowFor(lineText, rule) {
  const m = lineText.match(/ds-allow\s+([a-z-]+)\s*:\s*([^*`]*)/);
  return m && m[1] === rule ? m[2].trim() || "(no reason given)" : null;
}

function report(file, text, index, rule, detail) {
  const line = lineOf(text, index);
  const lineText = text.split("\n")[line - 1] || "";
  const why = allowFor(lineText, rule);
  const entry = { file, line, rule, detail: detail.slice(0, 140) };
  if (why) allowed.push({ ...entry, why });
  else findings.push(entry);
}

// Token block: any `:root … { … }` (or [data-*] variant on :root / html) rule whose
// body is mostly custom-property definitions. Raw colors are legal only there.
function tokenRanges(css, offset) {
  const out = [];
  const re = /(^|[}\s])((?::root|html)[^{]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[3].replace(/\/\*[\s\S]*?\*\//g, "");
    const decls = body.split(";").map((d) => d.trim()).filter(Boolean);
    const custom = decls.filter((d) => d.startsWith("--")).length;
    if (decls.length && custom / decls.length >= 0.6) {
      out.push([offset + m.index, offset + m.index + m[0].length]);
    }
  }
  return out;
}

// @font-face blocks may carry data URIs and fallback stacks; skip them entirely.
function fontFaceRanges(css, offset) {
  const out = [];
  const re = /@font-face\s*\{[^}]*\}/g;
  let m;
  while ((m = re.exec(css))) out.push([offset + m.index, offset + m.index + m[0].length]);
  return out;
}

function inRanges(i, ranges) { return ranges.some(([a, b]) => i >= a && i < b); }

function auditDeclarations(file, text, segStart, segText, skip) {
  // naive declaration scan: prop: value; inside the segment
  const re = /(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/gim;
  let m;
  while ((m = re.exec(segText))) {
    const at = segStart + m.index;
    if (inRanges(at, skip)) continue;
    const prop = m[1].toLowerCase();
    const value = m[2].trim();
    if (prop.startsWith("--")) continue;
    // colors anywhere in a declaration value
    for (const c of value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/gi)) {
      report(file, text, at, "color", `${prop}: ${value}`);
      break;
    }
    if (prop === "font-size") {
      const ok = /var\(--text-/.test(value) || value === "inherit" || /^(100%|1em|smaller|larger)$/.test(value)
        || [...value.matchAll(/([\d.]+)px/g)].every((x) => TYPE_PX.has(Number(x[1]))) && /px/.test(value)
        || [...value.matchAll(/([\d.]+)rem/g)].every((x) => TYPE_REM.has(Number(x[1]))) && /rem/.test(value);
      if (!ok) report(file, text, at, "font-size", `${prop}: ${value}`);
    }
    if (SPACING_PROPS.test(prop)) {
      for (const x of value.matchAll(/(-?[\d.]+)px/g)) {
        const n = Math.abs(Number(x[1]));
        if (n === 0 || n % 4 === 0) continue;
        if ((n === 1 || n === 2) && /^(margin|inset|top|right|bottom|left)/.test(prop)) continue; // hairline / ring compensation
        if (n === 1 && /gap$/.test(prop)) continue; // a hairline grid: 1 px gaps over a --line background
        report(file, text, at, "spacing", `${prop}: ${value}`);
        break;
      }
    }
    if (prop === "border-radius" || /^border-(top|bottom)-(left|right)-radius$/.test(prop)) {
      if (!/var\(--radius-|inherit|50%/.test(value) || /px/.test(value)) {
        const bad = [...value.matchAll(/([\d.]+)px/g)].some((x) => !RADII.has(Number(x[1])));
        if (bad) report(file, text, at, "radius", `${prop}: ${value}`);
      }
    }
    if (prop === "font-family") {
      if (!/^(var\(--font-(sans|num|mono|heading)\)|inherit)$/.test(value)) report(file, text, at, "font", `${prop}: ${value}`);
    }
    if (prop === "font") {
      if (!/var\(--font-(sans|num|mono)\)|inherit/.test(value)) report(file, text, at, "font", `${prop}: ${value}`);
    }
    if (prop === "font-weight" && !WEIGHTS.has(value)) report(file, text, at, "weight", `${prop}: ${value}`);
    if (prop === "text-transform" && /uppercase/.test(value)) report(file, text, at, "case", `${prop}: ${value}`);
    if (/gradient\(/.test(value) && !/^(-webkit-)?mask(-image)?$/.test(prop) && !/skeleton|shimmer/.test(segText.slice(Math.max(0, m.index - 200), m.index))) report(file, text, at, "decoration", `${prop}: ${value}`);
    if ((prop === "backdrop-filter" || prop === "-webkit-backdrop-filter") && !/^blur\(\d+px\)$/.test(value)) report(file, text, at, "decoration", `${prop}: ${value}`);
  }
}

export function auditSource(text, file = "page.html") {
  findings = []; allowed = [];
  scan(file, text);
  return { findings, allowed };
}

function auditFile(file) { scan(file, readFileSync(file, "utf8")); }

function scan(file, text) {
  const ext = extname(file).toLowerCase();
  const segments = [];
  if (ext === ".css") segments.push([0, text, "css"]);
  else {
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) segments.push([m.index + m[0].indexOf(m[1]), m[1], "css"]);
    for (const m of text.matchAll(/style="([^"]*)"/g)) segments.push([m.index + 7, m[1], "inline"]);
    if (ext === ".js" || ext === ".mjs") segments.push([0, text, "js"]);
    else for (const m of text.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) segments.push([m.index + m[0].indexOf(m[1]), m[1], "js"]);
  }
  for (const [start, seg, kind] of segments) {
    if (kind === "css" || kind === "inline") {
      const skip = kind === "css" ? [...tokenRanges(seg, start), ...fontFaceRanges(seg, start)] : [];
      auditDeclarations(file, text, start, seg, skip);
    } else {
      // scripts: hard-coded colors (charts, inline styles built in JS)
      for (const c of seg.matchAll(/["'`](#[0-9a-f]{6}(?:[0-9a-f]{2})?|#[0-9a-f]{3})["'`]|rgba?\(\s*\d+[^)]*\)/gi)) {
        const at = start + c.index;
        const lineText = text.split("\n")[lineOf(text, at) - 1] || "";
        if (/^\s*\/\//.test(lineText)) continue; // comment lines
        report(file, text, at, "color", c[0]);
      }
      // inline style strings built in JS: check their declarations too
      for (const s of seg.matchAll(/style=\\?"([^"\\]*)/g)) auditDeclarations(file, text, start + s.index + 7, s[1], []);
    }
  }
}

// Compare real paths: ~/.claude/skills is a symlink, and Node reports the main
// module by its real path — a plain string compare would skip main() and exit 0.
const isCli = (() => {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
})();
if (isCli) main();

function main() {
const args = process.argv.slice(2);
const json = args.includes("--json");
const quiet = args.includes("--quiet");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node ds-audit.mjs <file.html|file.css|file.js> [...] [--json] [--quiet]");
  process.exit(2);
}
for (const f of files) auditFile(f);

const byRule = {};
for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
if (json) {
  console.log(JSON.stringify({ findings, allowed, byRule, total: findings.length }, null, 2));
} else {
  if (!quiet) {
    for (const f of findings) console.log(`${f.file}:${f.line}  [${f.rule}]  ${f.detail}`);
    if (allowed.length) {
      console.log(`\n${allowed.length} opt-out(s):`);
      for (const a of allowed) console.log(`  ${a.file}:${a.line}  [${a.rule}]  ${a.why}`);
    }
  }
  const summary = Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(" · ");
  console.log(`\nds-audit: ${findings.length} finding(s)${summary ? ` — ${summary}` : ""}; ${allowed.length} opt-out(s)`);
}
process.exit(findings.length ? 1 : 0);
}
