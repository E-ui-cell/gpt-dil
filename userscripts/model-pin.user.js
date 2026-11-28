// ==UserScript==
// @name         ChatGPT - Luna Model Pin + Reasoning
// @namespace    https://github.com/E-ui-cell/gpt-dil
// @version      0.2.0
// @description  Set the native ChatGPT default model and patch conversation model/reasoning fields.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      MAIN
// @grant        none
// @updateURL    https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js
// @downloadURL  https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js
// ==/UserScript==

(() => {
    "use strict";

    // Configuration. No custom UI is added.
    const TARGET_MODEL = "gpt-5.6-luna-wm";

    // Kept separate from TARGET_MODEL to preserve the model_slug behavior
    // used by the previous 3.2.0 test script. Set to TARGET_MODEL to test both.
    const TARGET_MODEL_SLUG = "auto";

    const TARGET_THINKING_EFFORT = "extended";
    const ENABLE_REASON_HINT = true;

    // Rewrite the model defaults returned by /conversation/init.
    const PATCH_INIT_DEFAULT = true;

    // Patch the outgoing generation request.
    const PATCH_CONVERSATION_REQUEST = true;

    const INIT_PATTERN =
        /\/backend-api\/(?:f\/)?conversation\/init(?:[?#]|$)/;

    const PATCH_PATTERN =
        /\/backend-api\/(?:f\/)?conversation(?:\/prepare)?(?:[?#]|$)/;

    const OBSERVE_PATTERN =
        /\/backend-api\/(?:f\/)?conversation(?:\/(?:prepare|init))?(?:[/?#]|$)/;

    const KEY = "__GPT_DIL_LUNA_MODEL_PIN__";
    const MODEL_FIELDS = new Set([
        "model",
        "model_slug",
        "default_model_slug",
        "resolved_model_slug",
        "last_message_model_slug",
        "intended_default_model_slug"
    ]);

    // Remove an earlier instance before installing a new one.
    window[KEY]?.stop?.();

    let enabled = true;

    const nativeFetch = window.fetch;
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    const xhrInfo = new WeakMap();

    function getUrl(input) {
        if (typeof input === "string") return input;
        if (typeof URL !== "undefined" && input instanceof URL) return input.href;
        return input?.url || "";
    }

    function getMethod(input, init) {
        const isRequest =
            typeof Request !== "undefined" && input instanceof Request;

        return String(
            init?.method || (isRequest ? input.method : "GET")
        ).toUpperCase();
    }

    function isConversationPatch(url, method) {
        return method === "POST" && PATCH_PATTERN.test(url) &&
            !INIT_PATTERN.test(url);
    }

    function patchBody(body, transport) {
        if (typeof body !== "string") {
            console.warn("[ModelPin] Unsupported request body; unchanged:", transport);
            return body;
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            console.warn("[ModelPin] Request body isn't JSON; unchanged:", transport);
            return body;
        }

        if (!payload || typeof payload !== "object" ||
            !Object.prototype.hasOwnProperty.call(payload, "model")) {
            return body;
        }

        const previous = {
            model: payload.model,
            model_slug: payload.model_slug,
            thinking_effort: payload.thinking_effort,
            system_hints: Array.isArray(payload.system_hints)
                ? payload.system_hints.slice()
                : payload.system_hints
        };

        payload.model = TARGET_MODEL;
        payload.model_slug = TARGET_MODEL_SLUG;
        payload.thinking_effort = TARGET_THINKING_EFFORT;

        if (ENABLE_REASON_HINT) {
            const hints = Array.isArray(payload.system_hints)
                ? payload.system_hints.slice()
                : [];
            if (!hints.includes("reason")) hints.push("reason");
            payload.system_hints = hints;
        }

        if (
            previous.model === payload.model &&
            previous.model_slug === payload.model_slug &&
            previous.thinking_effort === payload.thinking_effort &&
            JSON.stringify(previous.system_hints) === JSON.stringify(payload.system_hints)
        ) {
            return body;
        }

        console.groupCollapsed("[ModelPin] Outgoing conversation payload");
        console.info("model:", previous.model, "->", payload.model);
        console.info("model_slug:", previous.model_slug ?? "unset", "->", payload.model_slug);
        console.info(
            "thinking_effort:",
            previous.thinking_effort ?? "default",
            "->",
            payload.thinking_effort
        );
        console.info("system_hints:", previous.system_hints ?? "unset", "->", payload.system_hints ?? "unset");
        console.groupEnd();

        return JSON.stringify(payload);
    }

    function rewriteInitResponse(response, url) {
        if (!PATCH_INIT_DEFAULT || !response.ok) return Promise.resolve(response);

        return response.clone().json().then(data => {
            if (!data || typeof data !== "object") return response;

            const previous = {
                default: data.default_model_slug,
                intended: data.intended_default_model_slug
            };

            data.default_model_slug = TARGET_MODEL;
            data.intended_default_model_slug = TARGET_MODEL;

            const headers = new Headers(response.headers);
            headers.delete("content-length");
            headers.delete("content-encoding");
            headers.delete("transfer-encoding");

            console.info(
                "[ModelPin] conversation/init defaults:",
                previous,
                "->",
                TARGET_MODEL
            );

            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers
            });
        }).catch(error => {
            console.warn("[ModelPin] Init response rewrite failed; original response kept:", error);
            return response;
        });
    }

    function reportModelFields(value, source) {
        const found = [];

        function walk(node, path, depth) {
            if (depth > 14 || node === null || typeof node !== "object") return;

            if (Array.isArray(node)) {
                node.forEach((item, index) =>
                    walk(item, path + "[" + index + "]", depth + 1)
                );
                return;
            }

            for (const [key, child] of Object.entries(node)) {
                const childPath = path ? path + "." + key : key;

                if (MODEL_FIELDS.has(key)) {
                    found.push({ path: childPath, value: child });
                }

                if (key === "reasoning_status" ||
                    key === "reasoning_recap_type" ||
                    key === "cot_version") {
                    found.push({ path: childPath, value: child });
                }

                if (key === "content_type" && child === "reasoning_recap") {
                    found.push({ path: childPath, value: child });
                }

                walk(child, childPath, depth + 1);
            }
        }

        walk(value, "", 0);

        if (found.length) {
            console.groupCollapsed("[ModelPin] Server metadata (" + source + ")");
            for (const item of found) console.info(item.path, item.value);
            console.groupEnd();
        }
    }

    function inspectText(text, source) {
        if (typeof text !== "string" || !text.trim()) return;

        try {
            reportModelFields(JSON.parse(text), source);
            return;
        } catch {
            // Conversation response may be SSE.
        }

        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            try {
                reportModelFields(JSON.parse(data), source + " (SSE)");
            } catch {
                // Ignore non-JSON SSE lines.
            }
        }
    }

    function observeResponse(response, url) {
        if (INIT_PATTERN.test(url)) {
            return rewriteInitResponse(response, url);
        }

        if (!OBSERVE_PATTERN.test(url)) return Promise.resolve(response);

        return response.clone().text().then(text => {
            inspectText(text, url);
            return response;
        }).catch(() => response);
    }

    function sendFetch(input, init, url) {
        return nativeFetch.call(this, input, init).then(response =>
            observeResponse(response, url)
        );
    }

    // Fetch interception.
    window.fetch = function(input, init) {
        if (!enabled) return nativeFetch.apply(this, arguments);

        const isRequest =
            typeof Request !== "undefined" && input instanceof Request;

        const url = getUrl(input);
        const method = getMethod(input, init);
        const patch = PATCH_CONVERSATION_REQUEST &&
            isConversationPatch(url, method);
        const observe = OBSERVE_PATTERN.test(url);
        const rewriteInit = PATCH_INIT_DEFAULT && INIT_PATTERN.test(url);

        if (!patch && !observe && !rewriteInit) {
            return nativeFetch.apply(this, arguments);
        }

        // A string body supplied through fetch init.
        if (typeof init?.body === "string") {
            const modified = patch
                ? patchBody(init.body, "fetch")
                : init.body;
            const nextInit = modified === init.body
                ? init
                : { ...init, body: modified };

            return sendFetch.call(this, input, nextInit, url);
        }

        // A Request object may carry the body.
        if (
            patch &&
            isRequest &&
            (!init ||
             !Object.prototype.hasOwnProperty.call(init, "body"))
        ) {
            return input.clone().text().then(body => {
                const modified = patchBody(body, "fetch Request");
                if (modified === body) {
                    return sendFetch.call(this, input, init, url);
                }

                const replacement = new Request(input, {
                    ...(init || {}),
                    body: modified
                });

                return sendFetch.call(this, replacement, undefined, url);
            }).catch(error => {
                console.warn("[ModelPin] Could not read Request body; sending original once:", error);
                return sendFetch.call(this, input, init, url);
            });
        }

        if (patch && init?.body != null && typeof init.body !== "string") {
            console.warn("[ModelPin] Non-string conversation body; request unchanged.");
        }

        return sendFetch.call(this, input, init, url);
    };

    // XMLHttpRequest interception.
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        xhrInfo.set(this, {
            method: String(method),
            url: String(url)
        });
        return xhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
        const info = xhrInfo.get(this);
        if (!enabled || !info) return xhrSend.call(this, body);

        const method = info.method.toUpperCase();
        const patch = PATCH_CONVERSATION_REQUEST &&
            isConversationPatch(info.url, method);
        const observe = OBSERVE_PATTERN.test(info.url);

        if (observe) {
            this.addEventListener("load", () => {
                try {
                    const responseText =
                        typeof this.responseText === "string"
                            ? this.responseText
                            : (
                                this.response &&
                                typeof this.response === "object"
                                    ? JSON.stringify(this.response)
                                    : ""
                            );

                    inspectText(responseText, info.url + " XHR response");
                } catch {
                    // responseText can be unavailable for non-text response types.
                }
            }, { once: true });
        }

        if (patch) body = patchBody(body, "XHR");

        // XHR init responses are observed but not rewritten. The fetch path handles
        // the init response mutation used by the earlier Luna-default test script.
        return xhrSend.call(this, body);
    };

    const wrappedFetch = window.fetch;

    function stop() {
        enabled = false;
        if (window.fetch === wrappedFetch) window.fetch = nativeFetch;
        XMLHttpRequest.prototype.open = xhrOpen;
        XMLHttpRequest.prototype.send = xhrSend;
        console.info("[ModelPin] Stopped.");
    }

    window[KEY] = {
        target: TARGET_MODEL,
        modelSlug: TARGET_MODEL_SLUG,
        reasoning: TARGET_THINKING_EFFORT,
        get enabled() {
            return enabled;
        },
        toggle() {
            enabled = !enabled;
            console.info("[ModelPin] Enabled:", enabled);
            return enabled;
        },
        stop
    };

    console.info(
        "[ModelPin] Installed. Init default:",
        TARGET_MODEL,
        "| model:",
        TARGET_MODEL,
        "| model_slug:",
        TARGET_MODEL_SLUG,
        "| effort:",
        TARGET_THINKING_EFFORT,
        "| reason hint:",
        ENABLE_REASON_HINT
    );
})();
