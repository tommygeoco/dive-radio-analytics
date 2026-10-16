# A late Restream export replaces the captions copy — 2026-10-16

Follows the E14 morning of 2026-10-16. A Whisper copy saved under the reserved name
`e14-transcript-2026-10-15.txt` stopped the 07:00 and 08:15 runs (fixed in `bd91361`: a
vault file with no speaker lines is skipped). The episode-notes skill now saves Whisper
copies as `e<n>-whisper-transcript-<date>.txt`. This ledger records the finding that
those two fixes leave open, the owners' decision, and the change that carries it out.

## Finding

`transcripts-pull.mjs` saved YouTube auto-captions permanently on the first run of day two
(the Phoenix date after air) when the vault held no Restream speaker export. From then on
the episode "already had a transcript", and the vault was never read for it again.
Validator 5a failed "exists in the owner vault but was not imported" only when the file was
missing. A late export beside a captions copy was therefore ignored without any warning.

E14's export reached the vault at 09:20 on day two. It was imported only because both
morning runs had failed for another reason and the operator repair ran at about 14:30.
With `bd91361` in place that morning, the 07:00 run would have saved captions, and the
export would never have become E14's transcript.

When the exports reached the vault (birth times on the Mini):

| Episodes | Landed |
|---|---|
| E7–E13 | air day, 15:07–19:13 |
| E14 | day two, 09:20 |
| E4, E6 (before the importer) | day two, 11:17 and 12:09 |

## Options weighed

- **(a) Replace.** A speaker export that reaches the vault after captions were saved
  replaces them, through a declared step.
- **(b) Wait longer** before saving captions. This narrows the window but cannot close
  it, because the table above has no upper bound. It would also delay the transcript by
  a day for every episode that never gets an export.
- **(c) Both.**

**Owner decision 2026-10-16: (a).** Tommy approved the recommendation in the session that
built this change.

## The change

- **Trigger.** `transcripts/<slug>.txt` exists and is a captions copy (`isCaptionsTranscript`:
  header line three is `Source: YouTube auto-captions…` and the file has no timed speaker
  lines). `planVaultTranscript` also finds a speaker export with that episode number and air
  date. A speaker transcript, whether imported from the vault or staged by hand, is never
  replaced. The earlier test "changed source must not replace canonical" still holds.
- **Order, so a crash never leaves the store inconsistent:**
  1. The episode's chapters entry moves unchanged under `chapters.json superseded[]` with
     `why: "transcript changed"`, the shape chapters.mjs already writes, under the chapters
     source lock. The chapters clock (`updatedAt`) is left alone.
  2. The transcript is replaced atomically, and only if it still has the bytes that were
     read. The new file is exactly what an on-time import writes, so 5a's vault-parity
     checks apply unchanged.
  3. `transcript-state.json` records `vault:<file>` and appends
     `replaced[]: {sha256, objectId, replacedAt}`. Later runs keep that history.
- **Chapters.** The episode has no entry, so `chapters.mjs` writes a fresh list the same
  morning and stamps `rederivedFrom` from the superseded list.
  - Superseding is required, not tidy-up. The first `validate` of the run checks the
    chapters store against the transcripts (`chapters.validateStore`, sha mismatch) before
    the chapters step runs. Without step 1, every morning would fail at that `validate`
    and never reach the step that could repair it.
- **Validator 5a** fails when a captions copy is kept beside a vault speaker export, the
  same rule that already fails a missing file. It also fails when a `replaced[]` entry is
  malformed, or when the current file is not a vault speaker export.
- **`chain.json`.** The transcripts step declares `data/restream/chapters.json` in `writes`.

## Left alone, with evidence

- **Clock checks** are keyed by transcript sha, and `clock.mjs linkableUpload` ignores a
  check made for another sha. Exact YouTube links return after the next owner
  `clock-check.mjs` run, the same state every new speaker transcript starts in (E14 has
  no check today).
- **Moment summaries** are keyed by `slug|kind|at`, the moment's place on the retention
  curve, not by transcript words. They describe the same stretch of the show and are reused.
- **Watch moments, sponsor counts, partner moments and the brief** are re-derived from the
  transcript by build-data on every build and re-checked by validators 1m2 and 1s.
- **The 08:00 mirror** skips an episode once the vault has any `e<n>-transcript-*` file. The
  vault already holds the export, the real source (see "Queued").

**Effect on today's stores: none.** E1, E3 and E5 are the only captions transcripts, and their
vault files are captions copies with no speaker lines (checked on the Mini). So nothing
historical is rewritten.

## Proof

- `audit/transcripts-pull.test.mjs` replays E14's morning:
  - At 07:00 on day two, captions are saved.
  - The mirror's captions copy sits in the vault; a later run keeps the captions without
    a warning.
  - The 09:20 export lands; a dry run changes nothing.
  - At 07:00 on day three the export replaces the captions. The result is byte-identical
    to an on-time import, the chapters are superseded unchanged, `validateStore` passes,
    and putting the old entry back fails with a sha mismatch. The ledger records `replaced[]`
    and source integrity is clean.
  - The swap happens once (an edited export later is not taken), and it refuses a file that
    changed after it was read.
  - Eight mutations were tried; all are killed.
- `audit/model-failures.test.mjs`: the fresh chapters list names the superseded one in
  `rederivedFrom` and does not supersede it a second time.
- Real data: `validate.mjs` with a copy of the Mini's vault transcripts (`DIVE_TRANSCRIPT_VAULT`)
  exits 0. With a speaker export added beside E1's captions it fails with "…the YouTube
  auto-captions copy was kept".
- End to end in a throwaway clone (the same E1 export): transcripts-pull replaces E1 and
  supersedes its list, `build-data` and `validate` exit 0, E1 shows "chapters not written
  yet", and every dirty path is inside publish scope.

## Known edge

If an export lands between the transcripts step and `validate` in the same run, that
attempt fails. The race already exists for a missing file, and recovery reruns.

## Queued

- **The mirror's captions copy.** The mirror copies a captions transcript into the vault
  under the reserved name `e<n>-transcript-<date>.txt`. After a replacement, that stale
  copy stays next to the export, and `clips.mjs findTranscript` or search may pick it.
  Options: the mirror skips captions copies, or it names them `e<n>-captions-transcript-…`.
  Either is a change on the vault side.
