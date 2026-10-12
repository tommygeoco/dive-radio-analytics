# Live measures split at the E5 reporting break — 2026-10-12

Follows `AUDIT-2026-10-12-x-live-before-e5.md`, "Queued for the owners", items
1 and 2. That change made the X rows of E1–E4 absent rather than zero. It left
session-level comparisons alone because changing them is a definition change.
This ledger records the owners' decision and the change that carries it out.

## Finding

Before E5 Restream measured no live viewing on the X destinations. Each X row
reported views and chat, but its peak, average and minutes watched were zero
placeholders. So the session peak, average and minutes watched of E1–E4 are
YouTube's alone. From E5 they include X. The YouTube-only peak below is the
highest per-minute sum of the YouTube rows.

| Ep | session peak | YouTube-only peak | X's lift on the peak |
|---|---|---|---|
| E1–E4 | 90 · 71 · 53 · 63 | the same | none counted |
| E5 | 64 | 49 | +31% |
| E6 | 71 | 61 | +16% |
| E7 | 72 | 51 | +41% |
| E8 | 98 | 71 | +38% |
| E9 | 133 | 116 | +15% |
| E10 | 97 | 84 | +15% |
| E11 | 109 | 79 | +38% |
| E12 | 111 | 91 | +22% |
| E13 | 87 | 76 | +14% |

The known break (`restream-live-per-channel-2026-08-13`) declared only
`liveViewers` and `minutesPerViewer`. Three comparisons crossed it:

1. **Episode health's live check** (`health21-v3`) compared E5–E10's peaks,
   which include X, with E1–E4's YouTube-only peaks. E5 read 64 against a
   typical of 71 from E1, E2 and E4. That typical understated what a like-for-like
   peak would be, so the check favoured post-break nights. E11 (read due
   2026-10-15) and E12 (2026-10-22) would have frozen the same mix, each with
   E4 in its typical.
2. **Show health** compared the peak, average, minutes watched, chatters per
   hundred at the peak and hold rate with pre-break episodes. 36 of the 42
   saved reads did so, the last on 2026-10-08 (E12 newest, E4 a peer). Since
   10-09 the newest episode's window is E5–E12, and no read has crossed.
3. **Two measures the queue did not name.** Chatters per hundred at the peak
   counts X chatters over a YouTube-only peak before E5 (E1: 106, against 86
   for YouTube alone). The hold rate's audience changes at the break (from E5,
   X moves it by up to ten points). Both read the same session peak.

The brief's note also overstated one point. "(E1–E4 counted YouTube only)" is
true of watching at once and minutes, not of the unique-viewer totals: E1's
1,131 live views are 383 on YouTube plus 748 on X.

A related fact shaped the numbers: every episode from E7 on carries a promo
flag (E7 a promo outlier; E8–E13 a known newsletter promotion). Episode health
drops a flagged episode from every check, the live check included. So E5 and
E6 are the only post-break episodes that can be its peers.

## Options put to the owners

| | Option 1: leave and document | Option 2: split at the break |
|---|---|---|
| E5–E10 frozen scores | 36, 38, 57, 69, 67, 64 | 37, 37, 61, 73, 63, 66 (declared `health21-v3 → v4` re-derive) |
| E5–E10 live check | 31, 39, 39, 53, 86, 53 against E1–E4 | absent: 0, 1, 2, 2, 2 and 2 peers on their side |
| E11 / E12 live check | 81 / 72 on today's data, E4 in the typical | absent (E5 and E6 only on their side) |
| E13 on | absent either way (E5 and E6 only) | absent either way |
| Show health | unchanged | no number moves; formula bump restarts the trend |

**Decision (Tommy, 2026-10-12): option 2.** The re-derived store is committed
from this branch. Show health moves to `health-v11`.

## What changed

- **The break** (`baselines.KNOWN_BREAKS`) now declares every live measure
  built on viewer counts. Each is named under the key a comparison reads it by:
  `peak`, `average`, `liveViewers`, `minutesWatched`, `chattersPer100`,
  `minutesPerViewer`, `holdRate`, `livePeak` and `liveAverage`. Chat messages
  an hour stays out, because X reported chat on both sides. The note now says
  what was YouTube-only and what was not. `sameSideOfBreaks` serves comparisons
  that read an earlier episode rather than the newest.
- **Episode health `health21-v4`** (`ratings.mjs`). The live check takes peers
  only from the episode's side of every break on the peak. When that leaves
  fewer than three and the whole window would have had three, it is absent with
  `NOTE_BREAK`; otherwise it uses the plain reason. Its weight goes to the other
  checks. `REDERIVES` declares the `health21-v3 → v4` step. The step proves the
  stored v3 values (peak and compared chat) still match the live-event files.
  It then rebuilds only the live check, from the entry's own window and frozen
  verdicts, and re-weights. The v2 → v3 step still replays v3's own rule
  (`acrossBreaks`), so `FROZEN_BASELINE`, which is a v2 store, replays
  v2 → v3 → v4 exactly.
