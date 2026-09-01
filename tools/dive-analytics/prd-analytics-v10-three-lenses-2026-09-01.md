# PRD — Analytics v10: show health in three lenses, launch reads, and a standing critic loop (2026-09-01)

Owner brief (2026-09-01): "Thoroughly audit our show and episode health
formulas and build an absolutely robust, up-to-date algorithm for determining
show health. Right now it doesn't read very accurate — it's kind of useless.
We can't see health per show; it's flagging red but we feel good about
things. The gap between how we feel recently and how things are trending
versus projecting needs to surface automatically and without error. Handle
staleness, over-time versus recency, cool-off. This is a live show. Also:
create a proper critic / verification loop so we fact-check and scrutinize
its accuracy, longevity, and usefulness, short and long term."

Audit: `audit/AUDIT-2026-09-01-health-formulas.md` (thirteen findings, every
number re-derived from the stores). This PRD is the design that answers them,
and the record of what shipped the same day on branch `health-v4-three-lenses`.

## 0. The answer to the owner question

**Why it read wrong.** The v3 rules compare like for like and still produced a
wrong reading on 2026-09-01 (score 46, three "Fragile"), because (1) the newest
episode is a promo-driven outlier and the formula scored its diluted per-view
engagement rate anyway (8.8 against 43.8 → 10); (2) "live turnout" averaged
the peak of a recovering room (72, the best since E1) with a falling chat
count (92 against 167) into one "Fragile", and never measured average
viewers (56, tied with E2 for the best since E1); (3) reach read the previous
episode's weak announce conversion with no visible discount; (4) growth's
slope was three points with a three-episode gap treated as consecutive; (5) no
field said which way anything was moving or where the next launch should land.
And no episode had a health score, nor can E1–E4 ever have one under the
frozen 21-day rule at seven episodes.

**What changes (health-v4).** The score stays one number, 50 = usual, built
from the newest episode at its age — the NOW lens — under seven checks:
growth, audience quality, reach, live turnout, **participation** (new: chatters
per hundred at the peak, chat messages an hour), subscribers, goodwill.
Audience quality *counts* likes and comments at the same age instead of a
per-view rate. A promo-driven unit's lift is **qualified**: shown with its
numbers, never scored. A measure that has to read an older episode is
**carried** at half weight and says so. Beside the number, a **direction**
word — building, holding, softening, mixed — comes from each durable
measure's change over the last five clean episodes (a gap-aware, one-odd-
episode-proof slope), and an **outlook** gives the next first week's expected
range from the last three clean launches plus the newest episode's cool-off.
Every episode card gets a **launch word** (strong / typical / soft, with a
promo qualifier) from its first day; the frozen three-week score stays the
permanent read. A deterministic **verification loop** ledgers every claim the
read makes and scores it when reality arrives, watches the formula's own
ageing, and compares the owners' "feel" notes with the read.

**What today reads under v4** (dry run on the real stores, 2026-09-01,
after the adversarial review): weighted mean 48 ("Near usual"), all seven
checks scored. Growth 46 (the launch is promo-qualified — shown, not scored;
the three clean first weeks run down 8.3% an episode, too few for a word),
audience quality 35 (43 likes and comments against 70 at the same age; share
watched 8.9% against 10.7%, carried from E4), reach 21 (X reach promo-
qualified; announce-to-play 13% against 31.4%, carried from E6), live turnout
55 (peak 72 vs 67.5, average 56 vs 49), participation 32 (55.6 chatters per
hundred vs 82.4; 50.2 messages an hour vs 85.3), subscribers 62 (3.6 per
thousand against 2.9, carried from E4), goodwill 100 (six comments,
absolute). Direction **mixed**: live turnout building (average +6.7%, peak
+7.1% an episode over five clean shows); participation softening (chatters
−16.1%, chat pace −12.2%); reach softening (announce-to-play −14.2%); audience
quality softening (share watched −6.9% over four); the three-point series —
clean first weeks (−8.3%), first-week engagement, first-week X reach,
subscribers — show their slopes without a word. Outlook: the last three clean
first weeks ran 1,189–1,830 (typical 1,751); the newest episode's cool-off is
promo-driven, shown not judged. Launch words: E1 strong, E2 strong, E3 soft,
E4 typical, E5 soft, E6 soft, E7 promo-driven (so far).

That is the gap the owners felt, stated: the room is filling back up and the
latest launch is the biggest ever because it was promoted; underneath, the
organic first weeks, chat participation, and announce conversion have been
softening for five episodes.

