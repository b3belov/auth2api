# Browser OAuth Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-started OAuth login endpoints for Claude and Codex so visiting `/v1/claude-auth` or `/v1/codex-auth` performs the same provider login as the CLI and persists credentials into `auth-dir`.

**Architecture:** Implement one shared browser OAuth coordinator that works with the existing `Provider` interface. The server exposes exactly two loopback-only browser routes before the `/v1` API-key middleware, maps them to provider ids `anthropic` and `codex`, and lets `AccountManager.addAccount()` persist tokens and update the live in-memory pool.

**Tech Stack:** TypeScript, Express 4, Node `http`, existing PKCE/OAuth provider adapters, Node test runner through `tsx --test`.

## Global Constraints

- Public auth routes are exactly `GET /v1/claude-auth` and `GET /v1/codex-auth`.
- Do not add a `/v1/anthropic-auth` alias.
- Auth-start routes must be usable through normal browser navigation, so they must not require an API-key header.
- Auth-start routes must be loopback-only: allow local callers and reject remote callers.
- Loopback checks must use the socket peer address (`req.socket.remoteAddress`) and must not trust `X-Forwarded-For` or other client-controlled headers.
- Browser OAuth must reuse existing provider OAuth details: Claude callback `http://localhost:54545/callback`; Codex callback `http://localhost:1455/auth/callback`.
- Token persistence must go through `provider.manager.addAccount(token)` so existing `claude-<email>.json` and `codex-<email>.json` storage remains unchanged.
- Server startup must no longer exit when there are zero accounts; first-run browser login must be possible.
- `startAutoRefresh()` and `startStatsLogger()` must not create duplicate timers after repeated browser logins.
- Cursor is out of scope for browser callback endpoints.
- Existing CLI `--login`, `--login --provider=codex`, and `--manual` behavior must remain compatible.

---

## File Structure

- Create `src/auth/browser-oauth.ts`: shared browser OAuth route handler and callback server for providers with redirect-based OAuth.
- Modify `src/accounts/manager.ts`: make refresh and stats timer starters idempotent.
- Modify `src/server.ts`: import the new helper and register `/v1/claude-auth` plus `/v1/codex-auth` before the `/v1` API-key middleware.
- Modify `src/index.ts`: allow the server to start without accounts, print the two browser auth endpoints, and export `startServer()` so startup behavior can be tested without executing the CLI entrypoint on import.
- Modify `README.md`: document browser login alongside CLI login.
- Add `tests/browser-oauth.test.ts`: focused tests for route security, redirects, successful callbacks, state mismatch, in-flight behavior, and zero-account server behavior.

---

### Task 1: Add Idempotent Account Timers

**Files:**
- Modify: `src/accounts/manager.ts`
- Test: `tests/browser-oauth.test.ts`

**Interfaces:**
- Consumes: existing `AccountManager.startAutoRefresh()` and `AccountManager.startStatsLogger()`.
- Produces: idempotent timer methods that return safely when a timer already exists.

- [ ] **Step 1: Make `startAutoRefresh()` idempotent**

In `src/accounts/manager.ts`, replace the start of `startAutoRefresh()` with this guard:

```ts
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error(`[${this.provider}] auto-refresh failed:`, err.message),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error(`[${this.provider}] initial refresh failed:`, err.message),
    );
  }
```

- [ ] **Step 2: Make `startStatsLogger()` idempotent**

In `src/accounts/manager.ts`, replace `startStatsLogger()` with:

```ts
  startStatsLogger(): void {
    if (this.statsTimer) return;
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }
```

- [ ] **Step 3: Run the focused compile check**

Run:

```bash
npm run build
```

Expected: TypeScript build passes.

---

### Task 2: Create Shared Browser OAuth Coordinator

**Files:**
- Create: `src/auth/browser-oauth.ts`
- Test: `tests/browser-oauth.test.ts`

**Interfaces:**
- Consumes: `Provider`, `generatePKCECodes()`, Express `Request`/`Response`.
- Produces:
  - `isLoopbackAddress(address: string | undefined): boolean`
  - `isLoopbackRequest(req: Request): boolean`
  - `createBrowserOAuthHandler(options): express.RequestHandler`
  - one in-flight login per provider id

