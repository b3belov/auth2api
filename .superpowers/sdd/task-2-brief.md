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

