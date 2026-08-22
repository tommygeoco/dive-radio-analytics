# Dive Radio — Episode Analytics

Analytics dashboard for Dive Radio episode performance across four
destinations: YouTube (Dive Club + DesignerTom) and X (@ridd_design +
@designertom).

- Newest-episode hero (total views = YouTube views + X broadcast plays;
  X reach shown separately and never summed into views) with pace,
  sentiment, and outlier chips
- Episode strip + three views: Standings (stacked total views),
  Pacing race (YouTube cumulative since premiere), Weekly gains
- Click any episode for a detail panel: per-channel breakdown, reach split,
  featured quotes, comment sentiment with full drilldown
- Table view mirrors every charted number; "About this data" defines units
  and coverage markers
- Deterministic insights & recommendations computed at build time
  (no model calls), categorized by the decision they inform
- Static site — no server, no network calls at view time

Data is exported daily (07:25 America/Phoenix) by an automated pipeline that
also discovers newly published episodes, collects audience comments, and
classifies comment sentiment. Built with vanilla JS + Chart.js (MIT, vendored).
