import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDilBridgeEvents } from "../tools/analyze-dil-bridge.mjs";

test("summarizes directions, commands, runner lifetimes and gaps", () => {
  const events = [
    { ms: 0, direction: "PORT OUT", channel: "frame", kind: "createRunner", runnerId: "runner_0", compiledDilLength: 120 },
    { ms: 100, direction: "PORT OUT", channel: "message", kind: "command", command: "setData", id: "command_0" },
    { ms: 250, direction: "PORT OUT", channel: "message", kind: "command", command: "setData", id: "command_0" },
    { ms: 20000, direction: "PORT IN", channel: "message", kind: "response", id: "worker_0" },
    { ms: 21000, direction: "PORT OUT", channel: "frame", kind: "disposeRunner", runnerId: "runner_0" },
  ];
  const summary = analyzeDilBridgeEvents(events, 10000);
  assert.equal(summary.eventCount, 5);
  assert.equal(summary.durationMs, 21000);
  assert.equal(summary.directionCounts["PORT OUT"], 4);
  assert.equal(summary.directionCounts["PORT IN"], 1);
  assert.equal(summary.commandCounts.setData, 2);
  assert.equal(summary.runnerCount, 1);
  assert.equal(summary.disposedRunnerCount, 1);
  assert.equal(summary.runners[0].lifetimeMs, 21000);
  assert.equal(summary.runners[0].compiledDilLength, 120);
  assert.equal(summary.reusedCommandIds.length, 1);
  assert.equal(summary.reusedCommandIds[0].id, "command_0");
  assert.equal(summary.gapsOverThreshold.length, 1);
});

test("keeps runners without a dispose event marked active", () => {
  const summary = analyzeDilBridgeEvents([{ ms: 10, kind: "createRunner", runnerId: "runner_1" }]);
  assert.deepEqual(summary.activeRunners, ["runner_1"]);
  assert.equal(summary.runners[0].lifetimeMs, null);
});