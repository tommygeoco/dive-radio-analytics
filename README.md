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
- The panel's drop-off curve carries transcript-anchored moment markers
  (tools/dive-analytics/watch-moments.mjs, deterministic): ▾ where the most
  viewers left, ▴ where extra viewers were watching, each a keyboard-reachable
  tooltip quoting the verbatim transcript from that stretch; the same shape
  and moment facts (plus excerpts) feed the recommendation engine
- Click any episode for a detail panel: per-channel breakdown, reach split,
  episode-health checks, featured quotes, recurring audience themes, and
  praise/concern drilldown
- Table view mirrors every charted number; "About this data" defines units
  and missing-data marks
- "What matters" is a model-backed recommendation engine
  (tools/dive-analytics/recommendations.mjs): it reads the full fact sheet —
  watch curves, view sources, per-channel subscribers and watch shares,
  health reads, live sessions, platform split — and saves four to seven
  tactical items whose every number is validated against the stored facts;
  deterministic rule-based insights remain the fallback when no store exists
- Static site — no server, no network calls at view time

Data is exported daily (07:25 America/Phoenix) by an automated pipeline that
also discovers newly published episodes and collects audience comments. A
separate model step removes noise, labels reactions, audits a sample, and keeps
unclear items off every surface. Built with vanilla JS + Chart.js (MIT, vendored).

The publish chain must run health only after the first deterministic gate, then
rebuild so today's saved entry reaches the public artifact:

```text
ratings → build-data → validate → health → recommendations → build-data → validate → publish
```

(`recommendations` needs ANTHROPIC_API_KEY like `health`; on failure the
previous store stays the public truth, so the step is safe to skip.)

The classifier, health writer, recommendation engine, and standing critic
are the only model-backed scripts. `build-data.mjs` (including the
watch-moments extraction it imports) stays deterministic and never calls a model.
