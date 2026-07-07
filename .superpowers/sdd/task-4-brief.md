### Task 4: Allow First-Run Server Startup

**Files:**
- Modify: `src/index.ts`
- Test: `tests/browser-oauth.test.ts`

**Interfaces:**
- Consumes: existing `startServer()` setup and `main()` CLI dispatch.
- Produces:
  - `export async function startServer(args?: string[]): Promise<http.Server>`
  - server startup that continues with zero accounts and advertises browser login URLs
  - `main()` guarded by `require.main === module` so tests can import `startServer()`

- [ ] **Step 1: Import the HTTP server type**

At the top of `src/index.ts`, add:

```ts
import http from "http";
```

- [ ] **Step 2: Export `startServer()` with injectable args**

Replace:

```ts
async function startServer(): Promise<void> {
  const configPath = process.argv
    .find((a) => a.startsWith("--config="))
    ?.split("=")[1];
```

with:

```ts
export async function startServer(
  args = process.argv.slice(2),
): Promise<http.Server> {
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
```

- [ ] **Step 3: Replace the zero-account exit**

In `src/index.ts`, replace:

```ts
  if (totalAccounts === 0) {
    console.log(
      "No accounts found. Run with --login (and optionally --provider=codex) to add an account first.",
    );
    process.exit(1);
  }
```

with:

```ts
  if (totalAccounts === 0) {
    console.log(
      "No accounts found. Start a browser login at /v1/claude-auth or /v1/codex-auth, or run with --login.",
    );
  }
```

- [ ] **Step 4: Return the listening server**

Replace:

```ts
  app.listen(port, host, () => {
```

with:

```ts
  const server = app.listen(port, host, () => {
```

Then add this line immediately after the `process.on("SIGINT", ...)` block:

```ts
  return server;
```

- [ ] **Step 5: Print the new routes at startup**

In the `app.listen()` callback, after `console.log(\`  GET  /v1/models\`);`, add:

```ts
    console.log(`  GET  /v1/claude-auth`);
    console.log(`  GET  /v1/codex-auth`);
```

- [ ] **Step 6: Pass CLI args into `startServer()`**

In `main()`, replace:

```ts
    await startServer();
```

with:

```ts
    await startServer(args);
```

- [ ] **Step 7: Guard CLI execution on import**

At the end of `src/index.ts`, replace:

```ts
main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
```

with:

```ts
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 8: Run the build**

Run:

```bash
npm run build
```

Expected: build passes.

---

