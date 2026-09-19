import type { TypeSafeContext } from "./context-assembler.ts";
import type { VariantCatalog } from "./open-code-variant-adapter.ts";

export type ScoreLevel = { [key: string]: string | string[] } & {
  profile: string;
  boundaries: string;
  examples: string[];
};

export type TypeSafeScoreRequest = {
  state: TypeSafeContext;
  instructions: { [key: string]: string } & {
    task: string;
    ordering: string;
    output: string;
  };
  criteria: readonly [ScoreLevel, ScoreLevel, ...ScoreLevel[]];
};

export type TypeSafeScoreAnswer = {
  type: unknown;
  score: unknown;
  confidence: unknown;
  legend: unknown;
  probabilities: unknown;
};

export type TypeSafeScoreClient = {
  score(
    request: TypeSafeScoreRequest,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<TypeSafeScoreAnswer>;
};

export type RouterReason =
  | "selected"
  | "not-routable"
  | "missing-api-key"
  | "invalid-response"
  | "pre-request-timeout"
  | "request-timeout"
  | "network-error"
  | "auth-error"
  | "rate-limited"
  | "server-error"
  | "client-error";

export type InvalidResponseDetail =
  | "request"
  | "type"
  | "probabilities"
  | "score"
  | "confidence"
  | "legend"
  | "variant";

export type RouterDecision = {
  status: "selected" | "fallback" | "skipped";
  modelID: string;
  variant?: string;
  reason: RouterReason;
  createdAt: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  detail?: InvalidResponseDetail;
};

export type RouterDiagnostic = {
  code: Exclude<RouterReason, "selected">;
  modelID: string;
  status: "fallback" | "skipped";
  detail?: InvalidResponseDetail;
};

type RouteInput = {
  modelID: string;
  state: TypeSafeContext;
  catalog: VariantCatalog;
  fallbackVariant: string;
  deadlineAt: number;
  variantDescriptions: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onRequestStart?: () => void;
};

type RouterDependencies = {
  client?: TypeSafeScoreClient;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => () => void;
  onDiagnostic?: (diagnostic: RouterDiagnostic) => void;
};

type SettledCall =
  | { kind: "answer"; answer: TypeSafeScoreAnswer }
  | { kind: "error"; error: unknown }
  | { kind: "deadline" }
  | { kind: "cancelled" };

const DEFAULT_LEVELS: Readonly<Record<string, ScoreLevel>> = Object.freeze({
  none: {
    profile: "Latency-critical work that does not benefit from deliberate reasoning, planning, or multi-step tool use.",
    boundaries: "Use for direct formatting, retrieval, or classification when speed matters and no reasoning chain is needed.",
    examples: ["Reformat a supplied JSON object without changing values."],
  },
  low: {
    profile: "Efficient reasoning for straightforward tool use, planning, search, or multi-step decisions while optimizing speed and cost.",
    boundaries: "Use when a modest reasoning increase is useful but the task does not require complex judgement, deep debugging, or long-horizon work.",
    examples: ["Implement one documented validation rule and its focused tests."],
  },
  medium: {
    profile: "Balanced reasoning for work where quality and reliability matter and the task requires planning, complex judgement, or coordinated steps.",
    boundaries: "Use as the balanced level for substantive work; not for direct transformations or unusually difficult, high-risk analysis.",
    examples: ["Implement a service change across several modules with regression coverage."],
  },
  high: {
    profile: "Hard reasoning for complex debugging, deep planning, and high-value work where quality matters more than latency.",
    boundaries: "Use for genuinely difficult interacting constraints; not for routine implementation or tasks needing an exceptionally long research run.",
    examples: ["Diagnose a cross-module race and design compatibility-preserving regression coverage."],
  },
  xhigh: {
    profile: "Very deep reasoning for challenging long-running research, agentic, security, review, or enterprise workflows.",
    boundaries: "Use only when evaluation shows that the difficult task benefits enough to justify substantially greater latency and cost.",
    examples: ["Evaluate competing concurrency designs under adversarial failure and safety constraints."],
  },
  max: {
    profile: "Maximum available reasoning for the most complex tasks where the strongest analysis is required.",
    boundaries: "Reserve for exceptional tasks that need more reasoning than xhigh and can tolerate the greatest latency and cost.",
    examples: ["Resolve an exceptionally complex, high-stakes architecture problem with many coupled failure modes."],
  },
});

function levelFor(name: string, description: string | undefined): ScoreLevel {
  if (description) {
    return {
      profile: description,
      boundaries: `Use only for tasks that independently match the configured ${name} profile in the current model's validated catalog.`,
      examples: [`A repository task that directly matches the configured ${name} profile.`],
    };
  }
  const builtIn = DEFAULT_LEVELS[name.toLowerCase()];
  if (builtIn) return { ...builtIn, examples: [...builtIn.examples] };
  return {
    profile: `A task that independently matches the configured reasoning variant named ${name}.`,
    boundaries: `Use only when the current model's validated catalog exposes ${name} and the task directly fits that named profile.`,
    examples: [`A repository-specific task assigned to the configured ${name} reasoning profile.`],
  };
}

function buildRequest(input: RouteInput): TypeSafeScoreRequest | undefined {
  if (input.catalog.names.length < 2 || input.catalog.names.length > 10) return undefined;
  const levels = input.catalog.names.map((name) => levelFor(name, input.variantDescriptions[name]));
  return {
    state: input.state,
    instructions: {
      task: "Rate how much reasoning effort the current software task and supplied context require.",
      ordering: "The criteria are the current model's validated variants in ascending catalog order; assess each level from its standalone description.",
      output: "Place the task on this one reasoning-effort spectrum without inventing variants or provider options.",
    },
    criteria: levels as [ScoreLevel, ScoreLevel, ...ScoreLevel[]],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactIndexKeys(value: unknown, count: number): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === count && keys.every((key, index) => key === String(index));
}

function isScoreLevel(value: unknown): value is ScoreLevel {
  if (!isRecord(value)
    || typeof value.profile !== "string"
    || typeof value.boundaries !== "string"
    || !Array.isArray(value.examples)
    || !value.examples.every((example) => typeof example === "string")) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string"
    || (Array.isArray(entry) && entry.every((item) => typeof item === "string")));
}

function hasValidLegend(value: unknown, count: number): boolean {
  return hasExactIndexKeys(value, count)
    && Object.values(value).every((level) => isScoreLevel(level));
}

export function selectHighestProbabilityVariant(
  value: unknown,
  candidates: readonly string[],
): { variant: string; probabilities: Record<string, number> } | undefined {
  if (!hasExactIndexKeys(value, candidates.length) || candidates.length === 0) return undefined;
  const probabilities: Record<string, number> = Object.create(null);
  let total = 0;
  let selectedIndex = 0;
  let selectedProbability = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const probability = value[String(index)];
    if (!candidate || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return undefined;
    }
    probabilities[candidate] = probability;
    total += probability;
    if (probability > selectedProbability) {
      selectedIndex = index;
      selectedProbability = probability;
    }
  }
  if (Math.abs(total - 1) > 0.001) return undefined;
  const variant = candidates[selectedIndex];
  return variant ? { variant, probabilities } : undefined;
}

