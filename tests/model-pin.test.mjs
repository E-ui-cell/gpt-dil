import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../userscripts/model-pin.user.js", import.meta.url),
  "utf8",
);

const endpoint = "https://chatgpt.com/backend-api/f/conversation";
const initEndpoint = "https://chatgpt.com/backend-api/conversation/init";

function makePage() {
  const calls = [];
  const logs = [];
  const FakeXHR = class FakeXHR {};

  const nativeFetch = async function(input, init) {
    calls.push({ input, init });
    if (String(input?.url || input).includes("/conversation/init")) {
      return new Response(JSON.stringify({
        default_model_slug: "auto",
        intended_default_model_slug: "auto",
        other: "preserved"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      resolved_model_slug: "gpt-5.6-luna-wm",
      model_slug: "gpt-5.6-luna-wm"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const window = { fetch: nativeFetch };
  const context = {
    window,
    URL,
    Request,
    Response,
    Headers,
    XMLHttpRequest: FakeXHR,
    console: {
      info(...args) { logs.push(args.join(" ")); },
      warn(...args) { logs.push(args.join(" ")); },
      groupCollapsed(...args) { logs.push(args.join(" ")); },
      groupEnd() {}
    }
  };

  vm.runInNewContext(source, context);
  return {
    window,
    calls,
    logs,
    originalFetch: nativeFetch
  };
}

function payload(extra = {}) {
  return {
    action: "next",
    model: "auto",
    messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["test"] } }],
    untouched: { keep: true },
    ...extra
  };
}

test("pins outgoing model, model_slug, effort and native reason hint", async () => {
  const page = makePage();
  await page.window.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload({ system_hints: ["existing"] }))
  });

  const sent = JSON.parse(page.calls[0].init.body);
  assert.equal(sent.model, "gpt-5.6-luna-wm");
  assert.equal(sent.model_slug, "auto");
  assert.equal(sent.thinking_effort, "extended");
  assert.deepEqual(sent.system_hints, ["existing", "reason"]);
  assert.deepEqual(sent.untouched, { keep: true });
});

test("rewrites conversation/init default model fields and preserves other data", async () => {
  const page = makePage();
  const response = await page.window.fetch(initEndpoint, { method: "POST" });
  const data = await response.json();

  assert.equal(data.default_model_slug, "gpt-5.6-luna-wm");
  assert.equal(data.intended_default_model_slug, "gpt-5.6-luna-wm");
  assert.equal(data.other, "preserved");
});

test("observes resolved model metadata without exposing response text", async () => {
  const page = makePage();
  await page.window.fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(payload())
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.ok(page.logs.some(line => line.includes("resolved_model_slug")));
});

test("leaves unrelated endpoints unchanged", async () => {
  const page = makePage();
  const init = { method: "POST", body: JSON.stringify(payload()) };

  await page.window.fetch("https://chatgpt.com/backend-api/models", init);
  assert.equal(page.calls[0].init, init);
});

test("leaves unsupported conversation request bodies unchanged", async () => {
  const page = makePage();
  const rawBody = JSON.stringify({ messages: [{ role: "user", content: "unknown shape" }] });
  const init = { method: "POST", body: rawBody };

  await page.window.fetch(endpoint, init);
  assert.equal(page.calls[0].init, init);
});

test("supports Request input without consuming the original Request", async () => {
  const page = makePage();
  const request = new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload())
  });

  await page.window.fetch(request);
  const sent = page.calls[0].input;
  const data = JSON.parse(await sent.clone().text());

  assert.ok(sent instanceof Request);
  assert.equal(data.model, "gpt-5.6-luna-wm");
  assert.equal(data.thinking_effort, "extended");
  assert.equal(request.bodyUsed, false);
});

test("stop restores the original fetch hook", () => {
  const page = makePage();
  const controller = page.window.__GPT_DIL_LUNA_MODEL_PIN__;
  assert.equal(controller.target, "gpt-5.6-luna-wm");
  controller.stop();
  assert.equal(page.window.fetch, page.originalFetch);
});
