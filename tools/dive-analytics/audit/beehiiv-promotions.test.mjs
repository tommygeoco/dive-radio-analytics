#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildPromotionStore,
  canonicalTrackedUrl,
  assertUsablePosts,
  extractAnchorUrls,
  fetchConfirmedPosts,
  mergeSnapshot,
  promotionForEpisode,
  targetKeyFromUrl,
} from "../../../scripts/restream/beehiiv-promotions-pull.mjs";

const show = {
  slug: "2026-09-02-dive-radio-how-to-engineer-a-brand-unive",
  title: "Dive Radio: How to Engineer a Brand Universe",
  date: "2026-09-03",
  active: true,
  targets: [
    { kind: "youtube", account: "joindiveclub", videoId: "Vh8ogFIE8CA" },
    { kind: "youtube", account: "designertom", videoId: "lnAecYrKYos" },
    { kind: "x", account: "ridd_design", broadcastId: "1AKEmvbREYaKL" },
  ],
};
const post = {
  id: "post_179faf55-d19b-4399-b9f2-e2d892de4820",
  title: "7 changes in brand world-building",
  slug: "7-changes-in-brand-world-building",
  publish_date: Date.parse("2026-09-03T13:00:00Z") / 1000,
  web_url: "https://uxtools.beehiiv.com/p/7-changes-in-brand-world-building",
  content: { free: { email: [
    '<a href="https://www.youtube.com/live/lnAecYrKYos?si=one&amp;utm_source=uxtools&amp;_bhlid=reader-one">Watch</a>',
    '<a href="https://www.youtube.com/live/lnAecYrKYos?si=one&amp;utm_source=uxtools&amp;_bhlid=reader-two">Title</a>',
    '<a href="https://www.youtube.com/live/lnAecYrKYos?utm_source=uxtools&amp;_bhlid=reader-three">Watch live</a>',
    '<a href="https://www.youtube.com/live/lnAecYrKYos?utm_source=uxtools&amp;_bhlid=reader-four">Today</a>',
    '<a href="https://www.youtube.com/live/lnAecYrKYos?utm_source=uxtools&amp;_bhlid=reader-five">Dive Radio</a>',
    '<a href="https://dive.radio/vote?utm_source=uxtools">Vote</a>',
  ].join("\n") } },
  stats: { clicks: [
    {
      url: "https://www.youtube.com/live/lnAecYrKYos?si=one&utm_source=uxtools",
      base_url: "https://www.youtube.com/live/lnAecYrKYos",
      email: { clicks: 76, verified_clicks: 27, unique_clicks: 33, unique_verified_clicks: 24 },
    },
    {
      url: "https://www.youtube.com/live/lnAecYrKYos?utm_source=uxtools",
      base_url: "https://www.youtube.com/live/lnAecYrKYos",
      email: { clicks: 33, verified_clicks: 14, unique_clicks: 20, unique_verified_clicks: 14 },
    },
    {
      url: "https://dive.radio/vote?utm_source=uxtools",
      base_url: "https://dive.radio/vote",
      email: { clicks: 18, verified_clicks: 9, unique_clicks: 12, unique_verified_clicks: 8 },
    },
  ] },
};

assert.deepEqual(extractAnchorUrls('<a HREF="https://example.com/?a=1&amp;b=2">x</a>'), ["https://example.com/?a=1&b=2"]);
assert.equal(targetKeyFromUrl("https://www.youtube.com/watch?v=abc123"), "youtube:abc123");
assert.equal(targetKeyFromUrl("https://youtu.be/abc123?t=4"), "youtube:abc123");
assert.equal(targetKeyFromUrl("https://x.com/i/broadcasts/1AKEmvbREYaKL"), "x:1AKEmvbREYaKL");
assert.equal(targetKeyFromUrl("https://dive.radio/watch"), null);
assert.equal(
  canonicalTrackedUrl("https://www.youtube.com/live/lnAecYrKYos?si=one&utm_source=uxtools&_bhlid=private-reader-id"),
  "https://www.youtube.com/live/lnAecYrKYos?si=one&utm_source=uxtools",
);

