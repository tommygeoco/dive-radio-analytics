---
summary: "Execution plan for atomic source stores and truthful unattended Dive Radio publishing."
read_when:
  - Changing Dive Radio source-store writes, daily runners, recovery jobs, or OpenClaw schedules.
---

# Execution Plan: Analytics v13 reliability

## Purpose / Big Picture

Make the current Dive Radio data and schedule safe for unattended decisions. A
partial source response must never become a blended number, every automatic path
must recover or alert with its real status, and production must be proved from the
same bytes that passed validation. No new data or UI is in scope.

## Progress

- [x] 2026-09-04 11:10 MST - audited production parity, source responses, current stores, runner tests, and OpenClaw histories.
- [x] 2026-09-04 11:10 MST - wrote the v13 source and schedule reliability PRD.
- [x] 2026-09-04 11:33 MST - implemented atomic YouTube cohorts, locked history writes, and source-store validation.
- [x] 2026-09-04 11:33 MST - implemented retry, idle, waiting, final-attempt alert, and proof-only behavior with executable fixtures.
- [x] 2026-09-04 11:35 MST - passed 30 deterministic tests and the ratings to build to strict-validator release gate without changing a frozen score.
- [x] 2026-09-04 11:41 MST - updated and proved the transcript and recovery OpenClaw jobs without consuming another daily attempt.
- [x] 2026-09-04 11:43 MST - pushed main, deployed production, proved 16-file parity and the production time, and captured the dashboard.

## Surprises & Discoveries

- A successful response for one YouTube channel can currently replace that channel
  while the other channel retains an older reading. Both blocks remain usable, so
  the exporter can combine two different pull times.
- `run-chain.mjs` recognizes YouTube's waiting exit before its retry, but not after
  it. A hard error followed by a normal waiting response is therefore fatal.
- The transcript cron's inner command exited 1 on September 3 and 4, but its shell
  wrapper failed on zsh's read-only `status` variable and then returned a message,
  so OpenClaw recorded both runs as successful.
- Today's two permitted whole-chain attempts are already recorded. Acceptance must
  not spend a third attempt; transition behavior is covered by injected fixtures.
- A preregistered future show could make a waiting aired show look old, while the
  puller's UTC date could move one day ahead of Phoenix during the evening. Future
  shows now stay idle and every source date uses the Phoenix boundary.
- Recovery mode does not necessarily mean attempt two: if 07:00 never starts, the
  08:15 recovery is attempt one. Final alerts and no-third-run copy now follow the
  saved attempt number.
- A proof-only check could previously call fresh public bytes green with a missing
  or unreadable checklist. It now requires either a passed checklist or the exact
  typed YouTube-waiting outcome.
- The watch-history writer rewrote the JSONL file without an atomic rename. It is
  now serialized with an ignored crash-recovery lock and atomically replaced.
- A queued missing-watch warning could outlive the missing source if Slack was
  unavailable. It now has its own resolution class and clears only after a
  complete watch reading is proved on production.
- Noon handled only typed YouTube waiting, so a missed 07:00 and 08:15 could leave
  production stale despite an unused attempt. Both scheduled checks now repair any
  unproved production state; the ledger still refuses attempt three.

## Decision Log

- 2026-09-04: Treat every episode's registered YouTube channels as one transaction.
  Either the whole same-pull cohort advances, the whole prior current-id cohort
  stays, or channels is empty. Partial evidence lives only in internal probes.
- 2026-09-04: The registry has only an air date. Air-date absence remains idle and
  non-historical; waiting and recovery begin on the next Phoenix date rather than
  claiming an exact premiere time the source does not store.
- 2026-09-04: Keep expected source delay publishable, but queue a plain alert when
  the reserved recovery still ends waiting. This separates honest absence from an
  operational publishing failure without allowing indefinite silence.
- 2026-09-04: Do not add an extra automatic run. The two-attempt cap remains the
  protection against loops, duplicate platform calls, and repeated releases.
- 2026-09-04: Change only the faulty OpenClaw job fields and verify all preserved
  fields by readback. This is within the owner's latest explicit request to repair
  the current cron jobs now; unrelated jobs remain read-only.
- 2026-09-04: Add proof-only recovery verification before manually exercising the
  recovery job, so today's exhausted attempt ledger can never start capture.
