# Health-v3 transition audit — 2026-08-24

Trigger: the owner saw Growth, Audience quality, and Subscribers flip to "Not in
yet" overnight and read it as a stale/broken cron ("this dashboard is becoming
too untrustworthy b/c of our cron automations"). A 7-agent audit (4 readers over
gating code, raw stores, chain, and PRD intent; 3 adversarial verifiers) ran
against the working tree at `be6d8d7`.

## What actually happened (verified)

1. **The visible change was designed, not breakage.** 2026-08-24 was the first
   chain run under `health-v3` (W24). PRD v9 D1c predicted today's exact
   screen: audienceQuality and conversion scored yesterday under health-v2's
   unlike-age lifetime comparisons; v3 refuses that comparison (rules 11–13)
   and both went absent with stored reasons. The exclusions are faithful to the
   stores: E3 promo outlier (2.34× typical X plays), E4/E5 first snapshotted
   2026-08-21 at ages 14.4/7.4 d so no reading exists at E6's read age (4.0 d),
   and `yt-analytics-history` starts 2026-08-23 with no backfill.
2. **No data loss, no capture gap.** Every postlive series is gap-free through
   2026-08-24T19:00Z; every store updated today; validator exits 0; prod
   data.json is byte-identical with local.
3. **The cron did fail this morning — safely.** Four ~7 AM runs died at the
   validator's same-day health gate (bundle-hash comparison could not survive
   the first v3 entry); fixed by hand in `0630275`/`d26e316`; first clean
   publish 10:46 MST. The gate blocked publishing rather than shipping anything
   wrong. The unattended chain has not yet completed cleanly at its scheduled
   time on any day; 2026-08-25 07:25 is the first real test of the fixed chain.
4. **The trust failure was a transparency gap, not a data gap.** Score held
   51 → 51 while the composition went 5 checks → 3. The store recorded
   `checkSetChange` and the model wrote the explaining driver, but
   `projectHealth` projected neither, D1c's "headline must say so" was
   implemented only in unrendered drivers, the >5-point-move guard exempted the
   score-holds-still case, and alerts had no line for it. Every reader-facing
   surface was silent on the one day it mattered.

## Triage

### Fixed (W27, this commit)

- `projectHealth` projects `checkSetChange` and `drivers`; the diagnosis card
  renders a plain deterministic change line, the evidence card renders the
  drivers, Slack gets one digest line, alerts get check-set and formula-version
  lines. Prompt v4: naming a changed set is unconditional and drivers are
  digit-free; entries are judged under their stamped prompt version. Validator
  locks: per-stamp synthesis re-check (1h), Slack-line data check, synthetic
  alert proof, and page-wiring checks (1x). About explains that the check set
  can change and that the trend never crosses rule versions.

### Fixed after adversarial review of the W27 diff (same commit)

A 17-agent review (3 dimensions, every finding independently re-verified) ran
against the W27 diff before commit. Fixed: (R1, medium) alert 2c false-fired
after a withheld stretch — the withheld projection saves an empty check set and
recovery then diffed against `[]`, naming every check as "joined"; both sides
of the diff now must be non-empty, and the validator proves the non-firing with
a synthetic withheld state. (R2, low) the driver-naming guard was a substring
test ("reached" satisfied "reach") — now whole-word; and an unlabeled check key
silently escaped the rule — now falls back to the raw key. (R3, low) prompt
rule 10 claimed "one driver" and exact names while the validator checked joined
drivers and substrings — both sides aligned. (R4, low) the dynamic transition
copy (alerts, Slack line) sat outside every banned-words scan — the validator
now scans the generated lines. The review also verified clean: tomorrow's save
is unblocked under prompt v4, the alerts bootstrap is silent, future validate
days hold, and the withheld page renders artifact-free.

### Queued (each needs its own change; none blocks today's publish)

- **Q1 — sameAge lock erased by one absent day** (medium). `prevBasis` reads
  only the immediately previous entry, and an absent day stores
  `ageBasis: null`, so a measure that was once same-age can silently fall back
  to mature after a single absent day — against the §3.1 transition rule and
  the header contract at `health.mjs:14-16`.
- **Q2 — commentRate own not gated** (medium). `rateOwn` checks only
  finiteness (`health.mjs` sentiment block); peers require age ≥ 21 d and
  unflagged. A young own reads systematically high against mature peers while
  stamped `mature`.
