import { chromium, firefox, webkit } from "playwright";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const TARGET_URL = "https://chatgpt.com/";
const BROWSER_NAME = process.env.GPT_DIL_BROWSER || "chromium";
const BROWSER_TYPES = { chromium, firefox, webkit };
const browserType = BROWSER_TYPES[BROWSER_NAME];
if (!browserType) throw new Error("Unsupported browser engine: " + BROWSER_NAME);
const OUTPUT_DIR = path.resolve(process.env.GPT_DIL_OUTPUT_DIR || "capture-output");
const INCLUDE_ASSETS = process.env.GPT_DIL_INCLUDE_ASSETS !== "false";
const INCLUDE_SOURCE_MAPS =
  INCLUDE_ASSETS && process.env.GPT_DIL_INCLUDE_SOURCE_MAPS !== "false";

const MAX_ASSETS = 600;
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 300 * 1024 * 1024;
const MAX_SOURCE_MAPS = 200;
const MAX_JSON_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_EVENT_STREAM_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_SHAPE_BYTES = 4 * 1024 * 1024;
const ALLOWED_ASSET_HOSTS = [
  "chatgpt.com",
  "openai.com",
  "oaiusercontent.com",
  "oaistatic.com",
];

const startedAt = new Date();
const network = [];
const consoleEvents = [];
const websocketRecords = [];
const scriptRecords = new Map();
const endpointCandidates = new Set();
const sourceMapCandidates = new Map();
const assetByHash = new Map();
const pendingResponses = new Set();
const requestRecords = new WeakMap();

let browser;
let totalAssetBytes = 0;
let browserInfo = {};
let pageState = {};
let navigationError = null;
let fatalError = null;

function isRelevantHost(hostname) {
  return ALLOWED_ASSET_HOSTS.some(
    (domain) => hostname === domain || hostname.endsWith("." + domain),
  );
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const safePath = url.pathname
      .split("/")
      .map((part) => {
        if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ":uuid";
        if (/^\d{7,}$/.test(part)) return ":id";
        if (/^(?:sess(?:ion)?|conv(?:ersation)?|thread|user|message|msg|file|upload)[-_][A-Za-z0-9_-]{12,}$/i.test(part)) return ":id";
        if (/^[A-Za-z0-9_-]{36,}$/.test(part) || part.length > 120) return ":opaque";
        return part;
      })
      .join("/");
    const queryKeys = [...new Set(url.searchParams.keys())].sort();
    return (
      url.origin +
      safePath +
      (queryKeys.length
        ? "?" + queryKeys.map((key) => encodeURIComponent(key)).join("&")
        : "")
    );
  } catch {
    return "[invalid-url]";
  }
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[OPAQUE]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => sanitizeUrl(url))
    .slice(0, 1200);
}

function safeKey(key) {
  const value = String(key);
  if (value.length > 80) return "[long-key]";
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return "[uuid-key]";
  if (/^[a-f0-9]{24,}$/i.test(value) || /^[A-Za-z0-9_-]{32,}$/.test(value)) return "[opaque-key]";
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) return "[email-key]";
  return value;
}

function describeShape(value, depth = 0) {
  if (depth >= 7) {
    if (Array.isArray(value)) return { type: "array", truncated: true };
    if (value === null) return "null";
    return typeof value;
  }

  if (value === null) return "null";

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.length ? describeShape(value[0], depth + 1) : "empty",
    };
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const selected = keys.slice(0, 100);
    const properties = {};
    for (const key of selected) {
      properties[safeKey(key)] = describeShape(value[key], depth + 1);
    }
    return {
      type: "object",
      properties,
      ...(keys.length > selected.length ? { truncatedKeys: true } : {}),
    };
  }

  return typeof value;
}

function inspectRequestBody(request) {
  let body;
  try {
    body = request.postData();
  } catch {
    return { kind: "unreadable" };
  }

  if (body == null) return undefined;

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_REQUEST_SHAPE_BYTES) {
    return { kind: "omitted", bytes, reason: "over-size-limit" };
  }

  try {
    const parsed = JSON.parse(body);
    return {
      kind: "json",
      bytes,
      shape: describeShape(parsed),
    };
  } catch {
    return { kind: "non-json", bytes };
  }
}

function addEndpointCandidates(text) {
  const pattern =
    /["']((?:\/backend-api\/|\/(?:api|graphql|ces)\/)[^"'\s\\]*)["']/g;

  for (const match of text.matchAll(pattern)) {
    const endpoint = match[1].replace(/\\u002f/gi, "/").slice(0, 500);
    endpointCandidates.add(endpoint);
  }
}

