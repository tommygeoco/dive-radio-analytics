# BUILD REVIEW — Dive Radio Analytics — 2026-08-21 (post-redesign, 5 commits)

Third ruling tonight. Scope: commits db0068b → 9924063 (Total-views hero, hover
panel, text trim, chart redo, card reorder + categorized insights), verified
against source, data.json, and the live Vercel deploy (publish 23:00 MST,
byte-match confirmed by validate.mjs).

**Headline: the numbers are now honest everywhere. The remaining lies are in
framing and navigation, not arithmetic.** 0 CRITICAL, 5 HIGH, 6 MEDIUM,
7 POLISH.

---

## A. Data integrity — PASS

- `validate.mjs` exits 0. 13 ok-lines, 6 warnings (all sub-±2 YT view dips,
  documented API jitter). Rebuild determinism and public-repo byte-match both
  hold.
- **Standings math hand-verified, all six episodes exact:**

  | Ep | YT Dive | YT Tom | X ridd plays | X tom plays | Σ segments | totalViews |
  |----|---------|--------|--------------|-------------|-----------|------------|
  | E1 | 1,227 | 844 | 1,022 | 760 | 3,853 | 3,853 ✓ |
  | E2 | 1,149 | 914 | 1,166 | 635 | 3,864 | 3,864 ✓ |
  | E3 | 937 | 664 | 1,429 | 2,777 | 5,807 | 5,807 ✓ |
  | E4 | 1,191 | 706 | 1,329 | 541 | 3,767 | 3,767 ✓ |
  | E5 | 638 | 500 | 1,088 | 958 | 3,184 | 3,184 ✓ |
  | E6 | 500 | 380 | 664 | 289 | 1,833 | 1,833 ✓ |

  No double-count, no undercount, E2's dual-host posts attribute cleanly. All
  episodes have have=2/total=2 plays coverage, so no ◐ renders today; the
  barTotals plugin (index.html ~L330) correctly reads
  `latest.totalViewsInfo.partial` and would render ◐ per-episode. Correct.

---

## HIGH

**H-1. The verdict banner contradicts the hero cards sitting 40px below it.**
Banner (live, top of page): *"E6 — The Mascot Industrial Complex: at 880
YouTube views (plus 7,723 X post impressions)…"*. E6's card: **1.8k views**.
Two different hero numbers for the same episode in the two most prominent
surfaces, and the banner resurrects impressions in prime position — the exact
pattern the card ruling demoted. Source: `pace-rank` fallback text
(build-data.mjs ~L470) predates the Total-views ruling and was never migrated;
syncUI (index.html ~L618) pipes it verbatim into the banner. This is the last
surface still speaking the old language.

**H-2. Insight "show me" routing sends three insights to views that cannot
show their claim — one actively disproves it.**
Routing rule (index.html ~L700): `solo || delta || calendar → trajectory, else
standings`. Trajectory is YT-only by design.
- **Outlier insight** (E3: >2× median *X plays* and *X reach*) has `solo` set →
  routes to Trajectory solo E3. Verified live: you land on a flat, unremarkable
  YT-only line (~1.6k) with zero X data. The chart visually *refutes* the
  insight. Standings solo — where E3's giant blue X segment is the whole story
  — was one conditional away.
- **platform-phase** (X front-loading vs YT compounding) → calendar Trajectory,
  which contains no X series at all.
- **host-split** (impressions, tom 59%) → Standings, which shows *plays*, where
  ridd leads. The user is shown the opposite ordering of the claim.
watch-split and host-plays-split route correctly. The routing heuristic is
shape-based (delta/calendar/solo) when it needs to be unit-based (does the
target view contain the cited unit?).

**H-3. host-split's conclusion is manufactured by the episode its sibling
insight disowns.** "tom is the stronger announce arm — 59%" rests on E3's
16,541-impression outlier post. Remove E3 (which the Outlier insight itself
says to "treat as promo-driven outlier, not topic signal"): ridd 18,336 vs tom
14,044 — **ridd leads 57%**. Two insights on the same screen: one says discard
E3 as signal, the other builds its only conclusion on it. At n=6 with a known
outlier, "stronger announce arm" is overclaimed; the sign of the claim flips
on one excluded row.

