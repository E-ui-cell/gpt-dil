import { chromium } from "playwright";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile, appendFile } from "node:fs/promises";

const CDP_URL = process.env.GPT_DIL_CDP_URL || "http://127.0.0.1:9222";
const BASE_DIR = path.resolve(
  process.env.GPT_DIL_LOCAL_OUTPUT_DIR ||
    path.join(process.env.USERPROFILE || process.cwd(), "Documents", "GPT-DIL-Captures"),
);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = path.join(BASE_DIR, "capture-" + RUN_ID);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const ALLOWED_HOSTS = ["chatgpt.com", "openai.com", "oaiusercontent.com", "oaistatic.com"];

const startedAt = new Date();
const network = [];
const websocketRecords = [];
const consoleEvents = [];
const pending = new Set();
const requestRecords = new WeakMap();
const pages = new Set();

let browser;
let context;
let sequence = 0;
let stopping = false;
let stopReason = "running";

function isRelevant(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname;
    return ALLOWED_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
  } catch {
    return false;
  }
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").map((part) => {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ":uuid";
      if (/^(?:sess(?:ion)?|conv(?:ersation)?|thread|user|message|msg|file|upload)[-_][A-Za-z0-9_-]{12,}$/i.test(part)) return ":id";
      if (/^[A-Za-z0-9_-]{48,}$/.test(part)) return ":opaque";
      return part;
    });
    return url.origin + parts.join("/") +
      (url.searchParams.size ? "?" + [...new Set(url.searchParams.keys())].sort().join("&") : "");
  } catch {
    return "[invalid-url]";
  }
}

function redactText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[SECRET]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]")
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key|signature|sig)=)[^&\s]+/gi, "$1[REDACTED]");
}

const SECRET_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|csrf(?:[_-]?token)?|xsrf|sentinel|proof[_-]?token|token|email)$/i;

