# Reasoning Level Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-specific app config defaults for reasoning level without overriding client-provided reasoning settings.

**Architecture:** Add config typing and normalization in `src/config.ts`, then apply provider defaults at translation boundaries where the outbound upstream body shape is known. Keep helpers focused and testable: Anthropic defaults apply to Anthropic Messages bodies, Codex defaults apply to OpenAI Responses bodies.

**Tech Stack:** TypeScript, Node.js built-in test runner (`tsx --test`), `js-yaml`, Express handlers.

## Global Constraints

- Add an optional top-level `reasoning` config section with provider-specific keys `anthropic` and `codex`.
- `reasoning.anthropic` accepts `none`, `minimal`, `low`, `medium`, `high`, and `max`.
- `reasoning.codex` accepts `minimal`, `low`, `medium`, and `high`.
- Both keys are optional; omitted keys keep current behavior with no reasoning default injection.
- Reasoning config is a default, not an override. Client-provided reasoning always wins.
- Invalid configured values should not silently create upstream requests with bad reasoning settings; normalize known values and ignore invalid ones with a clear warning.
- `/v1/messages/count_tokens` is not changed because it is not a generation request.
- Preserve existing behavior for request timeouts, stats, debug logging, provider routing, and cloaking.
- Use existing scripts only: `npm test -- --test-reporter=dot` and focused `npx tsx --test ...` commands.

---

## File Structure

- Modify `src/config.ts`: add `AnthropicReasoningLevel`, `CodexReasoningLevel`, `ReasoningConfig`, default config merge, and normalization helpers.
- Modify `src/upstream/translator.ts`: export `applyThinking` or a wrapper named `applyAnthropicReasoningDefault` so handlers can apply Anthropic defaults after translation without duplicating the effort-to-budget mapping.
- Modify `src/upstream/responses-translator.ts`: add `applyCodexReasoningDefault(body, level)` for OpenAI Responses-shaped bodies.
- Modify `src/handlers/openai.ts`: apply Anthropic and Codex defaults after translation and before upstream calls.
- Modify `src/handlers/anthropic.ts`: apply Anthropic default for native Anthropic provider requests and Codex default for translated Codex `/v1/messages` requests.
- Modify `tests/unit.test.ts`: cover config normalization and Anthropic helper behavior.
- Modify `tests/responses-translator.test.ts`: cover Codex helper behavior.
- Modify `config.example.yaml`, `README.md`, and `README_CN.md`: document the new config section and default-only semantics.

---

### Task 1: Config schema and normalization

**Files:**
- Modify: `src/config.ts`
- Test: `tests/unit.test.ts`

**Interfaces:**
- Produces: `export type AnthropicReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "max"`
- Produces: `export type CodexReasoningLevel = "minimal" | "low" | "medium" | "high"`
- Produces: `export interface ReasoningConfig { anthropic?: AnthropicReasoningLevel; codex?: CodexReasoningLevel; }`
- Produces: `Config.reasoning: ReasoningConfig`
- Produces: `loadConfig()` returns normalized `reasoning`, omitting invalid provider values after logging a warning.

- [ ] **Step 1: Write failing config tests**

Add tests near existing config tests in `tests/unit.test.ts`:

```ts
test("loadConfig normalizes provider reasoning levels", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-"));
  const configPath = path.join(tmpDir, "config.yaml");
  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test",
        "reasoning:",
        "  anthropic: max",
        "  codex: high",
      ].join("\n"),
    );

    const config = loadConfig(configPath);

    assert.deepEqual(config.reasoning, { anthropic: "max", codex: "high" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig ignores invalid provider reasoning levels with warnings", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-"));
  const configPath = path.join(tmpDir, "config.yaml");
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg?: unknown) => warnings.push(String(msg));
  try {
    fs.writeFileSync(
      configPath,
      [
        "api-keys:",
        "  - sk-test",
        "reasoning:",
        "  anthropic: extreme",
        "  codex: max",
      ].join("\n"),
    );

    const config = loadConfig(configPath);

    assert.deepEqual(config.reasoning, {});
    assert.ok(warnings.some((w) => w.includes("reasoning.anthropic")));
    assert.ok(warnings.some((w) => w.includes("reasoning.codex")));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx tsx --test tests/unit.test.ts --test-name-pattern "loadConfig .*reasoning"`

