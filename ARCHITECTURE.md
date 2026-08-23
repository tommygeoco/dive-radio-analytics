# ARCHITECTURE.md — where every number comes from

Companion to `CLAUDE.md` (intent and rules). This file is the lineage: which
script writes which store, what each store's timestamps mean, and how each
number on the page is derived. Verified against commit `96a4f2f` (2026-08-23).
When code and this file disagree, the code is right and this file needs a
commit in the same change.

Contents: §1 chain and cadence · §2 stores and their time semantics · §3
number lineage (page → store → script → rule) · §4 the two scorers side by
side · §5 model steps and their grounding contracts · §6 the validator's
contract map · §7 known gaps (pointers to PRD v7)

---

## 1. Chain and cadence

Owner machine, 07:25 America/Phoenix daily. The publish half is documented in
`README.md`; the capture half below is reconstructed from the scripts' own
header comments (there is no versioned crontab — PRD v7 F22).

| Step | Script | Writes | Model? | On failure |
|---|---|---|---|---|
| discover | `scripts/restream/postlive-discover.mjs` | `data/restream/postlive-registry.json` (new episodes, 4 destinations) | no | warns; registry unchanged |
| transcripts | `scripts/restream/transcripts-pull.mjs` | `transcripts/<slug>.txt` (yt-dlp auto-captions, day 2+) | no | absent; retried next day |
| snapshot | `scripts/restream/postlive-track.mjs snapshot` | `data/restream/postlive/<slug>.json` (append) | no | destination absent from that snapshot |
| yt-analytics | `scripts/restream/yt-analytics-pull.mjs` | `data/restream/yt-analytics/<slug>.json` (overwrite) | no | file unchanged (stale `updatedAt`) |
| comments | `scripts/restream/comments-pull.mjs` | `data/restream/comments/<slug>.json` (append by id) | no | store unchanged |
| classify | `scripts/restream/comments-classify.mjs` | `data/restream/comments-classified.json` (append by id) | **yes** | previous labels stay; golden-set gate FAILs loudly |
| channel-stats | `scripts/restream/channel-stats-pull.mjs` | `data/restream/channel-stats.json` (one point/channel/UTC day) | no | day absent |
| live | `scripts/restream/ingest-restream.mjs` | `data/restream/events/<id>.json`, `state.json` | no | event retried |
| ratings | `tools/dive-analytics/ratings.mjs` | `data/restream/episode-ratings.json` (frozen entries) | no | — |
| build-data | `tools/dive-analytics/build-data.mjs` | `data.json`, `data.js` | no (imports `watch-moments.mjs`) | — |
| validate | `tools/dive-analytics/audit/validate.mjs` | — | no | **no publish** |
| health | `tools/dive-analytics/health.mjs` | `data/restream/health-history.json` (append, one/Phoenix day) | **yes** | previous entry stays public |
| recommendations | `tools/dive-analytics/recommendations.mjs` | `data/restream/recommendations.json` | **yes** | previous store stays |
| moment-summaries | `tools/dive-analytics/moment-summaries.mjs` | `data/restream/moment-summaries.json` | **yes** | moments render without context |
| build-data → validate | (again, so today's health entry is in the artifact) | | | |
| publish | `scripts/restream/postlive-publish.sh` | git commit + push `main`, `vercel deploy --prod`, live `generatedAt` parity | no | exits non-zero; **does not pull first** |
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
| `yt-analytics/<slug>.json` | per channel: `totals{views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, likes, comments}`, `retention[]` (100-point curve), `trafficSources[]`, `updatedAt` | yt-analytics-pull (all episodes, every run) | **overwrite; lifetime-to-date** (`startDate = premiere, endDate = today`) — no history | a 2-day-old and a 30-day-old episode's `averageViewPercentage` are not comparable; nothing can be age-pinned from this store (PRD v7 W19a adds a daily history) |
| `comments/<slug>.json` | comments by id with `firstSeenAt`, `likes`, source (`yt`/`x`), `xCoverage` | comments-pull | **append by id**; YouTube pulled forever, **X replies only within 7 days** of premiere | `xCoverage: "missed"` for E1–E5 — their feedback is YouTube-only while E6 includes X |
| `comments-classified.json` | per comment id: relevance, sentiment, themes, confidence, `classifiedAt`, version stamps; `lastRun` | classify | **append by id; a label is never re-read** unless `--reclassify-all` with a `CLASSIFIER_VERSION` bump | golden set (`audit/golden-comments.json`) gates every run: 100 % relevance / ≥95 % sentiment or previous labels stay |
| `comments-sentiment.json` | wordlist-v1 labels | (legacy; not in chain) | — | only `hasNegativeSignal()` is still used, as a featured-quote veto |
| `channel-stats.json` | per channel/host per UTC day: subscribers, totalViews, followers | channel-stats-pull | one point per day, first write wins | series started 2026-08-22; no trend yet |
| `events/<id>.json` + `state.json` | raw Restream analytics per live event | ingest-restream | **frozen at first ingest** (age-free: air night) | surfaced as `episode.live` |
| `episode-ratings.json` | `scores[]` one per finished episode: score, per-check `{value, typical, ratio, score, sample, weight}`, `windowIds`, `frozenAt` | ratings | **frozen forever within `algorithm`**; re-derived visibly on bump (`rederivedFrom`) | only watch/engagement read same-age snapshots; retention/conversion/sentiment read peers' *current* files on freeze day (PRD v7 F7) |
| `health-history.json` | `entries[]` one per Phoenix day: score, headline, pros/cons (fact-cited), subScores with measures `{value, typical, sample, score, reason}`, facts, stamps | health | **append-only, immutable**; newest entry ≤ today is served | typicals are recomputed daily from all prior non-anomaly episodes (lifetime, no window); the served entry has no maximum age (PRD v7 F2, F4) |
| `recommendations.json` | 4–7 items `{id, category, text, recommendation}`, every number grounded in the fact sheet | recommendations | overwrite on success | projected wholesale into `data.insights`; deterministic rule insights are only the no-store fallback |
| `moment-summaries.json` | per episode/moment: one model-written sentence | moment-summaries | overwrite on success | never a raw transcript quote |
| `alerts-state.json` / `alerts-pending.json` | last-seen values / queued lines | alerts | overwrite | no baselines; pure day-over-day diff |
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
| Pace ("#n of m at this age", ▲/▼ vs typical) | `showTrend.paceRank` (export) / `sameAgeSub()` (page) | build-data `sameAgePace` | snapshots at matching age | peers = prior episodes whose snapshots span the newest's age; **≥3 peers** or absent; median = upper-middle element (PRD v7 F18) |
| First-week trend card (views) | `showTrend.week1VelocityByEpisode` | build-data | snapshot at ≤ day 7 | null for `partialHistory` or < 7 d; page hides the verdict below 3 clean weeks; **Slack fires at 2** (PRD v7 F14) |
| Trend card (watched / reach / live) | page-computed from `watch.avgPercent`, `latest.xImpressions`, `live.peak` | `index.html` `buildHero` | — | newest vs previous episode, ±5 % quiet zone — lifetime-to-date values at unlike ages for watched/reach (PRD v7 F15) |
| Anomaly ("promo-driven outlier") | `metrics.anomaly` | build-data | `latest.*` of **all** episodes incl. self | >2× the true median of the same unit; excludes the episode from host/announce/topic comparisons and from show-health priors (PRD v7 F13) |
| Engagement per 1k | `metrics.engagementPer1k` | build-data | latest snapshot (YT likes+comments / YT views) | drifts with age; the insight gates at ≥7 d, show health does not (PRD v7 F1) |
| Live peak / chat / chatters | `live.*` | build-data | `events/<id>.json` | age-free (air night) |
| Share watched, avg time, minutes, curve, traffic | `watch.*` | build-data `attachWatch` | `yt-analytics/<slug>.json` | view-weighted blend across channels with reports; absent channel drops out; curve null until YouTube produces it; lifetime-to-date |
| Typical watch line (Watching chart) | page-computed | `index.html` | `watch.curve` of every episode with a curve, newest included | drawn only with ≥3 curves; median per point where all curves share the `at` |
| Watched vs typical (table ▲/▼) | page-computed | `index.html` `buildTable` | `watch.avgPercent` of all episodes incl. the row | ±5 % quiet zone (PRD v7 F16) |
| Drop-off moments + pins | `watch.shape`, `watch.moments` | build-data via `watch-moments.mjs` | curve + transcript | deterministic; floor 2.0 points; ≤3 drops + 2 holds; summary text from `moment-summaries.json` |
| Feedback counts, themes, featured quotes, commenters per 1k | `comments.*`, `commentSummary` | build-data `summarizeComments` | `comments-classified.json` ∩ `comments/<slug>.json` | only `ready` + `feedback` labels surface; `commentersPer1k` only when X coverage is complete and plays are not partial/stale |
| Episode health chip / panel / table / Slack | `episode.health` | **ratings.mjs** | snapshots (watch, engagement), yt-analytics (retention, conversion), events (live), classified comments (sentiment) | §4; ≥21 d; frozen; window-relative |
| Show health score, headline, six checks, pros/cons | `health` | **health.mjs** (deterministic checks) + model synthesis | snapshots, yt-analytics, classified comments, `showTrend`, `episode.health` | §4; one entry per Phoenix day; score within ±8 of the weighted mean; each bullet cites one fact |
| "What matters" | `insights[]` | recommendations.mjs (store) else build-data rule insights | fact sheet over every store | every number token must exist in the fact sheet; banned words enforced |
| Slack trends text | `slackTrends()` in build-data | build-data | `data.json` itself | must read the same exported numbers the page reads (validator 1e/1f parity) |
| "Data refreshed today/yesterday" stamp | `generatedAt` | build-data | — | tracks the *build*, not the health entry's date (PRD v7 F4) |

---

## 4. The two scorers side by side

| | Show health (`health.mjs`, formula `health-v2`, prompt v2) | Episode health (`ratings.mjs`, algorithm `health21-v1`) |
|---|---|---|
| Question | How healthy is the show *today*? | Did *this episode* beat the show's own bar at the time? |
| Cadence | one entry per Phoenix day, recomputed from fresh stores | one entry per episode, written once at ≥21 d, frozen |
| Checks & weights | growth 25 · audience quality 20 · reach 15 · live pull 15 · conversion 10 · sentiment 15 | watch 35 · engagement 15 · retention 15 · live 15 · conversion 10 · sentiment 10 |
| Score form | per measure `round(clamp(50 × value / typical))`; check = mean of its measures; weighted mean over available checks; model may move ±8 and must explain | per check `round(clamp(50 × own / typical))`; weighted mean over available checks; ≥2 checks and ≥50 % weight or reason |
| Peer set | all prior episodes, anomaly-excluded, no window | up to 9 prior episodes, anomaly **included**, no minimum count |
| Age handling | same-age pace ✔; engagement / watch-% / subscribers compare newest-at-its-age vs priors-at-theirs ✘; reach waits for a finished episode ✔ | watch & engagement same-age ✔; retention / conversion / sentiment read peers' current values on freeze day ✘ |
| Missing data | measure null with reason; check shares missing weight; never zero | check drops out; weight redistributes; reason instead of score |
| Honesty stamps | `formulaVersion`, `promptVersion`, `promptHash`, `model`, `bundleHash`, `dataGeneratedAt`, `dataThrough`; facts with `requiredPhrase` ("still early") | `algorithm`, `windowIds`, `atDay`, `readCompleteOn`, `frozenAt`, `basis` string, `rederivedFrom` |
| Rendered | gauge + six-word diagnosis + today's read + evidence drill-in (`index.html` `buildHealth`) | carousel chip, panel breakdown with ▲▼≈, table column, Slack sequence |
| Known gaps | PRD v7 F1–F6 | PRD v7 F7–F12 |

Both read `true median`; `build-data.mjs` has a third median (anomaly, true;
pace, upper-middle). PRD v7 rule 16 consolidates into one `baselines.mjs`.

---

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
| 1g | episode health: 21-day gate, pending markers, windowIds membership, weight math, definition-lock store ⇔ `episode.health`, "immutability" (re-run returns stored entries — tautological, PRD v7 F10) |
| 1m / 1m2 | watching export ranges and ordering; moments recompute-locked; summaries verbatim |
| 1n | recommendations re-grounded; `insights` ⇔ store |
| 1h | show health: schema, append-only vs HEAD, stamps, weighted mean, ±8, bullets cite facts, projection ⇔ `data.health`, trend gate ≥7; bundle re-derived from stores **only for today's entry under the current formula** |
| 1i | banned words over every reader-facing string |
| 1j / 1j2 | honesty gates present in page source (3-peer, 3-curve, quiet zones, retired absence copy absent, no `?? 0`) |
| 1k / 1p / 1q / 1r | card layout order and budgets, chart picker, page gutter, destination links |
| warnings | unresolved broadcast latches, snapshot cadence gaps |

What it does **not** check today (PRD v7 §6 adds these): the age at which
compared values were measured; which episodes form a typical; the served
health entry's age; any store's `updatedAt` vs `generatedAt`; direction-badge
and band semantics; pace/anomaly values themselves.

---

## 7. Known gaps

All open reliability work is in `prd-analytics-v7-baselines-and-comparison-2026-08-23.md`
(findings F1–F34, owner decisions D1–D7). Summary: lifetime baselines, unlike-age
comparisons in both scorers, no minimum peer count in episode health,
non-reproducible freezes, no freshness bound on the served health read, three
independent "typical" implementations, no analytics history store, an
undocumented capture chain, a publish script that pushes without pulling, two browser-side typicals (watching curve, per-row pace), and a recommendation fact sheet that hands the model unlike-age rates.
