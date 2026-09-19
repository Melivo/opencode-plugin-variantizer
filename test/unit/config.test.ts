import { describe, expect, test } from "bun:test";

import {
  ConfigurationError,
  parseRouterConfig,
  readTypeSafeApiKey,
} from "../../src/config.ts";

const explicitCatalog = {
  "openai/gpt-5": {
    low: {
      reasoning: true,
      options: { reasoningEffort: "low" },
    },
    disabled: {
      reasoning: true,
      disabled: true,
      options: { reasoningEffort: "high" },
    },
  },
};

describe("router configuration", () => {
  test("applies bounded defaults and reads the API key only from the environment", () => {
    const config = parseRouterConfig({
      fallbackVariant: "low",
      variantsByModel: explicitCatalog,
    });

    expect(config).toEqual({
      enabled: true,
      fallbackVariant: "low",
      timeoutMs: 1_500,
      manualVariantPolicy: "typesafe-first",
      agentSelection: {
        enabled: true,
        manualAgentPolicy: "typesafe-first",
        agents: {
          luna: "openai/gpt-5.6-luna",
          terra: "openai/gpt-5.6-terra",
          sol: "openai/gpt-5.6-sol",
        },
        ring: ["luna", "terra", "sol"],
        tuiSync: { enabled: true },
      },
      context: {
        mode: "recent-messages",
        maxMessages: 6,
        maxChars: 12_000,
      },
      variantsByModel: explicitCatalog,
      variantDescriptions: {},
      notify: "fallback",
      logLevel: "warn",
    });
    expect(readTypeSafeApiKey({ TYPESAFE_API_KEY: "env-only-secret" })).toBe("env-only-secret");
    expect(readTypeSafeApiKey({ TYPESAFE_API_KEY: "   " })).toBeUndefined();
  });

  test("rejects unknown fields, embedded credentials, nested extras, and invalid bounds", () => {
    const invalidInputs = [
      { fallbackVariant: "low", apiKey: "must-not-be-configurable" },
      { fallbackVariant: "low", unknown: true },
      { fallbackVariant: "low", context: { mode: "prompt-only", maxMessages: 1, maxChars: 10, extra: true } },
      { fallbackVariant: "low", confidenceThreshold: 0.75 },
      { fallbackVariant: "low", timeoutMs: 0 },
      { fallbackVariant: "low", context: { mode: "recent-messages", maxMessages: 0, maxChars: 100 } },
    ];

    for (const input of invalidInputs) {
      expect(() => parseRouterConfig(input)).toThrow(ConfigurationError);
    }
  });

  test("strictly validates enabled agent selection but preserves explicit disabled migration mode", () => {
    const invalidEnabled = [
      { agents: { luna: "openai/gpt-5.6-sol", terra: "openai/gpt-5.6-terra", sol: "openai/gpt-5.6-sol" } },
      { ring: ["luna", "sol", "terra"] },
      { manualAgentPolicy: "unsupported" },
      { tuiSync: { enabled: true, extra: true } },
      { extra: true },
    ];
    for (const agentSelection of invalidEnabled) {
      expect(() => parseRouterConfig({ fallbackVariant: "low", agentSelection })).toThrow(ConfigurationError);
    }

    const disabled = parseRouterConfig({
      fallbackVariant: "low",
      agentSelection: {
        enabled: false,
        agents: { luna: "legacy/luna", terra: "legacy/terra", sol: "legacy/sol" },
        ring: ["sol", "terra", "luna"],
        tuiSync: { enabled: false },
      },
    });
    expect(disabled.agentSelection.enabled).toBe(false);
    expect(disabled.agentSelection.agents.luna).toBe("legacy/luna");
    expect(disabled.agentSelection.ring).toEqual(["sol", "terra", "luna"]);
  });

  test("requires a configured fallback to be enabled and reasoning-verified for every configured model", () => {
    expect(() => parseRouterConfig({
      fallbackVariant: "missing",
      variantsByModel: explicitCatalog,
    })).toThrow(ConfigurationError);
    expect(() => parseRouterConfig({
      fallbackVariant: "disabled",
      variantsByModel: explicitCatalog,
    })).toThrow(ConfigurationError);
    expect(() => parseRouterConfig({
      fallbackVariant: "plain",
      variantsByModel: {
        "openai/gpt-5": {
          plain: { reasoning: false, options: { reasoningEffort: "low" } },
        },
      },
    })).toThrow(ConfigurationError);
  });

  test("does not retain a process credential in parsed policy state", () => {
    const secret = "PRIVATE_API_KEY_91f0";
    const config = parseRouterConfig({ fallbackVariant: "low" });

    expect(JSON.stringify(config)).not.toContain(secret);
    expect(Object.hasOwn(config, "apiKey")).toBe(false);
  });
});
