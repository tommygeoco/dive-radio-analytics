# Design critique — Dive Radio Episode Analytics

**Date:** 2026-08-22 · **Scope:** `index.html` (the whole UI) · **Goal:** modernize, simplify, adopt progressive disclosure, reduce information density.

**Method:** the dashboard was served locally and screenshotted in 16 states (desktop 1440×900 and mobile 390×844: default, full page, every tab/segmented-control state, chart and card hover tooltips, solo focus, insights, controls close-up). Two independent design critics reviewed the rendered pixels and the source — one for visual modernity and craft, one for information architecture and disclosure — grounded in the dataviz design skill (`anti-patterns.md`, `marks-and-anatomy.md`, `color-formula.md`, `interaction.md`, `choosing-a-form.md`), with every palette run through the skill's computable validator (`validate_palette.js`). Findings below were cross-verified against source line numbers and `data.json`. A reusable critic now lives at `.claude/agents/design-critic.md`.

---

## Verdict

The analysis layer is genuinely rigorous — unit discipline (X reach never blended into totals), honest coverage flags, refusal to fabricate X history — but the presentation buries that rigor under volume. The default view ships **~104 distinct information elements above the fold** (27 numerals plus 24 number-encoding marks) to answer a question — *"how is the newest episode doing, and is anything unusual?"* — that needs about five numbers. **18 non-neutral hues** across three uncoordinated palettes collide in meaning (`--good` *is* episode E3's color; `--bad` *is* E5's; `#59b0ff` is simultaneously the UI accent, episode E6, and platform @designertom). **42 reachable view states** hide behind three segmented control groups. The same six totals are encoded twice above the fold, and the content that would most reward a curious host — per-channel breakdowns, per-host reach splits, viewer quotes — is gated behind a hover with no affordance and no touch path.

The fix is not decoration. It is **subtraction and layering**: one hero for the newest episode, one encoding of the standings, three named views instead of a parameter space, three insight headlines instead of eleven paragraphs, and a click-pinned detail panel that gives every hidden datum a discoverable, touch-accessible home. Modernity then comes almost free: a token system, one type scale, validated palettes, and selection by elevation instead of accent flood.

## By the numbers

| Measure | Current |
|---|---|
| Elements above the fold (1440×900) | ~104 (55 in the card row alone) |
| Non-neutral hues page-wide | 18, in 3 palettes — all 3 **fail** the skill validator |
| Reachable view states | 42 (2 tabs × 6 chart configs × 7 solo states) |
| Duplicate encodings | 6 totals shown twice; E6's total shown 3× |
| "show me →" links reproducing the default view | 6 of 11 |
| Distinct font sizes / families in use | 15 sizes (incl. half-pixel steps) / 3 stacks — 2 inside one chart canvas |
| WCAG AA failures | 1 (quote attribution `#6d788c` on `#171d29` = 3.79:1 at 11px) |
| Hover-only content with no touch path | per-channel splits, coverage notes, per-host reach, viewer quotes |

## What already works — a redesign must keep these

- **The verdict banner instinct.** A computed per-tab headline leading with the newest episode is exactly the right Layer-1 idea; only its execution (hedged prose, methodology in the headline slot) and its competition need fixing.
- **Unit discipline in the data model.** Reach is never blended into totals; Trajectory refuses to draw fake X history; coverage and staleness are flagged honestly. Presentation should surface this rigor instead of hiding it in small print.
- **Insight → chart deep links.** Each insight carries a `chartState` that rehydrates the view — the right architecture for evidence-backed claims. It needs honest routing, not removal.
- **Solo emphasis as one coherent state.** Card click and bar click drive the same `state.solo`, dimming via alpha — correct "highlight one, gray the rest" form, no recolor-on-filter.
- **Standings' form choice.** Part-to-whole per episode → horizontal stacked bars with direct-labeled totals, legend present, ◐ marker where coverage is partial.
- **The neutral shell and the tooltip.** One navy family (`#0b0e13` → `#141922` → `#273043`), hairline borders, solid recessive grid; and the HTML tooltip (layered surface, color-keyed rows, right-aligned `tabular-nums`) is the best-crafted component on the page — it sets the quality bar the rest should rise to.
- **One control row above the chart** (not per-chart filters) — placement is right; contents are the problem.

