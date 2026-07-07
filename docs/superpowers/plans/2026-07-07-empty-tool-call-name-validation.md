# Empty Tool Call Name Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed assistant tool-call history from being proxied to Codex as Responses `input[*].name: ""`, and return a clear local 400 error instead.

**Architecture:** Add a small translator-level validation error and non-empty-name helper in `src/upstream/responses-translator.ts`, then use it at every Chat/Anthropic-to-Responses function-call creation point. Update OpenAI and Anthropic handlers to map these translator validation errors to client-facing 400 responses instead of generic 500s.

**Tech Stack:** TypeScript, Express handlers, Node `node:test`, OpenAI Chat Completions/Responses and Anthropic Messages wire formats.

## Global Constraints

- Keep the fix localized to request translation and handler error mapping; do not rewrite translator architecture.
- Do not silently drop invalid tool calls or invent fallback tool names.
- Preserve valid tool-call translation output exactly where possible.
- Use existing scripts only: `npm test` and `npm run build`.
- Manual edits must use `apply_patch`.

---

## File Structure

- Modify `src/upstream/responses-translator.ts`: own validation type/helper and apply it in `chatToResponsesRequest()` and `anthropicToResponsesRequest()`.
- Modify `src/handlers/openai.ts`: return local 400 for `ResponsesTranslationError` thrown while building Codex request bodies for `/v1/chat/completions` and `/v1/responses` if sanitization later validates direct Responses input.
- Modify `src/handlers/anthropic.ts`: return local 400 for `ResponsesTranslationError` thrown while building Codex request bodies for `/v1/messages`.
- Modify `tests/responses-translator.test.ts`: add regression tests for empty/missing Chat `tool_calls[].function.name` and Anthropic `tool_use.name`.

---

### Task 1: Add translator validation tests

**Files:**
- Modify: `tests/responses-translator.test.ts`

**Interfaces:**
- Consumes: existing `chatToResponsesRequest()` and `anthropicToResponsesRequest()` exports from `src/upstream/responses-translator.ts`.
- Produces: failing regression tests that require both translators to throw an error with `status === 400`, `code === "invalid_tool_call_name"`, and a path-specific message.

- [ ] **Step 1: Add failing Chat translator tests**

Insert these tests after the existing `chatToResponsesRequest: converts assistant tool_calls to function_call items` test:

```ts
test("chatToResponsesRequest: rejects assistant tool_calls with empty names", () => {
  assert.throws(
    () =>
      chatToResponsesRequest({
        model: "gpt-5.5-medium",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "", arguments: '{"city":"SF"}' },
              },
            ],
          },
        ],
      }),
    (err: any) => {
      assert.equal(err.name, "ResponsesTranslationError");
      assert.equal(err.status, 400);
      assert.equal(err.code, "invalid_tool_call_name");
      assert.match(
        err.message,
        /messages\[1\]\.tool_calls\[0\]\.function\.name must be a non-empty string/,
      );
      return true;
    },
  );
});

test("chatToResponsesRequest: rejects assistant tool_calls with missing function names", () => {
  assert.throws(
    () =>
      chatToResponsesRequest({
        model: "gpt-5.5-medium",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { arguments: '{"city":"SF"}' },
              },
            ],
          },
        ],
      }),
    (err: any) => {
      assert.equal(err.name, "ResponsesTranslationError");
      assert.equal(err.status, 400);
      assert.equal(err.code, "invalid_tool_call_name");
      assert.match(
        err.message,
        /messages\[1\]\.tool_calls\[0\]\.function\.name must be a non-empty string/,
      );
      return true;
    },
  );
});
```

- [ ] **Step 2: Add failing Anthropic translator test**

Insert this test after the existing `anthropicToResponsesRequest: converts tool_use / tool_result blocks` test:

```ts
test("anthropicToResponsesRequest: rejects tool_use blocks with empty names", () => {
  assert.throws(
    () =>
      anthropicToResponsesRequest({
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "   ",
                input: { city: "SF" },
              },
            ],
          },
        ],
      }),
    (err: any) => {
      assert.equal(err.name, "ResponsesTranslationError");
      assert.equal(err.status, 400);
      assert.equal(err.code, "invalid_tool_call_name");
      assert.match(
        err.message,
        /messages\[0\]\.content\[0\]\.name must be a non-empty string/,
      );
      return true;
    },
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm test -- --test-name-pattern "rejects.*names|empty names"
```

