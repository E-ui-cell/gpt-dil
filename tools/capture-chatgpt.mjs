import { chromium } from "playwright";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const TARGET_URL = "https://chatgpt.com/";
const OUTPUT_DIR = path.resolve(process.env.GPT_DIL_OUTPUT_DIR || "capture-output");
const INCLUDE_ASSETS = process.env.GPT_DIL_INCLUDE_ASSETS !== "false";
const INCLUDE_SOURCE_MAPS =
  INCLUDE_ASSETS && process.env.GPT_DIL_INCLUDE_SOURCE_MAPS !== "false";

const MAX_ASSETS = 600;
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 300 * 1024 * 1024;
const MAX_SOURCE_MAPS = 200;
const MAX_JSON_RESPONSE_BYTES = 6 * 1024 * 1024;
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

  browser = await chromium.launch({ headless: true });
  browserInfo = {
    name: "Chromium",
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

  page.on("request", (request) => {
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

  page.on("response", (response) => {
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

  page.on("requestfailed", (request) => {
    const record = requestRecords.get(request);
    if (record) {
      record.failure = sanitizeText(request.failure()?.errorText || "request failed");
      record.failureAtMs = Date.now() - startedAt.getTime();
      record.durationMs = Math.max(0, record.failureAtMs - record.atMs);
    }
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
      apiResponseBodies: "JSON structure only; values omitted; other bodies not collected",
      conversationText: "not collected",
      browserStorage: "not read",
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
      "browser storage, or conversation text were exported. JSON response shapes only.",
      "",
      "Files:",
      "- network.json: sanitized request/response metadata",
      "- payload-shapes.json: JSON request structure without values",
      "- response-shapes.json: JSON response structure without values",
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