## 1. Constitution — new rules (18–22); rules 1–17 stand

18. **Qualified lifts.** A measure whose own unit is promo-flagged (the newest
    episode's YouTube views, its X reach, or a rate on either) keeps its value
    and typical, scores null, and carries the fixed reason "promo-driven lift
    — shown, not scored". It never receives or relinquishes weight in a way
    that moves the number: the check averages its other measures; a check
    with none is absent. The page shows the lift as a word and its numbers at
    the click layer.
19. **Carried reads count half.** A measure read from an older episode than
    the newest (because the newest is too young for its maturity) is stamped
    `carried` with `episodeRead` and the fixed note "carried from <title>,
    the latest finished episode — counted at half weight"; inside its check it
    counts `CARRIED_WEIGHT` (0.5); a check whose every scored measure is
    carried brings half its base weight to the mean. The entry's `asOf` names
    the newest episode, its age, the carried checks, and the qualified
    measures.
20. **Direction is a slope over clean episodes, never over days.** For each
    durable measure, the Theil–Sen median of pairwise slopes of ln(value) over
    episode number across the last `TREND_N` (5) clean episodes that carry
    the value, as percent per episode; the quiet zone (±5%) is the only gate
    between building / softening and holding. Fewer than `MIN_PEERS` (3)
    points is absent with a reason; three points show the slope but withhold
    the word (`TREND_MIN_WORD` = 4 — with three, one episode can be the
    slope). Every series carries one basis and its note (rules 11, 17): day-7
    and air-night readings are sameAge / ageFree; lifetime values read past
    maturity are mature, "as they stand now". Promo exclusion is by unit family
    (`UNIT_FAMILIES`): an episode flagged on YouTube views is out of every
    view-based series and typical, one flagged on X reach or plays out of
    every reach-based one, and the live room — which carries no flagged unit
    — keeps every episode; the same shared peer filter serves the NOW lens,
    so a promo spike on X never silences a live night and the two lenses
    never disagree about who counts (the frozen episode-health algorithm and
    the page's pace keep the episode-level rule). The overall word is one vote per check (a check's series agree
    by majority): a single word only when every voting check agrees, "mixed"
    whenever both sides carry a vote, "holding" when every vote holds. The
    lenses are computed once, by build-data, from `baselines.mjs`, served
    every build as `data.baselines.direction` / `.outlook`, and copied into
    the day's health entry — never gated on the model step.
21. **Outlook describes where the last three clean launches landed; it never
    claims a bound.** The range is the low–high of the last three clean first
    weeks with their median as typical, shown with the first-week slope (and
    its word only with four clean weeks): "where the next one lands if it
    follows them". Three samples contain the next value only about half the
    time, so the copy never says "no lower than" and the verifier counts a
    miss on the side the slope pointed as neutral. Cool-off compares the
    newest episode's two-day growth at its age with the other episodes' over
    the same two days at that age (three peers or nothing); a promo-driven
    newest gets no cool-off word, only the qualifier. Neither moves the
    score; both are stored, projected, ledgered, and later scored against
    reality.
22. **A launch word for every episode.** YouTube views at day 7 — or at the
    earliest reading for late-tracked episodes (capped at day 21), or at the
    current age while under a week old (provisional) — against the other
    episodes' readings at that age, either side in air order, outliers out,
    three or nothing; strong ≥ 55 / soft < 45 on the shared 50 × own ÷ typical
    scale (the shared `BANDS`). A flagged YouTube unit keeps the word and adds
    the promo qualifier. A word, never a number, at the glance layer; the
    numbers in the panel. The frozen 21-day score (D4) stands unchanged.

## 2. Findings → design (from the audit)

| Audit finding | Design |
|---|---|
| F1 diluted rate of a flagged episode scored | rule 18; audience quality counts engagement at the same age |
| F2 live mixes viewers and chat | live turnout = peak + average; participation = chatters/100 + messages/hour (normalized) |
| F3 gap-blind slope, promo weeks admitted | rule 20; `build-data` nulls a promo-flagged first week with note "excluded: promo-driven outlier" |
| F4 stale reach, invisible age | reach = same-age exposure (qualified when flagged) + announce-to-play same-age when three peers carry plays, else carried (rule 19); `asOf` on the page |
| F5 no direction, no projection | rules 20–21; Where it's heading column; Slack lines; alerts on a turned direction or a moved range |
| F6 thin absolute goodwill | weight 0.15 → 0.10 |
| F7 staleness invisible | `asOf`, carried notes at the click layer, "reads E7, five days in" |
| F8 no cool-off | rule 21 cool-off |
| F9 tone from rule 9 | prompt v6 rules 12–14: qualified lifts never strength, carried facts keep their wording, direction cited only for the measure it names |
| F10 no episode health visible | rule 22; card words; panel Launch tile |
| F11 promo target scores its own lift (episode health) | queued (own commit: frozen-store field) |
| F12 formula bump restarts the daily trend | accepted; the direction lens reads episodes, not entries, so over-time survives the bump |
| F13 no model here | prompt v6 validated by the same grounding rules the validator applies; first live run on the chain machine |

## 3. The comparison contract — health-v4

Shared definitions unchanged (`baselines.mjs` §3.0 of v9) plus `TREND_N = 5`,
`CARRIED_WEIGHT = 0.5`, `LAUNCH_AGE = 7`, `COOL_SPAN_DAYS = 2`, the notes
`promoQualified`, `carried(title)`, `provisional`, `noLaunchReading`, and the
word tables `DIRECTION_WORDS`, `LAUNCH_WORDS`, `COOL_WORDS`.

### 3.1 NOW lens — the checks (`health.mjs`, weights sum to 1)

| Check | Weight | Measure | Own (`episodeRead`) | Peers | Basis | Qualified when | Carried when |
|---|---|---|---|---|---|---|---|
| growth | .25 | firstWeek | Theil–Sen over the last 5 clean first weeks, as change each episode (1.0 = flat) | — (typical 1) | ageFree | never (promo weeks are not clean) | never |
| growth | | sameAge (launch) | newest's YouTube views at age A ≤ 21 | snapshots at A | sameAge | newest ytViews flagged | never |
| audience quality | .17 | engagement | newest's likes + comments at A | snapshots at A | sameAge | never (a count) | never |
| audience quality | | watching | latest ≥ 7 d: history line at its age (sameAge) → mature fallback (v9 transition rule) | history lines / current files | sameAge → mature | never | own ≠ newest |
| reach | .12 | exposure | newest's X impressions at A | snapshots at A | sameAge | newest xImpressions flagged | never |
| reach | | announceToPlay | newest's plays ÷ impressions at A when 3 peers carry plays at A; else latest finished clean episode's | snapshots at A / latest values | sameAge / mature | newest xPlays or xImpressions flagged | own ≠ newest |
| live turnout | .16 | peak, average | newest live session | window's live sessions | ageFree | never | never |
| participation | .12 | chattersPer100, messagesPerHour | newest live session, normalized | window's | ageFree | never | never |
| subscribers | .08 | subscribers | as watching | as watching | sameAge → mature | never | own ≠ newest |
| goodwill | .10 | balance | last 3 episodes' directional feedback, common sources; absolute scale (no redistributed weight) | — / window balances | ageFree / mature | never | never |
| goodwill | | commentRate | latest with complete replies | peers with complete replies | mature | never | own ≠ newest |

Check score = mean of scored measures, carried ones at 0.5. Mean = relative
checks share (1 − absolute weight) in proportion to base × (carried ? 0.5 : 1);
absolute checks keep their base weight. Append gate unchanged (≥ 3 checks);
`checkSet`, `checkSetChange`, and the naming rule stand; **participation joins
on the first v4 run and the drivers must say so**.

### 3.2 DIRECTION lens (`entry.direction`)

| Measure | Value per episode | Clean when |
|---|---|---|
| firstWeek | clean first-week YouTube views (`showTrend`) | not partial history, ytViews not flagged |
| liveAverage, livePeak | live session | has a session |
| chattersPer100, messagesPerHour | `liveRatesOf` | has a session with peak > 0 |
| engagementWeekOne | likes + comments at day 7 | not partial history |
| exposureWeekOne | X impressions at day 7 | not partial history, xImpressions not flagged |
| announceToPlay | plays ÷ impressions, finished (≥ 7 d) with complete, fresh plays | not flagged |
| watching | share watched, ≥ 21 d | not flagged |
| subscribers | subscribers per 1k, ≥ 21 d | not flagged |

Each: `{key, n, pctPerEpisode, direction, points[{slug, ep, value}], reason}`;
`overall` by majority. Stored points are the only thing the validator and the
verifier re-derive from.

### 3.3 OUTLOOK (`entry.outlook`)

`nextFirstWeek {low, high, typical, n, window, direction, reason}` from the
last three clean first weeks; `coolOff {ageDays, span, value, typical, n,
word, peers, excluded, reason}`.

### 3.4 Launch read (`data.baselines.launch[slug]`)

`{ageDays, value, typical, n, pct, word, promoDriven, provisional, late,
peers, excluded, reason}` per rule 22; rendered on cards (word) and in the
panel (numbers); never frozen.

## 4. Stores and schemas

- `health-history.json` → `HEALTH_STORE_VERSION = 3` (v1/v2 accepted, upgraded
  in place, entries byte-identical). New entries add `direction`, `outlook`,
  `asOf`; measures add `qualified`, `carried`, `carriedNote`; checks add
  `carried`. `WEIGHTS_BY_FORMULA["health-v4"]` holds the new weights; v1–v3
  entries keep theirs and are judged under them.
- `data/restream/health-verify.json` (new, append-only): `{version: 1,
  updatedAt, claims: [{id, kind, madeOn, …, resolution: null | {on, outcome:
  hit|miss|void, actual, detail}}]}` — claims are never edited once resolved.
- `data/restream/health-feedback.jsonl` (new, owner-written): one line per
  note `{date, feel: better|same|worse, note, at}` via `health-feedback.mjs`.
- `tools/dive-analytics/audit/HEALTH-VERIFY.md`: the rolling report, rewritten
  every run (deterministic given the stores).
- `chain.json`: step `health-verify` after `health` (`required: false`).
- `data.json`: `baselines.launch`, `baselines.direction` (`measures[]` with
  `key, check, n, pctPerEpisode, direction, ageBasis, note, points, reason`;
  `votes[]`; `overall`), `baselines.outlook` (`nextFirstWeek`, `coolOff`),
  `health.asOf`, per-check `carried`, per-measure `qualified` / `carried` /
  `carriedNote` / `ratio` (the three-decimal comparison every relative score
  derives from — the one scoring path); `episodes[].subsPer1k`;
  `showTrend.week1VelocityByEpisode` rows for promo-flagged episodes carry
  `value: null, note: "excluded: promo-driven outlier"`, and first-week views
  read the day-7 snapshot by the shared reading rule.

## 5. Workstreams

- **W29 health-v4** — `health.mjs` (formula, weights, `checkScoreOf`,
  `deterministicMean` with carried weights, direction/outlook/asOf blocks,
  projection), `baselines.mjs` (rules 20–22 functions and constants),
  `build-data.mjs` (clean first weeks, Slack lines), prompt v6.
- **W30 surfaces** — `index.html`: seven check names, direction word in the
  band, Where it's heading column, reads-on line, qualified/carried notes in
  the drill, launch words on cards, panel Launch tile, About; `alerts.mjs`:
  direction turned / range moved lines; `critic-prompt.md`.
- **W31 validator + fixtures** — block 1h: per-formula check sets, qualified
  and carried contracts, `checkScoreOf`, direction re-derivation from stored
  points, outlook shape, `asOf.carried`, same-day recompute extended; card-
  layout block: the page reads the stored blocks and `baselines.launch`, no
  slope or standing recomputed, no number on a launch word;
  `baselines.test.mjs`: Theil–Sen, direction words, `trendFor`, overall,
  launch reads (growing run, late-tracked, promo, lone), live rates, cool-off,
  carried weights.
- **W32 docs** — this PRD, the audit ledger, `ARCHITECTURE.md`, `README.md`,
  `CLAUDE.md` (L3/L4 lists).
- **W33 verification loop** — `health-verify.mjs`, `health-feedback.mjs`,
  the ledger, the report, the chain step (§7).
- **W34 never a day without a read** — `fallbackSynthesis` in `health.mjs`:
  after two failed model attempts, or with no key, a deterministic entry
  (score = the weighted mean; bullets = the strongest and weakest scored
  facts verbatim; headline and drivers from fixed plain-word templates over
  the check words and the direction) that passes `validateSynthesis`, stamped
  `provider: "deterministic"`; `run-chain.mjs` pulls main before the first
  step (generated files set aside, never stashed over pulled code);
  `postlive-publish.sh` rebuilds `data.json` on a stash conflict instead of
  aborting.
- **Queued:** F11 (episode-health entries stamp the target's own promo
  verdict; needs a frozen-store schema bump and a validator block); a
  deterministic v4 back-fill of past days' weighted means for the daily trend
  (snapshot measures only; analytics measures cannot be time-travelled).

## 6. Validator contracts (block names extend 1h and the card-layout block)

- **1h-v4 entry shape** — exactly the checks of the entry's formula; a
  qualified measure has value, typical, score null, and the fixed reason; a
  carried measure has a score, `episodeRead`, and the half-weight note; the
  check score equals `checkScoreOf`; `carried` on the check equals "every
  scored measure carried"; effective weights equal `deterministicMean`;
  absolute checks never exceed base weight; every direction measure's
  `pctPerEpisode` and word re-derive from its stored points, none rests on
  fewer than `MIN_PEERS` or more than `TREND_N` points; `overall` follows the
  measures; the outlook range is well-formed on ≥ 3 clean weeks; `asOf`
  names the newest episode and lists exactly the carried checks; today's
  entry recomputes from the stores including direction, outlook, and asOf.
- **Card layout** — the page renders `h.direction`, `h.outlook`, `h.asOf`,
  and `baselines.launch` (strip cards and panel) and contains no slope,
  log, or per-episode-percent arithmetic; a launch word carries no tagged
  number.
- **Fixtures** — the twelve-episode synthetic run proves the new functions
  (a 10%/episode series reads 10; one odd episode does not move it; the
  largest episode of a growing run reads strong and the smallest soft; the
  late-tracked episode reads at its earliest age; the promo episode's word
  carries the qualifier; a carried check gets half the share).

## 7. The verification loop (W33)

Runs every chain day after `health` (never blocks publish), and by hand:
`node tools/dive-analytics/health-verify.mjs [--dry]`.

1. **Accuracy** — re-derives today's entry from what it stored (checks,
   weights, direction slopes, outlook range) and reads its words against its
   numbers: a "fragile" headline needs a check under 45, a "strong" one a
   check at 55 or more; a direction word in the headline must be one the
   entry carries; a "helping" bullet must not cite a promo-qualified fact;
   air-night facts must equal the store.