- **Show health `health-v11`** (`health.mjs`). Live turnout and participation
  take peers for every measure the break touches only from the newest side.
  When that leaves fewer than three, the reason is `NOTE_BREAK`.
  `computeDirection` gates each series by the declaration itself, so no
  measure key is hard-coded there any more.
- **Episode panel.** A check left out now shows its stored reason, one line per
  reason, instead of the fixed "fewer than three earlier episodes had a
  reading" (rule 17). That fixed text would have been wrong for E7–E10: each
  had five earlier episodes with readings.

## Episode health, before and after (2026-10-12 stores)

| Ep | v3 score | live (v3 peers) | v4 score | change | v4 live |
|---|---|---|---|---|---|
| E1–E4 | — | not scored | — | — | unchanged byte for byte; only `algorithm` and `rederivedFrom` move |
| E5 | 36 | 31 (E1, E2, E4) | 37 | +1 | absent, 0 on its side |
| E6 | 38 | 39 (E1, E2, E4, E5) | 37 | −1 | absent, 1 (E5) |
| E7 | 57 | 39 (E1, E2, E4, E5, E6) | 61 | +4 | absent, 2 (E5, E6) |
| E8 | 69 | 53 (E1, E2, E4, E5, E6) | 73 | +4 | absent, 2 (E7 promo outlier) |
| E9 | 67 | 86 (E1, E2, E4, E5, E6) | 63 | −4 | absent, 2 (E7, E8 out) |
| E10 | 64 | 53 (E2, E4, E5, E6) | 66 | +2 | absent, 2 (E7, E8, E9 out) |

Every other check is carried byte for byte apart from its weight. Without the
live check, E5–E8 and E10 weigh watch 0.4667, engagement and retention 0.2
each, and conversion 0.1333. E9, with sentiment, weighs 0.4118, 0.1765, 0.1765,
0.1176 and 0.1176. `ratings.mjs --dry` on the v3 store printed exactly these
six moves and "0 computed, 10 frozen kept — re-derived from health21-v3".

## Show health: no number moved

`computeHealthInputs` under v11, run against the saved 2026-10-12 read (v10),
gives identical checks, facts, direction, outlook and as-of. Every saved read
written under health-v5 to v10 (33 days and 4 superseded reads) kept unique live
viewers and minutes per viewer on one side: 74 measure readings checked, none
crossed. The direction lens reads
E9–E13. The cost is the trend line: it plots only reads under the running
formula. `data.health.trend` goes from 14 points to none and returns after
seven `health-v11` reads.

## Surfaces

| Surface | Before | Now |
|---|---|---|
| Episode health chip, table, panel, Slack sequence | E5–E10: 36, 38, 57, 69, 67, 64 | 37, 37, 61, 73, 63, 66 |
| Episode panel, Not compared (click) | "Live turnout, Goodwill — fewer than three earlier episodes had a reading." | "Not compared: Live turnout. Fewer than three episodes since the live-reporting change (from E5) to compare with." and "Not compared: Goodwill. Fewer than three earlier episodes to compare with." |
| About → Show health | live measures listed | adds: Restream began counting X's live viewers at E5, so everything built on live viewers compares only from E5 on; chat compares across |
| About → Episode health | — | adds: live turnout compares only with earlier episodes on the same side of E5; fewer than three there and the check drops out; E5 to E10 were re-read |
| Show health trend line (Why this score) | 14 v10 reads | restarts under v11 (saved reads keep their stamps) |
| Agent brief | note on two rows, with the YouTube-only overstatement | corrected note on all seven affected live rows; "touches" lists each measure once; definition "live-reporting change"; E8–E10 lines name their v3 scores |
| Slack (alerts 2d, 2d2) | — | on the next chain run, one line for the episode-health rules (each re-read score) and one when the first v11 read is saved |
| Recommendations (What matters) | 4 shown, 1 held back | unchanged |

Paths that moved in `data.json`: `episodes[E1–E10].health` (algorithm,
`rederivedFrom`; for E5–E10 score, live check, weights, `missingChecks`),
`health.trend`, `baselines.knownBreaks[].measures` and `.note`, and
`generatedAt`. Nothing else moved.

## Validator and tests

