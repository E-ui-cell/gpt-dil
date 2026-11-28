import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../userscripts/plain-text-payload.user.js", import.meta.url),
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
  const context = {
    window,
    location: { href: "https://chatgpt.com/" },
    URL,
    Request,
    WeakMap,
    console: { info() {}, warn() {} },
  };
  vm.runInNewContext(source, context);
  return { window, getNativeCall: () => nativeCall };
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
  };
}

function assertModifiedPayload(rawBody) {
  const result = JSON.parse(rawBody);
  assert.equal(result.messages[0].content.parts[0], "system");
  assert.equal(result.messages[1].content.parts[0], "older prompt");
  assert.equal(result.messages[3].content.parts[0].startsWith("latest prompt\n\n"), true);
  assert.equal(result.conversation_id, "test-conversation");
  assert.deepEqual(Object.keys(result).sort(), ["conversation_id", "messages", "metadata"]);
  assert.equal(result.__plainTextModified, undefined);
  return result;
}

test("appends the editable payload to only the latest user message (string fetch body)", async () => {
  const page = makePage();
  const payload = makePayload();

  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const call = page.getNativeCall();
  assert.equal(call[0], "https://chatgpt.com/backend-api/f/conversation");
  assertModifiedPayload(call[1].body);
});

test("supports Request input and the legacy conversation route", async () => {
  const page = makePage();
  const request = new Request("https://chatgpt.com/backend-api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makePayload()),
  });

  await page.window.fetch(request);
  const call = page.getNativeCall();
  assert.ok(call[0] instanceof Request);
  assert.equal(call[0].url, request.url);
  assertModifiedPayload(await call[0].clone().text());
});

test("passes unrelated requests through unchanged", async () => {
  const page = makePage();
  const init = { method: "POST", body: JSON.stringify(makePayload()) };

  await page.window.fetch("https://chatgpt.com/backend-api/models", init);

  const call = page.getNativeCall();
  assert.equal(call[0], "https://chatgpt.com/backend-api/models");
  assert.equal(call[1], init);
});

test("passes unknown conversation payload shapes through unchanged", async () => {
  const page = makePage();
  const rawBody = JSON.stringify({ messages: [{ role: "user", content: "not the known schema" }] });
  const init = { method: "POST", body: rawBody };

  await page.window.fetch("https://chatgpt.com/backend-api/f/conversation", init);

  assert.equal(page.getNativeCall()[1], init);
});
