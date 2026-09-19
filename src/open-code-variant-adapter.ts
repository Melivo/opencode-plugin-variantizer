import type { Hooks } from "@opencode-ai/plugin";

import type { VariantsByModel } from "./config.ts";
import { cloneJsonObject, cloneSafeOptions, type JsonValue } from "./safe-json.ts";

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type OpenCodeModel = ChatParamsInput["model"];

export type RuntimeVariantModel = Pick<OpenCodeModel, "id" | "providerID"> & {
  capabilities?: { reasoning?: boolean };
  reasoning?: boolean;
  variants?: unknown;
  [key: string]: unknown;
};

export type VariantCatalog = {
  modelKey: string;
  source: "runtime" | "explicit-config" | "runtime+explicit-config";
  names: string[];
  runtimeNames: readonly string[];
  optionsByVariant: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
};

function reasoningIsVerified(model: RuntimeVariantModel): boolean {
  return model.reasoning === true || model.capabilities?.reasoning === true;
}

function validateRuntimeVariants(value: unknown): Record<string, Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;

  const result: Record<string, Record<string, JsonValue>> = Object.create(null);
  for (const [name, rawOptions] of entries) {
    if (!name.trim() || name.length > 128 || rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
      return undefined;
    }
    if ((rawOptions as Record<string, unknown>).disabled === true) continue;
    const { disabled: _disabled, ...providerOptions } = rawOptions as Record<string, unknown>;
    const options = cloneSafeOptions(providerOptions);
    if (!options) return undefined;
    result[name] = options;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function configuredVariantsForModel(
  configured: VariantsByModel,
  modelKey: string,
): Record<string, Record<string, JsonValue>> | undefined {
  const definitions = configured[modelKey];
  if (!definitions) return undefined;

  const result: Record<string, Record<string, JsonValue>> = Object.create(null);
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.reasoning !== true || definition.disabled === true) continue;
    const options = cloneSafeOptions(definition.options);
    if (options) result[name] = options;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolveVariantCatalog(input: {
  model: RuntimeVariantModel;
  configuredVariants: VariantsByModel;
}): VariantCatalog | undefined {
  if (input.model.providerID !== "openai" || !reasoningIsVerified(input.model)) return undefined;

  const modelKey = `${input.model.providerID}/${input.model.id}`;
  const runtime = validateRuntimeVariants(input.model.variants);
  const configured = configuredVariantsForModel(input.configuredVariants, modelKey);
  if (!runtime && !configured) return undefined;

  const merged: Record<string, Readonly<Record<string, JsonValue>>> = Object.create(null);
  for (const [name, options] of Object.entries(runtime ?? {})) merged[name] = Object.freeze(options);
  for (const [name, options] of Object.entries(configured ?? {})) {
    if (!Object.hasOwn(merged, name)) merged[name] = Object.freeze(options);
  }

  const source = runtime && configured
    ? "runtime+explicit-config"
    : runtime
      ? "runtime"
      : "explicit-config";
  return Object.freeze({
    modelKey,
    source,
    names: Object.freeze(Object.keys(merged)) as unknown as string[],
    runtimeNames: Object.freeze(Object.keys(runtime ?? {})),
    optionsByVariant: Object.freeze(merged),
  });
}

export function resolveVariantCatalogFromParams(
  input: ChatParamsInput,
  configuredVariants: VariantsByModel,
): VariantCatalog | undefined {
  return resolveVariantCatalog({
    model: input.model as RuntimeVariantModel,
    configuredVariants,
  });
}

export function getVariantOptions(
  catalog: VariantCatalog | undefined,
  variant: string,
): Record<string, JsonValue> | undefined {
  const options = catalog?.optionsByVariant[variant];
  return options ? cloneJsonObject(options as Record<string, JsonValue>) : undefined;
}

export function getFallbackOptions(
  catalog: VariantCatalog | undefined,
  fallbackVariant: string,
): Record<string, JsonValue> | undefined {
  return getVariantOptions(catalog, fallbackVariant);
}
