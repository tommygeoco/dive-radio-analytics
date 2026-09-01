# Design critique — the show-health strip (2026-09-01)

Scope: the top row of the dashboard, redesigned today from three cards (gauge,
diagnosis rows, Today's read, plus a fourth evidence card behind "Why this
score") into one strip with one disclosure. The owner supplied a mock: a
single card, a small ring with the score, six pill chips with state dots, the
headline held to two lines, an "Expand" button at the right. This ledger
records what shipped, what the design critic found, and how each finding was
triaged (fixed / queued / rejected with evidence), per CLAUDE.md step 7.

Critic: the `design-critic` agent (read-only; screenshots via Playwright at
1440, 1280, 1100, 1021, 1020, 900, and 390 px, plus keyboard, touch, reduced-
motion, and paused transition frames). Builder: this session. Evidence PNGs
lived in the session scratchpad (`shots/before-*.png`, `final*-*.png`,
`critic-*.png`); the measurements quoted below were taken from them and from
DOM probes, not from the source alone.

## What shipped

| | Before (three cards) | After (one strip) |
|---|---|---|
| Health row height, desktop 1440 | 396 px | **98 px** |
| Health row height, tablet 900 | 512 px | **181 px** |
| Health row height, phone 390 | 723 px | **281 px** |
| Row height with everything open, desktop | 739 px (evidence card) | 700 px (evidence, rows, do-next) |
| Elements in the row at a glance (critic count) | 31 | 22 |
| Numbers in the row at a glance | 3 (`46`, `100`, `50`) | 1 (`46`) |
| Validator glance budget (rule 8) | 11 numeric tokens | 9 |

Glance layer: a 64 px ring with the saved score and a notch at 50, the band in
words (`Above usual` / `Near usual` / `Below usual`, from the same `BANDS`
thresholds the checks use — `scoreBandWords` in `index.html`), one chip per
saved check (a real button; dot = state, hollow when the check has no reading;
accessible name carries the word: "Growth: Healthy"), the day's headline held
to two lines, and Expand.

Click layer: the shared structured tooltip on every chip (hover, focus, tap-
pin) with each measure's value, direction, typical, sample, and the stored
"compared at the same age" note; and the details region — Why this score
(Helping / Needs work bullets, the saved driver sentences, the trend
sparkline), Check by check (the six rows with state words, same tooltip), Do
next (the two saved actions).

Motion: the region is a grid row easing `0fr → 1fr` over 320 ms
(`cubic-bezier(.22,1,.36,1)`); the body fades in 60 ms later; the chevron
turns; the headline's box eases from two lines to its full height and only
re-clamps once the closing motion ends (a clamp cannot animate, so the
ellipsis waits for the last frame). The region stays in the DOM and is `inert`
while closed; the toggle mutates the existing card, never `render()`, so the
same DOM does the moving; a re-render for any other reason draws the card
straight into its current state. Measured open: 98 → 322 (60 ms) → 598 (120)
→ 673 (200) → 695 (320) → 700 px (480). Reduced motion: 98 → 699 px in one
frame. Escape inside the open region collapses it and returns focus to the
button.

Contracts kept: one `data-fold-number` (the gauge); every check renders as a
plain-word state via `checkState`; rows keep `<div class="checkrow"
tabindex="0" data-stat=`; Today's read reads `esc(h.headline)` and store-backed
`esc(r.recommendation)`; evidence starts closed behind a real `aria-expanded`
button and carries `bullets(h.pros)` / `bullets(h.cons)`; no lowercase retired
absence copy. Two validator blocks were rewritten for the new shape, not
loosened: the "Why this score sits under the gauge, ahead of the diagnosis
card" ordering check became the strip contract (gauge with band words, one
drillable chip per check, the clamped headline, one Expand disclosure ahead of
an inert-while-closed details region toggled in place), and the page-gutter
check for `.healthrow` now asks for the shared bottom margin only, since the
row is a single card with no inner grid to gap. `validate.mjs` exits 0.

## What works (critic)

- One card, one disclosure. The three equally weighted cards (a PRODUCT.md
  anti-reference) are gone; the page's first decision is no longer a 400 px
  KPI wall.
- `Near usual` replaces `of 100` + `50 is this show's usual level`: two
  numbers became one word derived from the same thresholds the checks use, so
  the ring and the chips cannot disagree.
- The motion mechanics are right: an ease-out row, content fading in a beat
  after the container and out before it collapses, chevron rotation, `inert`
  while closed, Escape returning focus, a true no-motion path.
- One drill payload per check shared by chip, row, and tooltip; values lead,
  labels follow; the basis note reaches the click layer; focus opens it, a
  tap pins it.
- Chips are real buttons whose accessible name carries the state; the focus
  ring is visible.
- The tablet cut puts score | read on row one and the chips on row two —
  decision before evidence — and the headline is whole there and on the phone.

