# PRD — Dive Radio analytics v7: baselines, like-for-like comparison, freshness (2026-08-23)

**Owner:** Tommy · **Author:** Claude (Fable 5) from a code audit of `github.com/tommygeoco/dive-radio-analytics` at commit `96a4f2f` (2026-08-23), then three independent fresh-context audit passes (§10) · **Status:** PLANNED — nothing in this document is built.
**Supersedes:** the baseline / "typical" definitions in v4 §1–2 and the W10 section of v5. Everything else in v2–v6 stands.
**Trigger:** owner question 2026-08-23 — "are the averages calculated intelligently, or are we comparing against stale averages / sentiment?"
**Runtime truth:** `/Users/bones/Dev/2026/dive-radio-analytics` (the chain machine). A copy of this file lives at `tools/dive-analytics/` in the repo; `CLAUDE.md` and `ARCHITECTURE.md` there describe the system as it is today.

---

## 0. The answer to the owner question

**Are the averages stale?** No. Every "typical" is recomputed each morning from the freshly pulled stores. Nothing is cached.

**Are they calculated intelligently?** Not yet, in four specific ways:

1. **They compare episodes at different ages.** The daily show-health score takes the newest episode *as it stands today* — E6 was two days old in the saved 08-22 read — and compares its engagement, share watched, and subscribers-per-thousand with older episodes *as they stand today* (9–36 days old). Those rates change a lot in the first weeks, so the comparison says more about age than about the episode. The page's own engagement insight refuses to do this (it waits 7 days); the health score does not.
2. **"Typical" means "every episode ever".** As the catalog grows, a lifetime median stops describing the current show. The promo-outlier test is built on the same lifetime median and mixes two-day-old episodes with two-month-old ones, so it will mislabel ordinary episodes as the show grows — and a mislabeled episode is silently dropped from every other comparison.
3. **The per-episode health scores are not what they claim to be.** Each is meant to be a permanent, frozen read against the episodes before it. Only two of its six checks are actually pinned to day 21; three read whatever the earlier episodes' numbers happen to be on the day the freeze runs. Every score on the page today was built from one or two comparison episodes — the constitution's own small-sample rule says those should be suppressed. And the scores cannot be rebuilt later: the inputs were never stored.
4. **Caveats are stored but never shown.** The health store records "still under a week old, so this check may move" and "uses the latest finished episode"; the page drops those notes for any check that has a score. Nothing bounds or displays how old the served health read is — the header stamp tracks the data build, which succeeds even when the health step fails.

None of this produces a wrong *number* today. All of it produces wrong *conclusions* ("E3 was our worst episode", "growth is slipping", "that one was promo-driven") as soon as there is enough history to draw them. Fixing it is cheap now and expensive later: every day without an analytics history store is a day the honest comparisons can never recover.

**What it costs.** Honest comparisons need three earlier episodes measured the same way. At six episodes with thin tracking history, that means: the two episode scores on the page today disappear (they are one- and two-episode comparisons); the first real episode score lands around 09-04; the daily show-health score runs on three of its six checks for about ten days; and a brand-new episode's same-age checks are absent for its first few days until E9. Section 9 lists these as decisions.

---

## 1. Constitution

### 1a. Standing rules (v5 §1, unchanged — restated so this file stands alone)

1. Total views = YouTube views + X broadcast plays. X impressions (reach) are exposure and are NEVER summed into views.
2. Absence ≠ zero. Missing data says so in plain words; it never renders as 0 and is never estimated or interpolated.
3. Never fabricate history. No backfill, no extrapolation, no blended series where one unit lacks history.
4. Definition-lock: a metric definition change moves every surface (cards, hero, panel, table, Slack, validator) in one commit. Every surface reads the same store — no surface recomputes its own version of a number.
5. `node tools/dive-analytics/audit/validate.mjs` exits 0 before every publish. Publish verifies live parity post-deploy.
6. Plain words everywhere a human reads. Banned in glance/click layers: composite, percentile, pillar, ratio/×-multiples, velocity, coverage, basis, median (use "typical"), delta, cumulative.
7. Small-n honesty: claims from fewer than 3 clean samples are suppressed, not caveated.
8. Simplicity contract: ≤12 numbers above the fold; one question per surface; three layers (glance → click → About).
9. Frozen numbers never change within an algorithm version; version bumps re-derive ALL entries visibly (`rederivedFrom` stamped), never silently.
10. Zero runtime deps. Model calls only in explicitly-model scripts — never in `build-data.mjs`.

**Absence is silent** (v5 addendum, owner directive 2026-08-23): a missing metric renders nothing at the glance layer — no marks, no wait dates, no "sets the baseline" chips. This PRD keeps that at the glance layer and proposes that the *reason* render at the click layer (panel, drill-in) and in About — see rule 17 and decision D7, because that is an amendment to the directive.

### 1b. New rules (this PRD)

11. **Like for like.** Every comparison carries one of three bases, defined once in `baselines.mjs` and stamped on the stored measure as `ageBasis`:
    - `sameAge` — own value and every peer value are readings taken at the same age (days since premiere), chosen by the reading rule in §3.0.
    - `mature` — own value and every peer value are readings taken at or after that measure's maturity age: `MATURITY_DAYS.analytics = 21` for YouTube-analytics measures (share watched, subscribers per thousand, commenters per thousand, sentiment shares); `MATURITY_DAYS.xAnnounce = 7` for X-announce measures (announce→play, X share) with `partial===false && stale===false`.
    - `ageFree` — the measure does not move with age (live-night peak and chat; a day-7 or day-21 total read at that exact age).
    A comparison must also be like-for-like in **source coverage**: a YouTube-only comment set is never compared with a YouTube+X set. A comparison that cannot meet its basis is absent with a reason — never made anyway with a caveat.
12. **Windowed typical.** "Typical" = true median of the peers left after taking the `WINDOW_N` = 8 most recent episodes *before the own episode* in premiere order and then removing the own episode, promo-outlier episodes, peers that cannot meet the measure's basis, and peers with different source coverage. Lifetime medians are retired. The slugs used and the slugs excluded (with reasons) are stamped beside every stored typical.
13. **Minimum peers, per measure.** `MIN_PEERS` = 3, one exported constant. A measure with fewer than 3 usable peers is absent with a reason; its weight is shared by the remaining measures of its check, and a check with no measures shares its weight with the remaining checks. **Absolute-scale measures (today: sentiment balance) never receive redistributed weight**, so honest absences cannot inflate them.
14. **Reproducible freezes.** A frozen entry stores its inputs: per peer `{slug, value, atDay, source, readDate}` and the outlier verdicts it used (`excluded[]`). The validator recomputes every frozen score from those stored inputs, and recomputes the inputs from the history stores. Entries whose inputs predate the history store are stamped `reproducible: false` and exempt from the second check only.
15. **Freshness is visible, then withheld; data always publishes.** Wherever a model-written number's date differs from the data date, the page says so (D5). Per model store:

    | Store | >1 day | >2 days | >7 days |
    |---|---|---|---|
    | `health-history` | validator WARN | alert line | `projectHealth` withholds the score; the card shows its existing empty state |
    | `recommendations` | — | — | WARN; grounding always runs against the facts the store stamps, not today's sheet |
    | `moment-summaries` | tied to moments by hash; never expires | | |
    | `comments-classified` | per-run golden gate (unchanged) | | |

    Publish is never blocked by a stale model step. Every required *input* store is checked against the versioned chain definition (§4.5).
