# CLAUDE.md — Dive Radio analytics

Read this before changing anything. It says what this repo is for, which rules
are non-negotiable, how a number travels from a source to the page, and how to
change a number without breaking the honesty contracts. `ARCHITECTURE.md` has
the full store-by-store and number-by-number lineage; this file is the intent.

## What this is

A static dashboard (`index.html` + `data.js`) that answers three questions for
the two owners of the Dive Radio live show (Tommy and Ridd):

1. **Is the show compounding?** (growth trend, show-health score)
2. **Where should marketing effort go?** (platform split, host split, "What matters")
3. **How did the latest episode do against the rest?** (latest-episode card, episode health, pace)

Everything else in the repo exists to make those three answers *honest*: a
capture layer that records what the platforms report, a deterministic
synthesis layer that turns records into comparisons, a narrow model layer that
writes prose over deterministic facts, and a validator that refuses to publish
when any surface disagrees with its store.

The product brief is `PRODUCT.md`. The feature list is `README.md`. The reasons
behind every design decision are in the PRDs (`tools/dive-analytics/prd-*.md`,
canonical copies in the Obsidian vault at `Dive Media Group/Dive Radio/`) and
the audit ledgers (`tools/dive-analytics/audit/*.md`).

## The constitution (v5 §1 — every change must pass these)

1. **Total views = YouTube views + X broadcast plays.** X impressions (reach) are exposure and are NEVER summed into views.
2. **Absence ≠ zero.** Missing data says so in plain words; it never renders as 0 and is never estimated or interpolated.
3. **Never fabricate history.** No backfill, no extrapolation, no blended series where one unit lacks history.
4. **Definition-lock.** A metric definition change moves every surface (cards, hero, panel, table, Slack, validator) in one commit. Every surface reads the same store — no surface recomputes its own version of a number.
5. **`node tools/dive-analytics/audit/validate.mjs` exits 0 before every publish.** Publish verifies live parity afterwards. Two tiers (PRD v11 rule 24): `fail` re-derives a shipped number, definition, grounding, absence, freshness, or store integrity and always blocks; `drift` inspects page or script source or copy — strict mode (a person, the pre-push hook) blocks on it, the chain's `--publish` mode reports it and queues a Slack line. Never move a check from `fail` to `drift` because it is inconvenient; only because it inspects source.
6. **Plain words everywhere a human reads.** Banned in glance/click layers: composite, percentile, pillar, ratio / ×-multiples, velocity, coverage, basis, median (say "typical"), delta, cumulative (say "total so far"). Test: "it doesn't need the PRD to parse."
7. **Small-n honesty.** Claims from fewer than 3 clean samples are suppressed, not caveated.
8. **Simplicity contract.** ≤12 numbers above the fold; one question per surface; three layers (glance → click → About); every glance number passes "what would Tommy/Ridd DO differently if this changed?"
9. **Frozen numbers never change within an algorithm version.** Version bumps re-derive ALL entries visibly (`rederivedFrom` stamped), never silently.
10. **Zero runtime deps.** Vanilla JS + vendored Chart.js. Model calls only in explicitly-model scripts (classifier, health, recommendations, moment summaries, critic) — never in `build-data.mjs`, which stays deterministic.

**Absence is silent** (v5 addendum): a missing metric renders nothing — no
asterisks, no "sat out", no wait dates. The gates still hold; they are not
announced. The validator fails if retired absence copy reappears.

**Rules 11–17 (PRD v9, implemented 2026-08-23 on branch
`docs/agent-guide-architecture-prd-v7`, W22a–W26):**

