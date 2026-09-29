# Audit 2026-09-29 — Sonnet 5.5 model route, comments, promo posts, LinkedIn

Owner request (2026-09-29): run every model task on Claude Sonnet 5.5 through the
API; thoroughly run and audit the LinkedIn analytics and health pulls; keep the
agent brief complete; account for comments and promo tweets consistently and
reliably.

## What had happened

Production did not publish on 2026-09-28 or 2026-09-29 (both attempts each day,
chain logs `chain-2026-09-28.log`, `chain-2026-09-29.log` on the owner machine):

- 09-28: the OpenClaw gateway's frontier model (gpt-6-astra) answered but failed
  the classifier golden gate — relevance 39/40, sentiment 22/24 (91.67%, needs 95).
  `runGoldenGate` stamped the failing configuration onto
  `comments-classified.json` anyway.
- 09-29: the gateway model request failed outright. The validator then read the
  store stamped the day before, found "current classifier config lacks a passing
  golden gate", and blocked publish (fail tier) — the whole dashboard, not just
  comments.
- Consequences: E11's 8 comments stayed unlabelled and were exported as
  "0 people commented / 0 per 1,000"; `recommendations.json` was absent (pruned
  below three items earlier), so What matters ran on fixed rules; the health read
  was two days behind.

## Findings and decisions

| # | Finding | Evidence | Decision |
|---|---|---|---|
| 1 | Six model scripts each carried their own model string, fetch, and OpenAI branch; default route was the gateway's frontier alias | `grep claude-fable-5`; stores stamped `openai/gpt-6-astra` | **Fixed.** `model-route.mjs` is the only route: `claude-sonnet-5-5`, Messages API, stated effort, adaptive thinking, stop-reason gate, one paced retry on 429/5xx/529. Source lock in `model-route.test.mjs`. Gateway kept as explicit rollback only. |
| 2 | A failing golden gate replaced the passing configuration and blocked every publish | 09-28/09-29 logs above | **Fixed.** Failed gate leaves stamps and labels byte-identical, records `lastRun.pendingIds`, fails only its own step. `classifier-golden.test.mjs` runs the real CLI both ways. |
| 3 | Validator bound the stored classifier/audience configuration to the prompt text in the code (fail tier) | `validate.mjs` configHash used `PROMPT_VERSION` + current prompt hash; `audience-integrity.mjs` required `promptVersion === PROMPT_VERSION` | **Fixed (tier split, rule 24).** Fail tier re-derives each store's integrity from its own stamps and golden result; "still the prompt in the code" is drift. A prompt change awaiting adoption no longer blocks publish. Nothing that was a store-integrity check moved to drift. |
| 4 | Prompt v2 misread jokes: both Sonnet 5.5 and gpt-6-astra scored 22/24 sentiment, missing the same two cases (`21-host-jab`, `31-orca`) | live golden runs on the owner machine | **Fixed.** Prompt v3 adds one rule: jokes carry the commenter's view of the show. Sonnet 5.5 passed 4 consecutive gates at 100% / 100%. Golden labels unchanged. |
| 5 | Unlabelled comments became zeros (rule 2) | E11 `commentersPer1k: 0`, `uniqueCommenters: 0`, Slack "0 people commented" | **Fixed.** `pending` count; counts, rate and themes `null` with a reason; page shows no pills, the brief marks feedback absent, Slack says "still being read", alerts skip the comparison. Validator mirror updated. |
| 6 | Goodwill balance stamped the newest episode while reading only older ones' labels; day-21 sentiment could freeze from a partial list | `health.mjs` balance, `ratings.mjs sentimentOf` | **Fixed (absence gates).** Balance waits while any of the three newest has pending comments; `sentimentOf` returns nothing for an episode still being read. No frozen number changes (no entry was pending at freeze). |
| 7 | Promo posts' impressions were summed into X reach, unevenly: none registered E1–E5, four on E10 | registry + per-post `sources`; E8 Ridd promo 15,837 > its broadcast post 7,847 | **Fixed per CARD-RULING-2026-08-21 Q2 and AUDIT-2026-08-21 F-9** (both already defined reach as the announce posts; never built). `x-posts.mjs`: announce post = carries the broadcast. Reach = announce posts; promo reach shown beside it (panel, brief), never compared or summed. Pre-09-04 blended readings are absent. Outlier flags and tiers verified identical before/after; frozen episode scores untouched (ratings never read reach). Show health formula `health-v10`. New validator block 1b2 re-derives the split from raw readings. |
| 8 | E7's two posts without a broadcast had no role; its X replay link pointed at a teaser | registry E7 `2092646157709185177`, `2093094217283506661` | **Fixed** by the same definition (no registry hand edit): they read as promo; links prefer the broadcast; a latched no-broadcast post never stands in. Validator 1r mirror updated. |
| 9 | Scored X replies came from any non-promo post, so coverage differed by episode | `comments-pull.mjs` `role !== "promo"` | **Fixed for future captures** (append-only store untouched): replies are read from announce posts and posts still awaiting broadcast resolution. |
| 10 | Agent brief dropped each post's role | `agent-brief.mjs` announces map | **Fixed.** Role carried and printed; promo reach per episode with an absence reason; X reach and promo post defined. |
| 11 | LinkedIn chatters counted in "chatters per 100 at the peak" while LinkedIn viewers are never reported; E11 (no LinkedIn stream) compared with peers that had LinkedIn chat | per-channel rows: E9 54.9 → 48.9 without LinkedIn; E11 unchanged 61.5 | **Fixed for show health** (`liveRatesOf`, health-v10): LinkedIn chat left out of both participation rates. |
| 12 | Ratings' live check compares chat messages including LinkedIn | `ratings.mjs` live check | **Fixed (code) — `health21-v3`; store re-derive released by the chain machine, before 2026-10-15.** Chat is `baselines.liveChatOf`, the one definition show health already used. Frozen entries change only through a declared re-derive the guard and validator replay. See "Finding 12" below. |
| 13 | E11's LinkedIn absence carried no reason | no `sourceStates.linkedin` | **Fixed.** `not-streamed` when the Restream session had no LinkedIn destination; `missing` when it carried LinkedIn chat but no broadcast matched. Silent on the page, stated in the brief. |
| 14 | LinkedIn total-views test could not fail (LinkedIn attached after totals were computed) | `linkedin.test.mjs` | **Fixed.** New test imports a LinkedIn plays reading and proves brief totals, Slack lines and page view keys are unchanged. |
| 15 | LinkedIn viewing analytics (plays, viewers, watch time, impressions, post comments) | `docs/linkedin-setup.md`, commit 50cff5e | **Not a code defect — access boundary.** Needs LinkedIn Community Management API approval for a company Page app plus Ridd's OAuth consent. Until then only links and live chat exist; every viewing metric stays null ("awaiting access"). Owner imports remain the stopgap. |
| 16 | Chapters on Sonnet 5.5 at `high` grounded 6 of 10 (979 output tokens); at `xhigh` runs varied (9, 10, then 4 of 10 in the production repair); an incomplete list was never retried | live debug on E11; repair log 2026-09-29 11:42 | **Fixed.** Chapters run at `xhigh`, 64k tokens, 10 min timeout; an incomplete list is retried on later mornings (max three), replaced only by one that grounds more, the old list superseded. Connection resets get one client retry (`UND_ERR_SOCKET` seen live). |
| 19 | The repair publish was refused by the release gate: the new golden-gate test assumed the committed store was stamped by another model, which stopped being true once Sonnet 5.5 stamped it | repair log 11:43; reproduced in a gate clone | **Fixed** (1500f11): the test seeds its own previous configuration. Full gate on the owner machine with 09-29 data: 60/60 tests, strict validator 0 failures, 0 drift. One operator repair per day is the rule, so production refreshes at the next 07:00 run. |
| 17 | Discovery finds 6–11 unregistered Dive Radio mentions a day and keeps no IDs | discovery receipts 09-24…09-27 | **Queued.** Most are pre-show posts for an episode not yet registered; they are matched once it is. Persisting skipped IDs changes the receipt schema — separate change. |
| 18 | Review backlog (684 audience records, 1 scored comment) has no resolution workflow | `audience-feedback.json` processing counts | **Queued.** Review items stay private by design; a resolve tool is new product surface. |

