# Reasoning Level App Config Design

## Goal

Add app-level reasoning defaults that can be configured separately for Anthropic/Claude-bound requests and Codex-bound requests. The defaults should fill in missing reasoning settings without overriding explicit client intent.

## Configuration

Add an optional top-level `reasoning` section:

```yaml
reasoning:
  anthropic: "medium"
  codex: "high"
```

Both keys are optional. If a key is omitted, requests for that provider keep current behavior and no reasoning default is injected.

`reasoning.anthropic` accepts the levels already supported by the Anthropic translation helper: `none`, `minimal`, `low`, `medium`, `high`, and `max`.

`reasoning.codex` accepts OpenAI Responses reasoning effort levels supported by Codex: `minimal`, `low`, `medium`, and `high`.

Invalid configured values should not silently create upstream requests with bad reasoning settings. The loader should normalize known values and ignore invalid ones with a clear warning, matching the existing config style of safe defaults.

## Behavior

Reasoning config is a default, not an override. Client-provided reasoning always wins.

For Anthropic-bound requests:

- `/v1/messages` with native `thinking` keeps the request's `thinking` unchanged.
- `/v1/chat/completions` with `reasoning_effort` keeps the request's value before OpenAI-to-Anthropic translation.
- `/v1/responses` with `reasoning` keeps the request's value before Responses-to-Anthropic translation.
- If no client reasoning is present, `reasoning.anthropic` is applied as Anthropic `thinking` using the existing effort-to-budget mapping.

For Codex-bound requests:

- `/v1/chat/completions` with `reasoning_effort` keeps the request's value after translation to Responses `reasoning.effort`.
- `/v1/responses` with `reasoning` keeps the request's value.
- `/v1/messages` with native Anthropic `thinking` keeps the request's value after translation to Responses `reasoning.effort`.
- If the translated upstream Responses body has no `reasoning`, `reasoning.codex` is injected as `reasoning: { effort: <level> }`.

`/v1/messages/count_tokens` is not changed because it is not a generation request.

## Architecture

Extend `Config` and raw YAML loading in `src/config.ts` with a `ReasoningConfig` type and default `{}`. Normalize configured levels during load so downstream code receives either a valid level or `undefined`.

Add focused helper functions near the translation boundary rather than scattering conditionals through handlers:

- Anthropic helper: apply the Anthropic default to an Anthropic Messages body only if `thinking` is absent.
- Codex helper: apply the Codex default to a Responses body only if `reasoning` is absent.

Handlers should call these helpers after translating into the upstream-native body and before cloaking/sanitization/proxying. This keeps provider defaults close to the outbound body shape and avoids changing public request parsing.

## Documentation

Update `config.example.yaml` with the new section and short comments. Update README configuration docs so users understand that provider-specific defaults preserve explicit client reasoning.

## Testing

Add tests for:

- Config loading/normalization of valid and invalid provider reasoning levels.
- Anthropic default injection when no reasoning is present.
- Anthropic client reasoning preservation.
- Codex default injection after Chat/Messages translation and direct Responses requests.
- Codex client reasoning preservation.

Existing translation tests should continue to pass unchanged except where new helper behavior is intentionally asserted.