function addSourceMapCandidates(text, baseUrl) {
  const pattern =
    /(?:\/\/[#@]\s*sourceMappingURL=([^\s*]+)|\/\*[#@]\s*sourceMappingURL=([^*]+)\*\/)/g;

  for (const match of text.matchAll(pattern)) {
    const reference = (match[1] || match[2] || "").trim();
    if (!reference || reference.startsWith("data:")) continue;

    try {
      const resolved = new URL(reference, baseUrl);
      if (resolved.protocol !== "https:" || !isRelevantHost(resolved.hostname)) {
        continue;
      }
      sourceMapCandidates.set(resolved.href, baseUrl);
    } catch {
      // Ignore malformed source map references.
    }
  }
}

async function saveAsset(rawUrl, body, contentType, source) {
  if (!INCLUDE_ASSETS || body.length > MAX_ASSET_BYTES) return null;

  const hash = createHash("sha256").update(body).digest("hex");
  const existing = assetByHash.get(hash);
  const safeUrl = sanitizeUrl(rawUrl);

  if (existing) {
    if (!existing.urls.includes(safeUrl)) existing.urls.push(safeUrl);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    return existing.path;
  }

  if (
    assetByHash.size >= MAX_ASSETS ||
    totalAssetBytes + body.length > MAX_TOTAL_ASSET_BYTES
  ) {
    return null;
  }

  const url = new URL(rawUrl);
  const originalName = path.posix.basename(url.pathname) || "resource";
  const safeName =
    originalName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100) || "resource";
  const relativePath = path.posix.join(
    "assets",
    url.hostname,
    hash.slice(0, 16) + "-" + safeName,
  );
  const absolutePath = path.join(OUTPUT_DIR, ...relativePath.split("/"));

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body);

  const entry = {
    path: relativePath,
    sha256: hash,
    bytes: body.length,
    contentType: contentType || "unknown",
    urls: [safeUrl],
    sources: [source],
  };

  assetByHash.set(hash, entry);
  totalAssetBytes += body.length;
  return relativePath;
}

function isStaticTextAsset(rawUrl, contentType, resourceType) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!isRelevantHost(url.hostname)) return false;

  const pathname = url.pathname.toLowerCase();
  if (
    pathname.startsWith("/backend-api/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/data/") ||
    pathname.startsWith("/ces/") ||
    pathname.includes("/graphql")
  ) {
    return false;
  }

  const hasStaticExtension =
    /\.(?:m?js|css|html|json|map|wasm)$/i.test(pathname);
  const hasCodeMime =
    /javascript|ecmascript|text\/css|text\/html|application\/wasm/i.test(
      contentType,
    );

  if (
    contentType.includes("application/json") &&
    !/\.(?:json|map)$/i.test(pathname)
  ) {
    return false;
  }

  return (
    hasStaticExtension ||
    (hasCodeMime && ["document", "script", "stylesheet"].includes(resourceType))
  );
}

function summarizeEventStream(body) {
  const text = body.toString("utf8");
  const eventTypes = new Map();
  const dataShapes = new Map();
  let currentEvent = "message";
  let eventCount = 0;
  let doneMarker = false;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim() || "message";
      continue;
    }
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      doneMarker = true;
      continue;
    }

    eventCount++;
    eventTypes.set(currentEvent, (eventTypes.get(currentEvent) || 0) + 1);
    let shape;
    try {
      shape = describeShape(JSON.parse(data));
    } catch {
      shape = "string";
    }
    const key = JSON.stringify(shape);
    const existing = dataShapes.get(key);
    if (existing) existing.count++;
    else dataShapes.set(key, { shape, count: 1 });
  }

  return {
    kind: "event-stream",
    bytes: body.length,
    eventCount,
    eventTypes: [...eventTypes.entries()].map(([name, count]) => ({ name, count })),
    dataShapes: [...dataShapes.values()],
    doneMarker,
  };
}

function summarizeWebSocketFrame(frame) {
  const payload = frame?.payload;
  if (Buffer.isBuffer(payload)) {
    return { type: "binary", bytes: payload.length };
  }
  const value = String(payload ?? "");
  try {
    return {
      type: "json",
      bytes: Buffer.byteLength(value, "utf8"),
      shape: describeShape(JSON.parse(value)),
    };
  } catch {
    return {
      type: "text",
      bytes: Buffer.byteLength(value, "utf8"),
    };
  }
}

