---
summary: "Explain missing audience curves without hiding valid watch totals, and verify the release on main."
read_when:
  - Investigating missing retention curves or topic markers.
  - Releasing the September 2026 watch-curve availability correction.
---

# Execution Plan: Explain unavailable retention moments and release on main

## Purpose / Big Picture

The latest episode has watch totals but no audience curve or topic markers. Identify the source gap, explain it honestly in the episode panel, preserve the working dashboard, and release verified code from main.

## Progress

- [x] 2026-09-05 20:36 UTC: switched the primary workspace to current main; preserved its prior unfinished work in Git stash.
- [x] 2026-09-05 20:37 UTC: both owner API requests returned HTTP 200 and zero retention rows for E8; wider date ranges also returned zero. E7 returned 100 rows per channel using the same requests.
- [x] Added a build-authored curve-unavailable reason to the panel and agent brief.
- [x] Focused regression, agent-brief, summary-store, strict validator (0 failures, 0 drift), and desktop/mobile browser checks passed. E4's 2.2-per-100 jump-in tooltip matches the supplied example.
- [x] Full release gate: 43 audit files, 93 script syntax checks, 2 page scripts, 0 failures, 0 drift. Existing 41 warning conditions remain reported.
- [x] 2026-09-05 20:48 UTC: pushed main, updated the dedicated publisher, and deployed c67ddd83. All 17 public files matched exactly. Live browser checks confirmed the E8 explanation, the E4 topic tooltip, and no JavaScript errors.

## Surprises & Discoveries

YouTube reports averages independently of its retention curve. E8 has 18.06% average watched, but both saved curves are empty. Its transcript and chapters exist. The active workspace was 67 commits behind production and contained an unfinished W47 semantic-projection refactor. It is preserved as stash 932d8d1; importing that older refactor would reintroduce stale data and replace working production surfaces.

## Decision Log

- 2026-09-05: use current production main as the baseline, preserve older unfinished changes separately, and make the missing-curve correction narrowly.
- 2026-09-05: keep totals ready when their valid cohort exists; a curve-unavailable explanation is independent of totals readiness. Retain the existing two-channel gate and extraction thresholds.
- 2026-09-05: existing daily capture already queries retention for every aired episode and runs moment summaries after the first build. No scheduler changes or invented points are needed.

## Outcomes & Retrospective

The correction is live. Valid averages stay visible alongside an explicit explanation when retention is unavailable. E4 still displays the reference jump-in tooltip (2.2 of every 100 viewers, about 38 minutes in) and its two drop markers. All pre-existing analytics values and saved topic summaries are preserved. Actual E8 topic markers remain dependent on YouTube returning the retention curve. The older unfinished W47 refactor is preserved separately instead of being included in this focused release.

## Context and Orientation

`scripts/restream/yt-analytics-pull.mjs` queries owner reports. `tools/dive-analytics/build-data.mjs` blends aligned curves and attaches deterministic transcript moments plus saved summaries. `index.html` draws the curve and markers. `agent-brief.mjs` projects the same availability explanation. The dedicated scheduled writer is `~/Library/Application Support/Dive Radio Analytics/publisher-main`.

## Plan of Work

In scope: source diagnosis, main reconciliation, one availability field, matching panel/agent output, regression checks, release proof. Existing calculations, frozen ratings, history, the unfinished W47 refactor, and cron definitions remain outside this correction.

## Architecture Impact

`ARCHITECTURE.md` needs an additive field and timing explanation. The build remains deterministic, missing curves remain null, and summary notes still require stored transcript-grounded moments. No dependencies are introduced.

## Concrete Steps

1. [complete] Verify current sources and preserve the existing checkout before moving to main.
User benefit: retain today's working production behavior and identify why markers are absent.
2. [complete] Add the same missing-curve explanation to human and agent surfaces and prove both arrival and absence behavior.
User benefit: the empty area explains itself and automatically restores markers when source data arrives.
3. [complete] Run the full release gate, push main, deploy from the dedicated publisher, and inspect live E8 and E4.
User benefit: the production page serves the reviewed change while older topic tooltips keep working.

## Validation and Acceptance

- [x] Missing, one-channel, and disjoint curves retain valid totals and have no fabricated markers.
- [x] Complete curves restore drops, jumps, and saved topic notes, and clear the explanation.
- [x] Human and agent surfaces carry the same reason. Desktop and 390px mobile render correctly without horizontal overflow.
- [x] Full release gate, production byte parity, browser tooltip checks, and clean main pass. No open GitHub pull requests remain.

## Idempotence and Recovery

Regression tests write only temporary fixtures. The ordinary capture/build sequence retries curves daily. Revert the correction commit to undo the availability explanation; never rewrite frozen stores. The pre-existing work remains recoverable in the named stash and original branch.

## Artifacts and Notes

Initial production commit: d962516. Direct source checks: 2026-09-05T20:36:53Z through 20:36:54Z. E8 video ids: lnAecYrKYos and Vh8ogFIE8CA. Both returned zero rows with start dates 2026-09-03 and 2026-08-01. E7 controls returned 100 points each. Credentials were not logged.

Correction commit: a192655. First verified production release: c67ddd839a8a583c2e6cc48d50efb84013e54098, generated 2026-09-05T20:44:18.978Z, proven at 20:48:22Z. Deployment: https://dive-radio-analytics-kesesb71i-toolbenders.vercel.app. Canonical site: https://dive-radio-analytics.vercel.app. Runtime evidence and screenshots are retained under `~/Library/Application Support/Dive Radio Analytics/watch-curve-2026-09-05/`; `publish-proof.json` beside that folder records the latest release, including any documentation-only follow-up.

Deep comparison against d962516 confirms that every existing analytics value, curve, moment, rating, source state, and recommendation is unchanged; only the new reason and build timestamp differ. The planner's plan validator passes. Its generic architecture-template validator does not apply to this repository's existing numbered lineage document (the same missing template headings predate this change); the architecture addition was reviewed against the actual implementation and the repository validator passes.

## Interfaces and Dependencies

Additive `episodes[].watch.curveUnavailableReason: string | null`, copied to `agent.json` under `episodes[].watching` and rendered verbatim in the panel and Markdown brief. Existing YouTube Analytics, transcript stores, Chart.js, Vercel, and vanilla JavaScript remain the only relevant boundaries.
