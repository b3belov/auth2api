# App Gap Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the implementation gaps found in the current auth2api audit: protected-route hardening, config validation, reload lifecycle, Codex account failover, Docker packaging, and stale model documentation.

**Architecture:** Keep the existing Express/provider/account-manager structure. Add small reusable helpers for config validation and timing-safe key checks, reorder protected middleware so cheap auth/rate checks happen before JSON parsing, make provider lifecycle starts idempotent so reload can safely start newly added providers, and extend retry classification only for Codex account-scoped model errors.

**Tech Stack:** TypeScript, Node.js 20+, Express 4, Node `node:test` through `tsx`, Docker, `js-yaml`.

## Global Constraints

- Preserve the existing public API endpoints and provider routing behavior unless a task explicitly changes admin authentication.
- Keep the default server bind address behavior: empty `host` still means `127.0.0.1`.
- Do not add runtime dependencies; use Node built-ins where possible.
- Use TDD for every code behavior change.
- Use `npm run build` and `npm test` as final verification.
- If `npm test` fails inside the managed sandbox with `tsx` IPC `EPERM`, rerun the same command with appropriate escalation; do not treat the sandbox error as an app failure.

---

## File Structure

- Modify `src/config.ts`: validate parsed YAML, normalize string-list config fields, add separate `admin-api-keys`, and persist generated missing key lists.
- Modify `src/utils/common.ts`: add timing-safe API key validation helper.
- Modify `src/server.ts`: split client/admin auth middleware, rate-limit admin and API routes before JSON parsing, parse JSON only for protected route groups, and start newly loaded provider lifecycle timers after reload.
- Modify `src/accounts/manager.ts`: make `startAutoRefresh()` and `startStatsLogger()` idempotent.
- Modify `src/utils/http.ts`: add optional account-scoped upstream error classifier and retry those failures on another account.
- Modify `src/handlers/openai.ts` and `src/handlers/anthropic.ts`: pass Codex account-scoped error classifier into all Codex proxy paths.
- Modify `Dockerfile`: use `package-lock.json` with `npm ci`, prune dev dependencies before the runtime stage, and align declared volumes.
- Create `.dockerignore`: keep build context small and avoid sending local secrets.
- Modify `docker-compose.yml`: align the auth token volume with the configured container auth directory.
- Modify `README.md`, `README_CN.md`, and `config.example.yaml`: document admin keys, Docker auth-dir behavior, and current Anthropic aliases/models.
- Modify `tests/unit.test.ts`, `tests/smoke.test.ts`, and `tests/codex.test.ts`: cover each behavior change.

---

### Task 1: Config Schema Validation and Admin Key Separation

**Files:**
- Modify: `src/config.ts`
- Modify: `src/utils/notify-reload.ts`
- Modify: `config.example.yaml`
- Modify: `tests/unit.test.ts`
- Modify: `tests/codex.test.ts`

**Interfaces:**
- Produces: `Config["admin-api-keys"]: Set<string>`
- Produces: `normalizeStringList(value: unknown, key: string): string[]`
- Produces: `loadConfig()` accepts empty YAML as `{}` and a scalar string key as a one-item list.
- Consumes: existing `notifyServerReload(config: Config)` and changes it to prefer `admin-api-keys`.

- [ ] **Step 1: Write failing config validation tests**

Add these tests near existing `loadConfig` tests in `tests/unit.test.ts`:

