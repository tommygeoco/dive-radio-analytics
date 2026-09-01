# Health formulas audit — show health (health-v3) and episode health (health21-v2), 2026-09-01

Trigger (owner, 2026-09-01): "Right now it doesn't read very accurate — it's
actually kind of useless. We can't see health per show; it's flagging red but
we feel good about things. The gap between how we feel recently and how
things are trending versus projecting needs to surface automatically and
without error. Handle staleness, over-time versus recency, cool-off. This is a
live show."

Method: the repo's baseline-integrity audit (eleven failure classes), re-run
against the code at `c5ae054` and the stores as of the 2026-09-01 10:24 MST
refresh. Every number below was re-derived from `data.json`, the snapshot
store, the live-event archive, and today's saved entry
(`health-history.json` 2026-09-01: score 46, weighted mean 49.8). Nothing is
quoted from prose.

## 0. The answer

The v3 rules are honest about *ages* and *windows* (PRD v9 fixed that) and
still produce the wrong *conclusion* today, for five reasons that are all
structural, not bugs:

1. **The newest episode is a promo-driven outlier, and the formula scores its
   per-view rates anyway.** E7 is flagged on YouTube views (4,860 at day 5
   against a same-age typical of 1,600) and on X reach (13,285 against
   5,496). Flags keep E7 out of every *typical*, but the audience check reads
   E7's own engagement per thousand views (8.8 against 43.8) — a rate whose
   denominator is the promo-inflated view count. Score 10, "Fragile". The
   absolute count tells a different story: 38 likes and comments at day 3
   against E6's 28 and E1's 85.
2. **"Live turnout" averages two signals moving in opposite directions.**
   Peak 72 (typical 71; the best since E1) is averaged with chat messages 92
   (typical 167, down 45%); average concurrent viewers — 56, tied with E2
   for the best since E1 — are not measured at all. Chat has fallen on five
   of six steps — 383, 310, 169, 167, 100, 127, 92 — while viewers have
   recovered — average 42, 48, 46, 50, 56 since E3. One word,
   "Fragile", hides the half the owners feel.
3. **The score is a level against a "usual" that the show's first two
   episodes set, with no direction.** Every typical is a median of a window
   that E1 and E2 dominate (they were the largest launches until E7). A show
   recovering from its E3–E5 dip reads "below usual" for months even while
   improving three episodes in a row. Nothing in the entry says which way
   anything is moving, and nothing projects.
4. **Two checks read stale episodes with no visible discount.** Reach reads E6
   (twelve days old, announce-to-play 13% against 31.4%) because the rule
   demands a week of maturity; the click layer says "read from The Mascot
   Industrial Complex", the glance layer says "Fragile". Growth's first-week
   slope is three points wide with a three-episode gap in the middle
   (E1 1,830 → E2 1,751 → E6 1,189, E3–E5 excluded as partial history) and is
   scored as if those were consecutive episodes; at the 09-04 chain run, E7's
   promo-driven first week (≈5,000+) joins that series as "clean" and the
   slope flips from 0.8 to about 1.3 — the whole score will jump for a promo
   reason.
5. **No episode has a health score today, and E1–E4 never will.** The frozen
   21-day read needs three earlier comparable episodes; E1 has none, E2 one,
   E3 two, E4 two (E3 is excluded as an outlier). E5's read freezes at
   the 07:25 chain run on 09-04, E6's on 09-11, E7's on 09-18 (the store's
   `readCompleteOn` names the calendar day before each). For a seven-episode
   show, "health per show" is empty by construction.

None of this is a wrong number. All of it is a wrong reading: the diagnosis
is dominated by a diluted rate, a chat count, and a stale conversion, while
the things the owners felt — the fullest room since E1 and the biggest launch
ever — either are not measured (average concurrent, launch shape) or are
excluded from the read (the promo lift, correctly, but silently).

## 1. Findings — show health (health-v3)

### F1. Per-view rates of a flagged episode are scored against unflagged typicals (failure class 1, like-for-like, in its population form)

Evidence: `health.mjs` audience block reads `engagementPer1kOf(newestSnap)` for
the newest episode with no check on `flags.get(newest.slug)`; today's entry
stores `audienceQuality.measures.engagement = {value: 8.8, typical: 43.8,
score: 10}` while `baselines.anomaly[E7].units.ytViews = {tier 2, 4860 vs
1600, flag: true}`. The rule that keeps E7 out of typicals (rule 12) exists
because promo traffic is a different population; the same logic applies to
E7's own denominators. Absolute engagement at the same age is like-for-like
and is not diluted (E7 day 3: 38; E6: 28; E1: 85).

