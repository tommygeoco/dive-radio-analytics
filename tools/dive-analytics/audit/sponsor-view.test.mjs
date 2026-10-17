#!/usr/bin/env node
// sponsor-view.test.mjs — fixtures for the sponsor page's three new pieces
// (2026-10-11): the clock check that decides which timestamps link into a
// YouTube upload (clock.mjs), the call-in import from the published episode
// notes (contributors-import.mjs), and the sponsor projection's honesty rules
// (sponsor-view.mjs). Pure: no network, no stores, no clock.

import assert from "node:assert/strict";
import { captionWords, clockOffset, clockHolds, linkableUpload, momentUrl, CLOCK_MIN_ANCHORS, CLOCK_MAX_SPREAD } from "../clock.mjs";
import { parseCallIn, parseEpisodeNotes, contributorEpisodes } from "../../../scripts/restream/contributors-import.mjs";
import { sponsorView, quoteText, excerptAt, brandPattern, cleanSpeech, typographic, callerIndex, calledIn, quoteUrl, teamsNamed, liveAt, reviewersOf, BRAND_MIN_MENTIONS, EXAMPLES,
  featuredCallIns, featuredQuotes, FEATURED_CALLINS, FEATURED_CALLINS_MAX, FEATURED_QUOTES, FEATURED_QUOTES_MAX, exampleSegment, EXAMPLE_WINDOW_SEC,
  featuredCovers, FEATURED_COVERS, FEATURED_COVERS_MAX,
  toolCallIns, FEATURED_TOOL_CALLINS, FEATURED_TOOL_CALLINS_MAX } from "../sponsor-view.mjs";
import { normalize } from "../transcripts.mjs";

// --- clock.mjs ----------------------------------------------------------------------
{
  const json3 = { events: [{ tStartMs: 10000, segs: [{ utf8: "Hello" }, { utf8: " there", tOffsetMs: 400 }] }, { tStartMs: 12000 }] };
  assert.deepEqual(captionWords(json3), [{ word: "hello", sec: 10 }, { word: "there", sec: 10.4 }], "caption words carry their own times; events without words are skipped");

  // a transcript whose every segment opens with a distinct six-word phrase,
  // and captions that say the same words 3 seconds later
  const words = Array.from({ length: 900 }, (_, i) => `w${i}`);
  const segments = Array.from({ length: 150 }, (_, k) => ({ seconds: k * 10, text: words.slice(k * 6, k * 6 + 6).join(" ") }));
  const captions = words.map((word, i) => ({ word, sec: Math.floor(i / 6) * 10 + 3 }));
  const found = clockOffset(segments, captions);
  assert.equal(found.anchors, 150);
  assert.equal(found.offsetSec, 3, "the median difference is the offset");
  assert.equal(found.spreadSec, 0);
  assert.equal(clockOffset(segments, []), null, "nothing matched is no reading, never an offset of 0");
  // a phrase said twice pins nothing
  const twice = clockOffset([{ seconds: 0, text: "a b c d e f" }, { seconds: 50, text: "a b c d e f" }], [..."abcdef"].map((w, i) => ({ word: w, sec: i })));
  assert.equal(twice, null, "a phrase that is not unique in the transcript is not an anchor");

  const ready = (over = {}) => ({ state: "ready", videoId: "AAA", transcriptSha256: "sha", anchors: CLOCK_MIN_ANCHORS, offsetSec: -1.4, spreadSec: CLOCK_MAX_SPREAD, ...over });
  assert.equal(clockHolds(ready()), true);
  assert.equal(clockHolds(ready({ anchors: CLOCK_MIN_ANCHORS - 1 })), false, "too few phrases");
  assert.equal(clockHolds(ready({ spreadSec: CLOCK_MAX_SPREAD + 0.1 })), false, "one offset must hold for the whole episode");
  assert.equal(clockHolds(ready({ state: "pending" })), false);

  const episode = { slug: "e", links: { "yt:joindiveclub": "https://youtube.com/watch?v=AAA", "yt:designertom": "https://youtube.com/watch?v=BBB" } };
  const stream = { clock: "stream", sha256: "sha", youtubeUrl: "https://youtube.com/watch?v=AAA" };
  const checks = (uploads) => ({ entries: { e: { uploads } } });
  assert.deepEqual(linkableUpload(episode, stream, checks({ "yt:joindiveclub": ready(), "yt:designertom": ready({ videoId: "BBB", offsetSec: 0.6 }) })),
    { key: "yt:joindiveclub", url: "https://youtube.com/watch?v=AAA", offsetSec: -1.4 }, "the show's home channel first");
  assert.deepEqual(linkableUpload(episode, stream, checks({ "yt:joindiveclub": ready({ transcriptSha256: "old" }), "yt:designertom": ready({ videoId: "BBB", offsetSec: 0.6 }) })),
    { key: "yt:designertom", url: "https://youtube.com/watch?v=BBB", offsetSec: 0.6 }, "a check of an older transcript does not count");
  assert.equal(linkableUpload(episode, stream, checks({ "yt:joindiveclub": ready({ videoId: "ZZZ" }) })), null, "a check of another upload does not count");
  assert.equal(linkableUpload(episode, stream, null), null, "a live-recording transcript with no check links nowhere");
  const captionsOf = { clock: "upload", sha256: "x", youtubeUrl: "https://youtube.com/watch?v=BBB" };
  assert.deepEqual(linkableUpload(episode, captionsOf, null), { key: "yt:designertom", url: "https://youtube.com/watch?v=BBB", offsetSec: 0 }, "a caption transcript is its own upload's clock");
  assert.equal(momentUrl({ url: "https://youtube.com/watch?v=AAA", offsetSec: -1.4 }, 100), "https://youtube.com/watch?v=AAA&t=99s");
  assert.equal(momentUrl({ url: "https://youtube.com/watch?v=AAA", offsetSec: -5.4 }, 2), "https://youtube.com/watch?v=AAA&t=0s", "never before the start");
  assert.equal(momentUrl(null, 100), null);
}

