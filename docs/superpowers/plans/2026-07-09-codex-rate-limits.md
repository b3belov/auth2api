# Codex Rate-Limit Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward safe Codex/OpenAI rate-limit headers from Codex upstream responses to auth2api clients.

**Architecture:** Add one shared HTTP helper that copies a case-insensitive allowlist from Fetch `Response.headers` to an Express response. Use it from `proxyWithRetry` for terminal upstream errors and from every Codex success path before body bytes are written.

**Tech Stack:** TypeScript, Express, Node `fetch`/`Response`, `node:test`, existing `tsx --test` runner.

## Global Constraints

- Forward safe Codex/OpenAI rate-limit headers to clients on Codex-backed requests.
- Cover all Codex request surfaces that receive an upstream `Response`: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and Codex compact endpoints.
- Preserve existing response bodies and streaming behavior.
- Avoid leaking unrelated upstream metadata, cookies, auth headers, account identifiers, or Cloudflare/internal headers.
- Do not persist rate-limit state in `stats.jsonl`.
- Do not add a new admin endpoint.
- Do not infer quota state from response bodies.
- Do not forward arbitrary upstream headers.
- Do not change account cooldown or retry selection behavior.
- Initial allowed header names are `retry-after`, `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, and `x-ratelimit-reset-tokens`.
- Commit subjects must follow Conventional Commit format.

---

## File Structure

- `src/utils/http.ts`: add and export `forwardRateLimitHeaders(upstream: Response, resp: ExpressResponse): void`; call it for the terminal upstream error response after retry selection has finished.
- `src/handlers/openai.ts`: import `forwardRateLimitHeaders`; call it in Codex chat, responses, and compact success paths before streaming, draining, setting content type, or sending JSON.
- `src/handlers/anthropic.ts`: import `forwardRateLimitHeaders`; call it in the Codex messages success path before streaming, draining, or sending JSON.
- `tests/unit.test.ts`: add focused helper and `proxyWithRetry` tests for allowlist behavior, case-insensitive matching, header exclusion, and terminal 429/error forwarding.
- `tests/codex.test.ts`: add route-level tests for non-streaming and streaming Codex success paths, plus compact and messages coverage if existing route helpers make that cheaper than lower-level tests.

### Task 1: Shared rate-limit header forwarding helper

**Files:**
- Modify: `src/utils/http.ts`
- Test: `tests/unit.test.ts`

**Interfaces:**
- Consumes: Express-like response objects with `setHeader(name: string, value: string): unknown` and Fetch `Response.headers`.
- Produces: `export const RATE_LIMIT_RESPONSE_HEADERS: readonly string[]` and `export function forwardRateLimitHeaders(upstream: Response, resp: ExpressResponse): void`.

- [ ] **Step 1: Write failing helper tests**

Add these imports and tests in `tests/unit.test.ts` near the existing `utils/http.ts` tests:

```ts
import {
  classifyFailure,
  forwardRateLimitHeaders,
  proxyWithRetry,
  RATE_LIMIT_RESPONSE_HEADERS,
} from "../src/utils/http";
```

Replace the existing `import { classifyFailure, proxyWithRetry } from "../src/utils/http";` with the import above, then add:

```ts
test("RATE_LIMIT_RESPONSE_HEADERS contains only explicit safe header names", () => {
  assert.deepEqual([...RATE_LIMIT_RESPONSE_HEADERS].sort(), [
    "retry-after",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]);
});

test("forwardRateLimitHeaders copies allowlisted headers case-insensitively", () => {
  const upstream = new Response("ok", {
    headers: {
      "X-RateLimit-Limit-Requests": "100",
      "x-ratelimit-remaining-tokens": "9876",
      "Retry-After": "3",
      "set-cookie": "session=secret",
      "cf-ray": "internal",
      "openai-organization": "org_secret",
    },
  });
  const resp = makeMockResponse();

  forwardRateLimitHeaders(upstream, resp);

  assert.equal(resp.headers["x-ratelimit-limit-requests"], "100");
  assert.equal(resp.headers["x-ratelimit-remaining-tokens"], "9876");
  assert.equal(resp.headers["retry-after"], "3");
  assert.equal(resp.headers["set-cookie"], undefined);
  assert.equal(resp.headers["cf-ray"], undefined);
  assert.equal(resp.headers["openai-organization"], undefined);
});