Expected: tests fail because current translators emit `name: ""` instead of throwing `ResponsesTranslationError`. If Node's test runner does not match all patterns as expected, run the full file instead:

```bash
npx tsx --test tests/responses-translator.test.ts
```

- [ ] **Step 4: Commit failing tests is not required**

Do not commit yet; Task 2 will make the tests pass and commit the cohesive translator change.

---

### Task 2: Implement translator validation

**Files:**
- Modify: `src/upstream/responses-translator.ts:19-23`
- Modify: `src/upstream/responses-translator.ts:228-263`
- Modify: `src/upstream/responses-translator.ts:355-390`
- Test: `tests/responses-translator.test.ts`

**Interfaces:**
- Consumes: test expectations from Task 1.
- Produces: exported class `ResponsesTranslationError extends Error` with fields `status: number` and `code: string`; exported function is not required. Internal helper `requireNonEmptyName(value: unknown, path: string): string` returns the original string only when `value.trim()` is non-empty.

- [ ] **Step 1: Add validation error and helper**

Insert after `compactUuid()`:

```ts
export class ResponsesTranslationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code = "invalid_request") {
    super(message);
    this.name = "ResponsesTranslationError";
    this.status = 400;
    this.code = code;
  }
}

function requireNonEmptyName(value: unknown, path: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new ResponsesTranslationError(
    `${path} must be a non-empty string`,
    "invalid_tool_call_name",
  );
}
```

- [ ] **Step 2: Validate Chat assistant tool-call names**

Change the Chat messages loop to track the message index and tool-call index. Replace:

```ts
for (const msg of body.messages || []) {
```

with:

```ts
for (const [messageIndex, msg] of (body.messages || []).entries()) {
```

Then replace this block:

```ts
for (const tc of msg.tool_calls) {
  inputItems.push({
    type: "function_call",
    call_id: tc.id,
    name: tc.function?.name || "",
    arguments: tc.function?.arguments || "{}",
  });
}
```

with:

```ts
for (const [toolCallIndex, tc] of msg.tool_calls.entries()) {
  inputItems.push({
    type: "function_call",
    call_id: tc.id,
    name: requireNonEmptyName(
      tc.function?.name,
      `messages[${messageIndex}].tool_calls[${toolCallIndex}].function.name`,
    ),
    arguments: tc.function?.arguments || "{}",
  });
}
```

- [ ] **Step 3: Validate Anthropic tool_use names**

Change the Anthropic messages loop and content loop to track indexes. Replace:

```ts
for (const msg of body.messages || []) {
```

with:

```ts
for (const [messageIndex, msg] of (body.messages || []).entries()) {
```

Replace:

```ts
for (const block of msg.content) {
```

with:

```ts
for (const [contentIndex, block] of msg.content.entries()) {
```

Then replace the `tool_use` name assignment:

```ts
name: block.name,
```

with:

```ts
name: requireNonEmptyName(
  block.name,
  `messages[${messageIndex}].content[${contentIndex}].name`,
),
```

- [ ] **Step 4: Run translator tests**

Run:

```bash
npx tsx --test tests/responses-translator.test.ts
```

Expected: all tests in `tests/responses-translator.test.ts` pass.

- [ ] **Step 5: Commit translator validation**

Run:

