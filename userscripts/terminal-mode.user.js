// ==UserScript==
// @name         GPT-DIL - Terminal Mode
// @namespace    https://github.com/E-ui-cell/gpt-dil
// @version      0.1.0
// @description  Requests plain, terminal-friendly text without Markdown formatting.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @inject-into  page
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/terminal-mode.user.js
// @downloadURL  https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/terminal-mode.user.js
// ==/UserScript==

(() => {
    "use strict";

    const VERSION = "0.1.0";
    const INSTANCE_KEY = "__GPT_DIL_TERMINAL_MODE__";
    const VERSION_KEY = "__GPT_DIL_TERMINAL_MODE_VERSION__";

    // EDIT THIS INSTRUCTION to customize terminal-mode output.
    // It is appended to the latest user message; no request fields are added.
    const CUSTOM_PAYLOAD_TEXT = [
        "TERMINAL MODE: respond using plain, unformatted text only.",
        "Do not use Markdown or rich-text formatting: no headings, bullets, numbered lists, tables, blockquotes, emphasis, strikethrough, Markdown links, or fenced code blocks.",
        "Use ordinary text and line breaks. If multiple items are necessary, put each item on its own line without bullets or numbering.",
        "Show commands, paths, logs, configuration, and source code as raw text, without code fences or decorative prefixes. Preserve meaningful indentation.",
        "Do not add shell prompts such as $, >, or PS> unless they are part of the actual content. Never claim a command was executed unless it actually was.",
        "Keep output concise and terminal-friendly. Avoid emoji and decorative symbols; preserve Unicode when needed."
    ].join("\n");

    const log = (...args) => console.info("[TerminalMode]", ...args);
    const warn = (...args) => console.warn("[TerminalMode]", ...args);

    const previous = window[INSTANCE_KEY];
    if (previous && previous.version === VERSION) return;
    if (previous && typeof previous.stop === "function") previous.stop();

    // The previous 0.2.0 script did not expose a stop hook. Avoid stacking
    // another interceptor if both versions are manually injected in one page.
    if (!previous && window[VERSION_KEY]) {
        warn("An older instance is active. Reload the page to install this version cleanly.");
        return;
    }

    function isConversationPost(url, method) {
        if (String(method || "GET").toUpperCase() !== "POST") return false;

        try {
            const parsed = new URL(String(url), location.href);
            return (parsed.hostname === "chatgpt.com" ||
                    parsed.hostname === "chat.openai.com") &&
                   /^\/backend-api\/(?:f\/)?conversation(?:\/prepare)?$/.test(parsed.pathname);
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
    let wrappedFetch = null;

    if (typeof nativeFetch === "function") {
        wrappedFetch = async function(input, init) {
            if (!enabled) return nativeFetch.apply(this, arguments);

            const isRequest = typeof Request !== "undefined" && input instanceof Request;
            const url = isRequest ? input.url : input;
            const method = (init && init.method) || (isRequest && input.method) || "GET";

            if (!isConversationPost(url, method)) {
                return nativeFetch.apply(this, arguments);
            }

            try {
                let rawBody = null;
                const hasInitBody = !!init && Object.prototype.hasOwnProperty.call(init, "body");

                if (hasInitBody) {
                    if (typeof init.body !== "string") {
                        warn("Matched conversation request has a non-string body; passed through unchanged.");
                        return nativeFetch.apply(this, arguments);
                    }
                    rawBody = init.body;
                } else if (isRequest) {
                    rawBody = await input.clone().text();
                }

                if (typeof rawBody !== "string") {
                    warn("Matched conversation request body could not be read; passed through unchanged.");
                    return nativeFetch.apply(this, arguments);
                }

                const modifiedBody = modifyPayload(rawBody);
                if (!modifiedBody) {
                    return nativeFetch.apply(this, arguments);
                }

                const nextInit = Object.assign({}, init || {}, { body: modifiedBody });
                log("Terminal-mode instruction appended to conversation POST (fetch).");

                if (isRequest) {
                    return nativeFetch.call(this, new Request(input, nextInit));
                }
                return nativeFetch.call(this, input, nextInit);
            } catch (error) {
                warn("Fetch interception failed; original request sent unchanged.", error && error.name);
                return nativeFetch.apply(this, arguments);
            }
        };

        window.fetch = wrappedFetch;
    } else {
        warn("fetch is unavailable; no fetch hook installed.");
    }

    let nativeOpen = null;
    let nativeSend = null;
    let wrappedOpen = null;
    let wrappedSend = null;

    if (typeof XMLHttpRequest !== "undefined") {
        const xhrMeta = new WeakMap();
        nativeOpen = XMLHttpRequest.prototype.open;
        nativeSend = XMLHttpRequest.prototype.send;

        wrappedOpen = function(method, url) {
            xhrMeta.set(this, {
                method: String(method || "GET").toUpperCase(),
                url: String(url)
            });
            return nativeOpen.apply(this, arguments);
        };

        wrappedSend = function(body) {
            const meta = xhrMeta.get(this);
            if (enabled && meta && isConversationPost(meta.url, meta.method) && typeof body === "string") {
                const modifiedBody = modifyPayload(body);
                if (modifiedBody) {
                    body = modifiedBody;
                    log("Terminal-mode instruction appended to conversation POST (XHR).");
                }
            }
            return nativeSend.call(this, body);
        };

        XMLHttpRequest.prototype.open = wrappedOpen;
        XMLHttpRequest.prototype.send = wrappedSend;
    }

    let enabled = true;
    const instance = {
        version: VERSION,
        get enabled() {
            return enabled;
        },
        toggle() {
            enabled = !enabled;
            log("Enabled:", enabled);
            return enabled;
        },
        stop() {
            enabled = false;
            if (wrappedFetch && window.fetch === wrappedFetch) window.fetch = nativeFetch;
            if (nativeOpen && XMLHttpRequest.prototype.open === wrappedOpen) {
                XMLHttpRequest.prototype.open = nativeOpen;
            }
            if (nativeSend && XMLHttpRequest.prototype.send === wrappedSend) {
                XMLHttpRequest.prototype.send = nativeSend;
            }
            if (window[INSTANCE_KEY] === instance) delete window[INSTANCE_KEY];
            if (window[VERSION_KEY] === VERSION) delete window[VERSION_KEY];
            log("Stopped.");
        }
    };

    window[INSTANCE_KEY] = instance;
    window[VERSION_KEY] = VERSION;

    log("Installed", VERSION, "(request-side prompt instruction only).");
})();