- 2026-09-04: Skip future shows, store incomplete air-date checks as internal idle
  evidence, and start `pendingSince` only on the next Phoenix date.
- 2026-09-04: Decide final-source alerting from the saved attempt number and include
  the Phoenix date in the line so an undelivered earlier warning cannot suppress a
  later day's event.

## Outcomes & Retrospective

The source and schedule contract shipped in `9ffd1d3`; implementation shipped in
`cd278c9`. A watch reading now advances only as one complete same-pull set, history
writes are locked and atomic, future and air-date gaps stay idle, both scheduled
recovery windows can repair a missed morning, final missing-source alerts are dated
and durable, and stale source alerts clear only after ready data is proved live.

Production at `https://dive-radio-analytics.vercel.app` served local
`generatedAt` `2026-09-04T18:35:22.692Z`, and all 16 public artifacts matched.
E8 still has no YouTube watch report from either owner account, so its watched
share remains absent and explicitly waiting; its existing YouTube views, X plays,
live-event facts, transcript, and newsletter facts remain source-backed.

The transcript and production-proof jobs both completed real manual runs with
status `ok`. The daily ledger remained at exactly two prior passed attempts. The
fourteen-morning unattended observation gate begins with the next 06:50/07:00 run;
it cannot be truthfully claimed from a same-day manual proof.

## Context and Orientation

- Product contract: `tools/dive-analytics/prd-analytics-v13-source-and-schedule-reliability-2026-09-04.md`
- Source readiness rules: `tools/dive-analytics/youtube-readiness.mjs`
- YouTube store writer: `scripts/restream/yt-analytics-pull.mjs`
- Deterministic public projection: `tools/dive-analytics/build-data.mjs`
- Honesty gate: `tools/dive-analytics/audit/validate.mjs`
- Chain retry policy: `tools/dive-analytics/run-chain.mjs`
- Daily ledger and cap: `tools/dive-analytics/run-daily.mjs`
- Production recovery: `tools/dive-analytics/recover-publish.mjs`
- Versioned schedule definition: `tools/dive-analytics/chain.json`
- External scheduler: OpenClaw jobs on the owner machine; their state is not stored
  in Git and must be proved by readback plus run history.

## Plan of Work

- In scope: atomic watch-store writes, cohort validation, honest air-time waiting,
  retry transitions, recovery alerts after the final daily check, scheduler wrapper
  truth, tests, docs, release, parity, and visual proof.
- Out of scope: new measures, new UI, new sources, new packages, rating changes,
  estimates, backfill, or a third automatic run.

## Architecture Impact

- Impacted architecture areas: L1 YouTube store write semantics, L2 acceptance of
  watch cohorts, daily runner outcome states, recovery alerts, and the transcript
  job boundary.
- Invariants affected: absence is not zero; a number has one source cohort; history
  is append-only; frozen ratings do not move; two automatic attempts; job status
  equals owned-command status; validation precedes release.
- `ARCHITECTURE.md` update needed? yes.
- README and CLAUDE guidance also need narrow updates because the operational
  schedule and source-store contract are contributor-facing behavior.

## Concrete Steps

1. [complete] Add a shared same-pull, current-video cohort contract and stage the
   complete YouTube episode pull before changing its store or history.
User benefit: decisions cannot be based on two channels measured at different times.
2. [complete] Make build and validation reject mixed-time or wrong-video cohorts and
   add regression fixtures for preservation, replacement, and first incomplete pull.
User benefit: a malformed store fails closed before any number reaches production.
3. [complete] Make the chain handle waiting after a retry, preserve the two-run cap,
   and durably mark one alert after the reserved recovery still lacks watch data.
User benefit: expected source delay no longer blocks the day's other facts or stays silent indefinitely.
4. [complete] Repair the transcript OpenClaw wrapper and correct recovery wording,
   add proof-only recovery, and preserve every schedule, destination, timeout, and
   failure-alert field.
User benefit: green cron history once again means the owned command actually succeeded.
5. [complete] Run focused fixtures and the ratings to build to validator chain, update
   docs, then commit the source reliability concern.
User benefit: every changed behavior is reproducible without risking a third live run today.
6. [complete] Push, deploy, prove exact public parity and production time, manually
   exercise safe cron proofs, and capture the dashboard screenshot.
User benefit: the repaired code and jobs are verified on the path used each morning, not only locally.