## Live verification (owner machine, throwaway clone — no publisher state touched)

- Classifier golden gate on Sonnet 5.5 + prompt v3: 4/4 runs at relevance 40/40,
  sentiment 24/24. E11's 8 comments labelled in 15 s.
- Audience feedback re-derived under prompt v3: 239 approved records across E2–E11
  (28 before), 382 E1 records left for the next run. The daily step handles 480 a
  run; run `scripts/restream/audience-feedback.mjs --all` once on the publisher after
  this change lands, or E1–E5 fill in over several mornings.
- Show health: saved in 19 s, grounded, provider `anthropic`, model
  `claude-sonnet-5-5`. Recommendations: five ranked items, grounded on the first
  attempt (25 s). Critic: complete report on Sonnet 5.5. Chapters: see 16.

## Finding 12 — episode health `health21-v3` (fixed 2026-09-29)

**Definition.** The live check compares peak viewers and chat messages. Chat
is now `baselines.liveChatOf(episode)`: the Restream session total minus the
LinkedIn channel row, absent when that row's count is unknown — the same
function show health's participation rates read (`liveRatesOf`, health-v10).
Peak needs no change: Restream never reports a LinkedIn peak. A peer counts
only with both readings, so the two typicals come from the same episodes (v2
kept two peer sets; identical on every stored entry, since every episode has
both). The check's stored `note` says "chat counted on YouTube and X only,
since LinkedIn never reports its viewers", which the panel already renders in
the row's hover (rule 17) — no page change. An episode whose own LinkedIn count
is unknown gets the check absent with `NOTES.liveChatUnknown`.

