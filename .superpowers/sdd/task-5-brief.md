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

