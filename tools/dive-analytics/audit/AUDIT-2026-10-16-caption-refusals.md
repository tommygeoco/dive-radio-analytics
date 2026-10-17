# YouTube caption refusals wait instead of stopping the publish — 2026-10-16

Follows the sponsor-page session of 2026-10-16 (`acc8f9e`). It met the refusals while running
the clock check on the owner machine, upgraded Homebrew yt-dlp to 2026.08.19, and moved
`clock-check.mjs` to `en-orig` first. `transcripts-pull.mjs` was left for this change because it
is the required `transcripts` step.

## Finding

- `downloadEnglishVtt` asked yt-dlp for `--sub-langs "en.*"`, every English track at once,
  including YouTube's `en`. On these uploads `en` is often YouTube's machine translation of
  another auto-caption track. On 2026-10-16 every `en` download from the owner machine got
  `HTTP Error 429: Too Many Requests`. `en-orig`, the upload's own English speech recognition,
  downloaded at once.
- yt-dlp exits non-zero when one requested track fails. That error did not match the
  expected-delay test (captions pending, not published, no subtitles, no automatic captions).
  So the day-two captions fallback recorded `failed` and threw "caption download failed".
  `transcripts` is required and has no retry, so the chain stopped before build-data and
  nothing was published. The 08:15 recovery would then spend the day's second attempt on the
  same request an hour later.

## Decision: a refusal is a wait

A refusal is YouTube turning the download away: HTTP 429, or its "Sign in to confirm you're not
a bot" check. It now leaves the episode `pending` with a plain reason, and the step exits 20.
The reliability PRDs support this:

- **v11 rule 24:** "A morning publish stops only when a number would be wrong." No number reads
  a transcript. Without one, the episode's chapters, moments, partner moments and exact links are
  absent (absence ≠ zero), and every other number that morning is current. Stopping withholds all
  of them for a source that is asked again anyway. That is the pattern v11 §0 recorded: no
  blocked publish protected a reader from a wrong number.
- **v13 §1 (outcome 2) and rule 30:** an unavailable source is published as unavailable, the
  saved state names the condition, and the owner hears about it after the final recovery check of
  the day. The chain already does this for `transcripts`:
  - `run-chain.mjs` lists the step in `SOURCE_PENDING_STEPS`, so exit 20 continues to the
    publish without a retry (`scheduler-contract.test.mjs` locks it).
  - `run-daily.mjs` saves the attempt as `waiting:sources`.
  - At 08:15 the recovery check defers; at 12:15 it runs the reserved attempt, which asks YouTube
    again about five hours later.
  - If that final attempt still waits, it queues one dated line: "Daily publishing source data
    remains unavailable on <day>: E<n> transcript: <reason>".
- **v13 rule 31:** waiting "is not retried inside the same chain because the reserved full run
  owns the later check." A retry 60 s later would be refused too.
- **v13 §10 states:** `pending` means a source response has not supplied the report; `failed`
  means the request, parsing or validation failed. A 429 or a sign-in check is YouTube answering
  a well-formed request with "not now". The clock check made the same call the same day: a failed
  download is `pending` with yt-dlp's own words, never a failed step. The same section's
  failure-risk row asks that a rate limit give "bounded calls, nonzero error, no numeric
  promotion". Exit 20 is that nonzero result; run-chain reads it as "unavailable", not "broken".

**Still a stopped step (unchanged):**

- any other download failure (HTTP 403 is locked by the existing test);
- a missing yt-dlp;
- captions with no readable cues;
- a write failure;
- conflicting vault speaker copies.

Each of these needs a person; asking again tomorrow would not fix it. A hard error on one upload
still stops the step even when the other upload was refused.

## The change

- **`CAPTION_LANGS = ["en-orig", "en"]`.** One yt-dlp request per track, vtt as before, with the
  same file pick.
  - `en` is asked for only when the `en-orig` request left no file.
  - A failed request ends the download, so `en` is never asked for after YouTube refused
    `en-orig`.
- **`REFUSED`**, the clock check's test, marks an upload refused. The next upload is still
  asked: it is another video, and on 10-16 only the translated track was refused.
  - The clock check stops at the first refusal because it walks every upload of every episode.
    The transcripts step asks about one or two uploads of a day-two episode, at most four
    requests.
- **The reason** (`refusalReason`) is one of two fixed sentences:
  - "YouTube refused the caption download for now (too many requests); it is tried again on the
    next run."
  - "…until this machine signs in; …"

  It reaches the page's episode note, the agent brief and the alert, so it carries no codes.
  yt-dlp's own line goes to the run log as a WARN.
- **One definition, held by a test.** Both caption readers define `CAPTION_LANGS` and `REFUSED`,
  and `transcripts-pull.test.mjs` (a fail-tier validator fixture) holds the two copies equal.
  `transcripts-pull` cannot import the clock check's copy: clock-check → contributors-import →
  transcripts-pull would form a cycle, and a required step would depend on an optional one.

## Proof

`audit/transcripts-pull.test.mjs`:

- **Injected downloads, shaped the way execFileSync throws them.**
  - A 429, and separately a sign-in check, on both uploads: the episode waits as `pending` with
    its reason. Both uploads are asked, and yt-dlp's words reach the WARN.
  - A refusal beside "captions pending" still names the refusal.
  - The next run, with the first upload refused and the second served, saves the second upload's
    captions as `ready`.
  - A 403 beside a refusal still throws and records `failed`.
- **The real download path, against a stand-in yt-dlp** (`/bin/sh`, no network). It answers by
  video id the way YouTube did on 10-16.
  - The request log shows one track per request, with `en-orig` first. `en` comes only after an
    `en-orig` request that left no file, and never after a refusal.
  - Of six episodes, three are saved and three wait. The ledger passes
    `sourceStoreIntegrityErrors`.
- **Eleven mutations, all killed:**
  - one `en.*` request (the old download);
  - `en` first;
  - no `en` fallback;
  - refusals not recognised;
  - `en` asked after a refused `en-orig`;
  - a refusal stopping the other upload;
  - a refusal recorded as `failed`;
  - the reason dropped;
  - the two reasons swapped;
  - the refusal test reading only the first line of the message;
  - a per-run file pick in place of the per-track pick.

**Effect on today's stores: none.** No transcript or store is rewritten. Only future day-two
caption pulls change.
