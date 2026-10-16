process.env.DIVE_MODEL_TRANSPORT = "api";
process.env.ANTHROPIC_API_KEY = "fixture-only";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
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
assert.equal(body.stream, true, "every reply is streamed, so headers come at once");
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

// streamed replies (2026-10-16): the events are put back together into the
// message an unstreamed call returns, so the same rules read the same fields
const eventsOf = ({ content = [], stop_reason = null, stop_details, ...message }) => [
  { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "ping" },
  ...content.flatMap((block, index) => {
    const field = block.type === "thinking" ? "thinking" : "text";
    const pieces = (block[field].match(/[\s\S]{1,5}/g) || []).map((piece) => ({ type: "content_block_delta", index, delta: { type: `${field}_delta`, [field]: piece } }));
    return [
      { type: "content_block_start", index, content_block: block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } },
      ...pieces, { type: "ping" },
      ...(block.signature ? [{ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }] : []),
      { type: "content_block_stop", index },
    ];
  }),
  { type: "message_delta", delta: { stop_reason, stop_sequence: null, ...(stop_details ? { stop_details } : {}) }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];
const sseText = (events, newline = "\n") => events.map((e) => `event: ${e.type}${newline}data: ${JSON.stringify(e)}${newline}${newline}`).join("");
const streamHeaders = { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream; charset=utf-8" : null) };
const streamed = (message, { size = 7, events = eventsOf(message), tail = "", newline = "\n", fault = null } = {}) => {
  const bytes = new TextEncoder().encode(sseText(events, newline) + tail);
  return { ok: true, status: 200, headers: streamHeaders, body: (async function* () {
    for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
    if (fault) throw fault;
  })() };
};
const thought = [{ type: "thinking", thinking: "", signature: "sig/ÄÖ+==" }, { type: "thinking", thinking: "Weighing the opening segment", signature: "sig2" }, { type: "text", text: '{"chapters":[{"title":"Café — naïve ✓"}]}' }];
// chunks of 1 and 7 bytes split events, lines and multi-byte characters
for (const [size, newline] of [[1, "\n"], [7, "\n"], [7, "\r\n"], [65536, "\n"]]) {
  const whole = await completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", fetchImpl: async () => streamed({ model: MODEL, stop_reason: "end_turn", content: thought }, { size, newline }) });
  assert.equal(whole.text, thought[2].text, `streamed text reassembles (chunks of ${size})`);
  assert.deepEqual(whole.content, thought, "thinking blocks come back byte-identical, signatures included, for append-only retries");
  assert.equal(whole.stopReason, "end_turn");
  assert.equal(whole.usage.output_tokens, 42, "usage takes message_delta's final count");
}
const streamCases = [
  [{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [] }, /declined the request \(cyber\)/],
  [{ stop_reason: "max_tokens", content: [{ type: "text", text: '{"cut' }] }, /cut off at 16000 tokens/],
  [{ stop_reason: "pause_turn", content: [{ type: "text", text: "x" }] }, /incomplete reply \(stop_reason pause_turn\)/],
  [{ content: [{ type: "text", text: "x" }] }, /stop_reason missing/],
  [{ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "s" }] }, /empty reply/],
];
for (const [message, pattern] of streamCases) {
  await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", fetchImpl: async () => streamed(message), sleep: noSleep }), pattern);
}
const finished = eventsOf({ model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "complete text" }] });
const streamFaults = [
  [{ events: finished.slice(0, -1) }, /ended before message_stop/, "a stream cut before message_stop"],
  [{ events: finished.slice(0, 4) }, /ended before message_stop/, "a stream cut mid-block"],
  [{ events: [...finished.slice(0, 3), { type: "error", error: { type: "overloaded_error", message: "secret-body" } }] }, /stream error overloaded_error$/, "an error event mid-stream"],
  [{ events: finished.slice(0, 3), tail: "event: content_block_delta\ndata: {not json\n\n" }, /malformed stream event/, "a payload that is not JSON"],
  [{ events: [finished[0], { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "n", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, ...finished.slice(-2)] }, /unexpected input_json_delta/, "a delta it cannot rebuild faithfully"],
  [{ events: finished.slice(2) }, /did not start with message_start/, "a stream without message_start"],
  [{ events: [finished[0], { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } }] }, /never started/, "a delta for an unknown block"],
  [{ events: finished.slice(0, 4), fault: Object.assign(new TypeError("terminated: secret-body"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } }) }, /request failed or timed out \(TypeError UND_ERR_BODY_TIMEOUT\)/, "a connection lost mid-stream"],
  [{ events: finished.slice(0, 4), fault: new DOMException("timed out", "TimeoutError") }, /request failed or timed out \(TimeoutError\)/, "the step's own timeout mid-stream"],
];
for (const [options, pattern, what] of streamFaults) {
  let tries = 0;
  await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", sleep: noSleep, fetchImpl: async () => { tries++; return streamed(null, options); } }),
    (error) => pattern.test(error.message) && !/secret-body/.test(error.message), what);
  assert.equal(tries, 1, `${what} is not retried — the request has already spent its time`);
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

