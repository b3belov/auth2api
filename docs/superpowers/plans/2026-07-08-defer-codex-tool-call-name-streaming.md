# Defer Codex Tool Call Name Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent auth2api from streaming nameless Codex tool calls that OpenAI-compatible clients later echo back as invalid `messages[].tool_calls[].function.name`.

**Architecture:** Keep the existing ingress validation intact. Fix the upstream-to-client streaming translators so a `response.output_item.added` function-call event without a non-empty `item.name` is buffered until `response.output_item.done` supplies a valid name; if no valid name arrives, emit a stream error instead of a malformed tool-call delta. Apply the same rule to OpenAI Chat Completions SSE and Anthropic Messages SSE so both public streaming formats stay valid.

**Tech Stack:** TypeScript, Node `node:test`, OpenAI Chat Completions SSE, Anthropic Messages SSE, Codex Responses SSE.

## Global Constraints

- Do not remove or loosen existing local ingress validation for empty tool-call names.
- Do not invent a synthetic function name; a tool call without a real non-empty name is invalid.
- Preserve current behavior for normal Codex streams where `response.output_item.added.item.name` is already non-empty.
- Preserve existing `item.id` to `call_id` argument-delta mapping behavior for real Codex `fc_...` item ids.
- Keep changes scoped to `src/upstream/responses-translator.ts` and `tests/responses-translator.test.ts`.
- Use repo-local commands: `./node_modules/.bin/tsx --test ...` and `npm run build`.

---

## File Structure

- Modify: `src/upstream/responses-translator.ts`
  - Owns all Codex Responses SSE to public stream-format conversion.
  - Add per-stream pending tool-call buffers for Chat and Anthropic output.
  - Add local helpers for non-empty tool names and stream error payloads.
- Modify: `tests/responses-translator.test.ts`
  - Add focused regression tests that reproduce the live container failure source: an upstream `function_call` starts without `name`, arguments arrive, and the completed item supplies the name later.
  - Add negative tests for the terminal case where no non-empty name ever arrives.

---

### Task 1: Add Failing Chat SSE Regression Tests

**Files:**
- Modify: `tests/responses-translator.test.ts`

**Interfaces:**
- Consumes: `responsesSSEToChat(event: string, data: any, state: ResponsesToChatState): string[]`
- Consumes: `makeResponsesToChatState(model: string): ResponsesToChatState`
- Produces: failing tests that require Chat SSE to avoid empty or missing `function.name` deltas.

- [ ] **Step 1: Add regression tests after the existing `responsesSSEToChat: tool_call arg deltas resolve when item_id differs from call_id (real codex shape)` test**

```ts
test("responsesSSEToChat: defers nameless tool_call until output_item.done supplies name", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const chunks = [
    ...responsesSSEToChat(
      "response.output_item.added",
      {
        item: {
          id: "fc_late",
          call_id: "call_late",
          type: "function_call",
        },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "fc_late", delta: '{"city":"' },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "fc_late", delta: 'Kyiv"}' },
      state,
    ),
    ...responsesSSEToChat(
      "response.output_item.done",
      {
        item: {
          id: "fc_late",
          call_id: "call_late",
          type: "function_call",
          name: "get_weather",
          arguments: '{"city":"Kyiv"}',
        },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = chunks.join("");

  assert.doesNotMatch(all, /"name":""/);
  assert.match(all, /"id":"call_late"/);
  assert.match(all, /"name":"get_weather"/);
  assert.match(all, /"arguments":"\{\\"city\\":\\"Kyiv\\"\}"/);
  assert.match(all, /"finish_reason":"tool_calls"/);
});

test("responsesSSEToChat: emits stream error when completed function_call has no name", () => {
  const state = makeResponsesToChatState("gpt-5.5-medium");
  const chunks = [
    ...responsesSSEToChat(
      "response.output_item.added",
      {
        item: {
          id: "fc_bad",
          call_id: "call_bad",
          type: "function_call",
        },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.function_call_arguments.delta",
      { item_id: "fc_bad", delta: "{}" },
      state,
    ),
    ...responsesSSEToChat(
      "response.output_item.done",
      {
        item: {
          id: "fc_bad",
          call_id: "call_bad",
          type: "function_call",
          name: "",
          arguments: "{}",
        },
      },
      state,
    ),
    ...responsesSSEToChat(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = chunks.join("");

  assert.doesNotMatch(all, /"tool_calls"/);
  assert.match(all, /"code":"invalid_tool_call_name"/);
  assert.match(all, /function_call name must be a non-empty string/);
  assert.match(all, /data: \[DONE\]/);
});
```