```bash
git add src/upstream/responses-translator.ts tests/responses-translator.test.ts
git commit -m "fix: validate tool call names before codex translation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Map translator validation errors to local 400 responses

**Files:**
- Modify: `src/handlers/openai.ts:25-31`
- Modify: `src/handlers/openai.ts:67-93`
- Modify: `src/handlers/openai.ts:201-223`
- Modify: `src/handlers/anthropic.ts:10-16`
- Modify: `src/handlers/anthropic.ts:33-60`

**Interfaces:**
- Consumes: `ResponsesTranslationError` exported from `src/upstream/responses-translator.ts`.
- Produces: helper `sendResponsesTranslationError(resp, err): boolean` in each handler file, returning `true` only when it writes a 400 response.

- [ ] **Step 1: Import `ResponsesTranslationError` in OpenAI handler**

Update the existing import from `../upstream/responses-translator` to include the class:

```ts
import {
  ResponsesTranslationError,
  chatToResponsesRequest,
  responsesToChatCompletion,
  responsesSSEToChat,
  makeResponsesToChatState,
  drainCodexResponsesSse,
} from "../upstream/responses-translator";
```

- [ ] **Step 2: Add OpenAI handler error mapper**

Insert after `internalError()` in `src/handlers/openai.ts`:

```ts
function sendResponsesTranslationError(
  resp: ExpressResponse,
  err: unknown,
): boolean {
  if (!(err instanceof ResponsesTranslationError)) return false;
  resp.status(err.status).json({
    error: {
      message: err.message,
      type: "invalid_request_error",
      code: err.code,
    },
  });
  return true;
}
```

- [ ] **Step 3: Wrap OpenAI Codex chat translation**

Replace:

```ts
const responsesBody = normalizeCodexResponsesBody(
  chatToResponsesRequest(body),
);
```

with:

```ts
let responsesBody: any;
try {
  responsesBody = normalizeCodexResponsesBody(chatToResponsesRequest(body));
} catch (err) {
  if (sendResponsesTranslationError(resp, err)) return;
  throw err;
}
```

- [ ] **Step 4: Wrap OpenAI direct Responses normalization defensively**

Replace:

```ts
const responsesBody = normalizeCodexResponsesBody(body);
```

with:

```ts
let responsesBody: any;
try {
  responsesBody = normalizeCodexResponsesBody(body);
} catch (err) {
  if (sendResponsesTranslationError(resp, err)) return;
  throw err;
}
```

Expected note: this defensive wrapper may not catch anything today because direct Responses passthrough is not yet validating `input`, but it keeps handler behavior consistent if validation is later centralized in normalization.

- [ ] **Step 5: Import `ResponsesTranslationError` in Anthropic handler**

Update the existing import from `../upstream/responses-translator` to include the class:

```ts
import {
  ResponsesTranslationError,
  anthropicToResponsesRequest,
  responsesToAnthropicMessage,
  responsesSSEToAnthropic,
  makeResponsesToAnthropicState,
  drainCodexResponsesSse,
} from "../upstream/responses-translator";
```

- [ ] **Step 6: Add Anthropic handler error mapper**

Insert after `internalError()` in `src/handlers/anthropic.ts`:

```ts
function sendResponsesTranslationError(
  resp: ExpressResponse,
  err: unknown,
): boolean {
  if (!(err instanceof ResponsesTranslationError)) return false;
  resp.status(err.status).json({
    error: {
      message: err.message,
      type: "invalid_request_error",
      code: err.code,
    },
  });
  return true;
}
```

- [ ] **Step 7: Wrap Anthropic Codex messages translation**

Replace:

```ts
const responsesBody = normalizeCodexResponsesBody(
  anthropicToResponsesRequest(body),
);
```

with:

```ts
let responsesBody: any;
try {
  responsesBody = normalizeCodexResponsesBody(anthropicToResponsesRequest(body));
} catch (err) {
  if (sendResponsesTranslationError(resp, err)) return;
  throw err;
}
```

- [ ] **Step 8: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript compilation succeeds.

- [ ] **Step 9: Commit handler mapping**

Run:

```bash
git add src/handlers/openai.ts src/handlers/anthropic.ts
git commit -m "fix: return local 400 for translation validation errors" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Final verification

**Files:**
- No new edits expected.

**Interfaces:**
- Consumes: Tasks 1-3 committed changes.
- Produces: verified branch where malformed tool-call names fail locally and valid translator behavior remains intact.

- [ ] **Step 1: Run all tests**

Run:

```bash
npm test
```

Expected: all test files pass.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript compilation succeeds.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git --no-pager diff --stat main...HEAD
git --no-pager diff main...HEAD -- src/upstream/responses-translator.ts src/handlers/openai.ts src/handlers/anthropic.ts tests/responses-translator.test.ts
```

Expected: diff is limited to translator validation, handler 400 mapping, and regression tests.

- [ ] **Step 4: Commit any missed verification-only fixes**

If Step 1 or Step 2 reveals a type/test issue directly caused by this plan, fix only that issue and commit:

```bash
git add src/upstream/responses-translator.ts src/handlers/openai.ts src/handlers/anthropic.ts tests/responses-translator.test.ts
git commit -m "fix: complete empty tool call name validation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

Expected: no commit is needed if Tasks 2 and 3 were implemented correctly.

---

## Self-Review

- Spec coverage: The plan covers local validation, no silent filtering/fallbacks, clear 400 errors, valid-path preservation, and tests/build verification.
- Placeholder scan: No TBD/TODO placeholders remain; all code steps include concrete snippets and commands.
- Type consistency: `ResponsesTranslationError`, `status`, `code`, and `requireNonEmptyName()` are named consistently across translator, handlers, and tests.