- **Q3 — wrong absence reason possible** (low). growth.sameAge /
  audienceQuality.engagement blame the peer count (`NOTES.youngAge`) even when
  peers suffice and the own reading is what is missing.
- **Q4 — pre-filtered peers invisible in `excluded[]`** (low). Window
  pre-filters (`.filter(reachOk)`, age ≥ 21, `rateOk`) drop peers before
  `peersFor`, so the stored entry never records why they are absent —
  weakens rules 14/17.
- **Q5 — "no reading at this age" stamped on age-free measures** (low).
  `peersFor`'s only missing-value reason is age-worded; livePull and sentiment
  peers get an age explanation for a non-age absence.
- **Q6 — balance peers not coverage-matched** (low). `balancePeers` passes no
  `coverageOf`/`ownCoverage` (contrast commentRate), so a peer with different
  comment-source coverage can bias the typical (rule 11).
- **Q7 — same-day step-aside residual window** (low). The step-aside compares
  store freshness against `createdAt` but recomputes at `dataGeneratedAt`
  (~56 s apart today); a store refresh inside that window could still deadlock
  a day. Accepted for now: the next daily run re-proves.
- **Q8 — schedule drift unverifiable** (low). chain.json documents
  `25 7 * * *` but today's run started ~07:03 Phoenix; the crontab and the
  midday `--strict` freshness cron live only on the owner machine and left no
  verifiable trace. Align the crontab with chain.json or update chain.json.
- **Q9 — growth.firstWeek bypasses `peersFor`** (low). The slope path builds
  its own peer object, so a flagged episode with a fully-tracked first week
  would count in the slope. Moot today (E3 is excluded as partial history);
  becomes real when a flagged episode has a clean first week.
- **Q10 — synthesis retry carries no error feedback** (low). `synthesize`
  retries with the identical payload, so prompt v4's two new hard rules fail
  in a correlated way on transition days; worst case the day's entry is not
  saved (previous kept, "behind" stamp + alert 2b — safe but a lost day).
  Feed the validation error into the retry payload.
- **Q11 — mid-week check-set changes reach the reader through alert 2c and
  the page only** (accepted). The Slack trends digest goes out on its own
  cadence, so the digest line can lag a mid-week change; alerts are the
  designed same-day channel. No change.
- **Q12 — pre-v4 drivers render without the digit-free guarantee** (accepted
  with evidence). `projectHealth` projects drivers regardless of prompt
  version; the digit ban starts at v4. Unreachable harm with the real store —
  the only pre-v4 entry the page can serve (2026-08-24) has digit-free
  drivers, and every later entry is v4-validated. Becomes moot as v4 entries
  accrue.

### Rejected (with evidence)

- "The cron/data is stale" — refuted on five fronts (stores fresh, no
  deletions in git, validator 0, inputs that fed yesterday's scores still
  present and moving, absence strings re-derived from code paths).
- "health-history v1/v2 entries violate rule 9 (un-rederived)" — exempt by
  documented design: append-only daily journal, entries judged under their own
  stamps (`health.mjs:46-52`, PRD §4.3, ARCHITECTURE §4); re-deriving a model
  synthesis over vanished overwrite-store inputs would fabricate history
  (rule 3). Rule 9's blanket wording in CLAUDE.md carries no carve-out — noted
  for the next CLAUDE.md pass.

## Recovery dates (verified against code + stores; assume daily chain, flags hold)

- Growth: 2026-08-28 (E6's first clean week completes → third clean week;
  growth.sameAge same day if E6 is still newest).
- Audience quality: 2026-08-28 via engagement if E6 is still newest
  (~2026-08-31 if E7 premieres 08-27); the watching measure itself 2026-09-04
  (mature, own = E5, peers E1/E2/E4).
- Subscribers: 2026-09-04 (E5 crosses 21 d at the 07:25 run; mature peers
  E1/E2/E4 = exactly MIN_PEERS). Not earlier: with E4 as own, E3's flag caps
  the mature peer set at 2.
- Same-age share-watched/subscribers: first possible ~2026-09-12 (E8 read at
  ~8.8 d against history lines from E5/E6/E7).
- Maturity boundaries land at noon Phoenix, so on the 07:25 cadence every
  threshold is crossed one calendar day later than naive premiere+N arithmetic.