## Validation and Acceptance

- [x] Shared cohort tests reject partial, mixed-time, wrong-id, zero, and missing data.
- [x] Pull tests prove whole-cohort preservation and replacement, internal probe evidence, and history safety.
- [x] Runner tests cover waiting, hard-to-waiting, hard-to-ready, and two hard failures.
- [x] Daily and recovery tests cover the once-per-day recovery alert marker, third-run refusal, and next-day reset.
- [x] Existing source, alert, checkout, publish, freshness, and parity fixtures pass.
- [x] Ratings, build-data, and strict validator exit 0 on the release tree.
- [x] Frozen rating entries remain byte-identical.
- [x] Transcript wrapper fixtures cover success, nonzero, and missing status; OpenClaw job readback and manual histories prove real exit behavior.
- [x] GitHub main, Vercel production, public bytes, and cache-busted generatedAt agree.
- [x] Final browser screenshot shows honest missing watch data, not zero or a blend.

## Idempotence and Recovery

Store writes use atomic rename. A complete current cohort can be pulled repeatedly;
it replaces the prior cohort as one unit. An incomplete retry preserves the whole
prior valid cohort or stays wholly incomplete. History remains one immutable entry
per eligible Phoenix date, so retries cannot duplicate a day. The daily ledger and
run lock bound recovery to two complete attempts. Cron edits are recoverable from
the read-before snapshot, and deployment follows the existing checked retry path.

## Artifacts and Notes

- Pre-change production: 16 public artifacts matched local bytes at commit
  `fa53b2f`; production `generatedAt` was `2026-09-04T16:55:00.266Z`.
- Pre-change direct YouTube owner reads: both E8 video ids returned HTTP 200 with
  zero Analytics rows. E8 share watched correctly remains absent for now.
- Pre-change transcript cron evidence: September 3 and 4 inner exit code 1 with
  `zsh: read-only variable: status`, while the outer job recorded success.
- Deterministic review after implementation: 30 test files passed, including a
  full-validator rejection of an in-memory mixed-time cohort; strict validation
  reported 0 failures, 41 historical warnings, and 0 drift before release.
- GitHub main and the deployed implementation: `cd278c91094dedd130e366905b46342429b11daa`.
- Vercel deployment: `https://dive-radio-analytics-5d7uwsznx-toolbenders.vercel.app`,
  aliased to `https://dive-radio-analytics.vercel.app`.
- Cache-busted production proof: all 16 files matched and both local and production
  reported `generatedAt` `2026-09-04T18:35:22.692Z`.
- Transcript manual run: `manual:84781eb0-d195-4203-a13a-026f4b453eeb:1788547282193:9`,
  status `ok`, silent because the mirror was current.
- Recovery manual run: `manual:34741aa2-342e-454e-9eea-30fff2b92c18:1788547296361:10`,
  status `ok`, reporting all 16 public files matched; daily attempt count stayed two.
- Production browser capture: `https://dive-radio-analytics.vercel.app/?cb=release-cd278c9`,
  showing E8's watched share as “YouTube is still preparing this number.”

## Interfaces and Dependencies

- Node built-ins and global `fetch` only; no package changes.
- YouTube Analytics v2 with both existing owner OAuth tokens.
- GitHub `main`, Vercel production, and the existing project link.
- OpenClaw 2026.9.1 scheduler, current Slack delivery target, and existing 1Password
  environment loading. Secrets remain outside Git and logs.

## Reopened end-to-end audit — 2026-09-04

The owner requested complete source-to-production repair against unverified
baseline 94d6517. Earlier completed steps are historical and do not discharge this
new acceptance. Updated PRD section 10 is the implementation contract.

### Progress

- [x] Read the v5 constitution, existing v13 PRD/plan, README, CLAUDE, architecture and assigned source/validator/scheduler/deploy code before implementation.
- [x] Locate clean launcher and runtime main at baseline; verify origin/main; preserve dirty user checkout.
- [x] Verify baseline 16-file production parity independently; identify missing chart-library proof and source/store/status gaps.
- [x] Update PRD with every source, store, clock, consumer, failure path and exact tests before code.
- [x] Repair source transactions, request completeness, capture metadata, future-episode filtering and canonical writes.
- [x] Repair frozen-rating validation and source-to-screen consumers without new features.
- [x] Repair durable run/alert receipts, bounded child execution, scheduler truth and recovery.
- [x] Repair safe release hooks, clean exact-commit release and all-artifact proof.
- [ ] Run complete audit fixtures, syntax, ratings/build/strict validator and frozen-byte proof.
- [ ] Push clean main, deploy, prove production bytes/time, run controlled real scheduler executions, capture browser.
- [ ] Record final evidence and explicitly retain future mornings/reboot observation as unproven.