16. **One baseline per concept.** `baselines.mjs` is the only definition of: median, window, peer filter, outlier test, reading rule, quiet zone, band thresholds, `MIN_PEERS`, `WINDOW_N`, `SLOPE_N`. Scorers and build-data import it; the page, alerts, Slack, the recommendation fact sheet, and the critic bundle read its projection (`data.baselines`). The validator proves it by fixture equality, not by grep (§6 1t).
17. **Stored honesty reaches the click layer.** A reason or non-`sameAge` basis stored with a measure is written into the entry as a fixed plain-words `note` (§3.4) and rendered verbatim with that measure in the panel / drill-in — never at the glance layer. The validator checks the stored notes against the §3.4 table and the banned-word list, and checks that the page renders `note`.

---

## 2. Findings ledger

Verified against code at `96a4f2f` and re-verified by an independent fact-check pass (§10). Severity: **S1** = wrong conclusion today or on the next episode · **S2** = drifts into a wrong conclusion within ~10 episodes · **S3** = consistency / hygiene. "Fix" names the workstream (§5).

### 2a. Show health — `tools/dive-analytics/health.mjs` (formula health-v2)

| # | Sev | Finding | Evidence | Fix |
|---|-----|---------|----------|-----|
| F1 | S1 | **Unlike ages.** Engagement (L301–306), share watched (L307–314), subscriber rate (L392–405: `conversionEligible.at(-1)` is the newest, no age gate) compare `newest` at its current age with `episodes.slice(0,-1)` at theirs. Only reach (L323–344) waits for a finished episode. | Saved 08-22 entry: `engagement 28.5 vs 38.1` (E6 at 1.9 d vs priors 8.9–35.9 d), `subscribers 1.6 vs 3`, each carrying the reason "still under a week old, so this check may move" — and still weighted. `build-data.mjs:1012` gates its own engagement insight at ≥7 d "because likes and comments per 1,000 views change with age". | W21, W22 |
| F2 | S2 | **Lifetime baselines.** `trueMedian` over all prior non-outlier episodes (L302, 313, 353–355, 374–375, 405, 442). No trailing window. Only growth's first-week slope (`cleanWeeks.slice(-5)`, L262) and sentiment balance (`episodes.slice(-3)`, L424) are windowed. | — | W19 |
| F3 | S1 | **Stored caveats never render.** `index.html:852–854` renders `c.reason` only when a check has no score; the `audienceQuality`, `reachEfficiency`, `conversion` reasons in the saved entry never reach the page. `readState: "early"` (`health.mjs:633`) is read nowhere in `index.html`. | grep `readState` in index.html → 0 hits | W22 |
| F4 | S1 | **No freshness bound.** `projectHealth` (L612–621) serves the newest entry ≤ today at any age. The validator re-derives an entry from stores **only** when `latest.date === today && latest.formulaVersion === FORMULA_VERSION` (`validate.mjs:968–978`); older entries' typicals are accepted as-is. No check reads `store.updatedAt`. The page shows no saved date by owner directive (`index.html:822–824`), and `validate.mjs:1164–1166` fails if the two retired literals return; the header stamp (`index.html:2420–2423`) reads `DATA.generatedAt`, which regenerates even when the health step fails. | A 30-day-old entry would ship under a green "Data refreshed today". | W21, D5 |
| F5 | S3 | **Version handling is inverted.** `formulaVersion` is validated as a non-empty string (`validate.mjs:897`); the newest entry is never required to match the running formula; the ≥7-day trend (L959–963) plots mixed versions on one line. Meanwhile historical entries are asserted against *today's* `BASE_WEIGHTS` (L912), so a weight change breaks every old entry. | store entry 08-22 is `health-v1`; code is `health-v2` | W21 |
| F6 | S2 | **Unlike comment coverage.** X replies are collected only while `ageDays ≤ 8` (`comments-pull.mjs:26, 135`); E1–E5 are `xCoverage: "missed"`, E6 `"covered"`. From E7 on, sentiment pools YouTube-only peers with YouTube+X episodes. (Today's ratings sentiment checks are all YouTube-only, so the mixing has not started yet.) | `data/restream/comments/*.json` | W20, W21 |
| F8b | S2 | **Sentiment balance is on an absolute scale.** `health.mjs:431` scores balance as `clamp(balanceValue)` (85.7 % positive → 86), not "50 = typical", and it receives redistributed weight from absent checks. On 08-22 it was the largest single contributor. When honest absences remove other checks the weighted mean rises (53 → ~61 with only reach, live, sentiment) and reads as "the show improved". | entry 2026-08-22 `sentiment.balance.score 86` | W21 (rule 13) |
| F33 | S1 | **The append gate would stall the store under honest rules.** `health.mjs:701` keeps the previous entry when `availableChecks < 3 || availableBaseWeight < 0.5`. Under like-for-like bases today (E6 at 2.9 d; E3 an outlier; only E1/E2 mature) the available checks are reach + live + sentiment = 0.45 weight → no entry written until E5 matures (09-03), and again after every premiere. | — | W21 |

### 2b. Episode health — `tools/dive-analytics/ratings.mjs` (algorithm health21-v1)

| # | Sev | Finding | Evidence | Fix |
|---|-----|---------|----------|-----|
| F7 | S1 | **Three of six checks are not age-pinned.** `retentionOf` (L134–149) and `conversionOf` (L151–163) read the peer's *current* `yt-analytics/<slug>.json` — a file overwritten daily with lifetime-to-date totals (`yt-analytics-pull.mjs:96, 106`); `sentimentOf` (L167–175) reads the peer's current comment list. Watch and engagement use same-age snapshots; live is age-free. | E1–E3 share `frozenAt = 2026-08-23T01:52:10Z` (E1 at 36 d, E2 at 30 d, E3 at 23 d). E2's retention typical 10.55 is E1's *current* share watched; its conversion typical 8.9 is E1's current subscribers/1k. | W20 |
| F8 | S1 | **No minimum peer count.** `scoreEpisode` guards only `!peers.length` (L254). E2 (score 44): every check `sample: 1`. E3 (33): `sample: 2`. Rule 7 is violated by every score on the page. | `episode-ratings.json` | W20, D1a |
| F9 | S2 | **Freezes are not reproducible.** Entries store `typical` but not the per-peer values; a version bump "re-derives every score visibly" (v4 §1), and at that time the peers will have aged. | no `peers[]` in entries | W20 |
| F10 | S3 | **The validator's immutability check is tautological.** `validate.mjs:629–638` re-runs `computeRatings`, which returns the stored entry for any slug it already has (`ratings.mjs:291–296`). | — | W23 |
| F11 | S2 | **Outlier episodes are peers here, excluded in show health.** `ratings.mjs:298` takes every prior episode; `health.mjs:301` filters `!metrics.anomaly`. E3 (4,206 X plays, flagged) is a peer for E4–E12. | — | W20, D1b |
| F12 | S3 | The stamped `basis` string ("yt-views-at-own-read-age-vs-peer-values-at-theirs", L318) describes engagement only; watch compares peers at the *target's* age; the other three are not age-matched at all. | — | W20 |
| F34 | S2 | **Sentiment cannot meet rule 13 at current volumes.** Episode stores hold 2–8 comments each; `sentimentOf` needs 3 directional from 3 people; with `MIN_PEERS` and same-coverage peers, the episode sentiment check and the show-level commenters-per-thousand measure will be absent for the foreseeable future. The PRD must say what the owners see instead. | `data/restream/comments/*.json` | §3.2 note |

### 2c. Page, insights, alerts, Slack — `build-data.mjs`, `index.html`, `alerts.mjs`, `recommendations.mjs`

| # | Sev | Finding | Evidence | Fix |
|---|-----|---------|----------|-----|
| F13 | S2 | **The outlier test mixes ages and drifts with growth.** `build-data.mjs:280–299`: an episode is a promo outlier when a unit exceeds 2× the true median of *every* episode's lifetime-to-date `latest.*`, including itself. The median always contains one or two young episodes (weekly show), so mature episodes are over-flagged and young ones can never flag; under steady growth the test starts flagging ordinary mature episodes once they exceed twice the mid-catalog episode (≈4× catalog growth). Flagged episodes are dropped from host/announce/topic comparisons and from show-health priors — a silent feedback loop. The flag is recomputed every run, so the set of "comparable" episodes can flip after a score froze. Critic prompt v1.3 §4 codifies the lifetime rule. | — | W19b, W23 |
| F14 | S1 | **n=2 trend in Slack.** `build-data.mjs:1060`: "First-week YouTube views … trending up/down (sample of 2)" fires at `vels.length >= 2`; with exactly two clean first weeks today (1,830 → 1,751) it reads "trending down". The page suppresses the same claim below 3. | — | W22 |
| F15 | S1 | **Trend card compares unlike ages.** `index.html:1346–1350`: for `watched` and `reach`, "Climbing / Slipping on the newest episode" is newest vs previous on lifetime-to-date values — today reach E6 8,214 (2 d) vs E5 8,900 (9 d) ⇒ "Slipping". (`live` is age-free and correct.) The first-week verdict "Each launch is starting stronger" (L1378) is also a two-point comparison wearing trend words. | `CHART_METRICS` reads `watch.avgPercent`, `latest.xImpressions` | W22 |
| F16 | S2 | **Table "watched vs typical" baseline includes unfinished episodes and the row itself**, computed in the browser (`index.html:2202`, newest and self included); its quiet-zone form (L2222, `> 0.05`) is not the one the validator's regex checks (`validate.mjs:1024–1026`). | — | W22, W23 |
| F17 | S2 | **Window-relative scores read as a trajectory.** Carousel chips in air order (code comment: "the finished health scores ARE the trajectory of the show"); table Health column colored with the *show-health* bands 55/45 (`index.html:2204–2212`); Slack "07-23 44 → 07-30 33 → …" (`build-data.mjs:1074`). Each score is against a different set of earlier episodes; no copy says so. | About explains the window but not "different bars" | W20 |
| F18 | S3 | `sameAgePace` (`build-data.mjs:800`) uses the upper-middle element as the median; every other median in the repo is true. | — | W19b |
| F19 | S3 | **Three "typical" implementations** (`health.mjs`, `ratings.mjs`, `build-data.mjs`); `recommendations.mjs:113–145` re-sums channel totals and traffic mix from the analytics files instead of reading `data.json`. | — | W19, W22 |
| F20 | S3 | The ±5 % quiet zone is hard-coded at seven page sites (`index.html:690, 1162, 1348–1349, 1378, 2222, 2227`) and in validator regexes; band thresholds 55/45 and `deltaBadge` are each defined once but the validator checks none of their semantics. | — | W22, W23 |
| F27 | S3 | Show health's same-age pace (`health.mjs:271–279`) does not exclude promo-outlier episodes from its peers, unlike every other show-health measure. | — | W19b |
| F28 | S1 | **The recommendation engine is handed unlike-age rates and asked to compare them.** `recommendations.mjs:66–84` emits `watched-E1…E6`, `subs1k-E*`, `health-E*` with no age, window, or sample; the prompt (L195–197) asks "what the best episode did differently" and "which channel converts"; `validateItems` checks only that number tokens exist — "E6 converts twice E1" passes while E6 is two days old. | — | W22 |
| F29 | S2 | **Watching-chart typical line is a browser-side lifetime median** over every curve including the newest (two-day) episode and the curve being compared (`index.html:1976–1985`), no window, no outlier exclusion; `validate.mjs:1044` *requires* the page-source gate `curves.length >= 3`. | — | W19a, W22 |
| F30 | S2 | **Per-row table pace recomputes in the browser with later episodes as peers** (`index.html:753–781` `sameAgeSub`, upper-middle median); `validate.mjs:1020` requires its page-source gate. A second definition of pace (rule 16). | — | W19a, W22 |
| F31 | S2 | **Alerts fire on window changes and n<3.** `alerts.mjs:79–83` "moved up/down to #N of M on same-age pace" fires when M grows as peers start spanning the age (no real change); L106 "#rank of N clean first weeks" fires at N = 1–2; L88's complaint spike compares `complaintCount`, which also moves when a review label resolves or the classifier version changes. | — | W22 |
| F32 | S3 | **Recommendations grounding runs against today's fact sheet** (`validate.mjs:822` calls `collectFacts()` live) although the store stamps `factsGeneratedAt`; a skipped model run ("safe to skip") fails publish as soon as a cited rate moves. | — | W21 |

### 2d. Pipeline

| # | Sev | Finding | Evidence | Fix |
|---|-----|---------|----------|-----|
| F21 | S2 | **No analytics history.** `yt-analytics-pull.mjs` overwrites each file with lifetime-to-date totals (`startDate: show.date, endDate: today` in UTC). Nothing can be age-pinned for share watched, subscribers, or traffic until a daily reading is kept. YouTube Analytics also reports 2–3 days late, in the channel's time zone. | all six files `updatedAt = 2026-08-22T22:00:46Z` | W19a |
| F22 | S3 | **The capture chain is not versioned.** README L55 documents `ratings → … → publish`; the pulls that feed it appear in no ordered definition; no crontab/launchd/plist is in the repo; no validator check compares any store's `updatedAt` to `data.generatedAt`. Store timestamps from 08-22 are build-session runs; the steady-state 07:25 chain has not yet been observed in the stores. | — | W21 |
| F23 | S3 | `playsHighWater` / `playsStatus` live in the mutable registry (`postlive-track.mjs:463–494`), not in the snapshot; re-reading an old snapshot yields today's staleness verdict. Harmless while X plays are excluded from scoring; blocks rule 14 the day they enter. | — | note in W20 |
| F24 | S3 | Snapshots stop 60 days after premiere (`TRACK_WINDOW_DAYS`, L37). `latest.*` for old episodes freezes at day 60 while younger ones keep moving. Acceptable (flatline ≈ week 3); must be stated where `latest.*` feeds a baseline, and the freshness check must not expect updates past 60 d. | no episode is 60 d old yet | About copy; W21 |
| F26 | S1 | **Publish pushes without pulling.** `postlive-publish.sh:18–24`: `git add -A && git commit && git push origin main` under `set -eu`, no fetch/rebase. Any commit to `origin/main` from another machine makes the next morning's push non-fast-forward; the script aborts before `vercel deploy` — no publish that day, silently. | — | W21 |

### 2e. Incidental (not comparison-related; visible)

| # | Sev | Finding |
|---|-----|---------|
| F25 | S1 | `index.html:2199` builds the non-live table header with a **double-quoted** string, so `${PLOGO.yt}` / `${PLOGO.x}` render as literal text in four header cells. Fix in the W22 commit. |

---

## 3. The comparison contract

### 3.0 Shared definitions (all in `baselines.mjs`)

- **Constants:** `WINDOW_N = 8`, `MIN_PEERS = 3`, `SLOPE_N = 5`, `QUIET_ZONE_PCT = 5`, `BANDS = {healthy: 55, steady: 45}`, `MATURITY_DAYS = {analytics: 21, xAnnounce: 7}`, `READ_DAYS = 21`, `OUTLIER_MULTIPLE = 2`.
- **Reading rule.** `readingAt(series, A, tol)` returns the reading whose age is nearest `A` within `±tol` — snapshots `tol = 0.5` on `ts − premiere`; history lines `tol = 1.5` on `pulledAt − premiere` (the wider tolerance absorbs YouTube's reporting jitter); ties → the earlier; none → absent. Every same-age comparison, in every script and in the validator, calls this one function.
- **Window.** `windowFor(own, episodes)` = the `WINDOW_N` most recent episodes *before* `own` in premiere order. For show health "own" is the episode the measure reads (§3.1), so the window always trails the episode actually being compared.
- **Peer filter.** `peersFor(measure, own, episodes, flags)` = `windowFor` minus flagged episodes minus episodes that cannot meet the measure's basis (rule 11) minus episodes with different source coverage for comment measures. Returns `{peers, excluded: [{slug, why}]}`; `peers.length < MIN_PEERS` ⇒ `{typical: null, reason}`.
- **Outlier test — same-age, two tiers, evaluated before any typical.** `anomalyFlags(episodes)` runs once per build in premiere order, per unit (YouTube views, X plays with `partial===false && stale===false`, X reach):
  - *Tier 1 (settled):* an episode ≥ `READ_DAYS` old is flagged when `readingAt(snapshots, READ_DAYS)` exceeds `OUTLIER_MULTIPLE ×` the true median of the same-age readings of the `WINDOW_N` nearest other episodes (either side in premiere order, unflagged-so-far) — requires `MIN_PEERS`.
  - *Tier 2 (provisional):* when tier 1 cannot run (fewer than `MIN_PEERS` peers with a day-21 reading, or the episode is younger than 21 d), the test uses the episode's current age against peers' readings at that age; fewer than `MIN_PEERS` ⇒ the test is off. A tier-2 flag is stamped `provisional: true`.
  - Flags feed every other typical in the same build. Frozen entries (episode health) store the verdicts they used in `excluded[]` and never re-evaluate them. Today: E3 is flagged under tier 2 (4,206 X plays vs E1/E2 at the same age) and stays flagged when tier 1 takes over on 08-27 (E4's day 21). The slugs used are stamped in `baselines.json.anomaly.<unit>.windowBySlug`.
- **Typical** = true median of the peers' values. **Score** = `round(clamp(50 × own / typical, 0, 100))` (unchanged).
- **Precision.** Values stored at source precision (1 dp for rates and percentages, integers for counts); typicals 1 dp; ratios 3 dp. Re-derive passes when |Δ| ≤ 0.05 for 1-dp values and exact for integers and scores.

### 3.1 Show health — `health.mjs`, formula **health-v3**, prompt v3

Principle: each measure reads **the latest episode that can meet the measure's basis** — not the newest episode by default — and stamps which episode it read (`episodeRead`).

| Check | Measure | Own value (`episodeRead`) | Peers | Basis | Newest too young |
|---|---|---|---|---|---|
| growth 25% | first-week slope | log-linear slope over the last `SLOPE_N` clean first weeks (unchanged) | — | ageFree (day-7 total) | unchanged |
| growth | same-age pace | newest's YouTube views at its age A (snapshot) | `readingAt(snapshots, A)` per peer; flagged episodes excluded (F27) | sameAge | present from the first day ≥`MIN_PEERS` peers cover A |
| audience quality 20% | engagement per 1k | newest at age A from its snapshot (`engagementAt`, machinery in `ratings.mjs:126–131`) | peers' snapshots at A | sameAge; A capped at 21 | same as pace |
| audience quality | share watched | latest episode ≥7 d (YouTube's lag makes younger readings near-empty): history line at its age A | peers' history lines at A | sameAge (history) — transition: `mature` | newest <7 d → latest finished episode, named in the note |
| reach 15% | announce→play, X share | latest episode ≥7 d with `partial===false && stale===false` (unchanged) | peers meeting the same gate | mature (7, X) | unchanged |
| live pull 15% | peak, chat | newest live session | peers' live sessions | ageFree | unchanged |
| conversion 10% | subscribers per 1k | latest episode ≥7 d: history line at A | peers' history lines at A | sameAge (history) — transition: `mature` | newest <7 d → latest finished |
| sentiment 15% | balance | last 3 episodes' directional feedback, restricted to sources all three have coverage for; absolute scale, **no redistributed weight** (rule 13); gains a typical (window median of prior episodes' balances) once `MIN_PEERS` prior episodes have one | — / peers' balances | — / mature (21) | unchanged |
| sentiment | commenters per 1k | latest episode with complete replies | peers with complete replies, same coverage | mature (21) | unchanged — expected absent for months (F34) |

**Append gate (F33).** health-v3 writes an entry whenever `availableChecks ≥ 3`; the 0.5-weight gate is removed (absent checks already relinquish weight and render as "Not in yet"; a three-check read with three honest absences is more useful than a stale six-check read). The entry records `checkSet` (the keys that scored). **Check-set guard:** when `checkSet` differs from the previous entry's and the score moves by more than 5, the model's `drivers` must name the check that joined or left (prompt v3 rule) — the validator WARNs otherwise.

**Transition rule (history store has no depth).** Share watched and subscribers per 1k have no same-age peer readings for E1–E6 and never will (rule 3). Until ≥`MIN_PEERS` peers carry a history line within tolerance of A, these two measures run on `mature`: own = latest episode ≥21 d, peers = episodes ≥21 d, both from the current analytics file, stamped `ageBasis: "mature"`, `readDate`. **Once an entry's measure has been `sameAge`, later entries never fall back to `mature`**: if `sameAge` cannot be formed that day the measure is absent with the reason in §3.4. Expected: history accrues from the day W19a ships; `sameAge` becomes possible for these two measures around E10.

**Same-age availability today** (snapshot coverage as of 08-23): E1 and E2 have daily snapshots from day 3.0 / 4.0; E3–E6 were first snapshotted 2026-08-20 21:53 Phoenix (ages 21.4 / 14.4 / 7.4 / 0.4). So for E6 three peers cover an age A only from A ≈ 7.4 d; for E7 (peers E6 0.4, E1 3.0, E2 4.0) from ≈4 d; for E8 from ≈3 d; from E9 on, from day 1.

**Day-1 consequence (D1c).** On the first health-v3 run the available checks are reach, live, and sentiment (growth: fewer than 3 clean weeks until 08-27; audience quality and conversion: E6 too young for same-age and only E1/E2 mature until E5 reaches 21 d on 09-03). The score is written from those three, the diagnosis shows three "Not in yet", and the headline must say so (prompt v3 rule 9 extended: name the absent checks in `drivers`).

**Trend line.** `projectHealth` plots only entries whose `formulaVersion` equals the running formula (F5); the ≥7-point gate counts those entries only.

### 3.2 Episode health — `ratings.mjs`, algorithm **health21-v2**

| Check | Own value | Peer value | Basis | Change from v1 |
|---|---|---|---|---|
| watch 35% | YouTube views at `readingAt(snapshots, READ_DAYS)` (or the earliest real snapshot if first tracked later) | `readingAt(peer.snapshots, ownReadAge)` | sameAge | reading rule replaces `snapAt`/`peerCovers` |
| engagement 15% | per 1k at own read age | peers at their own read age | sameAge | none |
| retention 15% | share watched from the history line at own day 21 | peers' history lines at **their** day 21 | sameAge — transition: `mature` | was: current file on freeze day |
| live 15% | peak, chat | peers' | ageFree | none |
| conversion 10% | subscribers per 1k from the history line at own day 21 | peers' at their day 21 | sameAge — transition: `mature` | was: current file on freeze day |
| sentiment 10% | positive share of directional feedback from comments with `publishedAt ≤ premiere + 21 d`, restricted to sources every window member has coverage for | peers' same | mature (21) | was: all comments to date, mixed coverage. Expected absent at current volumes (F34); the check drops out and its weight redistributes — the feedback counts and themes stay visible in the panel's feedback tile |

Plus: peers = `peersFor(measure, target, episodes)` — `WINDOW_N` before the target, outlier flags **as evaluated at freeze time** and stored (never recomputed), `MIN_PEERS` per check (rule 13), `MIN_WEIGHT` 0.5 unchanged. Each check stores `peers: [{slug, value, atDay, source, readDate}]`, `ageBasis`, `note`; the entry stores `excluded: [{slug, why}]`, `frozenAtDay`, `reproducible`; the `basis` string is removed. The freeze runs on the first 07:25 chain run whose last snapshot age is ≥ `READ_DAYS` — in practice the day after `readCompleteOn` — and stamps `frozenAtDay`.

**Transition rule.** Peers without a history line at their day 21 (every peer until ~E10) are read on `mature` from the current analytics file (peer ≥21 d) with `readDate`; the note reads "compared with earlier episodes as they stand now, not at the same age". Entries frozen with any `mature` input before that slug's first history line are stamped `reproducible: false` (rule 14). W20's re-derive must run after W19a has appended at least one history line for every mature episode — i.e., the day after W19a ships.

**Visible consequence on day 1 (D1a, D1b).** Re-derive health21-v1 → v2: E1 unchanged (sets the bar). **E2 (1 peer) and E3 (2 peers) lose their scores**; chips show nothing (absence is silent); the panel's episode-health tile reads "Fewer than three earlier episodes to compare with." E4 (read completes 08-27, freeze 08-28): with E3 excluded as an outlier (D1b) its usable peers are E1 and E2 → every check absent → no score; if the owner keeps outliers as peers, E4 scores on E1–E3. **E5 (read completes 09-03, freeze 09-04) is expected to be the first scored episode** under D1b (peers E1, E2, E4 all cover age 21; sentiment absent). This must be confirmed by `node tools/dive-analytics/ratings.mjs --dry` against the real stores before D1 is decided.

### 3.3 Page, insights, alerts, Slack

- **Outlier test:** §3.0; the insight caveat ("promo outliers left out"), About, and critic prompt §4 change in the same commit as the switch (rule 4).
- **Same-age pace:** true median via `baselines.mjs` (F18); per-episode pace (for the table and panel rows) is exported by build-data as `episode.pace` — peers are the other episodes at the same age, outliers excluded — so `sameAgeSub` leaves the browser (F30).
- **Typical watch curve:** exported as `data.baselines.typicalCurve` — per-point true median over curves of episodes ≥21 d, outliers excluded, the compared episode excluded — drawn only with ≥`MIN_PEERS` curves; the browser computation is removed (F29).
- **Trend card:** `watched` and `reach` verdicts compare the newest and previous episodes at the same age (history line / snapshot via `readingAt`) or show "Too young to compare with the episode before it at the same age."; `live` unchanged. Two-point verdicts lose trend words: "The newest first week beat the one before by 12 %" / "came in 8 % under"; "Each launch is starting stronger" requires a three-point monotone run (F15).
- **Table watched-vs-typical:** baseline = `data.baselines.watchPct` (mature episodes only, row excluded); the page reads `QUIET_ZONE_PCT` and `BANDS` from `DATA.baselines.constants` (F16, F20).
- **Slack and alerts:** `slackTrends` and `alerts.mjs` are built from exported `trendsLines(data)` / `alertLines(data, state)` returning `[{text, sample, direction}]`; any line with a direction needs `sample ≥ MIN_PEERS` (F14); the pace-rank alert fires only when `of` is unchanged and ≥`MIN_PEERS`; the first-week-rank alert needs ≥`MIN_PEERS` clean weeks; the complaint spike counts new comment ids, not label totals (F31); finished episodes without a score are **omitted** from the episode-health sequence.
- **Episode-health sequence** (chips, table, Slack): the table column uses a neutral single colour, not the show-health bands; lead copy "each against the episodes before it"; About gains: "Two episodes' scores were measured against different earlier episodes, so a higher score means it beat its own bar by more — not that it was the better episode." No trend word over the sequence (validator 1y).
- **Recommendation fact sheet (F28):** every per-episode rate fact carries `ageDays` and `ageBasis`; rate facts are emitted only for mature episodes, plus same-age pairs from `baselines.mjs` where they exist; the prompt forbids comparing facts of different bases; `validateItems` rejects an item that cites two episode-rate facts with different bases. Channel totals and traffic mix are read from `data.channelTotals` / `data.trafficMix` projected by build-data (F19).
- **Health card drill-in:** renders each measure's stored `note` verbatim (rule 17).

### 3.4 Notes — the fixed reader-facing strings written into entries

Written by the scorers into `measure.note` (show health) / `check.note` (episode health); the page renders them verbatim at the click layer only.

| Stored state | `note` |
|---|---|
| `ageBasis: sameAge` | "compared at the same age" |
| `ageBasis: mature` | "compared with earlier episodes as they stand now, not at the same age" |
| `ageBasis: ageFree` | (no note) |
| entry written before health-v3 | (no note; `projectHealth` emits null) |
| fewer than `MIN_PEERS` usable peers | "Fewer than three earlier episodes to compare with." |
| same-age peers missing at a young age | "Only N earlier episodes were tracked this early; at least three are needed." |
| `episodeRead` ≠ newest | "read from <short title>, the latest finished episode" |
| `sameAge` could not be formed after having been formed | "Fewer than three earlier episodes have a reading at this age." |

All pass rule 6. The validator checks stored notes against this table and the banned-word list (1z).

---

## 4. Stores and schemas

### 4.1 `baselines.mjs` + `data/restream/baselines.json`
`baselines.mjs` exports pure functions (`readingAt`, `windowFor`, `anomalyFlags`, `peersFor`, `typicalOf`, `typicalCurve`) and the constants. No chain step of its own: `build-data.mjs` calls it after `latest` is built, attaches `metrics.anomaly` from `anomalyFlags`, writes `data/restream/baselines.json` as a side output, and projects it as `data.baselines` (`{constants, anomaly, typicalCurve, <concept>: {typical, window: [slug], n, ageBasis, excluded: [{slug, why}]}}`). `ratings.mjs` and `health.mjs` import the same functions. Rebuild-currency (validator 7) therefore covers it.

### 4.2 `data/restream/yt-analytics-history/<slug>.jsonl` (append-only)
`yt-analytics-pull.mjs` appends one line per episode per Phoenix day **after** a pull in which every authorized channel succeeded; skipped when a line for that `date` exists; never rewritten. Line: `{date: phoenixDate(pulledAt), pulledAt, endDate, ageDays: round1((pulledAt − premiereMs) / DAY), channels: {key: {views, averageViewPercentage, averageViewDuration, estimatedMinutesWatched, subscribersGained, likes, comments}}}`. No backfill (rule 3). Same-age readings are selected on `pulledAt − premiere` with `tol = 1.5` (§3.0); because YouTube Analytics reports 2–3 days late for every episode alike, a "day-21 line" holds data through ≈day 18 for all of them — like-for-like holds; About says "as the numbers stood about three weeks in". A YouTube restatement shows up as the next day's line.

### 4.3 `health-history.json` → `HEALTH_STORE_VERSION = 2`
`loadStore` and `projectHealth` accept root `version` 1 or 2; on the first v3 write the root becomes `version: 2` with every existing entry byte-identical (the append-only guard is entry-level). Entry shape is detected by the presence of `measures.*.ageBasis`; for old entries `projectHealth` emits `ageBasis: null, window: null, episodeRead: null, note: null`. New entries add per measure `ageBasis`, `window`, `excluded`, `episodeRead`, `readDate`, `note`, and per entry `checkSet`. `WEIGHTS_BY_FORMULA = {"health-v1": …, "health-v2": …, "health-v3": …}` is exported and the validator asserts each entry's `baseWeight` against **its own** stamped formula (F5).

### 4.4 `episode-ratings.json` → `version: 4`, `algorithm: "health21-v2"`
`rederivedFrom: "health21-v1"` / `rederivedAt` are stamped automatically by the existing code (`ratings.mjs:331–333`). `windowIds` = `windowFor` candidates + self (replacing the 9-prior rule; `WINDOW_MAX` deleted); per check `peers[]`, `ageBasis`, `note`; entry-level `excluded`, `frozenAtDay`, `reproducible`. Validator 1g edits: `"health21-v2"` stamp, `windowIds` from `WINDOW_N`, `readDays` unchanged. (F23 note: when X plays enter scoring, the staleness verdict must be copied into the snapshot first.)

### 4.5 `tools/dive-analytics/chain.json` (versioned)
`[{step, script, writes: [glob], freshnessKey: "updatedAt" | "snapshots[-1].ts" | "entries[-1].date" | "lines[-1].date", required: bool, scope: "episodes-within-60d" | "active-episodes" | "all"}, …]` in run order, plus `"cron": "25 7 * * * America/Phoenix"`. The freshness block (1v) reads it: WARN for any store behind `data.generatedAt` by >26 h; FAIL only for `required` stores in scope (`postlive/*` within their 60-day window, `yt-analytics/*` and the history jsonl for active episodes). Model stores follow rule 15's table. `postlive-publish.sh` gains `git pull --rebase --quiet origin main || { echo "publish: remote moved — not publishing"; exit 1; }` before the commit (F26), so a moved remote fails loudly instead of silently.

### 4.6 `recommendations.json`
The store keeps the facts it was grounded on (`facts[]` or their hash plus the sheet); validator 1n grounds against those, not against today's `collectFacts()` (F32).

---

## 5. Workstreams (numbered after W18, which is in use)

| WS | Scope | Commit boundary (rule 4) | Visible change |
|---|---|---|---|
| **W19a** | `baselines.mjs` + constants; `yt-analytics-history` append; `data.baselines` projection incl. `typicalCurve` and `episode.pace`; validator 1t (fixture equality) and 1u on, **with no consumer switched** and the page untouched | one commit | none — history starts accruing. **Ship this week.** |
| **W19b** | Outlier test (two-tier, same-age), same-age pace, and show-health peer filters switched to `baselines.mjs`; insight caveat, About, critic prompt §4 sentence updated together | one commit | pace typical may shift by the median fix; E3 stays flagged |
| **W20** | `ratings.mjs` health21-v2 (§3.2); visible re-derive; D1a/D1b; episode-health copy on every surface (Slack sequence, About, panel tile incl. notes, table colour, chip) in the same commit (F17); validator 1g edits and the real immutability check (1w). Runs the day after W19a. | one commit | E2/E3 scores disappear; panel tile shows the reason; table column recoloured; About sentence |
| **W21** | `health.mjs` health-v3 (§3.1: bases, gate, balance weight rule, check-set guard, notes), prompt v3, store v2 (§4.3); `projectHealth` withhold rule and version-filtered trend; `chain.json`; validator 1v; `postlive-publish.sh` pull-before-push; alerts line "health read is N days old"; 1n grounding against stamped facts (F32) | one commit | drill-in shows notes; diagnosis shows three "Not in yet" for ~10 days |
| **W22** | Page honesty: rule-17 drill-in renders `note` (F3); trend-card same-age and wording (F15); table baseline and page constants from `DATA.baselines` (F16, F20); typical curve and pace from data (F29, F30) with 1j regexes rewritten; `trendsLines` / `alertLines` + n≥3 (F14, F31); header stamp per D5; About copy for windows, ages, the 60-day cutoff, the analytics lag; recommendation facts with `ageBasis` + channel totals from data (F28, F19); F25 header fix | one commit | header stamp when health is behind; trend verdict wording; table header fixed |
| **W23** | Validator 1x, 1y, 1z; critic harvest adds `data.baselines`, per-entry `peers[]`, the history lines behind the newest health entry, `health.ageDays`; critic prompt v1.4 (age-basis and window lenses; lifetime-outlier sentence replaced; "re-derive a typical only from its stamped window"; the saved-date sentence follows D5) | one commit | none |

Order: W19a → W19b → W20 → W21 → W22 → W23. Critic run after W19b, W20, W22, W23; findings triaged in the CRITIC file.

---

## 6. Validator contracts (new blocks; names chosen to avoid the existing 1b–1r)

- **1s Like-for-like:** every stored measure with a typical carries `ageBasis ∈ {sameAge, mature, ageFree}`; for `sameAge`, every `peers[].atDay` is within the reading tolerance of own `atDay`; for `mature`, own and every peer ≥ that measure's `MATURITY_DAYS` at `readDate`; source coverage identical across the set. Thresholds imported from `baselines.mjs`, not re-typed.
- **1t Single source, by equality:** a fixture test (`audit/baselines.test.mjs`) runs `health.computeHealthInputs`, `ratings.scoreEpisode`, and `build-data.computeAll` over the fixture and asserts every typical, flag, pace, and quiet-zone/band decision equals `baselines.mjs`'s own output; plus an import check that no script other than `baselines.mjs` defines a median. The page cannot import (rule 10), so 1j's three literal regexes (`pct <= 5`, `peers.length < 3`, `curves.length >= 3`) are replaced by assertions that the page reads `DATA.baselines.constants` and `DATA.baselines.typicalCurve` / `episode.pace` and contains no arithmetic median.
- **1u Windowed typical:** every stored typical in today's build re-derives as the true median of its stamped `window` values read from stores; `n ≥ MIN_PEERS`; window ⊆ `windowFor`; no flagged slug, no self; today's flags re-derive from `anomalyFlags`. Frozen entries are checked against their **stamped** `excluded[]`, never today's flags.
- **1v Freshness:** `healthStore.latest.date` vs `phxDate(data.generatedAt)`: >1 WARN; >7 ⇒ `data.health` must be the withheld form; `latest.formulaVersion !== FORMULA_VERSION` ⇒ WARN; `checkSet` change + |Δscore| > 5 without a naming driver ⇒ WARN; every `chain.json` store checked per §4.5; `data.health.trend` contains only running-formula entries.
- **1w Reproducible freeze:** every `episode-ratings.json` entry recomputes to the same score from its own `peers[]`; every `peers[].value` with `reproducible !== false` recomputes from the history store / snapshots at the stamped `atDay` / `readDate` within §3.0 precision. Replaces the tautological re-run (F10).
- **1x n≥3 on data:** every element of `trendsLines(data)` and `alertLines(data, state)` with a direction has `sample ≥ MIN_PEERS`; every recommendation item citing two episode-rate facts cites one basis.
- **1y No cross-window trend language:** the episode-health sequence line, table column, carousel, and About sentence contain none of: trending, improving, declining, climbing, slipping, best, worst, getting, trajectory.
- **1z Stored honesty renders:** every `note` in the newest health entry and in every ratings entry is one of the §3.4 strings (parameterised) and passes the banned-word scan; the page templates for the drill-in and the panel tile reference `note` (source check) and contain no other reason/basis prose.
- **1h edit:** historical entries' `baseWeight` asserted against `WEIGHTS_BY_FORMULA[entry.formulaVersion]`.

---

## 7. Residual drift risks after v7 (accepted, monitored)

| Risk | Guard |
|---|---|
| Model synthesis bias — the score shaded one way day after day | critic lens: sign of `score − weightedMean` over the last 14 entries; WARN if ≥12 share a sign |
| Classifier drift across versions | already: version stamp + golden set; add: balance computed only over comments labeled under the current classifier version, or the note says "labels from two versions" |
| YouTube restating analytics retroactively | history lines are never rewritten; re-derive compares against the stored line |
| X plays backfilled late | reach and the outlier test gated on `partial===false && stale===false`; the staleness verdict is copied into the snapshot when X plays enter scoring (F23) |
| A young episode's promo spike under-detected until tier 1 | accepted; tier 2 catches large spikes at the same age; flags are provisional until day 21 |
| Show outgrows the window's memory | by design; About says "typical = the last eight comparable episodes" |
| Late-registered episodes thin the same-age peer pool | excluded per measure with a counted reason |
| Sentiment checks absent at current comment volumes | accepted and stated; feedback counts and themes remain visible; revisit when episodes average ≥10 directional comments |
| Chain runs out of order / a step skipped / remote moved | 1v catches stale required stores; publish fails loudly on a moved remote; `chain.json` is the one definition |
| A week-long model outage | score withheld (existing empty state), data still publishes, alert fires daily (D3) |

---

## 8. Verification

- **Fixture test** (`audit/baselines.test.mjs`): 12 synthetic episodes with one promo outlier, one late-registered episode, one missing analytics file, one missed pull day, and a 2× growth trend — asserts window membership, per-measure exclusions, `MIN_PEERS` absence, reading-rule tie-breaks, tier-1/tier-2 outlier behaviour (only the promo episode flagged under growth), that every typical re-derives from its stamped window, and that every consumer's numbers equal `baselines.mjs`'s (1t).
- **Dry runs before D1:** `ratings.mjs --dry` under health21-v2 on the real stores (confirms the first scored episode and date under D1b yes/no); `health.mjs --dry` under health-v3 (confirms which measures are `sameAge` / `mature` / absent today and that an entry is written).
- **Re-derive:** `validate.mjs` 1s–1z exit 0 after each workstream.
- **Day-1 screenshot review** after W20 and W22: notes per §3.4 in the drill-in and panel tile; E2/E3 chips show nothing; table header fixed; About sentences present; numbers above the fold counted (≤12; the header stamp adds no digit).
- **Babysat 07:25 runs** after W19a and W21; critic run after W19b, W20, W22, W23.
- **Two-week check** (≈2026-09-06): newest health entry has `sameAge` engagement; history store has ≥14 lines per active episode; E5's score landed on 09-04 with `peers[]` stamped; no `mature` → `sameAge` → `mature` flip in any measure.

---

## 9. Owner decisions (one sentence each, with the visible consequence)

- **D1a — Minimum of three comparison episodes.** Apply rule 7 to episode health: E2 and E3 lose their scores today (chips empty; the panel says "Fewer than three earlier episodes to compare with"); the first score is expected on 09-04 (E5). *Recommended: yes — every score on the page today is built from one or two episodes.*
- **D1b — Promo outliers are not comparison episodes.** E3 stops counting as a peer in episode health (it already doesn't in show health); E4 therefore gets no score either (E1 and E2 are its only usable peers). *Recommended: yes — one definition of "comparable" for both scorers.*
- **D1c — Same-age checks are absent rather than mis-aged.** For about ten days the show-health score runs on reach, live, and sentiment with three checks shown as "Not in yet"; a new episode's engagement and pace checks stay absent until three earlier episodes were tracked at that age (≈7 days for E6, ≈4 for E7, ≈3 for E8, day 1 from E9). *Recommended: yes — the alternative is the current unlike-age comparison.*
- **D2 — Typical = the last eight comparable episodes**, for both scorers and the page (replacing "all prior" and "up to nine prior"). *Recommended: 8.*
- **D3 — A health read older than seven days is withheld, not published as today's.** The card shows its existing "not available yet" state; data still publishes; the alert fires daily from day 2. *Recommended: yes — never block data publishing for a model outage.*
- **D4 — Episode health stays "each against the episodes before it."** It is the only definition under which "a finished score never changes" is true; the standings chart and `episode.pace` give the same-age cross-episode view. *Recommended: keep.*
- **D5 — Where the page says the health read is behind.** (a) The header stamp reads "Data refreshed today · health read is behind" when the dates differ (exact date in the hover title, so no digit is added above the fold), or (b) only inside "Why this score". *Recommended: (a) — the 08-23 directive's premise ("the header stamp already says when the data last refreshed") is true for data but not for the health read.*
- **D7 — Reasons at the click layer.** The 08-23 "absence is silent" directive stays for chips, cards, and the hero; the *reason* for an absent score or check renders in the panel tile and the health drill-in, and About carries the methodology. *Recommended: yes — silence at a glance, honesty on click.*

---

## 10. Audit record

Three fresh-context passes ran against the draft before this version (2026-08-23). What each changed:

1. **Fact-check** (every F# opened at the cited lines): 19 confirmed, 5 partial, 1 overstated. F13's growth arithmetic corrected (≈4×, not 2×; young episodes under- not over-flagged); §0's "four checks" → three (live is age-free); snapshot-coverage ages (21.4 / 14.4 / 7.4 / 0.4) and per-episode same-age availability; F6's gate (`ageDays ≤ 8`) and timing (mixing starts at E7); F12's strict reading; F20's scope (only the quiet zone is duplicated); F27 added (pace peers not outlier-filtered); first scored episode E5, not E4; line references refreshed to `96a4f2f`.
2. **Implementability** (25 findings, 10 HIGH): one `ageBasis` enum with per-measure maturity (was three definitions); `WINDOW_N` consistent at 8 (draft said 8 and 9); W19 split so the first commit is invisible; `baselines.mjs` as pure functions called by build-data (the draft's data flow was circular and had no chain step); sentiment keyed on `publishedAt` (`firstSeenAt` is the pull date); `peers[].readDate` + `reproducible: false` (the draft referenced an archive that does not exist); `chain.json` with per-store freshness keys and scope; no `mature` fallback after `sameAge`; trend filtered by formula; `MIN_PEERS` per measure; the reading rule; store migration for `HEALTH_STORE_VERSION`; `WEIGHTS_BY_FORMULA`; precision tolerances; identifiers renumbered (W19–W23, 1s–1z); `trendsLines` for data-checkable Slack; episode-health copy moved into W20; staleness withholds instead of blocking publish; jsonl line spec; header stamp without a digit; decisions split into plain sentences; rules 1–10 restated.
3. **Gap-finding** (20 findings, 7 HIGH): the day-1 store stall under the existing append gate (F33 — gate relaxed to ≥3 checks); the absolute-scale sentiment balance dominating after honest absences (F8b — no redistributed weight into absolute measures; check-set guard); two browser-side typicals missed by the draft (F29 typical curve, F30 per-row pace — both move to `data.baselines`); the collision with the "absence is silent" directive (D7); the recommendation engine comparing unlike-age rates (F28); sentiment starvation at current volumes (F34, stated with its replacement); alerts firing on window changes and n<3 (F31); recommendations grounded against today's sheet (F32); the outlier test made same-age and two-tier with stamped verdicts so frozen windows never flip; YouTube lag handled by a wider history tolerance; two-point trend-card verdicts lose trend words; `SLOPE_N` exported; critic harvest extended so the critic can actually re-derive.

## Status log
- 2026-08-23 — written from the code audit; three audit passes folded in. Awaiting D1–D7.
