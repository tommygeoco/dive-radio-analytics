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
| 12 | Ratings' live check compares chat messages including LinkedIn | `ratings.mjs` live check | **Queued — deadline 2026-10-15** (E11's read-complete day; it is the first episode without LinkedIn). Needs `health21-v3` and a visible re-derive path through the frozen-bytes guard (`assertFrozenRatingsUnchanged` accepts no re-derive today). E9 (10-01) and E10 (10-08) had LinkedIn on both sides and are unaffected. |
| 13 | E11's LinkedIn absence carried no reason | no `sourceStates.linkedin` | **Fixed.** `not-streamed` when the Restream session had no LinkedIn destination; `missing` when it carried LinkedIn chat but no broadcast matched. Silent on the page, stated in the brief. |
| 14 | LinkedIn total-views test could not fail (LinkedIn attached after totals were computed) | `linkedin.test.mjs` | **Fixed.** New test imports a LinkedIn plays reading and proves brief totals, Slack lines and page view keys are unchanged. |
| 15 | LinkedIn viewing analytics (plays, viewers, watch time, impressions, post comments) | `docs/linkedin-setup.md`, commit 50cff5e | **Not a code defect — access boundary.** Needs LinkedIn Community Management API approval for a company Page app plus Ridd's OAuth consent. Until then only links and live chat exist; every viewing metric stays null ("awaiting access"). Owner imports remain the stopgap. |
| 16 | Chapters on Sonnet 5.5 at `high` grounded 6 of 10 (979 output tokens) | live debug on E11 | **Fixed.** Chapters run at `xhigh`, 64k tokens, 10 min timeout: 9 of 10 grounded in 164 s. |
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
