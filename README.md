# Dive Radio — Episode Analytics

Analytics dashboard for Dive Radio episode performance across four
destinations: YouTube (Dive Club + DesignerTom) and X (@ridd_design +
@designertom).

- Card layout: show-health gauge + six-check diagnosis + today's-read cards,
  then latest-episode and growth-trend cards, then the episode carousel above
  the chart
- Saved show-health score (daily; compares the newest episodes with the show's
  usual levels, like for like — same age or three weeks in, never a two-day-old
  rate against a month-old one) with grounded Helping / Needs work bullets;
  missing checks drop out, the header says when the read is behind the data,
  and a read older than a week is withheld
- Show health in three lenses (PRD v10): one score from the newest episode at
  its age (seven checks reading the whole live session — peak, average,
  people who watched live, minutes watched, minutes each stayed, hold to the
  end, chat — plus YouTube discovery; promo-driven lifts shown, not scored;
  stale reads carried at half weight; each check's state word from bands
  fitted to its own swing, PRD v10 §11), a direction word from the last five clean
  episodes, and an outlook for the next first week — with a standing
  verification loop (`tools/dive-analytics/health-verify.mjs`) that ledgers
  every claim and scores it against reality, plus owner feel notes
  (`tools/dive-analytics/health-feedback.mjs better|same|worse "…"`).
- Launch word per episode (strong / typical / soft, promo-qualified, "so far"
  under a week) on every card from its first reading.
- What matters: the five things to do this week, ranked by lever and
  anchored in the day's show-health read (which checks are fragile, which
  measures are softening, the outlook, each launch word); every number in an
  item is a stored fact, and each item names the health check it helps.
- Per-episode health score (0–100, 50 = typical): each episode's own
  three-week read against the eight episodes before it (promo outliers left
  out, at least three to compare), frozen at day 21 with the inputs it used
  stored, and shown nowhere until those three weeks are over
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
semantics. The comparison rules (one `baselines.mjs`, like-for-like bases,
eight-episode windows, three-peer minimum, rebuildable freezes, freshness)
are specified in `tools/dive-analytics/prd-analytics-v7-*.md`.

Data is exported daily (07:00 America/Phoenix, an OpenClaw automation on the owner machine running `tools/dive-analytics/run-chain.mjs`) by an automated pipeline that
(PRD v11: the chain pulls and heals first, retries the two platform steps once, runs the validator in publish mode — honesty checks block, source-contract drift is reported — publishes with a self-fixing script, and queues one Slack line on any failure; `dive-alerts` delivers the queue every 30 minutes and a freshness check re-reads the live site at 08:15 and noon)
also discovers newly published episodes and collects audience comments. A
separate model step removes noise, labels reactions, audits a sample, and keeps
unclear items off every surface. Built with vanilla JS + Chart.js (MIT, vendored).

The publish chain must run health only after the first deterministic gate, then
rebuild so today's saved entry reaches the public artifact:

```text
ratings → build-data → validate → health → health-verify → recommendations → moment-summaries → build-data → validate → publish → freshness
```

(`recommendations` and `moment-summaries` need ANTHROPIC_API_KEY like
`health`. On any model or grounding failure `recommendations` prunes its
saved store to the items that still ground in the current facts — below
three survivors the store is removed and the page falls back to the
deterministic insights — so a stale store can never block a publish. For
`health` and `moment-summaries` the previous store stays the public truth.
`freshness` checks the LIVE site at the end of the chain and again from a
midday OpenClaw automation, raising one plain line when prod serves data older than 26
hours.)

The classifier, health writer, recommendation engine, moment summarizer,
and standing critic are the only model-backed scripts. `build-data.mjs`
(including the watch-moments extraction it imports) stays deterministic and
never calls a model.
