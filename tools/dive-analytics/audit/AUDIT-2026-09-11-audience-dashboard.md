# Audience dashboard integration — September 11, 2026

The private archive retained recovered X conversations and Restream chat, but the dashboard still read only the older scored-comment cohort. This change adds a separate approved message projection and connects it to the visible episode preview, searchable feedback dialog, agent brief and expanded Slack summary.

## Review and verification

- The classifier reuses the existing prompt, version discipline and passing golden gate. Only confident relevant directional feedback is public; raw capture, noise, review candidates and model bookkeeping remain private.
- Native IDs deduplicate expanded and legacy feedback. Message counts do not replace distinct-person counts or historical health/rate inputs.
- Independent critic initially identified missing approved-quote URL grounding, incomplete capture notices, and configuration migration handling. All were fixed without weakening existing validation.
- Final critic found the zero-approved pending state disappeared. The visible preview and episode panel now show its notices with unavailable copy, avoiding false zero sentiment counts. Final re-review: PASS, no remaining blockers.
- Fifteen focused tests passed, including private-field exclusion, full text and provenance, mixed feedback, deduplication, revision history, source failures, configuration migration, zero-approved UI, archive pagination, daily ordering and model failure preservation.
- Browser preview verified real Episode 9 praise, full-text search, live-chat source filtering, original links and readable mobile controls.
- Strict preview validation passed with zero failures and zero drift. Final committed release and production checks follow through the normal gated publisher.

## Live acceptance

Production release `1da5d4fc` passed the normal publisher: 52 audit suites, 108 script syntax checks, two page scripts, zero validation failures/drift, and exact 18-file parity at 2026-09-11T23:14:53.422Z. Browser checks verified the E9 visible preview, 53-message list, best-show live-chat searches with original links/timestamps, five-message criticism filter, and clearing search. Final private processing exported 105 approved expanded messages with no unprocessed records. Independent live brief examination confirmed all answers against the complete archive and the 53/48/5 feedback counts; no factual discrepancies.
