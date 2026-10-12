# X live minutes before E5 are absent, not zero — 2026-10-12

## Finding

The episode panel's live session showed, for E1–E4, X rows such as
"@ridd_design 463 watched · 0 min". The Average live viewers tooltip gave
those destinations an average of 0, and the Live viewers by minute tooltip
gave them 0 viewers at the minutes where Restream had saved a point. None of
these zeros is a measurement (rule 2).

The raw Restream events show it. On all four nights both X destinations come
back with the placeholder Restream also gives LinkedIn, which never reports
viewers: `max 0`, `mean 0`, `watchedTime 0`, and a two-point
`viewersPerMinute` (start and end, both 0) in place of a per-minute series.
The same rows carry real readings that Restream did report — views, and chat
from people who were plainly watching on X:

| Ep | event | @ridd_design views · chat | @designertom views · chat | X peak / avg / min | X per-minute points |
|---|---|---|---|---|---|
| E1 | `4ae9a07c…` | 463 · 20 from 10 | 285 · 15 from 8 | 0 / 0 / 0 | 2, all 0 |
| E2 | `871beebc…` | 580 · 8 from 3 | 243 · 7 from 5 | 0 / 0 / 0 | 2, all 0 |
| E3 | `e961d77d…` | 557 · 13 from 8 | 397 · 3 from 3 | 0 / 0 / 0 | 2, all 0 |
| E4 | `46fea3c1…` | 673 · 17 from 8 | 213 · 6 from 2 | 0 / 0 / 0 | 2, all 0 |

From E5 (`40ba7e2c…`) every X destination has a full per-minute series (96
points on E5) and positive minutes (665 and 285). This is the reporting break
already declared in `baselines.KNOWN_BREAKS` (`restream-live-per-channel-2026-08-13`,
`fromEp: 5`).

## Decision: a declared exception tied to the break

`build-data.projectLiveSession` keeps an explicit provider zero as zero, and
that stays the rule. The fix is not a general change: the break now declares
what Restream did not report before it, in one place —

```js
unreported: {
  platform: "x",
  fields: ["peak", "avg", "watchedMin", "series"],
  reason: "Restream did not report X's live viewers or minutes watched before E5.",
}
```

— and `projectLiveSession(ev, registry, { ep })` applies it through
`baselines.unreportedLiveOf(episode, platform)`. The platform comes from the
destination URL (`x.com/i/broadcasts/…`). Before E5 an X row's peak, average and minutes
watched are `null` and the row carries the reason. Every minute of its
`live.series[].byChan` value is `null`, and the destination keeps its place.
Views and chat on the same rows stay, because Restream reported them.
Untouched: YouTube rows, X rows from E5 on (E6's @designertom has 17 real
zero minutes, still zero), LinkedIn rows, and every session total
(`live.peak`, `avg`, `liveViews`, `watchedMin`, `series[].v`), which are
Restream's own session numbers.

