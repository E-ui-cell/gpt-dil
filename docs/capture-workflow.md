# CHATGPT CAPTURE

Run it from GitHub:

1. Open **Actions**.
2. Select **ChatGPT Capture**.
3. Select Windows, Linux, or both.
4. Run the workflow.

Windows is the default. The workflow is manual-only and does not need API keys or account credentials.

## COLLECTED

- Sanitized ChatGPT DOM structure plus public JavaScript and CSS
- Static JSON assets and exposed source maps
- Network URLs, methods, resource types, status codes and timing
- JSON request and response structure: field names, types and array shapes; values are omitted
- Endpoint-like strings extracted from frontend bundles
- Browser errors and resource timing
- SHA-256 hashes for saved assets

The Windows and Linux jobs use fresh, unauthenticated Chromium sessions. Selecting **both** runs them in parallel so we can compare platform behavior.

## NOT COLLECTED

- Login cookies or browser profiles
- Authorization or request headers
- Raw request bodies or conversation text
- Dynamic API response bodies
- Local storage or session storage
- HAR files

This is intentional. HAR files and full browser traces can contain credentials, cookies, and private message content. Request payloads are reduced to schema shape before they are written to the artifact.

## ARTIFACTS

Each runner uploads a separate chatgpt-capture artifact. Artifacts are retained for three days.

**This repository is public. Treat every uploaded artifact as public.** The capture is unauthenticated, but frontend bundles and source maps are still copies of publicly served site assets.

## LIMITS

This workflow investigates the browser-visible public frontend. It cannot reveal server-side prompts, model internals, private backend code, or authenticated conversation traffic.

To study real conversation requests and streamed responses, we need a separate local browser capture that runs inside your own logged-in Chrome session and redacts sensitive data before export. Do not put browser cookies, access tokens, or HAR files in GitHub Actions secrets or repository files.