**Why it had to land before 2026-10-15.** E11 is the first episode not
simulcast to LinkedIn. Under v2 its whole-session chat (184, no LinkedIn) would
have been measured against peers' LinkedIn-inclusive typical (127): live check
79. Under v3 both sides leave LinkedIn out (184 vs 119): 81. Computed on the
09-27 stores, with today's outlier flags; E9 86 (v2 88), E10 53 (v2 53).

**The re-derive path (rule 9, rule 24).** `assertFrozenRatingsUnchanged`
accepted no change to frozen bytes, so any version bump was impossible. It
now takes a declared re-derive and stays exactly as strict otherwise:

- Same algorithm: every frozen entry byte-identical (unchanged).
- Different algorithm: refused unless `ratings.mjs` `REDERIVES` declares a
  chain of steps between the two, the new store's `rederivedFrom` names the
  immediately previous algorithm and it carries `rederivedAt`, and every old
  frozen entry is replaced by exactly — byte for byte, as `ratings.mjs` writes
  it — the entry the declared steps build from its stored bytes.
- The v2 → v3 step (`liveWithoutLinkedin`) rebuilds only the live check, from
  the entry's own `windowIds` and frozen outlier verdicts (reasons kept) plus
  the live-event files (frozen at first ingest). It first proves the entry's
  stored v2 live values still equal those files, so a changed input cannot
  ride in on a rules change. Every other check and field is carried byte for
  byte; weights and score are recomputed by the same code a fresh read uses;
  the entry gains `rederivedFrom {algorithm, score}`. An entry that froze with
  no live session keeps that.
- A from-scratch recompute is no longer possible: `computeRatings` throws when
  no declared step connects the stored and running algorithms.
- Validator 1g replays the step against `FROZEN_BASELINE` (E1–E5, forever) and
  HEAD (E1–E8 on the release day; thereafter the byte lock), requires every
  entry frozen before `rederivedAt` to name its earlier rules and score and no
  later entry to claim one, re-derives every live value from the live files
  through `liveChatOf`, and rebuilds the live score. Block 1u runs the new
  fixture (`audit/ratings-rederive.test.mjs`, fail tier) and locks the
  LinkedIn row to `baselines.mjs` among the scorers (drift tier — it reads
  source).

**Rejected.** (a) Recompute every entry from scratch under v3 — retention and
conversion read `mature` from the overwritten analytics file, so E5–E8 would
move for reasons unrelated to this finding and lose their frozen day-21 read.
(b) Exempt frozen entries whenever the algorithm string changes — that is the
loosening rule 5 forbids; a silent edit would pass with any version bump.
(c) A second LinkedIn subtraction in `ratings.mjs` — rule 16.

**Before → after on the real stores (09-27 data, local run).** Only the live
check moves; every other check and field is byte-identical.

| Episode | Live chat own (v2 → v3) | Typical chat (v2 → v3) | Live check | Score |
|---|---|---|---|---|
| E1–E4 | 383→340, 310→304, 169→169, 167→163 | not compared (fewer than three peers) | — | none (unchanged) |
| E5 | 100 → 98 | 310 → 304 | 31 → 31 | 36 → 36 |
| E6 | 127 → 119 | 238.5 → 233.5 | 40 → 39 | 38 → 38 |
| E7 | 92 → 89 | 167 → 163 | 39 → 39 | 57 → 57 |
| E8 | 137 → 121 | 167 → 163 | 55 → 53 | 70 → 69 |

Visible: the Slack episode-health line reads `09-03 69`; alerts line 2d2 says
once "Episode health scoring rules changed (health21-v2 → health21-v3). Each
finished score was re-read from its saved inputs: E5 36 → 36, E6 38 → 38, E7 57
→ 57, E8 70 → 69."; the brief prints the earlier score per episode and defines
"compared live chat".

**Verification (this Mac).** `ratings.mjs` wrote the v3 store through the
guard; `build-data` + `validate` gave 49 failures against a 50-failure
baseline on the untouched tree, the difference being the ratings store's own
freshness — all 49 are environmental here (52-hour-old data, vault transcripts
absent, a store-state-dependent model-failure regression). Episode health
block green against HEAD (v2) and `FROZEN_BASELINE`. Tamper probes: a +1 on
E6's carried watch score failed the HEAD replay; LinkedIn chat put back into
E8's live check failed the live-file rebuild. Every refusal case in the fixture
fails for its own reason. `youtube-zero-downstream.test.mjs` asserted frozen
entries with a plain deep-equal, which cannot express a declared rules change
and would have refused the source-only push (committed store still v2); it now
asserts through the same guard — byte-identical within an algorithm, exactly
the declared re-derive across one — and passes with the store at v2 and at v3.
All 61 audit test files pass. The store was not committed: rule 26, the chain
machine is its one writer.

**Release.** Code only (source-only push). The next chain run re-derives the
store in the publisher checkout, the validator replays the step against its
HEAD, and the ordinary strict gate publishes it. `chain-heal` refuses to merge
two ratings stores with different algorithms, so no other machine may write
this store in the meantime.