- [ ] **Step 1: Add `src/auth/browser-oauth.ts`**

Create the file with this implementation:

```ts
import crypto from "crypto";
import express, { Request, Response } from "express";
import http from "http";
import { URL } from "url";
import { generatePKCECodes } from "./pkce";
import { Provider } from "../providers/types";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const inFlight = new Map<string, Promise<void>>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family:sans-serif;text-align:center;padding-top:80px">
  <h1>${escapeHtml(title)}</h1>
  <p>${body}</p>
</body>
</html>`;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

export interface BrowserOAuthHandlerOptions {
  provider: Provider;
  displayName: string;
  onAccountAdded?: (provider: Provider) => void;
  timeoutMs?: number;
}

function startBrowserCallback(options: {
  provider: Provider;
  state: string;
  pkce: ReturnType<typeof generatePKCECodes>;
  displayName: string;
  timeoutMs: number;
  onAccountAdded?: (provider: Provider) => void;
}): Promise<{ done: Promise<void> }> {
  const { provider, state, pkce, displayName, timeoutMs, onAccountAdded } =
    options;
  const port = provider.oauth.callbackPort;
  const callbackPath = provider.oauth.callbackPath;

  return new Promise((resolveStarted, rejectStarted) => {
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    let listening = false;
    let closed = false;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const message = `OAuth error: ${error}`;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page(`${displayName} Login Failed`, escapeHtml(message)));
        cleanup();
        rejectDone(new Error(message));
        return;
      }

      const code = url.searchParams.get("code") || "";
      const returnedState = url.searchParams.get("state") || "";

      if (!code || !returnedState) {
        const message = "OAuth callback missing code or state parameter";
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          page(
            `${displayName} Login Failed`,
            "The callback was missing an authorization code or state.",
          ),
        );
        cleanup();
        rejectDone(new Error(message));
        return;
      }

      try {
        const token = await provider.exchangeCode(
          code,
          returnedState,
          state,
          pkce,
        );
        if (!token.provider) token.provider = provider.id;
        provider.manager.addAccount(token);
        onAccountAdded?.(provider);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          page(
            `${displayName} Login Successful`,
            `Account ${escapeHtml(token.email)} was saved. You can close this tab.`,
          ),
        );
        cleanup();
        resolveDone();
      } catch (err: any) {
        const message = err?.message || String(err);
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page(`${displayName} Login Failed`, escapeHtml(message)));
        cleanup();
        rejectDone(new Error(message));
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      rejectDone(new Error(`${displayName} OAuth callback timeout`));
    }, timeoutMs);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (listening) server.close();
    }

    server.once("error", (err) => {
      cleanup();
      rejectStarted(err);
      rejectDone(err instanceof Error ? err : new Error(String(err)));
    });

    server.listen(port, "127.0.0.1", () => {
      listening = true;
      resolveStarted({ done });
    });
  });
}

