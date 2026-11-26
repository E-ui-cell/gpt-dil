import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeBundleText,
  analyzeCaptureAssets,
} from "../tools/analyze-bundles.mjs";

test("finds DIL runtime symbols and backend routes in bundle text", () => {
  const source = [
    'const bridge = new MessagePort();',
    'function createRunner(){ return bridge.postMessage("setData"); }',
    'const route = "/backend-api/conversation/updates";',
    'const auth = "Bearer do-not-leak-this";',
  ].join("\n");
  const result = analyzeBundleText(source, "assets/app.js");

  assert.equal(result.symbols.createRunner, 1);
  assert.equal(result.symbols.MessagePort, 1);
  assert.equal(result.symbols.postMessage, 1);
  assert.ok(result.routes.includes("/backend-api/conversation/updates"));
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak-this/);
});

test("scans captured assets and extracts source-map source names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gpt-dil-bundle-test-"));
  try {
    const assetDirectory = path.join(root, "assets", "cdn");
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(
      path.join(assetDirectory, "app.js"),
      'function setCompiledDil(){}; const r="/unauth-mweb/conversation/prepare";',
      "utf8",
    );
    await writeFile(
      path.join(assetDirectory, "app.js.map"),
      JSON.stringify({ version: 3, sources: ["src/runner.ts", "src/bridge.ts"] }),
      "utf8",
    );

    const result = await analyzeCaptureAssets(root);
    assert.equal(result.filesScanned, 2);
    assert.equal(result.symbolCounts.setCompiledDil, 1);
    assert.ok(result.routeReferences.includes("/unauth-mweb/conversation/prepare"));
    assert.deepEqual(result.sourceMapSources, ["src/bridge.ts", "src/runner.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