### Discoveries and decisions

- Comments can label failed reads as covered; older snapshot cohorts can be partial;
  several canonical writers truncate directly or silently reset corrupt JSON.
- Ratings can use an incomplete watch cohort and silently replace an unreadable
  frozen store. Every frozenAt baseline entry must be preserved byte-for-byte.
- The pre-push hook rebuilds caller files and checks only a hard-coded subset of
  tests. The revised gate must operate in an isolated temporary copy.
- Daily attempts record status and start SHA but lack complete source/build/deploy
  receipts. Existing legacy attempts remain unchanged; new proof is additional.
- Root owns release proof and documentation; independent source, surface and
  scheduler branches own separate file sets and return concern-level commits.
- No package manifest/dependency tree or dev-discipline harness exists in this
  repo. Use the existing install-hooks script and this complete plan. User's
  explicit plain one-line commits override the skill's commit-body preference.

### Concrete steps and user benefit

1. Source lane: stage complete identified responses and promote atomically.
User benefit: a successful request for one channel cannot produce a blended number.
2. Surface lane: enforce validated source cohorts and immutable frozen entries.
User benefit: every existing number remains traceable and past scores cannot drift.
3. Scheduler lane: persist results, cap attempts, preserve alerts and check statuses.
User benefit: failures remain visible and recovery works after interruption.
4. Release lane: isolate gates, prove exact main and every served file.
User benefit: success means the validated release is actually on the public alias.
5. Integration: fixture runs, real scheduler proof, browser, final source inventory.
User benefit: operational truth is reviewable now; future streak claims wait for evidence.

### Integration checkpoint — 2026-09-04 13:54 MST

- The first integrated gate passed 39 audit suites, 89 script syntax checks and
  two inline page scripts. Strict validator: 0 failures, 42 warnings, 0 drift.
  Warnings retain historical gaps and the genuinely unavailable E8 watch history.
- Fresh authorized source calls checked 16 YouTube video IDs and 22 X posts across
  eight due episodes, both owner Analytics accounts, every newsletter page, four
  audience accounts, comments, Restream state and all eight transcripts. Thirty
  real source stores passed source integrity before promotion from a temporary
  capture checkout. The temporary operator log kept capture verification separate
  from the owner's vault. No daily attempt was spent or reset.
- E8 owner Analytics still returns no usable watch totals on both registered
  videos. The complete earlier seven cohorts advanced; no E8 history was added.
- Five frozen raw rating entry substrings are identical to baseline 94d6517:
  SHA256 b94babfe6d7e0db344524ece29ef687ecc49cd243db4269c37cf48d921634081.
  Only the enclosing store update timestamp can change.
- Release review added original committed-artifact validation before disposable
  rebuild, exact Vercel project and organization checks, and an explicit full gate
  before every push even if a hook is absent. Runtime preparation installs and
  verifies the committed hook, including fresh clones.
- Final review is closing model error propagation and alert reconciliation after
  an ambiguous provider response. No push, deployment or live job mutation has
  occurred at this checkpoint. A final complete gate follows those changes.

### Release candidate

The integrated release includes strict nonzero model and verification failures,
atomic output preservation, and bounded Slack history reconciliation for ambiguous
sends. Confirmed provider receipts survive a crash before acknowledgement; an
unknown send does not block unrelated new alerts. Every job will use the runtime
checkout after exact seven-job configuration readback.

The live recommendation generation attempt was rejected on both bounded attempts
by the young-versus-mature comparison guard. The command returned nonzero and
pruned one stale recommendation; four saved recommendations remain grounded in
current facts. This is failed refresh evidence, not a successful model call. Other
existing model steps kept today's immutable health read and current chapters,
added two grounded moment summaries, and passed deterministic health verification.