## Findings and triage

Severity and evidence are the critic's; the triage line is the builder's.

### 1. [SEV-high] Check state is color-only at a glance — QUEUED (owner decision on treatment)

The six chips carry state as a green / coral / gray / hollow 8 px dot; the
word exists only in the tooltip, the accessible name, and the expanded rows.
PRODUCT.md: state must never depend on color, hover, or a symbol alone. The
old row showed `Healthy` / `Fragile` / `Not in yet` without interaction, so
this is a regression at the glance layer. `--good #3ecf8e` and `--bad
#ff7a59` are near in luminance for deuteranopes; filled-gray steady vs hollow
waiting is a second symbol-only pair.

Critic's fix: group the checks by state with the word once per group, fragile
first, and drop the pill chrome — `Fragile  Audience · Reach · Live turnout`
on one line, `Healthy  Growth · Goodwill    Not in yet  Subscribers` on the
next — bare labels with the page's dotted drill mark; ≈ 360 px wide against
≈ 590 px for the chips, which is what funds finding 2.

Triage: agree it is the largest honesty gap in the strip. Shipped
mitigations: the hollow dot for the unscored state (shape, not color), the
accessible name, the tooltip on hover / focus / tap, and the words one click
away in Check by check. The treatment is the owner's call because the mock
is the owner's: (A) the critic's grouped words, quietest and narrowest;
(B) keep the pills but order them by state with the word before each group
("Fragile" then the three chips, "Healthy" then two, "Not in yet" then one)
— this keeps the mock's language and adds ≈ 150 px, so it needs the read
zone to yield or the chips to tighten; (C) leave as shipped. Recommendation:
B if the pills stay, A if the strip should be as quiet as possible.

### 2. [SEV-high] The headline is the one sentence the page exists to deliver and desktop shows the least of it — PARTLY FIXED, rest queued with 1