Expected: FAIL because `Config` has no `reasoning` property and normalization is not implemented.

- [ ] **Step 3: Implement config types and normalization**

In `src/config.ts`, add the exported types after `StatsConfig`:

```ts
export type AnthropicReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max";

export type CodexReasoningLevel = "minimal" | "low" | "medium" | "high";

export interface ReasoningConfig {
  anthropic?: AnthropicReasoningLevel;
  codex?: CodexReasoningLevel;
}
```

Add `reasoning: ReasoningConfig;` to `Config`, add `reasoning: {},` to `DEFAULT_RAW`, merge parsed reasoning in `loadConfig`, and normalize after debug normalization:

```ts
const ANTHROPIC_REASONING_LEVELS = new Set<AnthropicReasoningLevel>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
]);

const CODEX_REASONING_LEVELS = new Set<CodexReasoningLevel>([
  "minimal",
  "low",
  "medium",
  "high",
]);

function normalizeReasoningConfig(value: unknown): ReasoningConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const reasoning: ReasoningConfig = {};

  if (raw.anthropic !== undefined) {
    if (
      typeof raw.anthropic === "string" &&
      ANTHROPIC_REASONING_LEVELS.has(raw.anthropic as AnthropicReasoningLevel)
    ) {
      reasoning.anthropic = raw.anthropic as AnthropicReasoningLevel;
    } else {
      console.warn(
        `Ignoring invalid reasoning.anthropic value: ${String(raw.anthropic)}`,
      );
    }
  }

  if (raw.codex !== undefined) {
    if (
      typeof raw.codex === "string" &&
      CODEX_REASONING_LEVELS.has(raw.codex as CodexReasoningLevel)
    ) {
      reasoning.codex = raw.codex as CodexReasoningLevel;
    } else {
      console.warn(`Ignoring invalid reasoning.codex value: ${String(raw.codex)}`);
    }
  }

  return reasoning;
}
```

In the parsed merge block include:

```ts
reasoning: { ...DEFAULT_RAW.reasoning, ...(parsed.reasoning || {}) },
```

After `raw.debug = normalizeDebugMode(raw.debug);`, add:

```ts
raw.reasoning = normalizeReasoningConfig(raw.reasoning);
```

- [ ] **Step 4: Run focused config tests**

Run: `npx tsx --test tests/unit.test.ts --test-name-pattern "loadConfig .*reasoning"`

Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --test-reporter=dot`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/unit.test.ts
git commit -m "feat: add reasoning config normalization" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Apply provider reasoning defaults

**Files:**
- Modify: `src/upstream/translator.ts`
- Modify: `src/upstream/responses-translator.ts`
- Modify: `src/handlers/openai.ts`
- Modify: `src/handlers/anthropic.ts`
- Test: `tests/unit.test.ts`
- Test: `tests/responses-translator.test.ts`

**Interfaces:**
- Consumes: `Config.reasoning`, `AnthropicReasoningLevel`, `CodexReasoningLevel` from Task 1.
- Produces: `export function applyAnthropicReasoningDefault(anthropicBody: any, effort?: AnthropicReasoningLevel): void`
- Produces: `export function applyCodexReasoningDefault(responsesBody: any, effort?: CodexReasoningLevel): void`

- [ ] **Step 1: Write failing helper tests**

In `tests/unit.test.ts`, import `applyAnthropicReasoningDefault` from `../src/upstream/translator` and add:

```ts
test("applyAnthropicReasoningDefault applies configured thinking only when absent", () => {
  const body: any = { model: "claude-sonnet-5", max_tokens: 1024 };

  applyAnthropicReasoningDefault(body, "low");

  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 1024 });
});

