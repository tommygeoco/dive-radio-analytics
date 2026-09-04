# PRD — Analytics v13: source and schedule reliability (2026-09-04)

**Owner:** Tommy. **Status:** approved for immediate implementation by the
2026-09-04 reliability directive. **Scope:** the existing source stores, daily
runner, recovery runner, validation gates, and current OpenClaw jobs. This PRD
adds no measure and changes no dashboard layout.

The owner's latest request explicitly names the current cron jobs and asks that
they be fixed now without another approval step. That narrow authorization
supersedes the earlier operator-wires-cron rule for the transcript and recovery
jobs named here; it does not authorize changes to unrelated jobs.

## 1. Outcome

Every unattended morning must end in one of two truthful states:

1. production contains the newest complete readings that the sources returned,
   every required check passed, and every public file matches the release; or
2. a source value is unavailable, production says it is unavailable instead of
   showing zero or combining incompatible readings, the saved run state names
   that condition, and the existing alert path tells the owner after the final
   daily recovery check.

An OpenClaw job is successful only when the command it owns succeeds. A wrapper
must never turn a failed inner command into a green job.

## 2. Rules

These extend, and do not weaken, the v5 constitution and v11 publish rules.

27. **Two YouTube channels are one saved reading.** The current watch store may
    advance only when every registered channel for the episode returned a usable
    watch report in the same pull, for the currently registered video ids. A
    partial pull never updates one saved channel by itself.
28. **A saved reading has one time.** Every channel in a complete current watch
    reading has the same valid `pulledAt`. A mixed-time reading is incomplete and
    cannot enter `data.json`, history, health, ratings, or any comparison.
29. **A new check cannot erase an exact reading.** When a pull is incomplete, the
    prior `channels` block and `updatedAt` remain byte-for-byte only when the whole
    cohort belongs to the current video ids. Otherwise `channels` is empty and
    `updatedAt` is absent. Current incomplete evidence lives only in
    `watchReport.probes`; it can never enter a calculation.
30. **Waiting is bounded and visible.** The registry stores an air date, not an
    exact start time, so future shows are not queried and an empty report on the
    Phoenix air date is saved as idle: neither a failure nor a first-day reading.
    Starting on the next Phoenix date it is saved as waiting. The 08:15 check
    preserves the remaining run for 12:15. If the final allowed attempt still
    finds no complete report, one dated plain alert is queued for that Phoenix day
    and marked in the existing daily ledger so repeated checks do not resend it.
    The source is tried again on later days; a later complete reading plus proven
    production clears any undelivered stale source warning. No zero, guess, or
    fabricated history is written.
31. **Retries keep their meaning.** A required platform step runs at most twice.
    `hard error → success` succeeds, `hard error → waiting` publishes honest
    waiting data, and `hard error → hard error` stops and alerts. Waiting itself
    is not retried inside the same chain because the reserved full run owns the
    later check.
32. **Job status follows command status.** Script-backed OpenClaw jobs inspect the
    structured exit code returned by `exec`, throw on nonzero or missing status,
    and return no message for a successful no-change run. Existing failure alerts
    remain enabled after one error.
    `run-chain` exit 20 is a typed non-failure result meaning production was
    published with an honestly unavailable newest watch report. Only `run-daily`
    may translate that typed result to scheduler success after the chain has
    completed its release path.
33. **Current production is proved, not inferred.** Every release still requires
    validator exit 0, a checked Git push, a checked Vercel production deployment,
    exact public-file parity, and an independent cache-busted read of
    `data.json.generatedAt`.

## 3. Store contract

`data/restream/yt-analytics/<slug>.json` keeps the existing fields and meanings.

- `channels` is either empty or one current cohort. A cohort contains exactly the episode's
  registered YouTube channels, current `videoId` values, one shared valid
  `pulledAt`, and usable positive `views` plus a real
  `averageViewPercentage` for every channel.
- A pull is staged in memory. It replaces `channels` only as a whole. If staging
  is incomplete, an earlier complete current-id cohort stays unchanged as a
  whole. If no such cohort exists, `channels` is empty.
- `updatedAt` advances only with a new complete cohort. `watchReport.checkedAt`
  advances with every source check. A waiting report also stores `pendingSince`,
  preserving the first consecutive waiting check; a hard failure, ready result,
  or target-id change clears it. Existing waiting stores migrate from their prior
  `checkedAt`. `pendingSince`, the target fingerprint, and probes remain internal
  source evidence and are not exported to `data.json`.
