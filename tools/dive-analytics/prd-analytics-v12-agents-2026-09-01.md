# PRD — Analytics v12: Agents — the whole show, readable by any agent in one pull (2026-09-01)

**Status:** built and live 2026-09-02 (early); the agent exam passed 12/12 on the first live run — status log at the end. **Owner ask:** analyze
everything the site lists — the content, outputs, intelligence,
recommendations, comparisons, transcripts, links, episode and show health —
and give any AI agent (Claude Code, Claude.ai, ChatGPT, OpenClaw, Cursor,
anything that can fetch a URL) one endpoint that returns the nicest agentic
read of the show to date: performance, stats, comparisons, recommendations,
topics with timestamps, trajectory. Regenerated on every build, kept complete
by rule, reachable from one "Agents" link in the header. A fresh conversation
that is told "go pull this" should know the show better than the owners do.

## 0. What the site exposes today (inventory, from `data.json` and `index.html`)

| Surface on the page | Data it renders | Notes an agent needs |
|---|---|---|
| Header stamp | `generatedAt`, `health.date`/`ageDays` | data date vs health-read date |
| Show health strip + Expand | `health.*` (score, headline, seven checks with `state`/`bands`/`swing`, measures with own/typical/note/qualified/carried, pros/cons with fact ids, drivers, `asOf`, `checkSetChange`, `trend`) and `baselines.direction`/`outlook` | the words are model-written over deterministic facts; every bullet cites one fact |
| Latest-episode card | newest `episode.latest` (YT views, X plays, X reach — never summed with plays) | pace, launch, newest-vs-previous, and the episode-health chip live in the panel and on the carousel, not on this card (fact-check row 2) |
| Growth trend card | `showTrend.week1VelocityByEpisode`, `baselines.direction.measures[firstWeek]` | first weeks only for clean episodes; the outlook renders on the health strip |
| Episode carousel | per episode: `ep`, `title`, `latest.totalViews`, and EITHER the episode-health chip (finished read) OR the launch word | seven episodes E1–E7 |
| Chart + table | `snapshots` (56–129 per episode, by destination), `weekly`, `live.series`, `watch.curve`, `baselines.typicalCurve` (the typical WATCH curve), X reach | raw series — summarised for agents, linked raw; `showTrend.cumulativeAllEpisodes` feeds Slack only |
| Episode panel | `links` (two YouTube uploads, two X broadcast replays — announce-post URLs live only in the registry), `baselines.pace`/`launch`/`newestVsPrevious`, transcript download, `watch` (share watched, average duration, minutes watched, traffic sources, curve shape, moments with transcript excerpts and model summaries), `live` (peak, average, unique viewers, minutes watched, chat, chatters, duration, per-channel), `comments` (counts, themes, featured quotes, per-comment list with sentiment), `metrics` (first week, flatline, engagement per 1k, anomaly text), `health` (episode read at day 21, frozen), `announces` | the richest surface; most of it never reaches an agent today |
| What matters | `insights[]` (five ranked, category, text, recommendation, `serves`) | grounded in the day's fact sheet |
| About this data | methodology prose | definitions live here and in `baselines.constants` |
| Not on the page | `transcripts/<slug>.txt` (150 KB each, `HH:MM:SS [Speaker n]` lines), `data/restream/moment-summaries.json`, `episode-ratings.json` (stored inputs), `health-history.json`, `health-verify.json`, `recommendations.json` facts | linked as deeper data |

Two gaps stand out. **Topics with timestamps do not exist anywhere**: the
transcripts are raw (two formats: Restream speaker files on the live-stream
clock for E2/E4/E6/E7, YouTube auto-captions on the upload's clock for
E1/E3/E5), the moments are three to five retention events per episode, the
tags are unconfirmed drafts. And **there is no single document**: an agent
would have to fetch a 675 KB `data.json`, seven transcripts, and infer the
methodology from prose in a `<details>` block.

## 1. Principles (extend the constitution)

