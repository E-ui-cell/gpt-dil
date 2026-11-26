import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDilBridgeEvents } from "../tools/analyze-dil-bridge.mjs";

test("correlates runner lifetimes and reused command IDs", () => {
  const summary = analyzeDilBridgeEvents([
    { kind: "createRunner", runnerId: "runner_0", ms: 0, compiledDilLength: 120 },
    { kind: "command", command: "setData", id: "cmd_1", ms: 10 },
    { kind: "command", command: "setData", id: "cmd_1", ms: 20 },
    { kind: "disposeRunner", runnerId: "runner_0", ms: 100 },
    { kind: "createRunner", runnerId: "runner_1", ms: 120 },
  ], 50);

  assert.equal(summary.runnerCount, 2);
  assert.equal(summary.disposedRunnerCount, 1);
  assert.deepEqual(summary.activeRunners, ["runner_1"]);
  assert.equal(summary.runners[0].lifetimeMs, 100);
  assert.deepEqual(summary.reusedCommandIds, [{ id: "cmd_1", count: 2 }]);
  assert.equal(summary.gapsOverThreshold.length, 1);
  assert.equal(summary.gapsOverThreshold[0].durationMs, 80);
});

test("counts directions, channels, commands and error-like events", () => {
  const summary = analyzeDilBridgeEvents([
    { kind: "command", command: "setData", id: "a", direction: "OUT", channel: "message", ms: 0 },
    { kind: "response", direction: "IN", channel: "message", ms: 1 },
    { kind: "worker-error", direction: "IN", channel: "message", ms: 2 },
  ]);

  assert.deepEqual(summary.directionCounts, { IN: 2, OUT: 1 });
  assert.deepEqual(summary.channelCounts, { message: 3 });
  assert.deepEqual(summary.commandCounts, { setData: 1 });
  assert.equal(summary.errorEventCount, 1);
});

test("ignores malformed events and reports duration when timestamps are absent", () => {
  const summary = analyzeDilBridgeEvents([
    null,
    "not-an-event",
    { kind: "createRunner", runnerId: "runner_0" },
    { kind: "disposeRunner", runnerId: "runner_0" },
  ]);

  assert.equal(summary.eventCount, 2);
  assert.equal(summary.timedEventCount, 0);
  assert.equal(summary.durationMs, null);
  assert.equal(summary.disposedRunnerCount, 1);
});
