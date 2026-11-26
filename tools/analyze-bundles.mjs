import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeText } from "./payload-sanitizer.mjs";

const SYMBOLS = [
  "createRunner",
  "disposeRunner",
  "setCompiledDil",
  "setData",
  "MessagePort",
  "SharedWorker",
  "BroadcastChannel",
  "runner.html",
  "authenticatedBrowserStreamFetch",
  "conversation/updates",
  "conversation/prepare",
  "message-stream-complete",
  "data-conversation-control",
  "postMessage",
  "ReadableStream",
  "getReader",
  "sentinel/chat-requirements",
  "lightweight_authenticated",
];

const ROUTE_PATTERN = /["'`]((?:\/backend-api\/|\/backend-anon\/|\/unauth-mweb\/|\/(?:api|graphql|ces)\/)[A-Za-z0-9._~/?=&%+-]*)["'`]/g;
const MAX_MATCHES_PER_SYMBOL_PER_FILE = 8;
const MAX_TOTAL_MATCHES = 1200;
const MAX_SOURCE_MAP_SOURCES = 5000;

function safeRoutePath(rawPath) {
  const pathOnly = String(rawPath).split("?")[0];
  return pathOnly.split("/").map((part) => {
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ":uuid";
    if (/^\d{7,}$/.test(part)) return ":id";
    if (/^[A-Za-z0-9_-]{40,}$/.test(part)) return ":opaque";
    return part;
  }).join("/");
}

function makeSnippet(source, offset, tokenLength) {
  const start = Math.max(0, offset - 110);
  const end = Math.min(source.length, offset + tokenLength + 110);
  return sanitizeText(source.slice(start, end)).replace(/\s+/g, " ").slice(0, 260);
}

export function analyzeBundleText(sourceText, filePath) {
  const source = String(sourceText ?? "");
  const lower = source.toLowerCase();
  const symbols = {};
  const matches = [];
  let totalMatches = 0;

  for (const symbol of SYMBOLS) {
    const needle = symbol.toLowerCase();
    let offset = 0;
    let count = 0;
    const snippets = [];

    while ((offset = lower.indexOf(needle, offset)) !== -1) {
      count++;
      if (snippets.length < MAX_MATCHES_PER_SYMBOL_PER_FILE && totalMatches < MAX_TOTAL_MATCHES) {
        snippets.push({
          offset,
          snippet: makeSnippet(source, offset, needle.length),
        });
        totalMatches++;
      }
      offset += needle.length || 1;
    }

    if (count) {
      symbols[symbol] = count;
      matches.push({ symbol, count, snippets });
    }
  }

  const routes = new Set();
  for (const match of source.matchAll(ROUTE_PATTERN)) {
    routes.add(safeRoutePath(match[1]));
  }

  return {
    file: filePath,
    bytes: Buffer.byteLength(source, "utf8"),
    symbols,
    matches,
    routes: [...routes].sort(),
  };
}

async function walk(directory) {
  const output = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(fullPath));
    else if (entry.isFile() && /\.(?:m?js|css|json|map)$/i.test(entry.name)) output.push(fullPath);
  }
  return output;
}

export async function analyzeCaptureAssets(captureDirectory) {
  const assetRoot = path.join(captureDirectory, "assets");
  const files = await walk(assetRoot);
  const findings = [];
  const routeReferences = new Set();
  const sourceMapSources = new Set();
  const symbolCounts = {};
  let bytesScanned = 0;
  let totalMatches = 0;

  for (const fullPath of files) {
    let source;
    try {
      source = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    bytesScanned += Buffer.byteLength(source, "utf8");
    const relativePath = path.relative(captureDirectory, fullPath).split(path.sep).join("/");
    const result = analyzeBundleText(source, relativePath);

    for (const [symbol, count] of Object.entries(result.symbols)) {
      symbolCounts[symbol] = (symbolCounts[symbol] || 0) + count;
    }
    for (const route of result.routes) routeReferences.add(route);
    totalMatches += result.matches.reduce((sum, item) => sum + item.snippets.length, 0);
    if (result.matches.length || result.routes.length) findings.push(result);

    if (/\.map$/i.test(fullPath)) {
      try {
        const parsed = JSON.parse(source);
        for (const item of parsed.sources || []) {
          if (typeof item === "string" && sourceMapSources.size < MAX_SOURCE_MAP_SOURCES) {
            sourceMapSources.add(sanitizeText(item).slice(0, 300));
          }
        }
      } catch {}
    }
  }

  return {
    filesScanned: files.length,
    bytesScanned,
    totalSymbolMatches: totalMatches,
    symbolCounts,
    routeReferences: [...routeReferences].sort(),
    sourceMapSources: [...sourceMapSources].sort(),
    findings,
  };
}

async function main() {
  const captureDirectory = path.resolve(process.argv[2] || "capture-output");
  await mkdir(captureDirectory, { recursive: true });
  const report = await analyzeCaptureAssets(captureDirectory);
  await writeFile(
    path.join(captureDirectory, "bundle-findings.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(
    "Bundle analysis: " + report.filesScanned + " files, " +
    report.totalSymbolMatches + " symbol matches, " +
    report.routeReferences.length + " route references.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Bundle analysis failed: " + (error?.message || error));
    process.exitCode = 1;
  });
}
