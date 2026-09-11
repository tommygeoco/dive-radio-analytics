# Audience retention — September 11, 2026

Owner request: retain the glowing Episode 9 comments missed across X threads and the live stream.

The scored store contained only five rows. Its X collector searched direct live-post conversations, omitted promo targets, and did not resolve promo replies to parent conversations. Restream ingestion retained chat analytics totals but no message text.

Added an owner-only archive under `~/Library/Application Support/Dive Radio Analytics/audience-archive`. The existing daily comments command invokes it before scored collection. JSON and Markdown retain full text, source attribution, timestamps, original X URLs, raw responses, and capture receipts. Archive files are 0600 inside a 0700 directory and never enter Git or public deployment. Existing scored feedback definitions and public metrics are unchanged.

Capture searches registered X anchors (including promo posts), their actual parent conversations, and quotes of those roots recursively. It does not search quotes of arbitrary non-anchor replies or every mention of the show. X recent-search remains a rolling seven-day boundary; active episodes are harvested during their first eight calendar days. Restream chat is matched through exact registered destination URLs and paginated. Anonymous source labels remain anonymous. Identical chat payloads retain distinct occurrence IDs; this is a synthetic identity because the API supplies no native message ID.

Each successful source is retained independently. Failed sources and bounded pagination are recorded without erasing previous records; raw received pages survive incomplete captures. The comments chain step is already optional, so incompleteness is surfaced without stopping publication.

Live evidence: Episode 9 archive captured 80 X records and 287 Restream messages with zero failed sources. These are source records including hosts, ordinary discussion, praise and criticism, not 367 audience testimonials. Chat-history count is not interchangeable with Restream analytics' 275 messages. Nine selected highlights are in the private `e9-highlights.md` artifact; source JSON and the complete Markdown archive retain all captured records.

Validation: focused archive regression tests cover promo-parent and quote discovery, full long-post text, duplicate IDs, partial X lookup, repeated cursors, chat pagination, duplicate occurrences, null text, source anonymity, independent-source preservation, repeat-run idempotency, and restrictive permissions. Existing comment tests pass.

## Builder triage

Independent final_critic review: PASS, no blocking findings. Accepted coverage qualification for quotes of non-root replies and potentially unrelated discussion in parent conversations. The archive explicitly labels this unscored scope. The reviewer initially raised a publication-blocking concern, then retracted it after checking the existing optional comments step in chain.json.

## Future-episode hardening

The initial comments-step integration could be skipped by an earlier required transcript or analytics failure, and eight days was too short for continued replies. The archive now has its own optional step immediately after episode discovery, with explicit private runtime outputs. It runs daily for 30 days per episode and carries forward saved conversation IDs, so a quote post aging out of recent search does not hide later replies to its thread. Retained archives do not expire.

When no finished event is present locally, capture reads bounded Restream event history and uses the existing canonical destination-ID matcher. This handles YouTube watch/live/short URL forms and rejects ambiguous episode assignments. Capture does not depend on the separate analytics ingest having succeeded. Scored comments remain a separate later step.

Regression proof creates an October episode with no local events directory, resolves its chat from history, then advances to day 14 and captures a new reply through a previously saved quote conversation. The repeated chat message remains one stored record. Chain tests require capture after discovery and before transcripts with no public/store output declaration.

Future-hardening critic findings fixed: enumerate all bounded history pages even when local events exist, retaining restarted/split events matched to the same episode; a multi-page fixture proves both are kept. Archive collection has a three-minute request-start budget plus at most the current bounded request, after which remaining sources fail explicitly and the optional chain continues. A zero-budget test proves no source call starts and failed receipts remain. Live 30-day capture retained another 529 records across five episodes with no failed sources.