function redactObject(value, depth = 0) {
  if (depth > 30) return "[DEPTH-LIMIT]";
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key)
        ? "[REDACTED]"
        : redactObject(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

function sanitizeBody(raw, contentType) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (/multipart\/form-data/i.test(contentType)) {
    const names = [...text.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    return {
      kind: "multipart-metadata",
      bytes: Buffer.byteLength(text),
      fieldNames: [...new Set(names)],
      values: "not exported",
      reason: "file/form content can contain unrelated private documents",
    };
  }

  if (/json|\+json/i.test(contentType)) {
    try {
      return redactObject(JSON.parse(text));
    } catch {
      return redactText(text);
    }
  }

  if (/x-www-form-urlencoded/i.test(contentType)) {
    const output = {};
    for (const [key, value] of new URLSearchParams(text)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactText(value);
    }
    return output;
  }

  if (/text\/event-stream|ndjson/i.test(contentType)) {
    return text.split(/\r?\n/).map((line) => {
      if (!line.startsWith("data:")) return redactText(line);
      const data = line.slice(5).trim();
      try {
        return "data: " + JSON.stringify(redactObject(JSON.parse(data)));
      } catch {
        return "data: " + redactText(data);
      }
    }).join("\n");
  }

  return redactText(text);
}

function bodyExtension(contentType) {
  if (/json|\+json/i.test(contentType)) return "json";
  if (/text\/event-stream|ndjson/i.test(contentType)) return "stream.txt";
  if (/text\//i.test(contentType)) return "txt";
  return "bin";
}

async function saveBody(kind, id, raw, contentType) {
  if (raw == null) return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  if (buffer.length > MAX_BODY_BYTES) {
    return { skipped: "over-size-limit", bytes: buffer.length };
  }
  const extension = bodyExtension(contentType);
  const directory = path.join(OUTPUT_DIR, kind);
  await mkdir(directory, { recursive: true });

  if (extension === "bin") {
    return { skipped: "binary-body-not-exported", bytes: buffer.length };
  }

  const safe = sanitizeBody(buffer, contentType);
  const output = extension === "json" && typeof safe !== "string"
    ? JSON.stringify(safe, null, 2)
    : String(safe);
  const filename = String(id).padStart(6, "0") + "." + extension;
  const filePath = path.join(directory, filename);
  await writeFile(filePath, output, "utf8");
  return path.posix.join(kind, filename);
}

function requestContentType(request) {
  try {
    return request.headers()["content-type"] || "";
  } catch {
    return "";
  }
}

function addPending(promise) {
  pending.add(promise);
  promise
    .catch((error) => {
      consoleEvents.push({
        type: "capture-error",
        message: redactText(error?.message || error),
        at: new Date().toISOString(),
      });
    })
    .finally(() => pending.delete(promise));
}

async function recordRequest(request) {
  if (!isRelevant(request.url())) return;
  const id = ++sequence;
  const url = safeUrl(request.url());
  const contentType = requestContentType(request);
  const record = {
    id,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    type: "request",
    method: request.method(),
    url,
    resourceType: request.resourceType(),
    navigation: request.isNavigationRequest(),
    requestHeaderNames: [],
    requestContentType: contentType || null,
  };

  try {
    record.requestHeaderNames = Object.keys(await request.allHeaders()).sort();
  } catch {}

  try {
    const body = request.postDataBuffer();
    if (body && body.length) {
      record.requestBytes = body.length;
      record.requestBody = await saveBody("requests", id, body, contentType);
    }
  } catch (error) {
    record.requestBodyError = redactText(error?.message || error);
  }

  network.push(record);
  requestRecords.set(request, record);
}

async function recordResponse(response) {
  const request = response.request();
  const record = requestRecords.get(request);
  if (!record) return;

  record.status = response.status();
  record.responseAt = new Date().toISOString();
  record.durationMs = Date.now() - startedAt.getTime() - record.elapsedMs;

  let headers = {};
  try {
    headers = await response.allHeaders();
  } catch {}

  const contentType = headers["content-type"] || "";
  record.responseContentType = contentType || null;
  record.responseHeaderNames = Object.keys(headers).sort();
  for (const name of ["content-length", "cache-control", "content-encoding", "server"]) {
    if (headers[name]) record[name.replace(/-/g, "_")] = headers[name];
  }

  if (!/(?:json|\\+json|text\\/event-stream|application\\/x-ndjson|text\\/plain|application\\/xml)/i.test(contentType)) {
    record.responseBody = { skipped: "non-text-response", contentType };
    return;
  }

  const declared = Number(headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) {
    record.responseBody = { skipped: "over-size-limit", bytes: declared };
    return;
  }

  try {
    const body = await response.body();
    record.responseBytes = body.length;
    record.responseBody = await saveBody("responses", record.id, body, contentType);
  } catch (error) {
    record.responseBodyError = redactText(error?.message || error);
  }
}

async function savePageSnapshot(page, reason) {
  if (page.isClosed()) return;
  try {
    const snapshot = await page.evaluate(async () => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach((script) => script.remove());
      clone.querySelectorAll("input, textarea").forEach((field) => {
        field.removeAttribute("value");
        field.textContent = "";
      });
      clone.querySelectorAll(
        'meta[name*="token" i], meta[name*="csrf" i], meta[property*="token" i]',
      ).forEach((meta) => meta.remove());
      clone.querySelectorAll("*").forEach((element) => {
        for (const attribute of [...element.attributes]) {
          if (/^(?:nonce|value|.*authorization.*|data-.*(?:token|session|csrf))$/i.test(attribute.name)) {
            element.removeAttribute(attribute.name);
          }
        }
        for (const name of ["src", "href"]) {
          const value = element.getAttribute(name);
          if (!value) continue;
          try {
            const url = new URL(value, location.href);
            element.setAttribute(name, url.origin + url.pathname);
          } catch {}
        }
      });

      let databases = [];
      try {
        databases = (await indexedDB.databases()).map((db) => ({
          name: db.name,
          version: db.version,
        }));
      } catch {}

      return {
        title: document.title,
        url: location.origin + location.pathname,
        readyState: document.readyState,
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        html: "<!doctype html>" + clone.outerHTML,
        scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
        localStorageKeys: (() => {
          try { return Object.keys(localStorage).sort(); } catch { return []; }
        })(),
        sessionStorageKeys: (() => {
          try { return Object.keys(sessionStorage).sort(); } catch { return []; }
        })(),
        indexedDB: databases,
        resources: performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
          decodedBodySize: entry.decodedBodySize || 0,
        })),
      };
    });

    const number = String(Date.now());
    const directory = path.join(OUTPUT_DIR, "snapshots");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, number + ".html"), snapshot.html, "utf8");
    delete snapshot.html;
    snapshot.url = safeUrl(snapshot.url);
    snapshot.scripts = snapshot.scripts.map(safeUrl);
    snapshot.resources = snapshot.resources.map((item) => ({
      ...item,
      name: safeUrl(item.name),
    }));
    snapshot.reason = reason;
    snapshot.at = new Date().toISOString();
    await writeFile(path.join(directory, number + ".json"), JSON.stringify(snapshot, null, 2));
  } catch (error) {
    consoleEvents.push({
      type: "snapshot-error",
      message: redactText(error?.message || error),
      at: new Date().toISOString(),
    });
  }
}

