import assert from "node:assert/strict";
import { matchRestreamDestination } from "./restream-destination.mjs";

// E11: both DesignerTom posts resolve to Restream's one X channel.
const broadcast = "1qxvveXzoggxB";
const destination = { channelId: 17404025, externalUrl: `https://x.com/i/broadcasts/${broadcast}` };
const firstPost = { kind: "x", account: "designertom", postId: "2103213058743218388", broadcastId: broadcast };
const secondPost = { kind: "x", account: "designertom", postId: "2103055258993721705", broadcastId: broadcast };

const repeated = matchRestreamDestination(destination, [firstPost, secondPost]);
assert.equal(repeated.identity, `x:${broadcast}`);
assert.equal(repeated.matchingCount, 2);
assert.equal(repeated.target?.account, "designertom", "two posts for one X account resolve to one channel identity");

const otherAccount = { ...secondPost, account: "ridd_design" };
assert.equal(matchRestreamDestination(destination, [firstPost, otherAccount]).target, null,
  "one broadcast claimed by different X accounts remains ambiguous");
assert.equal(matchRestreamDestination(destination, [firstPost, { ...secondPost, role: "promo" }]).matchingCount, 1,
  "promo posts cannot claim a broadcast destination");
assert.equal(matchRestreamDestination(destination, []).target, null, "missing registry identity remains invalid");

const video = { channelId: 17404029, externalUrl: "https://www.youtube.com/watch?v=FqsXWbfKmGw" };
const ytTarget = { kind: "youtube", account: "designertom", videoId: "FqsXWbfKmGw" };
assert.equal(matchRestreamDestination(video, [ytTarget]).target, ytTarget);
assert.equal(matchRestreamDestination(video, [ytTarget, { ...ytTarget }]).target, null,
  "duplicate YouTube registrations remain invalid");
assert.equal(matchRestreamDestination({ externalUrl: "https://www.linkedin.com/feed/update/example" }, []).identity, null);

console.log("restream-destination.test: repeated same-account X posts resolve; cross-account, missing, and duplicate YouTube mappings fail");