At 1440 and 1280 the clamp keeps 60 of 90 characters and cuts before the
diagnosis ("…engagement per viewer an…"; "reach off X both look fragile
right now" is gone); tablet and phone show it whole. The read zone is 335 px
of which the button takes 92, the divider padding 20, the gap 14. The lead
sentence is also unled typographically: 14.5 px / 600, the same size as
`Near usual`.

Triage: the mock clamps at the same place, but the critic is right that the
cut half is the useful half. Fixed now: the read zone is a click target for
pointer users (a cut sentence invites a click on the sentence; a drag to
select text is not a click). Queued with finding 1: the width rebalance
(grouped checks ≈ 360 px give the read zone ≈ 575 px and the whole headline
fits two lines), then set the headline to 16 px / 600 so it is the largest
text in the strip after the score. Builder's note: `-webkit-line-clamp` cuts
per character, so the ellipsis can land mid-word ("an…"); only width fixes
that honestly.

### 3. [SEV-med] Three kickers in one card, on two baselines — BASELINE FIXED, removal rejected

`SHOW HEALTH`, `HEALTH DIAGNOSIS`, `TODAY'S READ` share one card against the
owner's one-kicker-per-card exception, and the first sat 13 px lower because
the score zone was a vertically centered media object (kicker y = 95 / 82 /
82). The pair `Health diagnosis` / `Check by check` names one list twice.

Triage: fixed the baseline — the score words now sit at the zone's top, so
the three kickers share one line (measured y = 82 / 82 / 82). Rejected the
removal with evidence: the mock carries all three, and at a glance the three
zones need names. The tension with PRODUCT.md's one-kicker rule is real and
is the owner's call; if two go, the critic's `aria-label`s on the containers
keep the names for assistive tech.

### 4. [SEV-med] Opening moved the thing you clicked and the number you were reading — FIXED

The headline un-clamp grew the strip 66 → 108 px, so the ring, band word, and
kicker dropped 20 px and the Expand pill moved 20 px down and 5 px left while
widening 92 → 97 px as its label became `Collapse`. Linear / Vercel / Stripe
disclosures never displace the trigger.

Triage: fixed — zones are top-aligned, the button is pinned beside the
headline's first line (visually centered on a closed two-line read), the label
has a fixed width, and only the headline's own box changes height. Measured
after the fix: ring 0 px, band 0 px, button 0 × 0 px, width change 0.
Queued: starting the bring-into-view scroll together with the transition
rather than after it (today `block: "nearest"` only scrolls when the region's
bottom is off-screen). Persisting the open state in `localStorage`: queued
as an owner decision — default-closed is the glance contract, and a remembered
open state would quietly defeat it for the reader who expanded once.

### 5. [SEV-med] The expanded region narrates each fact three times and stacks it in one column — QUEUED, coupled to 1

The same facts appear as bullets with a number, as three driver paragraphs
without numbers, and as six rows with a state word; the evidence column runs
≈ 500 px against ≈ 250 px in the other two. `Check by check` is built from the
same `checks` array as the chips.

Triage: partly agree. Check by check exists because the state words must be
visible somewhere without hover (PRODUCT.md); once finding 1 puts the words
in the strip the rows are redundant and should go, and the region becomes two
balanced columns (Helping | Needs work, and Do next). Moving the drivers and
the sparkline into a tooltip on the ring ("why 46" on the 46) is a good idea
and is queued with it; the shared tooltip already works on touch.

### 6. [SEV-med] The sparkline turns a 6-point drift into a full-height plunge — QUEUED (honesty fix, own commit)

`healthTrend` scales the y-axis to the data's own low..high, so 51 → 45 fills
all 22 px; there is no 50 hairline, no endpoint values, and the caption gives
neither span nor direction.

Triage: agree — the auto-scale makes a small move look large, which the
constitution forbids ("decorative styling that makes weak data look more
certain"). Queued as its own change: a fixed domain (25–75 or 0–100) with a
hairline at 50, labeled endpoints, caption `Since Aug 24`; it changes a number
surface, so it ships with its validator block.

### 7. [SEV-med] The chip drill is invisible, mis-signalled, and not dismissable — ESCAPE FIXED, drill mark queued

A pill with a dot reads as a filter; the cursor stays an arrow; nothing says
hover / tap opens the numbers; the tooltip ignored Escape (WCAG 1.4.13).

Triage: fixed — Escape now clears a pinned or focus-shown tooltip before it
collapses anything (inside the strip and page-wide). Queued: the drill
affordance. The page's established drill mark is a dotted underline on a bare
label, which is the finding-1 (A) treatment; with pills kept, a `cursor: help`
and the underline on the chip word are the smallest honest signal.

### 8. [SEV-low] The ring borrows the interaction color; track and notch are faint — REJECTED for now, notch queued

Accent blue means selected / current elsewhere; the track is `--s2` on `--s1`;
the 50-notch is a 7 × 2 px tick at 70 % opacity.

Triage: rejected with evidence: the mock's ring is accent blue and the
previous gauge used the accent — the one place data has always worn it. Do
not tint the ring by band (agreed with the critic: a gray "near usual" would
read as disabled). Queued: a 3 px full-opacity notch spanning the stroke so
the 50 mark reads as a mark, not an artifact.

### 9. [SEV-low] An unplanned layout lives between 1021 and 1240 px — QUEUED, coupled to 1

Measured: the chips zone is 390–546 px in that band against ≈ 590 px of chips,
so they wrap 4 + 2 and the strip grows to 120 px while the read zone stays
at 330 px. From 1280 up the six chips hold one line (zone 601 px).

Triage: agree; it is inherent to six pills. Grouped words fit at every width
down to the tablet cut; failing that, move the two-row breakpoint from 1020
to 1240.

### 10. [SEV-low] Phone order buried the decision — FIXED

The strip read ring + Expand, then six chips, then the headline last, and Do
next was the last thing in a 1,448 px expanded card.

Triage: fixed — the phone now stacks score + Expand, the headline, then the
chips (measured y 64 / 130 / 221), and the single-column details lead with Do
next, then Why this score, then Check by check.

### 11. [SEV-low] The toggle is the loudest control, generically named, and the divider is asymmetric — REJECTED with evidence

Fix proposed: a text-only `Details` / `Hide details` toggle and no divider.

Triage: rejected for now — the filled pill labelled Expand and the single
divider before the read zone are the mock's; the old `Why this score +`
promised less than the region now delivers. `Details` is a fair alternative
label and is the owner's call.

### 12. [SEV-low] Context: the space the strip saved was spent by the chart — RECORDED, out of scope

The chart's first six rows now sit above the fold (fold numbers 15 → 19
against rule 8's ≤ 12 as the critic counts them; the validator's own glance
budget counts 9 because it does not count chart labels). The coral fragile
dots sit 60 px above the YouTube-red split bar.

Triage: page-level; recorded for the next page pass. Finding 1 (words instead
of coral dots) removes the strip's part of the hue collision.

## Recommended next round (priority order)

1. **Words in the strip** (findings 1, 2, 7, 9 together, ~half a day with
   the validator block): choose treatment A or B above; rebalance the zones so
   the whole headline fits two lines at 16 px; retire the wrap band.
2. **Two-column details** (finding 5, ~2 h after 1): drop Check by check,
   Helping | Needs work side by side, Do next beside them; drivers and the
   sparkline behind the ring.
3. **Honest sparkline** (finding 6, ~1 h + validator): fixed domain, 50 line,
   endpoints.
4. **Notch** (finding 8, 15 min): 3 px, full opacity, spans the stroke.
5. Owner decisions, no build needed until decided: kicker count (3), toggle
   label and divider (11), remembered open state (4).

## Critic's target

Layer 1 is one 98 px card that reads left to right as decision → state → why,
with nothing in it that changes height when opened: a neutral 64 px ring with
`46`, one kicker over `Near usual`; the headline whole at 16 px across a
≈ 575 px zone with a quiet toggle at its end; and the six checks as two short
worded lines, bare labels with the dotted drill mark and no dots, pills,
kickers, or divider. Layer 2: each check name's tooltip (unchanged payload,
Escape-dismissable), the ring's own tooltip with the drivers and a fixed-domain
sparkline, and the details region as two balanced columns. Layer 3 stays
About. Count: strip 22 → 16 elements, chrome 6 pills + 3 kickers + 1 divider
→ 1 kicker, strip hues 3 → 1, and the open transition animates one thing
instead of three.

