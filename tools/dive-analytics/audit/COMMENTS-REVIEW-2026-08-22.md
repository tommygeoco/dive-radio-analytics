# COMMENTS-REVIEW — 2026-08-22

**Verdict: fix-before-trust.** The plumbing (dedupe, escaping, additive merge) is mostly sound. The praise picker is not: the dashboard is featuring a viewer complaint as the top quote for the 2026-08-06 episode *right now*, and the validator passes it. Two data-loss paths and an absence≠zero gap back that up.

Scope: `scripts/restream/comments-pull.mjs`, `tools/dive-analytics/build-data.mjs` (attachComments), `tools/dive-analytics/index.html` (card hover panel), `data/restream/comments/*.json`, `tools/dive-analytics/audit/validate.mjs`. All 6 comment stores read in full (29 stored comments).

---

## CRIT

### C1 — The praise heuristic features complaints. Live, today, in data.json.
- **Evidence:** `tools/dive-analytics/data.json`, episode `2026-08-06-dive-radio-backyard-designers-behind-the`, featured[0] (rank #1, highest score):
  > "Guys, love the show, but the quality is sooo poor. Like, come on, you're constantly talking about a high quality bar, craft, etc., yet we have to watch slideshows instead of videos, robovoices, drops" — qwertyPechenkO, 3 likes
- **Why:** `build-data.mjs:289` — `PRAISE` regex matches the substring "love"; nothing checks what comes after "but". `build-data.mjs:299` — score is `likes*2 + 1`, and this complaint has the most likes in the episode, so it ranks first. Featured[2] for the same episode is "banger episode ... @tom pls fix your streaming ! :D Its so glitchy" (matched "banger"), and featured[1] is "What is the beginning music guys? Help a fellow designer out lol." (matched `\blol\b` — a question, not praise).
- **Minimal fix:** add a veto regex (e.g. `/\b(but|poor|glitch|fix|boring|worst|slop|robovoice)\b/i` → excluded) before the PRAISE test, and drop `\blol\b` from the wordlist. Longer term, featured quotes need a human once-over before publish; a wordlist cannot read "love the show, but".

## HIGH

### H1 — A corrupt store file silently wipes history on the next run.
- **Evidence:** `comments-pull.mjs:34` — `loadJson` swallows any parse error and returns the empty fallback; `comments-pull.mjs` main loop then merges the (empty) store with today's pull and `saveJson` (line ~37, non-atomic `writeFileSync`) overwrites the file.
- **Repro:** truncate any `data/restream/comments/*.json` mid-file; next cron run rewrites it containing only what today's APIs return. Everything outside the current window — all X replies older than 7 days, YT comments beyond the newest 100 — is gone permanently, with no error, exit 0.
- **Minimal fix:** in main(), if the store file exists but fails to parse, skip that show with a WARN instead of resetting; write via temp file + rename.

### H2 — Absence≠zero violation: episodes 1–5 look like they have no X replies.
- **Evidence:** the pipeline first ran 2026-08-22 (`firstSeenAt` on every stored comment). Episodes 2026-07-17 through 2026-08-13 were already past the 7-day X search window (`comments-pull.mjs:118`, `ageDays > X_SEARCH_WINDOW_DAYS + 1` skip), so their stores contain zero X comments — not because nobody replied, but because we can no longer look. Nothing in the store, `data.json`, or the UI marks this. `build-data.mjs:303` sets `comments.total` blending full-history YT with never-covered X.
- The window guard itself is correct going forward (skip means no pull; merge at `comments-pull.mjs` main loop is additive by id — verified stored X comments are never deleted when a show ages out). The violation is the missing coverage marker.
- **Minimal fix:** record per-show `xCoverage: "never" | "windowed"` at pull time (was the show ever pulled inside the window?), carry it into `e.comments`, and if the UI ever shows counts or "no X replies", gate it on that flag. Today the hover panel only shows quotes, so the lie is latent — but the data file already tells it.

### H3 — Host exclusion covers the brand channels, not the humans.
- **Evidence:** `comments-pull.mjs:29` — `HOST_YT_CHANNELS = {UCkCnraWwlnBw1_i7C9-3p0w (joindiveclub), UC4_qP33t3TGpEM0-96WfC6Q (designertom)}` (mapped in `postlive-track.mjs:49-52`). Ridd is a host, is excluded on X (`ridd_design`), but has no YT channel in the set. If Ridd comments on a YT upload from a personal channel, he passes the filter and — since host comments tend to collect likes — likely tops the featured quotes. "Featured praise, by the co-host" is exactly the embarrassment this exclusion exists to prevent. The X side is fine: exact username match, lowercased (`comments-pull.mjs:130`), usernames are unique, so no false exclusion either.
- **Minimal fix:** confirm Ridd's personal YT channel id and add it to `HOST_YT_CHANNELS`; leave a comment naming which id is whom.

### H4 — The validator would not catch any of the above.
- **Evidence:** `validate.mjs` "featured comments sanity" block (near end): checks cap ≤3, author/text present, host *names* (display-name match only — H3's personal-channel case passes), 200-char cap, and a `/<script|javascript:/i` pattern. It has no sentiment check (C1 passes today — confirmed by running it), no store-integrity or count-regression check (H1's wiped store just shrinks `total` silently), and no X-coverage check (H2 invisible).
- Run result (2026-08-22 09:16): exit 1 — but only from **publish integrity** ("public repo data.json/data.js differs from source of truth"), i.e. the public dashboard is currently stale relative to the source build. The comments check reported `ok`.
- **Minimal fix:** (a) add a count-regression check — compare each store's `comments.length` against the count embedded in the last committed data.json, fail on shrink; (b) add a veto-word check on featured text mirroring C1's fix; (c) fix the stale publish.

## MED

### M1 — YT reply threads are never collected.
- `comments-pull.mjs:62` requests `part=snippet` and reads only `topLevelComment` (line 70). Audience replies inside threads are invisible; X, by contrast, captures nested replies via `conversation_id`. Undercounts YT and skews `total` asymmetrically. Fix: request `part=snippet,replies` or accept and document top-level-only.

### M2 — No pagination on either source.
- `comments-pull.mjs:62` (`maxResults=100`, no `pageToken` loop) and `:121` (`max_results=100`, no `next_token`). A video with >100 top-level comments loses everything past the newest 100 at first backfill; daily incremental runs mask it afterward. Current volumes (≤8/episode) make this latent, not active.

### M3 — Edited and deleted comments: first version wins, forever.
- `comments-pull.mjs` merge loop: for a seen id, only `likes` is updated, and only upward. Text edits never land; a comment deleted on YT/X stays stored and can stay featured (append-only is intentional per header comment, but featuring content the author deleted is a taste risk). Also, like-count retractions never lower the stored count, so ranking can overstate.

### M4 — 429 handling recurses without a bound.
- `comments-pull.mjs:52-56` — `getJson` calls itself on every 429 with no retry cap. A persistently rate-limited endpoint loops until the cron's outer timeout. Fix: cap at 2 retries then throw (per-show try/catch already contains the blast radius).

### M5 — Cross-post double-feature possible.
- One episode = two YT uploads (`postlive-registry.json`, e.g. 2026-07-17 has videos on both channels). Two comments on two videos is legitimately two comments, and `total` counting both is defensible — but a viewer pasting the same praise on both uploads gets two ids and can occupy two of the three featured slots with identical text. No dedupe-by-(author,text) in `build-data.mjs:297-302`. Not yet observed in data (BetterNeil/BentoBox comment on both channels but with different texts).

## POLISH

### P1 — XSS: render path is correct today; fragile edges noted.
Traced end to end: YT text is entity-decoded at store time (`comments-pull.mjs:60`, so stores can hold raw `<`), stored raw, and escaped **at render time** — the correct architecture. The only DOM insertion for comment text/author is `index.html:572` inside `showCardTip`, both wrapped in `esc()` (`index.html:216` — escapes `& < > "`), landing in text-node context of an `innerHTML` template. Tried payloads: `<img src=x onerror=alert(1)>` → escaped inert; `" onmouseover=...` → never reaches an attribute (no user data goes into attributes); backtick/`${}` → template literal is evaluated server…-side of the string, JS injection would need to escape the JSON layer, which `JSON.stringify` prevents. Author names take the same `esc()` path. Remaining edges: `esc()` skips `'` and backtick (safe only while user data stays out of attributes — one future single-quoted attribute breaks it); `data.js` embeds `JSON.stringify` output which does **not** escape `</script>` — safe only because `index.html:145` loads it via `<script src>`, never inline (inlining it later = instant XSS); U+2028/2029 are legal in string literals since ES2019, fine in modern browsers; `card.innerHTML` (`index.html:641`) inserts `short(e.title)` unescaped — registry titles are internal, but one `<` in a title breaks the card.

### P2 — Dedupe id namespacing is correct.
`yt:`/`x:` prefixes (`comments-pull.mjs:73,133`) make cross-platform id collision impossible. Merge is by-id, additive, verified against the stores. No finding — recorded so the next auditor doesn't re-derive it.

### P3 — Truncation can split emoji.
`build-data.mjs:302` `slice(0,200)` and `index.html:572` `slice(0,108)` cut by UTF-16 code unit; a surrogate pair on the boundary renders as �. Cosmetic.

### P4 — Doc/comment says "ranked by likes + positive signal"; the code is likes-only.
`build-data.mjs:299` — `score = likes*2 + 1`; the `+1` is constant, praise contributes nothing beyond the binary filter. `build-data.mjs:287` and the pull-script header oversell it. Also `store.comments.find` inside the merge loop (`comments-pull.mjs`) is O(n²) — irrelevant at current volume.

### P5 — Wordlist substring hazards (not yet fired, will fire).
`build-data.mjs:289` — unanchored substrings: `peak` matches "speaking"/"speaker" (a podcast!), `fire` matches "fired", `best` matches "asbestos", `great` matches "greatly". Only `lol` got a `\b`. False-negative side, from the actual stores: "finally a release notes successor" (3 likes, ep1's top-liked comment — missed), "this is like mkbhd waveform podcast equivalent but for design industry" (3 likes — missed; 2026-08-13 shows `featured: []` despite it), "I think 90 mins is perfect!" ("perfect" absent from list), "Excited for this!… Thankful for you guys…" (missed), "Very cool first show!" (missed). Sarcasm/spam held up okay in this sample: "this show is boring af…" and "Seek first the kingdom of God 📖" both correctly excluded — by luck of vocabulary, not by design.

---

## Three fixes first

1. **Kill C1 today:** add the negative-veto regex to `attachComments`, drop `\blol\b`, rebuild, republish. The 2026-08-06 card must stop featuring "the quality is sooo poor" this morning.
2. **Make the store loss-proof (H1):** parse-failure → skip + WARN (never reset), atomic write, and a validator count-regression check so a shrink can never ship silently.
3. **Mark X coverage (H2 + H3):** persist `xCoverage` per show, surface it wherever counts appear, and add Ridd's personal YT channel id to the host set before he congratulates himself into the featured slot.

Constitutional check: absence≠zero — violated latently by H2, fix specified; never fabricate history — the additive merge honors it, H1 is the one path that breaks it; X impressions as views — not touched by this pipeline (likes only), no violation found.

Validator run log: `node tools/dive-analytics/audit/validate.mjs` → exit 1, 2 failures (both publish-staleness, unrelated to comments), 6 warnings (small YT view dips); comments check: `ok` — which, given C1, is itself finding H4.
