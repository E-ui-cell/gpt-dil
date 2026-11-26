# CHATGPT CAPTURE

## AUTOMATIC CLOUD CAPTURE

Runs every day at **03:17 UTC** and whenever the public collector or its workflow changes. Windows uses Chromium; Ubuntu runs Chromium, Firefox and WebKit.

Each run creates a public GitHub Release named `capture-RUN_ID`, with separate Windows and Linux archives. Manual runs are available from **Actions → ChatGPT Capture → Run workflow**; choose one runner or both.

Actions artifacts are retained for 14 days. Release assets remain until deleted.

## CLOUD DATA

- Public ChatGPT DOM snapshot with inline scripts and sensitive attributes removed
- JavaScript, CSS, static JSON assets and exposed source maps
- Request URLs, methods, query parameter names, resource types, status codes and timings
- JSON request and response schemas, without values
- Streaming response event names and JSON shapes, without values
- A fixed anonymous test turn's request/response schema and completion markers
- WebSocket connection metadata, frame sizes and JSON shapes, without values
- Script URLs, hashes, source-map references and executed function ranges
- Chromium performance metrics, script coverage, resource timing and browser errors
- Local/session storage key names, IndexedDB database names and service-worker scopes

The cloud browser is fresh and unauthenticated. Linux Firefox sends one fixed, harmless anonymous test prompt per run to exercise the real conversation request and response stream; no account is used and no user-provided text is sent. It cannot see your ChatGPT account traffic.

See [protocol notes](protocol-notes.md) for the first endpoint, authentication, streaming, upload and voice findings.

## LOCAL AUTHENTICATED CAPTURE

Run this on Windows from the repository or installed GPT-DIL folder:

```powershell
.\Capture-Local.ps1
```

It launches a separate Chrome profile with remote debugging enabled, then captures browser-visible ChatGPT traffic. Sign into ChatGPT in that Chrome window and use it normally. Press **Ctrl+C** in the PowerShell window to finish and write the report.

The first run installs Playwright locally and creates a persistent Chrome profile at `%LOCALAPPDATA%\GPT-DIL\ChromeProfile`. Capture output is written to `Documents\GPT-DIL-Captures`.

Local capture includes:

- Actual JSON request and response bodies, including message and tool payloads
- Completed text/event-stream responses and their event data
- Selected image, audio, video, PDF and binary responses (32 MB per response limit)
- Sent and received WebSocket text frames
- DIL frame, MessagePort, Worker, SharedWorker and BroadcastChannel messages in both directions, with sensitive fields redacted
- Request/response status, headers names, content types and timings
- Sanitized DOM snapshots, resource lists and browser diagnostics
- Cookie names/attributes, storage key names and IndexedDB database names

Authorization/cookie header values, cookie values, common credential fields, and multipart upload contents are excluded. Selected binary responses are saved locally. Conversation text is deliberately retained for protocol analysis. DIL bridge events are written to `dil-bridge.jsonl`; use `node tools/analyze-dil-bridge.mjs path\\to\\dil-bridge.jsonl` to summarize runner lifetimes, command IDs and long event gaps.

**Local captures are private. They can contain your conversations. Never upload them to this public repository or its Releases.** Share only a copy you have inspected and redacted.

## LIMITS

This collects browser-visible data. It cannot reveal server-side prompts, model internals, private backend code, or hidden model reasoning. Cloud Releases contain public frontend data and sanitized schemas only.