export function createBrowserOAuthHandler(
  options: BrowserOAuthHandlerOptions,
): express.RequestHandler {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;

  return async (req: Request, res: Response) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({
        error: {
          message: "Browser OAuth login is only available from localhost",
          type: "loopback_only",
        },
      });
      return;
    }

    const key = options.provider.id;
    if (inFlight.has(key)) {
      res.status(409).json({
        error: {
          message: `${options.displayName} OAuth login is already in progress`,
          type: "login_in_progress",
          provider: options.provider.id,
        },
      });
      return;
    }

    const pkce = generatePKCECodes();
    const state = crypto.randomBytes(16).toString("hex");
    let authUrl: string;
    try {
      authUrl = options.provider.buildAuthUrl(state, pkce);
    } catch (err: any) {
      res.status(500).json({
        error: {
          message: `Could not build ${options.displayName} OAuth URL: ${err?.message || String(err)}`,
          type: "auth_url_build_failed",
          provider: options.provider.id,
        },
      });
      return;
    }

    const startPromise = startBrowserCallback({
      provider: options.provider,
      state,
      pkce,
      displayName: options.displayName,
      timeoutMs,
      onAccountAdded: options.onAccountAdded,
    });
    const pending = startPromise
      .then(({ done }) => done)
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
    pending.catch((err) => {
      console.error(
        `[${options.provider.id}] browser OAuth failed: ${err?.message || String(err)}`,
      );
    });

    try {
      await startPromise;
    } catch (err: any) {
      inFlight.delete(key);
      res.status(500).json({
        error: {
          message: `Could not start ${options.displayName} OAuth callback server: ${err?.message || String(err)}`,
          type: "callback_server_start_failed",
          provider: options.provider.id,
        },
      });
      return;
    }

    res.redirect(302, authUrl);
  };
}
```

- [ ] **Step 2: Run the build**

Run:

```bash
npm run build
```

Expected: build passes.

---

### Task 3: Register the Browser Auth Routes

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `createBrowserOAuthHandler()`.
- Produces:
  - `GET /v1/claude-auth` mapped to provider id `anthropic`
  - `GET /v1/codex-auth` mapped to provider id `codex`

- [ ] **Step 1: Import the helper**

At the top of `src/server.ts`, add:

```ts
import { createBrowserOAuthHandler } from "./auth/browser-oauth";
```

- [ ] **Step 2: Add a timer-start callback near the existing middleware setup**

Inside `createServer()`, after `statsFinishMiddleware` is declared and before `/health`, add:

```ts
  const startProviderRuntime = (providerId: "anthropic" | "codex") => {
    const provider = registry.get(providerId);
    if (provider.manager.accountCount > 0) {
      provider.manager.startAutoRefresh();
      provider.manager.startStatsLogger();
    }
  };
```

- [ ] **Step 3: Register the two public auth routes before API-key middleware**

Still before `app.use(["/v1", "/codex", "/backend-api/codex"], requireApiKey);`, add:

```ts
  app.get(
    "/v1/claude-auth",
    createBrowserOAuthHandler({
      provider: registry.get("anthropic"),
      displayName: "Claude",
      onAccountAdded: () => startProviderRuntime("anthropic"),
    }),
  );

  app.get(
    "/v1/codex-auth",
    createBrowserOAuthHandler({
      provider: registry.get("codex"),
      displayName: "Codex",
      onAccountAdded: () => startProviderRuntime("codex"),
    }),
  );
```

- [ ] **Step 4: Do not add any Anthropic alias**

Verify there is no route with this string:

```bash
rg -n "anthropic-auth" src tests README.md
```

Expected: no output.

- [ ] **Step 5: Run the build**

Run:

```bash
npm run build
```

Expected: build passes.

---

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

### Task 5: Add Browser OAuth Tests

**Files:**
- Add: `tests/browser-oauth.test.ts`

**Interfaces:**
- Consumes: `createServer()`, `buildRegistry()`, `saveToken()/loadAllTokens()`, provider OAuth route behavior.
- Produces: regression coverage for loopback-only access, redirect behavior, token persistence, state mismatch, in-flight rejection, no alias, and zero-account server behavior.

- [ ] **Step 1: Create `tests/browser-oauth.test.ts` with shared helpers**

Create the test file with:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { Config } from "../src/config";
import { isLoopbackRequest } from "../src/auth/browser-oauth";
import { AccountManager } from "../src/accounts/manager";
import { createServer } from "../src/server";
import { startServer } from "../src/index";
import { buildRegistry, ProviderRegistry } from "../src/providers/registry";
import { loadAllTokens } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {
      "cli-version": "2.1.88",
      entrypoint: "cli",
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    stats: { enabled: false },
    reasoning: {},
    debug: "off",
  };
}

async function startApp(config: Config): Promise<{
  server: http.Server;
  registry: ProviderRegistry;
}> {
  const registry = buildRegistry(config["auth-dir"]);
  for (const provider of registry.all()) provider.manager.load();
  const app = createServer(config, registry);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, registry };
}

async function stopApp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

async function request(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = serverAddress(options.server);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function getOnce(url: string): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      })
      .on("error", reject);
  });
}

function stubProviderExchange(
  registry: ProviderRegistry,
  providerId: "anthropic" | "codex",
  token: TokenData,
): void {
  const provider = registry.get(providerId);
  provider.exchangeCode = async (code, returnedState, expectedState) => {
    if (returnedState !== expectedState) {
      throw new Error("OAuth state mismatch — possible CSRF attack");
    }
    assert.equal(code, "auth-code");
    return token;
  };
}
```