function attachPage(page) {
  if (pages.has(page)) return;
  pages.add(page);

  page.on("websocket", (socket) => {
    const entry = {
      url: safeUrl(socket.url()),
      openedAt: new Date().toISOString(),
      sentFrames: 0,
      receivedFrames: 0,
      frameLog: null,
    };
    websocketRecords.push(entry);

    const frameDir = path.join(OUTPUT_DIR, "websockets");
    const frameName = String(websocketRecords.length).padStart(4, "0") + ".jsonl";
    entry.frameLog = path.posix.join("websockets", frameName);

    const recordFrame = async (direction, frame) => {
      const payload = frame.payload;
      const isBinary = Buffer.isBuffer(payload);
      const text = isBinary ? null : String(payload);
      let value;
      if (isBinary) {
        value = { kind: "binary", bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
      } else {
        try {
          value = redactObject(JSON.parse(text));
        } catch {
          value = redactText(text);
        }
      }

      if (direction === "sent") entry.sentFrames++;
      else entry.receivedFrames++;

      await mkdir(frameDir, { recursive: true });
      await appendFile(
        path.join(frameDir, frameName),
        JSON.stringify({ at: new Date().toISOString(), direction, value }) + "\n",
        "utf8",
      );
    };

    socket.on("framesent", (frame) => addPending(recordFrame("sent", frame)));
    socket.on("framereceived", (frame) => addPending(recordFrame("received", frame)));
    socket.on("close", () => { entry.closedAt = new Date().toISOString(); });
  });

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleEvents.push({
        type: message.type(),
        message: redactText(message.text()),
        at: new Date().toISOString(),
      });
    }
  });

  page.on("pageerror", (error) => {
    consoleEvents.push({
      type: "page-error",
      message: redactText(error?.message || error),
      at: new Date().toISOString(),
    });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) addPending(savePageSnapshot(page, "navigation"));
  });
}