2. **Usefulness** — the ledger of claims and their outcomes, one claim per
   thing predicted (a range per next episode, a word per series and last
   episode, a launch word per episode — never one per day): the next first
   week inside the range (neutral when outside on the side the slope
   pointed; void when the next launch is promo-driven or tracked late — not
   a clean test); each direction word against the next episode's move (hit,
   miss, or neutral when either sits in the quiet zone; void when the next
   episode never enters the series), read from the served lens — the same
   definition, never re-implemented; a provisional launch word holding at
   day seven (promo-driven words are not ledgered: they cannot fail).
   Plus the owners' notes: `node tools/dive-analytics/health-feedback.mjs
   better|same|worse "a few words"` on any day; the loop compares each with
   the read's direction word or score move and reports agreement over time.
   This is the standing test of "flagging red but we feel good".
3. **Longevity** — absence streaks per check (≥ 21 days = starving), the
   carried share of scored checks (> ½ = mostly last episode's read) with the
   size of the carried discount (the mean at full weight), steady-state
   check-set changes in 30 days (≥ 3; a launch week's designed joins do not
   count), days without a read in 30 (≥ 3), scoring-rule changes, direction
   measures still at three points, and the mature fallback outliving its
   expected retirement (mid-October). Owner feel is compared two ways — with
   the direction word and with the score's move since the previous read
   (five points) — and agrees when either matches.
4. **Open claims** — what is still waiting for reality.

Report: `audit/HEALTH-VERIFY.md`; ledger: `data/restream/health-verify.json`.
The Monday model critic (`critic.mjs`) reads the v4 rules from its prompt and
re-derives independently; its findings are triaged in `audit/CRITIC-*.md` as
before. A three-lens adversarial review (fact-check vs code, gaps,
implementability) ran on this PRD and the code before merge — §10.

## 8. Cost of honesty — day-1 consequences

- The daily score trend restarts (eight v3 points disappear until seven v4
  days exist, ≈ 09-08). The direction lens covers over-time from day one.
- Participation joins on the first v4 run; the drivers name it (rule 10).
- Subscribers stay absent until E5 is 21 days old at a chain run (09-04)
  and gives a third mature peer; watching the same.
- Reach's announce-to-play stays carried on every read until three peers
  carry X plays at the newest episode's age — plays exist only from 08-21,
  so not before E10 (mid-October); the strip says so and it counts half.
- Cool-off reads as soon as three peers carry readings two days apart at
  the newest's age (for E7, from 09-02) — and for E7 it is promo-driven, so
  it is shown, not judged.
- E7's launch and X reach are shown, not scored, for as long as the flag
  holds (tier 1 settles at the 09-18 run); its first week will not enter the
  clean series on 09-04.
- Prompt v6 was exercised live from the build machine with the vault key
  (`--probe-model`: valid grounded JSON, score 47). If the model still fails
  twice on a chain day, the deterministic fallback (W34) writes the entry —
  the day never goes without a read.
- The chain runs from `chain.json` through `run-chain.mjs` (one crontab
  line), so the `health-verify` step runs on the next morning without a
  crontab edit; `run-chain` now pulls main before it builds, and the publish
  script regenerates `data.json` rather than failing on a stash conflict.

## 9. Decisions taken (owner asked to build; recommended options adopted)

- D8 Qualified, not excluded: promo lifts are shown with their numbers and
  never scored (rule 18). *Alternative rejected:* scoring them, which lets
  promotion move health.
- D9 Carried at half, not dropped: a stale read counts half and says so
  (rule 19). *Alternative rejected:* dropping it, which starves reach for a
  week after every episode.
- D10 Seven checks, participation split from turnout (F2), goodwill 0.10.
- D11 Direction and outlook are words beside the number, never inside it.
- D12 Launch words on cards from day one, provisional under a week, promo
  qualified; the frozen score unchanged (D4 stands).
- D13 The verification loop is deterministic and never blocks publish; owner
  feel is opt-in via the CLI.

## 10. Audit record

Three fresh-context adversarial passes ran over this PRD, the audit, and the
working tree on 2026-09-01 before merge.

1. **Fact-check vs code** — every number in both documents re-derived from
   the stores (all ten direction slopes by hand, every check score and
   typical, the weighted mean, the launch words, the live series); rules
   18–22 confirmed against the code. Corrections folded in: v3 averaged peak
   with chat and never measured average viewers; chat fell on five of six
   steps; average 56 ties E2; E3 −21%, E4 −3% at day 14.4; participation is
   per hour, not per minute; the page's `checkState`, not prompt rule 9,
   forces "Fragile"; chain-run dates (09-04, 09-18) replace calendar days.
   Defects found and fixed: the verifier re-scored from the rounded value and
   would have printed a false FAIL on the first v4 day; qualified measures
   dropped their basis note (kept now, rule 17); a check's reason ran two
   strings together (reasons now name only absent measures); the Slack
   first-week line had its own "last against first" direction (rule 16);
   `asOf.qualified` was unvalidated (validated); ledger "band" claims never
   resolved (removed) and a promo-driven provisional launch word was a
   guaranteed hit (no longer ledgered). Accepted with a note: the direction
   lens's mature series read values at different ages (rule 11 `mature`);
   same-age announce-to-play cannot arrive before E10.
2. **Gaps** (21 findings, 5 HIGH) — the design changes it forced: the
   direction and outlook lenses moved out of the model-gated entry into
   build-data (`data.baselines.direction` / `.outlook`, copied into the entry),
   so the page carries a direction on every build; a direction word now needs
   four clean readings (`TREND_MIN_WORD`) and every series carries its basis
   note; the overall word is one vote per check with a single word only on
   unanimity (a majority of correlated series is not a reading); the outlook
   range is a description of the last three clean launches, never a bound;
   promo exclusion is by unit family for both lenses (a flag on X never
   removes a live night; the reviewer's episode-level rule was tried and
   silenced E7's turnout); a promo-driven newest gets no cool-off word; the card says
   "Promo-driven launch" instead of "Strong launch · promo" and always adds
   "so far" while provisional; the trend card's direction word and the Slack
   first-week line read the stored lens (one definition); the verifier's
   claims are keyed by the thing predicted, resolve with hit / miss / neutral
   / void, and the churn count ignores a launch week's designed joins; alerts
   fire when the promo flags change and no longer on every range move; a pro
   citing a promo fact is rejected at synthesis. Accepted with a note: a
   launch read moves while an episode is young (by design); carried weight
   0.5 is a stated convention, and the verifier prints the counterfactual.
3. **Implementability** (2 HIGH, 4 MED, 15 LOW) — fixed: the writer scored
   from the raw quotient while storing a rounded ratio (one day in five would
   have failed the validator) — the ratio is now the single scoring path; the
   expanded card sized its grid for a column it did not render; the model's
   second attempt is told the first attempt's error; the validator's same-day
   recompute passes the previous entry (the never-fall-back rule reads it);
   `readState` no longer calls a promo-qualified measure "early"; the ledger
   was regenerated before the first commit. The reviewer's crontab note was
   wrong: the crontab runs `run-chain.mjs`, which reads `chain.json`, so the
   step is live on the first morning after merge.

## 11. Addendum (2026-09-01, evening) — rule 23, the whole live session, and the day the formula changed

Owner reaction to the first shipped v4 page, verbatim in spirit: *the data
didn't change; live turnout looks only at peak viewers and chat; where are
average viewers and watch time; build something that stays useful and
evolves.* Three findings, all confirmed against the stores:

1. **The served read was still v3.** `health.mjs` is append-only per day; the
   chain had saved the day's v3 read at 07:25 and the new code would not
   write until the next morning. Shipping the machinery without a v4 read
   was a real gap between "live" and what the owners saw.
2. **The live checks ignored most of the live record.** Restream reports, per
   event, unique live viewers (`viewsTotal`), minutes watched live
   (`watchedTime`), and the minute-by-minute audience; the YouTube analytics
   file carries traffic sources. None of it fed show health.
3. **Fixed ±10 % bands overclaim on noisy measures.** Chat messages an hour
   swing about ±16 % between ordinary episodes and subscribers per thousand
   views about ±100 % on three peers; a dip inside a measure's ordinary swing
   was reading "fragile".

### Rule 23 — bands follow the show's own swing

Each scored measure stores `swing`: the median absolute deviation of its
peers from their typical, as a whole-percent share of the typical, from the
same peers the typical used (`baselines.swingOf`). A check's `swing` is the
median of its scored measures' swings; its `bands` are half that swing in
score points either side of 50, never narrower than the fixed bands (±5
points = ±10 %) and never wider than ±15 points (±30 %) (`bandsFor`); its
`state` word — healthy / steady / fragile / waiting — follows those bands
(`stateOf`). The writer stamps all three; the page reads `c.state` and
`c.bands` (fixed bands only for reads written before the rule); the model
prompt (v7) reads `state`, never a cut-off; the verifier judges headlines by
`state`; the validator re-derives swing, bands, and state from the entry
alone (block 1h) and rejects bands outside the allowed range. The overall
score's band words (above / near / below usual) stay fixed at ±5: the mean
of seven checks is already smoother than any one of them.

Consequence on the real stores, first run: subscribers per thousand views
scored 62 and read *steady* (swing 100 % → bands 35 / 65); participation
scored 47 and read *steady* (swing 22 % → 39 / 61) with chat down and staying
power up inside it; audience quality (35, swing 17 %) and reach (35, swing
13 %) still read *fragile* — those dips are outside any ordinary swing.

### The measure set (final for health-v4; no entry existed under the narrower set)

| Check | Measures (basis) | New this addendum |
|---|---|---|
| growth | first-week slope (ageFree) · same-age launch (sameAge, qualified when promo) | — |
| audience quality | likes + comments at the newest's age (sameAge) · share watched (sameAge → mature, carried) | — |
| reach | X exposure at age (sameAge, qualified when promo) · announce-to-play (sameAge → mature, carried) · **discovery share** — YouTube views from search, suggested, Shorts, browse (mature, carried; `DISCOVERY_SOURCES`) | discovery share |
| live turnout | peak · average · **unique live viewers** (`live.liveViews`) · **minutes watched live** (`live.watchedMin`) — all ageFree, live family | two |
| participation | chatters / 100 at peak · messages / hour · **minutes each live viewer stayed** (`watchedMin / liveViews`) · **hold rate** — audience over the last `HOLD_MINUTES` (10) against the peak — all ageFree | two |
| subscribers | subscribers / 1k views (sameAge → mature, carried) | — |
| goodwill | balance (absolute or mature) · commenters / 1k (mature) | — |

The direction lens carries the five new series (`TREND_MEASURES`), each in
its check's vote. Live measures stay in the live unit family (a promo spike
on X or YouTube never silences a live night). Weights are unchanged (§3).

What this changed in the first read: fewer unique people watched the newest
show live (727 against a typical 1,125) but each stayed longer (8.3 minutes
against 6.6) and more of the peak held to the end (75 % against 63 %) — a
"smaller room, better room" reading that peak and chat alone could not
express. Discovery share read 13.4 % against 14.1 %: YouTube is not yet
surfacing the show to strangers, and the newest episode's own 87 %
subscriber traffic (when it matures) will say so louder.

### Rule 9 on the day a formula ships — same-day re-derivation

A day's read written under an older formula is re-derived by the new one
the same day: the older read is moved, byte-identical, to
`store.superseded[]` (`{supersededOn, by, entry}`) and the new read carries
`rederivedFrom: {formulaVersion, score}`. The validator's append-only guard
accepts exactly that shape and nothing else; the projection, the trend, and
the verifier see one read per day. Today: the v3 read of 46 is superseded
by the v4 read of 49 (deterministic mean 50.1, model move −1.1, prompt v7).

### The morning after (W34, continued) — `chain-heal.mjs`

The chain machine ran old code the next morning: it appended its v3 read
locally, then the publish script's stash pop collided with the pushed
re-derived store and exited, leaving unmerged paths and a stash. The new
`run-chain.mjs` calls `healLeftovers()` before it pulls: generated files
take HEAD's copy (the build regenerates them), `health-history.json` is
unioned by day (both sides' days kept; the same day under two formulas keeps
the newer read and files the older under `superseded`), anything else stops
the chain with the file named. `audit/chain-heal.test.mjs` rehearses the
exact sequence in throwaway repos. The validator allows catch-up days (more
than one new entry, each later than the last committed day) so a read saved
on a morning that never published still lands.

### What "evolves on its own" now means, in one list

- Typical = the last eight comparable episodes; it rolls forward every
  episode (windowFor), so a step change (the unique-live-viewer halving from
  E5) leaves the baseline within eight shows.
- Bands follow each check's own swing (rule 23) and re-fit every read.
- Direction reads the last five clean episodes; a word needs four.
- Same-age readings take over from mature ones the day three peers have a
  history line at the needed age (PRD v9 §3.1), never the other way.
- A launch word settles at day seven; a promo verdict settles at day 21.
- Carried reads fall away the day the newest episode reaches the measure's
  age; provisional reads say so until then.
- The verification loop ledgers every claim and scores it when reality
  arrives; the owners' feel notes are compared with what the read said.
- Every re-derivation is visible (`rederivedFrom`, `superseded`), never silent.

### W35 — What matters, ranked from the day's read (owner directive, same evening)

"Wire up our insights in the bottom (no new categories) to more intelligently
surface the top five things we should do based on the latest intelligence."

- `recommendations.mjs` prompt v4: the payload carries `context` — today's
  show-health read (score, each check's `state`, headline, drivers, what the
  read is on, carried and promo-qualified notes), the direction word of every
  durable measure, the outlook (first-week direction, cool-off word), and each
  episode's launch word — as words only; every number stays a fact. New facts:
  the show-health score, each check's score, each measure's own value and
  typical (`hm-*`), each direction slope (`dir-*`), the outlook range, each
  launch read and its typical, and per episode the average live viewers,
  chatters, people who watched live, minutes watched live, minutes each
  viewer stayed, hold rate (`baselines.liveDepthOf`, one definition) and
  discovery share.
- Exactly five items, in order of lever (`TOP_N`), each with `serves` (the
  check it helps, or null); the prompt leads with fragile checks and
  softening measures the hosts can act on, never against a promo-driven lift,
  and must cover at least three checks. Categories unchanged (content,
  distribution, promotion, audience).
- The store stamps `ranked: true`; build-data ships `rank` and `serves` on
  each item and keeps store order (unranked claims — the validator-locked
  pace-rank — follow by category). The page renders the rank where the
  category icon sat and "helps <check>" after the category; the health card's
  Do next is the top two by rank. Validator: ranks 1..n contiguous and first,
  store order = page order, a fresh ranked store holds exactly five, `serves`
  names a known check, and the page's sort/Do-next contracts.
- The prune floor is unchanged (three); a pruned ranked store keeps its
  surviving order.

### Validator contracts added

- 1h: per-measure `swing` (integer ≥ 0, ≥ MIN_PEERS peers, absent on
  absolute-scale); per-check `swing` / `bands` / `state` re-derived from the
  entry's measures; bands inside [SWING_MIN_PCT, SWING_MAX_PCT] / 2.
- 1h: append-only guard accepts a same-day re-derivation (older formula,
  byte-identical under `superseded`, `rederivedFrom` names it) and catch-up
  days; superseded reads are append-only too.
- card-layout: the page calls `checkState(c.score, c.bands)` and renders the
  swing note with the other measure notes.

## Status log

- 2026-09-01 — audit written; health-v4, surfaces, validator, fixtures, and
  the verification loop built and validated on the real stores (dry run);
  three adversarial passes (fact-check, gaps, implementability) run and
  folded in (§10); branch `health-v4-three-lenses`.
- 2026-09-01 (evening) — owner: "the data didn't change; live turnout reads
  only peak and chat". Addendum §11: rule 23 (swing-fitted bands), five live /
  reach measures, same-day re-derivation (v3 46 → v4 49), `chain-heal.mjs`
  with a rehearsal test, prompt v7. Merged to main and deployed the same
  evening.
- 2026-09-01 (late) — W35 shipped: What matters = five ranked actions from the day's read; the carousel lost its second colored dot and the question-mark cursor (owner directives).