async function processStaticResponse(response, record) {
  const request = response.request();
  const rawUrl = response.url();
  const headers = await response.allHeaders().catch(() => ({}));
  const contentType = headers["content-type"] || "";
  const resourceType = request.resourceType();

  if (!response.ok()) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return;
  }
  if (!isRelevantHost(parsedUrl.hostname)) return;

  const isStatic = isStaticTextAsset(rawUrl, contentType, resourceType);
  const isJsonResponse =
    /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType);

  // Inspect dynamic JSON responses for schema only. Never persist their values.
  if (!isStatic && isJsonResponse) {
    const declaredLength = Number(headers["content-length"] || 0);
    if (declaredLength > MAX_JSON_RESPONSE_BYTES) {
      record.responseBody = {
        kind: "json",
        skipped: "over-size-limit",
        bytes: declaredLength,
      };
      return;
    }

    const body = await response.body();
    if (!body.length || body.length > MAX_JSON_RESPONSE_BYTES) {
      record.responseBody = {
        kind: "json",
        skipped: "empty-or-over-size-limit",
        bytes: body.length,
      };
      return;
    }

    try {
      const parsed = JSON.parse(body.toString("utf8"));
      record.responseBody = {
        kind: "json",
        bytes: body.length,
        shape: describeShape(parsed),
      };
    } catch {
      record.responseBody = {
        kind: "json-unparsed",
        bytes: body.length,
      };
    }
    return;
  }

  const isEventStream =
    /text\/event-stream|application\/x-ndjson/i.test(contentType);

  if (!isStatic && isEventStream) {
    const declaredLength = Number(headers["content-length"] || 0);
    if (declaredLength > MAX_EVENT_STREAM_BYTES) {
      record.responseBody = {
        kind: "event-stream",
        skipped: "over-size-limit",
        bytes: declaredLength,
      };
      return;
    }

    const body = await response.body();
    if (!body.length || body.length > MAX_EVENT_STREAM_BYTES) {
      record.responseBody = {
        kind: "event-stream",
        skipped: "empty-or-over-size-limit",
        bytes: body.length,
      };
      return;
    }
    record.responseBody = summarizeEventStream(body);
    return;
  }

  if (!isStatic) return;

  const declaredLength = Number(headers["content-length"] || 0);
  if (declaredLength > MAX_ASSET_BYTES) {
    record.assetSkipped = "over-size-limit";
    return;
  }

  const body = await response.body();
  if (!body.length || body.length > MAX_ASSET_BYTES) {
    record.assetSkipped = "empty-or-over-size-limit";
    return;
  }

  if (/javascript|ecmascript|text\/css|text\/html/i.test(contentType)) {
    const text = body.toString("utf8");
    addEndpointCandidates(text);
    if (/javascript|ecmascript|text\/css/i.test(contentType)) {
      addSourceMapCandidates(text, rawUrl);
    }
  }

  // Do not export raw document HTML: it can contain transient bootstrap tokens.
  if (resourceType === "document" || /text\/html/i.test(contentType)) {
    record.assetSkipped = "raw-html-not-exported";
    return;
  }

  const savedPath = await saveAsset(rawUrl, body, contentType, "network");
  if (savedPath) record.savedAsset = savedPath;
  else if (INCLUDE_ASSETS) record.assetSkipped = "asset-limit";
}

