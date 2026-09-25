# Show-health fallback repair — 2026-09-25

## Finding

The September 24 primary and recovery chains captured and published current
source data, but both health steps failed after two OpenClaw model requests.
`~/Library/Logs/dive-radio-analytics/chain-2026-09-24.log` records the model
error at lines 149 and 408. The public September 24 build therefore still
projected the September 23 health entry. On September 25, a separate required
validator failure stopped the chain before health; that source-mapping issue
is tracked separately.

The deterministic check scores and a grounded fixed synthesis were available.
`health.mjs --probe-fallback` passed on the September 24 source build (score
52) and on the September 25 publisher's captured source build (score 51).
The writer nevertheless treated the fallback as probe-only and threw on a
model failure, contrary to PRD v10 W34 and the lineage table in
`ARCHITECTURE.md`.

## Repair

After the existing two model attempts, the writer now validates the fixed
synthesis with `validateSynthesis` and saves it as a new day's entry with
`provider: "deterministic"` and `model: "fallback-v2"`. A missing direct-API
credential takes the same path. `--probe-model` remains strict and read-only;
`--dry` and `--probe-fallback` remain read-only. Existing entries, including
earlier `fallback-v1` entries, are not rewritten. If the fixed synthesis
cannot pass grounding, the writer fails and leaves the previous entry intact.

The fallback copies each cited fact's number and text. When the required
Helping/Needs work buckets rank an all-low or all-high set, an individual
bullet says "Still below usual" or "Still above usual" rather than claiming
the opposite standing. This restores W34's saved-read behavior without
changing `health-v9` scoring weights or the public data schema.

## Verification and release boundary

- `baselines.test.mjs` covers all-high and all-low ranked fallback bullets.
- `model-failures.test.mjs` and `gateway-model-failures.test.mjs` exercise
  request, JSON, and grounding failures through the real health CLI in
  isolated clones; they prove a stamped append, intact earlier entries, and
  a strict model probe that writes nothing.
- The September 25 data release and a fresh live health read still require
  the separate source-mapping gate, a full chain, and production parity proof.
  The About paragraph in the served `index.html` still describes the older
  keep-previous behavior and needs a later served-artifact release to match
  the restored fallback policy.
