import crypto from "crypto";
import express, { Request, Response } from "express";
import http from "http";
import { URL } from "url";
import { generatePKCECodes } from "./pkce";
import { Provider } from "../providers/types";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
const DOCKER_CALLBACK_HOSTS = ["0.0.0.0"] as const;

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

function isDockerBrowserOAuthMode(): boolean {
  return process.env.AUTH2API_DOCKER_BROWSER_OAUTH === "1";
}

function isPrivateIpv4Address(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  const parts = normalized.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isLoopbackHostHeader(host: unknown): boolean {
  const raw = Array.isArray(host) ? host[0] : host;
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const parsed = new URL(`http://${raw}`);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export function isLoopbackRequest(req: Request): boolean {
  if (isLoopbackAddress(req.socket.remoteAddress)) return true;
  return (
    isDockerBrowserOAuthMode() &&
    isPrivateIpv4Address(req.socket.remoteAddress) &&
    isLoopbackHostHeader(req.headers.host)
  );
}

export interface BrowserOAuthHandlerOptions {
  provider: Provider;
  displayName: string;
  onAccountAdded?: (provider: Provider) => void;
  timeoutMs?: number;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
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
    let settled = false;
    let startupFailed = false;
    let startupResolved = false;
    const listeningServers = new Set<http.Server>();
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const requestHandler: http.RequestListener = async (req, res) => {
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
        await finish(new Error(message));
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
        await finish(new Error(message));
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
        await finish();
      } catch (err: any) {
        const message = err?.message || String(err);
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page(`${displayName} Login Failed`, escapeHtml(message)));
        await finish(new Error(message));
      }
    };

    const timer = setTimeout(() => {
      void finish(new Error(`${displayName} OAuth callback timeout`));
    }, timeoutMs);

    async function shutdownServers(): Promise<void> {
      clearTimeout(timer);
      const servers = Array.from(listeningServers);
      if (servers.length === 0) return;

      await Promise.all(
        servers.map(async (server) => {
          await closeServer(server);
          listeningServers.delete(server);
        }),
      );
    }

    async function finish(error?: Error): Promise<void> {
      if (settled) return;
      settled = true;

      try {
        await shutdownServers();
      } catch (closeErr) {
        const closeError =
          closeErr instanceof Error ? closeErr : new Error(String(closeErr));
        if (!error) {
          error = closeError;
        } else {
          error = new Error(`${error.message}; ${closeError.message}`);
        }
      }

      if (error) {
        rejectDone(error);
        return;
      }

      resolveDone();
    }

    async function failStartup(err: Error): Promise<void> {
      if (startupResolved || startupFailed) return;
      startupFailed = true;
      settled = true;

      try {
        await shutdownServers();
      } catch (closeErr) {
        const closeError =
          closeErr instanceof Error ? closeErr : new Error(String(closeErr));
        err = new Error(`${err.message}; ${closeError.message}`);
      }

      rejectStarted(err);
    }

    const callbackHosts = isDockerBrowserOAuthMode()
      ? DOCKER_CALLBACK_HOSTS
      : LOOPBACK_HOSTS;
    const servers = callbackHosts.map((host) => {
      const server = http.createServer(requestHandler);

      server.once("error", (err) => {
        const serverError = err instanceof Error ? err : new Error(String(err));

        if (startupFailed || settled) {
          return;
        }

        if (startupResolved) {
          void finish(serverError);
          return;
        }

        void failStartup(serverError);
      });

      return { host, server };
    });

    let pendingStarts = servers.length;

    for (const { host, server } of servers) {
      server.listen(
        host === "::1" ? { port, host, ipv6Only: true } : { port, host },
        () => {
          if (startupFailed || settled) {
            closeServer(server).catch((err) => {
              console.error(
                `[${provider.id}] failed to close late OAuth callback listener: ${err?.message || String(err)}`,
              );
            });
            return;
          }

          listeningServers.add(server);
          pendingStarts -= 1;

          if (pendingStarts === 0 && !startupResolved) {
            startupResolved = true;
            resolveStarted({ done });
          }
        },
      );
    }
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
