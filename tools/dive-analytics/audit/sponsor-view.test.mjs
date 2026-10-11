#!/usr/bin/env node
// sponsor-view.test.mjs — fixtures for the sponsor page's three new pieces
// (2026-10-11): the clock check that decides which timestamps link into a
// YouTube upload (clock.mjs), the call-in import from the published episode
// notes (contributors-import.mjs), and the sponsor projection's honesty rules
// (sponsor-view.mjs). Pure: no network, no stores, no clock.

import assert from "node:assert/strict";
import { captionWords, clockOffset, clockHolds, linkableUpload, momentUrl, CLOCK_MIN_ANCHORS, CLOCK_MAX_SPREAD } from "../clock.mjs";
import { parseCallIn, parseEpisodeNotes, contributorEpisodes } from "../../../scripts/restream/contributors-import.mjs";
import { sponsorView, quoteText, excerptAt, brandPattern, BRAND_MIN_MENTIONS } from "../sponsor-view.mjs";
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
  const contributors = { updatedAt: "2026-10-11T00:00:00Z", episodes: { e9: { callIns: [{ kind: "submission", who: "A", about: "b" }, { kind: "nomination", who: "C", nominee: "D" }] }, "not-aired": { callIns: [{ kind: "submission", who: "X" }] } } };
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
  const thin = sponsorView({ episodes: eps.slice(0, 3), transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(thin.live.typical.peak, null, "fewer than three shows before the newest is no typical, never a guess");

  assert.equal(view.audience.total, 170000 + 68800 + 76565 + 19776);
  const gap = sponsorView({ episodes: eps, channelStats: { current: { ...channelStats.current, "x:designertom": { date: "2026-10-11", followers: null, reading: { state: "failed" } } } }, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" });
  assert.equal(gap.audience.total, null, "a missing channel leaves the total absent");
  assert.ok(gap.audience.reason);

  assert.deepEqual(view.feedback.quotes.map((q) => q.id), ["x:1"], "named public praise only: no questions, no anonymous chat, no negatives, one per person");
  assert.equal(view.feedback.positive, 4);

  assert.equal(view.callIns.total, 2, "a store entry for an episode that has not aired is ignored");
  assert.equal(view.callIns.nominations, 1);
  assert.equal(sponsorView({ episodes: eps, transcripts, generatedAt: "2026-10-11T14:00:00.000Z" }).callIns.total, null);

  const figma = view.brands.list.find((b) => b.name === "Figma");
  assert.equal(figma.mentions, 2 * 12, "every whole-word mention, in every episode that says it");
  assert.equal(figma.episodes, 12);
  assert.ok(!view.brands.list.some((b) => b.mentions < BRAND_MIN_MENTIONS));
  for (const b of view.brands.list) for (const m of b.moments) {
    assert.ok(normalize(transcripts[m.slug].segments.map((s) => s.text).join(" ")).includes(normalize(m.text.replace(/…/g, ""))), `${b.name} E${m.ep} excerpt is verbatim`);
    assert.equal(m.url, null, "no clock check, no link");
  }

  const notion = view.partners.find((p) => p.name === "Notion");
  assert.deepEqual(notion.moments.map((m) => [m.ep, m.kind]), [[6, "read"]], "named in a sponsor line");
  const paper = view.partners.find((p) => p.name === "Paper");
  assert.deepEqual(paper.moments.map((m) => m.ep), [6], "“not sponsored by Paper” is not a read");
  const lovable = view.partners.find((p) => p.name === "Lovable");
  assert.deepEqual(lovable.moments.map((m) => [m.ep, m.kind]), [[5, "segment"]], "a read inside the first minute of a chapter about the partner is that chapter");

  // a long speaker segment is cut to whole words around the name, verbatim
  const long = Array.from({ length: 80 }, (_, i) => (i === 40 ? "Mobbin" : `word${i}`)).join(" ");
  const x = excerptAt([{ stamp: "00:01:00", seconds: 60, text: long }], 0, brandPattern("Mobbin"));
  assert.ok(x.text.includes("Mobbin") && x.text.startsWith("…") && x.text.endsWith("…") && x.text.length <= 222);
}

console.log("sponsor-view.test: clock checks link only on a matched clock; call-ins come from what aired; sponsor totals mirror the brief, typicals use the window before the newest, quotes and excerpts stay verbatim, and absent inputs stay absent");
