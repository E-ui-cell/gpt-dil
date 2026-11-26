import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
}
class FakePort extends FakeEventTarget {
  postMessage(data) { this.peer?.dispatch("message", { data, ports: [], origin: "" }); }
  start() {}
}
class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}
class FakeWindow extends FakeEventTarget {
  postMessage(data, targetOrigin, transfer) {
    this.dispatch("message", { data, origin: "https://chatgpt.com", ports: transfer || [] });
  }
}
class FakeWorker extends FakeEventTarget {
  postMessage(data) { this.dispatch("message", { data, origin: "" }); }
}

const hookSource = await readFile(new URL("../tools/dil-bridge-hook.js", import.meta.url), "utf8");
function makeRealm(hostname = "chatgpt.com") {
  const events = [];
  const sandbox = new FakeWindow();
  Object.assign(sandbox, {
    location: { hostname, origin: "https://chatgpt.com", href: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc" },
    performance: { now: () => 123.4 },
    navigator: {},
    URL,
    Window: FakeWindow,
    MessagePort: FakePort,
    MessageChannel: FakeMessageChannel,
    Worker: FakeWorker,
    __gptDilBridgeEvent: (event) => events.push(event),
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(hookSource, context);
  return { sandbox, context, events };
}

test("captures both MessagePort directions and redacts sensitive values", () => {
  const realm = makeRealm();
  const channel = vm.runInContext("new MessageChannel()", realm.context);
  channel.port1.postMessage({
    kind: "command", command: "setData", id: "command_7",
    sessionToken: "do-not-save-this", text: "hello",
  });
  assert.equal(realm.events.length, 2);
  assert.equal(realm.events[0].direction, "OUT");
  assert.equal(realm.events[0].channel, "message");
  assert.equal(realm.events[0].kind, "command");
  assert.equal(realm.events[0].command, "setData");
  assert.equal(realm.events[0].payload.properties.sessionToken, "[REDACTED]");
  assert.equal(realm.events[1].direction, "IN");
});

test("captures frame messages and is idempotent", () => {
  const realm = makeRealm();
  vm.runInContext(hookSource, realm.context);
  realm.sandbox.postMessage({ kind: "createRunner", runnerId: "runner_0", compiledDil: "<DIL/>" }, "*");
  assert.equal(realm.events.length, 2);
  assert.equal(realm.events[0].channel, "frame");
  assert.equal(realm.events[0].kind, "createRunner");
  assert.equal(realm.events[0].compiledDilLength, 6);
});

test("does not install on unrelated origins", () => {
  const realm = makeRealm("example.com");
  const channel = vm.runInContext("new MessageChannel()", realm.context);
  channel.port1.postMessage({ kind: "command" });
  assert.equal(realm.events.length, 0);
});