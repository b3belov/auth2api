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