- `watchReport.probes` contains one row per registered channel:
  `{key, videoId, result, observed}`. Result is `ready`, `no-row`, `zero-views`,
  `missing-share`, or `request-failed`. `observed` distinguishes an explicit zero
  from absence but is never a dashboard value.
- `watchReport.state` is `idle` for an incomplete air-date check, `pending` for an
  incomplete later-date check, `failed` for a source request error, or `ready` for
  a complete check. Idle state and all probes stay internal; the existing public
  waiting summary is unchanged.
- `yt-analytics-history/<slug>.jsonl` accepts a line only from the newly staged,
  complete same-pull cohort. It never appends from a preserved older cohort,
  never writes on the air date, and never treats zero or absence as day one. Its
  one-writer append is locked and replaced atomically; ignored temp locks cannot
  dirty the publisher after an interruption.
- `build-data.mjs` accepts only a complete cohort whose channel ids, video ids,
  and pull time agree with the registry. It continues to export the existing
  watch shape; no new public field is added.

## 4. Scheduler contract

The existing schedule remains one system:

- 06:50 Restream ingest prepares live-event source data.
- 07:00 `restream-postlive-snapshot` calls `run-daily.mjs --primary`.
- 08:00 transcript mirror copies any newly released transcript into the owner
  vault and refreshes search only when needed.
- 08:15 and 12:15 `restream-postlive-freshness` prove production and own the one
  reserved recovery run. Either check repairs any unproved production state when
  an attempt remains; an honest YouTube wait at 08:15 reserves the run for 12:15.
- every five minutes `dive-alerts` delivers queued warnings and removes them only
  after a Slack receipt.
- Monday noon reporting stays read-only.

Schedules, delivery targets, time zones, run limits, and secrets do not change.
The transcript wrapper changes only its exit handling. The recovery description
is corrected to match its two daily checks.

## 5. Failure paths and required results

| Path | Required result |
|---|---|
| Future episode | no source request, history, waiting attempt, or zero |
| Empty report on its Phoenix air date | internal idle check; no history, waiting attempt, or zero |
| Empty report starting the next Phoenix date | waiting state; current production may publish without a watch number |
| Both channels become ready in one pull | replace the whole cohort; append at most one eligible history line |
| One channel ready, one empty | replace neither saved channel; append no history; publish no mixed reading |
| One channel request fails | replace neither saved channel; retry once; then stop and alert if it fails again |
| Saved cohort belongs to old video ids | do not carry it into the new registration |
| Saved channels have different pull times | withhold the watch block and fail store validation |
| First attempt fails, retry is ready | continue normally |
| First attempt fails, retry is waiting | continue, publish, and preserve the later daily recovery |
| Both attempts fail | stop before release and queue one alert |
| Final allowed attempt still waiting | production remains current; queue and durably mark one dated plain missing-watch alert for the day; refuse a third run |
| Daily state or alert queue is missing/corrupt | fail closed; never silently reset the attempt cap or discard an alert |
| Another run owns the lock | bounded wait/check, then fail and alert without touching its checkout |
| 07:00 and 08:15 were missed or never reached capture | 12:15 uses an available bounded attempt, then proves production |
| Git, deploy, or parity cannot be proved | bounded retry, then fail and alert; never claim current production |
| Transcript inner command exits nonzero or gives no status | OpenClaw job fails and its configured alert fires |
| Transcript succeeds with no new file | job succeeds silently |

## 6. Workstreams

### W42 — atomic YouTube watch cohorts

- Stage every channel response before mutating an episode store.
- Add one shared completeness function for same-time, current-id cohorts.
- Preserve either the whole previous cohort or none of it.
- Store each incomplete check only as non-public probes under `watchReport`.
- Build history only from the staged complete cohort.
- Require every registered channel in a history line to carry positive views and
  a real watched-share value; legacy empty lines stay as non-reading evidence.
- Extend validator and fixtures for mixed time, partial pull, video-id change,
  first pull, preservation, and complete replacement.

### W43 — waiting and recovery truth

- Treat the air date as non-history and begin waiting on the next Phoenix date,
  matching the date-only registry contract.
- Apply waiting handling after a platform retry as well as before it.
- Keep 08:15 defer and 12:15 recovery behavior.
- Queue and mark one daily plain alert when the final allowed run still ends
  waiting, while keeping the operational job green because production was
  honestly updated. Key this to attempt two, not the caller's mode, because the
  08:15 recovery can be attempt one when 07:00 never started.
