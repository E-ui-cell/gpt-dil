import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizePayload,
  sanitizeProtocolBody,
  sanitizeText,
} from "../tools/payload-sanitizer.mjs";

test("redacts sensitive object keys recursively but preserves protocol values", () => {
  const value = sanitizePayload({
    type: "message",
    message: "hello alice@example.com",
    sessionToken: "private-token",
    nested: [{ authorization: "Bearer private", content: "visible" }],
  });

  assert.equal(value.type, "message");
  assert.equal(value.message, "hello [EMAIL]");
  assert.equal(value.sessionToken, "[REDACTED]");
  assert.equal(value.nested[0].authorization, "[REDACTED]");
  assert.equal(value.nested[0].content, "visible");
});

test("redacts bearer, JWT, API key and token query values in text", () => {
  const input = "Bearer abc.def sk-abcdefghijk https://chatgpt.com/?access_token=secret";
  const output = sanitizeText(input);

  assert.doesNotMatch(output, /abc\\.def|sk-abcdefghijk|access_token=secret/);
  assert.match(output, /Bearer \\[REDACTED\\]/);
  assert.match(output, /access_token=\\[REDACTED\\]/);
});

test("sanitizes JSON event-stream data while preserving event order and done marker", () => {
  const input = [
    "event: message",
    'data: {"type":"delta","session_token":"private","text":"hello"}',
    "",
    "event: done",
    "data: [DONE]",
    "",
  ].join("\\n");
  const output = sanitizeProtocolBody(input, "text/event-stream");

  assert.match(output, /event: message/);
  assert.match(output, /"session_token":"\\[REDACTED\\]"/);
  assert.match(output, /"text":"hello"/);
  assert.match(output, /data: \\[DONE\\]/);
  assert.doesNotMatch(output, /private/);
});

test("captures form field names but never multipart values or file contents", () => {
  const input = [
    'Content-Disposition: form-data; name="prompt"',
    "",
    "private prompt",
    'Content-Disposition: form-data; name="file"; filename="secret.txt"',
    "Content-Type: text/plain",
    "",
    "private file content",
  ].join("\\r\\n");
  const output = sanitizeProtocolBody(input, "multipart/form-data; boundary=abc");

  assert.equal(output.kind, "multipart-metadata");
  assert.deepEqual(output.fieldNames.sort(), ["file", "prompt"]);
  assert.equal(output.fileParts, 1);
  assert.doesNotMatch(JSON.stringify(output), /private prompt|private file content/);
});

test("redacts sensitive URL-encoded fields", () => {
  const output = sanitizeProtocolBody(
    "prompt=hello&session_token=private&mode=anonymous",
    "application/x-www-form-urlencoded",
  );

  assert.deepEqual(output, {
    kind: "form-urlencoded",
    fields: {
      prompt: "hello",
      session_token: "[REDACTED]",
      mode: "anonymous",
    },
  });
});

test("sanitizes NDJSON records that do not use SSE data prefixes", () => {
  const output = sanitizeProtocolBody(
    '{"type":"patch","session_id":"private","value":"visible"}\\n{"type":"done"}',
    "application/x-ndjson",
  );

  assert.match(output, /"session_id":"\\[REDACTED\\]"/);
  assert.match(output, /"value":"visible"/);
  assert.doesNotMatch(output, /private/);
});
