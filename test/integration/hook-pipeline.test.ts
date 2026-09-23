import { describe, expect, test } from "bun:test";
import {
  createAgentRouteStore,
  createDecisionStore,
  createManualAgentPolicyState,
} from "../../src/decision-store.ts";
import {
  AGENT_MODEL_BINDINGS,
  OBSERVED_PRIMARY_ORDER,
  createAgentTopologySnapshot,
  type AgentTopologySnapshot,
  type RingAgentID,
  type TopologyObservation,
} from "../../src/agent-topology.ts";
import type {
  TypeSafeAgentRouteClient,
  TypeSafeAgentRouteRequest,
} from "../../src/agent-route.ts";
import type { VariantCatalog } from "../../src/open-code-variant-adapter.ts";
import { createTypeSafeVariantRouterPlugin, createVariantRouterHooks as createRawVariantRouterHooks, type AppliedVariant, type VariantRouterHooks } from "../../src/plugin.ts";
import type { RouterDecision, TypeSafeScoreAnswer, TypeSafeScoreClient, TypeSafeScoreRequest } from "../../src/typesafe-router.ts";
import { createUnavailableAgentSync } from "../../src/agent-sync.ts";
import { createVariantSyncQueue } from "../../src/variant-sync.ts";
import type { DiagnosticRecord } from "../../src/diagnostics.ts";

const createVariantRouterHooks = (
  config: Parameters<typeof createRawVariantRouterHooks>[0],
  dependencies?: Parameters<typeof createRawVariantRouterHooks>[1],
) => createRawVariantRouterHooks({ agentSelection: { enabled: false }, ...(config as Record<string, unknown>) }, dependencies);

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
      terminalDecision ??= { status: "fallback", modelID: catalog.modelKey, variant: "low", reason: "pre-request-timeout", createdAt: 0 };
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

const sharedAgentBehavior = { prompt: "shared", permission: { edit: "allow" }, tools: { edit: true }, skills: ["shared"] };
const sharedProviderBoundary = { instructions: ["shared"], tools: [{ name: "edit" }] };

function ringTopology(): AgentTopologySnapshot {
  const catalog = (agent: RingAgentID, names: readonly string[]) => ({
    modelKey: AGENT_MODEL_BINDINGS[agent],
    names: [...names],
    runtimeNames: [...names],
    optionsByVariant: Object.fromEntries(names.map((name) => [name, { reasoningEffort: name }])),
  });
  return createAgentTopologySnapshot({
    generationID: "generation-hook-1",
    orderedPrimaryAgents: [...OBSERVED_PRIMARY_ORDER],
    agentToModel: { ...AGENT_MODEL_BINDINGS },
    behaviorByAgent: {
      luna: structuredClone(sharedAgentBehavior),
      terra: structuredClone(sharedAgentBehavior),
      sol: structuredClone(sharedAgentBehavior),
    },
    providerBoundaryByAgent: {
      luna: structuredClone(sharedProviderBoundary),
      terra: structuredClone(sharedProviderBoundary),
      sol: structuredClone(sharedProviderBoundary),
    },
    catalogsByAgent: {
      luna: catalog("luna", ["low", "high"]),
      terra: catalog("terra", ["low", "high"]),
      sol: catalog("sol", ["low", "high", "xhigh"]),
    },
  });
}

function ringObservation(snapshot: AgentTopologySnapshot, sourceAgent: RingAgentID): TopologyObservation {
  return {
    generationID: snapshot.generationID,
    sourceAgent,
    sourceModel: snapshot.agentToModel[sourceAgent],
    orderedPrimaryAgents: snapshot.orderedPrimaryAgents,
    agentToModel: snapshot.agentToModel,
    behaviorFingerprint: snapshot.behaviorFingerprint,
    providerBoundaryFingerprint: snapshot.providerBoundaryFingerprint,
    catalogFingerprints: snapshot.catalogFingerprints,
    optionsFingerprints: snapshot.optionsFingerprints,
  };
}

function ringTopologySource(snapshot: AgentTopologySnapshot) {
  return {
    async acquire(input: { sourceAgent: RingAgentID }) {
      return { topology: snapshot, observation: ringObservation(snapshot, input.sourceAgent) };
    },
    async revalidate(input: { sourceAgent: RingAgentID }) {
      return ringObservation(snapshot, input.sourceAgent);
    },
  };
}

function ringScore(criteria: readonly unknown[], selected: number) {
  return {
    type: "score",
    score: selected,
    confidence: 1,
    legend: Object.fromEntries(criteria.map((entry, index) => [String(index), entry])),
    probabilities: Object.fromEntries(criteria.map((_entry, index) => [String(index), index === selected ? 1 : 0])),
  };
}

