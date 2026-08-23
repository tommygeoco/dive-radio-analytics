# PRD — Dive Radio analytics v4: episode health + watching (2026-08-23)

Owner: Tommy. Supersedes the rating section of
`prd-analytics-v3-comments-and-rating-2026-08-22.md`; everything else in v3
(comments capture, classification, sentiment gates) stands. Copy this file
into the PRD folder (`Dive Media Group/Dive Radio/`) next to v2 and v3.

## Why v4

Two owner directives on 2026-08-23:

1. The "#x of N" episode rank (v3, ratio-v2) is retired. Every episode gets
   its own **three-week episode health score**, and **nothing renders before
   the three weeks are over** — no provisional badges, no settling notes.
2. The dashboard moves to the approved card layout, with the episode carousel
   above the chart, and must make the true health of the show legible: the
   daily show read, each episode's permanent three-week read, and (W13, same
   day) the verified watching data — drop-off curves, time watched, and view
   sources — visualized per episode and against a typical episode.

## 1. Episode health (replaces the rating)

**Definition (constitutional).** One score per episode, 0–100, where **50 =
right at what the show usually did before that episode aired**. It is written
once the episode is at least **21 days** old (the measured flatline point) and
is then **frozen forever** within an algorithm version. Windows never include
later episodes, so a finished score can never be rewritten by the future. An
algorithm version bump re-derives every score visibly (stamped at the store
root) — never silently.

**Window.** The episode plus up to 9 episodes that aired before it. The first
episode has no peers: it **sets the baseline** and carries a reason instead of
a score.

**Checks and weights** (each comparative check is own ÷ typical-of-peers,
converted to `round(clamp(50 × own/typical, 0..100))`):

| check      | weight | measure |
|------------|-------:|---------|
| watch      | 35%    | YouTube views at day 21, same-age against peers' real snapshots (late-registered episodes use their earliest real snapshot age; peers must genuinely span that age) |
| engagement | 15%    | YouTube likes+comments per 1k views at the episode's own read age, vs peers at theirs |
| retention  | 15%    | averageViewPercentage, view-weighted across channels with reports, vs peers |
| live       | 15%    | peak concurrents and chat messages vs peer typicals, averaged |
| conversion | 10%    | subscribers gained per 1k analytics views, both channels required, vs peers |
| sentiment  | 10%    | positive share of directional feedback (mixed counts half; needs 3+ directional comments from 3+ people), vs peers' shares |

**Missing-data rule.** A check with no honest number drops out and its weight
redistributes. Never estimate, interpolate, or zero-fill. A score ships only
with ≥2 checks and ≥50% of planned weight; otherwise the entry carries a
reason. A real zero (e.g. 0 subscribers gained) is an honest value, never
treated as missing.

**Store.** `data/restream/episode-ratings.json` (path kept for the cron
chain), `algorithm: "health21-v1"`, entries only for finished episodes,
`rederivedFrom: "ratio-v2"` stamped. `build-data.mjs` attaches the entry as
`episode.health`; younger episodes get `{ pending: true, readCompleteOn }`.

**Surfaces.** Carousel card chip (`health 44` + micro-track, finished only;
E1 shows "sets the baseline"; pending episodes show nothing), hero wait line
("Health score lands after 09/10"), panel breakdown (per-check values with
plain "% above/below typical" words, basis line, missing-check note), table
column, Slack trends line. The chip explains itself on hover/focus/tap.

## 2. Show health changes

Unchanged formula; two version stamps moved:

- `FORMULA_VERSION health-v2`: model context now carries per-episode health
  (scores, pending dates, reasons) instead of ranks; the projection exposes
  the six saved checks so the page renders a full diagnosis (Healthy ≥55 /
  Steady 45–54 / Fragile <45 / Not in yet) without recomputing.
- `PROMPT_VERSION 2`: the headline must agree with the rendered check states;
  a single strong measure inside a mixed check may be praised only by name.
- Validation is stamp-aware: saved entries are judged against their own
  stamped versions; history stays append-only and immutable.

Scope is stated in-product (today's-read card): the score is saved once a
day and compares the newest episodes with the show's usual levels — a today
read, not a running total over any fixed number of days.

## 3. Watching (W13 — verified analytics on the page)

**Source.** `yt-analytics-pull.mjs` (v2 W7) — owner OAuth for both channels.
Per episode: views, estimatedMinutesWatched, averageViewDuration,
averageViewPercentage, subscribersGained, likes, comments, traffic sources,
and the 100-point drop-off curve.

**Export (`episode.watch`, built by `build-data.mjs`).** View-weighted blend
across channels with reports: `avgPercent`, `avgDurationSec`,
`minutesWatched`, `curve` (`{at, watching}` on the shared grid; null until
YouTube produces curves), `traffic` (top 5 sources + "Everything else", with
shares). A channel without a report drops out; an episode without any report
carries no block. Absence is never zero.

**Surfaces.**
- **Watching chart view** (third mode beside Totals / Over time): every
  finished curve overlaid — the newest episode with a curve in color, priors
  gray until soloed, plus a dashed **typical** line (middle value across
  curves at each point) drawn only once **three** real curves exist. Episodes
  without curves are named in the scope line ("E6 not in yet"). Unit switch
  is announced with a visible "YouTube only" pill.
- **Episode panel**: share watched, average time watched, total watch time,
  the blended drop-off curve, and "Where views came from" in plain words.
- **Table**: a Watched column mirrors the share.

**Honesty gates.** Typical line waits for 3 curves; missing curves are named,
not hidden; duration/minutes are stated per the analytics reports at pull
time; watch data is YouTube-only and says so (X reports no equivalent).

## 4. Contracts

`tools/dive-analytics/audit/validate.mjs` enforces: the 21-day gate (no
stored or attached score before day 21; pending markers carry the exact
read-complete date), frozen immutability on recompute, weight math and
missing-check bookkeeping, definition-lock between store and page data, the
card reading order (health → latest/trend → carousel → panel → chart),
glance-number budgets per surface, plain-words bans, watch-blend ranges and
curve ordering, and the three-curve typical gate.

## 5. Open questions / later

- Retention curve *shape* diagnostics (cold-open cliff depth, mid-video sag)
  as deterministic insights — the E2 cliff (≈66% → ≈15% within the first 2%)
  is the motivating example.
- averageViewDuration is exported but not scored (share-watched is the
  normalized form; duration is display-only).
- Palette consolidation (episode identity vs platform vs category hues) —
  accepted debts, revisit after the card layout settles.
- Growth-trend card gains real bars once three clean first weeks exist
  (expected 2026-08-27 when E6's first week completes).