11. **Like for like.** Every comparison carries one basis — `sameAge` (readings at the same days-since-premiere), `mature` (own and peers past the measure's maturity age, as they stand now), or `ageFree` — and the same comment-source coverage. A comparison that cannot meet its basis is absent with a reason.
12. **Windowed typical.** Typical = true median of the `WINDOW_N` (8) episodes before the one being read, minus promo outliers and peers with no honest reading. Lifetime medians are gone.
13. **Minimum peers, per measure.** `MIN_PEERS` (3) or absent with a reason. An absolute-scale measure (sentiment balance) never absorbs the weight of absent checks.
14. **Reproducible freezes.** A frozen episode-health entry stores every peer value it used (`peers[]`, `excluded[]`); the validator rebuilds the score from the entry and snapshot-sourced inputs from the snapshots. Inputs read from the overwritten analytics file are stamped `reproducible: false`.
15. **Freshness is visible, then withheld.** The header says "health read is behind" when the saved read's date differs from the data's; after 7 days the score is withheld (empty state). Data always publishes. `tools/dive-analytics/chain.json` defines which input stores must be fresh.
16. **One baseline per concept.** `tools/dive-analytics/baselines.mjs` is the only definition of median, window, peer filter, outlier test, reading rule, quiet zone, bands, and constants. The page reads `data.baselines`; the scorers import the module; the fixture test (`audit/baselines.test.mjs`) and validator blocks 1u/1v/1x/1y/1z prove it.
17. **Stored honesty reaches the click layer.** Each measure's `note` ("compared at the same age" / "compared with earlier episodes as they stand now, not at the same age") and reason render in the drill-in and panel — never on chips (absence stays silent at a glance, D7).

## The five layers

```
L0 sources     YouTube Data API · YouTube Analytics API (owner OAuth, both channels)
               X API (xurl bearer) · Restream API · yt-dlp captions · owner-supplied transcripts
     │
L1 capture     scripts/restream/*.mjs  →  data/restream/**        (records of what platforms reported)
     │
L2 synthesis   tools/dive-analytics/baselines.mjs   (pure: windows, reading rule, outlier test, typicals — imported by all three below)
 (deterministic) tools/dive-analytics/ratings.mjs   → episode-ratings.json   (episode health, frozen, rebuildable)
               tools/dive-analytics/build-data.mjs  → data.json / data.js   (EVERY number the page shows, incl. data.baselines)
               tools/dive-analytics/watch-moments.mjs (pure functions, imported by build-data)
     │
L3 model       scripts/restream/comments-classify.mjs → comments-classified.json
 (prose over    tools/dive-analytics/health.mjs        → health-history.json   (health-v4: three lenses, PRD v10; swing-fitted bands and the whole live session, §11)
  facts)        tools/dive-analytics/health-verify.mjs → health-verify.json + audit/HEALTH-VERIFY.md (deterministic critic loop; never blocks)
               tools/dive-analytics/recommendations.mjs → recommendations.json
               tools/dive-analytics/moment-summaries.mjs → moment-summaries.json
               tools/dive-analytics/critic.mjs         → audit/CRITIC-<date>.md  (never blocks publish)
     │
L4 gate        tools/dive-analytics/audit/validate.mjs  (exit 0 or no publish)
               scripts/restream/postlive-publish.sh     (commit → push → Vercel → live parity check)
               tools/dive-analytics/alerts.mjs          (diff vs last run → Slack queue)
     │
L5 page        index.html reads data.js only. It never fetches, never recomputes a score,
               and never decides what is missing — it renders what the store says.
```

Rules that follow from the shape:

- **L2 is the only place a comparison is computed.** If you need a new "typical", "pace", "vs", or "trend", it is computed through `baselines.mjs` (windows, reading rule, peers, median) inside `build-data.mjs` / `ratings.mjs` / `health.mjs` and shipped in `data.json` (`data.baselines` for page-side comparisons). The page formats; it does not derive — validator 1j fails on in-page medians or thresholds.
- **L3 scripts receive a deterministic fact sheet and may only use numbers from it.** Every number token in saved prose is validated against the facts (`health.mjs` `validateSynthesis`, `recommendations.mjs` `validateItems`). On model failure the previous store stays the public truth — every L3 step is safe to skip, and the validator checks the store, not the run.
- **L1 stores have different time semantics.** Snapshots (`postlive/`) are append-only time series. YouTube analytics (`yt-analytics/`) is an overwrite of lifetime-to-date totals; `yt-analytics-history/<slug>.jsonl` (since 2026-08-23) keeps one line per episode per day so share watched and subscribers can be read at the same age — no backfill, so same-age readings for those two measures exist only for episodes from E7 on. Comments are append-only by id; a label is never re-read without a classifier version bump. Live events are frozen at first ingest. Read `ARCHITECTURE.md` §2 before comparing two numbers from different stores.
- **`build-data.mjs` must be reproducible.** Validator check 7 recomputes `data.json` byte-for-byte from the stores with `generatedAt` pinned. Anything non-deterministic (time, randomness, network, a model) breaks publish.

## The daily chain

Runs on the owner machine (`/Users/bones/Dev/2026/dive-radio-analytics`) as the OpenClaw automation `restream-postlive-snapshot` at 07:00 America/Phoenix (`node tools/dive-analytics/run-chain.mjs`); a 06:00 `--rehearse` job runs the same chain without publishing, a 06:50 job ingests Restream, a 12:00 job checks freshness, and a Monday-noon job posts the Slack trends report. The repo is both source and served site; publish = commit + push + `vercel deploy --prod` + live parity check. Only the `ratings → … → publish` half is documented (README); the capture order below is reconstructed from the scripts' header comments.

```
postlive-discover → transcripts-pull → postlive-track snapshot → yt-analytics-pull
→ comments-pull → comments-classify → channel-stats-pull → ingest-restream
→ ratings → build-data → validate → health → health-verify → recommendations → moment-summaries
→ build-data → validate → publish → alerts          (Mondays: + critic)
```

- The second `build-data → validate` exists so today's health entry reaches the published artifact.
- `validate` failing anywhere = no publish. Fix the cause; do not weaken the check.
- `tools/dive-analytics/chain.json` is the versioned chain definition (order, what each step writes, which stores must be fresh). The scheduler is an OpenClaw automation on the owner machine (`openclaw cron list`), not a crontab; do not add one here.
- **Publishes do not fail for reasons readers would not care about** (PRD v11): the chain heals leftovers and pulls first, retries `snapshot` / `yt-analytics` once, runs the validator in publish mode, publishes with a script that merges store conflicts, retries the push and the deploy, and exits 2 (published, parity unconfirmed) rather than re-capturing; every required-step failure queues one Slack line (`dive-alerts` delivers every 30 min; `run-chain.mjs --last` on the chain machine shows the log). Install the pre-push hook once per clone: `sh scripts/dev/install-hooks.sh`.
- **`run-chain.mjs` pulls main before the first step** (PRD v10 W34) and `postlive-publish.sh` pulls `--rebase` again before it pushes; a stash conflict on the generated files (`data.json`, `data.js`) is resolved by taking the pulled tree and rebuilding, never by aborting. Work from another machine may land on main directly when it changes no store files; commit `data.json`/`data.js` only when the chain machine has already pulled the code that produces them (the chain rebuilds them every morning).

## How to change a number (the procedure)

1. **Find the definition** in `ARCHITECTURE.md` §3 (number → store → script → rule) and the PRD section that introduced it.
2. **Change it in the store-writing script**, not on the page. If the store is frozen (`episode-ratings.json`, `health-history.json`), bump the version/algorithm stamp (`ALGORITHM`, `FORMULA_VERSION`, `PROMPT_VERSION`, `CLASSIFIER_VERSION`) and let the re-derive happen visibly (`rederivedFrom`). Never edit a store file by hand.
3. **Move every surface in the same commit** (rule 4): hero/cards/panel/table in `index.html`, the Slack text in `build-data.mjs` (`slackTrends`), the About copy, and the validator block that locks them together.
4. **Add or extend the validator block** so the new definition is re-derived from stores on every run. The validator's pattern is: recompute from the store, compare to what shipped, fail on mismatch. Source-regex checks on `index.html` only prove wiring shape; prefer a data check.
5. **Run** `node tools/dive-analytics/build-data.mjs && node tools/dive-analytics/audit/validate.mjs` (and `node tools/dive-analytics/health.mjs --dry`, `node tools/dive-analytics/ratings.mjs --dry` when those are touched). Exit 0 or it does not ship.
6. **Record the why**: a PRD section or addendum for definition changes; an audit ledger entry (`audit/*.md`) for findings triaged fix / reject-with-evidence / queue. Workstreams are numbered `W<n>` across PRDs; keep numbering.
7. **Let the critic run** after a workstream ships and triage its findings in the CRITIC file (the "Builder triage" section). Rejections carry evidence.

## Do / don't for agent sessions

- Do read `ARCHITECTURE.md` §2 (store time semantics) before writing any comparison. The most common mistake in this codebase is comparing a 2-day-old episode's lifetime-to-date rate with a 30-day-old episode's.
- Do keep `build-data.mjs` model-free and network-free.
- Do keep prose surfaces within the banned-word list (rule 6). The validator (block 1i) and each model script's `BANNED` regex enforce it; About is the only place methodology words belong.
- Do write reasons, not zeros, for missing data (`{value: null, reason}`), and let the page render nothing.
- Don't add a second implementation of median / window / outlier / quiet zone / bands. `baselines.mjs` is the one; validator 1j/1u/1z and the fixture test fail on a second.
- Don't add glance-layer numbers without removing others (≤12 above the fold, counted on a screenshot).
- Don't commit secrets. API keys come from the login-shell environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, YouTube/X credentials via the owner's tooling); `restream-token.mjs` reads 1Password.
- Don't run the chain or `postlive-publish.sh` from a machine that is not the owner's, and don't commit `data/restream/**`, `data.json`, or `data.js` from another machine (rule 26: one writer — the pre-push hook warns). Reach the chain machine with `ssh -4 bones@192.168.0.135` on the LAN; its jobs are OpenClaw automations (`openclaw cron list`).
- Don't "fix" a validator failure by relaxing the regex; find out which surface drifted.
- Don't trust the critic's findings without re-deriving: it has produced false positives from a flattened bundle (see CRITIC-2026-08-22-W10 "Builder triage").