test("applyAnthropicReasoningDefault preserves client thinking", () => {
  const body: any = {
    model: "claude-sonnet-5",
    max_tokens: 8192,
    thinking: { type: "enabled", budget_tokens: 4096 },
  };

  applyAnthropicReasoningDefault(body, "high");

  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 4096 });
});
```

In `tests/responses-translator.test.ts`, import `applyCodexReasoningDefault` from `../src/upstream/responses-translator` and add:

```ts
test("applyCodexReasoningDefault applies configured effort only when absent", () => {
  const body: any = { model: "gpt-5.5", input: "hi" };

  applyCodexReasoningDefault(body, "medium");

  assert.deepEqual(body.reasoning, { effort: "medium" });
});

test("applyCodexReasoningDefault preserves client reasoning", () => {
  const body: any = {
    model: "gpt-5.5",
    input: "hi",
    reasoning: { effort: "high" },
  };

  applyCodexReasoningDefault(body, "low");

  assert.deepEqual(body.reasoning, { effort: "high" });
});
```

- [ ] **Step 2: Run focused helper tests and verify they fail**

Run: `npx tsx --test tests/unit.test.ts tests/responses-translator.test.ts --test-name-pattern "ReasoningDefault|reasoning default"`

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement helpers**

In `src/upstream/translator.ts`, import the type and export a wrapper around existing `applyThinking`:

```ts
import { AnthropicReasoningLevel } from "../config";
```

Add below `applyThinking`:

```ts
export function applyAnthropicReasoningDefault(
  anthropicBody: any,
  effort?: AnthropicReasoningLevel,
): void {
  if (!effort || anthropicBody.thinking !== undefined) return;
  applyThinking(anthropicBody, effort);
}
```

In `src/upstream/responses-translator.ts`, import the type and add near request translators:

```ts
import { CodexReasoningLevel } from "../config";

export function applyCodexReasoningDefault(
  responsesBody: any,
  effort?: CodexReasoningLevel,
): void {
  if (!effort || !responsesBody || typeof responsesBody !== "object") return;
  if (responsesBody.reasoning !== undefined) return;
  responsesBody.reasoning = { effort };
}
```

- [ ] **Step 4: Run focused helper tests**

Run: `npx tsx --test tests/unit.test.ts tests/responses-translator.test.ts --test-name-pattern "ReasoningDefault|reasoning default"`

Expected: PASS.

- [ ] **Step 5: Integrate helpers in handlers**

In `src/handlers/openai.ts`:

- Add `applyAnthropicReasoningDefault` to the existing translator import from `../upstream/translator`.
- Add `applyCodexReasoningDefault` to the existing import from `../upstream/responses-translator`.
- In `proxyCodexChatCompletions`, call `applyCodexReasoningDefault(responsesBody, config.reasoning.codex);` after `normalizeCodexResponsesBody(chatToResponsesRequest(body))` and before deleting unsupported fields.
- In `proxyCodexResponses`, call `applyCodexReasoningDefault(responsesBody, config.reasoning.codex);` after `normalizeCodexResponsesBody(body)` and before deleting unsupported fields.
- In the Anthropic Chat Completions path, call `applyAnthropicReasoningDefault(translatedBody, config.reasoning.anthropic);` immediately after `const translatedBody = openaiToAnthropic(body);` and before debug logging/cloaking.
- In the Anthropic Responses path, call `applyAnthropicReasoningDefault(translatedBody, config.reasoning.anthropic);` immediately after `const translatedBody = responsesToAnthropic(body);`.

In `src/handlers/anthropic.ts`:

- Import `applyAnthropicReasoningDefault` from `../upstream/translator`.
- Import `applyCodexReasoningDefault` from `../upstream/responses-translator`.
- In `proxyCodexMessages`, call `applyCodexReasoningDefault(responsesBody, config.reasoning.codex);` after translation/normalization and before deleting unsupported fields.
- In the non-Codex `/v1/messages` path, construct `const upstreamBody = { ...body };`, call `applyAnthropicReasoningDefault(upstreamBody, config.reasoning.anthropic);`, and pass `body: upstreamBody` to `provider.callMessages`. If `provider.applyCloaking` returns a body, it must receive `body: upstreamBody` in the cloaking context so defaults are preserved.

- [ ] **Step 6: Add integration tests for translated request defaults**

Add focused translator-level tests instead of network-heavy handler tests:

In `tests/unit.test.ts`:

```ts
test("Anthropic default can be applied after OpenAI chat translation", () => {
  const translated = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
  });

  applyAnthropicReasoningDefault(translated, "medium");

  assert.equal(translated.thinking.type, "enabled");
  assert.equal(translated.thinking.budget_tokens, 8192);
});

