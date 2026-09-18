import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createDecisionStore } from "../plugins/typesafe-variant-router/decision-store.ts";
import type { VariantCatalog } from "../plugins/typesafe-variant-router/open-code-variant-adapter.ts";
import { createTypeSafeVariantRouterPlugin, createVariantRouterHooks, type AppliedVariant, type VariantRouterHooks } from "../plugins/typesafe-variant-router/plugin.ts";
import type { RouterDecision, TypeSafeScoreAnswer, TypeSafeScoreClient, TypeSafeScoreRequest } from "../plugins/typesafe-variant-router/typesafe-router.ts";
import { createVariantSyncQueue } from "../plugins/typesafe-variant-router/variant-sync.ts";

function scoreAnswer(
  request: TypeSafeScoreRequest,
  probabilities: Record<string, number>,
  confidence = 1,
): TypeSafeScoreAnswer {
  return {
    type: "score",
    score: Object.entries(probabilities).reduce((total, [index, probability]) => total + Number(index) * probability, 0),
    confidence,
    legend: Object.fromEntries(request.criteria.map((criterion, index) => [String(index), criterion])),
    probabilities,
  };
}

const variants = { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } };
const selected = (modelID: string, variant: string): RouterDecision => ({ status: "selected", modelID, variant, reason: "selected", createdAt: 0, confidence: 0.9, probabilities: { low: 0.1, high: 0.9 } });
const deferredRouting = (producer: (catalog: VariantCatalog) => Promise<RouterDecision>) => {
  let decision: Promise<RouterDecision> | undefined;
  let terminalDecision: RouterDecision | undefined;
  return {
    start(catalog: VariantCatalog): Promise<RouterDecision> {
      decision ??= producer(catalog).then((result) => terminalDecision ??= result);
      return decision;
    },
    timeout(catalog: VariantCatalog): RouterDecision {
      terminalDecision ??= { status: "fallback", modelID: catalog.modelKey, variant: "low", reason: "timeout", createdAt: 0 };
      return terminalDecision;
    },
    terminal(): RouterDecision | undefined {
      return terminalDecision;
    },
    cancel(): void {
      terminalDecision ??= { status: "skipped", modelID: "openai/gpt-5", reason: "not-routable", createdAt: 0 };
    },
  };
};
const messageInput = (extra: Record<string, unknown> = {}) => ({ sessionID: "session-1", model: { providerID: "openai", modelID: "gpt-5" }, ...extra });
const messageOutput = (id: string, text = "Choose carefully") => ({ message: { id, sessionID: "session-1", role: "user", time: { created: 0 }, agent: "build", model: { providerID: "openai", modelID: "gpt-5" } }, parts: text ? [{ id: `part-${id}`, sessionID: "session-1", messageID: id, type: "text", text }] : [] });
const paramsInput = (id: string, modelID = "gpt-5", providerID = "openai") => ({ sessionID: "session-1", agent: "build", model: { id: modelID, providerID, reasoning: true, variants }, provider: { source: "config", info: {}, options: {} }, message: { id, sessionID: "session-1", role: "user", time: { created: 0 }, agent: "build", model: { providerID, modelID } } });
const paramsOutput = (options: Record<string, unknown> = {}) => ({ temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options });
const runMessage = async (hooks: VariantRouterHooks, input: ReturnType<typeof messageInput>, output: ReturnType<typeof messageOutput>) => { await hooks["chat.message"]?.(input as never, output as never); };
const runParams = async (hooks: VariantRouterHooks, input: ReturnType<typeof paramsInput>, output: ReturnType<typeof paramsOutput>) => { await hooks["chat.params"]?.(input as never, output as never); };

describe("bounded decision store", () => {
  test("actively expires and cancels an entry without a later store operation", async () => {
    const callbacks: Array<() => void> = [];
    let cancelled = 0;
    const store = createDecisionStore<{ cancel(): void }>({
      ttlMs: 50,
      maxEntries: 2,
      now: () => 100,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback);
        return () => undefined;
      }),
    } as never);
    const produce = store.produce as unknown as (
      metadata: { messageID: string; sessionID: string; modelID: string; deadlineAt: number; turnOrder: number },
      producer: () => { cancel(): void },
      onRemove: (value: { cancel(): void }) => void,
    ) => unknown;
    produce(
      { messageID: "active-ttl", sessionID: "secret-session", modelID: "openai/gpt-5", deadlineAt: 120, turnOrder: 1 },
      () => ({ cancel: () => { cancelled += 1; } }),
      (value) => value.cancel(),
    );

    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await Promise.resolve();
    expect(cancelled).toBe(1);
  });

  test("isolates IDs, deduplicates producers, bounds TTL/capacity, and cleans consume/session state", async () => {
    let now = 100;
    let calls = 0;
    const store = createDecisionStore({ ttlMs: 50, maxEntries: 2, now: () => now });
    const produce = (messageID: string, sessionID = "s1") => store.produce({ messageID, sessionID, modelID: "openai/gpt-5", deadlineAt: now + 20, turnOrder: calls + 1 }, async () => { calls += 1; return selected("openai/gpt-5", messageID === "a" ? "low" : "high"); });
    const first = produce("a");
    expect(produce("a")).toBe(first);
    expect(calls).toBe(1);
    produce("b", "s2");
    produce("c", "s3");
    expect(store.size).toBe(2);
    expect(store.consume("a")).toBeUndefined();
    const consumed = store.consume("b");
    expect(await consumed?.promise).toMatchObject({ variant: "high" });
    expect(store.consume("b")).toBeUndefined();
    produce("ttl", "secret-session");
    now += 51;
    expect(store.consume("ttl")).toBeUndefined();
    produce("session", "cleanup-me");
    store.cleanupSession("cleanup-me");
    expect(store.consume("session")).toBeUndefined();
    expect(JSON.stringify(store.inspect())).not.toContain("PRIVATE_PROMPT");
  });
});

