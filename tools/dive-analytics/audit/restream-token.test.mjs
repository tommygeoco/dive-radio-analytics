import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAccessToken, tokenRequest, loadOpRead } from "../../../scripts/restream/restream-token.mjs";
const root = mkdtempSync(join(tmpdir(), "dive-token-fixture-"));
try {
  const tokenPath = join(root, "token.json");
  writeFileSync(tokenPath, JSON.stringify({ refresh_token: "fixture-refresh", access_token: "fixture-old", expires_at_ms: 1 }));
  let requests = 0;
  const request = async () => { requests++; await new Promise((resolve) => setTimeout(resolve, 10)); return { access_token: "fixture-new", refresh_token: "fixture-rotated", expires_in: 3600 }; };
  const options = { tokenPath, request, readCredentials: () => ({ clientId: "fixture", clientSecret: "fixture" }), log() {} };
  const first = getAccessToken(options);
  await assert.rejects(getAccessToken(options), /already in use/);
  assert.equal(await first, "fixture-new");
  assert.equal(await getAccessToken(options), "fixture-new");
  assert.equal(requests, 1, "concurrent or duplicate capture cannot rotate one refresh token twice");
  assert.equal(JSON.parse(readFileSync(tokenPath)).refresh_token, "fixture-rotated");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  await assert.rejects(tokenRequest({}, { clientId: "fixture", clientSecret: "fixture-secret" }, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => "fixture-secret echoed by server" }) }), (error) => error.message.includes("401") && !error.message.includes("fixture-secret"));

  writeFileSync(tokenPath, JSON.stringify({ refresh_token: "fixture-refresh", access_token: "old", expires_at_ms: 1, client_id: "cached", client_secret: "cached" }));
  let reads = 0;
  await assert.rejects(getAccessToken({ tokenPath, readCredentials: () => { reads++; return { clientId: "cached", clientSecret: "cached" }; }, request: async () => { throw new Error('restream token returned HTTP 500 after 1 attempt(s)'); }, log() {} }), /HTTP 500/);
  assert.equal(reads, 1, 'network/server failures do not refresh credentials');

  writeFileSync(tokenPath, JSON.stringify({ refresh_token: "fixture-refresh", access_token: "old", expires_at_ms: 1, client_id: "cached", client_secret: "cached" }));
  reads = 0;
  let authRequests = 0;
  const token = await getAccessToken({ tokenPath, readCredentials: ({ refresh } = {}) => { reads++; return refresh ? { clientId: "fresh", clientSecret: "fresh" } : { clientId: "cached", clientSecret: "cached" }; }, request: async () => { authRequests++; if (authRequests === 1) throw new Error('restream token returned HTTP 401 after 1 attempt(s)'); return { access_token: "fixture-after-auth", expires_in: 3600 }; }, log() {} });
  assert.equal(token, 'fixture-after-auth');
  assert.equal(reads, 2, 'an auth rejection refreshes credentials once');
  await assert.rejects(loadOpRead(join(root, "missing-op.mjs")), /1Password helper, which is missing at .*missing-op\.mjs/);
  writeFileSync(tokenPath, "invalid fixture-secret JSON");
  await assert.rejects(getAccessToken(options), (error) => error.message.includes("unreadable") && !error.message.includes("fixture-secret"));
  console.log("restream-token: serialized rotation, duplicate refresh prevention, private cache permissions and sanitized credential errors passed");
} finally { rmSync(root, { recursive: true, force: true }); }
