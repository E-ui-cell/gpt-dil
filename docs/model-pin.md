# Luna model pin and reasoning userscript

Install the raw Tampermonkey script:

https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js

This script adds **no floating panel or custom controls**. Keep the separate native merged-model-picker userscript enabled; this script complements it.

It combines the two earlier techniques:
- Rewrite successful `/backend-api/conversation/init` JSON responses so `default_model_slug` and `intended_default_model_slug` are set to Luna WM.
- Patch outgoing POSTs to `/backend-api/(f/)conversation` and `/prepare` using the existing top-level fields `model`, `model_slug`, and `thinking_effort`.
- Preserve `system_hints` exactly as supplied by the native UI; the script does not turn Think on or off.
- Observe response model fields and reasoning metadata, including SSE records.

Configuration is at the top of the script:
- `TARGET_MODEL = "gpt-5.6-luna-wm"`
- `TARGET_MODEL_SLUG = "auto"` (kept separate intentionally, as in the previous 3.2.0 script)
- `TARGET_THINKING_EFFORT = "extended"`

The clean no-Tampermonkey capture showed native requests using `model: "auto"`; Think added `system_hints: ["reason"]`; the server resolved Instant to `gpt-6` and Think to `gpt-6-t-mini`. The earlier script version forcibly appended that hint, which unintentionally enabled native Think and routed to `gpt-6-t-mini`. The current version leaves `system_hints` untouched while retaining the configured `thinking_effort`. The model catalogue advertised Luna and Terra WM with `standard` and `extended` effort values.

The capture did **not** prove that a forced Luna slug or `thinking_effort` is accepted. Check the console's server metadata after sending a message. A requested model is not proof of the resolved model. The script does not bypass account limits or model availability.

The conversation endpoint is private and unsupported; its payload can change. If Cloudflare challenges begin, disable this script and test without it. XHR conversation requests are patched and observed; `conversation/init` response rewriting is implemented for fetch, matching the earlier test script.

Run tests with `node --test tests/model-pin.test.mjs`. These tests validate local request/response mutation only, not server acceptance.