// A real loopback reply through Node's own fetch, shaped like the API: headers
// and message_start at once, pings while the model thinks, the reply at the
// end. The call waits on the body, never on headers, and only the step's own
// timeout stops it. MODEL_ROUTE_SLOW=1 holds the reply for 310 s — past the
// 300 s at which Node's fetch gives up on headers that have not come — and
// shows an unstreamed reply held as long still fails that way (E14 chapters,
// 2026-10-16: UND_ERR_HEADERS_TIMEOUT under a 600 s step timeout).
const SLOW = process.env.MODEL_ROUTE_SLOW === "1";
const HOLD_MS = SLOW ? 310_000 : 1_200;
const PING_MS = SLOW ? 15_000 : 100;
const loopback = createServer((req, res) => {
  req.resume();
  if (req.url === "/held") {
    const timer = setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: MODEL, stop_reason: "end_turn", content: thought })); }, HOLD_MS);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  const events = eventsOf({ model: MODEL, stop_reason: "end_turn", content: thought });
  res.write(sseText(events.slice(0, 3)));
  const ping = setInterval(() => res.write(sseText([{ type: "ping" }])), PING_MS);
  const timer = req.url === "/forever" ? null : setTimeout(() => { clearInterval(ping); res.end(sseText(events.slice(3))); }, HOLD_MS);
  res.on("close", () => { clearInterval(ping); clearTimeout(timer); });
});
await new Promise((resolve) => loopback.listen(0, "127.0.0.1", resolve));
const local = (path) => async (url, init) => {
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  const response = await fetch(`http://127.0.0.1:${loopback.address().port}${path}`, init);
  local.headersAt = Date.now();
  return response;
};
try {
  const started = Date.now();
  const [slowReply, heldUnstreamed] = await Promise.all([
    completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", timeoutMs: HOLD_MS + 60_000, fetchImpl: local("/stream") }),
    SLOW ? completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", timeoutMs: HOLD_MS + 60_000, fetchImpl: local("/held") }).then(() => "answered", (error) => error.message) : null,
  ]);
  const elapsed = Date.now() - started;
  assert.deepEqual(slowReply.content, thought, "a reply that takes its time arrives whole through the real fetch");
  assert.ok(elapsed >= HOLD_MS, `the call waited for the reply (${elapsed} ms)`);
  if (SLOW) {
    assert.ok(elapsed > 300_000, "a streamed reply is not cut off at 300 s");
    assert.match(heldUnstreamed, /UND_ERR_HEADERS_TIMEOUT/, "an unstreamed reply held as long is still cut off by Node's fetch");
  }
  // the step's own timeout still bounds a reply that never finishes, once
  const before = Date.now();
  await assert.rejects(completeModel("s", [{ role: "user", content: "x" }], { label: "fixture", timeoutMs: 600, fetchImpl: local("/forever") }), /request failed or timed out \(TimeoutError\)/);
  assert.ok(local.headersAt - before < 600, "headers came before the timeout; the timeout stopped the body");
} finally {
  loopback.closeAllConnections();
  loopback.close();
}

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