- [ ] **Step 2: Add loopback and redirect tests**

Append:

```ts
test("isLoopbackRequest allows local callers and rejects remote callers", () => {
  assert.equal(
    isLoopbackRequest({
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    } as any),
    true,
  );
  assert.equal(
    isLoopbackRequest({
      ip: "::ffff:127.0.0.1",
      socket: { remoteAddress: "203.0.113.10" },
    } as any),
    false,
  );
});

test("AccountManager timer starters are idempotent", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const manager = new AccountManager(authDir, {
    provider: "codex",
    refresh: async () => {
      throw new Error("refresh should not run when no accounts exist");
    },
  });
  t.after(() => {
    manager.stopAutoRefresh();
    manager.stopStatsLogger();
  });

  manager.startAutoRefresh();
  const firstRefreshTimer = (manager as any).refreshTimer;
  assert.ok(firstRefreshTimer);
  manager.startAutoRefresh();
  assert.equal((manager as any).refreshTimer, firstRefreshTimer);

  manager.startStatsLogger();
  const firstStatsTimer = (manager as any).statsTimer;
  assert.ok(firstStatsTimer);
  manager.startStatsLogger();
  assert.equal((manager as any).statsTimer, firstStatsTimer);
});

test("GET /v1/claude-auth redirects to Claude OAuth without API key", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const { server } = await startApp(makeConfig(authDir));
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await request({
    server,
    method: "GET",
    path: "/v1/claude-auth",
  });

  assert.equal(resp.status, 302);
  const location = String(resp.headers.location || "");
  const parsed = new URL(location);
  assert.equal(parsed.origin, "https://claude.ai");
  assert.equal(parsed.pathname, "/oauth/authorize");
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://localhost:54545/callback");
  const state = parsed.searchParams.get("state");
  assert.ok(state);
  await getOnce(`http://127.0.0.1:54545/callback?error=access_denied&state=${state}`);
});

test("GET /v1/codex-auth redirects to Codex OAuth without API key", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const { server } = await startApp(makeConfig(authDir));
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await request({
    server,
    method: "GET",
    path: "/v1/codex-auth",
  });

  assert.equal(resp.status, 302);
  const location = String(resp.headers.location || "");
  const parsed = new URL(location);
  assert.equal(parsed.origin, "https://auth.openai.com");
  assert.equal(parsed.pathname, "/oauth/authorize");
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  const state = parsed.searchParams.get("state");
  assert.ok(state);
  await getOnce(`http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}`);
});
```

- [ ] **Step 3: Add successful callback tests**

Append:

```ts
test("Claude browser OAuth callback persists token and updates live manager", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const config = makeConfig(authDir);
  const { server, registry } = await startApp(config);
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  stubProviderExchange(registry, "anthropic", {
    accessToken: "claude-access",
    refreshToken: "claude-refresh",
    email: "claude@example.com",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "claude-uuid",
    provider: "anthropic",
  });

  const start = await request({ server, method: "GET", path: "/v1/claude-auth" });
  assert.equal(start.status, 302);
  const authUrl = new URL(String(start.headers.location));
  const state = authUrl.searchParams.get("state");
  assert.ok(state);

  const callback = await getOnce(
    `http://127.0.0.1:54545/callback?code=auth-code&state=${state}`,
  );
  assert.equal(callback.status, 200);
  assert.match(callback.body, /Claude Login Successful/);

  const tokens = loadAllTokens(authDir, "anthropic");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].email, "claude@example.com");
  assert.equal(registry.get("anthropic").manager.accountCount, 1);
});

