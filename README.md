# GPT-DIL

Small browser tools for ChatGPT.

## What's inside

- uBlock Origin filters
- Tampermonkey userscripts:
  - [Model pin and reasoning](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js)
  - [Plain-text custom payload hook](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js)
- Automated protocol capture
- Windows installer

## Tampermonkey: model pin

Install the [model-pin userscript](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js). It adds a panel to select a ChatGPT web model slug, thinking effort, and optional reason hint. The panel also reports the server-resolved model when the response exposes it.

See [model-pin documentation](docs/model-pin.md) and the [sanitized authenticated protocol baseline](evidence/chatgpt-web-model-baseline-2026-11-28.json).

## Custom text payload

Install the [plain-text userscript](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js). Edit its CUSTOM_PAYLOAD_TEXT block to change the text appended to the latest user message.

## Capture

Daily Windows + Linux captures are published in [Releases](https://github.com/E-ui-cell/gpt-dil/releases). They include sanitized anonymous request/response payloads, completed stream data, WebSocket text/JSON frames, public assets, iframe snapshots, and automated DIL-symbol/endpoint analysis.

Authenticated local captures can contain conversation text. Keep raw local captures private; only publish a separately reviewed and sanitized extract.

## Local protocol

Run .\Capture-Local.ps1 in PowerShell. This opens a separate Chrome profile for authenticated traffic capture, including DIL frame and MessagePort traffic. Sign in there and use ChatGPT. Captures stay on your PC.

Analyze DIL runner lifetimes and command traffic with node tools/analyze-dil-bridge.mjs <path-to-dil-bridge.jsonl>.

## Install and update

Run .\Install.ps1 -Force from the installed folder.

## Status

Experimental. Browser settings are never changed automatically. The ChatGPT web endpoint is private and unsupported; its format can change.
