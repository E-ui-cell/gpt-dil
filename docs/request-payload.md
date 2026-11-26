# OBSERVED REQUEST SHAPE

The captured web request uses:

POST /backend-api/f/conversation

The relevant message structure is:

- messages[]
- messages[].author.role = "user"
- messages[].content.content_type = "text"
- messages[].content.parts[] = text

The userscript edits only the last text part of the newest user message. It leaves other message fields, request headers, response streaming, and model response contracts unchanged.

# IMPORTANT

This is a private ChatGPT web endpoint, not a supported public API. Its format can change.

The observed web.mica.v1 contract is related to Mica/web-search metadata, not a plain-text output switch. Do not change it to guess at a text mode.

The formatting preference is added to the actual user message. It may be visible in the conversation transcript. It is only a prompt-level preference: it cannot guarantee plain text and does not disable Markdown or DIL rendering.

Never commit HAR files, request headers, cookies, bearer tokens, Sentinel tokens, or real user message text.
