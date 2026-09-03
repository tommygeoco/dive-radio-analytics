# X broadcast-only correction — 2026-09-03

## Finding

E8 showed 323 episode views before air. Both scheduled YouTube containers were
at zero and no Restream live event existed. The 323 was X's native-video
`view_count` for a 13.82-second teaser on Ridd's announcement post. Discovery
registered the nearby post without a promo role, capture copied native-media
views into `plays`, and synthesis added them to episode total views despite the
target having no broadcast ID.

An audit of 701 source snapshots found no other positive native-media play
count. E1–E7's latest X plays exactly match their resolved broadcast high-water
marks. Only E8 required a source correction.

## Correction

- Removed E8's native-video `detail.plays` and top-level `plays` value.
- Marked that post as a promo/non-broadcast target.
- Stopped requesting native-media public metrics from X.
- X `plays` now has one writer: the resolved broadcast extractor, after
  `live_status` confirms the broadcast is live or finished.
- Removed the synthesis fallback from tweet-media detail and required a
  resolved broadcast target before X plays can enter coverage or totals.
- Added a fixture and blocking validator checks for source provenance.

The false total also exposed a maturity leak in the show-health comment-rate
fact: the latest numeric rate was selected before checking episode age. Formula
`health-v6` requires the selected episode itself to be finished and visibly
supersedes the affected same-day read.
