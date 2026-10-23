#!/usr/bin/env node
// restream-token.mjs — print a valid Restream API access token to stdout.
//
// OAuth2 authorization-code flow with rotating refresh. Client credentials
// live in 1Password (OpenClaw vault, item "Restream", fields client_id /
// client_secret). Token cache: ~/.openclaw/secrets/restream-tokens.json (0600).
//
// Usage:
//   node restream-token.mjs --auth-url [--redirect-uri URI]   # print consent URL
//   node restream-token.mjs --exchange CODE --redirect-uri URI # one-time code swap
//   node restream-token.mjs                                    # print access token
//
// Diagnostics go to stderr; stdout carries only the token (or auth URL).

import { readFileSync, writeFileSync, chmodSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { atomicWriteJson, readJsonFile, withSourceLock, fetchJson } from "../../tools/dive-analytics/source-io.mjs";

const TOKEN_PATH = join(homedir(), ".openclaw", "secrets", "restream-tokens.json");
const AUTHORIZE_URL = "https://api.restream.io/oauth/authorize";
const TOKEN_URL = "https://api.restream.io/oauth/token";
const DEFAULT_REDIRECT = "http://localhost:8899/callback";
const SCOPES = "stream.read";
const SKEW_MS = 5 * 60 * 1000;
// The shared 1Password reader lives in the hinterlands repo, not here. It is
// loaded only on the fallback path, from a fixed location (override with
// DIVE_OP_HELPER), so env and token-cache reads never depend on it.
export const OP_HELPER_PATH = process.env.DIVE_OP_HELPER
  || join(homedir(), "Dev", "2026", "hinterlands", "scripts", "op", "op.mjs");

export async function loadOpRead(path = OP_HELPER_PATH) {
  if (!existsSync(path)) throw new Error(`Restream client credentials need the 1Password helper, which is missing at ${path} (set DIVE_OP_HELPER)`);
  let mod;
  try { mod = await import(pathToFileURL(path).href); }
  catch { throw new Error(`Restream client credentials need the 1Password helper, which failed to load from ${path}`); }
  if (typeof mod.opRead !== "function") throw new Error(`the 1Password helper at ${path} does not export opRead`);
  return mod.opRead;
}

// Use env, then the protected token cache. Read 1Password once only when absent
// or when Restream rejects the cached client credentials.
async function readOpCreds({ refresh = false } = {}) {
  if (!refresh && process.env.RESTREAM_CLIENT_ID && process.env.RESTREAM_CLIENT_SECRET) return { clientId: process.env.RESTREAM_CLIENT_ID, clientSecret: process.env.RESTREAM_CLIENT_SECRET };
  if (!refresh) {
    const cache = readCache();
    if (cache?.client_id && cache?.client_secret) return { clientId: cache.client_id, clientSecret: cache.client_secret };
  }
  const opRead = await loadOpRead();
  const clientId = opRead('op://OpenClaw/Restream/client_id', { caller: 'restream-token' });
  const clientSecret = opRead('op://OpenClaw/Restream/client_secret', { caller: 'restream-token' });
  if (!clientId || !clientSecret) throw new Error('Restream client credentials are unavailable');
  return { clientId, clientSecret };
}

function readCache(path = TOKEN_PATH) { return readJsonFile(path, { fallback: null }); }
function writeCache(cache, path = TOKEN_PATH) { atomicWriteJson(path, cache, { mode: 0o600 }); }

export async function tokenRequest(params, creds, { fetchImpl = fetch } = {}) {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const data = await fetchJson(TOKEN_URL, {
    label: "Restream token refresh", fetchImpl, timeoutMs: 20000, maxAttempts: 1,
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("token response missing access_token");
  return data;
}

function cacheFromResponse(data, prev = {}) {
  const now = Date.now();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    token_type: data.token_type || "Bearer",
    expires_at_ms: data.expires_in ? now + data.expires_in * 1000 : (data.accessTokenExpiresEpoch ? data.accessTokenExpiresEpoch * 1000 : now + 3600 * 1000),
    refreshed_at: new Date(now).toISOString(),
  };
}

export function needsRefresh(cache, nowMs = Date.now(), skewMs = SKEW_MS) {
  if (!cache || !cache.access_token || !cache.expires_at_ms) return true;
  return nowMs >= cache.expires_at_ms - skewMs;
}

export async function getAccessToken({ tokenPath = TOKEN_PATH, readCredentials = readOpCreds, request = tokenRequest, now = Date.now(), log = (line) => process.stderr.write(line + "\n") } = {}) {
  return withSourceLock(tokenPath, async () => {
  let cache = readCache(tokenPath);
  if (!cache || !cache.refresh_token) {
    throw new Error(
      `no Restream token cache at ${tokenPath} — run --auth-url then --exchange to authorize`
    );
  }
  if (needsRefresh(cache, now)) {
    const creds = await readCredentials();
    let data;
    try { data = await request({ grant_type: "refresh_token", refresh_token: cache.refresh_token }, creds); }
    catch (error) {
      if (!/HTTP (401|403)\b/.test(String(error?.message || error))) throw error;
      const fresh = await readCredentials({ refresh: true });
      data = await request({ grant_type: "refresh_token", refresh_token: cache.refresh_token }, fresh);
      Object.assign(creds, fresh);
    }
    cache = {
      ...cacheFromResponse(data, cache),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    };
    writeCache(cache, tokenPath);
    log("restream-token: refreshed");
  }
  return cache.access_token;
  });
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const redirect = arg("--redirect-uri") || DEFAULT_REDIRECT;
  if (process.argv.includes("--auth-url")) {
    const creds = await readOpCreds();
    const state = randomBytes(16).toString("hex");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", creds.clientId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    process.stdout.write(url.toString() + "\n");
    return;
  }
  const code = arg("--exchange");
  if (code) {
    const creds = await readOpCreds();
    const data = await tokenRequest(
      { grant_type: "authorization_code", code, redirect_uri: redirect },
      creds
    );
    await withSourceLock(TOKEN_PATH, () => writeCache({
      ...cacheFromResponse(data),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }));
    process.stderr.write("restream-token: authorized, cache written\n");
    return;
  }
  process.stdout.write(await getAccessToken());
}

const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirect)
  await main().catch((err) => {
    process.stderr.write(`restream-token: ${err.message}\n`);
    process.exit(1);
  });
