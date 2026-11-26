// ==UserScript==
// @name         GPT-DIL - Plain Text Payload
// @namespace    https://github.com/E-ui-cell/gpt-dil
// @version      0.2.0
// @description  Adds an editable custom text payload to outgoing ChatGPT user messages.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @inject-into  page
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js
// @downloadURL  https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js
// ==/UserScript==

(() => {
    "use strict";

    const VERSION = "0.2.0";

    // EDIT THIS PAYLOAD. It is appended to the latest user message's text.
    // Keep it as ordinary text; the existing JSON message structure is preserved.
    const CUSTOM_PAYLOAD_TEXT = [
        "Please answer in plain text.",
        "Avoid Markdown headings, bullets, numbered lists, tables, bold, italics, and code fences.",
        "Use ordinary paragraphs. If code is necessary, output raw code without fences."
    ].join(" ");

    if (window.__GPT_DIL_PLAIN_TEXT_VERSION__ === VERSION) return;
    window.__GPT_DIL_PLAIN_TEXT_VERSION__ = VERSION;

    const log = (...args) => console.info("[GPT-DIL]", ...args);
    const warn = (...args) => console.warn("[GPT-DIL]", ...args);

    function isConversationPost(url, method) {
        if (String(method || "GET").toUpperCase() !== "POST") return false;

        try {
            const parsed = new URL(String(url), location.href);
            return (parsed.hostname === "chatgpt.com" ||
                    parsed.hostname === "chat.openai.com") &&
                   (parsed.pathname === "/backend-api/f/conversation" ||
                    parsed.pathname === "/backend-api/conversation");
        } catch (_) {
            return false;
        }
    }

    function modifyPayload(rawBody) {
        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch (_) {
            return null;
        }

        if (!payload || !Array.isArray(payload.messages)) return null;

        let userMessage = null;
        for (let i = payload.messages.length - 1; i >= 0; i--) {
            const candidate = payload.messages[i];
            if (candidate && candidate.author && candidate.author.role === "user") {
                userMessage = candidate;
                break;
            }
        }

        if (!userMessage || !userMessage.content ||
            userMessage.content.content_type !== "text" ||
            !Array.isArray(userMessage.content.parts)) {
            return null;
        }

        const parts = userMessage.content.parts;
        for (let i = parts.length - 1; i >= 0; i--) {
            if (typeof parts[i] !== "string") continue;
            if (parts[i].includes(CUSTOM_PAYLOAD_TEXT)) return null;

            parts[i] = parts[i].length
                ? parts[i] + "\n\n" + CUSTOM_PAYLOAD_TEXT
                : CUSTOM_PAYLOAD_TEXT;

            return JSON.stringify(payload);
        }

        return null;
    }

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
        window.fetch = async function(input, init) {
            const isRequest = typeof Request !== "undefined" && input instanceof Request;
            const url = isRequest ? input.url : input;
            const method = (init && init.method) || (isRequest && input.method) || "GET";

            if (!isConversationPost(url, method)) {
                return nativeFetch.apply(this, arguments);
            }

            try {
                let rawBody = null;

                if (init && typeof init.body === "string") {
                    rawBody = init.body;
                } else if (init && init.body != null) {
                    warn("Matched conversation request, but its body is not a JSON string; passed through unchanged.");
                    return nativeFetch.apply(this, arguments);
                } else if (isRequest) {
                    rawBody = await input.clone().text();
                }

                if (typeof rawBody !== "string") {
                    warn("Matched conversation request, but could not read its body; passed through unchanged.");
                    return nativeFetch.apply(this, arguments);
                }

                const modifiedBody = modifyPayload(rawBody);
                if (!modifiedBody) {
                    warn("Conversation request did not match the known message shape; passed through unchanged.");
                    return nativeFetch.apply(this, arguments);
                }

                log("Modified POST /backend-api/conversation (fetch). No headers or response data were read.");

                if (isRequest) {
                    const nextInit = Object.assign({}, init || {}, { body: modifiedBody });
                    return nativeFetch.call(this, new Request(input, nextInit));
                }

                const nextInit = Object.assign({}, init || {}, { body: modifiedBody });
                return nativeFetch.call(this, input, nextInit);
            } catch (error) {
                warn("Fetch interception failed; original request sent unchanged.", error && error.name);
                return nativeFetch.apply(this, arguments);
            }
        };
    } else {
        warn("fetch is unavailable; no fetch hook installed.");
    }

    // Fallback for any conversation request sent through XMLHttpRequest.
    if (typeof XMLHttpRequest !== "undefined") {
        const xhrMeta = new WeakMap();
        const nativeOpen = XMLHttpRequest.prototype.open;
        const nativeSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            xhrMeta.set(this, {
                method: String(method || "GET").toUpperCase(),
                url: String(url)
            });
            return nativeOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(body) {
            const meta = xhrMeta.get(this);
            if (meta && isConversationPost(meta.url, meta.method) && typeof body === "string") {
                const modifiedBody = modifyPayload(body);
                if (modifiedBody) {
                    body = modifiedBody;
                    log("Modified POST /backend-api/conversation (XHR).");
                }
            }
            return nativeSend.call(this, body);
        };
    }

    log("Custom conversation payload hook active", VERSION);
})();