async function collectSourceMaps(context) {
  if (!INCLUDE_SOURCE_MAPS) return [];

  const candidates = [...sourceMapCandidates.entries()].slice(0, MAX_SOURCE_MAPS);
  const results = [];

  for (const [mapUrl, parentUrl] of candidates) {
    const result = {
      url: sanitizeUrl(mapUrl),
      discoveredFrom: sanitizeUrl(parentUrl),
    };

    try {
      const response = await context.request.get(mapUrl, { timeout: 30000 });
      result.status = response.status();

      if (!response.ok()) {
        results.push(result);
        continue;
      }

      const body = await response.body();
      if (!body.length || body.length > MAX_ASSET_BYTES) {
        result.skipped = "empty-or-over-size-limit";
        results.push(result);
        continue;
      }

      const source = body.toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(source);
      } catch {
        result.skipped = "not-json";
        results.push(result);
        continue;
      }

      addEndpointCandidates(source);
      if (Array.isArray(parsed.sourcesContent)) {
        for (const sourceText of parsed.sourcesContent) {
          if (typeof sourceText === "string") addEndpointCandidates(sourceText);
        }
      }

      const savedPath = await saveAsset(
        mapUrl,
        body,
        "application/json",
        "source-map",
      );
      if (savedPath) result.savedAsset = savedPath;
      else result.skipped = "asset-limit";
    } catch (error) {
      result.error = sanitizeText(error?.message || error);
    }

    results.push(result);
  }

  return results;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  browser = await browserType.launch({ headless: true });
  browserInfo = {
    name: BROWSER_NAME,
    version: browser.version(),
    node: process.version,
    platform: process.platform,
    osRelease: os.release(),
    runnerOs: process.env.RUNNER_OS || process.platform,
  };

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "UTC",
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);

  let cdpSession;
  let preciseCoverage = [];
  let browserMetrics = [];
  try {
    if (BROWSER_NAME !== "chromium") throw new Error("CDP coverage is Chromium-only.");
    cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Debugger.enable");
    cdpSession.on("Debugger.scriptParsed", (event) => {
      scriptRecords.set(event.scriptId, {
        scriptId: event.scriptId,
        url: sanitizeUrl(event.url || ""),
        hash: event.hash || null,
        sourceMapURL: event.sourceMapURL ? sanitizeUrl(new URL(event.sourceMapURL, event.url || TARGET_URL).href) : null,
        startLine: event.startLine,
        endLine: event.endLine,
      });
    });
    await cdpSession.send("Profiler.enable");
    await cdpSession.send("Profiler.startPreciseCoverage", {
      callCount: false,
      detailed: true,
    });
    await cdpSession.send("Performance.enable");
  } catch (error) {
    consoleEvents.push({
      type: "cdp-setup-error",
      message: sanitizeText(error?.message || error),
    });
  }

  context.on("request", (request) => {
    const rawUrl = request.url();
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }

    const record = {
      atMs: Date.now() - startedAt.getTime(),
      method: request.method(),
      url: sanitizeUrl(rawUrl),
      queryKeys: [...new Set(url.searchParams.keys())].sort(),
      resourceType: request.resourceType(),
      navigation: request.isNavigationRequest(),
    };

    const body = inspectRequestBody(request);
    if (body) record.requestBody = body;

    network.push(record);
    requestRecords.set(request, record);
  });

  context.on("response", (response) => {
    const task = (async () => {
      const record = requestRecords.get(response.request());
      if (!record) return;

      record.status = response.status();
      record.responseUrl = sanitizeUrl(response.url());
      record.responseAtMs = Date.now() - startedAt.getTime();
      record.durationMs = Math.max(0, record.responseAtMs - record.atMs);

      const headers = await response.allHeaders().catch(() => ({}));
      record.responseHeaders = {};
      for (const name of [
        "content-type",
        "content-length",
        "cache-control",
        "last-modified",
        "etag",
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
        if (headers[name]) record.responseHeaders[name] = headers[name];
      }

      await processStaticResponse(response, record);
    })()
      .catch((error) => {
        consoleEvents.push({
          type: "capture-error",
          message: sanitizeText(error?.message || error),
        });
      })
      .finally(() => pendingResponses.delete(task));

    pendingResponses.add(task);
  });

  context.on("requestfailed", (request) => {
    const record = requestRecords.get(request);
    if (record) {
      record.failure = sanitizeText(request.failure()?.errorText || "request failed");
      record.failureAtMs = Date.now() - startedAt.getTime();
      record.durationMs = Math.max(0, record.failureAtMs - record.atMs);
    }
  });

  page.on("websocket", (socket) => {
    const entry = {
      url: sanitizeUrl(socket.url()),
      openedAtMs: Date.now() - startedAt.getTime(),
      sentFrames: 0,
      receivedFrames: 0,
      sentShapes: [],
      receivedShapes: [],
    };
    websocketRecords.push(entry);

    socket.on("framesent", (frame) => {
      entry.sentFrames++;
      if (entry.sentShapes.length < 100) entry.sentShapes.push(summarizeWebSocketFrame(frame));
    });
    socket.on("framereceived", (frame) => {
      entry.receivedFrames++;
      if (entry.receivedShapes.length < 200) entry.receivedShapes.push(summarizeWebSocketFrame(frame));
    });
    socket.on("close", () => {
      entry.closedAtMs = Date.now() - startedAt.getTime();
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleEvents.push({
        type: message.type(),
        message: sanitizeText(message.text()),
      });
    }
  });

  page.on("pageerror", (error) => {
    consoleEvents.push({
      type: "page-error",
      message: sanitizeText(error?.message || error),
    });
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (error) {
    navigationError = sanitizeText(error?.message || error);
  }

  // Allow lazy-loaded chunks and late requests to settle.
  await page.waitForTimeout(12000).catch(() => {});
  await Promise.allSettled([...pendingResponses]);

  try {
    pageState = await page.evaluate(() => ({
      title: document.title,
      url: location.origin + location.pathname,
      readyState: document.readyState,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
      localStorageKeys: (() => {
        try { return Object.keys(localStorage).sort(); } catch { return []; }
      })(),
      sessionStorageKeys: (() => {
        try { return Object.keys(sessionStorage).sort(); } catch { return []; }
      })(),
      indexedDB: await indexedDB.databases().then((items) =>
        items.map((item) => ({ name: item.name, version: item.version })),
      ).catch(() => []),
      serviceWorkers: await navigator.serviceWorker.getRegistrations().then((items) =>
        items.map((item) => item.scope),
      ).catch(() => []),
      resources: performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        durationMs: Math.round(entry.duration),
        transferSize: entry.transferSize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
      })),
    }));

    pageState.url = sanitizeUrl(pageState.url);
    pageState.scripts = pageState.scripts.map(sanitizeUrl);
    pageState.resources = pageState.resources.map((resource) => ({
      ...resource,
      name: sanitizeUrl(resource.name),
    }));

    if (INCLUDE_ASSETS) {
      const safeHtml = await page.evaluate(() => {
        const clone = document.documentElement.cloneNode(true);

        clone.querySelectorAll("script").forEach((script) => {
          script.textContent = script.src ? "" : "[inline script omitted]";
        });

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

          for (const attributeName of ["src", "href"]) {
            const value = element.getAttribute(attributeName);
            if (!value) continue;
            try {
              const assetUrl = new URL(value, location.href);
              element.setAttribute(attributeName, assetUrl.origin + assetUrl.pathname);
            } catch {
              // Leave non-URL attributes unchanged.
            }
          }
        });

        return "<!doctype html>" + clone.outerHTML;
      });

      await writeFile(
        path.join(OUTPUT_DIR, "page.html"),
        safeHtml,
        "utf8",
      );
      await page.screenshot({
        path: path.join(OUTPUT_DIR, "page.png"),
        fullPage: false,
      }).catch(() => {});
    }
  } catch (error) {
    consoleEvents.push({
      type: "page-inspection-error",
      message: sanitizeText(error?.message || error),
    });
  }

  if (cdpSession) {
    try {
      const coverage = await cdpSession.send("Profiler.takePreciseCoverage");
      preciseCoverage = coverage.result.map((entry) => ({
        ...(scriptRecords.get(entry.scriptId) || {
          scriptId: entry.scriptId,
          url: sanitizeUrl(entry.url || ""),
        }),
        functions: entry.functions.map((fn) => ({
          functionName: fn.functionName,
          isBlockCoverage: fn.isBlockCoverage,
          ranges: fn.ranges,
        })),
      }));
      const metrics = await cdpSession.send("Performance.getMetrics");
      browserMetrics = metrics.metrics;
      await cdpSession.send("Profiler.stopPreciseCoverage");
    } catch (error) {
      consoleEvents.push({
        type: "cdp-coverage-error",
        message: sanitizeText(error?.message || error),
      });
    }
    await cdpSession.detach().catch(() => {});
  }

  const sourceMaps = await collectSourceMaps(context);
  await Promise.allSettled([...pendingResponses]);

  await writeFile(
    path.join(OUTPUT_DIR, "network.json"),
    JSON.stringify(network, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "payload-shapes.json"),
    JSON.stringify(
      network
        .filter((entry) => entry.requestBody)
        .map((entry) => ({
          method: entry.method,
          url: entry.url,
          resourceType: entry.resourceType,
          requestBody: entry.requestBody,
        })),
      null,
      2,
    ),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "endpoints.json"),
    JSON.stringify([...endpointCandidates].sort(), null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "response-shapes.json"),
    JSON.stringify(
      network
        .filter((entry) => entry.responseBody)
        .map((entry) => ({
          method: entry.method,
          url: entry.url,
          status: entry.status,
          responseBody: entry.responseBody,
        })),
      null,
      2,
    ),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "assets.json"),
    JSON.stringify([...assetByHash.values()], null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "websockets.json"),
    JSON.stringify(websocketRecords, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "script-coverage.json"),
    JSON.stringify(preciseCoverage, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "scripts.json"),
    JSON.stringify([...scriptRecords.values()], null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "browser-metrics.json"),
    JSON.stringify(browserMetrics, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "source-maps.json"),
    JSON.stringify(sourceMaps, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "page-state.json"),
    JSON.stringify(pageState, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "console.json"),
    JSON.stringify(consoleEvents, null, 2),
  );

  const report = {
    captureType: "unauthenticated-public-frontend",
    target: TARGET_URL,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    browser: browserInfo,
    navigationError,
    options: {
      includeAssets: INCLUDE_ASSETS,
      includeSourceMaps: INCLUDE_SOURCE_MAPS,
    },
    counts: {
      networkRequests: network.length,
      jsonPayloadShapes: network.filter(
        (entry) => entry.requestBody?.kind === "json",
      ).length,
      jsonResponseShapes: network.filter(
        (entry) => entry.responseBody?.kind === "json",
      ).length,
      eventStreams: network.filter(
        (entry) => entry.responseBody?.kind === "event-stream",
      ).length,
      websocketConnections: websocketRecords.length,
      websocketFrames: websocketRecords.reduce(
        (sum, entry) => sum + entry.sentFrames + entry.receivedFrames,
        0,
      ),
      scriptsObserved: scriptRecords.size,
      scriptsWithCoverage: preciseCoverage.length,
      endpointCandidates: endpointCandidates.size,
      sourceMapCandidates: sourceMapCandidates.size,
      sourceMapsFetched: sourceMaps.length,
      assetsSaved: assetByHash.size,
      assetBytes: totalAssetBytes,
      consoleEvents: consoleEvents.length,
    },
    privacy: {
      authenticatedSessionUsed: false,
      cookiesExported: false,
      authorizationHeadersExported: false,
      requestHeadersExported: false,
      responseHeaders: "allowlisted metadata only; Set-Cookie excluded",
      requestBodies: "JSON structure and value types only; values omitted",
      apiResponseBodies: "JSON and streaming-event structure only; values omitted; other bodies not collected",
      websocketFrames: "frame sizes and JSON shapes only; values omitted",
      conversationText: "not collected",
      browserStorage: "key names and database names only; values not read",
      rawHar: "not generated",
    },
  };

  await writeFile(
    path.join(OUTPUT_DIR, "capture.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(OUTPUT_DIR, "README.txt"),
    [
      "GPT-DIL ChatGPT public frontend capture",
      "",
      "This run used a fresh, unauthenticated browser context.",
      "Network records contain URL paths, methods, statuses and payload shapes only.",
      "Static frontend assets and exposed source maps may be included.",
      "No cookies, authorization headers, raw request bodies, raw API response bodies,",
      "browser storage values, or conversation text were exported. JSON/SSE/WebSocket shapes only.",
      "",
      "Files:",
      "- network.json: sanitized request/response metadata",
      "- payload-shapes.json: JSON request structure without values",
      "- response-shapes.json: JSON response structure without values",
      "- websockets.json: WebSocket frame counts, sizes and JSON shapes",
      "- scripts.json: all scripts observed by the Chrome debugger",
      "- script-coverage.json: executed script/function ranges and script hashes",
      "- browser-metrics.json: Chromium performance metrics",
      "- endpoints.json: endpoint-like strings extracted from frontend code",
      "- assets.json: saved asset index and SHA-256 hashes",
      "- source-maps.json: source-map discovery results",
      "- page-state.json: browser and resource timing metadata",
      "- console.json: sanitized browser warnings and errors",
      "- capture.json: run summary and privacy settings",
      "- page.html: sanitized DOM structure; inline scripts and transient attributes removed",
      "- assets/: public JavaScript, CSS, static data and source maps, without raw HTML",
      "",
      "This does not reveal private server-side prompts, model internals,",
      "or authenticated conversation payloads.",
    ].join("\n"),
    "utf8",
  );

  await context.close();
}

try {
  await main();
} catch (error) {
  fatalError = sanitizeText(error?.stack || error?.message || error);
  console.error("GPT-DIL capture failed:", fatalError);
} finally {
  if (browser) await browser.close().catch(() => {});
}

if (fatalError) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, "fatal-error.txt"), fatalError, "utf8");
}

if (navigationError || fatalError) process.exitCode = 1;
