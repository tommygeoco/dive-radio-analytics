# Card Ruling — Total Views, X Reach placement, card readability

Critic subagent · 2026-08-21 · companion to AUDIT-2026-08-21.md (F-2, F-3, F-7 govern units here).
Scope: metrics presentation only. No code changed by this ruling.

State checked before ruling: data.json 2026-08-22T00:45Z — all six episodes now have
plays coverage 2/2, no partial, no stale (F-1 recovery landed). So the sum in question
is computable honestly for the entire roster **today**.

---

## Q1 — "Total views" = ytTotal + xPlays: **LEGITIMATE. Ship it as the hero.**

**Ruling: YES.** YouTube views and X broadcast plays are both counts of *video playback
events*. The constitutional crime that destroyed trust was adding **impressions**
(exposure: post scrolled past on a timeline) to **views** (someone watched). Plays are
on the views side of that line. Summing them is a heterogeneous-but-same-dimension
total — the same thing every publisher does when they say "this episode did 4k across
platforms." It is not unit fraud; it is a cross-platform total of watch events.

The honest objections, weighed:

- **Methodology skew.** YouTube counts a qualified view (roughly ~30s / engagement
  heuristics); X counts a play start. The X term is the looser count, so the sum leans
  slightly generous. This is a *precision* caveat, not a *category* error — it belongs
  in hover text, not in the decision about whether the number may exist. Verdict:
  acceptable with a one-line methodology note on hover.
- **Partial/stale plays coverage.** This is the real hazard (F-2: E4's 541 shown as
  whole). The sum may only ever render as a whole number when plays coverage is whole.
  Degradation rules below are mandatory, not decorative.
- **Does it mislead at decision level?** No — the opposite. The current 3-stat grid
  forces Tommy to do the addition in his head while dodging the reach trap. One
  pre-added, impression-free number is *less* error-prone than three numbers where one
  is a different unit.

**Definition (canonical, everywhere):**
`totalViews = ytTotal + (xPlays ?? 0)` — never includes `xImpressions`, ever.

**Label:** `views` (small, muted, after the big number). Tommy's word, colloquially
correct. Not "plays", not "watches".

