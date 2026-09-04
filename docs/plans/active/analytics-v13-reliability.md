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
- [ ] 2026-09-04 11:10 MST - update and prove the transcript and recovery OpenClaw jobs.
- [ ] 2026-09-04 11:10 MST - run the full local release gate, push, deploy, prove parity, and capture a screenshot.

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

Pending implementation. This section will record commit ids, production evidence,
cron run receipts, remaining source absence, and the rolling unattended-run gate.

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
4. [pending] Repair the transcript OpenClaw wrapper and correct recovery wording,
   add proof-only recovery, and preserve every schedule, destination, timeout, and
   failure-alert field.
User benefit: green cron history once again means the owned command actually succeeded.
5. [pending] Run focused fixtures and the ratings to build to validator chain, update
   docs, then commit the source reliability concern.
User benefit: every changed behavior is reproducible without risking a third live run today.
6. [pending] Push, deploy, prove exact public parity and production time, manually
   exercise safe cron proofs, and capture the dashboard screenshot.
User benefit: the repaired code and jobs are verified on the path used each morning, not only locally.

## Validation and Acceptance

- [x] Shared cohort tests reject partial, mixed-time, wrong-id, zero, and missing data.
- [x] Pull tests prove whole-cohort preservation and replacement, internal probe evidence, and history safety.
- [x] Runner tests cover waiting, hard-to-waiting, hard-to-ready, and two hard failures.
- [x] Daily and recovery tests cover the once-per-day recovery alert marker, third-run refusal, and next-day reset.
- [x] Existing source, alert, checkout, publish, freshness, and parity fixtures pass.
- [ ] Ratings, build-data, and strict validator exit 0 on the release tree.
- [x] Frozen rating entries remain byte-identical.
- [ ] Transcript wrapper fixtures cover success, nonzero, and missing status; OpenClaw job readback and manual histories prove real exit behavior.
- [ ] GitHub main, Vercel production, public bytes, and cache-busted generatedAt agree.
- [ ] Final browser screenshot shows honest missing watch data, not zero or a blend.

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
- Commit, deployment, parity, cron run ids, and screenshot path will be appended.

## Interfaces and Dependencies

- Node built-ins and global `fetch` only; no package changes.
- YouTube Analytics v2 with both existing owner OAuth tokens.
- GitHub `main`, Vercel production, and the existing project link.
- OpenClaw 2026.9.1 scheduler, current Slack delivery target, and existing 1Password
  environment loading. Secrets remain outside Git and logs.
