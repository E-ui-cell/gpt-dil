import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../userscripts/block-dil.user.js", import.meta.url),
  "utf8",
);

const endpoint = "https://chatgpt.com/backend-api/f/conversation";

function makePage(responseFactory) {
  const calls = [];
  const nativeFetch = async function(input, init) {
    calls.push({ input, init });
    return responseFactory();
  };

  const window = { fetch: nativeFetch };
  const context = {
    window,
    URL,
    Request,
    Response,
    Headers,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    console: {
      info() {},
      warn() {}
    }
  };

  vm.runInNewContext(source, context);
  return { window, calls, nativeFetch };
}

test("removes model_dil_v2 from JSON while preserving fallback markdown", async () => {
  const page = makePage(() => new Response(JSON.stringify({
    message: {
      metadata: {
        model_dil_v2: {
          code: "DIL.render(...)",
          constants: { "0": "Rendered text" },
          fallbackMarkdown: "Fallback text"
        },
        keep: "metadata"
      }
    }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));

  const response = await page.window.fetch(endpoint);
  const data = await response.json();

  assert.equal(data.message.metadata.model_dil_v2, undefined);
  assert.equal(data.message.metadata.keep, "metadata");
  assert.equal(data.message.metadata.model_dil_v2?.fallbackMarkdown, undefined);
  assert.equal(response.status, 200);
});

test("removes DIL metadata from SSE events and preserves other event data", async () => {
  const page = makePage(() => new Response([
    'data: {"message":{"metadata":{"model_dil_v2":{"fallbackMarkdown":"Fallback"},"other":1}}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  }));

  const response = await page.window.fetch(endpoint);
  const text = await response.text();

  assert.match(text, /"other":1/);
  assert.doesNotMatch(text, /model_dil_v2/);
  assert.match(text, /data: \[DONE\]/);
});

test("does not modify unrelated endpoints", async () => {
  const page = makePage(() => new Response("unchanged", {
    headers: { "content-type": "text/plain" }
  }));

  const response = await page.window.fetch("https://chatgpt.com/backend-api/models");
  assert.equal(await response.text(), "unchanged");
});

test("stop restores the original fetch hook", () => {
  const page = makePage(() => new Response("{}"));
  page.window.__GPT_DIL_BLOCKER__.stop();
  assert.equal(page.window.fetch, page.nativeFetch);
});