## Where intent lives

| Question | Look in |
|---|---|
| Why does this number exist / what decision does it serve? | `PRODUCT.md`; PRD v5 §1 rule 8; the PRD section that introduced the workstream (`W<n>`) |
| What is the exact definition and its honesty gates? | `ARCHITECTURE.md` §3; the header comment of the script that writes it; the validator block that locks it |
| What did a critic or audit say and what was decided? | `tools/dive-analytics/audit/*.md` — every finding is fixed, rejected with evidence, or queued |
| Why are the comparison rules what they are? | `prd-analytics-v7-*.md` — findings F1–F34, the comparison contract (§3), the audit record (§10), and the status log's implementation notes |
| What is the chain and cadence? | this file; `README.md` bottom; `ARCHITECTURE.md` §1 |

## Glossary (the words the code and PRDs use precisely)

- **typical** — the true median of the usable peers among the eight episodes before the one being read (`baselines.windowFor` + `peersFor`): promo outliers out, peers without a reading at the needed basis out, three or nothing.
- **same-age** — a value taken from the snapshot at the same days-since-premiere as the episode under test. The only honest way to compare a young episode's views or engagement with older ones.
- **finished / mature** — an episode at least 7 days old (reach, insights) or 21 days old (episode health read complete). Rates drift with age; finished values are comparable with each other.
- **clean** — not an anomaly, not late-registered (`partialHistory`), with the needed snapshot coverage.
- **anomaly / promo outlier** — an episode whose YouTube views, X plays, or X reach exceed 2× the same-age typical of the nearby episodes (settled at day 21; provisional before; the window-limited lifetime test only while history is too thin). Excluded from host, announce, topic, and every typical (but included in the all-show platform split, which is descriptive). Frozen episode-health entries store the verdicts they used.
- **partial / stale (X plays)** — `partial`: some X targets have no plays count; `stale`: this run's plays were missing and the high-water mark was substituted. Both exclude the episode from reach comparisons.
- **tracked late (`partialHistory`)** — first snapshot more than 5 days after premiere; first-week velocity and flatline are undefined for it.
- **launch word** — an episode's first-week standing in one word (strong / typical / soft; promo-qualified; "so far" while under a week): YouTube views at day 7 — or the earliest reading, or the current age — against the other episodes at that age, outliers out, three or nothing (`baselines.launchReadFor`). A standing, never frozen, never a number at a glance.
- **qualified / carried** — a show-health measure whose own unit is promo-flagged is *qualified*: value and typical shown, score null ("promo-driven lift — shown, not scored"); a measure read from an older episode than the newest is *carried* at half weight and names the episode it read. `entry.asOf` lists both.
- **direction / outlook** — the show-health lenses beside the score: each durable measure's Theil–Sen change per episode over the last five clean episodes (building / holding / softening / mixed), and the next first week's expected range from the last three clean first weeks plus the newest episode's cool-off. Stored with the entry, projected verbatim, ledgered and scored by `health-verify.mjs`.
- **read complete / frozen** — an episode-health score is written once, on the first run whose last snapshot is ≥21 days old, and never changes within `health21-v<n>`; its inputs are stored so it can be rebuilt.
- **basis / note** — `ageBasis` (sameAge / mature / ageFree) is the field; the reader sees its fixed `note` at the click layer. The word "basis" itself is banned on the page.
- **window-relative** — each episode-health score compares the episode only with episodes that aired *before* it. Two scores are not on one baseline; a row of them answers "did each beat the show's own bar at the time", not "which episode was best".
- **glance / click / About** — the three layers: a sentence the owners read in seconds; the detail behind it on click/hover; the methodology in "About this data".
- **swing / bands / state** (PRD v10 §11, rule 23) — a measure's swing is how much it normally moves between the peers that formed its typical (median absolute deviation as a % of the typical); a check's bands are half its measures' median swing either side of 50, clamped to ±5…±15 points; its state word (healthy / steady / fragile / waiting) follows its bands. The writer stamps all three; nothing on the page applies a fixed cut-off to a check that carries bands.
- **superseded / rederivedFrom** — on the day a formula ships, the day's older-formula read is moved byte-identical under `store.superseded[]` and the new read names it; the validator accepts exactly that shape. `chain-heal.mjs` merges the store by day when a stash pop left it conflicted.
