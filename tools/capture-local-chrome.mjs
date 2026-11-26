import { chromium } from "playwright";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { sanitizePayload, sanitizeProtocolBody, sanitizeText as sanitizePayloadText } from "./payload-sanitizer.mjs";

const CDP_URL = process.env.GPT_DIL_CDP_URL || "http://127.0.0.1:9222";
const BASE_DIR = path.resolve(
  process.env.GPT_DIL_LOCAL_OUTPUT_DIR ||
    path.join(process.env.USERPROFILE || process.cwd(), "Documents", "GPT-DIL-Captures"),
);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = path.join(BASE_DIR, "capture-" + RUN_ID);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_DIL_BRIDGE_EVENTS = 50000;
const MAX_DIL_BRIDGE_LOG_BYTES = 64 * 1024 * 1024;
const MAX_DIL_BRIDGE_EVENT_BYTES = 256 * 1024;
const MAX_FINALIZE_WAIT_MS = 15000;
const ALLOWED_HOSTS = ["chatgpt.com", "openai.com", "oaiusercontent.com", "oaistatic.com"];

const startedAt = new Date();
const network = [];
const websocketRecords = [];
const frameLifecycleEvents = [];
const consoleEvents = [];
const pending = new Set();
const requestRecords = new WeakMap();
const pages = new Set();
const dilBridgeLogLines = [];
let dilBridgeLogBytes = 0;
let dilBridgeDroppedEvents = 0;
let dilBridgeHookSource = "";

let browser;
let context;
let browserVersion = "unknown";
let requestStop;
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
  return sanitizePayloadText(value);
}

function redactObject(value, depth = 0) {
  return sanitizePayload(value, depth);
}

function sanitizeBody(raw, contentType) {
  return sanitizeProtocolBody(raw, contentType);
}