test("Codex browser OAuth callback persists token and updates live manager", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const config = makeConfig(authDir);
  const { server, registry } = await startApp(config);
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  stubProviderExchange(registry, "codex", {
    accessToken: "codex-access",
    refreshToken: "codex-refresh",
    email: "codex@example.com",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "chatgpt-account",
    provider: "codex",
    idToken: "id.jwt.token",
  });

  const start = await request({ server, method: "GET", path: "/v1/codex-auth" });
  assert.equal(start.status, 302);
  const authUrl = new URL(String(start.headers.location));
  const state = authUrl.searchParams.get("state");
  assert.ok(state);

  const callback = await getOnce(
    `http://127.0.0.1:1455/auth/callback?code=auth-code&state=${state}`,
  );
  assert.equal(callback.status, 200);
  assert.match(callback.body, /Codex Login Successful/);

  const tokens = loadAllTokens(authDir, "codex");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].email, "codex@example.com");
  assert.equal(registry.get("codex").manager.accountCount, 1);
});
```

- [ ] **Step 4: Add state mismatch and in-flight tests**

Append:

```ts
test("browser OAuth callback rejects state mismatch without saving token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const { server, registry } = await startApp(makeConfig(authDir));
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  stubProviderExchange(registry, "anthropic", {
    accessToken: "unused",
    refreshToken: "unused",
    email: "unused@example.com",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "unused",
    provider: "anthropic",
  });

  const start = await request({ server, method: "GET", path: "/v1/claude-auth" });
  assert.equal(start.status, 302);

  const callback = await getOnce(
    "http://127.0.0.1:54545/callback?code=auth-code&state=wrong-state",
  );
  assert.equal(callback.status, 400);
  assert.match(callback.body, /state mismatch/i);

  assert.equal(loadAllTokens(authDir, "anthropic").length, 0);
  assert.equal(registry.get("anthropic").manager.accountCount, 0);
});

test("browser OAuth rejects a second in-flight login for the same provider", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const { server } = await startApp(makeConfig(authDir));
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const first = await request({ server, method: "GET", path: "/v1/codex-auth" });
  assert.equal(first.status, 302);

  const second = await request({ server, method: "GET", path: "/v1/codex-auth" });
  assert.equal(second.status, 409);
  assert.match(second.body, /login_in_progress/);

  const authUrl = new URL(String(first.headers.location));
  const state = authUrl.searchParams.get("state");
  assert.ok(state);
  await getOnce(
    `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}`,
  );
});
```

- [ ] **Step 5: Add auth-boundary route tests**

Append:

```ts
test("GET /v1/anthropic-auth is not registered", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const { server } = await startApp(makeConfig(authDir));
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await request({
    server,
    method: "GET",
    path: "/v1/anthropic-auth",
  });

  assert.equal(resp.status, 401);
  assert.match(resp.body, /Missing API key/);
});

test("GET /v1/models still requires API key when no accounts are loaded", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const { server } = await startApp(makeConfig(authDir));
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const missingKey = await request({
    server,
    method: "GET",
    path: "/v1/models",
  });
  assert.equal(missingKey.status, 401);

  const withKey = await request({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(withKey.status, 200);
  assert.deepEqual(JSON.parse(withKey.body), { object: "list", data: [] });
});

test("startServer starts successfully with zero accounts", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-browser-"));
  const authDir = path.join(tmp, "auth");
  const configPath = path.join(tmp, "config.yaml");
  fs.writeFileSync(
    configPath,
    [
      'host: "127.0.0.1"',
      "port: 0",
      `auth-dir: "${authDir}"`,
      "api-keys:",
      '  - "test-key"',
      "stats:",
      "  enabled: false",
    ].join("\n"),
  );

  const server = await startServer([`--config=${configPath}`]);
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const address = serverAddress(server);
  assert.equal(typeof address.port, "number");
  assert.ok(address.port > 0);
});
```

- [ ] **Step 6: Run the new tests**

Run:

```bash
npm run test -- tests/browser-oauth.test.ts
```

Expected: all browser OAuth tests pass.

---

### Task 6: Update README Login Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: existing Login and Starting the server sections.
- Produces: documented browser login URLs with no Anthropic alias.

- [ ] **Step 1: Add browser-login docs in the Login section**

After the provider list and before "Auto mode", add:

````md
### Browser mode from the running server

When the server is running locally, you can start OAuth from a normal browser page:

```bash
# Claude
open http://127.0.0.1:8317/v1/claude-auth

