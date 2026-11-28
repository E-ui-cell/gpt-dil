# Model pin and reasoning userscript

Install from the raw script URL:

https://raw.githubusercontent.com/E-ui-cell/gpt-dil/main/userscripts/model-pin.user.js

The script adds a small settings panel to ChatGPT. It defaults to model slug `gpt-5.6-luna-wm`, effort `standard`, and no extra `reason` system hint. The model and effort can be changed in the panel. Settings are stored in the ChatGPT page's local storage.

The hook only changes POST requests to:
- `/backend-api/f/conversation`
- `/backend-api/conversation`

Observed from the clean authenticated capture:
- Native requests used top-level `model: "auto"`.
- Native Think added `system_hints: ["reason"]`.
- The server resolved Instant to `gpt-6` and Think to `gpt-6-t-mini`.
- The catalogue advertised `gpt-5.6-luna-wm` and `gpt-5.6-terra-wm` with `standard` and `extended` effort options.

Experimental fields:
- The capture did not show a native request with a forced Luna/Terra model slug.
- The capture did not show a native `thinking_effort` request field.
- The script sends the selected slug in the observed top-level `model` field and optionally adds `thinking_effort`. Acceptance must be verified from the server response.
- The optional reason checkbox adds `"reason"` to `system_hints`. It is independent from the effort setting.

After each modified conversation request, the panel reports HTTP status, requested model, server-resolved model when present, and reasoning metadata. It does not display response text or reasoning content. A requested model is not proof that the backend selected it.

The userscript cannot bypass model availability, account limits, or plan restrictions. The ChatGPT web endpoint is private and unsupported; its payload contract may change. If it produces Cloudflare challenges or other browser problems, disable the script and test again without it.

Run tests with `node --test`. These tests validate local request mutation and metadata parsing only; they do not prove that ChatGPT accepts the custom fields.