Fix: a measure whose own unit is flagged is *qualified* — value and typical
shown, score null, reason "promo-driven lift — shown, not scored"; rates on a
flagged denominator (engagement per thousand, subscribers per thousand,
announce-to-play on flagged reach) are qualified; the absolute count at the
same age becomes the scored measure for engagement.

### F2. Live turnout mixes viewers and chat into one word (class 11's cousin: unlike signals under one score)

Evidence: `livePull.measures = {peak: 72 vs 71 → 51, chat: 92 vs 167 → 28}`,
check score 40; average concurrent is not a v3 measure. From the event
archive, per episode E1…E7: average concurrent
65, 56, 42, 48, 46, 50, 56; peak 90, 71, 53, 63, 64, 71, 72; chatters 104, 55,
56, 55, 39, 41, 40; messages per minute 3.1, 2.6, 1.5, 1.3, 1.1, 1.3, 0.8;
chatters per 100 peak viewers 116, 77, 106, 87, 61, 58, 56. Turnout is
recovering; participation is falling. Two different decisions ("the format
is pulling people back" versus "the room is quieter — prompt the chat")
collapse into one "Fragile".

Fix: split into **turnout** (peak, average concurrent) and **participation**
(chatters per 100 peak viewers, messages per hour — both normalized so a
95-minute show and a 124-minute show compare).

### F3. Growth's first-week slope ignores gaps and admits promo weeks (class 2b, outlier feedback)

Evidence: `health.mjs` growth block takes `cleanWeeks = week1VelocityByEpisode
.filter(row => Number.isFinite(row.value))` — three rows today (E1, E2, E6)
— and fits a log-linear slope over `xs = [0, 1, 2]`, so a fall spread over
five episodes is scored as a fall over two. `build-data.mjs` sets
`week1Velocity` for every non-partial episode regardless of the outlier flag,
so at the 09-04 run E7's first week enters as clean. `showTrend` and the Slack
first-week line share the same filter.

Fix: a first week whose YouTube views are flagged is nulled with the note
"excluded: promo-driven outlier" (the number stays on the episode); the slope is the Theil–Sen median of pairwise slopes over
(episode number, log first week) for the last `TREND_N` clean weeks — gap-
aware, robust to one odd week — and needs `MIN_PEERS` points.

### F4. Reach reads the previous episode and the read's age is invisible at a glance (class 6, freshness)

Evidence: `reachOk` requires `ageOf(e) ≥ 7`, so `reachEfficiency.measures.*
.episodeRead = E6`, `readDate 2026-09-01` (the date the *file* was read, not
the age of the episode read); the strip shows "Fragile" for reach beside a
newest episode with 13,285 X impressions at day 5. Same-age exposure at day
5 is computable today (E1, E2, E6 have day-5 readings); same-age plays are
not (X plays exist only from 08-21, so E1/E2 have no early plays).

Fix: reach = **exposure** (X impressions at the same age, qualified when
flagged) + **announce-to-play** (same-age when three peers carry plays at
that age; otherwise the latest finished clean episode, stamped `carried` and
counted at half weight). Every carried measure is named at the click layer
and the check's `asOf` says which episode it reads.

### F5. No direction, no projection (the owner's gap)

Evidence: the entry has `subScores` (levels), `facts` (levels), a daily score
`trend` of eight points (51 → 46), and nothing about the direction of any
measure across episodes or where the next launch is expected to land. The
About copy calls the score "a today read". The owners' question — "how we
feel recently versus how things are trending versus projecting" — has no
field to be answered from.

Fix: a **direction** lens per durable measure (last `TREND_N = 5` clean
episodes, Theil–Sen percent per episode, quiet zone ±5%, words building /
holding / softening, `MIN_PEERS` points) and an **outlook**: the next first
week's expected range from the last three clean first weeks with the
direction word, and the newest episode's cool-off (its two-day growth at age
A against peers' at A: still building / cooling as usual / cooling faster).

### F6. Goodwill is an absolute 100 from six comments (class 4/11, thin absolute measure)

Evidence: `sentiment.measures.balance = {value: 100, sample: 0, absoluteScale:
true, score: 100}` from `recent-positive-feedback = 6`, `recent-feedback-
people = 6`; `commentRate` absent (one complete episode). Weight 0.15 stays
at base (rule 13 works), but the glance word is "Healthy" with nothing
saying it rests on six comments.

Fix: keep the rule; lower the base weight to 0.10; the participation check
carries the "people" signal with a typical.

### F7. Staleness is per check and invisible (class 6)

Evidence: growth and audience read E7 at 4.9 days; reach reads E6 at 11.9;
live reads E7's air night; goodwill spans E5–E7; subscribers and watching are
absent. Only the click layer says "read from …"; the glance layer shows one
number "today".

Fix: the entry stores `asOf` (the newest episode's slug and age, and the
list of carried checks); the strip says which episode the read is on; carried
measures count half.

### F8. Cool-off is not measured at all

Evidence: for a live show most views arrive on air night: E1 had 79% of its
day-21 views by day 3 and 91% by day 7; E6 90% of its day-10 views by day 7.
E7 is still gaining at day 5 (day 5 ÷ day 3 = 1.15 against E1's 1.08 and E6's
1.09) — a long promo tail. No measure reads the shape.

Fix: the outlook's cool-off measure above (absent until three peers carry
readings two days apart at the newest's age — from E8/E9 on with daily
snapshots).

