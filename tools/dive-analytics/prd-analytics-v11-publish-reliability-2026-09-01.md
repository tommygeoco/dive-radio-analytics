# PRD — Analytics v11: publishes that do not fail (2026-09-01)

**Status:** proposed, evening of 2026-09-01. **Owner ask:** "make this
bulletproof and I want it to stop failing for publishes. Don't
over-engineer." **Scope:** the daily chain on the owner machine, the
validator's blocking rules, the publish script, and how a failure reaches
a human. Nothing here changes a number the page shows.

## 0. The record — why publishes failed

Every failed or silent publish I could find in the incident notes, the
OpenClaw run history, and today's live runs:

| When | What stopped the publish | Would readers have seen a wrong number without the stop? | Fixed today? |
|---|---|---|---|
| 2026-08-23 | one bad recommendation model call blocked the whole publish | no | yes (prune floor, v8) |
| 2026-08-23 | a blocked morning served yesterday's numbers silently | — | yes (freshness watchdog, v8) |
| 2026-08-24 | four 7 AM runs failed the same-day recompute proof after intraday re-ingest | no | yes (refresh escape) |
| 2026-08-31 | the model's recommendation set replaced the deterministic list; validator demanded `pace-rank` | no | yes (injected) |
| 2026-08-31 → 09-07 | the Monday job ran a legacy inline command list (no pull, no health steps); 5 straight errors | no | yes (repointed) |
| 2026-09-01 07:04, 07:14, 07:34 | classifier got an empty model response; the validator then refused to publish over pending comments | no | yes (prompt + warn) |
| 2026-09-01 07:00–15:40 | the machine ran nine-day-old code because nothing pulled before the run | — | yes (pull-first) |
| 2026-09-01 15:45 | first real v4 run: today's entry keeps the lens it was written from; a fresh snapshot moved the served lens; equality check failed | no | yes (refresh-aware) |
| 2026-09-01 15:51 | OpenClaw gateway restarted mid-run (model catalog update); run marked interrupted | — | retry policy covers it |
| since 2026-08-28 | **seven alert lines queued and never delivered** — no `dive-alerts` job exists among the 91 automations; failure notifications on the chain jobs are "not requested" | — | **no** |

Two facts fall out of the table. **Not one blocked publish protected a
reader from a wrong number**: every stop was a contract or wiring rule
tripping on a code change, a model hiccup, or an intraday re-run. And
**nobody was told**: four failures in a row on 09-01 surfaced only when the
owner said "the data didn't change".

The validator today has 383 `fail()` calls, 23 `warn()` calls, and 121
regex tests against the page source. It is doing two jobs with one lever:
protecting readers from wrong numbers (must block a publish) and protecting
the codebase from drift (must block a code change). Pulling those apart is
most of this PRD.

## 1. Rules (extend the constitution)

24. **A morning publish stops only when a number would be wrong.** A
    contract, wiring, or copy drift is reported, alerted, and fixed at code
    time; it never withholds today's data from the owners.
25. **Every failure reaches a human within ten minutes.** A required step
    failing, a publish that could not confirm parity, or a stale site posts
    one plain line to Slack. Silence means success, and only success.
26. **Stores have one writer.** Only the chain machine commits
    `data/restream/**`, `data.json`, and `data.js`. Every other machine
    pushes code only. A push that breaks this is warned about before it leaves.

## 2. Workstreams

### W36 — Two-tier validator: honesty blocks, drift reports

- Add `drift(msg)` beside `fail(msg)`. In **publish mode**
  (`validate.mjs --publish`, the mode `chain.json` uses) drift lines print as
  `DRIFT`, are counted, and never affect the exit code; the chain queues one
  Slack line naming them (W37). In **strict mode** (the default when a
  person runs it, and the pre-push hook) drift fails like today.
- Reclassify by one rule: *does this check re-derive a shipped number,
  definition, grounding, absence, freshness, or store integrity from the
  stores?* If yes it stays `fail`. If it inspects `index.html`,
  `build-data.mjs`, prompt files, or copy strings, it becomes `drift`.
  Concretely: every `.test(html)` / `.test(healthSource)` / renderer regex,
  the fold-number counts, the About and banned-word copy checks (the model
  scripts' own `BANNED` regex still rejects prose at write time), the
  prompt-hash-without-version-bump stamp, the `chain.json` shape check, the
  strip and panel layout contracts. Stays `fail`: unit rules (total views,
  no impressions summed), absence ≠ zero, data.json reproducibility, every
  episode-health and show-health re-derivation, weights and bands, bullet
  and item grounding, append-only guards, store schemas, freshness and
  withholding, Slack-text parity with the page (it is a number surface).
- Pre-push hook (`scripts/dev/install-hooks.sh` → `.git/hooks/pre-push`):
  runs the fixture tests and `validate.mjs` strict on a fresh build, and
  refuses the push on any fail or drift. This is where drift belongs.
- Acceptance: on the real stores, publish mode and strict mode agree on
  every `fail`; the 121 source-regex checks all appear under `drift`; a
  deliberately broken page regex still publishes in publish mode and refuses
  a push in strict mode (fixture in `audit/validate-tiers.test.mjs`).

### W37 — Failures and changes reach Slack

- `run-chain.mjs`: when a required step fails, or publish exits with
  "published, parity unconfirmed" (W38), queue one line into
  `alerts-pending.json` — `chain: <step> failed at 07:03 — <last stderr
  line>` — before exiting. The queue is append-only JSON and needs no model.
- **Restore delivery.** Recreate the `dive-alerts` automation: every 30
  minutes, `node tools/dive-analytics/alerts.mjs --emit`, delivered to the
  owner's Slack DM, silent when the queue is empty (the script already
  prints nothing then). The seven waiting lines go out on its first run.
