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