- Exercise the attempt cap, day reset, and all four retry transitions without a
  live third chain run.

### W44 — OpenClaw job truth

- Replace the transcript mirror's shell-status wrapper with structured exit-code
  handling and failure propagation.
- Correct the recovery job description without changing its command or schedule.
- Read back every field after editing and manually run the transcript job once.
- Run the recovery job once after release; it must prove current production and
  avoid spending a third chain attempt. A repo-owned `--proof-only` path must
  exist first so verification can never start capture or consume an attempt; it
  passes only for a completed checklist or the typed YouTube-waiting state.

### W45 — release proof and continuing checks

- Run every focused source, runner, recovery, alert, publish, and parity fixture.
- Run the required local ratings → build-data → validator chain.
- Commit scoped concerns, push `main`, deploy production, compare all public
  artifacts, read cache-busted production `generatedAt`, and capture the final
  dashboard screenshot.
- The rolling operational acceptance target remains fourteen consecutive
  unattended mornings. A day passes when production is current and exact, the
  checklist is passed or typed-waiting, and any typed-waiting alert has a Slack
  receipt. A stale build, parity mismatch, unreported failure, duplicate automatic
  run, or missing required receipt resets the streak. Evidence stays in the daily
  state, 30-day chain log, OpenClaw run history, production stamp, parity output,
  and alert delivery receipt; a code commit alone is not evidence.

## 7. Non-goals

- No new dashboard number, card, chart, copy block, or interaction.
- No new platform, source, model call, package, or runtime dependency.
- No estimate or backfill for E8 or any future episode.
- No mutation of frozen episode ratings.
- No third automatic full-chain attempt on a Phoenix day.
- No broad cron rewrite, new scheduler, or secret movement.

## 8. Immediate acceptance

1. Atomic cohort fixtures prove partial or mixed-time data cannot be consumed.
2. Runner fixtures prove `[20]`, `[1,20]`, `[1,0]`, and `[1,1]` outcomes.
3. Date fixtures prove future shows are skipped, air-date absence is idle, the UTC
   evening boundary still uses the Phoenix date, and next-date absence is waiting,
   while history continues to reject the air date.
4. Daily/recovery fixtures prove one alert after the reserved run remains waiting,
   the third attempt is refused, and the next Phoenix day resets the allowance.
5. `validate.mjs` exits 0 on the release tree and fails a deliberately invalid
   in-memory or temporary cohort fixture. Tests never mutate canonical E8 data,
   source history, or frozen ratings.
6. A deterministic transcript-wrapper fixture rejects nonzero and missing inner
   exit status. OpenClaw readback then matches every preserved field; a transcript
   manual run is truly green; a recovery manual run proves current production
   without new capture.
7. GitHub `main`, the deployed Vercel release, local public bytes, and production
   `generatedAt` all agree; the final browser view contains no fabricated watch
   value.

## 9. Rollback and recovery

The code change is additive to the existing store shape and accepts every current
valid cohort. Reverting the code restores the earlier reader, but source stores
written under this PRD remain readable because the added `watchReport` members are
optional and ignored by the old public projection. The daily alert marker is
optional runtime state. Cron changes are narrow field edits and can be restored
from the read-before snapshot. Interrupted store writes remain atomic temp-file
renames. Re-running a pull is safe: current totals overwrite only as a complete
cohort and history remains one immutable line per eligible Phoenix date.

## Status log

- 2026-09-04 11:10 MST — PRD written after live production parity, direct
  two-account YouTube checks, current scheduler history, and the existing fixtures
  were audited. Implementation begins only after this contract is committed to the
  working tree.
- 2026-09-04 11:43 MST — implementation `cd278c9` passed 30 deterministic tests,
  strict validation with 0 failures and 0 drift, frozen-entry byte comparison,
  GitHub and Vercel release, 16-file production parity, both cron readbacks, and
  successful transcript and recovery manual runs. E8 watched share remains
  honestly absent because both current owner reports still contain no rows.

## 10. End-to-end re-audit contract (2026-09-04, supersedes earlier completion claims)

The owner requested a fresh audit and repair of every existing production path.
Baseline `94d65170dc92245f86544066a99635bb68d7f95a` is evidence to compare,
not an acceptance result. The launch checkout and runtime clone were clean main
at that baseline and GitHub matched on this audit's first fetch. The unrelated
`~/Dev/2026/dive-radio-analytics` agent branch is dirty and must remain untouched.
Implementation runs in isolated concern branches; production runs only from a
clean, current main checkout with its installed, verified repository hook.

