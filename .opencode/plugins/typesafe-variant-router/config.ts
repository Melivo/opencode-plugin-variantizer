import { z } from "zod";

import { cloneSafeOptions, type JsonValue } from "./safe-json.ts";

const variantNameSchema = z.string().trim().min(1).max(128);
const modelIDSchema = z.string().trim().min(1).max(256);

const configuredVariantSchema = z.strictObject({
  reasoning: z.boolean(),
  disabled: z.boolean().optional(),
  options: z.record(z.string(), z.json()).superRefine((value, context) => {
    if (!cloneSafeOptions(value)) {
      context.addIssue({ code: "custom", message: "options must be a non-empty safe JSON object" });
    }
  }),
});

const configuredModelSchema = z.record(variantNameSchema, configuredVariantSchema);

const routerConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  fallbackVariant: variantNameSchema,
  timeoutMs: z.number().int().positive().max(30_000).default(1_500),
  manualVariantPolicy: z.enum(["typesafe-first", "manual-first"]).default("typesafe-first"),
  context: z.strictObject({
    mode: z.enum(["prompt-only", "recent-messages"]).default("recent-messages"),
    maxMessages: z.number().int().positive().max(100).default(6),
    maxChars: z.number().int().positive().max(100_000).default(12_000),
  }).default({ mode: "recent-messages", maxMessages: 6, maxChars: 12_000 }),
  variantsByModel: z.record(modelIDSchema, configuredModelSchema).default({}),
  variantDescriptions: z.record(variantNameSchema, z.string().trim().min(1).max(4_000)).default({}),
  notify: z.enum(["off", "fallback", "always"]).default("fallback"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("warn"),
});

export type ConfiguredVariant = {
  reasoning: boolean;
  disabled?: boolean;
  options: Record<string, JsonValue>;
};

export type VariantsByModel = Record<string, Record<string, ConfiguredVariant>>;

export type RouterConfig = Omit<z.infer<typeof routerConfigSchema>, "variantsByModel"> & {
  variantsByModel: VariantsByModel;
};

export class ConfigurationError extends Error {
  constructor(message = "Invalid TypeSafe variant router configuration") {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function parseRouterConfig(input: unknown): RouterConfig {
  const parsed = routerConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigurationError();

  const config = parsed.data as RouterConfig;
  for (const variants of Object.values(config.variantsByModel)) {
    const fallback = variants[config.fallbackVariant];
    if (!fallback || fallback.reasoning !== true || fallback.disabled === true) {
      throw new ConfigurationError("fallbackVariant is not an enabled verified reasoning variant for a configured model");
    }
  }
  return config;
}

export function readTypeSafeApiKey(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = environment.TYPESAFE_API_KEY?.trim();
  return value ? value : undefined;
}