What moved in `data.json`, by path (diffed against the 07:07 build):
8 rows × `peak`, `avg`, `watchedMin` → `null` plus `reason`; 10 per-minute
values (the placeholders' start and end minutes) → `null`;
`baselines.knownBreaks[0].unreported`; `generatedAt`. Nothing else.

## Surfaces

| Surface | Before | Now |
|---|---|---|
| Episode panel, Live session → By destination (click) | `463 watched · 0 min` | `463 watched`, and once below the rows the stored reason |
| Average live viewers tooltip → Average by destination (hover) | X `0` | X `not available` and the reason as a note |
| Live viewers by minute tooltip (hover) | X `0` at a placeholder minute, `not available` elsewhere | X `not available` every minute, and the reason as a note |
| Glance layer (hero, cards, table, sparkline) | session totals only | unchanged — absence stays silent |
| About → Episode health | — | one sentence: X's live viewers and minutes before E5 were never reported, so they are blank, never zero |
| Agent brief | channel rows never reached it, though the census listed `episodes[].live.byChannel[]*` as consumed whole | census corrected: `episodes[].live.byChannel` is left out with a reason; section 3 prints the declaration with its reason; `agent.json` carries it in `knownBreaks` |
| Recommendation facts, Slack, alerts | no per-channel live number | unchanged (fact sheet identical apart from `generatedAt`) |

The page renders only what the store says: one helper, `liveReasons(live)`,
lists the distinct stored reasons, and each surface prints them once. The
sponsor page (`sponsors.html`, `data.sponsor`) is on the unmerged
`sponsor-page` branch, not on main. It reads session totals and already says
X's live hours count from E5, which agrees with this reason. The vault capture
log written by `ingest-restream.mjs` records what Restream returned at first
ingest (L1). No new ingest is from before the break.

## Frozen stores: nothing re-derived

No frozen read uses these values. Episode health's live check
(`ratings.mjs`, `health21-v3`) reads the session peak and `liveChatOf` (the
LinkedIn row's chat only). Show health (`health.mjs`) reads session-level
numbers only. `health-history.json` cites only session `live.watchedMin`.
Checked, not assumed:

- `ratings.mjs --dry` output is byte-identical before and after
  (`0 computed, 10 frozen kept`), and validator 1g replays the frozen store.
- `computeAll` + `computeHealthInputs` at a pinned instant, old tree against
  new, are identical for the show-health inputs, every episode's health, the
  saved health read, the insights and all of `baselines` except
  `knownBreaks`.
- No file under `data/restream/` changed. No `ALGORITHM`, `FORMULA_VERSION`,
  `REDERIVES` step or `rederivedFrom` is needed.

## Validator

Block 3a re-derives the exception from the definition and the raw event, on
its own code path (platform from `matchRestreamDestination`'s identity, not
the builder):

- each declared field of a pre-break row is expected `null`, and every minute
  of a declared series is expected missing;
- the row must carry the break's reason, and no other row may carry one;
- the declaration may only blank a zero. A declared field that reads above
  zero in the raw event fails, because a reading would be hidden;
- the break holds together: `from` is the episode numbered `fromEp`, the
  platform and fields are ones a row can carry, and the reason names
  `before E5`;
- a fixture runs the projection on one night with a YouTube and an X
  destination, before and from the break.

Block 1w fails when `agent.md` does not print the declared reason. All are
fail tier: they re-derive an absence and a definition.

Tamper probes, each in a disposable clone (control: 0 failures):

| Probe | Result |
|---|---|
| the 07:07 `data.json` (with the zeros) shipped against the new code | 48 failures — every X row's peak/avg/minutes, the missing reasons, the per-minute series |
| raw E3 X `watchedTime` set to 42 | fails: "a reading would be hidden" |
| raw E2 X per-minute point set to 3 | fails: "1 per-minute reading(s) above zero … would be hidden" |
| reason no longer names E5 | fails: "gives no reason naming E5" |
| `watchedMin` misspelled in `fields` | fails: "declares unreported fields it cannot apply" |
| reason dropped from one E1 row | fails: "does not carry the known break's reason" |
| reason added to an E5 row | fails: "carries a reason no known break declares" |
| builder ignores the declaration (rebuilt) | 27 failures, including the fixture's "before the break an X fixture peak became 0" |
| `agent.md` without the reason | fails: block 1w |

## Queued for the owners (not changed here)

1. **Episode health compares post-break live peaks with YouTube-only ones.**
   Before E5 X reported no concurrent viewers, so the session peak and
   average of E1–E4 are YouTube's alone. For example, E1's peak is 90 against
   YouTube channel peaks of 67 + 26. From E5 the session peak includes X
   viewers (E5: X peaks 15 and 10). The break declares only `liveViewers` and
   `minutesPerViewer`. The frozen `health21-v3` live checks of E5–E10
   therefore read E1–E4 peaks as peers: E5's 64 against a typical of 71 from
   E1, E2 and E4 (live score 31). E3 was left out as a promo outlier. The
   same will freeze into E11 (its window E3–E10 still holds E4; read due
   about 2026-10-15) and E12 (window E4–E11, about 2026-10-22). Adding
   `peak`/`average` (and, for show health, `minutesWatched`) to the break's
   measures is a definition change. It needs a declared `health21-v3 → v4`
   step in `ratings.mjs` `REDERIVES`. It would also leave every live check
   from E5 to E10 with fewer than three post-break peers (0, 1, 2, 2, 2 and 2
   after the stored exclusions), so those checks would drop out and their
   weight move to the others. That is the owners' call.
2. **The break's note overstates one thing.** "(E1–E4 counted YouTube only)"
   is true of concurrent viewers and minutes, but not of the unique-viewer
   total it sits beside. E1's 1,131 live views are 383 on YouTube plus 748 on
   X. The not-like-for-like conclusion stands, because X's pre-break live
   views run about twice its later ones (853 an episode for E1–E4, 421 for
   E5–E13). The note is printed on affected rows of the brief, so a rewording
   is a copy change to decide with item 1.
3. **LinkedIn rows** have the same placeholder shape and are already blank by
   label in the projection. Their reason lives on `episode.linkedin` and
   `sourceStates.linkedin`, not on the row. Left as is.

## Release note

The page, code and generated files ship together: the release gate validates
the committed bytes before it rebuilds, and a source-only push cannot carry
`index.html`. `data.json`, `data.js`, `agent.md`, `agent.json` and `llms.txt`
were rebuilt from the unchanged stores of the 2026-10-12 07:07 refresh. No
store under `data/restream/` is committed. If main moves first, a conflict on
the generated files resolves by taking main's tree and rebuilding.
