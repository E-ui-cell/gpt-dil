# GPT-DIL

Small browser tools for ChatGPT.

# WHAT'S INSIDE

- uBlock Origin filters
- Tampermonkey userscripts
  - [Plain-text custom payload hook](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js)
- Automated protocol capture
- Windows installer

# INSTALL

irm https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/Install.ps1 | iex

# CUSTOM PAYLOAD

Install the [Tampermonkey script](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/plain-text-payload.user.js). Edit the `CUSTOM_PAYLOAD_TEXT` block near the top to change the text appended to the latest user message.

# CAPTURE

Daily Windows + Linux captures are published in [Releases](https://github.com/E-ui-cell/gpt-dil/releases). They include sanitized anonymous request/response payloads, completed stream data, WebSocket text/JSON frames, public assets, iframe snapshots and automated DIL-symbol/endpoint analysis.

# LOCAL PROTOCOL

Run `.\Capture-Local.ps1` in PowerShell.

This opens a separate Chrome profile for authenticated traffic capture, including DIL frame and MessagePort traffic. Sign in there and use ChatGPT. Captures stay on your PC.

Analyze DIL runner lifetimes and command traffic with `node tools/analyze-dil-bridge.mjs <path-to-dil-bridge.jsonl>`.

# UPDATE

Run `.\Install.ps1 -Force` from the installed folder.

# STATUS

Experimental. Browser settings are never changed automatically.