**H-4. platform-phase includes a 1.2-day-old episode in a "week-1 share of
lifetime" statistic.** full-history set = {E1, E2, E6}; E6 is 1.2 days old, so
its "week-1 snapshot" IS its lifetime — it contributes 100%/100% trivially and
inflates both shares. Recomputed: with E6 → 95%/89% (shipped); ≥7d-only (n=2)
→ 91%/87%. The sibling reach-conversion insight applies exactly this ≥7d
exclusion; platform-phase doesn't. Worse, the framing self-contradicts: "YouTube
compounds over weeks" in a sentence reporting that 89% of lifetime YT views
land in week 1. The honest read of these numbers is "both platforms front-load;
X slightly more." (build-data.mjs ~L497.)

**H-5. Category icon colors violate the locked "color-distinct from platform
colors" rule — two exact hex collisions.** `CATS.live = #ff4f5e` ≡
`PLAT_COLORS["yt:joindiveclub"]` (the red filling the chart directly above);
`CATS.engagement = #59b0ff` ≡ `PLAT_COLORS["x:designertom"]` (and the accent
color). Five of eight category colors are also verbatim episode-PALETTE entries
(#e6c74a, #3ecf8e, #ff7a59, #ff5d8f, #59b0ff). An Engagement insight about
*YouTube* wears tom's X-blue. index.html ~L680 vs ~L156.

## MEDIUM

**M-1. "Per week" silently renders 2 of 6 episodes.** E3–E6 were (re)first-
snapshotted 2026-08-21; their first Monday-noon boundary is Aug 24, so
`weekly=[]` (verified: weekly lengths 4,4,0,0,0,0). Verified live: Per-week
view shows only E1/E2 bars; the newest episode vanishes with no explanation.
Self-heals Monday, but tonight the owner can hit an unexplained empty state.
The flatline insight also lands here.

**M-2. Trajectory's YT-only nature is carried by one 11px hint line.** Cards
say E3 = 5.8k; Trajectory shows E3 topping out at ~1.6k. No axis title, no
"YouTube" in the tooltip's big number ("2,071 views" — the split rows below
are the only clue). The Standings→Trajectory unit shift is the single most
likely misreading in the tool and it's guarded by the least prominent text on
the page. One word — "YT views" in the tooltip big line or a y-axis title —
closes it.

**M-3. Standings segment tooltip implicitly calls plays "views".** Hover an X
segment: "1,022 @ridd_design / of 3,853 total views". The play-count carries no
unit word; the hint ("every segment is a watch count") is off-canvas. Cheap fix
inside key-pieces budget: "1,022 plays" / "1,227 views" as the small label.

**M-4. The hint promises something the code will never do.** "X plays history
accumulates from Aug 21" + code comment "They join as their series accumulates"
(index.html ~L200) — but `sum()` is hardcoded `YT_KEYS`; plays will never join
Trajectory without a code change. Stale promise = a future "why isn't this
updating" bug report. Either build the accretion or say "YouTube views only."

**M-5. Tomorrow's 7:25 run fails silently.** The snapshot cron
(c4bc213f) has `delivery: not requested`. The chain is correctly gated
(discover && snapshot && build && **validate** && publish, timeout 420s,
node --check passes on all three files, publish.sh is set -eu and idempotent) —
but if any link fails, nobody is told until someone notices stale data.
Plausible failure modes for the first unattended run: (a) a YT view-dip
exceeding validate's jitter tolerance → hard fail, publish blocked by design;
(b) X plays scrape returning nothing → handled (high-water fallback + stale
marker), fine; (c) `vercel deploy` CLI auth/token staleness in a non-
interactive shell — git push would succeed, deploy step fails, cron exits
non-zero, site serves last-good; (d) 420s ceiling if yt-dlp hangs. None would
corrupt data; all would be invisible.