### Ownership, lineage, definitions and clocks

All source owners below are the existing Dive Radio owners. The chain machine is
the sole canonical capture writer. Every new reading must carry or inherit from
its containing record: source, episode slug, source object ID, pull timestamp and
completeness state. Historical records without these fields must remain clearly
legacy evidence; missing provenance must never be invented or backdated.

| Source / owner | Source IDs and raw response | Canonical stores / writer | Existing public consumers and units | Schedule |
|---|---|---|---|---|
| YouTube Data / Dive Club and DesignerTom | registered channel ID and episode video ID; statistics and liveStreamingDetails | registry, postlive snapshots, source receipts / discover + track | views are counts; likes and comments are counts; totals, first weeks, pace, charts, health, agent brief | daily full chain and one recovery |
| YouTube owner Analytics / both registered accounts | OAuth owner, exact registered video ID, report dates, full totals/retention/traffic response | yt-analytics + yt-analytics-history / yt-analytics-pull | watched share percent; average duration seconds; estimated watch time minutes; subscriber counts; retention fraction; traffic views | daily full chain and one recovery |
| X / ridd_design and designertom | exact post ID, account ID, resolved broadcast ID; API public metrics and broadcast counter | registry, postlive snapshots, source receipts / discover + track | impressions are reach; broadcast plays only enter views; tweet/teaser videos never enter plays | daily full chain and recovery |
| Restream / existing owner account | event ID matched to exact destination video/broadcast IDs; summary, minute and destination responses | events + state / ingest-restream | peak and average concurrent viewers; live views count; seconds converted once to watched minutes; minute samples with unsampled null | 06:50 ingestion and chain live step |
| Transcript / owner vault or YouTube captions | exact episode/date/title and source file or registered video ID | transcripts / transcripts-pull; owner vault / mirror-transcripts | transcript link, chapters and grounded moments; timestamps seconds on the documented source clock | chain pull; 08:00 mirror/recovery |
| Beehiiv / UX Tools owner | issue ID, exact registered target URL, tracked link ID, provider click records | beehiiv-promotions / beehiiv-promotions-pull | tracked email clicks and verified clicks are separate counts, never views or summed unique readers | daily full chain and recovery |
| YouTube/X comments / both owners | comment/reply ID, video/post ID, pagination response and capture time | comments / comments-pull; labels / dedicated classifier | verified feedback counts, themes and commenters; pending/review/noise never public | daily full chain |
| Channel audience / both owners | channel/user ID and complete statistics response | channel-stats / channel-stats-pull | existing audience history counts only; no new surface | daily full chain |
| Frozen ratings / deterministic writer | validated source cohorts and stored peer inputs | episode-ratings / ratings | existing episode scores and their components; existing frozenAt entries byte immutable | chain before build |
| Model summaries / dedicated scripts | validated deterministic fact bundle and model/prompt stamps | health-history, recommendations, moment-summaries, chapters | existing scores, prose and transcript-grounded material; unavailable/stale facts withheld | existing model steps only |
| Publication / chain machine | validated source stores, exact Git SHA, generatedAt, deployment ID/URL and per-file hashes | public artifacts + durable runtime receipts | dashboard, agents page, data.json/data.js, agent files, chart library, every served transcript | daily and recovery, proof checks without attempt |
| Operations / OpenClaw | job ID, structured child exit, attempt ID and Phoenix date | runtime daily ledger, source states, alert queue and delivery receipts | freshness stamp, existing source-state text, owner alerts | primary, recovery, alert and weekly jobs verified live |

Phoenix calendar dates govern air dates and daily attempts. UTC timestamps remain
ISO instants. Future episodes are not queried and do not create missing warnings.
Same-day absence is idle until the next Phoenix day. A complete source zero is
valid for count metrics; an undefined denominator produces an unavailable rate.
A zero-view watch report cannot define watched share and cannot start history.

States are: missing (no validated source record), pending (valid source response
has not supplied the report), ready (all required IDs/fields/times validate),
failed (request, parsing or validation failed), stale (previous valid reading,
with its original time), and future (not eligible for capture). These are internal
contracts projected through existing public fields/copy. No new dashboard measure
or section is authorized. Partial evidence remains internal. A current incomplete
pull never enters public data/history; any preserved last complete cohort keeps
its original time and explicitly stale/unavailable semantics.

### Atomicity, retry, release and recovery