function bodyExtension(contentType) {
  if (/multipart\/form-data|x-www-form-urlencoded/i.test(contentType)) return "json";
  if (/json|\+json/i.test(contentType)) return "json";
  if (/text\/event-stream|ndjson/i.test(contentType)) return "stream.txt";
  if (/text\//i.test(contentType)) return "txt";
  if (/application\/(?:xml|graphql)/i.test(contentType)) return "txt";
  return "bin";
}
async function saveBinaryResponse(id, raw, contentType) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buffer.length > MAX_BODY_BYTES) {
    return { skipped: "over-size-limit", bytes: buffer.length };
  }
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "application/pdf": "pdf",
    "application/zip": "zip",
  };
  const extension = extensions[mime] || "bin";
  const directory = path.join(OUTPUT_DIR, "responses");
  await mkdir(directory, { recursive: true });
  const filename = String(id).padStart(6, "0") + "." + extension;
  await writeFile(path.join(directory, filename), buffer);
  return {
    path: path.posix.join("responses", filename),
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    contentType: mime,
    binary: true,
  };
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

  if (extension === "bin" && !/multipart\/form-data/i.test(contentType)) {
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
  let frameUrl = null;
  try {
    frameUrl = safeUrl(request.frame().url());
  } catch {}
  const record = {
    id,
    frameUrl,
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

  network.push(record);
  requestRecords.set(request, record);

  try {
    record.requestHeaderNames = Object.keys(await request.allHeaders()).sort();
  } catch {}

  try {
    const body = request.postDataBuffer();
    if (body && body.length) {
      record.requestBytes = body.length;
      if (/(?:json|\\+json|x-www-form-urlencoded|multipart\\/form-data|application\\/(?:xml|graphql))/i.test(contentType)) {
        record.requestBody = await saveBody("requests", id, body, contentType);
      } else {
        record.requestBody = {
          kind: "omitted-metadata",
          bytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
          values: "not recorded",
        };
      }
    }
  } catch (error) {
    record.requestBodyError = redactText(error?.message || error);
  }
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
  record.responseHeaders = {};
  for (const name of [
    "content-length",
    "cache-control",
    "content-encoding",
    "server",
    "date",
    "x-request-id",
    "x-openai-request-id",
    "cf-ray",
    "retry-after",
    "server-timing",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  ]) {
    if (headers[name]) record.responseHeaders[name] = redactText(headers[name]);
  }

  const isTextResponse =
    /(?:json|\+json|text\/event-stream|application\/x-ndjson|text\/plain|application\/(?:xml|graphql))/i.test(contentType);
  const isUsefulBinary =
    /^(?:image\/|audio\/|video\/|application\/(?:pdf|octet-stream|zip))/i.test(contentType);

  if (!isTextResponse && !isUsefulBinary) {
    record.responseBody = { skipped: "non-protocol-binary", contentType };
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
    record.responseBody = isTextResponse
      ? await saveBody("responses", record.id, body, contentType)
      : await saveBinaryResponse(record.id, body, contentType);
  } catch (error) {
    record.responseBodyError = redactText(error?.message || error);
  }

  if (/\/conversation(?:\/|$)/i.test(request.url())) {
    for (const page of pages) {
      if (!page.isClosed()) addPending(savePageSnapshot(page, "conversation-response"));
    }
  }
}

async function savePageSnapshot(page, reason) {
  if (page.isClosed()) return;
  try {
    const snapshot = await page.evaluate(async () => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach((script) => script.remove());
      clone.querySelectorAll("input, textarea, select").forEach((field) => {
        if ("value" in field) field.value = "";
        field.removeAttribute("value");
        field.removeAttribute("checked");
        field.removeAttribute("selected");
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

    const frameSnapshots = [];
    for (const [index, frame] of page.frames().entries()) {
      if (index === 0) continue;
      try {
        const frameState = await frame.evaluate(async () => {
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll("script").forEach((script) => script.remove());
          clone.querySelectorAll("input, textarea, select").forEach((field) => {
            if ("value" in field) field.value = "";
            field.removeAttribute("value");
            field.removeAttribute("checked");
            field.removeAttribute("selected");
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
            databases = (await indexedDB.databases()).map((db) => ({ name: db.name, version: db.version }));
          } catch {}
          let serviceWorkers = [];
          try {
            serviceWorkers = (await navigator.serviceWorker.getRegistrations()).map((registration) => registration.scope);
          } catch {}
          return {
            title: document.title,
            url: location.origin + location.pathname,
            readyState: document.readyState,
            scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
            localStorageKeys: (() => { try { return Object.keys(localStorage).sort(); } catch { return []; } })(),
            sessionStorageKeys: (() => { try { return Object.keys(sessionStorage).sort(); } catch { return []; } })(),
            indexedDB: databases,
            serviceWorkers,
            html: "<!doctype html>" + clone.outerHTML,
          };
        });
        const filename = number + "-frame-" + String(index).padStart(2, "0") + ".html";
        await writeFile(path.join(directory, filename), frameState.html, "utf8");
        frameSnapshots.push({
          index,
          name: frame.name(),
          parentUrl: frame.parentFrame() ? safeUrl(frame.parentFrame().url()) : null,
          url: safeUrl(frameState.url),
          title: frameState.title,
          readyState: frameState.readyState,
          scripts: frameState.scripts.map(safeUrl),
          localStorageKeys: frameState.localStorageKeys,
          sessionStorageKeys: frameState.sessionStorageKeys,
          indexedDB: frameState.indexedDB,
          serviceWorkers: frameState.serviceWorkers.map(safeUrl),
          html: path.posix.join("snapshots", filename),
        });
      } catch (error) {
        frameSnapshots.push({
          index,
          name: frame.name(),
          url: safeUrl(frame.url()),
          error: redactText(error?.message || error),
        });
      }
    }

    snapshot.frames = frameSnapshots;
    snapshot.workers = page.workers().map((worker) => safeUrl(worker.url()));
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

async function installBridgeFrame(frame) {
  if (!dilBridgeHookSource) return;
  try { await frame.evaluate(dilBridgeHookSource); } catch {}
}

async function installBridgeHook(page) {
  if (page.isClosed()) return;
  await Promise.all(page.frames().map((frame) => installBridgeFrame(frame)));
}

function attachPage(page) {
  if (pages.has(page)) return;
  pages.add(page);
  addPending(installBridgeHook(page));
  const logFrameLifecycle = (type, frame) => {
    let pageUrl = null;
    let frameUrl = null;
    let name = null;
    try { pageUrl = safeUrl(page.url()); } catch {}
    try { frameUrl = safeUrl(frame.url()); } catch {}
    try { name = redactText(frame.name()); } catch {}
    frameLifecycleEvents.push({
      type,
      at: new Date().toISOString(),
      pageUrl,
      frameUrl,
      name,
    });
  };
  page.on("frameattached", (frame) => {
    logFrameLifecycle("attached", frame);
    addPending(installBridgeFrame(frame));
  });
  page.on("framenavigated", (frame) => logFrameLifecycle("navigated", frame));
  page.on("framedetached", (frame) => logFrameLifecycle("detached", frame));

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
    addPending(installBridgeFrame(frame));
    if (frame === page.mainFrame()) addPending(savePageSnapshot(page, "navigation"));
  });
}

async function waitForPending(timeoutMs = MAX_FINALIZE_WAIT_MS) {
  const tasks = [...pending];
  if (!tasks.length) return { settled: true, pending: 0 };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([
    Promise.allSettled(tasks).then(() => true),
    timeout,
  ]);
  clearTimeout(timer);
  return { settled, pending: pending.size };
}

async function writeReport() {
  const drain = await waitForPending();
  if (!drain.settled) {
    consoleEvents.push({
      type: "finalize-timeout",
      pendingTasks: drain.pending,
      waitMs: MAX_FINALIZE_WAIT_MS,
      at: new Date().toISOString(),
    });
  }
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
  await writeFile(path.join(OUTPUT_DIR, "frame-lifecycle.json"), JSON.stringify(frameLifecycleEvents, null, 2));
  await writeFile(path.join(OUTPUT_DIR, "websockets.json"), JSON.stringify(websocketRecords, null, 2));
  await writeFile(path.join(OUTPUT_DIR, "console.json"), JSON.stringify(consoleEvents, null, 2));
  await writeFile(path.join(OUTPUT_DIR, "cookies-metadata.json"), JSON.stringify(cookies, null, 2));
  await writeFile(
    path.join(OUTPUT_DIR, "dil-bridge.jsonl"),
    dilBridgeLogLines.length ? dilBridgeLogLines.join("\n") + "\n" : "",
    "utf8",
  );

  const report = {
    captureType: "local-authenticated-browser",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    stopReason,
    browserVersion,
    requests: network.length,
    responses: network.filter((item) => item.status !== undefined).length,
    requestBodies: network.filter((item) => item.requestBody && typeof item.requestBody === "string").length,
    omittedRequestBodies: network.filter((item) => item.requestBody?.kind === "omitted-metadata").length,
    responseBodies: network.filter((item) => item.responseBody && (typeof item.responseBody === "string" || item.responseBody.path)).length,
    binaryResponseBodies: network.filter((item) => item.responseBody?.binary).length,
    websocketConnections: websocketRecords.length,
    websocketFrames: websocketRecords.reduce((sum, item) => sum + item.sentFrames + item.receivedFrames, 0),
    dilBridgeMessages: dilBridgeLogLines.length,
    dilBridgeDroppedMessages: dilBridgeDroppedEvents,
    dilBridgeLogBytes: dilBridgeLogBytes,
    pagesObserved: pages.size,
    framesObserved: [...pages].reduce((sum, page) => sum + (page.isClosed() ? 0 : page.frames().length), 0),
    frameLifecycleEvents: frameLifecycleEvents.length,
    workersObserved: [...pages].reduce((sum, page) => sum + (page.isClosed() ? 0 : page.workers().length), 0),
    pendingTasksAtFinalize: pending.size,
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      maxDilBridgeEvents: MAX_DIL_BRIDGE_EVENTS,
      maxDilBridgeLogBytes: MAX_DIL_BRIDGE_LOG_BYTES,
      maxDilBridgeEventBytes: MAX_DIL_BRIDGE_EVENT_BYTES,
      maxFinalizeWaitMs: MAX_FINALIZE_WAIT_MS,
    },
    privacy: {
      outputIsLocalOnly: true,
      authorizationAndCookieHeaderValues: "never recorded",
      cookieValues: "never recorded",
      localAndSessionStorageValues: "never recorded; key names only",
      indexedDBValues: "never recorded; database names and versions only",
      requestAndResponseBodies: "captured with credential-like JSON fields redacted",
      dilBridgePayloads: "Window, MessagePort, Worker, SharedWorker, ServiceWorker and BroadcastChannel messages captured in both directions with sensitive fields redacted",
      conversationContent: "included; this folder is private and must not be uploaded publicly",
      frameSnapshots: "main page and accessible iframe DOM snapshots; scripts and form values removed",
      multipartValuesAndFileContents: "not recorded",
      unstructuredRequestBodies: "size and SHA-256 only; contents not recorded",
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
      "responses/: JSON, text, streaming and selected binary response bodies",
      "Multipart field values and file contents are not recorded; unstructured request bodies are represented by size and SHA-256 only.",
      "websockets/: sent and received WebSocket frames",
      "dil-bridge.jsonl: DIL frame/worker/MessagePort messages in both directions; sensitive fields redacted",
      "snapshots/: sanitized DOM snapshots for the main page and accessible iframes, plus browser/storage metadata",
      "network.json: request/response index and timing",
      "frame-lifecycle.json: iframe attach/navigation/detach timeline",
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
  browserVersion = browser.version();
  context = browser.contexts()[0];
  if (!context) throw new Error("No Chrome browser context was found on the debugging port.");

  dilBridgeHookSource = await readFile(new URL("./dil-bridge-hook.js", import.meta.url), "utf8");
  await context.exposeBinding("__gptDilBridgeEvent", ({ frame, page }, event) => {
    if (stopping || !event || typeof event !== "object") return;
    if (dilBridgeLogLines.length >= MAX_DIL_BRIDGE_EVENTS) {
      dilBridgeDroppedEvents++;
      return;
    }
    try {
      const safeEvent = redactObject(event);
      safeEvent.captureElapsedMs = Date.now() - startedAt.getTime();
      safeEvent.observedAt = new Date().toISOString();
      safeEvent.pageUrl = page ? safeUrl(page.url()) : null;
      safeEvent.frameUrl = frame ? safeUrl(frame.url()) : null;
      const line = JSON.stringify(safeEvent);
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (bytes > MAX_DIL_BRIDGE_EVENT_BYTES || dilBridgeLogBytes + bytes > MAX_DIL_BRIDGE_LOG_BYTES) {
        dilBridgeDroppedEvents++;
        return;
      }
      dilBridgeLogLines.push(line);
      dilBridgeLogBytes += bytes;
    } catch (error) {
      consoleEvents.push({
        type: "dil-bridge-capture-error",
        message: redactText(error?.message || error),
        at: new Date().toISOString(),
      });
    }
  });
  await context.addInitScript({ content: dilBridgeHookSource });

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
  console.log("DIL frame/MessagePort/Worker messages are captured in both directions with sensitive fields redacted.");
  console.log("Use ChatGPT normally in the dedicated Chrome window. Press Ctrl+C here to stop.");
  console.log("Output: " + OUTPUT_DIR);

  await new Promise((resolve) => {
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      stopReason = signal;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve();
    };
    requestStop = stop;
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    browser.on("disconnected", () => stop("browser-disconnected"));
  });

  for (const pageItem of pages) {
    if (!pageItem.isClosed()) await savePageSnapshot(pageItem, "capture-stop");
  }
  await writeReport();
  console.log("Capture saved: " + OUTPUT_DIR);
  requestStop = null;
  await browser.close().catch(() => {});
}

main().catch(async (error) => {
  console.error("GPT-DIL local capture failed:", redactText(error?.stack || error?.message || error));
  process.exitCode = 1;
  if (context) {
    try { await writeReport(); } catch {}
  }
  if (browser) {
    try { await browser.close(); } catch {}
  }
});