## Three systemic diagnoses

### 1 · No layering — everything ships at once

Six 170px cards each carry a hero total, an X-reach figure, a pace delta, a premiere date, flags, and a colored dot: 55 elements and **three incompatible unit systems** (views+plays, impressions, YT-only %) in one 90px band. Directly below, the standings chart re-encodes the same six totals the cards just showed — roughly half of everything above the fold is a duplicate. Below that, all eleven insights render as full-weight prose (~450 words) in stored order: the one urgent item (Outlier) sits at position 7, ~1,800px down; two Live insights sit in the Growth tab's list. Meanwhile the *best* detail content is invisible: the card hover mega-panel (per-channel table, coverage notes, per-host reach split, viewer quotes) has no visual affordance, is unreachable on touch (the card's click is spent on solo-toggle), and holds data that exists nowhere else in the UI — "tooltips enhance, never gate" is violated in both directions at once: everything shallow is exposed, the depth is gated.

### 2 · Color does too many jobs

Three palettes were designed independently and collide: 6 episode hues, 4 platform colors, 8 insight-category colors, plus accent, good/bad, and flag amber — 18 identity hues where the anti-patterns ceiling is ~7 meaningful classes. Collisions are semantic, not just aesthetic: `--good: #3ecf8e` **is** E3's identity color and `--bad: #ff7a59` **is** E5's, so E5 wears "bad" and E3 wears "good" by hue alone; `#59b0ff` means accent, E6, and @designertom on the same screen; four separate ambers coexist. The validator (the skill's computable check — never eyeballed) fails **all three palettes**: the platform set's `#d7dbe0` has chroma 0.008 ("reads gray") yet is the most luminous element on the page (12.67:1 — brighter than body text), so one arbitrary channel reads as highlighted in every bar; the episode set fails the lightness band (6 of 8), chroma floor (`#6b7a94` reads gray — the top line of the live chart looks like a median reference, not a series), and the normal-vision floor (E1↔E2 ΔE 12.7 < 15 — genuinely hard to tell apart, visible as the clumped top lines in Trajectory); the category set's worst pair measures ΔE 1.8 under deuteranopia. Episode hues also cycle (`ep % 8`) — a structural violation waiting for episode 9.

### 3 · An analyst's controls for a host's three questions

2 tabs × (Standings | Trajectory × [Since premiere | Calendar] × [Cumulative | Per week]) × 7 solo states = 42 view states, exposed as up to three simultaneous unlabeled segmented groups whose three saturated "on" fills read as three primary buttons fighting the chart. Hosts need roughly three views daily: standings, pacing race, weekly gains. Worse, switching Standings→Trajectory silently changes the **unit** (total views incl. X plays → YouTube-only), so E6 drops from 1,833 to ~880 while its card still says "1.8k views" directly above — disclosed only by a rotated 11px axis title and a muted hint line below the chart. The ◐ glyph carries two different meanings (late registration on cards; partial plays coverage on totals). "Reset view" resets the tab too — from Live it teleports you to Growth.

## Ranked findings

Severity · finding — fix.

1. **HIGH · Exclusive data gated behind an unaffordanced hover, dead on touch** (`index.html:651–654`; the panel content exists nowhere else; no table view exists anywhere — double anti-pattern). → Promote the hover mega-panel to a click-pinned **episode detail panel** (below the card row or as a drawer), opened by the existing card/bar click alongside solo; hover previews, tap pins, Esc/× closes; add a chart⇄**table** toggle as the canonical non-hover home for every number.
2. **HIGH · The newest episode occupies the worst position on every screen** (oldest→newest order puts E6 far right on desktop, sixth card ~1.5 screens down on mobile; the outlier alert is at insight #7, ~1,800px down). → Merge verdict + newest card into a **hero block** (≥28px figure, platform-split secondary line, pace chip, snapshot sparkline, 0–2 auto-promoted alert chips), first in reading order; demote older episodes to compact rows.
3. **HIGH · 18-hue color anarchy with meaning collisions; all palettes fail validation** (lines 10, 150, 155–160, 711–718). → One color budget ≤10 non-neutral hues: the skill's validated 8-slot dark categorical for episodes (`#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`), a 2-hue×2-step platform set (hue = platform, lightness = host; YT `#e5484d`/`#ff8a80`, X `#3b82d9`/`#79b8ff`, re-validated against the new surface), status pair reserved and absent from all series palettes, one accent that no data may wear. Stop cycling at 8 — fold or facet.
4. **HIGH · The Standings⇄Trajectory unit trap** (totals silently halve; ◐ means two things). → A real chart title line stating scope in place ("YouTube views only — X plays have no history before 08/21"); scope card heroes to match the active view or badge them; split the two glyphs and define both in the detail panel.
5. **MED · Six totals encoded twice above the fold** — cards and chart are the same chart. → Keep **one** Layer-1 encoding (the standings chart); collapse the card row to the hero block + a slim per-episode strip (dot · E# · pace arrow) that doubles as legend/selector. Removes ~45 elements alone.
6. **MED · 42-state controls model** (three mutating segmented groups; three accent-flooded "on" states; reset crosses tabs). → One segmented control of three **named views** — Standings · Pacing race · Weekly gains — mapping onto the existing state fields; "by date" axis toggle tucked inside the trajectory presets; reset scoped to the current tab; selected segment styled by elevation (surface-2 fill + hairline), not accent flood.
7. **MED · The insight wall: 11 unranked prose cards, ~450 words, 8-color category rainbow** (worst category pair ΔE 1.8 deutan; colored 10px uppercase labels). → Rank by actionability (outlier/momentum first; live items routed to the Live tab; data-note demoted to an "About this data" footnote); show **top 3 as one-line headlines** with expand-on-click; collapse the rest behind "All insights ▾"; category color → one neutral icon tint (3 semantic tints max).
8. **MED · "show me →" mostly shows nothing** — 6 of 11 links reproduce the default view (verified against `data.json` chartState + fallback at `index.html:741–744`); engagement routes to a views chart that can't show its claim; the whole card is the click target and force-scrolls to top. → Render "show me" only where the target differs from default *and* evidences the claim; route reach/engagement claims to the detail panel or table view; make the link the sole click target.
9. **MED · Standings bars break the mark specs** (~36px gapless saturated slabs; segment-at-a-time tooltip via `intersect: true`). → `barThickness: 22`, 2px surface gaps (`borderColor` = panel, `borderWidth: 2`), `borderRadius: 4` on the final segment only; tooltip `mode: "index"` so one hover reads the whole stack (reusing the card-panel row markup); delta mode gets `barThickness: 12–16` instead of 4px slivers.
10. **MED · No type scale; three font stacks, two inside one canvas** (15 sizes incl. half-pixels; `font-weight: 650` snaps on non-variable fallbacks; Chart.js default Helvetica vs plugin-hardcoded SF in the same chart; the page's largest type is a card stat, not the hero). → 7-step scale (11/12/13/14/16/20/28, −0.02em on figures), weights 400/500/700, `Chart.defaults.font.family` synced to the body stack once at init; optionally one webfont (Google Fonts) for cross-OS consistency.
11. **MED · Surface sprawl and accent overload** (six near-identical navies; one orphan gradient; hover swaps full border to saturated accent; legends disabled on all line charts while end labels collide — E2 detached below E1 in calendar view, six labels scattered over live data). → 3-step surface ramp (`#0b0e13` / `#12161f` / `#1a212e`) + two alpha border tokens; hover = border-strong + soft shadow; accent border reserved for the *selected* card; restore a compact legend on multi-series line views; leader lines when an end label is displaced >6px; the live chart becomes an emphasis chart — newest in accent, five priors in one context gray (identity on hover/solo), optional dashed median guide.
12. **LOW · Micro-debt and mobile** (glyph soup ▲▼◐→♥ at mismatched metrics; quote attribution 3.79:1 AA fail; seven radius values; off-grid spacing; at 390px the chart is ~1.9 screens down, hover layers vanish, `min-height: 34px` dead bands in every card). → Radius tokens 4/8/12; 4px spacing grid; inline SVG glyphs at `currentColor`; attribution lifted to ≥4.5:1; mobile gets hero-first order, a 2-col compact strip, `CARD_CAP` 3 with the existing (currently dormant) expander, and the detail panel as the native tap target.

## The target — three layers

| Layer | Contents | Reveal | Touch path |
|---|---|---|---|
| **L1 — always visible** | Newest-episode **hero block** (merged verdict+card: title, hero total with "880 YT + 953 X" secondary, pace chip, snapshot sparkline, 0–2 alert chips) · **standings chart** as the single per-episode encoding (newest row first, full-stack tooltips) · slim episode strip (dot · E# · pace) as legend/selector · **top-3 insight headlines** · one control: Standings · Pacing race · Weekly gains, + 2 tabs | — | — |
| **L2 — one interaction away** | **Episode detail panel** (the promoted hover panel: per-channel table, coverage/◐ notes, X reach + per-host split, quotes, live stats) · solo emphasis · remaining 8 insights with honest "show me" · trajectory presets with in-title scope · Live tab (emphasis-styled) | click/tap card, chart row, or strip · "All insights ▾" · view segment · tab | identical — click/tap everywhere; panel pins until ×/Esc/outside-tap |
| **L3 — on demand** | **Table view** twin of the chart (every number, per-channel, reach, engagement, live, flags) · "About this data" collapsible footer (data-note, glyph definitions, unit rules, refresh cadence) · calendar-axis permutations · older-episode expansion | chart⇄table toggle · `<details>` footer · "by date" toggle · "N older" expander | native |

**Default view after:** hero block (~10 elements) + standings chart (~30) + episode strip (~15) + three insight headlines (~6) + controls/tabs (~6) ≈ **65–70 elements, down from ~104** (≈35–40% cut); the 55-element card band drops to ~25; the insight wall drops from ~450 words to 3 lines. Every current datum stays reachable in ≤2 interactions; everything currently hover-only gains a tap-parity home.

## Visual language (proposed tokens)

Keep the navy shell's restraint; tokenize it. Read: a Linear/Vercel-class operations page — quiet chrome, loud data, nothing else loud.

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#0b0e13` | keep |
| `--surface-1` | `#12161f` | cards, chart, insights |
| `--surface-2` | `#1a212e` | tooltip, hover, selected control |
| `--border` / `--border-strong` | `rgba(148,163,184,.10)` / `.18` | replaces `#273043` / `#3d4c68` |
| `--text-1/2/3` | `#eef1f6` / `#b7c1d1` / `#8a94a8` | adds the missing mid tier; text-3 ≥4.5:1 |
| `--accent` | `#59b0ff` | UI only — tabs, links, solo border; never data |
| `--good` / `--bad` | `#2fbf71` / `#ff6b5e` | reserved; absent from data palettes |
| Episodes | `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767` | validated dark categorical, fixed order, never cycled |
| Platforms | YT `#e5484d`/`#ff8a80` · X `#3b82d9`/`#79b8ff` | hue = platform, step = host; re-validate vs `--surface-1` |
| Radii / spacing | 4 · 8 · 12 / 4px grid | three radius tokens replace seven values |
| Type | 11/12/13/14/16/20/28 · 400/500/700 | one family, synced into Chart.js |

## Implementation roadmap (all within vanilla JS + Chart.js, single file)

1. **Tokens & craft (no behavior change):** surface/border/text/radius/spacing tokens; type scale + one font family incl. `Chart.defaults.font`; swap the three palettes for the validated sets; bar thickness/gaps/rounded data-ends; delta bar widths; legend + leader lines on line charts; fix the AA contrast miss. *Mostly CSS + config — low risk, transforms the feel on its own.*
2. **Layering (the density work):** hero block (merge verdict + newest card); compact episode strip; click-pinned detail panel reusing `showCardTip` markup; insights top-3 + expander with honest routing; three named view presets + scoped reset; unit-scope chart titles; index-mode stack tooltips.
3. **Depth & mobile:** table-view toggle; "About this data" `<details>` footer; mobile order (hero → chart → strip), `CARD_CAP` 3, 2-col strip; live-view emphasis treatment; glyph SVGs.

Phases 1 and 2 each stand alone; either can ship independently. Nothing here deletes a datum — everything currently visible or hover-hidden keeps a home one or two intentional interactions away.