describe("two-phase hook pipeline", () => {
  test("resolves the runtime catalog from chat.params when chat.message provides model IDs only", async () => {
    const applied: AppliedVariant[] = [];
    const client: TypeSafeScoreClient = {
      async score(request) {
        return scoreAnswer(request, { 0: 0, 1: 1 });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      client,
      onAppliedVariant: (application) => applied.push(application),
    });
    await runMessage(hooks, messageInput(), messageOutput("runtime-contract"));
    const output = paramsOutput({ foreign: "keep" });

    await runParams(hooks, paramsInput("runtime-contract"), output);

    expect(output.options).toEqual({ foreign: "keep", reasoningEffort: "high" });
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "high",
      status: "selected",
      reason: "selected",
    }]);
  });

  test("expires deferred work without params and never starts classification", async () => {
    let now = 0;
    let historyCalls = 0;
    let scoreCalls = 0;
    const store = createDecisionStore<ReturnType<typeof deferredRouting>>({
      ttlMs: 20,
      maxEntries: 8,
      now: () => now,
    });
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", timeoutMs: 10 }, {
      store,
      now: () => now,
      historyProvider: async () => { historyCalls += 1; return []; },
      client: { async score(request) { scoreCalls += 1; return scoreAnswer(request, { 0: 1, 1: 0 }); } },
    });

    await runMessage(hooks, messageInput(), messageOutput("no-params"));

    expect(historyCalls).toBe(1);
    expect(scoreCalls).toBe(0);
    expect(store.size).toBe(1);
    now = 21;
    expect(store.size).toBe(0);
  });

  test("does not start deferred classification after the absolute deadline", async () => {
    let now = 0;
    let scoreCalls = 0;
    const applied: AppliedVariant[] = [];
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", timeoutMs: 10 }, {
      now: () => now,
      client: { async score(request) { scoreCalls += 1; return scoreAnswer(request, { 0: 0, 1: 1 }); } },
      onAppliedVariant: (application) => applied.push(application),
    });
    await runMessage(hooks, messageInput(), messageOutput("expired-deferred"));
    now = 10;
    const output = paramsOutput();

    await runParams(hooks, paramsInput("expired-deferred"), output);

    expect(scoreCalls).toBe(0);
    expect(output.options.reasoningEffort).toBe("low");
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "low",
      status: "fallback",
      reason: "timeout",
    }]);
  });

  test("separates parallel turns, deduplicates producers, and preserves foreign options", async () => {
    let calls = 0;
    const client: TypeSafeScoreClient = { async score(request) { calls += 1; return scoreAnswer(request, request.state.currentPrompt.includes("first") ? { 0: 0.9, 1: 0.1 } : { 0: 0.1, 1: 0.9 }, 0.9); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client });
    await Promise.all([runMessage(hooks, messageInput(), messageOutput("m1", "first request")), runMessage(hooks, messageInput(), messageOutput("m2", "second request")), runMessage(hooks, messageInput(), messageOutput("m1", "duplicate ignored"))]);
    expect(calls).toBe(0);
    const first = paramsOutput({ foreign: "keep", nested: { owner: "other" } });
    const second = paramsOutput({ foreign: "keep-too" });
    await Promise.all([runParams(hooks, paramsInput("m1"), first), runParams(hooks, paramsInput("m2"), second)]);
    expect(calls).toBe(2);
    expect(first.options).toEqual({ foreign: "keep", nested: { owner: "other" }, reasoningEffort: "low" });
    expect(second.options).toEqual({ foreign: "keep-too", reasoningEffort: "high" });
  });

  test("reuses one correlated result for concurrent and repeated params with exactly-once side effects", async () => {
    const applied: AppliedVariant[] = [];
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => { cycleCalls += 1; return true; });
    const client: TypeSafeScoreClient = {
      async score(request) {
        return scoreAnswer(request, { 0: 0, 1: 1 });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      client,
      variantSync,
      onAppliedVariant: (application) => applied.push(application),
    });
    await runMessage(hooks, messageInput(), messageOutput("idempotent"));
    const first = paramsOutput({ caller: "first" });
    const second = paramsOutput({ caller: "second" });

    await Promise.all([
      runParams(hooks, paramsInput("idempotent"), first),
      runParams(hooks, paramsInput("idempotent"), second),
    ]);
    await runParams(hooks, paramsInput("idempotent"), first);
    await variantSync.flush();

    expect(first.options).toEqual({ caller: "first", reasoningEffort: "high" });
    expect(second.options).toEqual({ caller: "second", reasoningEffort: "high" });
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "high",
      status: "selected",
      reason: "selected",
    }]);
    expect(cycleCalls).toBe(2);
  });

  test("aborts started TypeSafe work on session deletion and dispose", async () => {
    for (const cleanup of ["session", "dispose"] as const) {
      let scoreSignal: AbortSignal | undefined;
      const client: TypeSafeScoreClient = {
        score: async (_request, options) => {
          scoreSignal = options.signal;
          return new Promise<TypeSafeScoreAnswer>(() => undefined);
        },
      };
      const hooks = createVariantRouterHooks({ fallbackVariant: "low", timeoutMs: 1_000 }, { client });
      await runMessage(hooks, messageInput(), messageOutput(`abort-${cleanup}`));
      const output = paramsOutput({ cleanup });
      const pending = runParams(hooks, paramsInput(`abort-${cleanup}`), output);
      for (let index = 0; index < 6 && !scoreSignal; index += 1) await Promise.resolve();
      expect(scoreSignal, `${cleanup} score start`).toBeDefined();

      if (cleanup === "session") {
        await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);
      } else {
        await hooks.dispose?.();
      }

      expect(scoreSignal?.aborted, cleanup).toBe(true);
      await expect(pending).resolves.toBeUndefined();
      expect(output.options).toEqual({ cleanup });
    }
  });

  test("aborts history preparation on session deletion even when the provider cannot abort transport", async () => {
    let historySignal: AbortSignal | undefined;
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      historyProvider: async (...args: unknown[]) => {
        historySignal = args[1] as AbortSignal | undefined;
        return new Promise<readonly unknown[]>(() => undefined);
      },
    });
    await runMessage(hooks, messageInput(), messageOutput("abort-history"));

    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);

    expect(historySignal?.aborted).toBe(true);
  });

  test("notifies the application observer only after a routed variant is applied", async () => {
    const applied: AppliedVariant[] = [];
    const client: TypeSafeScoreClient = {
      async score(request) {
        return scoreAnswer(request, { 0: 0, 1: 1 });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      client,
      onAppliedVariant: (application) => applied.push(application),
    });
    await runMessage(hooks, messageInput(), messageOutput("applied-selected"));
    const output = paramsOutput();

    expect(applied).toEqual([]);
    await runParams(hooks, paramsInput("applied-selected"), output);

    expect(output.options.reasoningEffort).toBe("high");
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "high",
      status: "selected",
      reason: "selected",
    }]);
  });

  test("reports a technical fallback once at application while preserving its reason", async () => {
    const applied: AppliedVariant[] = [];
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      onAppliedVariant: (application) => applied.push(application),
    });
    await runMessage(hooks, messageInput(), messageOutput("applied-fallback"));
    const output = paramsOutput();

    await runParams(hooks, paramsInput("applied-fallback"), output);

    expect(output.options.reasoningEffort).toBe("low");
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "low",
      status: "fallback",
      reason: "missing-api-key",
    }]);
  });

  test("classifies a params deadline winner as one applied timeout fallback", async () => {
    const applied: AppliedVariant[] = [];
    const diagnostics: unknown[] = [];
    const callbacks: Array<() => void> = [];
    const store = createDecisionStore<ReturnType<typeof deferredRouting>>({ ttlMs: 1_000, maxEntries: 8, now: () => 0 });
    store.produce({
      messageID: "outer-timeout",
      sessionID: "session-1",
      modelID: "openai/gpt-5",
      deadlineAt: 10,
      turnOrder: 1,
      sourceVariant: "default",
      variantCatalog: ["low", "high"],
    }, () => deferredRouting(async () => new Promise<RouterDecision>(() => undefined)));
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      store,
      now: () => 0,
      setTimer: (callback) => {
        callbacks.push(callback);
        return () => undefined;
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onAppliedVariant: (application) => applied.push(application),
    });
    const output = paramsOutput();
    const pending = runParams(hooks, paramsInput("outer-timeout"), output);
    for (let index = 0; index < 4 && callbacks.length === 0; index += 1) await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await pending;

    expect(output.options.reasoningEffort).toBe("low");
    expect(diagnostics).toEqual([{ code: "timeout", modelID: "openai/gpt-5", status: "fallback" }]);
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "low",
      status: "fallback",
      reason: "timeout",
    }]);
  });

  test("classifies an invalid selected variant as one applied invalid-response fallback", async () => {
    const applied: AppliedVariant[] = [];
    const store = createDecisionStore<ReturnType<typeof deferredRouting>>({ ttlMs: 1_000, maxEntries: 8, now: () => 0 });
    store.produce({
      messageID: "invalid-selected",
      sessionID: "session-1",
      modelID: "openai/gpt-5",
      deadlineAt: 10,
      turnOrder: 1,
      sourceVariant: "default",
      variantCatalog: ["low", "high"],
    }, () => deferredRouting(async () => selected("openai/gpt-5", "not-in-catalog")));
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      store,
      now: () => 0,
      onAppliedVariant: (application) => applied.push(application),
    });
    const output = paramsOutput();

    await runParams(hooks, paramsInput("invalid-selected"), output);

    expect(output.options.reasoningEffort).toBe("low");
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "low",
      status: "fallback",
      reason: "invalid-response",
    }]);
  });

  test("routes an exact orientation-only prompt and reports its applied variant once", async () => {
    const applied: AppliedVariant[] = [];
    let currentPrompt: string | undefined;
    const client: TypeSafeScoreClient = {
      async score(request) {
        currentPrompt = request.state.currentPrompt;
        return scoreAnswer(request, { 0: 0, 1: 1 });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      client,
      historyProvider: async () => [],
      onAppliedVariant: (application) => applied.push(application),
    });
    const orientation = "## Gortex Session Orientation\n- Repository: local\n- Branch: current";
    await runMessage(hooks, messageInput(), messageOutput("orientation-only", orientation));
    const output = paramsOutput();

    await runParams(hooks, paramsInput("orientation-only"), output);

    expect(currentPrompt).toBe("");
    expect(output.options.reasoningEffort).toBe("high");
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "high",
      status: "selected",
      reason: "selected",
    }]);
  });

  test("message intake returns without awaiting classification and params uses the remaining absolute budget", async () => {
    let capturedRequest: TypeSafeScoreRequest | undefined;
    let resolveScore: ((value: TypeSafeScoreAnswer) => void) | undefined;
    const client: TypeSafeScoreClient = {
      score: async (request) => {
        capturedRequest = request;
        return new Promise((resolve) => { resolveScore = resolve; });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", timeoutMs: 15 }, { client });
    await runMessage(hooks, messageInput(), messageOutput("slow"));
    expect(resolveScore).toBeUndefined();
    const output = paramsOutput({ foreign: true });
    const params = runParams(hooks, paramsInput("slow"), output);
    await params;
    expect(resolveScore).toBeDefined();
    expect(output.options).toEqual({ foreign: true, reasoningEffort: "low" });
    if (!capturedRequest) throw new Error("expected captured Score request");
    resolveScore?.(scoreAnswer(capturedRequest, { 0: 0, 1: 1 }));
  });

  test("keeps applied provider options when the direct TUI publish fails", async () => {
    const publishes: unknown[] = [];
    const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
    const hooks = await plugin({
      client: {
        app: { log: async () => ({} as never) },
        tui: {
          showToast: async () => ({} as never),
          publish: async (request: unknown) => {
            publishes.push(request);
            return { data: false } as never;
          },
        },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", notify: "off" });
    await hooks["chat.message"]?.(messageInput() as never, messageOutput("publish-failure") as never);
    const output = paramsOutput({ foreign: "keep" });

    await hooks["chat.params"]?.(paramsInput("publish-failure") as never, output as never);
    for (let index = 0; index < 4 && publishes.length === 0; index += 1) await Promise.resolve();
    await hooks.dispose?.();

    expect(output.options).toEqual({ foreign: "keep", reasoningEffort: "low" });
    expect(publishes).toEqual([{
      body: {
        type: "tui.command.execute",
        properties: { command: "variant.cycle" },
      },
    }]);
  });

  test("cycles only through runtime TUI variants when configured variants extend provider routing", async () => {
    const states = ["default", "low", "high"] as const;
    let visibleState: typeof states[number] = "high";
    const commands: string[] = [];
    const variantSync = createVariantSyncQueue(async () => {
      commands.push("variant.cycle");
      visibleState = states[(states.indexOf(visibleState) + 1) % states.length] ?? "default";
      return true;
    });
    const client: TypeSafeScoreClient = {
      async score(request) {
        return scoreAnswer(request, { 0: 1, 1: 0, 2: 0 });
      },
    };
    const hooks = createVariantRouterHooks({
      fallbackVariant: "low",
      variantsByModel: {
        "openai/gpt-5": {
          low: { reasoning: true, options: { reasoningEffort: "configured-low" } },
          custom: { reasoning: true, options: { reasoningEffort: "custom" } },
        },
      },
    }, { client, variantSync });
    await runMessage(hooks, messageInput({ variant: "high" }), messageOutput("runtime-tui-catalog"));
    const output = paramsOutput();

    await runParams(hooks, paramsInput("runtime-tui-catalog"), output);
    await variantSync.flush();

    expect(output.options).toEqual({ reasoningEffort: "low" });
    expect(commands).toEqual(["variant.cycle", "variant.cycle"]);
    expect(visibleState).toBe("low");
  });

  test("skips TUI synchronization when provider routing selects a configured-only variant", async () => {
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => {
      cycleCalls += 1;
      return true;
    });
    const client: TypeSafeScoreClient = {
      async score(request) {
        return scoreAnswer(request, { 0: 0, 1: 0, 2: 1 });
      },
    };
    const hooks = createVariantRouterHooks({
      fallbackVariant: "low",
      variantsByModel: {
        "openai/gpt-5": {
          low: { reasoning: true, options: { reasoningEffort: "configured-low" } },
          custom: { reasoning: true, options: { reasoningEffort: "custom" } },
        },
      },
    }, { client, variantSync });
    await runMessage(hooks, messageInput({ variant: "high" }), messageOutput("configured-only-tui-target"));
    const output = paramsOutput({ foreign: "keep" });

    await runParams(hooks, paramsInput("configured-only-tui-target"), output);
    await variantSync.flush();

    expect(output.options).toEqual({ foreign: "keep", reasoningEffort: "custom" });
    expect(cycleCalls).toBe(0);
  });

  test("ignores an older turn that completes after a newer turn synchronized", async () => {
    const states = ["default", "low", "high"] as const;
    let visibleState: typeof states[number] = "default";
    const commands: string[] = [];
    const scoreResolutions = new Map<string, (answer: TypeSafeScoreAnswer) => void>();
    const scoreRequests = new Map<string, TypeSafeScoreRequest>();
    const variantSync = createVariantSyncQueue(async () => {
      commands.push("variant.cycle");
      visibleState = states[(states.indexOf(visibleState) + 1) % states.length] ?? "default";
      return true;
    });
    const client: TypeSafeScoreClient = {
      score: async (request) => {
        scoreRequests.set(request.state.currentPrompt, request);
        return new Promise<TypeSafeScoreAnswer>((resolve) => {
          scoreResolutions.set(request.state.currentPrompt, resolve);
        });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client, variantSync });
    await runMessage(hooks, messageInput(), messageOutput("slow-old", "older turn"));
    await runMessage(hooks, messageInput(), messageOutput("fast-new", "newer turn"));
    const oldOutput = paramsOutput();
    const newOutput = paramsOutput();
    const oldParams = runParams(hooks, paramsInput("slow-old"), oldOutput);
    const newParams = runParams(hooks, paramsInput("fast-new"), newOutput);
    for (let index = 0; index < 8 && scoreResolutions.size < 2; index += 1) await Promise.resolve();

    const newRequest = scoreRequests.get("newer turn");
    if (!newRequest) throw new Error("expected newer score request");
    scoreResolutions.get("newer turn")?.(scoreAnswer(newRequest, { 0: 0, 1: 1 }));
    await newParams;
    await variantSync.flush();
    expect(newOutput.options.reasoningEffort).toBe("high");
    expect(commands).toEqual(["variant.cycle", "variant.cycle"]);
    expect(visibleState).toBe("high");

    const oldRequest = scoreRequests.get("older turn");
    if (!oldRequest) throw new Error("expected older score request");
    scoreResolutions.get("older turn")?.(scoreAnswer(oldRequest, { 0: 1, 1: 0 }));
    await oldParams;
    await variantSync.flush();

    expect(oldOutput.options.reasoningEffort).toBe("low");
    expect(commands).toEqual(["variant.cycle", "variant.cycle"]);
    expect(visibleState).toBe("high");
  });

  test("synchronizes applied variants with the minimum ordered cycle sequence", async () => {
    const cases = [
      { name: "default to target", source: undefined, target: "high", cycles: 2 },
      { name: "lower to higher", source: "low", target: "high", cycles: 1 },
      { name: "higher to lower wraps through default", source: "high", target: "low", cycles: 2 },
      { name: "already equal", source: "high", target: "high", cycles: 0 },
    ] as const;

    for (const scenario of cases) {
      const commands: string[] = [];
      const variantSync = createVariantSyncQueue(async () => { commands.push("variant.cycle"); return true; });
      const client: TypeSafeScoreClient = {
        async score(request) {
          return scoreAnswer(request, scenario.target === "low" ? { 0: 1, 1: 0 } : { 0: 0, 1: 1 });
        },
      };
      const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client, variantSync });
      const input = scenario.source === undefined ? messageInput() : messageInput({ variant: scenario.source });
      await runMessage(hooks, input, messageOutput(`sync-${scenario.name}`));
      const output = paramsOutput();
      await runParams(hooks, paramsInput(`sync-${scenario.name}`), output);
      await variantSync.flush();

      expect(commands, scenario.name).toEqual(Array(scenario.cycles).fill("variant.cycle"));
      expect(output.options.reasoningEffort).toBe(scenario.target);
    }
  });

  test("recomputes overlapping transitions so the latest target wins", async () => {
    const states = ["default", "low", "high"] as const;
    let visibleState: typeof states[number] = "default";
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => {
      cycleCalls += 1;
      visibleState = states[(states.indexOf(visibleState) + 1) % states.length] ?? "default";
      return true;
    });
    const client: TypeSafeScoreClient = {
      async score(request) {
        return scoreAnswer(request, request.state.currentPrompt.includes("lower") ? { 0: 1, 1: 0 } : { 0: 0, 1: 1 });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client, variantSync });

    await runMessage(hooks, messageInput(), messageOutput("overlap-low", "lower target"));
    await runMessage(hooks, messageInput(), messageOutput("overlap-high", "higher target"));
    await Promise.all([
      runParams(hooks, paramsInput("overlap-low"), paramsOutput()),
      runParams(hooks, paramsInput("overlap-high"), paramsOutput()),
    ]);
    await variantSync.flush();

    expect(cycleCalls).toBe(2);
    expect(visibleState).toBe("high");
  });

  test("synchronizes deterministic fallback from the correlated visible variant", async () => {
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => { cycleCalls += 1; return true; });
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { variantSync });
    await runMessage(hooks, messageInput({ variant: "high" }), messageOutput("fallback-sync"));
    const output = paramsOutput({ foreign: true });

    await runParams(hooks, paramsInput("fallback-sync"), output);
    await variantSync.flush();
    expect(output.options).toEqual({ foreign: true, reasoningEffort: "low" });
    expect(cycleCalls).toBe(2);
  });

  test("leaves rejected commands detached from routing and applied options", async () => {
    let rejectedCalls = 0;
    const variantSync = createVariantSyncQueue(async () => {
      rejectedCalls += 1;
      throw new Error("PRIVATE_PROMPT_COMMAND_FAILURE");
    });
    const client: TypeSafeScoreClient = { async score(request) { return scoreAnswer(request, { 0: 0, 1: 1 }); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client, variantSync });
    await runMessage(hooks, messageInput(), messageOutput("rejected-sync"));
    const output = paramsOutput({ foreign: true });

    await expect(runParams(hooks, paramsInput("rejected-sync"), output)).resolves.toBeUndefined();
    expect(output.options).toEqual({ foreign: true, reasoningEffort: "high" });
    await variantSync.flush();
    expect(rejectedCalls).toBe(1);
  });

  test("manual-first keeps the submitted visible variant without cycling", async () => {
    let scoreCalls = 0;
    let cycleCalls = 0;
    const client: TypeSafeScoreClient = { async score(request) { scoreCalls += 1; return scoreAnswer(request, { 0: 1, 1: 0 }); } };
    const variantSync = createVariantSyncQueue(async () => { cycleCalls += 1; return true; });
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", manualVariantPolicy: "manual-first" }, { client, variantSync });
    await runMessage(hooks, messageInput({ variant: "high" }), messageOutput("manual-sync"));
    const output = paramsOutput();
    await runParams(hooks, paramsInput("manual-sync"), output);
    await variantSync.flush();

    expect(scoreCalls).toBe(0);
    expect(cycleCalls).toBe(0);
    expect(output.options.reasoningEffort).toBe("high");
  });

  test("manual-first avoids TypeSafe and typesafe-first overrides a valid manual variant", async () => {
    let manualCalls = 0;
    const manualClient: TypeSafeScoreClient = { async score(request) { manualCalls += 1; return scoreAnswer(request, { 0: 0, 1: 1 }); } };
    const manual = createVariantRouterHooks({ fallbackVariant: "low", manualVariantPolicy: "manual-first" }, { client: manualClient });
    await runMessage(manual, messageInput({ variant: "low" }), messageOutput("manual"));
    const manualOut = paramsOutput({ foreign: true });
    await runParams(manual, paramsInput("manual"), manualOut);
    expect(manualCalls).toBe(0);
    expect(manualOut.options).toEqual({ foreign: true, reasoningEffort: "low" });
    let automaticCalls = 0;
    const automaticClient: TypeSafeScoreClient = { async score(request) { automaticCalls += 1; return scoreAnswer(request, { 0: 0, 1: 1 }); } };
    const automatic = createVariantRouterHooks({ fallbackVariant: "low", manualVariantPolicy: "typesafe-first" }, { client: automaticClient });
    await runMessage(automatic, messageInput({ variant: "low" }), messageOutput("automatic"));
    const automaticOut = paramsOutput();
    await runParams(automatic, paramsInput("automatic"), automaticOut);
    expect(automaticCalls).toBe(1);
    expect(automaticOut.options.reasoningEffort).toBe("high");
  });

  test("does not apply missing or model-mismatched decisions and uses only current fallback options", async () => {
    let scoreCalls = 0;
    const client: TypeSafeScoreClient = { async score(request) { scoreCalls += 1; return scoreAnswer(request, { 0: 0, 1: 1 }); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client });
    await runMessage(hooks, messageInput(), messageOutput("original"));
    const missing = paramsOutput({ foreign: 1 });
    await runParams(hooks, paramsInput("different"), missing);
    expect(missing.options).toEqual({ foreign: 1, reasoningEffort: "low" });
    const switched = paramsOutput({ foreign: 2 });
    await runParams(hooks, paramsInput("original", "gpt-5-new"), switched);
    expect(switched.options).toEqual({ foreign: 2, reasoningEffort: "low" });
    expect(scoreCalls).toBe(0);
  });

  test("bypasses non-openai, non-text, synthetic, and missing producer IDs", async () => {
    let calls = 0;
    const client: TypeSafeScoreClient = { async score(request) { calls += 1; return scoreAnswer(request, { 0: 1, 1: 0 }); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client });
    await runMessage(hooks, messageInput({ model: { providerID: "anthropic", modelID: "claude" } }), messageOutput("other"));
    await runMessage(hooks, messageInput(), messageOutput("no-text", ""));
    const synthetic = messageOutput("synthetic");
    (synthetic.message as { synthetic?: boolean }).synthetic = true;
    await runMessage(hooks, messageInput(), synthetic);
    const noID = messageOutput("placeholder");
    (noID.message as { id?: string }).id = undefined;
    await runMessage(hooks, messageInput(), noID);
    expect(calls).toBe(0);
    const nonTextOut = paramsOutput({ foreign: "non-text" });
    await runParams(hooks, paramsInput("no-text"), nonTextOut);
    expect(nonTextOut.options).toEqual({ foreign: "non-text" });
    const syntheticOut = paramsOutput({ foreign: "synthetic" });
    await runParams(hooks, paramsInput("synthetic"), syntheticOut);
    expect(syntheticOut.options).toEqual({ foreign: "synthetic" });
  });

  test("loads bounded recent messages through the injected history provider", async () => {
    let capturedState: unknown;
    const client: TypeSafeScoreClient = { async score(request) { capturedState = request.state; return scoreAnswer(request, { 0: 1, 1: 0 }); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", context: { mode: "recent-messages", maxMessages: 2, maxChars: 100 } }, {
      client,
      historyProvider: async () => [
        { role: "system", parts: [{ type: "text", text: "PRIVATE_SYSTEM" }] },
        { role: "user", parts: [{ type: "reasoning", text: "PRIVATE_REASONING" }, { type: "text", text: "allowed user\n## Gortex Session Orientation\nPRIVATE_ORIENTATION\n## Genuine User Section\nkept" }] },
        { role: "assistant", parts: [{ type: "tool", text: "PRIVATE_TOOL" }, { type: "text", text: "## Gortex Session Orientation\nPRIVATE_ORIENTATION_ONLY" }] },
        { role: "assistant", parts: [{ type: "text", text: "allowed assistant" }] },
      ],
    });
    await runMessage(hooks, messageInput(), messageOutput("history", "before\n## Gortex Session Orientation\nPRIVATE_CURRENT_ORIENTATION\n## User Request\nfollow up"));
    await runParams(hooks, paramsInput("history"), paramsOutput());
    expect(capturedState).toEqual({ currentPrompt: "before\n## User Request\nfollow up", recentMessages: [{ role: "user", text: "allowed user\n## Genuine User Section\nkept" }, { role: "assistant", text: "allowed assistant" }], model: "openai/gpt-5" });
    expect(JSON.stringify(capturedState)).not.toContain("PRIVATE_");
  });

  test("cancels session work and invalidates newer work overlapped by its in-flight global command", async () => {
    const commands: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCommand = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const variantSync = createVariantSyncQueue(async () => {
      commands.push("variant.cycle");
      if (commands.length === 1) await firstCommand;
      return true;
    });
    const client: TypeSafeScoreClient = { async score(request) { return scoreAnswer(request, { 0: 0, 1: 1 }); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client, variantSync });

    await runMessage(hooks, messageInput(), messageOutput("cleanup-sync-1"));
    await runParams(hooks, paramsInput("cleanup-sync-1"), paramsOutput());
    await runMessage(hooks, messageInput({ sessionID: "session-2" }), messageOutput("cleanup-sync-2"));
    await runParams(hooks, { ...paramsInput("cleanup-sync-2"), sessionID: "session-2" }, paramsOutput());
    await Promise.resolve();
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);
    releaseFirst?.();
    await variantSync.flush();

    expect(commands).toEqual(["variant.cycle"]);
  });

  test("keeps the latest model observation isolated from stale model work", async () => {
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => { cycleCalls += 1; return true; });
    const catalog = ["low", "high"];
    variantSync.observe({ messageID: "model-a", sessionID: "session-a", modelID: "openai/model-a", sourceVariant: "default", catalog, turnOrder: 1 });
    variantSync.observe({ messageID: "model-b", sessionID: "session-b", modelID: "openai/model-b", sourceVariant: "default", catalog, turnOrder: 2 });
    variantSync.schedule({ messageID: "model-a", sessionID: "session-a", modelID: "openai/model-a", sourceVariant: "default", targetVariant: "low", catalog, turnOrder: 1 });
    variantSync.schedule({ messageID: "model-b", sessionID: "session-b", modelID: "openai/model-b", sourceVariant: "default", targetVariant: "high", catalog, turnOrder: 2 });

    await variantSync.flush();

    expect(cycleCalls).toBe(2);
  });

  test("invalidates an ambiguous in-flight handoff and retries only from a fresh authoritative observation", async () => {
    const states = ["default", "low", "high"] as const;
    const visibleByModel = new Map<string, typeof states[number]>([
      ["openai/model-a", "default"],
      ["openai/model-b", "default"],
    ]);
    let visibleModel = "openai/model-a";
    let releaseCommand: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
    const commandStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => {
      cycleCalls += 1;
      markStarted?.();
      await commandGate;
      const current = visibleByModel.get(visibleModel) ?? "default";
      visibleByModel.set(visibleModel, states[(states.indexOf(current) + 1) % states.length] ?? "default");
      return true;
    });
    const catalog = ["low", "high"];

    variantSync.observe({ messageID: "model-a-old", sessionID: "session-a", modelID: "openai/model-a", sourceVariant: "default", catalog, turnOrder: 1 });
    variantSync.schedule({ messageID: "model-a-old", sessionID: "session-a", modelID: "openai/model-a", sourceVariant: "default", targetVariant: "low", catalog, turnOrder: 1 });
    await commandStarted;

    visibleModel = "openai/model-b";
    variantSync.observe({ messageID: "model-b-overlap", sessionID: "session-b", modelID: "openai/model-b", sourceVariant: "default", catalog, turnOrder: 2 });
    variantSync.schedule({ messageID: "model-b-overlap", sessionID: "session-b", modelID: "openai/model-b", sourceVariant: "default", targetVariant: "high", catalog, turnOrder: 2 });
    releaseCommand?.();
    await variantSync.flush();

    expect(cycleCalls).toBe(1);
    expect(visibleByModel.get("openai/model-a")).toBe("default");
    expect(visibleByModel.get("openai/model-b")).toBe("low");

    variantSync.observe({ messageID: "model-b-fresh", sessionID: "session-b", modelID: "openai/model-b", sourceVariant: "low", catalog, turnOrder: 3 });
    variantSync.schedule({ messageID: "model-b-fresh", sessionID: "session-b", modelID: "openai/model-b", sourceVariant: "low", targetVariant: "high", catalog, turnOrder: 3 });
    await variantSync.flush();

    expect(cycleCalls).toBe(2);
    expect(visibleByModel.get("openai/model-b")).toBe("high");
  });

  test("bounds unmatched observations without reviving evicted stale work", async () => {
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => { cycleCalls += 1; return true; }, 2);
    const catalog = ["low", "high"];
    for (const [index, messageID] of ["oldest", "middle", "latest"].entries()) {
      variantSync.observe({ messageID, sessionID: "session", modelID: `openai/${messageID}`, sourceVariant: "default", catalog, turnOrder: index + 1 });
    }

    variantSync.schedule({ messageID: "oldest", sessionID: "session", modelID: "openai/oldest", sourceVariant: "default", targetVariant: "high", catalog, turnOrder: 1 });
    variantSync.schedule({ messageID: "latest", sessionID: "session", modelID: "openai/latest", sourceVariant: "default", targetVariant: "low", catalog, turnOrder: 3 });
    await variantSync.flush();

    expect(cycleCalls).toBe(1);
  });

  test("rebases changed catalogs and rejects mismatched observation identities", async () => {
    let cycleCalls = 0;
    const variantSync = createVariantSyncQueue(async () => { cycleCalls += 1; return true; });
    variantSync.observe({ messageID: "catalog", sessionID: "session", modelID: "openai/model", sourceVariant: "default", catalog: ["low", "high"], turnOrder: 1 });
    variantSync.schedule({ messageID: "catalog", sessionID: "session", modelID: "openai/model", sourceVariant: "default", targetVariant: "high", catalog: ["high", "low"], turnOrder: 1 });
    await variantSync.flush();

    variantSync.observe({ messageID: "stale-catalog", sessionID: "session", modelID: "openai/model", sourceVariant: "default", catalog: ["low", "high"], turnOrder: 2 });
    variantSync.observe({ messageID: "current-catalog", sessionID: "session", modelID: "openai/model", sourceVariant: "high", catalog: ["high", "low"], turnOrder: 3 });
    variantSync.schedule({ messageID: "stale-catalog", sessionID: "session", modelID: "openai/model", sourceVariant: "default", targetVariant: "high", catalog: ["high", "low"], turnOrder: 2 });
    variantSync.schedule({ messageID: "current-catalog", sessionID: "session", modelID: "openai/model", sourceVariant: "high", targetVariant: "low", catalog: ["high", "low"], turnOrder: 3 });
    await variantSync.flush();

    variantSync.observe({ messageID: "identity", sessionID: "original", modelID: "openai/model", sourceVariant: "high", catalog: ["high", "low"], turnOrder: 4 });
    variantSync.schedule({ messageID: "identity", sessionID: "different", modelID: "openai/model", sourceVariant: "high", targetVariant: "low", catalog: ["high", "low"], turnOrder: 4 });
    await variantSync.flush();

    expect(cycleCalls).toBe(2);
  });

  test("cleans pending work at session end and exposes no prompt in store metadata", async () => {
    const store = createDecisionStore({ ttlMs: 10_000, maxEntries: 8 });
    const client: TypeSafeScoreClient = { async score(request) { return scoreAnswer(request, { 0: 1, 1: 0 }); } };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, { client, store });
    await runMessage(hooks, messageInput(), messageOutput("cleanup", "PRIVATE_PROMPT_739a"));
    expect(store.size).toBe(1);
    expect(JSON.stringify(store.inspect())).not.toContain("PRIVATE_PROMPT_739a");
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);
    expect(store.size).toBe(0);
  });

  test("keeps OMA registered without duplicating the globally configured router", async () => {
    const config = JSON.parse(await readFile(new URL("../opencode.jsonc", import.meta.url), "utf8"));
    expect(config.plugin).toContain("./plugins/oma/oma.ts");
    const routerEntry = config.plugin.find((entry: unknown) => Array.isArray(entry) && entry[0] === "./plugins/typesafe-variant-router/index.ts");
    expect(routerEntry).toBeUndefined();
    const entryModule = await import("../plugins/typesafe-variant-router/index.ts");
    const callableExports = Object.entries(entryModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(callableExports).toEqual(["default"]);
  });
});