Builder's note on the target: everything in it except the ring color and the
kicker count is compatible with the owner's mock in spirit (one strip, one
disclosure, score-chips-read left to right); those two are the mock's explicit
choices and are left to the owner.

## Round 2 — the recommended changes, shipped the same day

Owner direction (2026-09-01, afternoon): make all recommended changes and
fixes, then publish to main and production. Treatment A was chosen for
finding 1 — the words are the honest version of the mock's pills, and they
are what let the headline fit. The owner decisions in item 5 of the next
round stayed as recommended: three kickers, the Expand pill and its divider,
and no remembered open state.

| Finding | Round-2 status |
|---|---|
| 1 color-only state | **Fixed.** The checks are words grouped by state, fragile first: `Fragile  Audience · Reach · Live turnout` over `Healthy  Growth · Goodwill    Not in yet  Subscribers`. Each name is a real button wearing the page's dotted drill mark; no dots, no pills. Strip hues at a glance 3 → 1 (coral on the word Fragile only). |
| 2 headline cut | **Fixed.** Read zone 335 → 546 px at 1440; headline 16 px / 600 and whole in two lines (measured not truncated at 1101, 1180, 1280, 1440); the clamp holds three lines for a longer day. The score zone and the read zone both toggle on click. |
| 3 kickers | Unchanged by decision (all three kept; one baseline since round 1). |
| 4 trigger moves | Fixed in round 1; the bring-into-view scroll now starts with the motion, and only when the region's bottom would fall below the viewport (at a 520 px window it scrolled 96 px and the region ends 25 px above the fold). |
| 5 region narrates three times | **Fixed.** Check by check is gone (the strip says it); Helping and Needs work sit side by side; two columns, 1.5fr and 1fr; expanded height 700 → 542 px. The drivers stayed in the region rather than in a ring tooltip: three sentences in a hover box fail the click-layer size test. Instead the score itself opens the region — "why 46" on the 46. |
| 6 sparkline | **Fixed.** Fixed 25–75 scale, a hairline at 50, the first and newest saved scores labeled (51 → 46), caption `since Aug 24`. The validator locks the scale, the labels, and the seven-day gate. |
| 7 drill invisible | **Fixed.** Bare names with the dotted mark and a help cursor; Escape dismissal since round 1. |
| 8 ring | Notch **fixed** (3 px, full opacity, spans the stroke); the ring keeps the accent by decision. |
| 9 1021–1240 band | **Fixed.** The two-row cut moved to 1100 px; from 1101 up the strip is one row with the headline whole. |
| 10 phone order | Fixed in round 1. |
| 11 toggle and divider | Unchanged by decision. |
| 12 page level | Recorded; not part of the strip. |

Measured after round 2: desktop 1440 closed 106 px (a 16 px two-line
headline beside two worded lines), open 542 px; tablet 900 closed 201 px, open
769 px; phone 390 closed 273 px, open 1,203 px. Nothing in the strip moves on
open; the kickers share one baseline; Escape clears a tooltip, then collapses.
`validate.mjs` exits 0. The strip contract now asks for `hgroups`, `hgword`,
the fragile → steady → healthy → waiting order, `hname` drill buttons, the
three-line clamp, and the fixed trend scale; the old chip and row literals
fail it.

## Files touched by the redesign

- `index.html` — the health CSS block (strip, worded check groups, details,
  motion), the tablet and phone cuts, `CHECK_LABELS` short names,
  `scoreBandWords`, `healthTrend` (fixed scale), `buildHealth` (names from
  one drill payload; in-place toggle; Escape; score and read-zone clicks),
  About copy for the strip; the carousel's scrollbar hidden (owner directive).
- `tools/dive-analytics/audit/validate.mjs` — the strip contract replaces the
  under-the-gauge ordering check; the `.healthrow` gutter regex asks for the
  shared bottom margin only.
- `ARCHITECTURE.md` — the rendered show-health surface row.
- `.claude/launch.json` — a `dashboard` preview config (Python static server
  on 8765) for local review.
