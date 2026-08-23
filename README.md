# Dive Radio — Episode Analytics

Analytics dashboard for Dive Radio episode performance across four
destinations: YouTube (Dive Club + DesignerTom) and X (@ridd_design +
@designertom).

- Card layout: show-health gauge + six-check diagnosis + today's-read cards,
  then latest-episode and growth-trend cards, then the episode carousel above
  the chart
- Saved show-health score (daily; compares the newest episodes with the show's
  usual levels) with grounded Helping / Needs work bullets; missing checks drop
  out and history starts only from real saved days
- Per-episode health score (0–100, 50 = typical): each episode's own
  three-week read against the episodes before it, frozen at day 21 and shown
  nowhere until those three weeks are over
- Latest-episode card keeps unit discipline: total views = YouTube views + X
  broadcast plays; X reach shown separately and never summed into views
- Episode carousel + three chart views: Totals (stacked per destination),
  Over time (YouTube cumulative since premiere), and Watching (every episode's
  drop-off curve from verified YouTube analytics, with a dashed typical line
  once three curves exist)
- Episode panel adds the verified watch numbers: share watched, average time
  watched, total watch time, the drop-off curve, and where views came from
  (traffic sources) — view-weighted across both channels, absent when a
  report has not arrived
- The panel's drop-off curve carries transcript-anchored moment pins
  (tools/dive-analytics/watch-moments.mjs, deterministic): below the line
  where the most viewers left, above it where extra viewers were watching,
  each a keyboard-reachable tooltip whose context line is a model-written
  summary of what was happening (data/restream/moment-summaries.json,
  written by tools/dive-analytics/moment-summaries.mjs — never a raw
  transcript quote); the verbatim excerpts stay in the data as provenance
  and feed the recommendation engine alongside the shape and moment facts
- Click any episode for a detail panel: per-channel breakdown, reach split,
  episode-health checks, featured quotes, recurring audience themes,
  praise/concern drilldown, and direct links to the episode on every
  destination it lives on (registry-locked; validated URL shapes)
- Table view mirrors every charted number; "About this data" defines units
  and missing-data marks
- "What matters" is a model-backed recommendation engine
  (tools/dive-analytics/recommendations.mjs): it reads the full fact sheet —
  watch curves, view sources, per-channel subscribers and watch shares,
  health reads, live sessions, platform split — and saves four to seven
  tactical items whose every number is validated against the stored facts;
  deterministic rule-based insights remain the fallback when no store exists
- Static site — no server, no network calls at view time

For agent sessions and contributors: `CLAUDE.md` states the intent and the
rules every change must pass; `ARCHITECTURE.md` traces every number on the
page back to its store, script, and rule, and documents each store's time
semantics. Planned reliability work (baselines, like-for-like comparison,
freshness) is `tools/dive-analytics/prd-analytics-v7-*.md`.

Data is exported daily (07:25 America/Phoenix) by an automated pipeline that
also discovers newly published episodes and collects audience comments. A
separate model step removes noise, labels reactions, audits a sample, and keeps
unclear items off every surface. Built with vanilla JS + Chart.js (MIT, vendored).

The publish chain must run health only after the first deterministic gate, then
rebuild so today's saved entry reaches the public artifact:

```text
ratings → build-data → validate → health → recommendations → moment-summaries → build-data → validate → publish → freshness
```

(`recommendations` and `moment-summaries` need ANTHROPIC_API_KEY like
`health`. On any model or grounding failure `recommendations` prunes its
saved store to the items that still ground in the current facts — below
three survivors the store is removed and the page falls back to the
deterministic insights — so a stale store can never block a publish. For
`health` and `moment-summaries` the previous store stays the public truth.
`freshness` checks the LIVE site at the end of the chain and again from a
midday cron, raising one plain line when prod serves data older than 26
hours.)

The classifier, health writer, recommendation engine, moment summarizer,
and standing critic are the only model-backed scripts. `build-data.mjs`
(including the watch-moments extraction it imports) stays deterministic and
never calls a model.
