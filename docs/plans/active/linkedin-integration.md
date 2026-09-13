# Execution Plan: LinkedIn episode integration

## Purpose / Big Picture

Include Ridd's existing LinkedIn broadcasts in daily episode tracking and available audience insights. Recover historical sources and comments, support evidence-backed owner observations, and make the remaining API access boundary clear.

## Progress

- [x] Verified nine exact broadcast URLs and chat counters in saved Restream events; verified member analytics API documentation and access requirements.
- [x] Implemented daily source registration, private owner metric imports, LinkedIn episode panel/brief/facts, chat link provenance, and removal of unsupported Restream viewer zeros.
- [x] Focused tests for identity, missing values, observed zero, import idempotency/conflicts, and chat totals.
- [x] Full regression run: 54 audit files, 112 script syntax checks, two page scripts. Final focused tests passed; strict validator reported zero failures and zero drift (44 pre-existing warnings). Desktop and 390px mobile passed with no horizontal overflow or browser errors.
- [ ] Historical chat capture and approved feedback projection from the dedicated publisher.
- [ ] Commit, production deployment, byte parity and desktop/mobile runtime proof.
- [ ] External dependency: LinkedIn Community Management approval and Ridd OAuth consent. No API collector or automatic viewing data is claimed ready.

## Surprises & Discoveries

LinkedIn text was already entering the private audience archive and some approved feedback. Restream reports zero for unavailable viewer measures, so rendering those as zero was misleading. The fixed destination list and brief census grammar only recognized X/YouTube. All nine exact LinkedIn URLs were nevertheless retained in raw events.

## Decision Log

- Keep LinkedIn source identity separate from required YouTube/X transport targets, and add its destination to the public list.
- Preserve historical scoring definitions. LinkedIn chat already belongs to Restream totals; do not double count it. Imported metrics remain separately dated and do not rewrite existing view totals or historical scores.
- Keep complete raw chat and import evidence private. Project only approved feedback and allowlisted metrics.
- Discover before feedback (for links), and again after live ingestion (for newly available events). Both passes are idempotent; no new scheduler is needed.

## Validation and Acceptance

Prove exact matching, safe URLs, future/wrong-post/invalid observation rejection, append-only history, no invented viewer zeros or history, no double counting, grounded model facts, brief/dashboard parity, full existing regression suite, and production byte parity. Explicitly report access-blocked metrics.

## Idempotence and Recovery

Source registration retains existing YouTube/X targets. Owner observation timestamps are immutable and idempotent; a conflicting duplicate fails without saving staged changes. Existing private raw input remains in place. Revert the implementation commit and rebuild from retained stores to roll back presentation; never alter frozen historical scores.

## Outcomes & Retrospective

Pending runtime verification and release.

Release finding: the pre-push hook inherited `GIT_DIR` from a linked worktree, so its supposed scratch checkout detached the caller and failed validation. Strip repository-local Git environment variables for gate subprocesses, preserving authentication/environment settings. Regression reproduces hook variables and proves the original branch and dirty files remain unchanged. No checks are disabled.