type ValidScoreAnswer = {
  valid: true;
  selection: { variant: string; probabilities: Record<string, number> };
  confidence: number;
};

type InvalidScoreAnswer = { valid: false; detail: Exclude<InvalidResponseDetail, "request" | "variant"> };

export function validateTypeSafeScoreAnswer(
  response: TypeSafeScoreAnswer,
  candidates: readonly string[],
): ValidScoreAnswer | InvalidScoreAnswer {
  if (response.type !== "score") return { valid: false, detail: "type" };
  const selection = selectHighestProbabilityVariant(response.probabilities, candidates);
  if (!selection) return { valid: false, detail: "probabilities" };
  if (typeof response.score !== "number" || !Number.isFinite(response.score)
    || response.score < 0 || response.score > candidates.length - 1) {
    return { valid: false, detail: "score" };
  }
  if (typeof response.confidence !== "number" || !Number.isFinite(response.confidence)
    || response.confidence < 0 || response.confidence > 1) {
    return { valid: false, detail: "confidence" };
  }
  if (!hasValidLegend(response.legend, candidates.length)) {
    return { valid: false, detail: "legend" };
  }
  return { valid: true, selection, confidence: response.confidence };
}

function errorReason(error: unknown): Exclude<RouterReason, "selected" | "invalid-response" | "missing-api-key" | "not-routable"> {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  if (status === 401 || status === 403) return "auth-error";
  if (status === 408) return "request-timeout";
  if (status === 429) return "rate-limited";
  if (status !== undefined && status >= 500 && status <= 599) return "server-error";
  const name = error instanceof Error ? error.name : isRecord(error) && typeof error.name === "string" ? error.name : "";
  if (name === "APITimeoutError" || name === "TimeoutError") return "request-timeout";
  if (name === "APIConnectionError" || name === "TypeError") return "network-error";
  return "client-error";
}