const result = promotionForEpisode(show, [post], { now: Date.parse("2026-09-03T23:00:00Z") });
assert.equal(result.status, "found");
assert.equal(result.newsletters.length, 1);
assert.equal(result.newsletters[0].anchorCount, 5);
assert.equal(result.newsletters[0].trackedLinkCount, 2);
assert.deepEqual(result.newsletters[0].matchedTargets, ["youtube:lnAecYrKYos"]);
assert.equal(result.newsletters[0].emailClicks, 109);
assert.equal(result.newsletters[0].verifiedEmailClicks, 41);
assert.equal(result.newsletters[0].links.length, 2, "the vote link must not be attributed to the episode");
assert.equal(result.totals.emailClicks, 109);
assert.equal(result.totals.verifiedEmailClicks, 41);
assert.equal(result.totals.combinedUniqueReaders, null, "unique counts from different tracked links must not be added");

const noEpisodeLink = structuredClone(post);
noEpisodeLink.content.free.email = '<a href="https://dive.radio/watch">Watch Dive Radio</a>';
assert.deepEqual(promotionForEpisode(show, [noEpisodeLink]), { status: "no-direct-link", reason: "No newsletter link could be tied to this episode exactly.", newsletters: [], totals: null });

const future = structuredClone(post);
future.publish_date = Date.parse("2026-09-05T13:00:00Z") / 1000;
assert.equal(promotionForEpisode(show, [future], { now: Date.parse("2026-09-03T23:00:00Z") }).status, "no-direct-link");

const missingStats = structuredClone(post);
missingStats.stats.clicks.splice(1, 1);
const incomplete = promotionForEpisode(show, [missingStats]);
assert.equal(incomplete.status, "found");
assert.equal(incomplete.totals.emailClicks, null, "one missing tracked-link row must make the total unknown");
assert.match(incomplete.newsletters[0].clicksReason, /not returned stats for every tracked episode link/);

const missingCount = structuredClone(post);
delete missingCount.stats.clicks[0].email.verified_clicks;
const incompleteCount = promotionForEpisode(show, [missingCount]);
assert.equal(incompleteCount.totals.emailClicks, 109);
assert.equal(incompleteCount.totals.verifiedEmailClicks, null);
assert.match(incompleteCount.newsletters[0].clicksReason, /without complete email click counts/);

const duplicate = structuredClone(post);
duplicate.stats.clicks.push(structuredClone(duplicate.stats.clicks[0]));
assert.throws(() => promotionForEpisode(show, [duplicate]), /repeats a click row/);

const firstSnapshots = mergeSnapshot([], result, Date.parse("2026-09-03T23:00:00Z"));
assert.deepEqual(firstSnapshots, [{ date: "2026-09-03", pulledAt: "2026-09-03T23:00:00.000Z", emailClicks: 109, verifiedEmailClicks: 41 }]);
const laterSameDay = structuredClone(result);
laterSameDay.totals.emailClicks = 112;
laterSameDay.totals.verifiedEmailClicks = 43;
assert.deepEqual(mergeSnapshot(firstSnapshots, laterSameDay, Date.parse("2026-09-04T02:00:00Z")), [
  { date: "2026-09-03", pulledAt: "2026-09-04T02:00:00.000Z", emailClicks: 112, verifiedEmailClicks: 43 },
]);
const nextDay = mergeSnapshot(firstSnapshots, laterSameDay, Date.parse("2026-09-04T14:00:00Z"));
assert.equal(nextDay.length, 2);
assert.deepEqual(nextDay.map((row) => row.date), ["2026-09-03", "2026-09-04"]);

const store = buildPromotionStore({
  registry: { shows: [show] },
  posts: [post],
  previous: { episodes: { [show.slug]: { snapshots: firstSnapshots } } },
  now: Date.parse("2026-09-04T14:00:00Z"),
  publicationId: "pub_test",
});
assert.equal(store.publication.name, "UX Tools");
assert.equal(store.episodes[show.slug].totals.verifiedEmailClicks, 41);
assert.equal(store.episodes[show.slug].snapshots.length, 2);
assert.throws(() => buildPromotionStore({
  registry: { shows: [show] },
  posts: [],
  previous: { episodes: { [show.slug]: result } },
}), /previously saved/);