- [ ] **Step 2: Run the Chat-focused tests and verify they fail**

Run:

```bash
./node_modules/.bin/tsx --test tests/responses-translator.test.ts --test-name-pattern "responsesSSEToChat: defers nameless|responsesSSEToChat: emits stream error"
```

Expected: FAIL because current `responsesSSEToChat()` emits `function: { name: item.name, arguments: "" }` immediately from `response.output_item.added`, so the first test contains an omitted or empty name and the second test does not emit `invalid_tool_call_name`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/responses-translator.test.ts
git commit -m "test: cover deferred codex chat tool names"
```

---

### Task 2: Buffer Nameless Chat Tool Calls Until a Valid Name Arrives

**Files:**
- Modify: `src/upstream/responses-translator.ts`

**Interfaces:**
- Consumes: `ResponsesToChatState`
- Produces: `pendingToolCalls: Map<string, PendingChatToolCall>`
- Produces: `terminalErrorSent: boolean`
- Produces: `validToolName(value: unknown): string | null`
- Produces: `chatStreamToolNameError(): string[]`

- [ ] **Step 1: Add helper types and state fields near `ResponsesToChatState`**

```ts
interface PendingChatToolCall {
  index: number;
  callId: string;
  argsBuf: string;
  started: boolean;
}

function validToolName(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function chatStreamToolNameError(state: ResponsesToChatState): string[] {
  if (state.terminalErrorSent) return [];
  state.terminalErrorSent = true;
  return [
    `data: ${JSON.stringify({
      error: {
        message: "function_call name must be a non-empty string",
        type: "invalid_request_error",
        code: "invalid_tool_call_name",
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}
```

Update the `ResponsesToChatState` interface:

```ts
export interface ResponsesToChatState {
  id: string;
  created: number;
  fingerprint: string;
  model: string;
  rolePrimerSent: boolean;
  toolCallIndices: Map<string, number>;
  itemIdToCallId: Map<string, string>;
  pendingToolCalls: Map<string, PendingChatToolCall>;
  nextToolIndex: number;
  finishReason: string;
  terminalErrorSent: boolean;
}
```

Update `makeResponsesToChatState()`:

```ts
export function makeResponsesToChatState(model: string): ResponsesToChatState {
  return {
    id: `chatcmpl-${compactUuid().slice(0, 24)}`,
    created: Math.floor(Date.now() / 1000),
    fingerprint: `fp_${compactUuid().slice(0, 12)}`,
    model,
    rolePrimerSent: false,
    toolCallIndices: new Map(),
    itemIdToCallId: new Map(),
    pendingToolCalls: new Map(),
    nextToolIndex: 0,
    finishReason: "stop",
    terminalErrorSent: false,
  };
}
```

- [ ] **Step 2: Add Chat helper functions below `ensureRolePrimer()`**

```ts
function registerChatToolCall(
  state: ResponsesToChatState,
  item: any,
): PendingChatToolCall | null {
  if (!item?.call_id) return null;
  const existingIndex = state.toolCallIndices.get(item.call_id);
  if (existingIndex !== undefined) {
    return (
      state.pendingToolCalls.get(item.call_id) || {
        index: existingIndex,
        callId: item.call_id,
        argsBuf: "",
        started: true,
      }
    );
  }

  const tool: PendingChatToolCall = {
    index: state.nextToolIndex++,
    callId: item.call_id,
    argsBuf: "",
    started: false,
  };
  state.toolCallIndices.set(item.call_id, tool.index);
  state.pendingToolCalls.set(item.call_id, tool);
  if (item.id && item.id !== item.call_id) {
    state.itemIdToCallId.set(item.id, item.call_id);
  }
  state.finishReason = "tool_calls";
  return tool;
}

function resolveChatCallId(state: ResponsesToChatState, data: any): string | undefined {
  const ref = data?.item_id || data?.call_id;
  if (!ref) return undefined;
  return state.toolCallIndices.has(ref) ? ref : state.itemIdToCallId.get(ref);
}

function startChatToolCall(
  state: ResponsesToChatState,
  tool: PendingChatToolCall,
  name: string,
  args: string,
): string[] {
  tool.started = true;
  state.pendingToolCalls.delete(tool.callId);
  const out = [
    ...ensureRolePrimer(state),
    buildChatChunk(state, {
      tool_calls: [
        {
          index: tool.index,
          id: tool.callId,
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    }),
  ];
  if (args) {
    out.push(
      buildChatChunk(state, {
        tool_calls: [
          {
            index: tool.index,
            function: { arguments: args },
          },
        ],
      }),
    );
  }
  return out;
}
```

- [ ] **Step 3: Update the Chat `response.output_item.added` case**

Replace the current `response.output_item.added` case with:

```ts
case "response.output_item.added": {
  const item = data?.item;
  if (item?.type === "function_call" && item.call_id) {
    if (state.toolCallIndices.has(item.call_id)) return [];
    const tool = registerChatToolCall(state, item);
    if (!tool) return [];
    const name = validToolName(item.name);
    if (!name) return [];
    return startChatToolCall(state, tool, name, "");
  }
  return [];
}
```

- [ ] **Step 4: Update the Chat `response.function_call_arguments.delta` case**

Replace the current argument-delta case with:

```ts
case "response.function_call_arguments.delta": {
  const callId = resolveChatCallId(state, data);
  if (!callId || typeof data?.delta !== "string") return [];
  const idx = state.toolCallIndices.get(callId);
  if (idx === undefined) return [];

  const pending = state.pendingToolCalls.get(callId);
  if (pending && !pending.started) {
    pending.argsBuf += data.delta;
    return [];
  }

  return [
    buildChatChunk(state, {
      tool_calls: [
        {
          index: idx,
          function: { arguments: data.delta },
        },
      ],
    }),
  ];
}
```

- [ ] **Step 5: Add a Chat `response.output_item.done` case before `response.completed`**

```ts
case "response.output_item.done": {
  const item = data?.item;
  if (item?.type !== "function_call" || !item.call_id) return [];
  const tool = state.pendingToolCalls.get(item.call_id);
  if (!tool || tool.started) return [];

  const name = validToolName(item.name);
  if (!name) return chatStreamToolNameError(state);

  const args =
    typeof item.arguments === "string" ? item.arguments : tool.argsBuf;
  return startChatToolCall(state, tool, name, args);
}
```

- [ ] **Step 6: Guard Chat terminal cases after stream error**

At the start of the `response.completed` case, add:

```ts
if (state.terminalErrorSent) return [];
if ([...state.pendingToolCalls.values()].some((tool) => !tool.started)) {
  return chatStreamToolNameError(state);
}
```

At the start of the `response.failed` case, add:

```ts
if (state.terminalErrorSent) return [];
```

- [ ] **Step 7: Run the Chat regression tests and existing Chat stream tests**

Run:

```bash
./node_modules/.bin/tsx --test tests/responses-translator.test.ts --test-name-pattern "responsesSSEToChat"
```

Expected: PASS.

- [ ] **Step 8: Commit the Chat implementation**

```bash
git add src/upstream/responses-translator.ts tests/responses-translator.test.ts
git commit -m "fix: defer codex chat tool calls until names arrive"
```

---

### Task 3: Add Anthropic SSE Parity Tests

**Files:**
- Modify: `tests/responses-translator.test.ts`

**Interfaces:**
- Consumes: `responsesSSEToAnthropic(event: string, data: any, state: ResponsesToAnthropicState): string[]`
- Consumes: `makeResponsesToAnthropicState(model: string): ResponsesToAnthropicState`
- Produces: failing tests that require Anthropic SSE to avoid empty `tool_use.name`.

- [ ] **Step 1: Add tests after the existing `responsesSSEToAnthropic: tool_use input_json_delta resolves when item_id differs from call_id (real codex shape)` test**

```ts
test("responsesSSEToAnthropic: defers nameless tool_use until output_item.done supplies name", () => {
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.output_item.added",
      {
        item: {
          id: "fc_late",
          call_id: "call_late",
          type: "function_call",
        },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.function_call_arguments.delta",
      { item_id: "fc_late", delta: '{"city":"' },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.function_call_arguments.delta",
      { item_id: "fc_late", delta: 'Kyiv"}' },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.output_item.done",
      {
        item: {
          id: "fc_late",
          call_id: "call_late",
          type: "function_call",
          name: "get_weather",
          arguments: '{"city":"Kyiv"}',
        },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = out.join("");

  assert.doesNotMatch(all, /"name":""/);
  assert.match(
    all,
    /"content_block":\{"type":"tool_use","id":"call_late","name":"get_weather"/,
  );
  assert.match(
    all,
    /"type":"input_json_delta","partial_json":"\{\\"city\\":\\"Kyiv\\"\}"/,
  );
  assert.match(all, /"stop_reason":"tool_use"/);
});

test("responsesSSEToAnthropic: emits error when completed tool_use has no name", () => {
  const state = makeResponsesToAnthropicState("claude-sonnet-4-5");
  const out = [
    ...responsesSSEToAnthropic("response.created", {}, state),
    ...responsesSSEToAnthropic(
      "response.output_item.added",
      {
        item: {
          id: "fc_bad",
          call_id: "call_bad",
          type: "function_call",
        },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.function_call_arguments.delta",
      { item_id: "fc_bad", delta: "{}" },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.output_item.done",
      {
        item: {
          id: "fc_bad",
          call_id: "call_bad",
          type: "function_call",
          name: " ",
          arguments: "{}",
        },
      },
      state,
    ),
    ...responsesSSEToAnthropic(
      "response.completed",
      { response: { status: "completed" } },
      state,
    ),
  ];
  const all = out.join("");

  assert.doesNotMatch(all, /"type":"tool_use"/);
  assert.match(all, /"type":"error"/);
  assert.match(all, /"type":"invalid_request_error"/);
  assert.match(all, /function_call name must be a non-empty string/);
});
```

- [ ] **Step 2: Run the Anthropic-focused tests and verify they fail**

Run:

```bash
./node_modules/.bin/tsx --test tests/responses-translator.test.ts --test-name-pattern "responsesSSEToAnthropic: defers nameless|responsesSSEToAnthropic: emits error"
```

Expected: FAIL because current `responsesSSEToAnthropic()` emits `content_block.name: item.name` immediately from `response.output_item.added`.

- [ ] **Step 3: Commit the failing Anthropic tests**

```bash
git add tests/responses-translator.test.ts
git commit -m "test: cover deferred codex anthropic tool names"
```

---

### Task 4: Buffer Nameless Anthropic Tool Uses Until a Valid Name Arrives

**Files:**
- Modify: `src/upstream/responses-translator.ts`

**Interfaces:**
- Consumes: `ResponsesToAnthropicState`
- Produces: `pendingToolBlocks: Map<string, PendingAnthropicToolBlock>`
- Produces: `terminalErrorSent: boolean`
- Reuses: `validToolName(value: unknown): string | null`

- [ ] **Step 1: Add helper type and state fields near `ResponsesToAnthropicState`**

```ts
interface PendingAnthropicToolBlock {
  index: number;
  callId: string;
  argsBuf: string;
  started: boolean;
}
```

Update the `ResponsesToAnthropicState` interface:

```ts
export interface ResponsesToAnthropicState {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingOpen: boolean;
  thinkingIndex: number;
  textOpen: boolean;
  textIndex: number;
  toolBlocks: Map<string, { index: number; name: string; argsBuf: string }>;
  pendingToolBlocks: Map<string, PendingAnthropicToolBlock>;
  itemIdToCallId: Map<string, string>;
  nextBlockIndex: number;
  messageStartSent: boolean;
  stopReason: string;
  terminalErrorSent: boolean;
}
```

Update `makeResponsesToAnthropicState()`:

```ts
export function makeResponsesToAnthropicState(
  model: string,
): ResponsesToAnthropicState {
  return {
    messageId: `msg_${compactUuid()}`,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    thinkingOpen: false,
    thinkingIndex: -1,
    textOpen: false,
    textIndex: -1,
    toolBlocks: new Map(),
    pendingToolBlocks: new Map(),
    itemIdToCallId: new Map(),
    nextBlockIndex: 0,
    messageStartSent: false,
    stopReason: "end_turn",
    terminalErrorSent: false,
  };
}
```

- [ ] **Step 2: Add Anthropic helper functions below `ensureMessageStart()`**

```ts
function anthropicStreamToolNameError(
  state: ResponsesToAnthropicState,
): string[] {
  if (state.terminalErrorSent) return [];
  state.terminalErrorSent = true;
  const out = ensureMessageStart(state);
  out.push(...closeOpenBlocks(state));
  out.push(
    sseEvent("error", {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "function_call name must be a non-empty string",
      },
    }),
  );
  return out;
}

function resolveAnthropicCallId(
  state: ResponsesToAnthropicState,
  data: any,
): string | undefined {
  const ref = data?.item_id || data?.call_id;
  if (!ref) return undefined;
  return state.toolBlocks.has(ref) || state.pendingToolBlocks.has(ref)
    ? ref
    : state.itemIdToCallId.get(ref);
}

function registerAnthropicToolBlock(
  state: ResponsesToAnthropicState,
  item: any,
): PendingAnthropicToolBlock | null {
  if (!item?.call_id) return null;
  const existing = state.pendingToolBlocks.get(item.call_id);
  if (existing) return existing;
  const started = state.toolBlocks.get(item.call_id);
  if (started) {
    return {
      index: started.index,
      callId: item.call_id,
      argsBuf: started.argsBuf,
      started: true,
    };
  }

  const pending: PendingAnthropicToolBlock = {
    index: state.nextBlockIndex++,
    callId: item.call_id,
    argsBuf: "",
    started: false,
  };
  state.pendingToolBlocks.set(item.call_id, pending);
  if (item.id && item.id !== item.call_id) {
    state.itemIdToCallId.set(item.id, item.call_id);
  }
  state.stopReason = "tool_use";
  return pending;
}

function startAnthropicToolBlock(
  state: ResponsesToAnthropicState,
  tool: PendingAnthropicToolBlock,
  name: string,
  args: string,
): string[] {
  const out = ensureMessageStart(state);
  if (state.thinkingOpen) {
    out.push(
      sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.thinkingIndex,
      }),
    );
    state.thinkingOpen = false;
  }
  if (state.textOpen) {
    out.push(
      sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.textIndex,
      }),
    );
    state.textOpen = false;
  }

  tool.started = true;
  state.pendingToolBlocks.delete(tool.callId);
  state.toolBlocks.set(tool.callId, {
    index: tool.index,
    name,
    argsBuf: args,
  });
  out.push(
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: tool.index,
      content_block: {
        type: "tool_use",
        id: tool.callId,
        name,
        input: {},
      },
    }),
  );
  if (args) {
    out.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: tool.index,
        delta: { type: "input_json_delta", partial_json: args },
      }),
    );
  }
  return out;
}
```

- [ ] **Step 3: Update `closeOpenBlocks()` to ignore pending blocks**

Leave existing `toolBlocks` iteration intact. Do not close `pendingToolBlocks`; pending blocks were never opened.

At the end of `closeOpenBlocks()`, add:

```ts
state.pendingToolBlocks.clear();
```

- [ ] **Step 4: Update the Anthropic `response.output_item.added` case**

Replace the current `response.output_item.added` case with:

```ts
case "response.output_item.added": {
  const item = data?.item;
  if (item?.type === "function_call" && item.call_id) {
    if (state.toolBlocks.has(item.call_id)) return [];
    const tool = registerAnthropicToolBlock(state, item);
    if (!tool) return [];
    const name = validToolName(item.name);
    if (!name) return [];
    return startAnthropicToolBlock(state, tool, name, "");
  }
  return [];
}
```

- [ ] **Step 5: Update the Anthropic `response.function_call_arguments.delta` case**

Replace the current argument-delta case with:

```ts
case "response.function_call_arguments.delta": {
  const callId = resolveAnthropicCallId(state, data);
  if (!callId || typeof data?.delta !== "string") return [];

  const pending = state.pendingToolBlocks.get(callId);
  if (pending && !pending.started) {
    pending.argsBuf += data.delta;
    return [];
  }

  const tool = state.toolBlocks.get(callId);
  if (!tool) return [];
  tool.argsBuf += data.delta;
  return [
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: tool.index,
      delta: { type: "input_json_delta", partial_json: data.delta },
    }),
  ];
}
```

- [ ] **Step 6: Add an Anthropic `response.output_item.done` case before `response.completed`**

```ts
case "response.output_item.done": {
  const item = data?.item;
  if (item?.type !== "function_call" || !item.call_id) return [];
  const tool = state.pendingToolBlocks.get(item.call_id);
  if (!tool || tool.started) return [];

  const name = validToolName(item.name);
  if (!name) return anthropicStreamToolNameError(state);

  const args =
    typeof item.arguments === "string" ? item.arguments : tool.argsBuf;
  return startAnthropicToolBlock(state, tool, name, args);
}
```

- [ ] **Step 7: Guard Anthropic terminal cases after stream error**

At the start of the `response.completed` case, add:

```ts
if (state.terminalErrorSent) return [];
if ([...state.pendingToolBlocks.values()].some((tool) => !tool.started)) {
  return anthropicStreamToolNameError(state);
}
```

At the start of the `response.failed` case, add:

```ts
if (state.terminalErrorSent) return [];
```

- [ ] **Step 8: Run the Anthropic regression tests and existing Anthropic stream tests**

Run:

```bash
./node_modules/.bin/tsx --test tests/responses-translator.test.ts --test-name-pattern "responsesSSEToAnthropic"
```

Expected: PASS.

- [ ] **Step 9: Commit the Anthropic implementation**

```bash
git add src/upstream/responses-translator.ts tests/responses-translator.test.ts
git commit -m "fix: defer codex anthropic tool uses until names arrive"
```

---

### Task 5: Final Verification And Container Probe

**Files:**
- No code changes.

**Interfaces:**
- Consumes: completed Tasks 1 through 4.
- Produces: verified local build, focused tests, and live-container reproduction notes.

- [ ] **Step 1: Run the full translator regression suite**

Run:

```bash
./node_modules/.bin/tsx --test tests/responses-translator.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Rebuild and restart the Docker service**

Run:

```bash
docker compose build auth2api
docker compose up -d auth2api
```

Expected: the `auth2api-auth2api-1` service is recreated from the updated `dist/` artifact and remains healthy.

- [ ] **Step 4: Confirm the running container contains the new buffering code**

Run:

```bash
docker exec auth2api-auth2api-1 node -e "const fs=require('fs'); const s=fs.readFileSync('/app/dist/upstream/responses-translator.js','utf8'); console.log(s.includes('pendingToolCalls'), s.includes('pendingToolBlocks'), s.includes('invalid_tool_call_name'));"
```

Expected output:

```text
true true true
```

- [ ] **Step 5: Confirm malformed inbound history is still rejected locally**

Run:

```bash
docker exec auth2api-auth2api-1 node -e "const fs=require('fs'); const yaml=require('js-yaml'); const cfg=yaml.load(fs.readFileSync('/config/config.yaml','utf8')); const key=(cfg['api-keys']&&cfg['api-keys'][0])||(cfg.apiKeys&&cfg.apiKeys[0]); const body={model:'gpt-5.5',messages:[{role:'user',content:'x'},{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'',arguments:'{}'}}]}],stream:false}; fetch('http://127.0.0.1:8317/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)}).then(async r=>{console.log(r.status); console.log(await r.text());});"
```

Expected output contains:

```text
400
invalid_tool_call_name
```

- [ ] **Step 6: Commit final verification notes if any docs were changed**

If no docs were changed during execution, do not create an empty commit.

If docs were updated, run:

```bash
git add docs/superpowers/plans/2026-07-08-defer-codex-tool-call-name-streaming.md
git commit -m "docs: plan codex tool name streaming fix"
```

---

## Self-Review

**Spec coverage:** The plan covers the live failure sequence: a successful streaming `POST /v1/chat/completions` is followed by a next-turn `400` because the client echoed a nameless tool call. Task 1 reproduces the Chat path. Task 2 fixes Chat streaming. Task 3 and Task 4 apply the same validity rule to Anthropic streaming. Task 5 verifies tests, build, and the running container.

**Placeholder scan:** The plan contains concrete paths, functions, tests, commands, and expected outputs. It does not rely on unspecified implementation steps.

**Type consistency:** The planned state fields are consistent across tests and implementation: Chat uses `pendingToolCalls`, Anthropic uses `pendingToolBlocks`, and both use the shared `validToolName()`.
