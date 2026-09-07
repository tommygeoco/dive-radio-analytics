// Public X reads only. xurl owns app credentials; no token extraction or fallback.
import { spawnSync } from "node:child_process";

const XURL = "/opt/homebrew/bin/xurl";
const PATHS = [/^\/2\/users\/by$/, /^\/2\/users\/by\/username\/[A-Za-z0-9_]+$/, /^\/2\/users\/\d+\/tweets$/, /^\/2\/tweets$/, /^\/2\/tweets\/search\/recent$/];
const PARAMS = new Set(["usernames", "user.fields", "ids", "tweet.fields", "expansions", "media.fields", "max_results", "exclude", "pagination_token", "query", "next_token"]);

function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("X public request URL is invalid"); }
  if (url.origin !== "https://api.x.com" || url.username || url.password || url.hash
    || !PATHS.some((path) => path.test(url.pathname))
    || [...url.searchParams.keys()].some((key) => !PARAMS.has(key))) {
    throw new Error("X public request must use an approved HTTPS api.x.com endpoint");
  }
  return url.href;
}

export async function xPublicGet(url, {
  run = spawnSync, timeoutMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const target = publicUrl(url);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("X request timeout must be positive");
  for (let attempt = 1; attempt <= 2; attempt++) {
    let result;
    try {
      result = run(XURL, ["--app", "hinterlands", "--auth", "app", "--method", "GET", target], {
        encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { result = { error: true }; }
    // Child diagnostics can contain sensitive text: never forward them or use
    // Error.cause. Transport failures alone get one bounded retry.
    if (result?.error || result?.signal) {
      if (attempt === 1) continue;
      throw new Error("X app request failed or timed out after 2 attempts");
    }
    let data;
    try { data = JSON.parse(result?.stdout); } catch { /* Report only a fixed message below. */ }
    const status = Number.isInteger(data?.status) && data.status >= 400 && data.status <= 599 ? data.status : null;
    if (status >= 500 && attempt === 1) { await sleep(250); continue; }
    // Raw xurl does not expose Retry-After without verbose diagnostics. Do not
    // retry a 429 here: a short guessed delay would ignore the server's limit.
    if (status || result?.status !== 0 || data?.error || data?.errors?.length) {
      throw new Error(status ? `X app request returned HTTP ${status}` : "X app request failed or returned incomplete results");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("X app request returned malformed or empty JSON");
    return data;
  }
}