# Codex / ChatGPT
open http://127.0.0.1:8317/v1/codex-auth
```

These routes are localhost-only and do not require an API key because they start an interactive browser login. Successful login writes the same token files as the CLI flow (`claude-<email>.json` or `codex-<email>.json`) and updates the running server immediately.
````

- [ ] **Step 2: Update the endpoint list**

In the endpoint list near the existing `/admin/reload` row, add:

```md
| `GET /v1/claude-auth`       | Start Claude OAuth login from a local browser |
| `GET /v1/codex-auth`        | Start Codex OAuth login from a local browser  |
```

- [ ] **Step 3: Verify no alias docs exist**

Run:

```bash
rg -n "anthropic-auth" README.md src
```

Expected: no output.

---

### Task 7: Full Validation

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: completed Tasks 1-6.
- Produces: final confidence that browser OAuth endpoints build and tests pass.

- [ ] **Step 1: Run formatting**

Run:

```bash
npm run prettier
```

Expected: Prettier updates or confirms formatting for `src/**/*.ts` and `tests/**/*.ts`.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm run test -- tests/browser-oauth.test.ts tests/codex.test.ts tests/smoke.test.ts
```

Expected: browser OAuth tests, existing Codex auth tests, and smoke tests pass.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Confirm route surface**

Run:

```bash
rg -n "claude-auth|codex-auth|anthropic-auth" src README.md tests
```

Expected:
- `claude-auth` appears in `src/server.ts`, `README.md`, and tests.
- `codex-auth` appears in `src/server.ts`, `README.md`, and tests.
- `anthropic-auth` appears only in the negative test string, or not at all if the implementer chooses to test the missing route without spelling it in docs/source.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/auth/browser-oauth.ts src/accounts/manager.ts src/server.ts src/index.ts tests/browser-oauth.test.ts README.md
git commit -m "feat(auth): add browser oauth endpoints"
```

Expected: commit succeeds with a Conventional Commits-compliant subject.

---

## Self-Review

- Spec coverage: The plan covers both requested endpoints, excludes `/v1/anthropic-auth`, preserves existing provider token storage, keeps browser navigation header-free, and protects credential minting with loopback-only access.
- Placeholder scan: No placeholder marker text remains.
- Type consistency: Provider ids use the repo's existing `anthropic` and `codex` ids while public routes use `claude-auth` and `codex-auth`.
- Risk notes: The tests use fixed OAuth callback ports `54545` and `1455`, matching production behavior. If a local developer already has those ports in use, the relevant tests fail clearly with `EADDRINUSE`, which mirrors the real runtime constraint.

## Hardening Coverage

- Logical gaps: First-run startup is now testable through an exported `startServer()` instead of only described in prose.
- Technical gaps: The callback server must be listening before redirecting the browser, and every terminal callback outcome clears the listener and in-flight state.
- Simplification and reusability: The plan keeps one provider-agnostic browser OAuth helper and exactly two public routes; no alias or wrapper route is introduced.
- UX: Success and failure browser pages are explicit, and README copy gives the two visitable local URLs.
- Performance: The auth flow is not a hot path; one in-flight login per provider and idempotent timers prevent resource buildup.
- Security: Browser auth remains header-free for navigation, but loopback authorization is based on `req.socket.remoteAddress`, not spoofable forwarding headers.
- Bugs: The plan covers state mismatch, malformed callback, duplicate login, callback bind failure, and auth URL build failure paths.
- Misconfigurations: Startup output lists the new routes, temp-config startup is tested with zero accounts, and route-surface checks prevent `/v1/anthropic-auth` from landing.