function ringResponse(request: TypeSafeAgentRouteRequest, agent: RingAgentID, variant: string) {
  const selectedIndex = request.questions[`reasoning_for_${agent}`].criteria.findIndex((entry) => entry.profile.includes(` ${variant} `));
  if (selectedIndex < 0) throw new Error(`missing variant ${variant}`);
  return {
    model: "jev-test",
    answers: {
      target_agent: {
        type: "choice",
        choice: agent,
        confidence: 1,
        probabilities: { luna: agent === "luna" ? 1 : 0, terra: agent === "terra" ? 1 : 0, sol: agent === "sol" ? 1 : 0 },
      },
      reasoning_for_luna: ringScore(request.questions.reasoning_for_luna.criteria, agent === "luna" ? selectedIndex : 0),
      reasoning_for_terra: ringScore(request.questions.reasoning_for_terra.criteria, agent === "terra" ? selectedIndex : 0),
      reasoning_for_sol: ringScore(request.questions.reasoning_for_sol.criteria, agent === "sol" ? selectedIndex : 0),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function ringConfig() {
  return {
    fallbackVariant: "low",
    agentSelection: { enabled: true },
    variantsByModel: {
      [AGENT_MODEL_BINDINGS.luna]: {
        low: { reasoning: true, options: { reasoningEffort: "low" } },
        high: { reasoning: true, options: { reasoningEffort: "high" } },
      },
      [AGENT_MODEL_BINDINGS.terra]: {
        low: { reasoning: true, options: { reasoningEffort: "low" } },
        high: { reasoning: true, options: { reasoningEffort: "high" } },
      },
      [AGENT_MODEL_BINDINGS.sol]: {
        low: { reasoning: true, options: { reasoningEffort: "low" } },
        high: { reasoning: true, options: { reasoningEffort: "high" } },
        xhigh: { reasoning: true, options: { reasoningEffort: "xhigh" } },
      },
    },
  };
}

function ringMessageInput(sessionID: string, agent: RingAgentID) {
  const [providerID, modelID] = AGENT_MODEL_BINDINGS[agent].split("/");
  return { sessionID, agent, model: { providerID, modelID } };
}

function ringMessageOutput(id: string, agent: RingAgentID, sessionID = "session-1") {
  const [providerID, modelID] = AGENT_MODEL_BINDINGS[agent].split("/");
  return {
    message: { id, sessionID, role: "user", time: { created: 0 }, agent, model: { providerID, modelID } },
    parts: [{ id: `part-${id}`, sessionID, messageID: id, type: "text", text: "PRIVATE route this task" }],
  };
}

function ringParamsInput(message: ReturnType<typeof ringMessageOutput>["message"]) {
  const modelKey = `${message.model.providerID}/${message.model.modelID}` as keyof ReturnType<typeof ringConfig>["variantsByModel"];
  const configured = ringConfig().variantsByModel[modelKey];
  const runtime = Object.fromEntries(Object.entries(configured).map(([name, definition]) => [name, definition.options]));
  return {
    sessionID: message.sessionID,
    agent: message.agent,
    model: { id: message.model.modelID, providerID: message.model.providerID, reasoning: true, variants: runtime },
    provider: { source: "config", info: {}, options: {} },
    message,
  };
}

describe("bounded decision store", () => {
  test("keeps pending agent reservations short-lived while committed metadata uses its bounded backstop", () => {
    let now = 10;
    const timers: Array<() => void> = [];
    let cancellations = 0;
    const store = createAgentRouteStore({
      ttlMs: 50,
      committedTtlMs: 500,
      maxEntries: 1,
      now: () => now,
      setTimer: (callback) => { timers.push(callback); return () => undefined; },
    });
    const reservation = store.reserve({ sessionID: "session", messageID: "message" }, () => { cancellations += 1; });
    expect(reservation).toBeDefined();
    expect(store.reserve({ sessionID: "other", messageID: "message" }, () => undefined)).toBeUndefined();
    expect(store.get("session", "message")).toBeUndefined();
    expect(reservation?.commit({
      sessionID: "session",
      messageID: "message",
      turnOrder: 1,
      sourceAgent: "luna",
      sourceModel: AGENT_MODEL_BINDINGS.luna,
      targetAgent: "terra",
      targetModel: AGENT_MODEL_BINDINGS.terra,
      targetVariant: "high",
      confidence: 1,
      topologyGenerationID: "generation",
      behaviorFingerprint: "behavior",
      catalogFingerprint: "catalog",
      optionsFingerprint: "options",
      createdAt: now,
    })).toBe(true);
    expect(store.get("session", "message")?.targetAgent).toBe("terra");
    expect(store.claimSideEffects("session", "message")).toBe(true);
    expect(store.claimSideEffects("session", "message")).toBe(false);
    now = 61;
    timers[0]?.();
    expect(store.get("session", "message")?.targetAgent).toBe("terra");
    now = 511;
    expect(store.get("session", "message")).toBeUndefined();
    expect(store.wasCommitted("session", "message")).toBe(true);
    now = 1_012;
    expect(store.wasCommitted("session", "message")).toBe(false);
    const pending = store.reserve({ sessionID: "session", messageID: "pending" }, () => { cancellations += 1; });
    expect(pending).toBeDefined();
    timers[2]?.();
    expect(store.size).toBe(0);
    expect(cancellations).toBe(2);
    expect(timers).toHaveLength(3);
  });

  test("keeps every unexpired invalidation fail-closed under tombstone capacity pressure", () => {
    let now = 0;
    const store = createAgentRouteStore({
      ttlMs: 10,
      committedTtlMs: 100,
      maxEntries: 2,
      now: () => now,
      setTimer: () => () => undefined,
    });
    const pending = store.reserve({ sessionID: "session", messageID: "pending" }, () => undefined);
    expect(pending).toBeDefined();
    const commitAndInvalidate = (messageID: string, turnOrder: number): void => {
      const reservation = store.reserve({ sessionID: "session", messageID }, () => undefined);
      expect(reservation).toBeDefined();
      expect(reservation?.commit({
        sessionID: "session",
        messageID,
        turnOrder,
        sourceAgent: "luna",
        sourceModel: AGENT_MODEL_BINDINGS.luna,
        targetAgent: "terra",
        targetModel: AGENT_MODEL_BINDINGS.terra,
        targetVariant: "high",
        confidence: 1,
        topologyGenerationID: "generation",
        behaviorFingerprint: "behavior",
        catalogFingerprint: "catalog",
        optionsFingerprint: "options",
        createdAt: now,
      })).toBe(true);
      store.invalidate("session", messageID);
    };

    commitAndInvalidate("first", 1);
    commitAndInvalidate("second", 2);
    commitAndInvalidate("overflow", 3);

    for (const messageID of ["first", "second", "overflow"]) {
      expect(store.wasCommitted("session", messageID)).toBe(true);
      expect(store.reserve({ sessionID: "session", messageID }, () => undefined)).toBeUndefined();
    }
    expect(pending?.commit({
      sessionID: "session",
      messageID: "pending",
      turnOrder: 4,
      sourceAgent: "luna",
      sourceModel: AGENT_MODEL_BINDINGS.luna,
      targetAgent: "sol",
      targetModel: AGENT_MODEL_BINDINGS.sol,
      targetVariant: "xhigh",
      confidence: 1,
      topologyGenerationID: "generation",
      behaviorFingerprint: "behavior",
      catalogFingerprint: "catalog",
      optionsFingerprint: "options",
      createdAt: now,
    })).toBe(true);
    expect(store.get("session", "pending")?.targetAgent).toBe("sol");
    expect(store.size).toBe(1);

    now = 101;
    expect(store.wasCommitted("session", "never-routed")).toBe(false);
    expect(store.reserve({ sessionID: "fresh", messageID: "fresh" }, () => undefined)).toBeDefined();
  });

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
      confidence: 1,
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
      reason: "pre-request-timeout",
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
      confidence: 1,
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
      confidence: 1,
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
    expect(diagnostics).toEqual([{ code: "pre-request-timeout", modelID: "openai/gpt-5", status: "fallback" }]);
    expect(applied).toEqual([{
      modelID: "openai/gpt-5",
      variant: "low",
      status: "fallback",
      reason: "pre-request-timeout",
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
      confidence: 1,
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
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "off" });
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

  test("ignores OpenCode's ancillary params without invalidating the committed route", async () => {
    const snapshot = ringTopology();
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: { async route(request) { return ringResponse(request, "sol", "high"); } },
      agentTopology: ringTopologySource(snapshot),
      now: () => 100,
    });
    const output = ringMessageOutput("ancillary-bypass", "luna");

    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, output as never);
    for (const agent of ["title", "summary", "compaction", "explore"]) {
      const ancillaryInput = { ...ringParamsInput(output.message), agent };
      const ancillaryParams = paramsOutput({ untouched: agent });
      await hooks["chat.params"]?.(ancillaryInput as never, ancillaryParams as never);
      expect(ancillaryParams.options).toEqual({ untouched: agent });
    }

    const actualParams = paramsOutput();
    await hooks["chat.params"]?.(ringParamsInput(output.message) as never, actualParams as never);

    expect(actualParams.options).toEqual({ reasoningEffort: "high" });
    await hooks.dispose?.();
  });

  test("commits an authoritative mixed agent route and applies only correlated cloned options", async () => {
    const snapshot = ringTopology();
    let calls = 0;
    const applied: AppliedVariant[] = [];
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: {
        async route(request) {
          calls += 1;
          return ringResponse(request, "terra", "high");
        },
      },
      agentTopology: ringTopologySource(snapshot),
      historyProvider: async () => [],
      onAppliedVariant: (application) => applied.push(application),
    });
    const output = ringMessageOutput("agent-commit", "luna");

    await hooks["chat.message"]?.(ringMessageInput("session-1", "terra") as never, output as never);

    expect(calls).toBe(1);
    expect(output.message).toMatchObject({
      agent: "terra",
      model: { providerID: "openai", modelID: "gpt-5.6-terra", variant: "high" },
    });
    const params = ringParamsInput(output.message);
    const bound = paramsOutput({ foreign: "keep" });
    await hooks["chat.params"]?.(params as never, bound as never);
    expect(bound.options).toEqual({ foreign: "keep", reasoningEffort: "high" });
    const repeated = paramsOutput({ repeated: true });
    await hooks["chat.params"]?.(params as never, repeated as never);
    expect(repeated.options).toEqual({ repeated: true, reasoningEffort: "high" });
    expect(applied).toEqual([{
      modelID: AGENT_MODEL_BINDINGS.terra,
      variant: "high",
      status: "selected",
      reason: "selected",
      confidence: 1,
    }]);
    bound.options.reasoningEffort = "mutated";
    expect(snapshot.catalogsByAgent.terra.optionsByVariant.high).toEqual({ reasoningEffort: "high" });
  });

  test("retains committed agent routes across long tool cycles with a fresh timeout per params invocation", async () => {
    let now = 0;
    const timerDelays: number[] = [];
    const snapshot = ringTopology();
    const hooks = createRawVariantRouterHooks({ ...ringConfig(), timeoutMs: 20 }, {
      now: () => now,
      setTimer: (_callback, delayMs) => {
        timerDelays.push(delayMs);
        return () => undefined;
      },
      agentClient: { async route(request) { return ringResponse(request, "terra", "high"); } },
      agentTopology: ringTopologySource(snapshot),
    });
    const routed = ringMessageOutput("long-agent-cycle", "luna");
    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, routed as never);

    now = 30_001;
    const first = paramsOutput();
    await hooks["chat.params"]?.(ringParamsInput(routed.message) as never, first as never);
    expect(first.options).toEqual({ reasoningEffort: "high" });
    expect(timerDelays.at(-1)).toBe(20);

    now = 60_002;
    const repeated = paramsOutput();
    await hooks["chat.params"]?.(ringParamsInput(routed.message) as never, repeated as never);
    expect(repeated.options).toEqual({ reasoningEffort: "high" });
    expect(timerDelays.at(-1)).toBe(20);
  });

  test("binds the selected variant from the persisted OpenCode UserMessage model", async () => {
    const snapshot = ringTopology();
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: {
        async route(request) {
          return ringResponse(request, "terra", "high");
        },
      },
      agentTopology: ringTopologySource(snapshot),
      historyProvider: async () => [],
    });
    const output = ringMessageOutput("persisted-agent-route", "luna");

    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, output as never);

    const persistedMessage = {
      id: output.message.id,
      sessionID: output.message.sessionID,
      role: output.message.role,
      time: output.message.time,
      agent: output.message.agent,
      model: { ...output.message.model },
    };
    expect(persistedMessage.model).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      variant: "high",
    });
    const bound = paramsOutput();
    await hooks["chat.params"]?.(ringParamsInput(persistedMessage) as never, bound as never);
    expect(bound.options).toMatchObject({ reasoningEffort: "high" });
  });

  test("keeps TypeSafe task-fit choice input independent of the source agent", async () => {
    const snapshot = ringTopology();
    const requests: TypeSafeAgentRouteRequest[] = [];
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: {
        async route(request) {
          requests.push(request);
          return ringResponse(request, "sol", "high");
        },
      },
      agentTopology: ringTopologySource(snapshot),
      historyProvider: async () => [],
    });

    for (const sourceAgent of ["luna", "terra", "sol"] as const) {
      const output = ringMessageOutput(`source-${sourceAgent}`, sourceAgent, `session-${sourceAgent}`);
      await hooks["chat.message"]?.(
        ringMessageInput(`session-${sourceAgent}`, sourceAgent) as never,
        output as never,
      );
      expect(output.message).toMatchObject({ agent: "sol", model: { variant: "high" } });
    }

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.state)).toEqual([
      requests[0]!.state,
      requests[0]!.state,
      requests[0]!.state,
    ]);
    expect(Object.keys(requests[0]!.state)).toEqual(["currentPrompt", "recentMessages"]);
    expect(requests[0]!.questions.target_agent.instructions).toContain("solely by task fit");
    expect(requests[0]!.questions.target_agent.criteria).toEqual({
      luna: {
        profile: expect.stringContaining("boilerplate, extraction, formatting"),
        modelPremise: `luna is always bound to ${AGENT_MODEL_BINDINGS.luna}.`,
      },
      terra: {
        profile: expect.stringContaining("clearly specified local code changes and structured subtasks"),
        modelPremise: `terra is always bound to ${AGENT_MODEL_BINDINGS.terra}.`,
      },
      sol: {
        profile: expect.stringContaining("normal backend, frontend, and mobile implementation"),
        modelPremise: `sol is always bound to ${AGENT_MODEL_BINDINGS.sol}.`,
      },
    });
  });

  test("reports a missing TypeSafe key once while keeping the current agent tuple unchanged", async () => {
    const rejections: Array<{ modelID: string; reason: string }> = [];
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentTopology: ringTopologySource(ringTopology()),
      onAgentRouteRejected: (rejection) => rejections.push(rejection),
    });
    const output = ringMessageOutput("missing-agent-key", "sol");
    const before = structuredClone(output.message);

    await hooks["chat.message"]?.(ringMessageInput("session-1", "sol") as never, output as never);

    expect(output.message).toEqual(before);
    expect(rejections).toEqual([{
      modelID: AGENT_MODEL_BINDINGS.sol,
      reason: "missing-api-key",
    }]);
  });

  test("reports topology acquisition failures instead of dropping them silently", async () => {
    const rejections: Array<{ modelID: string; reason: string }> = [];
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: { async route(request) { return ringResponse(request, "sol", "high"); } },
      agentTopology: {
        async acquire() { throw new Error("PRIVATE topology failure"); },
        async revalidate() { throw new Error("unreachable"); },
      },
      onAgentRouteRejected: (rejection) => rejections.push(rejection),
    });
    const output = ringMessageOutput("topology-failure", "sol");
    const before = structuredClone(output.message);

    await hooks["chat.message"]?.(ringMessageInput("session-1", "sol") as never, output as never);

    expect(output.message).toEqual(before);
    expect(rejections).toEqual([{
      modelID: AGENT_MODEL_BINDINGS.sol,
      reason: "topology-error",
    }]);
    expect(JSON.stringify(rejections)).not.toContain("PRIVATE");
  });

  test("keeps all tuple fields unchanged on agent precommit failures without legacy fallback", async () => {
    const snapshot = ringTopology();
    let legacyCalls = 0;
    const store = createAgentRouteStore({ ttlMs: 1_000, maxEntries: 1 });
    const held = store.reserve({ sessionID: "held", messageID: "held" }, () => undefined);
    expect(held).toBeDefined();
    const hooks = createVariantRouterHooks(ringConfig(), {
      store: createDecisionStore({ ttlMs: 1_000, maxEntries: 2 }),
      agentStore: store,
      client: { async score() { legacyCalls += 1; throw new Error("legacy path must not run"); } },
      agentClient: { async route(request) { return ringResponse(request, "sol", "xhigh"); } },
      agentTopology: ringTopologySource(snapshot),
    });
    const output = ringMessageOutput("capacity", "luna");
    const before = structuredClone(output.message);

    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, output as never);

    expect(output.message).toEqual(before);
    expect(legacyCalls).toBe(0);
  });

  test("aborts a mismatched agent binding before options mutation and isolates composite identities", async () => {
    const snapshot = ringTopology();
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: { async route(request) { return ringResponse(request, "terra", "high"); } },
      agentTopology: ringTopologySource(snapshot),
    });
    const first = ringMessageOutput("shared", "luna", "session-1");
    const second = ringMessageOutput("shared", "terra", "session-2");
    await Promise.all([
      hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, first as never),
      hooks["chat.message"]?.(ringMessageInput("session-2", "terra") as never, second as never),
    ]);
    const badInput = ringParamsInput(first.message);
    badInput.message.model.variant = "low";
    const badOutput = paramsOutput({ untouched: true });

    await expect(hooks["chat.params"]?.(badInput as never, badOutput as never)).rejects.toThrow("committed agent route mismatch");
    await expect(hooks["chat.params"]?.(badInput as never, badOutput as never)).rejects.toThrow("committed agent route mismatch");
    expect(badOutput.options).toEqual({ untouched: true });

    const goodOutput = paramsOutput();
    await hooks["chat.params"]?.(ringParamsInput(second.message) as never, goodOutput as never);
    expect(goodOutput.options).toEqual({ reasoningEffort: "high" });
  });

  test("revalidates the active route after topology wait before applying provider options", async () => {
    const snapshot = ringTopology();
    let acquireCalls = 0;
    let markWaiting: (() => void) | undefined;
    let releaseTopology: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const topologyGate = new Promise<void>((resolve) => { releaseTopology = resolve; });
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: { async route(request) { return ringResponse(request, "terra", "high"); } },
      agentTopology: {
        async acquire(input) {
          acquireCalls += 1;
          if (acquireCalls === 2) {
            markWaiting?.();
            await topologyGate;
          }
          return { topology: snapshot, observation: ringObservation(snapshot, input.sourceAgent) };
        },
        async revalidate(input) {
          return ringObservation(snapshot, input.sourceAgent);
        },
      },
    });
    const routed = ringMessageOutput("concurrent-invalidation", "luna");
    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, routed as never);
    const validInput = ringParamsInput(structuredClone(routed.message));
    const validOutput = paramsOutput({ untouched: true });
    const validPending = hooks["chat.params"]?.(validInput as never, validOutput as never);
    await waiting;

    const mismatch = ringParamsInput(structuredClone(routed.message));
    mismatch.message.model.variant = "low";
    await expect(hooks["chat.params"]?.(mismatch as never, paramsOutput() as never))
      .rejects.toThrow("committed agent route mismatch");
    releaseTopology?.();

    await expect(validPending).rejects.toThrow("committed agent route mismatch");
    expect(validOutput.options).toEqual({ untouched: true });
    expect(acquireCalls).toBe(2);
  });

  test("cancels in-flight agent work on cleanup and disposal and retains only bounded route metadata", async () => {
    for (const cleanup of ["session", "dispose"] as const) {
      let signal: AbortSignal | undefined;
      const store = createAgentRouteStore({ ttlMs: 1_000, maxEntries: 2 });
      const hooks = createVariantRouterHooks(ringConfig(), {
        agentStore: store,
        agentClient: {
          async route(_request, options) {
            signal = options.signal;
            return new Promise(() => undefined);
          },
        },
        agentTopology: ringTopologySource(ringTopology()),
      });
      const pending = hooks["chat.message"]?.(
        ringMessageInput("session-1", "luna") as never,
        ringMessageOutput(`cleanup-${cleanup}`, "luna") as never,
      );
      for (let index = 0; index < 8 && !signal; index += 1) await Promise.resolve();
      expect(signal).toBeDefined();
      if (cleanup === "session") {
        await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);
      } else {
        await hooks.dispose?.();
      }
      expect(signal?.aborted).toBe(true);
      await expect(pending).resolves.toBeUndefined();
      expect(store.size).toBe(0);
      expect(JSON.stringify(store.inspect())).not.toContain("PRIVATE");
    }
  });

  test("isolates overlapping agent turns that finish out of order and deduplicates one composite turn", async () => {
    const snapshot = ringTopology();
    const requests: TypeSafeAgentRouteRequest[] = [];
    const resolvers: Array<(response: unknown) => void> = [];
    let routeCalls = 0;
    const hooks = createVariantRouterHooks(ringConfig(), {
      agentClient: {
        async route(request) {
          routeCalls += 1;
          requests.push(request);
          return new Promise((resolve) => { resolvers.push(resolve); });
        },
      },
      agentTopology: ringTopologySource(snapshot),
    });
    const older = ringMessageOutput("older", "luna", "session-1");
    const newer = ringMessageOutput("newer", "terra", "session-2");
    const olderPending = hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, older as never);
    for (let index = 0; index < 8 && resolvers.length < 1; index += 1) await Promise.resolve();
    const newerPending = hooks["chat.message"]?.(ringMessageInput("session-2", "terra") as never, newer as never);
    for (let index = 0; index < 8 && resolvers.length < 2; index += 1) await Promise.resolve();

    resolvers[1]?.(ringResponse(requests[1]!, "terra", "high"));
    await newerPending;
    expect(newer.message).toMatchObject({ agent: "terra", model: { variant: "high" } });
    const newerCommitted = structuredClone(newer.message);
    resolvers[0]?.(ringResponse(requests[0]!, "sol", "xhigh"));
    await olderPending;
    expect(older.message).toMatchObject({ agent: "sol", model: { variant: "xhigh" } });
    expect(newer.message).toEqual(newerCommitted);

    const duplicatePrimary = ringMessageOutput("duplicate", "luna", "session-3");
    const duplicateShadow = ringMessageOutput("duplicate", "luna", "session-3");
    const primaryPending = hooks["chat.message"]?.(
      ringMessageInput("session-3", "luna") as never,
      duplicatePrimary as never,
    );
    for (let index = 0; index < 8 && resolvers.length < 3; index += 1) await Promise.resolve();
    await hooks["chat.message"]?.(ringMessageInput("session-3", "luna") as never, duplicateShadow as never);
    expect(routeCalls).toBe(3);
    expect(duplicateShadow.message).toEqual(ringMessageOutput("duplicate", "luna", "session-3").message);
    resolvers[2]?.(ringResponse(requests[2]!, "terra", "high"));
    await primaryPending;
    expect(duplicatePrimary.message).toMatchObject({ agent: "terra", model: { variant: "high" } });
  });

  test("suppresses late agent completion after timeout and rejects topology drift before tuple commit", async () => {
    const snapshot = ringTopology();
    let now = 0;
    let timeout: (() => void) | undefined;
    let request: TypeSafeAgentRouteRequest | undefined;
    let resolveRoute: ((response: unknown) => void) | undefined;
    const hooks = createVariantRouterHooks({ ...ringConfig(), timeoutMs: 20 }, {
      store: createDecisionStore({ ttlMs: 1_000, maxEntries: 8 }),
      agentStore: createAgentRouteStore({ ttlMs: 1_000, maxEntries: 8 }),
      now: () => now,
      setTimer: (callback) => { timeout = callback; return () => undefined; },
      agentClient: {
        async route(captured) {
          request = captured;
          return new Promise((resolve) => { resolveRoute = resolve; });
        },
      },
      agentTopology: ringTopologySource(snapshot),
    });
    const timedOut = ringMessageOutput("agent-timeout", "luna");
    const beforeTimeout = structuredClone(timedOut.message);
    const pending = hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, timedOut as never);
    for (let index = 0; index < 8 && !resolveRoute; index += 1) await Promise.resolve();
    now = 21;
    timeout?.();
    await pending;
    expect(timedOut.message).toEqual(beforeTimeout);
    resolveRoute?.(ringResponse(request!, "terra", "high"));
    await Promise.resolve();
    expect(timedOut.message).toEqual(beforeTimeout);

    const drifted = ringMessageOutput("agent-drift", "luna");
    const beforeDrift = structuredClone(drifted.message);
    const driftHooks = createVariantRouterHooks(ringConfig(), {
      agentClient: { async route(captured) { return ringResponse(captured, "terra", "high"); } },
      agentTopology: {
        async acquire(input) {
          return { topology: snapshot, observation: ringObservation(snapshot, input.sourceAgent) };
        },
        async revalidate(input) {
          return { ...ringObservation(snapshot, input.sourceAgent), generationID: "drifted" };
        },
      },
    });
    await driftHooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, drifted as never);
    expect(drifted.message).toEqual(beforeDrift);
  });

  test("implements typesafe-first and conservative manual-first locks with expected paths", () => {
    const typesafeFirst = createManualAgentPolicyState("typesafe-first");
    expect(typesafeFirst.observe("s", "luna", 1)).toBeUndefined();
    expect(typesafeFirst.observe("s", "terra", 2)).toBeUndefined();

    const manualFirst = createManualAgentPolicyState("manual-first");
    expect(manualFirst.observe("s", "luna", 1)).toBeUndefined();
    manualFirst.expectPath("s", ["terra", "sol"], 1);
    expect(manualFirst.observe("s", "terra", 2)).toBeUndefined();
    manualFirst.expectPath("s", ["sol"], 2);
    expect(manualFirst.observe("s", "terra", 3)).toBeUndefined();
    expect(manualFirst.observe("s", "sol", 4)).toBe("sol");
    expect(manualFirst.observe("s", "luna", 5)).toBe("sol");
    manualFirst.reset("s");
    expect(manualFirst.observe("s", "luna", 6)).toBeUndefined();
    manualFirst.cleanupSession("s");
    expect(manualFirst.inspect()).toEqual([]);
  });

  test("reports unavailable agent sync without affecting route binding or retaining turn data", async () => {
    const snapshot = ringTopology();
    const diagnostics: unknown[] = [];
    const agentSync = createUnavailableAgentSync({
      enabled: true,
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
        throw new Error("diagnostic observers cannot affect provider routing");
      },
    });
    const hooks = createRawVariantRouterHooks(ringConfig(), {
      agentClient: { async route(request) { return ringResponse(request, "terra", "high"); } },
      agentTopology: ringTopologySource(snapshot),
      agentSync,
    });
    const routed = ringMessageOutput("agent-sync-unavailable", "luna");

    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, routed as never);
    const bound = paramsOutput({ foreign: "keep" });
    await hooks["chat.params"]?.(ringParamsInput(routed.message) as never, bound as never);

    expect(bound.options).toEqual({ foreign: "keep", reasoningEffort: "high" });
    expect(diagnostics).toHaveLength(1);
    expect(agentSync.inspect()).toEqual({
      capability: "unavailable",
      enabled: true,
      disposed: false,
      retainedEntries: 0,
      reasons: ["targetless-command", "unproven-selector-scope", "ambiguous-delivery"],
    });
    expect(JSON.stringify(agentSync.inspect())).not.toContain("agent-sync-unavailable");

    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);
    expect(agentSync.inspect().retainedEntries).toBe(0);
    await hooks.dispose?.();
    expect(agentSync.inspect()).toMatchObject({ disposed: true, retainedEntries: 0 });
  });

  test("classifies decision-store TTL expiry and capacity eviction without retaining stale work", () => {
    let now = 0;
    const lifecycle: string[] = [];
    const store = createDecisionStore<{ cancel(): void }>({
      ttlMs: 10,
      maxEntries: 1,
      now: () => now,
      setTimer: () => () => undefined,
      onLifecycle: (reason) => lifecycle.push(reason),
    });
    store.produce({ messageID: "a", sessionID: "s", modelID: "openai/a", deadlineAt: 10, turnOrder: 1 }, () => ({ cancel() {} }));
    store.produce({ messageID: "b", sessionID: "s", modelID: "openai/b", deadlineAt: 10, turnOrder: 2 }, () => ({ cancel() {} }));
    expect(lifecycle).toEqual(["capacity-eviction"]);
    now = 10;
    expect(store.get("b")).toBeUndefined();
    expect(lifecycle).toEqual(["capacity-eviction", "ttl-expiry"]);
    expect(store.size).toBe(0);
  });

  test("isolates every cleanup and disposal failure behind lifecycle diagnostics", async () => {
    const diagnostics: DiagnosticRecord[] = [];
    const fail = (): never => { throw new Error("PRIVATE_LIFECYCLE_STACK"); };
    const hooks = createRawVariantRouterHooks({ enabled: false, fallbackVariant: "low" }, {
      store: { cleanupSession: fail, clear: fail } as never,
      agentStore: { cleanupSession: fail, clear: fail } as never,
      manualAgentPolicy: { cleanupSession: fail, clear: fail } as never,
      agentSync: { cleanupSession: fail, clear: fail } as never,
      variantSync: { cleanupSession: fail, clear: fail } as never,
      onRuntimeDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(hooks.event?.({
      event: { type: "session.deleted", properties: { info: { id: "private-session" } } },
    } as never)).resolves.toBeUndefined();
    expect(diagnostics.filter((diagnostic) => diagnostic.reasonCode === "cleanup-failed")).toHaveLength(5);
    expect(diagnostics).toContainEqual(expect.objectContaining({ reasonCode: "cancelled", operation: "session-cleanup" }));

    await expect(hooks.dispose?.()).resolves.toBeUndefined();
    expect(diagnostics.filter((diagnostic) => diagnostic.reasonCode === "disposal-failed")).toHaveLength(5);
    expect(diagnostics).toContainEqual(expect.objectContaining({ reasonCode: "cancelled", operation: "dispose" }));
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_LIFECYCLE_STACK");
  });

  test("fails closed when a correlated committed agent route expires before params", async () => {
    let now = 0;
    const snapshot = ringTopology();
    const agentStore = createAgentRouteStore({
      ttlMs: 10,
      maxEntries: 8,
      now: () => now,
      setTimer: () => () => undefined,
    });
    const hooks = createRawVariantRouterHooks(ringConfig(), {
      now: () => now,
      agentStore,
      agentClient: { async route(request) { return ringResponse(request, "terra", "high"); } },
      agentTopology: ringTopologySource(snapshot),
    });
    const routed = ringMessageOutput("expired-commit", "luna");
    await hooks["chat.message"]?.(ringMessageInput("session-1", "luna") as never, routed as never);
    now = 11;
    const output = paramsOutput({ untouched: true });

    await expect(hooks["chat.params"]?.(ringParamsInput(routed.message) as never, output as never))
      .rejects.toThrow("committed agent route mismatch");
    expect(output.options).toEqual({ untouched: true });
  });

  test("all exposed hooks and late observers are inert after disposal", async () => {
    const diagnostics: DiagnosticRecord[] = [];
    let scoreCalls = 0;
    const hooks = createRawVariantRouterHooks({ fallbackVariant: "low", agentSelection: { enabled: false } }, {
      client: { async score(request) { scoreCalls += 1; return scoreAnswer(request, { 0: 0, 1: 1 }); } },
      onRuntimeDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await hooks.dispose?.();
    const diagnosticCount = diagnostics.length;
    const output = paramsOutput({ untouched: true });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("after-dispose") as never);
    await hooks["chat.params"]?.(paramsInput("after-dispose") as never, output as never);
    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never);
    await Promise.resolve();

    expect(scoreCalls).toBe(0);
    expect(output.options).toEqual({ untouched: true });
    expect(diagnostics).toHaveLength(diagnosticCount);
  });

  test("invalid startup config rejects without waiting for a hanging diagnostic sink", async () => {
    const plugin = createTypeSafeVariantRouterPlugin();
    const startup = plugin({
      client: {
        app: { log: async () => new Promise(() => undefined) },
        tui: {},
        session: {},
      },
    } as never, { timeoutMs: 0 } as never);

    const outcome = await Promise.race([
      startup.then(() => "resolved", (error) => error instanceof Error ? error.name : "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 20)),
    ]);
    expect(outcome).toBe("DiagnosticError");
  });

  test("attributes an agent deadline to the still-active history read", async () => {
    let now = 0;
    let expire: (() => void) | undefined;
    const diagnostics: DiagnosticRecord[] = [];
    const hooks = createRawVariantRouterHooks({
      ...ringConfig(),
      timeoutMs: 10,
      context: { mode: "recent-messages", maxMessages: 4, maxChars: 1_000 },
    }, {
      now: () => now,
      setTimer: (callback) => { expire = callback; return () => undefined; },
      historyProvider: async () => new Promise(() => undefined),
      agentClient: { async route(request) { return ringResponse(request, "terra", "high"); } },
      agentTopology: ringTopologySource(ringTopology()),
      onRuntimeDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const pending = hooks["chat.message"]?.(
      ringMessageInput("session-1", "luna") as never,
      ringMessageOutput("history-timeout", "luna") as never,
    );
    for (let index = 0; index < 8 && !expire; index += 1) await Promise.resolve();
    now = 11;
    expire?.();
    await pending;

    expect(diagnostics).toContainEqual(expect.objectContaining({
      boundary: "deadline",
      operation: "read-history",
      reasonCode: "routing-timeout",
      disposition: "unchanged",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      reasonCode: "routing-timeout",
      operation: "acquire-topology",
    }));
  });

  test("closes production observers before a late toast completion can publish or log", async () => {
    const logs: unknown[] = [];
    const publishes: unknown[] = [];
    let resolveToast: ((value: unknown) => void) | undefined;
    const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
    const hooks = await plugin({
      client: {
        app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
        tui: {
          showToast: async () => new Promise((resolve) => { resolveToast = resolve; }) as never,
          publish: async (request: unknown) => { publishes.push(request); return { data: false } as never; },
        },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "always", logLevel: "debug" });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("late-toast") as never);
    await hooks["chat.params"]?.(paramsInput("late-toast") as never, paramsOutput() as never);
    for (let index = 0; index < 8 && !resolveToast; index += 1) await Promise.resolve();
    expect(resolveToast).toBeDefined();
    await hooks.dispose?.();
    const logCount = logs.length;

    resolveToast?.({ error: { code: "PRIVATE_LATE_ERROR" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(publishes).toEqual([]);
    expect(logs).toHaveLength(logCount);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_LATE_ERROR");
  });

  test("exposes bounded production log-sink health without recursive logging", async () => {
    const health: Array<{ reasonCode: string; sinkFailures: number }> = [];
    let logCalls = 0;
    const plugin = createTypeSafeVariantRouterPlugin({
      resolveApiKey: async () => undefined,
      onDiagnosticSinkFailure: (state) => health.push(state),
    });
    const hooks = await plugin({
      client: {
        app: { log: async () => { logCalls += 1; throw new Error("PRIVATE_SINK_FAILURE"); } },
        tui: { showToast: async () => ({} as never) },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, logLevel: "debug" });
    await hooks["chat.message"]?.(messageInput() as never, messageOutput("sink-health") as never);
    await hooks["chat.params"]?.(paramsInput("sink-health") as never, paramsOutput() as never);
    for (let index = 0; index < 8 && health.length < 2; index += 1) await Promise.resolve();

    expect(logCalls).toBe(3);
    expect(health).toEqual([
      { reasonCode: "log-delivery-failed", sinkFailures: 1 },
      { reasonCode: "log-delivery-failed", sinkFailures: 2 },
    ]);
    await hooks.dispose?.();
  });

  test("maps malformed production history to the variant fallback history policy only", async () => {
    const logs: unknown[] = [];
    let scoreCalls = 0;
    const plugin = createTypeSafeVariantRouterPlugin({
      resolveApiKey: async () => "offline-key",
      createScoreClient: () => ({
        async score(request) {
          scoreCalls += 1;
          return scoreAnswer(request, { 0: 0, 1: 1 });
        },
      }),
    });
    const hooks = await plugin({
      client: {
        app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
        tui: { showToast: async () => ({} as never) },
        session: { messages: async () => ({ data: { PRIVATE_HISTORY: true } }) },
      },
    } as never, {
      fallbackVariant: "low",
      agentSelection: { enabled: false },
      context: { mode: "recent-messages", maxMessages: 4, maxChars: 1_000 },
      logLevel: "debug",
    });
    await hooks["chat.message"]?.(messageInput() as never, messageOutput("invalid-history") as never);
    const output = paramsOutput();
    await hooks["chat.params"]?.(paramsInput("invalid-history") as never, output as never);
    await Promise.resolve();
    const records = logs.map((entry) => JSON.parse((entry as { body: { message: string } }).body.message) as DiagnosticRecord);

    expect(scoreCalls).toBe(0);
    expect(output.options).toMatchObject({ reasoningEffort: "low" });
    expect(records.filter((record) => record.boundary === "history")).toEqual([
      expect.objectContaining({
        operation: "read-history",
        reasonCode: "history-response-invalid",
        disposition: "fallback",
        level: "warn",
      }),
    ]);
    expect(records).not.toContainEqual(expect.objectContaining({ reasonCode: "client-error" }));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_HISTORY");
    await hooks.dispose?.();
  });
});