function defaultSetTimer(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

export function createTypeSafeRouter(dependencies: RouterDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? defaultSetTimer;

  const finish = (
    input: RouteInput,
    reason: Exclude<RouterReason, "selected">,
    createdAt: number,
    detail?: InvalidResponseDetail,
  ): RouterDecision => {
    const validFallback = input.catalog.names.includes(input.fallbackVariant);
    const status = validFallback ? "fallback" : "skipped";
    const diagnostic: RouterDiagnostic = {
      code: reason,
      modelID: input.modelID,
      status,
      ...(detail ? { detail } : {}),
    };
    dependencies.onDiagnostic?.(diagnostic);
    return {
      status,
      modelID: input.modelID,
      ...(validFallback ? { variant: input.fallbackVariant } : {}),
      reason,
      createdAt,
      ...(detail ? { detail } : {}),
    };
  };

  return {
    async route(input: RouteInput): Promise<RouterDecision> {
      const createdAt = now();
      if (!dependencies.client) return finish(input, "missing-api-key", createdAt);
      const request = buildRequest(input);
      if (!request) return finish(input, "invalid-response", createdAt, "request");
      const controller = new AbortController();
      let resolveCancellation: ((value: SettledCall) => void) | undefined;
      const cancellation = new Promise<SettledCall>((resolve) => { resolveCancellation = resolve; });
      const cancel = (): void => {
        controller.abort();
        resolveCancellation?.({ kind: "cancelled" });
      };
      if (input.signal?.aborted) {
        return { status: "skipped", modelID: input.modelID, reason: "not-routable", createdAt };
      }
      input.signal?.addEventListener("abort", cancel, { once: true });

      const callStartedAt = now();
      const callBudgetMs = input.deadlineAt - callStartedAt;
      if (!Number.isFinite(callBudgetMs) || callBudgetMs <= 0) {
        input.signal?.removeEventListener("abort", cancel);
        return finish(input, "pre-request-timeout", createdAt);
      }

      let resolveDeadline: ((value: SettledCall) => void) | undefined;
      const deadline = new Promise<SettledCall>((resolve) => { resolveDeadline = resolve; });
      const cancelTimer = setTimer(() => {
        resolveDeadline?.({ kind: "deadline" });
        controller.abort();
      }, callBudgetMs);
      let call: Promise<SettledCall>;
      try {
        input.onRequestStart?.();
        call = Promise.resolve(dependencies.client.score(request, {
          signal: controller.signal,
          timeoutMs: callBudgetMs,
        })).then<SettledCall, SettledCall>(
          (answer) => ({ kind: "answer", answer }),
          (error: unknown) => ({ kind: "error", error }),
        );
      } catch (error) {
        call = Promise.resolve({ kind: "error", error });
      }

      const settled = await Promise.race([call, deadline, cancellation]);
      cancelTimer();
      input.signal?.removeEventListener("abort", cancel);
      if (settled.kind === "cancelled") {
        return { status: "skipped", modelID: input.modelID, reason: "not-routable", createdAt };
      }
      if (settled.kind === "deadline") return finish(input, "request-timeout", createdAt);
      if (settled.kind === "error") return finish(input, errorReason(settled.error), createdAt);

      const validation = validateTypeSafeScoreAnswer(settled.answer, input.catalog.names);
      if (!validation.valid) {
        return finish(input, "invalid-response", createdAt, validation.detail);
      }
      return {
        status: "selected",
        modelID: input.modelID,
        variant: validation.selection.variant,
        reason: "selected",
        createdAt,
        confidence: validation.confidence,
        probabilities: validation.selection.probabilities,
      };
    },
  };
}
