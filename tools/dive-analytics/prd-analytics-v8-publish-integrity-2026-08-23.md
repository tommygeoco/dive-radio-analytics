# PRD — Dive Radio analytics v8: publish integrity (2026-08-23)

Owner: Tommy. Status: REPO CODE LANDED 2026-08-23 — W19 (prune mode +
prune-on-failure), W20 (allowed-number payload, error-feedback retries,
health.mjs audit recorded in its header: frozen entries are judged against
their own saved facts, no staleness), and W21 (audit/freshness.mjs watchdog
+ end-of-chain probe in alerts.mjs) are implemented. Still open: the cron
chain edit (W19 step 3) and the 12:00 watchdog cron, both operator-run.
Numbering note: first drafted as v7 with work items W17–W19, renumbered
the same day — W17 (moment summaries, v6.1) and W18 (destination links)
were already claimed by shipped work, so this PRD is v8 and its work items
are W19–W21. Builds on v5 (recommendation engine, W15), v6 (transcript
moments, W16), and v6.1 (moment summaries, W17).
Goal: the morning publish can never be blocked by a stale model artifact,
and the model artifact can never go stale silently.

## Incident (2026-08-23, the motivating failure)

- The 7:00 chain pulled every store correctly (12 YT reports, 13 X posts,
  channel stats) and built a fresh `data.json` at 07:38 MST.
- `validate.mjs` exited 1: `recommendations: store failed grounding
  validation — x-bridge: number 56.7 is not in the fact sheet`. The saved
  item cited yesterday's X-share; the fact moved with the fresh data.
- Publish is gated on validate, so the deploy never ran. Prod served the
  previous night's 01:29 build all morning. The owners read it as "views
  didn't change". The job had 4 consecutive failed runs before a human
  diagnosed it from Slack.
- Manual recovery: two regeneration attempts both failed grounding (the
  model wrote `25`, a derived number not in the facts). The stale item was
  removed by hand, validate passed, publish shipped 08:34 data.

## Root causes

1. **Chain gap.** The 7:00 cron chain runs discover → snapshot → comments →
   channel-stats → yt-analytics → ratings → build-data → validate → publish.
   It never runs `recommendations.mjs`. The store header documents the
   intended owner chain (… health → recommendations → build-data → validate
   → publish) but the cron was never updated when W15 shipped. Any day the
   data drifts past a cited number, publish blocks. This is guaranteed to
   recur: drift is the normal case, not the edge case.
2. **Keep-previous is not safe.** `recommendations.mjs` treats model failure
   as non-fatal ("previous store stays the public truth") while
   `validate.mjs` treats a stale store as fatal. Together these turn one bad
   model call into a blocked publish with no automatic path back.
3. **The model derives numbers.** Two independent runs failed grounding by
   writing a computed value (`25`). The prompt forbids it but nothing helps
   the model comply (no allowed-token list in the payload, no error-feedback
   retry), so a single-shot call fails often.

## Design decisions

- Validate stays hard. An ungrounded number on the page is a lie; the gate
  is correct. We fix the inputs to the gate, not the gate.
- The validator never mutates data. Pruning is a store-side, deterministic
  operation with an audit trail.
- Model calls stay inside `recommendations.mjs` (constitution: model calls
  live only in dedicated scripts). The cron chain stays a plain command
  payload.

## W19 — self-pruning store + regeneration in the chain

`recommendations.mjs` changes:

1. **Deterministic prune (no model).** New mode
   `node tools/dive-analytics/recommendations.mjs --prune`: load the store,
   re-run `validateItems` item-by-item against the CURRENT fact sheet, drop
   items that no longer ground, atomic-write the survivors with
   `prunedAt` + `prunedIds` recorded in the store. If fewer than 3 items
   survive, delete the store file entirely — build-data already falls back
   to the deterministic rule-based insights when no store exists, and
   validate already treats an absent store as WARN, not FAIL.
2. **Regenerate, then prune as the floor.** Default run: try the model as
   today; on success, full replace (current behavior). On any model or
   grounding failure, fall back to the prune instead of keep-previous. The
   store on disk is always grounded in the current facts after the script
   exits, no matter what the model did.
3. **Chain order (cron `restream-postlive-snapshot`, job
   c4bc213f-7437-4a80-9c91-8af216cd6fab):** insert after the first
   build-data, per the store's own documented chain:
   `… ratings → build-data → recommendations (non-fatal wrapper) →
   build-data → validate → publish → alerts`. The second build-data
   projects the new store into the page so validate's page-matches-store
   check holds. Cron edit follows the workspace new-cron checklist; model
   tier for the chain stays "command payload, zero-model" — the model call
   lives inside the script and uses `ANTHROPIC_API_KEY`/`RECS_MODEL` as
   today.

Acceptance:
- Kill the network for the model call: chain still publishes, store is
  pruned-not-stale, validate exit 0.
- Hand-edit a store number to a value not in the facts, run the chain:
  the item is pruned, publish proceeds, `prunedIds` names it.
- Prune below 3 items: store file is gone, page shows deterministic
  fallback insights, validate WARNs (absent store) and exits 0.

## W20 — grounding-failure hardening for the model call

1. **Allowed numbers in the payload.** Send the model the exact allowed
   token list (the same set `validateItems` builds), with the instruction:
   every digit sequence in your output must appear verbatim in this list.
   Never compute, round, combine, or convert numbers — if the number you
   want is not in the list, make the point without a number.
2. **Error-feedback retry.** On a grounding failure, retry the model call
   up to 2 more times, appending the exact validation error and the
   offending item to the conversation. Three grounded failures → fall back
   to W19 prune. Log each attempt (`attempt n/3: <error>`).
3. **Same treatment audit for `health.mjs`.** It shares the provider
   plumbing. Verify whether its saved reads can go stale against the fact
   sheet the same way; if yes, file the same prune-or-regenerate pattern as
   a follow-up work item; if no (frozen reads are immutable by design),
   record that in the script header so nobody "fixes" it later.

Acceptance:
- Replay today's failure (facts where the model previously wrote `25`):
  regeneration succeeds within 3 attempts, or prunes and publishes.
- The saved store's `attempts` field records how many calls were needed.

## W21 — prod freshness watchdog

The gate can only block; nothing watches the OUTPUT for staleness. Local
validate checks the local build's freshness, which is useless when publish
itself is what failed.

- Extend `alerts.mjs` (or a 15-line sibling) with a prod check: fetch
  `https://dive-radio-analytics.vercel.app/data.json`, alert when
  `generatedAt` is older than 26 hours. Runs at the END of the chain and
  also under a separate small cron at 12:00 MST (catches the
  chain-died-before-alerts case, which is exactly what happened today —
  alerts.mjs never ran because the chain stopped at validate).
- Alert text is one plain sentence: "prod dashboard is serving data from
  <timestamp>, <n> hours old — the morning publish likely failed."

Acceptance:
- With prod parity current: silent.
- With prod pinned to yesterday's deploy: one Slack line in #garage from
  the midday check.

## Out of scope

- Hand-editing the store (today's recovery was a one-off; W19 makes the
  deterministic prune the sanctioned path).
- Weakening `validateItems` (the allowed-token set stays exact; structural
  constants list unchanged).
- Any change to the deterministic fallback insights in build-data.

## Rollout

1. W19 script change + acceptance runs locally.
2. Cron chain edit (owner-approved, six-point checklist in the workspace
   AGENTS.md), then one supervised `cron run` end-to-end.
3. W20 prompt/retry change, replay test.
4. W21 watchdog + midday cron.
5. Watch two consecutive 7:00 runs; done when both publish with parity
   confirmed and zero manual touches.