assert.throws(() => assertUsablePosts([]), /no confirmed posts/);
assert.throws(() => assertUsablePosts([{ id: "post_without_expansions" }]), /incomplete email content or click stats/);
assert.equal(assertUsablePosts([post]).length, 1);
assert.throws(() => assertUsablePosts([post, { id: "partial" }]), /incomplete email/);
const pendingStore = buildPromotionStore({ registry: { shows: [show] }, posts: [missingStats], previous: store, now: Date.parse("2026-09-04T15:00Z") });
assert.equal(pendingStore.capture.state, "pending");
assert.equal(pendingStore.episodes[show.slug].capture.state, "pending");
assert.deepEqual(pendingStore.episodes[show.slug].totals, store.episodes[show.slug].totals);
assert.deepEqual(pendingStore.episodes[show.slug].snapshots, store.episodes[show.slug].snapshots);
assert.deepEqual(pendingStore.episodes[show.slug].newsletters, store.episodes[show.slug].newsletters, "preserved complete facts keep their original reading");
assert.equal(pendingStore.lastSuccessfulAt, store.lastSuccessfulAt);
assert.equal(pendingStore.capture.checkedAt, "2026-09-04T15:00:00.000Z");
const firstPending = buildPromotionStore({ registry: { shows: [show] }, posts: [missingStats], now: Date.parse("2026-09-04T15:00Z"), publicationId: "pub_test" });
assert.equal(firstPending.updatedAt, null);
assert.equal(firstPending.lastSuccessfulAt, null);
assert.deepEqual(firstPending.episodes[show.slug].snapshots, []);
assert.equal(firstPending.episodes[show.slug].totals.emailClicks, null);
assert.deepEqual(firstPending.episodes[show.slug].newsletters[0].reading, {
  schemaVersion: 1, source: "beehiiv", episode: show.slug, objectId: post.id,
  pulledAt: "2026-09-04T15:00:00.000Z", state: "pending",
});
const stillPending = buildPromotionStore({ registry: { shows: [show] }, posts: [missingStats], previous: firstPending, now: Date.parse("2026-09-04T16:00Z"), publicationId: "pub_test" });
assert.equal(stillPending.episodes[show.slug].newsletters[0].reading.pulledAt, "2026-09-04T16:00:00.000Z");
assert.equal(firstPending.episodes[show.slug].newsletters[0].reading.pulledAt, "2026-09-04T15:00:00.000Z", "refresh does not mutate previous pending facts");
const futureStore = buildPromotionStore({ registry: { shows: [{ ...show, date: "2026-09-05" }] }, posts: [post], now: Date.parse("2026-09-04T06:30Z") });
assert.deepEqual(futureStore.episodes, {});
assert.equal(store.episodes[show.slug].snapshots.at(-1).reading.episode, show.slug);

const pages = [];
const fetched = await fetchConfirmedPosts({
  apiKey: "test-only",
  publicationId: "pub_test",
  async fetchImpl(url, options) {
    pages.push({ url: String(url), auth: options.headers.Authorization });
    const page = Number(url.searchParams.get("page"));
    return { ok: true, async json() { return { data: [{ id: `post_${page}` }], total_pages: 2 }; } };
  },
});
assert.deepEqual(fetched.map((item) => item.id), ["post_1", "post_2"]);
assert.equal(pages.length, 2);
assert.ok(pages.every((item) => item.auth === "Bearer test-only"));
assert.ok(pages.every((item) => item.url.includes("expand%5B%5D=stats") && item.url.includes("expand%5B%5D=free_email_content")));
await assert.rejects(() => fetchConfirmedPosts({ apiKey: "" }), /OpenClaw 1Password environment/);
await assert.rejects(fetchConfirmedPosts({ apiKey: "fixture", fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "duplicate" }], total_pages: 2 }) }) }), /duplicate post ID/);
await assert.rejects(fetchConfirmedPosts({ apiKey: "fixture", fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "post" }], total_pages: 1000000 }) }) }), /excessive page count/);

console.log("beehiiv-promotions.test: exact episode links, safe click sums, unique-reader guard, daily snapshots, and pagination pass");