**M-6. Engagement insight compares a 35-day episode against a 1-day episode.**
49.7 (E1, age 35d) vs 28.4 (E6, age 1.2d) per-1k — engagement ratios drift with
age; "reach and resonance are separating" is a trend claim built on two
episodes at wildly different lifecycle points. Math verified correct
(103/2,071k, 25/880k ✓); framing overstates.

## POLISH

- **P-1. Rapid-iteration debris:** `PLAT_NAME` (index.html L161) defined,
  never referenced. `.chips`/`.chip` CSS (L60-66) orphaned since the filter
  row was deleted. `chartState.dests` still emitted for every insight
  (build-data.mjs `state()`) and never consumed. `splitOf` collects X keys the
  tooltip never renders. Same-age median logic exists twice (client
  `sameAgeSub` vs build `sameAgePace`).
- **P-2. Stale comment / flipped reading order:** `renderStandings` says
  "newest first, matches the cards" — cards are now oldest→newest L→R, bars
  newest→oldest top→bottom. Both put the newest at the visual anchor, which is
  defensible, but the comment is now false and "Standings" bars are ordered by
  recency, not standing.
- **P-3.** E2 card: "▲ 0% vs same-age median" — an up-arrow on zero.
- **P-4.** Public repo README still describes the deleted chart ("one line per
  episode… cumulative or weekly delta"); no mention of Standings/Total views.
- **P-5.** Card click rebuilds the board; `mouseleave` never fires on the
  removed node, so the hover panel can linger until the next mouse move.
- **P-6.** `medianOf` is upper-median (`v[floor(len/2)]`): plays median
  reported 1,870 vs interpolated 1,835.5. Consistent and immaterial (E3 is
  2.3× either), but it's not the median a reader would compute.
- **P-7.** Live view labels X channels "X"/"X #2" by destination iteration
  order with host-colored swatches — the ridd/tom identity implied by color is
  not guaranteed stable across events.

## D. UX rule compliance (owner's locked rules)

| Rule | Status |
|------|--------|
| One hero number per card | ✅ (hero + demoted reach line, per ruling) |
| Key-pieces-only tooltips | ✅ trimmed hard; M-3 unit word is the one gap |
| No unit mixing visible | ✅ in all math; H-1 banner surfaces impressions at top prominence |
| Latest episode far right | ✅ verified live; left-edge expander logic correct (dormant at n=6) |
| Icons color-distinct from platforms | ❌ H-5, two exact hex collisions |
| Progressive disclosure | ✅ hover panel sums to hero exactly, reach below divider, "not in total" |

## E. Pipeline coherence — PASS with M-5 caveat

postlive-track.mjs report/vault output agrees with dashboard definitions
verbatim ("Total views = YT views + X broadcast plays… ◐ = partial plays
coverage", L543-671). Both cron payloads gate on validate.mjs before publish.
`node --check` clean on postlive-track.mjs, build-data.mjs, validate.mjs,
postlive-discover.mjs. Publish chain verified live (23:00 MST commit, byte-match).

---

## VERDICT

**Is this dashboard now trustworthy and usable at a glance? Yes — for the
first time tonight, every rendered number is real, every sum is exact, and the
default view (Standings) answers the owner's actual question in one look.
The remaining defects are navigational and rhetorical: the banner speaks last
week's language, three "show me" links break their promise, and two insights
dress n≤6 arithmetic as conclusions.**

**Single change with most leverage:** rewrite the `pace-rank` fallback text
(H-1) to lead with Total views — it's the first sentence anyone reads, and it
currently disagrees with the card beside it. (Fixing the H-2 routing rule to
be unit-aware is a close second and a 3-line change.)

**Do NOT touch again:** the data layer — build-data.mjs unit discipline,
totalViews/◐ semantics, validate.mjs gates, and the Standings segment math.
That stack is exact, deterministic, reproducible, and byte-verified to the
live site. Every remaining fix lives in insight *text* and index.html *render*
logic. Any further "improvement" to the math pipeline is risk without payoff,
20 hours before the first unattended run.

— Critic, 2026-08-21 ~23:30 MST