```ts
test("loadConfig treats empty YAML as an empty config object", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-config-"));
  const configPath = path.join(tmpDir, "config.yaml");
  try {
    fs.writeFileSync(configPath, "");
    const config = loadConfig(configPath);
    assert.equal(config.host, "");
    assert.equal(config.port, 8317);
    assert.equal(config["api-keys"].size, 1);
    assert.equal(config["admin-api-keys"].size, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig normalizes scalar api-keys instead of splitting characters", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-config-"));
  const configPath = path.join(tmpDir, "config.yaml");
  try {
    fs.writeFileSync(
      configPath,
      ["api-keys: sk-client", "admin-api-keys: sk-admin"].join("\n"),
    );
    const config = loadConfig(configPath);
    assert.deepEqual([...config["api-keys"]], ["sk-client"]);
    assert.deepEqual([...config["admin-api-keys"]], ["sk-admin"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects non-object YAML config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-config-"));
  const configPath = path.join(tmpDir, "config.yaml");
  try {
    fs.writeFileSync(configPath, "- not\n- an\n- object\n");
    assert.throws(
      () => loadConfig(configPath),
      /Config file must contain a YAML object/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig backfills missing admin-api-keys without reusing client keys", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-config-"));
  const configPath = path.join(tmpDir, "config.yaml");
  try {
    fs.writeFileSync(configPath, "api-keys:\n  - sk-client\n");
    const config = loadConfig(configPath);
    assert.deepEqual([...config["api-keys"]], ["sk-client"]);
    assert.equal(config["admin-api-keys"].size, 1);
    assert.equal(config["admin-api-keys"].has("sk-client"), false);
    const persisted = fs.readFileSync(configPath, "utf-8");
    assert.match(persisted, /admin-api-keys:/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write failing notify reload test**

In `tests/codex.test.ts`, update the existing notify test or add this one near `notifyServerReload` tests:

```ts
test("notifyServerReload prefers the first admin-api-key as Bearer", async () => {
  const oldFetch = global.fetch;
  let seen: { url: string; init?: RequestInit } | null = null;
  global.fetch = (async (url: any, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ reloaded: {}, generated_at: "now" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
  try {
    await notifyServerReload({
      host: "127.0.0.1",
      port: 18399,
      "auth-dir": "/tmp/unused",
      "api-keys": new Set(["sk-client"]),
      "admin-api-keys": new Set(["sk-admin"]),
      "body-limit": "1mb",
      cloaking: {},
      stats: { enabled: true },
      reasoning: {},
      debug: "off",
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
    });
    assert.equal(
      (seen!.init?.headers as Record<string, string>)?.Authorization,
      "Bearer sk-admin",
    );
  } finally {
    global.fetch = oldFetch;
  }
});
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
npx tsx --test tests/unit.test.ts --test-name-pattern "loadConfig .*YAML|scalar api-keys|admin-api-keys"
npx tsx --test tests/codex.test.ts --test-name-pattern "notifyServerReload prefers"
```

Expected: FAIL because `admin-api-keys` and config normalization are not implemented.

- [ ] **Step 4: Implement config parsing helpers**

In `src/config.ts`, add `"admin-api-keys"` to `Config`, `RawConfig`, and `DEFAULT_RAW`:

```ts
export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": Set<string>;
  "admin-api-keys": Set<string>;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  stats: StatsConfig;
  reasoning: ReasoningConfig;
  debug: DebugMode;
}

interface RawConfig extends Omit<Config, "api-keys" | "admin-api-keys"> {
  "api-keys": string[];
  "admin-api-keys": string[];
}
```

Add default:

```ts
  "api-keys": [],
  "admin-api-keys": [],
```

Add helpers before `loadConfig`:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringList(value: unknown, key: string): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    console.warn(`Ignoring invalid ${key}: expected string or string array`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      console.warn(`Ignoring non-string item in ${key}: ${String(item)}`);
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function readConfigFile(filePath: string): Partial<RawConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(content);
  if (parsed == null) return {};
  if (!isRecord(parsed)) {
    throw new Error("Config file must contain a YAML object");
  }
  return parsed as Partial<RawConfig>;
}
```

- [ ] **Step 5: Persist generated missing client and admin keys**

Replace the read/merge and key generation section in `loadConfig` with this shape:

```ts
  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const parsed = readConfigFile(filePath);
    raw = {
      ...DEFAULT_RAW,
      ...parsed,
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
      stats: { ...DEFAULT_RAW.stats, ...(parsed.stats || {}) },
      reasoning: { ...DEFAULT_RAW.reasoning, ...(parsed.reasoning || {}) },
      "api-keys": normalizeStringList(parsed["api-keys"], "api-keys"),
      "admin-api-keys": normalizeStringList(
        parsed["admin-api-keys"],
        "admin-api-keys",
      ),
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);
  raw.reasoning = normalizeReasoningConfig(raw.reasoning);

  let shouldPersist = false;
  if (!raw["api-keys"].length) {
    const key = generateApiKey();
    raw["api-keys"] = [key];
    shouldPersist = true;
    console.log(`\nGenerated client API key (saved to ${filePath}):\n\n  ${key}\n`);
  }
  if (!raw["admin-api-keys"].length) {
    const key = generateApiKey();
    raw["admin-api-keys"] = [key];
    shouldPersist = true;
    console.log(`\nGenerated admin API key (saved to ${filePath}):\n\n  ${key}\n`);
  }
  if (shouldPersist) {
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
  }

  return {
    ...raw,
    "api-keys": new Set(raw["api-keys"]),
    "admin-api-keys": new Set(raw["admin-api-keys"]),
  };
```

- [ ] **Step 6: Update notify reload to use admin keys**

In `src/utils/notify-reload.ts`, replace the API key selection with:

```ts
  const apiKey =
    [...(config["admin-api-keys"] || [])][0] || [...config["api-keys"]][0];
```

- [ ] **Step 7: Update config example docs**

In `config.example.yaml`, add:

```yaml
# Admin keys for /admin/accounts, /admin/stats, and /admin/reload.
# If omitted, auth2api generates a separate admin key on startup.
admin-api-keys:
  - "your-admin-api-key-here"
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
npx tsx --test tests/unit.test.ts --test-name-pattern "loadConfig .*YAML|scalar api-keys|admin-api-keys"
npx tsx --test tests/codex.test.ts --test-name-pattern "notifyServerReload prefers"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/utils/notify-reload.ts config.example.yaml tests/unit.test.ts tests/codex.test.ts
git commit -m "fix(config): validate key lists and separate admin keys"
```

---

### Task 2: Timing-Safe Auth and Protected Middleware Ordering

**Files:**
- Modify: `src/utils/common.ts`
- Modify: `src/server.ts`
- Modify: `tests/unit.test.ts`
- Modify: `tests/smoke.test.ts`

**Interfaces:**
- Produces: `hasTimingSafeApiKey(provided: string, allowed: Set<string>): boolean`
- Produces: protected route order `CORS -> rateLimit -> auth -> express.json -> handlers`
- Consumes: `Config["api-keys"]` for `/v1`, `/codex`, `/backend-api/codex`
- Consumes: `Config["admin-api-keys"]` for `/admin`

- [ ] **Step 1: Write failing timing-safe helper tests**

In `tests/unit.test.ts`, import `hasTimingSafeApiKey` from `../src/utils/common` and add:

```ts
test("hasTimingSafeApiKey validates exact configured keys", () => {
  const allowed = new Set(["sk-one", "sk-two"]);
  assert.equal(hasTimingSafeApiKey("sk-one", allowed), true);
  assert.equal(hasTimingSafeApiKey("sk-two", allowed), true);
  assert.equal(hasTimingSafeApiKey("sk-three", allowed), false);
  assert.equal(hasTimingSafeApiKey("", allowed), false);
});
```

- [ ] **Step 2: Write failing protected-route tests**

In `tests/smoke.test.ts`, add a test near admin auth tests. Reuse the file's existing test server helpers:

```ts
test("admin routes require admin-api-key, not client api-key", async (t) => {
  const fixture = await startSmokeServer(t, {
    apiKeys: ["sk-client"],
    adminApiKeys: ["sk-admin"],
  });

  const clientKey = await requestJson(fixture.port, {
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer sk-client" },
  });
  assert.equal(clientKey.status, 403);

  const adminKey = await requestJson(fixture.port, {
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer sk-admin" },
  });
  assert.equal(adminKey.status, 200);
});

test("protected routes reject missing auth before parsing oversized JSON", async (t) => {
  const fixture = await startSmokeServer(t, { bodyLimit: "1kb" });
  const hugeBody = JSON.stringify({ input: "x".repeat(4096) });

  const result = await requestRaw(fixture.port, {
    method: "POST",
    path: "/v1/responses",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(hugeBody).toString(),
    },
    body: hugeBody,
  });

  assert.equal(result.status, 401);
  assert.match(result.body, /Missing API key/);
});
```

If `startSmokeServer`, `requestJson`, or `requestRaw` use different names in the current test file, adapt only the call wrapper names and preserve the assertions exactly.

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
npx tsx --test tests/unit.test.ts --test-name-pattern "hasTimingSafeApiKey"
npx tsx --test tests/smoke.test.ts --test-name-pattern "admin routes require|oversized JSON"
```

Expected: FAIL because the helper and admin/client separation are not implemented.

- [ ] **Step 4: Implement timing-safe helper**

In `src/utils/common.ts`, add:

```ts
function sha256Buffer(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

export function hasTimingSafeApiKey(
  provided: string,
  allowed: Set<string>,
): boolean {
  if (!provided || allowed.size === 0) return false;
  const providedHash = sha256Buffer(provided);
  let matched = false;
  for (const candidate of allowed) {
    const candidateHash = sha256Buffer(candidate);
    matched = crypto.timingSafeEqual(providedHash, candidateHash) || matched;
  }
  return matched;
}
```

- [ ] **Step 5: Reorder protected middleware and split auth**

In `src/server.ts`, import `hasTimingSafeApiKey`:

```ts
import { extractApiKey, hashApiKey, hasTimingSafeApiKey } from "./utils/common";
```

Replace global JSON parsing:

```ts
  app.use(express.json({ limit: config["body-limit"] }));
```

with route-scoped parsing after auth:

```ts
  const protectedRoutes = ["/v1", "/codex", "/backend-api/codex", "/admin"];
```

Refactor the auth factory:

```ts
  const requireApiKeyFor = (
    allowedKeys: Set<string>,
    label: "client" | "admin",
  ): express.RequestHandler => {
    return (req, res, next) => {
      const key = extractApiKey(req.headers);
      if (!key) {
        res.status(401).json({ error: { message: "Missing API key" } });
        return;
      }
      if (!hasTimingSafeApiKey(key, allowedKeys)) {
        res.status(403).json({ error: { message: `Invalid ${label} API key` } });
        return;
      }
      if (statsRecorder) {
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        const ua = (req.headers["user-agent"] as string) || "";
        res.locals.stats = {
          apiKeyHash: hashApiKey(key),
          ip,
          ua,
          endpoint: `${req.method} ${req.baseUrl}${req.path}`,
          startedAt: Date.now(),
          model: null,
          provider: null,
          accountEmail: null,
          usage: null,
          failureKind: null,
        };
      }
      next();
    };
  };
  const requireClientApiKey = requireApiKeyFor(config["api-keys"], "client");
  const requireAdminApiKey = requireApiKeyFor(
    config["admin-api-keys"],
    "admin",
  );
```

Mount rate limit, auth, stats, and JSON parsing in this order:

```ts
  app.use(protectedRoutes, (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip)) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  app.use("/admin", requireAdminApiKey);
  app.use(["/v1", "/codex", "/backend-api/codex"], requireClientApiKey);

  app.use("/admin", statsFinishMiddleware);
  app.use(["/v1", "/codex", "/backend-api/codex"], statsFinishMiddleware);

  app.use(protectedRoutes, express.json({ limit: config["body-limit"] }));
```

Remove the old `/v1`-only rate limiter and old `app.use("/admin", requireApiKey)` / `app.use(["/v1", ...], requireApiKey)` calls.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx tsx --test tests/unit.test.ts --test-name-pattern "hasTimingSafeApiKey"
npx tsx --test tests/smoke.test.ts --test-name-pattern "admin routes require|oversized JSON"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/utils/common.ts src/server.ts tests/unit.test.ts tests/smoke.test.ts
git commit -m "fix(server): harden protected route authentication"
```

---

### Task 3: Reload Lifecycle for Newly Added Providers

**Files:**
- Modify: `src/accounts/manager.ts`
- Modify: `src/server.ts`
- Modify: `tests/codex.test.ts`

**Interfaces:**
- Produces: idempotent `AccountManager.startAutoRefresh(): void`
- Produces: idempotent `AccountManager.startStatsLogger(): void`
- Consumes: `/admin/reload` reload result and starts lifecycle timers when `accountCount > 0`

- [ ] **Step 1: Write failing idempotency test**

In `tests/codex.test.ts`, add near AccountManager tests:

```ts
test("AccountManager lifecycle starters are idempotent", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-manager-"));
  try {
    let refreshCalls = 0;
    const manager = new AccountManager(tmpDir, {
      provider: "anthropic",
      refresh: async () => {
        refreshCalls++;
        return {
          accessToken: "new",
          refreshToken: "new-refresh",
          email: "x@y.z",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          accountUuid: "acct",
          provider: "anthropic",
        };
      },
      refreshPolicy: { kind: "expires-lead", leadMs: 86_400_000 },
    });
    manager.addAccount({
      accessToken: "old",
      refreshToken: "old-refresh",
      email: "x@y.z",
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      accountUuid: "acct",
      provider: "anthropic",
    });

    manager.startAutoRefresh();
    manager.startAutoRefresh();
    manager.startStatsLogger();
    manager.startStatsLogger();
    await new Promise((resolve) => setTimeout(resolve, 25));

    manager.stopAutoRefresh();
    manager.stopStatsLogger();
    assert.equal(refreshCalls, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run focused test and verify it fails**

Run:

```bash
npx tsx --test tests/codex.test.ts --test-name-pattern "lifecycle starters are idempotent"
```

Expected: FAIL because two initial refresh passes can be scheduled.

- [ ] **Step 3: Make lifecycle starts idempotent**

In `src/accounts/manager.ts`, change the two starter methods:

```ts
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error(
            `[${this.provider}] refresh cycle failed:`,
            err.message,
          ),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error(`[${this.provider}] initial refresh failed:`, err.message),
    );
  }

  startStatsLogger(): void {
    if (this.statsTimer) return;
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }
```

- [ ] **Step 4: Start lifecycle after reload**

In `src/server.ts`, inside `app.post("/admin/reload", ...)`, after a provider reload succeeds:

```ts
        if (p.manager.accountCount > 0) {
          p.manager.startAutoRefresh();
          p.manager.startStatsLogger();
        }
