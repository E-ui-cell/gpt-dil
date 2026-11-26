# CHATGPT WEB PROTOCOL NOTES

These are observations from the public `unauth-mweb` JavaScript bundles collected on 2026-11-26. They are not a complete specification of every ChatGPT client or account mode.

## OBSERVED REQUEST ROUTES

The unauthenticated landing page issued:

- `POST /unauth-mweb/sentinel/chat-requirements/prepare`
- `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=1`
- `GET /api/auth/account-picker`
- `GET /backend-anon/beacons/home?product`
- `POST /unauth-mweb/events/page-view`
- `POST /unauth-mweb/events/statsc/flush`
- `POST /unauth-mweb/events/performance`
- `POST /unauth-mweb/events/business`

The observed conversation-prepare response schema contains `conduit_token` and `prepare_cadence_enabled`.

The Sentinel prepare response schema contains `persona`, `prepare_token`, `proofofwork`, `so`, and `turnstile`. The proof-of-work object contains `difficulty`, `required`, and `seed`.

## AUTHENTICATED LIGHTWEIGHT CLIENT

The downloaded `authenticated-browser-client` bundle contains an explicit route allowlist.

POST routes:

- `/conversation/prepare`
- `/conversation/updates`
- `/entity-detail`
- `/stop_conversation`
- `/authenticated-file-uploads/retry-policy`
- `/sentinel/chat-requirements/prepare`
- `/sentinel/chat-requirements/finalize`

GET routes:

- `/thinking-models`
- `/voice/policy`

It also permits selected `/backend-api/*` routes and `/public-api/report_flow/report`.

The lightweight client adds `lightweight_authenticated=1` to the relevant requests. The bundle shows these header names being prepared:

- `Authorization`
- `OAI-Device-Id`
- `OAI-Language`
- `OAI-Client-Version`
- `OAI-Client-Build-Number`
- `x-openai-web-frontend`
- `ChatGPT-Account-ID`
- `X-OAI-Lightweight-Default-Model`
- `X-OAI-Lightweight-Session-Proof`

No header values or session credentials are included in these notes.

The client uses `fetch` with `cache: no-store` and `redirect: error`. It checks session identity and session-proof expiry, and contains retry handling for `token_expired`, `lightweight_session_proof_expired`, and `lightweight_session_proof_invalid`.

## STREAMING

The bundle exports an `authenticatedBrowserStreamFetch` function. It uses the same authenticated request path but selects a streaming mode that returns the original `Response` rather than reading and rebuilding a bounded response body.

The regular fetch path can read a bounded response body and construct a new `Response`. This distinction matters when instrumenting streaming: a response-side hook must preserve the original body stream and not consume it before the application does.

The conversation UI uses DOM completion markers including:

- `data-conversation-control="complete"`
- `data-conversation-control="message-stream-complete"`

The public landing-page capture did not yet show an authenticated `/conversation/updates` exchange. The local authenticated capture is needed to confirm the actual stream framing, event names, message patches, and tool-call payloads.

## FILES AND VOICE

Observed upload routes:

- `POST /backend-api/files`
- `POST /backend-api/files/process_upload_stream`
- `POST /backend-api/estuary/upload_content_bytes`

Observed dictation routes:

- `/backend-api/dictation/stream?client_type=web`
- `/backend-api/dictation/v2/stream?client_type=web`

The bundle also prepares a voice WebSocket at `/realtime/wm?dcid=0`, using subprotocol names `chatgpt-dictation` and `openai-bearer.*`. The actual bearer value is never recorded here.

## HISTORY

A history-related bundle reads `Response.body` with `getReader()` and `TextDecoder`, then parses line-delimited JSON records. The parser expects record types `history` and `snapshot`, each with a `value` field.

This is a separate history transport path; it should not be assumed to be the same framing as live conversation streaming.

## NEXT CONFIRMATION

The next local capture should verify, using the logged-in browser:

1. The exact request body for `/conversation/prepare`.
2. The exact `/conversation/updates` request and response content type.
3. Stream framing and event/patch types.
4. How tool calls, attachments, citations, reasoning and final messages are represented.
5. Which headers and fields change between normal, lightweight and worker requests.

Local captures contain conversation text and must remain private. Never upload them to this public repository or its Releases.
