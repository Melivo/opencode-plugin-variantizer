import { describe, expect, test } from "bun:test";

import { parseRouterConfig } from "../../src/config.ts";
import {
  getFallbackOptions,
  getVariantOptions,
  resolveVariantCatalog,
} from "../../src/open-code-variant-adapter.ts";

describe("OpenCode variant adapter", () => {
  test("accepts only active reasoning variants and includes verified explicit variants without overriding runtime options", () => {
    const config = parseRouterConfig({
      fallbackVariant: "low",
      variantsByModel: {
        "openai/gpt-5": {
          low: { reasoning: true, options: { reasoningEffort: "configured-low" } },
          custom: { reasoning: true, options: { reasoningEffort: "custom" } },
          disabled: { reasoning: true, disabled: true, options: { reasoningEffort: "high" } },
          unverified: { reasoning: false, options: { reasoningEffort: "medium" } },
        },
      },
    });
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: true },
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
          disabledRuntime: { disabled: true, reasoningEffort: "medium" },
        },
      },
      configuredVariants: config.variantsByModel,
    });

    expect(catalog?.names).toEqual(["low", "high", "custom"]);
    expect(catalog?.runtimeNames).toEqual(["low", "high"]);
    expect(getVariantOptions(catalog, "low")).toEqual({ reasoningEffort: "low" });
    expect(getVariantOptions(catalog, "custom")).toEqual({ reasoningEffort: "custom" });
    expect(getVariantOptions(catalog, "disabled")).toBeUndefined();
    expect(getVariantOptions(catalog, "unverified")).toBeUndefined();
    expect(getVariantOptions(catalog, "disabledRuntime")).toBeUndefined();
  });

  test("rejects malformed runtime maps but can use a verified explicit catalog", () => {
    const config = parseRouterConfig({
      fallbackVariant: "safe",
      variantsByModel: {
        "openai/gpt-5": {
          safe: { reasoning: true, options: { reasoningEffort: "low" } },
        },
      },
    });
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: true },
        variants: { broken: "not-an-options-object" },
      },
      configuredVariants: config.variantsByModel,
    });

    expect(catalog?.source).toBe("explicit-config");
    expect(catalog?.names).toEqual(["safe"]);
    expect(catalog?.runtimeNames).toEqual([]);
  });

  test("returns no catalog for unverified reasoning models or invalid catalogs", () => {
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: false },
        variants: { high: { reasoningEffort: "high" } },
      },
      configuredVariants: {},
    });

    expect(catalog).toBeUndefined();
    expect(getVariantOptions(catalog, "high")).toBeUndefined();
  });

  test("returns only cloned validated option objects and never translates a variant name", () => {
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: true },
        variants: { arbitraryName: { nested: { effort: "verified" } } },
      },
      configuredVariants: {},
    });
    const first = getVariantOptions(catalog, "arbitraryName");
    expect(first).toEqual({ nested: { effort: "verified" } });
    expect(getVariantOptions(catalog, "xhigh")).toBeUndefined();
    if (first) first.nested = "mutated";
    expect(getVariantOptions(catalog, "arbitraryName")).toEqual({ nested: { effort: "verified" } });
  });

  test("uses a fallback only when it is valid in the current catalog", () => {
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: true },
        variants: { low: { reasoningEffort: "low" } },
      },
      configuredVariants: {},
    });

    expect(getFallbackOptions(catalog, "low")).toEqual({ reasoningEffort: "low" });
    expect(getFallbackOptions(catalog, "missing")).toBeUndefined();
  });

  test("preserves legacy catalog resolution when agent selection is explicitly disabled", () => {
    const config = parseRouterConfig({
      fallbackVariant: "low",
      agentSelection: { enabled: false },
      variantsByModel: {
        "openai/gpt-5": {
          low: { reasoning: true, options: { reasoningEffort: "low" } },
        },
      },
    });
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: true },
      },
      configuredVariants: config.variantsByModel,
    });

    expect(config.agentSelection.enabled).toBe(false);
    expect(catalog?.names).toEqual(["low"]);
    expect(getFallbackOptions(catalog, config.fallbackVariant)).toEqual({ reasoningEffort: "low" });
  });

  test("does not retain request or prompt data in adapter state", () => {
    const prompt = "PRIVATE_PROMPT_238a";
    const requestState = "PRIVATE_REQUEST_STATE_77bb";
    const catalog = resolveVariantCatalog({
      model: {
        id: "gpt-5",
        providerID: "openai",
        capabilities: { reasoning: true },
        variants: { low: { reasoningEffort: "low" } },
        prompt,
        requestState,
      },
      configuredVariants: {},
    });

    expect(JSON.stringify(catalog)).not.toMatch(/PRIVATE_PROMPT_238a|PRIVATE_REQUEST_STATE_77bb/);
  });
});
