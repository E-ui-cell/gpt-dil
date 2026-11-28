// ==UserScript==
// @name         GPT-DIL - Model Pin and Reasoning
// @namespace    https://github.com/E-ui-cell/gpt-dil
// @version      0.1.0
// @description  Experimental ChatGPT web model and reasoning-effort selector.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @inject-into  page
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js
// @downloadURL  https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js
// ==/UserScript==

(() => {
    "use strict";

    const VERSION = "0.1.0";
    const KEY = "__GPT_DIL_MODEL_PIN_CONFIG_V1__";
    const DEFAULTS = {
        enabled: true,
        model: "gpt-5.6-luna-wm",
        effort: "standard",
        reasonHint: false
    };

    if (window.__GPT_DIL_MODEL_PIN_VERSION__ === VERSION) return;
    window.__GPT_DIL_MODEL_PIN_VERSION__ = VERSION;

    let statusNode = null;
    let lastRequest = null;

    const log = (...args) => console.info("[GPT-DIL Model Pin]", ...args);
    const warn = (...args) => console.warn("[GPT-DIL Model Pin]", ...args);

    function config() {
        try {
            const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
            return Object.assign({}, DEFAULTS, saved && typeof saved === "object" ? saved : {});
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function save(next) {
        try {
            localStorage.setItem(KEY, JSON.stringify(next));
        } catch (error) {
            warn("Could not save settings:", error && error.name);
        }
    }

    function setStatus(message) {
        if (statusNode) statusNode.textContent = message;
        log(message);
    }

    function isConversationPost(url, method) {
        if (String(method || "GET").toUpperCase() !== "POST") return false;
        try {
            const parsed = new URL(String(url), location.href);
            return (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com") &&
                (parsed.pathname === "/backend-api/f/conversation" ||
                 parsed.pathname === "/backend-api/conversation");
        } catch (_) {
            return false;
        }
    }

    function patchPayload(raw) {
        let body;
        try {
            body = JSON.parse(raw);
        } catch (_) {
            return null;
        }

        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return null;

        const cfg = config();
        if (!cfg.enabled) return null;

        const model = String(cfg.model || "").trim();
        if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(model)) {
            setStatus("Invalid model slug. Request passed through unchanged.");
            return null;
        }

        const effort = String(cfg.effort || "native").toLowerCase();
        if (!["native", "standard", "extended"].includes(effort)) {
            setStatus("Invalid effort setting. Request passed through unchanged.");
            return null;
        }

        // The clean native capture uses top-level "model". It does not use model_slug.
        body.model = model;

        // Experimental: the native Think capture did not contain thinking_effort.
        // This option is based on the model catalogue's advertised effort values.
        if (effort === "standard" || effort === "extended") {
            body.thinking_effort = effort;
        }

        if (cfg.reasonHint) {
            const hints = Array.isArray(body.system_hints) ? body.system_hints.slice() : [];
            if (!hints.includes("reason")) hints.push("reason");
            body.system_hints = hints;
        }

        const info = {
            requestedModel: model,
            effort: effort,
            reasonHint: Boolean(cfg.reasonHint)
        };
        lastRequest = info;
        setStatus("Modified request: " + model + " | effort: " + effort +
            " | reason hint: " + (info.reasonHint ? "on" : "off"));

        return { body: JSON.stringify(body), info: info };
    }

    function collectMetadata(value, found, depth) {
        if (depth > 16 || value == null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const item of value) collectMetadata(item, found, depth + 1);
            return;
        }

        for (const [key, item] of Object.entries(value)) {
            if (key === "resolved_model_slug" && typeof item === "string") found.resolved = item;
            if (key === "model_slug" && typeof item === "string" && !found.model) found.model = item;
            if (key === "reasoning_status" && typeof item === "string") found.reasoningStatus = item;
            if (key === "content_type" && item === "reasoning_recap") found.reasoningRecap = true;
            collectMetadata(item, found, depth + 1);
        }
    }

    function inspectResponse(text) {
        const found = { resolved: null, model: null, reasoningStatus: null, reasoningRecap: false };
        if (typeof text !== "string" || !text) return found;

        try {
            collectMetadata(JSON.parse(text), found, 0);
            return found;
        } catch (_) {
            // The conversation endpoint commonly streams SSE.
        }

        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
                collectMetadata(JSON.parse(data), found, 0);
            } catch (_) {
                // Ignore non-JSON stream records.
            }
        }
        return found;
    }

    function reportResponse(status, text, info) {
        const found = inspectResponse(text);
        const actual = found.resolved || found.model || "not reported";
        const reasoning = found.reasoningStatus || (found.reasoningRecap ? "recap present" : "no reasoning metadata observed");
        setStatus("HTTP " + status + " | requested: " + (info ? info.requestedModel : "unknown") +
            " | resolved: " + actual + " | reasoning: " + reasoning);
    }

    function observeResponse(response, info) {
        try {
            response.clone().text().then(text => reportResponse(response.status, text, info)).catch(error => {
                warn("Could not inspect response metadata:", error && error.name);
            });
        } catch (error) {
            warn("Could not clone response:", error && error.name);
        }
        return response;
    }

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
        window.fetch = async function(input, init) {
            const isRequest = typeof Request !== "undefined" && input instanceof Request;
            const url = isRequest ? input.url : input;
            const method = (init && init.method) || (isRequest && input.method) || "GET";
            if (!isConversationPost(url, method)) return nativeFetch.apply(this, arguments);

            let nextInput = input;
            let nextInit = init;
            let info = null;

            // Interception errors fall back to the untouched request. Network errors do not
            // trigger a retry, which could otherwise submit the same conversation twice.
            try {
                let raw = null;
                if (init && typeof init.body === "string") raw = init.body;
                else if (init && init.body != null) {
                    warn("Non-string conversation body; request passed through unchanged.");
                } else if (isRequest) {
                    raw = await input.clone().text();
                }

                if (typeof raw === "string") {
                    const patched = patchPayload(raw);
                    if (patched) {
                        info = patched.info;
                        if (isRequest) nextInput = new Request(input, Object.assign({}, init || {}, { body: patched.body }));
                        else nextInit = Object.assign({}, init || {}, { body: patched.body });
                    }
                }
            } catch (error) {
                warn("Interception failed; sending original request once:", error && error.name);
                nextInput = input;
                nextInit = init;
                info = null;
            }

            const response = await nativeFetch.call(this, nextInput, nextInit);
            return info ? observeResponse(response, info) : response;
        };
    } else {
        warn("fetch unavailable; no fetch hook installed.");
    }

    if (typeof XMLHttpRequest !== "undefined") {
        const metadata = new WeakMap();
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            metadata.set(this, { method: String(method || "GET").toUpperCase(), url: String(url) });
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(raw) {
            const meta = metadata.get(this);
            if (!meta || !isConversationPost(meta.url, meta.method) || typeof raw !== "string") {
                return originalSend.call(this, raw);
            }

            const patched = patchPayload(raw);
            if (patched) {
                raw = patched.body;
                meta.info = patched.info;
                this.addEventListener("load", () => {
                    try {
                        const text = this.responseType === "json" ? JSON.stringify(this.response) :
                            ((this.responseType === "" || this.responseType === "text") ? this.responseText : "");
                        reportResponse(this.status, text, meta.info);
                    } catch (error) {
                        warn("Could not inspect XHR response:", error && error.name);
                    }
                }, { once: true });
            }
            return originalSend.call(this, raw);
        };
    }

    function mountPanel() {
        if (document.getElementById("gpt-dil-model-pin-panel")) return;

        const style = document.createElement("style");
        style.textContent = [
            "#gpt-dil-model-pin-panel,#gpt-dil-model-pin-toggle{position:fixed;right:14px;z-index:2147483647;color:#f3f4f6;background:#171923;border:1px solid #454a5a;border-radius:9px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 5px 24px rgba(0,0,0,.35)}",
            "#gpt-dil-model-pin-panel{bottom:14px;width:285px;padding:11px;box-sizing:border-box}",
            "#gpt-dil-model-pin-panel .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:600}",
            "#gpt-dil-model-pin-panel label{display:block;margin:7px 0 3px;color:#cbd0dc}",
            "#gpt-dil-model-pin-panel input[type=text],#gpt-dil-model-pin-panel select{box-sizing:border-box;width:100%;padding:6px;color:#f3f4f6;background:#242838;border:1px solid #555d70;border-radius:5px}",
            "#gpt-dil-model-pin-panel .check{display:flex;gap:7px;align-items:center;margin-top:7px}",
            "#gpt-dil-model-pin-panel button,#gpt-dil-model-pin-toggle{padding:5px 8px;color:#f3f4f6;background:#30384d;border:1px solid #59647d;border-radius:5px;cursor:pointer}",
            "#gpt-dil-model-pin-panel .status{margin-top:9px;padding-top:8px;border-top:1px solid #3b4050;color:#c5d5fa;overflow-wrap:anywhere}",
            "#gpt-dil-model-pin-panel .note{margin-top:6px;color:#9da5b6;font-size:10px}",
            "#gpt-dil-model-pin-toggle{display:none;bottom:14px;padding:8px 10px}"
        ].join("");
        document.documentElement.appendChild(style);

        const cfg = config();
        const panel = document.createElement("div");
        panel.id = "gpt-dil-model-pin-panel";
        panel.innerHTML =
            '<div class="head"><span>GPT-DIL Model Pin</span><button type="button" data-hide>Hide</button></div>' +
            '<label class="check"><input type="checkbox" data-key="enabled"> Enable model override</label>' +
            '<label for="gpt-dil-model-value">Model slug</label>' +
            '<input id="gpt-dil-model-value" type="text" data-key="model" spellcheck="false" autocomplete="off">' +
            '<label for="gpt-dil-effort-value">Thinking effort</label>' +
            '<select id="gpt-dil-effort-value" data-key="effort">' +
            '<option value="native">Native / leave unchanged</option><option value="standard">standard</option><option value="extended">extended</option></select>' +
            '<label class="check"><input type="checkbox" data-key="reasonHint"> Add system_hints: reason</label>' +
            '<div class="status" data-status>Ready. No request modified yet.</div>' +
            '<div class="note">Requested model is not proof of selection. Check the server-resolved model below.</div>';

        const toggle = document.createElement("button");
        toggle.id = "gpt-dil-model-pin-toggle";
        toggle.type = "button";
        toggle.textContent = "GPT-DIL Model";
        document.documentElement.appendChild(panel);
        document.documentElement.appendChild(toggle);

        statusNode = panel.querySelector("[data-status]");
        for (const field of panel.querySelectorAll("[data-key]")) {
            const key = field.getAttribute("data-key");
            if (field.type === "checkbox") field.checked = Boolean(cfg[key]);
            else field.value = String(cfg[key] || DEFAULTS[key]);

            field.addEventListener("change", () => {
                const next = config();
                next[key] = field.type === "checkbox" ? field.checked : field.value;
                save(next);
                setStatus(next.enabled ? "Settings saved; applies to the next conversation request." :
                    "Override disabled; requests pass through unchanged.");
            });
        }

        if (lastRequest) statusNode.textContent = "Last requested model: " + lastRequest.requestedModel;
        panel.querySelector("[data-hide]").addEventListener("click", () => {
            panel.style.display = "none";
            toggle.style.display = "block";
        });
        toggle.addEventListener("click", () => {
            toggle.style.display = "none";
            panel.style.display = "block";
        });
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
        else mountPanel();
    }

    log("Hook active", VERSION, "default model:", DEFAULTS.model, "default effort:", DEFAULTS.effort);
})();