test("forwardRateLimitHeaders skips missing allowlisted headers", () => {
  const upstream = new Response("ok", {
    headers: { "content-type": "application/json" },
  });
  const resp = makeMockResponse();

  forwardRateLimitHeaders(upstream, resp);

  assert.deepEqual(resp.headers, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- --test-name-pattern "RATE_LIMIT_RESPONSE_HEADERS|forwardRateLimitHeaders"
```

Expected: FAIL with an import/export error for `forwardRateLimitHeaders` or `RATE_LIMIT_RESPONSE_HEADERS`.

- [ ] **Step 3: Implement the helper**

In `src/utils/http.ts`, after `RETRYABLE_STATUSES`, add:

```ts
export const RATE_LIMIT_RESPONSE_HEADERS = [
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

export function forwardRateLimitHeaders(
  upstream: Response,
  resp: ExpressResponse,
): void {
  for (const header of RATE_LIMIT_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value !== null) {
      resp.setHeader(header, value);
    }
  }
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
npm test -- --test-name-pattern "RATE_LIMIT_RESPONSE_HEADERS|forwardRateLimitHeaders"
```

Expected: PASS for the three new helper tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/http.ts tests/unit.test.ts
git commit -m "feat(codex): add rate-limit header forwarding helper" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Forward rate-limit headers on terminal upstream errors

**Files:**
- Modify: `src/utils/http.ts`
- Test: `tests/unit.test.ts`

**Interfaces:**
- Consumes: `forwardRateLimitHeaders(upstream: Response, resp: ExpressResponse): void` from Task 1.
- Produces: Terminal error responses from `proxyWithRetry(...)` include allowlisted headers from the last upstream response selected for the client.

- [ ] **Step 1: Write failing proxy error test**

Add this test after `proxyWithRetry does not write terminal error after client disconnects` in `tests/unit.test.ts`:

```ts
test("proxyWithRetry forwards allowlisted rate-limit headers on terminal errors", async () => {
  const resp = makeMockResponse();
  const account: any = { token: { email: "x@y.z" } };
  const manager: any = {
    provider: "codex",
    accountCount: 1,
    getNextAccount: () => ({ account }),
    recordAttempt: () => {},
    recordFailure: () => {},
    refreshAccount: async () => false,
  };

  await proxyWithRetry("TestProxy", resp, { debug: "off" } as any, {
    manager,
    maxRetries: 1,
    upstream: async () =>
      new Response(JSON.stringify({ error: { message: "too many requests" } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "12s",
          "openai-organization": "org_secret",
        },
      }),
    success: async () => {},
  });

  assert.equal(resp.statusCode, 429);
  assert.equal(resp.headers["x-ratelimit-remaining-requests"], "0");
  assert.equal(resp.headers["x-ratelimit-reset-requests"], "12s");
  assert.equal(resp.headers["openai-organization"], undefined);
  assert.deepEqual(resp.body, { error: { message: "too many requests" } });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- --test-name-pattern "proxyWithRetry forwards allowlisted rate-limit headers"
```

Expected: FAIL because `x-ratelimit-remaining-requests` is not present on `resp.headers`.

- [ ] **Step 3: Store the last upstream response and forward headers before error JSON**

In `src/utils/http.ts`, add a variable near `lastRetryAfter`:

```ts
let lastUpstream: Response | null = null;
```

Immediately after a successful upstream fetch and before status handling, set it:

```ts
lastUpstream = upstream;
```

In the terminal error section, replace:

```ts
if (lastRetryAfter) resp.setHeader("Retry-After", lastRetryAfter);
```

with:

```ts
if (lastUpstream) {
  forwardRateLimitHeaders(lastUpstream, resp);
} else if (lastRetryAfter) {
  resp.setHeader("Retry-After", lastRetryAfter);
}
```

Keep `lastRetryAfter` assigned where it is today so existing behavior remains available if a future path has no stored response.

- [ ] **Step 4: Run proxy error tests**

Run:

```bash
npm test -- --test-name-pattern "proxyWithRetry forwards allowlisted rate-limit headers|proxyWithRetry does not write terminal error after client disconnects"
```

Expected: PASS. The disconnect test must still report no writes after disconnect.

- [ ] **Step 5: Commit**

```bash
git add src/utils/http.ts tests/unit.test.ts
git commit -m "feat(codex): forward rate-limit headers on upstream errors" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Forward headers on Codex OpenAI success paths

**Files:**
- Modify: `src/handlers/openai.ts`
- Test: `tests/codex.test.ts`

**Interfaces:**
- Consumes: `forwardRateLimitHeaders(upstream: Response, resp: ExpressResponse): void`.
- Produces: Codex-backed `/v1/chat/completions`, `/v1/responses`, `/v1/responses/compact`, `/codex/responses/compact`, and `/backend-api/codex/responses/compact` success responses include allowlisted upstream rate-limit headers.

- [ ] **Step 1: Write failing OpenAI route tests**

Append these helpers and tests to `tests/codex.test.ts` after the existing Codex route tests. If `makeCodexConfig` and `makeAvailableAccount` already exist in the file, reuse them.

```ts
async function withCodexTestServer<T>(
  upstream: typeof fetch,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rate-"));
  const origFetch = globalThis.fetch;
  try {
    saveToken(tmpDir, {
      accessToken: "at",
      refreshToken: "rt",
      email: "codex@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      accountUuid: "acct_123",
      provider: "codex",
      idToken: makeJwt({
        email: "codex@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      }),
    });
    globalThis.fetch = upstream;
    const registry = buildRegistry(tmpDir);
    for (const p of registry.all()) p.manager.load();
    const app = createServer(
      {
        host: "127.0.0.1",
        port: 0,
        "auth-dir": tmpDir,
        "api-keys": new Set(["sk-test"]),
        "admin-api-keys": new Set(["sk-admin"]),
        "body-limit": "1mb",
        cloaking: { "cli-version": "2.1.88", entrypoint: "cli" },
        timeouts: {
          "messages-ms": 1000,
          "stream-messages-ms": 1000,
          "count-tokens-ms": 1000,
        },
        stats: { enabled: false },
        reasoning: {},
        debug: "off",
      },
      registry,
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function codexCompletedSse(): string {
  return [
    'event: response.output_text.delta',
    'data: {"delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"response":{"id":"resp_1","object":"response","created_at":1,"status":"completed","model":"gpt-5.5","output":[],"usage":{"input_tokens":4,"output_tokens":2,"input_tokens_details":{"cached_tokens":1},"output_tokens_details":{"reasoning_tokens":0}}}}',
    '',
    '',
  ].join("\n");
}

test("Codex /v1/responses forwards safe rate-limit headers and drops unsafe headers", async () => {
  await withCodexTestServer(
    async () =>
      new Response(codexCompletedSse(), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "X-RateLimit-Limit-Requests": "100",
          "x-ratelimit-remaining-requests": "99",
          "openai-organization": "org_secret",
          "set-cookie": "secret=1",
        },
      }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: false,
          input: [{ role: "user", content: "hi" }],
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ratelimit-limit-requests"), "100");
      assert.equal(response.headers.get("x-ratelimit-remaining-requests"), "99");
      assert.equal(response.headers.get("openai-organization"), null);
      assert.equal(response.headers.get("set-cookie"), null);
      const body = await response.json();
      assert.equal(body.status, "completed");
    },
  );
});

test("Codex /v1/chat/completions streaming forwards rate-limit headers before body", async () => {
  await withCodexTestServer(
    async () =>
      new Response(codexCompletedSse(), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-tokens": "12345",
        },
      }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ratelimit-remaining-tokens"), "12345");
      const body = await response.text();
      assert.match(body, /data:/);
    },
  );
});

test("Codex compact endpoints forward safe rate-limit headers", async () => {
  await withCodexTestServer(
    async () =>
      new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-reset-tokens": "2s",
          },
        },
      ),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses/compact`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          input: [{ role: "user", content: "compact" }],
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ratelimit-reset-tokens"), "2s");
      const body = await response.json();
      assert.equal(body.status, "completed");
    },
  );
});
```

- [ ] **Step 2: Run OpenAI route tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern "Codex /v1/responses forwards safe rate-limit headers|Codex /v1/chat/completions streaming forwards rate-limit headers|Codex compact endpoints forward safe rate-limit headers"
```

Expected: FAIL because the rate-limit headers are not present on the client response.

- [ ] **Step 3: Import helper in OpenAI handler**

In `src/handlers/openai.ts`, change:

```ts
import { proxyWithRetry } from "../utils/http";
```

to:

```ts
import { forwardRateLimitHeaders, proxyWithRetry } from "../utils/http";
```

- [ ] **Step 4: Forward headers in Codex chat success path**

In `proxyCodexChatCompletions`, at the start of the `success: async (upstream, account) => {` block, add:

```ts
      forwardRateLimitHeaders(upstream, resp);
```

This line must be before the `if (stream)` branch so both streaming and non-streaming chat responses get headers before body writes.

- [ ] **Step 5: Forward headers in Codex responses success path**

In `proxyCodexResponses`, at the start of the `success: async (upstream, account) => {` block, add:

```ts
      forwardRateLimitHeaders(upstream, resp);
```

This line must be before the `if (stream)` branch so both streaming and non-streaming Responses responses get headers before body writes.

- [ ] **Step 6: Forward headers in Codex compact success path**

Find the compact handler in `src/handlers/openai.ts` where it calls `callCodexResponses({ ..., path: RESPONSES_COMPACT_PATH })` and handles `success: async (upstream, account) => {`.

At the start of that compact success block, add:

```ts
          forwardRateLimitHeaders(upstream, resp);
```

This line must appear before any existing `resp.setHeader("Content-Type", ...)`, `await upstream.text()`, `tagStatsUsage(...)`, or `resp.status(...).send(...)` / `resp.json(...)` calls.

- [ ] **Step 7: Run OpenAI route tests**

Run:

```bash
npm test -- --test-name-pattern "Codex /v1/responses forwards safe rate-limit headers|Codex /v1/chat/completions streaming forwards rate-limit headers|Codex compact endpoints forward safe rate-limit headers"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/handlers/openai.ts tests/codex.test.ts
git commit -m "feat(codex): forward rate-limit headers on OpenAI routes" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Forward headers on Codex Anthropic messages success path

**Files:**
- Modify: `src/handlers/anthropic.ts`
- Test: `tests/codex.test.ts`

**Interfaces:**
- Consumes: `forwardRateLimitHeaders(upstream: Response, resp: ExpressResponse): void`.
- Produces: Codex-backed `/v1/messages` success responses include allowlisted upstream rate-limit headers for streaming and non-streaming clients.

- [ ] **Step 1: Write failing `/v1/messages` route test**

Add this test to `tests/codex.test.ts` near the tests from Task 3:

```ts
test("Codex /v1/messages forwards safe rate-limit headers", async () => {
  await withCodexTestServer(
    async () =>
      new Response(codexCompletedSse(), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-limit-tokens": "200000",
          "x-ratelimit-remaining-tokens": "199000",
          "cf-ray": "internal",
        },
      }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: false,
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ratelimit-limit-tokens"), "200000");
      assert.equal(response.headers.get("x-ratelimit-remaining-tokens"), "199000");
      assert.equal(response.headers.get("cf-ray"), null);
      const body = await response.json();
      assert.equal(body.type, "message");
    },
  );
});
```

- [ ] **Step 2: Run the failing messages test**

Run:

```bash
npm test -- --test-name-pattern "Codex /v1/messages forwards safe rate-limit headers"
```

Expected: FAIL because the rate-limit headers are not present on the client response.

- [ ] **Step 3: Import helper in Anthropic handler**

In `src/handlers/anthropic.ts`, change:

```ts
import { proxyWithRetry } from "../utils/http";
```

to:

```ts
import { forwardRateLimitHeaders, proxyWithRetry } from "../utils/http";
```

- [ ] **Step 4: Forward headers in Codex messages success path**

In `proxyCodexMessages`, at the start of the `success: async (upstream, account) => {` block, add:

```ts
      forwardRateLimitHeaders(upstream, resp);
```

This line must be before the `if (stream)` branch so both streaming and non-streaming Anthropic Messages responses get headers before body writes.

- [ ] **Step 5: Run the messages test**

Run:

```bash
npm test -- --test-name-pattern "Codex /v1/messages forwards safe rate-limit headers"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/anthropic.ts tests/codex.test.ts
git commit -m "feat(codex): forward rate-limit headers on messages route" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Full verification and documentation

**Files:**
- Modify: `README.md`
- Verify: `src/utils/http.ts`, `src/handlers/openai.ts`, `src/handlers/anthropic.ts`, `tests/unit.test.ts`, `tests/codex.test.ts`

**Interfaces:**
- Consumes: completed forwarding behavior from Tasks 1-4.
- Produces: documented client-visible rate-limit header behavior and a fully verified branch.

- [ ] **Step 1: Add README documentation**

In `README.md`, add this section after the endpoint support matrix or near the existing Codex endpoint notes:

```md
#### Codex rate-limit headers

For Codex-backed requests, auth2api forwards a safe allowlist of upstream rate-limit headers to the client when Codex returns them:

- `retry-after`
- `x-ratelimit-limit-requests`
- `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-requests`
- `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-requests`
- `x-ratelimit-reset-tokens`

Other upstream headers are intentionally not forwarded.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- --test-name-pattern "RATE_LIMIT_RESPONSE_HEADERS|forwardRateLimitHeaders|proxyWithRetry forwards allowlisted rate-limit headers|Codex /v1/responses forwards safe rate-limit headers|Codex /v1/chat/completions streaming forwards rate-limit headers|Codex compact endpoints forward safe rate-limit headers|Codex /v1/messages forwards safe rate-limit headers"
```

Expected: PASS for all rate-limit related tests.

- [ ] **Step 3: Run full tests**

Run:

```bash
npm test
```

Expected: PASS for the full test suite.

- [ ] **Step 4: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git --no-pager diff --stat HEAD
git --no-pager diff -- src/utils/http.ts src/handlers/openai.ts src/handlers/anthropic.ts tests/unit.test.ts tests/codex.test.ts README.md
```

Expected: Diff only contains rate-limit header forwarding code, tests, and README documentation.

- [ ] **Step 6: Commit documentation and any final fixes**

```bash
git add README.md src/utils/http.ts src/handlers/openai.ts src/handlers/anthropic.ts tests/unit.test.ts tests/codex.test.ts
git commit -m "docs: document Codex rate-limit headers" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

If there are no documentation-only changes left because README was committed with a prior task, skip this commit and ensure the final `git status --short` is clean.

### Task 6: Prepare PR

**Files:**
- Verify repository state only.

**Interfaces:**
- Consumes: clean, verified implementation branch.
- Produces: a PR title and body that satisfy the repository’s Conventional Commit and PR-description requirements.

- [ ] **Step 1: Verify commit subjects**

Run:

```bash
git --no-pager log --oneline main..HEAD
```

Expected: every non-merge commit subject matches `[revert: ]<type>[(scope)][!]: <description>`.

- [ ] **Step 2: Verify working tree is clean**

Run:

```bash
git status --short
```

Expected: no output.

- [ ] **Step 3: Create PR**

Use title:

```text
feat(codex): forward rate-limit headers
```

Use body:

```md
## Summary

Forward safe Codex/OpenAI rate-limit headers from Codex upstream responses to auth2api clients so callers can inspect current quota state.

## Changes

- Add an explicit allowlist for rate-limit response headers.
- Forward allowlisted headers on Codex success paths for chat completions, Responses, Messages, and compact endpoints.
- Forward allowlisted headers on terminal upstream errors such as 429 responses.
- Document the forwarded header names.

## Testing

- `npm test`
- `npm run build`

## Risk

Clients with valid auth2api API keys can see upstream account quota state through the forwarded headers. Header forwarding is limited to an explicit allowlist to avoid exposing unrelated upstream metadata.
```

- [ ] **Step 4: Confirm PR creation**

Expected: PR title follows Conventional Commit format and PR body includes Summary, Changes, Testing, and Risk sections.
