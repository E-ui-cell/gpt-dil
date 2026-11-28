import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../userscripts/terminal-mode.user.js", import.meta.url),
  "utf8",
);

function makePage() {
  let nativeCall;
  const window = {
    fetch: async function(...args) {
      nativeCall = args;
      return { ok: true };
    },
  };

  class FakeXMLHttpRequest {
    open(method, url, ...rest) {
      this.method = method;
      this.url = url;
      this.openArgs = rest;
      return "opened";
    }
    send(body) {
      this.sentBody = body;
      return "sent";
    }
  }

  const nativeFetch = window.fetch;
  const nativeOpen = FakeXMLHttpRequest.prototype.open;
  const nativeSend = FakeXMLHttpRequest.prototype.send;
  const context = {
    window,
    location: { href: "https://chatgpt.com/" },
    URL,
    Request,
    XMLHttpRequest: FakeXMLHttpRequest,
    WeakMap,
    console: { info() {}, warn() {} },
  };
  vm.runInNewContext(source, context);
  return {
    window,
    XMLHttpRequest: FakeXMLHttpRequest,
    getNativeCall: () => nativeCall,
    nativeFetch,
    nativeOpen,
    nativeSend,
    context,
  };
}

function makePayload() {
  return {
    messages: [
      { author: { role: "system" }, content: { content_type: "text", parts: ["system"] } },
      { author: { role: "user" }, content: { content_type: "text", parts: ["older prompt"] } },
      { author: { role: "assistant" }, content: { content_type: "text", parts: ["prior answer"] } },
      { author: { role: "user" }, content: { content_type: "text", parts: ["latest prompt"] } },
    ],
    conversation_id: "test-conversation",
    metadata: { source: "test" },
    system_hints: ["native-hint"],
  };
}

function assertModifiedPayload(rawBody) {
  const result = JSON.parse(rawBody);
  const latest = result.messages[3].content.parts[0];

  assert.equal(result.messages[0].content.parts[0], "system");
  assert.equal(result.messages[1].content.parts[0], "older prompt");
  assert.equal(result.messages[2].content.parts[0], "prior answer");
  assert.ok(latest.startsWith("latest prompt\n\nTERMINAL MODE: respond using plain, unformatted text only."));
  assert.match(latest, /no headings, bullets, numbered lists, tables/);
  assert.match(latest, /raw text, without code fences/);
  assert.equal(result.conversation_id, "test-conversation");
  assert.deepEqual(result.system_hints, ["native-hint"]);
  assert.deepEqual(Object.keys(result).sort(), ["conversation_id", "messages", "metadata", "system_hints"]);
  assert.equal(result.__plainTextModified, undefined);
  return result;
}

test("appends terminal-mode instruction only to the latest user message", async () => {
  const page = makePage();
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makePayload()),
  });

  const call = page.getNativeCall();
  assert.equal(call[0], "https://chatgpt.com/backend-api/f/conversation");
  assertModifiedPayload(call[1].body);
});

test("supports Request input and the legacy conversation route", async () => {
  const page = makePage();
  const request = new Request("https://chatgpt.com/backend-api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test": "preserved" },
    body: JSON.stringify(makePayload()),
  });

  await page.window.fetch(request);
  const call = page.getNativeCall();
  assert.ok(call[0] instanceof Request);
  assert.equal(call[0].url, request.url);
  assert.equal(call[0].headers.get("x-test"), "preserved");
  assertModifiedPayload(await call[0].clone().text());
});

test("supports the conversation prepare route", async () => {
  const page = makePage();
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation/prepare", {
    method: "POST",
    body: JSON.stringify(makePayload()),
  });
  assertModifiedPayload(page.getNativeCall()[1].body);
});

test("does not append the instruction twice", async () => {
  const page = makePage();
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify(makePayload()),
  });
  const firstBody = page.getNativeCall()[1].body;

  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: firstBody,
  });
  const secondBody = page.getNativeCall()[1].body;
  assert.equal(secondBody, firstBody);
});

test("passes unrelated requests and non-POST requests through unchanged", async () => {
  const page = makePage();
  const unrelatedInit = { method: "POST", body: JSON.stringify(makePayload()) };
  await page.window.fetch("https://chatgpt.com/backend-api/models", unrelatedInit);
  assert.equal(page.getNativeCall()[1], unrelatedInit);

  const getInit = { method: "GET" };
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", getInit);
  assert.equal(page.getNativeCall()[1], getInit);
});

test("passes unknown conversation payload shapes through unchanged", async () => {
  const page = makePage();
  const rawBody = JSON.stringify({ messages: [{ role: "user", content: "unknown schema" }] });
  const init = { method: "POST", body: rawBody };

  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", init);
  assert.equal(page.getNativeCall()[1], init);
});

test("supports XMLHttpRequest conversation posts", () => {
  const page = makePage();
  const xhr = new page.XMLHttpRequest();
  xhr.open("POST", "https://chatgpt.com/backend-api/f/conversation");
  const result = xhr.send(JSON.stringify(makePayload()));

  assert.equal(result, "sent");
  assertModifiedPayload(xhr.sentBody);
});

test("stop restores the original fetch and XHR methods", () => {
  const page = makePage();
  const wrappedFetch = page.window.fetch;
  const wrappedOpen = page.XMLHttpRequest.prototype.open;
  const wrappedSend = page.XMLHttpRequest.prototype.send;
  const instance = page.window.__GPT_DIL_TERMINAL_MODE__;

  assert.equal(instance.enabled, true);
  instance.stop();
  assert.notEqual(page.window.fetch, wrappedFetch);
  assert.notEqual(page.XMLHttpRequest.prototype.open, wrappedOpen);
  assert.notEqual(page.XMLHttpRequest.prototype.send, wrappedSend);
  assert.equal(page.window.fetch, page.nativeFetch);
  assert.equal(page.XMLHttpRequest.prototype.open, page.nativeOpen);
  assert.equal(page.XMLHttpRequest.prototype.send, page.nativeSend);
  assert.equal(page.window.__GPT_DIL_TERMINAL_MODE__, undefined);
  assert.equal(page.window.__GPT_DIL_TERMINAL_MODE_VERSION__, undefined);

  vm.runInNewContext(source, page.context);
  assert.notEqual(page.window.fetch, page.nativeFetch);
  assert.equal(page.window.__GPT_DIL_TERMINAL_MODE__.enabled, true);
});

test("toggle disables and re-enables request modification", async () => {
  const page = makePage();
  const instance = page.window.__GPT_DIL_TERMINAL_MODE__;
  assert.equal(instance.toggle(), false);

  const init = { method: "POST", body: JSON.stringify(makePayload()) };
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", init);
  assert.equal(page.getNativeCall()[1], init);

  assert.equal(instance.toggle(), true);
  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", init);
  assertModifiedPayload(page.getNativeCall()[1].body);
});
