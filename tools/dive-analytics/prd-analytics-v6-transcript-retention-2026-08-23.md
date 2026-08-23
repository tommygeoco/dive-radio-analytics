# PRD — Dive Radio analytics v6: transcript × retention moments (2026-08-23)

Owner: Tommy. Status: PLANNED (not yet built). Builds on v4 (watching data)
and v5 (recommendation engine). Goal: turn "people leave" into "people leave
HERE, during THIS" — and let the recommendation engine cite it.

## Problem

The drop-off curves show WHERE attention is lost (the open cliff is already
a saved recommendation), but nothing connects a mid-video dip to what was
actually happening in the show at that moment. The pipeline already stores
everything needed: 100-point blended curves per episode and timestamped
speaker transcripts. Nobody has joined them.

## Data facts (verified 2026-08-23)

- Curves: `episode.watch.curve` = `{at, watching}` on an aligned grid,
  `at` ∈ 0.01…1.00 step 0.01, view-weighted blend of both channels.
- Transcripts: `transcripts/<slug>.txt` — 3 header lines, then blocks of
  `HH:MM:SS [Speaker N]` + one text line, ~9-second cadence. Header warns
  speaker labels are automatic.
- Video duration is NOT stored directly. Derive per channel:
  `durationSec ≈ averageViewDuration / (averageViewPercentage / 100)`
  (E2: DesignerTom ≈ 8113s, Dive Club ≈ 7176s — the two VODs differ, likely
  trim offsets). Blend view-weighted for display; when the two channel
  estimates disagree by more than 5%, widen the excerpt window and mark the
  moment time approximate. Live `durationMin` is the live session, not the
  VOD — do not use it for mapping.
- Transcript timestamps come from the live recording; VOD trims can shift
  them relative to curve positions. Calibration is APPROXIMATE by design —
  windows, not instants.

## Phase 1 — deterministic extraction (no model, no new chain step)

New module `tools/dive-analytics/watch-moments.mjs` exporting pure
functions; `build-data.mjs` imports it (stays deterministic, rebuild-currency
check 7 covers everything; no separate store file).

Per episode with BOTH a curve and a transcript:

1. **Shape facts** (attached as `episode.watch.shape`):
   `openStart` (watching at first grid point), `openFloor` (minimum in the
   first 5%), `recoveryPeak` + `recoveryAt` (local max after the floor,
   at ≤ 0.15), `midHold` (mean watching 0.25–0.75), `endHold` (watching at
   0.95). All ×100, one decimal.
2. **Moments** (attached as `episode.watch.moments`, max 5):
   scanning `at ≥ 0.05` only (the open cliff is its own known story):
   - top 3 **drops**: largest negative change over a 2-step window, each at
     least 1.5 points, no two moments within 0.05 of each other;
   - top 2 **holds**: largest positive change (rewind/skip-to bumps), same
     spacing rule.
   Each moment: `{kind: "drop"|"hold", at, points (magnitude, 1dp),
   estSec, approx (bool from the duration disagreement), excerpt, speaker}`.
   `excerpt` = transcript text within ±45s of `estSec` (±90s when approx),
   trimmed to ≤ 320 chars on block boundaries, speaker label of the first
   block kept. Episode missing a transcript or a curve → no `shape`, no
   `moments`, and NOTHING says so (absence-is-silent rule).

## Phase 2 — surfaces

- **Panel, How-people-watch tile**: small markers on the drop-off SVG at
  each moment's `at` (down-tinted for drops, up-tinted for holds); each
  marker is a `data-tip` target reading like
  `"32% through · about 38 minutes in — ‘…excerpt…’ — 2.1 points left"`.
  Markers exist only when moments exist. Keyboard: tabbable, same tooltip.
- **Watching chart**: unchanged in phase 2 (markers on six overlaid curves
  would collide); revisit only if the panel markers prove useful.
- No new glance-layer numbers; the fold budget does not move.

## Phase 3 — engine integration

- `recommendations.mjs collectFacts()` adds per-episode shape facts
  (`open-floor-E3`, `mid-hold-E3`, …) and moment facts
  (`drop-E3-32`: value = points lost), plus an `excerpts` context array
  (id → excerpt text) passed to the model ALONGSIDE facts — excerpts are
  quotable context, not numbers.
- System prompt gains: name a moment by its position in plain words ("about
  a third of the way in"); treat transcript timing as approximate; never
  claim the words caused the exit — recommend a test (trim, tighten,
  re-order) instead. Number-grounding validation unchanged.

## Validation contract (extend validate.mjs)

- Moments: `at` ∈ [0.05, 1], `points` ≥ 1.5 for drops, spacing ≥ 0.05,
  ≤ 5 per episode; `excerpt` must be a verbatim substring of the episode's
  transcript file; `estSec` within the derived duration; `approx` matches
  the >5% channel-duration disagreement; episodes without transcript or
  curve carry neither `shape` nor `moments`.
- Absence stays silent on every surface (existing 1j regex extends to any
  new copy).
- Panel markers: rendered only from `episode.watch.moments`, count parity,
  tabbable, tooltip-backed (source-level checks in 1k).
- Rebuild-currency (check 7) already proves determinism end to end.

## Acceptance

1. E1–E5 each show 1–5 moments with excerpts that match their transcripts
   verbatim; E6 shows none (no curve yet) with no explanatory copy.
2. Validator green; plain-words ban holds on all new reader-facing text.
3. The next engine run can cite a mid-video exit with its excerpt context.
4. Panel screenshot shows markers + tooltip at 1440 and 390 widths.

## Out of scope / later

- X-side retention (X reports no equivalent data).
- Automatic chaptering or edit-list generation from moments.
- Whisper-level re-transcription or speaker re-identification.
- Cross-episode topic clustering of exit moments (needs more episodes).

## Open questions

- Drop threshold (1.5 points over 2 steps) is a first guess — calibrate on
  the five real curves before freezing, and record the chosen value here.
- Whether holds (positive bumps) earn panel markers or engine facts only —
  decide from how noisy the real bumps look.
