# GPT-DIL

Small browser tools for ChatGPT.

## What's inside

- uBlock Origin filters
- Tampermonkey userscripts:
  - [Model pin and reasoning](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js)
  - [Plain-text custom payload hook](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js)
- Automated protocol capture
- Windows installer

## Model pin userscript

Install the [model-pin userscript](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js) alongside your separate native merged-model-picker script. It rewrites the conversation-init model defaults, patches outgoing model/slug/reasoning fields, and logs server-reported model and reasoning metadata. It adds no floating panel or custom UI.

See [model-pin documentation](docs/model-pin.md) and the [sanitized authenticated protocol baseline](evidence/chatgpt-web-model-baseline-2026-11-28.json).

## Custom text payload

Install the [plain-text userscript](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js). Edit its CUSTOM_PAYLOAD_TEXT block to change the text appended to the latest user message.

## Capture

Daily Windows + Linux captures are published in [Releases](https://github.com/E-ui-cell/gpt-dil/releases). Authenticated local captures can contain conversation text. Keep raw local captures private; publish only separately reviewed and sanitized extracts.

## Local protocol

Run .\Capture-Local.ps1 in PowerShell. This opens a separate Chrome profile for authenticated traffic capture, including DIL frame and MessagePort traffic. Sign in there and use ChatGPT. Captures stay on your PC.

## Install and update

Run .\Install.ps1 -Force from the installed folder.

## Status

Experimental. The ChatGPT web endpoint is private and unsupported; its format can change.