test("Anthropic default preserves OpenAI reasoning_effort after translation", () => {
  const translated = openaiToAnthropic({
    model: "sonnet",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  });

  applyAnthropicReasoningDefault(translated, "low");

  assert.equal(translated.thinking.budget_tokens, 24576);
});
```

In `tests/responses-translator.test.ts`:

```ts
test("Codex default can be applied after Chat to Responses translation", () => {
  const translated = chatToResponsesRequest({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
  });

  applyCodexReasoningDefault(translated, "low");

  assert.deepEqual(translated.reasoning, { effort: "low" });
});

test("Codex default preserves Anthropic thinking after Messages to Responses translation", () => {
  const translated = anthropicToResponsesRequest({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 24576 },
  });

  applyCodexReasoningDefault(translated, "low");

  assert.deepEqual(translated.reasoning, { effort: "high" });
});
```

- [ ] **Step 7: Run focused integration tests**

Run: `npx tsx --test tests/unit.test.ts tests/responses-translator.test.ts --test-name-pattern "default|reasoning"`

Expected: PASS.

- [ ] **Step 8: Run full test suite**

Run: `npm test -- --test-reporter=dot`

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/upstream/translator.ts src/upstream/responses-translator.ts src/handlers/openai.ts src/handlers/anthropic.ts tests/unit.test.ts tests/responses-translator.test.ts
git commit -m "feat: apply reasoning defaults by provider" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Documentation and example config

**Files:**
- Modify: `config.example.yaml`
- Modify: `README.md`
- Modify: `README_CN.md`

**Interfaces:**
- Consumes: config shape from Task 1 and behavior from Task 2.
- Produces: user-facing documentation for `reasoning.anthropic` and `reasoning.codex`.

- [ ] **Step 1: Update config example**

Add this section after `stats` and before `debug` in `config.example.yaml`:

```yaml
# Provider-specific reasoning defaults. These fill in missing client settings
# without overriding explicit reasoning_effort / reasoning / thinking fields.
# Omit a key to keep that provider's current no-default behavior.
reasoning:
  # Anthropic/Claude-bound requests: none | minimal | low | medium | high | max
  # anthropic: "medium"
  # Codex/OpenAI Responses-bound requests: minimal | low | medium | high
  # codex: "high"
```

- [ ] **Step 2: Update English README config block**

In `README.md`, add the same `reasoning` block to the YAML config example after `timeouts` or `stats`, and add a short paragraph after the example:

```md
`reasoning` sets provider-specific defaults only when the client did not already request reasoning. Anthropic-bound requests use `reasoning.anthropic` (`none`, `minimal`, `low`, `medium`, `high`, `max`); Codex-bound requests use `reasoning.codex` (`minimal`, `low`, `medium`, `high`).
```

- [ ] **Step 3: Update Chinese README config block**

In `README_CN.md`, add the matching YAML block and paragraph:

```md
`reasoning` 只在客户端没有显式传入 reasoning 配置时作为 provider 默认值生效。Anthropic/Claude 路径使用 `reasoning.anthropic`（`none`、`minimal`、`low`、`medium`、`high`、`max`）；Codex 路径使用 `reasoning.codex`（`minimal`、`low`、`medium`、`high`）。
```

- [ ] **Step 4: Run full test suite**

Run: `npm test -- --test-reporter=dot`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add config.example.yaml README.md README_CN.md
git commit -m "docs: document reasoning config defaults" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```
