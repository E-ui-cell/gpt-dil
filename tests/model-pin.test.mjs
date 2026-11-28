import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../userscripts/model-pin.user.js", import.meta.url), "utf8");
const endpoint = "https://chatgpt.com/backend-api/f/conversation";

function makePage(config = {}) {
  let nativeCall = null;
  let nativeCallCount = 0;
  const logs = [];
  const store = new Map();
  if (Object.keys(config).length) store.set("__GPT_DIL_MODEL_PIN_CONFIG_V1__", JSON.stringify(config));

  const nativeFetch = async function(input, init) {
    nativeCallCount++;
    nativeCall = { input, init };
    if (config.__rejectFetch) throw new TypeError("simulated network failure");
    return {
      status: 200,
      clone() {
        return { text: async () => JSON.stringify({ resolved_model_slug: "gpt-5.6-luna-wm" }) };
      },
    };
  };

  const window = {
    fetch: nativeFetch,
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, value); },
    },
  };
  const context = {
    window, URL, Request, WeakMap,
    location: { href: "https://chatgpt.com/" },
    localStorage: window.localStorage,
    console: { info(...args) { logs.push(args.join(" ")); }, warn() {} },
  };
  vm.runInNewContext(source, context);
  return {
    window,
    getNativeCall: () => nativeCall,
    getNativeCallCount: () => nativeCallCount,
    getLogs: () => logs,
  };
}

function makePayload(extra = {}) {
  return {
    action: "next",
    model: "auto",
    messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["test"] } }],
    untouched: { keep: true },
    ...extra,
  };
}

test("pins top-level model and selected effort without rewriting other fields", async () => {
  const page = makePage({ effort: "extended" });
  await page.window.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makePayload()),
  });
  const payload = JSON.parse(page.getNativeCall().init.body);
  assert.equal(payload.model, "gpt-5.6-luna-wm");
  assert.equal(payload.thinking_effort, "extended");
  assert.deepEqual(payload.messages, makePayload().messages);
  assert.deepEqual(payload.untouched, { keep: true });
});

test("adds reason hint only when enabled and preserves existing hints", async () => {
  const page = makePage({ effort: "standard", reasonHint: true });
  await page.window.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(makePayload({ system_hints: ["existing"] })),
  });
  const payload = JSON.parse(page.getNativeCall().init.body);
  assert.deepEqual(payload.system_hints, ["existing", "reason"]);
  assert.equal(payload.thinking_effort, "standard");
});

test("passes through unchanged when disabled", async () => {
  const page = makePage({ enabled: false });
  const init = { method: "POST", body: JSON.stringify(makePayload()) };
  await page.window.fetch(endpoint, init);
  assert.equal(page.getNativeCall().init, init);
});

test("does not modify unrelated endpoints", async () => {
  const page = makePage();
  const init = { method: "POST", body: JSON.stringify(makePayload()) };
  await page.window.fetch("https://chatgpt.com/backend-api/models", init);
  assert.equal(page.getNativeCall().init, init);
});

test("supports Request input without consuming the original Request", async () => {
  const page = makePage();
  const request = new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makePayload()),
  });
  await page.window.fetch(request);
  const sent = page.getNativeCall();
  assert.ok(sent.input instanceof Request);
  const payload = JSON.parse(await sent.input.clone().text());
  assert.equal(payload.model, "gpt-5.6-luna-wm");
  assert.equal(payload.thinking_effort, "standard");
  assert.equal(request.bodyUsed, false);
});

test("does not retry a request when native fetch rejects", async () => {
  const page = makePage({ __rejectFetch: true });
  await assert.rejects(
    page.window.fetch(endpoint, { method: "POST", body: JSON.stringify(makePayload()) }),
    /simulated network failure/
  );
  assert.equal(page.getNativeCallCount(), 1);
});

test("reports requested and server-resolved model metadata", async () => {
  const page = makePage();
  await page.window.fetch(endpoint, { method: "POST", body: JSON.stringify(makePayload()) });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(page.getLogs().some(line =>
    line.includes("HTTP 200 | requested: gpt-5.6-luna-wm | resolved: gpt-5.6-luna-wm")
  ));
});
