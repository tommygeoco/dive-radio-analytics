process.env.DIVE_MODEL_TRANSPORT = "api";
process.env.ANTHROPIC_API_KEY = "fixture-only";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL, PROVIDER, completeModel, hasModelCredential, modelIdentity, useGateway } from "../model-route.mjs";

// One model for every L3 step: Claude Sonnet 5.5 over the Anthropic Messages
// API, with every non-complete reply refused before a script can parse it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const reply = (body, { ok = true, status = 200, headers = {} } = {}) => ({
  ok, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body,
});
const done = (text = '{"ok":true}') => reply({ model: MODEL, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text }] });
const noSleep = async () => {};

assert.equal(MODEL, "claude-sonnet-5-5");
assert.equal(PROVIDER, "anthropic");
assert.equal(useGateway(), false, "the API is the default transport");
assert.deepEqual(modelIdentity(), { provider: "anthropic", model: "claude-sonnet-5-5" });
assert.equal(hasModelCredential(), true);

// request shape: one model, stated effort, adaptive thinking left to the model
let seen;
const ok = await completeModel("system text", [{ role: "user", content: "hi" }], {
  maxTokens: 1234, label: "fixture", fetchImpl: async (url, init) => { seen = { url, init }; return done(); },
});
const body = JSON.parse(seen.init.body);
assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
assert.equal(seen.init.headers["x-api-key"], "fixture-only");
assert.equal(body.model, "claude-sonnet-5-5");
assert.equal(body.max_tokens, 1234);
assert.equal(body.system, "system text");
assert.deepEqual(body.output_config, { effort: "high" });
for (const banned of ["thinking", "temperature", "top_p", "top_k", "tool_choice"]) assert.equal(body[banned], undefined, `${banned} is never sent`);
assert.equal(ok.text, '{"ok":true}', "only text blocks become the reply");
assert.equal(ok.content.length, 2, "full content (thinking included) is returned for append-only retries");
assert.equal(ok.provider, "anthropic");
assert.equal(ok.model, "claude-sonnet-5-5");

// every incomplete reply throws before a caller can parse it
const cases = [
  [reply({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }), /declined the request \(cyber\)/],
  [reply({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"cut' }] }), /cut off at 16000 tokens/],
  [reply({ stop_reason: "pause_turn", content: [{ type: "text", text: "x" }] }), /incomplete reply \(stop_reason pause_turn\)/],
  [reply({ content: [{ type: "text", text: "x" }] }), /stop_reason missing/],
  [reply({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] }), /empty reply/],
  [{ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad"); } }, /malformed JSON/],
];
for (const [response, pattern] of cases) {
  await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", fetchImpl: async () => response, sleep: noSleep }), pattern);
}

// one paced retry on overload or rate limit; no retry on a request error
let calls = 0;
const recovered = await completeModel("s", [{ role: "user", content: "x" }], {
  label: "fixture", sleep: noSleep,
  fetchImpl: async () => (++calls === 1 ? reply({ error: { type: "overloaded_error" } }, { ok: false, status: 529, headers: { "retry-after": "2" } }) : done("fine")),
});
assert.equal(calls, 2);
assert.equal(recovered.text, "fine");
calls = 0;
await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], {
  label: "fixture", sleep: noSleep,
  fetchImpl: async () => { calls++; return reply({ error: { type: "invalid_request_error" } }, { ok: false, status: 400 }); },
}), /HTTP 400 invalid_request_error after 1 attempt/);
assert.equal(calls, 1, "a rejected request is not retried");
calls = 0;
await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], {
  label: "fixture", sleep: noSleep,
  fetchImpl: async () => { calls++; return reply({}, { ok: false, status: 529 }); },
}), /HTTP 529 after 2 attempt/);
assert.equal(calls, 2, "a second overload stops the call");
await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", fetchImpl: async () => { throw new TypeError("net"); } }), /request failed or timed out/);
// a dropped connection is retried once; a timeout never is; error text never leaks
const dropped = () => Object.assign(new TypeError("fetch failed: secret-body"), { cause: { code: "UND_ERR_SOCKET" } });
calls = 0;
const afterReset = await completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", sleep: noSleep, fetchImpl: async () => { if (++calls === 1) throw dropped(); return done("back"); } });
assert.equal(calls, 2);
assert.equal(afterReset.text, "back");
calls = 0;
await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", sleep: noSleep, fetchImpl: async () => { calls++; throw dropped(); } }),
  (error) => /UND_ERR_SOCKET/.test(error.message) && !/secret-body/.test(error.message));
assert.equal(calls, 2, "a second dropped connection stops the call");
calls = 0;
await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", sleep: noSleep, fetchImpl: async () => { calls++; throw new DOMException("timed out", "TimeoutError"); } }), /TimeoutError/);
assert.equal(calls, 1, "a timeout is not retried");
await assert.rejects(completeModel("s", [], { label: "fixture", effort: "turbo", fetchImpl: async () => done() }), /unknown effort/);

// no credential: the call is refused before any request
const saved = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = " ";
assert.equal(hasModelCredential(), false);
await assert.rejects(completeModel("s", [], { label: "fixture", fetchImpl: async () => assert.fail("no request without a key") }), /ANTHROPIC_API_KEY not set/);
process.env.ANTHROPIC_API_KEY = saved;
process.env.DIVE_MODEL_TRANSPORT = "direct-api";
assert.throws(() => useGateway(), /must be api or gateway/);
process.env.DIVE_MODEL_TRANSPORT = "api";

// source lock: model strings and provider endpoints live only in model-route
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(mjs|js)$/.test(name) ? [path] : [];
});
const offenders = [...walk(join(ROOT, "tools")), ...walk(join(ROOT, "scripts"))]
  .filter((path) => !/\/audit\/[^/]+\.test\.mjs$|\/model-route\.mjs$/.test(path))
  .flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [/["'`]claude-[a-z]+-\d/, /["'`]gpt-\d/, /api\.anthropic\.com/, /api\.openai\.com/, /_MODEL\s*\|\|/]
      .filter((pattern) => pattern.test(source)).map((pattern) => `${relative(ROOT, path)} ${pattern}`);
  });
assert.deepEqual(offenders, [], "every model step goes through model-route.mjs");
console.log("model-route: Sonnet 5.5 request shape, stop reasons, bounded retry, credential gate and single-route source lock green");
