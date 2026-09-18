import { describe, expect, test } from "bun:test";

import type { TypeSafeContext } from "../plugins/typesafe-variant-router/context-assembler.ts";
import type { VariantCatalog } from "../plugins/typesafe-variant-router/open-code-variant-adapter.ts";
import {
  createTypeSafeRouter,
  selectHighestProbabilityVariant,
  type InvalidResponseDetail,
  type RouterDiagnostic,
  type TypeSafeScoreAnswer,
  type TypeSafeScoreClient,
  type TypeSafeScoreRequest,
} from "../plugins/typesafe-variant-router/typesafe-router.ts";

type PendingTimer = { callback: () => void; at: number; cancelled: boolean };

class ControlledClock {
  current = 1_000;
  readonly timers: PendingTimer[] = [];

  now = (): number => this.current;

  setTimer = (callback: () => void, delayMs: number): (() => void) => {
    const timer = { callback, at: this.current + delayMs, cancelled: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  };

  advanceBy(milliseconds: number): void {
    this.current += milliseconds;
    for (const timer of this.timers) {
      if (!timer.cancelled && timer.at <= this.current) {
        timer.cancelled = true;
        timer.callback();
      }
    }
  }
}

const state: TypeSafeContext = {
  currentPrompt: "PRIVATE_PROMPT_238a",
  recentMessages: [{ role: "user", text: "PRIVATE_HISTORY_77bb" }],
  model: "gpt-5",
};

const catalog: VariantCatalog = Object.freeze({
  modelKey: "openai/gpt-5",
  source: "runtime",
  names: Object.freeze(["low", "high"]) as unknown as string[],
  runtimeNames: Object.freeze(["low", "high"]),
  optionsByVariant: Object.freeze({
    low: Object.freeze({ reasoningEffort: "low" }),
    high: Object.freeze({ reasoningEffort: "high" }),
  }),
});

const routeInput = {
  modelID: "gpt-5",
  state,
  catalog,
  fallbackVariant: "low",
  deadlineAt: 2_000,
  variantDescriptions: {},
};

function answer(
  criteria: TypeSafeScoreRequest["criteria"],
  probabilities: Record<string, number>,
  confidence = 0.1,
): TypeSafeScoreAnswer {
  const score = Object.entries(probabilities).reduce((total, [index, probability]) => total + Number(index) * probability, 0);
  return {
    type: "score",
    score,
    confidence,
    legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
    probabilities,
  };
}

function clientWith(
  handler: (request: TypeSafeScoreRequest, options: Parameters<TypeSafeScoreClient["score"]>[1]) => ReturnType<TypeSafeScoreClient["score"]>,
): TypeSafeScoreClient {
  return { score: handler };
}

describe("TypeSafe Score router", () => {
  test("builds ordered standalone levels for official OpenAI efforts and configured custom catalogs", async () => {
    let captured: TypeSafeScoreRequest | undefined;
    const names = ["none", "low", "medium", "high", "xhigh", "max", "custom"];
    const fullCatalog: VariantCatalog = {
      modelKey: "openai/gpt-5",
      source: "runtime",
      names,
      runtimeNames: names,
      optionsByVariant: Object.fromEntries(names.map((name) => [name, { reasoningEffort: name }])),
    };
    const probabilities = Object.fromEntries(names.map((_name, index) => [String(index), index === 3 ? 1 : 0]));
    const router = createTypeSafeRouter({
      client: clientWith(async (request) => {
        captured = request;
        return answer(request.criteria, probabilities, 0.9);
      }),
      now: () => 1_000,
    });

    const result = await router.route({
      ...routeInput,
      catalog: fullCatalog,
      variantDescriptions: { custom: "Repository-specific exhaustive verification work." },
    });

    expect(result).toMatchObject({ status: "selected", variant: "high" });
    expect(captured?.criteria).toHaveLength(names.length);
    expect(captured?.instructions).toMatchObject({ task: expect.any(String), ordering: expect.any(String) });
    for (const level of captured?.criteria ?? []) {
      expect(typeof level.profile).toBe("string");
      expect(typeof level.boundaries).toBe("string");
      expect(Array.isArray(level.examples)).toBe(true);
      expect(level.examples.length).toBeGreaterThan(0);
      expect(level.profile).not.toMatch(/previous|next|lower level|higher level/i);
    }
    expect(captured?.criteria[6]?.profile).toBe("Repository-specific exhaustive verification work.");
  });

  test("selects the highest indexed probability at any confidence and resolves exact ties toward lower effort", async () => {
    const lowConfidence = createTypeSafeRouter({
      client: clientWith(async (request) => answer(request.criteria, { 0: 0.2, 1: 0.8 }, 0.01)),
      now: () => 1_000,
    });
    expect(await lowConfidence.route(routeInput)).toEqual({
      status: "selected",
      modelID: "gpt-5",
      variant: "high",
      reason: "selected",
      createdAt: 1_000,
      confidence: 0.01,
      probabilities: { low: 0.2, high: 0.8 },
    });

    expect(selectHighestProbabilityVariant({ 0: 0.5, 1: 0.5 }, catalog.names)).toMatchObject({
      variant: "low",
      probabilities: { low: 0.5, high: 0.5 },
    });
    const tied = createTypeSafeRouter({
      client: clientWith(async (request) => answer(request.criteria, { 0: 0.5, 1: 0.5 }, 0)),
      now: () => 1_000,
    });
    expect(await tied.route(routeInput)).toMatchObject({ status: "selected", variant: "low", confidence: 0 });
  });

  test("accepts independently rounded score metadata and shape-valid legend serialization", async () => {
    const router = createTypeSafeRouter({
      client: clientWith(async () => ({
        type: "score",
        score: 0.8,
        confidence: 0.75,
        legend: {
          0: { profile: "low", boundaries: "lower effort", examples: ["direct task"] },
          1: { profile: "high", boundaries: "higher effort", examples: ["complex task"] },
        },
        probabilities: { 0: 0.333, 1: 0.667 },
      })),
      now: () => 1_000,
    });

    expect(await router.route(routeInput)).toMatchObject({
      status: "selected",
      variant: "high",
      reason: "selected",
      confidence: 0.75,
      probabilities: { low: 0.333, high: 0.667 },
    });
  });

  test("falls back for malformed Score answers, discriminators, legends, and index sets", async () => {
    const mutations: Array<[
      InvalidResponseDetail,
      (response: TypeSafeScoreAnswer) => TypeSafeScoreAnswer,
    ]> = [
      ["score", (response) => ({ ...response, score: -0.001 })],
      ["score", (response) => ({ ...response, score: 1.001 })],
      ["score", (response) => ({ ...response, score: Number.NaN })],
      ["probabilities", (response) => ({ ...response, probabilities: { low: 0.1, high: 0.9 } })],
      ["probabilities", (response) => ({ ...response, probabilities: { 0: 1 } })],
      ["probabilities", (response) => ({ ...response, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } })],
      ["probabilities", (response) => ({ ...response, probabilities: { 0: 0.1, 1: 0.8 } })],
      ["probabilities", (response) => ({ ...response, probabilities: { 0: -0.1, 1: 1.1 } })],
      ["confidence", (response) => ({ ...response, confidence: Number.NaN })],
      ["confidence", (response) => ({ ...response, confidence: 1.001 })],
      ["type", (response) => ({ ...response, type: undefined })],
      ["type", (response) => ({ ...response, type: "choice" })],
      ["legend", (response) => ({ ...response, legend: { 0: response.legend && (response.legend as Record<string, unknown>)["0"] } })],
      ["legend", (response) => {
        const legend = response.legend as Record<string, unknown>;
        return { ...response, legend: { ...legend, 1: { ...(legend["1"] as Record<string, unknown>), extra: true } } };
      }],
      ["legend", (response) => ({ ...response, legend: { ...(response.legend as Record<string, unknown>), 2: "extra" } })],
    ];

    for (const [detail, mutate] of mutations) {
      const diagnostics: RouterDiagnostic[] = [];
      const router = createTypeSafeRouter({
        client: clientWith(async (request) => mutate(answer(request.criteria, { 0: 0.1, 1: 0.9 }))),
        now: () => 1_000,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(await router.route(routeInput), detail).toMatchObject({
        status: "fallback",
        variant: "low",
        reason: "invalid-response",
        detail,
      });
      expect(diagnostics, detail).toEqual([{
        code: "invalid-response",
        modelID: "gpt-5",
        status: "fallback",
        detail,
      }]);
    }
  });

  test("leaves OpenCode unchanged when the configured fallback is not in the current catalog", async () => {
    const router = createTypeSafeRouter({
      client: clientWith(async (request) => ({ ...answer(request.criteria, { 0: 0.9, 1: 0.1 }), score: -1 })),
      now: () => 1_000,
    });

    const result = await router.route({ ...routeInput, fallbackVariant: "missing" });
    expect(result.status).toBe("skipped");
    expect(result.variant).toBeUndefined();
    expect(result.reason).toBe("invalid-response");
  });

  test("does not invoke TypeSafe when the deadline passes before the score call starts", async () => {
    const clock = new ControlledClock();
    let scoreCalls = 0;
    let timeReads = 0;
    const router = createTypeSafeRouter({
      client: clientWith(async (request) => {
        scoreCalls += 1;
        return answer(request.criteria, { 0: 0, 1: 1 }, 1);
      }),
      now: () => timeReads++ === 0 ? 1_000 : 1_010,
      setTimer: clock.setTimer,
    });

    const result = await router.route({ ...routeInput, deadlineAt: 1_010 });

    expect(scoreCalls).toBe(0);
    expect(result).toMatchObject({ status: "fallback", variant: "low", reason: "timeout" });
  });

  test("uses one absolute deadline for SDK retries and plugin waiting, ignoring a late response", async () => {
    const clock = new ControlledClock();
    let requestOptions: Parameters<TypeSafeScoreClient["score"]>[1] | undefined;
    let capturedRequest: TypeSafeScoreRequest | undefined;
    let resolveLate: ((value: TypeSafeScoreAnswer) => void) | undefined;
    const late = new Promise<TypeSafeScoreAnswer>((resolve) => { resolveLate = resolve; });
    const router = createTypeSafeRouter({
      client: clientWith((request, options) => {
        capturedRequest = request;
        requestOptions = options;
        return late;
      }),
      now: clock.now,
      setTimer: clock.setTimer,
    });

    const pending = router.route({ ...routeInput, deadlineAt: 1_120 });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestOptions?.timeoutMs).toBe(120);
    expect(requestOptions?.signal.aborted).toBe(false);
    clock.advanceBy(120);
    const timedOut = await pending;
    expect(timedOut).toMatchObject({ status: "fallback", variant: "low", reason: "timeout" });
    expect(requestOptions?.signal.aborted).toBe(true);

    if (!capturedRequest) throw new Error("expected captured Score request");
    resolveLate?.(answer(capturedRequest.criteria, { 0: 0, 1: 1 }, 1));
    await Promise.resolve();
    expect(timedOut).toMatchObject({ status: "fallback", variant: "low", reason: "timeout" });
  });

  test("maps missing key, auth, rate limit, server, network, and timeout failures deterministically", async () => {
    const scenarios: Array<[unknown, string]> = [
      [Object.assign(new Error("PRIVATE_ERROR_BODY_a1"), { status: 401, responseBody: "PRIVATE_ERROR_BODY_a1" }), "auth-error"],
      [Object.assign(new Error("PRIVATE_ERROR_BODY_b2"), { status: 403 }), "auth-error"],
      [Object.assign(new Error("PRIVATE_ERROR_BODY_c3"), { status: 408 }), "timeout"],
      [Object.assign(new Error("PRIVATE_ERROR_BODY_c4"), { status: 429 }), "rate-limited"],
      [Object.assign(new Error("PRIVATE_ERROR_BODY_d4"), { status: 503 }), "server-error"],
      [Object.assign(new Error("PRIVATE_ERROR_BODY_e5"), { name: "APIConnectionError" }), "network-error"],
      [Object.assign(new Error("PRIVATE_ERROR_BODY_f6"), { name: "APITimeoutError" }), "timeout"],
    ];

    const missing = await createTypeSafeRouter({ now: () => 1_000 }).route(routeInput);
    expect(missing).toMatchObject({ status: "fallback", reason: "missing-api-key" });

    for (const [error, reason] of scenarios) {
      const router = createTypeSafeRouter({
        client: clientWith(async () => { throw error; }),
        now: () => 1_000,
      });
      expect(await router.route(routeInput)).toMatchObject({ status: "fallback", variant: "low", reason });
    }
  });

  test("emits a privacy-safe diagnostic for every route without retaining sensitive state or raw failures", async () => {
    const diagnostics: RouterDiagnostic[] = [];
    const error = Object.assign(new Error("PRIVATE_ERROR_BODY_88ee"), {
      status: 429,
      body: "PRIVATE_RAW_RESPONSE_44cc",
      requestState: "PRIVATE_REQUEST_STATE_12dd",
      apiKey: "PRIVATE_API_KEY_91f0",
    });
    const router = createTypeSafeRouter({
      client: clientWith(async () => { throw error; }),
      now: () => 1_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await router.route(routeInput);
    await router.route(routeInput);

    expect(diagnostics).toEqual([
      { code: "rate-limited", modelID: "gpt-5", status: "fallback" },
      { code: "rate-limited", modelID: "gpt-5", status: "fallback" },
    ]);
    const serialized = JSON.stringify({ router, diagnostics });
    expect(serialized).not.toMatch(/PRIVATE_PROMPT_238a|PRIVATE_HISTORY_77bb|PRIVATE_API_KEY_91f0/);
    expect(serialized).not.toMatch(/PRIVATE_RAW_RESPONSE_44cc|PRIVATE_ERROR_BODY_88ee|PRIVATE_REQUEST_STATE_12dd/);
  });
});
