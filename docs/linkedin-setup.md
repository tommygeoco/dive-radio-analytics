# LinkedIn analytics setup

LinkedIn broadcasts are discovered daily from the exact destination in the matching Restream event. The verified source is Ridd's Restream channel 17403676. No LinkedIn scraping, password, cookie, or developer app is needed for episode links and available live chat.

## What works without API approval

Each episode has a LinkedIn broadcast link, recorded live chat message/participant counts, available approved feedback, and LinkedIn facts in the recommendation engine and agent brief. Restream does not provide LinkedIn viewer counts. Video plays, impressions and watching remain null until an actual owner observation exists. Live comments are already included in Restream session totals; they are not added again. Live chat and post comments can overlap.

`node scripts/restream/comments-archive.mjs --restream-history` performs a one-time historical chat retrieval for all registered aired episodes, using Restream only. Normal daily archive capture continues to cover the first 30 days. Historical retrieval does not assert that Restream retained every original comment.

## Interim owner observations

The dedicated publisher reads JSON files in:

`~/Library/Application Support/Dive Radio Analytics/linkedin-imports/`

Use an actual reading or export from the owner analytics for the exact broadcast. This is a normalized JSON import, not a generic LinkedIn spreadsheet parser. Copy only available metrics; omit missing ones. Do not put passwords, access tokens, audience identities or raw exports in these files. Actual raw exports can be retained privately alongside them as evidence.

Required fields: `version` (1), `slug` (the registered episode slug), `url` (its exact LinkedIn broadcast URL), `source` (`linkedin-native-export` or `linkedin-owner-reading`), `observedAt` (UTC ISO time when the metrics were actually observed), and `metrics`.

Allowed metric names: `plays`, `uniqueViewers`, `watchTimeMinutes`, `impressions`, `reactions`, `comments`, `reposts`. All counts are nonnegative integers; watch minutes may be fractional. Impressions mean post exposure, never video plays. No invented values or historical estimates. Use a new observation time for a genuinely new reading; conflicting values at an existing timestamp are rejected. Reimporting identical values is safe.

Run `node scripts/restream/linkedin-sync.mjs` from the dedicated publisher, then use the normal build/validate/publish flow. The daily chain imports these files too. The public store retains numeric observations, source type, timestamps and evidence hashes; private filenames and raw exports do not ship. Data older than 26 hours is labeled stale and excluded from current recommendation facts. Imported metrics remain separate from the existing YouTube/X viewing total and historical scores until a comparable automatic series is proven.

## Enable automatic analytics

1. Create a LinkedIn developer app associated with the appropriate real company Page; the Page owner must verify the association. Use the actual app owner, logo, privacy policy and redirect URL. Do not invent these or attach an unrelated company.
2. Apply for Community Management API access. Its member analytics scope is `r_member_postAnalytics`. Approval and appropriate production-tier access are LinkedIn's decision.
3. Implement an OAuth authorization-code connection with a registered redirect and state validation; have Ridd authorize that scope. Keep credentials and tokens in the existing private secret-management system, never in Git or chat.
4. Test one known broadcast against member post and member video analytics before enabling a collector. Verify plays, unique viewers, watch time, impressions and engagement as separately defined metrics. Record unavailable responses as missing.
5. Once proven, add the authenticated pull to the existing daily chain, populate real observation history, test API-expiry/failure handling, and explicitly version any expanded comparisons. Full post/replay comment access remains a separate capability; analytics comment counts do not provide comment text.

The current implementation does not include an approved app, Ridd's OAuth connection, or an automatic LinkedIn metrics collector. Those remain blocked on the external setup above.

Official references checked September 2026:

- [Access and permissions](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-08)
- [Member post analytics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics?view=li-lms-2026-06)
- [Member video analytics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/video-statistics?view=li-lms-2026-06)
- [Restream coverage](https://support.restream.io/en/articles/4167758-track-your-stream-s-performance-with-analytics)
