# All-episode refresh repair — 2026-09-22

## Scope and findings

Code/tests/docs only in the development checkout. Starting clean HEAD:
`f009b21c149d6da3be94571367deca0f854a4333`. No capture, publish, push,
credential, scheduler, publisher-store, live-event, or frozen-score writes.
All requested contract sources were available and read.

The daily snapshot step used the manual command's 60-day default. Its freshness
scope also excluded old episodes, so EP1 could stop updating without failing.
The chain now explicitly uses `snapshot --all` and `active-episodes`. Future
and inactive entries stay out. A registry-based freshness check also catches
missing old histories, which the rendered episode list cannot catch. A fresh
pending/failed attempt remains an honest source gap; it does not advance counts.
The ordinary manual command keeps its bounded default.

Read-only publisher evidence: `~/Library/Logs/dive-radio-analytics/chain-2026-09-22.log`
lines 99 and 251 fail on E10 `yt:designertom`, 2613 → 2556 at
`2026-09-21T14:00:57.211Z`. The preceding raw reading is
`2026-09-20T19:15:32.002Z`. Both identify video `0xL0XtpH_og`, have ready
postlive and YouTube source envelopes, matching pull times, and exact matching
metric/source/detail counts. A second September 21 pull reports 2556 too;
September 22 reports 2647 and then 2650. These are observed platform revisions,
not evidence that the history should be clamped or rewritten. No claim is made
about YouTube's reason for the revision.

Validator block 2 now recognizes a decrease only if BOTH raw observations prove
the same single registered YouTube upload, valid ready envelopes, matching
pull times, valid nonnegative integer counts and matching source/detail values.
The raw counts must also reproduce the displayed drop. Accepted revisions remain
visible warnings. X and unproven material decreases retain the existing hard
failure threshold. Full source-store integrity and deterministic rebuild checks
still run; they were not weakened. Neither snapshot history nor public number
calculation changed. Restream live-night totals, frozen scores and LinkedIn's
owner-import path are unchanged.

## Verification

Final focused run: every command below exited **0** on September 22:

```sh
node tools/dive-analytics/audit/long-tail-capture.test.mjs
node tools/dive-analytics/audit/youtube-counter-revision.test.mjs
node tools/dive-analytics/audit/source-integrity.test.mjs
node tools/dive-analytics/audit/source-capture.test.mjs
node tools/dive-analytics/audit/source-receipts.test.mjs
node tools/dive-analytics/audit/run-chain-policy.test.mjs
node tools/dive-analytics/audit/validate-tiers.test.mjs
node tools/dive-analytics/audit/youtube-validator-negative.test.mjs
node tools/dive-analytics/audit/youtube-missing-data.test.mjs
node tools/dive-analytics/audit/x-broadcast-plays.test.mjs
node tools/dive-analytics/audit/operator-repair.test.mjs
node --check scripts/restream/postlive-track.mjs
node --check tools/dive-analytics/source-integrity.mjs
node --check tools/dive-analytics/audit/validate.mjs
git diff --check
```

Proof lines include:
- `long-tail-capture: all aired active episodes, no future/inactive requests, stale/missing old history fails, honest pending attempts pass`
- `youtube-counter-revision: same-upload source correction accepted; malformed, wrong-ID, mixed-time, missing and X observations still rejected; raw history unchanged`
- `validate-tiers.test: 136 drift-tier checks, 7 fail(s) on this tree, publish mode exit 1`
- `youtube-validator-negative.test: in-memory mixed-time store is rejected without changing canonical data`

The counter fixture also runs the complete source-store integrity checker against
disposable stores; malformed counts, wrong IDs, missing sources and mixed times
still fail. A read-only call of the new revision helper against the publisher's
real raw rows accepted the exact 2613 → 2556 correction. The freshness helper
against publisher rows reported stale EP1 and EP2. These checks made no writes.

`node tools/dive-analytics/audit/validate.mjs` exited **1** on the untouched
saved development dataset: seven hard failures plus one strict-mode drift
(counted as eight failures in the summary). They are stale generated data,
EP1 freshness (registry and file checks), and classifier prompt/config/golden
mismatches from the two already-existing local commits. The counter block
passed; the new old-episode gate failed honestly. This is not a release-ready
dataset. No attempt was made to fix it by changing stores or rerunning capture.

`git diff --quiet -- data data.json data.js agent.json agent.md llms.txt`
exited **0**: source stores and served artifacts were unchanged.
Full source-only release gate, independent review, live capture and production
proof remain the releasing agent's responsibility; no production success claimed.

## Adoption and release — main owns this

At inspection, local main already contained two unrelated commits above cached
origin/main (`4d36d6604c38640e181a1ba5b960cecd085554bb`): `1da1ea5` and `f009b21`.
Do not silently include or discard them. Adopt this repair commit alone onto
current reviewed origin/main if those classifier edits are not part of the
release. Preserve current publisher-generated stores and any concurrent work.

1. Review/adopt the scoped repair into the normal source-release checkout.
   Install/check the existing hook with `sh scripts/dev/install-hooks.sh`.
   Run `node tools/dive-analytics/release-gate.mjs --source-only` on the committed
   candidate. Only if it passes and source stores/public files match origin/main,
   use the existing `DIVE_SOURCE_ONLY_PUSH=1 git push origin HEAD:main` route.
   This is code adoption, not a data publication.
2. In `/Users/bones/Library/Application Support/Dive Radio Analytics/publisher-main`,
   inspect `node tools/dive-analytics/run-daily.mjs --dry` and the real ledger.
   Use the existing protected preparation/adoption path; never overwrite dirty
   generated stores or copy development data over the publisher.
3. If today's two automatic attempts are hard failures and no operator repair
   was used, the owner's approved rerun may use
   `node tools/dive-analytics/run-daily.mjs --operator-repair --reason="Tommy approved all-episode refresh and verified YouTube revision repair on 2026-09-22"`.
   It requires changed committed code and retains both failed receipts. If the
   budget differs, follow the existing primary/recovery rules; never reset state
   or call run-chain/postlive-publish directly to bypass the cap.
4. Require the complete capture/build/strict release gate and exact production
   byte proof. Check that EP1/EP2 gained real source observations and the served
   latest values match them; old rows and frozen scores must remain unchanged.
   `node tools/dive-analytics/recover-publish.mjs --proof-only` can recheck the
   resulting production without capture or an extra attempt.

Rollback: revert only this code commit through the same protected source path;
never roll back or erase newly captured history. That restores the older
60-day behavior and strict counter block, so it is not a freshness solution.