```

The full success branch should look like:

```ts
      try {
        reloaded[p.id] = await p.manager.reload();
        if (p.manager.accountCount > 0) {
          p.manager.startAutoRefresh();
          p.manager.startStatsLogger();
        }
      } catch (err: any) {
        reloaded[p.id] = { error: err?.message || String(err) };
      }
```

- [ ] **Step 5: Run focused test**

Run:

```bash
npx tsx --test tests/codex.test.ts --test-name-pattern "lifecycle starters are idempotent"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/accounts/manager.ts src/server.ts tests/codex.test.ts
git commit -m "fix(accounts): start provider lifecycle after reload"
```

---

### Task 4: Codex Account-Scoped Model Failover

**Files:**
- Modify: `src/utils/http.ts`
- Modify: `src/handlers/openai.ts`
- Modify: `src/handlers/anthropic.ts`
- Modify: `tests/smoke.test.ts`

**Interfaces:**
- Produces: `ProxyOptions.classifyAccountScopedError?: (status: number, body: string) => AccountFailureKind | null`
- Produces: Codex account-scoped model/subscription errors are cooled down and retried on another account.

- [ ] **Step 1: Write failing Codex failover test**

In `tests/smoke.test.ts`, add a Codex test using the existing mocked upstream server pattern:

```ts
test("codex retries another account when one account cannot serve the requested model", async (t) => {
  const fixture = await startCodexSmokeServer(t, {
    accounts: [
      { email: "free@example.com", accessToken: "free-at", refreshToken: "free-rt" },
      { email: "pro@example.com", accessToken: "pro-at", refreshToken: "pro-rt" },
    ],
    codexResponses: [
      {
        expectedBearer: "Bearer free-at",
        status: 400,
        body: { detail: "model not supported for this account" },
      },
      {
        expectedBearer: "Bearer pro-at",
        status: 200,
        sse: [
          {
            event: "response.output_text.delta",
            data: { delta: "ok" },
          },
          {
            event: "response.completed",
            data: {
              response: {
                id: "resp_1",
                object: "response",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          },
        ],
      },
    ],
  });

  const result = await requestJson(fixture.port, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.choices[0].message.content, "ok");
  assert.deepEqual(fixture.seenAuthorizations, [
    "Bearer free-at",
    "Bearer pro-at",
  ]);
});
```

If `startCodexSmokeServer` does not exist, build the helper locally in the test from existing smoke server helpers: create two `codex-*.json` token files in the auth dir and mock `global.fetch` for `https://chatgpt.com/backend-api/codex/responses`.

- [ ] **Step 2: Run focused test and verify it fails**

Run:

```bash
npx tsx --test tests/smoke.test.ts --test-name-pattern "codex retries another account"
```

Expected: FAIL because 400 responses are currently surfaced immediately.

- [ ] **Step 3: Extend proxy retry options**

In `src/utils/http.ts`, extend `ProxyOptions`:

```ts
  classifyAccountScopedError?: (
    status: number,
    body: string,
  ) => AccountFailureKind | null;
```

After `lastErrBody = await upstream.text();`, before the existing `if (lastStatus === 401)` block, add:

```ts
      const accountScopedFailure =
        options.classifyAccountScopedError?.(lastStatus, lastErrBody) ?? null;
      if (accountScopedFailure) {
        manager.recordFailure(
          account.token.email,
          accountScopedFailure,
          lastErrBody.slice(0, 500),
        );
        if (attempt < Math.max(maxRetries, manager.accountCount) - 1) {
          continue;
        }
      }
```

Change the retry loop bound:

```ts
    for (let attempt = 0; attempt < Math.max(maxRetries, manager.accountCount); attempt++) {
```

- [ ] **Step 4: Add Codex classifier and pass it to Codex proxy calls**

In `src/handlers/openai.ts`, add:

```ts
function codexAccountScopedError(
  status: number,
  body: string,
): "forbidden" | null {
  if (status !== 400 && status !== 403) return null;
  const text = body.toLowerCase();
  if (
    text.includes("model not supported") ||
    text.includes("not available for this account") ||
    text.includes("requires chatgpt plus") ||
    text.includes("requires chatgpt pro") ||
    text.includes("upgrade")
  ) {
    return "forbidden";
  }
  return null;
}
```

Pass `classifyAccountScopedError: codexAccountScopedError` to all Codex `proxyWithRetry` calls in `proxyCodexChatCompletions`, `proxyCodexResponses`, and `createResponsesCompactHandler`.

In `src/handlers/anthropic.ts`, add the same local helper or export it from `src/handlers/openai.ts` only if that does not create circular imports. Prefer duplicating the small helper in `anthropic.ts` and pass it to the Codex `/v1/messages` proxy call.

- [ ] **Step 5: Run focused test**

Run:

```bash
npx tsx --test tests/smoke.test.ts --test-name-pattern "codex retries another account"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/http.ts src/handlers/openai.ts src/handlers/anthropic.ts tests/smoke.test.ts
git commit -m "fix(codex): retry account-scoped model failures"
```

---

### Task 5: Docker Reproducibility and Secret-Safe Build Context

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Create: `.dockerignore`
- Modify: `README.md`
- Modify: `README_CN.md`

**Interfaces:**
- Produces: Docker build uses `npm ci` with `package-lock.json`.
- Produces: build context excludes local tokens, config, generated artifacts, and dependency folders.
- Produces: compose auth token volume aligns with default `auth-dir: "~/.auth2api"` inside the container.

- [ ] **Step 1: Add `.dockerignore`**

Create `.dockerignore`:

```dockerignore
.git
.gitignore
node_modules
dist
config.yaml
.env
*.log
.DS_Store
.cursor
.idea
.vscode
docs/superpowers/plans
docs/superpowers/specs
```

- [ ] **Step 2: Update Dockerfile**

Replace the Dockerfile with:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./
EXPOSE 8317
VOLUME ["/root/.auth2api", "/config"]
ENV NODE_ENV=production
CMD ["node", "dist/index.js", "--config=/config/config.yaml"]
```

- [ ] **Step 3: Update compose volume**

In `docker-compose.yml`, change the token volume:

```yaml
    volumes:
      - ./config.yaml:/config/config.yaml
      - auth-data:/root/.auth2api
```

- [ ] **Step 4: Update Docker docs**

In `README.md`, change the Docker run token mount from:

```bash
-v ~/.auth2api:/data \
```

to:

```bash
-v ~/.auth2api:/root/.auth2api \
```

Add one sentence below the Docker command:

```md
Inside the container, the default `auth-dir: "~/.auth2api"` resolves to `/root/.auth2api`; keep the volume mounted there unless you explicitly set `auth-dir: "/data"` in your config.
```

Mirror the same update in `README_CN.md`.

- [ ] **Step 5: Verify Docker build syntax**

Run:

```bash
docker build -t auth2api:test .
```

Expected: image builds successfully. If Docker is unavailable in the environment, run `npm run build` and record Docker verification as not run with the reason.

- [ ] **Step 6: Commit**

```bash
git add .dockerignore Dockerfile docker-compose.yml README.md README_CN.md
git commit -m "fix(docker): make builds reproducible and align auth volume"
```

---

### Task 6: Documentation Consistency for Auth, Docker, and Models

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `config.example.yaml`

**Interfaces:**
- Produces: docs that match `src/upstream/translator.ts` aliases and `src/providers/anthropic.ts` advertised models.
- Produces: docs that explain client API keys versus admin API keys.

- [ ] **Step 1: Update README API key sections**

In `README.md`, replace the config snippet around `api-keys` with:

```yaml
api-keys:
  - "your-client-api-key-here" # clients use these for /v1, /codex, and /backend-api/codex

admin-api-keys:
  - "your-admin-api-key-here" # operators use these for /admin/accounts, /admin/stats, and /admin/reload
```

Add below the snippet:

```md
If either key list is omitted or empty, auth2api generates a fresh key for that list and saves it to `config.yaml`. Admin keys are intentionally separate from client keys so application clients cannot inspect account state or trigger reloads.
```

Mirror the same change in `README_CN.md`.

- [ ] **Step 2: Update model table and alias docs**

In `README.md`, update the Anthropic rows to include the current advertised models:

```md
| `claude-sonnet-5`                                  | anthropic | Claude Sonnet 5                                    |
| `claude-fable-5`                                   | anthropic | Claude Fable 5                                     |
| `claude-mythos-preview`                            | anthropic | Claude Mythos preview                              |
| `claude-opus-4-8`                                  | anthropic | Claude Opus 4.8                                    |
| `claude-opus-4-7`                                  | anthropic | Claude Opus 4.7                                    |
| `claude-opus-4-6`                                  | anthropic | Claude Opus 4.6                                    |
| `claude-sonnet-4-6`                                | anthropic | Claude Sonnet 4.6                                  |
```

Update aliases:

```md
- `opus` -> `claude-opus-4-7`
- `sonnet` -> `claude-sonnet-5`
- `haiku` -> `claude-haiku-4-5-20251001`
- `fable` -> `claude-fable-5`
- `mythos` -> `claude-mythos-preview`
```

Mirror equivalent changes in `README_CN.md`.

- [ ] **Step 3: Verify docs references**

Run:

```bash
rg -n "sonnet` -> `claude-sonnet-4-6|your-api-key-here|/data" README.md README_CN.md config.example.yaml docker-compose.yml Dockerfile
```

Expected: no stale `sonnet -> claude-sonnet-4-6`, no generic `your-api-key-here`, and no stale Docker `/data` token mount unless explicitly described as an opt-in override.

- [ ] **Step 4: Commit**

```bash
git add README.md README_CN.md config.example.yaml
git commit -m "docs: align keys docker and model references"
```

---

### Task 7: Final Verification

**Files:**
- Verify only; no planned source edits.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: final confidence that build, tests, docs grep, and working tree status are clean.

- [ ] **Step 1: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS. If the managed sandbox blocks `tsx` IPC with `listen EPERM ... tsx-*.pipe`, rerun the same command with escalation and document that the first failure was sandbox infrastructure.

- [ ] **Step 3: Run stale-doc grep**

Run:

```bash
rg -n "sonnet` -> `claude-sonnet-4-6|your-api-key-here|/data" README.md README_CN.md config.example.yaml docker-compose.yml Dockerfile
```

Expected: no stale hits except an explicit sentence explaining `/data` as an opt-in override.

- [ ] **Step 4: Check worktree**

Run:

```bash
git status --short
```

Expected: clean after commits.

- [ ] **Step 5: Final summary**

Record:

```text
Build: npm run build passed
Tests: npm test passed
Docs grep: no stale key/model/Docker references
Docker: docker build passed OR not run because Docker unavailable
```
