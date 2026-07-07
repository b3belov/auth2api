## Task 2 Report: Shared Browser OAuth Coordinator

### Scope completed

- Created `src/auth/browser-oauth.ts` only, per task scoping.
- Did not wire routes.
- Did not add tests, because the turn-level task instructions explicitly defer route wiring and tests to later tasks.

### What was implemented

Added a shared browser OAuth helper with:

- `isLoopbackAddress(address)` for strict loopback matching of:
  - `127.0.0.1`
  - `::1`
  - `::ffff:127.0.0.1`
- `isLoopbackRequest(req)` using only `req.socket.remoteAddress`
- `createBrowserOAuthHandler(options)` returning an Express request handler
- internal per-provider in-flight coordination using `Map<string, Promise<void>>`
- callback server startup before redirecting the browser to the provider auth URL
- cleanup of callback listener/timer/in-flight state on terminal outcomes:
  - OAuth error callback
  - missing code/state callback
  - successful token exchange/account save
  - exchange failure
  - callback timeout
  - callback server startup failure

### Requirement alignment check

- Exactly two eventual public routes (`/v1/claude-auth` and `/v1/codex-auth`):
  - Preserved by keeping this task route-agnostic. This helper does not introduce any route aliases.
- No `/v1/anthropic-auth` alias:
  - Preserved. No routes added here.
- Loopback checks based on `req.socket.remoteAddress` only:
  - Implemented exactly that way in `isLoopbackRequest`.
- Callback listener starts before redirect:
  - Implemented by awaiting callback server startup before `res.redirect(302, authUrl)`.
- Terminal callback outcomes clean up listener/in-flight state:
  - Implemented via `cleanup()` inside callback flow and `finally(() => inFlight.delete(key))` for the in-flight map.

### TypeScript/build notes

- No extra TypeScript adjustments were needed beyond the provided skeleton.
- `npm run build` passed successfully.

### Files changed

- `src/auth/browser-oauth.ts`

### Verification run

```bash
npm run build
```

Result: passed.
