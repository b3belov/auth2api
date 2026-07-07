# Task 3 Report: Register the Browser Auth Routes

## Scope

- Modified `src/server.ts` only for production code, per task brief.
- Added this report file under `.superpowers/sdd/`.

## What changed

1. Imported `createBrowserOAuthHandler` from `src/auth/browser-oauth.ts`.
2. Added a local `startProviderRuntime()` helper inside `createServer()` to start refresh/stats runtime for `anthropic` and `codex` providers once an account exists.
3. Registered exactly these browser-auth routes before the `/v1` API-key middleware:
   - `GET /v1/claude-auth` -> provider id `anthropic`, display name `Claude`
   - `GET /v1/codex-auth` -> provider id `codex`, display name `Codex`
4. Did not add `/v1/anthropic-auth`.

## Route ordering

The two public browser-auth endpoints were inserted immediately before:

```ts
app.use(["/v1", "/codex", "/backend-api/codex"], requireApiKey);
```

That keeps them reachable without API-key auth while leaving the rest of `/v1` protected.

## Loopback / browser behavior

`src/auth/browser-oauth.ts` already enforces loopback-only access via `isLoopbackRequest()` and returns browser-friendly HTML responses for success/failure. No extra server-side route aliasing or special response handling was added in `src/server.ts`.

## Verification

### 1. Forbidden alias check

Command:

```bash
rg -n "anthropic-auth" src tests README.md
```

Result:

- No matches in tracked implementation/docs/tests.
- Exit code `1`, which is expected for "no matches".

### 2. Build

Command:

```bash
npm run build
```

Result:

- Passed (`tsc` completed successfully).

### 3. Diff hygiene

Command:

```bash
git diff --check
```

Result:

- No whitespace or patch formatting issues.

## Self-review

- Confirmed the change is scoped to `src/server.ts` and does not touch unrelated code.
- Confirmed the new public routes are registered before API-key middleware.
- Confirmed only `/v1/claude-auth` and `/v1/codex-auth` were added.
- Confirmed no `/v1/anthropic-auth` alias was introduced.

## Notes

- I did not add tests in this task because the brief scoped implementation to `src/server.ts` and required verification was `npm run build` plus the `rg` route check.
