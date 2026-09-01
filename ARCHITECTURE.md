# ARCHITECTURE.md — where every number comes from

Companion to `CLAUDE.md` (intent and rules). This file is the lineage: which
script writes which store, what each store's timestamps mean, and how each
number on the page is derived. Verified against the `docs/agent-guide-architecture-prd-v7` branch (2026-08-23, PRD v9 implemented).
When code and this file disagree, the code is right and this file needs a
commit in the same change.

Contents: §1 chain and cadence · §2 stores and their time semantics · §3
number lineage (page → store → script → rule) · §4 the two scorers side by
side · §5 model steps and their grounding contracts · §6 the validator's
contract map · §7 known gaps (pointers to PRD v9)

---

## 1. Chain and cadence

Owner machine, 07:00 America/Phoenix daily (OpenClaw automation `restream-postlive-snapshot` → `run-chain.mjs`; a 06:00 rehearsal runs the same chain without publishing). The publish half is documented in
`README.md`; the whole chain, with what each step writes and which stores must
be fresh, is versioned in `tools/dive-analytics/chain.json` (the automation itself
lives on the owner machine).

| Step | Script | Writes | Model? | On failure |
|---|---|---|---|---|
| discover | `scripts/restream/postlive-discover.mjs` | `data/restream/postlive-registry.json` (new episodes, 4 destinations) | no | warns; registry unchanged |
| transcripts | `scripts/restream/transcripts-pull.mjs` | `transcripts/<slug>.txt` (yt-dlp auto-captions, day 2+) | no | absent; retried next day |
| snapshot | `scripts/restream/postlive-track.mjs snapshot` | `data/restream/postlive/<slug>.json` (append) | no | destination absent from that snapshot |
| yt-analytics | `scripts/restream/yt-analytics-pull.mjs` | `data/restream/yt-analytics/<slug>.json` (overwrite) + `yt-analytics-history/<slug>.jsonl` (append, one line per Phoenix day when every authorized channel pulled) | no | file unchanged (stale `updatedAt`); no history line that day |
| comments | `scripts/restream/comments-pull.mjs` | `data/restream/comments/<slug>.json` (append by id) | no | store unchanged |
| classify | `scripts/restream/comments-classify.mjs` | `data/restream/comments-classified.json` (append by id) | **yes** | previous labels stay; golden-set gate FAILs loudly |
| channel-stats | `scripts/restream/channel-stats-pull.mjs` | `data/restream/channel-stats.json` (one point/channel/UTC day) | no | day absent |
| live | `scripts/restream/ingest-restream.mjs` | `data/restream/events/<id>.json`, `state.json` | no | event retried |
| ratings | `tools/dive-analytics/ratings.mjs` | `data/restream/episode-ratings.json` (frozen, rebuildable entries) | no | — |
| build-data | `tools/dive-analytics/build-data.mjs` | `data.json`, `data.js` (incl. `data.baselines`, `data.insightsStale`) | no (imports `baselines.mjs`, `watch-moments.mjs`, `recommendations.validateItem`) | — |
| validate | `tools/dive-analytics/audit/validate.mjs` | — | no | **no publish** |
| health | `tools/dive-analytics/health.mjs` | `data/restream/health-history.json` (append, one/Phoenix day) | **yes** | previous entry stays public |
| recommendations | `tools/dive-analytics/recommendations.mjs` | `data/restream/recommendations.json` | **yes** | previous store stays |
| moment-summaries | `tools/dive-analytics/moment-summaries.mjs` | `data/restream/moment-summaries.json` | **yes** | moments render without context |
| build-data → validate | (again, so today's health entry is in the artifact) | | | |
| publish | `scripts/restream/postlive-publish.sh` | stash → `git pull --rebase` → commit + push `main`, `vercel deploy --prod`, live `generatedAt` parity | no | exits non-zero on a moved remote or a data conflict — nothing half-published |
| alerts | `tools/dive-analytics/alerts.mjs` | `alerts-state.json`, `alerts-pending.json` (Slack queue) | no | — |
| critic (Mon) | `tools/dive-analytics/critic.mjs` | `tools/dive-analytics/audit/CRITIC-<date>.md` | **yes** | writes "did not run", exit 0 |

Secrets: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the login shell; YouTube
API key + owner OAuth (both channels) and X bearer via the owner's tooling
(`xurl`); Restream via `restream-token.mjs` (1Password). Nothing in the repo.

---

## 2. Stores and their time semantics

This is the section to read before comparing two numbers. "Age" means
days since the episode's premiere (noon Phoenix).

| Store | Shape | Written | Time semantics | Gotchas |
|---|---|---|---|---|
| `postlive-registry.json` | show → destinations (videoId, postId, broadcastId, role), `playsStatus`, `playsHighWater` | discover, track | mutable registry | `playsStatus`/`playsHighWater` are *current* state, not per-snapshot — re-reading an old snapshot yields today's staleness verdict |
| `postlive/<slug>.json` | `snapshots[]` of `{ts, metrics[dest]: {views, plays?, detail{likes, comments…}}}` | track (every run, every active episode ≤ 60 d old) | **append-only time series** — the only store with real history | episodes stop receiving snapshots at 60 days; E3–E6 were first snapshotted 2026-08-21 (late registration), so same-age peers for young ages are thin until ~E9 |
| `yt-analytics/<slug>.json` | per channel: `totals{views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, likes, comments}`, `retention[]` (100-point curve), `trafficSources[]`, `updatedAt` | yt-analytics-pull (all episodes, every run) | **overwrite; lifetime-to-date** (`startDate = premiere, endDate = today`) | a 2-day-old and a 30-day-old episode's `averageViewPercentage` are not comparable — comparisons from this file are stamped `mature` (both ≥ 21 d) |
| `yt-analytics-history/<slug>.jsonl` | one line per Phoenix day: `{date, pulledAt, endDate, ageDays, channels{key: {views, averageViewPercentage, averageViewDuration, estimatedMinutesWatched, subscribersGained, likes, comments}}}` | yt-analytics-pull | **append-only**; never rewritten; no backfill | what makes share watched and subscribers readable at the same age (`baselines.historyAt`, ±1.5 d for YouTube's reporting jitter); starts 2026-08-23, so E1–E6 never get day-21 lines |
| `comments/<slug>.json` | comments by id with `firstSeenAt`, `likes`, source (`yt`/`x`), `xCoverage` | comments-pull | **append by id**; YouTube pulled forever, **X replies only within 7 days** of premiere | `xCoverage: "missed"` for E1–E5 — their feedback is YouTube-only while E6 includes X |
| `comments-classified.json` | per comment id: relevance, sentiment, themes, confidence, `classifiedAt`, version stamps; `lastRun` | classify | **append by id; a label is never re-read** unless `--reclassify-all` with a `CLASSIFIER_VERSION` bump | golden set (`audit/golden-comments.json`) gates every run: 100 % relevance / ≥95 % sentiment or previous labels stay |
| `comments-sentiment.json` | wordlist-v1 labels | (legacy; not in chain) | — | only `hasNegativeSignal()` is still used, as a featured-quote veto |
| `channel-stats.json` | per channel/host per UTC day: subscribers, totalViews, followers | channel-stats-pull | one point per day, first write wins | series started 2026-08-22; no trend yet |
| `events/<id>.json` + `state.json` | raw Restream analytics per live event | ingest-restream | **frozen at first ingest** (age-free: air night) | surfaced as `episode.live` |
| `episode-ratings.json` | `scores[]` one per finished episode: score, per-check `{value, typical, ratio, score, sample, weight, ageBasis, note, peers[{slug, value, atDay, source, readDate}], excluded[]}`, `windowIds`, `excluded[]`, `frozenAtDay`, `reproducible` | ratings (`health21-v2`, store v4) | **frozen forever within `algorithm`**; re-derived visibly on bump (`rederivedFrom`) | every check is like for like and stores its inputs; `reproducible:false` marks entries whose mature inputs came from the overwritten analytics file |
| `health-history.json` | `entries[]` one per Phoenix day: score, headline, pros/cons (fact-cited), drivers (digit-free from prompt v4; projected and rendered in the evidence card), subScores with measures `{value, typical, sample, score, reason, ageBasis, note, window, excluded, episodeRead, readDate, absoluteScale}`, `checkSet`, `checkSetChange` (projected as `data.health.checkSetChange`; the page, Slack, and alerts announce a changed set — W27), facts, stamps | health (`health-v3`, store v2) | **append-only, immutable**; newest entry ≤ today is served; **withheld after 7 days** | typicals from the eight episodes before the read episode; entries written under older formulas keep their own stamps and are judged by their own weights |
| `recommendations.json` | 4–7 items `{id, category, text, recommendation}`, every number grounded in the fact sheet; `facts[]` the sheet it was grounded on | recommendations | overwrite on success | projected into `data.insights` **minus stale items** — an item whose numbers have left today's sheet, or that compares a young episode's rate with a finished one's, is held back and named in `data.insightsStale` |
| `moment-summaries.json` | per episode/moment: one model-written sentence | moment-summaries | overwrite on success | never a raw transcript quote |
| `alerts-state.json` / `alerts-pending.json` | last-seen values / queued lines | alerts | overwrite | day-over-day diff; lines carry `sample`/`direction` (validator 1x); pace-rank alert only when the peer set is unchanged |
| `transcripts/<slug>.txt` | 3 header lines + timestamped body (two formats: Restream speaker transcript or YouTube auto-captions) | transcripts-pull or owner | never overwritten once present | timestamps are live-recording time; VOD trims shift them (moments are windows, not instants) |
| `data.json` / `data.js` | the artifact (below) | build-data | rebuilt every run; byte-reproducible from stores (validator 7) | `data.js` is `data.json` wrapped; the page reads only `data.js` |

---

## 3. Number lineage — page → `data.json` → store → script → rule

`data.json` top level: `generatedAt`, `dests[4]`, `episodes[]`, `insights[]`,
`showTrend{week1VelocityByEpisode, cumulativeAllEpisodes, paceRank}`,
`commentSummary`, `health`.

Per episode: `slug, title, premiere, ep, ageDays, partialHistory, announces,
snapshots[], weekly[], latest{ts, byDest, ytTotal, xImpressions, xPlays,
xPlaysInfo, totalViews, totalViewsInfo}, links, transcript, metrics{week1Velocity,
week1Note, flatlineWeek, engagementPer1k, anomaly}, live{peak, avg, liveViews,
watchedMin, chatMessages, chatters, durationMin, series, byChannel},
comments{…, list[], featured[], xCoverage}, watch{avgPercent, avgDurationSec,
minutesWatched, curve[], traffic[], byChannel, shape, moments}, health`.

| Surface (page) | Field | Derived in | From | Definition / gate |
|---|---|---|---|---|
| Total views (hero, table, standings) | `latest.totalViews` | build-data `buildLatest` | snapshots | YT views + X plays; `totalViewsInfo{partial, stale}` mirrors `xPlaysInfo` (rule 1) |
| X reach | `latest.xImpressions` | build-data | snapshots (X `views` = impressions) | exposure; never summed (rule 1) |
| Pace ("#n of m at this age", ▲/▼ vs typical) | `data.baselines.pace[slug]`, `showTrend.paceRank` | `baselines.paceFor` via build-data | snapshots at the same age (`readingAt`, ±0.5 d) | the other episodes at that age, outliers out, ≥3 or absent with a reason; the page reads it, never recomputes |
| First-week trend card (views) | `showTrend.week1VelocityByEpisode` | build-data | snapshot at ≤ day 7 | null for `partialHistory` or < 7 d; page and Slack give a direction only from 3 clean weeks; trend words need a three-point run |
| Trend card (watched / reach / live) | bars from `watch.avgPercent`, `latest.xImpressions`, `live.peak`; verdict from `data.baselines.newestVsPrevious[metric]` | `baselines.newestVsPrevious` | reach: snapshots at the same age; watched: history lines at the same age; live: age-free | "Too young to compare…" when no same-age reading exists; quiet zone from `data.baselines.constants` |
| Promo outlier | `metrics.anomaly`, `data.baselines.anomaly[slug]` | `baselines.anomalyFlags` | same-age readings of the nearby episodes (tier 1 at day 21; tier 2 at current age; tier 3 window-limited latest totals only while history is thin) | >2× the typical, ≥3 peers, self excluded; provisional until tier 1; excluded from host/announce/topic comparisons and every typical |
| Engagement per 1k | `metrics.engagementPer1k` (display); show health reads `engagementPer1kOf(snapshotAt(e, A))` | build-data / health | snapshots | drifts with age, so every comparison is same-age |
| Live peak / chat / chatters | `live.*` | build-data | `events/<id>.json` | age-free (air night) |
| Share watched, avg time, minutes, curve, traffic | `watch.*` | build-data `attachWatch` | `yt-analytics/<slug>.json` | view-weighted blend across channels with reports; absent channel drops out; curve null until YouTube produces it; lifetime-to-date |
| Typical watch line (Watching chart) | `data.baselines.typicalCurve` | `baselines.typicalCurve` | curves of episodes ≥ 21 d, outliers out | drawn only with ≥3 curves; per-point true median where all contributing curves share the `at` |
| Watched vs typical (table ▲/▼) | `data.baselines.watchPctBySlug[slug]` | `baselines.computeBaselines` | other mature, unflagged episodes (the row never in its own typical) | ≥3 or neutral; quiet zone from constants |
| Drop-off moments + pins | `watch.shape`, `watch.moments` | build-data via `watch-moments.mjs` | curve + transcript | deterministic; floor 2.0 points; ≤3 drops + 2 holds; summary text from `moment-summaries.json` |
| Feedback counts, themes, featured quotes, commenters per 1k | `comments.*`, `commentSummary` | build-data `summarizeComments` | `comments-classified.json` ∩ `comments/<slug>.json` | only `ready` + `feedback` labels surface; `commentersPer1k` only when X coverage is complete and plays are not partial/stale |
| Episode health chip / panel / table / Slack | `episode.health` | **ratings.mjs** (`health21-v2`) | snapshots (watch, engagement — same age), analytics history or file (retention, conversion), events (live), classified comments within 21 d on common sources (sentiment) | §4; ≥21 d; frozen with stored inputs; eight episodes before it, outliers out, three peers per check |
| Show health score, headline, seven checks with swing-fitted states, pros/cons, direction, outlook, as-of | `health` (incl. `ageDays`, `withheld`, per-check `state` / `bands` / `swing`, per-measure `note` / `qualified` / `carried` / `swing`, `direction`, `outlook`, `asOf`) | **health.mjs** (`health-v4`, deterministic checks; PRD v10 §11: live turnout = peak, average, unique live viewers, minutes watched live; participation = chatters/100, messages/hour, minutes per live viewer, hold rate; reach adds discovery share) + model synthesis (prompt v7; deterministic fallback after two failures or with no key, stamped `provider: "deterministic"`) | snapshots, live events, analytics history/file, classified comments, `showTrend`, `baselines.launch` | §4; one entry per Phoenix day when ≥3 checks are available; promo-flagged lifts shown not scored; carried reads at half weight; direction = Theil–Sen over the last 5 clean episodes; outlook = last 3 clean first weeks; score within ±8 of the weighted mean; each bullet cites one fact; withheld after 7 days; bands per check = ±max(10, min(30, swing)) / 2 points (rule 23); a formula bump re-derives the day and files the older read under `superseded` (rule 9); the chain heals a leftover stash-pop conflict on this file by a union by day (`chain-heal.mjs`) |
| "What matters" — five ranked actions | `insights[]` (each with `rank`, `serves`), `insightsStale[]` | recommendations.mjs (prompt v4, `ranked: true`, exactly five in lever order, W35) else build-data rule insights | fact sheet over every store + `context` (the day's health read states, direction words, outlook, launch words — words only); rate facts carry `ageDays`/`basis` | every number token must exist in today's fact sheet or the item is held back; no item compares a young episode's rate with a finished one's |
| Slack trends text | `slackTrends()` in build-data | build-data | `data.json` itself | must read the same exported numbers the page reads (validator 1e/1f parity) |
| "Data refreshed today · health read is behind" stamp | `generatedAt`, `health.ageDays`, `health.withheld` | build-data / health | — | says when the saved health read is behind the data; exact date in the hover title |

---

## 4. The two scorers side by side

| | Show health (`health.mjs`, formula `health-v4`, prompt v7) | Episode health (`ratings.mjs`, algorithm `health21-v2`) + launch word (`baselines.launchReadFor`) |
|---|---|---|
| Question | How healthy is the show *today*? | Did *this episode* beat the show's own bar at the time? |
| Cadence | one entry per Phoenix day (when ≥3 checks are available), recomputed from fresh stores | one entry per episode, written once its last snapshot is ≥21 d, frozen |
| Checks & weights | growth 25 · audience quality 20 · reach 15 · live pull 15 · conversion 10 · sentiment 15 | watch 35 · engagement 15 · retention 15 · live 15 · conversion 10 · sentiment 10 |
| Score form | per measure `round(clamp(50 × value / typical))`; check = mean of its measures; weighted mean over available checks (absolute-scale sentiment keeps its base weight; relative checks share the rest); model may move ±8 and must explain — and must name a check that joined/left when the set changed and the score moved >5 | per check `round(clamp(50 × own / typical))`; weighted mean over available checks; ≥2 checks and ≥50 % weight or reason |
| Peer set | `baselines.windowFor(episodeRead)`: the eight episodes before the episode the measure reads, outliers out, no reading out, coverage mismatch out; `MIN_PEERS` per measure | the eight episodes before the target, outliers **as flagged at freeze** out, `MIN_PEERS` per check |
| Age handling | `sameAge` for pace/engagement (snapshots) and, once history exists, share watched/subscribers (history lines); `mature` for reach (7 d) and the analytics measures until then; `ageFree` for live. Once a measure has been `sameAge` it never falls back | watch/engagement `sameAge` (snapshots); retention/conversion `sameAge` via day-21 history lines once every member has one, else `mature`; live `ageFree`; sentiment `mature` (comments within 21 d, common sources) |
| Missing data | measure null with reason; check shares missing weight (relative checks only); never zero | check drops out; weight redistributes; reason instead of score |
| Honesty stamps | `formulaVersion`, `promptVersion`, `promptHash`, `model`, `bundleHash`, `dataGeneratedAt`, `dataThrough`, `checkSet`, `checkSetChange`; per measure `ageBasis`, `note`, `window`, `excluded`, `episodeRead`, `readDate` | `algorithm`, `windowIds`, `excluded[]`, `atDay`, `frozenAtDay`, `readCompleteOn`, `frozenAt`, `reproducible`, `rederivedFrom`; per check `ageBasis`, `note`, `peers[]` |
| Rendered | one strip: small gauge with its band and direction words, the seven checks as words grouped by state (each name a tooltip drill with each measure's note, promo qualifier, carried note, and each check's reason), the headline whole, and Expand → the evidence with the reads-on line, Where it's heading (direction rows, the next first-week range, cool-off), the saved scores on a fixed scale, and the do-next actions (`index.html` `buildHealth`); the direction and outlook lenses are read from `data.baselines` (computed by build-data, copied into the entry) | carousel launch word (from `baselines.launch`, never a number) until the frozen chip exists, panel Launch tile with the numbers, then as before | carousel chip (silent when unscored), panel tile with notes / "Not compared" / the reason, neutral table column, Slack sequence of scored episodes only |
| Rebuilt by the validator | 1h: weights by formula, bases, notes, windows, `MIN_PEERS`, absolute-scale weight, checkSet, freshness/withhold, same-day recompute under the running formula | 1g: windows from `baselines.mjs`, typical and score from stored peers, snapshot-sourced peer values from the snapshot at the stored age, notes match bases |

Both read `baselines.trueMedian`; nothing else in the repo defines a median.

## 5. Model steps and their grounding contracts

Every model step follows the same shape: a **deterministic bundle** is built
from stores → one model call (fetch only, no SDK) → strict JSON → a validator
that rejects anything not traceable to the bundle → atomic write → on any
failure the previous store remains the public truth.

| Step | Bundle | Output contract | Enforced by |
|---|---|---|---|
| classify | new comments only (never re-labels) | relevance → sentiment → ≤2 themes from a controlled vocabulary; confidence; low-confidence + 10 % sample self-audited; disagreements → `review` (never surfaced) | golden-set gate; schema; `CLASSIFIER_VERSION` + prompt hash stamps; validator 1e recomputes every rollup |
| health | sub-scores + facts (each with `display`, `sources`, optional `requiredPhrase`) + compact context + `allowedScore` | `{score, headline (no digits, ≤100 chars), pros[2], cons[2], drivers[1–3]}`; each bullet copies exactly one fact's display value and cites its `factId`; banned words; no markup | `validateSynthesis` (two attempts, then skip); validator 1h re-checks the saved entry and, for today's entry under the current formula, re-derives the bundle from stores |
| recommendations | ~108-fact sheet (watch curves, sources, per-channel subs/watch, episode health, live, platform split, moments) | 4–7 `{id, category, text, recommendation}`; every number token exact-matches a fact; banned words | `validateItems`; validator 1n re-grounds the store each run and locks `data.insights` to it |
| moment-summaries | moment excerpts + shape facts | one sentence per moment; no quotes | validator 1m2 (store validated, verbatim into page, no orphan summaries) |
| critic | `data.json` + `index.html` (compact bundle; `coverage` and `live.chatters` preserved after two false positives) | five-lens markdown, ≤12 findings, one recommendation | never blocks; "Builder triage" section records fix / reject-with-evidence / queue |

The prompts are versioned files (`health-prompt.md`, `critic-prompt.md`,
`comments-classify-prompt.md`); a prompt change without a version bump is a
validator failure for the health prompt (hash compared when versions match).

---

## 6. The validator's contract map (`audit/validate.mjs`)

Blocks in file order, with what each locks (line refs at `96a4f2f`):

| Block | Locks |
|---|---|
| 1 / 1b / 1c | unit discipline: no plays on YT, views+plays only, impressions never summed, `*Info` flags consistent, plays status schema |
| 2 | cumulative views never drop (>2 % fails, less warns) |
| 3 | `partialHistory` = first snapshot > 5 d; partial ⇒ no first-week value |
| 4 | newest snapshot and `generatedAt` < 26 h; generatedAt ≥ newest snapshot |
| 5 / 5a / 5b | registry ⇔ episodes; transcripts ⇔ files ⇔ links; tags schema |
| 6 / 7 | artifact files present; `data.js` wraps `data.json`; **`data.json` byte-reproduces from stores** |
| 1d / 1e | featured quotes safe and verbatim; W8 store stamps, golden gate, every rollup recomputed, Slack/alerts parity |
| 1f | insight schema, live-chat sentence contract, pace three-peer gate, anomaly caveat wording |
| 1g | episode health: 21-day gate, pending markers, windowIds membership, weight math, definition-lock store ⇔ `episode.health`, "immutability" (re-run returns stored entries — tautological, PRD v9 F10) |
| 1m / 1m2 | watching export ranges and ordering; moments recompute-locked; summaries verbatim |
| 1n | recommendations re-grounded; `insights` ⇔ store |
| 1h | show health: schema, append-only vs HEAD, stamps, weighted mean, ±8, bullets cite facts, projection ⇔ `data.health`, trend gate ≥7; bundle re-derived from stores **only for today's entry under the current formula** |
| 1i | banned words over every reader-facing string |
| 1j / 1j2 | honesty gates present in page source (3-peer, 3-curve, quiet zones, retired absence copy absent, no `?? 0`) |
| 1k / 1p / 1q / 1r | card layout order and budgets, chart picker, page gutter, destination links |
| 1u | baselines: fixture test (`audit/baselines.test.mjs`) green; `data.baselines` re-derives; outlier windows exclude self; nothing below `MIN_PEERS`; `metrics.anomaly` matches the outlier test |
| 1v | chain: `chain.json` order sane; required input stores within 26 h of the build; publish pulls before it pushes |
| 1x / 1y / 1z | Slack/alert lines carry directions only on ≥`MIN_PEERS` samples (on data); no trend word over the episode-health sequence; every stored note is one of the fixed strings and reasons pass the plain-words ban; the page renders notes |
| warnings | unresolved broadcast latches, snapshot cadence gaps, a served health read behind the data or under an older formula |

Surface checks on `index.html` are source regexes: they prove wiring shape
(which data field a surface reads, that no median or threshold is computed
in the page), not rendered pixels. The day-1 screenshot review in the PRD's
verification plan covers the rest.

---

## 7. Known gaps and accepted debts

PRD v9 is implemented (W22a–W26, 2026-08-23). What remains, by design or deferred:

- **History depth.** `yt-analytics-history` starts 2026-08-23; share watched and subscribers compare `mature` until three peers carry a line at the needed age (≈E10 for same-age episode health; the show-health measures switch as soon as three peers have lines at the read episode's age). E2/E3 carry no episode score (one and two peers); E4 has none either (E3 is an outlier); E5 is expected to be the first, on the 07:25 run after 2026-09-03.
- **Sentiment at current volumes.** Episode-health sentiment and show-health commenters-per-1k stay absent until episodes average ≥10 directional comments; feedback counts and themes remain visible.
- **Recommendation fact sheet** still re-sums channel totals and traffic mix from the analytics files (F19, S3) instead of reading a projection from `data.json`; rate facts now carry a basis and the cross-basis guard holds.
- **Model steps need `ANTHROPIC_API_KEY` on the chain machine**: the served health read stays the 2026-08-22 `health-v1` entry (header says "health read is behind") and two recommendations are held back as stale until the next successful runs rewrite those stores.
- **X plays in scoring** would need the staleness verdict copied into snapshots first (F23).
