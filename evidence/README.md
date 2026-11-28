# Authenticated browser protocol baseline

This directory contains a deliberately small, sanitized extract from a local authenticated ChatGPT browser capture, collected on 2026-11-28 with Tampermonkey not installed.

The JSON records only:
- the model catalogue entries relevant to the custom userscript experiment;
- the request-level model and Think hint observed in native ChatGPT turns;
- server-reported resolved model and reasoning metadata.

It excludes raw request/response bodies, all user and assistant message text, conversation and request IDs, account identifiers, cookies, authorization values, headers, and account-specific usage limits. The full local capture is private and is not included.

The baseline establishes native behavior only. It does not establish that a custom model slug or a custom thinking-effort value will be accepted when forced into a request. The userscript must report the server-resolved model rather than treating the requested value as proof of selection.

See `chatgpt-web-model-baseline-2026-11-28.json`.
