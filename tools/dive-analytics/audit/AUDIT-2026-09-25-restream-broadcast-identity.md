# Restream broadcast identity and stale X plays — 2026-09-25

## Finding

The 2026-09-24 Just-in-Time Interfaces episode has two `designertom` X posts
(`2103213058743218388` and `2103055258993721705`) pointing to the same
broadcast (`1qxvveXzoggxB`). Restream exposes that broadcast once, as channel
`17404025`. The morning and recovery captures on September 25 collected E11,
but the first required validation stopped both runs because it required one
registry **post** per Restream channel. Production therefore remained on the
September 24 build and did not include E11.

The current successful broadcast pull counts its plays once. If a later pull
fails, both the collector's `playsSummary` and the public builder's
`xPlaysSummary` previously summed the high-water count once per post. The
saved 777-play reading on each DesignerTom post would have been reported as
1,554. This was a latent stale-data error, not an observed doubling in today's
successful pull.

## Repair and proof

- Match a Restream X destination by broadcast and account. Several posts from
  that one account may resolve to the channel; missing and cross-account
  matches still fail. YouTube still requires one registered upload.
- Share one high-water rule between the collector and public builder: count
  each distinct broadcast once, select its highest saved observation, and
  treat an unobserved additional broadcast as partial rather than complete.
  A measured zero remains a measured zero.
- Regression fixtures cover the exact E11 post and broadcast identifiers,
  cross-account and YouTube ambiguity, a failed fresh X pull, and partial and
  zero high-water observations.

On a scratch copy of the unpublished September 25 publisher data, the repaired
Restream validator traced all 11 episodes to their events and reported zero
validation failures. This is candidate proof; live publication and today's
daily-run receipt are separate checks.
