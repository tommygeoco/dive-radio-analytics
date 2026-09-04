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