27. **Complete by construction.** The agent brief is written by the
    deterministic build from the same stores the page reads, and a coverage
    census in the validator fails the build when a `data.json` path is
    neither covered by the brief nor listed as excluded with a reason. A new
    surface or a new piece of intelligence cannot ship without reaching the
    brief in the same commit.
28. **One URL, one prompt, any agent.** No MCP server, no auth, no SDK: plain
    HTTPS files that every agent runtime can fetch — Markdown for reading,
    JSON for parsing, an index for discovery. The instructions fit in one
    sentence.
29. **The brief is as honest as the page.** Absences carry reasons, every
    comparison names its basis, promo lifts are shown and marked, model-written
    words are labelled as such and cite their facts, and the brief states
    its own freshness. It never estimates.

## 2. Artifacts (all written by `build-data.mjs`, all served from the repo root)

### 2.1 `/agent.md` — the brief (the thing to point an agent at)

Fixed section order; every section present even when it says "none yet".

1. **How to read this** — three sentences: what it is, its THREE clocks
   (the data build, the health read's `dataThrough`, the chapters' written
   date — the health section's numbers are as of the read, the episode
   tables as of the build; the two can differ by a day), what is not here
   and where it is (raw series, transcripts). The honesty contract as six
   bullets, including: an absent value is written as a dash with its reason,
   never as zero or an empty list.
2. **The show at a glance** — episodes, span, cadence, hosts and channels,
   total views (YouTube + X plays), X reach kept apart, live audience
   summary, comments captured. Dashboard link.
3. **Show health today** — read date and state (early / settled / withheld —
   a withheld read prints no score), score and band, the headline and the
   drivers (labelled model-written), what the read is on, the seven checks as
   a table (state, score, bands, swing, each measure: own, typical, compared
   how, qualified / carried, sample), helping and needs-work bullets with
   their fact ids, the facts behind the read (`health.facts[]`, newly
   projected so an id is citable), the direction lens table (measure, word,
   change per episode, readings, compared how), the outlook (range,
   first-week direction, cool-off), the check-set change when one happened,
   and the known reporting breaks that touch any measure (§3.1).
4. **What to do this week** — the five ranked actions: rank, category, the
   finding, the action, the check it serves.
5. **Episodes** — one table, E1…En: date, title, YouTube views (both channels),
   X plays, X reach, first-week views, launch word, pace, episode health,
   live peak / average / unique / minutes, share watched, subscribers per 1k,
   discovery share, comments (+/−), promo flag.
6. **Episode by episode** — per episode: links (both uploads, the X
   broadcast replays, the announce posts from the registry, the transcript),
   **chapters with timestamps** — a YouTube deep link (`&t=<s>`) only when the
   transcript runs on that upload's clock (captions), otherwise the time is
   given as minutes into the live recording with no link, and the brief says
   why — watch moments (position, minutes in, viewers lost or gained,
   the excerpt, the model summary), feedback (themes, featured quotes with
   author and source), the live session, the first-week story (launch, pace,
   promo, late-tracked), episode-health read with its checks, and every
   absence with its reason.
7. **Trajectory** — first weeks in air order (with the launch reading
   beside them, and the difference explained: a first week needs a clean
   seven-day record; a launch reading is the same-age standing on the first
   day one exists), the newest episode's same-age pace, direction series with
   words, the outlook, newest-vs-previous at the same age.
8. **Definitions** — typical, same-age, mature, clean, promo outlier,
   carried, qualified, swing and bands, launch word, episode-health read,
   window-relative, direction, outlook, hold rate, discovery share. The one
   section where methodology words are allowed.
9. **Lineage and freshness** — stores, cadence, dates, the model steps and
   their versions, the verify loop's standing.
10. **Deeper data** — links: `agent.json`, `data.json`, each transcript,
    `llms.txt`, the dashboard, About.

