(() => {
  "use strict";
  const BINDING_NAME = "__gptDilBridgeEvent";
  const INSTALL_FLAG = "__GPT_DIL_BRIDGE_HOOK_INSTALLED__";
  const host = String(globalThis.location?.hostname || "").toLowerCase();
  const allowedHost = ["chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"]
    .some((domain) => host === domain || host.endsWith("." + domain));
  if (!allowedHost || globalThis[INSTALL_FLAG]) return;
  const report = globalThis[BINDING_NAME];
  if (typeof report !== "function") return;
  Object.defineProperty(globalThis, INSTALL_FLAG, { value: true });

  const MAX_DEPTH = 9;
  const MAX_KEYS = 100;
  const MAX_ITEMS = 80;
  const MAX_STRING = 96 * 1024;
  const SECRET_KEY = /token|secret|password|authorization|cookie|csrf|xsrf|signature|proof|turnstile|credential|api.?key|email|username|sentinel|session|auth|bearer|jwt|phone/i;
  const endpointIds = new WeakMap();
  const attached = new WeakSet();
  const realmId = "realm_" + Math.random().toString(36).slice(2, 10);
  let endpointSequence = 0;
  let reporting = false;

  function safeLocation() {
    try {
      const url = new URL(globalThis.location.href);
      const pathname = url.pathname.split("/").map((part) => {
        if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ":uuid";
        if (/^[A-Za-z0-9_-]{40,}$/.test(part)) return ":opaque";
        return part;
      }).join("/");
      return url.origin + pathname;
    } catch {
      return String(globalThis.location?.origin || "");
    }
  }

  function cleanString(value) {
    return String(value ?? "")
      .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
      .replace(/([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|signature|sig|session[_-]?proof|session[_-]?id|proof|auth)=)[^&#\s]+/gi, "$1[REDACTED]")
      .slice(0, MAX_STRING);
  }

  function endpointId(target, transport) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return null;
    let id = endpointIds.get(target);
    if (!id) {
      id = transport.toLowerCase() + "_" + (++endpointSequence);
      endpointIds.set(target, id);
    }
    return id;
  }

  function typeName(value) {
    try { return value?.constructor?.name || "Object"; }
    catch { return "Object"; }
  }

  function snapshot(value, depth = 0, seen = new WeakSet()) {
    if (depth > MAX_DEPTH) return "[DEPTH-LIMIT]";
    if (value === null || value === undefined) return value === null ? null : "undefined";
    if (typeof value === "string") return cleanString(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString() + "n";
    if (typeof value === "symbol") return String(value);
    if (typeof value === "function") return "[Function]";

    try {
      if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
        return { type: "ArrayBuffer", bytes: value.byteLength };
      }
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
        return { type: typeName(value), bytes: value.byteLength, length: value.length ?? null };
      }
      if (typeof Blob !== "undefined" && value instanceof Blob) {
        return { type: typeName(value), bytes: value.size, mimeType: cleanString(value.type) };
      }
      if (typeof MessagePort !== "undefined" && value instanceof MessagePort) {
        return { type: "MessagePort", endpointId: endpointId(value, "MessagePort") };
      }
      if (typeof Node !== "undefined" && value instanceof Node) {
        return { type: "DOMNode", nodeName: cleanString(value.nodeName || "") };
      }
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Error) {
        return { type: "Error", name: cleanString(value.name), message: cleanString(value.message) };
      }
    } catch {
      return "[UNREADABLE]";
    }

    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        items: value.slice(0, MAX_ITEMS).map((item) => snapshot(item, depth + 1, seen)),
        ...(value.length > MAX_ITEMS ? { truncatedItems: true } : {}),
      };
    }
    if (typeof Map !== "undefined" && value instanceof Map) {
      return {
        type: "Map",
        size: value.size,
        entries: [...value.entries()].slice(0, MAX_ITEMS).map(([key, item]) => [
          snapshot(key, depth + 1, seen), snapshot(item, depth + 1, seen),
        ]),
      };
    }
    if (typeof Set !== "undefined" && value instanceof Set) {
      return {
        type: "Set",
        size: value.size,
        values: [...value.values()].slice(0, MAX_ITEMS).map((item) => snapshot(item, depth + 1, seen)),
      };
    }

    let keys;
    try { keys = Object.keys(value); }
    catch { return { type: typeName(value), unreadable: true }; }
    const output = { type: "object", properties: {} };
    for (const key of keys.slice(0, MAX_KEYS)) {
      output.properties[cleanString(key)] = SECRET_KEY.test(key)
        ? "[REDACTED]"
        : snapshot(value[key], depth + 1, seen);
    }
    if (keys.length > MAX_KEYS) output.truncatedKeys = true;
    if (keys.length === 0) output.class = typeName(value);
    return output;
  }

  function parseForClassification(value) {
    if (value && typeof value === "object") return value;
    if (typeof value === "string" && value.length <= MAX_STRING) {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { return JSON.parse(trimmed); } catch {}
      }
    }
    return null;
  }

  function transferSummary(args) {
    let list = [];
    for (const item of args) {
      if (Array.isArray(item)) { list = item; break; }
      if (item && typeof item === "object" && Array.isArray(item.transfer)) {
        list = item.transfer;
        break;
      }
    }
    return list.slice(0, MAX_ITEMS).map((item) => {
      const kind = typeName(item);
      return kind === "MessagePort"
        ? { type: kind, endpointId: endpointId(item, kind) }
        : { type: kind };
    });
  }

  function emit(direction, transport, data, details = {}) {
    if (reporting) return;
    try {
      const classified = parseForClassification(data);
      const source = classified && typeof classified === "object" && !Array.isArray(classified)
        ? classified : {};
      const kind = typeof source.kind === "string"
        ? cleanString(source.kind)
        : typeof source.type === "string" ? cleanString(source.type) : typeof data;
      const event = {
        elapsedMs: Math.round(globalThis.performance?.now?.() || 0),
        wallTime: new Date().toISOString(),
        realmId,
        realmUrl: safeLocation(),
        direction,
        channel: transport === "Window" ? "frame" : "message",
        transport,
        endpointId: details.endpointId || null,
        kind,
        ...(typeof source.command === "string" ? { command: cleanString(source.command) } : {}),
        ...((typeof source.id === "string" || typeof source.id === "number") ? { id: cleanString(source.id) } : {}),
        ...(typeof source.runnerId === "string" ? { runnerId: cleanString(source.runnerId) } : {}),
        ...(typeof source.compiledDil === "string" ? { compiledDilLength: source.compiledDil.length } : {}),
        ...(typeof source.compiledDilLength === "number" ? { compiledDilLength: source.compiledDilLength } : {}),
        ...(details.origin ? { origin: cleanString(details.origin) } : {}),
        ...(details.transferredPorts ? { transferredPorts: details.transferredPorts } : {}),
        ...(details.transfer ? { transfer: details.transfer } : {}),
        payload: snapshot(data),
      };
      reporting = true;
      try {
        const pending = report(event);
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      } finally {
        reporting = false;
      }
    } catch {
      reporting = false;
      // Diagnostics must never interfere with the application message.
    }
  }

  function attachEndpoint(target, transport) {
    if (!target || attached.has(target) || typeof target.addEventListener !== "function") return;
    attached.add(target);
    const id = endpointId(target, transport);
    try {
      target.addEventListener("message", (event) => {
        const ports = Array.from(event.ports || []);
        emit("IN", transport, event.data, {
          endpointId: id,
          origin: typeof event.origin === "string" ? event.origin : "",
          transferredPorts: ports.length,
        });
        for (const port of ports) attachEndpoint(port, "MessagePort");
      });
    } catch {}
  }

  function patchPostMessage(prototype, transport, transferArgs) {
    if (!prototype || typeof prototype.postMessage !== "function") return;
    const nativePostMessage = prototype.postMessage;
    try {
      Object.defineProperty(prototype, "postMessage", {
        configurable: true,
        writable: true,
        value: function(message) {
          const args = Array.from(arguments).slice(1);
          emit("OUT", transport, message, {
            endpointId: endpointId(this, transport),
            transfer: transferSummary(transferArgs(args)),
          });
          return Reflect.apply(nativePostMessage, this, arguments);
        },
      });
    } catch {}
  }

  function wrapConstructor(name, onCreated) {
    const NativeConstructor = globalThis[name];
    if (typeof NativeConstructor !== "function") return;
    try {
      globalThis[name] = new Proxy(NativeConstructor, {
        construct(target, args, newTarget) {
          const instance = Reflect.construct(target, args, newTarget);
          try { onCreated(instance); } catch {}
          return instance;
        },
      });
    } catch {}
  }

  try {
    if (typeof Window !== "undefined") {
      attachEndpoint(globalThis, "Window");
      patchPostMessage(Window.prototype, "Window", (args) => [args[0], args[1]]);
    }
    if (typeof MessagePort !== "undefined") {
      patchPostMessage(MessagePort.prototype, "MessagePort", (args) => [args[0], args[1]]);
      const nativeStart = MessagePort.prototype.start;
      if (typeof nativeStart === "function") {
        MessagePort.prototype.start = function() {
          attachEndpoint(this, "MessagePort");
          return Reflect.apply(nativeStart, this, arguments);
        };
      }
    }
    if (typeof Worker !== "undefined") {
      patchPostMessage(Worker.prototype, "Worker", (args) => [args[0], args[1]]);
      wrapConstructor("Worker", (worker) => attachEndpoint(worker, "Worker"));
    }
    if (typeof ServiceWorker !== "undefined") {
      patchPostMessage(ServiceWorker.prototype, "ServiceWorker", (args) => [args[0], args[1]]);
    }
    if (typeof BroadcastChannel !== "undefined") {
      patchPostMessage(BroadcastChannel.prototype, "BroadcastChannel", () => []);
      wrapConstructor("BroadcastChannel", (channel) => attachEndpoint(channel, "BroadcastChannel"));
    }
    wrapConstructor("MessageChannel", (channel) => {
      attachEndpoint(channel.port1, "MessagePort");
      attachEndpoint(channel.port2, "MessagePort");
    });
    wrapConstructor("SharedWorker", (worker) => attachEndpoint(worker.port, "MessagePort"));
    if (globalThis.navigator?.serviceWorker) {
      attachEndpoint(globalThis.navigator.serviceWorker, "ServiceWorkerContainer");
    }
  } catch {}
})();