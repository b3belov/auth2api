# Codex rate-limit header access design

## Summary

Expose current Codex upstream rate-limit information to API clients by forwarding a narrowly allowlisted set of rate-limit response headers from Codex upstream responses to auth2api responses.

The first implementation target is client-visible headers, not persistent admin stats. This gives callers immediate access to the current quota information Codex already returns, while avoiding broad upstream header forwarding.

## Goals

- Forward safe Codex/OpenAI rate-limit headers to clients on Codex-backed requests.
- Cover all Codex request surfaces that receive an upstream `Response`: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and Codex compact endpoints.
- Preserve existing response bodies and streaming behavior.
- Avoid leaking unrelated upstream metadata, cookies, auth headers, account identifiers, or Cloudflare/internal headers.

## Non-goals

- Persist rate-limit state in `stats.jsonl`.
- Add a new admin endpoint.
- Infer quota state from response bodies.
- Forward arbitrary upstream headers.
- Change account cooldown or retry selection behavior.

## Architecture

Add a small helper near the existing HTTP proxy utilities that copies only known-safe rate-limit headers from a Fetch `Response.headers` object to an Express response.

The helper will use a case-insensitive allowlist. The initial allowed names are `retry-after` and these OpenAI/Codex-style rate-limit headers:

- `x-ratelimit-limit-requests`
- `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-requests`
- `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-requests`
- `x-ratelimit-reset-tokens`

If Codex returns additional quota headers during testing, they should be added explicitly rather than forwarded by prefix.

## Data flow

1. A client calls a Codex-backed auth2api endpoint.
2. auth2api sends the request to Codex using the existing account and retry path.
3. When an upstream response is received, auth2api copies allowlisted rate-limit headers to the client response before any body bytes are written.
4. Existing success handlers continue streaming or aggregating the response exactly as they do today.
5. On terminal upstream errors, auth2api also forwards the same allowlisted rate-limit headers when available before sending the error response.

## Components

- `src/utils/http.ts`: owns the shared safe forwarding helper and uses it in terminal error handling.
- Codex success handlers in `src/handlers/openai.ts` and `src/handlers/anthropic.ts`: call the helper before streaming, draining, or sending JSON responses.
- Codex compact path in `src/handlers/openai.ts`: call the helper before copying content type and sending the compact JSON response.

## Error handling

The existing retry behavior remains unchanged. Retries may observe multiple upstream responses; only the response ultimately returned to the client should have its rate-limit headers forwarded.

For 429 and other terminal upstream failures, `Retry-After` remains supported and the helper forwards any additional allowlisted quota headers from the last upstream response. Non-allowlisted headers are ignored silently.

## Security and privacy

Forwarding is intentionally allowlist-based. The implementation must not forward cookies, auth headers, request IDs, organization/account identifiers, Cloudflare headers, or any unrelated upstream metadata.

Because these headers expose account quota state to API-key clients, this design assumes the operator intentionally wants clients to see that information. It does not add config gating in the first pass because the user selected direct client access.

## Testing

Add tests that mock Codex upstream responses and verify:

- Allowlisted rate-limit headers are present on client responses.
- Header matching is case-insensitive.
- Non-allowlisted upstream headers are not forwarded.
- Streaming Codex paths set headers before the body is written.
- Terminal 429/error responses forward allowed quota headers without changing the error body shape.

Run the existing test suite and TypeScript build after implementation.