Final production, scheduler, frozen-byte and browser evidence is retained outside
the served checkout at
`~/Library/Application Support/Dive Radio Analytics/reliability-2026-09-04/`.
The final report records actual commit, generatedAt, per-file hashes, current
source states, exact live schedules and scheduler run IDs. No multi-day streak or
actual reboot is inferred from the temporary crash/restart fixtures.

### Local retrieval follow-up, 2026-09-04

The QMD collection and active OpenClaw lookup/recap skills still referenced the
old development checkout after production repair. The transcript mirror now
refreshes its two search collections on every run, independent of vault copies,
and keeps failed indexing pending. Regression fixtures cover an unchanged vault
with no marker, index failure/retry, and quiet successful indexing. Native QMD
configuration and Workshop skill application are verified separately in the
Hinterlands `dive-radio-retrieval-repair.md` plan.

## Public-X authentication repair — 2026-09-07

### Owner-directed incident recovery — 2026-09-07

The owner requested immediate repair and publication after both morning attempts
failed. Live evidence: the 07:00 primary and 08:15 recovery ran at origin/main
1e6997a, failed X personal OAuth discovery, and left production at September 6.
The existing three app-auth/recovery commits are local only. Native app-auth
read-only verification returned both public accounts successfully today.

- [x] Verify scheduler history, production timestamp, runtime checkout and ledger.
- [x] Adopt existing repairs with regression and source-only release checks.
- [x] Add one explicit operator repair after two failed automatic attempts,
  requiring a reason and changed committed code; retain every attempt and the
  unchanged limit of two automatic attempts. No scheduler may select this mode.
- [x] Run capture and publication from the dedicated publisher, with real source
  capture, strict validation, full release gate and exact production proof.
- [x] Record live timestamp, source status, frozen-entry comparison and browser.
- [ ] Reconcile the advisory-only incomplete result and prove the scheduler.

Publication 069590f passed 46 audit suites and 97 syntax checks; all 17 public
files match production at generatedAt 2026-09-07T17:11:15.920Z. All eight episodes'
source states are ready; five frozen entries are byte-identical. Browser shows
today, health 54, latest views 8,386 and no errors. The Monday critic was stopped
after four minutes to release the site. An independent same-commit retry then
also timed out after its two bounded provider calls. The legacy runner's exit 10
therefore describes an incomplete advisory report despite verified publication.

The advisory correction introduces a typed critic-only result. Its receipt and
dated alert retain the report failure; missing proof, any failed data/model step,
pending sources and the capture-attempt cap remain enforced. Today's initial
operator outcome is retained when its already-completed publication is reconciled
under this explicit status. No further source capture is authorized or needed.

Source-only code adoption must reject any changed source store or served artifact
and run every audit and syntax check. It does not certify or deploy the old
dataset. The ordinary publication gate still validates saved and rebuilt data
strictly against the real clock. This removes the stale-data repair deadlock.
The operator run is authorized by the owner's immediate repair request in this
task, not by the scheduler; historical failed attempts are never reset or erased.

### Scope and progress

- [x] Read required contracts, repository guidance and the existing reliability plan.
- [x] Preserve clean development `main` at a7a78d9; fetch origin/main and branch
  `fix/public-x-app-auth` from 1e6997a. Rollback is reverting each focused commit;
  no runtime checkout, scheduler, source store or attempt record is edited here.
- [x] Replace four public-X token-extraction paths with shared native app auth.
- [x] Test injected transports, both pagination grammars, tweet batching, honest
  absence, error redaction, allowed endpoints and bounded retries: eight focused
  audit files pass (`node --test` with x-public-get, comments-pull, channel-stats,
  source-capture, source-receipts, x-broadcast-discovery, x-broadcast-plays and
  source-io under tools/dive-analytics/audit), exit 0. `git diff --check`: exit 0.
- [x] Repair hard-failure recovery exhaustion and durable alert deduplication.
- [x] Run combined safe verification and record handoff evidence below.

### Discoveries and decisions

The personal-login `xurl token` command was unnecessary for these public reads.
The native app-auth request keeps credentials in xurl and uses the existing app
without changing permissions. Existing injected `get`/`fetchImpl` transports stay
available; explicit `xGet` supports source-specific fixtures. Personal bearer
options are no longer used. No new dependency or validation exception was added.

