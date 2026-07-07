# Task 5 Report: Browser OAuth Tests

## Scope completed

- Added `tests/browser-oauth.test.ts` covering the browser OAuth routes and callback flow for Anthropic and Codex.
- Added regression coverage for:
  - loopback-only request detection
  - `AccountManager` timer idempotency
  - `/v1/claude-auth` and `/v1/codex-auth` redirect behavior without API keys
  - successful callback token persistence and live manager updates
  - state mismatch rejection with no token persistence
  - duplicate in-flight login rejection
  - absence of `/v1/anthropic-auth`
  - `/v1/models` auth behavior when zero accounts are loaded
  - `startServer()` booting successfully with zero accounts

## TDD notes

1. Wrote `tests/browser-oauth.test.ts` from the task brief.
2. Initial sandboxed `npm run test -- tests/browser-oauth.test.ts` failed with the known `tsx` IPC `EPERM` issue:
   - `listen EPERM ... /var/folders/.../tsx-501/...pipe`
3. Re-ran the tests unsandboxed to get real red-state evidence.
4. Red-state findings:
   - browser OAuth callback tests were colliding because the test HTTP clients were leaving callback connections open long enough to keep the module-level in-flight state around between cases
   - `startServer()` resolved before the server was actually listening, so `server.address()` could still be unset
   - existing stats tests in `tests/unit.test.ts` were still constructing `createServer()` with a stub registry that no longer satisfied the route registration contract after browser OAuth endpoints were added

## Code changes

### 1. Added browser OAuth integration tests

File: `tests/browser-oauth.test.ts`

- Added shared helpers for:
  - config construction
  - ephemeral app startup/shutdown
  - HTTP requests against the in-process app server
  - one-shot callback requests
  - provider exchange stubbing
- Forced `Connection: close` on test HTTP clients and added a short cleanup wait after callback completion/cancellation so callback listeners fully unwind between tests.

### 2. Fixed `startServer()` readiness semantics

File: `src/index.ts`

- Changed `startServer()` to await the underlying HTTP server `listening` event before resolving.
- This makes the exported `startServer(args?)` contract deterministic for tests and callers using ephemeral port `0`.

### 3. Fixed repeated `startServer()` SIGINT listener accumulation

File: `src/index.ts`

- Added a named `SIGINT` handler and remove it on `server.close()`.
- This addresses the known reviewer minor mentioned in the task brief and keeps repeated `startServer()` calls from leaking process listeners.

### 4. Updated existing stats tests to use a real registry

File: `tests/unit.test.ts`

- Replaced the old `{} as any` registry stub with `buildRegistry(tmp)` plus `manager.load()` calls in the two `createServer()` stats tests.
- This keeps those tests aligned with current route registration requirements without widening their scope.

## Verification

### Focused browser OAuth tests

Command:

```bash
./node_modules/.bin/tsx --test tests/browser-oauth.test.ts
```

Result:

- 11 tests passed
- 0 failed

### Build

Command:

```bash
npm run build
```

Result:

- succeeded

### Full suite

Command:

```bash
npm run test
```

Result:

- 226 tests passed
- 0 failed

## Minimal implementation fixes made

- `src/index.ts`: await server listen before resolving `startServer()`
- `src/index.ts`: remove per-server `SIGINT` handler on close

No other production behavior was changed.

## Concerns

- The sandboxed `npm run test -- ...` path still hits the known `tsx` IPC permission error, so test verification required unsandboxed execution.
- The browser OAuth tests intentionally drive real localhost callback listeners, so they depend on callback ports `54545` and `1455` being available on the test machine.
