const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|csrf|xsrf|signature|proof|turnstile|credential|api.?key|email|username|sentinel|session|auth|bearer|jwt|phone|device.?id|user.?id|account.?id|ip.?address/i;

function safePayloadKey(key) {
  const value = String(key);
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) return "[EMAIL-KEY]";
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return "[UUID-KEY]";
  if (/^[A-Za-z0-9_-]{40,}$/.test(value)) return "[OPAQUE-KEY]";
  return value;
}


export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|signature|sig|session[_-]?proof|session[_-]?id|proof|auth)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|prepare[_-]?token|conduit[_-]?token|session[_-]?proof|session[_-]?id|api[_-]?key|client[_-]?secret|authorization|cookie|csrf|xsrf|sentinel|proof|signature|password|secret|token|user[_-]?id|account[_-]?id|device[_-]?id)\s*[:=]\s*)["']?[^,\s"']+/gi, "$1[REDACTED]")
    .replace(/(["'][^"']*(?:token|secret|password|passwd|authorization|cookie|csrf|xsrf|signature|proof|turnstile|credential|api.?key|email|username|sentinel|session|auth|bearer|jwt|phone|device.?id|user.?id|account.?id|ip.?address)[^"']*["']\s*:\s*["'])[^"']*(["'])/gi, "$1[REDACTED]$2");
}

export function sanitizePayload(value, depth = 0) {
  if (depth > 32) return "[DEPTH-LIMIT]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, 2000).map((item) => sanitizePayload(item, depth + 1));
    if (value.length > 2000) output.push({ __truncatedItems: value.length - 2000 });
    return output;
  }
  if (value && typeof value === "object") {
    const output = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, 1000)) {
      output[safePayloadKey(key)] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizePayload(item, depth + 1);
    }
    if (entries.length > 1000) output.__truncatedKeys = entries.length - 1000;
    return output;
  }
  return String(value);
}

export function sanitizeProtocolBody(raw, contentType = "") {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");

  if (/multipart\/form-data/i.test(contentType)) {
    const fieldNames = [...new Set([...text.matchAll(/(?:^|[;\s])name="([^"]+)"/g)].map((match) => match[1]))];
    return {
      kind: "multipart-metadata",
      bytes: Buffer.byteLength(text, "utf8"),
      fieldNames,
      fileParts: (text.match(/filename="/g) || []).length,
      values: "omitted",
    };
  }

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const fields = {};
    for (const [key, value] of new URLSearchParams(text)) {
      fields[safePayloadKey(key)] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeText(value);
    }
    return { kind: "form-urlencoded", fields };
  }

  if (/text\/event-stream|application\/x-ndjson|ndjson/i.test(contentType)) {
    const isNdjson = /ndjson/i.test(contentType);
    return text.split(/\r?\n/).map((line) => {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") return "data: [DONE]";
        try {
          return "data: " + JSON.stringify(sanitizePayload(JSON.parse(data)));
        } catch {
          return "data: " + sanitizeText(data);
        }
      }
      if (isNdjson && line.trim()) {
        try {
          return JSON.stringify(sanitizePayload(JSON.parse(line)));
        } catch {}
      }
      return sanitizeText(line);
    }).join("\n");
  }

  if (/json|\+json/i.test(contentType)) {
    try {
      return sanitizePayload(JSON.parse(text));
    } catch {
      return sanitizeText(text);
    }
  }


  return sanitizeText(text);
}

export function isSensitivePayloadKey(key) {
  return SECRET_KEY.test(String(key));
}