### F9. The model's latitude and the headline rule turn a mixed read into two "fragile"s

Evidence: weighted mean 49.8, model score 46 (−3.8, "thin goodwill");
headline "engagement per viewer and reach off X both look fragile"; the
page's `checkState` renders "Fragile" for any check under 45 (audience 10,
reach 35, live 40) and prompt rule 9 permits the word there. Consequence of F1, F2, F4 rather than a defect of its own; kept on
record because the words are what the owners read.

## 2. Findings — episode health (health21-v2)

### F10. No score exists today and E1–E4 can never have one (class 4 at the show's scale)

Evidence: `episode-ratings.json`: E1 "first episode — it sets the baseline";
E2 "Fewer than three earlier episodes" (one peer); E3 (two); E4 (two — E3
excluded as a promo outlier); E5–E7 pending (09-04, 09-11, 09-18). The
window-before rule is the right definition of "beat its own bar" (D4) and is
the wrong *only* surface for "health per show" at seven episodes.

Fix: a **launch read** per episode from `baselines.mjs`: YouTube views at a
fixed age (day 7; day 21 or the earliest reading for late-tracked episodes;
the current age, provisional, for episodes under a week) against the other
episodes' readings at that age (either side, outliers out, `MIN_PEERS`),
rendered as a **word** on every card — strong / typical / soft launch, with a
"promo-driven" qualifier — never as a number. The frozen 21-day score stays
the permanent read. Today that gives all seven episodes a word: E1 strong
(+54%), E2 strong (+47%), E3 soft (−21% at day 21, X promo), E4 typical (−3%
at its earliest reading, day 14.4), E5 soft (−36%), E6 soft (−32%), E7
promo-driven (+204%, five days in).

### F11. A promo-driven target scores its own lift (queued)

Evidence: `scoreEpisode` excludes flagged *peers* but scores a flagged
*target* on its own views (E7 will freeze on 09-18 with watch ≈ 100).
The data critic (CRITIC-2026-09-01) separately found no render path for the
outlier condition.

Fix (queued, own commit — a frozen-store schema change): stamp the target's
own verdict (`promoDriven`) in new entries and render the qualifier word; the
launch read above carries the qualifier from today.

## 3. Cross-cutting

### F12. A formula bump restarts the daily trend

`projectHealth` plots only entries under the running formula; the eight-point
v3 line disappears for seven days after v4. The new direction lens does not
depend on saved entries (it reads episodes), so the reader still has an
over-time read from day one. Re-deriving past days' deterministic means under
v4 from the append-only stores is possible for the snapshot-based measures
and is left as a later workstream (analytics-file measures cannot be
time-travelled before 08-23).

### F13. The chain runs the model on the owner machine only

This machine has no model key, so the deterministic half (`--dry`), the
projection, the validator, and the page were exercised here; prompt v6 is
validated by the same grounding rules the validator applies to saved entries
and is first exercised live by the chain. A failed synthesis keeps the
previous entry (designed), and the alert fires from day 2.

## 4. The comparison contract for health-v4

See PRD v10 §3 (`prd-analytics-v10-three-lenses-2026-09-01.md`). Every
measure has one basis, a window, `MIN_PEERS`, a qualifier rule, and a carried
rule; direction and outlook have their own gates.

## 5. Cost of honesty (day-1 consequences, from the dry run)

See PRD v10 §0 (what today reads under v4) and §8 (day-1 consequences).

## 6. Audit record

Three fresh-context adversarial passes re-derived every number above from the
stores and refuted the design where it was weak (2026-09-01). Corrections
folded in here: average concurrent was not a v3 measure; chat fell on five of
six steps; E3 −21%, E4 −3% at day 14.4; participation is per hour; chain-run
dates. The design changes the passes forced are recorded in PRD v10 §10.
