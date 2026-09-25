// Match a Restream destination to its registered episode account. An X
// broadcast can be linked by multiple posts from the same account; those
// posts still describe one Restream channel. Different accounts remain
// ambiguous, as do duplicate YouTube video registrations.

function targetIdentity(target) {
  if (target.kind === "youtube" && target.videoId) return `youtube:${target.videoId}`;
  if (target.kind === "x" && target.role !== "promo" && target.broadcastId) return `x:${target.broadcastId}`;
  return null;
}

function urlIdentity(url) {
  const yt = String(url || "").match(/(?:youtube\.com\/(?:watch\?v=|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (yt) return `youtube:${yt[1]}`;
  const x = String(url || "").match(/(?:x|twitter)\.com\/i\/broadcasts\/([A-Za-z0-9_-]+)/);
  if (x) return `x:${x[1]}`;
  return null;
}

export function matchRestreamDestination(destination, targets = []) {
  const identity = urlIdentity(destination?.externalUrl);
  if (!identity) return { identity: null, target: null, matchingCount: 0 };
  const matching = targets.filter((target) => targetIdentity(target) === identity);
  const sameXAccount = identity.startsWith("x:") && matching.length > 1
    && typeof matching[0].account === "string" && matching[0].account.length > 0
    && matching.every((target) => target.account === matching[0].account);
  const target = matching.length === 1 || sameXAccount ? matching[0] : null;
  return { identity, target, matchingCount: matching.length };
}
