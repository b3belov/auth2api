import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
  /**
   * Codex (ChatGPT) provider — protocol-required headers, NOT identity faking.
   * Strings live here so upstream flag-name drift can ship as a YAML edit.
   */
  codex?: {
    "user-agent"?: string;
    originator?: string;
    "cli-version"?: string;
    /** Optional: only set if upstream begins requiring an OpenAI-Beta header. */
    "openai-beta"?: string;
  };
  /**
   * Cursor provider — reverse-engineered, unstable headers for personal local
   * experiments only. Cursor version-gates requests, so keep these overrideable.
   */
  cursor?: {
    "client-version"?: string;
    "client-type"?: string;
    "agent-base-url"?: string;
    "api-base-url"?: string;
    "config-version"?: string;
    timezone?: string;
    "ghost-mode"?: string;
  };
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export interface StatsConfig {
  /** Default true. Set false to disable per-request stats recording entirely. */
  enabled: boolean;
}

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

export type DebugMode = "off" | "errors" | "verbose";

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": Set<string>;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  stats: StatsConfig;
  reasoning: ReasoningConfig;
  debug: DebugMode;
}

// Raw config shape from YAML (api-keys is an array, not a Set)
interface RawConfig extends Omit<Config, "api-keys"> {
  "api-keys": string[];
}

const DEFAULT_RAW: RawConfig = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
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
  stats: {
    enabled: true,
  },
  reasoning: {},
  debug: "off",
};

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

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

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

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: RawConfig;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<RawConfig>;
    raw = {
      ...DEFAULT_RAW,
      ...parsed,
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
      stats: { ...DEFAULT_RAW.stats, ...(parsed.stats || {}) },
      reasoning: { ...DEFAULT_RAW.reasoning, ...(parsed.reasoning || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);
  raw.reasoning = normalizeReasoningConfig(raw.reasoning);

  // Auto-generate API key if none configured
  if (!raw["api-keys"] || raw["api-keys"].length === 0) {
    const key = generateApiKey();
    raw["api-keys"] = [key];
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return { ...raw, "api-keys": new Set(raw["api-keys"]) };
}