- **1g** (fail): the store must be `health21-v4`. Frozen bytes replay against
  `FROZEN_BASELINE` (v2 → v3 → v4) and HEAD (v3 → v4). Each live check's peers
  are re-derived from `windowIds`, the frozen outlier verdicts and the live
  files as every usable episode on the entry's side of each break on the peak.
  No peer may cross. An absent check must carry the re-derived sample and
  reason: `NOTE_BREAK` when the break is what leaves fewer than three,
  `fewPeers` otherwise.
- **3a** (fail):
  - The raw events must place the break. Before it X reported chat but no
    viewer count; on its first night X's viewers are counted.
  - `measures` must be exactly the live measures built on viewer counts.
  - The direction lens and every saved show-health read must keep those
    measures on one side, judged by the rules each read was written under:
    health-v5 for unique viewers and minutes per viewer, health-v11 for all.
  - Drift: the retired "E1–E4 counted YouTube only" note.
- **1w** (fail): each affected row of the brief must carry the note itself. It
  used to accept the note anywhere in the brief (see the last probe), which was
  enough while two rows carried it. Seven rows carry it now.
- **Fixtures.**
  - `ratings-rederive.test.mjs` is renumbered so its chat rules run on one side
    (E5–E9), plus a straddling set (E1–E8). That set covers: same-side peers;
    the break reason against the plain one; the v3 → v4 step for an entry
    before, at and after the break; the guard's refusals; a moved live file; a
    v2 → v3 → v4 replay; and the Slack line.
  - `baselines.test.mjs` adds a direction fixture: six live nights, with series
    the break touches reading E5–E6 only and chat reading E2–E6.

Tamper probes, each in a throwaway copy (control: the 14 vault failures below,
0 drift):

| Probe | Result |
|---|---|
| control, untouched copy | 14 failures (the vault sources, below), 0 drift |
| the v4 store keeps E8's v3 live check, relabelled v4 | 1g: HEAD replay "frozen rating bytes changed outside the declared re-derive"; "live check compares the peak across a known reporting break"; "live peers are not every usable episode on its side of the break" |
| the scorer ignores the break (`acrossBreaks` on by default) | 1g: replays from `FROZEN_BASELINE` and HEAD fail; the ratings fixture fails |
| the break forgets `peak` | 3a: "must split every live measure built on viewer counts … (missing peak)"; 1g replays fail |
| the break claims `messagesPerHour` | 3a: "not a viewer measure: messagesPerHour"; both fixture tests fail |
| the retired note restored | drift: "still says E1–E4's live-viewer totals counted YouTube only" |
| the direction lens no longer gated | baselines fixture: "liveAverage reads only the nights since E5" |
| a saved v11 read compares the peak with E4 | 3a: "the 2026-10-12 show-health read (health-v11) compares peak across the known break" |
| E7's absent live check given the plain reason | 1g: "live check is absent with 2 peers and … its side of the break has 2", plus the HEAD replay |
| E5's raw X viewer counts zeroed | 3a: "the raw events do not place known break … at E5", plus the live rebuild and provenance checks |
| the note removed from the brief's peak row only | first run: caught only because `agent.md` stopped reproducing, since 1w looked for the note anywhere in the brief. 1w now checks each row: "the known break is not noted on the peak row" |

## Release note

- **Rule 26, owner-approved exception.** `data/restream/episode-ratings.json`
  is committed from this branch: exactly the declared re-derive, which 1g
  replays. The v3 precedent shipped code only, but then validate and the full
  release gate could not pass on the branch, and a page change cannot take the
  source-only gate. The generated files (`data.json`, `data.js`, `agent.md`,
  `agent.json`, `llms.txt`) were rebuilt from the 2026-10-12 07:07 stores plus
  this store. No other store changed. `health-history.json` is untouched: the
  chain writes the first v11 read.
- **Merging.** If main's `episode-ratings.json` has moved by then (a daily
  `updatedAt`, or E11 frozen under v3 on 10-15), take main's copy, never this
  branch's. The chain's `ratings` step runs before `build-data` and `validate`,
  and it re-derives that store through the same declared step. A v3 E11 would
  then show its v3 score in `rederivedFrom`. Taking this branch's copy would
  drop any entry frozen since. Generated files resolve by taking main's and
  rebuilding.
- **Stacking.** This branch stacks on `claude/happy-gates-fdwyhp` (unmerged, no
  PR), which edits the same break declaration. Merging this branch brings both.
- **This container has no owner vault.** The validator reports 14 failures
  here, all from block 5a: `named vault source … is missing` for E7–E13's
  transcripts, the Obsidian vault on the owner machine. The untouched tree
  gives the same 14. Apart from those, validate gives 0 failures and 0 drift.
  The release gate stops at its first validate here for the same reason. Its
  remaining steps (63 audit tests, syntax checks, page scripts) and the
  ratings → build → validate cycle pass. Run the full gate on the owner machine
  before merging.
