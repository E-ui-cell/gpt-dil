// ==UserScript==
// @name         ChatGPT - Block DIL Rendering
// @namespace    https://github.com/E-ui-cell/gpt-dil
// @version      0.1.0
// @description  Removes model_dil_v2 response metadata while preserving fallbackMarkdown.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      MAIN
// @grant        none
// @updateURL    https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/block-dil.user.js
// @downloadURL  https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/block-dil.user.js
// ==/UserScript==

(() => {
    "use strict";

    const ENDPOINT_PATTERN =
        /\/backend-api\/(?:f\/)?conversation(?:\/prepare)?(?:[?#]|$)/;

    const KEY = "__GPT_DIL_BLOCKER__";
    window[KEY]?.stop?.();

    const nativeFetch = window.fetch;
    let enabled = true;
    let removedCount = 0;

    function stripDIL(value) {
        if (!value || typeof value !== "object") return value;

        if (Array.isArray(value)) {
            for (const item of value) stripDIL(item);
            return value;
        }

        if (
            Object.prototype.hasOwnProperty.call(value, "model_dil_v2")
        ) {
            delete value.model_dil_v2;
            removedCount++;
        }

        for (const child of Object.values(value)) {
            stripDIL(child);
        }

        return value;
    }

    function stripSSELine(line) {
        const match = /^(\s*data:\s*)(.*)$/.exec(line);
        if (!match || !match[2] || match[2] === "[DONE]") return line;

        try {
            const event = JSON.parse(match[2]);
            stripDIL(event);
            return match[1] + JSON.stringify(event);
        } catch {
            return line;
        }
    }

    function rewriteHeaders(response) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.delete("transfer-encoding");
        return headers;
    }

    async function rewriteJSON(response) {
        const data = await response.clone().json();
        stripDIL(data);

        return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: rewriteHeaders(response)
        });
    }

    function rewriteSSE(response) {
        if (!response.body) return Promise.resolve(response);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let pending = "";

        const body = new ReadableStream({
            async pull(controller) {
                try {
                    const { value, done } = await reader.read();

                    if (done) {
                        pending += decoder.decode();
                        if (pending) {
                            controller.enqueue(encoder.encode(stripSSELine(pending)));
                        }
                        controller.close();
                        return;
                    }

                    pending += decoder.decode(value, { stream: true });
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop() ?? "";

                    if (lines.length) {
                        const output = lines.map(stripSSELine).join("\n") + "\n";
                        controller.enqueue(encoder.encode(output));
                    }
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel(reason) {
                return reader.cancel(reason);
            }
        });

        return Promise.resolve(new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: rewriteHeaders(response)
        }));
    }

    async function rewriteResponse(response) {
        if (!response.ok) return response;

        const contentType = response.headers.get("content-type") || "";

        try {
            if (contentType.includes("text/event-stream")) {
                return await rewriteSSE(response);
            }

            if (contentType.includes("application/json")) {
                return await rewriteJSON(response);
            }
        } catch (error) {
            console.warn("[DILBlock] Response rewrite failed; original response kept:", error);
        }

        return response;
    }

    window.fetch = function(input, init) {
        if (!enabled) return nativeFetch.apply(this, arguments);

        const url = typeof input === "string"
            ? input
            : (input?.url || "");

        if (!ENDPOINT_PATTERN.test(url)) {
            return nativeFetch.apply(this, arguments);
        }

        return nativeFetch.apply(this, arguments).then(rewriteResponse);
    };

    const wrappedFetch = window.fetch;

    function stop() {
        enabled = false;
        if (window.fetch === wrappedFetch) window.fetch = nativeFetch;
        console.info("[DILBlock] Stopped.");
    }

    window[KEY] = {
        get enabled() {
            return enabled;
        },
        get removedCount() {
            return removedCount;
        },
        toggle() {
            enabled = !enabled;
            console.info("[DILBlock] Enabled:", enabled);
            return enabled;
        },
        stop
    };

    console.info("[DILBlock] Installed. Stripping model_dil_v2 from conversation responses.");
})();