- Turn on OpenClaw failure notifications for `restream-postlive-snapshot`
  (`openclaw cron edit … --announce` to the same DM), so a run killed by a
  gateway restart is announced even though the chain never got to queue.
- Move `restream-postlive-freshness` to `15 8,12 * * *`: the 08:15 run
  catches a morning that never published while the owners are starting
  their day; the noon run stays.
- Acceptance: kill a required step on purpose in a rehearsal; a Slack line
  arrives within ten minutes. The pending queue is empty every evening.

### W38 — A publish that cannot fail for a reason it can fix itself

`scripts/restream/postlive-publish.sh`:
- A stash-pop conflict on a store file no longer aborts: `health-history.json`
  is merged by day (`chain-heal.mergeHealthStores`, already rehearsed);
  every other `data/restream/**` file keeps the local run's version (the
  chain is its only writer, rule 26) and generated files are rebuilt.
- Deploy: after `vercel deploy --prod`, one retry if the parity loop does
  not see the new stamp; then exit **2** ("published, parity unconfirmed")
  rather than 1. `run-chain.mjs` treats 2 as success plus an alert line —
  a parity miss must never re-run capture and re-publish.
- Push: if `git push` is rejected because main moved again during the
  deploy window, fetch, rebase, push once more; only then fail.
- Acceptance: the throwaway-repo rehearsal (`audit/chain-heal.test.mjs`)
  gains the publish-script path; `postlive-publish.sh --dry` prints the
  decisions it would take.

### W39 — One retry for the two required capture steps

`snapshot` and `yt-analytics` are the only required steps that talk to a
platform. `run-chain.mjs` retries a required step once after 60 seconds
when it exits non-zero; a second failure stops the chain as today (and
now alerts). YouTube analytics 500s already degrade to a warning inside
the step; this covers the X and Restream side. No further retry logic.

### W40 — A log a person can read

`run-chain.mjs` tees its whole output to
`~/Library/Logs/dive-radio-analytics/chain-<YYYY-MM-DD>.log` (outside the
repo; 30 days kept), because OpenClaw retains a 2,000-byte summary and the
failing step is routinely past it. `run-chain.mjs --last` prints the last
run's failing step and its ten surrounding lines.

### W41 — One writer, one schedule

- The pre-push hook (W36) warns when a push contains `data/restream/**`,
  `data.json`, or `data.js` from a machine without `DIVE_CHAIN_MACHINE=1`
  in its environment (set once on the Mini). Warn, not block: the heal
  covers the rare deliberate case.
- Retire the 06:00 `restream-postlive-rehearsal` automation. It captured
  everything twice a day (double platform calls, two snapshot points a
  day), and in its history it never caught anything the 07:00 run did not
  hit the same way. Drift is caught at push time now (W36); failures are
  announced (W37). `--rehearse` stays as a manual mode.
- `README`, `ARCHITECTURE`, `CLAUDE.md`: publish-mode vs strict-mode
  validator, the hook, the alert path, and the single-writer rule.

## 3. Deliberately not doing

- No resumable chain, no per-step checkpoints: every capture step is
  idempotent and the whole run takes under two minutes; a retry is cheaper
  than state.
- No second machine, no container, no move off OpenClaw: one gateway
  restart a day is survivable with retries and announcements.
- No extra model retries beyond what the scripts already do: every model
  step has a deterministic floor, and W36 guarantees a model hiccup cannot
  block the data.
- No validator relaxation of any honesty rule. The 383 fails split into
  two tiers; none is removed.

## 4. Definition of bulletproof (acceptance for the whole PRD)

1. Fourteen consecutive unattended 07:00 publishes, each confirmed by the
   08:15 freshness check, with no human touch.
2. No publish blocked by a check that inspects source or copy (audit the
   run logs weekly for `DRIFT` lines; each one is a code fix, never a stop).
3. Every non-success — required-step failure, parity unconfirmed, stale
   site, interrupted run — produces one Slack line within ten minutes.
4. The pending alert queue is empty at the end of every day.
5. A push from a laptop that changes stores is warned about before it lands.

## 5. Order and size

| Step | Work | Size |
|---|---|---|
| 1 | W37 delivery job + failure notifications + freshness at 08:15 (ops on the Mini, no code) | 20 min |
| 2 | W36 tiers + hook + tier fixture | half a day |
| 3 | W38 publish script + rehearsal test | 2 hours |
| 4 | W39, W40 | 1 hour |
| 5 | W41 retire the rehearsal, docs | 30 min |

Steps 1 and 5's job edits happen through `openclaw cron edit`/`add`/`rm` on
the Mini and are recorded in `ARCHITECTURE.md` §1 so the schedule stays
documented. Everything else ships as one branch, merged code-only (rule
26), and the Mini pulls it at its next 07:00.

## 6. Risks

- **Reclassifying a check wrongly to drift** could let a real reader-facing
  drift publish. Mitigation: the rule in W36 is mechanical (source
  inspection → drift), the tier fixture proves the split, and the Slack
  line makes any drift visible the same morning.
- **Slack delivery depends on the OpenClaw gateway** — the same dependency
  as the chain. The 08:15 freshness check is the backstop: it reads the
  live site, not the machine.
- **Retiring the rehearsal** removes the only pre-07:00 signal. Accepted:
  the hook moves that signal to push time, where it belongs.