async function writeReport() {
  await Promise.allSettled([...pending]);
  await mkdir(OUTPUT_DIR, { recursive: true });

  let cookies = [];
  try {
    cookies = (await context.cookies()).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  } catch {}

  await writeFile(path.join(OUTPUT_DIR, "network.json"), JSON.stringify(network, null, 2));
  await writeFile(path.join(OUTPUT_DIR, "websockets.json"), JSON.stringify(websocketRecords, null, 2));
  await writeFile(path.join(OUTPUT_DIR, "console.json"), JSON.stringify(consoleEvents, null, 2));
  await writeFile(path.join(OUTPUT_DIR, "cookies-metadata.json"), JSON.stringify(cookies, null, 2));

  const report = {
    captureType: "local-authenticated-browser",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stopReason,
    browserVersion: browser.version(),
    requests: network.length,
    responses: network.filter((item) => item.status !== undefined).length,
    requestBodies: network.filter((item) => item.requestBody && typeof item.requestBody === "string").length,
    responseBodies: network.filter((item) => item.responseBody && typeof item.responseBody === "string").length,
    websocketConnections: websocketRecords.length,
    websocketFrames: websocketRecords.reduce((sum, item) => sum + item.sentFrames + item.receivedFrames, 0),
    pagesObserved: pages.size,
    privacy: {
      outputIsLocalOnly: true,
      authorizationAndCookieHeaderValues: "never recorded",
      cookieValues: "never recorded",
      localAndSessionStorageValues: "never recorded; key names only",
      indexedDBValues: "never recorded; database names and versions only",
      requestAndResponseBodies: "captured with credential-like JSON fields redacted",
      conversationContent: "included; this folder is private and must not be uploaded publicly",
      multipartValuesAndFileContents: "not recorded",
    },
  };

  await writeFile(path.join(OUTPUT_DIR, "capture.json"), JSON.stringify(report, null, 2));
  await writeFile(
    path.join(OUTPUT_DIR, "README.txt"),
    [
      "GPT-DIL LOCAL AUTHENTICATED CAPTURE",
      "",
      "This capture can contain private conversations and message attachments metadata.",
      "Keep this folder on your own machine. Do not upload it to the public GitHub repository or Releases.",
      "",
      "requests/: request payloads with credential-like fields redacted",
      "responses/: JSON, text and streaming response bodies with credential-like fields redacted",
      "websockets/: sent and received WebSocket frames",
      "snapshots/: sanitized DOM snapshots and browser/storage metadata",
      "network.json: request/response index and timing",
      "websockets.json: WebSocket connection summary",
      "cookies-metadata.json: cookie names and attributes only; no values",
      "console.json: browser warnings and errors",
      "capture.json: run summary and privacy boundaries",
      "",
      "Authorization and cookie header values are never recorded.",
      "Conversation text is intentionally preserved for protocol analysis.",
    ].join("\n"),
    "utf8",
  );
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  browser = await chromium.connectOverCDP(CDP_URL);
  context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome browser context was found on the debugging port.");

  context.on("page", attachPage);
  context.on("request", (request) => addPending(recordRequest(request)));
  context.on("response", (response) => addPending(recordResponse(response)));
  context.on("requestfailed", (request) => {
    const record = requestRecords.get(request);
    if (record) record.failure = redactText(request.failure()?.errorText || "request failed");
  });

  for (const page of context.pages()) attachPage(page);

  let page = context.pages().find((item) => {
    try { return new URL(item.url()).hostname.endsWith("chatgpt.com"); } catch { return false; }
  });

  if (!page) {
    page = await context.newPage();
    attachPage(page);
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((error) => {
      consoleEvents.push({ type: "navigation-error", message: redactText(error?.message || error) });
    });
  }

  await savePageSnapshot(page, "capture-start");
  console.log("GPT-DIL local capture is running.");
  console.log("Use ChatGPT normally in the dedicated Chrome window. Press Ctrl+C here to stop.");
  console.log("Output: " + OUTPUT_DIR);

  await new Promise((resolve) => {
    const stop = async (signal) => {
      if (stopping) return;
      stopping = true;
      stopReason = signal;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve();
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });

  for (const pageItem of pages) {
    if (!pageItem.isClosed()) await savePageSnapshot(pageItem, "capture-stop");
  }
  await writeReport();
  console.log("Capture saved: " + OUTPUT_DIR);
  await browser.close();
}

main().catch(async (error) => {
  console.error("GPT-DIL local capture failed:", redactText(error?.stack || error?.message || error));
  process.exitCode = 1;
  if (context) {
    try { await writeReport(); } catch {}
  }
});
