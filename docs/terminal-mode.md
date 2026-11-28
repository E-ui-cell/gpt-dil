# Terminal Mode userscript

Install the [Terminal Mode userscript](https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/terminal-mode.user.js) in Tampermonkey.

This is a separate Tampermonkey userscript named "GPT-DIL - Terminal Mode". It does not replace or modify the existing Plain Text Payload userscript.

The script asks ChatGPT to answer in plain, terminal-friendly text: no Markdown headings, bullets, numbered lists, tables, emphasis, Markdown links, or fenced code blocks. Commands, paths, logs, configuration, and source code should be returned as raw text, with meaningful indentation preserved.

## What it changes

The script intercepts outgoing POST requests to the ChatGPT conversation endpoints and appends the editable CUSTOM_PAYLOAD_TEXT instruction to the last text part of the latest user message. It supports fetch and XMLHttpRequest, including the legacy conversation route and the /prepare route. It does not add request fields, inspect response bodies, read headers, or add a UI.

The instruction becomes part of the user message sent to ChatGPT and may appear in the conversation history.

## Important limitation

This is a prompt instruction, not an output filter. The model can ignore it or still produce Markdown. The script does not change the response renderer and does not disable DIL. Keep the separate Block DIL script enabled if you also want its response-side DIL filtering; the two scripts do different jobs.

## Configuration and controls

Edit CUSTOM_PAYLOAD_TEXT near the top of the script to change the instruction.

The page exposes window.__GPT_DIL_TERMINAL_MODE__ for manual control from DevTools:

- window.__GPT_DIL_TERMINAL_MODE__.toggle() enables or disables request modification.
- window.__GPT_DIL_TERMINAL_MODE__.stop() removes this script's hooks.

The script is experimental and depends on ChatGPT's private conversation request format.