**Caveat markers (amber, same style as today's `.mk`), exhaustive:**

| plays state (from xPlaysInfo) | hero renders | marker |
|---|---|---|
| complete + fresh (have=total, !stale) | `3.9k views` | none |
| partial (have < total) | yt + available plays | `◐1/2` — hover: "plays from 1 of 2 broadcasts; true total is higher" |
| stale (high-water fallback) | yt + high-water plays | `→08/21` — hover: "X plays last confirmed 08/21" |
| plays entirely absent (value null) | ytTotal alone | `YT only` — hover: "X broadcast plays unavailable; this is YouTube only" |

A partial sum without its marker is a validator FAILURE (see Q4). F-2 survives.

**Hero hover text (exact):**
> Total views = YouTube views (both channels) + X broadcast plays (both hosts).
> YouTube: 2,071 · X plays: 1,782 (2/2 broadcasts). Both count video playback —
> YouTube counts a qualified view (~30s), X counts a play start, so treat the sum as
> directional. X post impressions (reach) are never included.

(First sentence and last sentence fixed; middle line is the live per-card breakdown.)

---

## Q2 — X reach: **secondary line on the card, small and muted. Not the grid, not tooltip-only.**

Tommy likes it and glances at it → it must stay visible without hovering. It failed the
top-level test on two grounds: it's a different unit than everything else on the card,
and its derivation is opaque. So: demote to one small line, attach the derivation to
hover. Insights panel keeps its reach-based items (host split, front-loading) unchanged.

**Card line (exact):** `X reach 7.7k` — 11px muted, directly under the hero.

**Hover text (exact, this wording, no variations across surfaces):**
> X reach = impressions on the two hosts' X announce posts for this episode
> (@ridd_design + @designertom). An impression = one time the post appeared on
> someone's timeline. It measures exposure, not watching — never added to views.

Why not tooltip-only: he said "I like having x reach." Hiding a metric the owner likes
to punish it for being confusing is the wrong fix; the fix is a smaller seat and a
clear label. Two sentences of why: reach is the announce-machine health gauge (did the
posts travel?), which is a real weekly question; it just isn't the "did people watch"
question the hero answers.

---

## Q3 — Card spec: one hero, five lines, everything else on hover

Kill the 3-stat grid. Each card, top to bottom:

```
┌────────────────────────────────┐
│ ● E6                ◐ late reg │
│ The Mascot Industrial Complex  │
│ 1.8k views                     │
│ X reach 7.7k                   │
│ ▲ 4% vs same-age median (YT)   │
└────────────────────────────────┘
```

1. **Identity row** — color dot + `E6` (12px caps, muted). Flags stay top-right,
   amber, unchanged: `◐ late reg`. (Late-reg flag survives per constraint.)
2. **Title** — 12.5px, max two lines, as today.
3. **HERO: total views** — one big number, ~26–28px bold (bump from today's 22px stat
   size; it's now alone and must carry the card). Followed by 12px muted `views`.
   Amber caveat marker per the Q1 table when coverage is not whole. Hover = the Q1
   breakdown text (YT/plays split lives here — it leaves the visible card).
4. **X reach line** — 11px muted: `X reach 7.7k`. Hover = the Q2 explanation.
5. **Pace line** — unchanged position/coloring: `▲ 4% vs same-age median (YT)` /
   `▼ 12% …`. **Add the `(YT)` tag** — mandatory now, because the hero is a blended
   number and the pace baseline is YT-only (Q4); without the tag the two get conflated.
   No-peer fallback stays: `premiered 08/20 · no same-age peer yet`.

**Moves to hover:** YT-vs-plays breakdown, plays coverage detail (n of m, as-of date),
methodology caveat, reach derivation. **Stays visible:** hero + marker glyph, reach,
pace, late-reg flag, episode identity. Live-session tab cards: untouched.

Glance test: a founder scanning six cards reads six big numbers, six pace arrows, done.
Second pass picks up reach. Nothing on the card requires unit vigilance anymore —
the only two numbers visible are pre-separated (views vs reach) and pre-labeled.

---

## Q4 — Consistency sweep: every surface that must move in the same commit

If `totalViews` ships on the cards, these adopt the **identical definition
simultaneously** (a "total views" that means different things on two surfaces is F-3
all over again):

1. **build-data.mjs `computeAll()`** — emit `latest.totalViews` and
   `latest.totalViewsInfo` (mirrors xPlaysInfo: `{includesPlays, partial, stale, asOf,
   have, total}`). Single source; index.html must render the field, never re-derive.
2. **index.html chart y-mode button** — currently labeled **"Total views"** and sums
   `views` across selected dest chips: with an X chip on, that is YT views +
   impressions under the exact label we're canonizing. Rename the button
   **"Cumulative views"** (delta stays "Views gained per week"). The phrase
   "Total views" is henceforth reserved for the YT+plays definition, everywhere.
3. **Monday Slack report** (`postlive-track.mjs report`) — per-episode line becomes
   `Total views N (YT n + X plays m) · X reach R (…)`; grand total becomes
   `All tracked shows — Total views: N ◐? · YT: n · X plays: m · X reach: R`. The
   grand total inherits `◐ some episodes partial/stale` whenever ANY episode's plays
   are partial/stale/absent — a grand total quietly missing one episode's plays is
   F-2 at fleet scale. Units legend line updated: "Total views = YT views + X
   broadcast plays (both video playback). X reach = post impressions, never included."
4. **Vault table** (`renderVault`, `Ops/Bones/live-show-analytics.md`) — add
   `Total views` column with the same `playsCell`-style markers; same legend sentence.
5. **Pace / velocity / flatline / anomaly math — stays YT-only. Ruled.** Plays history
   is one day old (first plays snapshot 2026-08-21; back catalog is point-in-time
   backfill, no time series). Same-age pace needs historical series at matching ages;
   a plays-inclusive pace would compare today's blended number against baselines that
   structurally lack plays — fabricated disadvantage for every old episode. Revisit
   only when ≥4 episodes have plays series from week 1. Corollary: the card pace line
   carries the `(YT)` tag (Q3.5), and `week1Velocity`, `flatlineWeek`, anomaly median,
   `sameAgePace` keep YT_KEYS untouched.
6. **`showTrend.cumulativeAllEpisodes`** — stays per-unit (`ytViews`/`xReach`). Do NOT
   add a `totalViews` series: plays have no history, so a backfilled series would be
   invented. Point-in-time `latest.totalViews` is honest; a totalViews *time series* is
   not yet possible.
7. **Insights text** — pace-rank keeps saying "YouTube views" explicitly; host-split
   and front-loading unchanged. Recommended (F-8 family, same commit or next): run the
   >2× median anomaly check on xPlays too — E3's 4,206 plays vs ~1,835 median would
   correctly flag as promo-driven.
8. **Publish** — public repo copies covered automatically by validator check 6.

### validate.mjs changes (exact)

In **section 1b** (unit separation), keep the existing `"total" in latest` ban
(the old mixed field stays illegal forever), and add:

- `FAIL` if `latest.totalViews == null` once the field ships (presence check, like ytTotal).
- `FAIL` unless `latest.totalViews === latest.ytTotal + (latest.xPlays ?? 0)` — the
  constitutional assertion; by construction this excludes xImpressions.
- `FAIL` (conflation heuristic) if `latest.totalViews - latest.ytTotal ===
  latest.xImpressions && latest.xImpressions > 0 && latest.xImpressions !==
  latest.xPlays` — catches an impressions value smuggled in through the plays slot.
- `FAIL` unless `totalViewsInfo.partial === xPlaysInfo.partial` and
  `totalViewsInfo.stale === xPlaysInfo.stale` — marker state may not be dropped
  between build and render (F-2 guard).
- `FAIL` if any key named `totalViews` appears in `showTrend.cumulativeAllEpisodes`
  entries (no fabricated blended history — item 6 above).

Section 7 (deterministic rebuild) needs no change and is what forces build-data and
data.json to move in the same commit. Sections 1/1c (plays sanity, high-water schema)
unchanged — they are the upstream guarantee that makes the sum trustworthy.

---

## Torn-decision notes (per the no-fence-sitting rule)

- **"views" vs a fussier label** ("plays", "watch starts"): chose *views* because the
  hero must be self-evident to its one reader and the methodology skew is second-order.
  The precision debt is paid in hover text, which is where precision debts belong.
- **Reach visible vs tooltip-only:** chose visible-secondary because the owner
  explicitly values it; the complaint was placement and opacity, not existence.