// --- contributors-import.mjs ------------------------------------------------------------
{
  assert.deepEqual(parseCallIn("Jared Tredly: what Shopify looks for in the first five seconds"), { kind: "submission", who: "Jared Tredly", about: "what Shopify looks for in the first five seconds" });
  assert.deepEqual(parseCallIn("Laura Escobar's nomination of Jonas"), { kind: "nomination", who: "Laura Escobar", nominee: "Jonas" });
  assert.deepEqual(parseCallIn("Brett"), { kind: "submission", who: "Brett", about: null });
  const notes = [
    "---", "episode: 9", "air_date: 2026-09-10", "---", "",
    "Prose that mentions 🎥 SUBMISSION is not a call-in.",
    "🎥 **SUBMISSION** · [Laura Escobar's nomination of Jonas](https://example.com/a.mp4)",
    "🎥 **SUBMISSION** · [Conor Muirhead: how Linear hires product-leaning designers](https://example.com/b.mp4)",
    "**Didn't make the show, still worth a look**",
    "🎥 **SUBMISSION** · [Danny Martinez: a clip that did not air](https://example.com/c.mp4)",
    "## Accuracy audit", "🎥 **SUBMISSION** · [Nobody: audit lines never count](https://example.com/d.mp4)",
  ].join("\n");
  const parsed = parseEpisodeNotes(notes);
  assert.equal(parsed.episode, 9);
  assert.equal(parsed.airDate, "2026-09-10");
  assert.deepEqual(parsed.callIns.map((c) => c.who), ["Laura Escobar", "Conor Muirhead"], "only what aired, above “Didn't make the show”");
  assert.ok(!JSON.stringify(parsed).includes("example.com"), "links are never stored");
  // a portfolio the community sent in counts once a named designer reviewed it on air; one only shown, or not reached, does not
  const reviewed = parseEpisodeNotes([
    "---", "episode: 14", "air_date: 2026-10-15", "---", "",
    "🌐 Site · [Pablo Stanley's portfolio: a world to explore](https://example.com/p)",
    "🌐 Site · [Inflight: the free portfolio review widget](https://example.com/i)",
    "🌐 Site · [Kartik Iyer's portfolio, reviewed by Geoff Teehan](https://example.com/k)",
    "🌐 Site · [Pooja Jadav’s portfolio, reviewed by Maheen Sohail and Rob Hope](https://example.com/j)",
    "🌐 Site · [James’ portfolio, reviewed by Femke](https://example.com/s)",
    "**Didn't make the show, still worth a look**",
    "🌐 Site · [Furkan Durgun's portfolio, reviewed by Nobody](https://example.com/f)",
  ].join("\n"));
  assert.deepEqual(reviewed.callIns, [
    { kind: "portfolio", who: "Kartik Iyer", reviewedBy: "Geoff Teehan" },
    { kind: "portfolio", who: "Pooja Jadav", reviewedBy: "Maheen Sohail and Rob Hope" },
    { kind: "portfolio", who: "James", reviewedBy: "Femke" },
  ], "reviewed on air, above “Didn't make the show”: who sent it and who reviewed it, no link");

  const registry = { shows: [
    { slug: "2026-07-15-jason-yuan-designing", date: "2026-07-15", title: "Jason Yuan - Designing" },
    ...Array.from({ length: 9 }, (_, i) => ({ slug: `ep-${i + 1}-dive-radio`, date: `2026-09-${String(2 + i).padStart(2, "0")}`, title: `Dive Radio: ${i + 1}` })),
  ] };
  registry.shows[9].date = "2026-09-10";
  const one = contributorEpisodes({ registry, notes: [{ name: "e9-episode-notes-2026-09-10.md", text: notes }, { name: "e3-episode-notes-2026-09-04.md", text: "---\nepisode: 3\nair_date: 2026-09-04\n---\nno call-ins listed" }], today: "2026-10-11" });
  assert.deepEqual(Object.keys(one), ["ep-9-dive-radio"], "notes with no sent-in video leave the episode absent, never zero");
  assert.equal(one["ep-9-dive-radio"].ep, 9);
  assert.throws(() => contributorEpisodes({ registry, notes: [{ name: "e9-episode-notes-2026-09-10.md", text: notes.replace("2026-09-10", "2026-09-11") }], today: "2026-10-11" }), /aired 2026-09-10 in the registry/, "a date that disagrees with the registry stops the import");
  assert.throws(() => contributorEpisodes({ registry, notes: [{ name: "e8-episode-notes-2026-09-10.md", text: notes }], today: "2026-10-11" }), /file says E8/);
}

