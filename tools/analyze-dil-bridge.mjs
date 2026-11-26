import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function countBy(events, selector) {
  const counts = {};
  for (const event of events) {
    const value = selector(event);
    if (value === undefined || value === null || value === "") continue;
    const key = String(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function eventTime(event) {
  for (const key of ["ms", "captureElapsedMs", "elapsedMs", "timeMs", "timestampMs"]) {
    if (Number.isFinite(event?.[key])) return event[key];
  }
  for (const key of ["observedAt", "wallTime", "at", "timestamp", "time"]) {
    const value = event?.[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = milliseconds / 1000;
  if (seconds < 60) return seconds.toFixed(3) + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds - minutes * 60).toFixed(1) + "s";
}

export function analyzeDilBridgeEvents(inputEvents, gapThresholdMs = 10000) {
  const events = inputEvents.filter((event) => event && typeof event === "object");
  const timed = events
    .map((event, index) => ({ event, index, time: eventTime(event) }))
    .filter((item) => item.time !== null)
    .sort((a, b) => a.time - b.time || a.index - b.index);

  const firstTime = timed.length ? timed[0].time : null;
  const lastTime = timed.length ? timed[timed.length - 1].time : null;
  const gaps = [];
  for (let index = 1; index < timed.length; index++) {
    const previous = timed[index - 1];
    const current = timed[index];
    const durationMs = current.time - previous.time;
    if (durationMs >= gapThresholdMs) {
      gaps.push({
        durationMs,
        fromIndex: previous.index,
        toIndex: current.index,
        fromMs: previous.time,
        toMs: current.time,
        fromKind: previous.event.kind || previous.event.type || null,
        toKind: current.event.kind || current.event.type || null,
      });
    }
  }

  const created = new Map();
  const disposed = new Map();
  for (const event of events) {
    if (!event.runnerId) continue;
    if (event.kind === "createRunner") created.set(String(event.runnerId), event);
    if (event.kind === "disposeRunner") disposed.set(String(event.runnerId), event);
  }

  const runners = [...created.entries()].map(([runnerId, createEvent]) => {
    const disposeEvent = disposed.get(runnerId);
    const start = eventTime(createEvent);
    const end = disposeEvent ? eventTime(disposeEvent) : null;
    return {
      runnerId,
      createdAtMs: start,
      compiledDilLength: createEvent.compiledDilLength ?? null,
      disposedAtMs: end,
      lifetimeMs: start !== null && end !== null ? end - start : null,
      activeAtEnd: !disposeEvent,
    };
  }).sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));

  const commandIdCounts = countBy(events.filter((event) => event.kind === "command" && event.id), (event) => event.id);
  const reusedCommandIds = Object.entries(commandIdCounts)
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));

  return {
    eventCount: events.length,
    timedEventCount: timed.length,
    firstEventMs: firstTime,
    lastEventMs: lastTime,
    durationMs: firstTime !== null && lastTime !== null ? lastTime - firstTime : null,
    directionCounts: countBy(events, (event) => event.direction),
    channelCounts: countBy(events, (event) => event.channel),
    kindCounts: countBy(events, (event) => event.kind),
    commandCounts: countBy(events, (event) => event.command),
    runnerCount: created.size,
    disposedRunnerCount: [...created.keys()].filter((id) => disposed.has(id)).length,
    activeRunners: runners.filter((runner) => runner.activeAtEnd).map((runner) => runner.runnerId),
    runners,
    commandIdCount: Object.keys(commandIdCounts).length,
    reusedCommandIds,
    gapsOverThreshold: gaps.sort((a, b) => b.durationMs - a.durationMs),
    errorEventCount: events.filter((event) => /error|exception|failed/i.test(String(event.kind || event.type || ""))).length,
  };
}

function printSummary(summary, gapThresholdMs) {
  console.log("DIL bridge capture analysis");
  console.log("Events: " + summary.eventCount + " (timed: " + summary.timedEventCount + ")");
  console.log("Duration: " + formatDuration(summary.durationMs));
  console.log("Directions: " + JSON.stringify(summary.directionCounts));
  console.log("Channels: " + JSON.stringify(summary.channelCounts));
  console.log("Kinds: " + JSON.stringify(summary.kindCounts));
  if (Object.keys(summary.commandCounts).length) console.log("Commands: " + JSON.stringify(summary.commandCounts));
  console.log("Runners: " + summary.runnerCount + " created, " + summary.disposedRunnerCount + " disposed");
  if (summary.activeRunners.length) console.log("Still active: " + summary.activeRunners.join(", "));
  for (const runner of summary.runners) {
    const lifetime = runner.lifetimeMs === null ? "still active" : formatDuration(runner.lifetimeMs);
    console.log("  " + runner.runnerId + ": " + lifetime + (runner.compiledDilLength === null ? "" : ", compiled DIL " + runner.compiledDilLength + " chars"));
  }
  console.log("Command IDs: " + summary.commandIdCount + " unique; " + summary.reusedCommandIds.length + " reused");
  console.log("Gaps >= " + formatDuration(gapThresholdMs) + ": " + summary.gapsOverThreshold.length);
  for (const gap of summary.gapsOverThreshold.slice(0, 10)) {
    console.log("  " + formatDuration(gap.durationMs) + ": " + gap.fromKind + " -> " + gap.toKind + " (" + gap.fromMs + "ms -> " + gap.toMs + "ms)");
  }
  console.log("Error-like events: " + summary.errorEventCount);
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((arg) => !arg.startsWith("--"));
  if (!inputPath) {
    console.error("Usage: node tools/analyze-dil-bridge.mjs <capture.json|capture.jsonl> [--json] [--gap-ms=10000]");
    process.exitCode = 2;
    return;
  }
  const gapArgument = args.find((arg) => arg.startsWith("--gap-ms="));
  const gapThresholdMs = gapArgument ? Math.max(0, Number(gapArgument.slice(9)) || 0) : 10000;
  const raw = (await readFile(inputPath, "utf8")).replace(/^\uFEFF/, "");
  let events;
  try {
    const parsed = JSON.parse(raw);
    events = Array.isArray(parsed) ? parsed : Array.isArray(parsed.events) ? parsed.events : [parsed];
  } catch {
    events = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  const summary = analyzeDilBridgeEvents(events, gapThresholdMs);
  if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary, gapThresholdMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("DIL bridge analysis failed: " + (error?.message || error));
    process.exitCode = 1;
  });
}