The shared transport only accepts the five public endpoint shapes used here.
It captures, but never forwards, child diagnostics. Auth failures do not trigger
a credential fallback. Raw xurl offers no safe Retry-After header output, so a
429 ends the request without an inline retry; existing whole-chain limits remain.
Caller schemas and bounded pagination are unchanged. X broadcasts still come
from the existing broadcast extractor, not tweet-video counters.

Read-only native smoke: `node --input-type=module -e` importing `xPublicGet`
and requesting `/2/users/by?usernames=ridd_design,designertom&user.fields=public_metrics`
returned `READ_ONLY_APP_AUTH: two public accounts returned`, exit 0. No store was
written and no credential value was requested, exported or logged.

### Recovery decision and evidence

The hard-failure branch used to spawn `run-daily --recovery` after the two daily
attempts had already been spent. The child refused correctly, but the checker
queued another recovery-failed line after the prior line had been delivered.
A disposable import of origin/main's recovery code reproduced this: two checks
launched two refusing children and requeued after drain (fixture command exit 0).
No production runner or queue was used in that reproduction.

Recovery now checks the cap for every unproved outcome, not just a source wait.
An exhausted hard failure returns 75 without launching the child. It uses the
existing daily `failureAlerts` marker, under the existing run lock, for exhausted,
child, preflight, out-of-window and final-proof failures. The child and checker
therefore share one daily failure event. The queue must accept the warning before
the marker is saved. Delivery removes the queue line, not the marker. Historical
attempts, invocation records, the two-attempt policy and publish gates stay intact.
Lock-contention alerts retain their existing behavior; they are not exhausted
recovery events, and this repair adds no monitoring or delivery framework.

Executable fixtures cover a delivered earlier daily failure, a new exhausted
warning, queue drain, a child that consumes the second attempt and queues its own
failure, failed queue writes, corrupt state, untouched attempt history and the
next day's fresh budget. The test wrapper now supplies a disposable ledger even
for legacy tests; it never inspects the owner's real attempt state.

### Verification commands (2026-09-07)

All commands ran in `/Users/bones/Dev/2026/dive-radio-analytics` on the repair
branch. Network, publishing and deployment effects were not part of these tests.
Existing tests use disposable fixtures. The one separately noted live call was
an authorized read-only public-user lookup.

```sh
node --test tools/dive-analytics/audit/x-public-get.test.mjs tools/dive-analytics/audit/comments-pull.test.mjs tools/dive-analytics/audit/channel-stats.test.mjs tools/dive-analytics/audit/source-capture.test.mjs tools/dive-analytics/audit/source-receipts.test.mjs tools/dive-analytics/audit/x-broadcast-discovery.test.mjs tools/dive-analytics/audit/x-broadcast-plays.test.mjs tools/dive-analytics/audit/source-io.test.mjs
# exit 0; 8 files passed
node --test tools/dive-analytics/audit/recover-publish.test.mjs tools/dive-analytics/audit/run-daily.test.mjs tools/dive-analytics/audit/alert-queue.test.mjs tools/dive-analytics/audit/alerts-delivery.test.mjs
# exit 0; 4 files passed
node --test --test-concurrency=1 tools/dive-analytics/audit/*.test.mjs
# exit 0; 44 files passed, 0 failed
node --check tools/dive-analytics/recover-publish.mjs
for script in scripts/restream/{x-public-get,postlive-discover,postlive-track,comments-pull,channel-stats-pull}.mjs tools/dive-analytics/audit/{x-public-get,recover-publish}.test.mjs; do node --check "$script" || exit; done
# exit 0; all eight syntax checks passed
git diff --check
# exit 0
node tools/dive-analytics/audit/validate.mjs
# exit 1; 3 failures, 32 warnings, 0 drift
```

The strict validator correctly refuses the existing September 6 data: generatedAt
is stale, the newest snapshot is 26.3 hours old, and data.json is 26.3 hours old
(the limit is 26). Those three freshness failures are NOT waived or repaired by
this code change. The validation rules, run-daily cap, `data.json`, `data.js` and
all `data/restream` files have no diff against origin/main. Code fixtures passing
does not mean the old saved dataset is publishable. No live publish was run.
Full local audit output is in `.git/public-x-repair-tests.log`; strict output is
in `.git/public-x-repair-validation.log` (local, not part of the release).

### Safe adoption and rerun (main owns this, not executed here)

