# Task 4 Report: Allow First-Run Server Startup

## Scope

- Modified only `/Users/dmytro/.codex/worktrees/cd2a/auth2api/src/index.ts`, as requested.
- Added this report at `/Users/dmytro/.codex/worktrees/cd2a/auth2api/.superpowers/sdd/task-4-report.md`.

## Requirements Covered

1. Export `startServer(args?)` returning `http.Server`
   - Added `import http from "http";`.
   - Changed `startServer` to:
     - `export async function startServer(args = process.argv.slice(2)): Promise<http.Server>`
   - Switched config parsing inside `startServer` to use injected `args`.

2. Allow first-run startup with zero accounts
   - Removed the zero-account `process.exit(1)` path.
   - Replaced the message with:
     - `No accounts found. Start a browser login at /v1/claude-auth or /v1/codex-auth, or run with --login.`
   - Existing auto-refresh and stats startup logic remains unchanged for loaded accounts and enabled stats.

3. Return the listening server
   - Captured `app.listen(...)` into `const server`.
   - Returned `server` after the `SIGINT` handler setup.

4. Print new browser-auth startup routes
   - Added startup route logs for:
     - `GET  /v1/claude-auth`
     - `GET  /v1/codex-auth`

5. Keep CLI behavior compatible
   - `main()` still handles `--login`, `--manual`, `--provider=...`, and cursor-specific flags exactly in the CLI path.
   - Updated the non-login branch to call `await startServer(args)` so CLI argument handling remains consistent.

6. Guard CLI execution on import
   - Wrapped `main().catch(...)` in `if (require.main === module) { ... }`.
   - This prevents process startup when `src/index.ts` is imported by Task 5 tests.

## Verification

- Ran `npm run build`
- Result: passed (`tsc` exited successfully)

## Self-Review

- Kept the edit limited to `src/index.ts`.
- Did not change login flow internals beyond passing parsed CLI args through to `startServer`.
- Did not add tests because the task brief explicitly says startServer import tests come in Task 5 and only requires `npm run build` for Task 4.

## Concerns

- No functional concerns from this task scope.
- Runtime validation of the new first-run browser-auth path is deferred to later task coverage; this task verified compile/build only per brief.
