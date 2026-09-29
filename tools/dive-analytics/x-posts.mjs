// The one definition of which X posts are an episode's announce posts.
//
// X reach is impressions on the hosts' announce posts — the posts that carry
// the episode's X broadcast (CARD-RULING-2026-08-21 Q2; AUDIT-2026-08-21 F-9).
// Promo posts (teasers, clips, links to the YouTube upload) and posts that
// never resolved to a broadcast are counted separately as promo reach: shown,
// never compared, never part of reach, plays or views. How many promo posts an
// episode gets varies (none before E6, four on E10), so folding them into reach
// made one episode's number mean something different from the next one's.
//
// Capture (comment replies), build-data (reach, links, announces) and the
// validator all import this module; none carries its own rule.

export const isAnnouncePost = (t) => t?.kind === "x" && Boolean(t.broadcastId) && t.role !== "promo";

export const postRole = (t) => (isAnnouncePost(t) ? "announce" : "promo");

// Comment capture reads replies to announce posts, plus a post still waiting
// for its broadcast to resolve (the same morning it was registered). A promo
// post, or one that repeatedly answered "no broadcast", is never read.
export const announceCandidate = (t) => t?.kind === "x" && t.role !== "promo" && (Boolean(t.broadcastId) || !t.broadcastResolved);

// Split one account's X reading into announce and promo impressions.
// Readings since 2026-09-04 keep per-post sources and split exactly. An older
// reading is one blended total per account: it is announce-only when the
// account had no other post registered, and otherwise cannot be split — both
// values are absent, never estimated (rule 3). Promo impressions exist only
// where promo posts are registered: none registered is absence, not zero
// (E1–E5 were never searched for promo posts).
export function splitXReading(account, metric, targets) {
  const posts = (targets || []).filter((t) => t.kind === "x" && t.account === account);
  const announce = new Set(posts.filter(isAnnouncePost).map((t) => t.postId));
  const promoPosts = posts.length - announce.size;
  const sum = (rows) => (rows.every((r) => Number.isFinite(r.views)) ? rows.reduce((a, r) => a + r.views, 0) : null);
  if (Array.isArray(metric?.sources) && metric.sources.length) {
    const own = metric.sources.filter((r) => announce.has(r.objectId));
    const other = metric.sources.filter((r) => !announce.has(r.objectId));
    return { views: own.length ? sum(own) : null, promoViews: promoPosts ? sum(other) : null };
  }
  if (promoPosts) return { views: null, promoViews: null };
  return { views: Number.isFinite(metric?.views) ? metric.views : null, promoViews: null };
}