App-auth commit: `4ff4affbebdfe81b5dbcfa58f64bb18ee314e40c`.
Recovery is a separate concern-level commit following it. Adopt both reviewed
commits through the normal main/publisher process; this task never pushes,
publishes, edits the dedicated publisher, changes schedules or resets state.

From the committed publisher checkout, inspect today's real budget with:

```sh
node tools/dive-analytics/run-daily.mjs --dry
```

If both attempts are recorded, do not run the chain again that Phoenix day. Do
not remove records, change their dates, select another state file or call
`run-chain.mjs` / `postlive-publish.sh` directly to avoid the cap. After adoption,
`node tools/dive-analytics/recover-publish.mjs --proof-only` can check existing
production without capture or another attempt; an old or failed checklist still
fails honestly. Preparation may update the dedicated checkout, so main owns even
that command. It is not a fresh data pull.

The next real Phoenix day gets a new budget automatically. The normal scheduled
`run-daily.mjs --primary` run (or the existing recovery window if an attempt is
still available) pulls new data, validates it, and follows the full publishing
path. A manual primary run, if main chooses one, must start from the dedicated
publisher and still pass the same cap. Yesterday's records remain untouched.
Independent final review, adoption, fresh capture, production proof and scheduler
work remain with main; no claim of live repair or unattended stability is made.

### September 7 independent review — first-run failure marker

The first independent review found a new edge case: recovery preparation could
fail before the daily ledger had ever existed, and the new deduplication helper
then dereferenced a missing failureAlerts map. A temporary-fixture regression
failed with exit 1 before the fix. The empty-ledger constructor now includes that
map, matching the normal loaded-state shape. Existing initialized-but-missing
ledgers still fail closed; no live ledger is changed.

The regression verifies one queued warning, no fabricated capture attempt, no
second warning on replay, and refusal rather than reset after an initialized
ledger disappears. The focused recovery test passes after the fix. This changes
only first-run state initialization, not the two-attempt cap or publication
validation. After the fix, node --test --test-concurrency=1 tools/dive-analytics/audit/*.test.mjs exited 0: 44 passed, 0 failed (47.94 seconds). git diff --check and the daily-runner syntax check also exited 0. Independent recheck remains pending.

## September 10 repeated publication failure

The owner requested immediate repair. Production remained September 8. September
9 captured eight episodes and eight owner-Analytics history rows, then failed
strict transcript parity because two cloud-backed vault files returned read
error -11. September 10 reached both YouTube and X accounts successfully but
stopped because a same-day upcoming broadcast lacked one X destination. Original
attempts and all 45 dirty captured files were copied to the private incident
folder before modifying the release path. No captured reading is backdated.

### Discovery repair

- [x] Reproduce the same-day upcoming broadcast with injected real response shapes.
- [x] Defer broadcasts still marked upcoming or scheduled in the future, using
  actual start when supplied. Store deferred IDs in the successful discovery
  receipt. Aired episodes still pass all destination completeness checks.
- [x] Verify live read-only discovery reaches both platforms and defers today's
  two upcoming YouTube uploads without changing the registry.
- [ ] Adopt the committed repairs and complete the remaining authorized recovery.

Decision: YouTube's exact broadcast state and timestamp are available at discovery;
being on today's Phoenix date does not mean a broadcast has begun. This does not
alter the date-only readiness rules for an already registered episode.

### Transcript source read repair

- [x] Add bounded transient-read retries and a private atomic source-byte cache.
- [x] Verify E7 and E8 can currently be read directly from their exact vault files;
  seed the cache from those successful reads, never from public transcripts.
- [x] Fixtures reject an unseeded cache, corrupt bytes, changed source identity,
  deleted source and permission failures; they prove retry success and private modes.
- [x] Keep exact source selection, conflicting-copy checks, source/body parity,
  transcript headers and clock checks in strict validation.

Decision: after three transient read errors only, the reader may use bytes it
previously read successfully from the same absolute source path if device, inode,
size, modification time and change time still match before and after the read.
It checks the stored SHA256 and byte length. Readable source bytes always win;
source deletion, access denial, changed metadata, cache corruption or no prior
source read still fail. The cache is under the private runtime folder, mode 0600
inside a 0700 directory, and is not a source store or a served artifact. The
validator compares against the importer's one verified source read instead of
opening the cloud file a second time. This preserves exact parity without making
an unchanged historical transcript depend on repeated cloud-file reads.