Budget: the brief carries ten chapters at most per episode (gist ≤ 120
characters), moment summaries with excerpts cut to 160 characters, and at
most two featured quotes per episode; validator warns above 80 KB and fails
above 100 KB (71 KB on seven episodes once section 3 carries the read's
lens and section 7 the build's; the collapse rule holds it there).

### 2.2 `/agent.json` — the same digest, structured

`{ version, generatedAt, clocks, show, health (with facts[]), direction,
outlook, recommendations[], episodes[] (with chapters, moments, feedback,
live, watch, links, health), trajectory, knownBreaks[], definitions, lineage,
covers[], leavesOut[] }`. Every absent value is `{ value: null, reason }` —
never an empty list standing in for "none".
A curated ~80 KB, not `data.json`. Schema-stable keys; additions are fine,
renames are a version bump (`agent.json.version`).

### 2.3 `/llms.txt` — discovery (the emerging convention)

Title, one paragraph, then links with one-line descriptions: `agent.md`,
`agent.json`, `data.json`, every `transcripts/<slug>.txt`, the dashboard.

### 2.4 `/agent-skill.md` — a drop-in skill (static, checked in — not generated)

A SKILL.md-shaped file (frontmatter `name`, `description`) that tells a
Claude Code / OpenClaw agent: fetch `agent.md` in full, read §1 first, treat
the definitions as binding, cite fact ids, go to `data.json` or a transcript
only for what the brief says is there. Owners paste its URL or drop the file
into a skills folder.

### 2.5 Chapters — the missing intelligence (new L3 step `chapters.mjs`)

Per episode with a transcript: 6–10 chapters, each `{ start: "HH:MM:SS",
seconds, title ≤ 80 chars, gist ≤ 120 chars, quote 3–12 words }`, one model
call per episode over the whole transcript (`transcripts.mjs` presents it
with every timestamp line verbatim; the model reasons before it writes, so
the output budget is generous). Stored in `data/restream/chapters.json`
keyed by slug with the transcript's sha256, format (speaker / captions) and
clock (stream / upload), prompt version, model, and status. A changed
transcript or a prompt bump re-derives the list and moves the old one under
`superseded[]` with `rederivedFrom` (rule 9). Grounding, enforced by the
writer and re-checked by the validator from the store alone: `start` equals a
timestamp that exists in the transcript (both formats parse through the one
`watch-moments.parseTranscript`); `quote` is found within 90 seconds after
`start` with case, whitespace, and punctuation ignored and words never
fuzzy-matched; chapters at least three minutes apart; the first within five
minutes of the first timestamp; the last at least three minutes before the
end; titles and gists carry no digits and no banned words. A chapter that
fails is dropped; fewer than six survivors (or a first/last rule broken)
marks the episode `incomplete` and the brief says so. The chain runs it after
`moment-summaries`, optional, `model: true`; without a key it is skipped and
the brief says "chapters not written yet". The panel gains a Chapters list —
a deep link only on the upload clock.

### 2.6 The Agents view on the page

- Header gains one link, right of the title: **Agents**. It toggles the view
  (`#agents` in the URL, `hashchange`-driven, instant, no reload): the
  dashboard sections hide, an `agents` section shows; **Dashboard** in the
  same spot toggles back. Reload on `#agents` opens the view directly.
- The view: the one-line prompt with a copy button — *"Read
  https://dive-radio-analytics.vercel.app/agent.md in full, then answer as the
  show's analyst; treat its definitions as binding and cite its fact ids."* —
  the URLs (brief, JSON, index, skill), "what you get" (ten lines), per-runtime
  notes that all say the same thing (Claude Code: paste the prompt or
  `curl`; Claude.ai / ChatGPT: paste the prompt; OpenClaw: fetch the URL;
  any HTTP agent: `GET`), the honesty contract, freshness (built at, health
  read, chapters), and a note that no MCP or key is needed.
- No numbers on the view except its dates: the glance-number budget is
  untouched. The section sits after About, so the locked reading order is
  untouched; it carries none of the retired page-tab markers (`id="view"`,
  `class="tabs"`); the chart is re-sized when the dashboard returns. The
  reviews noted the retired Growth/Live page tabs directive; this view is a
  page mode for a different audience, not a chart view, and the owner asked
  for exactly this toggle.

## 3. Coverage census (rule 27, the mechanism) and known breaks

### 3.1 Known reporting breaks

`baselines.KNOWN_BREAKS` lists, versioned, every place the platforms changed
what they report: today one entry — Restream's per-channel live reporting
changed from E5 (X destinations began reporting viewers; unique live viewers
and minutes per viewer before and after are not like for like). Projected as
`data.baselines.knownBreaks`, rendered on every affected row of the brief and
in `agent.json`, and checked by the validator (each broken measure carries
the note).

### 3.2 The census

`tools/dive-analytics/agent-brief.mjs` exports `COVERAGE`: the list of
`data.json` paths the brief consumes (`generatedAt`, `episodes[].title`,
`episodes[].watch.moments`, `health.checks`, …, `baselines.outlook`) and
`EXCLUDED`: paths intentionally left to the raw file, each with a reason
(`episodes[].snapshots` → "raw series; summarised as first week, pace, and
totals", `episodes[].live.series` → "per-minute audience; summarised as peak,
average, hold rate", `episodes[].watch.curve` → "100-point curve; summarised
by shape and moments", `dests` → "destination labels; folded into links",
`insightsStale` → "held-back items are not advice"). Path grammar: dotted keys, arrays as `[]`, slug-keyed maps as `{slug}`,
destination-keyed maps (`yt:…`, `x:…`) as `{dest}`, depth at most four
(`episodes[].watch.byChannel[].views`). The walker is one function
(`agentBrief.censusPaths(data)`) used by the writer's fixture and the
validator. `health.direction` / `health.outlook` are covered through
`baselines.*` and listed as left out ("copies kept with the read for
history"). A path in neither list is DRIFT (reported at push time by the
hook and by the chain, never a blocked morning — rule 24). `agent.json.coverage` publishes both lists so an agent knows
what the brief left out and why.

## 4. Validator block "agent" (extends check 6/7 and card-layout) — tiers per rule 24: fail = reproducibility, numbers, links, chapter grounding, size above 100 KB; drift = census, words, page

- reproducibility: `agent.md`, `agent.json`, `llms.txt` rebuild byte-for-byte
  from the stores with `generatedAt` pinned (check 7 gains three artifacts).
- census: every `data.json` path covered or excluded (§3).
- numbers: the health score, every check score and state, the five
  recommendation texts, every episode's total views, launch word, and
  episode-health score in the brief equal `data.json`.
- links: every link in the brief is an episode link from `data.json`, a
  transcript that exists on disk, the dashboard, or one of the artifacts.
- chapters: every stored chapter re-grounds against its transcript (timestamp
  exists, quote found within the window, order strict); the brief lists all
  chapters the store holds and none it does not; an episode without chapters
  says so.
- words: outside §8 Definitions, the brief passes the plain-words check
  (drift).
- size: warn > 70 KB, fail > 100 KB.
- absences: no empty list where `data.json` carries null with a reason.
- page: the header carries the Agents link, the view exists, is hidden by
  default, toggles on `#agents`, carries the prompt verbatim with the live
  URL, and shows no number but the dates.

## 5. Workstreams

| # | Work | Files |
|---|---|---|
| W42 | `agent-brief.mjs` (pure functions: `buildBrief(data, stores) → { md, json, llms }`, `COVERAGE`, `EXCLUDED`), called from build-data; three artifacts + `agent-skill.md` | new module, build-data |
| W43 | `chapters.mjs` (L3, grounded, frozen per transcript hash), chain step, panel "Chapters" list | new module, chain.json, index.html |
| W44 | Agents view + header link, About paragraph | index.html |
| W45 | validator block "agent" + check-7 extension + fixture test (`audit/agent-brief.test.mjs`: coverage walker, grounding of a fixture chapter, size budget) | validate.mjs, new test |
| W46 | docs: README, ARCHITECTURE §3 rows, CLAUDE.md rule 27–29 and L5 note; PRD status log | docs |

## 6. Acceptance

1. **The agent exam.** A fresh-context agent given only the prompt answers
   twelve questions from the brief alone, each pinned to a path: today's
   score and band (`health.score`); the fragile checks (`health.checks[].state`);
   the first ranked action (`insights[0]`); E7's launch word and why it is
   marked promo-driven (`baselines.launch[E7]`); E5's launch reading and why
   it has no first week (`baselines.launch[E5]`, `metrics.week1Note`); the
   episode whose live viewers stayed longest (`episodes[].live.minutesPerViewer`,
   new); the newest episode's third chapter and its timestamp
   (`chapters.json`); the typical of the last three clean first weeks
   (`baselines.outlook.nextFirstWeek.typical`); what is absent for E7 and why
   (episode-health `reason`); where the raw watch curve lives (`data.json`);
   the outlook range; the health read's date and data-through stamp. Run after each deploy that
   touches the brief; recorded in the PRD status log.
2. Validator block "agent" passes; the census lists no uncovered path.
3. `agent.md` ≤ 80 KB on today's seven episodes (71 KB shipped).
4. Chapters exist for every episode with a transcript, all grounded.
5. The Agents view toggles in under 100 ms with no reload and is linkable.

## 7. Cost of honesty (what the brief will say it cannot say)

Stated as rules, derived at build time, never hard-coded: an X plays total
marked partial or stale carries its marker; feedback counts are printed with
the number of people behind them; a measure compared "as the earlier
episodes stand now" says so; an episode-health read that does not exist yet
carries its reason (today none of the seven has a finished read); chapters,
the health headline, drivers, and recommendations are model-written and
labelled; unconfirmed episode tags are not included; the E5 live-reporting
break is named wherever it touches a number.

## 8. Deliberately not doing

No MCP server or API keys (a static file is the most portable interface an
agent has); no per-agent formats (one Markdown, one JSON); no inlined
transcripts (linked, 1 MB total); no model-written show summary in the brief
(the health headline and drivers already are, and are labelled); no
per-comment lists beyond featured quotes and counts.

## 9. Risks

- **Chapter hallucination** — mitigated by verbatim-quote grounding and
  strict timestamp existence; a chapter that fails grounding is dropped and
  the episode is marked "chapters incomplete".
- **Brief drift from the page** — the census plus the number re-derivation
  make silent drift a build failure.
- **Size creep as episodes accrue** — per-episode weight is 7–10 KB, so the
  70 KB line arrives around the tenth episode: from then, episodes older
  than the last eight collapse to their table row, links, and chapter titles
  (the full section stays in `agent.json`). The rule ships now, dormant.

## 10. Audit record (2026-09-01, evening — three passes before the build)

**Fact-check vs code** (17 rows: 5 confirmed, 7 partial, 5 refuted/overstated).
Refuted and fixed: the latest-episode card does not render pace/launch (they
live in the panel); the carousel shows the chip OR the launch word; the outlook
renders on the health strip, not the trend card; `cumulativeAllEpisodes` is
Slack-only; two transcript formats, not one; snapshot and moment counts are
ranges; the §7 counts were wrong (feedback 3/6/1, no partial X plays today, no
finished episode-health read) — §7 is now rules; "E5's first-week views" and
"kept viewers longest live" were unanswerable — questions re-pinned and
per-episode live depth shipped; X links are broadcast replays — announce URLs
added from the registry; the skill file is static. Wiring for check 7 and
the chapters conventions specified as the reviewer laid out.

**Gaps** (18 findings: 6 high). Folded: chapter deep links only on the
upload clock (HIGH 1); three clocks stated and §3 stamped as of the read
(HIGH 2); `health.facts[]` projected so fact ids are citable (HIGH 3);
`KNOWN_BREAKS` for the E5 live-reporting change (HIGH 4); census and words
and page checks are drift, numbers/grounding/links/size fail (HIGH 5); exam
questions pinned to paths, live depth per episode (HIGH 6); "compared how"
and covers/leavesOut instead of the banned words (7); five ranked only (8);
`{value: null, reason}` absences (9); grounding over the shared parser with
spacing and end-margin rules (10); no "typical first-week curve" (11); size
caps (12); slug-keyed store with superseded (13); the Agents view kept as a
page mode with the retired-tab markers avoided and the directive recorded
(14 — owner's explicit ask); path grammar and the missing-path list (15);
feedback counts with people (16); rules not counts (17); totals from
`latest.totalViews`, freshness table, static skill (18).

**Implementability** (guesses resolved): in-memory `computeAll` object is the
input for both build and validator; skill static; deeper links only to
served files (`.vercelignore` hides `data/`, `tools/`, `scripts/`); ranked
= `rank != null`; one number formatter; fixed headings; chain step copied
from `moment-summaries` with `freshnessKey: null`; `transcripts.mjs` wraps
the existing two-format parser (no second definition); Restream-clock deep
links dropped; `[hidden]` section after About; `chart.resize()` on return;
About paragraph inside the one template literal; block `1w` between 1v and
1x with the tier words in messages; census path grammar fixed; artifacts
byte-compared with the pinned `now`; no `Date.now`/locale in the writer;
sorted iteration; one commit for W42–W45; chapters seeded from the laptop
(the chain machine pulls first, keeps its own copy on any conflict); budget
raised to 100 KB fail.

## Status log

- 2026-09-02 00:47Z — shipped: `agent-brief.mjs` (pure; census with `COVERS`
  bundles and `LEAVES_OUT`), `chapters.mjs` (ten grounded chapters for all
  seven episodes; ~2 min per transcript; output budget 24,000 tokens because
  the model reasons before it writes), `transcripts.mjs` over the shared
  two-format parser with the clock detected from the header, the Agents view
  and header link, panel chapters, live depth per episode, announce URLs,
  `KNOWN_BREAKS`, projected health facts, validator block 1w (87 drift-tier
  checks after the split), fixtures, docs. `agent.md` 70 KB, `agent.json`
  108 KB, served with `text/markdown` / `application/json`.
- **Agent exam (acceptance 1), first live run:** a fresh-context agent given
  only the one-line prompt answered all twelve questions correctly against
  `data.json` (score 49 near usual; audience quality and reach fragile;
  `rebuild-announce-to-play`; E7 promo-driven with the doubling reason; E5
  soft at 1,127 with "partial history"; E6 at 10.2 minutes per viewer; the
  third chapter at 00:20:39; typical 1,751; E7's read pending until
  2026-09-17; the curve in `data.json`; 1,189–1,830; 2026-09-01). It also
  reported six defects, all fixed the same hour: enjoyed themes printed as
  "[object Object]"; the read's episode title truncated; the direction table
  and cool-off in section 3 came from the build, not the read (section 3 now
  carries the read's own lens and says so; the build-time lens moved to
  section 7); goodwill's absolute-scale score had no explanation (now says
  so, with the people behind it); `agent.json` launch words needed a label;
  and the honesty gap below.
- **health-v5** (same hour): the exam noted "people who watched live" was
  scored against six peers although E1–E4 sit before the Restream reporting
  break. `comparableAcrossBreaks()` now restricts peers and direction points
  for the two touched measures to the newest side of every known break;
  with two comparable episodes they read "fewer than three episodes since
  the live-reporting change" — absent, not caveated. Live turnout moved to
  healthy (56) and participation to fragile (41) as a result; the day's v4
  read (49) is kept under `superseded`.
- 2026-09-02 01:06Z — the chain machine's daily job ran the full chain with the
  chapters step and the brief artifacts (92 s): five actions regenerated
  against the v5 read, publish parity confirmed on `data.json` and
  `agent.json`. Soft size line raised to 80 KB (71 KB shipped).