// --- sponsor-view.mjs ---------------------------------------------------------------------
{
  assert.equal(quoteText("@designertom @ridd_design This was a fun episode, Ridd! https://t.co/abc"), "This was a fun episode, Ridd!", "addressees and an attached link go; the words stay");
  assert.equal(quoteText("Loving this edit!!"), "Loving this edit!!");
  assert.equal(quoteText("Such an insightful session! Thank you for creating this community!@designertom @ridd_design https://t.co/x"), "Such an insightful session! Thank you for creating this community!",
    "addressees after the last sentence go too, with the attached link");
  assert.equal(quoteText("Huge thanks to @ridd_design"), "Huge thanks to @ridd_design", "a mention inside the sentence is its own word and stays");
  assert.equal(quoteText("Great show. Thanks @designertom and @ridd_design"), "Great show. Thanks @designertom and @ridd_design", "only a run of mentions after a closing mark is addressees");
  const re = brandPattern("Paper");
  assert.equal("we use Paper daily".match(re)?.length, 1);
  assert.equal("a paper cut, Papers chillin', @Paper".match(re), null, "case-sensitive whole words: the tool, not the word, not a handle");

  // thirteen synthetic episodes
  const seg = (stamp, seconds, text) => ({ stamp, seconds, speaker: null, text });
  const transcripts = {};
  const eps = Array.from({ length: 13 }, (_, i) => {
    const ep = i + 1, slug = `e${ep}`;
    transcripts[slug] = {
      clock: "stream", sha256: `sha${ep}`, youtubeUrl: `https://youtube.com/watch?v=V${ep}`,
      segments: [
        seg("00:00:10", 10, "Welcome back to the show, everybody, good to see you all here today."),
        seg("00:05:00", 300, ep === 6 ? "Not sponsored by Celsius, but we are sponsored by Notion and Paper." : "We talked about Figma and Figma again, and a paper napkin."),
        seg("00:05:20", 320, ep === 7 ? "That's not sponsored by Paper, just a tool I like." : "Then the next segment started right after the break."),
        seg("00:40:00", 2400, ep === 5 ? "One up weekly, brought to you by Lovable." : "Thanks for watching."),
      ],
    };
    return {
      ep, slug, show: "dive-radio", title: `Dive Radio: Episode ${ep}`, premiere: `2026-07-${String(ep + 10).padStart(2, "0")}`,
      links: { "yt:joindiveclub": `https://youtube.com/watch?v=V${ep}` },
      latest: { ytTotal: 1000 * ep, xPlays: 100, totalViews: 1000 * ep + 100, xImpressions: 500 },
      watch: { minutesWatched: 600 },
      live: { peak: 50 + ep, avg: 40 + ep, liveViews: 400 + ep * 10, watchedMin: 3000, chatMessages: 100, chatters: 30, durationMin: 120, holdRate: 60 + ep, byChannel: [] },
      audience: { list: ep === 9 ? [
        { id: "x:1", source: "x", author: "@robhope", text: "i smiled and chuckled so much during this one, thanks guys!", platform: "X", url: "https://x.com/i/status/1", likes: 2, sentiment: "positive", at: "2026-09-11T00:00:00Z" },
        { id: "x:2", source: "x", author: "@robhope", text: "Another one from the same person, loved it again.", platform: "X", url: "https://x.com/i/status/2", likes: 1, sentiment: "positive", at: "2026-09-11T01:00:00Z" },
        { id: "yt:3", source: "yt", author: "Someone", text: "Could you add links to the description?", platform: "YouTube", url: null, likes: 5, sentiment: "positive", at: "2026-09-11T02:00:00Z" },
        { id: "chat:4", source: "live-chat", author: "Person 9", text: "This live chat message is anonymous and long enough.", platform: "YouTube", url: null, likes: null, sentiment: "positive", at: "2026-09-10T20:00:00Z" },
        { id: "yt:5", source: "yt", author: "Critic", text: "The audio was terrible this week, honestly.", platform: "YouTube", url: null, likes: 9, sentiment: "negative", at: "2026-09-11T03:00:00Z" },
      ] : [] },
      chapters: { list: ep === 5 ? [{ start: "00:39:50", seconds: 2390, title: "One Up Weekly", gist: "Picks of the week, presented by Lovable." }] : [] },
    };
  });
  const channelStats = { current: {
    "yt:designertom": { date: "2026-10-11", subscribers: 170000, reading: { state: "ready" } },
    "yt:joindiveclub": { date: "2026-10-11", subscribers: 68800, reading: { state: "ready" } },
    "x:ridd_design": { date: "2026-10-11", followers: 76565, reading: { state: "ready" } },
    "x:designertom": { date: "2026-10-11", followers: 19776, reading: { state: "ready" } },
  } };
  const contributors = { updatedAt: "2026-10-11T00:00:00Z", episodes: { e9: { callIns: [{ kind: "submission", who: "A", about: "b" }, { kind: "nomination", who: "C", nominee: "D" }, { kind: "portfolio", who: "E", reviewedBy: "F" }] }, "not-aired": { callIns: [{ kind: "submission", who: "X" }] } } };
  const view = sponsorView({ episodes: eps, channelStats, contributors, clockChecks: null, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });

  assert.equal(view.asOf, "2026-10-11", "the Phoenix date of the build");
  assert.equal(view.views.total, eps.reduce((a, e) => a + e.latest.totalViews, 0));
  assert.equal(view.views.perEpisode, Math.round(view.views.total / 13));
  assert.equal(view.views.xReach, 13 * 500, "reach is kept apart, never in views");
  const missing = sponsorView({ episodes: eps.map((e, i) => (i === 12 ? { ...e, latest: { ...e.latest, ytTotal: null, totalViews: null } } : e)), transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(missing.views.total, null, "one missing reading never passes for a smaller show");
  assert.ok(missing.views.reason);

  assert.equal(view.watch.hours, Math.round((13 * 600) / 60));
  const t = view.live.typical;
  assert.deepEqual([t.fromEp, t.toEp, t.shows], [5, 12, 8], "a typical show is the middle of the eight before the newest");
  assert.equal(t.peak, (50 + 8 + 50 + 9) / 2, "an even window's middle is the mean of its two middle values");
  assert.equal(t.people, (400 + 80 + 400 + 90) / 2);
  assert.equal(view.live.best.peak.ep, 13);
  assert.equal(view.live.chat, 1300, "chat totals add up across shows");
  assert.equal(view.live.xFromEp, 5, "shows before the X reporting break sit in the totals, so the page names where X starts");
  assert.equal(view.live.linkedInShows, 0, "no session row says LinkedIn, so no show is counted as going there");
  const viaLinkedIn = sponsorView({ episodes: eps.map((e) => (e.ep % 2 ? { ...e, live: { ...e.live, byChannel: [{ label: "YT Dive Club", peak: 10 }, { label: "LinkedIn", chatters: 0 }] } } : e)), transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(viaLinkedIn.live.linkedInShows, 7, "a LinkedIn row, even one reporting only a zero, says the show went there");
  assert.equal(sponsorView({ episodes: eps.filter((e) => e.ep >= 5), transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" }).live.xFromEp, null, "with every show after the break, nothing needs saying");
  const thin = sponsorView({ episodes: eps.slice(0, 3), transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(thin.live.typical.peak, null, "fewer than three shows before the newest is no typical, never a guess");
  // a window across the live-reporting break (E5): every figure built on live viewers reads only the newest's
  // side of it, even when an earlier show stands out; chat and the show's length compare across
  const across = sponsorView({ episodes: eps.slice(0, 9).map((e) => (e.ep === 2 ? { ...e, live: { ...e.live, peak: 500, liveViews: 9000 } } : e)), transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  const a = across.live.typical;
  assert.deepEqual([a.fromEp, a.toEp, a.shows], [1, 8, 8], "the window is still the eight shows before the newest");
  assert.equal(a.peak, (56 + 57) / 2, "the peak's middle is E5–E8's: E1–E4 counted YouTube's viewers alone");
  assert.equal(a.average, (46 + 47) / 2);
  assert.equal(a.people, (460 + 470) / 2);
  assert.equal(a.holdRate, (66 + 67) / 2);
  assert.equal(a.durationMin, 120, "a show's length is no viewer count: all eight");
  assert.deepEqual(across.live.best.peak, { value: 59, ep: 9, since: 5 }, "the record runs from the break and says so");
  assert.deepEqual(across.live.best.people, { value: 490, ep: 9, since: 5 });
  assert.deepEqual(sponsorView({ episodes: eps.filter((e) => e.ep >= 5), transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" }).live.best.peak, { value: 63, ep: 13, since: null }, "with every show after the break, the record runs from the first");

  assert.equal(view.audience.total, 170000 + 68800 + 76565 + 19776);
  const gap = sponsorView({ episodes: eps, channelStats: { current: { ...channelStats.current, "x:designertom": { date: "2026-10-11", followers: null, reading: { state: "failed" } } } }, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(gap.audience.total, null, "a missing channel leaves the total absent");
  assert.ok(gap.audience.reason);

  assert.deepEqual(view.feedback.quotes.map((q) => q.id), ["x:1"], "named public praise only: no questions, no anonymous chat, no negatives, one per person");
  assert.equal(view.feedback.positive, 4);

  assert.equal(view.callIns.total, 3, "a store entry for an episode that has not aired is ignored");
  assert.equal(view.callIns.nominations, 1);
  assert.equal(view.callIns.portfolios, 1, "a portfolio reviewed on air is a call-in of its own kind");
  assert.equal(view.callIns.people, 3, "the person who sent a portfolio counts; its reviewer does not");
  assert.deepEqual(view.callIns.reviews, [{ ep: 9, slug: "e9", portfolios: 1, reviewers: ["F"] }], "an episode's portfolio reviews are one fact: how many, and by whom");
  assert.deepEqual(reviewersOf([
    { kind: "portfolio", ep: 14, who: "A", reviewedBy: "Maheen Sohail and Rob Hope" },
    { kind: "portfolio", ep: 14, who: "B", reviewedBy: "Geoff Teehan, Josh Puckett, and Femke" },
    { kind: "portfolio", ep: 14, who: "C", reviewedBy: "Rob Hope" },
    { kind: "submission", ep: 14, who: "D", about: "reviewed by nobody" },
  ]).map((r) => r.who), ["Maheen Sohail", "Rob Hope", "Geoff Teehan", "Josh Puckett", "Femke"], "each reviewer once, in the order the notes name them");
  assert.equal(sponsorView({ episodes: eps, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" }).callIns.total, null);

  const figma = view.brands.list.find((b) => b.name === "Figma");
  assert.equal(figma.mentions, 2 * 12, "every whole-word mention, in every episode that says it");
  assert.equal(figma.episodes, 12);
  assert.ok(!view.brands.list.some((b) => b.mentions < BRAND_MIN_MENTIONS));
  for (const b of view.brands.list) for (const m of b.moments) {
    const flat = (x) => normalize(x).replace(/'/g, "").replace(/\s+/g, " ").trim();
    assert.ok(flat(cleanSpeech(transcripts[m.slug].segments.map((s) => s.text).join(" "))).includes(flat(m.text.replace(/…/g, " "))), `${b.name} E${m.ep} excerpt is the transcript's words`);
    assert.equal(m.url, null, "no clock check, no link");
  }

  const notion = view.partners.find((p) => p.name === "Notion");
  assert.deepEqual(notion.moments.map((m) => [m.ep, m.kind]), [[6, "named"]], "named in a sponsor line — named as a partner, never called a paid read");
  assert.equal(notion.named, 1);
  const paper = view.partners.find((p) => p.name === "Paper");
  assert.deepEqual(paper.moments.map((m) => m.ep), [6], "“not sponsored by Paper” is not a read");
  const lovable = view.partners.find((p) => p.name === "Lovable");
  assert.deepEqual(lovable.moments.map((m) => [m.ep, m.kind]), [[5, "inSegment"]], "a naming inside the first minute of a chapter that names the partner is that chapter; a chapter whose title does not name it is named in, not about it");
  assert.deepEqual([lovable.segments, lovable.about], [1, 0]);
  const titled = sponsorView({ episodes: eps.map((e) => (e.ep === 5 ? { ...e, chapters: { list: [{ start: "00:39:50", seconds: 2390, title: "One Up Weekly by Lovable", gist: "Picks of the week." }] } } : e)), transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  const titledLovable = titled.partners.find((p) => p.name === "Lovable");
  assert.deepEqual([titledLovable.moments[0].kind, titledLovable.segments, titledLovable.about], ["segment", 1, 1], "a segment whose title names the partner is about it");

  // a long speaker segment is cut to whole words around the name, verbatim
  const long = Array.from({ length: 80 }, (_, i) => (i === 40 ? "Mobbin" : `word${i}`)).join(" ");
  const x = excerptAt([{ stamp: "00:01:00", seconds: 60, text: long }], 0, brandPattern("Mobbin"));
  assert.ok(x.text.includes("Mobbin") && x.text.startsWith("…") && x.text.endsWith("…") && x.text.length <= 222);
  assert.equal(x.complete, false);

  // speech as it reads: marks, fillers and a doubled word go; the words stay in order
  assert.equal(cleanSpeech(">> Uh Remotion is, um, really really good. And I I do wanna say [Music] let's let's go."), "Remotion is, really good. And I do wanna say let's go.");
  assert.equal(cleanSpeech("which I think is a is a very proper sponsor, and I saw I saw it"), "which I think is a very proper sponsor, and I saw it", "a pair of words said twice goes too");
  assert.equal(cleanSpeech("an umbrella, a hummingbird"), "an umbrella, a hummingbird", "a filler is a whole word, never part of one");
  assert.equal(typographic(`it's "great" 'here'`), "it’s ‘great’ ‘here’", "inside the page's “ ” a quotation takes ‘ ’");
  // whole sentences: a caption fragment run is read back to its sentence start; a cut says so with "…"
  const caps = [
    { stamp: "00:40:50", seconds: 2450, speaker: null, text: "so that's the news. >> Um" },
    { stamp: "00:40:52", seconds: 2452, speaker: null, text: ">> Um speaking of notion, one of our" },
    { stamp: "00:41:00", seconds: 2460, speaker: null, text: "partners, Notion, we appreciate you. They recently" },
    { stamp: "00:41:02", seconds: 2462, speaker: null, text: "announced a thing and it is good." },
  ];
  const y = excerptAt(caps, 2, brandPattern("Notion"));
  assert.equal(y.at, "00:40:52", "the excerpt starts where the sentence does (a caption >> starts one)");
  assert.equal(y.text, "Speaking of notion, one of our partners, Notion, we appreciate you. They recently announced a thing and it is good.", "a short sentence takes the next one; the filler and the mark go");
  assert.equal(y.complete, true);
  const turn = [
    { stamp: "00:00:01", seconds: 1, speaker: "S2", text: "Something else entirely." },
    { stamp: "00:00:40", seconds: 40, speaker: "S1", text: "we had been talking about it and" },
    { stamp: "00:00:45", seconds: 45, speaker: "S1", text: "then Figma said it would ship" },
  ];
  assert.equal(excerptAt(turn, 2, brandPattern("Figma")).text, "We had been talking about it and then Figma said it would ship…", "a new speaker starts a sentence; an unfinished one closes with …");
  const turnNext = [
    { stamp: "00:17:04", seconds: 1024, speaker: "S3", text: "We will announce the winners at the end of the show." },
    { stamp: "00:17:10", seconds: 1030, speaker: "S3", text: "Thank you for Notion for sponsoring this segment." },
    { stamp: "00:17:15", seconds: 1035, speaker: "S3", text: "On that note, you said something there a second ago." },
  ];
  assert.equal(excerptAt(turnNext, 1, brandPattern("Notion")).text, "We will announce the winners at the end of the show. Thank you for Notion for sponsoring this segment.", "a sentence that turns to the next topic is not taken in; the one before is");
  const mid = [{ stamp: "00:00:01", seconds: 1, speaker: "S1", text: "I kept going on about the" }, { stamp: "00:00:40", seconds: 40, speaker: "S1", text: "thing and then Figma said it would ship." }];
  assert.equal(excerptAt(mid, 1, brandPattern("Figma")).text, "…thing and then Figma said it would ship.", "a line that continues a sentence from beyond the reach opens with …");

  // the newest show's curve is its stored session; the series may never reach the stored peak (no minute then)
  const lived = eps.map((e) => ({ ...e, ageDays: 140 - e.ep * 7, live: { ...e.live, series: Array.from({ length: 121 }, (_, m) => ({ m, v: m === 60 ? e.live.peak : 10 + (m % 7) })) }, watch: { ...e.watch, curve: [{ at: 0.49, watching: 0.2 }, { at: 0.5, watching: 0.1 + e.ep / 100 }] } }));
  lived[12] = { ...lived[12], live: { ...lived[12].live, peak: 999 } };
  const v2 = sponsorView({ episodes: lived, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(v2.live.latest.ep, 13);
  assert.equal(v2.live.latest.peak, 999, "the stored peak, as stored");
  assert.equal(v2.live.latest.peakMinute, null, "a series that never reaches the stored peak has no peak minute, never a guessed one");
  assert.equal(v2.live.latest.durationMin, 120, "the stored length, never the series length");
  assert.equal(v2.live.typical.atMiddle, (50 + 8 + 50 + 9) / 2, "the middle minute (60 of 120) of each show in the window, its middle value");
  assert.equal(v2.live.typical.recordingAtMiddle, (18 + 19) / 2 / 1, "of every 100 YouTube views, still watching at the recording's middle");
  assert.equal(liveAt(lived[4], { clock: "stream" }, 3601), lived[4].live.series[60].v, "a stream-clock moment reads its own minute");
  assert.equal(liveAt(lived[4], { clock: "upload" }, 3601), null, "an upload-clock transcript has no live minute");

  // quotes: originals linked; people on the show rank last and say so
  assert.equal(quoteUrl({ source: "yt", id: "yt:Ugx1" }, { links: { "yt:designertom": "https://youtube.com/watch?v=BBB" } }, { "yt:Ugx1": "yt:designertom" }), "https://youtube.com/watch?v=BBB&lc=Ugx1");
  assert.equal(quoteUrl({ source: "yt", id: "yt:Ugx1" }, { links: {} }, {}), null, "a comment whose upload is unknown has no link, never a guessed one");
  const callers = callerIndex([{ ep: 9, who: "Genny Dee" }, { ep: 9, who: "Dan Tase" }, { ep: 8, who: "Charles Patterson" }, { ep: 5, who: "Nad" }]);
  assert.equal(calledIn("@gennydee", callers)?.ep, 9);
  assert.equal(calledIn("@tasedan", callers)?.ep, 9, "either order");
  assert.equal(calledIn("@CharlesPattson", callers)?.ep, 8, "first name and the surname's first four letters");
  assert.equal(calledIn("@nadia", callers), null, "a one-word name never matches");
  const guests = eps.map((e) => (e.ep === 9 ? { ...e, audience: { list: [
    { id: "x:7", source: "x", author: "@gennydee", text: "This was fun and in good company, thanks all!", platform: "X", url: "https://x.com/i/status/7", likes: 13, sentiment: "positive", at: "2026-09-11T00:00:00Z" },
    { id: "x:8", source: "x", author: "@jess", text: "Loving this edit!! Thanks for including me Tommy.", platform: "X", url: "https://x.com/i/status/8", likes: 9, sentiment: "positive", at: "2026-09-11T00:00:00Z" },
    { id: "x:9", source: "x", author: "@viewer", text: "Best show so far, watched it twice already.", platform: "X", url: "https://x.com/i/status/9", likes: 1, sentiment: "positive", at: "2026-09-11T00:00:00Z" },
  ] } } : e));
  const g = sponsorView({ episodes: guests, contributors: { episodes: { e9: { callIns: [{ kind: "submission", who: "Genny Dee", about: "a job at Railway" }] } } }, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.deepEqual(g.feedback.quotes.map((q) => [q.author, q.onShow, q.calledIn]), [["@viewer", false, null], ["@gennydee", true, 9], ["@jess", true, null]], "the audience first; a call-in or someone who says they were on the show after, marked");
  // a designer who reviewed a portfolio on air was on the show: their quote ranks after the audience's, marked, never "called in"
  const reviewer = eps.map((e) => (e.ep === 6 ? { ...e, audience: { list: [
    { id: "x:10", source: "x", author: "@robhope", text: "i smiled and chuckled so much during this one, thanks guys!", platform: "X", url: "https://x.com/i/status/10", likes: 40, sentiment: "positive", at: "2026-08-21T00:00:00Z" },
    { id: "x:11", source: "x", author: "@viewer", text: "Best show so far, watched it twice already.", platform: "X", url: "https://x.com/i/status/11", likes: 1, sentiment: "positive", at: "2026-08-21T00:00:00Z" },
  ] } } : e));
  const r = sponsorView({ episodes: reviewer, contributors: { episodes: { e13: { callIns: [{ kind: "portfolio", who: "Pooja Jadav", reviewedBy: "Maheen Sohail and Rob Hope" }] } } }, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.deepEqual(r.feedback.quotes.map((q) => [q.author, q.onShow, q.calledIn]), [["@viewer", false, null], ["@robhope", true, null]], "a reviewer's quote, however liked, comes after the audience's and says “on the show”");

  // the teams the call-ins were about: only where their words put the work
  assert.deepEqual(teamsNamed([{ about: "building an OG card tool at Vercel" }, { about: "what Shopify looks for in five seconds" }, { about: "a map built in Lovable" }, { about: "Lovable's Series C" }, { about: "Vercel's creative team builds tools" }]), ["Vercel", "Shopify"]);

  // each package's example is found near the owners' recorded time, or absent with a reason
  assert.deepEqual(EXAMPLES.map((x) => x.package), ["Mid-roll", "Segment", "Build"]);
  const withOneUp = { ...transcripts, e5: { ...transcripts.e5, segments: [...transcripts.e5.segments, { stamp: "01:20:35", seconds: 4835, speaker: null, text: "The One Up Weekly segment, brought to you by Lovable." }] } };
  const shown = sponsorView({ episodes: eps, transcripts: withOneUp, generatedAt: "2026-10-11T14:00:00.000Z" });
  const ex = shown.examples.find((x) => x.package === "Segment");
  assert.equal(ex.moment.at, "01:20:35", "Lovable is named within the window of the recorded time");
  assert.equal(ex.moment.url, null, "no clock check, no link");
  assert.equal(view.examples.find((x) => x.package === "Segment").moment, null, "the 40-minute line is not near the recorded time");
  assert.equal(shown.examples.find((x) => x.package === "Mid-roll").moment, null);
  assert.ok(shown.examples.find((x) => x.package === "Mid-roll").reason, "a record the transcript does not bear out shows nothing, with a reason");

  // each example carries the segment it aired in (D21): the partner's own stored segment moment (a chapter whose title
  // names it) in the example's episode inside the recorded window, as stored; with none, no field at all
  const build = EXAMPLES.find((x) => x.package === "Build");
  assert.deepEqual([build.partner, build.ep], ["Notion", 5]);
  const at = (sec) => `00:${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  const before = build.near - EXAMPLE_WINDOW_SEC.before, after = build.near + EXAMPLE_WINDOW_SEC.after;
  const chaptered = eps.map((e) => (e.ep === build.ep ? { ...e, chapters: { list: [
    { start: "00:39:50", seconds: 2390, title: "One Up Weekly", gist: "Picks of the week, presented by Lovable." },
    { start: at(before - 1), seconds: before - 1, title: "Notion just before", gist: "A second before the window opens." },
    { start: at(before + 5), seconds: before + 5, title: "A Mobbin segment", gist: "Another partner's segment, inside the window." },
    { start: at(before + 10), seconds: before + 10, title: "Building live", gist: "Named in, not about it: the hosts build on Notion." },
    { start: at(build.near + 26), seconds: build.near + 26, title: "Notion as code", gist: "Tommy demos Notion as code powering show tools." },
    { start: at(after - 1), seconds: after - 1, title: "Notion, later in the window", gist: "A second segment inside the window." },
    { start: at(after + 1), seconds: after + 1, title: "Notion past the window", gist: "A second after it closes." },
  ] } } : e.ep === 6 ? { ...e, chapters: { list: [{ start: at(build.near + 26), seconds: build.near + 26, title: "Notion as code", gist: "The same time in another episode." }] } } : e));
  const withSegments = sponsorView({ episodes: chaptered, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  const notionSegment = withSegments.partners.find((p) => p.name === "Notion").moments.find((m) => m.kind === "segment" && m.ep === 5 && m.title === "Notion as code");
  const builtIn = withSegments.examples.find((x) => x.package === "Build");
  assert.deepEqual(builtIn.segment, { at: notionSegment.at, seconds: notionSegment.seconds, title: "Notion as code", text: "Tommy demos Notion as code powering show tools.", url: null },
    "the partner's first stored segment about it in the window, as stored: time, title, the chapter's description, link (none without a clock check)");
  assert.deepEqual(Object.keys(builtIn.segment), ["at", "seconds", "title", "text", "url"]);
  assert.ok(!("segment" in withSegments.examples.find((x) => x.package === "Mid-roll")), "no segment of the partner in that episode's window: no field, never null");
  assert.ok(!("segment" in withSegments.examples.find((x) => x.package === "Segment")), "a chapter that only names the partner in its description, or lies outside the window, is not the example's segment");
  assert.ok(!("segment" in view.examples.find((x) => x.package === "Build")), "no chapter about the partner, no segment");
  const untranscribed = sponsorView({ episodes: chaptered, transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" }).examples.find((x) => x.package === "Build");
  assert.equal(untranscribed.moment, null);
  assert.equal(untranscribed.segment.title, "Notion as code", "a stored chapter stands without the transcript line; its link waits for one");
  const partnersOf = (moments) => [{ name: "Notion", moments }];
  const segAt = (ep, seconds, kind = "segment") => ({ kind, ep, slug: `e${ep}`, at: at(seconds), seconds, title: `t${seconds}`, text: `d${seconds}`, url: null, liveAt: null });
  assert.equal(exampleSegment(build, partnersOf([segAt(5, before - 1), segAt(6, build.near), segAt(5, build.near, "inSegment"), segAt(5, after + 1)])), null, "outside the window, another episode, or only named in: none");
  assert.equal(exampleSegment(build, [{ name: "Mobbin", moments: [segAt(5, build.near)] }]), null, "another partner's segment is never this example's");
  assert.equal(exampleSegment(build, partnersOf([segAt(5, before), segAt(5, after)])).seconds, before, "the window's edges count; the first segment wins");
  assert.equal(exampleSegment(build, null), null);

  // the owners' featured picks (D19): stored entries in the list's order, each once, within the caps; a pick the
  // stores do not hold is dropped, never invented; a featured quote is the stored quote object, unchanged
  assert.ok(FEATURED_CALLINS.length <= FEATURED_CALLINS_MAX && new Set(FEATURED_CALLINS).size === FEATURED_CALLINS.length, "the owners' call-in picks fit the cap, each once");
  assert.ok(FEATURED_QUOTES.length <= FEATURED_QUOTES_MAX && new Set(FEATURED_QUOTES).size === FEATURED_QUOTES.length, "the owners' quote picks fit the cap, each once");
  assert.deepEqual([FEATURED_CALLINS_MAX, FEATURED_QUOTES_MAX], [6, 3]);
  const aired = [
    { ep: 4, slug: "e4", kind: "submission", who: "Josh Puckett", about: "making things for yourself" },
    { ep: 8, slug: "e8", kind: "submission", who: "Evil Rabbit", about: "Vercel's creative team builds tools" },
    { ep: 9, slug: "e9", kind: "submission", who: "Kyle Zantos", about: "the candidate side" },
    { ep: 11, slug: "e11", kind: "submission", who: "Kyle Zantos", about: "an app idea turned into wireframes" },
    { ep: 12, slug: "e12", kind: "nomination", who: "David Hoang", nominee: "Jade" },
  ];
  assert.deepEqual(featuredCallIns(aired, ["Kyle Zantos", "Nobody Aired", "Evil Rabbit", "Josh Puckett", "Evil Rabbit"]), [
    { who: "Kyle Zantos", ep: 9, slug: "e9", kind: "submission", about: "the candidate side" },
    { who: "Evil Rabbit", ep: 8, slug: "e8", kind: "submission", about: "Vercel's creative team builds tools" },
    { who: "Josh Puckett", ep: 4, slug: "e4", kind: "submission", about: "making things for yourself" },
  ], "the list's order, not the episodes'; an unknown name dropped; a repeated pick once; a name's first aired call-in; who, episode, slug, kind and its own words (D23), verbatim");
  assert.deepEqual(featuredCallIns([{ ep: 8, slug: "e8", kind: "submission", who: "Brett", about: null }, { ep: 9, slug: "e9", kind: "submission", who: "Anjali", about: "  " }], ["Brett", "Anjali"]),
    [{ who: "Brett", ep: 8, slug: "e8", kind: "submission" }, { who: "Anjali", ep: 9, slug: "e9", kind: "submission" }], "a call-in the notes give no words for carries no words field, never null or blank");
  assert.deepEqual(featuredCallIns(aired, ["David Hoang", "Evil Rabbit"]).map((c) => c.who), ["Evil Rabbit"], "a nomination of someone else is not the nominator's own call-in: the page says they called in");
  assert.deepEqual(featuredCallIns([{ ep: 10, slug: "e10", kind: "nomination", who: "Flora Guo", nominee: "Josephine" }, { ep: 11, slug: "e11", kind: "submission", who: "Flora Guo", about: "the tip of the iceberg" }, { ep: 14, slug: "e14", kind: "portfolio", who: "Kartik Iyer", reviewedBy: "Geoff Teehan" }], ["Flora Guo", "Kartik Iyer"]),
    [{ who: "Flora Guo", ep: 11, slug: "e11", kind: "submission", about: "the tip of the iceberg" }], "a name's first video, past an earlier nomination; a portfolio reviewed on air is not its sender calling in");
  assert.deepEqual(featuredCallIns(aired, ["evil rabbit", "Evil  Rabbit"]), [], "an exact name only: nothing is matched loosely");
  assert.deepEqual(featuredCallIns(null), [], "no call-in list, nothing featured");
  const many = Array.from({ length: 9 }, (_, i) => ({ ep: 4 + i, slug: `e${4 + i}`, kind: "submission", who: `Person ${i}` }));
  assert.deepEqual(featuredCallIns(many, many.map((c) => c.who)).map((c) => c.who), many.slice(0, FEATURED_CALLINS_MAX).map((c) => c.who), "the cap holds, in order");
  assert.deepEqual(featuredCallIns([...aired, { ep: 13, slug: "e13", kind: "submission", who: "Soleio" }], ["Nobody", ...many.map((c) => c.who), "Soleio"]).map((c) => c.who), ["Soleio"], "a name the list does not hold takes no place under the cap");

  const stored = [
    { id: "x:1", ep: 9, slug: "e9", author: "@viewer", platform: "X", text: "Best show so far, watched it twice already.", url: "https://x.com/i/status/1", likes: 2, onShow: false, calledIn: null },
    { id: "yt:2", ep: 9, slug: "e9", author: "someone", platform: "YouTube", text: "Time spent absolutely well, thank you both.", url: "https://youtube.com/watch?v=V9&lc=2", likes: 1, onShow: false, calledIn: null },
    { id: "x:3", ep: 10, slug: "e10", author: "@another", platform: "X", text: "I would not miss one of these for anything.", url: "https://x.com/i/status/3", likes: 1, onShow: false, calledIn: null },
    { id: "x:4", ep: 10, slug: "e10", author: "@extra", platform: "X", text: "A fourth quote, to prove the cap holds here.", url: "https://x.com/i/status/4", likes: 0, onShow: false, calledIn: null },
    { id: "x:5", ep: 9, slug: "e9", author: "@gennydee", platform: "X", text: "This was fun and in good company, thanks all!", url: "https://x.com/i/status/5", likes: 9, onShow: true, calledIn: 9 },
  ];
  const picked = featuredQuotes(stored, ["yt:2", "x:missing", "x:1", "yt:2"]);
  assert.deepEqual(picked, [stored[1], stored[0]], "verbatim, in the list's order; an unknown id dropped; a repeated id once");
  assert.notEqual(picked[0], stored[1], "a copy: the shipped quote list is never shared or changed");
  assert.deepEqual(featuredQuotes(stored, ["x:5", "x:1"]), [stored[0]], "a quote from someone on the show is never featured as the audience's");
  assert.deepEqual(featuredQuotes(stored, ["x:1", "yt:2", "x:3", "x:4"]).map((q) => q.id), ["x:1", "yt:2", "x:3"], "the cap holds, in order");
  assert.deepEqual(featuredQuotes(undefined), [], "no quotes, nothing featured");

  // D24: four names, none of the career-shaped hooks the panels read as a careers show
  assert.deepEqual([...FEATURED_CALLINS], ["Soleio", "Pietro Schirano", "Jared Erondu", "Josh Puckett"]);
  assert.ok(!FEATURED_CALLINS.includes("Eric Sin") && !FEATURED_CALLINS.includes("Alex Danilowicz"), "D24: the career-shaped hooks are not featured");
  // through the projection: the owners' own lists, read from the stores as built
  const [firstPick, secondPick] = FEATURED_CALLINS;
  const pickedView = sponsorView({ episodes: eps, contributors: { episodes: {
    e9: { callIns: [{ kind: "submission", who: secondPick, about: "a later name in the list, aired first" }] },
    e11: { callIns: [{ kind: "nomination", who: secondPick, nominee: "Someone" }, { kind: "submission", who: firstPick, about: "advice" }, { kind: "submission", who: "Not Picked", about: "x" }] },
  } }, transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.deepEqual(pickedView.callIns.featured, [{ who: firstPick, ep: 11, slug: "e11", kind: "submission", about: "advice" }, { who: secondPick, ep: 9, slug: "e9", kind: "submission", about: "a later name in the list, aired first" }], "the owners' order, the store's own entries with their words");

  // the desktop cover row (D23): stored episodes by slug, in the owners' order, each once, six at most; unknown dropped
  assert.ok(FEATURED_COVERS.length <= FEATURED_COVERS_MAX && FEATURED_COVERS_MAX === 6 && new Set(FEATURED_COVERS).size === FEATURED_COVERS.length, "the owners' cover picks fit the row (six, two of the page's twelve columns each), each once");
  assert.deepEqual(featuredCovers(eps, ["e12", "e-unknown", "e5", "e12", "e7"]), [
    { ep: 12, slug: "e12", title: "Dive Radio: Episode 12" },
    { ep: 5, slug: "e5", title: "Dive Radio: Episode 5" },
    { ep: 7, slug: "e7", title: "Dive Radio: Episode 7" },
  ], "the owners' order, not the episodes'; an unknown slug dropped; a repeat once; the stored number, slug and title only");
  assert.deepEqual(featuredCovers(eps, eps.map((e) => e.slug)).map((c) => c.ep), [1, 2, 3, 4, 5, 6], "six at most");
  assert.deepEqual(featuredCovers(eps, ["e-unknown", ...eps.slice(0, 6).map((e) => e.slug)]).length, 6, "an unknown slug takes no place in the row");
  assert.deepEqual(featuredCovers(null), [], "no episodes, no covers");
  const coverView = sponsorView({ episodes: eps.map((e, i) => ({ ...e, slug: FEATURED_COVERS[i] ?? e.slug })), transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.deepEqual(coverView.covers.map((c) => c.slug), [...FEATURED_COVERS], "through the projection: the owners' row over the stored episodes");
  assert.deepEqual(view.covers, [], "none of the picked slugs is stored in the fixture: an empty row, never an invented one");
  assert.equal(FEATURED_COVERS.at(-1), "2026-08-20-dive-radio-the-mascot-industrial-complex", "D25: E6, a titled cover, closes the row");
  assert.ok(!FEATURED_COVERS.includes("2026-07-30-dive-radio-mixed-media-workflows-game-de") && !FEATURED_COVERS.some((slug) => /portfoli/.test(slug)), "D25: no bare-wordmark cover (E3), no portfolio episode");
  // the call-ins that show the audience building with tools (D21): the same own-video rule, the stored words verbatim,
  // never a name featured above, a submission without words dropped, three at most, in the owners' order
  assert.ok(FEATURED_TOOL_CALLINS.length <= FEATURED_TOOL_CALLINS_MAX && FEATURED_TOOL_CALLINS_MAX === 3 && new Set(FEATURED_TOOL_CALLINS).size === FEATURED_TOOL_CALLINS.length);
  assert.ok(!FEATURED_TOOL_CALLINS.some((who) => FEATURED_CALLINS.includes(who)), "no name in both lists");
  const builders = [
    { ep: 8, slug: "e8", kind: "submission", who: "Nick Pattison", about: "a live map tool Primary built in Lovable for a client brand" },
    { ep: 8, slug: "e8", kind: "submission", who: "Brett", about: null },
    { ep: 9, slug: "e9", kind: "nomination", who: "Davey Heuser", nominee: "Someone" },
    { ep: 11, slug: "e11", kind: "submission", who: "Davey Heuser", about: "the codebase as the source of truth in Paper" },
    { ep: 12, slug: "e12", kind: "submission", who: "Kolbe Yang", about: "from a Figma frame to a finished animation" },
    { ep: 12, slug: "e12", kind: "submission", who: "Finn McKenty", about: "restyle real footage in Flora" },
    { ep: 13, slug: "e13", kind: "submission", who: "Eric Sin", about: "how he landed a staff design job" },
    { ep: 14, slug: "e14", kind: "portfolio", who: "Kartik Iyer", reviewedBy: "Geoff Teehan" },
  ];
  const featuredHere = featuredCallIns(builders, ["Eric Sin"]);
  assert.deepEqual(toolCallIns(builders, ["Kolbe Yang", "Nobody", "Brett", "Kartik Iyer", "Eric Sin", "Davey Heuser", "Kolbe Yang", "Nick Pattison", "Finn McKenty"], featuredHere), [
    { who: "Kolbe Yang", ep: 12, slug: "e12", kind: "submission", about: "from a Figma frame to a finished animation" },
    { who: "Davey Heuser", ep: 11, slug: "e11", kind: "submission", about: "the codebase as the source of truth in Paper" },
    { who: "Nick Pattison", ep: 8, slug: "e8", kind: "submission", about: "a live map tool Primary built in Lovable for a client brand" },
  ], "the owners' order; an unknown name, a submission without words, a portfolio and a featured name dropped; a name's first video past its nomination; the stored words verbatim; three at most");
  assert.deepEqual(toolCallIns(null), [], "no call-in list, no tool call-ins");
  const toolView = sponsorView({ episodes: eps, contributors: { episodes: {
    e9: { callIns: [{ kind: "submission", who: FEATURED_TOOL_CALLINS[2], about: "third pick's words" }, { kind: "submission", who: FEATURED_TOOL_CALLINS[1], about: "words as the notes give them" }, { kind: "submission", who: FEATURED_TOOL_CALLINS[0], about: "first pick's words" }] },
    e10: { callIns: [{ kind: "submission", who: "Nick Pattison", about: "a live map tool Primary built in Lovable for a client brand" }] },
  } }, transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.deepEqual(toolView.callIns.tools, [
    { who: FEATURED_TOOL_CALLINS[0], ep: 9, slug: "e9", kind: "submission", about: "first pick's words" },
    { who: FEATURED_TOOL_CALLINS[1], ep: 9, slug: "e9", kind: "submission", about: "words as the notes give them" },
    { who: FEATURED_TOOL_CALLINS[2], ep: 9, slug: "e9", kind: "submission", about: "third pick's words" },
  ], "through the projection: the owners' list over the stored entries; an aired call-in not on the list (D22: Nick Pattison) stays out");
  assert.ok(!FEATURED_TOOL_CALLINS.includes("Nick Pattison") && !FEATURED_TOOL_CALLINS.includes("Daniel Linthwaite"), "D22: a line a cold reader can misread, and a clip cut from an interview, are not picks");
  assert.deepEqual(view.callIns.tools, [], "none of the picks aired in the fixture");
  assert.deepEqual(sponsorView({ episodes: eps, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" }).callIns.tools, [], "no call-in list: an empty list beside the absent count's reason");
  const nominatedOnly = sponsorView({ episodes: eps, contributors: { episodes: { e11: { callIns: [{ kind: "nomination", who: firstPick, nominee: "Someone" }] } } }, transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.deepEqual(nominatedOnly.callIns.featured, [], "a pick whose only aired entry is a nomination is not featured");
  assert.deepEqual(view.callIns.featured, [], "none of the picks aired in the fixture: nothing featured, never invented");
  assert.deepEqual(sponsorView({ episodes: eps, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" }).callIns.featured, [], "no call-in list: an empty feature, beside the absent count's reason");
  const quoted = sponsorView({ episodes: eps.map((e) => (e.ep === 10 ? { ...e, audience: { list: [
    { id: FEATURED_QUOTES[0], source: "x", author: "@audience", text: "@ridd_design A whole sentence from the audience, long enough to quote.", platform: "X", url: `https://x.com/i/status/${FEATURED_QUOTES[0].slice(2)}`, likes: 0, sentiment: "positive", at: "2026-09-18T00:00:00Z" },
  ] } } : e)), transcripts: {}, generatedAt: "2026-10-11T14:00:00.000Z" });
  const shippedQuote = quoted.feedback.quotes.find((q) => q.id === FEATURED_QUOTES[0]);
  assert.ok(shippedQuote, "the fixture's comment is a shipped quote");
  assert.deepEqual(quoted.feedback.featured, [shippedQuote], "a featured quote is the shipped quote, unchanged");
  assert.equal(quoted.feedback.featured[0].text, "A whole sentence from the audience, long enough to quote.");
  assert.deepEqual(view.feedback.featured, [], "none of the picked ids is stored in the fixture");
}

console.log("sponsor-view.test: clock checks link only on a matched clock; call-ins come from what aired; sponsor totals mirror the brief, typicals use the window before the newest, the newest curve is its stored session, excerpts are whole sentences of the transcript's words, quotes link to their originals with the show's own guests last, examples stand only where the transcript bears the owners' record out and carry the partner's own segment from the recorded window, the owners' featured call-ins (with their words), tool call-ins, quotes and cover row are stored entries in their order within the caps, and absent inputs stay absent");
