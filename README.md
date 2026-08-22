# Dive Radio — Episode Analytics

Analytics dashboard for Dive Radio episode performance across four
destinations: YouTube (Dive Club + DesignerTom) and X (@ridd_design +
@designertom).

- Newest-episode hero (total views = YouTube views + X broadcast plays;
  X reach shown separately and never summed into views) with pace,
  audience-feedback, and outlier chips
- Saved show-health score with grounded Helping / Needs work bullets; missing
  checks drop out and history starts only from real saved days
- Episode strip + three views: Standings (stacked total views),
  Pacing race (YouTube cumulative since premiere), Weekly gains
- Click any episode for a detail panel: per-channel breakdown, reach split,
  featured quotes, recurring audience themes, and praise/concern drilldown
- Table view mirrors every charted number; "About this data" defines units
  and missing-data marks
- Deterministic insights & recommendations computed at build time
  (no model calls), categorized by the decision they inform
- Static site — no server, no network calls at view time

Data is exported daily (07:25 America/Phoenix) by an automated pipeline that
also discovers newly published episodes and collects audience comments. A
separate model step removes noise, labels reactions, audits a sample, and keeps
unclear items off every surface. Built with vanilla JS + Chart.js (MIT, vendored).

The publish chain must run health only after the first deterministic gate, then
rebuild so today's saved entry reaches the public artifact:

```text
ratings → build-data → validate → health → build-data → validate → publish
```

The classifier, health writer, and standing critic are the only model-backed
scripts. `build-data.mjs` stays deterministic and never calls a model.