All canonical writes use unique same-directory temporary files and atomic rename.
Read-modify-write operations require a cross-process lock held through promotion;
locks identify the owner and do not evict a live writer merely because time passed.
Malformed existing stores fail closed rather than silently reset. API requests
have finite deadlines, finite retries and checked status/JSON/schema/pagination.
Complete episode/channel cohorts are staged before promotion. No partial or
mixed-time cohort can become history, ratings, health or a public number.

Publication executes ratings, build, strict validator, all audit fixtures and
syntax checks before every push/deployment. Hooks must test in temporary copies
and preserve every byte of caller work. Release checks exact origin/main, branch,
HEAD, cleanliness, project identity and every child status. The deploy command is
`vercel deploy --prod --yes`; a URL alone is insufficient. Cache-busted production
reads must match local generatedAt and every expected public file, including the
vendored chart library and all declared transcripts. A durable receipt records
Phoenix date, attempt, source states, SHA, generatedAt, deployment and per-artifact
proof before a run may finish successfully. Proof-only checks spend no attempts.

A failed or pending day is recoverable under the two-attempt cap. One specific
cause plus the last successful production proof is recorded durably. Alert
attempts and confirmed Slack delivery receipts survive restarts; failed delivery
never discards the queue. A warning resolves only after source readiness and
production proof both pass. Controlled scheduler fixtures use separate temporary
stores/ledger/queue and are marked synthetic; they never spend or reset actual
production attempts or masquerade as real source readings. Actual production
proof is captured separately. No reboot or future morning streak is claimed from
fixtures; persisted configuration, stale-owner recovery and future run receipts
are the immediate evidence.

### Failure risks and executable acceptance

Every fixture uses temporary stores; real source failures are not injected into
canonical analytics. Tests below are required implementation deliverables, not
claims that the baseline already satisfies them.

| Failure risk | Required automated evidence / exact fixture suite |
|---|---|
| Missing/invalid credentials; timeout; rate limit; 4xx/5xx; malformed JSON; empty body | source-io.test.mjs plus source pull fixtures: bounded calls, nonzero error, no numeric promotion |
| Partial channels; wrong/stale IDs; mixed pull timestamps; zero versus absent | youtube-missing-data.test.mjs, youtube-readiness.test.mjs, youtube-validator-negative.test.mjs, source-receipts.test.mjs |
| Late source result; Phoenix/UTC rollover; future/same-day episode | youtube-release-date.test.mjs, episode-date-sync.test.mjs, run-daily.test.mjs, recover-publish.test.mjs |
| Missing transcripts/newsletter/X/live results | transcripts-pull.test.mjs, beehiiv-promotions.test.mjs, x-broadcast-plays.test.mjs, ingest-restream.test.mjs |
| Failed/partial/paginated comments or channel response | comments-pull.test.mjs, channel-stats.test.mjs: no false coverage or successful reading |
| Stale stores; partial history; source-less number; frozen-rating mutation | source-integrity.test.mjs, youtube-zero-downstream.test.mjs, full validate.mjs negative fixtures |
| Concurrent runs, lock contention, interrupted write, stale lock after crash | source-io.test.mjs, alert-queue.test.mjs, run-daily.test.mjs: prior bytes intact and no duplicate history |
| Dirty/stale/wrong release checkout; hook clobbers work | publisher-checkout.test.mjs, publish-git.test.mjs, release-gate.test.mjs |
| Build or validator failure; child no status; timeout; deploy failure | publish-flow.test.mjs, release-gate.test.mjs, run-chain-policy.test.mjs, scheduler-contract.test.mjs |
| Deployment URL succeeds but alias/cache stale or any public file differs | live-parity.test.mjs, publish-flow.test.mjs; exact bytes and stamp required |
| Alert delivery failure; crash after send; later source readiness clears warning | alerts-delivery.test.mjs, alert-queue.test.mjs, recover-publish.test.mjs; durable delivery/resolve evidence |
| Scheduler restart/reboot; duplicate recovery; attempts exhausted; proof-only | run-daily.test.mjs, recover-publish.test.mjs, scheduler-contract.test.mjs; persisted live readback plus controlled manual scheduler executions |

Final acceptance requires all audit files and syntax checks pass, exact strict
validator exit 0, baseline frozen-entry byte comparison, current source states,
real scheduler manual run IDs/statuses, final SHA equal origin/main, clean release
trees, deployment identity, all-public-file parity, browser screenshots, durable
receipt and alert state. Immediate proof and future unattended evidence are
reported separately. The old completion checkboxes above are historical only.
