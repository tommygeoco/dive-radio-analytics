# PRD — Dive Radio analytics v5 addendum: glyph grammar, recommendation engine, per-channel splits (2026-08-23)

Owner: Tommy. Extends v4 (episode health + watching), which shipped the same
day. Everything here is LIVE in production as of this date. Copy into the PRD
folder next to v2–v4.

## W14 — Glyph grammar (owner directive: replace micro text labels)

- Inline 14px stroked icon set (`ICONS` in index.html) carries identity on
  every dense surface; a colored **direction badge** carries comparison:
  `▲12%` (good) / `▼20%` (bad) / `≈` (within the ±5% quiet zone). Definitions
  live in hover/tap/focus tooltips (`data-tip`, shared `#rtt` box), never as
  inline explainer text. The episode-health tile, live and watch stat lines,
  and view sources all use this grammar; the diagnosis card dropped its
  sub-label column; carousel chips use a pulse glyph instead of the word
  "health". Every glyph keeps a text name via aria or tooltip — no state
  rides on color or symbol alone. About documents ▲▼≈.

## Absence is silent (constitutional UI rule, owner directive)

A missing metric renders **nothing**: no asterisks, no "sat out" notes, no
wait dates ("arrives after 09/10" is retired), no "sets the baseline" chips,
no "not in yet" scope suffixes. The gates still hold (no score before day 21,
typical watch line waits for three curves) — they are simply not announced.
The validator FAILS if retired absence copy reappears
(`healthWaitDate|sat out|sets the baseline`). Structural placeholders ("–" in
table cells) remain; About carries the methodology.

## W15 — Recommendation engine ("What matters")

- `tools/dive-analytics/recommendations.mjs`: model-backed. Builds a
  deterministic fact sheet (~108 facts) from every store — watch curves,
  traffic sources, per-channel subscribers and watch shares, episode health,
  live sessions, platform split — and asks for 4–7 tactical items
  `{id, category, text, recommendation}`.
- Discipline: every number token in a saved item must exist in the fact
  sheet (exact-match tokenizer, thousands-groups aware); banned-jargon list
  enforced; failure keeps the previous store. Store:
  `data/restream/recommendations.json`.
- `build-data.mjs` projects the store into `data.insights` wholesale; the
  deterministic rule-based insights are now only the no-store fallback (the
  validator's live-chat sentence contract applies only in fallback mode).
- Validator block 1n: re-grounds the store on every run and definition-locks
  the page to it.
- Chain (owner machine): `ratings → build-data → validate → health →
  recommendations → build-data → validate → publish`. Needs
  ANTHROPIC_API_KEY; safe to skip.
- Seeded 2026-08-23 from the owner session (provider "session", model null):
  open-cliff, best-open-template, end-screens-dead, discovery-gap, x-bridge,
  subscribe-window, channel-gap.

## Per-channel attribution (owner directive: separate AND cumulative)

- `episode.watch.byChannel[]`: each channel's views, share watched, average
  duration, subscribers, subscribers per 1,000 — never hidden by the blend.
- Panel: both channels' share watched render beside the blended number in
  channel colors; the subscribers row tooltip names the split.
- `health.mjs` (still formula health-v2, prompt v2): the fact sheet now
  includes per-channel watch-percent and subscriber-rate facts so daily
  bullets can name the channel.
- Engine facts include per-channel and cumulative channel totals.

## Layout & interaction changes since v4

- **Panel = bento**: sections are contrast tiles (s1 wells on the s2 panel,
  10px radius, 6px gaps) on a deliberate grid — row 1 health/totals/reach,
  row 2 live/watching/sources, feedback spans the bottom; 2 columns
  mid-width, 1 on phones. Header: title left; date · transcript right; the
  tracked-late chip is retired (About covers late tracking).
- **Chart independence**: the panel lives BELOW the chart; a card click
  scrolls the chart into view. In Totals, selecting an episode collapses the
  chart to that one bar (animated, 168px) with the full-standings x-scale
  kept so the bar holds its true length; line views give a solo the full
  canvas. Locked order: health → hero/trend → carousel → chart → panel.
- **Hover highlight**: pointing at any line (race/watching/live) lights it in
  its episode color, raises it, and reveals its end label; hidden lines never
  draw labels.
- **Status colors**: table health by band, watched vs typical (±5% quiet
  zone, ▲/▼), pace by direction; raw view totals stay uncolored (age-unfair).
  Diagnosis status dots sit in a fixed left-aligned column.
- **Evidence card**: direction dots per bullet, the single validated number
  bolded, structured not-in-yet rows, capped measure.
- **Mobile cut**: inline stamp, compact tabs, 84px gauge beside its caption,
  8px card rhythm, methodology deferred to About.
- Footer removed (About's Cadence line already says it).

## Validator contract updates

1j absence regex; 1k re-pinned order and argumented bullets; 1n engine
grounding; live-chat fallback gating; watching export checks (1m) unchanged.

## Superseded / retired

v4's "young episodes state when their read completes" surface copy; the
deterministic insights as the primary "What matters"; per-check missing
notes and marks.
