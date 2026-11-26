# GPT-DIL

Small browser tools for ChatGPT.

# WHAT'S INSIDE

- uBlock Origin filters
- Tampermonkey userscripts
- Automated protocol capture
- Windows installer

# INSTALL

irm https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/Install.ps1 | iex

# CAPTURE

Daily Windows + Linux captures are published in [Releases](https://github.com/E-ui-cell/gpt-dil/releases).

# LOCAL PROTOCOL

Run `.\Capture-Local.ps1` in PowerShell.

This opens a separate Chrome profile for authenticated traffic capture. Sign in there and use ChatGPT. Captures stay on your PC.

# UPDATE

Run `.\Install.ps1 -Force` from the installed folder.

# STATUS

Experimental. Browser settings are never changed automatically.
